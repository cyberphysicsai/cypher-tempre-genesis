import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createBrowserAuthority } from './browser-authority.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const denied = message => Object.assign(new Error(message), { code: 'MANAGED_BROWSER_DENIED', status: 403 });
function identityKey(identity) {
  if (!identity || typeof identity.agentId !== 'string' || !identity.agentId || identity.agentId.length > 512 ||
      typeof identity.genesisHash !== 'string' || !/^[a-f0-9]{64}$/i.test(identity.genesisHash)) throw denied('A verified native agent identity is required for browser access.');
  return hash({ agentId: identity.agentId, genesisHash: identity.genesisHash.toLowerCase() });
}

/** Parent-process coordinator. It never accepts profile paths, CDP URLs or test
 * transports from model/frontend data. Gateway receives only a private lease.
 */
export function createManagedBrowserService({ directory, packageRoot, cacheDirectory, executablePath, getGrant, assertCurrent, authorizeAction,
  protectedRoots = () => [], onEvent = () => {}, createAuthority = createBrowserAuthority, testTransport } = {}) {
  if (!path.isAbsolute(directory || '') || ![getGrant, assertCurrent, authorizeAction, protectedRoots, createAuthority].every(value => typeof value === 'function')) throw denied('Managed browser requires private grant and action authorities.');
  const entries = new Map(), privateEndpoints = new Set(); let closed = false, queue = Promise.resolve();
  const serialize = action => { const result = queue.then(action); queue = result.catch(() => {}); return result; };
  async function read(identity) {
    const stored = await getGrant(identity);
    return { revision: stored?.revision ?? null, grant: structuredClone(stored?.grant || stored || {}) };
  }
  async function closeEntry(key) {
    const entry = entries.get(key); if (!entry) return;
    entries.delete(key); entry.active = null; entry.authority?.pauseNetwork?.(); await entry.authority?.close();
  }
  async function prepareInvocation(context) {
    if (closed) throw denied('The browser service is closed.');
    if (!context || context.purpose !== 'candidate' || !context.nativeIdentity || !context.toolAuthority?.enabled ||
        !context.toolAuthority.tools?.includes('browser')) return null;
    return serialize(async () => {
      const identity = structuredClone(context.nativeIdentity), key = identityKey(identity), selected = await read(identity);
      if (hash(selected.grant) !== hash(context.toolAuthority)) throw denied('Browser permissions changed before invocation setup.');
      await assertCurrent(context);
      const protectedPaths = await protectedRoots();
      const scopeHash = hash({ revision: selected.revision, grant: selected.grant, protectedPaths });
      let entry = entries.get(key);
      if (entry && (entry.scopeHash !== scopeHash || !entry.authority || entry.authority.describe?.().closed)) { await closeEntry(key); entry = null; }
      if (!entry) {
        entry = { scopeHash, identity, selected, active: null, authority: null };
        const heldEntry = entry;
        const check = async () => {
          if (closed || entries.get(key) !== heldEntry || !heldEntry.active || heldEntry.active.context.signal?.aborted) throw denied('No active PoI browser invocation exists.');
          const latest = await read(identity);
          if (hash({ revision: latest.revision, grant: latest.grant, protectedPaths: await protectedRoots() }) !== heldEntry.scopeHash) {
            heldEntry.authority?.pauseNetwork?.(); throw denied('Browser authority was changed or revoked.');
          }
          await assertCurrent(heldEntry.active.context);
        };
        entry.check = check; entries.set(key, entry);
        try { entry.authority = await createAuthority({ directory: path.join(directory, key), ownerId: key, packageRoot, cacheDirectory, executablePath,
          grant: selected.grant,
          protectedRoots: protectedPaths, operatorGrant: selected.grant.browserCapabilities || {}, testTransport,
          assertCurrent: check,
          inspectNativeTarget: async params => { await check();
            if (typeof heldEntry.active.context.inspectNativeTarget !== 'function') throw denied('Native reference perception is unavailable.');
            return heldEntry.active.context.inspectNativeTarget(params); },
          authorizeAction: async (tool, metadata) => {
            await check(); return authorizeAction(heldEntry.active.context, { tool, metadata });
          }, onEvent: event => onEvent(heldEntry.active?.context, event) }); }
        catch (error) { entries.delete(key); throw error; }
      }
      if (entry.active && !entry.active.context.signal?.aborted) throw denied('An owned browser invocation is already active.');
      const leaseId = randomUUID(); entry.active = { leaseId, context };
      let endpoint;
      try { endpoint = await entry.authority.start(); } catch (error) { await closeEntry(key); throw error; }
      privateEndpoints.add(endpoint.cdpUrl);
      const live = async () => { if (entry.active?.leaseId !== leaseId) throw denied('This browser invocation lease expired.'); await entry.check(); };
      const release = async () => {
        if (entry.active?.leaseId === leaseId) { entry.active = null; entry.authority.pauseNetwork?.(); }
      };
      return {
        profile: endpoint.profile,
        config: { browser: { enabled: true, defaultProfile: endpoint.profile, attachOnly: true,
          // Only the private fixed-function inspector may use JavaScript unless
          // the separate human capability explicitly grants model-authored code.
          evaluateEnabled: true,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false, allowedHostnames: [...selected.grant.networkHosts] },
          profiles: { [endpoint.profile]: { cdpUrl: endpoint.cdpUrl, attachOnly: true } } } },
        async inspectAction(params) { await live(); return entry.authority.inspectAction(params); },
        async assertActionUnchanged(params, fingerprint) { await live(); return entry.authority.assertActionUnchanged(params, fingerprint); },
        async execute(params, binding) { await live(); return entry.authority.execute(params, binding); },
        describe: () => entry.authority.describe(), releaseInvocation: release,
      };
    });
  }
  return { prepareInvocation,
    redactionSecrets: () => [...privateEndpoints],
    revoke: identity => serialize(() => closeEntry(identityKey(identity))),
    async close() { closed = true; await serialize(async () => { for (const key of [...entries.keys()]) await closeEntry(key); }); },
  };
}
