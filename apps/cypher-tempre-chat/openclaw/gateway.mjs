/** Managed, private OpenClaw agent transport. Real provider keys live only here.
 * The HTTP agent endpoint is never exposed to the browser. An authenticated
 * local broker must admit each invocation and attest the exact final text.
 */
import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual, createHash, generateKeyPairSync, createPublicKey, createPrivateKey } from "node:crypto";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { validateProvider, assertCredentialIsolation } from "../lib/providers.mjs";
import { createNativeControls, readControlOverlay, mergeControlOverlay, validateControlPatch, NATIVE_PREFERENCES, controlSessionKey, redactNativeControl } from "../lib/openclaw-controls.mjs";

export const OPENCLAW_VERSION = "2026.10.9";
const MAX_BYTES = 24 * 1024 * 1024;
const PROVIDERS = Object.freeze({
  openai: { id: "chainchat-openai", api: "openai-responses", prefix: "/openai/v1", endpoint: "/responses" },
  compatible: { id: "chainchat-compatible", api: "openai-completions", prefix: "/compatible/v1", endpoint: "/chat/completions" },
  anthropic: { id: "chainchat-anthropic", api: "anthropic-messages", prefix: "/anthropic/v1", endpoint: "/messages" },
  gemini: { id: "chainchat-gemini", api: "google-generative-ai", prefix: "/gemini", endpoint: null },
});
const fail = (message, code = "OPENCLAW_RUNTIME", status = 502) => Object.assign(new Error(message), { code, status });
const secret = () => randomBytes(32).toString("hex");
const isLoopback = address => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
function authorized(actual, expected) {
  const a = Buffer.from(String(actual || "")), b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function collect(stream, limit = MAX_BYTES) {
  const chunks = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) throw fail("The local model transport exceeded its response limit.", "OPENCLAW_RESPONSE_LIMIT");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function checkSignal(signal) {
  if (signal?.aborted) throw fail("The OpenClaw run was cancelled.", "REQUEST_CANCELLED", 499);
}
function emit(context, ability, status, label) {
  if (typeof context?.event === "function") context.event(ability, status, label);
  else context?.onEvent?.({ ability, status, label });
}
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); child.removeListener("exit", finish); resolve(); };
    const timer = setTimeout(finish, timeoutMs); child.once("exit", finish);
  });
}
async function unusedPort() {
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function atomicJson(file, object) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(object, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}
async function supervisorIdentity(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "transport-identity.json");
  async function read() {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1 || info.size > 4096 ||
        process.platform !== "win32" && (info.mode & 0o077))
      throw fail("The private Gateway transport identity needs local inspection.", "OPENCLAW_IDENTITY_INVALID");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (value.version !== 1 || ![value.proxyPort, value.gatewayPort, ...(value.browserPort ? [value.browserPort] : [])].every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535) ||
        value.proxyPort === value.gatewayPort || ![value.proxyToken, value.gatewayToken].every(token => typeof token === "string" && /^[a-f0-9]{64}$/.test(token)))
      throw fail("The private Gateway transport identity is invalid.", "OPENCLAW_IDENTITY_INVALID");
    if (!value.browserPort) { do { value.browserPort = await unusedPort(); } while ([value.gatewayPort, value.proxyPort].includes(value.browserPort)); await atomicJson(file, value); }
    return value;
  }
  try { return await read(); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const proxyPort = await unusedPort(); let gatewayPort;
  do { gatewayPort = await unusedPort(); } while (gatewayPort === proxyPort);
  let browserPort; do { browserPort = await unusedPort(); } while ([gatewayPort, proxyPort].includes(browserPort));
  const value = { version: 1, proxyPort, gatewayPort, browserPort, proxyToken: secret(), gatewayToken: secret() };
  try { await fs.writeFile(file, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); return value; }
  catch (error) { if (error.code === "EEXIST") return read(); throw error; }
}
async function operatorIdentity(directory) {
  const file = path.join(directory, 'operator-identity.json');
  async function read() {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 4096 || process.platform !== 'win32' && (stat.mode & 0o077))
      throw fail('The private operator identity requires local inspection.', 'OPENCLAW_IDENTITY_INVALID');
    const item = JSON.parse(await fs.readFile(file, 'utf8'));
    const publicKey = createPublicKey(item.publicKeyPem), privateKey = createPrivateKey(item.privateKeyPem);
    const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    if (publicKey.asymmetricKeyType !== 'ed25519' || privateKey.asymmetricKeyType !== 'ed25519' ||
        !derived.equals(publicKey.export({ type: 'spki', format: 'der' })) ||
        createHash('sha256').update(derived.subarray(-32)).digest('hex') !== item.deviceId)
      throw fail('The private operator identity is invalid.', 'OPENCLAW_IDENTITY_INVALID');
    return item;
  }
  try { return await read(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pair = generateKeyPairSync('ed25519');
  const item = { deviceId: createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).digest('hex'),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }), privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  try { await fs.writeFile(file, JSON.stringify(item) + '\n', { mode: 0o600, flag: 'wx' }); return item; }
  catch (error) { if (error.code === 'EEXIST') return read(); throw error; }
}
function redactError() { return fail("The selected model failed inside the local OpenClaw runtime. No model text was released.", "OPENCLAW_MODEL_FAILED"); }
function inspectResponse(config, buffer) {
  const text = buffer.toString("utf8"); assertCredentialIsolation(config, text);
  try { assertCredentialIsolation(config, JSON.parse(text)); } catch (error) { if (error.code === "PROVIDER_CREDENTIAL_REFLECTION") throw error; }
  for (const line of text.split(/\r?\n/)) if (line.startsWith("data:")) {
    try { assertCredentialIsolation(config, JSON.parse(line.slice(5).trim())); } catch (error) { if (error.code === "PROVIDER_CREDENTIAL_REFLECTION") throw error; }
  }
}

