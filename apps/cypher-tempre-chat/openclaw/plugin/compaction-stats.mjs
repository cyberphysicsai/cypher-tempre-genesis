/** Private host budget metadata; target paths can only come from native lifecycle callbacks. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectNativeCompaction } from './compaction.mjs';

export const COMPACTION_STATS_METHOD = 'chainchat.compactionStats';
const failure = () => Object.assign(new Error('Native compaction metadata is unavailable for this exact session.'), { code: 'OPENCLAW_COMPACTION_SCOPE' });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const scopedKey = value => typeof value === 'string' && /^agent:main:chainchat-control:[a-f0-9]{64}$/.test(value);
export function validateCompactionStatsRequest(value) {
  if (!plain(value) || Object.keys(value).length !== 2 || Object.keys(value).some(key => !['sessionKey', 'sessionId'].includes(key)) ||
      !scopedKey(value.sessionKey) || !bounded(value.sessionId, 512)) throw failure();
  return { sessionKey: value.sessionKey, sessionId: value.sessionId };
}
const storageKey = ({ sessionKey, sessionId }) => createHash('sha256').update(sessionKey + '\0' + sessionId).digest('hex');
function savedTarget(value) {
  if (!plain(value) || value.agentId !== 'main' || !scopedKey(value.sessionKey) || !bounded(value.sessionId, 512) ||
      !bounded(value.storePath, 32768) || !path.isAbsolute(value.storePath)) throw failure();
  return { agentId: 'main', sessionKey: value.sessionKey, sessionId: value.sessionId, storePath: value.storePath,
    ...(bounded(value.threadId, 512) || Number.isSafeInteger(value.threadId) ? { threadId: value.threadId } : {}) };
}
export function createNativeCompactionStats({ store, loadSdk } = {}) {
  if (typeof store?.lookup !== 'function' || typeof store?.register !== 'function' || typeof loadSdk !== 'function') throw failure();
  return {
    async remember(target) {
      // Scratch, utility and external native sessions do not become selectable
      // ChainChat targets merely by invoking this lifecycle hook.
      if (!scopedKey(target?.sessionKey)) return false;
      const value = savedTarget(target), key = storageKey(value), current = await store.lookup(key);
      if (JSON.stringify(current) !== JSON.stringify(value)) await store.register(key, value);
      return true;
    },
    async probe(input, signal) {
      const request = validateCompactionStatsRequest(input); signal?.throwIfAborted();
      const raw = await store.lookup(storageKey(request)); signal?.throwIfAborted();
      if (!raw) return { version: 1, known: false, ...request };
      const target = savedTarget(raw);
      if (target.sessionKey !== request.sessionKey || target.sessionId !== request.sessionId) throw failure();
      const result = await inspectNativeCompaction({ sdk: await loadSdk(), sessionTarget: target, signal });
      signal?.throwIfAborted();
      return { version: 1, known: true, ...result };
    },
  };
}
