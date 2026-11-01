import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createManagedAutomation, nativeSignalDefinition, validateManagedSchedule } from '../lib/managed-automation.mjs';

const binding = { ownerId: 'owner', agentId: 'paired-agent', genesisHash: 'a'.repeat(64) };
const channel = { name: 'Fixture transport', channelId: 'fixture', accountId: 'default', conversationId: 'room', allowSenders: ['sender'] };
const incoming = (id = 'message-1') => ({ channelId: 'fixture', accountId: 'default', conversationId: 'room', senderId: 'sender', messageId: id, text: 'Please introduce yourself.' });
function nativeFixture() {
  const jobs = new Map(), listeners = new Set(), history = new Map();
  return { nodePath: process.execPath, jobs,
    async rpc(method, params) {
      if (method === 'cron.list') return { jobs: [...jobs.values()].slice(params.offset || 0, (params.offset || 0) + (params.limit || 1000)) };
      if (method === 'cron.add') { const entry = { ...structuredClone(params), id: randomUUID() }; jobs.set(entry.id, entry); return entry; }
      const entry = jobs.get(params.id); if (!entry) throw new Error('Unknown native fixture job');
      if (method === 'cron.get') return structuredClone(entry);
      if (method === 'cron.update') { Object.assign(entry, structuredClone(params.patch)); return entry; }
      if (method === 'cron.runs') return { entries: [...(history.get(params.id) || [])].reverse() };
      throw new Error('Unexpected native operation');
    },
    subscribe(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    async fire(id, at = Date.now() + 50, live = true) {
      const event = { jobId: id, action: 'finished', status: 'ok', runAtMs: at };
      history.set(id, [...(history.get(id) || []), event]);
      if (live) for (const listener of listeners) listener({ event: 'cron', payload: event });
      await new Promise(resolve => setTimeout(resolve, 15));
    },
  };
}
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-managed-automation-'));
  const native = nativeFixture(), turns = [], deliveries = [], authorizations = [];
  const options = { directory, native, checkEligibility: async () => ({ eligible: true }),
    executeTurn: async request => { turns.push(request); return { approved: true, text: 'Hello, with kindness and care.' }; },
    authorizeDelivery: async request => { authorizations.push(request); return { allowed: true, privateCapability: 'not-for-disk' }; },
    deliver: async request => { deliveries.push(request); return { delivered: true }; }, ...overrides };
  const coordinator = await createManagedAutomation(options);
  t.after(async () => { await coordinator.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, native, coordinator, options, turns, deliveries, authorizations };
}

test('native jobs contain only a fixed no-model scheduler signal', () => {
  const job = nativeSignalDefinition({ id: randomUUID(), schedule: { kind: 'every', everyMs: 60000 }, anchorMs: 1000 }, process.execPath);
  assert.equal(job.payload.kind, 'command'); assert.deepEqual(job.payload.argv, [process.execPath, '--input-type=module', '-e', 'process.stdout.write("NO_REPLY")']);
  assert.deepEqual(job.payload.toolsAllow, []); assert.deepEqual(job.delivery, { mode: 'none' });
  assert.equal(job.enabled, false); assert.equal(job.schedule.anchorMs, 1000);
  assert.throws(() => validateManagedSchedule({ kind: 'every', everyMs: 1000 }), /once a minute/);
  assert.throws(() => validateManagedSchedule({ kind: 'cron', expr: '* * * * * *', tz: 'UTC' }), /five-field/);
  assert.throws(() => validateManagedSchedule({ kind: 'at', at: new Date(Date.now() + 10000).toISOString(), command: 'bad' }), /Unexpected/);
});

test('incoming content cannot choose identity, authority, chain, recipient or run', async t => {
  const f = await fixture(t); await f.coordinator.bindChannel(binding, channel);
  for (const key of ['ownerId', 'agentId', 'genesisHash', 'runId', 'sessionKey', 'target'])
    await assert.rejects(f.coordinator.acceptInbound({ ...incoming(), [key]: 'forged' }), /Unexpected/);
  await assert.rejects(f.coordinator.acceptInbound({ ...incoming(), senderId: 'outsider' }), /authorized Timechain/);
  await f.coordinator.acceptInbound(incoming()); await f.coordinator.wake();
  assert.equal(f.turns.length, 1); assert.deepEqual(f.turns[0].binding, binding);
  assert.deepEqual(f.deliveries[0].target, { channelId: 'fixture', accountId: 'default', conversationId: 'room' });
});

test('a physical channel message is never delivered twice, including pause/resume', async t => {
  const f = await fixture(t); const bound = await f.coordinator.bindChannel(binding, channel);
  await Promise.all([f.coordinator.acceptInbound(incoming()), f.coordinator.acceptInbound(incoming())]); await f.coordinator.wake();
  assert.equal(f.turns.length, 1); assert.equal(f.deliveries.length, 1);
  await f.coordinator.setEnabled('owner', 'channel', bound.id, false);
  await f.coordinator.setEnabled('owner', 'channel', bound.id, true);
  const repeat = await f.coordinator.acceptInbound(incoming()); await f.coordinator.wake();
  assert.equal(repeat.duplicate, true); assert.equal(f.deliveries.length, 1);
  assert.equal((await fs.readFile(path.join(f.directory, 'automation.json'), 'utf8')).includes('not-for-disk'), false);
});

test('wallet/provider/owner ineligibility holds durable work until an eligible live session returns', async t => {
  let eligible = false; const f = await fixture(t, { checkEligibility: async () => ({ eligible }) });
  await f.coordinator.bindChannel(binding, channel); await f.coordinator.acceptInbound(incoming()); await f.coordinator.wake();
  assert.equal(f.turns.length, 0); assert.equal((await f.coordinator.status('owner')).occurrences[0].status, 'held');
  eligible = true; await f.coordinator.wake(); assert.equal(f.deliveries.length, 1);
  assert.equal((await f.coordinator.status('other-owner')).occurrences.length, 0);
});

test('PoI refusal before generation approval or outgoing action never delivers', async t => {
  for (const overrides of [ { executeTurn: async () => ({ approved: false, text: 'withheld' }) }, { authorizeDelivery: async () => ({ allowed: false }) } ]) {
    const f = await fixture(t, overrides); await f.coordinator.bindChannel(binding, channel);
    await f.coordinator.acceptInbound(incoming()); await f.coordinator.wake();
    assert.equal(f.deliveries.length, 0); assert.equal((await f.coordinator.status('owner')).occurrences[0].status, 'rejected');
  }
});

test('revoking a binding while a reviewed turn is pending cancels outgoing authority', async t => {
  let release, started; const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { executeTurn: async ({ signal }) => { started(); await new Promise(resolve => { release = resolve; });
    assert.equal(signal.aborted, true); return { approved: true, text: 'Should remain private.' }; } });
  const bound = await f.coordinator.bindChannel(binding, channel); await f.coordinator.acceptInbound(incoming()); await began;
  await f.coordinator.setEnabled('owner', 'channel', bound.id, false); release(); await f.coordinator.wake();
  assert.equal(f.deliveries.length, 0); assert.equal((await f.coordinator.status('owner')).occurrences[0].status, 'revoked');
});

