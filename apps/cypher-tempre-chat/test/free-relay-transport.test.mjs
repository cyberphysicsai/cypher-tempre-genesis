import test from 'node:test';
import assert from 'node:assert/strict';
import { generate, review, FRUITS, DIMENSIONS } from '../lib/providers.mjs';

const configuration = () => ({ provider: 'compatible', model: 'free-fixture', apiKey: 'chainchat-free-tier',
  baseUrl: 'https://cyphertempre.ai/api/free-model/v1' });
const score = () => ({ decision: 'approve', usedRings: [], scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: 'A careful, honest fixture response.' });

test('the exact free relay gets a public random session stable across generation and review with no shared secret', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = JSON.parse(options.body); requests.push({ url, headers: options.headers, body });
    const text = body.messages[0].content.includes('independent pre-release covenant reviewer') ? JSON.stringify(score()) : 'A careful fixture response.';
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }));
  });
  const config = configuration();
  await generate(config, { messages: [{ role: 'user', content: 'Please respond carefully.' }] });
  await review(config, { input: 'Please respond carefully.', candidate: 'A careful fixture response.', covenant: [...FRUITS] });
  await generate({ ...config }, { messages: [{ role: 'user', content: 'Another private session.' }] });
  const id = requests[0].headers['x-chainchat-session'];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(requests[1].headers['x-chainchat-session'], id); assert.notEqual(requests[2].headers['x-chainchat-session'], id);
  for (const request of requests) {
    assert.equal(request.headers['x-opencode-session'], undefined);
    assert.equal(request.headers['user-agent'], 'CypherTempre-ChainChat');
    assert.equal(request.headers.authorization, 'Bearer chainchat-free-tier');
    assert.equal(request.url, config.baseUrl + '/chat/completions');
    assert.equal(JSON.stringify(request.body).includes(id), false);
  }
});

test('unrelated hosts, paths, ports and non-marker keys cannot acquire a free relay session header', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, headers: options.headers });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A careful fixture response.' }, finish_reason: 'stop' }] }));
  });
  for (const patch of [
    { baseUrl: 'https://cyphertempre.ai.evil.example/api/free-model/v1' },
    { baseUrl: 'https://cyphertempre.ai:444/api/free-model/v1' },
    { baseUrl: 'https://cyphertempre.ai/other/v1' },
    { apiKey: 'synthetic-real-byok-key' },
  ]) {
    await generate({ ...configuration(), ...patch }, { messages: [{ role: 'user', content: 'Please respond carefully.' }] });
    assert.equal(requests.at(-1).headers['x-chainchat-session'], undefined);
    assert.equal(requests.at(-1).headers['user-agent'], undefined);
  }
});
