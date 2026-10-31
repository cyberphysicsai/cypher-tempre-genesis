import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { createBrokerClient, createEnforcementHooks, register, PLUGIN_ID } from "../openclaw/plugin/index.mjs";

const binding = { sessionKey: "agent:main:chainchat:isolated", runId: "run-isolated" };
const candidate = "We can approach this question with care and honesty.";
const hash = value => createHash("sha256").update(value).digest("hex");
const digest = hash(candidate);
const token = "synthetic-private-broker-token-for-tests";
const now = Date.now();
const result = (fields = {}) => ({ version: 1, allowed: true, purpose: "candidate", binding, ...fields });
const receipt = (fields = {}) => ({ candidateSha256: digest, expectedHead: "a".repeat(64),
  genesisHash: "b".repeat(64), reviewed: true, issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 60000).toISOString(), ...fields });

function fixture(options = {}) {
  const calls = [];
  let denied = options.denied, purpose = options.purpose || "candidate";
  const request = async (op, passedBinding, fields) => {
    calls.push({ op, binding: passedBinding, fields });
    if (options.throw === op) throw new Error("Do not leak credentials, source text or transport details.");
    const value = result({ allowed: denied !== op, purpose, binding: passedBinding,
      ...(op === "prepare" ? { context: options.context || "Verified native skill and paired chain context.", toolsAllow: options.tools || [] } : {}),
      ...(op === "tool" ? { tool: fields.tool } : {}),
      ...(["finalize", "outgoing"].includes(op) ? { candidateSha256: fields.candidateSha256,
        receipt: receipt({ candidateSha256: fields.candidateSha256 }) } : {}) });
    return options.transform ? options.transform(op, value) : value;
  };
  const hooks = createEnforcementHooks(request, { now: () => now });
  return { hooks, calls, setDenied: value => { denied = value; }, setPurpose: value => { purpose = value; } };
}
const prepare = f => f.hooks.before_prompt_build({ prompt: "Please reason carefully." }, binding);
const finalize = (f, text = candidate) => f.hooks.before_agent_finalize({ lastAssistantMessage: text }, binding);
const outgoing = (f, text = candidate, kind = "final") => f.hooks.reply_payload_sending({ payload: { text }, kind }, binding);

test("plugin admission binds a real prepared run and only exact reviewed final text can leave", async () => {
  const f = fixture();
  assert.deepEqual(await prepare(f), { appendSystemContext: "Verified native skill and paired chain context.", toolsAllow: [] });
  assert.deepEqual(await f.hooks.before_agent_run({ prompt: "Please reason carefully." }, binding), { outcome: "pass" });
  assert.deepEqual(await finalize(f), { action: "continue" });
  assert.equal((await outgoing(f)).cancel, false);
  assert.equal((await outgoing(f, "Changed after review")).cancel, true);
  assert.equal((await outgoing(f, candidate.slice(0, 10))).cancel, true);
  assert.equal((await outgoing(f, candidate, "block")).cancel, true);
  assert.deepEqual(f.calls.map(call => call.op), ["admit", "prepare", "admit", "finalize", "outgoing"]);
  assert.equal(f.calls.find(call => call.op === "finalize").fields.candidateSha256, digest);
});

test("unknown identities, cross-run context and denied admission fail closed", async () => {
  const f = fixture({ denied: "admit" });
  assert.equal((await f.hooks.before_agent_run({ prompt: "request" }, binding)).outcome, "block");
  assert.equal((await outgoing(f)).cancel, true);
  assert.equal((await f.hooks.before_agent_run({ prompt: "request" }, {})).outcome, "block");
  assert.equal((await f.hooks.before_agent_run({ runId: "forged" }, binding)).outcome, "block");
  const forged = fixture({ transform: (_op, value) => ({ ...value, binding: { ...binding, runId: "other" } }) });
  assert.equal((await forged.hooks.before_agent_run({}, binding)).outcome, "block");
});

test('goal-compatible native reply admission stops denied or failed broker runs', async () => {
  const accepted = fixture();
  assert.deepEqual(await accepted.hooks.before_agent_reply({ cleanedBody: 'Hello' }, binding), { handled: false });
  assert.equal(accepted.calls[0].fields.input, 'Hello');
  for (const options of [{ denied: 'admit' }, { throw: 'admit' }]) {
    const denied = fixture(options);
    const decision = await denied.hooks.before_agent_reply({ cleanedBody: 'Hello' }, binding);
    assert.equal(decision.handled, true); assert.equal(decision.reply, undefined);
  }
});