test('an ambiguous outgoing network result is held for inspection and never automatically resent', async t => {
  let attempts = 0; const f = await fixture(t, { deliver: async () => { attempts++; throw new Error('Unknown transport result'); } });
  await f.coordinator.bindChannel(binding, channel); await f.coordinator.acceptInbound(incoming()); await f.coordinator.wake();
  await f.coordinator.wake(); assert.equal(attempts, 1);
  assert.equal((await f.coordinator.status('owner')).occurrences[0].status, 'uncertain');
  await f.coordinator.close(); const recovered = await createManagedAutomation(f.options); t.after(() => recovered.close());
  await recovered.wake(); assert.equal(attempts, 1);
});

test('completed and failed delivery attempts retire any outstanding private authorization signal', async t => {
  for (const failed of [false, true]) {
    let authorizationSignal, deliverySignal;
    const f = await fixture(t, {
      authorizeDelivery: async ({ signal }) => { authorizationSignal = signal; return { allowed: true }; },
      deliver: async ({ signal }) => {
        deliverySignal = signal; assert.equal(signal.aborted, false);
        if (failed) throw new Error('A transport may have retained an unused native permit.');
        return { delivered: true };
      },
    });
    await f.coordinator.bindChannel(binding, channel); await f.coordinator.acceptInbound(incoming()); await f.coordinator.wake();
    assert.equal(deliverySignal, authorizationSignal);
    assert.equal(authorizationSignal.aborted, true, 'No native callback may reuse this occurrence after it finishes.');
    assert.equal((await f.coordinator.status('owner')).occurrences[0].status, failed ? 'uncertain' : 'delivered');
  }
});

