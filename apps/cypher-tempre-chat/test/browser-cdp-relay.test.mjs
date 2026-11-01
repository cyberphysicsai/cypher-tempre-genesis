import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBrowserCDPRelay } from '../lib/browser-cdp-relay.mjs';

let ws;
for (const source of [process.env.CT_OPENCLAW_PACKAGE && path.join(process.env.CT_OPENCLAW_PACKAGE, 'package.json'),
  fileURLToPath(new URL('../openclaw/runtime/package.json', import.meta.url)),
  fileURLToPath(new URL('../../../work/openclaw-security-overlay/package.json', import.meta.url))].filter(Boolean)) {
  try { ws = createRequire(source)('ws'); break; } catch {}
}
const skip = !ws ? 'Install the pinned OpenClaw runtime to supply the published ws dependency.' : false;
const credentials = { username: 'proxy-user-private-111111', password: 'proxy-password-private-222222' };
const proxyOrigin = 'http://127.0.0.1:41777';
async function until(predicate) {
  for (let index = 0; index < 500; index++) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The bounded local transport fixture did not reach its expected state.');
}
async function fixture(t, options = {}) {
  const upstream = new ws.WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false,
    ...(options.upgradeDelay ? { verifyClient: (_info, accept) => { setTimeout(() => accept(true), options.upgradeDelay); } } : {}) });
  await once(upstream, 'listening');
  const peers = [], commands = [], diagnostics = []; let admitted = true, checks = 0;
  upstream.on('connection', socket => {
    peers.push(socket); socket.on('error', () => {});
    socket.on('message', data => {
      const message = JSON.parse(data.toString()); commands.push({ message, socket });
      if (options.manual?.(message)) return;
      socket.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result:
        message.method === 'Fetch.continueWithAuth' ? { reflectedPrivateAuth: message.params } : { method: message.method } }));
    });
  });
  const relay = createBrowserCDPRelay({ upstreamURL: `ws://127.0.0.1:${upstream.address().port}/devtools/browser/owned-browser`,
    proxyOrigin, credentials, WebSocket: ws.WebSocket, WebSocketServer: ws.WebSocketServer,
    assertCurrent: async () => { checks++; await options.check?.(); if (!admitted) throw new Error('Fixture grant revoked.'); }, onDiagnostic: event => diagnostics.push(event), ...options.relay });
  const endpoint = await relay.start();
  async function connect(url = endpoint.webSocketURL, options) {
    const client = new ws.WebSocket(url, options), messages = []; client.on('error', () => {});
    client.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(client, 'open'); return { client, messages };
  }
  t.after(async () => { await relay.close(); for (const socket of peers) socket.terminate(); await new Promise(resolve => upstream.close(resolve)); });
  return { relay, endpoint, peers, commands, connect, diagnostics, get checks() { return checks; }, revoke() { admitted = false; } };
}
function challenge(source, origin = proxyOrigin, requestId = 'request-1') {
  return { method: 'Fetch.authRequired', sessionId: 'page-session', params: { requestId, request: { url: 'https://example.com/' },
    authChallenge: { source, origin, scheme: 'basic', realm: 'fixture' } } };
}

test('private CDP relay remaps every client ID and isolates simultaneous clients', { skip }, async t => {
  const f = await fixture(t), a = await f.connect(), b = await f.connect();
  a.client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  b.client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
  await until(() => a.messages.length === 1 && b.messages.length === 1);
  assert.equal(a.messages[0].id, 1); assert.equal(b.messages[0].id, 1);
  assert.ok(f.commands.every(item => item.message.id !== 1));
  assert.equal(new Set(f.commands.map(item => item.message.id)).size, 2);
  const privateWireID = f.commands[0].message.id;
  a.client.send(JSON.stringify({ id: privateWireID, method: 'Browser.getVersion' }));
  await until(() => a.messages.length === 2); assert.equal(a.messages[1].id, privateWireID);
  assert.notEqual(f.commands.at(-1).message.id, privateWireID);
});