test('deterministic native control output needs its separate exact utility attestation', async () => {
  const control = fixture({ purpose: 'utility', transform: (op, value) => op === 'control_outgoing' ? {
    ...value, candidateSha256: digest, receipt: { candidateSha256: digest } } : value });
  assert.equal((await outgoing(control)).cancel, false);
  assert.equal(control.calls[0].op, 'control_outgoing');
  assert.equal((await outgoing(control, 'Changed command output')).cancel, true);
  const denied = fixture({ denied: 'control_outgoing', purpose: 'utility' });
  assert.equal((await outgoing(denied)).cancel, true);
});

test('legacy delivery can recover only an exact unique prior control receipt, never a candidate run', async () => {
  const control = fixture({ purpose: 'utility', transform: (op, value) => op === 'control_outgoing' ? {
    ...value, candidateSha256: digest, receipt: { candidateSha256: digest } } : value });
  const missingRun = { sessionKey: binding.sessionKey };
  assert.equal((await control.hooks.message_sending({ content: candidate }, missingRun)).cancel, true);
  assert.equal((await outgoing(control)).cancel, false);
  assert.equal((await control.hooks.message_sending({ content: candidate }, missingRun)).cancel, false);
  assert.equal(control.calls.at(-1).binding.runId, binding.runId);
  assert.equal((await control.hooks.message_sending({ content: candidate + ' changed' }, missingRun)).cancel, true);
  assert.equal((await control.hooks.message_sending({ content: candidate }, { sessionKey: 'other' })).cancel, true);
  const repeatedBinding = { ...binding, runId: 'next-control-run' };
  assert.equal((await control.hooks.reply_payload_sending({ payload: { text: candidate }, kind: 'final' }, repeatedBinding)).cancel, false);
  assert.equal((await control.hooks.message_sending({ content: candidate }, missingRun)).cancel, false);
  assert.equal(control.calls.at(-1).binding.runId, repeatedBinding.runId, 'An identical new command must supersede the ended control binding.');
  const ordinary = fixture(); await prepare(ordinary); await finalize(ordinary);
  assert.equal((await ordinary.hooks.message_sending({ content: candidate }, missingRun)).cancel, true);
  control.setDenied('control_outgoing');
  assert.equal((await control.hooks.message_sending({ content: candidate }, missingRun)).cancel, true);
});

test("preparation failure cannot grant tools or later admission, and no error reflects broker details", async () => {
  const f = fixture({ throw: "prepare" });
  const prepared = await prepare(f);
  assert.deepEqual(prepared.toolsAllow, []);
  assert.equal(prepared.appendSystemContext.includes("credentials"), false);
  assert.equal((await f.hooks.before_agent_run({}, binding)).outcome, "block");
  assert.equal((await finalize(f)).action, "revise");
});

test("tool authorization is for an explicitly equipped name and exact parameter envelope", async () => {
  const f = fixture({ tools: ["read"] }); await prepare(f);
  const params = { path: "approved/local/file.txt" };
  const event = { toolName: "read", toolCallId: "call-1", params };
  assert.deepEqual(await f.hooks.before_tool_call(event, binding), { block: false, params });
  assert.deepEqual(f.calls.at(-1).fields.tool, { name: "read", params, callId: "call-1" });
  const before = f.calls.length;
  assert.equal((await f.hooks.before_tool_call({ ...event, toolName: "exec" }, binding)).block, true);
  assert.equal(f.calls.length, before, "An unequipped tool never reaches approval.");
  assert.equal((await f.hooks.before_tool_call({ ...event, toolCallId: undefined }, binding)).block, true);
  f.setDenied("tool"); assert.equal((await f.hooks.before_tool_call(event, binding)).block, true);
});

test('tool execution uses the canonical reviewed envelope and rejects unbound approval replies', async () => {
  const event = { toolName: 'read', toolCallId: 'call-1', params: { path: './file.txt' } };
  const canonical = fixture({ tools: ['read'], transform: (op, value) => op === 'tool' ? {
    ...value, tool: { name: 'read', callId: 'call-1', params: { path: '/approved/file.txt' } } } : value });
  await prepare(canonical);
  assert.deepEqual(await canonical.hooks.before_tool_call(event, binding), { block: false, params: { path: '/approved/file.txt' } });
  for (const tool of [undefined, { name: 'exec', callId: 'call-1', params: {} }, { name: 'read', callId: 'wrong', params: {} }]) {
    const denied = fixture({ tools: ['read'], transform: (op, value) => op === 'tool' ? { ...value, tool } : value });
    await prepare(denied); assert.equal((await denied.hooks.before_tool_call(event, binding)).block, true);
  }
});

