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
import { createPrivateNativeServices } from '../lib/openclaw-services.mjs';
import { createNativeBrowserInspector } from '../lib/native-browser-inspection.mjs';
import { safeInvocationError, invocationError } from '../lib/runtime-errors.mjs';

import { CONTEXT_POLICY } from './plugin/compaction.mjs';

export const OPENCLAW_VERSION = "2026.10.9";
const MAX_BYTES = 24 * 1024 * 1024;
const PROVIDERS = Object.freeze({
  openai: { id: "chainchat-openai", api: "openai-responses", prefix: "/openai/v1", endpoint: "/responses" },
  compatible: { id: "chainchat-compatible", api: "openai-completions", prefix: "/compatible/v1", endpoint: "/chat/completions" },
  anthropic: { id: "chainchat-anthropic", api: "anthropic-messages", prefix: "/anthropic/v1", endpoint: "/messages" },
  gemini: { id: "chainchat-gemini", api: "google-generative-ai", prefix: "/gemini", endpoint: null },
});
const fail = (message, code = "OPENCLAW_RUNTIME", status = 502) => Object.assign(new Error(message), { code, status });
export function nativeControlCloseError(code, reason) {
  // Close frames are untrusted transport data. Expose only this exact, known
  // watchdog condition; arbitrary native text must never reach the UI/logs.
  return code === 4000 && reason === 'tick timeout'
    ? fail('The native control heartbeat timed out. No unreviewed answer was released.', 'OPENCLAW_CONTROL_TIMEOUT', 504)
    : fail('The native control connection closed.', 'OPENCLAW_CONTROL_CLOSED');
}
function nativeControlWatchdogMs(requestTimeoutMs) {
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 600000)
    throw new TypeError('The native invocation timeout must be an integer from 100 through 600000 milliseconds.');
  return Math.max(60000, requestTimeoutMs + 60000);
}
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
function* providerRecords(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  try { const value = JSON.parse(text); if (Array.isArray(value)) yield* value; else yield value; return; } catch {}
  let data = [];
  const parse = value => { try { return JSON.parse(value); } catch { return undefined; } };
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (data.length) { const value = parse(data.join('\n')); if (Array.isArray(value)) yield* value; else if (value !== undefined) yield value; }
      data = [];
    } else if (line === 'data') data.push('');
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (data.length) { const value = parse(data.join('\n')); if (Array.isArray(value)) yield* value; else if (value !== undefined) yield value; }
}
function inspectResponse(config, buffer) {
  const text = buffer.toString("utf8"); assertCredentialIsolation(config, text);
  for (const record of providerRecords(buffer)) assertCredentialIsolation(config, record);
}

// Keep the provider's explicit stop condition across the native adapter. Some
// adapters otherwise turn a token-limited stream into a normal final reply.
export function assertProviderCompletion(provider, buffer) {
  const termination = code => { throw Object.assign(fail(
    code === 'PROVIDER_INCOMPLETE' ? 'The provider did not finish a complete response.'
      : code === 'PROVIDER_CONTENT_HELD' ? 'The provider held the model response.'
      : code === 'PROVIDER_RATE_LIMIT' ? 'The provider rate limit or quota was reached.'
      : code === 'PROVIDER_HTTP_ERROR' ? 'The provider rejected the model request.'
      : 'The provider returned an invalid or unsuccessful response.', code,
    code === 'PROVIDER_RATE_LIMIT' ? 429 : code === 'PROVIDER_CONTENT_HELD' ? 422 : 502), { stage: 'generation' }); };
  const providerFailure = error => {
    const codes = [error?.code, error?.type, error?.status].map(value => String(value ?? '').toLowerCase());
    if (codes.some(code => ['429', 'rate_limit_exceeded', 'rate_limit_error', 'rate_limit', 'quota_exceeded', 'insufficient_quota', 'resource_exhausted'].includes(code))) termination('PROVIDER_RATE_LIMIT');
    if (codes.some(code => ['401', '403', 'invalid_api_key', 'api_key_invalid', 'authentication_error', 'invalid_authentication', 'unauthorized', 'permission_denied', 'access_denied'].includes(code))) termination('PROVIDER_HTTP_ERROR');
    termination('PROVIDER_INVALID_RESPONSE');
  };
  for (const value of providerRecords(buffer)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    let incomplete = false, held = false;
    if (value.error || value.type === 'error') providerFailure(value.error || value);
    if (provider === 'compatible') {
      const choices = Array.isArray(value.choices) ? value.choices : [];
      const reasons = choices.map(choice => choice?.finish_reason);
      held = reasons.includes('content_filter') || choices.some(choice => choice?.message?.refusal || choice?.delta?.refusal);
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (reasons.some(reason => reason != null && !['stop', 'length', 'tool_calls', 'function_call'].includes(reason))) termination('PROVIDER_INVALID_RESPONSE');
      incomplete = reasons.includes('length');
    } else if (provider === 'openai') {
      const result = value.response || value;
      if (result.error || result.status === 'failed' || value.type === 'response.failed') providerFailure(result.error);
      const reason = result.incomplete_details?.reason;
      held = reason === 'content_filter' || value.type === 'response.refusal.delta' || value.type === 'response.refusal.done' ||
        (Array.isArray(result.output) && result.output.some(item => Array.isArray(item?.content) && item.content.some(part => part?.type === 'refusal')));
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (result.status != null && !['queued', 'in_progress', 'completed', 'incomplete'].includes(result.status)) termination('PROVIDER_INVALID_RESPONSE');
      if (result.status === 'incomplete' || value.type === 'response.incomplete') {
        if (![undefined, null, 'max_output_tokens'].includes(reason)) termination('PROVIDER_INVALID_RESPONSE');
        incomplete = true;
      }
    } else if (provider === 'anthropic') {
      const reason = value.delta?.stop_reason || value.stop_reason;
      held = reason === 'refusal' || value.content_block?.type === 'refusal' ||
        (Array.isArray(value.content) && value.content.some(part => part?.type === 'refusal'));
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (reason != null && !['end_turn', 'stop_sequence', 'max_tokens', 'tool_use', 'pause_turn'].includes(reason)) termination('PROVIDER_INVALID_RESPONSE');
      incomplete = reason === 'max_tokens';
    } else if (provider === 'gemini') {
      const reasons = (Array.isArray(value.candidates) ? value.candidates : []).map(candidate => candidate?.finishReason);
      held = !!value.promptFeedback?.blockReason || reasons.some(reason => ['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT'].includes(reason));
      if (held) termination('PROVIDER_CONTENT_HELD');
      if (reasons.some(reason => reason != null && !['STOP', 'MAX_TOKENS'].includes(reason))) termination('PROVIDER_INVALID_RESPONSE');
      incomplete = reasons.includes('MAX_TOKENS');
    }
    if (incomplete) termination('PROVIDER_INCOMPLETE');
  }
}

