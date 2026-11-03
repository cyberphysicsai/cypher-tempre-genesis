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

test('native provider failures and content holds are never classified as recoverable truncation', () => {
  const cases = [
    ['openai', { type: 'response.failed', response: { status: 'failed', error: { code: 'invalid_api_key', message: 'PRIVATE auth details' } } }, 'PROVIDER_HTTP_ERROR'],
    ['openai', { type: 'response.failed', response: { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'PRIVATE quota details' } } }, 'PROVIDER_RATE_LIMIT'],
    ['openai', { type: 'response.failed', response: { status: 'failed', error: { code: 'unknown_fault', message: 'PRIVATE failure details' } } }, 'PROVIDER_INVALID_RESPONSE'],
    ['openai', { type: 'error', code: 'invalid_api_key', message: 'PRIVATE auth details' }, 'PROVIDER_HTTP_ERROR'],
    ['openai', { status: 'cancelled' }, 'PROVIDER_INVALID_RESPONSE'],
    ['openai', { status: 'incomplete', incomplete_details: { reason: 'unknown' } }, 'PROVIDER_INVALID_RESPONSE'],
    ['openai', { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' } } }, 'PROVIDER_CONTENT_HELD'],
    ['openai', { type: 'response.refusal.delta', delta: 'PRIVATE refusal' }, 'PROVIDER_CONTENT_HELD'],
    ['compatible', { choices: [{ finish_reason: 'stop', message: { refusal: 'PRIVATE refusal' } }] }, 'PROVIDER_CONTENT_HELD'],
    ['compatible', { choices: [{ delta: { refusal: 'PRIVATE refusal' } }] }, 'PROVIDER_CONTENT_HELD'],
    ['compatible', { choices: [{ finish_reason: 'unknown_stop' }] }, 'PROVIDER_INVALID_RESPONSE'],
    ['anthropic', { type: 'message_delta', delta: { stop_reason: 'refusal' } }, 'PROVIDER_CONTENT_HELD'],
    ['anthropic', { stop_reason: 'unknown_stop' }, 'PROVIDER_INVALID_RESPONSE'],
    ['anthropic', { type: 'error', error: { type: 'rate_limit_error', message: 'PRIVATE quota details' } }, 'PROVIDER_RATE_LIMIT'],
    ['gemini', { candidates: [{ finishReason: 'SAFETY' }] }, 'PROVIDER_CONTENT_HELD'],
    ['gemini', { promptFeedback: { blockReason: 'SAFETY' } }, 'PROVIDER_CONTENT_HELD'],
    ['gemini', { candidates: [{ finishReason: 'UNKNOWN' }] }, 'PROVIDER_INVALID_RESPONSE'],
    ['gemini', { error: { code: 403, status: 'PERMISSION_DENIED', message: 'PRIVATE permission details' } }, 'PROVIDER_HTTP_ERROR'],
  ];
  for (const [protocol, response, code] of cases) {
    for (const wire of [JSON.stringify(response), 'data: ' + JSON.stringify(response) + '\n\n'])
      assert.throws(() => assertProviderCompletion(protocol, Buffer.from(wire)),
        error => error.code === code && error.code !== 'PROVIDER_INCOMPLETE' && error.stage === 'generation' && !error.message.includes('PRIVATE'), protocol + ':' + code);
  }
  for (const [protocol, response] of [
    ['openai', { type: 'response.in_progress', response: { status: 'in_progress' } }],
    ['openai', { status: 'completed', output: [{ type: 'function_call', name: 'fixture' }] }],
    ['compatible', { choices: [{ finish_reason: 'tool_calls' }] }],
    ['anthropic', { delta: { stop_reason: 'tool_use' } }],
    ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'fixture' } }] } }] }],
  ]) assert.doesNotThrow(() => assertProviderCompletion(protocol, Buffer.from(JSON.stringify(response))),
    'Native guarded tool execution must remain available: ' + protocol);
});
