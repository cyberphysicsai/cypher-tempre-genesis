import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrustedPluginManager, normalizePluginSource, trustedPluginRpcValidators } from '../lib/trusted-plugin-manager.mjs';

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-trusted-plugin-')), source = path.join(temp, 'fixture-package'), state = path.join(temp, 'manager');
  await fs.mkdir(source); await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'ct-trusted-fixture', version: '1.0.0', type: 'module' }));
  await fs.writeFile(path.join(source, 'openclaw.plugin.json'), JSON.stringify({ id: 'ct-trusted-fixture', configSchema: { type: 'object' } }));
  await fs.writeFile(path.join(source, 'index.mjs'), 'export default { register() {} };');
  t.after(async () => { assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(temp, { recursive: true, force: true }); });
  const calls = [], permits = [], configurations = [], plugins = new Map(); let number = 0;
  const declared = { tools: ['fixture_touch'], channels: options.channels || [], providers: [], hooks: [], contracts: [], mcpServers: [], skills: [] };
  const rpc = async (method, params) => {
    calls.push({ method, params: structuredClone(params) });
    if (method === 'plugins.list') return { plugins: [...plugins.values()].map(plugin => ({ ...plugin })), mutationAllowed: true, diagnostics: [] };
    if (method === 'plugins.inspect') { const plugin = plugins.get(params.pluginId); if (!plugin) throw new Error('Not installed'); return { ok: true, plugin: { ...plugin }, source: { kind: 'path', spec: source }, declared, components: { mcpServers: [] } }; }
    if (method === 'plugins.install') {
      if (options.warning && !params.acknowledgeInstallPolicyWarning) throw options.warning;
      const manifest = JSON.parse(await fs.readFile(path.join(params.path, 'openclaw.plugin.json'), 'utf8'));
      const pkg = JSON.parse(await fs.readFile(path.join(params.path, 'package.json'), 'utf8'));
      const plugin = { id: manifest.id, name: pkg.name, version: pkg.version, installed: true, enabled: false }; plugins.set(plugin.id, plugin);
      return { ok: true, plugin, runtime: { generation: 1 }, restartRequired: false, warnings: ['Fixture native install warning'] };
    }
    if (method === 'plugins.setEnabled') { if (params.enabled && options.enableError) throw options.enableError; const plugin = plugins.get(params.pluginId); plugin.enabled = params.enabled; return { ok: true, plugin: { ...plugin }, runtime: { generation: 2 }, restartRequired: false }; }
    if (method === 'plugins.uninstall') { plugins.delete(params.pluginId); return { ok: true, pluginId: params.pluginId, removed: ['fixture'], restartRequired: false }; }
    if (method === 'plugins.reload') return { ok: true, runtime: { generation: 3 } };
    throw new Error(`Unexpected native method ${method}`);
  };
  const factory = () => createTrustedPluginManager({ directory: state, rpc,
    authorizeAction: async (_context, action) => { permits.push(action); return { allowed: options.deny !== true, permitId: options.replay ? 'replayed-permit' : `owner-permit-${++number}`, actionHash: action.actionHash }; },
    configureManagedServices: async (_context, patch, options) => { configurations.push(structuredClone(patch)); if (options) configurations.at(-1).forceReload = options.forceReload; for (const [id, entry] of Object.entries(patch.plugins?.entries || {})) if (plugins.has(id) && entry.enabled !== undefined) plugins.get(id).enabled = entry.enabled; return { ok: true }; },
    effectiveToolCatalogue: async () => [{ id: 'exec', source: 'core' }, { id: 'fixture_touch', source: 'plugin', pluginId: 'ct-trusted-fixture', description: 'Fixture tool', parameters: { type: 'object' } },
      { id: 'exec', source: 'plugin', pluginId: 'ct-trusted-fixture' }, { id: 'automations', source: 'plugin', pluginId: 'ct-trusted-fixture' },
      { id: 'plugins', source: 'plugin', pluginId: 'ct-trusted-fixture' }, { id: 'chainchat_browser', source: 'plugin', pluginId: 'ct-trusted-fixture' },
      { id: 'chainchat_automation', source: 'plugin', pluginId: 'ct-trusted-fixture' }, { id: 'chainchat_automation_hidden', source: 'plugin', pluginId: 'ct-trusted-fixture' },
      { id: 'chainchat_browser_hidden', source: 'plugin', pluginId: 'ct-trusted-fixture' }, { id: 'untrusted_tool', source: 'plugin', pluginId: 'other' }],
  });
  return { manager: await factory(), factory, source, state, calls, permits, configurations, plugins };
}
const trust = view => ({ acknowledged: true, pluginId: view.artifact.pluginId, version: view.artifact.version, integrity: view.artifact.integrity, trustDigest: view.trustDigest });
async function staged(f) {
  const view = await f.manager.preview({}, { operation: 'install', source: { source: 'local', path: f.source } });
  return f.manager.install({}, { previewId: view.previewId, trust: trust(view) });
}

