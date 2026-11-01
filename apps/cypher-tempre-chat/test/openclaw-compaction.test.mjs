import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReviewedContextEngine, planNativeCompaction, inspectNativeCompaction } from '../openclaw/plugin/compaction.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const buildSessionContext = entries => ({ messages: entries.filter(entry => entry.type === 'message').map(entry => entry.message) });
const entry = (id, role, content) => ({ id, type: 'message', message: { role, content, ...(role === 'toolResult' ? { toolCallId: id } : {}) } });
function fixture({ deny, changed, abort, stale, automaticPadding } = {}) {
  let branch = [entry('u1', 'user', 'Read the approved fixture.'), entry('a1', 'assistant', [
    { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'fixture.txt' } }]),
    entry('t1', 'toolResult', [{ type: 'text', text: 'Fixture: blue.' }]), entry('a2', 'assistant', 'The fixture says blue.'),
    entry('u2', 'user', 'Keep the source.'), entry('a3', 'assistant', 'I will retain the source.'),
    entry('u3', 'user', 'What happened?'), entry('a4', 'assistant', 'The fixture was read.')];
  if (automaticPadding) branch[0].message.content += ' padding'.repeat(5000);
  const appends = [], calls = [], targets = [], controller = new AbortController();
  const sdk = { buildSessionContext, SessionManager: { async openAsync(target) { targets.push(target); return {
    getBranch: () => structuredClone(branch),
    reloadPersistedTranscriptAsync: async () => { if (changed) branch.push(entry('u4', 'user', 'A racing new message.')); },
    appendCompactionAsync: async (...args) => { appends.push(args); },
  }; } } };
  const request = async (op, binding, fields) => {
    calls.push({ op, binding, fields });
    if (deny === op) throw new Error('private-provider-key must never escape');
    if (op === 'model_context') return { allowed: true, context: 'Verified Proof of Interaction context with private model admission.' };
    if (op === 'compaction_prepare') return { allowed: true, claimId: 'private-claim', summary: 'The approved fixture was read and reported as blue.' };
    const receipt = { claimId: fields.claimId, sessionId: fields.sessionId, firstKeptEntryId: fields.firstKeptEntryId,
      branchSha256: fields.branchSha256, summarySha256: fields.summarySha256,
      expiresAt: new Date(Date.now() + (stale ? -10000 : 100000)).toISOString() };
    if (abort === op) controller.abort();
    return { allowed: true, receipt };
  };
  const committed = new Map();
  const commitStore = { async registerIfAbsent(key, value) { if (committed.has(key)) return false; committed.set(key, structuredClone(value)); return true; },
    async lookup(key) { return committed.get(key); } };
  const engine = createReviewedContextEngine({ sdk, request, workspaceDir: 'fixture', commitStore });
  const params = { sessionId: 'session-one', sessionKey: 'agent:main:chainchat-control:' + 'a'.repeat(64),
    sessionTarget: { sessionId: 'session-one', sessionKey: 'agent:main:chainchat-control:' + 'a'.repeat(64), agentId: 'main', storePath: 'fixture.db' },
    force: true, abortSignal: controller.signal };
  return { engine, params, calls, appends, targets, branch: () => structuredClone(branch) };
}

test('compaction preserves complete recent turns and includes tool/result evidence in exact source digest', () => {
  const f = fixture(), plan = planNativeCompaction(f.branch(), buildSessionContext);
  assert.equal(plan.firstKeptEntryId, 'u2');
  assert.equal(plan.branchSha256, digest(f.branch()));
  assert.deepEqual(plan.messages.map(message => message.role), ['user', 'assistant', 'toolResult', 'assistant']);
});

test('every native assembly obtains its PoI context through the private active-session capability', async () => {
  const f = fixture(), result = await f.engine.assemble({ messages: [{ role: 'user', content: 'Hi' }], sessionKey: f.params.sessionKey });
  assert.match(result.systemPromptAddition, /Proof of Interaction/); assert.ok(result.estimatedTokens > 0);
  assert.equal(f.calls[0].op, 'model_context'); assert.match(f.calls[0].binding.runId, /^context-assembly:/);
  const denied = fixture({ deny: 'model_context' });
  assert.equal((await denied.engine.assemble({ messages: [], sessionKey: denied.params.sessionKey })).systemPromptAddition, '');
});

