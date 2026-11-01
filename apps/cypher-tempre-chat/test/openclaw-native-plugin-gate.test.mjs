import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { engine } from '../lib/engine.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

test('an explicitly trusted plugin action passes the real native proposal gate while rejected fruitages never acquire authority', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-plugin-gate-'))), root = path.join(directory, 'chain');
  let broker, low = false; const verdicts = [], events = [];
  t.after(async () => { await broker?.close(); assert.ok(path.basename(directory).startsWith('ct-native-plugin-gate-')); await fs.rm(directory, { recursive: true, force: true }); });
  await engine({ op: 'init', root, name: 'PluginFixture' });
  const before = await engine({ op: 'inspect', root, learning: false });
  const input = 'Please use ct_fixture_marker to write the disposable acceptance marker.';
  const sessionKey = `agent:main:chainchat-control:${'c'.repeat(64)}`;
  broker = createPoIBroker({ engine: async args => {
    try { return await engine(args); } catch (error) { if (error.nativeVerdict) verdicts.push(error.nativeVerdict); throw error; }
  }, review: async () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
    fruitages: Object.fromEntries(FRUITS.map(key => [key, low ? 20 : 240])), usedRings: [], rationale: 'Explicitly requested scoped fixture action.' }) });
  await broker.start();
  await broker.registerInvocation({ sessionKey, invocationId: 'plugin-proposal-fixture',
    config: { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'private-fixture-key' },
    args: { messages: [{ role: 'user', content: input }] }, context: { root, input, purpose: 'candidate', learning: false, loadout: [],
      pluginTools: ['ct_fixture_marker'], toolAuthority: { enabled: true, acknowledged: true, tools: ['ct_fixture_marker'], roots: [], networkHosts: [], allowExecution: false },
      event: (...event) => events.push(event), authorize: async () => {} } });
  const request = async (op, fields = {}) => (await fetch(broker.url, { method: 'POST', headers: {
    authorization: `Bearer ${broker.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, op, sessionKey, runId: 'plugin-proposal-run', ...fields }) })).json();
  assert.equal((await request('admit')).allowed, true); assert.ok((await request('prepare')).toolsAllow.includes('ct_fixture_marker'));
  const tool = callId => ({ name: 'ct_fixture_marker', callId, params: {} });
  const accepted = await request('tool', { tool: tool('permitted-fixture') });
  assert.equal(accepted.allowed, true, JSON.stringify({ accepted, verdicts }));
  low = true; assert.equal((await request('tool', { tool: tool('rejected-fixture') })).allowed, false);
  assert.equal((await engine({ op: 'inspect', root, learning: false })).head.hash, before.head.hash);
  assert.ok(events.some(event => event[1] === 'held'));
});
