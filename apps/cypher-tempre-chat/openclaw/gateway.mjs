/** Managed, private OpenClaw agent transport. Real provider keys live only here.
 * The HTTP agent endpoint is never exposed to the browser. An authenticated
 * local broker must admit each invocation and attest the exact final text.
 */
import { spawn, execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { validateProvider, assertCredentialIsolation } from "../lib/providers.mjs";

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
  toolsPolicy = { profile: "minimal", deny: ["*"] }, startupTimeoutMs = 90000, requestTimeoutMs = 240000,
  fetchImpl = fetch, spawnImpl = spawn, onDiagnostic } = {}) {
  if (!stateDir || !packageRoot || !pluginPath || !broker || typeof broker.registerInvocation !== "function" ||
      typeof broker.assertCandidate !== "function") throw new TypeError("A local OpenClaw runtime, plugin and enforcement broker are required.");
  const directory = path.resolve(stateDir), upstream = path.resolve(packageRoot), plugin = path.resolve(pluginPath);
  // Native sessions are ephemeral execution state. The interoperable Timechain
  // remains in the separate paired root managed by the native engine/broker.
  const providerSessions = new WeakMap();
  let child = null, proxy = null, port = null, proxyPort = null, active = null, queue = Promise.resolve(), startup = null, stopping = null;
  let gatewayToken = secret(), proxyToken = secret(), closed = false;
  const status = () => ({ backend: "openclaw", version: OPENCLAW_VERSION, running: Boolean(child && child.exitCode === null && child.signalCode === null),
    localOnly: true, credentials: "session-memory", hostTools: toolsPolicy.deny?.includes("*") ? "disabled" : "explicit-policy" });
  async function stopChild() {
    if (stopping) return stopping;
    const owned = child; child = null;
    if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
    stopping = (async () => {
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
      if (closed) throw fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED");
      const runtimeState = path.join(directory, "state", randomUUID());
      const manifest = JSON.parse(await fs.readFile(path.join(upstream, "package.json"), "utf8"));
      if (manifest.name !== "openclaw" || manifest.version !== OPENCLAW_VERSION)
        throw fail(`Install the pinned OpenClaw ${OPENCLAW_VERSION} runtime.`, "OPENCLAW_VERSION_MISMATCH");
      const brokerUrl = new URL(broker.url);
      if (brokerUrl.protocol !== "http:" || brokerUrl.hostname !== "127.0.0.1" || brokerUrl.username || brokerUrl.password || brokerUrl.search || brokerUrl.hash || !broker.token)
        throw fail("The enforcement broker must be an authenticated loopback service.", "OPENCLAW_BROKER_CONFIG");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const workspace = path.join(directory, "workspace"); await fs.mkdir(workspace, { recursive: true, mode: 0o700 });
      if (!proxy) { proxy = http.createServer((request, response) => { void handleProxy(request, response); });
        proxy.listen(0, "127.0.0.1"); await once(proxy, "listening"); proxyPort = proxy.address().port; }
      // The pinned runtime caches resolved model authentication in its own
      // state. Keep this process-private proxy credential stable across child
      // restarts; a fresh manager receives a fresh credential and fresh state.
      port = await unusedPort(); gatewayToken = secret();
      const providers = Object.fromEntries(Object.values(PROVIDERS).map(value => [value.id, {
        baseUrl: `http://127.0.0.1:${proxyPort}${value.prefix}`, apiKey: "${CHAINCHAT_PROVIDER_TOKEN}", api: value.api,
        authHeader: true, models: [{ id: "route", name: "User selected model (in-memory transport)", api: value.api,
          reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 32768,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      }]));
      const configuration = { gateway: { mode: "local", bind: "loopback", port,
          auth: { mode: "token", token: "${CHAINCHAT_GATEWAY_TOKEN}" }, controlUi: { enabled: false },
          http: { endpoints: { chatCompletions: { enabled: true } } } },
        agents: { defaults: { workspace, skipBootstrap: true, model: { primary: "chainchat-compatible/route" },
          heartbeat: { every: "0m" }, maxConcurrent: 1 } },
        tools: toolsPolicy, models: { mode: "replace", catalogRefresh: { enabled: false }, providers },
        discovery: { mdns: { mode: "off" } }, cron: { enabled: false },
        logging: { level: "error", consoleLevel: "error" },
        plugins: { enabled: true, allow: ["cypher-tempre-poi"], load: { paths: [plugin] }, entries: {
          "cypher-tempre-poi": { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true }, config: {
            brokerUrl: brokerUrl.href.replace(/\/$/, ""), brokerTokenEnv: "CHAINCHAT_BROKER_TOKEN" } } } } };
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
    checkSignal(args.signal); await start(); checkSignal(args.signal);
    const invocationId = randomUUID(), sessionKey = `agent:main:chainchat:${invocationId}`;
    const controller = new AbortController();
    const claim = await broker.registerInvocation({ config, args, context, sessionKey, invocationId });
    if (!claim || typeof claim.claimId !== "string" || claim.sessionKey !== sessionKey)
      throw fail("The local enforcement broker refused the invocation.", "OPENCLAW_ADMISSION_FAILED", 422);
    const abort = () => { controller.abort(); void stopChild(); };
    const timer = setTimeout(abort, requestTimeoutMs);
    args.signal?.addEventListener("abort", abort, { once: true });
    active = { config, args, context, controller, claimId: claim.claimId, sessionKey, openCodeSession };
    let responseComplete = false;
    try {
      checkSignal(args.signal);
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
      await broker.assertCandidate({ claimId: claim.claimId, candidate });
      checkSignal(args.signal); if (controller.signal.aborted) throw fail("The OpenClaw run was cancelled or timed out.", "REQUEST_CANCELLED", 499);
      return { text: candidate, usage: { input: result.usage?.prompt_tokens || 0, output: result.usage?.completion_tokens || 0 },
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
  return { start, generate, close, status };
}
