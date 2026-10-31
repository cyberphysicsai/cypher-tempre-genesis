import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { validateToolAuthority, authorizeToolCall, isPublicAddress } from '../lib/tool-authority.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

async function files(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-host-scope-'));
  const work = path.join(temp, 'documents'), secret = path.join(temp, 'private-chain');
  await fs.mkdir(work); await fs.mkdir(secret);
  await fs.writeFile(path.join(work, 'notes.txt'), 'hello');
  await fs.writeFile(path.join(secret, 'private.txt'), 'private');
  t.after(async () => { assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(temp, { recursive: true, force: true }); });
  const grant = { enabled: true, acknowledged: true, allowExecution: false, tools: ['read', 'write', 'edit'], roots: [work], networkHosts: [] };
  return { temp, work, secret, grant };
}
const call = (name, params, callId = 'test-call') => ({ name, params, callId });
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const good = () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), usedRings: [], rationale: 'The concrete action is appropriate.' });

test('host authority defaults off and rejects unacknowledged, unknown and broad implicit grants', async t => {
  const f = await files(t);
  assert.deepEqual(await validateToolAuthority(), { enabled: false, tools: [], roots: [], networkHosts: [], allowExecution: false, acknowledged: false });
  await assert.rejects(validateToolAuthority({ ...f.grant, acknowledged: false }));
  await assert.rejects(validateToolAuthority({ ...f.grant, tools: ['unknown_plugin_tool'] }));
  await assert.rejects(validateToolAuthority({ ...f.grant, tools: ['exec'] }));
  await assert.rejects(validateToolAuthority({ ...f.grant, injected: true }));
  await assert.rejects(validateToolAuthority({ ...f.grant, roots: [path.parse(f.work).root] }));
  await assert.rejects(authorizeToolCall({}, call('read', { path: path.join(f.work, 'notes.txt') })));
});

test('UNC and device roots and file requests are rejected before a filesystem lookup', async t => {
  const f = await files(t), original = fs.realpath;
  let lookups = 0;
  fs.realpath = async (...args) => { lookups++; return original(...args); };
  try {
    for (const root of ['\\\\server\\share\\directory', '//server/share/directory', '\\\\.\\pipe\\chainchat', '\\\\?\\UNC\\server\\share', '\\\\?\\C:\\private']) {
      const before = lookups;
      await assert.rejects(validateToolAuthority({ ...f.grant, roots: [root] }));
      assert.equal(lookups, before, 'An invalid network/device root must not initiate SMB lookup.');
    }
    const before = lookups;
    await assert.rejects(authorizeToolCall(f.grant, call('read', { path: '\\\\server\\share\\private.txt' })));
    // Grant validation resolves its one explicitly local directory; the tool
    // target itself must never reach realpath.
    assert.equal(lookups, before + 1);
  } finally { fs.realpath = original; }
});

