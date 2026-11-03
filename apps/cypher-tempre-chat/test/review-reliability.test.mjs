import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { generate, review, parseReview, validateProvider, answerTokenAllowance, perspectiveTokenAllowance, DIMENSIONS, FRUITS } from '../lib/providers.mjs';
import { enrichPrepared } from '../lib/native-cognition.mjs';
import { Activity, defaultCognition } from '../lib/cognition.mjs';

const good = () => ({ decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: 'A supported, kind and honest response.' });
const args = () => ({ input: 'Please introduce yourself.', candidate: 'Hello! I can help you think carefully.', covenant: [...FRUITS] });
async function provider(t, respond) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const call = { headers: request.headers, body: JSON.parse(raw) }; calls.push(call);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(respond(call, calls.length)));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { calls, config: { provider: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}
const answer = (text, finish = 'stop') => ({ choices: [{ finish_reason: finish, message: { role: 'assistant', content: text } }] });

test('provider limits are explicit bounded integers and constrain all four direct protocols', async t => {
  const config = { provider: 'compatible', model: 'fixture', contextWindow: 16384, maxOutputTokens: 1024 };
  assert.equal(validateProvider(config).contextWindow, 16384);
  assert.equal(validateProvider(config).maxOutputTokens, 1024);
  assert.equal(Object.hasOwn(validateProvider({ provider: 'compatible', model: 'fixture' }), 'maxOutputTokens'), false);
  for (const limits of [{ contextWindow: '16384' }, { contextWindow: 4095 }, { contextWindow: 2097153 },
    { contextWindow: 8192.5 }, { maxOutputTokens: '1024' }, { maxOutputTokens: 127 }, { maxOutputTokens: 32769 },
    { contextWindow: 4096, maxOutputTokens: 4096 }]) assert.throws(() => validateProvider({ ...config, ...limits }), { code: 'INVALID_PROVIDER' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Safe answer.' }] }],
      ...answer('Safe answer.'), stop_reason: 'end_turn', content: [{ type: 'text', text: 'Safe answer.' }],
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Safe answer.' }] } }] }));
  });
  for (const protocol of ['compatible', 'openai', 'anthropic', 'gemini']) {
    await generate({ ...config, provider: protocol, baseUrl: 'http://127.0.0.1:9999/v1' },
      { maxTokens: 12000, messages: [{ role: 'user', content: 'Hello' }] });
    const body = calls.at(-1);
    assert.equal(body.max_tokens ?? body.max_output_tokens ?? body.generationConfig.maxOutputTokens, 1024);
  }
  assert.equal(perspectiveTokenAllowance({ provider: 'compatible', model: 'fixture' }), 4096);
  assert.equal(perspectiveTokenAllowance({ provider: 'compatible', model: 'fixture', reasoningCapable: true }), 8192);
  assert.equal(perspectiveTokenAllowance({ ...config, reasoningCapable: true }), 1024);
  assert.equal(answerTokenAllowance({ provider: 'compatible', model: 'fixture' }), 4096);
  assert.equal(answerTokenAllowance({ provider: 'compatible', model: 'fixture', reasoningCapable: true }), 8192);
  assert.equal(answerTokenAllowance({ ...config, contextWindow: 65536, maxOutputTokens: 16384 }), 16384);
  assert.equal(answerTokenAllowance({ ...config, reasoningCapable: true }), 1024);
});

test('complete bare and singly fenced review objects retain every original gate check', () => {
  const raw = JSON.stringify(good());
  for (const text of [raw, `  ${raw}\n`, '```json\n' + raw + '\n```', '```\r\n' + raw + '\r\n```'])
    assert.equal(parseReview(text).approved, true);
  for (const text of ['A review follows.\n' + raw, raw + '\nThanks.', raw + '\n' + raw,
    '```javascript\n' + raw + '\n```', '```json\n' + raw + '\n```\n```json\n' + raw + '\n```',
    JSON.stringify([good()]), JSON.stringify(raw), 'null']) assert.throws(() => parseReview(text), { code: 'GATE_INVALID_REVIEW' });
  for (const fruit of FRUITS) {
    const low = good(); low.fruits[fruit] = 179;
    assert.equal(parseReview('```json\n' + JSON.stringify(low) + '\n```').approved, false, fruit);
  }
  const missing = good(); delete missing.usedRings;
  assert.throws(() => parseReview('```json\n' + JSON.stringify(missing) + '\n```'), { code: 'GATE_INVALID_EVIDENCE' });
});

test('a truncated or malformed review receives one fresh bounded same-candidate assessment', async t => {
  for (const first of ['truncated', 'malformed', 'missing-evidence']) await t.test(first, async t => {
    const mock = await provider(t, (_call, count) => count > 1 ? answer(JSON.stringify(good()))
      : first === 'truncated' ? answer('{"decision":', 'length')
      : first === 'malformed' ? answer('Incomplete JSON {')
      : answer(JSON.stringify({ ...good(), usedRings: undefined })));
    const assessment = await review({ ...mock.config, maxOutputTokens: 1536 }, args());
    assert.equal(assessment.approved, true); assert.equal(mock.calls.length, 2);
    assert.ok(mock.calls.every(call => call.body.max_tokens === 1536));
    assert.deepEqual(mock.calls[0].body.messages[1], mock.calls[1].body.messages[1]);
    assert.match(mock.calls[1].body.messages[0].content, /Do not change a judgment merely to obtain approval/);
    assert.doesNotMatch(mock.calls[1].body.messages[0].content, /Incomplete JSON \{/);
  });
});

test('a rejection or low fruit score is final even when another required field is missing', async t => {
  for (const kind of ['reject', 'low-fruit', 'missing-evidence', 'reject-missing', 'low-missing']) await t.test(kind, async t => {
    const value = good();
    if (kind.startsWith('reject')) value.decision = 'reject';
    if (kind.startsWith('low')) value.fruits.joy = 179;
    if (kind === 'missing-evidence' || kind.endsWith('-missing')) delete value.usedRings;
    const mock = await provider(t, () => answer(JSON.stringify(value)));
    if (kind === 'missing-evidence' || kind.endsWith('-missing')) {
      await assert.rejects(review(mock.config, args()), error => error.code === 'GATE_INVALID_EVIDENCE' && error.stage === 'review');
      assert.equal(mock.calls.length, kind === 'missing-evidence' ? 2 : 1);
    } else {
      assert.equal((await review(mock.config, args())).approved, false);
      assert.equal(mock.calls.length, 1);
    }
  });
});

test('review authentication and cancellation errors never trigger compatibility retry', async t => {
  let calls = 0, mode = 'authentication';
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (mode === 'authentication') return new Response('', { status: 401 });
    controller.abort(); throw new Error('Synthetic cancellation');
  });
  await assert.rejects(review({ provider: 'compatible', model: 'fixture' }, args()),
    error => error.code === 'PROVIDER_HTTP_ERROR' && error.stage === 'review');
  assert.equal(calls, 1);
  calls = 0; mode = 'cancellation';
  await assert.rejects(review({ provider: 'compatible', model: 'fixture' }, { ...args(), signal: controller.signal }),
    error => error.code === 'REQUEST_CANCELLED' && error.stage === 'review');
  assert.equal(calls, 1);
});

