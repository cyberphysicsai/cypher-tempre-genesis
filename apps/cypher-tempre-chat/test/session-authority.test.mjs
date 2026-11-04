import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSessionAuthority } from '../lib/session-authority.mjs';
import { createApp } from '../server.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

const hash = index => index.toString(16).padStart(64, '0');
const judgment = () => ({ approved: true, decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: 'Supported and compatible with the covenant.' });
function latch() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('local authority requires the exact registered live session and a fresh server-owned epoch', () => {
  let now = 1000;
  const sessions = new Map(), authority = createSessionAuthority({ resolveToken: token => sessions.get(token), now: () => now });
  const session = { origin: 'http://127.0.0.1:1234', expires: 2000 };
  authority.attach(session); sessions.set('opaque-token', session);
  const scope = { session, token: 'opaque-token', epoch: authority.epoch(session) };
  assert.doesNotThrow(() => authority.assertCurrent(scope));
  assert.throws(() => authority.assertCurrent(undefined), error => error.code === 'PAIR_REQUIRED' && error.status === 401);
  assert.throws(() => authority.assertCurrent({ ...scope, token: 'other' }), { code: 'PAIR_REQUIRED' });
  assert.throws(() => authority.assertCurrent({ ...scope, session: { ...session } }), { code: 'PAIR_REQUIRED' });
  const old = authority.epoch(session);
  authority.revoke(session);
  assert.notEqual(authority.epoch(session), old);
  session.epoch = old;
  assert.throws(() => authority.assertCurrent(scope), error => error.code === 'SESSION_CHANGED' && error.status === 409);
  const fresh = { ...scope, epoch: authority.epoch(session) };
  assert.doesNotThrow(() => authority.assertCurrent(fresh));
  const controller = new AbortController(); controller.abort();
  assert.throws(() => authority.assertCurrent({ ...fresh, signal: controller.signal }), error => error.code === 'CANCELLED' && error.status === 499);
  now = session.expires;
  assert.throws(() => authority.assertCurrent(fresh), { code: 'PAIR_REQUIRED' });
  now = 1000; sessions.delete('opaque-token');
  assert.throws(() => authority.assertCurrent(fresh), { code: 'PAIR_REQUIRED' });
});

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-local-authority-'));
  const chains = new Map(), engineCalls = [], modelCalls = [], reviewCalls = [];
  let rpcCalls = 0, token = null;
  const inspect = chain => ({ verified: true, genesis: { name: chain.name, hash: hash(0), covenant: [...FRUITS] },
    head: { index: chain.index, hash: hash(chain.index) }, faculties: [], history: [], runtime: { supported: false, mode: 'active' } });
  const app = await createApp({ dataDir: directory, pairingCode: 'LOCAL-ONLY-TEST',
    // A stale pre-upgrade option cannot bring back a wallet requirement.
    licenseConfig: { mode: 'holdings', required: true },
    licenseFetch: async () => { rpcCalls++; throw new Error('Wallet RPC must never be called.'); },
    engine: async request => {
      engineCalls.push(structuredClone(request));
      if (request.op === 'init') { const chain = { name: request.name, index: 0 }; chains.set(request.root, chain); return inspect(chain); }
      const chain = chains.get(request.root); assert.ok(chain, 'Fixture chain exists.');
      if (['inspect', 'verify'].includes(request.op)) return inspect(chain);
      if (request.op === 'prepare') return { ...inspect(chain), memories: [], context: 'Verified fixture context.', loadout: [], frames: [], computed: {}, availableEvidence: [] };
      if (request.op === 'evaluate') return { accepted: true, verdict: { decision: 'SEAL' } };
      if (request.op === 'commit') { assert.equal(request.expectedHead, hash(chain.index)); chain.index++; return { accepted: true, ring: { index: chain.index, hash: hash(chain.index) } }; }
      throw new Error('Unexpected fixture operation: ' + request.op);
    },
    generate: async (config, args) => { modelCalls.push({ config, args }); return overrides.generate ? overrides.generate(config, args) : { text: 'A useful supported answer.' }; },
    review: async (config, args) => { reviewCalls.push({ config, args }); return overrides.review ? overrides.review(config, args) : judgment(); },
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    await app.closeRuntime();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('ct-local-authority-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const request = async (endpoint, payload, headers = {}) => {
    const response = await fetch(base + endpoint, { method: payload === undefined ? 'GET' : 'POST',
      headers: { origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    return { status: response.status, body: await response.json() };
  };
  const pair = async () => { const result = await request('/api/pair', { code: 'LOCAL-ONLY-TEST' }); assert.equal(result.status, 200); token = result.body.token; return token; };
  const configure = (model = 'fixture-a') => request('/api/provider', { provider: 'compatible', model, baseUrl: 'http://127.0.0.1:9999/v1', apiKey: 'synthetic-private-key' });
  const ready = async () => { await pair(); assert.equal((await request('/api/agents', { name: 'Local Cypher Tempre' })).status, 201); assert.equal((await configure()).status, 200); };
  return { ...app, base, request, pair, configure, ready, engineCalls, modelCalls, reviewCalls, get token() { return token; }, get rpcCalls() { return rpcCalls; } };
}

test('paired users can create, connect and chat without a wallet or Base RPC while PoI still rejects low scores', async t => {
  let reject = false;
  const f = await fixture(t, { review: async () => { const value = judgment(); if (reject) value.fruits.kindness = 179; return value; } });
  await f.ready();
  const first = await f.request('/api/chat', { message: 'Please introduce yourself.' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.message.gate.approved, true);
  assert.equal(f.engineCalls.filter(call => call.op === 'commit').length, 1);
  reject = true;
  const held = await f.request('/api/chat', { message: 'Keep the PoI gate active.' });
  assert.equal(held.status, 422); assert.equal(held.body.code, 'COVENANT_REJECTED');
  assert.equal(held.body.message, undefined);
  assert.equal(f.engineCalls.filter(call => call.op === 'commit').length, 1);
  assert.equal(f.rpcCalls, 0);
  assert.equal(JSON.stringify((await f.request('/api/state')).body).includes('synthetic-private-key'), false);
  for (const endpoint of ['/api/license/challenge', '/api/license/verify', '/api/license/check', '/api/license/logout'])
    assert.equal((await f.request(endpoint, {})).status, 404, 'The obsolete wallet route is removed: ' + endpoint);
  assert.notEqual((await f.request('/api/license')).status, 200);
  assert.equal(f.rpcCalls, 0);
});

test('wallet-free access still requires a bearer session, exact browser origin and fresh local resume ticket', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/state')).status, 401);
  const launch = await f.request('/api/launch', { nonce: f.issueLaunchNonce() });
  assert.equal(launch.status, 200); assert.match(launch.body.resumeTicket, /^[a-f0-9]{64}$/);
  const authorization = `Bearer ${launch.body.token}`;
  assert.equal((await f.request('/api/state', undefined, { authorization })).status, 200);
  assert.equal((await f.request('/api/state', undefined, { authorization, origin: 'https://foreign.example' })).status, 403);
  const resumed = await f.request('/api/local-resume', { resumeTicket: launch.body.resumeTicket });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.token, launch.body.token);
  assert.notEqual(resumed.body.resumeTicket, launch.body.resumeTicket);
  assert.equal((await f.request('/api/local-resume', { resumeTicket: launch.body.resumeTicket })).status, 403);
  assert.equal(f.rpcCalls, 0);
});

test('provider replacement or disconnect invalidates old responses even when model or reviewer ignores abort', async t => {
  for (const phase of ['model', 'review']) for (const disconnect of [false, true]) await t.test(phase + (disconnect ? '-disconnect' : '-replace'), async t => {
    const started = latch(), release = latch();
    let delayed = true;
    const f = await fixture(t, {
      generate: async () => { if (phase === 'model' && delayed) { started.resolve(); await release.promise; } return { text: 'Old response must not escape.' }; },
      review: async () => { if (phase === 'review' && delayed) { started.resolve(); await release.promise; } return judgment(); },
    });
    await f.ready();
    const pending = f.request('/api/chat', { message: 'Invalidate this old request.' });
    try {
      await started.promise;
      const changed = disconnect ? await f.request('/api/provider', { disconnect: true }) : await f.configure('fixture-b');
      assert.equal(changed.status, 200);
    } finally { delayed = false; release.resolve(); }
    const held = await pending;
    assert.ok(['CANCELLED', 'SESSION_CHANGED'].includes(held.body.code), JSON.stringify(held));
    assert.equal(held.body.message, undefined);
    assert.equal(f.engineCalls.filter(call => call.op === 'commit').length, 0);
    const state = await f.request('/api/state');
    assert.equal(state.body.provider.configured, !disconnect);
    if (!disconnect) {
      assert.equal(state.body.provider.model, 'fixture-b');
      assert.equal((await f.request('/api/chat', { message: 'A fresh request can proceed.' })).status, 200);
    }
    assert.equal(f.rpcCalls, 0);
  });
});

test('expiry and unpair prevent commitment and release from an ignored-abort model response', async t => {
  for (const ending of ['expiry', 'unpair']) await t.test(ending, async t => {
    const started = latch(), release = latch();
    const f = await fixture(t, { generate: async () => { started.resolve(); await release.promise; return { text: 'Expired response must not escape.' }; } });
    await f.ready();
    const pending = f.request('/api/chat', { message: 'End this session before release.' });
    try {
      await started.promise;
      if (ending === 'expiry') f.sessions.get(f.token).expires = Date.now() - 1;
      else assert.equal((await f.request('/api/unpair', {})).status, 200);
    } finally { release.resolve(); }
    const held = await pending;
    assert.ok(['PAIR_REQUIRED', 'SESSION_CHANGED', 'CANCELLED'].includes(held.body.code), JSON.stringify(held));
    assert.equal(held.body.message, undefined);
    assert.equal(f.engineCalls.filter(call => call.op === 'commit').length, 0);
    assert.equal((await f.request('/api/state')).status, 401);
  });
});