test('file calls bind canonical paths, prevent traversal and protect application/chain roots', async t => {
  const f = await files(t), file = path.join(f.work, 'notes.txt');
  const approved = await authorizeToolCall(f.grant, call('read', { path: file }), { protectedRoots: [f.secret] });
  assert.equal(approved.params.path, await fs.realpath(file));
  const target = path.join(f.work, 'new', 'answer.txt');
  assert.equal((await authorizeToolCall(f.grant, call('write', { file_path: target, content: 'new' }))).params.file_path, target);
  await assert.rejects(authorizeToolCall(f.grant, call('read', { path: path.join(f.work, '..', 'private-chain', 'private.txt') })));
  await assert.rejects(authorizeToolCall(f.grant, call('read', { path: file, file_path: path.join(f.secret, 'private.txt') })));
  await assert.rejects(authorizeToolCall(f.grant, call('write', { path: file, content: 'x', run: 'injected' })));
  await assert.rejects(authorizeToolCall({ ...f.grant, roots: [f.temp] }, call('read', { path: path.join(f.secret, 'private.txt') }), { protectedRoots: [f.secret] }));
  await assert.rejects(validateToolAuthority({ ...f.grant, roots: [f.secret] }, { protectedRoots: [f.secret] }));
  // Junction creation on Windows does not require symlink privileges.
  const link = path.join(f.work, 'escape');
  await fs.symlink(f.secret, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(authorizeToolCall(f.grant, call('read', { path: path.join(link, 'private.txt') })));
  await assert.rejects(authorizeToolCall(f.grant, call('write', { path: path.join(link, 'new.txt'), content: 'x' })));
  const hardlink = path.join(f.work, 'private-hardlink.txt');
  await fs.link(path.join(f.secret, 'private.txt'), hardlink);
  await assert.rejects(authorizeToolCall(f.grant, call('read', { path: hardlink })));
});

test('network calls require an exact public HTTPS hostname and independently verified public DNS', async () => {
  const grant = { enabled: true, acknowledged: true, tools: ['web_fetch'], roots: [], networkHosts: ['Example.COM'], allowExecution: false };
  const options = { lookup: publicLookup };
  assert.equal((await authorizeToolCall(grant, call('web_fetch', { url: 'https://example.com/docs' }), options)).params.url, 'https://example.com/docs');
  for (const url of ['http://example.com/', 'https://other.example/', 'https://example.com:444/', 'https://user:password@example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://example.com.evil.invalid/'])
    await assert.rejects(authorizeToolCall(grant, call('web_fetch', { url }), options));
  await assert.rejects(authorizeToolCall(grant, call('web_fetch', { url: 'https://example.com/' }), { lookup: async () => [{ address: '127.0.0.1' }] }));
  await assert.rejects(authorizeToolCall(grant, call('web_fetch', { url: 'https://example.com/' }), { lookup: async () => [{ address: '93.184.216.34' }, { address: '10.0.0.1' }] }));
  await assert.rejects(validateToolAuthority({ ...grant, tools: ['browser'] }), /managed network adapter/);
  await assert.rejects(authorizeToolCall(grant, call('browser', { action: 'act', targetUrl: 'https://example.com/', request: { kind: 'evaluate', fn: 'x' } }), options));
  await assert.rejects(authorizeToolCall(grant, call('browser', { action: 'open', targetUrl: 'https://example.com/', profile: 'chrome' }), options));
  for (const address of ['0.0.0.0', '10.1.2.3', '127.0.0.2', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.0.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1', '2001:0db8:0::1', '2001:0000::1', '2002::1', '3fff::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('exec/process require a separate broad OS grant and cannot elevate or select another node', async () => {
  const grant = { enabled: true, acknowledged: true, tools: ['exec', 'process'], roots: [], networkHosts: [], allowExecution: true };
  assert.equal((await authorizeToolCall(grant, call('exec', { command: 'echo fixture', host: 'gateway' }))).params.command, 'echo fixture');
  await assert.rejects(authorizeToolCall({ ...grant, allowExecution: false }, call('exec', { command: 'echo denied' })));
  await assert.rejects(authorizeToolCall(grant, call('exec', { command: 'echo denied', elevated: true })));
  await assert.rejects(authorizeToolCall(grant, call('exec', { command: 'echo denied', host: 'node', node: 'other' })));
  await assert.rejects(authorizeToolCall(grant, call('process', { action: 'unknown' })));
});

async function brokerFixture(t, options = {}) {
  const f = await files(t), nativeCalls = [], reviews = [], events = [];
  let head = 'head-one', time = Date.now(), evaluations = 0, authorizations = 0;
  const engine = async request => {
    nativeCalls.push(request);
    const common = { verified: true, genesis: { hash: 'genesis-one', covenant: [...FRUITS] }, head: { hash: head, index: 0 }, runtime: { mode: options.plain ? 'dormant' : 'active' } };
    if (request.op === 'prepare') return { ...common, trustedAgentContext: { name: 'Cypher Tempre' }, loadout: [], frames: [], context: [], availableEvidence: [], recentHistory: [] };
    if (request.op === 'evaluate') { evaluations++; return { accepted: options.nativeReject !== true, verdict: { decision: options.nativeReject ? 'REJECT' : 'SEAL' } }; }
    if (request.op !== 'inspect') throw new Error(`Unexpected mutating native operation: ${request.op}`);
    return common;
  };
  const broker = createPoIBroker({ engine, now: () => time, review: async (_config, args) => { reviews.push(args); await options.onReview?.({ ...f, setHead: value => { head = value; } }); return options.assessment?.() || good(); } });
  await broker.start(); t.after(() => broker.close());
  const config = { apiKey: 'private-test-key-never-show', provider: 'compatible', model: 'fixture' };
  const sessionKey = options.goals && !options.scratch ? `agent:main:chainchat-control:${'a'.repeat(64)}` : 'agent:main:fixture';
  const context = { root: f.secret, input: 'Read my notes.', loadout: [], purpose: options.plain ? 'plain' : options.utility ? 'utility' : 'candidate', toolAuthority: options.disabled ? undefined : f.grant,
    goalAuthority: options.goalAuthority || (options.goals ? { enabled: true, sessionKey, goalId: 'goal-one' } : undefined),
    toolProtectedRoots: [f.secret], event: (...args) => events.push(args), authorize: async () => { authorizations++; if (options.revoked?.()) throw new Error('Revoked'); } };
  await broker.registerInvocation({ context, config, args: { messages: [{ role: 'user', content: context.input }] }, sessionKey, invocationId: 'fixture' });
  const request = async (op, fields = {}) => {
    const response = await fetch(broker.url, { method: 'POST', headers: { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, sessionKey, runId: 'fixture-run', op, ...fields }) });
    return response.json();
  };
  await request('admit'); const prepared = await request('prepare');
  return { ...f, broker, request, prepared, nativeCalls, reviews, events, setHead: value => { head = value; }, setTime: value => { time = value; }, get evaluations() { return evaluations; }, get authorizations() { return authorizations; } };
}

test('a permitted fake tool executes only after exact semantic and native approval without chain writes', async t => {
  const f = await brokerFixture(t), tool = call('read', { path: path.join(f.work, 'notes.txt') });
  assert.deepEqual(f.prepared.toolsAllow, ['read', 'write', 'edit']);
  let executions = 0;
  const result = await f.request('tool', { tool });
  if (result.allowed === true) { executions++; assert.equal(await fs.readFile(result.tool.params.path, 'utf8'), 'hello'); }
  assert.equal(executions, 1); assert.equal(f.reviews.length, 1); assert.equal(f.evaluations, 1);
  assert.deepEqual(JSON.parse(f.reviews[0].candidate).tool, result.tool, 'Actual canonical call is precisely what the reviewer assessed.');
  assert.equal(f.nativeCalls.some(request => ['commit', 'ingest', 'seal'].includes(request.op)), false);
  assert.ok(f.events.some(event => event[1] === 'completed' && event[2].includes('native execution may now begin')));
  assert.equal((await f.request('tool', { tool })).allowed, false, 'A replayed call cannot execute twice.');
});

test('denied, low-fruit, stale-head, native-rejected, reflected-key, expired and revoked fake tools never execute', async t => {
  const variants = [
    { disabled: true }, { utility: true }, { nativeReject: true },
    { assessment: () => { const value = good(); value.fruitages.love = 179; return value; } },
    { onReview: ({ setHead }) => setHead('changed-during-review') },
    { onReview: async ({ work, secret }) => { await fs.unlink(path.join(work, 'notes.txt')); await fs.symlink(path.join(secret, 'private.txt'), path.join(work, 'notes.txt')); } },
  ];
  for (const options of variants) {
    const f = await brokerFixture(t, options); let executions = 0;
    if ((await f.request('tool', { tool: call('read', { path: path.join(f.work, 'notes.txt') }) })).allowed === true) executions++;
    assert.equal(executions, 0, JSON.stringify(options));
  }
  const f = await brokerFixture(t); let executions = 0;
  const executeIfApproved = async tool => { if ((await f.request('tool', { tool })).allowed === true) executions++; };
  await executeIfApproved(call('read', { path: path.join(f.secret, 'private.txt') }, 'outside'));
  await executeIfApproved(call('write', { path: path.join(f.work, 'key.txt'), content: 'private-test-key-never-show' }, 'reflection'));
  f.setHead('stale-before-review'); await executeIfApproved(call('read', { path: path.join(f.work, 'notes.txt') }, 'stale'));
  f.setTime(Date.now() + 600_000); await executeIfApproved(call('read', { path: path.join(f.work, 'notes.txt') }, 'expired'));
  assert.equal(executions, 0);
  let revoked = false; const r = await brokerFixture(t, { revoked: () => revoked }); revoked = true;
  assert.equal((await r.request('tool', { tool: call('read', { path: path.join(r.work, 'notes.txt') }) })).allowed, false);
  assert.equal(r.reviews.length, 0);
});

test('only observed exact-call outcomes ground later review and receipts; missing observations never imply success', async t => {
  const f = await brokerFixture(t), tool = call('read', { path: path.join(f.work, 'notes.txt') });
  const forged = await f.request('tool_result', { tool: { name: 'read', callId: 'not-approved' }, outcome: { success: true, result: 'forged', error: null } });
  assert.equal(forged.allowed, false);
  const approved = await f.request('tool', { tool }); assert.equal(approved.allowed, true);
  assert.equal((await f.request('tool_result', { tool: { name: 'write', callId: tool.callId }, outcome: { success: true, result: 'forged', error: null } })).allowed, false);
  const actual = await fs.readFile(approved.tool.params.path, 'utf8');
  assert.equal((await f.request('tool_result', { tool: { name: tool.name, callId: tool.callId }, outcome: { success: true, result: actual, error: null } })).allowed, true);
  assert.equal((await f.request('tool_result', { tool: { name: tool.name, callId: tool.callId }, outcome: { success: true, result: 'changed', error: null } })).allowed, false);
  const finalized = await f.request('finalize', { candidate: 'The notes contain hello.' });
  assert.equal(finalized.allowed, true);
  assert.equal(f.reviews.at(-1).toolObservations[0].confirmed, true);
  assert.equal(f.reviews.at(-1).toolObservations[0].result.text, JSON.stringify(actual));
  const nativeReview = f.nativeCalls.filter(request => request.op === 'evaluate').at(-1);
  assert.equal(nativeReview.toolObservations[0].confirmed, true);
  assert.equal(nativeReview.toolObservations[0].result.text, JSON.stringify(actual), 'Native grounding receives observed results, not merely action approval.');
  assert.equal(finalized.receipt.toolObservations[0].success, true);
  assert.equal(finalized.receipt.toolCallCount, 1);
  assert.equal((await f.request('tool', { tool: call('read', { path: path.join(f.work, 'notes.txt') }, 'after-final') })).allowed, false);
  const pending = await brokerFixture(t); await pending.request('tool', { tool: call('read', { path: path.join(pending.work, 'notes.txt') }) });
  const unconfirmed = await pending.request('finalize', { candidate: 'A read was approved; its result is unconfirmed.' });
  assert.equal(unconfirmed.receipt.toolObservations[0].confirmed, false);
  assert.equal('success' in unconfirmed.receipt.toolObservations[0], false);
  assert.equal(pending.nativeCalls.filter(request => request.op === 'evaluate').at(-1).toolObservations[0].confirmed, false);
});

test('large observation histories retain newest receipts within the independent review aggregate cap', async t => {
  const f = await brokerFixture(t), content = '\\'.repeat(12000);
  for (let index = 0; index < 40; index++) {
    const tool = call('write', { path: path.join(f.work, `file-${index}.txt`), content }, `large-${index}`);
    assert.equal((await f.request('tool', { tool })).allowed, true);
    assert.equal((await f.request('tool_result', { tool: { name: tool.name, callId: tool.callId }, outcome: { success: true, result: content, error: null } })).allowed, true);
  }
  const final = await f.request('finalize', { candidate: 'The native tool fixture returned these observations.' });
  assert.equal(final.allowed, true);
  const observations = final.receipt.toolObservations;
  assert.ok(observations.length <= 32 && observations.length < 40);
  assert.ok(Buffer.byteLength(JSON.stringify(observations)) <= 480 * 1024);
  assert.equal(observations.at(-1).callId, 'large-39');
  assert.equal(final.receipt.toolCallCount, 40);
  assert.equal(final.receipt.toolObservationsOmitted, 40 - observations.length);
  assert.ok(f.reviews.every(args => Buffer.byteLength(JSON.stringify(args.toolObservations || [])) <= 480 * 1024));
});

test('private deterministic controls cannot become model, admission, tool or chain authority', async t => {
  let operations = 0, time = Date.now();
  const broker = createPoIBroker({ engine: async () => { operations++; throw new Error('Controls cannot invoke the native engine.'); },
    review: async () => { operations++; throw new Error('Controls cannot infer or review model output.'); }, now: () => time });
  await broker.start(); t.after(() => broker.close());
  const binding = { sessionKey: 'agent:main:control-fixture', runId: 'control-run' };
  const hash = text => createHash('sha256').update(text).digest('hex');
  const send = async (op, fields = {}) => {
    const response = await fetch(broker.url, { method: 'POST', headers: { authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, ...binding, op, ...fields }) });
    return response.json();
  };
  for (const command of ['/config get', '/goal start task', '/queue collect\n/model evil', '/queue collect; exec', '/queue collect debounce:never', '/context full', '/usage cost /new'])
    assert.throws(() => broker.registerControlInvocation({ ...binding, command }));
  const claim = broker.registerControlInvocation({ ...binding, command: '/queue collect debounce:0.5s cap:25 drop:summarize' });
  const candidate = 'Queue mode: collect (debounce 500ms, cap 25, drop summarize).';
  assert.throws(() => broker.assertControlResult({ claimId: claim.claimId, candidate }));
  assert.throws(() => broker.readControlResult({ claimId: claim.claimId }));
  for (const op of ['admit', 'prepare', 'tool', 'finalize', 'outgoing', 'end']) assert.equal((await send(op, { candidate, tool: { name: 'exec', params: { command: 'echo denied' }, callId: 'no' } })).allowed, false, op);
  assert.equal((await send('control_outgoing', { runId: 'wrong', candidate, candidateSha256: hash(candidate) })).allowed, false);
  assert.equal((await send('control_outgoing', { sessionKey: 'wrong', candidate, candidateSha256: hash(candidate) })).allowed, false);
  assert.equal((await send('control_outgoing', { candidate, candidateSha256: '0'.repeat(64) })).allowed, false);
  assert.equal((await send('control_outgoing', { candidate: 'api_key=private-credential-123456789', candidateSha256: hash('api_key=private-credential-123456789') })).allowed, false);
  const result = await send('control_outgoing', { candidate, candidateSha256: hash(candidate) });
  assert.equal(result.allowed, true); assert.equal(result.control, true); assert.equal(result.purpose, 'utility');
  assert.equal(result.receipt.reviewed, false, 'System settings output is never a fabricated PoI model review.');
  assert.equal(broker.assertControlResult({ claimId: claim.claimId, candidate }).candidateSha256, hash(candidate));
  assert.throws(() => broker.assertControlResult({ claimId: claim.claimId, candidate: `${candidate} altered` }));
  for (let variant = 2; variant <= 4; variant++) {
    const formatted = `${candidate}\nNative usage/status footer ${variant}`;
    const attested = await send('control_outgoing', { candidate: formatted, candidateSha256: hash(formatted) });
    assert.equal(attested.allowed, true);
    assert.equal(attested.receipt.commandSha256, hash('/queue collect debounce:0.5s cap:25 drop:summarize'));
    assert.deepEqual(attested.receipt.binding, binding);
    assert.equal(broker.assertControlResult({ claimId: claim.claimId, candidate: formatted }).candidateSha256, hash(formatted));
    assert.equal(broker.readControlResult({ claimId: claim.claimId }).text, formatted);
  }
  assert.equal((await send('control_outgoing', { candidate: 'Fifth unattested output', candidateSha256: hash('Fifth unattested output') })).allowed, false);
  assert.equal((await send('control_outgoing', { candidate, candidateSha256: hash(candidate) })).allowed, true, 'Existing immutable variants remain attestable.');
  assert.equal(operations, 0);
  broker.finishControlInvocation({ claimId: claim.claimId });
  assert.throws(() => broker.readControlResult({ claimId: claim.claimId }));
  assert.equal((await send('control_outgoing', { candidate, candidateSha256: hash(candidate) })).allowed, false);
  const expired = broker.registerControlInvocation({ ...binding, command: '/context json' }); time += 61_000;
  assert.throws(() => broker.assertControlResult({ claimId: expired.claimId, candidate }));
  assert.throws(() => broker.readControlResult({ claimId: expired.claimId }));
  assert.equal((await send('control_outgoing', { candidate, candidateSha256: hash(candidate) })).allowed, false);
});

test('ordinary model candidates cannot acquire deterministic control output receipts', async t => {
  const f = await brokerFixture(t);
  assert.equal((await f.request('control_outgoing', { candidate: 'Model wrote this', candidateSha256: createHash('sha256').update('Model wrote this').digest('hex') })).allowed, false);
  assert.throws(() => f.broker.readControlResult({ claimId: 'not-a-control-claim' }));
  assert.throws(() => f.broker.registerControlInvocation({ sessionKey: 'agent:main:fixture', runId: 'fixture-run', command: '/context list' }));
});

test('own-session native goals work without host grants and receive the full semantic/native gate', async t => {
  const f = await brokerFixture(t, { goals: true, disabled: true });
  assert.deepEqual(f.prepared.toolsAllow, ['get_goal', 'update_goal']);
  const get = call('get_goal', {}, 'goal-read');
  assert.equal((await f.request('tool', { tool: get })).allowed, true);
  assert.equal((await f.request('tool_result', { tool: { name: get.name, callId: get.callId }, outcome: { success: true, result: { goal: { id: 'goal-one', status: 'active' } }, error: null } })).allowed, true);
  const update = call('update_goal', { status: 'complete', note: 'The requested work was verified.' }, 'goal-complete');
  const approved = await f.request('tool', { tool: update });
  assert.equal(approved.allowed, true); assert.deepEqual(approved.tool.params, update.params);
  assert.equal(f.reviews.length, 2); assert.equal(f.evaluations, 2);
  assert.equal(f.nativeCalls.filter(request => request.op === 'evaluate').at(-1).toolObservations[0].confirmed, true);
  assert.equal(f.nativeCalls.some(request => ['commit', 'ingest'].includes(request.op)), false);
  assert.equal((await f.request('tool', { tool: call('exec', { command: 'echo no-host-grant' }, 'not-goal') })).allowed, false);
  assert.equal((await f.request('tool', { tool: call('create_goal', { objective: 'An unauthorized new objective' }, 'create') })).allowed, false);
});

test('goal tools reject other sessions, utility/plain/scratch calls, target fields, extra actions and low fruit scores', async t => {
  await assert.rejects(brokerFixture(t, { goals: true, goalAuthority: { enabled: true, sessionKey: 'agent:main:other', goalId: 'other' } }));
  await assert.rejects(brokerFixture(t, { goals: true, scratch: true }));
  for (const flags of [{}, { goals: true, utility: true }, { goals: true, plain: true }]) {
    const f = await brokerFixture(t, { ...flags, disabled: true });
    assert.equal(f.prepared.toolsAllow.includes('get_goal'), false);
    assert.equal((await f.request('tool', { tool: call('get_goal', {}) })).allowed, false);
  }
  const f = await brokerFixture(t, { goals: true, disabled: true });
  const denied = [call('get_goal', { sessionKey: 'another' }, 'other-session'), call('get_goal', { path: '/private' }, 'path'),
    call('update_goal', { status: 'complete', agentId: 'other' }, 'other-agent'), call('update_goal', { status: 'paused' }, 'pause'),
    call('update_goal', { status: 'complete', note: 'x'.repeat(2001) }, 'oversized'), call('update_goal', { status: 'blocked', objective: 'replaced' }, 'replace')];
  for (const tool of denied) assert.equal((await f.request('tool', { tool })).allowed, false);
  assert.equal((await f.request('tool', { tool: call('update_goal', { status: 'blocked', note: 'A repeated external blocker prevents further progress.' }, 'blocked') })).allowed, true);
  const low = await brokerFixture(t, { goals: true, disabled: true, assessment: () => { const value = good(); value.fruitages.kindness = 179; return value; } });
  assert.equal((await low.request('tool', { tool: call('update_goal', { status: 'complete' }) })).allowed, false);
  assert.equal(low.evaluations, 0);
});
