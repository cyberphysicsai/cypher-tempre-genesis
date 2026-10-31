import test from 'node:test';
import assert from 'node:assert/strict';
import { connectLocalSession, clearLocalResume } from '../public/local-session.js';

const origin = 'http://127.0.0.1:8790';
const nonce = '1'.repeat(64), token = '2'.repeat(64), ticket = '3'.repeat(64), next = '4'.repeat(64);
function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key), setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('installed launch then same-tab reload rotates only the local resume credential', async () => {
  const tab = storage(), calls = [];
  const request = async (path, body) => {
    calls.push({ path, body });
    return { token, resumeTicket: calls.length === 1 ? ticket : next, apiKey: 'never-store-this' };
  };
  assert.deepEqual(await connectLocalSession({ origin, nonce, storage: tab, request }), { token, resumable: true });
  assert.deepEqual([...tab.values.values()], [ticket]);
  assert.deepEqual(await connectLocalSession({ origin, storage: tab, request }), { token, resumable: true });
  assert.deepEqual(calls, [{ path: '/api/launch', body: { nonce } }, { path: '/api/local-resume', body: { resumeTicket: ticket } }]);
  assert.deepEqual([...tab.values.values()], [next]);
  assert.equal(JSON.stringify([...tab.values]).includes(token), false);
  assert.equal(JSON.stringify([...tab.values]).includes('never-store-this'), false);
  clearLocalResume(tab);
  await assert.rejects(connectLocalSession({ origin, storage: tab, request }), { code: 'LOCAL_LAUNCH_REQUIRED' });
  assert.equal(calls.length, 2);
});
test('a hosted page, unknown local tab or malformed nonce cannot bootstrap without owner proof', async () => {
  let requests = 0;
  const tab = storage();
  const request = () => { requests++; throw new Error('unexpected'); };
  for (const args of [{ origin: 'https://cyphertempre.ai', nonce }, { origin }, { origin, nonce: 'invalid' }])
    await assert.rejects(connectLocalSession({ ...args, storage: tab, request }), { code: 'LOCAL_LAUNCH_REQUIRED' });
  assert.equal(requests, 0);
});
test('replayed/expired resume fails closed and clears the stale credential', async () => {
  const tab = storage();
  await connectLocalSession({ origin, nonce, storage: tab, request: async () => ({ token, resumeTicket: ticket }) });
  await assert.rejects(connectLocalSession({ origin, storage: tab, request: async () => { throw new Error('expired'); } }), /expired/);
  assert.equal(tab.values.size, 0);
  await assert.rejects(connectLocalSession({ origin, nonce, storage: tab, request: async () => ({ token }) }), { code: 'LOCAL_LAUNCH_REQUIRED' });
});
test('storage denial permits an owner-authorized launch without saving credentials', async () => {
  const tab = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const result = await connectLocalSession({ origin, nonce, storage: tab, request: async () => ({ token, resumeTicket: ticket }) });
  assert.deepEqual(result, { token, resumable: false });
  await assert.rejects(connectLocalSession({ origin, storage: tab, request: async () => { throw new Error('unexpected'); } }), { code: 'LOCAL_LAUNCH_REQUIRED' });
});
