import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createNativeCompactionStats, validateCompactionStatsRequest } from '../openclaw/plugin/compaction-stats.mjs';

function fixture() {
  const values = new Map(), opened = [], writes = [];
  const store = { lookup: async key => structuredClone(values.get(key)), register: async (key, value) => { writes.push(key); values.set(key, structuredClone(value)); } };
  const target = { sessionKey: 'agent:main:chainchat-control:' + 'b'.repeat(64), sessionId: 'owned-native-session', agentId: 'main', storePath: path.join(os.tmpdir(), 'not-opened-ct-fixture.sqlite') };
  const branch = Array.from({ length: 3 }, (_, index) => [{ id: `u${index}`, type: 'message', message: { role: 'user', content: `Private fixture ${index}` } },
    { id: `a${index}`, type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'Acknowledged.' }], stopReason: 'stop' } }]).flat();
  const sdk = { SessionManager: { openAsync: async value => { opened.push(value); return { getBranch: () => structuredClone(branch) }; } },
    buildSessionContext: entries => ({ messages: entries.filter(entry => entry.type === 'message').map(entry => entry.message) }) };
  const create = () => createNativeCompactionStats({ store, loadSdk: async () => sdk });
  return { registry: create(), create, target, opened, writes, values };
}
test('retained native targets survive helper restart while only fresh non-content metadata is returned', async () => {
  const f = fixture(), request = { sessionKey: f.target.sessionKey, sessionId: f.target.sessionId };
  assert.deepEqual(await f.registry.probe(request), { version: 1, known: false, ...request }); assert.equal(f.opened.length, 0);
  await f.registry.remember(f.target); await f.registry.remember(f.target); assert.equal(f.writes.length, 1);
  const result = await f.create().probe(request);
  assert.equal(result.known, true); assert.equal(result.completeTurns, 3); assert.equal(result.compactable, true);
  assert.match(result.branchSha256, /^[a-f0-9]{64}$/); assert.ok(result.estimatedTokens > 0);
  assert.equal(JSON.stringify(result).includes('Private fixture'), false); assert.equal(JSON.stringify(result).includes(f.target.storePath), false);
  assert.deepEqual(f.opened[0], f.target);
});
test('model-provided paths, wrong sessions, damaged stored bindings and aborted probes acquire no native source', async () => {
  const f = fixture(), request = { sessionKey: f.target.sessionKey, sessionId: f.target.sessionId };
  for (const input of [{ ...request, storePath: '/untrusted' }, { ...request, agentId: 'other' }, { ...request, sessionKey: 'agent:main:other' }])
    assert.throws(() => validateCompactionStatsRequest(input));
  assert.equal(await f.registry.remember({ ...f.target, sessionKey: 'agent:main:scratch' }), false);
  await assert.rejects(f.registry.remember({ ...f.target, storePath: 'relative.sqlite' }));
  await f.registry.remember(f.target);
  assert.equal((await f.registry.probe({ ...request, sessionId: 'another' })).known, false);
  const controller = new AbortController(); controller.abort(); await assert.rejects(f.registry.probe(request, controller.signal));
  const [key] = f.values.keys(); f.values.set(key, { ...f.target, sessionKey: 'agent:main:chainchat-control:' + 'c'.repeat(64) });
  await assert.rejects(f.registry.probe(request)); assert.equal(f.opened.length, 0);
});
