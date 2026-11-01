import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelCredentialVault, createManagedChannelAccounts } from '../lib/managed-channel-credentials.mjs';

function fixture() {
  const vault = createChannelCredentialVault(), applications = [], secrets = new Set();
  let environment = {}, config, failure = null, halted = false;
  const accounts = createManagedChannelAccounts({ vault, getEnvironment: () => environment, setEnvironment: value => { environment = value; },
    markSecrets: values => values.forEach(value => secrets.add(value)), halt: async () => { halted = true; },
    applyAccount: async (channelId, accountId, next, options) => {
      config = structuredClone(next); applications.push({ channelId, accountId, config, options, environment: structuredClone(environment) });
      if (failure?.(next, applications.length)) throw new Error('Fixture failed after attempting native reconfiguration.');
    } });
  const configure = (credentials, config = {}) => accounts.configure({ ownerId: 'owner', channelId: 'fixture', accountId: 'default', credentials, config });
  return { vault, configure, applications, secrets, environment: () => structuredClone(environment), config: () => structuredClone(config),
    fail: value => { failure = value; }, halted: () => halted };
}

test('replacement drops omitted credential fields and old child variables only after exact config adoption', async () => {
  const f = fixture();
  await f.configure({ password: 'old-password-fixture', botToken: 'old-token-fixture' }, { endpoint: 'old' });
  const oldVariables = Object.keys(f.environment());
  const connected = await f.configure({ botToken: 'new-token-fixture' }, { endpoint: 'new' });
  assert.equal(JSON.stringify(connected).includes('new-token-fixture'), false);
  assert.equal(f.config().password, undefined); assert.equal(f.config().endpoint, 'new');
  assert.deepEqual(Object.values(f.environment()), ['new-token-fixture']);
  assert.deepEqual(f.environment(), f.vault.environment('owner', 'fixture', 'default'));
  const adopting = f.applications[1], cleaned = f.applications[2];
  assert.ok(oldVariables.every(name => Object.hasOwn(adopting.environment, name)), 'The previous references survive until the old child stops.');
  assert.ok(oldVariables.every(name => !Object.hasOwn(cleaned.environment, name)));
  assert.equal(cleaned.options.forceReload, true, 'The replacement child must not inherit revoked variables.');
  assert.equal(f.halted(), false);
});

test('a failed replacement restores the previous vault, exact account and environment rather than abandoning live old credentials', async () => {
  const f = fixture(); await f.configure({ password: 'prior-password-fixture' }, { endpoint: 'prior' });
  const originalEnvironment = f.environment(), originalConfig = f.config();
  f.fail(next => next.endpoint === 'failed');
  await assert.rejects(f.configure({ botToken: 'failed-new-token-fixture' }, { endpoint: 'failed' }), /Fixture failed/);
  assert.deepEqual(f.environment(), originalEnvironment); assert.deepEqual(f.config(), originalConfig);
  assert.deepEqual(f.vault.environment('owner', 'fixture', 'default'), originalEnvironment);
  assert.equal(f.vault.status('owner', 'fixture', 'default').connected, true); assert.equal(f.halted(), false);
  assert.equal(f.applications.at(-1).options.forceReload, true);
  f.fail(null); await f.configure({ botToken: 'later-success-fixture' });
  assert.equal(f.config().password, undefined); assert.deepEqual(Object.values(f.environment()), ['later-success-fixture']);
});

test('failed rollback halts the owned runtime and cannot commit a pending credential stage', async () => {
  const f = fixture(); await f.configure({ password: 'prior-password-fixture' });
  const prior = f.environment(); f.fail(() => true);
  await assert.rejects(f.configure({ token: 'not-adopted' }), error => error.code === 'CHANNEL_REPLACEMENT_HELD');
  assert.equal(f.halted(), true); assert.deepEqual(f.vault.environment('owner', 'fixture', 'default'), prior);
  assert.deepEqual(f.environment(), prior);
});

test('vault stages retain prior credentials, deny concurrent replacement and cannot revive after disconnect', () => {
  const vault = createChannelCredentialVault(), input = { ownerId: 'owner', channelId: 'fixture', accountId: 'default' };
  vault.connect({ ...input, credentials: { password: 'prior-fixture' } });
  const prior = vault.environment('owner', 'fixture', 'default'), staged = vault.stage({ ...input, credentials: { token: 'staged-fixture' } });
  assert.deepEqual(vault.environment('owner', 'fixture', 'default'), prior);
  assert.throws(() => vault.stage({ ...input, credentials: { token: 'concurrent-fixture' } }));
  assert.equal(JSON.stringify(staged).includes('staged-fixture'), false);
  vault.disconnect('owner', 'fixture', 'default'); assert.throws(() => staged.commit()); staged.abort();
  assert.equal(vault.status('owner', 'fixture', 'default').connected, false);
});
