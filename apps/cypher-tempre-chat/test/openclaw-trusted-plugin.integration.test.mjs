import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createTrustedPluginManager, trustedPluginRpcValidators } from '../lib/trusted-plugin-manager.mjs';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('real native fixture plugin installs disabled, enables with exact trust, invokes a reviewed tool and remains revocable across restart', {
  skip: !packageRoot || !nodePath ? 'Set CT_OPENCLAW_PACKAGE and CT_OPENCLAW_NODE for real native plugin acceptance.' : false,
  timeout: 480000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-plugin-fixture-')), source = path.join(directory, 'package'), chain = path.join(directory, 'chain'),
    managed = path.join(directory, 'gateway'), trustDirectory = path.join(directory, 'trust'), marker = path.join(directory, 'executed-marker.txt');
  const pluginId = 'ct-native-trusted-fixture', toolName = 'ct_fixture_marker';
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: pluginId, version: '1.0.0', type: 'module', openclaw: { extensions: ['./index.mjs'] } }));
  await fs.writeFile(path.join(source, 'openclaw.plugin.json'), JSON.stringify({ id: pluginId, name: 'Owned acceptance fixture', version: '1.0.0', contracts: { tools: [toolName] }, configSchema: { type: 'object', additionalProperties: false, properties: {} } }));
  await fs.writeFile(path.join(source, 'index.mjs'), `import fs from 'node:fs/promises';\nexport default {id:${JSON.stringify(pluginId)},name:'Owned acceptance fixture',register(api){api.registerTool({name:${JSON.stringify(toolName)},label:'Owned fixture marker',description:'Writes only the disposable acceptance marker.',parameters:{type:'object',properties:{},additionalProperties:false},async execute(){await fs.appendFile(${JSON.stringify(marker)},'executed\\n');return {content:[{type:'text',text:'Fixture marker tool returned.'}]};}});}};`);
  await engine({ op: 'init', root: chain, name: 'PluginFixture' });
  const inspected = await engine({ op: 'inspect', root: chain, learning: false });
  const identity = { agentId: 'plugin-fixture', genesisHash: inspected.genesis.hash };
  const sessionKey = `agent:main:chainchat-control:${'b'.repeat(64)}`;
  const diagnostics = []; let issueTool = true, sentTool = false, low = false, manager, broker, pluginManager, facade;
  const answer = "Hello! I'm PluginFixture. I can help with care, patience and honesty.";
  const provider = http.createServer(async (request, response) => {
    for await (const _chunk of request) { /* Deliberately discard synthetic request content. */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const tools = issueTool && !sentTool; if (tools) sentTool = true;
    const delta = tools ? { role: 'assistant', tool_calls: [{ index: 0, id: 'fixture-' + randomUUID(), type: 'function', function: { name: toolName, arguments: '{}' } }] } : { role: 'assistant', content: answer };
    response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`); response.end();
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const makeBroker = () => createPoIBroker({ engine, review: async (_config, args) => ({ approved: true,
    scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])), fruitages: Object.fromEntries(FRUITS.map(key => [key, low && args.candidate.includes('proposed-host-tool-action') ? 20 : 240])),
    usedRings: [], rationale: 'Fixture identity and explicitly trusted exact plugin action.' }) });
  const makeManager = () => createOpenClawGateway({ stateDir: managed, packageRoot, nodePath, broker,
    pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), startupTimeoutMs: 180000, onDiagnostic: line => diagnostics.push(line) });
  async function attach() {
    facade = manager.registerNativeService({ id: 'trusted-plugin-fixture-service', requestTimeoutMs: 240000, methods: { ...trustedPluginRpcValidators({ mandatoryPluginIds: ['cypher-tempre-poi', 'browser'] }),
      'sessions.patch': value => { assert.equal(value.key, sessionKey); assert.deepEqual(Object.keys(value).sort(), ['key', 'model']); return value; },
      'tools.effective': value => { assert.equal(value.sessionKey, sessionKey); return value; } } });
    pluginManager = await createTrustedPluginManager({ directory: trustDirectory, packageRoot,
      mandatoryPluginIds: ['cypher-tempre-poi', 'browser'],
      rpc: (method, params) => facade.request(method, params),
      configureManagedServices: (_context, patch, options) => manager.configureManagedServices(patch, options),
      authorizeAction: async (_context, action) => ({ allowed: true, permitId: randomUUID(), actionHash: action.actionHash }),
      effectiveToolCatalogue: () => facade.request('tools.effective', { sessionKey }) });
  }
  broker = makeBroker(); await broker.start(); manager = makeManager(); await attach();
  t.after(async () => { await manager?.close(); await broker?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  const trust = view => ({ acknowledged: true, trustDigest: view.trustDigest, pluginId: view.artifact.pluginId, version: view.artifact.version, integrity: view.artifact.integrity });
  try {
    const preview = await pluginManager.preview({}, { operation: 'install', source: { source: 'local', path: source } });
    const staged = await pluginManager.install({}, { previewId: preview.previewId, trust: trust(preview), acknowledgeInstallPolicyWarning: true });
    t.diagnostic('Native local fixture installed disabled.');
    assert.equal(staged.awaitingActivationTrust, true); await assert.rejects(fs.access(marker));
    await pluginManager.enable({}, { previewId: staged.preview.previewId, trust: trust(staged.preview) });
    t.diagnostic('Native local fixture enabled with exact artifact trust.');
    await facade.request('sessions.patch', { key: sessionKey, model: 'chainchat-compatible/route' });
    const catalogue = await pluginManager.toolCatalogue({});
    if (!catalogue.some(tool => tool.name === toolName)) {
      const inventory = await facade.request('tools.effective', { sessionKey }), inspection = await facade.request('plugins.inspect', { pluginId });
      assert.fail(JSON.stringify({ catalogue, actualInventory: inventory.groups.map(group => ({ source: group.source,
        tools: group.tools.map(tool => ({ id: tool.id, source: tool.source, pluginId: tool.pluginId })) })),
        plugin: inspection.plugin, declared: inspection.declared }));
    }
    t.diagnostic('Actual native effective catalogue exposes the trusted fixture.');
    const grant = { enabled: true, acknowledged: true, tools: [toolName], roots: [], networkHosts: [], allowExecution: false };
    const generate = () => manager.generate({ provider: 'compatible', model: 'fixture-model', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'synthetic-plugin-fixture-key' },
      { messages: [{ role: 'user', content: 'Please introduce yourself and use the trusted fixture marker.' }], maxTokens: 512 },
      { purpose: 'candidate', root: chain, input: 'Please introduce yourself and use the trusted fixture marker.', loadout: [], learning: false,
        nativeIdentity: identity, toolAuthority: grant, pluginTools: [toolName], authorize: async () => {} });
    assert.equal((await generate()).text, answer); assert.match(await fs.readFile(marker, 'utf8'), /executed/);
    const prior = await fs.readFile(marker, 'utf8'); low = true; sentTool = false; await generate().catch(() => {});
    assert.equal(await fs.readFile(marker, 'utf8'), prior, 'Rejected PoI assessments never execute the trusted native plugin tool.');
    low = false; issueTool = false;
    await manager.close(); await broker.close(); broker = makeBroker(); await broker.start(); manager = makeManager(); await attach();
    assert.ok((await pluginManager.restoreTrustedConfiguration({})).restored.includes(pluginId));
    await facade.request('sessions.patch', { key: sessionKey, model: 'chainchat-compatible/route' });
    assert.ok((await pluginManager.toolCatalogue({})).some(tool => tool.name === toolName));
    await pluginManager.disable({}, { pluginId }); assert.deepEqual(await pluginManager.toolCatalogue({}), []);
    await manager.close(); await broker.close(); broker = makeBroker(); await broker.start(); manager = makeManager(); await attach();
    assert.deepEqual((await pluginManager.restoreTrustedConfiguration({})).restored, []);
    assert.equal((await facade.request('plugins.inspect', { pluginId })).plugin.enabled, false);
    await pluginManager.uninstall({}, { pluginId });
    assert.equal((await pluginManager.catalogue()).plugins.some(plugin => plugin.id === pluginId), false);
  } catch (failure) { assert.fail(`${failure.code || 'ERROR'}: ${failure.message}\n${diagnostics.join('').slice(-3000)}`); }
});
