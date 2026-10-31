/** Read-only RPC to the authenticated parent. No runtime credentials enter this frame. */
const OPERATIONS = new Set(['summary', 'rings', 'ring', 'blockspace', 'blob']);
const ID = /^[a-zA-Z0-9_-]{1,80}$/;

export function validateAuditRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !OPERATIONS.has(request.op) ||
      Object.keys(request).some(key => !['op', 'index', 'offset', 'limit', 'hash'].includes(key))) throw new Error('Unsupported read-only audit request.');
  for (const key of ['index', 'offset', 'limit']) if (request[key] !== undefined &&
      (!Number.isSafeInteger(request[key]) || request[key] < 0)) throw new Error('Invalid audit page or ring index.');
  if (request.limit !== undefined && (request.limit < 1 || request.limit > 100)) throw new Error('Audit pages are limited to 100 entries.');
  if (request.offset !== undefined && request.offset > 10000) throw new Error('The bounded audit window has ended.');
  if (request.op === 'ring' ? request.index === undefined : request.index !== undefined) throw new Error('Unexpected audit ring index.');
  if (request.op === 'blob' ? typeof request.hash !== 'string' || !/^[a-f0-9]{64}$/.test(request.hash) : request.hash !== undefined)
    throw new Error('Unexpected audit blob hash.');
  if (!['rings', 'blockspace'].includes(request.op) && (request.offset !== undefined || request.limit !== undefined)) throw new Error('Unexpected audit page bounds.');
  return { ...request };
}

export function createAuditConnection({ window: view = globalThis.window, timeoutMs = 30000 } = {}) {
  if (!view || view.parent === view || !/^https?:\/\//.test(view.location.origin)) throw new Error('An authenticated ChainChat parent is required.');
  const parent = view.parent, origin = view.location.origin, pending = new Map(); let closed = false;
  function receive(event) {
    if (event.source !== parent || event.origin !== origin || event.data?.type !== 'chainchat-audit:response' || !ID.test(event.data.id || '')) return;
    const waiting = pending.get(event.data.id); if (!waiting) return;
    const data = event.data;
    if ((Object.hasOwn(data, 'result') ? 1 : 0) + (Object.hasOwn(data, 'error') ? 1 : 0) !== 1 ||
        Object.keys(data).some(key => !['type', 'id', 'result', 'error'].includes(key))) return;
    pending.delete(data.id); clearTimeout(waiting.timer);
    if (Object.hasOwn(data, 'error')) waiting.reject(new Error(typeof data.error === 'string' ? data.error.slice(0, 512) : 'The audit read did not complete.'));
    else waiting.resolve(data.result);
  }
  view.addEventListener('message', receive);
  function read(request) {
    if (closed) return Promise.reject(new Error('The audit connection is closed.'));
    let clean; try { clean = validateAuditRequest(request); } catch (error) { return Promise.reject(error); }
    if (pending.size >= 12) return Promise.reject(new Error('Too many pending audit reads.'));
    const id = view.crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Open your paired ChainChat agent and refresh the auditor.')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { parent.postMessage({ type: 'chainchat-audit:request', id, request: clean }, origin); }
      catch { clearTimeout(timer); pending.delete(id); reject(new Error('The parent audit connection is unavailable.')); }
    });
  }
  function close() {
    if (closed) return; closed = true; view.removeEventListener('message', receive);
    for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('The audit connection closed.')); }
    pending.clear();
  }
  return { read, close };
}
