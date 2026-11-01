/** Session-memory-only native channel credentials. There is no serialization API. */
import { randomBytes } from 'node:crypto';
const fail = () => Object.assign(new Error('A bounded explicitly configured native channel credential is required.'), { code: 'CHANNEL_CREDENTIAL_INVALID', status: 400 });
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
export function createChannelCredentialVault() {
  const entries = new Map(), pending = new Map();
  const key = (ownerId, channelId, accountId) => JSON.stringify([ownerId, channelId, accountId]);
  function stage({ ownerId, channelId, accountId, credentials }) {
      if (!id(ownerId) || !id(channelId) || !id(accountId) || !credentials || typeof credentials !== 'object' || Array.isArray(credentials) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(credentials)) ||
          !Object.keys(credentials).length || Object.keys(credentials).length > 16 || Object.entries(credentials).some(([name, value]) =>
            !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || ['constructor', 'prototype'].includes(name) || typeof value !== 'string' || !value || Buffer.byteLength(value) > 8192 || /[\0\r\n]/.test(value)) ||
          new Set(Object.keys(credentials).map(name => name.toUpperCase())).size !== Object.keys(credentials).length ||
          entries.size + pending.size >= 128 && !entries.has(key(ownerId, channelId, accountId)) || pending.has(key(ownerId, channelId, accountId))) throw fail();
      const reference = randomBytes(16).toString('hex'), environment = {}, fields = {};
      for (const [name, value] of Object.entries(credentials)) {
        const variable = 'CHAINCHAT_CHANNEL_' + reference.toUpperCase() + '_' + name.toUpperCase();
        environment[variable] = value; fields[name] = '${' + variable + '}';
      }
      const identity = key(ownerId, channelId, accountId), previous = entries.get(identity), marker = {};
      const candidate = { reference, environment, fields };
      const connection = { connected: true, reference, fields: structuredClone(fields), persistence: 'session-memory', reconnectAfterRestart: true };
      pending.set(identity, marker);
      return { connection,
        environment: () => structuredClone(environment), previousEnvironment: () => structuredClone(previous?.environment || {}),
        commit() { if (pending.get(identity) !== marker || entries.get(identity) !== previous) throw fail();
          entries.set(identity, candidate); pending.delete(identity); return structuredClone(connection); },
        abort() { if (pending.get(identity) === marker) pending.delete(identity); },
      };
  }
  return {
    stage,
    connect(input) { return stage(input).commit(); },
    environment(ownerId, channelId, accountId) {
      const entry = entries.get(key(ownerId, channelId, accountId)); if (!entry) throw fail();
      return structuredClone(entry.environment);
    },
    status(ownerId, channelId, accountId) { return { connected: entries.has(key(ownerId, channelId, accountId)), persistence: 'session-memory', reconnectAfterRestart: true }; },
    disconnect(ownerId, channelId, accountId) { const identity = key(ownerId, channelId, accountId); pending.delete(identity); entries.delete(identity); },
    close() { pending.clear(); entries.clear(); },
  };
}

/** Serialize account replacements so one rollback cannot overwrite a different
 * account's environment. The previous vault entry is authoritative until the
 * owned child has adopted the new exact config and shed all old variables. */
export function createManagedChannelAccounts({ vault, getEnvironment, setEnvironment, applyAccount, markSecrets = () => {}, halt } = {}) {
  if (!vault?.stage || [getEnvironment, setEnvironment, applyAccount, markSecrets, halt].some(value => typeof value !== 'function')) throw fail();
  const configurations = new Map(); let queue = Promise.resolve();
  return { configure(input) {
    const operation = queue.then(async () => {
      const { ownerId, channelId, accountId, credentials, config } = input;
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw fail();
      const identity = JSON.stringify([ownerId, channelId, accountId]), previousConfig = configurations.get(identity);
      const previousEnvironment = structuredClone(getEnvironment()), staged = vault.stage({ ownerId, channelId, accountId, credentials });
      const nextEnvironment = staged.environment(), oldVariables = Object.keys(staged.previousEnvironment());
      const account = { ...structuredClone(config), ...staged.connection.fields, enabled: true };
      try {
        markSecrets(Object.values(nextEnvironment));
        // Retain old references until the old owned process is fully stopped.
        setEnvironment({ ...previousEnvironment, ...nextEnvironment });
        await applyAccount(channelId, accountId, account, { forceReload: false });
        const cleanEnvironment = structuredClone(getEnvironment());
        for (const name of oldVariables) delete cleanEnvironment[name];
        setEnvironment(cleanEnvironment);
        if (oldVariables.length) await applyAccount(channelId, accountId, account, { forceReload: true });
        const connection = staged.commit(); configurations.set(identity, structuredClone(account));
        return connection;
      } catch (error) {
        setEnvironment(previousEnvironment);
        try { await applyAccount(channelId, accountId, previousConfig || { enabled: false }, { forceReload: true }); }
        catch {
          // An uncertain runtime must not keep using either credential set.
          // Stop only this installation's owned runtime and require relaunch.
          try { await halt(); } finally { staged.abort(); }
          throw Object.assign(new Error('Channel replacement could not restore its prior configuration. The owned runtime was stopped; relaunch the application before reconnecting.'),
            { code: 'CHANNEL_REPLACEMENT_HELD', status: 503 });
        }
        staged.abort(); throw error;
      }
    });
    queue = operation.catch(() => {}); return operation;
  } };
}