test('new ingress arriving during a current turn is durably processed without a lost wake', async t => {
  let release, started; const began = new Promise(resolve => { started = resolve; }); let calls = 0;
  const f = await fixture(t, { executeTurn: async () => { if (++calls === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return { approved: true, text: 'Reviewed result.' }; } });
  await f.coordinator.bindChannel(binding, channel); await f.coordinator.acceptInbound(incoming('first')); await began;
  await f.coordinator.acceptInbound(incoming('second')); release(); await f.coordinator.wake();
  assert.equal(calls, 2); assert.equal(f.deliveries.length, 2);
});

test('native scheduler identity and exact signal definition bind one occurrence to one verified chain', async t => {
  const f = await fixture(t); const bound = await f.coordinator.bindChannel(binding, channel);
  const job = await f.coordinator.createJob(binding, { name: 'Fixture schedule', prompt: 'Introduce yourself on schedule.',
    schedule: { kind: 'every', everyMs: 60000 }, channelBindingId: bound.id });
  await f.native.fire('foreign-job'); assert.equal(f.turns.length, 0);
  const at = Date.now() + 100; await f.native.fire(job.nativeId, at); await f.coordinator.wake();
  await f.native.fire(job.nativeId, at); await f.coordinator.wake();
  assert.equal(f.turns.length, 1); assert.equal(f.deliveries.length, 1); assert.deepEqual(f.turns[0].binding, binding);
  f.native.jobs.get(job.nativeId).payload.argv = ['unexpected-command'];
  await f.native.fire(job.nativeId, at + 1000); await f.coordinator.wake();
  assert.equal(f.turns.length, 1); assert.equal(f.native.jobs.get(job.nativeId).enabled, false);
});

test('pausing a channel revokes active dependent schedules and cannot replay their outgoing authority on resume', async t => {
  let release, started; const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { authorizeDelivery: async ({ signal }) => { started(); await new Promise(resolve => { release = resolve; });
    assert.equal(signal.aborted, true); return { allowed: true }; } });
  const bound = await f.coordinator.bindChannel(binding, channel);
  const job = await f.coordinator.createJob(binding, { name: 'Bound destination', prompt: 'Introduce yourself.', schedule: { kind: 'every', everyMs: 60000 }, channelBindingId: bound.id });
  const at = Date.now() + 100; await f.native.fire(job.nativeId, at); await began;
  await f.coordinator.setEnabled('owner', 'channel', bound.id, false); release(); await f.coordinator.wake();
  assert.equal(f.deliveries.length, 0); assert.equal((await f.coordinator.status('owner')).occurrences[0].status, 'revoked');
  await f.native.fire(job.nativeId, at + 1); await f.coordinator.wake();
  assert.equal(f.turns.length, 1, 'A paused recipient binding cannot admit another scheduled model turn.');
  await f.coordinator.setEnabled('owner', 'channel', bound.id, true); await f.coordinator.wake();
  assert.equal(f.deliveries.length, 0, 'Resuming a recipient cannot revive the previous revoked sends.');
});