test("utility review and planning must be host-registered and cannot acquire tools or a candidate identity", async () => {
  const f = fixture({ purpose: "utility" }); await prepare(f);
  assert.deepEqual(await finalize(f), { action: "continue" });
  assert.equal((await f.hooks.before_tool_call({ toolName: "read", params: {}, toolCallId: "call" }, binding)).block, true);
  const bad = fixture({ purpose: "utility", tools: ["read"] });
  assert.deepEqual((await prepare(bad)).toolsAllow, []);
  assert.equal((await bad.hooks.before_agent_run({}, binding)).outcome, "block");
  f.setPurpose("candidate");
  assert.equal((await f.hooks.before_agent_run({}, binding)).outcome, "block");
});

test("approval receipts require current review, exact hash, chain identity and a bounded lifetime", async t => {
  for (const invalid of [
    { reviewed: false }, { candidateSha256: "0".repeat(64) }, { expectedHead: "not-a-hash" },
    { genesisHash: null }, { expiresAt: new Date(now - 1).toISOString() },
    { issuedAt: new Date(now + 60000).toISOString() }, { expiresAt: new Date(now + 20 * 60000).toISOString() },
  ]) await t.test(JSON.stringify(invalid), async () => {
    const f = fixture({ transform: (op, value) => op === "finalize" ? { ...value, receipt: receipt(invalid) } : value });
    await prepare(f);
    assert.equal((await finalize(f)).action, "revise");
    assert.equal((await outgoing(f)).cancel, true);
  });
});

test("delivery blocks unsupported media and survives agent_end only with exact retained authorization", async () => {
  const f = fixture(); await prepare(f); await finalize(f);
  await f.hooks.agent_end({ success: true }, binding);
  assert.equal((await outgoing(f)).cancel, false);
  assert.equal((await f.hooks.reply_payload_sending({ payload: { text: candidate, mediaUrl: "https://example.invalid/private" }, kind: "final" }, binding)).cancel, true);
  f.setDenied("outgoing"); assert.equal((await outgoing(f)).cancel, true);
  await f.hooks.gateway_stop(); assert.equal((await outgoing(f)).cancel, true);
});

test("plugin registers all required blocking and delivery hooks against the public API", () => {
  const registered = [];
  register({ pluginConfig: { brokerUrl: "http://127.0.0.1:18791/private", brokerToken: token },
    on: (name, handler, options) => registered.push({ name, handler, options }) });
  assert.equal(PLUGIN_ID, "cypher-tempre-poi");
  for (const required of ["before_agent_reply", "before_prompt_build", "before_tool_call", "before_agent_finalize",
    "reply_payload_sending", "message_sending", "agent_end", "gateway_stop"])
    assert.ok(registered.some(entry => entry.name === required));
  assert.equal(registered.some(entry => entry.name === 'before_agent_run'), false, 'Native durable goals reject restart-unsafe before_agent_run hooks.');
  assert.ok(registered.every(entry => entry.options.timeoutMs > 120000));
});

test("broker credentials stay local and malformed or reflected protocol data is rejected", async t => {
  for (const brokerUrl of ["https://example.com/private", "http://localhost:18791/", "http://127.0.0.1:18791/?token=secret",
    "http://user:secret@127.0.0.1:18791/", "file:///tmp/broker"])
    assert.throws(() => createBrokerClient({ brokerUrl, brokerToken: token }));
  assert.throws(() => createBrokerClient({ brokerUrl: "http://127.0.0.1:18791/", brokerTokenEnv: "PATH" }, { env: {} }));
  let received;
  const server = createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    received = { authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(parts)) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result({ binding: { ...binding, runId: "forged" } })));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = createBrokerClient({ brokerUrl: `http://127.0.0.1:${server.address().port}/private`, brokerTokenEnv: "CHAINCHAT_BROKER_TOKEN" },
    { env: { CHAINCHAT_BROKER_TOKEN: token } });
  await assert.rejects(request("admit", binding, { input: "private user query" }), error => !error.message.includes(token) && !error.message.includes("private user query"));
  assert.equal(received.authorization, `Bearer ${token}`);
  assert.equal(received.body.version, 1);
  assert.equal(JSON.stringify(received.body).includes(token), false);
});

test("broker transport refuses redirects and aborts timed-out decisions", async t => {
  let redirected = false;
  const target = createServer((_req, res) => { redirected = true; res.writeHead(200); res.end("{}"); });
  target.listen(0, "127.0.0.1"); await once(target, "listening");
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/credential-target` }); res.end();
    } else {
      const timer = setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result())); }, 1000);
      req.on("close", () => clearTimeout(timer));
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    await Promise.all([server, target].map(instance => new Promise(resolve => { instance.closeAllConnections(); instance.close(resolve); })));
  });
  for (const route of ["redirect", "timeout"]) {
    const request = createBrokerClient({ brokerUrl: `http://127.0.0.1:${server.address().port}/${route}`,
      brokerToken: token, requestTimeoutMs: 100 });
    await assert.rejects(request("admit", binding));
  }
  assert.equal(redirected, false, "A private bearer must never follow a redirect.");
});