test('actual proxy challenge receives only private exact-origin credentials; Server auth never does', { skip }, async t => {
  const f = await fixture(t), a = await f.connect(); await until(() => f.peers.length === 1);
  f.peers[0].send(JSON.stringify(challenge('Proxy')));
  await until(() => f.commands.some(item => item.message.method === 'Fetch.continueWithAuth'));
  const proxyAuth = f.commands.find(item => item.message.method === 'Fetch.continueWithAuth').message;
  assert.deepEqual(proxyAuth.params.authChallengeResponse, { response: 'ProvideCredentials', ...credentials });
  assert.equal(proxyAuth.sessionId, 'page-session');
  // A subsequent ordinary response is an ordering barrier proving the private
  // reflected auth result was consumed rather than sent to the client.
  a.client.send(JSON.stringify({ id: 7, method: 'Browser.getVersion' })); await until(() => a.messages.length === 1);
  assert.equal(a.messages[0].id, 7);
  f.peers[0].send(JSON.stringify(challenge('Server', 'https://example.com', 'server-request')));
  await until(() => a.messages.length === 2);
  assert.equal(a.messages[1].params.authChallenge.source, 'Server');
  a.client.send(JSON.stringify({ id: 8, sessionId: 'page-session', method: 'Fetch.continueWithAuth',
    params: { requestId: 'server-request', authChallengeResponse: { response: 'CancelAuth' } } }));
  await until(() => a.messages.length === 3);
  const serverAuth = f.commands.at(-1).message;
  assert.deepEqual(serverAuth.params.authChallengeResponse, { response: 'CancelAuth' });
  assert.equal(JSON.stringify(a.messages).includes(credentials.username), false);
  assert.equal(JSON.stringify(a.messages).includes(credentials.password), false);
  assert.equal(JSON.stringify(a.messages).includes(Buffer.from(credentials.username + ':' + credentials.password).toString('base64')), false);
});

test('mismatched, malformed and repeated proxy challenges never receive a credential', { skip }, async t => {
  const f = await fixture(t), a = await f.connect(); await until(() => f.peers.length);
  for (const [index, origin] of ['http://127.0.0.1:41778', 'https://127.0.0.1:41777', proxyOrigin + '/foreign', 'http://localhost:41777'].entries())
    f.peers[0].send(JSON.stringify(challenge('Proxy', origin, 'mismatch-' + index)));
  f.peers[0].send(JSON.stringify(challenge('proxy', proxyOrigin, 'wrong-source')));
  await until(() => f.commands.length === 5);
  assert.ok(f.commands.every(item => item.message.params.authChallengeResponse.response === 'CancelAuth'));
  f.peers[0].send(JSON.stringify(challenge('Proxy', proxyOrigin, 'repeat')));
  await until(() => f.commands.length === 6);
  f.peers[0].send(JSON.stringify(challenge('Proxy', proxyOrigin, 'repeat')));
  await until(() => f.commands.length === 7);
  assert.equal(f.commands[5].message.params.authChallengeResponse.response, 'ProvideCredentials');
  assert.deepEqual(f.commands[6].message.params.authChallengeResponse, { response: 'CancelAuth' });
  a.client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); await until(() => a.messages.length === 1);
  assert.equal(a.messages[0].id, 1);
});

