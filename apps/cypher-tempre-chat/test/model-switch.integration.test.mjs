import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';
import { FREE_MODEL_BASE_URL, FREE_MODEL_ENDPOINT, FREE_MODEL_MARKER } from '../lib/model-catalogue.mjs';

const privateKey = 'synthetic-private-byo-model-switch-key';
const answer = 'We can examine the question carefully, honestly and patiently.';
const assessment = () => ({ usedRings: [], approved: true, decision: 'approve',
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: 'A careful, honest and helpful answer.' });

async function fixture(t, { native = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-model-switch-'));
  const generated = [], reviewed = [], nativeContexts = [], catalogueRequests = [];
  const behavior = { freeAvailable: true, failFree: false, hold: false, held: null };
  const generate = async (config, args, context) => {
    generated.push(structuredClone(config)); if (context) nativeContexts.push(context.modelCapabilities);
    if (behavior.hold) {
      behavior.held?.(args.signal);
      await new Promise((resolve, reject) => {
        const abort = () => reject(Object.assign(new Error('Synthetic cancelled turn.'), { code: 'CANCELLED', status: 499 }));
        if (args.signal.aborted) abort(); else args.signal.addEventListener('abort', abort, { once: true });
      });
    }
    if (behavior.failFree && config.tier === 'free') throw Object.assign(new Error('The free fixture is unavailable. ' + privateKey), { code: 'MODEL_UNAVAILABLE', status: 503 });
    return { text: answer, usage: {} };
  };
  const app = await createApp({ dataDir: directory, pairingCode: 'MODEL-SWITCH-FIXTURE', generate,
    review: async config => { reviewed.push(structuredClone(config)); return assessment(); },
    catalogueFetch: async (url, options) => {
      catalogueRequests.push({ url, headers: options.headers });
      assert.equal(options.redirect, 'error');
      if (url === FREE_MODEL_ENDPOINT) return new Response(JSON.stringify({ freeOnly: true, available: behavior.freeAvailable,
        notice: behavior.freeAvailable ? 'Free fixture online.' : 'Free fixture offline.', models: [
          { id: 'free-fixture', name: 'Free fixture', free: true, available: true, pricing: { input: 0, output: 0 },
            contextWindow: 65536, maxOutputTokens: 4096, reasoningCapable: false, privacyNotice: 'Fixture relay forwards relevant context.' },
          { id: 'paid-fixture', name: 'Paid fixture', free: false, available: true, pricing: { input: 1, output: 1 } },
        ] }), { status: 200 });
      assert.equal(url, 'https://provider.example/v1/models');
      assert.equal(options.headers.authorization, 'Bearer ' + privateKey);
      return new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b', contextWindow: 65536,
        maxOutputTokens: 8192, reasoningCapable: true }] }), { status: 200 });
    },
    ...(native ? { openclaw: {}, openclawFactory: () => ({ start: async () => {}, close: async () => {},
      status: () => ({ backend: 'openclaw', running: true }), generate }) } : {}),
  });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(async () => {
    await app.closeRuntime(); app.server.closeAllConnections();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    const absolute = path.resolve(directory);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('ct-model-switch-'));
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  const base = `http://127.0.0.1:${app.server.address().port}`; let token;
  const call = async (endpoint, input, authenticated = true) => {
    const response = await fetch(base + endpoint, { method: input === undefined ? 'GET' : 'POST', headers: {
      ...(input === undefined ? {} : { 'content-type': 'application/json' }), ...(authenticated && token ? { authorization: 'Bearer ' + token } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('/api/models', undefined, false)).status, 401);
  const pair = await call('/api/pair', { code: 'MODEL-SWITCH-FIXTURE' }); assert.equal(pair.status, 200); token = pair.body.token;
  assert.equal((await call('/api/agents', { name: 'ModelSwitchFixture' })).status, 201);
  assert.equal((await call('/api/cognition', { learning: false, autoRoute: false, autoSprout: false, semanticRecall: false,
    revisionLimit: 0, searchDepth: 1 })).status, 200);
  assert.equal((await call('/api/settings', { recall: false })).status, 200);
  const configure = async () => {
    const response = await call('/api/provider', { provider: 'compatible', model: 'model-a', baseUrl: 'https://provider.example/v1', apiKey: privateKey });
    assert.equal(response.status, 200); assert.equal(response.body.provider.tier, 'byok'); return response;
  };
  return { ...app, call, configure, behavior, generated, reviewed, nativeContexts, catalogueRequests, directory,
    session: () => app.sessions.get(token) };
}

test('authenticated tier catalogue and real model selection control generation/review while restoring private BYOK', async t => {
  const f = await fixture(t); await f.configure();
  const catalogue = await f.call('/api/models'); assert.equal(catalogue.status, 200);
  assert.deepEqual(catalogue.body.active, { tier: 'byok', provider: 'compatible', model: 'model-a' });
  assert.ok(catalogue.body.tiers.find(tier => tier.id === 'byok').models.some(model => model.id === 'model-b'));
  assert.equal(catalogue.body.tiers.find(tier => tier.id === 'free').available, true);
  assert.equal(JSON.stringify(catalogue.body).includes(privateKey), false);
  assert.equal(catalogue.body.tiers.find(tier => tier.id === 'free').models.some(model => model.id === 'paid-fixture'), false);
  let selected = await f.call('/api/model', { tier: 'byok', model: 'model-b' }); assert.equal(selected.status, 200);
  assert.equal(selected.body.provider.reasoningCapable, true);
  const firstChat = await f.call('/api/chat', { message: 'Please offer a careful response.' });
  assert.equal(firstChat.status, 200, JSON.stringify(firstChat.body));
  for (const config of [f.generated.at(-1), f.reviewed.at(-1)]) {
    assert.equal(config.model, 'model-b'); assert.equal(config.apiKey, privateKey); assert.equal(config.maxOutputTokens, 8192);
  }
  selected = await f.call('/api/model', { tier: 'free', model: 'free-fixture' }); assert.equal(selected.status, 200);
  assert.equal(selected.body.provider.tier, 'free'); assert.equal(JSON.stringify(selected.body).includes(privateKey), false);
  assert.equal(f.session().byokProvider.model, 'model-b');
  assert.equal((await f.call('/api/chat', { message: 'Please offer another careful response.' })).status, 200);
  for (const config of [f.generated.at(-1), f.reviewed.at(-1)]) {
    assert.equal(config.model, 'free-fixture'); assert.equal(config.apiKey, FREE_MODEL_MARKER); assert.equal(config.baseUrl, FREE_MODEL_BASE_URL);
  }
  selected = await f.call('/api/model', { tier: 'byok', model: 'model-b' }); assert.equal(selected.status, 200);
  assert.equal((await f.call('/api/chat', { message: 'Please respond using the restored model.' })).status, 200);
  for (const config of [f.generated.at(-1), f.reviewed.at(-1)]) assert.equal(config.apiKey, privateKey);
  const custom = await f.call('/api/model', { tier: 'byok', model: 'private-custom-id' }); assert.equal(custom.status, 200);
  assert.equal(custom.body.provider.model, 'private-custom-id'); assert.equal(custom.body.provider.reasoningCapable, true);
  const walk = async root => { for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name); if (item.isDirectory()) await walk(file);
    else assert.equal((await fs.readFile(file)).includes(Buffer.from(privateKey)), false, 'Provider keys must not enter local persistent files.');
  } }; await walk(f.directory);
});

test('free selection rejects paid IDs and untrusted endpoints; unavailable inference never falls back to BYOK', async t => {
  const f = await fixture(t); await f.configure();
  assert.equal((await f.call('/api/model', { tier: 'free', model: 'paid-fixture' })).status, 409);
  assert.equal((await f.call('/api/model', { tier: 'free', model: 'free-fixture', baseUrl: 'https://attacker.example/v1' })).status, 400);
  assert.equal((await f.call('/api/models/refresh', { url: 'https://attacker.example/' })).status, 400);
  assert.equal((await f.call('/api/model', { tier: 'free', model: 'free-fixture' })).status, 200);
  f.behavior.failFree = true;
  const prior = f.generated.length, failed = await f.call('/api/chat', { message: 'Please respond from the selected free model.' });
  assert.equal(failed.status, 503); assert.equal(f.generated.length, prior + 1);
  assert.equal(JSON.stringify(failed.body).includes(privateKey), false, 'An inactive private BYOK slot is still redacted from errors.');
  assert.equal(f.generated.at(-1).model, 'free-fixture'); assert.equal(f.generated.at(-1).apiKey, FREE_MODEL_MARKER);
  assert.equal(f.session().provider.tier, 'free'); assert.equal(f.session().byokProvider.apiKey, privateKey);
  f.behavior.freeAvailable = false;
  const refreshed = await f.call('/api/models/refresh', {}); assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.tiers.find(tier => tier.id === 'free').available, false);
  assert.equal((await f.call('/api/model', { tier: 'free', model: 'free-fixture' })).status, 409);
  const disconnected = await f.call('/api/provider', { disconnect: true });
  assert.deepEqual(disconnected.body.provider, { configured: false, tier: 'byok' });
  assert.equal(f.session().byokProvider, null);
  assert.equal((await f.call('/api/model', { tier: 'byok', model: 'model-a' })).status, 409);
});

