import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createManagedAutomation } from '../lib/managed-automation.mjs';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';
import { controlSessionKey } from '../lib/openclaw-controls.mjs';
import { nativeChannelDelivery } from '../openclaw/plugin/channels.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('real pinned native scheduler signals invoke a PoI-reviewed model turn and denied delivery never leaves the host', {
  skip: !packageRoot || !nodePath ? 'Set pinned native package and Node for actual scheduler acceptance.' : false, timeout: 360000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-auto-native-'));
  const root = path.join(directory, 'chain'); await engine({ op: 'init', root, name: 'AutomationFixture' });
  const inspected = await engine({ op: 'inspect', root, learning: false });
  const identity = { ownerId: 'fixture-owner', agentId: 'fixture-agent', genesisHash: inspected.genesis.hash };
  const answer = "Hello! I'm AutomationFixture. I can help with kindness, patience and honesty.";
  let modelCalls = 0, gateCalls = 0, externalDeliveries = 0, rejectDelivery = false, channelSecret = '', nativeGateCalls = 0;
  let coordinator, sendService;
  const deliveryClaims = new Map(), ingressClaims = [], permittedSends = new Set();
  const sha = value => createHash('sha256').update(value).digest('hex');
  const deliveryKey = channel => JSON.stringify([channel.channelId, channel.accountId, channel.to, channel.sessionKey, channel.candidateSha256]);
  const upstream = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    if (request.url === '/sink') {
      assert.equal(request.headers.authorization, 'Bearer ' + channelSecret);
      assert.deepEqual(JSON.parse(raw), { to: 'room', text: answer }); externalDeliveries++;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'native-message-' + externalDeliveries })); return;
    }
    modelCalls++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const data = delta => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
      model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    data({ role: 'assistant', content: answer });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`);
    response.end();
  }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const scores = Object.fromEntries(DIMENSIONS.map(key => [key, 240]));
  const assessment = { approved: true, scores, fruitages: Object.fromEntries(FRUITS.map(key => [key, 240])), usedRings: [], rationale: 'A supported verified fixture introduction.' };
  const broker = createPoIBroker({ engine, review: async () => assessment,
    channelIngress: async ({ channel }) => {
      ingressClaims.push(channel);
      const { sessionKey, ...facts } = channel;
      const accepted = await coordinator.acceptInbound(facts);
      return { allowed: accepted.accepted, accepted: accepted.accepted };
    },
    channelDeliveryGate: async ({ channel, phase }) => {
      nativeGateCalls++;
      const claim = deliveryClaims.get(deliveryKey(channel));
      const allowed = !rejectDelivery && claim && !claim.consumed;
      if (allowed && phase === 'message') claim.consumed = true;
      return { allowed: Boolean(allowed), candidateSha256: channel.candidateSha256 };
    },
  }); await broker.start();
  const diagnostics = [], phases = [];
  const manager = createOpenClawGateway({ stateDir: path.join(directory, 'managed'), packageRoot, nodePath,
    pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), broker, startupTimeoutMs: 180000,
    onDiagnostic: line => diagnostics.push(line) });
  t.after(async () => {
    await coordinator?.close(); await manager.close(); await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(directory).startsWith('ct-auto-native-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 });
  });
  try {
  await manager.start(); phases.push('initial-native-ready');
  const existing = await manager.automationRpc('cron.list', { includeDisabled: true });
  assert.equal((existing.jobs || []).filter(job => job.enabled).length, 0, 'Synthetic state must not enable an unrelated native job. ' + JSON.stringify((existing.jobs || []).map(job => ({ id: job.id, enabled: job.enabled, payload: job.payload, declarationKey: job.declarationKey }))));
  coordinator = await createManagedAutomation({ directory: path.join(directory, 'automation'),
    native: { nodePath, rpc: manager.automationRpc, subscribe: manager.subscribeAutomation },
    checkEligibility: async () => ({ eligible: true }),
    executeTurn: async ({ binding, input, signal }) => {
      assert.deepEqual(binding, identity);
      const result = await manager.generate({ provider: 'compatible', model: 'fixture-model', apiKey: 'isolated-fixture-key',
        baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }, { messages: [{ role: 'user', content: input }], maxTokens: 256, signal },
      { root, input, loadout: [], learning: false, purpose: 'candidate', nativeIdentity: { agentId: identity.agentId, genesisHash: identity.genesisHash }, modelCapabilities: { reasoning: false } });
      assert.equal(result.enforcement.reviewed, true);
      const committed = await engine({ op: 'commit', root, expectedHead: result.enforcement.expectedHead,
        exchanges: [{ input, output: result.text, scores, assessment, usedRings: [], loadout: [], model: { provider: 'compatible', model: 'fixture-model' } }],
        loadout: [], learning: false, growth: false });
      assert.equal(committed.accepted, true);
      return { approved: true, text: result.text };
    },
    authorizeDelivery: async ({ target, text }) => {
      gateCalls++;
      const current = await engine({ op: 'inspect', root, learning: false }); assert.equal(current.verified, true);
      assert.equal(current.genesis.hash, identity.genesisHash);
      const sessionKey = controlSessionKey(identity);
      if (!rejectDelivery) deliveryClaims.set(deliveryKey({ ...target, to: target.conversationId, sessionKey, candidateSha256: sha(text) }), { consumed: false });
      return { allowed: !rejectDelivery, sessionKey };
    },
    deliver: async request => {
      const native = nativeChannelDelivery(request); permittedSends.add(JSON.stringify(native.params));
      const result = await sendService.request(native.method, native.params);
      return { delivered: Boolean(result.messageId) };
    },
  });
  await manager.enableManagedAutomation();
  const fixturePath = fileURLToPath(new URL('./fixtures/native-channel', import.meta.url));
  const mandatoryPath = fileURLToPath(new URL('../openclaw/plugin', import.meta.url));
  phases.push('configure-native-channel');
  await manager.configureManagedServices({ channels: { 'chainchat-fixture': { enabled: true } }, plugins: {
    allow: ['cypher-tempre-poi', 'browser', 'chainchat-fixture'], load: { paths: [mandatoryPath, fixturePath] }, entries: {
      'chainchat-fixture': { enabled: true, hooks: { allowConversationAccess: true }, config: { sinkUrl: `http://127.0.0.1:${upstream.address().port}/sink` } },
    },
  } });
  phases.push('native-channel-ready');
  const fixtureService = manager.registerNativeService({ id: 'fixture-channel', methods: { 'chainchatFixture.credentials': () => ({}) } });
  channelSecret = (await fixtureService.request('chainchatFixture.credentials', {})).secret;
  sendService = manager.registerNativeService({ id: 'fixture-native-send', methods: { send: params => {
    if (!permittedSends.has(JSON.stringify(params))) throw new Error('The test host did not register this send.'); return params;
  } } });
  const bound = await coordinator.bindChannel(identity, { channelId: 'chainchat-fixture', accountId: 'default', conversationId: 'room', allowSenders: ['fixture-sender'], name: 'Native fixture sink' });
  // The same mandatory plugin must preserve durable native goal admission
  // while an external channel is enabled; observation grants no native run.
  const nativeIdentity = { agentId: identity.agentId, genesisHash: identity.genesisHash };
  const goalTurn = plan => manager.generate({ provider: 'compatible', model: 'fixture-model', apiKey: 'isolated-fixture-key',
    baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }, { messages: [{ role: 'user', content: plan.message }],
    maxTokens: 256, nativeControl: plan.native }, { root, input: plan.message, loadout: [], learning: false, purpose: 'candidate',
    nativeIdentity, modelCapabilities: { reasoning: false } });
  const beforeGoalCalls = modelCalls;
  const goalPlan = await manager.executeCommand({ ...nativeIdentity, command: '/goal start Please introduce yourself.' });
  assert.equal((await goalTurn(goalPlan)).text, answer);
  phases.push('configured-channel-goal-start');
  assert.equal((await manager.sessionControls(nativeIdentity)).goal.status, 'active');
  await manager.executeCommand({ ...nativeIdentity, command: '/goal pause' });
  const resumePlan = await manager.executeCommand({ ...nativeIdentity, command: '/goal resume' });
  assert.equal((await goalTurn(resumePlan)).text, answer);
  phases.push('configured-channel-goal-resume');
  assert.equal((await manager.sessionControls(nativeIdentity)).goal.status, 'active');
  await manager.executeCommand({ ...nativeIdentity, command: '/goal pause' });
  assert.equal(modelCalls, beforeGoalCalls + 2, 'Configured external channels cannot disable recoverable registered goal turns.');
  assert.equal(externalDeliveries, 0, 'Local goal turns carry no channel delivery authorization.');
  const create = () => coordinator.createJob(identity, { name: 'Actual native at timer', prompt: 'Please introduce yourself.',
    schedule: { kind: 'at', at: new Date(Date.now() + 1500).toISOString() }, channelBindingId: bound.id });
  async function waitTerminal(id) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await coordinator.wake(); const state = await coordinator.status(identity.ownerId);
      const occurrence = state.occurrences.find(item => item.sourceId === id);
      if (occurrence && ['delivered', 'rejected', 'uncertain'].includes(occurrence.status)) return occurrence;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Native scheduler did not finish an admitted occurrence. ' + JSON.stringify({ status: await coordinator.status(identity.ownerId), diagnostics: diagnostics.slice(-5) }));
  }
  const first = await create(); assert.equal((await waitTerminal(first.id)).status, 'delivered');
  assert.equal(externalDeliveries, 1); assert.ok(modelCalls >= 1); assert.equal(gateCalls, 1);
  rejectDelivery = true; const second = await create(); assert.equal((await waitTerminal(second.id)).status, 'rejected');
  assert.equal(externalDeliveries, 1); assert.equal(gateCalls, 2);
  assert.ok(nativeGateCalls > 0, 'Actual native channel sends must enter the mandatory sending hook.');
  // A private operator send without a live PoI delivery claim still cannot reach
  // the actual registered channel's HTTP transport.
  const unreviewed = { channel: 'chainchat-fixture', accountId: 'default', to: 'room', message: answer,
    sessionKey: controlSessionKey(identity), idempotencyKey: 'unregistered-native-send' };
  permittedSends.add(JSON.stringify(unreviewed));
  await sendService.request('send', unreviewed).catch(() => {}); assert.equal(externalDeliveries, 1);
  rejectDelivery = false;
  const privateTransport = JSON.parse(await fs.readFile(path.join(directory, 'managed/transport-identity.json'), 'utf8'));
  const receiveUrl = `http://127.0.0.1:${privateTransport.gatewayPort}/chainchat-fixture/inbound`;
  const incomingRequest = { method: 'POST', headers: { authorization: 'Bearer ' + channelSecret, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'native-wire-1', sender: 'fixture-sender', text: 'Please introduce yourself through the native channel.' }) };
  const beforeIncoming = modelCalls;
  assert.equal((await fetch(receiveUrl, incomingRequest)).status, 200);
  assert.equal((await waitTerminal(bound.id)).status, 'delivered'); assert.equal(externalDeliveries, 2);
  assert.equal(modelCalls, beforeIncoming + 1, 'Only the privately admitted managed turn may infer; the unregistered native channel run stays held.');
  assert.equal(ingressClaims.length, 1); assert.equal(ingressClaims[0].senderId, 'fixture-sender');
  const beforeDuplicate = modelCalls;
  assert.equal((await fetch(receiveUrl, incomingRequest)).status, 200); await coordinator.wake();
  assert.equal(externalDeliveries, 2); assert.equal(modelCalls, beforeDuplicate);
  const verified = await engine({ op: 'verify', root }); assert.equal(verified.verified, true);
  } catch (error) {
    let details = `${error.stack || error.message}\nNative automation phases: ${phases.join(', ')}\n${diagnostics.join('').slice(-10000)}`;
    for (const secret of [broker.token, channelSecret, 'isolated-fixture-key'].filter(Boolean)) details = details.split(secret).join('[redacted fixture credential]');
    throw new Error(details, { cause: error });
  }
});