test('decoded fenced review credentials are held before normalization and are never retried', async t => {
  const secret = 'synthetic-' + String.fromCharCode(80, 111, 81) + '-"quoted"-\\suffix';
  const mock = await provider(t, () => answer('```json\n' + JSON.stringify({ ...good(), rationale: secret }) + '\n```'));
  await assert.rejects(review({ ...mock.config, apiKey: secret }, args()),
    error => error.code === 'PROVIDER_CREDENTIAL_REFLECTION' && error.stage === 'review' && !error.message.includes(secret));
  assert.equal(mock.calls.length, 1);
});

const head = { index: 0, hash: 'a'.repeat(64) };
const memoryArgs = () => ({ config: { provider: 'compatible', model: 'fixture' }, message: 'Recall the latest preference.',
  record: { root: '/disposable-agent', settings: { recall: true }, cognition: { ...defaultCognition(), autoRoute: false } },
  prepared: { head, runtime: { supported: true }, context: '', availableEvidence: [], loadout: [] } });

test('an incomplete optional plan uses one bounded native query and leaves a visible safe fallback event', async () => {
  const calls = [], trace = new Activity('fixture'); trace.begin('Fixture');
  const out = await enrichPrepared({ ...memoryArgs(), trace,
    model: async () => { throw Object.assign(new Error('Do not expose private provider text.'), { code: 'PROVIDER_INCOMPLETE' }); },
    engine: async request => { calls.push(request); return { head, availableEvidence: [], coverage: { complete: false } }; } });
  assert.equal(calls.length, 1); assert.equal(calls[0].op, 'memory'); assert.equal(calls[0].action, 'evidence');
  assert.equal(calls[0].budgetChars, 24000); assert.equal(out.plan.validated, false); assert.equal(out.plan.useReplay, false);
  assert.equal(out.plan.fallbackReason, 'PROVIDER_INCOMPLETE'); assert.equal(out.prepared.memoryCoverage.complete, false);
  const events = trace.snapshot().events;
  assert.ok(events.some(event => event.fallback === true));
  assert.equal(JSON.stringify(events).includes('private provider text'), false);
});