test('page attachment enables proxy-only auth and service-worker bypass before the client sees it', { skip }, async t => {
  const f = await fixture(t), a = await f.connect(); await until(() => f.peers.length);
  const attached = { method: 'Target.attachedToTarget', params: { sessionId: 'page-session', targetInfo: { type: 'page', targetId: 'owned-page' } } };
  f.peers[0].send(JSON.stringify(attached)); await until(() => a.messages.length === 1);
  assert.deepEqual(a.messages[0], attached);
  assert.deepEqual(f.commands.map(item => [item.message.method, item.message.params]), [
    ['Network.setBypassServiceWorker', { bypass: true }], ['Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }],
  ]);
  a.client.send(JSON.stringify({ id: 10, method: 'Fetch.enable', sessionId: 'page-session', params: { patterns: [{ urlPattern: '*' }], handleAuthRequests: false } }));
  a.client.send(JSON.stringify({ id: 11, method: 'Fetch.disable', sessionId: 'page-session' }));
  a.client.send(JSON.stringify({ id: 12, method: 'Network.setBypassServiceWorker', sessionId: 'page-session', params: { bypass: false } }));
  await until(() => a.messages.length === 4);
  assert.deepEqual(f.commands.slice(-3).map(item => [item.message.method, item.message.params]), [
    ['Fetch.enable', { patterns: [{ urlPattern: '*' }], handleAuthRequests: true }],
    ['Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }], ['Network.setBypassServiceWorker', { bypass: true }],
  ]);
  assert.deepEqual(a.messages.slice(1).map(message => message.id), [10, 11, 12]);
});

test('auth-only request pauses continue privately while explicit interception stays with its client', { skip }, async t => {
  const f = await fixture(t), a = await f.connect(); await until(() => f.peers.length);
  const pause = { method: 'Fetch.requestPaused', sessionId: 'page-session', params: { requestId: 'paused-request', request: { url: 'https://example.com/' } } };
  f.peers[0].send(JSON.stringify(pause));
  await until(() => f.commands.some(item => item.message.method === 'Fetch.continueRequest'));
  a.client.send(JSON.stringify({ id: 1, method: 'Fetch.enable', sessionId: 'page-session', params: { patterns: [{ urlPattern: '*' }] } }));
  await until(() => a.messages.length === 1);
  f.peers[0].send(JSON.stringify(pause)); await until(() => a.messages.length === 2);
  assert.deepEqual(a.messages[1], pause);
  assert.equal(f.commands.filter(item => item.message.method === 'Fetch.continueRequest').length, 1);
});

test('capability path, Origin, lease and connection limits are enforced', { skip }, async t => {
  const f = await fixture(t, { relay: { maxConnections: 1 } });
  const checksBeforeInvalidPeers = f.checks;
  await assert.rejects(f.connect(f.endpoint.webSocketURL.replace(/.$/, 'z')));
  await assert.rejects(f.connect(f.endpoint.webSocketURL, { origin: 'https://example.com' }));
  await assert.rejects(f.connect(f.endpoint.webSocketURL, { headers: { Origin: '' } }));
  assert.equal(f.checks, checksBeforeInvalidPeers, 'Invalid capabilities must be rejected before expensive authority checks.');
  const a = await f.connect(); await assert.rejects(f.connect());
  const closed = once(a.client, 'close'); f.revoke();
  a.client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); await closed;
  assert.equal(f.commands.length, 0); await assert.rejects(f.connect());
});

test('attachment setup preserves FIFO ordering before an ordinary createTarget response', { skip }, async t => {
  const f = await fixture(t, { manual: message => message.method === 'Target.createTarget' }), a = await f.connect();
  a.client.send(JSON.stringify({ id: 40, method: 'Target.createTarget', params: { url: 'about:blank' } }));
  await until(() => f.commands.length === 1);
  const attached = { method: 'Target.attachedToTarget', params: { sessionId: 'page-session', targetInfo: { type: 'page', targetId: 'new-page' } } };
  f.peers[0].send(JSON.stringify(attached));
  f.peers[0].send(JSON.stringify({ id: f.commands[0].message.id, result: { targetId: 'new-page' } }));
  await until(() => a.messages.length === 2);
  assert.deepEqual(a.messages, [attached, { id: 40, result: { targetId: 'new-page' } }]);
});

test('both transport queues bound count and bytes while a private operation is waiting', { skip }, async t => {
  for (const direction of ['client', 'upstream']) for (const large of [false, true]) {
    let blocked = false, release;
    const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture(t, { relay: { limitBytes: 1024 }, check: async () => { if (blocked) await gate; },
      manual: message => direction === 'upstream' && message.method === 'Fetch.enable' });
    const a = await f.connect(); await until(() => f.peers.length); const closed = once(a.client, 'close');
    if (direction === 'client') blocked = true;
    else {
      f.peers[0].send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'page-session', targetInfo: { type: 'page' } } }));
      await until(() => f.commands.some(item => item.message.method === 'Fetch.enable'));
    }
    for (let index = 0; index < (large ? 8 : 140); index++) {
      const message = direction === 'client' ? { id: index + 1, method: 'Browser.getVersion', params: { padding: large ? 'x'.repeat(850) : '' } } :
        { method: 'Runtime.consoleAPICalled', params: { padding: large ? 'x'.repeat(850) : '' } };
      (direction === 'client' ? a.client : f.peers[0]).send(JSON.stringify(message));
    }
    await closed; release();
    assert.ok(f.diagnostics.some(item => item.phase === direction && item.code === 'QUEUE_LIMIT'), direction + (large ? ' bytes' : ' count'));
  }
});

test('frames arriving before the upstream handshake have a separate byte bound', { skip }, async t => {
  const f = await fixture(t, { upgradeDelay: 100, relay: { limitBytes: 1024 } }), a = await f.connect();
  const closed = once(a.client, 'close');
  for (let index = 0; index < 8; index++) a.client.send(JSON.stringify({ id: index, method: 'Browser.getVersion', params: { padding: 'x'.repeat(850) } }));
  await closed;
  assert.ok(f.diagnostics.some(item => item.code === 'EARLY_QUEUE_LIMIT'));
  assert.equal(f.commands.length, 0);
});

test('network completion retires the matching Fetch authentication attempt', { skip }, async t => {
  const f = await fixture(t), a = await f.connect(); await until(() => f.peers.length);
  f.peers[0].send(JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'page-session', params: { requestId: 'fetch-id', networkId: 'network-id' } }));
  f.peers[0].send(JSON.stringify(challenge('Proxy', proxyOrigin, 'fetch-id')));
  await until(() => f.commands.some(item => item.message.method === 'Fetch.continueWithAuth'));
  f.peers[0].send(JSON.stringify({ method: 'Network.loadingFinished', sessionId: 'page-session', params: { requestId: 'network-id' } }));
  await until(() => a.messages.length === 1);
  f.peers[0].send(JSON.stringify(challenge('Proxy', proxyOrigin, 'fetch-id')));
  await until(() => f.commands.filter(item => item.message.method === 'Fetch.continueWithAuth').length === 2);
  assert.ok(f.commands.filter(item => item.message.method === 'Fetch.continueWithAuth').every(item => item.message.params.authChallengeResponse.response === 'ProvideCredentials'));
});