test('an actual model switch aborts the old turn and prevents its response from committing', async t => {
  const f = await fixture(t); await f.configure();
  const before = (await f.call('/api/state')).body.agent.head;
  let admitted;
  const started = new Promise(resolve => { admitted = resolve; }); f.behavior.hold = true; f.behavior.held = admitted;
  const pending = f.call('/api/chat', { message: 'Please hold this isolated fixture response.' });
  const signal = await started; assert.equal(signal.aborted, false);
  assert.equal((await f.call('/api/model', { tier: 'byok', model: 'model-a' })).status, 200);
  assert.equal(signal.aborted, false, 'Selecting the identical configuration must not revoke an active turn.');
  const switched = await f.call('/api/model', { tier: 'free', model: 'free-fixture' }); assert.equal(switched.status, 200);
  assert.equal(signal.aborted, true);
  const held = await pending; assert.ok(held.status >= 400); assert.equal(held.body.message?.content, undefined);
  assert.deepEqual((await f.call('/api/state')).body.agent.head, before);
});

test('selected catalogue model and limits reach the native generation boundary and its independent reviewer', async t => {
  const f = await fixture(t, { native: true }); await f.configure();
  assert.equal((await f.call('/api/model', { tier: 'byok', model: 'model-b' })).status, 200);
  const nativeChat = await f.call('/api/chat', { message: 'Please respond carefully with the selected native model.' });
  assert.equal(nativeChat.status, 200, JSON.stringify(nativeChat.body));
  assert.equal(f.generated.at(-1).model, 'model-b'); assert.equal(f.reviewed.at(-1).model, 'model-b');
  assert.deepEqual(f.nativeContexts.at(-1), { reasoning: true, contextWindow: 65536, maxOutputTokens: 8192 });
});
