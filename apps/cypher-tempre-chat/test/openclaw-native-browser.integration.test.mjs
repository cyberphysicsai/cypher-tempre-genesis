import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createOpenClawGateway } from '../openclaw/gateway.mjs';
import { createPoIBroker } from '../openclaw/broker.mjs';
import { createManagedBrowserService } from '../lib/managed-browser-service.mjs';
import { createBrowserAuthority } from '../lib/browser-authority.mjs';
import { controlSessionKey } from '../lib/openclaw-controls.mjs';
import { engine } from '../lib/engine.mjs';
import { FRUITS, DIMENSIONS } from '../lib/providers.mjs';

const packageRoot = process.env.CT_OPENCLAW_PACKAGE, nodePath = process.env.CT_OPENCLAW_NODE, executablePath = process.env.CT_BROWSER_EXECUTABLE;
test('original native browser executes only freshly reviewed primitives and contains the owned browser', {
  skip: !packageRoot || !nodePath || !executablePath ? 'Set pinned native runtime and isolated browser executable paths.' : false,
  timeout: 300000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ct-nbr-')), root = path.join(directory, 'chain');
  await engine({ op: 'init', root, name: 'NativeBrowserFixture' });
  const inspected = await engine({ op: 'inspect', root, learning: false }), identity = { agentId: 'browser-native-fixture', genesisHash: inspected.genesis.hash };
  const sessionKey = controlSessionKey(identity), diagnostics = [], requests = [], reviews = [];
  let privateHits = 0, plan, returned = false, mutate = false, helpers = 0;
  const privateServer = http.createServer((_request, response) => { privateHits++; response.end('never reachable'); });
  privateServer.listen(0, '127.0.0.1'); await once(privateServer, 'listening');
  const url = 'https://example.com/';
  const grant = { enabled: true, acknowledged: true, tools: ['browser'], roots: [], networkHosts: ['example.com'], allowExecution: false, browserCapabilities: {} };
  const chromium = createRequire(path.join(packageRoot, 'package.json'))('playwright-core').chromium;
  const browsers = createManagedBrowserService({ directory: path.join(directory, 'browser'), packageRoot, executablePath,
    getGrant: async () => ({ revision: 'fixture-only', grant }), assertCurrent: async () => {}, protectedRoots: () => [root],
    createAuthority: async options => { const authority = await createBrowserAuthority(options);
      return { ...authority, inspectAction: async params => { try { return await authority.inspectAction(params); }
        catch (error) { console.error('[native-browser] fixture inspector:', error.code, error.message); throw error; } },
      assertActionUnchanged: async (...args) => { try { return await authority.assertActionUnchanged(...args); }
        catch (error) { console.error('[native-browser] fixture recheck:', error.code, error.message); throw error; } } }; },
    authorizeAction: async () => { helpers++; return { allowed: true }; } });
  const broker = createPoIBroker({ engine: async request => { const result = await engine(request);
    if (request.op === 'evaluate' && request.output?.includes('proposed-host-tool-action')) console.error('[native-browser] fixture native gate:', JSON.stringify({ accepted: result.accepted, decision: result.verdict?.decision }));
    return result; }, review: async (_config, args) => {
    reviews.push(args); const action = args.candidate.includes('proposed-host-tool-action');
    if (action && mutate && args.input.includes('after fresh target review')) {
      mutate = false; const client = await chromium.connectOverCDP(browsers.redactionSecrets().at(-1));
      try { await client.contexts()[0].pages().find(page => page.url() === url).locator('#allowed').evaluate(element => { element.textContent = 'Changed during review'; }); }
      finally { await client.close(); }
    }
    return { approved: true, scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
      fruitages: Object.fromEntries(FRUITS.map(key => [key, action && args.input.includes('denied fixture increment') ? 20 : 240])),
      usedRings: [], rationale: 'The exact requested native browser primitive is reviewed against actual owned target metadata.' };
  } }); await broker.start();
  const upstream = http.createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    assert.equal(raw.includes('[CHAINCHAT_PRIVATE_MODEL_ROUTE:'), false);
    for (const endpoint of browsers.redactionSecrets()) assert.equal(raw.includes(endpoint), false, 'Private CDP endpoints must not reach a provider.');
    const names = new Set((body.tools || []).map(tool => tool.function?.name || tool.name));
    assert.ok(names.has('browser')); assert.equal(names.has('chainchat_browser'), false);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (!returned) { returned = true; chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'browser-call-' + requests.length, type: 'function',
      function: { name: 'browser', arguments: JSON.stringify(plan) } }] }); chunk({}, 'tool_calls'); }
    else { chunk({ role: 'assistant', content: 'The native browser operation returned; consult its recorded result for completion details.' }); chunk({}, 'stop'); }
    response.end('data: [DONE]\n\n');
  }); upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const config = { provider: 'compatible', model: 'fixture', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: 'synthetic-native-browser-key' };
  const manager = createOpenClawGateway({ stateDir: path.join(directory, 'native'), packageRoot, nodePath, broker, browserService: browsers,
    pluginPath: fileURLToPath(new URL('../openclaw/plugin', import.meta.url)), requestTimeoutMs: 90000,
    onDiagnostic: line => { diagnostics.push(line); if (line.startsWith('[chainchat]')) console.error(line.trim()); } });
  t.after(async () => { await manager.close(); await browsers.close(); await broker.close();
    for (const server of [upstream, privateServer]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); assert.ok(path.basename(directory).startsWith('ct-nbr-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }); });
  const run = async (params, input) => { plan = params; returned = false;
    return manager.generate(config, { messages: [{ role: 'user', content: input }], maxTokens: 256, nativeControl: { kind: 'message', sessionKey } },
      { root, input, purpose: 'candidate', loadout: [], learning: false, nativeIdentity: identity, toolAuthority: grant, authorize: async () => {},
        event: (ability, status, label) => console.error(`[native-browser] ${ability}:${status}:${label}`) }); };
  const pageRead = async callback => { const client = await chromium.connectOverCDP(browsers.redactionSecrets().at(-1));
    try { const page = client.contexts()[0].pages().find(page => page.url() === url); assert.ok(page, 'The original native SDK must really open the approved page.'); return await callback(page); }
    finally { await client.close(); } };
  try {
    await run({ action: 'open', targetUrl: 'about:blank' }, 'Open a new empty owned browser tab at exactly about:blank.');
    let targetId;
    const initial = await chromium.connectOverCDP(browsers.redactionSecrets().at(-1));
    try { const page = initial.contexts()[0].pages().at(-1); assert.equal(page.url(), 'about:blank');
      const session = await page.context().newCDPSession(page); targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; await session.detach(); }
    finally { await initial.close(); }
    await run({ action: 'navigate', targetId, targetUrl: url }, `Navigate the newly opened owned tab to the approved fixture URL ${url}.`);
    await pageRead(async page => { await page.setContent(`<button id="allowed" onclick="document.documentElement.dataset.allowed=String(Number(document.documentElement.dataset.allowed||0)+1);fetch('http://127.0.0.1:${privateServer.address().port}/private').catch(()=>{})">Approved increment</button>
      <button id="denied" onclick="document.documentElement.dataset.denied=String(Number(document.documentElement.dataset.denied||0)+1)">Denied increment</button>
      <label>Fixture note<input id="note"></label><label>Fixture fill<input id="fill"></label><label>Secret input<input id="password" type="password"></label>`);
    });
    const snapshot = await run({ action: 'snapshot', targetId, snapshotFormat: 'ai', refs: 'aria' }, 'Take a fresh native snapshot of the owned fixture controls.');
    const snapshotObservation = snapshot.enforcement.toolObservations.filter(item => item.name === 'browser').at(-1).result;
    assert.equal(snapshotObservation.truncated, false);
    const snapshotText = JSON.parse(snapshotObservation.text).content
      .filter(item => item.type === 'text').map(item => item.text).join('\n');
    const nativeRef = label => snapshotText.split('\n').find(line => line.includes(label) && /\[ref=([a-zA-Z0-9_-]+)\]/.test(line))?.match(/\[ref=([a-zA-Z0-9_-]+)\]/)?.[1];
    const refs = { allowed: nativeRef('Approved increment'), denied: nativeRef('Denied increment'), note: nativeRef('Fixture note'),
      fill: nativeRef('Fixture fill'), password: nativeRef('Secret input') };
    for (const [name, ref] of Object.entries(refs)) assert.ok(ref, `A real native snapshot must provide ${name}.`);
    const count = () => pageRead(page => page.evaluate(() => ({ allowed: Number(document.documentElement.dataset.allowed || 0), denied: Number(document.documentElement.dataset.denied || 0) })));
    await run({ action: 'act', targetId, request: { kind: 'click', ref: refs.allowed } }, 'Click the approved fixture increment.');
    assert.equal((await count()).allowed, 1);
    await run({ action: 'act', targetId, request: { kind: 'type', ref: refs.note, text: 'A real native fixture note.' } }, 'Type the ordinary fixture note into its named input.');
    assert.equal(await pageRead(page => page.locator('#note').inputValue()), 'A real native fixture note.');
    await run({ action: 'act', targetId, request: { kind: 'fill', fields: [{ ref: refs.fill, type: 'text', value: 'A real native fixture fill.' }] } }, 'Fill the ordinary fixture fill input with the requested text.');
    assert.equal(await pageRead(page => page.locator('#fill').inputValue()), 'A real native fixture fill.');
    await run({ action: 'act', targetId, request: { kind: 'type', ref: refs.password, text: 'never-entered' } }, 'Propose editing the sensitive fixture input without a sensitive capability.').catch(() => {});
    assert.equal(await pageRead(page => page.locator('#password').inputValue()), '');
    await run({ action: 'act', targetId, request: { kind: 'click', ref: refs.denied } }, 'Propose clicking the denied fixture increment.').catch(() => {});
    assert.equal((await count()).denied, 0, 'A low-fruit primitive must not execute.');
    mutate = true;
    await run({ action: 'act', targetId, request: { kind: 'click', ref: refs.allowed } }, 'Click the approved fixture increment after fresh target review.').catch(() => {});
    assert.equal(mutate, false); assert.equal((await count()).allowed, 1, 'A changed DOM target must not reuse an earlier approval.');
    await run({ action: 'act', targetId, request: { kind: 'batch', actions: [{ kind: 'click', ref: refs.allowed }] } }, 'Attempt a compound browser action.').catch(() => {});
    assert.equal((await count()).allowed, 1, 'Compound syntax must be split into separately reviewed primitives.');
    await run({ action: 'act', targetId, request: { kind: 'wait', fn: '() => { document.documentElement.dataset.allowed = "99"; return true; }' } }, 'Propose ungranted renderer code through the native wait function path.').catch(() => {});
    assert.equal((await count()).allowed, 1, 'Private fixed-function perception must not grant model-authored JavaScript.');
    await pageRead(page => page.locator('#note').evaluate(element => element.remove()));
    await run({ action: 'act', targetId, request: { kind: 'type', ref: refs.note, text: 'must-not-resolve' } }, 'Propose editing a removed fixture input through its stale native ref.').catch(() => {});
    assert.equal(await pageRead(page => page.locator('#fill').inputValue()), 'A real native fixture fill.');
    assert.equal(privateHits, 0); assert.equal(helpers, 0); assert.ok(reviews.some(args => args.input.includes('denied fixture increment')));
  } catch (error) { throw new Error(`${error.message}\nNative browser diagnostics:\n${diagnostics.join('').slice(-7000)}`, { cause: error }); }
});
