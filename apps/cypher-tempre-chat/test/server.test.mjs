import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { Wallet } from "ethers";
import { createApp, strictReview } from "../server.mjs";
import { FRUITS, DIMENSIONS } from "../lib/providers.mjs";
import { HOLDINGS_NETWORK } from "../lib/holdings-gate.mjs";
import { StateStore } from "../lib/state.mjs";
import { connectLocalSession } from "../public/local-session.js";
import { engine as nativeEngine } from "../lib/engine.mjs";

const HASH = (index) => index.toString(16).padStart(64, "0");
const goodReview = () => ({
  usedRings: [],
  approved: true,
  decision: "approve",
  scores: Object.fromEntries(DIMENSIONS.map((k) => [k, 230])),
  fruits: Object.fromEntries(FRUITS.map((k) => [k, 240])),
  rationale: "Consistent with the genesis covenant.",
});
const inspect = (chain) => ({
  ok: true,
  verified: true,
  genesis: { name: chain.name, covenant: [...FRUITS] },
  head: { index: chain.index, hash: HASH(chain.index) },
  faculties: [
    { id: "2", key: "modality:2", name: "Reason", kind: "modality" },
    { id: "5", key: "sense:5", name: "Perceive", kind: "sense" },
  ],
  history: [],
});

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ct-chat-server-test-"),
  );
  const chains = new Map(),
    calls = [],
    modelCalls = [],
    reviewCalls = [];
  const engine = async (request) => {
    calls.push(structuredClone(request));
    if (overrides.engine) return overrides.engine(request);
    if (request.op === "sanitize_source")
      return {
        text: request.text,
        redactionCount: 0,
        bytes: Buffer.byteLength(request.text, "utf8"),
        sourceHash: (await import("node:crypto"))
          .createHash("sha256")
          .update(request.text)
          .digest("hex"),
      };
    if (request.op === "init") {
      chains.set(request.root, { name: request.name, index: 0 });
      return inspect(chains.get(request.root));
    }
    const chain = chains.get(request.root);
    if (!chain)
      throw Object.assign(new Error("Unknown fixture chain."), {
        code: "CHAIN_UNKNOWN",
        status: 422,
      });
    if (request.op === "inspect" || request.op === "verify")
      return inspect(chain);
    if (request.op === "prepare")
      return {
        ...inspect(chain),
        memories: [],
        context: "Verified fixture context.",
        loadout: request.loadout,
        frames: [],
        computed: {},
        ...(overrides.prepare ? overrides.prepare(request, chain) : {}),
      };
    if (request.op === "evaluate")
      return overrides.evaluate
        ? overrides.evaluate(request)
        : { ok: true, accepted: true, verdict: "SEAL" };
    if (request.op === "commit") {
      if (overrides.commit) return overrides.commit(request);
      assert.equal(request.expectedHead, HASH(chain.index));
      chain.index++;
      return {
        ok: true,
        accepted: true,
        ring: { index: chain.index, hash: HASH(chain.index) },
      };
    }
    if (request.op === "ingest") {
      chain.index++;
      return {
        ok: true,
        accepted: true,
        ring: { index: chain.index, hash: HASH(chain.index) },
      };
    }
    throw new Error("Unsupported fixture operation.");
  };
  const app = await createApp({
    licenseConfig: { mode: "holdings", required: false, ...overrides.licenseConfig },
    licenseFetch: overrides.licenseFetch,
    publicOrigins: overrides.publicOrigins,
    dataDir,
    pairingCode: "TEST-CODE",
    engine,
    generate: async (config, args) => {
      modelCalls.push({ config, args });
      return overrides.generate
        ? overrides.generate(config, args)
        : { text: "A helpful and truthful answer.", usage: {} };
    },
    review: async (config, args) => {
      reviewCalls.push({ config, args });
      return overrides.review ? overrides.review(config, args) : goodReview();
    },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    if (app.server.listening) await new Promise((resolve) => {
      app.server.closeAllConnections();
      app.server.close(resolve);
    });
    const resolved = path.resolve(dataDir);
    assert.ok(
      resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) &&
        path.basename(resolved).startsWith("ct-chat-server-test-"),
    );
    await fs.rm(resolved, { recursive: true, force: true });
  });
  let token;
  const request = async (endpoint, payload, customHeaders = {}) => {
    const response = await fetch(base + endpoint, {
      method: payload === undefined ? "GET" : "POST",
      headers: {
        ...(payload === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...customHeaders,
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  };
  const pair = async () => {
    const response = await request("/api/pair", { code: "TEST-CODE" });
    assert.equal(response.status, 200);
    token = response.body.token;
    return token;
  };
  const ready = async () => {
    await pair();
    const created = await request("/api/agents", { name: "Test agent" });
    assert.equal(created.status, 201);
    const provider = await request("/api/provider", {
      provider: "openai",
      model: "test-model-a",
      apiKey: "never-persist-this-key",
    });
    assert.equal(provider.status, 200);
    return created.body;
  };
  return {
    ...app,
    base,
    dataDir,
    request,
    pair,
    ready,
    chains,
    calls,
    modelCalls,
    reviewCalls,
  };
}

async function allText(root) {
  let text = "";
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    text += item.isDirectory()
      ? await allText(file)
      : await fs.readFile(file, "utf8");
  }
  return text;
}

test('installer launch nonce is single-use and scoped to the local page', async t => {
  const f = await fixture(t);
  const nonce = f.issueLaunchNonce();
  assert.equal((await f.request('/api/launch', { nonce }, { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.request('/api/launch', { nonce: '0'.repeat(64) })).status, 401);
  const paired = await f.request('/api/launch', { nonce }, { origin: f.base });
  assert.equal(paired.status, 200);
  assert.match(paired.body.token, /^[a-f0-9]{64}$/);
  assert.equal((await f.request('/api/launch', { nonce }, { origin: f.base })).status, 401);
  assert.equal((await f.request('/api/local-pairing')).status, 401);
  const code = await f.request('/api/local-pairing', undefined, { authorization: `Bearer ${paired.body.token}`, origin: f.base });
  assert.equal(code.status, 200);
  assert.equal(code.body.code, 'TEST-CODE');
});

test("local reload tickets require owner launch proof and never expose stored API credentials", async t => {
  const f = await fixture(t);
  const browser = { origin: f.base, "sec-fetch-site": "same-origin" };
  assert.equal((await f.request("/api/local-session", {}, browser)).status, 401);
  assert.equal((await f.request("/api/local-resume", {}, browser)).status, 403);
  assert.equal(f.sessions.size, 0);
  const launch = await f.request("/api/launch", { nonce: f.issueLaunchNonce() }, browser);
  assert.equal(launch.status, 200); const { token, resumeTicket } = launch.body;
  assert.match(token, /^[a-f0-9]{64}$/); assert.match(resumeTicket, /^[a-f0-9]{64}$/);
  assert.notEqual(token, resumeTicket);
  assert.equal(launch.headers.get("set-cookie"), null); assert.equal(launch.headers.get("location"), null);
  assert.equal(launch.headers.get("cache-control"), "no-store");
  const auth = { ...browser, authorization: `Bearer ${token}` };
  assert.equal((await f.request("/api/provider", { provider: "openai", model: "reload-fixture", apiKey: "reload-memory-only-key" }, auth)).status, 200);
  const originalSession = f.sessions.get(token), expires = originalSession.expires;
  const resumed = await f.request("/api/local-resume", { resumeTicket }, browser);
  assert.equal(resumed.status, 200); assert.equal(resumed.body.token, token);
  assert.notEqual(resumed.body.resumeTicket, resumeTicket);
  assert.match(resumed.body.resumeTicket, /^[a-f0-9]{64}$/);
  assert.equal(f.sessions.size, 1); assert.equal(f.sessions.get(token), originalSession);
  assert.equal(originalSession.expires, expires, "Reload cannot silently extend the original authorization lifetime.");
  assert.equal(originalSession.provider.apiKey, "reload-memory-only-key");
  const state = await f.request("/api/state", undefined, auth);
  assert.equal(state.status, 200); assert.equal(state.body.provider.configured, true);
  for (const secret of [token, resumeTicket, resumed.body.resumeTicket, "reload-memory-only-key"])
    assert.equal(JSON.stringify(state.body).includes(secret), false);
  assert.equal((await f.request(`/api/state?token=${token}`, undefined, browser)).status, 401);
  assert.equal((await f.request("/api/state", undefined, { ...browser, cookie: `token=${token}` })).status, 401);
  assert.equal((await f.request("/api/local-resume", { resumeTicket }, browser)).status, 403);
  const second = await f.request("/api/local-resume", { resumeTicket: resumed.body.resumeTicket }, browser);
  assert.equal(second.status, 200); assert.equal(second.body.token, token);
  const persisted = await allText(f.dataDir);
  for (const secret of [token, resumeTicket, resumed.body.resumeTicket, second.body.resumeTicket, "reload-memory-only-key"])
    assert.equal(persisted.includes(secret), false);
});

test("resume tickets enforce exact local Origin, Host and fetch metadata without consuming on rejection", async t => {
  const site = "https://cyphertempre.ai", f = await fixture(t, { publicOrigins: [site] });
  const launch = await f.request("/api/launch", { nonce: f.issueLaunchNonce() }, { origin: f.base });
  assert.equal(launch.status, 200); const { resumeTicket, token } = launch.body;
  const port = f.server.address().port;
  const badHeaders = [
    {}, { "sec-fetch-site": "same-origin" }, { origin: "null" }, { origin: site },
    { origin: "https://attacker.example" }, { origin: f.base + "/" },
    { origin: `http://127.0.0.1:${port + 1}` }, { origin: `http://localhost:${port}` },
    { origin: `http://[::1]:${port}` }, { origin: f.base.replace("http:", "https:") },
    ...["same-site", "cross-site", "none", "", "same-origin, same-origin"].map(value => ({ origin: f.base, "sec-fetch-site": value })),
  ];
  for (const headers of badHeaders) {
    const result = await f.request("/api/local-resume", { resumeTicket }, headers);
    assert.equal(result.status, 403, JSON.stringify(headers));
    assert.equal(result.body.token, undefined); assert.equal(result.body.resumeTicket, undefined);
  }
  const foreign = await new Promise((resolve, reject) => {
    const request = http.request(f.base + "/api/local-resume", { method: "POST", headers: {
      host: "attacker.example", origin: "http://attacker.example", "content-type": "application/json",
    } }, response => { response.resume(); resolve(response.statusCode); });
    request.on("error", reject); request.end(JSON.stringify({ resumeTicket }));
  });
  assert.equal(foreign, 403);
  const resumed = await f.request("/api/local-resume", { resumeTicket }, { origin: f.base });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.token, token);
  const hosted = await f.request("/api/pair", { code: "TEST-CODE" }, { origin: site });
  assert.equal(hosted.status, 200); assert.equal(hosted.body.resumeTicket, undefined);
  assert.equal((await f.request("/api/local-resume", { resumeTicket: hosted.body.token }, { origin: f.base })).status, 403);
});

test("only local browser nonce launches issue tickets; legacy and manual pairing remain intact", async t => {
  const f = await fixture(t);
  const cli = await f.request("/api/launch", { nonce: f.issueLaunchNonce() });
  assert.equal(cli.status, 200); assert.deepEqual(Object.keys(cli.body), ["token"]);
  assert.equal((await f.request("/api/local-resume", { resumeTicket: cli.body.token }, { origin: f.base })).status, 403);
  const manual = await f.request("/api/pair", { code: "TEST-CODE" }, { origin: f.base });
  assert.equal(manual.status, 200); assert.equal(manual.body.resumeTicket, undefined);
  const misleadingFetch = await f.request("/api/launch", { nonce: f.issueLaunchNonce() }, { origin: f.base, "sec-fetch-site": "cross-site" });
  assert.equal(misleadingFetch.status, 200); assert.equal(misleadingFetch.body.resumeTicket, undefined);
  const local = await f.request("/api/launch", { nonce: f.issueLaunchNonce() }, { origin: f.base });
  assert.equal(local.status, 200); assert.match(local.body.resumeTicket, /^[a-f0-9]{64}$/);
});

test("concurrent reloads consume a resume ticket once and share pairing rate limits", async t => {
  const f = await fixture(t), browser = { origin: f.base };
  const launch = await f.request("/api/launch", { nonce: f.issueLaunchNonce() }, browser);
  const results = await Promise.all([1, 2].map(() => f.request("/api/local-resume", { resumeTicket: launch.body.resumeTicket }, browser)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 403]);
  const rotated = results.find(result => result.status === 200).body.resumeTicket;
  for (let i = 0; i < 3; i++) assert.equal((await f.request("/api/pair", { code: "wrong" })).status, 401);
  assert.equal((await f.request("/api/local-resume", { resumeTicket: rotated }, browser)).status, 429);
  assert.equal((await f.request("/api/pair", { code: "TEST-CODE" })).status, 429);
});

test("resume tickets cannot survive unpair, session expiry or a server restart", async t => {
  for (const ending of ["unpair", "expiry", "restart"]) {
    await t.test(ending, async t => {
      const f = await fixture(t), browser = { origin: f.base };
      const launch = await f.request("/api/launch", { nonce: f.issueLaunchNonce() }, browser);
      const { token, resumeTicket } = launch.body, session = f.sessions.get(token);
      if (ending === "unpair") assert.equal((await f.request("/api/unpair", {}, { ...browser, authorization: `Bearer ${token}` })).status, 200);
      if (ending === "expiry") session.expires = Date.now() - 1;
      if (ending === "restart") {
        const port = f.server.address().port;
        await new Promise(resolve => { f.server.closeAllConnections(); f.server.close(resolve); });
        const restarted = await createApp({ dataDir: f.dataDir, pairingCode: "TEST-CODE", licenseConfig: { mode: "holdings", required: false } });
        try {
          restarted.server.listen(port, "127.0.0.1"); await once(restarted.server, "listening");
          const result = await f.request("/api/local-resume", { resumeTicket }, browser);
          assert.equal(result.status, 403); assert.equal(restarted.sessions.size, 0);
        } finally { await new Promise(resolve => { restarted.server.closeAllConnections(); restarted.server.close(resolve); }); }
      } else {
        assert.equal((await f.request("/api/local-resume", { resumeTicket }, browser)).status, 403);
        assert.equal(f.sessions.has(token), false);
      }
      assert.equal(session.provider, null);
    });
  }
});

test("resume preserves the original wallet challenge, grant and subsequent revocation", async t => {
  // Public deterministic fixture account; no live wallet, network or transaction.
  const wallet = new Wallet("0x" + "11".repeat(32));
  const fetchRpc = async (_url, options) => {
    const request = JSON.parse(options.body); let result;
    if (request.method === "eth_chainId") result = "0x2105";
    else if (request.method === "eth_blockNumber") result = "0x64";
    else if (request.method === "eth_getBlockByNumber") result = { number: "0x62", hash: "0x" + "ab".repeat(32) };
    else if (request.method === "eth_getCode") result = "0x";
    else if (request.method === "eth_call") result = "0x" + BigInt(request.params[0].data === "0x313ce567" ? 18 : HOLDINGS_NETWORK.minimumBalance).toString(16).padStart(64, "0");
    else throw new Error("Unexpected local RPC fixture method.");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  const f = await fixture(t, { licenseConfig: { required: true }, licenseFetch: fetchRpc });
  const browser = { origin: f.base }, storageValues = new Map(), frontendCalls = [];
  let saved = "aa".repeat(32); // A stale tab credential must not override a fresh owner nonce.
  const storage = { getItem: () => saved, setItem(key, value) { storageValues.set(key, value); saved = value; },
    removeItem(key) { storageValues.delete(key); saved = null; } };
  const request = async (endpoint, input) => {
    frontendCalls.push(endpoint);
    const result = await f.request(endpoint, input, browser);
    if (result.status !== 200) throw Object.assign(new Error(result.body.error), { code: result.body.code });
    return result.body;
  };
  const launch = await connectLocalSession({ origin: f.base, nonce: f.issueLaunchNonce(), storage, request });
  assert.equal(launch.resumable, true); assert.deepEqual(frontendCalls, ["/api/launch"]);
  const token = launch.token, firstTicket = saved, auth = { ...browser, authorization: `Bearer ${token}` };
  assert.equal((await f.request("/api/provider", { provider: "openai", model: "fixture", apiKey: "private-reload-wallet-key" }, auth)).body.code, "HOLDINGS_REQUIRED");
  const challenge = await f.request("/api/license/challenge", { address: wallet.address }, auth);
  assert.equal(challenge.status, 200);
  const resumed = await connectLocalSession({ origin: f.base, storage, request });
  assert.equal(resumed.token, token); assert.notEqual(saved, firstTicket);
  const signedIn = await f.request("/api/license/verify", { requestId: challenge.body.requestId,
    message: challenge.body.message, signature: await wallet.signMessage(challenge.body.message) }, auth);
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body)); assert.equal(signedIn.body.status, "active");
  assert.equal((await f.request("/api/provider", { provider: "openai", model: "fixture", apiKey: "private-reload-wallet-key" }, auth)).status, 200);
  const again = await connectLocalSession({ origin: f.base, storage, request });
  assert.equal(again.token, token);
  assert.equal((await f.request("/api/state", undefined, auth)).body.provider.configured, true);
  const license = await f.request("/api/license", undefined, auth);
  assert.equal(license.body.status, "active"); assert.deepEqual(license.body.session, signedIn.body.session);
  assert.equal((await f.request("/api/license/logout", {}, auth)).status, 200);
  const loggedOut = await connectLocalSession({ origin: f.base, storage, request });
  assert.equal(loggedOut.token, token);
  assert.equal((await f.request("/api/license", undefined, auth)).body.status, "wallet-required");
  assert.equal((await f.request("/api/provider", { provider: "openai", model: "fixture", apiKey: "new-key" }, auth)).body.code, "HOLDINGS_REQUIRED");
  assert.equal((await f.request("/api/state", undefined, auth)).body.provider.configured, false);
  assert.deepEqual(frontendCalls, ["/api/launch", "/api/local-resume", "/api/local-resume", "/api/local-resume"]);
  assert.equal(storageValues.size, 1);
  assert.equal([...storageValues.values()][0], saved);
  for (const secret of [token, "private-reload-wallet-key", "new-key"])
    assert.equal(JSON.stringify([...storageValues]).includes(secret), false);
});

test("audit reads require a paired selected agent, never a browser directory or a wallet grant", { timeout: 60000 }, async t => {
  const f = await fixture(t, { engine: nativeEngine, licenseConfig: { required: true } });
  assert.equal((await f.request("/api/audit/read", { op: "summary" })).status, 401);
  await f.pair();
  assert.equal((await f.request("/api/audit/read", { op: "summary" })).status, 409);
  const firstRoot = path.join(f.dataDir, "first-native-audit"), secondRoot = path.join(f.dataDir, "second-native-audit");
  await nativeEngine({ op: "init", root: firstRoot, name: "First Native Audit" });
  await nativeEngine({ op: "init", root: secondRoot, name: "Second Native Audit" });
  const first = await f.store.add(firstRoot, "First Native Audit", true);
  const second = await f.store.add(secondRoot, "Second Native Audit", true);
  assert.equal((await f.request("/api/agents/select", { id: first.id })).status, 200);
  const firstBytes = await fs.readFile(path.join(firstRoot, "chain", "rings.jsonl"));
  const secondBytes = await fs.readFile(path.join(secondRoot, "chain", "rings.jsonl"));
  const before = f.calls.length;
  const summary = await f.request("/api/audit/read", { op: "summary" });
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  assert.equal(summary.body.root, await fs.realpath(firstRoot));
  assert.equal(summary.body.verification.ok, true); assert.equal(summary.body.stats.rings, 1);
  assert.ok(f.calls.slice(before).some(call => call.op === "inspect" && call.root === firstRoot && call.learning === false));
  for (const input of [
    { op: "summary", root: secondRoot }, { op: "summary", root: firstRoot },
    { op: "summary", agentId: second.id }, { op: "summary", inspect: { verified: true } },
  ]) {
    const rejected = await f.request("/api/audit/read", input);
    assert.equal(rejected.status, 400); assert.equal(rejected.body.code, "AUDIT_INVALID_REQUEST");
  }
  assert.equal((await f.request("/api/audit/read", { op: "rings", offset: 0, limit: 1 })).status, 200);
  assert.equal((await f.request("/api/audit/read", { op: "ring", index: 0 })).status, 200);
  assert.equal((await f.request("/api/agents/select", { id: second.id })).status, 200);
  const selected = await f.request("/api/audit/read", { op: "summary" });
  assert.equal(selected.status, 200); assert.equal(selected.body.root, await fs.realpath(secondRoot));
  assert.deepEqual(await fs.readFile(path.join(firstRoot, "chain", "rings.jsonl")), firstBytes);
  assert.deepEqual(await fs.readFile(path.join(secondRoot, "chain", "rings.jsonl")), secondBytes);
  assert.equal((await f.request("/api/provider", { provider: "openai", model: "fixture", apiKey: "unused-audit-key" })).body.code, "HOLDINGS_REQUIRED");
  assert.equal((await f.request("/api/chat", { message: "Inspection did not authorize execution." })).body.code, "HOLDINGS_REQUIRED");
  assert.equal(f.modelCalls.length, 0); assert.equal(f.calls.some(call => ["commit", "ingest", "dormancy", "maintenance", "faculty_action"].includes(call.op)), false);
});

test("audit transport rejects mutation operations, malformed read bounds and foreign origins", { timeout: 60000 }, async t => {
  const f = await fixture(t, { engine: nativeEngine });
  const root = path.join(f.dataDir, "readonly-native-audit");
  await nativeEngine({ op: "init", root, name: "Read Only Audit" });
  await f.store.add(root, "Read Only Audit", true); await f.pair();
  const ledger = await fs.readFile(path.join(root, "chain", "rings.jsonl")), before = f.calls.length;
  for (const input of [
    {}, { op: "commit" }, { op: "init" }, { op: "dormancy" }, { op: "faculty_action" },
    { op: "blob", hash: "../private" }, { op: "ring", index: "0" },
    { op: "rings", offset: -1 }, { op: "rings", limit: 101 }, { op: ["summary"] },
  ]) {
    const rejected = await f.request("/api/audit/read", input);
    assert.equal(rejected.status, 400, JSON.stringify({ input, body: rejected.body }));
    assert.ok(rejected.body.code.startsWith("AUDIT_"));
  }
  assert.equal((await f.request("/api/audit/read", { op: "summary" }, { origin: "https://attacker.example" })).status, 403);
  assert.equal(f.calls.length, before, "Rejected requests must not invoke the native engine.");
  assert.deepEqual(await fs.readFile(path.join(root, "chain", "rings.jsonl")), ledger);
});

test("injected generation and review outputs are normalized before native scoring and release", async (t) => {
  const priorName = ["qua", "lia"].join("");
  const priorGate = ["Po", "Q"].join("");
  const retired = new RegExp(`${priorName}|${priorGate}`, "i");
  const f = await fixture(t, {
    generate: () => ({
      text: `Proof of ${priorName} uses ${priorGate.toLowerCase()}.py with care.`,
    }),
    review: () => ({
      ...goodReview(),
      rationale: `This ${priorGate} response promotes kindness.`,
    }),
  });
  await f.ready();
  const message = `Explain Proof of ${priorName}.`;
  const response = await f.request("/api/chat", { message });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(
    response.body.message.content,
    "Proof of interaction uses PoI.py with care.",
  );
  for (const item of [...f.modelCalls, ...f.reviewCalls])
    assert.doesNotMatch(JSON.stringify(item.args), retired);
  const committed = f.calls.find((call) => call.op === "commit");
  assert.equal(committed.exchanges[0].input, message);
  assert.doesNotMatch(committed.exchanges[0].output, retired);
  assert.doesNotMatch(
    JSON.stringify(committed.exchanges[0].assessment),
    retired,
  );
});

test("host, origin, pairing and bearer authentication protect private endpoints", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/state")).status, 401);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    http
      .get(
        `${f.base}/api/status`,
        { headers: { host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal(
    (
      await f.request(
        "/api/pair",
        { code: "TEST-CODE" },
        { origin: "https://attacker.example" },
      )
    ).status,
    403,
  );
  assert.equal((await f.request("/api/pair", { code: "bad" })).status, 401);
  await f.pair();
  const response = await f.request("/api/state");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal((await f.request("/api/unpair", {})).status, 200);
  assert.equal((await f.request("/api/state")).status, 401);
});

test("pairing guesses are rate-limited", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i++)
    assert.equal((await f.request("/api/pair", { code: "wrong" })).status, 401);
  assert.equal(
    (await f.request("/api/pair", { code: "TEST-CODE" })).status,
    429,
  );
});

test("credentials remain in session memory and model switches preserve the chain", async (t) => {
  const f = await fixture(t);
  const created = await f.ready();
  const first = await f.request("/api/chat", { message: "First question" });
  assert.equal(first.status, 200);
  assert.equal(first.body.message.ring.index, 1);
  const changed = await f.request("/api/provider", {
    provider: "anthropic",
    model: "test-model-b",
    apiKey: "second-memory-only-key",
  });
  assert.equal(changed.status, 200);
  const second = await f.request("/api/chat", { message: "Second question" });
  assert.equal(second.status, 200);
  assert.equal(second.body.message.ring.index, 2);
  const commits = f.calls.filter((c) => c.op === "commit");
  assert.equal(commits.length, 2);
  assert.equal(commits[0].root, commits[1].root);
  assert.equal(second.body.state.agent.id, created.agent.id);
  assert.equal(f.modelCalls[0].config.model, "test-model-a");
  assert.equal(f.modelCalls[1].config.model, "test-model-b");
  const state = JSON.stringify((await f.request("/api/state")).body);
  assert.doesNotMatch(
    state,
    /never-persist-this-key|second-memory-only-key|apiKey/,
  );
  assert.doesNotMatch(
    await allText(f.dataDir),
    /never-persist-this-key|second-memory-only-key|apiKey/,
  );
  assert.ok(
    f.calls.every((call) => !JSON.stringify(call).includes("memory-only-key")),
  );
});

test("perspective orchestration scopes the larger Muse allowance while synthesis and ordinary chat keep their limits", async (t) => {
  for (const [model, expected] of [
    ["muse-spark-1.3-contributor", 8192],
    ["generic-model", 2048],
  ]) {
    const f = await fixture(t);
    await f.ready();
    assert.equal(
      (
        await f.request("/api/provider", {
          provider: "openai",
          model,
          apiKey: "synthetic-candidate-budget-key",
          baseUrl: "https://opencode.ai/inference/go/openai/v1",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/api/settings", {
          fork: true,
          perspectives: 3,
          archetypes: ["2", "5", "6"],
        })
      ).status,
      200,
    );
    const reply = await f.request("/api/chat", {
      message: "Compare three perspectives.",
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(
      f.modelCalls.map((call) => call.args.maxTokens),
      [expected, expected, expected, 4096],
    );
    assert.equal(reply.body.message.perspectives.length, 3);
    assert.equal(
      (await f.request("/api/settings", { fork: false })).status,
      200,
    );
    assert.equal(
      (await f.request("/api/chat", { message: "Now use ordinary chat." }))
        .status,
      200,
    );
    assert.equal(f.modelCalls.at(-1).args.maxTokens, 4096);
  }
});

test("incomplete Muse perspective candidates remain held without native commitment or pending output", async (t) => {
  const f = await fixture(t, {
    generate: () => {
      throw Object.assign(new Error("Fixture output allowance exhausted."), {
        code: "PROVIDER_INCOMPLETE",
        status: 502,
      });
    },
  });
  await f.ready();
  await f.request("/api/provider", {
    provider: "openai",
    model: "muse-spark-1.3-contributor",
    apiKey: "synthetic-incomplete-key",
    baseUrl: "https://opencode.ai/inference/go/openai/v1",
  });
  await f.request("/api/settings", {
    fork: true,
    perspectives: 3,
    archetypes: ["2", "5", "6"],
  });
  const reply = await f.request("/api/chat", {
    message: "Hold an incomplete candidate.",
  });
  assert.equal(reply.status, 502);
  assert.equal(reply.body.code, "PROVIDER_INCOMPLETE");
  assert.ok(f.modelCalls.every((call) => call.args.maxTokens === 8192));
  assert.equal(f.reviewCalls.length, 0);
  assert.equal(
    f.calls.some((call) => call.op === "commit"),
    false,
  );
  assert.equal((await f.store.pending(f.store.agents[0])).exchanges.length, 0);
});

test("reflected credentials from generation or review never reach pending files, native writes, state or response", async (t) => {
  for (const stage of ["generation", "review"]) {
    const secret = "never-persist-this-key";
    const f = await fixture(t, {
      generate: () => ({
        text:
          stage === "generation"
            ? `Reflected credential: ${secret}`
            : "A safe candidate.",
      }),
      review: () => ({
        ...goodReview(),
        rationale: `Reflected credential: ${secret}`,
      }),
    });
    await f.ready();
    const response = await f.request("/api/chat", {
      message: "Synthetic reflection check",
    });
    assert.equal(response.status, 502, stage);
    assert.equal(response.body.code, "PROVIDER_CREDENTIAL_REFLECTION");
    assert.ok(!JSON.stringify(response.body).includes(secret));
    assert.equal(f.reviewCalls.length, stage === "generation" ? 0 : 1);
    assert.equal(
      f.calls.some((call) =>
        ["evaluate", "commit", "ingest", "pack_import"].includes(call.op),
      ),
      false,
    );
    assert.ok(!JSON.stringify(f.calls).includes(secret));
    assert.ok(
      !JSON.stringify((await f.request("/api/state")).body).includes(secret),
    );
    assert.ok(!(await allText(f.dataDir)).includes(secret));
    assert.equal(
      (await f.store.pending(f.store.agents[0])).exchanges.length,
      0,
    );
  }
});

test("an active API key pasted into chat is held before provider or native preparation", async (t) => {
  const f = await fixture(t);
  await f.ready();
  const before = f.calls.length;
  const response = await f.request("/api/chat", {
    message: "Accidental credential: never-persist-this-key",
  });
  assert.equal(response.status, 502);
  assert.equal(response.body.code, "PROVIDER_CREDENTIAL_REFLECTION");
  assert.equal(f.modelCalls.length, 0);
  assert.equal(f.reviewCalls.length, 0);
  assert.equal(f.calls.length, before);
  assert.ok(!(await allText(f.dataDir)).includes("never-persist-this-key"));
});

test("expanded legacy evidence and conversation are bounded after normalization without changing canonical metadata", async (t) => {
  const retired = ["qua", "lia"].join("");
  const original = (retired + " ").repeat(1100);
  assert.ok(Buffer.byteLength(original) <= 8192);
  const hash = "ab".repeat(32);
  const f = await fixture(t, {
    prepare: () => ({
      availableEvidence: [{ index: 1, hash, text: original, truncated: false }],
      recentHistory: [{ input: original, output: original }],
    }),
  });
  await f.ready();
  const reply = await f.request("/api/chat", {
    message: "A bounded-context request.",
  });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const context = f.reviewCalls[0].args;
  assert.equal(context.availableEvidence[0].hash, hash);
  assert.equal(context.availableEvidence[0].index, 1);
  assert.equal(context.availableEvidence[0].truncated, true);
  for (const value of [
    context.availableEvidence[0].text,
    ...context.recentConversation.map((entry) => entry.content),
  ]) {
    assert.ok(Buffer.byteLength(value, "utf8") <= 8192);
    assert.ok(!value.includes(retired));
    assert.ok(value.includes("interaction"));
  }
  assert.ok(context.recentConversation.every((entry) => entry.truncated));
});

test("low fruitage holds the candidate, ignores browser score overrides and never commits", async (t) => {
  const f = await fixture(t, {
    generate: () => ({ text: "PRIVATE_HELD_CANDIDATE" }),
    review: () => {
      const r = goodReview();
      r.fruits.love = 0;
      return r;
    },
  });
  await f.ready();
  const response = await f.request("/api/chat", {
    message: "A request",
    scores: Object.fromEntries(DIMENSIONS.map((k) => [k, 255])),
    assessment: goodReview(),
    disableGate: true,
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "COVENANT_REJECTED");
  assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_HELD_CANDIDATE/);
  assert.equal(f.calls.filter((c) => c.op === "commit").length, 0);
  assert.doesNotMatch(await allText(f.dataDir), /PRIVATE_HELD_CANDIDATE/);
});

test("malformed reviewer result is fail-closed", async (t) => {
  assert.equal(strictReview(null).approved, false);
  const f = await fixture(t, {
    review: () => ({
      approved: true,
      decision: "approve",
      scores: { covenant: 255 },
      fruits: { love: 255 },
    }),
  });
  await f.ready();
  const response = await f.request("/api/chat", {
    message: "Check all dimensions",
  });
  assert.equal(response.status, 422);
  assert.equal(f.calls.filter((c) => c.op === "commit").length, 0);
});

test("missing native acceptance or seal verdict cannot release or commit output", async (t) => {
  const f = await fixture(t, { evaluate: () => ({ ok: true }) });
  await f.ready();
  const response = await f.request("/api/chat", {
    message: "Test native transport shape",
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "POI_REJECTED");
  assert.equal(response.body.message, undefined);
  assert.equal(f.calls.filter((c) => c.op === "commit").length, 0);
});

test("missing canonical commit receipt holds answer and retains pending block for recovery", async (t) => {
  const f = await fixture(t, { commit: () => ({ ok: true, accepted: true }) });
  await f.ready();
  const response = await f.request("/api/chat", {
    message: "Need an actual seal receipt",
  });
  assert.equal(response.status, 422);
  assert.equal(response.body.code, "COMMIT_REJECTED");
  assert.equal(response.body.message, undefined);
  const state = await f.request("/api/state");
  assert.equal(state.body.pending.count, 1);
  assert.equal(state.body.pending.heldCount, 1);
  assert.deepEqual(state.body.pending.exchanges, []);
  assert.ok(
    !JSON.stringify(state.body).includes("A helpful and truthful answer."),
  );
  const retry = await f.request("/api/chat", { message: "Another question" });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, "PENDING_HELD");
});

test("invalid settings do not mutate the active loadout or ability settings", async (t) => {
  const f = await fixture(t);
  await f.ready();
  const original = (await f.request("/api/state")).body.settings;
  const result = await f.request("/api/settings", {
    fork: true,
    archetypes: ["not-a-real-archetype"],
  });
  assert.equal(result.status, 400);
  assert.deepEqual((await f.request("/api/state")).body.settings, original);
  assert.equal(
    (
      await f.request("/api/loadout", {
        modalities: ["unknown"],
        senses: ["5"],
      })
    ).status,
    400,
  );
  const valid = await f.request("/api/loadout", {
    modalities: ["2"],
    senses: ["5"],
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.body.loadout, { modalities: ["2"], senses: ["5"] });
});

test("byte mode buffers complete exchanges, then explicit flush re-reviews and commits one block", async (t) => {
  const f = await fixture(t);
  await f.ready();
  assert.equal(
    (
      await f.request("/api/settings", {
        continuum: { enabled: true, mode: "bytes", targetBytes: 10000 },
      })
    ).status,
    200,
  );
  for (const message of [
    "First buffered question",
    "Second buffered question",
  ]) {
    const response = await f.request("/api/chat", { message });
    assert.equal(response.status, 200);
    assert.equal(response.body.message.pending, true);
    assert.equal(response.body.message.ring, null);
  }
  assert.equal(f.calls.filter((c) => c.op === "commit").length, 0);
  assert.equal(f.reviewCalls.length, 2);
  const flush = await f.request("/api/continuum/flush", {});
  assert.equal(flush.status, 200);
  assert.equal(f.reviewCalls.length, 4);
  const commits = f.calls.filter((c) => c.op === "commit");
  assert.equal(commits.length, 1);
  assert.equal(commits[0].exchanges.length, 2);
  assert.equal(flush.body.state.pending.count, 0);
});

test("threshold commits automatically after an entire input and output exchange", async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.request("/api/settings", {
    continuum: { enabled: true, mode: "bytes", targetBytes: 1 },
  });
  const response = await f.request("/api/chat", {
    message: "é🙂 complete exchange",
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.message.pending, false);
  const commit = f.calls.find((c) => c.op === "commit");
  assert.equal(commit.exchanges[0].input, "é🙂 complete exchange");
  assert.equal(commit.exchanges[0].output, "A helpful and truthful answer.");
});

test("external appends block pending continuation until explicit re-reviewed flush", async (t) => {
  const f = await fixture(t);
  await f.ready();
  await f.request("/api/settings", {
    continuum: { enabled: true, mode: "bytes", targetBytes: 10000 },
  });
  await f.request("/api/chat", { message: "Buffer this" });
  const chain = [...f.chains.values()][0];
  chain.index = 8;
  const continued = await f.request("/api/chat", {
    message: "Do not silently append stale context",
  });
  assert.equal(continued.status, 409);
  assert.equal(continued.body.code, "PENDING_STALE");
  assert.equal(f.modelCalls.length, 1);
  const flushed = await f.request("/api/continuum/flush", {});
  assert.equal(flushed.status, 200);
  assert.equal(flushed.body.ring.index, 9);
  assert.equal(f.reviewCalls.length, 2);
});

test("a failed re-review during flush retains buffer without committing", async (t) => {
  let held = false;
  const f = await fixture(t, {
    review: () => {
      const result = goodReview();
      if (held) result.fruits.faith = 0;
      return result;
    },
  });
  await f.ready();
  await f.request("/api/settings", {
    continuum: { enabled: true, mode: "bytes", targetBytes: 10000 },
  });
  await f.request("/api/chat", { message: "Buffer for explicit flush" });
  held = true;
  assert.equal((await f.request("/api/continuum/flush", {})).status, 422);
  assert.equal(f.calls.filter((c) => c.op === "commit").length, 0);
  assert.equal((await f.request("/api/state")).body.pending.count, 1);
});

test("state store distinguishes case-sensitive roots on non-Windows hosts", async (t) => {
  if (process.platform === "win32")
    return t.skip("Windows paths are case-insensitive.");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ct-chat-server-test-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = await new StateStore(directory).load();
  const first = await store.add(
    path.join(directory, "Agent"),
    "Uppercase",
    true,
  );
  const second = await store.add(
    path.join(directory, "agent"),
    "Lowercase",
    true,
  );
  assert.notEqual(first.id, second.id);
});

test("ending a bridge session cancels model work and prevents commitment", async (t) => {
  let reached;
  const started = new Promise((resolve) => {
    reached = resolve;
  });
  const f = await fixture(t, {
    generate: async (config, { signal }) => {
      reached();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      throw Object.assign(new Error("Model request cancelled."), {
        code: "CANCELLED",
        status: 499,
      });
    },
  });
  await f.ready();
  const request = f.request("/api/chat", {
    message: "Cancel this in-flight request.",
  });
  await started;
  assert.equal((await f.request("/api/unpair", {})).status, 200);
  assert.equal((await request).status, 499);
  assert.equal(f.calls.filter((c) => c.op === "commit").length, 0);
  assert.equal(f.sessions.size, 0);
});