test('native install stays disabled until separate exact owner trust and never inherits unknown native enablement', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.manager.restoreTrustedConfiguration({}), { result: null, restored: [], warnings: [] });
  assert.deepEqual(await f.manager.toolCatalogue({}), []); assert.equal(f.configurations.length, 0);
  const result = await staged(f);
  assert.equal(result.awaitingActivationTrust, true); assert.equal(f.plugins.get('ct-trusted-fixture').enabled, false);
  assert.equal(f.calls.find(call => call.method === 'plugins.install').params.enable, false);
  await assert.rejects(f.manager.enable({}, { previewId: result.preview.previewId, trust: { acknowledged: true } }));
  f.plugins.set('unknown-native-enabled', { id: 'unknown-native-enabled', version: '1.0.0', installed: true, enabled: true });
  await f.manager.enable({}, { previewId: result.preview.previewId, trust: trust(result.preview) });
  assert.equal(f.configurations[0].plugins.entries['ct-trusted-fixture'].enabled, false, 'Native consent RPC, not an earlier config write, activates code.');
  assert.deepEqual(f.configurations[0].plugins.allow.sort(), ['ct-trusted-fixture', 'cypher-tempre-poi']);
  assert.equal(f.configurations[0].plugins.allow.includes('unknown-native-enabled'), false);
  assert.equal(f.configurations.at(-1).plugins.entries['ct-trusted-fixture'].enabled, true, 'Later supervisor restarts retain acknowledged enablement.');
  assert.equal(f.plugins.get('ct-trusted-fixture').enabled, true);
  const tools = await f.manager.toolCatalogue({}); assert.deepEqual(tools.map(tool => tool.name), ['fixture_touch']); assert.ok(tools[0].trustDigest); assert.equal(tools[0].parameters.type, 'object');
  await f.manager.disable({}, { pluginId: 'ct-trusted-fixture' }); assert.deepEqual(await f.manager.toolCatalogue({}), []);
  assert.equal(f.configurations.at(-1).plugins.entries['ct-trusted-fixture'].enabled, false);
  assert.equal(f.configurations.at(-1).plugins.allow.includes('ct-trusted-fixture'), false);
});

test('channel credentials require enabled exact artifact trust and a declared matching channel', async t => {
  const f = await fixture(t, { channels: ['fixture-channel'] });
  assert.equal(await f.manager.channelAllowed('ct-trusted-fixture', 'fixture-channel'), false);
  const result = await staged(f); await f.manager.enable({}, { previewId: result.preview.previewId, trust: trust(result.preview) });
  assert.equal(await f.manager.channelAllowed('ct-trusted-fixture', 'fixture-channel'), true);
  assert.equal(await f.manager.channelAllowed('ct-trusted-fixture', 'other-channel'), false);
  assert.equal(await f.manager.channelAllowed('unreviewed-native-plugin', 'fixture-channel'), false);
  await fs.appendFile(path.join(f.source, 'index.mjs'), '\n// source changed');
  assert.equal(await f.manager.channelAllowed('ct-trusted-fixture', 'fixture-channel'), false);
  await f.manager.disable({}, { pluginId: 'ct-trusted-fixture' });
  assert.equal(await f.manager.channelAllowed('ct-trusted-fixture', 'fixture-channel'), false);
});
test('mandatory plugins, changed artifacts, denied permits and permit replay never invoke plugin activation', async t => {
  const f = await fixture(t);
  for (const operation of ['enable', 'disable', 'uninstall', 'update', 'configure']) await assert.rejects(f.manager.preview({}, { operation, pluginId: 'cypher-tempre-poi' }));
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.manager.preview({}, { operation: 'install', source: { source: 'local', path: f.source, force: true } }));
  const result = await staged(f); await fs.appendFile(path.join(f.source, 'index.mjs'), '\n// changed source');
  await assert.rejects(f.manager.enable({}, { previewId: result.preview.previewId, trust: trust(result.preview) }), /changed after/);
  assert.equal(f.calls.some(call => call.method === 'plugins.setEnabled'), false);
  const denied = await fixture(t, { deny: true }); await assert.rejects(staged(denied)); assert.equal(denied.calls.some(call => call.method === 'plugins.install'), false);
  const replay = await fixture(t, { replay: true }), stagedReplay = await staged(replay);
  await assert.rejects(replay.manager.enable({}, { previewId: stagedReplay.preview.previewId, trust: trust(stagedReplay.preview) }));
  assert.equal(replay.calls.some(call => call.method === 'plugins.setEnabled'), false);
});

