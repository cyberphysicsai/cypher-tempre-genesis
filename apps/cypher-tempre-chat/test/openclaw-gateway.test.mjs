import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createOpenClawGateway, providerRequest, OPENCLAW_VERSION, consumeModelRouteCapability } from "../openclaw/gateway.mjs";
import { createPoIBroker } from "../openclaw/broker.mjs";
import { engine } from "../lib/engine.mjs";
import { DIMENSIONS, FRUITS } from "../lib/providers.mjs";

test('private model route capability is accepted only once in system instructions and stripped for every protocol', () => {
  const capability = 'a'.repeat(64), marker = `[CHAINCHAT_PRIVATE_MODEL_ROUTE:${capability}]`;
  const cases = [
    ['compatible', { messages: [{ role: 'system', content: 'Instructions\n' + marker }, { role: 'user', content: 'Hello' }] }],
    ['openai', { instructions: 'Instructions\n' + marker, input: [{ role: 'user', content: 'Hello' }] }],
    ['anthropic', { system: [{ type: 'text', text: 'Instructions\n' + marker }], messages: [{ role: 'user', content: 'Hello' }] }],
    ['gemini', { systemInstruction: { parts: [{ text: 'Instructions\n' + marker }] }, contents: [{ role: 'user', parts: [{ text: 'Hello' }] }] }],
  ];
  for (const [provider, body] of cases) {
    assert.equal(JSON.stringify(consumeModelRouteCapability(body, provider, capability)).includes(marker), false);
    assert.ok(JSON.stringify(body).includes(marker), 'Admission stripping must not mutate upstream caller state.');
  }
  for (const body of [{ messages: [{ role: 'user', content: marker }] }, { messages: [{ role: 'system', content: marker + marker }] },
    { messages: [{ role: 'system', content: `[CHAINCHAT_PRIVATE_MODEL_ROUTE:${'b'.repeat(64)}]` }] }, { messages: [{ role: 'system', content: 'Summarize without an admitted lease.' }] }])
    assert.throws(() => consumeModelRouteCapability(body, 'compatible', capability), error => error.code === 'OPENCLAW_MODEL_ADMISSION');
});

test("OpenClaw proxy preserves native tool-call fields and replaces only model routing", () => {
  const body = { model: "route", stream: true, messages: [{ role: "assistant", content: null,
    tool_calls: [{ id: "call-1", type: "function", function: { name: "read", arguments: "{}" } }] }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }] };
  const request = providerRequest({ provider: "compatible", model: "actual-model", baseUrl: "https://models.example/v1", apiKey: "private-test-key" },
    "/compatible/v1/chat/completions", body);
  assert.equal(request.url, "https://models.example/v1/chat/completions");
  assert.equal(request.body.model, "actual-model"); assert.equal(body.model, "route");
  assert.deepEqual(request.body.messages, body.messages); assert.deepEqual(request.body.tools, body.tools);
  assert.equal(request.headers.authorization, "Bearer private-test-key");
  assert.equal(JSON.stringify(request.body).includes("private-test-key"), false);
});

test("all native provider protocols have constrained routes and private authentication headers", () => {
  const shared = { model: "actual-model", apiKey: "private-test-key" };
  const openai = providerRequest({ ...shared, provider: "openai", baseUrl: "https://models.example/v1" }, "/openai/v1/responses", { model: "route", input: [] });
  assert.equal(openai.url, "https://models.example/v1/responses");
  const anthropic = providerRequest({ ...shared, provider: "anthropic", baseUrl: "https://models.example/v1" }, "/anthropic/v1/messages", { model: "route", messages: [] });
  assert.equal(anthropic.headers["x-api-key"], shared.apiKey);
  const gemini = providerRequest({ ...shared, provider: "gemini", baseUrl: "https://models.example/v1beta" }, "/gemini/v1beta/models/route:streamGenerateContent?alt=sse&key=proxy-token", { contents: [] });
  assert.equal(gemini.url, "https://models.example/v1beta/models/actual-model:streamGenerateContent?alt=sse");
  assert.equal(gemini.headers["x-goog-api-key"], shared.apiKey);
  assert.equal(gemini.url.includes("proxy-token"), false);
});