test('persisted scheduled recipients without an exact channel binding are held and quarantined before native cron activation', async t => {
  const f = await fixture(t); const bound = await f.coordinator.bindChannel(binding, channel);
  const job = await f.coordinator.createJob(binding, { name: 'Old target-only state', prompt: 'Introduce yourself.', schedule: { kind: 'every', everyMs: 60000 }, channelBindingId: bound.id });
  await f.coordinator.close();
  const filename = path.join(f.directory, 'automation.json'), saved = JSON.parse(await fs.readFile(filename, 'utf8'));
  delete saved.jobs[0].channelBindingId; await fs.writeFile(filename, JSON.stringify(saved));
  const recovered = await createManagedAutomation(f.options); t.after(() => recovered.close());
  const state = await recovered.status('owner'); assert.equal(state.jobs[0].enabled, false); assert.equal(state.jobs[0].reason, 'channel_binding_requires_repair');
  await assert.rejects(recovered.setEnabled('owner', 'cron', job.id, true), error => error.code === 'AUTOMATION_CHANNEL_REQUIRED');
  assert.equal(f.native.jobs.get(job.nativeId).enabled, false); await f.native.fire(job.nativeId); await recovered.wake();
  assert.equal(f.turns.length, 0); assert.equal(f.deliveries.length, 0);
});

test('native history recovers offline scheduler signals while inference remains live-session gated', async t => {
  let eligible = false; const f = await fixture(t, { checkEligibility: async () => ({ eligible }) });
  const job = await f.coordinator.createJob(binding, { name: 'Offline schedule', prompt: 'Review later.', schedule: { kind: 'every', everyMs: 60000 } });
  await f.native.fire(job.nativeId, Date.now() + 50, false); await f.coordinator.reconcile();
  assert.equal((await f.coordinator.status('owner')).occurrences[0].status, 'held'); assert.equal(f.turns.length, 0);
  eligible = true; await f.coordinator.wake(); assert.equal(f.turns.length, 1);
  assert.equal((await f.coordinator.status('owner')).occurrences[0].status, 'completed');
});

test('bounded durable ingress refuses before acknowledgement instead of dropping accepted work', async t => {
  const f = await fixture(t, { maximumPending: 1, checkEligibility: async () => ({ eligible: false }) });
  await f.coordinator.bindChannel(binding, channel); await f.coordinator.acceptInbound(incoming('first')); await f.coordinator.wake();
  await assert.rejects(f.coordinator.acceptInbound(incoming('second')), error => error.code === 'AUTOMATION_QUEUE_FULL');
  const saved = await f.coordinator.status('owner'); assert.equal(saved.occurrences.length, 1); assert.equal(saved.occurrences[0].input, incoming().text);
});

test('initial scheduler audit quarantines unknown enabled work and recognizes only the exact inert native monitor', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-audit-')), native = nativeFixture();
  native.jobs.set('foreign-command', { id: 'foreign-command', enabled: true, payload: { kind: 'command', argv: ['unadmitted'] } });
  native.jobs.set('monitor', { id: 'monitor', enabled: false, declarationKey: 'heartbeat:main', agentId: 'main', sessionTarget: 'main', wakeMode: 'next-heartbeat', payload: { kind: 'heartbeat' } });
  const coordinator = await createManagedAutomation({ directory, native, checkEligibility: async () => ({ eligible: true }),
    executeTurn: async () => { throw new Error('Audit must not run a model.'); }, authorizeDelivery: async () => ({ allowed: false }), deliver: async () => { throw new Error('Audit must not deliver.'); } });
  t.after(async () => { await coordinator.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.equal(native.jobs.get('foreign-command').enabled, false);
  const audit = await coordinator.auditScheduler();
  assert.equal(audit.jobs.find(job => job.nativeId === 'monitor').disposition, 'known_inert_heartbeat_monitor');
  assert.equal(audit.jobs.find(job => job.nativeId === 'foreign-command').disposition, 'unmanaged_disabled');
});