test('planner fallback never hides admission, credentials, auth, cancellation or native integrity failures', async () => {
  for (const code of ['PROVIDER_HTTP_ERROR', 'PROVIDER_RATE_LIMIT', 'PROVIDER_INVALID_RESPONSE', 'PROVIDER_CONTENT_HELD', 'PROVIDER_TOOL_CALL', 'PROVIDER_CREDENTIAL_REFLECTION', 'REQUEST_CANCELLED', 'LICENSE_REVOKED',
    'OPENCLAW_ENFORCEMENT_UNHEALTHY', 'INTEGRITY_FAILED', 'COVENANT_REJECTED']) {
    let calls = 0;
    await assert.rejects(enrichPrepared({ ...memoryArgs(),
      model: async () => { throw Object.assign(new Error('Held'), { code }); },
      engine: async () => { calls++; } }), error => error.code === code && error.stage === 'memory-planning');
    assert.equal(calls, 0, code);
  }
  await assert.rejects(enrichPrepared({ ...memoryArgs(),
    model: async () => { throw Object.assign(new Error('Incomplete'), { code: 'PROVIDER_INCOMPLETE' }); },
    engine: async () => ({ head: { ...head, hash: 'b'.repeat(64) }, availableEvidence: [] }) }), { code: 'STALE_HEAD' });
  const controller = new AbortController();
  let nativeCalls = 0;
  await assert.rejects(enrichPrepared({ ...memoryArgs(), signal: controller.signal,
    model: async () => { controller.abort(); throw Object.assign(new Error('Incomplete'), { code: 'PROVIDER_INCOMPLETE' }); },
    engine: async () => { nativeCalls++; } }), { code: 'CANCELLED' });
  assert.equal(nativeCalls, 0);
});

