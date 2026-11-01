import { createHash, randomUUID } from "node:crypto";
import { createReviewedContextEngine } from './compaction.mjs';
import { createNativeCompactionStats, COMPACTION_STATS_METHOD } from './compaction-stats.mjs';
import { createChannelHooks } from './channels.mjs';
import { sanitizeOwnedBrowserResult } from './browser-results.mjs';
import { managedServicesFactory } from './services.mjs';

export const PLUGIN_ID = "cypher-tempre-poi";
export const PROTOCOL_VERSION = 1;
const DENIED = "Proof of Interaction did not authorize this operation. Nothing may be delivered or executed.";
const MAX_BODY = 8 * 1024 * 1024;
const MAX_CONTEXT = 4 * 1024 * 1024;
const MAX_RUNS = 1024;
const RUN_TTL = 10 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;
const PURPOSES = new Set(["candidate", "utility"]);
const textHash = value => createHash("sha256").update(value, "utf8").digest("hex");
const nonempty = (value, limit = 4096) => typeof value === "string" && value.length > 0 && value.length <= limit;

function configuration(config = {}, env = process.env) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid PoI plugin configuration.");
  if (Object.keys(config).some(key => !["brokerUrl", "brokerToken", "brokerTokenEnv", "requestTimeoutMs"].includes(key)))
    throw new Error("Unexpected PoI plugin configuration.");
  let url;
  try { url = new URL(config.brokerUrl); } catch { throw new Error("The PoI broker must be a local HTTP endpoint."); }
  if (url.protocol !== "http:" || url.username || url.password || url.hash || url.search ||
      !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port)
    throw new Error("The PoI broker must use an explicit numeric loopback address and port.");
  if (config.brokerToken && config.brokerTokenEnv) throw new Error("Select one PoI broker credential source.");
  const envName = config.brokerTokenEnv || (!config.brokerToken ? "CHAINCHAT_BROKER_TOKEN" : null);
  if (envName && !/^[A-Z][A-Z0-9_]{0,127}$/.test(envName)) throw new Error("Invalid PoI credential environment variable.");
  const token = envName ? env[envName] : config.brokerToken;
  if (!nonempty(token, 4096) || token.length < 24 || /[\r\n\0]/.test(token)) throw new Error("The private PoI broker credential is unavailable.");
  const timeout = config.requestTimeoutMs ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) throw new Error("Invalid PoI request timeout.");
  return { url: url.href, token, timeout };
}

/** All exception text is intentionally replaced: transport errors may contain secrets. */
export function createBrokerClient(config, options = {}) {
  const { url, token, timeout } = configuration(config, options.env);
  const fetcher = options.fetch || fetch;
  return async function request(op, binding, fields = {}, signal) {
    const raw = JSON.stringify({ version: PROTOCOL_VERSION, op, ...binding, requestId: randomUUID(), ...fields });
    if (Buffer.byteLength(raw) > MAX_BODY) throw new Error(DENIED);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await fetcher(url, { method: "POST", redirect: "error", signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: raw });
      if (!response.ok) throw new Error(DENIED);
      if (!String(response.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new Error(DENIED);
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error(DENIED);
      const reader = response.body?.getReader();
      if (!reader) throw new Error(DENIED);
      const parts = []; let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > MAX_BODY) { await reader.cancel(); throw new Error(DENIED); }
          parts.push(Buffer.from(part.value));
        }
      } finally { reader.releaseLock(); }
      const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (value?.version !== PROTOCOL_VERSION || typeof value.allowed !== "boolean" || !PURPOSES.has(value.purpose) ||
          value.binding?.sessionKey !== binding.sessionKey || value.binding?.runId !== binding.runId)
        throw new Error(DENIED);
      return value;
    } catch { throw new Error(DENIED); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
}

function bindingFor(event = {}, context = {}) {
  const sessionKey = context.sessionKey ?? event.sessionKey;
  const runId = context.runId ?? event.runId;
  if (!nonempty(sessionKey, 2048) || !nonempty(runId, 256)) throw new Error(DENIED);
  if (event.sessionKey && context.sessionKey && event.sessionKey !== context.sessionKey) throw new Error(DENIED);
  if (event.runId && context.runId && event.runId !== context.runId) throw new Error(DENIED);
  return { sessionKey, runId };
}

