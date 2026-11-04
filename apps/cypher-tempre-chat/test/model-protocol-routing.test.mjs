import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelCatalogue } from '../lib/model-catalogue.mjs';
import { providerRequest } from '../openclaw/gateway.mjs';

const key = 'isolated-fixture-private-key';
const config = { provider: 'openai', model: 'responses-model', baseUrl: 'https://opencode.ai/inference/go/openai/v1',
  apiKey: key, reasoningCapable: true, contextWindow: 64000, maxOutputTokens: 4096 };
const model = (id, family, suffix, cap = 8192) => ({ id, name: id, type: 'chat',
  limit: { context: 262144, output: cap }, capabilities: { reasoning: { supported: true } },
  api: { [family]: { base_url: 'https://opencode.ai/inference/go' + suffix } } });
function catalogue(records) {
  return createModelCatalogue({ fetchImpl: async url => new Response(JSON.stringify(url.includes('cyphertempre')
    ? { freeOnly: true, available: false, models: [] } : { data: records }), { headers: { 'content-type': 'application/json' } }) });
}

test('OpenCode model switches select the advertised protocol and route without losing the private key or increasing user output budget', async () => {
  const directory = catalogue([model('responses-model', 'responses', '/openai/v1', 131072),
    model('messages-model', 'messages', '/anthropic/v1'), model('chat-model', 'chat-completions', '/openai/v1'),
    model('gemini-model', 'generate-content', '/google/v1beta')]);
  const listed = await directory.byokTier(config);
  assert.equal(JSON.stringify(listed).includes(key), false);
  assert.equal(listed.models.find(m => m.id === 'responses-model').contextWindow, 262144);
  assert.equal(listed.models.find(m => m.id === 'responses-model').reasoningCapable, true);
  for (const [id, provider, path] of [['messages-model','anthropic','/anthropic/v1/messages'],
    ['chat-model','compatible','/compatible/v1/chat/completions'], ['gemini-model','gemini','/gemini/v1beta/models/route:generateContent']]) {
    const next = await directory.selectByok(config, id);
    assert.equal(next.provider, provider);
    assert.equal(next.apiKey, key);
    assert.equal(next.contextWindow, 64000);
    assert.equal(next.maxOutputTokens, 4096);
    const request = providerRequest(next, path, { model: 'route', messages: [], contents: [] }, { openCodeSession: '6ea7ed41-af38-4e35-8bd8-88f5b4eb4cb3' });
    assert.ok(request.url.startsWith('https://opencode.ai/inference/go/'));
    assert.equal(JSON.stringify(request.body).includes(key), false);
  }
});

test('catalogue routes cannot redirect a private key to another origin, service tier, arbitrary API or non-chat model', async () => {
  const attacker = model('wrong-origin', 'messages', '/anthropic/v1');
  attacker.api.messages.base_url = 'https://outside.example/v1';
  const wrongTier = model('wrong-tier', 'responses', '/openai/v1');
  wrongTier.api.responses.base_url = 'https://opencode.ai/inference/openai/v1';
  const directory = catalogue([attacker, wrongTier, { id: 'image-only', type: 'image' }]);
  const listed = await directory.byokTier(config);
  assert.equal(listed.models.some(m => m.id === 'image-only'), false);
  for (const id of ['wrong-origin', 'wrong-tier']) await assert.rejects(directory.selectByok(config, id), /unavailable/);
});

test('manual IDs preserve existing reasoning/context/output settings; advertised smaller models clamp instead of exceeding their limits', async () => {
  const directory = catalogue([model('small-model', 'responses', '/openai/v1', 1024)]);
  const manual = await directory.selectByok(config, 'manual-model');
  assert.equal(manual.reasoningCapable, true);
  assert.equal(manual.contextWindow, 64000);
  assert.equal(manual.maxOutputTokens, 4096);
  const small = await directory.selectByok(config, 'small-model');
  assert.equal(small.maxOutputTokens, 1024);
});

test('model metadata cannot ratchet later selections down; original explicit user ceilings remain authoritative', async () => {
  const smallModel = model('small-model', 'chat-completions', '/openai/v1', 1024);
  smallModel.limit.context = 16384;
  smallModel.capabilities.reasoning.supported = false;
  const directory = catalogue([smallModel, model('large-model', 'responses', '/openai/v1')]);
  const { contextWindow, maxOutputTokens, ...withoutLimits } = config;
  const small = await directory.selectByok(withoutLimits, 'small-model');
  assert.equal(small.contextWindow, 16384);
  assert.equal(small.maxOutputTokens, 1024);
  const restored = await directory.selectByok(small, 'large-model');
  assert.equal(restored.contextWindow, undefined); // Original application default.
  assert.equal(restored.maxOutputTokens, 8192);
  assert.equal(restored.reasoningCapable, true);
  const cappedSmall = await directory.selectByok(config, 'small-model');
  const cappedRestored = await directory.selectByok(cappedSmall, 'large-model');
  assert.equal(cappedRestored.contextWindow, 64000);
  assert.equal(cappedRestored.maxOutputTokens, 4096);
  assert.equal(cappedRestored.apiKey, key);
});
