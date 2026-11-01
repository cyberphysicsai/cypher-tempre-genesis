import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { controlSessionKey } from '../lib/openclaw-controls.mjs';
import { DIMENSIONS, FRUITS } from '../lib/providers.mjs';
import { nativeCompactionSnapshot } from './fixtures/native-compaction-snapshot.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('real native compaction persists only an exact PoI-approved summary and preserves the Timechain', {
  skip: !packageRoot || !nodePath ? 'Set pinned native runtime paths to exercise actual SQLite compaction.' : false,
  timeout: 480000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-cmp-')));
  const root = path.join(directory, 'chain'), stateDir = path.join(directory, 'native');
  const pluginPath = path.join(directory, 'fixture-plugin');
  await fs.cp(fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), pluginPath, { recursive: true });
  const indexFile = path.join(pluginPath, 'index.mjs'), indexSource = await fs.readFile(indexFile, 'utf8');
  const targetFixture = indexSource.replace('export function register(api) {', `export function register(api) {
    api.registerGatewayMethod('chainchat.fixtureSessionTarget', async ({ params, respond }) => {
      if (!params || Object.keys(params).length !== 2 ||
          !/^agent:main:chainchat-control:[a-f0-9]{64}$/.test(params.sessionKey || '') ||
          typeof params.sessionId !== 'string' || !params.sessionId || params.sessionId.length > 512)
        throw new Error('Invalid disposable fixture target.');
      const key = createHash('sha256').update(params.sessionKey + '\\0' + params.sessionId).digest('hex');
      const target = await api.runtime.state.openKeyedStore({ namespace: 'chainchat-native-compaction-targets', retention: 'retained' }).lookup(key);
      if (!target || target.sessionKey !== params.sessionKey || target.sessionId !== params.sessionId || target.agentId !== 'main')
        throw new Error('Missing disposable fixture target.');
      respond(true, target);
    }, { scope: 'operator.admin', profileAccess: 'independent' });`);
  assert.notEqual(targetFixture, indexSource); await fs.writeFile(indexFile, targetFixture);
  const fixtures = path.join(directory, 'fixtures'), readFile = path.join(fixtures, 'approved.txt');
  await fs.mkdir(fixtures); await fs.writeFile(readFile, 'Fixture: blue.');
  await engine({ op: 'init', root, name: 'NativeCompactionFixture' });
  const inspected = await engine({ op: 'inspect', root, learning: false });
  const identity = { agentId: 'compaction-fixture', genesisHash: inspected.genesis.hash }, sessionKey = controlSessionKey(identity);
  const answer = 'Hello. I can help with care and honesty.';
  const summary = 'The user asked the assistant to say hello. The assistant replied: "Hello. I can help with care and honesty."';
  const toolSummary = 'The read tool returned "Fixture: blue." The assistant replied: "Hello. I can help with care and honesty."';
  let lowFruit = false, issuedRead = false; const summaries = [], diagnostics = [], phases = [], verdicts = [];
  const upstream = http.createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    assert.equal(raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'), false, 'The private native route capability must never reach the model.');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const messages = JSON.parse(raw).messages || [], lastUser = messages.findLast(message => message.role === 'user');
    const useRead = !issuedRead && JSON.stringify(lastUser?.content || '').includes('CT_REAL_TOOL_PAIR');
    if (useRead) issuedRead = true;
    const delta = useRead ? { role: 'assistant', tool_calls: [{ index: 0, id: 'compaction_fixture_read', type: 'function',
      function: { name: 'read', arguments: JSON.stringify({ path: readFile }) } }] } : { role: 'assistant', content: answer };
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: useRead ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\ndata: [DONE]\n\n`);
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const config = { provider: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'synthetic-compaction-key' };
  const broker = createPoIBroker({ engine: async request => {
    try { const result = await engine(request); if (request.op === 'evaluate_summary') verdicts.push({ accepted: result.accepted, verdict: result.verdict }); return result; }
    catch (error) { if (request.op === 'evaluate_summary') verdicts.push({ code: error.code, verdict: error.nativeVerdict }); throw error; }
  },
    generateSummary: async (_config, args) => { summaries.push(args); return { text: args.sourceMessages.some(message => message.role === 'toolResult') ? toolSummary : summary }; },
    review: async () => ({ approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
      fruitages: Object.fromEntries(FRUITS.map(key => [key, lowFruit ? 20 : 240])), usedRings: [],
      rationale: 'Synthetic local fixture summary preserves the exact observed greeting and its user request.' }) });
  await broker.start();
  const create = modelContextTokens => createOpenClawGateway({ stateDir, packageRoot, nodePath, broker, modelContextTokens,
    pluginPath,
    onDiagnostic: line => diagnostics.push(line) });
  let manager = create();
  const registerHistory = () => manager.registerNativeService({ id: 'fixture-history', methods: { 'chat.history': params => {
    assert.equal(params.sessionKey, sessionKey); return { sessionKey, limit: 100 };
  }, 'chainchat.fixtureSessionTarget': params => {
    assert.equal(params.sessionKey, sessionKey); assert.equal(typeof params.sessionId, 'string');
    return { sessionKey, sessionId: params.sessionId };
  } } });
  let history = registerHistory();
  t.after(async () => {
    await manager.close(); await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(directory).startsWith(await fs.realpath(os.tmpdir()) + path.sep)); assert.ok(path.basename(directory).startsWith('ct-cmp-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  const context = input => ({ root, input, purpose: 'candidate', learning: false, loadout: [], nativeIdentity: identity,
    toolAuthority: { enabled: true, acknowledged: true, tools: ['read'], roots: [fixtures], networkHosts: [], allowExecution: false },
    authorize: async () => {} });
  try {
    for (let index = 0; index < 3; index++) {
      const input = index === 1 ? `CT_REAL_TOOL_PAIR: read the approved local fixture ${readFile} and please say hello.` : 'Please say hello.';
      const generated = await manager.generate(config, { messages: [{ role: 'user', content: input }], maxTokens: 128,
        nativeControl: { kind: 'message', sessionKey } }, context(input));
      assert.equal(generated.text, answer);
      phases.push(`greeting-${index + 1}`);
    }
    const head = (await engine({ op: 'inspect', root, learning: false })).head;
    const before = (await history.request('chat.history', { sessionKey })).messages;
    const persistedBefore = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
    phases.push('baseline-sqlite-read');
    lowFruit = true;
    const rejected = await manager.compact(config, { identity, instructions: 'Preserve the greeting exactly.' }, context('Compact the native conversation.'));
    phases.push(`rejected-manual:${rejected.compacted}`);
    assert.equal(rejected.compacted, false, JSON.stringify(rejected));
    assert.deepEqual((await history.request('chat.history', { sessionKey })).messages, before, 'A denied summary must never change native transcript context.');
    assert.deepEqual((await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey })).compactions, persistedBefore.compactions,
      'Rejected review never appends a compaction event to the actual SQLite transcript.');
    lowFruit = false;
    const accepted = await manager.compact(config, { identity, instructions: 'Preserve the greeting exactly.' }, context('Compact the native conversation.'));
    phases.push(`accepted-manual:${accepted.compacted}`);
    assert.equal(accepted.compacted, true, JSON.stringify(accepted));
    assert.equal(accepted.result.summary, summary);
    assert.equal(accepted.result.details.reviewed, true);
    const persistedAccepted = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey });
    assert.equal(persistedAccepted.compactions.length, persistedBefore.compactions.length + 1);
    assert.equal(persistedAccepted.compactions.at(-1).summary, summary);
    assert.equal(persistedAccepted.compactions.at(-1).details.reviewed, true);
    assert.ok(persistedAccepted.compactions.at(-1).retainedUserTurns >= 2);
    assert.ok(persistedAccepted.compactions.at(-1).retainedAssistantMessages >= 2);
    assert.ok(persistedAccepted.compactions.at(-1).retainedToolCalls.length > 0, 'The retained recent turn must contain the real native read call.');
    assert.deepEqual(persistedAccepted.compactions.at(-1).retainedToolCalls, persistedAccepted.compactions.at(-1).retainedToolResults);
    assert.ok(summaries.length >= 2); assert.ok(summaries.every(item => item.instructions.includes('greeting')));
    assert.deepEqual((await engine({ op: 'inspect', root, learning: false })).head, head, 'Compaction does not append a fake user exchange to the Timechain.');
    const settings = JSON.stringify(await manager.describeControls(identity));
    assert.equal(settings.includes(config.apiKey), false); assert.equal(settings.includes(broker.token), false);
    // Native pressure must call our engine rather than silently degrading to
    // legacy compaction. One large old turn can be summarized while both recent
    // complete turns and the pending request remain intact.
    for (const input of ['Please say hello.\n' + 'source-padding '.repeat(18000), 'Please say hello.', 'Please say hello.']) {
      assert.equal((await manager.generate(config, { messages: [{ role: 'user', content: input }], maxTokens: 128,
        nativeControl: { kind: 'message', sessionKey } }, context(input))).text, answer);
    }
    await manager.close(); manager = create(48000); history = registerHistory();
    const automaticBefore = summaries.length, pendingMarker = 'CT_PENDING_ONLY_CURRENT_BOUNDARY', finalInput = `Please say hello. ${pendingMarker}`;
    assert.equal((await manager.generate(config, { messages: [{ role: 'user', content: finalInput }], maxTokens: 128,
      nativeControl: { kind: 'message', sessionKey } }, context(finalInput))).text, answer);
    assert.ok(summaries.length > automaticBefore, 'Normal native chat must trigger reviewed automatic compaction under context pressure.');
    assert.ok(summaries.slice(automaticBefore).every(item => !JSON.stringify(item.sourceMessages).includes(pendingMarker)),
      'The current admitted user input must remain outside every compaction summary source.');
    const currentSessionId = (await manager.sessionControls(identity)).session.sessionId;
    const sessionTarget = await history.request('chainchat.fixtureSessionTarget', { sessionKey, sessionId: currentSessionId });
    const persistedAutomatic = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey, packageRoot, sessionTarget });
    assert.ok(persistedAutomatic.compactions.length > persistedAccepted.compactions.length, 'Automatic pressure must persist a real reviewed SQLite compaction entry.');
    assert.ok(persistedAutomatic.compactions.every(item => [summary, toolSummary].includes(item.summary) && item.details.reviewed === true));
    assert.ok(summaries.slice(automaticBefore).some(item => item.sourceMessages.some(message => message.role === 'toolResult')),
      'The actual automatic summary source must preserve the older native tool/result record.');
    assert.ok(persistedAutomatic.recentUserInputs.some(input => input.includes(pendingMarker)), 'The admitted current input must survive native compaction and accepted append.');
    assert.equal(persistedAutomatic.sdk.modelViewContainsLatestSummary, true,
      'The new summary must remain on the actual current SDK branch after the next assistant append: ' + JSON.stringify(persistedAutomatic.sdk));
    assert.equal(persistedAutomatic.sdk.modelViewHasOldSourcePadding, false, 'The old summarized source must not remain in the effective native model view.');
    assert.equal(persistedAutomatic.sdk.modelViewHasPendingMarker, true);
    for (const prior of persistedBefore.sourceEvents) assert.deepEqual(persistedAutomatic.sourceEvents.find(item => item.sessionId === prior.sessionId && item.seq === prior.seq), prior,
      'Compaction appends an approved boundary without rewriting historical transcript event bytes.');
    const nextInput = 'Please say hello. Follow-up after reviewed compaction.';
    assert.equal((await manager.generate(config, { messages: [{ role: 'user', content: nextInput }], maxTokens: 128,
      nativeControl: { kind: 'message', sessionKey } }, context(nextInput))).text, answer, 'A later accepted native turn must append without a stale-parent fork.');
    const afterFollowup = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey, packageRoot, sessionTarget });
    assert.equal(afterFollowup.sdk.modelViewContainsLatestSummary, true);
    assert.equal(afterFollowup.sdk.modelViewHasOldSourcePadding, false);
    assert.equal(diagnostics.some(line => /degraded to "legacy"|context-engine.*quarantin/i.test(line)), false,
      'The managed context engine must satisfy native admitted-turn fencing without a legacy fallback.');
    assert.deepEqual((await engine({ op: 'inspect', root, learning: false })).head, head);
  } catch (error) {
    let persisted;
    try { const view = await nativeCompactionSnapshot({ nodePath, stateDir, sessionKey }); persisted = { compactions: view.compactions.length, recentUserInputs: view.recentUserInputs }; } catch {}
    throw new Error(`${error.message}\nNative fixture phases: ${phases.join(', ')}; summary calls: ${summaries.length}\nNative summary verdicts: ${JSON.stringify(verdicts)}\nNative persisted summary state: ${JSON.stringify(persisted)}\nNative fixture diagnostics:\n${diagnostics.join('').slice(-6000)}`, { cause: error });
  }
});