test('provider errors, policy holds, unknown stops and direct tool requests never become review retries or planner fallbacks', async t => {
  const visible = JSON.stringify(good());
  const cases = [
    ['openai', { status: 'failed', error: { code: 'invalid_api_key', message: 'PRIVATE synthetic failure' } }, 'PROVIDER_HTTP_ERROR'],
    ['openai', { status: 'failed', error: { code: 'rate_limit_exceeded', message: 'PRIVATE synthetic failure' } }, 'PROVIDER_RATE_LIMIT'],
    ['openai', { status: 'failed', error: { code: 'unknown_fault', message: 'PRIVATE synthetic failure' } }, 'PROVIDER_INVALID_RESPONSE'],
    ['openai', { status: 'cancelled' }, 'PROVIDER_INVALID_RESPONSE'],
    ['openai', { status: 'incomplete', incomplete_details: { reason: 'unknown_reason' } }, 'PROVIDER_INVALID_RESPONSE'],
    ['openai', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'PROVIDER_CONTENT_HELD'],
    ['openai', { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'PRIVATE synthetic refusal' }] }] }, 'PROVIDER_CONTENT_HELD'],
    ['openai', { status: 'completed', output: [{ type: 'function_call', name: 'fixture' }] }, 'PROVIDER_TOOL_CALL'],
    ['compatible', answer(visible, 'content_filter'), 'PROVIDER_CONTENT_HELD'],
    ['compatible', { choices: [{ finish_reason: 'stop', message: { content: visible, refusal: 'PRIVATE synthetic refusal' } }] }, 'PROVIDER_CONTENT_HELD'],
    ['compatible', answer(visible, 'unknown_stop'), 'PROVIDER_INVALID_RESPONSE'],
    ['compatible', answer(visible, ''), 'PROVIDER_INVALID_RESPONSE'],
    ['compatible', answer(visible, 'tool_calls'), 'PROVIDER_TOOL_CALL'],
    ['anthropic', { stop_reason: 'refusal', content: [{ type: 'text', text: visible }] }, 'PROVIDER_CONTENT_HELD'],
    ['anthropic', { stop_reason: 'unknown_stop', content: [{ type: 'text', text: visible }] }, 'PROVIDER_INVALID_RESPONSE'],
    ['anthropic', { stop_reason: false, content: [{ type: 'text', text: visible }] }, 'PROVIDER_INVALID_RESPONSE'],
    ['anthropic', { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'fixture' }] }, 'PROVIDER_TOOL_CALL'],
    ['gemini', { candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: visible }] } }] }, 'PROVIDER_CONTENT_HELD'],
    ['gemini', { promptFeedback: { blockReason: 'SAFETY' } }, 'PROVIDER_CONTENT_HELD'],
    ['gemini', { candidates: [{ finishReason: 'UNKNOWN', content: { parts: [{ text: visible }] } }] }, 'PROVIDER_INVALID_RESPONSE'],
    ['gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ functionCall: { name: 'fixture' } }] } }] }, 'PROVIDER_TOOL_CALL'],
  ];
  let payload, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify(payload)); });
  for (const [protocol, response, code] of cases) {
    payload = response;
    const config = { provider: protocol, model: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1' };
    const check = error => error.code === code && !error.message.includes('PRIVATE');
    await assert.rejects(generate(config, { messages: [{ role: 'user', content: 'Hello' }] }), check, protocol + ':' + code);
    const before = calls;
    await assert.rejects(review(config, args()), error => check(error) && error.stage === 'review', protocol + ':review:' + code);
    assert.equal(calls, before + 1, 'An explicit provider failure/hold must not trigger a fresh review.');
    let nativeCalls = 0;
    await assert.rejects(enrichPrepared({ ...memoryArgs(), config,
      model: (_config, request) => generate(config, request), engine: async () => { nativeCalls++; } }),
      error => check(error) && error.stage === 'memory-planning', protocol + ':planner:' + code);
    assert.equal(nativeCalls, 0, 'No native fallback may hide a provider failure/hold.');
  }
});

test('only actual token-limited direct responses remain eligible for incomplete handling', async t => {
  let payload;
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(payload)));
  for (const [protocol, response] of [
    ['compatible', answer('Partial.', 'length')],
    ['openai', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }],
    ['anthropic', { stop_reason: 'max_tokens', content: [{ type: 'text', text: 'Partial.' }] }],
    ['gemini', { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Partial.' }] } }] }],
  ]) {
    payload = response;
    await assert.rejects(generate({ provider: protocol, model: 'fixture', baseUrl: 'http://127.0.0.1:9999/v1' },
      { messages: [{ role: 'user', content: 'Hello' }] }), { code: 'PROVIDER_INCOMPLETE' });
  }
});