function receiptFor(response, candidateSha256, now) {
  const receipt = response.receipt;
  if (response.candidateSha256 !== undefined && response.candidateSha256 !== candidateSha256) throw new Error(DENIED);
  if (response.purpose === "utility") {
    if (response.candidateSha256 !== candidateSha256 && receipt?.candidateSha256 !== candidateSha256) throw new Error(DENIED);
    return { candidateSha256, utility: true, expiresAt: now + RUN_TTL };
  }
  if (!receipt || receipt.reviewed !== true || receipt.candidateSha256 !== candidateSha256 ||
      !HASH.test(receipt.expectedHead || "") || !HASH.test(receipt.genesisHash || "")) throw new Error(DENIED);
  const timestamp = value => typeof value === "number" && Number.isFinite(value) ? value : Date.parse(value);
  const issued = timestamp(receipt.issuedAt), expires = timestamp(receipt.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now + 30000 || issued < now - RUN_TTL ||
      expires <= now || expires <= issued || expires - issued > RUN_TTL) throw new Error(DENIED);
  return { ...receipt, expiresAt: expires };
}

/** Testable hook implementation; no raw prompt, output, credential or tool argument is logged. */
export function createEnforcementHooks(request, options = {}) {
  const clock = options.now || Date.now;
  const browserPrivateValues = options.browserPrivateValues || (() => Object.entries(process.env)
    .filter(([key]) => /^CHAINCHAT_(?:GATEWAY_TOKEN|PROVIDER_TOKEN|BROKER_TOKEN|CHANNEL_[A-F0-9]{32}_[A-Z0-9_]+)$/.test(key)).map(([, value]) => value));
  const browserResult = result => sanitizeOwnedBrowserResult(result, { privateValues: browserPrivateValues() });
  const runs = new Map();
  const keyOf = binding => JSON.stringify([binding.sessionKey, binding.runId]);
  function stateFor(binding) {
    const now = clock();
    for (const [key, state] of runs) if (state.expiresAt <= now) runs.delete(key);
    const key = keyOf(binding);
    if (!runs.has(key)) {
      if (runs.size >= MAX_RUNS) throw new Error(DENIED);
      runs.set(key, { binding, purpose: null, denied: false, receipt: null, expiresAt: now + RUN_TTL });
    }
    return runs.get(key);
  }
  function accept(state, result) {
    if (result?.version !== PROTOCOL_VERSION || result.allowed !== true || !PURPOSES.has(result.purpose) ||
        result.binding?.sessionKey !== state.binding.sessionKey || result.binding?.runId !== state.binding.runId ||
        (state.purpose !== null && state.purpose !== result.purpose)) throw new Error(DENIED);
    state.purpose = result.purpose;
    return result;
  }
  async function admission(event, context) {
    const binding = bindingFor(event, context), state = stateFor(binding);
    if (state.denied) throw new Error(DENIED);
    const result = accept(state, await request("admit", binding, { input: event.currentUserMessage ?? event.prompt ?? "" }, context.abortSignal));
    state.admitted = true;
    return { state, result };
  }
  const before_agent_run = async (event, context) => {
    try { await admission(event, context); return { outcome: "pass" }; }
    catch { return { outcome: "block", reason: "PoI turn admission failed.", message: DENIED }; }
  };
  const before_agent_reply = async (event, context) => {
    try { await admission({ ...event, currentUserMessage: event.cleanedBody }, context); return { handled: false }; }
    catch { return { handled: true, reason: 'PoI turn admission failed.' }; }
  };
  const before_prompt_build = async (event, context) => {
    try {
      const { state } = await admission(event, context);
      const prepared = accept(state, await request("prepare", state.binding,
        { input: event.currentUserMessage ?? event.prompt ?? "" }, context.abortSignal));
      if (typeof prepared.context !== "string" || Buffer.byteLength(prepared.context) > MAX_CONTEXT ||
          !Array.isArray(prepared.toolsAllow) || prepared.toolsAllow.length > 100 ||
          prepared.toolsAllow.some(name => !nonempty(name, 128)) ||
          (state.purpose === "utility" && prepared.toolsAllow.length)) throw new Error(DENIED);
      state.prepared = true;
      state.toolsAllow = new Set(prepared.toolsAllow);
      // The managed context engine supplies the full prepared instructions on
      // every model iteration. Keeping them here too would duplicate the route
      // capability and would leave tool-loop continuation coverage ambiguous.
      return { appendSystemContext: '', toolsAllow: [...new Set(prepared.toolsAllow)] };
    } catch {
      try { stateFor(bindingFor(event, context)).denied = true; } catch {}
      return { appendSystemContext: DENIED, toolsAllow: [] };
    }
  };
  const before_tool_call = async (event, context) => {
    try {
      const binding = bindingFor(event, context), state = stateFor(binding);
      if (state.denied || !state.admitted || !state.prepared || state.purpose !== "candidate" ||
          !state.toolsAllow?.has(event.toolName) ||
          !nonempty(event.toolName, 128) || !event.params || typeof event.params !== "object" || Array.isArray(event.params))
        throw new Error(DENIED);
      const callId = event.toolCallId ?? context.toolCallId;
      if (!nonempty(callId, 256)) throw new Error(DENIED);
      const result = accept(state, await request("tool", binding, { tool: { name: event.toolName, params: event.params, callId } }, context.abortSignal));
      if (result.tool?.name !== event.toolName || result.tool?.callId !== callId || !result.tool.params ||
          typeof result.tool.params !== 'object' || Array.isArray(result.tool.params)) throw new Error(DENIED);
      return { block: false, params: result.tool.params };
    } catch { return { block: true, blockReason: DENIED }; }
  };
  const after_tool_call = async (event, context) => {
    try {
      const binding = bindingFor(event, context), state = stateFor(binding);
      const callId = event.toolCallId ?? context.toolCallId;
      if (state.denied || !state.prepared || !state.toolsAllow?.has(event.toolName) || !nonempty(callId, 256)) return;
      const observed = event.toolName === 'browser' && event.result ? browserResult(event.result) : event.result;
      const returnedError = observed?.isError === true || ['error', 'blocked', 'denied'].includes(observed?.details?.status) ||
        observed?.details?.ok === false || observed?.details?.success === false || Boolean(observed?.details?.error);
      accept(state, await request('tool_result', binding, { tool: { name: event.toolName, callId },
        outcome: { success: !event.error && !returnedError, result: observed ?? null, error: event.error ?
          (event.toolName === 'browser' ? 'The native browser reported an error.' : String(event.error).slice(0, 1000)) : null } }, context.abortSignal));
    } catch { /* A missing observation cannot create an approval or claim successful execution. */ }
  };
  const tool_result_persist = (event, context = {}) => {
    if ((event.toolName ?? context.toolName ?? event.message?.toolName) !== 'browser') return;
    try { return { message: browserResult(event.message) }; }
    catch {
      return { message: { role: 'toolResult', toolCallId: event.toolCallId ?? event.message?.toolCallId,
        toolName: 'browser', timestamp: event.message?.timestamp ?? clock(), isError: true,
        content: [{ type: 'text', text: 'The browser result was withheld because its private control details could not be safely reduced. Completion is unconfirmed.' }] } };
    }
  };
  const before_agent_finalize = async (event, context) => {
    const candidate = event.lastAssistantMessage;
    try {
      const binding = bindingFor(event, context), state = stateFor(binding);
      if (state.denied || !state.admitted || !state.prepared || typeof candidate !== "string" || !candidate.trim()) throw new Error(DENIED);
      const candidateSha256 = textHash(candidate);
      const result = accept(state, await request("finalize", binding, { candidate, candidateSha256 }, context.abortSignal));
      state.receipt = receiptFor(result, candidateSha256, clock());
      return { action: "continue" };
    } catch {
      try { stateFor(bindingFor(event, context)).receipt = null; } catch {}
      return { action: "revise", reason: DENIED,
        retry: { instruction: "Correct unsupported assertions or covenant conflicts; obtain a fresh PoI review before finalizing.",
          idempotencyKey: "cypher-tempre-poi-review", maxAttempts: 1 } };
    }
  };
  async function authorizeOutgoing(candidate, event, context) {
    const binding = bindingFor(event, context), state = stateFor(binding);
    const candidateSha256 = typeof candidate === "string" ? textHash(candidate) : null;
    if (!state.denied && !state.admitted && !state.prepared && candidateSha256) {
      const control = accept(state, await request('control_outgoing', binding, { candidate, candidateSha256 }, context.abortSignal));
      if (control.purpose !== 'utility') throw new Error(DENIED);
      // The broker permits one live control claim per session. A fresh private
      // attestation supersedes old command receipts, including identical replies.
      for (const [key, previous] of runs) if (previous !== state && previous.control === true && previous.binding.sessionKey === binding.sessionKey) runs.delete(key);
      state.receipt = receiptFor(control, candidateSha256, clock()); state.control = true;
      return;
    }
    if (state.denied || !state.receipt || !candidateSha256 || state.receipt.candidateSha256 !== candidateSha256 ||
        state.receipt.expiresAt <= clock()) throw new Error(DENIED);
    const response = accept(state, await request("outgoing", binding, { candidate, candidateSha256, kind: "final" }, context.abortSignal));
    if (response.candidateSha256 !== candidateSha256 && response.receipt?.candidateSha256 !== candidateSha256) throw new Error(DENIED);
  }
  const reply_payload_sending = async (event, context) => {
    try {
      if (event.kind !== "final" || !event.payload || Object.entries(event.payload).some(([key, value]) =>
        ["mediaUrl", "mediaUrls", "channelData", "buttons", "audioAsVoice", "attachments"].includes(key) && value)) throw new Error(DENIED);
      await authorizeOutgoing(event.payload.text, event, context);
      return { cancel: false };
    } catch { return { cancel: true, reason: DENIED }; }
  };
  const message_sending = async (event, context) => {
    try {
      let boundContext = context;
      // The native legacy delivery hook omits runId for pure commands. Recover
      // only a unique prior control receipt for this exact session and text;
      // the private broker must still validate its live registered run.
      if (!event.runId && !context.runId && typeof event.content === 'string') {
        const sessionKey = context.sessionKey ?? event.sessionKey;
        if (!nonempty(sessionKey, 2048) || event.sessionKey && context.sessionKey && event.sessionKey !== context.sessionKey) throw new Error(DENIED);
        const digest = textHash(event.content), now = clock();
        const matches = [...runs.values()].filter(state => state.control === true && !state.denied &&
          state.binding.sessionKey === sessionKey && state.expiresAt > now && state.receipt?.expiresAt > now && state.receipt?.candidateSha256 === digest);
        if (matches.length !== 1) throw new Error(DENIED);
        boundContext = { ...context, sessionKey, runId: matches[0].binding.runId };
      }
      await authorizeOutgoing(event.content, event, boundContext); return { cancel: false };
    }
    catch { return { cancel: true, cancelReason: DENIED }; }
  };
  const agent_end = async (event, context) => {
    try {
      const binding = bindingFor(event, context), state = stateFor(binding);
      // Delivery can occur after agent_end; retain exact receipts briefly.
      state.expiresAt = Math.min(state.expiresAt, clock() + 5 * 60 * 1000);
      await request("end", binding, { success: event.success === true });
    } catch { /* Cleanup failure cannot grant execution or delivery. */ }
  };
  const gateway_stop = async () => { runs.clear(); };
  return { before_agent_run, before_agent_reply, before_prompt_build, before_tool_call, after_tool_call, tool_result_persist, before_agent_finalize,
    reply_payload_sending, message_sending, agent_end, gateway_stop };
}