test('native accepted-turn acknowledgements are atomic, idempotent and exact across host retry', async () => {
  const f = fixture(), turn = { advancementKey: 'native-advancement-one', sessionKey: f.params.sessionKey,
    sessionId: f.params.sessionId, admission: { id: 'native-admitted-user' }, terminal: { id: 'native-accepted-terminal' },
    messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }] };
  assert.deepEqual(await f.engine.commitTurn(turn), { status: 'committed' });
  assert.deepEqual(await f.engine.commitTurn(structuredClone(turn)), { status: 'duplicate' });
  await assert.rejects(f.engine.commitTurn({ ...turn, messages: [{ role: 'assistant', content: 'Changed reply' }] }));
  assert.equal(f.engine.info.transcriptSemantics.currentTurnFence, 'before-current-turn-entry-v1');
});

test('only exact reviewed native summary reaches native append after fresh source recheck', async () => {
  const f = fixture(), result = await f.engine.compact(f.params);
  assert.equal(result.ok, true); assert.equal(result.compacted, true);
  assert.deepEqual(f.calls.map(call => call.op), ['compaction_prepare', 'compaction_review', 'compaction_commit']);
  assert.equal(f.appends.length, 1);
  assert.equal(f.appends[0][0], result.result.summary);
  assert.equal(f.appends[0][1], 'u2'); assert.equal(f.appends[0][3].reviewed, true);
  assert.equal(f.calls[1].fields.summarySha256, digest(result.result.summary));
  assert.equal(f.calls[2].fields.receipt.branchSha256, digest(f.branch()));
  assert.equal(f.calls[0].binding.runId, f.calls[2].binding.runId);
});

test('denial, cancellation, stale receipt and transcript races never persist or trigger a fallback', async () => {
  for (const options of [{ deny: 'compaction_prepare' }, { deny: 'compaction_review' }, { deny: 'compaction_commit' },
    { changed: true }, { stale: true }, { abort: 'compaction_review' }, { abort: 'compaction_commit' }]) {
    const f = fixture(options), result = await f.engine.compact(f.params);
    assert.equal(result.ok, false, JSON.stringify(options)); assert.equal(result.compacted, false);
    assert.equal(f.appends.length, 0); assert.equal(JSON.stringify(result).includes('private-provider-key'), false);
  }
});

test('wrong native target, oversized focus, or too little history does not generate a summary', async () => {
  const wrong = fixture(); wrong.params.sessionTarget.sessionId = 'wrong-session';
  assert.equal((await wrong.engine.compact(wrong.params)).compacted, false); assert.equal(wrong.calls.length, 0);
  const focus = fixture(); focus.params.customInstructions = 'x'.repeat(16001);
  assert.equal((await focus.engine.compact(focus.params)).compacted, false); assert.equal(focus.calls.length, 0);
  assert.equal(planNativeCompaction([entry('u1', 'user', 'Hi'), entry('a1', 'assistant', 'Hello')], buildSessionContext), null);
});

test('large histories compact in bounded complete-turn chunks without a cumulative horizon limit', () => {
  const branch = Array.from({ length: 5 }, (_, index) => [entry('u' + index, 'user', 'x'.repeat(180000)), entry('a' + index, 'assistant', 'Received.')]).flat();
  const plan = planNativeCompaction(branch, buildSessionContext);
  assert.equal(plan.firstKeptEntryId, 'u1'); assert.equal(plan.retainedCompleteTurns, 4);
  assert.ok(Buffer.byteLength(JSON.stringify(plan.messages)) <= 288 * 1024);
  assert.throws(() => planNativeCompaction([entry('huge', 'user', 'x'.repeat(288 * 1024)), entry('huge-a', 'assistant', 'Received.'), ...branch], buildSessionContext), /review window/);
  const cumulative = [...Array.from({ length: 20 }, (_, index) => [entry('old' + index, 'user', 'y'.repeat(180000)), entry('olda' + index, 'assistant', 'Received.')]).flat(),
    ...branch, { id: 'last-summary', type: 'compaction', summary: 'Older work was summarized.', firstKeptEntryId: 'u4' },
    entry('u5', 'user', 'Next'), entry('a5', 'assistant', 'Received.'), entry('u6', 'user', 'Another'), entry('a6', 'assistant', 'Received.')];
  const nativeLikeCodec = entries => ({ messages: entries.flatMap(item => item.type === 'compaction'
    ? [{ role: 'user', content: item.summary }] : item.type === 'message' ? [item.message] : []) });
  const next = planNativeCompaction(cumulative, nativeLikeCodec);
  assert.equal(next.firstKeptEntryId, 'u5'); assert.equal(next.messages.length, 3);
  assert.equal(next.messages[0].content, 'Older work was summarized.');
  assert.equal(next.branchSha256, digest(cumulative));
});

