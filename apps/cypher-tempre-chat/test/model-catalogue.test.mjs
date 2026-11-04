import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCatalogue, FREE_MODEL_BASE_URL, FREE_MODEL_MARKER } from '../lib/model-catalogue.mjs';

const key = 'synthetic-private-catalogue-key';
const configured = (patch = {}) => ({ provider: 'compatible', model: 'current-model', baseUrl: 'https://models.example/v1', apiKey: key, ...patch });
const reply = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const free = (models = []) => ({ freeOnly: true, available: true, notice: 'Free fixture availability.', models });
const row = (id, patch = {}) => ({ id, name: id, available: true, free: true, pricing: { input: 0, output: 0 },
  contextWindow: 65536, maxOutputTokens: 4096, reasoningCapable: false, privacyNotice: 'Fixture relay privacy.', ...patch });

test('provider catalogues use fixed protocol routes and private headers with no credentials in their public result', async () => {
  for (const provider of ['compatible', 'openai', 'anthropic', 'gemini']) {
    const requests = [], catalogue = createModelCatalogue({ fetchImpl: async (url, options) => {
      requests.push({ url, options }); return reply(provider === 'gemini'
        ? { models: [{ name: 'models/chat-model', displayName: 'Chat model', inputTokenLimit: 65536, outputTokenLimit: 4096,
          supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed-model', supportedGenerationMethods: ['embedContent'] }] }
        : { data: [{ id: 'listed-model', name: 'Listed model', context_window: 65536, max_output_tokens: 4096 }] });
    } });
    const tier = await catalogue.byokTier(configured({ provider, model: provider === 'gemini' ? 'models/current-model' : 'current-model' }));
    assert.equal(requests[0].url, 'https://models.example/v1/models');
    assert.equal(requests[0].options.redirect, 'error'); assert.ok(requests[0].options.signal instanceof AbortSignal);
    const headers = requests[0].options.headers;
    assert.equal(headers[provider === 'anthropic' ? 'x-api-key' : provider === 'gemini' ? 'x-goog-api-key' : 'authorization'],
      ['anthropic', 'gemini'].includes(provider) ? key : 'Bearer ' + key);
    assert.equal(JSON.stringify(tier).includes(key), false);
    assert.ok(tier.models.some(model => model.contextWindow === 65536));
    assert.equal(tier.models.some(model => model.id === 'models/embed-model'), false);
  }
});

test('OpenCode Console and Go catalogues use their fixed public metadata endpoint, not an inference key', async () => {
  for (const go of [false, true]) {
    let request;
    const catalogue = createModelCatalogue({ fetchImpl: async (url, options) => {
      request = { url, options }; return reply({ data: [{ id: 'metadata-model' }] });
    } });
    await catalogue.byokTier(configured({ baseUrl: `https://opencode.ai/inference/${go ? 'go/' : ''}openai/v1` }));
    assert.equal(request.url, `https://opencode.ai/inference/${go ? 'go/' : ''}v1/models`);
    assert.equal(JSON.stringify(request.options).includes(key), false);
    if (go) { assert.match(request.options.headers['x-opencode-session'], /^[a-f0-9-]{36}$/); assert.equal(request.options.headers['user-agent'], 'CypherTempre-ChainChat'); }
  }
});

test('free models require explicit free-only, free flag, exact zero prices and current availability', async () => {
  const catalogue = createModelCatalogue({ fetchImpl: async () => reply(free([
    row('free-good'), row('paid', { pricing: { input: 0, output: 1 } }), row('unknown', { pricing: {} }),
    row('string-zero', { pricing: { input: '0', output: '0' } }), row('missing-flag', { free: undefined }),
    row('offline', { available: false, reason: 'Provider unavailable.' }),
  ])) });
  const tier = await catalogue.freeTier();
  assert.equal(tier.available, true); assert.deepEqual(tier.models.map(model => model.id), ['free-good', 'offline']);
  for (const id of ['paid', 'unknown', 'string-zero', 'missing-flag', 'offline']) await assert.rejects(catalogue.selectFree(id), { code: 'MODEL_UNAVAILABLE' });
  const selected = await catalogue.selectFree('free-good');
  assert.equal(selected.tier, 'free'); assert.equal(selected.model, 'free-good');
  assert.equal(selected.baseUrl, FREE_MODEL_BASE_URL); assert.equal(selected.apiKey, FREE_MODEL_MARKER);
  assert.equal(selected.provider, 'compatible'); assert.equal(selected.contextWindow, 65536);
  for (const payload of [{ available: true, models: [row('not-explicit-free-only')] },
    { ...free([row('not-available')]), available: false }]) {
    const closed = createModelCatalogue({ fetchImpl: async () => reply(payload) });
    assert.equal((await closed.freeTier()).available, false);
    await assert.rejects(closed.selectFree(payload.models[0].id), { code: 'MODEL_UNAVAILABLE' });
  }
});

test('free refresh rechecks availability and never falls back to a remembered paid route', async () => {
  let available = true, calls = 0;
  const catalogue = createModelCatalogue({ fetchImpl: async () => { calls++; return reply({ ...free([row('free-good')]), available }); } });
  assert.equal((await catalogue.freeTier()).available, true); available = false;
  assert.equal((await catalogue.freeTier()).available, true, 'The short public metadata cache has no credential.');
  assert.equal((await catalogue.freeTier({ refresh: true })).available, false);
  await assert.rejects(catalogue.selectFree('free-good'), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(calls, 3);
});

test('BYOK selection preserves its configured key/base, supports manual IDs and applies known model limits', async () => {
  const catalogue = createModelCatalogue({ fetchImpl: async () => reply({ data: [row('reasoning-model', { reasoningCapable: true }),
    row('disabled-model', { available: false })] }) });
  const selected = await catalogue.selectByok(configured(), 'reasoning-model');
  assert.equal(selected.apiKey, key); assert.equal(selected.baseUrl, configured().baseUrl);
  assert.equal(selected.reasoningCapable, true); assert.equal(selected.contextWindow, 65536);
  const manual = await catalogue.selectByok(selected, 'custom-model');
  assert.equal(manual.model, 'custom-model'); assert.equal(manual.apiKey, key);
  assert.equal(manual.reasoningCapable, selected.reasoningCapable); assert.equal(manual.contextWindow, selected.contextWindow);
  assert.equal(manual.maxOutputTokens, selected.maxOutputTokens);
  await assert.rejects(catalogue.selectByok(selected, 'disabled-model'), { code: 'MODEL_UNAVAILABLE' });
  await assert.rejects(catalogue.selectByok(null, 'custom-model'), { code: 'PROVIDER_REQUIRED' });
});

test('missing/redirected/oversized/reflected provider catalogues fail to manual BYOK rather than expose upstream content', async () => {
  const transports = [
    async () => new Response('bad', { status: 302, headers: { location: 'https://other.example/' } }),
    async () => new Response('not JSON'),
    async () => reply({ data: [{ id: 'reflected', name: key }] }),
    async () => new Response('x'.repeat(1024 * 1024 + 1)),
  ];
  for (const fetchImpl of transports) {
    const catalogue = createModelCatalogue({ fetchImpl });
    const tier = await catalogue.byokTier(configured());
    assert.equal(tier.available, true); assert.equal(JSON.stringify(tier).includes(key), false);
    assert.deepEqual(tier.models.map(model => model.id), ['current-model']);
    assert.equal((await catalogue.selectByok(configured(), 'manual-model')).model, 'manual-model');
  }
});