test('activation preserves only earlier explicit trust whose artifact still matches', async t => {
  const f = await fixture(t), first = await staged(f);
  await f.manager.enable({}, { previewId: first.preview.previewId, trust: trust(first.preview) });
  const add = async id => {
    const source = path.join(path.dirname(f.source), id); await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: id, version: '1.0.0' }));
    await fs.writeFile(path.join(source, 'openclaw.plugin.json'), JSON.stringify({ id, configSchema: { type: 'object' } }));
    await fs.writeFile(path.join(source, 'index.mjs'), 'export default {register(){}};');
    const view = await f.manager.preview({}, { operation: 'install', source: { source: 'local', path: source } });
    const staged = await f.manager.install({}, { previewId: view.previewId, trust: trust(view) });
    await f.manager.enable({}, { previewId: staged.preview.previewId, trust: trust(staged.preview) });
  };
  await add('ct-second-fixture');
  assert.ok(f.configurations.at(-2).plugins.allow.includes('ct-trusted-fixture'));
  await fs.appendFile(path.join(f.source, 'index.mjs'), '\n// unreviewed change');
  await add('ct-third-fixture');
  assert.deepEqual(f.configurations.at(-2).plugins.allow.sort(), ['ct-second-fixture', 'ct-third-fixture', 'cypher-tempre-poi']);
});

test('native policy warnings require a new explicit acknowledgment; the manager never forces or silently retries', async t => {
  const warning = Object.assign(new Error('Review native install policy'), { code: 'PLUGIN_INSTALL_POLICY_WARNING', details: { warning: 'Native fixture warning' } });
  const f = await fixture(t, { warning });
  const view = await f.manager.preview({}, { operation: 'install', source: { source: 'local', path: f.source } });
  await assert.rejects(f.manager.install({}, { previewId: view.previewId, trust: trust(view) }), failure => failure === warning);
  assert.equal(f.calls.filter(call => call.method === 'plugins.install').length, 1);
  await f.manager.install({}, { previewId: view.previewId, trust: trust(view), acknowledgeInstallPolicyWarning: true });
  assert.equal(f.calls.filter(call => call.method === 'plugins.install').at(-1).params.acknowledgeInstallPolicyWarning, true);
});

test('native enable failure reasserts the mandatory slot and leaves the selected plugin disabled', async t => {
  const failure = new Error('Native activation failed after a partial config write');
  const f = await fixture(t, { enableError: failure }), result = await staged(f);
  await assert.rejects(f.manager.enable({}, { previewId: result.preview.previewId, trust: trust(result.preview) }), error => error === failure);
  assert.equal(f.configurations.at(-1).forceReload, true);
  assert.equal(f.configurations.at(-1).plugins.slots.contextEngine, 'cypher-tempre-poi');
  assert.equal(f.configurations.at(-1).plugins.entries['ct-trusted-fixture'].enabled, false);
  assert.deepEqual(await f.manager.toolCatalogue({}), []);
});

test('trusted plugin persistence restores only the same artifact and never persists raw credential fields', async t => {
  const f = await fixture(t), result = await staged(f); await f.manager.enable({}, { previewId: result.preview.previewId, trust: trust(result.preview) });
  let view = await f.manager.preview({}, { operation: 'configure', pluginId: 'ct-trusted-fixture' });
  await assert.rejects(f.manager.configure({}, { previewId: view.previewId, trust: trust(view), config: { apiKey: 'never-persist-this-secret' } }), /private credential storage/);
  await f.manager.configure({}, { previewId: view.previewId, trust: trust(view), config: { greeting: 'fixture', maxTokens: 1024, tokenBudget: 2048 } });
  assert.equal(f.configurations.at(-1).plugins.entries['ct-trusted-fixture'].config.maxTokens, 1024);
  assert.equal((await fs.readFile(path.join(f.state, 'trusted-native-plugins.json'), 'utf8')).includes('never-persist'), false);
  const reloaded = await f.factory(); f.plugins.get('ct-trusted-fixture').enabled = false;
  assert.deepEqual((await reloaded.restoreTrustedConfiguration({})).restored, ['ct-trusted-fixture']);
  await fs.appendFile(path.join(f.source, 'index.mjs'), '\n// next untrusted version');
  assert.deepEqual((await reloaded.restoreTrustedConfiguration({})).restored, []);
  assert.equal(f.configurations.at(-1).plugins.entries['ct-trusted-fixture'].enabled, false);
});

test('all native source locators remain structured and private facade validators reject mutation escapes', () => {
  const sources = [{ source: 'clawhub', packageName: 'fixture' }, { source: 'official', pluginId: 'fixture' }, { source: 'npm', spec: '@fixture/package@1.0.0' },
    { source: 'git', spec: 'git+https://example.com/fixture.git#commit' }, { source: 'local', path: '/fixture path' }, { source: 'npm-pack', archivePath: '/fixture file.tgz' },
    { source: 'marketplace', marketplace: 'fixture-market', plugin: 'fixture' }, { source: 'bundled', pluginId: 'fixture' }];
  const validators = trustedPluginRpcValidators();
  for (const source of sources) { assert.deepEqual(normalizePluginSource(source), source); assert.deepEqual(validators['plugins.install']({ ...source, mode: 'install', enable: false }), { ...source, mode: 'install', enable: false }); }
  assert.throws(() => validators['plugins.install']({ source: 'local', path: '/fixture', mode: 'install', enable: true }));
  assert.throws(() => validators['plugins.setEnabled']({ pluginId: 'cypher-tempre-poi', enabled: false, allowlistPolicy: 'preserve' }));
  assert.throws(() => validators['plugins.install']({ source: 'local', path: '/fixture', force: true, mode: 'install', enable: false }));
});
