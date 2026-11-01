import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeBrowserInspector, NATIVE_BROWSER_ELEMENT_INSPECTION } from '../lib/native-browser-inspection.mjs';

const params = { targetId: 'owned-target', ref: 'e17' };
const metadata = () => ({ connected: true, tag: 'BUTTON', type: '', role: 'button', name: '', label: 'Save note', href: '', text: 'Save note',
  disabled: false, credentialForm: false, url: 'https://example.com/', documentIdentity: 123456,
  bounds: { x: 10, y: 20, width: 100, height: 30 } });
const response = () => ({ ok: true, targetId: params.targetId, url: 'https://example.com/', result: metadata() });

test('native reference perception uses only the fixed native cache inspection and checks current authority twice', async () => {
  const calls = []; let checks = 0, isolated;
  const inspect = createNativeBrowserInspector({ assertCurrent: async passed => { checks++; assert.deepEqual(passed, params); },
    assertIsolation: value => { isolated = value; }, rpc: async (method, request) => { calls.push({ method, request }); return response(); } });
  assert.deepEqual(await inspect(params), metadata()); assert.equal(checks, 2); assert.deepEqual(isolated, metadata());
  assert.deepEqual(calls, [{ method: 'browser.request', request: { method: 'POST', path: '/act', target: 'host', query: { profile: 'chainchat-owned' },
    body: { kind: 'evaluate', ...params, fn: NATIVE_BROWSER_ELEMENT_INSPECTION, timeoutMs: 10000 }, timeoutMs: 12000 } }]);
  for (const untrusted of [{ ...params, fn: 'fetch(secret)' }, { ...params, profile: 'personal' }, { ...params, targetId: '../target' },
    { ...params, ref: 'x); sideEffect()' }, { targetId: 'owned-target' }]) await assert.rejects(inspect(untrusted));
  assert.equal(calls.length, 1, 'Untrusted source and routing parameters must never reach native RPC.');
  const svg = response(); svg.result.tag = 'svg';
  assert.equal((await createNativeBrowserInspector({ assertCurrent: async () => {}, rpc: async () => svg })(params)).tag, 'svg');
});

test('native perception rejects disconnected/stale/invalid metadata and invocation revocation', async () => {
  for (const change of [value => { value.ok = false; }, value => { value.targetId = 'foreign-target'; }, value => { value.result.connected = false; },
    value => { value.result.bounds.x = Infinity; }, value => { value.result.bounds.height = -1; }, value => { value.result.url = 'https://changed.example/'; },
    value => { value.result.value = 'must-never-be-inspected'; }, value => { value.result.text = 'x'.repeat(1501); }]) {
    const value = response(); change(value);
    await assert.rejects(createNativeBrowserInspector({ assertCurrent: async () => {}, rpc: async () => value })(params));
  }
  let calls = 0;
  const revoked = createNativeBrowserInspector({ assertCurrent: async () => { if (++calls === 2) throw new Error('Revoked while inspecting.'); }, rpc: async () => response() });
  await assert.rejects(revoked(params), /Revoked/);
  await assert.rejects(createNativeBrowserInspector({ assertCurrent: async () => {}, rpc: async () => response(),
    assertIsolation: () => { throw new Error('Private control value cannot leave its owner.'); } })(params), /Private control/);
});
