import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

const assessment = () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), usedRings: [],
  rationale: 'The actual prior introduction is preserved in canonical history; this is a proposed own-session status transition, not a report that it has executed.' });

test('a real native gate reviews a resumed own-goal transition using verified goal state without crediting proposed parameters as facts', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-goal-gate-'));
  const root = path.join(directory, 'chain');
  let broker;
  t.after(async () => {
    await broker?.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('ct-native-goal-gate-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await engine({ op: 'init', root, name: 'NativeGoalFixture' });
  const initial = await engine({ op: 'inspect', root, learning: false });
  const introduction = "Hello! I'm NativeGoalFixture. I can help with care, patience and honesty.";
  const written = await engine({ op: 'commit', root, expectedHead: initial.head.hash,
    input: 'Please introduce yourself', output: introduction, scores: assessment().scores,
    assessment: assessment(), usedRings: [], loadout: [], learning: false, growth: false });
  assert.equal(written.sealed, true);
  const sessionKey = `agent:main:chainchat-control:${'a'.repeat(64)}`, goalId = 'native-goal-regression';
  const input = 'Continue pursuing the current goal.';
  let reviewMode = 'approve', goalReads = 0;
  const calls = [], reviews = [], verdicts = [], events = [];
  broker = createPoIBroker({ engine: async request => {
    calls.push(request);
    try { return await engine(request); }
    catch (error) { if (error.nativeVerdict) verdicts.push(error.nativeVerdict); throw error; }
  }, review: async (_config, args) => {
    reviews.push(args);
    const value = assessment();
    if (reviewMode === 'low') value.fruitages.love = 179;
    if (reviewMode === 'reject') value.approved = false;
    return value;
  } });
  await broker.start();
  await broker.registerInvocation({ sessionKey, invocationId: 'native-goal-gate-regression',
    config: { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'private-fixture-key' },
    args: { messages: [{ role: 'user', content: input }] },
    context: { root, input, purpose: 'candidate', loadout: [], settings: { recall: true },
      goalAuthority: { enabled: true, sessionKey, goalId },
      readNativeGoal: async () => { goalReads++; return { id: goalId, objective: 'Please introduce yourself', status: 'active' }; },
      event: (...event) => events.push(event), authorize: async () => {} } });
  const request = async (op, fields = {}) => {
    const response = await fetch(broker.url, { method: 'POST', headers: {
      authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, op, sessionKey, runId: 'native-goal-gate-run', ...fields }) });
    return response.json();
  };
  assert.equal((await request('admit')).allowed, true);
  assert.deepEqual((await request('prepare')).toolsAllow, ['get_goal', 'update_goal']);
  const tool = callId => ({ name: 'update_goal', callId,
    params: { status: 'complete', note: 'The requested fixture introduction was delivered and verified.' } });
  const accepted = await request('tool', { tool: tool('verified-completion-proposal') });
  assert.equal(accepted.allowed, true, JSON.stringify({ response: accepted, nativeVerdicts: verdicts }));
  assert.ok(goalReads > 0, 'The private native goal snapshot must be freshly read before authorizing the transition.');
  assert.equal(reviews[0].input, input, 'The semantic reviewer retains the actual request, not synthetic assertions that the action already ran.');
  assert.ok(reviews[0].recentConversation.some(message => message.content === introduction), 'The completed introduction is real committed/released history.');
  const evaluated = calls.filter(request => request.op === 'evaluate').at(-1);
  assert.equal(JSON.parse(evaluated.output).tool.params.status, 'complete');
  assert.equal((await engine({ op: 'inspect', root, learning: false })).head.hash, written.head.hash, 'Approving a proposal never appends a Timechain block.');
  for (const mode of ['low', 'reject']) {
    reviewMode = mode;
    const count = calls.filter(request => request.op === 'evaluate').length;
    assert.equal((await request('tool', { tool: tool(`critic-${mode}`) })).allowed, false);
    assert.equal(calls.filter(request => request.op === 'evaluate').length, count, 'A rejected semantic assessment never reaches native action admission.');
  }
  assert.ok(events.some(event => event[1] === 'held'));
});