export function register(api) {
  const config = api.pluginConfig || {};
  const request = createBrokerClient(config);
  let compactionStats;
  const stats = () => compactionStats ||= createNativeCompactionStats({
    store: api.runtime.state.openKeyedStore({ namespace: 'chainchat-native-compaction-targets', retention: 'retained' }),
    loadSdk: () => import('openclaw/plugin-sdk/agent-sessions') });
  api.registerGatewayMethod?.(COMPACTION_STATS_METHOD, async ({ params, respond, signal }) => {
    try { respond(true, await stats().probe(params, signal)); }
    catch { respond(false, undefined, { code: 'INVALID_REQUEST', message: 'Native compaction metadata is unavailable for this exact session.' }); }
  }, { scope: 'operator.admin', profileAccess: 'independent' });
  api.registerTool(managedServicesFactory(request), { name: 'chainchat_automation' });
  const hooks = createEnforcementHooks(request, { browserPrivateValues: () => [config.brokerToken,
    ...Object.entries(process.env).filter(([key]) => /^CHAINCHAT_(?:GATEWAY_TOKEN|PROVIDER_TOKEN|BROKER_TOKEN|CHANNEL_[A-F0-9]{32}_[A-Z0-9_]+)$/.test(key)).map(([, value]) => value),
    ...Object.values(api.config?.browser?.profiles || {}).map(profile => profile?.cdpUrl)].filter(Boolean) });
  const channels = createChannelHooks(request, { channelIds: () => Object.entries(api.config?.channels || {})
    .filter(([, value]) => value && value.enabled !== false).map(([id]) => id) });
  for (const name of ['message_sending', 'reply_payload_sending']) {
    const ordinary = hooks[name];
    hooks[name] = async (event, context) => (await channels[name](event, context)) ?? ordinary(event, context);
  }
  hooks.message_received = channels.message_received;
  api.registerContextEngine?.(PLUGIN_ID, async context => createReviewedContextEngine({
    sdk: await import('openclaw/plugin-sdk/agent-sessions'), request, workspaceDir: context.workspaceDir,
    targetRegistry: stats(),
    commitStore: api.runtime.state.openKeyedStore({ namespace: 'chainchat-native-accepted-turns', retention: 'retained' }) }));
  // Each callback's own transport deadline expires before the host can discard
  // its explicit deny/cancel result. The UI transport also requires receipts.
  const timeoutMs = 2 * (config.requestTimeoutMs ?? 60000) + 10000;
  // The native durable-goal admission contract permits before_agent_reply
  // after its recovery checkpoint. before_dispatch and before_agent_run are
  // both restart-unsafe, so channel ingress uses observation only; it cannot
  // grant a native run, bypass output review, or return a synthetic reply.
  for (const [name, handler] of Object.entries(hooks)) if (name !== 'before_agent_run') api.on(name, handler, { priority: 1000000, timeoutMs });
}

export default { id: PLUGIN_ID, name: "Cypher Tempre Proof of Interaction", register };
