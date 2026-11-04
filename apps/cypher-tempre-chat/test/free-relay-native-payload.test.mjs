import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generate } from '../lib/providers.mjs';

const runtime = process.env.CT_OPENCLAW_PACKAGE;
const php = process.env.CT_PHP_BIN || (process.platform !== 'win32' ? 'php' : null);
test('actual pinned native completions bodies pass the free PHP policy without enabling storage or paid tools', {
  skip: !runtime || !php ? 'Set the pinned native package and CT_PHP_BIN (Windows) for the native/PHP contract.' : false,
  timeout: 30000,
}, async t => {
  const require = createRequire(path.join(runtime, 'package.json'));
  const dist = path.dirname(require.resolve('@openclaw/ai'));
  const modules = (await fs.readdir(dist)).filter(name => /^openai-completions-(?!transport-|compat-).+\.mjs$/.test(name));
  assert.equal(modules.length, 1, 'Review the pinned adapter contract if its entry module changes.');
  const adapter = await import(pathToFileURL(path.join(dist, modules[0])).href);
  const stream = adapter.n;
  assert.equal(typeof stream, 'function');
  let attemptedHTTP = 0;
  t.mock.method(globalThis, 'fetch', async () => { attemptedHTTP++; throw new Error('This native serializer fixture permits no HTTP.'); });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-relay-native-body-'));
  t.after(async () => {
    const absolute = await fs.realpath(temporary), parent = await fs.realpath(os.tmpdir());
    assert.ok(absolute.startsWith(parent + path.sep) && path.basename(absolute).startsWith('ct-relay-native-body-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const validator = path.join(temporary, 'validate.php');
  await fs.writeFile(validator, '<?php require $argv[1]; $body=json_decode(file_get_contents($argv[2]),true,64,JSON_THROW_ON_ERROR); $body["model"]="beam-free"; $safe=CypherTempre\\FreeModels\\Policy::request($body,["beam-free"=>["maxOutputTokens"=>8192]]); echo json_encode(["accepted"=>true,"tokens"=>$safe["max_tokens"],"stream"=>$safe["stream"],"tools"=>count($safe["tools"]??[]),"store"=>array_key_exists("store",$safe),"cache"=>array_key_exists("prompt_cache_key",$safe)],JSON_THROW_ON_ERROR);');
  const model = { id: 'route', name: 'User selected model', api: 'openai-completions', provider: 'chainchat-compatible',
    baseUrl: 'http://127.0.0.1:1/compatible/v1', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const tools of [[], [{ name: 'noop', description: 'An explicitly granted synthetic function.',
    parameters: { type: 'object', properties: {}, additionalProperties: false } }]]) {
    let captured;
    const result = stream(model, { systemPrompt: 'A synthetic careful fixture.', messages: [
      { role: 'user', content: 'Please respond carefully.', timestamp: 1 },
    ], tools }, { apiKey: 'synthetic-local-serializer-key', maxTokens: 512, sessionId: 'synthetic-private-session',
      onPayload: body => { captured = JSON.parse(JSON.stringify(body)); throw new Error('CAPTURE_BEFORE_HTTP'); } });
    await result.result();
    assert.ok(captured); assert.equal(attemptedHTTP, 0);
    const capturedFile = path.join(temporary, 'body.json'); await fs.writeFile(capturedFile, JSON.stringify(captured));
    const core = fileURLToPath(new URL('../public/api/relay-core.php', import.meta.url));
    const { stdout } = await promisify(execFile)(php, [validator, core, capturedFile], { windowsHide: true, timeout: 10000 });
    assert.deepEqual(JSON.parse(stdout), { accepted: true, tokens: 512, stream: true, tools: tools.length, store: false, cache: false });
  }
});

test('actual pinned native SSE parser and direct reviewer fail closed on PHP late errors after pending padding', {
  skip: !runtime || !php ? 'Set the pinned native package and CT_PHP_BIN (Windows) for the native/PHP contract.' : false,
  timeout: 30000,
}, async t => {
  const require = createRequire(path.join(runtime, 'package.json'));
  const dist = path.dirname(require.resolve('@openclaw/ai'));
  const modules = (await fs.readdir(dist)).filter(name => /^openai-completions-(?!transport-|compat-).+\.mjs$/.test(name));
  assert.equal(modules.length, 1);
  const adapter = await import(pathToFileURL(path.join(dist, modules[0])).href);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-relay-native-error-'));
  t.after(async () => {
    const absolute = await fs.realpath(temporary), parent = await fs.realpath(os.tmpdir());
    assert.ok(absolute.startsWith(parent + path.sep) && path.basename(absolute).startsWith('ct-relay-native-error-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  const fixture = path.join(temporary, 'pending.php');
  await fs.writeFile(fixture, '<?php require $argv[1]; $results=[]; foreach ([false,true] as $stream) { $clock=0.0; $out=""; $pending=new CypherTempre\\FreeModels\\PendingOutput($stream,function()use(&$clock){return $clock;},function($bytes)use(&$out){$out.=$bytes;},fn()=>null,fn()=>null); $clock=12; $pending->pulse(); $pending->fail(["error"=>["code"=>"FREE_PRICE_CHANGED","message"=>"This response is held."]]); $results[$stream?"sse":"json"]=$out; } echo json_encode($results,JSON_THROW_ON_ERROR);');
  const core = fileURLToPath(new URL('../public/api/relay-core.php', import.meta.url));
  const { stdout } = await promisify(execFile)(php, [fixture, core], { windowsHide: true, timeout: 10000 });
  const body = JSON.parse(stdout);
  assert.ok(body.sse.startsWith(': pending') && body.json.startsWith(' '));
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests++;
    const request = JSON.parse(options.body);
    return new Response(request.stream ? body.sse : body.json, {
      status: 200, headers: { 'content-type': request.stream ? 'text/event-stream' : 'application/json' },
    });
  });
  const model = { id: 'beam-free', name: 'Fixture', api: 'openai-completions', provider: 'chainchat-compatible',
    baseUrl: 'http://127.0.0.1:1/compatible/v1', reasoning: false, input: ['text'], contextWindow: 131072, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const result = await adapter.n(model, { systemPrompt: 'Synthetic fixture.', messages: [
    { role: 'user', content: 'Please respond carefully.', timestamp: 1 },
  ], tools: [] }, { apiKey: 'synthetic-local-parser-key', maxTokens: 512 }).result();
  assert.equal(result.stopReason, 'error');
  assert.ok(!(result.content || []).some(block => block.type === 'text' && block.text));
  await assert.rejects(generate({ provider: 'compatible', model: 'beam-free',
    baseUrl: 'https://cyphertempre.ai/api/free-model/v1', apiKey: 'chainchat-free-tier' },
  { messages: [{ role: 'user', content: 'Synthetic reviewer fixture.' }], maxTokens: 512 }),
  error => error.code === 'PROVIDER_INVALID_RESPONSE');
  assert.equal(requests, 2);
});
