import test from 'node:test';
import assert from 'node:assert/strict';
import { controlSessionKey, createNativeControls, validateControlPatch, redactNativeControl } from '../lib/openclaw-controls.mjs';

const identity = { agentId: 'paired-agent', genesisHash: 'a'.repeat(64) };
function fixture(entry = null) {
  const calls = [], key = controlSessionKey(identity);
  let overlay = { patch: {}, revision: 'r1' };
  const controls = createNativeControls({
    getRuntime: () => ({ hostTools: 'disabled' }), readOverlay: async () => overlay,
    applyOverlay: async patch => calls.push(['apply', patch]),
    saveOverlay: async patch => (overlay = { patch, revision: 'r2' }),
    rpc: async (method, params) => {
      calls.push([method, params]);
      if (method === 'sessions.describe') return { session: entry ? { key, ...entry } : null };
      if (method === 'config.schema') return { schema: { properties: { maxTokens: { type: 'number' } } } };
      if (method === 'config.get') return { config: { gateway: { auth: { token: 'private' } }, maxTokens: 123 } };
      if (method === 'commands.list') return { commands: [{ name: 'think' }] };
      return { ok: true };
    },
  });
  return { controls, calls, key };
}

test('configuration guard preserves numeric token budgets and safe native schema documentation', () => {
  const patch = { agents: { defaults: { compaction: { maxHistoryShare: 0.5 }, contextTokens: 32000 } }, messages: { queue: { cap: 25 } } };
  assert.deepEqual(validateControlPatch(patch), patch);
  for (const patch of [{ gateway: { bind: 'lan' } }, { models: {} }, { agents: { defaults: { workspace: '/tmp' } } },
    { agents: { list: [] } }, { agents: null }, { agents: { defaults: [] } }, { ui: { apiKey: 'private' } }, { tools: { profile: 'full' } }])
    assert.throws(() => validateControlPatch(patch), error => error.code === 'OPENCLAW_SETTING_GUARDED');
  const safe = redactNativeControl({ maxTokens: 100, tokenBudget: 200, contextTokens: 300, token: 'private',
    schema: { token: { type: 'string', description: 'A private operator token.' } }, raw: 'known-secret' }, ['known-secret']);
  assert.equal(safe.maxTokens, 100); assert.equal(safe.tokenBudget, 200); assert.equal(safe.contextTokens, 300);
  assert.equal(safe.token, '[managed private value]'); assert.equal(safe.schema.token.type, 'string'); assert.equal(safe.raw, '[private]');
  assert.deepEqual(validateControlPatch({ tools: { profile: 'full' } }, { allowHostConfiguration: true }), { tools: { profile: 'full' } });
  assert.throws(() => validateControlPatch({ tools: { web: { fetch: { maxRedirects: 3 } } } }, { allowHostConfiguration: true }), error => error.code === 'OPENCLAW_SETTING_GUARDED');
  assert.throws(() => validateControlPatch({ browser: { ssrfPolicy: null } }, { allowHostConfiguration: true }), error => error.code === 'OPENCLAW_SETTING_GUARDED');
});

test('controls select only the verified chain and project no held conversation preview', async () => {
  const f = fixture({ sessionId: 's1', goal: { id: 'g1', tokenBudget: 500 }, lastMessage: 'held response', preview: 'held', thinkingLevel: 'high' });
  const state = await f.controls.sessionControls(identity);
  assert.equal(state.sessionKey, f.key); assert.equal(state.session.thinkingLevel, 'high');
  assert.equal(state.goal.tokenBudget, 500); assert.equal(JSON.stringify(state).includes('held'), false);
  assert.deepEqual(await f.controls.sessionControls(null), { sessionKey: null, session: null, goal: null });
  assert.throws(() => controlSessionKey({ ...identity, genesisHash: 'invalid' }));
});

test('native slash preferences are real schema-backed mutations with session race protection', async () => {
  const f = fixture({ sessionId: 's1' });
  await f.controls.executeCommand({ ...identity, command: '/thinking high' });
  assert.deepEqual(f.calls.at(-1), ['sessions.patch', { key: f.key, expectedSessionId: 's1', thinkingLevel: 'high' }]);
  await f.controls.executeCommand({ ...identity, command: '/fast ultrafast' });
  assert.equal(f.calls.at(-1)[1].fastMode, 'ultrafast');
  await f.controls.executeCommand({ ...identity, command: '/reason default' });
  assert.equal(f.calls.at(-1)[1].reasoningLevel, null);
  await assert.rejects(f.controls.executeCommand({ ...identity, command: '/queue collect' }), error => error.code === 'OPENCLAW_COMMAND_GUARDED');
  await assert.rejects(f.controls.executeCommand({ ...identity, command: '/compact custom instructions' }), error => error.code === 'OPENCLAW_COMMAND_GUARDED');
});

test('goal start and resume return only trusted native run plans; pause invokes durable goal RPC', async () => {
  const fresh = fixture();
  const start = await fresh.controls.executeCommand({ ...identity, command: '/goal start Investigate the example' });
  assert.equal(start.kind, 'turn'); assert.equal(start.message, 'Investigate the example');
  assert.equal(start.native.intent.kind, 'session-goal-start');
  assert.equal(fresh.calls.some(([method]) => method === 'chat.send'), false);
  const existing = fixture({ sessionId: 's1', goal: { id: 'g1', status: 'paused', objective: 'Investigate' } });
  const resume = await existing.controls.executeCommand({ ...identity, command: '/goal resume' });
  assert.equal(resume.native.goalOperation.action, 'resume'); assert.equal(resume.native.goalOperation.goalId, 'g1');
  await existing.controls.executeCommand({ ...identity, command: '/goal pause Stop now' });
  assert.equal(existing.calls.at(-1)[0], 'sessions.goal.update'); assert.equal(existing.calls.at(-1)[1].note, 'Stop now');
});

test('settings concurrency and guard failures never apply native configuration', async () => {
  const f = fixture();
  await assert.rejects(f.controls.updateControls({ revision: 'old', patch: { ui: {} } }), error => error.code === 'OPENCLAW_CONFIG_STALE');
  await assert.rejects(f.controls.updateControls({ revision: 'r1', patch: { gateway: {} } }), error => error.code === 'OPENCLAW_SETTING_GUARDED');
  assert.equal(f.calls.length, 0);
  const result = await f.controls.updateControls({ revision: 'r1', patch: { messages: { queue: { cap: 25 } } } });
  assert.equal(result.config.revision, 'r2'); assert.equal(f.calls[0][0], 'apply');
});