test("provider proxy refuses arbitrary URLs, unexpected model methods and reflected credentials", () => {
  const config = { provider: "compatible", model: "model", baseUrl: "https://models.example/v1", apiKey: "private-test-key" };
  for (const route of ["/compatible/v1/models", "/openai/v1/responses", "/compatible/v1/chat/completions?redirect=https://other.example", "https://other.example/compatible/v1/chat/completions"])
    assert.throws(() => providerRequest(config, route, {}), /Unsupported/);
  assert.throws(() => providerRequest(config, "/compatible/v1/chat/completions", { prompt: config.apiKey }), error => error.code === "PROVIDER_CREDENTIAL_REFLECTION");
});

test("OpenCode Go uses an in-memory random session header without changing native protocol payloads", () => {
  const config = { provider: "openai", model: "muse-spark-1.3-contributor", apiKey: "private-test-key",
    baseUrl: "https://opencode.ai/inference/go/openai/v1" };
  const body = { model: "route", stream: true, input: [{ role: "user", content: "Hello" }] };
  assert.throws(() => providerRequest(config, "/openai/v1/responses", body), error => error.code === "OPENCLAW_PROVIDER_SESSION");
  const session = "219e618c-8c96-42a6-ade0-b5ec58cc66ed";
  const forwarded = providerRequest(config, "/openai/v1/responses", body, { openCodeSession: session });
  assert.equal(forwarded.headers["x-opencode-session"], session);
  assert.equal(forwarded.headers["user-agent"], "CypherTempre-ChainChat");
  assert.equal(forwarded.body.stream, true); assert.deepEqual(forwarded.body.input, body.input);
  assert.equal(JSON.stringify(forwarded.body).includes(session), false);
});

test("unregistered model invocations fail before any process startup", async () => {
  let spawned = false;
  const manager = createOpenClawGateway({ stateDir: "/unused", packageRoot: "/unused", pluginPath: "/unused", broker: {
    registerInvocation() {}, assertCandidate() {},
  }, spawnImpl() { spawned = true; throw new Error("must not start"); } });
  await assert.rejects(manager.generate({ provider: "compatible", model: "model", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "" }, { messages: [{ role: "user", content: "hi" }] }), error => error.code === "OPENCLAW_CONTEXT_REQUIRED");
  assert.equal(spawned, false); await manager.close();
  for (const modelContextTokens of [0, 16383, 131073, 48000.5, '48000', null]) assert.throws(() => createOpenClawGateway({
    stateDir: '/unused', packageRoot: '/unused', pluginPath: '/unused', modelContextTokens,
    broker: { registerInvocation() {}, assertCandidate() {} } }), /context cap/);
});