/** A private per-invocation capability can occur once in system instructions.
 * Strip it before BYOK egress. Unreviewed fallback summarizers have no lease.
 */
export function consumeModelRouteCapability(body, provider, capability) {
  if (!/^[a-f0-9]{64}$/.test(capability || '')) throw fail('Private model admission is unavailable.', 'OPENCLAW_MODEL_ADMISSION', 403);
  const marker = `[CHAINCHAT_PRIVATE_MODEL_ROUTE:${capability}]`, copy = structuredClone(body);
  let total = 0, admitted = 0;
  const count = value => {
    if (typeof value === 'string') total += value.split(marker).length - 1;
    else if (Array.isArray(value)) value.forEach(count);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { count(key); count(child); }
  };
  count(copy);
  const strip = (object, key) => { if (typeof object?.[key] === 'string') {
    admitted += object[key].split(marker).length - 1; object[key] = object[key].replaceAll(marker, '');
  } };
  const content = (object, key) => {
    if (typeof object?.[key] === 'string') strip(object, key);
    else if (Array.isArray(object?.[key])) object[key].forEach(part => strip(part, 'text'));
  };
  if (provider === 'anthropic') content(copy, 'system');
  else if (provider === 'gemini') {
    for (const part of copy.systemInstruction?.parts || copy.system_instruction?.parts || []) strip(part, 'text');
  } else {
    strip(copy, 'instructions');
    for (const message of [...(Array.isArray(copy.messages) ? copy.messages : []), ...(Array.isArray(copy.input) ? copy.input : [])])
      if (['system', 'developer'].includes(message?.role)) content(message, 'content');
  }
  if (admitted !== 1 || total !== 1) throw Object.assign(fail('No exact model-route capability was supplied by the mandatory prompt hook.', 'OPENCLAW_MODEL_ADMISSION', 403),
    { admissionCounts: { system: admitted, total } });
  return copy;
}

