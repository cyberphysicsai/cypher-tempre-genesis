import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { controlSessionKey } from '../lib/openclaw-controls.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';
import { nativeCompactionSnapshot } from './fixtures/native-compaction-snapshot.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('a failed mandatory native context factory cannot select fallback or persist an unreviewed summary', {
  skip: !packageRoot || !nodePath ? 'Set pinned runtime paths for genuine legacy-fallback containment acceptance.' : false,
  timeout: 300000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-lcmp-'))), root = path.join(directory, 'chain'), stateDir = path.join(directory, 'native');
  const pluginPath = path.join(directory, 'fixture-plugin');
  await fs.cp(fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), pluginPath, { recursive: true });
  const compactionFile = path.join(pluginPath, 'compaction.mjs'), source = await fs.readFile(compactionFile, 'utf8');
  const factoryStart = 'export function createReviewedContextEngine({ sdk, request, workspaceDir, commitStore, targetRegistry } = {}) {';
  const broken = source.replace(factoryStart, factoryStart + "\n  console.error('CHAINCHAT_FIXTURE_CONTEXT_FACTORY_FAILURE');\n  throw new Error('Disposable context-engine factory failure');");
  assert.notEqual(source, broken, 'The disposable fixture must actually force native context-factory fallback.');
  await engine({ op: 'init', root, name: 'LegacyContainmentFixture' });
  const inspected = await engine({ op: 'inspect', root, learning: false }), identity = { agentId: 'legacy-fixture', genesisHash: inspected.genesis.hash };
  const sessionKey = controlSessionKey(identity), diagnostics = [], phases = [], nativeReviews = [], providerBytes = [], brokerCalls = [], activity = [], lifecycle = [], seedUsage = [];
  let calls = 0, reviewCalls = 0, nativeObserver;
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    calls++; providerBytes.push(Buffer.byteLength(raw)); assert.equal(raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'), false);
    const promptTokens = Math.ceil(Buffer.byteLength(raw) / 4);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
      delta: { role: 'assistant', content: 'Hello.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: promptTokens, completion_tokens: 2, total_tokens: promptTokens + 2 } })}\n\ndata: [DONE]\n\n`);
  }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const config = { provider: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic-legacy-fixture-key' };
  const verdictMetadata = verdict => verdict ? Object.fromEntries(['decision', 'brightness', 'grounding', 'assertiveness', 'effort', 'low_effort']
    .filter(key => verdict[key] !== undefined).map(key => [key, verdict[key]])) : undefined;
  const broker = createPoIBroker({ engine: async request => {
    try {
      const result = await engine(request);
      if (['prepare', 'evaluate', 'evaluate_summary'].includes(request.op)) nativeReviews.push({ op: request.op,
        accepted: result.accepted, blocked: result.screening?.blocked, verdict: verdictMetadata(result.verdict) });
      return result;
    } catch (error) {
      nativeReviews.push({ op: request.op, code: error.code, verdict: verdictMetadata(error.nativeVerdict) }); throw error;
    }
  }, review: async () => { reviewCalls++; return { approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
    fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), usedRings: [], rationale: 'The synthetic greeting is consistent with its explicit fixture request.' }; } });
  await broker.start();
  // Observe only protocol metadata. Forward exact private bytes without logging
  // credentials, prompts, candidate text or the native route capability.
  const relay = http.createServer(async (request, response) => {
    try {
      const parts = []; let size = 0;
      for await (const part of request) { size += part.length; if (size > 8 * 1024 * 1024) throw new Error('Fixture relay bound.'); parts.push(part); }
      const raw = Buffer.concat(parts), payload = JSON.parse(raw), startedAt = Date.now();
      const result = await fetch(broker.url, { method: 'POST', redirect: 'error', headers: {
        authorization: String(request.headers.authorization || ''), 'content-type': 'application/json' }, body: raw });
      const body = Buffer.from(await result.arrayBuffer()), parsed = JSON.parse(body);
      const withheld = payload.op === 'control_outgoing' && typeof payload.candidate === 'string' ? payload.candidate : null;
      brokerCalls.push({ at: Date.now(), op: /^[a-z_]{1,40}$/.test(payload.op) ? payload.op : 'unknown', status: result.status,
        allowed: parsed.allowed, code: parsed.code ?? parsed.error?.code, durationMs: Date.now() - startedAt,
        run: typeof payload.runId === 'string' ? createHash('sha256').update(payload.runId).digest('hex').slice(0, 12) : null,
        bindingMatches: parsed.binding ? parsed.binding.sessionKey === payload.sessionKey && parsed.binding.runId === payload.runId : null,
        ...(withheld ? { withheldBytes: Buffer.byteLength(withheld), withheldSha256: createHash('sha256').update(withheld).digest('hex'),
          nativeReasonFlags: { preflightCompaction: withheld.includes('This conversation is too long, and'),
            database: /database|sqlite/i.test(withheld), workspace: /workspace/i.test(withheld),
            modelOrAuthentication: /unknown model|model.{0,40}not (?:found|allowed)|api key|authentication|auth profile/i.test(withheld),
            session: /session|writer|generation/i.test(withheld), context: /context|token|too (?:long|large)/i.test(withheld) } } : {}) });
      response.writeHead(result.status, { 'content-type': 'application/json' }); response.end(body);
    } catch { brokerCalls.push({ op: 'relay_error', status: 502 }); response.writeHead(502); response.end(); }
  }); relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const observedBroker = Object.create(broker);
  Object.defineProperty(observedBroker, 'url', { value: `http://127.0.0.1:${relay.address().port}/v1/enforce` });
  const patch = { logging: { level: 'warn', consoleLevel: 'warn' } }, revision = createHash('sha256').update(JSON.stringify(patch)).digest('hex');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(stateDir, 'controls.json'), JSON.stringify({ version: 1, revision, patch }), { mode: 0o600 });
  const create = modelContextTokens => {
    const instance = createOpenClawGateway({ stateDir, packageRoot, nodePath, pluginPath, broker: observedBroker, modelContextTokens, onDiagnostic: line => diagnostics.push(line) });
    const events = instance.registerNativeService({ id: 'fixture-events', methods: { 'sessions.describe': params => {
      assert.equal(params.key, sessionKey); return { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false };
    } }, events: ['chat', 'agent'] });
    nativeObserver = events;
    const label = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) ? value : undefined;
    events.subscribe(event => {
      const payload = event.payload || {}, data = payload.data || {};
      if (payload.sessionKey && payload.sessionKey !== sessionKey) return;
      const textBytes = value => typeof value === 'string' ? Buffer.byteLength(value) : null;
      lifecycle.push({ at: Date.now(), event: event.event, state: label(payload.state), stream: label(payload.stream),
        phase: label(data.phase), completionSource: label(data.completionSource), stopReason: label(payload.stopReason ?? data.stopReason),
        errorKind: label(payload.errorKind ?? data.errorKind), messagePresent: !!payload.message,
        contentBytes: textBytes(typeof payload.message?.content === 'string' ? payload.message.content :
          Array.isArray(payload.message?.content) ? payload.message.content.filter(item => item?.type === 'text').map(item => item.text).join('\n') : null),
        deltaBytes: textBytes(payload.deltaText), run: typeof payload.runId === 'string' ? createHash('sha256').update(payload.runId).digest('hex').slice(0, 12) : null });
      if (lifecycle.length > 96) lifecycle.shift();
    });
    return instance;
  };
  let manager = create();
  t.after(async () => { await manager.close(); relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve));
    await broker.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    assert.ok(path.resolve(directory).startsWith(await fs.realpath(os.tmpdir()) + path.sep)); assert.ok(path.basename(directory).startsWith('ct-lcmp-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }); });
  const run = input => manager.generate(config, { messages: [{ role: 'user', content: input }], maxTokens: 128,
      nativeControl: { kind: 'message', sessionKey } }, { root, input, nativeIdentity: identity, purpose: 'candidate', loadout: [], learning: false, authorize: async () => {},
        event: (ability, status, label) => { activity.push({ ability, status, label: String(label).slice(0, 160) }); } });
  try {
    let seed = 0;
    // Establish a native conversation before adding its large older turn. This
    // fixture tests fallback over existing history, not a fresh oversized input.
    for (const input of ['Please say hello.', 'Please say hello.\n' + 'source-padding '.repeat(18000), 'Please say hello.', 'Please say hello.']) {
      phases.push(`seed-${++seed}:started`); assert.equal((await run(input)).text, 'Hello.'); phases.push(`seed-${seed}:accepted`);
      const nativeSession = (await nativeObserver.request('sessions.describe', { key: sessionKey })).session || {};
      seedUsage.push({ seed, totalTokensFresh: nativeSession.totalTokensFresh ?? null,
        ...Object.fromEntries(['totalTokens', 'inputTokens', 'outputTokens', 'contextTokens', 'compactionCount'].filter(key => nativeSession[key] !== undefined).map(key => [key, nativeSession[key]])) });
    }
    const head = (await engine({ op: 'inspect', root, learning: false })).head;
    const persistedBefore = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
    phases.push('seed-sqlite-read');
    await manager.close();
    await fs.writeFile(compactionFile, broken);
    const indexFile = path.join(pluginPath, 'index.mjs'), indexSource = await fs.readFile(indexFile, 'utf8');
    const withDiagnostic = indexSource.replace('export function register(api) {', `export function register(api) {
      api.on('model_call_started', event => { if (String(event.runId).includes(':compaction:')) console.error('CHAINCHAT_FIXTURE_NATIVE_COMPACTION_CALL'); });`);
    assert.notEqual(withDiagnostic, indexSource); await fs.writeFile(indexFile, withDiagnostic);
    manager = create(48000); const beforeCalls = calls;
    phases.push('forced-fallback:started');
    let rejection;
    await assert.rejects(run('Please say hello.'), error => { rejection = { code: error.code, message: error.message }; return error.code === 'OPENCLAW_ENFORCEMENT_UNHEALTHY'; }, 'A failed mandatory engine must stop before native fallback or model inference.');
    phases.push('forced-fallback:held');
    assert.equal(diagnostics.some(line => /degraded to "legacy"|falling back to default engine "legacy"/.test(line)), false,
      `A caught mandatory factory failure must never reach native fallback: ${JSON.stringify(rejection)}`);
    assert.ok(diagnostics.some(line => line.includes('CHAINCHAT_FIXTURE_CONTEXT_FACTORY_FAILURE')), 'The configured disposable context factory must actually fail.');
    assert.equal(diagnostics.some(line => line.includes('CHAINCHAT_FIXTURE_NATIVE_COMPACTION_CALL')), false, 'The failed factory must hold before any native summary inference.');
    assert.equal(calls, beforeCalls, 'The private route capability must stop legacy summary egress before any provider inference.');
    assert.equal(manager.status().running, false, 'Missing admission terminates the exact owned native child before the failed call settles.');
    const persistedAfterFailure = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
    assert.deepEqual(persistedAfterFailure.compactions, persistedBefore.compactions,
      'Direct read-only SQLite inspection must find no fallback summary after native child termination.');
    await assert.rejects(run('Please say hello. Verify the owned-runtime restart remains held.'), error => error.code === 'OPENCLAW_ENFORCEMENT_UNHEALTHY',
      'The faulty mandatory factory remains held after an owned-runtime restart.');
    const afterRestart = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
    assert.deepEqual(afterRestart.compactions, persistedBefore.compactions,
      'Restarting the owned runtime must not recover or publish a delayed fallback compaction.');
    assert.deepEqual(afterRestart.sourceEvents, persistedBefore.sourceEvents, 'Factory failure never changes prior native conversation event bytes.');
    assert.deepEqual((await engine({ op: 'inspect', root, learning: false })).head, head);
  } catch (error) {
    let persistedFailure;
    try {
      const snapshot = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
      persistedFailure = { eventCount: snapshot.eventCount, compactions: snapshot.compactions.map(entry => ({ id: entry.id,
        summaryBytes: Buffer.byteLength(entry.summary || ''), summarySha256: createHash('sha256').update(entry.summary || '').digest('hex'),
        reviewed: entry.details?.reviewed === true, kind: entry.details?.kind || null })) };
    } catch (inspectionError) { persistedFailure = { unavailable: inspectionError.code || 'FIXTURE_SNAPSHOT_UNAVAILABLE' }; }
    throw new Error(`${error.message}\nNative fallback metadata: ${JSON.stringify({ phases, calls, providerBytes: providerBytes.slice(-12), reviewCalls,
      nativeReviews: nativeReviews.slice(-24), brokerCalls: brokerCalls.slice(-48), activity: activity.slice(-24), lifecycle, seedUsage, persistedFailure })}\nNative fallback diagnostics:\n${diagnostics.join('').slice(-8000)}`, { cause: error });
  }
});
