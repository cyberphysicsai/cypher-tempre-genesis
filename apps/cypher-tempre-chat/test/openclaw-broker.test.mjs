import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const good = () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(k => [k, 240])),
  fruitages: Object.fromEntries(FRUITS.map(k => [k, 240])), usedRings: [], rationale: 'Supported and compatible with the covenant.' });
const candidate = "Hello! I'm Cypher Tempre, your conversational assistant. I can help you explore ideas and think through questions carefully.";
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-openclaw-broker-')), root = path.join(dir, 'agent');
  await engine({ op: 'init', root, name: 'Cypher Tempre' });
  let time = Date.now(); const seen = [];
  const broker = createPoIBroker({ engine, review: async (config, args) => { seen.push(args); return options.assessment?.() || good(); }, now: () => time });
  await broker.start();
  t.after(async () => { await broker.close(); assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); });
  const config = { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-private-key' };
  const context = { root, input: 'Please introduce yourself', purpose: 'candidate', loadout: [], settings: { recall: false }, authorize: async () => {} };
  const register = extra => broker.registerInvocation({ config, args: { messages: [{ role: 'user', content: context.input }] },
    context: { ...context, ...extra }, sessionKey: 'agent:main:chainchat:fixture', invocationId: 'fixture' });
  const call = async (op, fields = {}, headers = {}) => {
    const response = await fetch(broker.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${broker.token}`, ...headers },
      body: JSON.stringify({ version: 1, op, sessionKey: 'agent:main:chainchat:fixture', runId: 'run-one', ...fields }) });
    return { status: response.status, body: await response.json() };
  };
  return { broker, root, seen, register, call, setTime: value => { time = value; } };
}
test('OpenClaw authority is private and unknown claims fail closed', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('admit', {}, { authorization: 'Bearer invalid' })).status, 403);
  assert.equal((await f.call('admit', {}, { origin: 'https://example.com' })).status, 403);
  assert.equal((await f.call('admit')).body.allowed, false);
});

test('private context budgeting prepares the actual skill and retires its unbound claim', async t => {
  const f = await fixture(t);
  const inspected = await engine({ op: 'inspect', root: f.root, learning: false });
  const estimate = await f.broker.estimateInvocation({
    config: { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture-private-key' },
    args: { messages: [{ role: 'user', content: 'Please introduce yourself' }] },
    context: { root: f.root, input: 'Please introduce yourself', purpose: 'candidate', loadout: [], settings: { recall: false } },
    sessionKey: 'agent:main:chainchat:fixture', invocationId: 'budget-only',
  });
  assert.ok(estimate.estimatedTokens > 1000, 'Budget must include the real installed skill and verified native context.');
  assert.deepEqual((await engine({ op: 'inspect', root: f.root, learning: false })).head, inspected.head);
  assert.equal((await f.call('admit')).body.allowed, false, 'A budget probe must leave no model-admissible claim.');
  await f.register();
  assert.equal((await f.call('admit')).body.allowed, true, 'The same session remains available for the real turn.');
  assert.equal(f.seen.length, 0, 'Budget probes must not contact the reviewer or model.');
});
test('model context correlation supplies the managed skill but cannot bind a native run or authorize tools', async t => {
  const f = await fixture(t), capability = 'c'.repeat(64);
  await f.register({ modelRouteCapability: capability });
  const correlation = 'context-assembly:00000000-0000-4000-8000-000000000001';
  const supplied = await f.call('model_context', { runId: correlation });
  assert.equal(supplied.body.allowed, true); assert.equal(supplied.body.binding.runId, correlation);
  assert.ok(supplied.body.context.includes('CHAINCHAT HOST CONTRACT'));
  assert.ok(supplied.body.context.includes(`[CHAINCHAT_PRIVATE_MODEL_ROUTE:${capability}]`));
  assert.equal((await f.call('tool', { runId: correlation, tool: { name: 'read', callId: 'fake', params: { path: 'private' } } })).body.allowed, false);
  assert.equal((await f.call('admit', { runId: 'actual-native-run' })).body.allowed, true, 'Context assembly must not steal claim.runId.');
  assert.equal((await f.call('model_context', { sessionKey: 'other-session', runId: correlation })).body.allowed, false);
});
test('original browser primitives each require fresh review and compound or personal-profile calls are refused', async t => {
  let reviews = 0, effects = 0;
  const f = await fixture(t, { assessment: () => { const result = good(); if (++reviews === 2) result.fruitages.kindness = 20; return result; } });
  await f.register({ input: 'Click Continue, then click Finish in the owned browser.',
    toolAuthority: { enabled: true, acknowledged: true, tools: ['browser'], roots: [], networkHosts: ['example.com'], allowExecution: false },
    browserInvocation: {
      describe: () => ({ profile: 'chainchat-owned', isolated: true, running: true, closed: false }),
      inspectAction: async params => ({ params, context: { fingerprint: 'fixed', role: 'button', text: params.request.ref } }),
      assertActionUnchanged: async params => ({ params, context: { fingerprint: 'fixed' } }),
    } });
  await f.call('admit');
  assert.deepEqual((await f.call('prepare')).body.toolsAllow, ['browser']);
  const children = ['Continue', 'Finish'].map(ref => ({ action: 'act', request: { kind: 'click', ref } }));
  const invoke = (callId, params) => f.call('tool', { tool: { name: 'browser', callId, params } });
  assert.equal((await invoke('batch', { action: 'act', request: { kind: 'batch', actions: children.map(item => item.request) } })).body.allowed, false);
  assert.equal((await invoke('profiles', { action: 'profiles' })).body.allowed, false);
  assert.equal((await invoke('multi-field', { action: 'act', request: { kind: 'fill', fields: [{ ref: 'a', value: 'one' }, { ref: 'b', value: 'two' }] } })).body.allowed, false);
  const first = await invoke('native-primitive-one', children[0]);
  assert.equal(first.body.allowed, true, JSON.stringify(first.body)); effects++;
  assert.equal((await invoke('native-primitive-one', children[0])).body.allowed, false, 'An approved call identifier cannot be replayed.');
  await f.call('tool_result', { tool: { name: 'browser', callId: 'native-primitive-one' }, outcome: { success: true, result: { clicked: 'Continue' }, error: null } });
  const denied = await invoke('native-primitive-two', children[1]);
  if (denied.body.allowed) effects++;
  assert.equal(denied.body.allowed, false); assert.equal(effects, 1); assert.equal(reviews, 2);
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});
test('managed model services require a fresh exact one-use approved native call', async t => {
  let effects = 0;
  const f = await fixture(t);
  await f.register({ input: 'List the managed schedules for this agent.',
    toolAuthority: { enabled: true, acknowledged: true, tools: ['chainchat_automation'], roots: [], networkHosts: [], allowExecution: false },
    executeManagedService: async params => { effects++; assert.deepEqual(params, { action: 'list' }); return { jobs: [] }; } });
  await f.call('admit'); await f.call('prepare');
  const execute = fields => f.call('managed_service_execute', { runId: 'real-service-call', params: { action: 'list' }, ...fields });
  assert.equal((await execute()).body.allowed, false);
  assert.equal((await f.call('tool', { tool: { name: 'chainchat_automation', callId: 'forged-target', params: { action: 'list', agentId: 'other' } } })).body.allowed, false);
  assert.equal((await f.call('tool', { tool: { name: 'chainchat_automation', callId: 'real-service-call', params: { action: 'list' } } })).body.allowed, true);
  assert.equal((await execute({ params: { action: 'list_channels' } })).body.allowed, false);
  assert.equal((await execute()).body.allowed, true); assert.equal(effects, 1);
  assert.equal((await execute()).body.allowed, false); assert.equal(effects, 1);
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});
test('native prepare/review/evaluate bind an exact candidate, but UI retains commit ownership', async t => {
  const f = await fixture(t), claim = await f.register();
  assert.equal((await f.call('admit')).body.allowed, true);
  const prepared = (await f.call('prepare')).body;
  assert.ok(prepared.context.includes('Proof of Interaction'));
  assert.ok(prepared.context.includes('CHAINCHAT HOST CONTRACT'));
  assert.deepEqual(prepared.toolsAllow, []);
  const final = (await f.call('finalize', { candidate, candidateSha256: hash(candidate) })).body;
  assert.equal(final.allowed, true); assert.equal(final.receipt.reviewed, true);
  assert.equal(f.seen[0].trustedAgentContext.name, 'Cypher Tempre');
  assert.equal((await f.broker.assertCandidate({ claimId: claim.claimId, candidate })).commitOwner, 'chainchat');
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate: candidate + ' changed' }));
  assert.equal((await f.call('outgoing', { candidate: candidate + ' changed' })).body.allowed, false);
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0, 'Individual model candidates cannot double-commit the user turn.');
  assert.equal((await f.call('tool', { tool: { name: 'exec', params: { command: 'echo ungranted' } } })).body.allowed, false);
});
test('low semantic/native scores and changed run identities cannot release output', async t => {
  const f = await fixture(t, { assessment: () => { const result = good(); result.fruitages.love = 179; return result; } });
  const claim = await f.register(); await f.call('admit');
  assert.equal((await f.call('prepare', { runId: 'another-run' })).body.allowed, false);
  assert.equal((await f.call('finalize', { candidate })).body.allowed, false);
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate }));
  assert.equal((await engine({ op: 'inspect', root: f.root })).head.index, 0);
});
test('utility invocations cannot acquire tool rights or pretend to be an active plain call', async t => {
  const f = await fixture(t);
  await assert.rejects(f.register({ purpose: 'plain' }));
  const claim = await f.register({ purpose: 'utility' }); await f.call('admit');
  const prepared = (await f.call('prepare')).body; assert.equal(prepared.context, ''); assert.deepEqual(prepared.toolsAllow, []);
  assert.equal((await f.call('finalize', { candidate: '{"queries":[]}' })).body.purpose, 'utility');
  assert.equal(f.seen.length, 0, 'Review/planning calls cannot recursively trigger model review.');
  assert.equal((await f.call('tool', { tool: { name: 'read', params: {} } })).body.allowed, false);
  f.setTime(Date.now() + 600_000);
  await assert.rejects(f.broker.assertCandidate({ claimId: claim.claimId, candidate: '{"queries":[]}' }));
});
