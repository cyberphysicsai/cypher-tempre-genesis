import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRequest, assertProviderCompletion } from '../openclaw/gateway.mjs';
import { safeInvocationError, invocationError, errorStage } from '../lib/runtime-errors.mjs';

test('every native provider forward obeys the admitted output allowance without altering tool/context payloads', () => {
  const cases = [
    ['compatible', '/compatible/v1/chat/completions', { model: 'route', max_tokens: 32768, messages: [], tools: [{ type: 'function', function: { name: 'read' } }] }, ['max_tokens']],
    ['compatible', '/compatible/v1/chat/completions', { model: 'route', max_completion_tokens: 32768, messages: [] }, ['max_completion_tokens']],
    ['openai', '/openai/v1/responses', { model: 'route', max_output_tokens: 32768, input: [], store: false }, ['max_output_tokens']],
    ['anthropic', '/anthropic/v1/messages', { model: 'route', max_tokens: 32768, system: 'Be accurate.', messages: [] }, ['max_tokens']],
    ['gemini', '/gemini/v1beta/models/route:generateContent', { contents: [], generationConfig: { maxOutputTokens: 32768, temperature: 0.2 } }, ['generationConfig', 'maxOutputTokens']],
  ];
  for (const [provider, route, body, keys] of cases) {
    const original = structuredClone(body), config = { provider, model: 'actual', apiKey: 'synthetic-private-key', baseUrl: 'https://models.example/v1' };
    const forwarded = providerRequest(config, route, body, { maxTokens: 4096 });
    assert.equal(keys.reduce((value, key) => value[key], forwarded.body), 4096, provider);
    assert.deepEqual(body, original, 'Native caller objects remain unchanged.');
    if (body.tools) assert.deepEqual(forwarded.body.tools, body.tools);
    const capped = providerRequest({ ...config, maxOutputTokens: 1024 }, route, body, { maxTokens: 4096 });
    assert.equal(keys.reduce((value, key) => value[key], capped.body), 1024, provider);
  }
  const config = { provider: 'compatible', model: 'fixture', baseUrl: 'http://127.0.0.1:1234/v1' };
  assert.equal(providerRequest(config, '/compatible/v1/chat/completions', { max_tokens: 256 }, { maxTokens: 4096 }).body.max_tokens, 256);
  assert.throws(() => providerRequest(config, '/compatible/v1/chat/completions', { max_tokens: '32768' }, { maxTokens: 4096 }), error => error.code === 'OPENCLAW_OUTPUT_BUDGET');
  const gemini = { provider: 'gemini', model: 'fixture', apiKey: 'synthetic-only', baseUrl: 'https://models.example/v1beta', maxOutputTokens: 1024 };
  const alias = providerRequest(gemini, '/gemini/models/route:generateContent', { generation_config: { max_output_tokens: 32768, temperature: 0.1 } }, { maxTokens: 4096 });
  assert.deepEqual(alias.body.generationConfig, { maxOutputTokens: 1024, temperature: 0.1 });
  assert.equal(Object.hasOwn(alias.body, 'generation_config'), false);
  assert.throws(() => providerRequest(gemini, '/gemini/models/route:generateContent', { generationConfig: {}, generation_config: { max_output_tokens: 32768 } }, { maxTokens: 4096 }), error => error.code === 'OPENCLAW_OUTPUT_BUDGET');
});

test('native failure diagnostics preserve useful fixed code/stage without copying provider content', () => {
  const original = Object.assign(new Error('PRIVATE-KEY private prompt and https://private.example/account'), { code: 'GATE_INVALID_REVIEW', stage: 'review' });
  const snapshot = safeInvocationError(original), restored = invocationError(snapshot);
  assert.equal(restored.code, 'GATE_INVALID_REVIEW'); assert.equal(restored.stage, 'review');
  assert.equal(restored.message.includes('PRIVATE-KEY'), false);
  assert.equal(restored.message.includes('private.example'), false);
  assert.equal(safeInvocationError({ code: 'MODEL_MADE_UP_CODE', message: 'private content' }), null);
  assert.equal(errorStage({ code: 'INVALID_LOADOUT', stage: 'arbitrary-user-text' }), 'loadout');
  assert.equal(errorStage({ code: 'REQUEST_CANCELLED' }), 'cancellation');
});

test('native adapters retain explicit provider truncation and never treat tool calls or quoted stop strings as truncation', () => {
  for (const [provider, value] of [
    ['compatible', { choices: [{ finish_reason: 'length' }] }],
    ['openai', { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }],
    ['anthropic', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS' }] }],
  ]) assert.throws(() => assertProviderCompletion(provider, Buffer.from('data: ' + JSON.stringify(value) + '\n\n')),
    error => error.code === 'PROVIDER_INCOMPLETE', provider);
  assert.doesNotThrow(() => assertProviderCompletion('compatible', Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { content: 'finish_reason: length' } }] }))));
  assert.throws(() => assertProviderCompletion('compatible', Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'content_filter' }] }))),
    error => error.code === 'PROVIDER_CONTENT_HELD');
  assert.throws(() => assertProviderCompletion('compatible', Buffer.from('data: {"choices": [\ndata: {"finish_reason":"length"}]}\n\n')),
    error => error.code === 'PROVIDER_INCOMPLETE');
  assert.throws(() => assertProviderCompletion('gemini', Buffer.from(JSON.stringify([{ candidates: [{ finishReason: 'MAX_TOKENS' }] }]))),
    error => error.code === 'PROVIDER_INCOMPLETE');
});