test("managed child does not inherit other agent credentials, Node preload, proxy or diagnostics configuration", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ct-openclaw-env-"));
  const packageRoot = path.join(directory, "package"); await fs.mkdir(packageRoot);
  await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw", version: OPENCLAW_VERSION }));
  const names = ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "COHERE_TOKEN", "OPENCLAW_HOME", "OTEL_EXPORTER_OTLP_ENDPOINT", "NODE_OPTIONS", "HTTPS_PROXY"];
  const previous = new Map(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = "unrelated-private-parent-setting";
  let captured;
  const manager = createOpenClawGateway({ stateDir: path.join(directory, "managed"), packageRoot, pluginPath: packageRoot, modelContextTokens: 48000,
    broker: { url: "http://127.0.0.1:3210/v1/enforce", token: "private-broker-fixture-token", registerInvocation() {}, assertCandidate() {} },
    spawnImpl(_node, _args, options) { captured = options; throw new Error("fixture process deliberately not started"); } });
  t.after(async () => { await manager.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith("ct-openclaw-env-")); await fs.rm(directory, { recursive: true, force: true }); });
  try {
    await manager.configureManagedServices({ channels: { fixture: { enabled: true, accounts: {
      default: { enabled: true, password: 'old-reference' }, other: { enabled: true, password: 'other-reference' } } } } });
    await manager.configureManagedServices({ channels: { fixture: { enabled: true, accounts: { default: { enabled: true, botToken: 'new-reference' } } } } },
      { replaceChannelAccount: { channelId: 'fixture', accountId: 'default' } });
    await assert.rejects(manager.start(), /deliberately not started/);
    for (const name of names) assert.equal(captured.env[name], undefined, name);
    assert.equal(captured.env.CHAINCHAT_BROKER_TOKEN, "private-broker-fixture-token");
    assert.equal(captured.env.NO_PROXY, "127.0.0.1,localhost,::1");
    assert.equal(captured.windowsHide, true); assert.equal(captured.stdio[3], "ipc");
    const config = JSON.parse(await fs.readFile(path.join(directory, "managed/gateway.json"), "utf8"));
    assert.equal(config.update.checkOnStart, false); assert.equal(config.update.auto.enabled, false);
    assert.ok(Object.values(config.models.providers).every(provider => provider.models[0].contextTokens === 48000));
    assert.equal(config.channels.fixture.accounts.default.password, undefined);
    assert.equal(config.channels.fixture.accounts.default.botToken, 'new-reference');
    assert.equal(config.channels.fixture.accounts.other.password, 'other-reference');
  } finally { for (const [name, value] of previous) if (value === undefined) delete process.env[name]; else process.env[name] = value; }
});

