// Actual native runtime and default review transport; synthetic provider, no paid calls.
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const application = process.env.CT_CHAINCHAT_PACKAGE || fileURLToPath(new URL('..', import.meta.url));
const runtimePackage = process.env.CT_OPENCLAW_PACKAGE, runtimeNode = process.env.CT_OPENCLAW_NODE;
test('default active chat recovers provider formatting and enforces model limits without weakening review', {
  skip: !runtimePackage || !runtimeNode ? 'Set the pinned native runtime for active-chat reliability acceptance.' : false,
  timeout: 420000,
}, async t => {
const install = { release: application, node: runtimeNode };
const load = file => import(pathToFileURL(path.join(install.release, file)).href);
const [{ createApp }, { DIMENSIONS, FRUITS }, { engine }] = await Promise.all([
  load('server.mjs'), load('lib/providers.mjs'), load('lib/engine.mjs'),
]);
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-active-review-diagnosis-')));
const calls = [], diagnostics = [];
let format = 'bare', providerCap = null, truncatePlanner = false, holdPlanner = false, app, bearer;
const answer = 'Hello! I am Cypher Tempre. I can help you explore ideas carefully and acknowledge uncertainty.';
const plan = JSON.stringify({ queries: ['greeting'], entities: [], shapes: ['narrow'], rings: [], useReplay: false,
  labels: { senses: [], modalities: [] } });
const review = JSON.stringify({ decision: 'approve', usedRings: [],
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
  rationale: 'The introduction uses configured identity and makes no unsupported memory claim.' });
const upstream = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), text = JSON.stringify(body);
  const isReview = text.includes('independent pre-release covenant reviewer');
  const isPlanner = text.includes('Plan retrieval for a local Timechain agent');
  const kind = isReview ? 'review' : isPlanner ? 'planner' : 'answer';
  calls.push({ kind, bytes: Buffer.byteLength(raw), stream: body.stream === true, outputAllowance: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens });
  if (providerCap && kind === 'answer' && (body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens) > providerCap) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Fixture model output cap exceeded', type: 'invalid_request_error' } }));
    return;
  }
  const assessment = JSON.parse(review);
  if (format === 'missing-evidence') delete assessment.usedRings;
  if (format === 'low-score') assessment.fruits.kindness = 179;
  const assessmentText = JSON.stringify(assessment);
  const content = isReview ? (format === 'fenced' ? '```json\n' + assessmentText + '\n```' : assessmentText) : isPlanner ? plan : answer;
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'local-fixture', choices: [{ message: { role: 'assistant', content }, finish_reason: isPlanner && holdPlanner ? 'content_filter' : isPlanner && truncatePlanner ? 'length' : 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta: {}, finish_reason: isPlanner && holdPlanner ? 'content_filter' : isPlanner && truncatePlanner ? 'length' : 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 } })}\n\n`);
  res.end('data: [DONE]\n\n');
});
upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
const results = [];
try {
  app = await createApp({ dataDir: path.join(directory, 'data'), pairingCode: 'ACTIVE-REVIEW-DIAGNOSIS',
    licenseConfig: { mode: 'holdings', required: false },
    openclaw: { stateDir: path.join(directory, 'gateway'),
      packageRoot: runtimePackage, nodePath: install.node,
      pluginPath: path.join(install.release, 'openclaw/plugin'), onDiagnostic: line => diagnostics.push(line) } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (endpoint, body) => {
    const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  bearer = (await call('/api/pair', { code: 'ACTIVE-REVIEW-DIAGNOSIS' })).body.token;
  assert.equal((await call('/api/agents', { name: 'Cypher Tempre' })).status, 201);
  assert.equal((await call('/api/provider', { provider: 'compatible', model: 'fixture-model', apiKey: 'disposable-fixture-key',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` })).status, 200);
  const state = await call('/api/state');
  for (const key of ['learning', 'semanticRecall', 'autoRoute', 'autoSprout']) assert.equal(state.body.cognition[key], true, key);
  for (const scenario of ['active-valid', 'active-fenced-review', 'paused-same-provider', 'active-provider-cap', 'paused-provider-cap', 'active-invalid-evidence', 'active-low-score', 'active-truncated-planner', 'active-provider-policy-hold']) {
    if (scenario === 'active-fenced-review') format = 'fenced';
    if (scenario === 'active-provider-cap') {
      format = 'bare'; providerCap = 4096;
      assert.equal((await call('/api/cognition', { mode: 'active', confirm: true })).status, 200);
    }
    if (scenario === 'active-invalid-evidence' || scenario === 'active-low-score') {
      format = scenario === 'active-invalid-evidence' ? 'missing-evidence' : 'low-score';
      assert.equal((await call('/api/cognition', { mode: 'active', confirm: true })).status, 200);
    }
    if (scenario === 'active-truncated-planner') { format = 'bare'; truncatePlanner = true; }
    if (scenario === 'active-provider-policy-hold') { format = 'bare'; truncatePlanner = false; holdPlanner = true; }
    if (scenario.startsWith('paused-')) assert.equal((await call('/api/cognition', { mode: 'dormant', confirm: true })).status, 200);
    const start = calls.length, response = await call('/api/chat', { message: 'Please introduce yourself' });
    const result = { scenario, status: response.status, code: response.body.code ?? null, stage: response.body.stage ?? null,
      error: response.body.error ?? null, mode: response.body.message?.mode ?? null,
      answerReleased: typeof response.body.message?.content === 'string', calls: calls.slice(start) };
    results.push(result); t.diagnostic(JSON.stringify(result));
  }
  assert.equal(results[0].status, 200);
  assert.equal(results[1].status, 200);
  assert.equal(results[1].answerReleased, true);
  assert.equal(results[2].status, 200);
  assert.equal(results[3].status, 200);
  assert.ok(results[3].calls.every(call => call.outputAllowance <= 4096));
  assert.equal(results[4].status, 200);
  assert.equal(results[5].status, 422); assert.equal(results[5].code, 'GATE_INVALID_EVIDENCE');
  assert.equal(results[5].stage, 'review');
  assert.equal(results[5].answerReleased, false);
  assert.equal(results[6].status, 422); assert.equal(results[6].code, 'COVENANT_REJECTED');
  assert.equal(results[6].answerReleased, false);
  assert.equal(results[6].calls.filter(call => call.kind === 'review').length,
    results[6].calls.filter(call => call.kind === 'answer').length,
    'A complete low assessment is not retried without a newly generated candidate.');
  assert.equal(results[7].status, 200, 'An incomplete optional planner must fall back to verified native retrieval.');
  assert.equal(results[7].answerReleased, true);
  assert.ok(results[7].calls.some(call => call.kind === 'planner'));
  assert.equal(results[8].status, 422); assert.equal(results[8].code, 'PROVIDER_CONTENT_HELD');
  assert.equal(results[8].stage, 'memory-planning');
  assert.equal(results[8].answerReleased, false);
  assert.ok(results[8].calls.every(call => call.kind === 'planner'), 'Provider policy holds cannot use the optional planner fallback.');
  const selected = app.store.agents[0];
  assert.equal((await engine({ op: 'verify', root: selected.root })).verified, true);
} finally {
  await app?.closeRuntime();
  if (app?.server.listening) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('ct-active-review-diagnosis-'));
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
}

});
