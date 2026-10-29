import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULT_AUDIT_BRIDGE, normalizeBridgeURL } from '../public/audit/bridge-url.js';

test('auditor bridge URLs cannot send pairing credentials off this machine', () => {
  assert.equal(normalizeBridgeURL(DEFAULT_AUDIT_BRIDGE), DEFAULT_AUDIT_BRIDGE);
  assert.equal(normalizeBridgeURL(' http://localhost:8788/ '), 'http://localhost:8788');
  for (const value of [
    'https://example.com', 'http://127.0.0.1.example.com:8788',
    'http://localhost@evil.example:8788', 'http://user:pass@127.0.0.1:8788',
    'http://127.0.0.1:8788/api', 'http://127.0.0.1:8788/?token=secret',
    'http://127.0.0.1:8788/#secret', 'file:///etc/passwd', 'javascript:alert(1)',
  ]) assert.throws(() => normalizeBridgeURL(value), Error, value);
});

test('auditor removes previously persisted credentials and preserves only its in-memory session', async () => {
  const source = await readFile(new URL('../public/audit/app.js', import.meta.url), 'utf8');
  // Run the actual startup helpers without starting the DOM/canvas dashboard.
  const bootstrap = source.slice(source.indexOf('const state ='), source.indexOf('function initMotifs()'));
  const storage = new Map([['ctBridgeToken', 'old-persisted-secret'], ['ctBridgeBase', DEFAULT_AUDIT_BRIDGE]]);
  const input = { value: '' };
  const context = vm.createContext({
    URLSearchParams, DEFAULT_AUDIT_BRIDGE, normalizeBridgeURL,
    window: { location: { hostname: '127.0.0.1', pathname: '/audit/', search: '' } },
    document: { getElementById: () => input },
    localStorage: { getItem: (k) => storage.get(k), removeItem: (k) => storage.delete(k) },
  });
  vm.runInContext(bootstrap + '\nsetupBridgeState();', context);
  assert.equal(storage.has('ctBridgeToken'), false);
  assert.equal(vm.runInContext('state.hostedMode', context), true);
  assert.equal(vm.runInContext('state.bridgeBase', context), DEFAULT_AUDIT_BRIDGE);
  assert.equal(vm.runInContext('state.bridgeToken', context), '');
  vm.runInContext('state.bridgeToken = "memory-only"; setupBridgeState();', context);
  assert.equal(vm.runInContext('state.bridgeToken', context), 'memory-only');
  assert.equal(storage.has('ctBridgeToken'), false);
  storage.set('ctBridgeBase', 'http://localhost:8790');
  vm.runInContext('setupBridgeState();', context);
  assert.equal(vm.runInContext('state.bridgeToken', context), '');
  assert.equal(vm.runInContext('state.bridgeBase', context), 'http://localhost:8790');
});
