import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
const skip = !ws ? 'Install the pinned native runtime to supply its published ws dependency.' : false;
const browserId = 'owned-browser-fixture', pageId = 'A'.repeat(32);
const credentials = { username: 'private-discovery-proxy-user', password: 'private-discovery-proxy-password' };
const request = (url, options = {}) => new Promise((resolve, reject) => {
  const selected = new URL(url); selected.protocol = 'http:';
  const outgoing = http.request(selected, options, response => {
    let body = ''; response.on('data', bytes => { body += bytes; });
    response.once('end', () => resolve({ status: response.statusCode, body, headers: response.headers }));
  });
  outgoing.once('error', reject); outgoing.end();
});
async function until(predicate) {
  for (let index = 0; index < 400; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('The bounded disposable CDP fixture did not reach its expected state.');
}
async function fixture(t, options = {}) {
  let admitted = true, live = true, mode = 'normal', checks = 0, closes = 0, redirectHits = 0;
  const peers = [], commands = [], paths = [], httpPaths = [];
  const server = http.createServer((incoming, response) => {
    httpPaths.push(incoming.url);
    if (incoming.url === '/redirect-destination') { redirectHits++; response.end('not-followed'); return; }
    if (mode === 'redirect') { response.writeHead(302, { location: origin + '/redirect-destination' }); response.end(); return; }
    if (mode === 'oversize') { response.setHeader('content-type', 'application/json'); response.end(' '.repeat(3000)); return; }
    if (mode === 'timeout') return;
    response.setHeader('content-type', 'application/json');
    if (incoming.url === '/json/version') {
      response.end(JSON.stringify({ Browser: 'Owned fixture Chromium', 'Protocol-Version': '1.3', webSocketDebuggerUrl: upstreamURL })); return;
    }
    if (incoming.url === '/json/list') {
      response.end(JSON.stringify(live ? [{ id: pageId, type: 'page', title: 'Owned fixture page', url: 'https://example.com/', description: '',
        webSocketDebuggerUrl: mode === 'foreign-page' ? 'ws://127.0.0.1:1/devtools/page/' + pageId : origin.replace('http:', 'ws:') + '/devtools/page/' + pageId }] : [])); return;
    }
    if (incoming.url === '/json/close/' + pageId && live) { closes++; live = false; response.setHeader('content-type', 'text/plain'); response.end('Target is closing'); return; }
    response.writeHead(404); response.end('{}');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`, upstreamURL = origin.replace('http:', 'ws:') + '/devtools/browser/' + browserId;
  const websocket = new ws.WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (incoming, socket, head) => {
    if (incoming.url !== '/devtools/browser/' + browserId && (incoming.url !== '/devtools/page/' + pageId || !live)) { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    websocket.handleUpgrade(incoming, socket, head, peer => {
      peers.push(peer); paths.push(incoming.url); peer.on('error', () => {});
      peer.on('message', bytes => {
        const command = JSON.parse(bytes.toString()); commands.push({ ...command, path: incoming.url });
        peer.send(JSON.stringify({ id: command.id, ...(command.sessionId ? { sessionId: command.sessionId } : {}),
          result: { method: command.method, targetPath: incoming.url } }));
      });
    });
  });
  const relay = createBrowserCDPRelay({ upstreamURL, proxyOrigin: 'http://127.0.0.1:41777', credentials,
    WebSocket: ws.WebSocket, WebSocketServer: ws.WebSocketServer,
    assertCurrent: async () => { checks++; if (!admitted) throw new Error('Revoked fixture lease.'); }, ...options });
  const endpoint = await relay.start(), base = new URL(endpoint.webSocketURL); base.protocol = 'http:'; base.pathname = '/';
  const jsonURL = suffix => { const value = new URL(base); value.pathname = suffix; return value; };
  const connect = async url => {
    const client = new ws.WebSocket(url), messages = []; client.on('error', () => {});
    client.on('message', bytes => messages.push(JSON.parse(bytes.toString()))); await once(client, 'open'); return { client, messages };
  };
  t.after(async () => { await relay.close(); for (const peer of peers) peer.terminate();
    websocket.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { relay, endpoint, jsonURL, connect, commands, paths, httpPaths,
    get upstreamURL() { return upstreamURL; }, get checks() { return checks; }, get closes() { return closes; }, get redirectHits() { return redirectHits; },
    mode: value => { mode = value; }, removePage: () => { live = false; }, revoke: () => { admitted = false; } };
}

test('CDP discovery preserves native URL normalization and rewrites only owned debugger endpoints', { skip }, async t => {
  const f = await fixture(t);
  const endpoint = new URL(f.endpoint.webSocketURL);
  assert.equal(endpoint.pathname, '/devtools/browser/' + browserId);
  assert.match(endpoint.searchParams.get('token'), /^[a-f0-9]{64}$/);
  const version = await request(f.jsonURL('/json/version/'));
  assert.equal(version.status, 200); assert.equal(JSON.parse(version.body).webSocketDebuggerUrl, f.endpoint.webSocketURL);
  const listed = await request(f.jsonURL('/json/list/')); assert.equal(listed.status, 200);
  const [page] = JSON.parse(listed.body), target = new URL(page.webSocketDebuggerUrl);
  assert.equal(page.id, pageId); assert.equal(page.url, 'https://example.com/');
  assert.equal(target.origin, endpoint.origin); assert.equal(target.pathname, '/devtools/page/' + pageId);
  assert.equal(target.search, endpoint.search); assert.equal(listed.body.includes(f.upstreamURL), false);
  assert.equal(listed.body.includes(credentials.username), false); assert.equal(listed.body.includes(credentials.password), false);
  assert.match(version.headers['cache-control'], /no-store/);
});

test('discovery rejects unauthenticated, cross-origin, forged-host and revoked requests before forwarding', { skip }, async t => {
  const f = await fixture(t), valid = f.jsonURL('/json/list'), initial = f.httpPaths.length;
  for (const url of [new URL('/json/list', valid), new URL('/json/list?token=' + '0'.repeat(64), valid),
    new URL(valid + '&token=' + valid.searchParams.get('token'))]) assert.notEqual((await request(url)).status, 200);
  assert.notEqual((await request(valid, { headers: { Origin: 'https://untrusted.invalid' } })).status, 200);
  assert.notEqual((await request(valid, { headers: { Host: 'untrusted.invalid' } })).status, 200);
  assert.notEqual((await request(valid, { method: 'POST' })).status, 200);
  assert.equal(f.httpPaths.length, initial);
  const calls = f.checks;
  assert.notEqual((await request(new URL('/json/list', valid))).status, 200); assert.equal(f.checks, calls);
  f.revoke(); assert.notEqual((await request(valid)).status, 200); assert.equal(f.httpPaths.length, initial);
});

test('page websocket handshakes freshly bind the exact owned target and initialize root-session protections', { skip }, async t => {
  const f = await fixture(t), listed = JSON.parse((await request(f.jsonURL('/json/list'))).body), targetURL = listed[0].webSocketDebuggerUrl;
  const a = await f.connect(targetURL); const pageCommands = () => f.commands.filter(command => command.path === '/devtools/page/' + pageId);
  await until(() => pageCommands().some(command => command.method === 'Fetch.enable'));
  assert.ok(pageCommands().some(command => command.method === 'Network.setBypassServiceWorker' && command.params.bypass === true && command.sessionId === undefined));
  a.client.send(JSON.stringify({ id: 71, method: 'Page.getFrameTree' })); await until(() => a.messages.some(message => message.id === 71));
  assert.equal(a.messages.find(message => message.id === 71).result.targetPath, '/devtools/page/' + pageId);
  const connections = f.paths.length, unknown = new URL(targetURL); unknown.pathname = '/devtools/page/' + 'B'.repeat(32);
  await assert.rejects(f.connect(unknown)); assert.equal(f.paths.length, connections);
  f.removePage(); await assert.rejects(f.connect(targetURL)); assert.equal(f.paths.length, connections);
});

test('page lookup refuses an upstream debugger URL that changes authority', { skip }, async t => {
  const f = await fixture(t); f.mode('foreign-page');
  const target = new URL(f.endpoint.webSocketURL); target.pathname = '/devtools/page/' + pageId;
  await assert.rejects(f.connect(target)); assert.equal(f.paths.length, 0);
});

test('discovery never follows redirects or returns oversized/timed-out upstream data', { skip }, async t => {
  const f = await fixture(t, { limitBytes: 1024, timeoutMs: 50 });
  for (const mode of ['redirect', 'oversize', 'timeout']) {
    f.mode(mode); assert.notEqual((await request(f.jsonURL('/json/list'))).status, 200, mode);
  }
  assert.equal(f.redirectHits, 0);
});

test('closing a native target validates current ownership before the fixed upstream close request', { skip }, async t => {
  const f = await fixture(t);
  assert.notEqual((await request(f.jsonURL('/json/close/' + 'B'.repeat(32)))).status, 200); assert.equal(f.closes, 0);
  const closed = await request(f.jsonURL('/json/close/' + pageId)); assert.equal(closed.status, 200); assert.equal(f.closes, 1);
  assert.notEqual((await request(f.jsonURL('/json/close/' + pageId))).status, 200); assert.equal(f.closes, 1);
});
