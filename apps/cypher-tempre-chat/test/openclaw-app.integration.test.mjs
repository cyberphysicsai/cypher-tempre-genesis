import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../server.mjs';
import { resolveBrowserRuntime } from '../lib/browser-discovery.mjs';
import { FRUITS } from '../lib/providers.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE;
test('actual app composes native runtime, owner pairing, fresh genesis and private managed settings without a model call', {
  skip: !packageRoot || !nodePath ? 'Set CT_OPENCLAW_PACKAGE and CT_OPENCLAW_NODE for the actual native app smoke.' : false,
  timeout: 240000,
}, async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ct-native-app-smoke-'))), runtime = path.join(directory, 'gateway');
  let app, providerCalls = 0, bearer;
  const provider = http.createServer((_request, response) => { providerCalls++; response.writeHead(500); response.end('A settings smoke must never call the model.'); });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(async () => { await app?.closeRuntime(); if (app?.server.listening) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); }
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    assert.ok(path.basename(directory).startsWith('ct-native-app-smoke-')); await fs.rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });
  app = await createApp({ dataDir: path.join(directory, 'data'), pairingCode: 'NATIVE-APP-FIXTURE',
    licenseConfig: { mode: 'holdings', required: false }, openclaw: { stateDir: runtime, packageRoot, nodePath,
      pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)) } });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (endpoint, body) => {
    const response = await fetch(base + endpoint, { method: body === undefined ? 'GET' : 'POST', headers: {
      origin: base, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/openclaw')).status, 401);
  const paired = await request('/api/pair', { code: 'NATIVE-APP-FIXTURE' }); assert.equal(paired.status, 200); bearer = paired.body.token;
  const created = await request('/api/agents', { name: 'NativeAppFixture' }); assert.equal(created.status, 201);
  assert.equal(created.body.agent.verified, true); assert.equal(created.body.agent.genesis.name, 'NativeAppFixture');
  assert.deepEqual(created.body.agent.genesis.covenant, FRUITS);
  const configured = await request('/api/provider', { provider: 'compatible', model: 'no-call-fixture', apiKey: 'synthetic-app-smoke-key',
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, reasoningCapable: true });
  assert.equal(configured.status, 200);
  const native = await request('/api/openclaw'); assert.equal(native.status, 200);
  assert.equal(native.body.runtime.backend, 'openclaw'); assert.equal(native.body.runtime.running, true);
  assert.deepEqual(native.body.services, { jobs: [], channels: [], occurrences: [] });
  for (const id of ['cypher-tempre-poi', 'browser']) assert.equal(native.body.plugins.plugins.find(plugin => plugin.id === id)?.enabled, true, id);
  assert.equal(native.body.toolAuthority.grant.enabled, false);
  const browser = await resolveBrowserRuntime({ packageRoot });
  assert.equal(native.body.browserRuntime.version, browser.version); assert.equal(native.body.browserRuntime.revision, browser.revision);
  assert.ok(native.body.commands.some(command => command.name === '/goal'));
  const serialized = JSON.stringify(native.body), identity = JSON.parse(await fs.readFile(path.join(runtime, 'transport-identity.json'), 'utf8'));
  for (const secret of [identity.gatewayToken, identity.proxyToken, 'synthetic-app-smoke-key']) assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('/devtools/browser/'), false); assert.equal(serialized.includes('brokerToken\":\"'), false);
  const sourceSkill = process.env.CT_ORIGINAL_SKILL || process.env.CT_SOURCE_SKILL;
  if (sourceSkill) {
    // Invoke a clean external skill's actual CLI into disposable state. Never
    // initialize or alter an installed agent's existing source or Timechain.
    const skill = await fs.realpath(sourceSkill), imported = path.join(directory, 'skill-cli-chain');
    await fs.mkdir(imported); await fs.cp(path.join(skill, 'registry'), path.join(imported, 'registry'), { recursive: true });
    await promisify(execFile)(process.env.CT_CHAT_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
      [path.join(skill, 'timechain.py'), 'init', '--root', imported, '--name', 'SkillImportFixture'], {
        windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' } });
    const chainFile = path.join(imported, 'chain', 'rings.jsonl'), before = await fs.readFile(chainFile);
    const importedState = await request('/api/agents/pair', { root: imported });
    assert.equal(importedState.status, 200); assert.equal(importedState.body.agent.verified, true);
    assert.equal(importedState.body.agent.genesis.name, 'SkillImportFixture');
    assert.deepEqual(await fs.readFile(chainFile), before, 'Pairing preserves the original skill CLI ring bytes and hashes.');
    t.diagnostic('Actual external skill CLI genesis paired without rewriting historical ring bytes.');
  }
  assert.equal(providerCalls, 0);
});