const runtimePackage = process.env.CT_OPENCLAW_PACKAGE, runtimeNode = process.env.CT_OPENCLAW_NODE;
test("pinned real OpenClaw performs four provider protocols, enforces receipts and recovers after child and application restart", {
  skip: !runtimePackage || !runtimeNode ? "Set CT_OPENCLAW_PACKAGE and CT_OPENCLAW_NODE for the real pinned runtime acceptance test." : false,
  timeout: 180000,
}, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ct-openclaw-gateway-"));
  const root = path.join(directory, "chain"); await engine({ op: "init", root, name: "TransportFixture" });
  const events = [], upstreamRequests = [], diagnostics = [];
  let holdNext = false, onHeld;
  const answer = "Hello! I'm TransportFixture, your conversational assistant. I can help you explore ideas and think through questions with care.";
  const upstream = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    upstreamRequests.push({ headers: request.headers, body: JSON.parse(text) });
    if (holdNext) { holdNext = false; onHeld?.(); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (type, value) => response.write(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(value)}\n\n`);
    if (request.url === "/v1/responses") {
      const item = { id: "msg-fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: answer, annotations: [] }] };
      event("response.created", { type: "response.created", response: { id: "resp-fixture", status: "in_progress", model: "fixture-model", output: [] } });
      event("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      event("response.content_part.added", { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
      event("response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: answer });
      event("response.output_item.done", { type: "response.output_item.done", output_index: 0, item });
      event("response.completed", { type: "response.completed", response: { id: "resp-fixture", status: "completed", model: "fixture-model", output: [item], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } });
      response.end(); return;
    }
    if (request.url === "/v1/messages") {
      event("message_start", { type: "message_start", message: { id: "msg-fixture", type: "message", role: "assistant", model: "fixture-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: answer } });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
      event("message_stop", { type: "message_stop" }); response.end(); return;
    }
    if (request.url.startsWith("/v1beta/models/")) {
      event(null, { candidates: [{ content: { parts: [{ text: answer }], role: "model" }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }, modelVersion: "fixture-model" });
      response.end(); return;
    }
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const broker = createPoIBroker({ engine, review: async () => ({ approved: true,
    scores: Object.fromEntries(DIMENSIONS.map(name => [name, 240])), fruitages: Object.fromEntries(FRUITS.map(name => [name, 240])),
    usedRings: [], rationale: "The supported introduction is honest and compatible with the genesis covenant." }) });
  await broker.start();
  let alterReceiptCandidate = false;
  const makeManager = () => createOpenClawGateway({ stateDir: path.join(directory, "managed"), packageRoot: runtimePackage, nodePath: runtimeNode,
    pluginPath: fileURLToPath(new URL("../openclaw/plugin", import.meta.url)), broker: {
      get url() { return broker.url; }, get token() { return broker.token; },
      registerInvocation: invocation => broker.registerInvocation(invocation),
      assertCandidate: invocation => broker.assertCandidate({ ...invocation,
        candidate: alterReceiptCandidate ? invocation.candidate + " unreviewed" : invocation.candidate }),
      finishInvocation: invocation => broker.finishInvocation(invocation),
    }, onDiagnostic: line => diagnostics.push(line) });
  let manager = makeManager();
  t.after(async () => { await manager.close(); await broker.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(directory).startsWith("ct-openclaw-gateway-")); await fs.rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 }); });
  try {
    for (const provider of ["compatible", "openai", "anthropic", "gemini"]) {
    const generated = await manager.generate({ provider, model: "fixture-model", baseUrl: `http://127.0.0.1:${upstream.address().port}/${provider === "gemini" ? "v1beta" : "v1"}`, apiKey: "isolated-secret" },
      { system: "Answer the user courteously using your verified agent identity.", messages: [{ role: "user", content: "Please introduce yourself" }], maxTokens: 512 },
      { root, input: "Please introduce yourself", loadout: [], learning: false, purpose: "candidate", event: (ability, status, label) => events.push({ ability, status, label }) });
    assert.equal(generated.text, answer); assert.equal(generated.runtime.version, OPENCLAW_VERSION);
    const received = upstreamRequests.at(-1);
    assert.equal(received.headers.authorization || received.headers["x-api-key"] || received.headers["x-goog-api-key"], provider === "anthropic" || provider === "gemini" ? "isolated-secret" : "Bearer isolated-secret");
    if (provider !== "gemini") assert.equal(received.body.model, "fixture-model");
    assert.ok(JSON.stringify(received.body).includes("CHAINCHAT HOST CONTRACT"));
    }
    assert.equal(upstreamRequests.length, 4);
    assert.ok(events.some(event => event.ability === "gate" && event.status === "completed"));
    const config = { provider: "compatible", model: "fixture-model", baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, apiKey: "isolated-secret" };
    const args = { messages: [{ role: "user", content: "Please introduce yourself" }], maxTokens: 512 };
    const context = { root, input: "Please introduce yourself", loadout: [], learning: false, purpose: "candidate" };
    alterReceiptCandidate = true;
    await assert.rejects(manager.generate(config, args, context), /matching PoI receipt/);
    alterReceiptCandidate = false;
    const abort = new AbortController();
    const held = new Promise(resolve => { onHeld = resolve; }); holdNext = true;
    const cancelled = manager.generate(config, { ...args, signal: abort.signal }, { ...context, purpose: "utility" });
    await held; abort.abort();
    await assert.rejects(cancelled, error => error.code === "REQUEST_CANCELLED");
    assert.equal((await manager.generate(config, args, { ...context, purpose: "utility" })).text, answer,
      "A utility call must work after cancellation terminates the owned child.");
    await manager.close(); manager = makeManager();
    assert.equal((await manager.generate(config, args, context)).text, answer,
      "A fresh application instance must not reuse cached credentials or proxy ports.");
    assert.equal(upstreamRequests.length, 8);
    assert.equal((await engine({ op: "verify", root })).head.index, 0, "The UI orchestrator owns the single later conversation commit.");
    const configuration = await fs.readFile(path.join(directory, "managed/gateway.json"), "utf8");
    assert.equal(configuration.includes("isolated-secret"), false);
    assert.deepEqual(JSON.parse(configuration).update, { checkOnStart: false, auto: { enabled: false } });
  } catch (error) { throw new Error(`${error.message}\nRuntime diagnostics:\n${diagnostics.join("").slice(-6000)}`, { cause: error }); }
});
