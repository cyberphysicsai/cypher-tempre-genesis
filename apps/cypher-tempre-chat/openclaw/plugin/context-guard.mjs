/** Keep a failed mandatory engine selected; never let native error isolation pick a writer. */
import path from 'node:path';

export const ENFORCEMENT_HEALTH_METHOD = 'chainchat.enforcementHealth';
const ID = 'cypher-tempre-poi';
const HELD = 'The mandatory Proof of Interaction context engine is unavailable. Native context work was held.';
const info = {
  id: ID, name: 'Cypher Tempre reviewed native context', version: '1.0.0', ownsCompaction: true,
  acceptedHostParams: ['sessionKey', 'sessionTarget', 'runtimeContext', 'runtimeSettings', 'abortSignal', 'prompt'],
  transcriptSemantics: { currentTurnFence: 'before-current-turn-entry-v1', turnAdvancementIdempotency: 'atomic-idempotent-v1' },
  hostRequirements: { 'agent-run': { requiredCapabilities: ['assemble-before-prompt'] }, 'manual-compact': { requiredCapabilities: ['compact'] } },
};
const failure = () => Object.assign(new Error(HELD), { code: 'OPENCLAW_ENFORCEMENT_UNHEALTHY' });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export function createGuardedContextFactory({ load, context, onCriticalFault } = {}) {
  if (typeof load !== 'function' || typeof onCriticalFault !== 'function') throw new TypeError('A native loader and synchronous owned-process fail-stop are required.');
  const trustedContext = Object.freeze({ workspaceDir: context?.workspaceDir });
  let loading, engine, reasonCode;
  const fault = reason => { reasonCode ??= reason; };
  async function ready() {
    if (reasonCode) return null;
    loading ??= (async () => {
      try {
        if (typeof trustedContext.workspaceDir !== 'string' || !path.isAbsolute(trustedContext.workspaceDir) || trustedContext.workspaceDir.length > 32768)
          throw failure();
        const selected = await load(trustedContext);
        if (!selected || ['bootstrap', 'ingest', 'assemble', 'compact', 'commitTurn'].some(name => typeof selected[name] !== 'function') ||
            selected.info?.id !== ID || selected.info?.ownsCompaction !== true ||
            JSON.stringify(selected.info.transcriptSemantics) !== JSON.stringify(info.transcriptSemantics) ||
            JSON.stringify(selected.info.hostRequirements) !== JSON.stringify(info.hostRequirements)) throw failure();
        engine = selected; return selected;
      } catch { fault('FACTORY_FAILED'); return null; }
    })();
    return loading;
  }
  const heldAssembly = () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: '', promptAuthority: 'assembled' });
  const heldCompact = () => ({ ok: false, compacted: false, reason: HELD });
  async function call(name, params, held, validate) {
    const selected = await ready();
    if (!selected || reasonCode) return held();
    try {
      const result = await selected[name](params);
      if (validate && !validate(result)) throw failure();
      // A concurrent lifecycle failure revokes a pending read/context result.
      // A completed reviewed compaction must still report its actual write.
      if (reasonCode && name !== 'compact') return held();
      return result;
    } catch { fault(name.toUpperCase() + '_FAILED'); return held(); }
  }
  const facade = {
    info: structuredClone(info),
    bootstrap: params => call('bootstrap', params, () => ({ bootstrapped: false, importedMessages: 0, reason: HELD }), result => typeof result?.bootstrapped === 'boolean'),
    ingest: params => call('ingest', params, () => ({ ingested: false }), result => typeof result?.ingested === 'boolean'),
    assemble: params => call('assemble', params, heldAssembly, result => Array.isArray(result?.messages)),
    compact: params => call('compact', params, heldCompact, result => typeof result?.ok === 'boolean' && typeof result?.compacted === 'boolean'),
    async commitTurn(params) {
      const selected = await ready();
      try {
        if (!selected || reasonCode) throw failure();
        const result = await selected.commitTurn(params);
        if (!['committed', 'duplicate'].includes(result?.status)) throw failure();
        return result;
      } catch {
        fault('COMMIT_TURN_FAILED');
        // Native isolation immediately falls back after a rejection, even for
        // commitTurn. Production must exit its exact owned Gateway here before
        // control returns to that SDK catch; tests inject a non-exiting spy.
        onCriticalFault(reasonCode);
        throw failure();
      }
    },
  };
  return {
    async factory() { await ready(); return facade; },
    async probe(params = {}) {
      if (!plain(params) || Object.keys(params).length) throw failure();
      await ready();
      return { version: 1, pluginId: ID, engineId: ID, healthy: !!engine && !reasonCode, ...(reasonCode ? { reasonCode } : {}) };
    },
  };
}
