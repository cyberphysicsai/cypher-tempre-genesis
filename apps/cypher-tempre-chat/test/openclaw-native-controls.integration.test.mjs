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
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('real native goals, settings, scoped tools and durable app restarts retain enforcement and key isolation', {
  skip: !packageRoot || !nodePath ? 'Set CT_OPENCLAW_PACKAGE and CT_OPENCLAW_NODE for pinned native acceptance.' : false,
  timeout: 480000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-control-test-'));
  const root = path.join(directory, 'chain'), managed = path.join(directory, 'managed'), files = path.join(directory, 'granted');
  await fs.mkdir(files); const readFile = path.join(files, 'approved.txt'), ungrantedWrite = path.join(files, 'never-written.txt');
  await fs.writeFile(readFile, 'approved-native-file-content');
  await engine({ op: 'init', root, name: 'NativeControlFixture' });
  const inspected = await engine({ op: 'inspect', root, learning: false });
  const identity = { agentId: 'native-test', genesisHash: inspected.genesis.hash };
  const answer = "Hello! I'm NativeControlFixture. I can help with care, patience and honesty.";
  let toolPlan = null, toolReturned = false, lowFruit = false, reasoningCapable = false;
  const requests = [], events = [], reviews = [], diagnostics = [];
  const upstream = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push({ body, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = delta => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    if (toolPlan && !toolReturned) {
      toolReturned = true;
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'tool-fixture-' + requests.length, type: 'function',
        function: { name: toolPlan.name, arguments: JSON.stringify(toolPlan.params) } }] });
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
    } else {
      chunk({ role: 'assistant', content: answer });
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const makeBroker = () => createPoIBroker({ engine, review: async (_config, args) => {
    reviews.push(args.candidate);
    const action = args.candidate.includes('proposed-host-tool-action');
    return { approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
      fruitages: Object.fromEntries(FRUITS.map(key => [key, action && lowFruit ? 20 : 240])), usedRings: [],
      rationale: 'Supported fixture identity, exact scoped local action and covenant-compatible answer.' };
  } });
  let broker = makeBroker(); await broker.start();
  const makeManager = () => createOpenClawGateway({ stateDir: managed, packageRoot, nodePath,
    pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), broker, startupTimeoutMs: 180000,
    onDiagnostic: line => diagnostics.push(line) });
  let manager = makeManager();
  const config = key => ({ provider: 'compatible', model: 'fixture-model', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: key });
  const nativeContext = input => ({ root, input, loadout: [], learning: false, purpose: 'candidate', nativeIdentity: identity,
    modelCapabilities: { reasoning: reasoningCapable },
    event: (ability, status, label) => events.push({ ability, status, label }) });
  async function generate(input, nativeControl, grant) {
    return manager.generate(config('isolated-fixture-provider-key'), { messages: [{ role: 'user', content: input }], maxTokens: 512,
      ...(nativeControl ? { nativeControl } : {}) }, { ...nativeContext(input), ...(grant ? { toolAuthority: grant } : {}) });
  }
  t.after(async () => {
    await manager.close(); await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith('ct-native-control-test-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  try {
    let state = await manager.describeControls(identity);
    assert.ok(state.schema.schema); assert.equal(state.session, null);
    const plan = await manager.executeCommand({ ...identity, command: '/goal start Please introduce yourself' });
    assert.equal((await generate(plan.message, plan.native)).text, answer);
    state = await manager.sessionControls(identity);
    const goalId = state.goal.id;
    assert.equal(state.goal.status, 'active');
    await manager.executeCommand({ ...identity, command: '/goal pause Operator pause' });
    await manager.executeCommand({ ...identity, command: '/verbose full' });
    assert.equal((await manager.sessionControls(identity)).session.verboseLevel, 'full');
    assert.equal((await generate('Please introduce yourself again', { kind: 'message', sessionKey: state.sessionKey })).text, answer);
    const beforeControl = requests.length;
    const queue = await manager.executeCommand({ ...identity, command: '/queue collect debounce:0.5s cap:25 drop:summarize' });
    assert.match(queue.text, /collect/i);
    const contextReport = await manager.executeCommand({ ...identity, command: '/context json' });
    assert.ok(contextReport.text.length > 20); assert.equal(requests.length, beforeControl, 'Deterministic controls must never call a provider.');
    await manager.executeCommand({ ...identity, command: '/think high', modelCapabilities: { reasoning: true } });
    reasoningCapable = true;
    const beforeEffort = requests.length;
    assert.equal((await generate('Please introduce yourself with the selected native effort', { kind: 'message', sessionKey: state.sessionKey })).text, answer);
    assert.ok(requests.slice(beforeEffort).some(request => request.body.reasoning_effort === 'high' || request.body.reasoning?.effort === 'high'),
      'A reasoning-capable connected route must actually receive the selected effort.');
    const nativeSettings = await manager.describeControls(identity);
    const updated = await manager.updateControls({ patch: { messages: { queue: { cap: 17 } } }, revision: nativeSettings.config.revision });
    assert.equal(updated.config.editable.messages.queue.cap, 17);
    assert.equal((await manager.sessionControls(identity)).goal.id, goalId);
    const privateTransport = JSON.parse(await fs.readFile(path.join(managed, 'transport-identity.json'), 'utf8'));
    const publicState = JSON.stringify(await manager.describeControls(identity));
    for (const privateValue of [privateTransport.proxyToken, privateTransport.gatewayToken, broker.token, 'isolated-fixture-provider-key'])
      assert.equal(publicState.includes(privateValue), false, 'Operator/provider credentials must not reach settings responses.');
    await manager.close(); const previousBrokerToken = broker.token; await broker.close();
    broker = makeBroker(); await broker.start(); assert.notEqual(broker.token, previousBrokerToken);
    manager = makeManager();
    state = await manager.sessionControls(identity);
    assert.equal(state.goal.id, goalId); assert.equal(state.goal.status, 'paused'); assert.equal(state.session.verboseLevel, 'full');
    const resumed = await manager.executeCommand({ ...identity, command: '/goal resume' });
    assert.equal((await generate(resumed.message, resumed.native)).text, answer);
    assert.equal((await manager.sessionControls(identity)).goal.status, 'active');
    await manager.executeCommand({ ...identity, command: '/goal pause' });
    const grant = { enabled: true, tools: ['read'], roots: [files], networkHosts: [], allowExecution: false, acknowledged: true };
    toolPlan = { name: 'read', params: { path: readFile } }; toolReturned = false;
    const beforeRead = requests.length;
    assert.equal((await generate('Read the explicitly granted fixture file', null, grant)).text, answer);
    assert.ok(requests.slice(beforeRead).some(request => JSON.stringify(request.body.messages).includes('approved-native-file-content')),
      'The real upstream read tool must execute and feed its result back to the model.');
    assert.ok(reviews.some(candidate => candidate.includes('proposed-host-tool-action') && candidate.includes('approved.txt')));
    toolPlan = { name: 'write', params: { path: ungrantedWrite, content: 'must not execute' } }; toolReturned = false;
    await generate('A write is not in the grant', null, grant).catch(() => {});
    await assert.rejects(fs.access(ungrantedWrite));
    lowFruit = true; toolPlan = { name: 'read', params: { path: readFile } }; toolReturned = false;
    const beforeHeld = requests.length;
    await generate('Try the read with low covenant assessment', null, grant).catch(() => {});
    assert.equal(requests.slice(beforeHeld).some(request => JSON.stringify(request.body.messages).includes('approved-native-file-content')), false);
    assert.ok(events.some(event => event.status === 'held' && event.label.includes('read')));
    lowFruit = false; toolPlan = { name: 'update_goal', params: { status: 'complete', note: 'The requested fixture introduction was delivered and verified.' } }; toolReturned = false;
    const completePlan = await manager.executeCommand({ ...identity, command: '/goal resume' });
    assert.equal((await generate(completePlan.message, completePlan.native)).text, answer);
    assert.equal((await manager.sessionControls(identity)).goal.status, 'complete', 'The real native model-side goal tool must complete its own goal.');
    const walk = async directory => { for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name); if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) assert.equal((await fs.readFile(file)).includes(Buffer.from('isolated-fixture-provider-key')), false, file);
    } };
    await manager.close(); await walk(managed);
  } catch (error) { assert.fail(`${error.stack || error.message}\n${diagnostics.join('').slice(-4000)}`); }
});
