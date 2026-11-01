/** Private CDP transport for one owned Chromium process. Proxy authentication
 * stays in this parent process; neither Playwright client gets HTTP credentials.
 * This is a transport boundary, not a sandbox for trusted native plugin code.
 */
import http from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const denied = () => Object.assign(new Error('The owned browser transport is unavailable.'), { code: 'BROWSER_CDP_RELAY_DENIED', status: 403 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const loopback = value => value === '127.0.0.1' || value === '::ffff:127.0.0.1';
const targetTypes = new Set(['page', 'iframe', 'background_page', 'webview']);
function ownedURL(value, websocket) {
  if (typeof value !== 'string' || !(websocket ? /^ws:\/\/127\.0\.0\.1:[1-9][0-9]*\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/ :
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/?$/).test(value)) throw denied();
  let url; try { url = new URL(value); } catch { throw denied(); }
  if (url.protocol !== (websocket ? 'ws:' : 'http:') || url.hostname !== '127.0.0.1' || !url.port ||
      !Number.isSafeInteger(Number(url.port)) || Number(url.port) < 1 || url.username || url.password || url.search || url.hash ||
      (websocket ? !/^\/devtools\/browser\/[A-Za-z0-9_-]{1,256}$/.test(url.pathname) : url.pathname !== '/')) throw denied();
  return url;
}

export function createBrowserCDPRelay({ upstreamURL, proxyOrigin, credentials, WebSocket, WebSocketServer, assertCurrent,
  limitBytes = 4 * 1024 * 1024, timeoutMs = 120000, maxConnections = 8, maxPending = 256, onDiagnostic } = {}) {
  const upstream = ownedURL(upstreamURL, true), proxy = ownedURL(proxyOrigin, false);
  if (!plain(credentials) || Object.keys(credentials).some(key => !['username', 'password'].includes(key)) ||
      !bounded(credentials.username, 512) || credentials.username.includes(':') || !bounded(credentials.password, 512) ||
      typeof WebSocket !== 'function' || typeof WebSocketServer !== 'function' || typeof assertCurrent !== 'function' ||
      !Number.isSafeInteger(limitBytes) || limitBytes < 1024 || limitBytes > 24 * 1024 * 1024 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 300000 ||
      !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 16 ||
      !Number.isSafeInteger(maxPending) || maxPending < 4 || maxPending > 2048) throw denied();
  let username = credentials.username, password = credentials.password;
  const capability = randomBytes(32).toString('hex'), browserPath = upstream.pathname;
  const connections = new Set(), sockets = new Set(), upstreamRequests = new Set();
  let server, wss, starting, closed = false, webSocketURL = null, upgrades = 0, httpRequests = 0;
  const secrets = [username, password, Buffer.from(username + ':' + password).toString('base64'),
    encodeURIComponent(username), encodeURIComponent(password)];
  const hasSecret = value => secrets.some(secret => secret && value.includes(secret));
  async function current() { if (closed) throw denied(); await assertCurrent(); if (closed) throw denied(); }
  const endpoint = pathname => 'ws://127.0.0.1:' + server.address().port + pathname + '?token=' + capability;
  const targetID = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
  function routeFor(request, socket) {
    if (closed || !loopback(socket.remoteAddress) || Object.hasOwn(request.headers, 'origin') || request.method !== 'GET' ||
        request.headers.host !== '127.0.0.1:' + server.address().port || typeof request.url !== 'string') return null;
    let url; try { url = new URL(request.url, 'http://127.0.0.1'); } catch { return null; }
    // Exact raw shape avoids alternate path/authority encodings. No caller can
    // supply another URL, header, query field or destination to this transport.
    if (request.url !== url.pathname + url.search || !/^\?token=[a-f0-9]{64}$/.test(url.search) ||
        !timingSafeEqual(Buffer.from(url.search.slice(7)), Buffer.from(capability))) return null;
    return url.pathname;
  }
  async function upstreamHttp(pathname, json = true) {
    await current();
    const body = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: Number(upstream.port), method: 'GET', path: pathname,
        headers: { accept: json ? 'application/json' : 'text/plain' }, agent: false }, response => {
        if (response.statusCode !== 200) { response.resume(); request.destroy(); reject(denied()); return; }
        const chunks = []; let bytes = 0;
        response.on('data', chunk => { bytes += chunk.length; if (bytes > limitBytes) { request.destroy(); reject(denied()); } else chunks.push(chunk); });
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', () => reject(denied()));
      });
      const deadline = setTimeout(() => { request.destroy(); reject(denied()); }, Math.min(timeoutMs, 10000)); deadline.unref?.();
      upstreamRequests.add(request);
      request.once('close', () => { clearTimeout(deadline); upstreamRequests.delete(request); });
      request.on('error', () => reject(denied()));
      request.setTimeout(Math.min(timeoutMs, 10000), () => { request.destroy(); reject(denied()); }); request.end();
    });
    await current(); if (hasSecret(body)) throw denied();
    if (!json) return body;
    try { return JSON.parse(body); } catch { throw denied(); }
  }
  async function targets() {
    const values = await upstreamHttp('/json/list');
    if (!Array.isArray(values) || values.length > 256) throw denied();
    const result = [], seen = new Set();
    for (const value of values) {
      if (!plain(value) || !targetID(value.id) || seen.has(value.id) || !bounded(value.type, 32)) throw denied();
      seen.add(value.id); if (!targetTypes.has(value.type)) continue;
      const expected = 'ws://127.0.0.1:' + upstream.port + '/devtools/page/' + value.id;
      if (value.webSocketDebuggerUrl !== expected) throw denied();
      for (const field of ['title', 'url', 'description']) if (value[field] !== undefined &&
          (typeof value[field] !== 'string' || Buffer.byteLength(value[field]) > 32768)) throw denied();
      result.push(value);
    }
    return result;
  }
  async function pageEndpoint(id) {
    if (!targetID(id)) throw denied();
    const value = (await targets()).find(target => target.id === id);
    if (!value) throw denied();
    return value.webSocketDebuggerUrl;
  }
  async function handleHttp(request, response) {
    const pathname = routeFor(request, request.socket);
    const discovery = pathname && /^\/json\/(version|list)\/?$/.exec(pathname);
    const closeTarget = pathname && /^\/json\/close\/([A-Za-z0-9_-]{1,256})$/.exec(pathname);
    if ((!discovery && !closeTarget) || httpRequests >= maxConnections) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return; }
    httpRequests++;
    try {
      await current(); let result;
      if (closeTarget) {
        await pageEndpoint(closeTarget[1]); await current();
        await upstreamHttp('/json/close/' + closeTarget[1], false);
        result = 'Target is closing';
      } else if (discovery[1] === 'list') {
        result = (await targets()).map(value => Object.fromEntries([
          ['id', value.id], ['type', value.type], ...['title', 'url', 'description'].filter(key => value[key] !== undefined).map(key => [key, value[key]]),
          ['webSocketDebuggerUrl', endpoint('/devtools/page/' + value.id)],
        ]));
      } else {
        const version = await upstreamHttp('/json/version');
        if (!plain(version) || version.webSocketDebuggerUrl !== upstream.href) throw denied();
        result = { webSocketDebuggerUrl: endpoint(browserPath) };
        for (const field of ['Browser', 'Protocol-Version', 'User-Agent', 'V8-Version', 'WebKit-Version']) if (version[field] !== undefined) {
          if (!bounded(version[field], 4096)) throw denied(); result[field] = version[field];
        }
      }
      await current(); const text = typeof result === 'string' ? result : JSON.stringify(result);
      if (Buffer.byteLength(text) > limitBytes || hasSecret(text)) throw denied();
      response.writeHead(200, { 'content-type': typeof result === 'string' ? 'text/plain' : 'application/json', 'cache-control': 'no-store' }); response.end(text);
    } catch { if (!response.headersSent) response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); }
    finally { httpRequests--; }
  }
  function diagnostic(phase, method, code) {
    try { onDiagnostic?.({ phase, ...(typeof method === 'string' && /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(method) ? { method } : {}),
      code: typeof code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(code) ? code : 'HELD' }); } catch {}
  }
  function closeConnection(state, phase = 'transport', method, code = 'CLOSED') {
    if (state.closed) return; state.closed = true; connections.delete(state);
    diagnostic(phase, method, code);
    for (const entry of state.pending.values()) { clearTimeout(entry.timer); entry.reject?.(denied()); }
    state.pending.clear(); state.clientIds.clear(); state.sessions.clear(); state.challenges.clear(); state.interception.clear(); state.networkRequests.clear();
    try { state.client?.terminate(); } catch {} try { state.upstream?.terminate(); } catch {}
  }
  function send(socket, message) {
    const bytes = JSON.stringify(message);
    if (Buffer.byteLength(bytes) > limitBytes || socket.readyState !== 1 || socket.bufferedAmount + Buffer.byteLength(bytes) > 4 * limitBytes) throw denied();
    socket.send(bytes, error => { if (error) try { socket.terminate(); } catch {} });
  }
  function parse(data, binary) {
    if (binary || Buffer.byteLength(data) > limitBytes) throw denied();
    let value; try { value = JSON.parse(data.toString()); } catch { throw denied(); }
    if (!plain(value)) throw denied(); return value;
  }
  function clientSend(state, message) {
    // Chrome can expose its transport Proxy-Authorization in request telemetry.
    // Remove only that transport-owned header in known request metadata. Site
    // Authorization, page text, response headers and arbitrary fields are never
    // scrubbed to disguise a reflected credential: those still close the relay.
    const headers = value => { if (plain(value)) for (const key of Object.keys(value)) if (key.toLowerCase() === 'proxy-authorization') delete value[key]; };
    const textHeaders = object => {
      if (typeof object?.headersText === 'string') object.headersText = object.headersText.split(/\r?\n/)
        .filter(line => !/^Proxy-Authorization\s*:/i.test(line)).join('\r\n');
    };
    if (['Fetch.requestPaused', 'Fetch.authRequired', 'Network.requestWillBeSent', 'Network.webSocketWillSendHandshakeRequest'].includes(message.method)) {
      headers(message.params?.request?.headers); textHeaders(message.params?.request);
    }
    if (message.method === 'Network.requestWillBeSentExtraInfo') { headers(message.params?.headers); textHeaders(message.params); }
    if (message.method === 'Network.requestWillBeSent') headers(message.params?.redirectResponse?.requestHeaders);
    if (message.method === 'Network.responseReceived') headers(message.params?.response?.requestHeaders);
    if (hasSecret(JSON.stringify(message))) {
      diagnostic('client-egress', message.method, 'SECRET_REFLECTION');
      throw Object.assign(denied(), { relayCode: 'SECRET_REFLECTION' });
    }
    send(state.client, message);
  }
  function enqueue(state, direction, bytes, task, method) {
    const budget = state.queued[direction];
    if (state.closed) return;
    if (++budget.count > 128 || (budget.bytes += bytes) > 4 * limitBytes) return closeConnection(state, direction, undefined, 'QUEUE_LIMIT');
    const key = direction === 'client' ? 'clientQueue' : 'eventQueue';
    state[key] = state[key].then(async () => { if (!state.closed) await task(); })
      .catch(error => closeConnection(state, direction, method, error.relayCode || 'INVALID_OR_REVOKED'))
      .finally(() => { budget.count--; budget.bytes -= bytes; });
  }
  function retireChallenges(state) {
    const now = Date.now();
    for (const [key, value] of state.challenges) if (value.expiresAt <= now) state.challenges.delete(key);
    for (const [key, value] of state.networkRequests) if (value.expiresAt <= now) state.networkRequests.delete(key);
  }
  function allocate(state) {
    if (state.pending.size >= maxPending || state.nextId >= 2147483646) throw denied();
    return ++state.nextId;
  }
  function command(state, message, entry) {
    const id = allocate(state);
    entry.method = message.method;
    entry.timer = setTimeout(() => closeConnection(state, 'command', entry.method, 'TIMEOUT'), entry.private ? Math.min(timeoutMs, 10000) : timeoutMs);
    entry.timer.unref?.(); state.pending.set(id, entry);
    try { send(state.upstream, { ...message, id }); }
    catch (error) { closeConnection(state); throw error; }
    return id;
  }
  function privateCommand(state, method, params, sessionId) {
    return new Promise((resolve, reject) => {
      try { command(state, { method, params, ...(sessionId ? { sessionId } : {}) }, { private: true, resolve, reject }); }
      catch (error) { reject(error); }
    });
  }
  const challengeKey = message => (message.sessionId || '') + '\0' + message.params.requestId;
  async function upstreamEvent(state, message) {
    if (state.closed) return;
    if (message.method === 'Target.attachedToTarget') {
      const sessionId = message.params?.sessionId, type = message.params?.targetInfo?.type;
      if (!bounded(sessionId, 512) || state.sessions.size >= 256) throw denied();
      state.sessions.add(sessionId);
      if (targetTypes.has(type)) {
        // Chromium requires a nonempty pattern for auth handling. Auto-continue
        // its pauses privately until this client explicitly requests interception.
        state.interception.set(sessionId, false);
        await privateCommand(state, 'Network.setBypassServiceWorker', { bypass: true }, sessionId);
        await privateCommand(state, 'Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }, sessionId);
      }
    }
    if (message.method === 'Target.detachedFromTarget' && bounded(message.params?.sessionId, 512)) {
      state.sessions.delete(message.params.sessionId);
      state.interception.delete(message.params.sessionId);
      for (const key of state.challenges.keys()) if (key.startsWith(message.params.sessionId + '\0')) state.challenges.delete(key);
      for (const key of state.networkRequests.keys()) if (key.startsWith(message.params.sessionId + '\0')) state.networkRequests.delete(key);
    }
    if (message.method === 'Fetch.authRequired') {
      retireChallenges(state);
      if (!plain(message.params) || !bounded(message.params.requestId, 512) || !plain(message.params.authChallenge) ||
          state.challenges.size >= 256) throw denied();
      const challenge = message.params.authChallenge, key = challengeKey(message);
      if (challenge.source === 'Proxy') {
        // Only a challenge from our exact numeric loopback proxy can receive its
        // credential. Invalid/mismatched proxy challenges are cancelled privately.
        let exact = false;
        try { exact = ownedURL(challenge.origin, false).origin === proxy.origin && challenge.scheme?.toLowerCase() === 'basic'; } catch {}
        await current();
        const attempted = state.challenges.get(key)?.kind === 'proxy';
        state.challenges.set(key, { kind: 'proxy', expiresAt: Date.now() + Math.min(timeoutMs, 120000) });
        await privateCommand(state, 'Fetch.continueWithAuth', { requestId: message.params.requestId,
          authChallengeResponse: exact && !attempted ? { response: 'ProvideCredentials', username, password } : { response: 'CancelAuth' } }, message.sessionId);
        return; // Neither challenge nor credential-bearing response reaches clients.
      }
      if (challenge.source !== 'Server') {
        await privateCommand(state, 'Fetch.continueWithAuth', { requestId: message.params.requestId,
          authChallengeResponse: { response: 'CancelAuth' } }, message.sessionId);
        return;
      }
      state.challenges.set(key, { kind: 'server', expiresAt: Date.now() + Math.min(timeoutMs, 120000) });
    }
    if (message.method === 'Fetch.requestPaused' && bounded(message.params?.requestId, 512) && bounded(message.params?.networkId, 512)) {
      retireChallenges(state);
      const key = (message.sessionId || '') + '\0' + message.params.networkId;
      if (state.networkRequests.size >= 256 && !state.networkRequests.has(key)) throw denied();
      const record = state.networkRequests.get(key) || { fetchIds: new Set() };
      if (record.fetchIds.size >= 8 && !record.fetchIds.has(challengeKey(message))) throw denied();
      record.fetchIds.add(challengeKey(message)); record.expiresAt = Date.now() + Math.min(timeoutMs, 120000); state.networkRequests.set(key, record);
    }
    if (message.method === 'Fetch.requestPaused' && state.interception.get(message.sessionId || '') !== true) {
      if (!bounded(message.params?.requestId, 512)) throw denied();
      await current();
      await privateCommand(state, 'Fetch.continueRequest', { requestId: message.params.requestId }, message.sessionId);
      return;
    }
    if (['Fetch.requestPaused', 'Network.loadingFinished', 'Network.loadingFailed'].includes(message.method)) {
      // Only completed network events retire auth-attempt state; requestPaused
      // can precede a repeated authentication challenge for the same request.
      if (message.method !== 'Fetch.requestPaused' && bounded(message.params?.requestId, 512)) {
        const key = challengeKey(message), network = state.networkRequests.get(key);
        for (const fetchId of network?.fetchIds || []) state.challenges.delete(fetchId);
        state.networkRequests.delete(key);
      }
    }
    clientSend(state, message);
  }
  async function clientMessage(state, data, binary) {
    await current(); if (state.closed) return;
    const message = parse(data, binary);
    if (!Number.isSafeInteger(message.id) || message.id < 0 || message.id > 2147483647 || state.clientIds.has(message.id) ||
        !bounded(message.method, 256) || !/^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/.test(message.method) ||
        Object.keys(message).some(key => !['id', 'method', 'params', 'sessionId'].includes(key)) ||
        message.params !== undefined && !plain(message.params) || message.sessionId !== undefined && !bounded(message.sessionId, 512) ||
        hasSecret(JSON.stringify(message))) throw denied();
    const originalId = message.id, params = message.params || {};
    if (message.method === 'Fetch.enable') {
      if (params.patterns !== undefined && (!Array.isArray(params.patterns) || params.patterns.length > 256 || params.patterns.some(pattern => !plain(pattern)))) throw denied();
      const intercept = params.patterns === undefined || params.patterns.length > 0;
      state.interception.set(message.sessionId || '', intercept);
      message.params = { ...params, handleAuthRequests: true, ...(!intercept ? { patterns: [{ urlPattern: '*' }] } : {}) };
    }
    if (message.method === 'Fetch.disable') {
      state.interception.set(message.sessionId || '', false);
      message.method = 'Fetch.enable'; message.params = { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] };
    }
    if (message.method === 'Network.setBypassServiceWorker') message.params = { ...params, bypass: true };
    if (message.method === 'Fetch.continueWithAuth' && bounded(params.requestId, 512)) {
      const key = (message.sessionId || '') + '\0' + params.requestId;
      if (state.challenges.get(key)?.kind === 'proxy') throw denied();
      state.challenges.delete(key);
    }
    state.clientIds.add(originalId);
    command(state, message, { private: false, originalId, sessionId: message.sessionId });
  }
  function connect(client, upstreamEndpoint = upstream.href, page = false) {
    const state = { client, upstream: null, closed: false, pending: new Map(), clientIds: new Set(), sessions: new Set(), challenges: new Map(), interception: new Map(), networkRequests: new Map(),
      nextId: randomInt(1000000, 1000000000), eventQueue: Promise.resolve(), clientQueue: Promise.resolve(), queued: { client: { count: 0, bytes: 0 }, upstream: { count: 0, bytes: 0 } } };
    connections.add(state);
    const upstreamSocket = state.upstream = new WebSocket(upstreamEndpoint, { perMessageDeflate: false, maxPayload: limitBytes, handshakeTimeout: 10000 });
    const early = []; let open = false, earlyBytes = 0;
    client.on('message', (data, binary) => {
      if (!open) {
        if (early.length >= 32 || (earlyBytes += Buffer.byteLength(data)) > 4 * limitBytes) return closeConnection(state, 'client', undefined, 'EARLY_QUEUE_LIMIT');
        early.push([Buffer.from(data), binary]); return;
      }
      enqueue(state, 'client', Buffer.byteLength(data), () => clientMessage(state, data, binary));
    });
    upstreamSocket.on('open', () => {
      if (page) {
        // A direct page socket has no Target.attachedToTarget wrapper. Install
        // the same private protections on its root session before client work.
        state.eventQueue = state.eventQueue.then(async () => {
          state.interception.set('', false);
          await privateCommand(state, 'Network.setBypassServiceWorker', { bypass: true });
          await privateCommand(state, 'Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
        }).catch(() => closeConnection(state, 'page-initialize', undefined, 'HELD'));
      }
      void state.eventQueue.then(() => {
        if (state.closed) return; open = true;
        for (const [data, binary] of early) enqueue(state, 'client', Buffer.byteLength(data), () => clientMessage(state, data, binary));
        early.length = 0;
      });
    });
    upstreamSocket.on('message', (data, binary) => {
      try {
        const message = parse(data, binary);
        if (Object.hasOwn(message, 'id')) {
          if (!Number.isSafeInteger(message.id)) throw denied();
          const entry = state.pending.get(message.id); if (!entry) return;
          state.pending.delete(message.id); clearTimeout(entry.timer);
          if (entry.private) { if (message.error) {
            diagnostic('private-command', entry.method, Number.isSafeInteger(message.error.code) ? 'CDP_' + message.error.code : 'CDP_ERROR');
            entry.reject(denied());
          } else entry.resolve(); return; }
          if (message.sessionId !== undefined && message.sessionId !== entry.sessionId) throw denied();
          // Keep native message order around Target.attachedToTarget. Its
          // private setup can wait for an injected response, but ordinary
          // createTarget replies must not overtake that attachment event.
          enqueue(state, 'upstream', Buffer.byteLength(data), () => {
            state.clientIds.delete(entry.originalId);
            if (entry.method === 'Fetch.enable' && message.error) throw denied();
            clientSend(state, { ...message, id: entry.originalId });
          }, entry.method); return;
        }
        if (!bounded(message.method, 256) || !plain(message.params || {}) || message.sessionId !== undefined && !bounded(message.sessionId, 512)) throw denied();
        enqueue(state, 'upstream', Buffer.byteLength(data), () => upstreamEvent(state, message), message.method);
      } catch { closeConnection(state, 'upstream-frame', undefined, 'INVALID'); }
    });
    for (const socket of [client, upstreamSocket]) { socket.on('error', () => closeConnection(state)); socket.on('close', () => closeConnection(state)); }
  }
  async function start() {
    await current(); if (webSocketURL) return { endpointURL: webSocketURL, webSocketURL };
    if (starting) return starting;
    starting = (async () => {
      wss = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: limitBytes });
      server = http.createServer((request, response) => { void handleHttp(request, response); });
      server.on('connection', socket => {
        socket.on('error', () => {});
        if (sockets.size >= 4 * maxConnections) { socket.destroy(); return; }
        sockets.add(socket); socket.once('close', () => sockets.delete(socket));
      });
      server.on('upgrade', (request, socket, head) => {
        const pathname = routeFor(request, socket), page = pathname && /^\/devtools\/page\/([A-Za-z0-9_-]{1,256})$/.exec(pathname);
        const valid = (pathname === browserPath || page) && connections.size + upgrades < maxConnections;
        if (!valid) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
        upgrades++;
        void (async () => {
          await current();
          const destination = page ? await pageEndpoint(page[1]) : upstream.href;
          await current();
          if (socket.destroyed || connections.size >= maxConnections) throw denied();
          wss.handleUpgrade(request, socket, head, client => connect(client, destination, !!page));
        })().catch(() => { try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } catch { socket.destroy(); } })
          .finally(() => { upgrades--; });
      });
      server.requestTimeout = 10000; server.headersTimeout = 10000;
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      await current(); webSocketURL = endpoint(browserPath);
      return { endpointURL: webSocketURL, webSocketURL };
    })();
    try { return await starting; } catch (error) { await close(); throw error; } finally { starting = null; }
  }
  async function close() {
    if (closed) return; closed = true;
    for (const state of [...connections]) closeConnection(state);
    for (const request of upstreamRequests) request.destroy(); upstreamRequests.clear();
    for (const socket of sockets) socket.destroy(); sockets.clear();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    try { wss?.close(); } catch {}
    username = password = ''; secrets.fill(''); webSocketURL = null;
  }
  return { start, close, get url() { return webSocketURL; }, get webSocketURL() { return webSocketURL; },
    privateValues: () => closed ? [] : [webSocketURL, capability, username, password, ...secrets].filter(Boolean) };
}
