import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createApp, strictReview } from "../server.mjs";
import { FRUITS, DIMENSIONS } from "../lib/providers.mjs";
import { StateStore } from "../lib/state.mjs";

const HASH = (index) => index.toString(16).padStart(64, "0");
const goodReview = () => ({
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
    await new Promise((resolve) => {
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