/** Resolve only model protocol paths, never an arbitrary request URL. */
export function providerRequest(config, incomingPath, body, { openCodeSession } = {}) {
  if (typeof incomingPath !== "string" || !incomingPath.startsWith("/") || incomingPath.startsWith("//"))
    throw fail("Unsupported local provider route.", "OPENCLAW_PROXY_ROUTE", 404);
  config = validateProvider(config);
  const provider = PROVIDERS[config.provider];
  const incoming = new URL(incomingPath, "http://127.0.0.1");
  let suffix;
  if (provider.endpoint) {
    if (incoming.pathname !== provider.prefix + provider.endpoint || incoming.search)
      throw fail("Unsupported local provider route.", "OPENCLAW_PROXY_ROUTE", 404);
    suffix = provider.endpoint;
  } else {
    const match = incoming.pathname.match(/^\/gemini\/(?:v1beta\/)?models\/route:(streamGenerateContent|generateContent)$/);
    if (!match || [...incoming.searchParams.keys()].some(key => key !== "alt" && key !== "key") ||
        (incoming.searchParams.has("alt") && incoming.searchParams.get("alt") !== "sse"))
      throw fail("Unsupported local provider route.", "OPENCLAW_PROXY_ROUTE", 404);
    suffix = `/models/${encodeURIComponent(config.model.replace(/^models\//, ""))}:${match[1]}` +
      (incoming.searchParams.get("alt") === "sse" ? "?alt=sse" : "");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("Invalid local provider request.", "OPENCLAW_PROXY_REQUEST", 400);
  assertCredentialIsolation(config, body);
  const clean = { ...body };
  if (config.provider === "gemini") delete clean.model; else clean.model = config.model;
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const endpoint = new URL(config.baseUrl);
  if (endpoint.protocol === "https:" && endpoint.hostname === "opencode.ai" && !endpoint.port &&
      endpoint.pathname.startsWith("/inference/go/")) {
    if (typeof openCodeSession !== "string" || !/^[a-f0-9-]{36}$/i.test(openCodeSession))
      throw fail("The private model session is unavailable.", "OPENCLAW_PROVIDER_SESSION");
    headers["user-agent"] = "CypherTempre-ChainChat";
    headers["x-opencode-session"] = openCodeSession;
  }
  if (config.provider === "anthropic") { headers["x-api-key"] = config.apiKey; headers["anthropic-version"] = "2023-06-01"; }
  else if (config.provider === "gemini") headers["x-goog-api-key"] = config.apiKey;
  else if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  return { url: config.baseUrl + suffix, body: clean, headers };
}

/** Returns a manager; constructing it does not spawn processes or write files. */
export function createOpenClawGateway({ stateDir, packageRoot, nodePath = process.execPath, pluginPath, broker,
  toolsPolicy = { profile: "full", deny: [] }, startupTimeoutMs = 180000, requestTimeoutMs = 240000,
  fetchImpl = fetch, spawnImpl = spawn, onDiagnostic } = {}) {
  if (!stateDir || !packageRoot || !pluginPath || !broker || typeof broker.registerInvocation !== "function" ||
      typeof broker.assertCandidate !== "function") throw new TypeError("A local OpenClaw runtime, plugin and enforcement broker are required.");
  const directory = path.resolve(stateDir), upstream = path.resolve(packageRoot), plugin = path.resolve(pluginPath);
  // Private transport identity remains stable so native session/goal storage
  // survives restarts without retaining a stale loopback model endpoint/token.
  // Real BYOK credentials are never stored in that identity or native config.
  const providerSessions = new WeakMap();
  let child = null, proxy = null, port = null, proxyPort = null, active = null, queue = Promise.resolve(), startup = null, stopping = null;
  let gatewayToken = secret(), proxyToken = secret(), closed = false;
  let identity = null, nativeClient = null, nativeConnection = null, lastConfiguration = null, pendingOverlay = null;
  let browserHosts = [], reasoningCapable = false, capabilitiesInitialized = false;
  const nativeEvents = new Set();
  const status = () => ({ backend: "openclaw", version: OPENCLAW_VERSION, running: Boolean(child && child.exitCode === null && child.signalCode === null),
    localOnly: true, credentials: "session-memory", hostTools: toolsPolicy.deny?.includes("*") ? "disabled" : "scoped-per-invocation" });
  async function stopChild() {
    if (stopping) return stopping;
    const owned = child; child = null;
    if (!owned || owned.exitCode !== null || owned.signalCode !== null) {
      const client = nativeClient; nativeClient = null; nativeConnection = null;
      await client?.stopAndWait({ timeoutMs: 2000 }).catch(() => {}); return;
    }
    stopping = (async () => {
      const client = nativeClient; nativeClient = null; nativeConnection = null;
      if (client) await client.stopAndWait({ timeoutMs: 2000 }).catch(() => {});
      // An owned IPC pipe works on Windows without a visible console. The
      // bootstrap forwards only this fixed shutdown message to the pinned
      // runtime's native SIGTERM handler; it exposes no command interface.
      if (owned.connected && typeof owned.send === "function") {
        try { owned.send({ type: "chainchat:shutdown" }, () => {}); } catch {}
        await waitForExit(owned, 7000);
      }
      if (owned.exitCode !== null || owned.signalCode !== null) return;
      if (process.platform === "win32") {
        await new Promise(resolve => execFile("taskkill.exe", ["/PID", String(owned.pid), "/T", "/F"], { windowsHide: true }, () => resolve()));
        await waitForExit(owned, 3000);
      } else {
        try { process.kill(-owned.pid, "SIGTERM"); } catch { owned.kill("SIGTERM"); }
        await waitForExit(owned, 3000);
        if (owned.exitCode === null && owned.signalCode === null) { try { process.kill(-owned.pid, "SIGKILL"); } catch { owned.kill("SIGKILL"); } }
      }
    })().finally(() => { stopping = null; });
    return stopping;
  }
  async function handleProxy(request, response) {
    const current = active;
    try {
      if (request.headers.origin || !isLoopback(request.socket.remoteAddress) || !authorized(request.headers.authorization ||
          (request.headers["x-api-key"] ? `Bearer ${request.headers["x-api-key"]}` : request.headers["x-goog-api-key"] ? `Bearer ${request.headers["x-goog-api-key"]}` :
            new URL(request.url, "http://127.0.0.1").searchParams.get("key") ? `Bearer ${new URL(request.url, "http://127.0.0.1").searchParams.get("key")}` : ""), proxyToken))
        throw fail("Local provider authentication required.", "OPENCLAW_PROXY_AUTH", 401);
      if (request.method !== "POST" || !current || current.controller.signal.aborted)
        throw fail("No admitted local model invocation.", "OPENCLAW_PROXY_INACTIVE", 409);
      const raw = await collect(request), decoded = JSON.parse(raw.toString("utf8"));
      const upstreamRequest = providerRequest(current.config, request.url, decoded, { openCodeSession: current.openCodeSession });
      if (current !== active) throw fail("The model invocation ended.", "REQUEST_CANCELLED", 499);
      emit(current.context, "model", "started", "OpenClaw provider inference");
      const result = await fetchImpl(upstreamRequest.url, { method: "POST", headers: upstreamRequest.headers,
        body: JSON.stringify(upstreamRequest.body), redirect: "error", signal: current.controller.signal });
      if (!result.ok) throw redactError();
      const payload = await collect(result.body); inspectResponse(current.config, payload);
      if (current !== active || current.controller.signal.aborted) throw fail("The model invocation ended.", "REQUEST_CANCELLED", 499);
      emit(current.context, "model", "completed", "OpenClaw provider inference");
      response.writeHead(200, { "content-type": String(result.headers.get("content-type") || "application/json"), "cache-control": "no-store" });
      response.end(payload);
    } catch (error) {
      emit(current?.context, "model", "held", "OpenClaw provider held");
      if (!response.headersSent) response.writeHead(Number.isInteger(error.status) ? error.status : 502,
        { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { message: "The local provider request was held.", type: "chainchat_provider_error" } }));
    }
  }
  async function start() {
    if (closed) throw fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED");
    if (startup) return startup;
    if (child && child.exitCode === null && child.signalCode === null) return status();
    startup = (async () => {
      await stopping;
      await initializeModelCapabilities();
      if (closed) throw fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED");
      identity ||= await supervisorIdentity(directory);
      gatewayToken = identity.gatewayToken; proxyToken = identity.proxyToken;
      const runtimeState = path.join(directory, "native-state");
      const manifest = JSON.parse(await fs.readFile(path.join(upstream, "package.json"), "utf8"));
      if (manifest.name !== "openclaw" || manifest.version !== OPENCLAW_VERSION)
        throw fail(`Install the pinned OpenClaw ${OPENCLAW_VERSION} runtime.`, "OPENCLAW_VERSION_MISMATCH");
      const brokerUrl = new URL(broker.url);
      if (brokerUrl.protocol !== "http:" || brokerUrl.hostname !== "127.0.0.1" || brokerUrl.username || brokerUrl.password || brokerUrl.search || brokerUrl.hash || !broker.token)
        throw fail("The enforcement broker must be an authenticated loopback service.", "OPENCLAW_BROKER_CONFIG");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const workspace = path.join(directory, "workspace"); await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      if (!proxy) {
        proxy = http.createServer((request, response) => { void handleProxy(request, response); });
        proxyPort = identity.proxyPort;
        try { await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(proxyPort, "127.0.0.1", resolve); }); }
        catch { proxy.close(); proxy = null; throw fail("The private Gateway provider port is occupied. Stop only the previous owned app and retry.", "OPENCLAW_PORT_OCCUPIED"); }
      }
      // The pinned runtime caches resolved model authentication in its own
      // state. Keep this private proxy credential and loopback route stable
      // across application restarts without persisting real provider keys.
      port = identity.gatewayPort;
      // Refuse an occupied native port before spawning; never connect to or
      // terminate an unrelated listener and never silently rotate persisted routes.
      const reservation = net.createServer();
      try { await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(port, "127.0.0.1", resolve); }); }
      catch { throw fail("The private Gateway port is occupied. Stop only the previous owned app and retry.", "OPENCLAW_PORT_OCCUPIED"); }
      await new Promise(resolve => reservation.close(resolve));
      const providers = Object.fromEntries(Object.values(PROVIDERS).map(value => [value.id, {
        baseUrl: `http://127.0.0.1:${proxyPort}${value.prefix}`, apiKey: "${CHAINCHAT_PROVIDER_TOKEN}", api: value.api,
        authHeader: true, models: [{ id: "route", name: "User selected model (in-memory transport)", api: value.api,
          reasoning: reasoningCapable, input: ["text"], contextWindow: 131072, maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      }]));
      const baseConfiguration = { gateway: { mode: "local", bind: "loopback", port,
          auth: { mode: "token", token: "${CHAINCHAT_GATEWAY_TOKEN}" }, controlUi: { enabled: false },
          http: { endpoints: { chatCompletions: { enabled: true } } } },
        agents: { defaults: { workspace, skipBootstrap: true, model: { primary: "chainchat-compatible/route" },
          heartbeat: { every: "0m" }, maxConcurrent: 1 } },
        tools: mergeControlOverlay(toolsPolicy, { toolSearch: false,
          web: { fetch: { maxRedirects: 0, ssrfPolicy: { dangerouslyAllowPrivateNetwork: false } } } }),
        browser: { enabled: true, evaluateEnabled: false, defaultProfile: 'openclaw', attachOnly: false, noSandbox: false,
          ssrfPolicy: { dangerouslyAllowPrivateNetwork: false, allowedHostnames: browserHosts }, profiles: { openclaw: { cdpPort: identity.browserPort } } },
        models: { mode: "replace", catalogRefresh: { enabled: false }, providers },
        discovery: { mdns: { mode: "off" } }, cron: { enabled: false },
        // Update only through the reviewed downstream installer/pin. This also
        // suppresses native background update checks and anonymous update pings.
        update: { checkOnStart: false, auto: { enabled: false } },
        logging: { level: "error", consoleLevel: "error" },
        plugins: { enabled: true, allow: ["cypher-tempre-poi"], load: { paths: [plugin] }, entries: {
          "cypher-tempre-poi": { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true }, config: {
            brokerUrl: brokerUrl.href.replace(/\/$/, ""), brokerTokenEnv: "CHAINCHAT_BROKER_TOKEN" } } } } };
      const overlay = pendingOverlay || (await readControlOverlay(directory)).patch;
      const configuration = mergeControlOverlay(baseConfiguration, overlay);
      lastConfiguration = baseConfiguration;
      const configPath = path.join(directory, "gateway.json"); await atomicJson(configPath, configuration);
      // Avoid importing other agents' credentials, diagnostics, preload scripts,
      // proxy settings or OpenClaw configuration into this managed child.
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !/^(OPENCLAW_|CHAINCHAT_|CT_|OTEL_|SENTRY_)/i.test(name) &&
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(?:NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START|(?:HTTPS?|ALL|NO)_PROXY)$/i.test(name)));
      Object.assign(environment, { OPENCLAW_STATE_DIR: runtimeState, OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1", OPENCLAW_SKIP_CHANNELS: "1", CHAINCHAT_GATEWAY_TOKEN: gatewayToken,
        CHAINCHAT_PROVIDER_TOKEN: proxyToken, CHAINCHAT_BROKER_TOKEN: broker.token,
        NO_PROXY: "127.0.0.1,localhost,::1" });
      const bootstrap = 'import { pathToFileURL } from "node:url"; process.on("message", message => { if (message?.type === "chainchat:shutdown") { process.emit("SIGTERM"); if (process.connected) process.disconnect(); } }); await import(pathToFileURL(process.argv[1]).href);';
      if (closed) throw fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED");
      child = spawnImpl(nodePath, ["--input-type=module", "--eval", bootstrap, path.join(upstream, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"],
        { cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32" });
      let spawnError = false;
      child.on("error", () => { spawnError = true; });
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
        let line = chunk.toString("utf8");
        for (const token of [gatewayToken, proxyToken, broker.token, active?.config?.apiKey].filter(Boolean)) line = line.split(token).join("[REDACTED]");
        onDiagnostic?.(line.slice(-8192));
      });
      const readyAt = Date.now() + startupTimeoutMs;
      while (Date.now() < readyAt) {
        if (spawnError || !child || child.exitCode !== null || child.signalCode !== null) throw fail("The isolated OpenClaw gateway did not start. Inspect the local installation and pinned dependencies.", "OPENCLAW_START_FAILED");
        try {
          // The listener and model catalog bind before the pinned runtime's
          // background SQLite admission finishes. Startupz explicitly waits
          // for that admission; a catalog response alone is not agent readiness.
          const probeOptions = { headers: { authorization: `Bearer ${gatewayToken}` }, signal: AbortSignal.timeout(1500), redirect: "error" };
          const startupProbe = await fetchImpl(`http://127.0.0.1:${port}/startupz`, probeOptions);
          const startupState = startupProbe.ok ? await startupProbe.json() : null;
          if (startupState?.ok !== true || startupState.status !== "started") throw fail("Agent startup is pending.", "OPENCLAW_PENDING");
          const readiness = await fetchImpl(`http://127.0.0.1:${port}/readyz`, { ...probeOptions, signal: AbortSignal.timeout(1500) });
          if (!readiness.ok || (await readiness.json()).ready !== true) throw fail("Agent readiness is pending.", "OPENCLAW_PENDING");
          const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${gatewayToken}` },
            signal: AbortSignal.timeout(1500), redirect: "error" });
          if (response.ok) { const result = await response.json(); if (result.data?.some(value => value.id === "openclaw/default" || value.id === "openclaw/main")) return status(); }
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw fail("The local OpenClaw gateway did not become ready in time.", "OPENCLAW_START_TIMEOUT");
    })().catch(async error => { await stopChild(); throw error; }).finally(() => { startup = null; });
    return startup;
  }
  async function nativeConnectionReady() {
    await start();
    if (nativeConnection) return nativeConnection;
    nativeConnection = (async () => {
      const { GatewayClient } = await import(pathToFileURL(path.join(upstream, 'dist/plugin-sdk/gateway-runtime.js')).href);
      const deviceIdentity = await operatorIdentity(directory);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { client.stop(); reject(fail('The native OpenClaw control connection did not authenticate.', 'OPENCLAW_CONTROL_TIMEOUT')); }, 20000);
        const controlUrl = `ws://127.0.0.1:${port}`;
        const client = new GatewayClient({ url: controlUrl, deviceAuthScope: controlUrl, token: gatewayToken,
          clientName: 'cli', clientDisplayName: 'Cypher Tempre private controls', mode: 'backend', role: 'operator',
          caps: ['session-scoped-events'],
          scopes: ['operator.read', 'operator.write', 'operator.admin'], deviceIdentity, sharedStateMode: 'read-only',
          onHelloOk() { clearTimeout(timer); resolve(client); },
          onConnectError() { clearTimeout(timer); client.stop(); reject(fail('Native OpenClaw control authentication failed.', 'OPENCLAW_CONTROL_AUTH')); },
          onEvent(event) { for (const listener of nativeEvents) listener(event); },
          onClose() { if (active?.nativeRun) active.nativeClose?.(); },
        });
        nativeClient = client; client.start();
      });
    })().catch(error => { nativeConnection = null; throw error; });
    return nativeConnection;
  }
  async function nativeRpc(method, params) {
    const client = await nativeConnectionReady();
    return client.request(method, params, { timeoutMs: 30000 });
  }
  const controls = createNativeControls({
    rpc: nativeRpc, getRuntime: status, readOverlay: () => readControlOverlay(directory),
    sanitize: value => redactNativeControl(value, [gatewayToken, proxyToken, broker.token, identity?.proxyToken, identity?.gatewayToken]),
    async runSystemCommand({ sessionKey, command }) {
      if (active) throw fail('Wait for the current model run before changing native session controls.', 'OPENCLAW_CONTROL_BUSY', 409);
      if (!/^\/(?:queue|context|usage)(?:\s|$)/.test(command)) throw fail('This native command is not admitted.', 'OPENCLAW_COMMAND_GUARDED', 403);
      if (typeof broker.registerControlInvocation !== 'function' || typeof broker.assertControlResult !== 'function' || typeof broker.readControlResult !== 'function')
        throw fail('The native deterministic command adapter is unavailable.', 'OPENCLAW_COMMAND_GUARDED', 403);
      const selected = await nativeRpc('sessions.describe', { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false });
      if (!selected.session) await nativeRpc('sessions.patch', { key: sessionKey, model: 'chainchat-compatible/route' });
      const runId = randomUUID(), claim = await broker.registerControlInvocation({ sessionKey, runId, command });
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000);
      try {
        await nativeTurn({ sessionKey, message: command, idempotencyKey: runId, deliver: false }, controller, { allowEmptyFinal: true });
        // Native pure commands may intentionally omit their terminal message.
        // Their delivery hook still supplies an exact privately attested reply.
        const result = await broker.readControlResult({ claimId: claim.claimId });
        if (!result.text.trim() || result.text.trim() === 'NO_REPLY') throw fail('The native command did not return a deterministic result.', 'OPENCLAW_COMMAND_HELD');
        await broker.assertControlResult({ claimId: claim.claimId, candidate: result.text });
        return result;
      } finally { clearTimeout(timer); await broker.finishControlInvocation?.({ claimId: claim.claimId }); }
    },
    async saveOverlay(patch, revision) {
      const current = await readControlOverlay(directory);
      if (current.revision !== revision) throw fail('Settings changed. Refresh before saving.', 'OPENCLAW_CONFIG_STALE', 409);
      const next = { version: 1, patch, revision: createHash('sha256').update(JSON.stringify(patch)).digest('hex') };
      await atomicJson(path.join(directory, 'controls.json'), next); return next;
    },
    async applyOverlay(patch) {
      if (active) throw fail('Wait for the current model run before applying settings.', 'OPENCLAW_CONTROL_BUSY', 409);
      validateControlPatch(Object.keys(patch).length ? patch : { ui: {} }, { allowHostConfiguration: true });
      const current = await nativeRpc('config.get', {});
      // Native config.set performs the pinned runtime's own full schema and
      // secret-reference validation before writing its managed config file.
      const base = lastConfiguration;
      const previous = (await readControlOverlay(directory)).patch;
      pendingOverlay = patch;
      try {
        await nativeRpc('config.set', { raw: JSON.stringify(mergeControlOverlay(base, patch)), baseHash: current.hash });
        await stopChild(); await start();
      } catch (error) {
        pendingOverlay = previous;
        await stopChild(); await start().catch(() => {});
        throw fail('OpenClaw did not apply the settings; the previous managed settings were restored.', 'OPENCLAW_CONFIG_REJECTED', 422);
      } finally { pendingOverlay = null; }
    },
  });
  function serializedControl(callback) {
    if (closed) return Promise.reject(fail('This OpenClaw manager is closed.', 'OPENCLAW_CLOSED'));
    const operation = queue.then(callback); queue = operation.catch(() => {}); return operation;
  }
  async function initializeModelCapabilities() {
    if (capabilitiesInitialized) return;
    const file = path.join(directory, 'model-capabilities.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1000 || process.platform !== 'win32' && (stat.mode & 0o077))
        throw fail('The private model capability setting requires local inspection.', 'OPENCLAW_CONFIG_REJECTED');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (value.version !== 1 || typeof value.reasoning !== 'boolean') throw fail('The saved model capability setting is invalid.', 'OPENCLAW_CONFIG_REJECTED');
      reasoningCapable = value.reasoning;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    capabilitiesInitialized = true;
  }
  async function synchronizeModelCapabilities(capabilities) {
    await initializeModelCapabilities();
    if (typeof capabilities?.reasoning !== 'boolean' || capabilities.reasoning === reasoningCapable) return;
    reasoningCapable = capabilities.reasoning;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(directory, 'model-capabilities.json'), { version: 1, reasoning: reasoningCapable });
    await stopChild();
  }
  async function nativeTurn(params, controller, { allowEmptyFinal = false } = {}) {
    const client = await nativeConnectionReady();
    let expectedRun = params.idempotencyKey, settled = false, done, acknowledged = false, bufferedText = '';
    const earlyEvents = [];
    const completed = new Promise((resolve, reject) => {
      done = { resolve, reject };
    });
    // An admission RPC can fail before the terminal event is awaited. Keep its
    // sibling event promise observed while propagating the admission failure.
    completed.catch(() => {});
    const listener = event => {
      if (event.event !== 'chat' || event.payload?.sessionKey !== params.sessionKey) return;
      const payload = event.payload;
      if (!acknowledged && payload.runId !== expectedRun) { earlyEvents.push(event); return; }
      if (payload.runId !== expectedRun || settled) return;
      if (payload.state === 'delta') {
        const text = payload.deltaText;
        if (typeof text === 'string') {
          bufferedText = payload.replace === true ? text : bufferedText + text;
          if (Buffer.byteLength(bufferedText) > MAX_BYTES) { settled = true; done.reject(fail('The native text stream exceeded its limit.', 'OPENCLAW_RESPONSE_LIMIT')); }
        }
        return;
      }
      if (['error', 'aborted'].includes(payload.state)) { settled = true; done.reject(fail('The native OpenClaw turn stopped before an approved answer.', 'OPENCLAW_NATIVE_HELD')); }
      if (payload.state === 'final') {
        const content = payload.message?.content;
        const finalText = typeof content === 'string' ? content : Array.isArray(content)
          ? content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n') : null;
        // Native deterministic commands publish replace=true deltaText followed
        // by a final frame with no message. Buffer privately until terminal and
        // require the broker's exact candidate/control receipt before release.
        const candidate = finalText?.trim() ? finalText : bufferedText;
        if (!candidate?.trim() && !allowEmptyFinal) { settled = true; done.reject(fail('The native goal turn returned no final text.', 'OPENCLAW_EMPTY_RESPONSE')); }
        else { settled = true; done.resolve({ text: candidate, usage: payload.message?.usage || {} }); }
      }
    };
    const aborted = () => {
      void client.request('chat.abort', { sessionKey: params.sessionKey, runId: expectedRun }).catch(() => {});
      if (!settled) done.reject(fail('The native OpenClaw turn was cancelled.', 'REQUEST_CANCELLED', 499));
    };
    if (active) { active.nativeRun = true; active.nativeClose = () => { if (!settled) done.reject(fail('The native control connection closed.', 'OPENCLAW_CONTROL_CLOSED')); }; }
    nativeEvents.add(listener); controller.signal.addEventListener('abort', aborted, { once: true });
    try {
      await client.request('sessions.messages.subscribe', { key: params.sessionKey, subscriptionId: 'chainchat-active-turn' });
      const acknowledgement = params.goalOperation
        ? await client.request('sessions.goal.update', params.goalOperation)
        : await client.request('chat.send', params);
      expectedRun = acknowledgement.runId || expectedRun;
      acknowledged = true;
      if (acknowledgement.replayed) throw fail('This native goal operation already completed; refresh its state.', 'OPENCLAW_GOAL_REPLAY', 409);
      for (const event of earlyEvents) listener(event);
      return await completed;
    } finally { nativeEvents.delete(listener); controller.signal.removeEventListener('abort', aborted);
      await client.request('sessions.messages.unsubscribe', { key: params.sessionKey, subscriptionId: 'chainchat-active-turn' }).catch(() => {});
      if (active) { active.nativeRun = false; active.nativeClose = null; } }
  }
  async function perform(config, args, context) {
    if (!args || !Array.isArray(args.messages) || !args.messages.length || args.messages.length > 200 ||
        args.messages.some(value => !value || !["user", "assistant"].includes(value.role) || typeof value.content !== "string") ||
        (args.system !== undefined && typeof args.system !== "string") ||
        (args.maxTokens !== undefined && (!Number.isSafeInteger(args.maxTokens) || args.maxTokens < 1 || args.maxTokens > 32768)))
      throw fail("A bounded valid OpenClaw model request is required.", "OPENCLAW_INVALID_REQUEST", 400);
    if (!context || !["candidate", "utility", "plain"].includes(context.purpose))
      throw fail("An explicit trusted OpenClaw invocation purpose is required.", "OPENCLAW_CONTEXT_REQUIRED", 422);
    const rawConfig = config;
    config = validateProvider(config); assertCredentialIsolation(config, args);
    if (!providerSessions.has(rawConfig)) providerSessions.set(rawConfig, randomUUID());
    const openCodeSession = providerSessions.get(rawConfig);
    // Chromium cannot pin a hostname to the addresses reviewed by the broker.
    // Keep strict hostname navigation closed until a managed browser network
    // adapter exists; allowedHostnames would otherwise trust private addresses.
    const desiredBrowserHosts = [];
    await synchronizeModelCapabilities(context.modelCapabilities);
    if (JSON.stringify(desiredBrowserHosts) !== JSON.stringify(browserHosts)) { browserHosts = desiredBrowserHosts; await stopChild(); }
    checkSignal(args.signal); await start(); checkSignal(args.signal);
    const invocationId = randomUUID();
    const native = args.nativeControl;
    if (native && (context.purpose !== 'candidate' || !/^agent:main:chainchat-control:[a-f0-9]{64}$/.test(native.sessionKey || '') ||
        !(native.kind === 'message' || native.intent?.kind === 'session-goal-start' || native.goalOperation?.action === 'resume') ||
        context.nativeIdentity && native.sessionKey !== controlSessionKey(context.nativeIdentity)))
      throw fail('A valid host-registered native goal turn is required.', 'OPENCLAW_NATIVE_CONTROL_INVALID', 400);
    const sessionKey = native?.sessionKey || `agent:main:chainchat:${invocationId}`;
    const selected = context.nativeIdentity ? await controls.session(context.nativeIdentity) : null;
    const inherited = selected?.entry ? Object.fromEntries(NATIVE_PREFERENCES.filter(key => selected.entry[key] !== undefined)
      .map(key => [key, selected.entry[key]])) : {};
    if (!reasoningCapable && !['off', 'ultra'].includes(inherited.thinkingLevel)) delete inherited.thinkingLevel;
    const controller = new AbortController();
    const ownNativeGoal = native && context.nativeIdentity && context.purpose === 'candidate' &&
      native.sessionKey === controlSessionKey(context.nativeIdentity) &&
      (selected?.entry?.goal || native.intent?.kind === 'session-goal-start' || native.goalOperation?.action === 'resume');
    const registeredContext = { ...context,
      goalAuthority: ownNativeGoal ? { enabled: true, sessionKey, ...(selected?.entry?.goal?.id ? { goalId: selected.entry.goal.id } : {}) } : undefined,
      readNativeGoal: ownNativeGoal ? async () => {
        const current = await nativeRpc('sessions.describe', { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false });
        const goal = current.session?.goal;
        if (!goal || typeof goal.id !== 'string' || goal.id.length > 512 || typeof goal.objective !== 'string' ||
            goal.objective.length < 1 || goal.objective.length > 16000 ||
            !['active', 'paused', 'complete', 'blocked', 'budget_limited', 'usage_limited'].includes(goal.status) ||
            selected?.entry?.goal?.id && goal.id !== selected.entry.goal.id)
          throw fail('The selected native goal changed before action review.', 'OPENCLAW_GOAL_SCOPE_DENIED', 409);
        const snapshot = { id: goal.id, objective: goal.objective, status: goal.status };
        assertCredentialIsolation(config, snapshot); return snapshot;
      } : undefined,
      toolProtectedRoots: [...new Set([directory, upstream, plugin, ...(context.toolProtectedRoots || [])])] };
    const claim = await broker.registerInvocation({ config, args, context: registeredContext, sessionKey, invocationId });
    if (!claim || typeof claim.claimId !== "string" || claim.sessionKey !== sessionKey)
      throw fail("The local enforcement broker refused the invocation.", "OPENCLAW_ADMISSION_FAILED", 422);
    const abort = () => { controller.abort(); void stopChild(); };
    const timer = setTimeout(abort, requestTimeoutMs);
    args.signal?.addEventListener("abort", abort, { once: true });
    active = { config, args, context, controller, claimId: claim.claimId, sessionKey, openCodeSession };
    let responseComplete = false;
    try {
      checkSignal(args.signal);
      if (Object.keys(inherited).length && !native) await nativeRpc('sessions.patch', { key: sessionKey, ...inherited });
      if (native) {
        await nativeRpc('sessions.patch', { key: sessionKey, model: `${PROVIDERS[config.provider].id}/route` });
        const generated = await nativeTurn({ sessionKey, message: args.messages.at(-1).content, idempotencyKey: native.goalOperation?.operationId || invocationId,
          deliver: false, ...(native.intent ? { intent: native.intent } : {}), ...(native.goalOperation ? { goalOperation: native.goalOperation } : {}) }, controller);
        responseComplete = true; assertCredentialIsolation(config, generated);
        const enforcement = await broker.assertCandidate({ claimId: claim.claimId, candidate: generated.text });
        checkSignal(args.signal);
        return { ...generated, enforcement, runtime: { backend: 'openclaw', version: OPENCLAW_VERSION, invocationId, sessionKey } };
      }
      const response = await fetchImpl(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST", headers: { authorization: `Bearer ${gatewayToken}`, "content-type": "application/json",
          "x-openclaw-session-key": sessionKey, "x-openclaw-model": `${PROVIDERS[config.provider].id}/route` },
        body: JSON.stringify({ model: "openclaw/main", stream: false, max_completion_tokens: args.maxTokens || 4096,
          messages: [...(args.system ? [{ role: "system", content: args.system }] : []), ...args.messages] }),
        signal: controller.signal, redirect: "error" });
      const buffer = await collect(response.body); responseComplete = true;
      if (!response.ok) throw redactError();
      inspectResponse(config, buffer);
      const result = JSON.parse(buffer.toString("utf8")), candidate = result.choices?.[0]?.message?.content;
      if (typeof candidate !== "string" || !candidate.trim()) throw fail("OpenClaw returned no final candidate.", "OPENCLAW_EMPTY_RESPONSE");
      const enforcement = await broker.assertCandidate({ claimId: claim.claimId, candidate });
      checkSignal(args.signal); if (controller.signal.aborted) throw fail("The OpenClaw run was cancelled or timed out.", "REQUEST_CANCELLED", 499);
      return { text: candidate, enforcement, usage: { input: result.usage?.prompt_tokens || 0, output: result.usage?.completion_tokens || 0 },
        runtime: { backend: "openclaw", version: OPENCLAW_VERSION, invocationId } };
    } catch (error) {
      controller.abort(); if (!responseComplete) await stopChild();
      if (args.signal?.aborted) throw fail("The OpenClaw run was cancelled.", "REQUEST_CANCELLED", 499);
      throw error;
    } finally {
      clearTimeout(timer); args.signal?.removeEventListener("abort", abort); active = null;
      await broker.finishInvocation?.({ claimId: claim.claimId });
    }
  }
  function generate(config, args, context) {
    if (closed) return Promise.reject(fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED"));
    const operation = queue.then(() => perform(config, args, context)); queue = operation.catch(() => {}); return operation;
  }
  async function close() {
    closed = true; active?.controller.abort(); await stopChild();
    await startup?.catch(() => {}); await stopChild();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = null; }
  }
  return { start, generate, close, status,
    describeControls: identity => serializedControl(() => controls.describeControls(identity)),
    sessionControls: identity => serializedControl(() => controls.sessionControls(identity)),
    updateControls: request => serializedControl(() => controls.updateControls(request)),
    executeCommand: request => /^\s*\/(?:stop|model|config)(?:\s|$)/i.test(request?.command || '')
      ? controls.executeCommand(request) : serializedControl(async () => {
        await synchronizeModelCapabilities(request.modelCapabilities);
        return controls.executeCommand(request);
      }),
  };
}
