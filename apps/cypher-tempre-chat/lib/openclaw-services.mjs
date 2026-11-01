/** Private host capabilities. This facade must never become a browser RPC route. */
import { isDeepStrictEqual } from 'node:util';

const fail = () => Object.assign(new Error('This native service operation is not admitted.'), { code: 'OPENCLAW_SERVICE_DENIED', status: 403 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail(); };
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x20\x7f]/.test(value);
const SIGNAL = 'process.stdout.write("NO_REPLY")';
const METHODS = new Set(['cron.add', 'cron.get', 'cron.list', 'cron.update', 'cron.remove', 'cron.runs', 'cron.run', 'cron.status']);

export function validateAutomationRpc(method, params, nodePath) {
  if (!METHODS.has(method)) throw fail();
  params ??= {};
  if (method === 'cron.add') {
    exact(params, ['name', 'declarationKey', 'enabled', 'deleteAfterRun', 'agentId', 'sessionTarget', 'wakeMode', 'schedule', 'payload', 'delivery']);
    const id = /^ChainChat ([a-f0-9-]{36})$/i.exec(params.name || '')?.[1];
    if (!id || params.declarationKey !== `chainchat-managed:${id}` || params.enabled !== false || params.deleteAfterRun !== false ||
        params.agentId !== 'main' || params.sessionTarget !== 'isolated' || params.wakeMode !== 'next-heartbeat' ||
        !isDeepStrictEqual(params.payload, { kind: 'command', argv: [nodePath, '--input-type=module', '-e', SIGNAL],
          timeoutSeconds: 15, noOutputTimeoutSeconds: 10, outputMaxBytes: 64, toolsAllow: [] }) ||
        !isDeepStrictEqual(params.delivery, { mode: 'none' })) throw fail();
    const schedule = params.schedule;
    if (schedule?.kind === 'every') {
      exact(schedule, ['kind', 'everyMs', 'anchorMs']);
      if (!Number.isSafeInteger(schedule.everyMs) || schedule.everyMs < 60000 || schedule.everyMs > 365 * 86400000 ||
          !Number.isSafeInteger(schedule.anchorMs) || schedule.anchorMs < 1) throw fail();
    } else if (schedule?.kind === 'at') {
      exact(schedule, ['kind', 'at']);
      if (typeof schedule.at !== 'string' || !Number.isFinite(Date.parse(schedule.at)) || schedule.at.length > 100) throw fail();
    } else if (schedule?.kind === 'cron') {
      exact(schedule, ['kind', 'expr', 'tz', 'staggerMs']);
      if (typeof schedule.expr !== 'string' || schedule.expr.length > 256 || schedule.expr.trim().split(/\s+/).length !== 5 ||
          !/^[\d\s*/,+?\-LW#A-Za-z]+$/.test(schedule.expr) || typeof schedule.tz !== 'string' || schedule.tz.length > 128 || schedule.staggerMs !== 0) throw fail();
      try { new Intl.DateTimeFormat('en', { timeZone: schedule.tz }); } catch { throw fail(); }
    } else throw fail();
  } else if (method === 'cron.update') {
    exact(params, ['id', 'patch']); exact(params.patch, ['enabled']);
    if (!identifier(params.id) || typeof params.patch.enabled !== 'boolean') throw fail();
  } else if (method === 'cron.runs') {
    exact(params, ['id', 'limit', 'offset']);
    if (!identifier(params.id) || params.limit != null && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200) ||
        params.offset != null && (!Number.isSafeInteger(params.offset) || params.offset < 0)) throw fail();
  } else if (method === 'cron.run') {
    exact(params, ['id', 'mode']); if (!identifier(params.id) || params.mode !== 'force') throw fail();
  } else if (method === 'cron.get' || method === 'cron.remove') {
    exact(params, ['id']); if (!identifier(params.id)) throw fail();
  } else if (method === 'cron.list') {
    exact(params, ['includeDisabled', 'limit', 'offset']);
    if (params.includeDisabled != null && typeof params.includeDisabled !== 'boolean' ||
        params.limit != null && (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 200) ||
        params.offset != null && (!Number.isSafeInteger(params.offset) || params.offset < 0)) throw fail();
  } else exact(params, []);
  return structuredClone(params);
}

export function createPrivateNativeServices({ rpc, subscribe, nodePath } = {}) {
  if (typeof rpc !== 'function' || typeof subscribe !== 'function' || typeof nodePath !== 'string') throw new TypeError('Private native service capabilities are required.');
  const services = new Map();
  function registerNativeService({ id, methods, events = [], requestTimeoutMs } = {}) {
    if (!identifier(id) || services.has(id) || !plain(methods) || !Object.keys(methods).length ||
        Object.entries(methods).some(([name, validate]) => !/^[a-z][A-Za-z0-9.]{1,100}$/.test(name) || typeof validate !== 'function') ||
        !Array.isArray(events) || events.some(name => !identifier(name)) ||
        requestTimeoutMs !== undefined && (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 600000)) throw fail();
    let closed = false; const subscriptions = new Set();
    const service = {
      async request(method, params) {
        if (closed || !Object.hasOwn(methods, method)) throw fail();
        const checked = await methods[method](structuredClone(params ?? {}));
        if (!plain(checked) || Buffer.byteLength(JSON.stringify(checked)) > 2 * 1024 * 1024 || closed) throw fail();
        return requestTimeoutMs === undefined ? rpc(method, checked) : rpc(method, checked, { timeoutMs: requestTimeoutMs });
      },
      subscribe(listener) {
        if (closed || typeof listener !== 'function') throw fail();
        const remove = subscribe(event => { if (!closed && events.includes(event?.event)) listener(event); });
        subscriptions.add(remove); return () => { subscriptions.delete(remove); remove(); };
      },
      close() { closed = true; for (const remove of subscriptions) remove(); subscriptions.clear(); services.delete(id); },
    };
    services.set(id, service); return service;
  }
  return { registerNativeService,
    automationRpc: (method, params) => rpc(method, validateAutomationRpc(method, params, nodePath)),
    subscribeAutomation: listener => subscribe(event => { if (event?.event === 'cron') listener(event); }),
    close() { for (const service of services.values()) service.close(); },
  };
}