test('pending current input and unfinished tools never substitute for recent complete turns', () => {
  const first = [entry('u1', 'user', 'First'), entry('a1', 'assistant', 'First reply'), entry('u2', 'user', 'Second'), entry('a2', 'assistant', 'Second reply')];
  assert.equal(planNativeCompaction([...first, entry('current', 'user', 'Current pending input')], buildSessionContext), null);
  const branch = [...first, entry('u3', 'user', 'Third'), entry('a3', 'assistant', 'Third reply'),
    entry('current', 'user', 'Current pending input'), entry('pending-call', 'assistant', [{ type: 'toolCall', id: 'still-running', name: 'read', arguments: {} }])];
  const plan = planNativeCompaction(branch, buildSessionContext);
  assert.equal(plan.firstKeptEntryId, 'u2'); assert.equal(plan.retainedCompleteTurns, 2);
  assert.deepEqual(plan.messages.map(message => message.content), ['First', 'First reply']);
  assert.equal(JSON.stringify(plan.messages).includes('Current pending input'), false);
});

test('a tool-result pair spanning a user boundary cannot be split by compaction', () => {
  const branch = [entry('u1', 'user', 'Start'), entry('call', 'assistant', [{ type: 'toolCall', id: 'late-result', name: 'read', arguments: {} }]),
    entry('u2', 'user', 'Steering'), entry('late-result', 'toolResult', [{ type: 'text', text: 'Read result' }]), entry('a2', 'assistant', 'Result read'),
    entry('u3', 'user', 'Third'), entry('a3', 'assistant', 'Third reply'), entry('u4', 'user', 'Fourth'), entry('a4', 'assistant', 'Fourth reply')];
  // The cross-boundary result does not make its turn an independently complete
  // retained turn, and the unresolved prefix cannot be cut before that result.
  assert.equal(planNativeCompaction(branch, buildSessionContext), null);
});

test('the published SDK receives the original trusted target without exposing private metadata', async () => {
  const f = fixture(), target = f.params.sessionTarget;
  target.transcriptReadBoundary = { entryId: 'host-owned-boundary' };
  const result = await f.engine.compact(f.params);
  assert.equal(result.compacted, true); assert.equal(f.targets[0], target);
  assert.equal(JSON.stringify(result).includes('host-owned-boundary'), false);
});

test('assembly never writes behind an admitted native session even when its pending prompt exceeds the budget', async () => {
  const f = fixture({ automaticPadding: true }), before = f.branch();
  const result = await f.engine.assemble({ ...f.params, messages: buildSessionContext(before).messages, tokenBudget: 1 });
  assert.equal(result.promptAuthority, 'preassembly_may_overflow'); assert.equal(f.appends.length, 0);
  assert.deepEqual(f.calls.map(call => call.op), ['model_context']); assert.deepEqual(f.branch(), before);
});

test('the private native pre-admission probe returns only fresh budget and branch metadata', async () => {
  const branch = fixture().branch(), opened = [];
  const sdk = { buildSessionContext, SessionManager: { openAsync: async target => { opened.push(target); return { getBranch: () => structuredClone(branch) }; } } };
  const target = { sessionId: 'native-session', sessionKey: 'agent:main:chainchat-control:' + 'c'.repeat(64), agentId: 'main', storePath: 'owned-fixture.sqlite' };
  const result = await inspectNativeCompaction({ sdk, sessionTarget: target });
  assert.equal(opened[0], target); assert.equal(result.branchSha256, digest(branch)); assert.equal(result.compactable, true);
  assert.ok(result.estimatedTokens > 0); assert.equal(JSON.stringify(result).includes('approved fixture'), false);
  assert.equal(Object.hasOwn(result, 'messages'), false);
});
