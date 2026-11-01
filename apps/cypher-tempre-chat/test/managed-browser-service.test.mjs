import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { createManagedBrowserService } from '../lib/managed-browser-service.mjs';

function fixture() {
  const identity = { agentId: 'browser-service-fixture', genesisHash: 'a'.repeat(64) };
  let stored = { revision: 'one', grant: { enabled: true, acknowledged: true, tools: ['browser'], roots: [], networkHosts: ['example.com'], browserCapabilities: { evaluate: false } } };
  const authorities = [], admissions = [];
  const service = createManagedBrowserService({ directory: path.join(os.tmpdir(), 'not-opened-browser-service-fixture'),
    getGrant: async () => structuredClone(stored), assertCurrent: async context => { if (context.revoked) throw new Error('Revoked'); }, protectedRoots: () => [],
    authorizeAction: async (context, action) => { admissions.push({ context, action }); return { allowed: true }; },
    createAuthority: async options => {
      const state = { options, closed: false, starts: 0, paused: 0 }; authorities.push(state);
      return { start: async () => { await options.assertCurrent(); state.starts++; return { profile: 'chainchat-owned', cdpUrl: `http://127.0.0.1:${18000 + authorities.length}` }; },
        inspectAction: async params => { await options.assertCurrent(); return { params, context: { fingerprint: 'fingerprint' } }; },
        assertActionUnchanged: async (_params, fingerprint) => { await options.assertCurrent(); assert.equal(fingerprint, 'fingerprint'); },
        execute: async (params, { callId }) => { await options.assertCurrent(); return options.authorizeAction({ name: 'browser', params, callId }, {}); },
        pauseNetwork: () => state.paused++, close: async () => { state.closed = true; }, describe: () => ({ closed: state.closed }) };
    } });
  const context = () => ({ purpose: 'candidate', nativeIdentity: identity, toolAuthority: structuredClone(stored.grant) });
  return { service, authorities, admissions, context, identity, change: next => { stored = next; }, snapshot: () => structuredClone(stored) };
}

test('managed browser leases remain private, gate actions and stop network access outside an invocation', async t => {
  const f = fixture(); t.after(() => f.service.close());
  assert.equal(await f.service.prepareInvocation({ ...f.context(), purpose: 'utility' }), null);
  const obsolete = f.context(); obsolete.toolAuthority.tools = ['chainchat_browser'];
  assert.equal(await f.service.prepareInvocation(obsolete), null, 'Only the authentic native browser grant acquires a managed profile.');
  const context = f.context(), invocation = await f.service.prepareInvocation(context);
  assert.equal(invocation.config.browser.profiles['chainchat-owned'].attachOnly, true);
  assert.equal(invocation.config.browser.ssrfPolicy.dangerouslyAllowPrivateNetwork, false);
  assert.equal(invocation.config.browser.evaluateEnabled, true, 'Native fixed-function perception uses a private API; model JavaScript is separately gated.');
  assert.equal(f.authorities[0].options.grant.tools.includes('browser'), true);
  assert.equal(f.service.redactionSecrets().includes('http://127.0.0.1:18001'), true);
  await invocation.inspectAction({ action: 'snapshot' });
  await invocation.execute({ action: 'snapshot' }, { callId: 'one' }); assert.equal(f.admissions.length, 1);
  await assert.rejects(f.service.prepareInvocation(f.context()), /already active/);
  await invocation.releaseInvocation();
  await assert.rejects(invocation.inspectAction({ action: 'snapshot' }), /lease expired/);
  assert.ok(f.authorities[0].paused > 0);
  const next = await f.service.prepareInvocation(f.context()); assert.equal(f.authorities.length, 1, 'Same immutable authority can reuse its owned profile.');
  await next.releaseInvocation();
});

test('private native perception always follows the current invocation rather than a cached callback', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const first = await f.service.prepareInvocation({ ...f.context(), inspectNativeTarget: async params => ({ ...params, generation: 1 }) });
  const callback = f.authorities[0].options.inspectNativeTarget;
  assert.equal((await callback({ targetId: 'owned', ref: 'e1' })).generation, 1);
  await first.releaseInvocation(); await assert.rejects(callback({ targetId: 'owned', ref: 'e1' }));
  const second = await f.service.prepareInvocation({ ...f.context(), inspectNativeTarget: async params => ({ ...params, generation: 2 }) });
  assert.equal((await callback({ targetId: 'owned', ref: 'e1' })).generation, 2);
  await second.releaseInvocation();
});

test('grant changes, owner revocation and different chains cannot reuse an old browser lease', async t => {
  const f = fixture(); t.after(() => f.service.close());
  const original = await f.service.prepareInvocation(f.context());
  const changed = f.snapshot(); changed.revision = 'two'; changed.grant.networkHosts = ['different.example']; f.change(changed);
  await assert.rejects(original.inspectAction({ action: 'snapshot' }), /changed or revoked/);
  await original.releaseInvocation();
  const next = await f.service.prepareInvocation(f.context()); assert.equal(f.authorities[0].closed, true); assert.equal(f.authorities.length, 2);
  await f.service.revoke(f.identity); await assert.rejects(next.inspectAction({ action: 'snapshot' }));
  const stale = f.context(); stale.toolAuthority.networkHosts = ['example.com'];
  await assert.rejects(f.service.prepareInvocation(stale), /changed before/);
});
