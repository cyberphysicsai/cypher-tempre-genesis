import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditParent } from '../public/audit-parent.js';

function fixture(read = async request => ({ op: request.op, rings: 2 })) {
  const source = {}, other = {}, replies = [], calls = [];
  let session = 'private-memory-token', agent = 'agent-1';
  const origin = 'http://127.0.0.1:8790';
  const handle = createAuditParent({ origin, source: () => source,
    context: () => ({ session, agent }), read: async request => { calls.push(request); return read(request); },
    respond: (target, data, targetOrigin) => replies.push({ target, data, targetOrigin }) });
  const event = (request = { op: 'summary' }) => ({ origin, source, data: { type: 'chainchat-audit:request', id: 'audit_1', request } });
  return { handle, event, source, other, replies, calls, switchAgent() { agent = 'agent-2'; }, logout() { session = null; } };
}
test('embedded auditor accepts only its exact frame and origin, never passes authentication', async () => {
  const f = fixture();
  await f.handle({ ...f.event(), source: f.other });
  await f.handle({ ...f.event(), origin: 'https://attacker.example' });
  assert.equal(f.calls.length, 0);
  await f.handle(f.event());
  assert.deepEqual(f.calls, [{ op: 'summary' }]);
  assert.equal(f.replies[0].target, f.source);
  assert.equal(f.replies[0].targetOrigin, 'http://127.0.0.1:8790');
  assert.equal(JSON.stringify(f.replies).includes('private-memory-token'), false);
  assert.deepEqual(f.replies[0].data.result, { op: 'summary', rings: 2 });
});
test('embedded auditor cannot turn into a generic API proxy or select another root', async () => {
  const f = fixture();
  for (const request of [{ op: 'seal' }, { op: 'summary', root: 'C:/private' }, { op: 'summary', path: '/api/provider' }, { op: 'summary', token: 'x' }, []])
    await f.handle(f.event(request));
  assert.equal(f.calls.length, 0);
  assert.equal(f.replies.length, 5);
  assert.ok(f.replies.every(item => item.data.error && !item.data.result));
});
test('logout or selected-agent changes withhold stale in-flight audit responses', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(async () => { await pending; return { privateChain: 'old-agent' }; });
  const work = f.handle(f.event());
  f.switchAgent(); release(); await work;
  assert.equal(f.replies[0].data.result, undefined);
  assert.match(f.replies[0].data.error, /changed/);
  f.logout(); await f.handle(f.event());
  assert.equal(f.calls.length, 1);
});
test('auditor errors expose a fixed message and bound concurrent work', async () => {
  const f = fixture(async () => { throw new Error('provider-key-private'); });
  await f.handle(f.event());
  assert.equal(JSON.stringify(f.replies).includes('provider-key-private'), false);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const busy = fixture(async () => { await pending; return {}; });
  const work = Array.from({ length: 4 }, () => busy.handle(busy.event()));
  await busy.handle(busy.event());
  assert.equal(busy.calls.length, 4);
  assert.match(busy.replies[0].data.error, /busy/);
  release(); await Promise.all(work);
});