/** Resolve only model protocol paths, never an arbitrary request URL. */
export function providerRequest(config, incomingPath, body, { openCodeSession, maxTokens } = {}) {
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
  const clean = structuredClone(body);
  if (config.provider === "gemini") delete clean.model; else clean.model = config.model;
  // Native chat.send may otherwise select the model catalogue ceiling instead
  // of the caller's per-turn allowance. Enforce the private admitted budget at
  // every provider forward, including later tool-loop calls.
  if (maxTokens !== undefined || config.maxOutputTokens !== undefined) {
    const ceiling = Math.min(maxTokens ?? 32768, config.maxOutputTokens ?? 32768);
    if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 32768)
      throw Object.assign(fail('The admitted output allowance is invalid.', 'OPENCLAW_OUTPUT_BUDGET', 422), { stage: 'generation' });
    const cap = (object, key) => {
      const value = object[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw Object.assign(fail('The native output allowance is invalid.', 'OPENCLAW_OUTPUT_BUDGET', 422), { stage: 'generation' });
      object[key] = Math.min(value ?? ceiling, ceiling);
    };
    if (config.provider === 'openai') cap(clean, 'max_output_tokens');
    else if (config.provider === 'anthropic') cap(clean, 'max_tokens');
    else if (config.provider === 'gemini') {
      const invalid = () => Object.assign(fail('The native output configuration is ambiguous or invalid.', 'OPENCLAW_OUTPUT_BUDGET', 422), { stage: 'generation' });
      if (clean.generation_config !== undefined) {
        if (clean.generationConfig !== undefined) throw invalid();
        clean.generationConfig = clean.generation_config; delete clean.generation_config;
      }
      clean.generationConfig ??= {};
      if (typeof clean.generationConfig !== 'object' || Array.isArray(clean.generationConfig)) throw invalid();
      const settings = clean.generationConfig;
      if (settings.max_output_tokens !== undefined) {
        if (!Number.isSafeInteger(settings.max_output_tokens) || settings.max_output_tokens < 1) throw invalid();
        if (settings.maxOutputTokens !== undefined && (!Number.isSafeInteger(settings.maxOutputTokens) || settings.maxOutputTokens < 1)) throw invalid();
        settings.maxOutputTokens = Math.min(settings.maxOutputTokens ?? settings.max_output_tokens, settings.max_output_tokens);
        delete settings.max_output_tokens;
      }
      cap(settings, 'maxOutputTokens');
    } else {
      const usesCompletion = Object.hasOwn(clean, 'max_completion_tokens');
      cap(clean, usesCompletion ? 'max_completion_tokens' : 'max_tokens');
      if (usesCompletion && Object.hasOwn(clean, 'max_tokens')) cap(clean, 'max_tokens');
    }
  }
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const endpoint = new URL(config.baseUrl);
  if (config.provider === 'compatible' && config.apiKey === 'chainchat-free-tier' &&
      config.baseUrl === 'https://cyphertempre.ai/api/free-model/v1') {
    if (typeof openCodeSession !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(openCodeSession))
      throw fail('The public model session correlation is unavailable.', 'OPENCLAW_PROVIDER_SESSION');
    headers['x-chainchat-session'] = openCodeSession;
    headers['user-agent'] = 'CypherTempre-ChainChat';
  }
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
  fetchImpl = fetch, spawnImpl = spawn, onDiagnostic, browserService, serviceEnvironment = () => ({}), serviceSecrets = () => [], modelContextTokens } = {}) {
  if (!stateDir || !packageRoot || !pluginPath || !broker || typeof broker.registerInvocation !== "function" ||
      typeof broker.assertCandidate !== "function") throw new TypeError("A local OpenClaw runtime, plugin and enforcement broker are required.");
  if (modelContextTokens !== undefined && (!Number.isSafeInteger(modelContextTokens) || modelContextTokens < 16384 || modelContextTokens > 131072))
    throw new TypeError('The private native model context cap must be an integer from 16384 through 131072.');
  const controlWatchdogTimeoutMs = nativeControlWatchdogMs(requestTimeoutMs);
  const directory = path.resolve(stateDir), upstream = path.resolve(packageRoot), plugin = path.resolve(pluginPath);
  // Private transport identity remains stable so native session/goal storage
  // survives restarts without retaining a stale loopback model endpoint/token.
  // Real BYOK credentials are never stored in that identity or native config.
  const providerSessions = new WeakMap();
  let child = null, proxy = null, port = null, proxyPort = null, active = null, queue = Promise.resolve(), startup = null, stopping = null, stoppingChild = null;
  let gatewayToken = secret(), proxyToken = secret(), closed = false;
  let identity = null, nativeClient = null, nativeConnection = null, lastConfiguration = null, pendingOverlay = null;
  let browserHosts = [], reasoningCapable = false, capabilitiesInitialized = false;
  let contextWindow = modelContextTokens || 131072, outputCeiling = 32768;
  let managedServices = {};
  let lastServiceEnvironmentHash = null;
  const nativeEvents = new Set();
  const privateServiceSecrets = () => [gatewayToken, proxyToken, broker.token, ...(serviceSecrets() || []), ...(browserService?.redactionSecrets?.() || [])]
    .filter(value => typeof value === 'string' && value.length > 0);
  const checkServiceIsolation = value => {
    for (const secret of privateServiceSecrets()) {
      for (const encoded of new Set([secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')]))
        assertCredentialIsolation({ apiKey: encoded }, value);
    }
  };
  function serviceEnvironmentSnapshot() {
    const values = serviceEnvironment();
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.entries(values).some(([name, value]) =>
        !/^CHAINCHAT_CHANNEL_[A-F0-9]{32}_[A-Z0-9_]+$/.test(name) || typeof value !== 'string' || value.length > 65536 || /\0/.test(value)))
      throw fail('Private native channel environment is invalid.', 'OPENCLAW_SERVICE_DENIED', 403);
    return { values, hash: createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b))))).digest('hex') };
  }
  const status = () => ({ backend: "openclaw", version: OPENCLAW_VERSION, running: Boolean(child && child.exitCode === null && child.signalCode === null),
    localOnly: true, credentials: "session-memory", contextPolicy: structuredClone(CONTEXT_POLICY), hostTools: toolsPolicy.deny?.includes("*") ? "disabled" : "scoped-per-invocation" });
  async function stopChild({ force = false } = {}) {
    if (force) {
      // A missing assembly capability is a runtime integrity fault. Terminate
      // this exact owned process before acknowledging a failed model request:
      // graceful shutdown could let upstream persist a fallback summary first.
      const owned = child || stoppingChild; child = null;
      const client = nativeClient; nativeClient = null; nativeConnection = null;
      if (owned && owned.exitCode === null && owned.signalCode === null) {
        owned.kill('SIGKILL');
        await waitForExit(owned, 5000);
        if (owned.exitCode === null && owned.signalCode === null)
          throw fail('The isolated runtime could not be stopped after an integrity fault.', 'OPENCLAW_STOP_FAILED');
      }
      await client?.stopAndWait({ timeoutMs: 2000 }).catch(() => {});
      return;
    }
    if (stopping) return stopping;
    const owned = child; child = null;
    if (!owned || owned.exitCode !== null || owned.signalCode !== null) {
      const client = nativeClient; nativeClient = null; nativeConnection = null;
      await client?.stopAndWait({ timeoutMs: 2000 }).catch(() => {}); return;
    }
    stoppingChild = owned;
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
    })().finally(() => { stopping = null; stoppingChild = null; });
    return stopping;
  }
  async function handleProxy(request, response) {
    const current = active;
    let admitted = false;
    try {
      if (request.headers.origin || !isLoopback(request.socket.remoteAddress) || !authorized(request.headers.authorization ||
          (request.headers["x-api-key"] ? `Bearer ${request.headers["x-api-key"]}` : request.headers["x-goog-api-key"] ? `Bearer ${request.headers["x-goog-api-key"]}` :
            new URL(request.url, "http://127.0.0.1").searchParams.get("key") ? `Bearer ${new URL(request.url, "http://127.0.0.1").searchParams.get("key")}` : ""), proxyToken))
        throw fail("Local provider authentication required.", "OPENCLAW_PROXY_AUTH", 401);
      if (current?.kind === 'compaction') {
        // Reviewed summaries use the parent broker's direct provider route.
        // Any child inference here is an unadmitted legacy summarizer; stop it
        // before even returning an error that could trigger a fallback write.
        try { await stopChild({ force: true }); } finally { current.controller.abort(); }
        throw fail('Unadmitted native compaction inference was held.', 'OPENCLAW_MODEL_ADMISSION', 403);
      }
      if (request.method !== "POST" || !current || current.controller.signal.aborted)
        throw fail("No admitted local model invocation.", "OPENCLAW_PROXY_INACTIVE", 409);
      await assertEnforcementHealthy({ duringStartup: true });
      if (current !== active || current.controller.signal.aborted)
        throw fail('The model invocation ended before forwarding.', 'REQUEST_CANCELLED', 499);
      const raw = await collect(request), received = JSON.parse(raw.toString("utf8"));
      let decoded;
      try { decoded = consumeModelRouteCapability(received, current.config.provider, current.modelRouteCapability); }
      catch (error) {
        // No response (including an HTTP error) reaches the native summarizer
        // while it could still write a deterministic fallback to its transcript.
        try { await stopChild({ force: true }); }
        finally { current.controller.abort(); }
        throw error;
      }
      checkServiceIsolation(decoded);
      admitted = true;
      const upstreamRequest = providerRequest(current.config, request.url, decoded, {
        openCodeSession: current.openCodeSession, maxTokens: current.args.maxTokens || 4096 });
      {
        // This is a bounded UTF-8 estimate, not a provider-specific tokenizer.
        // It catches plainly oversized first turns before a remote rejection.
        const inputEstimate = Math.ceil(Buffer.byteLength(JSON.stringify(upstreamRequest.body), 'utf8') / 3);
        const output = Math.min(current.args.maxTokens || 4096, current.config.maxOutputTokens || 32768);
        if (inputEstimate + output > Math.min(current.config.contextWindow ?? contextWindow, contextWindow))
          throw Object.assign(fail('The active request exceeds the configured model context window.', 'OPENCLAW_CONTEXT_BUDGET', 422), { stage: 'context' });
      }
      if (current !== active) throw fail("The model invocation ended.", "REQUEST_CANCELLED", 499);
      emit(current.context, "model", "started", "OpenClaw provider inference");
      let result;
      try { result = await fetchImpl(upstreamRequest.url, { method: "POST", headers: upstreamRequest.headers,
        body: JSON.stringify(upstreamRequest.body), redirect: "error", signal: current.controller.signal }); }
      catch (error) {
        if (current.controller.signal.aborted) throw error;
        throw Object.assign(fail('The provider connection failed.', 'PROVIDER_CONNECTION_ERROR'), { stage: 'generation' });
      }
      if (!result.ok) {
        await result.body?.cancel();
        throw Object.assign(fail(result.status === 429 ? 'The provider rate limit or quota was reached.'
          : 'The provider rejected the model request. Check its model, endpoint and limits.',
          result.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_HTTP_ERROR', result.status === 429 ? 429 : 502), { stage: 'generation' });
      }
      const payload = await collect(result.body); inspectResponse(current.config, payload); checkServiceIsolation(payload.toString('utf8'));
      assertProviderCompletion(current.config.provider, payload);
      if (current !== active || current.controller.signal.aborted) throw fail("The model invocation ended.", "REQUEST_CANCELLED", 499);
      current.providerError = null;
      emit(current.context, "model", "completed", "OpenClaw provider inference");
      response.writeHead(200, { "content-type": String(result.headers.get("content-type") || "application/json"), "cache-control": "no-store" });
      response.end(payload);
    } catch (error) {
      if (admitted && current === active && !current.providerError)
        current.providerError = safeInvocationError(error, 'generation');
      onDiagnostic?.(`[chainchat] private model request held code=${/^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'PROVIDER_FAILED'}${error.admissionCounts ? ` systemMarkers=${error.admissionCounts.system} totalMarkers=${error.admissionCounts.total}` : ''}\n`);
      emit(current?.context, "model", "held", "OpenClaw provider held");
      if (!response.headersSent) response.writeHead(Number.isInteger(error.status) ? error.status : 502,
        { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { message: "The local provider request was held.", type: "chainchat_provider_error" } }));
    }
  }
  async function start() {
    if (closed) throw fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED");
    if (startup) return startup;
    if (child && child.exitCode === null && child.signalCode === null) {
      await assertEnforcementHealthy({ duringStartup: true });
      return status();
    }
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
          reasoning: reasoningCapable, input: ["text"], contextWindow, maxTokens: Math.min(outputCeiling, contextWindow - 1),
          ...(modelContextTokens !== undefined ? { contextTokens: modelContextTokens } : {}),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      }]));
      const baseConfiguration = { gateway: { mode: "local", bind: "loopback", port,
          auth: { mode: "token", token: "${CHAINCHAT_GATEWAY_TOKEN}" }, controlUi: { enabled: false },
          http: { endpoints: { chatCompletions: { enabled: true } } } },
        agents: { defaults: { workspace, skipBootstrap: true, model: { primary: "chainchat-compatible/route" },
          compaction: { memoryFlush: { enabled: false } },
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
        plugins: { enabled: true, allow: ["cypher-tempre-poi", "browser"], slots: { contextEngine: "cypher-tempre-poi" }, load: { paths: [plugin] }, entries: {
          browser: { enabled: true },
          "cypher-tempre-poi": { enabled: true, hooks: { allowConversationAccess: true, allowPromptInjection: true }, config: {
            brokerUrl: brokerUrl.href.replace(/\/$/, ""), brokerTokenEnv: "CHAINCHAT_BROKER_TOKEN" } } } } };
      const controlledConfiguration = mergeControlOverlay(baseConfiguration, managedServices);
      const overlay = pendingOverlay || (await readControlOverlay(directory)).patch;
      const configuration = mergeControlOverlay(controlledConfiguration, overlay);
      lastConfiguration = controlledConfiguration;
      const configPath = path.join(directory, "gateway.json"); await atomicJson(configPath, configuration);
      // Avoid importing other agents' credentials, diagnostics, preload scripts,
      // proxy settings or OpenClaw configuration into this managed child.
      const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
        !/^(OPENCLAW_|CHAINCHAT_|CT_|OTEL_|SENTRY_)/i.test(name) &&
        !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) &&
        !/^(?:NODE_OPTIONS|NODE_INSPECT_RESUME_ON_START|(?:HTTPS?|ALL|NO)_PROXY)$/i.test(name)));
      Object.assign(environment, { OPENCLAW_STATE_DIR: runtimeState, OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_NO_RESPAWN: "1", CHAINCHAT_GATEWAY_TOKEN: gatewayToken,
        CHAINCHAT_PROVIDER_TOKEN: proxyToken, CHAINCHAT_BROKER_TOKEN: broker.token,
        NO_PROXY: "127.0.0.1,localhost,::1" });
      if (!Object.values(managedServices.channels || {}).some(channel => channel && channel.enabled !== false)) environment.OPENCLAW_SKIP_CHANNELS = '1';
      const serviceEnv = serviceEnvironmentSnapshot();
      Object.assign(environment, serviceEnv.values);
      const bootstrap = 'import { pathToFileURL } from "node:url"; process.on("message", message => { if (message?.type === "chainchat:shutdown") { process.emit("SIGTERM"); if (process.connected) process.disconnect(); } }); await import(pathToFileURL(process.argv[1]).href);';
      if (closed) throw fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED");
      child = spawnImpl(nodePath, ["--input-type=module", "--eval", bootstrap, path.join(upstream, "openclaw.mjs"), "gateway", "run", "--port", String(port), "--bind", "loopback"],
        { cwd: directory, env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32" });
      lastServiceEnvironmentHash = serviceEnv.hash;
      let spawnError = false;
      child.on("error", () => { spawnError = true; });
      for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => {
        let line = chunk.toString("utf8");
        for (const token of [gatewayToken, proxyToken, broker.token, active?.config?.apiKey, active?.modelRouteCapability, ...privateServiceSecrets()].filter(Boolean)) line = line.split(token).join("[REDACTED]");
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
          if (response.ok) { const result = await response.json(); if (result.data?.some(value => value.id === "openclaw/default" || value.id === "openclaw/main")) {
            await assertEnforcementHealthy({ duringStartup: true });
            return status();
          } }
        } catch (error) {
          if (['OPENCLAW_ENFORCEMENT_UNHEALTHY', 'OPENCLAW_STOP_FAILED'].includes(error.code)) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw fail("The local OpenClaw gateway did not become ready in time.", "OPENCLAW_START_TIMEOUT");
    })().catch(async error => { await stopChild(); throw error; }).finally(() => { startup = null; });
    return startup;
  }
  async function nativeConnectionReady({ duringStartup = false } = {}) {
    if (!duringStartup) await start();
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
          // chat.send acknowledges before an agent finishes. Long verified
          // hooks can then be quiet for more than the SDK's default 60s tick
          // window. Keep the watchdog bounded by the invocation plus cleanup;
          // the independent invocation timer still cancels the actual work.
          tickWatchTimeoutMs: controlWatchdogTimeoutMs,
          scopes: ['operator.read', 'operator.write', 'operator.admin'], deviceIdentity, sharedStateMode: 'read-only',
          onHelloOk() { clearTimeout(timer); resolve(client); },
          onConnectError() { clearTimeout(timer); client.stop(); reject(fail('Native OpenClaw control authentication failed.', 'OPENCLAW_CONTROL_AUTH')); },
          onEvent(event) { for (const listener of nativeEvents) { try { listener(event); } catch {} } },
          onClose(code, reason) { if (active?.nativeRun) active.nativeClose?.(code, reason); },
        });
        nativeClient = client; client.start();
      });
    })().catch(error => { nativeConnection = null; throw error; });
    return nativeConnection;
  }
  async function nativeRpc(method, params, { timeoutMs = 30000 } = {}) {
    const client = await nativeConnectionReady();
    return client.request(method, params, { timeoutMs });
  }
  const subscribeNativeEvents = listener => {
    if (typeof listener !== 'function') throw new TypeError('A private native event listener is required.');
    nativeEvents.add(listener); return () => nativeEvents.delete(listener);
  };
  const services = createPrivateNativeServices({ rpc: nativeRpc, subscribe: subscribeNativeEvents, nodePath });
  const controls = createNativeControls({
    rpc: nativeRpc, getRuntime: status, readOverlay: () => readControlOverlay(directory),
    sanitize: value => redactNativeControl(value, [gatewayToken, proxyToken, broker.token, identity?.proxyToken, identity?.gatewayToken,
      ...privateServiceSecrets()]),
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
        const safe = redactNativeControl({ code: error?.code || 'OPENCLAW_CONFIG_APPLY_FAILED', message: String(error?.message || 'Native configuration apply failed.') },
          [gatewayToken, proxyToken, broker.token, active?.config?.apiKey, ...privateServiceSecrets()].filter(Boolean));
        onDiagnostic?.(`[chainchat] native settings apply held ${JSON.stringify(safe)}\n`);
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
  function validatedManagedServices(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
        Object.keys(patch).some(key => !['browser', 'cron', 'channels', 'plugins'].includes(key)) || Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024)
      throw fail('Invalid private native service configuration.', 'OPENCLAW_SERVICE_DENIED', 403);
    for (const value of Object.values(patch)) if (!value || typeof value !== 'object' || Array.isArray(value))
      throw fail('Native service sections must be objects.', 'OPENCLAW_SERVICE_DENIED', 403);
    if (patch.cron && (Object.keys(patch.cron).some(key => key !== 'enabled') || typeof patch.cron.enabled !== 'boolean'))
      throw fail('Only managed scheduler activation is admitted.', 'OPENCLAW_SERVICE_DENIED', 403);
    if (patch.plugins && (patch.plugins.enabled === false ||
        Object.hasOwn(patch.plugins, 'slots') && (!patch.plugins.slots || Array.isArray(patch.plugins.slots) ||
          Object.hasOwn(patch.plugins.slots, 'contextEngine') && patch.plugins.slots.contextEngine !== 'cypher-tempre-poi') ||
        Object.hasOwn(patch.plugins, 'entries') && (!patch.plugins.entries || Array.isArray(patch.plugins.entries) || Object.hasOwn(patch.plugins.entries, 'cypher-tempre-poi') ||
          Object.hasOwn(patch.plugins.entries, 'browser') && patch.plugins.entries.browser?.enabled !== true) ||
        Object.hasOwn(patch.plugins, 'allow') && (!Array.isArray(patch.plugins.allow) || !['cypher-tempre-poi', 'browser'].every(id => patch.plugins.allow.includes(id))) ||
        Object.hasOwn(patch.plugins, 'deny') && (!Array.isArray(patch.plugins.deny) || ['cypher-tempre-poi', 'browser'].some(id => patch.plugins.deny.includes(id))) ||
        Object.hasOwn(patch.plugins, 'load') && (!patch.plugins.load || !Array.isArray(patch.plugins.load.paths) || !patch.plugins.load.paths.map(value => path.resolve(value)).includes(plugin))))
      throw fail('Managed services cannot replace mandatory PoI enforcement.', 'OPENCLAW_SERVICE_DENIED', 403);
    return structuredClone(patch);
  }
  async function applyManagedServices(patch, { forceReload = false, replaceChannelAccount } = {}) {
    if (typeof forceReload !== 'boolean') throw fail('Invalid private native service reload option.', 'OPENCLAW_SERVICE_DENIED', 403);
    if (active) throw fail('Wait for the current model run before changing native services.', 'OPENCLAW_CONTROL_BUSY', 409);
    const previous = managedServices, validated = validatedManagedServices(patch);
    let seed = previous;
    if (replaceChannelAccount !== undefined) {
      const selection = replaceChannelAccount, validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) &&
        !['__proto__', 'constructor', 'prototype'].includes(value);
      if (!selection || typeof selection !== 'object' || Array.isArray(selection) ||
          Object.keys(selection).length !== 2 || Object.keys(selection).some(key => !['channelId', 'accountId'].includes(key)) ||
          !validId(selection.channelId) || !validId(selection.accountId) ||
          !Object.hasOwn(validated.channels || {}, selection.channelId) ||
          !Object.hasOwn(validated.channels[selection.channelId]?.accounts || {}, selection.accountId))
        throw fail('An exact private native channel account replacement is required.', 'OPENCLAW_SERVICE_DENIED', 403);
      seed = structuredClone(previous);
      if (seed.channels?.[selection.channelId]?.accounts) delete seed.channels[selection.channelId].accounts[selection.accountId];
    }
    const next = mergeControlOverlay(seed, validated);
    if (!forceReload && JSON.stringify(previous) === JSON.stringify(next) && lastServiceEnvironmentHash === serviceEnvironmentSnapshot().hash) return status();
    managedServices = next;
    // A private service may be staged before the first start. Avoid starting a
    // Gateway only to stop it immediately once its owned browser lease exists.
    if (!child && !startup && !proxy) return status();
    try { await stopChild(); await start(); return status(); }
    catch (error) { managedServices = previous; await stopChild(); await start().catch(() => {}); throw error; }
  }
  async function initializeModelCapabilities() {
    if (capabilitiesInitialized) return;
    const file = path.join(directory, 'model-capabilities.json');
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1000 || process.platform !== 'win32' && (stat.mode & 0o077))
        throw fail('The private model capability setting requires local inspection.', 'OPENCLAW_CONFIG_REJECTED');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (![1, 2].includes(value.version) || typeof value.reasoning !== 'boolean' || value.version === 2 &&
          (!Number.isSafeInteger(value.contextWindow) || value.contextWindow < 4096 || value.contextWindow > 2097152 ||
           !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 128 || value.maxOutputTokens > 32768))
        throw fail('The saved model capability setting is invalid.', 'OPENCLAW_CONFIG_REJECTED');
      reasoningCapable = value.reasoning;
      if (value.version === 2) {
        contextWindow = Math.min(value.contextWindow, modelContextTokens || 2097152);
        outputCeiling = value.maxOutputTokens;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    capabilitiesInitialized = true;
  }
  async function synchronizeModelCapabilities(capabilities) {
    await initializeModelCapabilities();
    const nextReasoning = typeof capabilities?.reasoning === 'boolean' ? capabilities.reasoning : reasoningCapable;
    const nextContext = Math.min(capabilities?.contextWindow ?? contextWindow, modelContextTokens || 2097152);
    const nextOutput = capabilities?.maxOutputTokens ?? outputCeiling;
    if (!Number.isSafeInteger(nextContext) || nextContext < 4096 || nextContext > 2097152 ||
        !Number.isSafeInteger(nextOutput) || nextOutput < 128 || nextOutput > 32768)
      throw fail('The selected model limits are invalid.', 'OPENCLAW_CONFIG_REJECTED');
    if (nextReasoning === reasoningCapable && nextContext === contextWindow && nextOutput === outputCeiling) return;
    reasoningCapable = nextReasoning; contextWindow = nextContext; outputCeiling = nextOutput;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await atomicJson(path.join(directory, 'model-capabilities.json'), { version: 2, reasoning: reasoningCapable,
      contextWindow, maxOutputTokens: outputCeiling });
    await stopChild();
  }
  async function nativeTurn(params, controller, { allowEmptyFinal = false } = {}) {
    await assertEnforcementHealthy();
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
        if (!candidate?.trim() && !allowEmptyFinal) { settled = true; done.reject(fail('OpenClaw ended this turn without an approved final reply. Native preflight or output policy may have held the request. No unreviewed text was released.', 'OPENCLAW_EMPTY_RESPONSE')); }
        else { settled = true; done.resolve({ text: candidate, usage: payload.message?.usage || {} }); }
      }
    };
    const aborted = () => {
      void client.request('chat.abort', { sessionKey: params.sessionKey, runId: expectedRun }).catch(() => {});
      if (!settled) done.reject(fail('The native OpenClaw turn was cancelled.', 'REQUEST_CANCELLED', 499));
    };
    if (active) { active.nativeRun = true; active.nativeClose = (code, reason) => { if (!settled) done.reject(nativeControlCloseError(code, reason)); }; }
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
  async function assertEnforcementHealthy({ duringStartup = false } = {}) {
    try {
      const owned = child;
      if (!owned || owned.exitCode !== null || owned.signalCode !== null)
        throw fail('No owned context engine is running.', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 503);
      const client = await nativeConnectionReady({ duringStartup });
      const result = await client.request('chainchat.enforcementHealth', {});
      if (owned !== child || owned.exitCode !== null || owned.signalCode !== null ||
          result?.version !== 1 || result.pluginId !== 'cypher-tempre-poi' || result.engineId !== 'cypher-tempre-poi' || result.healthy !== true)
        throw fail('The mandatory context engine is not healthy.', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 503);
    } catch {
      // Provider-route capabilities alone cannot stop a native deterministic
      // fallback from rewriting its transcript. Validate the actual mandatory
      // factory before entering any chat/compaction lifecycle, and fail-stop
      // this exact owned process if its guard is missing or latched unhealthy.
      try { await stopChild({ force: true }); }
      finally { active?.controller.abort(); }
      throw fail('The mandatory Proof of Interaction runtime is unavailable. This turn was held before native fallback; restart the local app after inspecting its runtime.', 'OPENCLAW_ENFORCEMENT_UNHEALTHY', 503);
    }
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
    config = validateProvider(config); assertCredentialIsolation(config, args); checkServiceIsolation(args);
    if (!providerSessions.has(rawConfig)) providerSessions.set(rawConfig, randomUUID());
    const openCodeSession = providerSessions.get(rawConfig);
    await synchronizeModelCapabilities({ ...context.modelCapabilities,
      contextWindow: config.contextWindow ?? (modelContextTokens || 131072), maxOutputTokens: config.maxOutputTokens ?? 32768 });
    let browserInvocation = null;
    try {
    const inspectNativeTarget = createNativeBrowserInspector({ rpc: nativeRpc, assertIsolation: checkServiceIsolation,
      assertCurrent: async () => {
        if (active?.context !== context || active.controller.signal.aborted || context.purpose !== 'candidate' || browserInvocation?.profile !== 'chainchat-owned')
          throw fail('No current owned browser invocation admits native perception.', 'OPENCLAW_BROWSER_INSPECTION_DENIED', 403);
        await context.authorize?.();
      } });
    browserInvocation = browserService?.prepareInvocation ? await browserService.prepareInvocation({ ...context, inspectNativeTarget }) : null;
    if (browserInvocation?.config) await applyManagedServices({ browser: browserInvocation.config.browser || browserInvocation.config });
    // Chromium cannot pin a hostname to the addresses reviewed by the broker.
    // Keep strict hostname navigation closed until a managed browser network
    // adapter exists; allowedHostnames would otherwise trust private addresses.
    const desiredBrowserHosts = [];
    if (JSON.stringify(desiredBrowserHosts) !== JSON.stringify(browserHosts)) { browserHosts = desiredBrowserHosts; await stopChild(); }
    checkSignal(args.signal); await start(); await assertEnforcementHealthy(); checkSignal(args.signal);
    const invocationId = randomUUID();
    const modelRouteCapability = secret();
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
    const registeredContext = { ...context, modelRouteCapability, assertContentIsolation: checkServiceIsolation, ...(browserInvocation ? { browserInvocation } : {}),
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
    // Official native compaction runs before admitting/appending the current
    // input. Never write through a second SessionManager during assemble: that
    // would stale OpenClaw's active writer and its transcript read fence.
    if (native && context.purpose === 'candidate' && context.nativeIdentity && selected?.entry?.sessionId &&
        typeof broker.estimateInvocation === 'function') {
      const estimate = await broker.estimateInvocation({ config, args, context: registeredContext, sessionKey, invocationId });
      const reserve = 12000 + Math.min(args.maxTokens || 4096, config.maxOutputTokens || 32768) + Math.ceil(Buffer.byteLength(args.messages.at(-1).content, 'utf8') / 4);
      const limit = Math.floor(contextWindow * 0.80);
      const readStats = async () => {
        const result = await nativeRpc('chainchat.compactionStats', { sessionKey, sessionId: selected.entry.sessionId });
        if (result?.version !== 1 || typeof result.known !== 'boolean' || result.known &&
            (result.sessionKey !== sessionKey || result.sessionId !== selected.entry.sessionId ||
             !Number.isSafeInteger(result.estimatedTokens) || result.estimatedTokens < 0 || typeof result.compactable !== 'boolean'))
          throw fail('Native context budget could not be verified.', 'OPENCLAW_COMPACTION_HELD', 422);
        return result;
      };
      let stats = await readStats();
      // An existing pre-upgrade session has not yet registered its trusted SDK
      // target. The official lifecycle seeds it; client paths are never used.
      if (!stats.known) {
        await performCompaction(config, { identity: context.nativeIdentity, signal: args.signal }, context);
        stats = await readStats();
        if (!stats.known) throw fail('The native session target is not available for budget verification.', 'OPENCLAW_COMPACTION_HELD', 422);
      }
      for (let pass = 0; stats.estimatedTokens + estimate.estimatedTokens + reserve > limit; pass++) {
        if (!stats.compactable || pass >= 8)
          throw fail('The current request and retained native turns exceed the safe context budget. Shorten this input or start a new native conversation.', 'OPENCLAW_CONTEXT_BUDGET', 422);
        const before = stats;
        const compacted = await performCompaction(config, { identity: context.nativeIdentity, signal: args.signal }, context);
        stats = await readStats();
        if (compacted.compacted !== true || !stats.known || stats.branchSha256 === before.branchSha256 || stats.estimatedTokens >= before.estimatedTokens)
          throw fail('Proof of Interaction held automatic compaction; the next turn was not admitted.', 'OPENCLAW_COMPACTION_HELD', 422);
      }
    }
    const claim = await broker.registerInvocation({ config, args, context: registeredContext, sessionKey, invocationId });
    if (!claim || typeof claim.claimId !== "string" || claim.sessionKey !== sessionKey)
      throw fail("The local enforcement broker refused the invocation.", "OPENCLAW_ADMISSION_FAILED", 422);
    const abort = () => { controller.abort(); void stopChild(); };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; abort(); }, requestTimeoutMs);
    args.signal?.addEventListener("abort", abort, { once: true });
    active = { config, args, context, controller, claimId: claim.claimId, sessionKey, openCodeSession, modelRouteCapability };
    let responseComplete = false;
    try {
      checkSignal(args.signal);
      if (Object.keys(inherited).length && !native) await nativeRpc('sessions.patch', { key: sessionKey, ...inherited });
      if (native) {
        await nativeRpc('sessions.patch', { key: sessionKey, model: `${PROVIDERS[config.provider].id}/route` });
        const generated = await nativeTurn({ sessionKey, message: args.messages.at(-1).content, idempotencyKey: native.goalOperation?.operationId || invocationId,
          deliver: false, ...(native.intent ? { intent: native.intent } : {}), ...(native.goalOperation ? { goalOperation: native.goalOperation } : {}) }, controller);
        responseComplete = true; assertCredentialIsolation(config, generated); checkServiceIsolation(generated);
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
      inspectResponse(config, buffer); checkServiceIsolation(buffer.toString('utf8'));
      const result = JSON.parse(buffer.toString("utf8")), candidate = result.choices?.[0]?.message?.content;
      if (typeof candidate !== "string" || !candidate.trim()) throw fail("OpenClaw returned no final candidate.", "OPENCLAW_EMPTY_RESPONSE");
      const enforcement = await broker.assertCandidate({ claimId: claim.claimId, candidate });
      checkSignal(args.signal); if (controller.signal.aborted) throw fail("The OpenClaw run was cancelled or timed out.", "REQUEST_CANCELLED", 499);
      return { text: candidate, enforcement, usage: { input: result.usage?.prompt_tokens || 0, output: result.usage?.completion_tokens || 0 },
        runtime: { backend: "openclaw", version: OPENCLAW_VERSION, invocationId } };
    } catch (error) {
      const providerError = active?.providerError;
      const brokerError = await broker.invocationError?.({ claimId: claim.claimId });
      controller.abort(); if (!responseComplete) await stopChild();
      if (args.signal?.aborted) throw fail("The OpenClaw run was cancelled.", "REQUEST_CANCELLED", 499);
      await context.authorize?.();
      if (timedOut) throw Object.assign(fail('The provider did not complete the native turn in time.', 'PROVIDER_TIMEOUT', 504), { stage: 'generation' });
      const specific = invocationError(providerError || brokerError);
      if (specific) throw specific;
      throw error;
    } finally {
      clearTimeout(timer); args.signal?.removeEventListener("abort", abort); active = null;
      await broker.finishInvocation?.({ claimId: claim.claimId });
    }
    } finally { await browserInvocation?.releaseInvocation?.(); }
  }
  function generate(config, args, context) {
    if (closed) return Promise.reject(fail("This OpenClaw manager is closed.", "OPENCLAW_CLOSED"));
    const operation = queue.then(() => perform(config, args, context)); queue = operation.catch(() => {}); return operation;
  }
  async function performCompaction(rawConfig, { identity: nativeIdentity, instructions = '', signal } = {}, context) {
    if (closed) throw fail('This OpenClaw manager is closed.', 'OPENCLAW_CLOSED');
    if (!context || context.purpose !== 'candidate' || typeof instructions !== 'string' || Buffer.byteLength(instructions) > 16000 ||
        typeof broker.registerCompactionInvocation !== 'function' || typeof broker.finishCompactionInvocation !== 'function')
      throw fail('A privately admitted native compaction operation is required.', 'OPENCLAW_COMPACTION_HELD', 422);
    const config = validateProvider(rawConfig), sessionKey = controlSessionKey(nativeIdentity);
    assertCredentialIsolation(config, { instructions }); checkServiceIsolation({ instructions }); checkSignal(signal);
    await synchronizeModelCapabilities({ ...context.modelCapabilities,
      contextWindow: config.contextWindow ?? (modelContextTokens || 131072), maxOutputTokens: config.maxOutputTokens ?? 32768 });
    await start(); await assertEnforcementHealthy();
    const selected = await nativeRpc('sessions.describe', { key: sessionKey, includeDerivedTitles: false, includeLastMessage: false });
    if (!selected.session?.sessionId) return { ok: true, compacted: false, reason: 'No native conversation exists for this Timechain yet.' };
    const operationId = randomUUID(), controller = new AbortController();
    const abort = () => { controller.abort(); void stopChild(); };
    const timer = setTimeout(abort, requestTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    let claim;
    try {
      checkSignal(signal);
      claim = await broker.registerCompactionInvocation({ config, context: { ...context, signal: controller.signal, assertContentIsolation: checkServiceIsolation },
        sessionKey, sessionId: selected.session.sessionId, operationId, instructions });
      if (!claim || typeof claim.claimId !== 'string' || claim.sessionKey !== sessionKey)
        throw fail('The compaction operation was not admitted.', 'OPENCLAW_COMPACTION_HELD', 422);
      active = { kind: 'compaction', config, context, controller, sessionKey, claimId: claim.claimId };
      emit(context, 'memory', 'started', 'Reviewing native conversation compaction');
      // The selected context engine obtains its summary through the admitted
      // broker operation, never through an unregistered model or tool run.
      const result = await nativeRpc('sessions.compact', { key: sessionKey }, { timeoutMs: requestTimeoutMs });
      checkSignal(signal); checkSignal(controller.signal);
      assertCredentialIsolation(config, result); checkServiceIsolation(result);
      const safe = redactNativeControl(result, [gatewayToken, proxyToken, broker.token]);
      emit(context, 'memory', result.compacted ? 'completed' : 'held', result.compacted ? 'Native conversation compacted after PoI review' : 'Native compaction did not change the transcript');
      return safe;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      active = null;
      if (claim) await broker.finishCompactionInvocation({ claimId: claim.claimId });
    }
  }
  function compact(config, args, context) {
    const operation = queue.then(() => performCompaction(config, args, context)); queue = operation.catch(() => {}); return operation;
  }
  async function close() {
    closed = true; services.close(); active?.controller.abort(); await stopChild();
    await startup?.catch(() => {}); await stopChild();
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); proxy = null; }
  }
  return { start, generate, compact, close, status, nodePath,
    automationRpc: services.automationRpc, subscribeAutomation: services.subscribeAutomation,
    registerNativeService: services.registerNativeService,
    configureManagedServices: (patch, options) => serializedControl(() => applyManagedServices(patch, options)),
    enableManagedAutomation: () => serializedControl(() => applyManagedServices({ cron: { enabled: true } })),
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