test('only transport-owned Proxy-Authorization metadata is reduced; site Authorization reflection stays held', { skip }, async t => {
  const encoded = Buffer.from(credentials.username + ':' + credentials.password).toString('base64');
  const f = await fixture(t), a = await f.connect(); await until(() => f.peers.length);
  f.peers[0].send(JSON.stringify({ method: 'Network.requestWillBeSentExtraInfo', params: {
    headers: { 'Proxy-Authorization': 'Basic ' + encoded, Authorization: 'Bearer ordinary-site-token', Accept: 'text/html' },
    headersText: 'GET / HTTP/1.1\r\nProxy-Authorization: Basic ' + encoded + '\r\nAccept: text/html\r\n',
  } }));
  await until(() => a.messages.length === 1);
  assert.deepEqual(a.messages[0].params.headers, { Authorization: 'Bearer ordinary-site-token', Accept: 'text/html' });
  assert.equal(a.messages[0].params.headersText.includes('Proxy-Authorization'), false);
  const closed = once(a.client, 'close');
  f.peers[0].send(JSON.stringify({ method: 'Network.requestWillBeSentExtraInfo', params: { headers: { Authorization: 'Basic ' + encoded } } }));
  await closed; assert.equal(a.messages.length, 1);
  assert.ok(f.diagnostics.some(item => item.code === 'SECRET_REFLECTION'));
});

test('revoked auth, malformed frames, duplicate pending IDs and reflected credentials close privately', { skip }, async t => {
  const cases = [
    async (f, a) => { f.revoke(); f.peers[0].send(JSON.stringify(challenge('Proxy'))); },
    async (_f, a) => { a.client.send('{invalid'); },
    async (_f, a) => { a.client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); a.client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); },
    async (f) => { f.peers[0].send(JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { value: credentials.password } })); },
  ];
  for (const action of cases) {
    const f = await fixture(t, { manual: message => message.method === 'Browser.getVersion' }), a = await f.connect();
    await until(() => f.peers.length); const closed = once(a.client, 'close'); await action(f, a); await closed;
    assert.equal(JSON.stringify(a.messages).includes(credentials.password), false);
    assert.equal(f.commands.some(item => item.message.method === 'Fetch.continueWithAuth'), false);
    assert.ok(f.diagnostics.every(item => Object.keys(item).every(key => ['phase', 'method', 'code'].includes(key))));
  }
});

test('upstream errors/timeouts and relay shutdown retire all clients and private credentials', { skip }, async t => {
  const f = await fixture(t, { relay: { timeoutMs: 30 }, manual: () => true }), a = await f.connect();
  const closed = once(a.client, 'close'); a.client.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' })); await closed;
  assert.ok(f.diagnostics.some(item => item.code === 'TIMEOUT'));
  const b = await f.connect(), c = await f.connect(); const stops = [once(b.client, 'close'), once(c.client, 'close')];
  await f.relay.close(); await Promise.all(stops); assert.deepEqual(f.relay.privateValues(), []);
  await assert.rejects(f.relay.start());
});

test('relay constructor accepts only a fixed owned loopback browser endpoint and proxy origin', { skip }, () => {
  const base = { upstreamURL: 'ws://127.0.0.1:4444/devtools/browser/owned', proxyOrigin, credentials,
    WebSocket: ws.WebSocket, WebSocketServer: ws.WebSocketServer, assertCurrent: async () => {} };
  for (const upstreamURL of ['ws://localhost:4444/devtools/browser/owned', 'ws://127.1:4444/devtools/browser/owned', 'ws://127.0.0.1:4444/devtools/page/foreign',
    'ws://127.0.0.1:4444/devtools/browser/owned?token=foreign', 'wss://example.com/devtools/browser/owned'])
    assert.throws(() => createBrowserCDPRelay({ ...base, upstreamURL }));
  for (const proxyOrigin of ['http://localhost:4444', 'http://127.1:4444', 'http://user:password@127.0.0.1:4444', 'http://127.0.0.1:4444/foreign', 'https://127.0.0.1:4444'])
    assert.throws(() => createBrowserCDPRelay({ ...base, proxyOrigin }));
});
