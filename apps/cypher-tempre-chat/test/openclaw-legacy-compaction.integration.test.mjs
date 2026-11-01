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
test('forced native legacy fallback cannot obtain a model lease or persist an unreviewed summary', {
  skip: !packageRoot || !nodePath ? 'Set pinned runtime paths for genuine legacy-fallback containment acceptance.' : false,
  timeout: 300000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-lcmp-'))), root = path.join(directory, 'chain'), stateDir = path.join(directory, 'native');
  const pluginPath = path.join(directory, 'fixture-plugin');
  await fs.cp(fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), pluginPath, { recursive: true });
  const compactionFile = path.join(pluginPath, 'compaction.mjs'), source = await fs.readFile(compactionFile, 'utf8');
  const broken = source.replace("  if (typeof sdk?.SessionManager", "  console.error('CHAINCHAT_FIXTURE_CONTEXT_FACTORY_FAILURE');\n  throw new Error('Disposable context-engine factory failure');\n  if (typeof sdk?.SessionManager");
  assert.notEqual(source, broken, 'The disposable fixture must actually force native context-factory fallback.');
  await engine({ op: 'init', root, name: 'LegacyContainmentFixture' });
  const inspected = await engine({ op: 'inspect', root, learning: false }), identity = { agentId: 'legacy-fixture', genesisHash: inspected.genesis.hash };
  const sessionKey = controlSessionKey(identity), diagnostics = []; let calls = 0;
  const provider = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    calls++; assert.equal(raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'), false);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0,
      delta: { role: 'assistant', content: 'Hello.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  }); provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const config = { provider: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic-legacy-fixture-key' };
  const broker = createPoIBroker({ engine, review: async () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
    fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), usedRings: [], rationale: 'The synthetic greeting is consistent with its explicit fixture request.' }) });
  await broker.start();
  const create = modelContextTokens => createOpenClawGateway({ stateDir, packageRoot, nodePath, pluginPath, broker, modelContextTokens, onDiagnostic: line => diagnostics.push(line) });
  let manager = create();
  t.after(async () => { await manager.close(); await broker.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    assert.ok(path.resolve(directory).startsWith(await fs.realpath(os.tmpdir()) + path.sep)); assert.ok(path.basename(directory).startsWith('ct-lcmp-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }); });
  const run = input => manager.generate(config, { messages: [{ role: 'user', content: input }], maxTokens: 128,
    nativeControl: { kind: 'message', sessionKey } }, { root, input, nativeIdentity: identity, purpose: 'candidate', loadout: [], learning: false, authorize: async () => {} });
  try {
    for (const input of ['Please say hello.\n' + 'source-padding '.repeat(18000), 'Please say hello.', 'Please say hello.']) assert.equal((await run(input)).text, 'Hello.');
    const before = await manager.sessionControls(identity), head = (await engine({ op: 'inspect', root, learning: false })).head;
    const persistedBefore = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
    await manager.close();
    await fs.writeFile(compactionFile, broken);
    const indexFile = path.join(pluginPath, 'index.mjs'), indexSource = await fs.readFile(indexFile, 'utf8');
    const withDiagnostic = indexSource.replace('export function register(api) {', `export function register(api) {
      api.on('model_call_started', event => { if (String(event.runId).includes(':compaction:')) console.error('CHAINCHAT_FIXTURE_NATIVE_COMPACTION_CALL'); });`);
    assert.notEqual(withDiagnostic, indexSource); await fs.writeFile(indexFile, withDiagnostic);
    const patch = { logging: { level: 'warn', consoleLevel: 'warn' } }, revision = createHash('sha256').update(JSON.stringify(patch)).digest('hex');
    await fs.writeFile(path.join(stateDir, 'controls.json'), JSON.stringify({ version: 1, revision, patch }), { mode: 0o600 });
    manager = create(48000); const beforeCalls = calls;
    let rejection;
    await assert.rejects(run('Please say hello.'), error => { rejection = { code: error.code, message: error.message }; return true; }, 'A fallback summarizer must not be allowed to obtain an upstream model result.');
    assert.ok(diagnostics.some(line => /degraded to "legacy"|falling back to default engine "legacy"/.test(line)), `The native fixture must truly exercise legacy fallback: ${JSON.stringify(rejection)}`);
    assert.ok(diagnostics.some(line => line.includes('CHAINCHAT_FIXTURE_CONTEXT_FACTORY_FAILURE')), 'The configured disposable context factory must actually fail.');
    assert.ok(diagnostics.some(line => line.includes('CHAINCHAT_FIXTURE_NATIVE_COMPACTION_CALL')), 'Native overflow/preflight must actually enter legacy summary inference.');
    assert.equal(calls, beforeCalls, 'The private route capability must stop legacy summary egress before any provider inference.');
    assert.equal(manager.status().running, false, 'Missing admission terminates the exact owned native child before the failed call settles.');
    const persistedAfterFailure = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
    assert.deepEqual(persistedAfterFailure.compactions, persistedBefore.compactions,
      'Direct read-only SQLite inspection must find no fallback summary after native child termination.');
    const after = await manager.sessionControls(identity);
    assert.equal(after.session.compactionCount || 0, before.session.compactionCount || 0, 'Denied legacy compaction must not be persisted.');
    assert.deepEqual((await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey })).compactions, persistedBefore.compactions,
      'Restarting the owned runtime must not recover or publish a delayed fallback compaction.');
    assert.deepEqual((await engine({ op: 'inspect', root, learning: false })).head, head);
  } catch (error) { throw new Error(`${error.message}\nNative fallback diagnostics:\n${diagnostics.join('').slice(-8000)}`, { cause: error }); }
});
