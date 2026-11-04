// Local browser ownership authorizes access. Model actions still pass PoI.
const fail = (message, code, status) => Object.assign(new Error(message), { code, status });

export function createSessionAuthority({ resolveToken, now = Date.now } = {}) {
  if (typeof resolveToken !== 'function' || typeof now !== 'function')
    throw new TypeError('A local session resolver and clock are required.');
  const records = new WeakMap();
  function record(session) {
    const value = session && records.get(session);
    if (!value) throw fail('Open ChainChat from its application launcher.', 'PAIR_REQUIRED', 401);
    return value;
  }
  return Object.freeze({
    attach(session) {
      if (!session || typeof session !== 'object' || records.has(session))
        throw new TypeError('Attach each local session exactly once.');
      records.set(session, { epoch: 0 });
    },
    epoch(session) { return record(session).epoch; },
    revoke(session) { record(session).epoch++; },
    assertCurrent(scope) {
      const session = scope?.session, current = record(session);
      if (typeof scope.token !== 'string' || !scope.token || resolveToken(scope.token) !== session ||
          !Number.isFinite(session.expires) || session.expires <= now())
        throw fail('This local session expired. Open ChainChat again.', 'PAIR_REQUIRED', 401);
      if (scope.epoch !== current.epoch)
        throw fail('The model or local session changed. Retry from the current app session.', 'SESSION_CHANGED', 409);
      if (scope.signal?.aborted)
        throw fail('This request was cancelled before it could continue.', 'CANCELLED', 499);
    },
  });
}
