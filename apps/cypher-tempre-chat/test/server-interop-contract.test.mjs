/** Real HTTP boundary with deterministic native/model fixtures; no API calls. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createApp } from "../server.mjs";
import { FRUITS, DIMENSIONS } from "../lib/providers.mjs";

const HASH = "a".repeat(64), SOURCE_HASH = "b".repeat(64), PLAN_HASH = "c".repeat(64);
const evidence = [{ index: 0, hash: HASH, text: "The user requested careful local maintenance.", truncated: false }];
const facultyExecution = { scope: "turn", entries: [
  { key: "modality:2", kind: "modality", name: "Reason", mode: "computed", mechanism: "base-op", status: "completed" },
  { key: "sense:5", kind: "sense", name: "Lens", mode: "frame", mechanism: "lens", status: "completed" },
] };
const operatorCompatibility = { available: true, approved: false, source: "active_ops.py", sha256: SOURCE_HASH,
  activation: "local-cli-only", isSandbox: false };
const goodReview = rings => ({ usedRings: rings || [], approved: true, decision: "approve",
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])), rationale: "Careful, bounded fixture operation." });
const ANSWER = "We can proceed patiently and carefully, acknowledging uncertainty.";

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-server-interop-"));
  const calls = [], reviews = [], history = [];
  const inspected = () => ({ ok: true, verified: true, head: { index: 0, hash: HASH },
    genesis: { name: "Contract Fixture", covenant: FRUITS }, runtime: { supported: true, mode: "active" },
    faculties: [], history, operatorCompatibility });
  const app = await createApp({ dataDir, pairingCode: "CONTRACT-FIXTURE", licenseConfig: { mode: "holdings", required: false },
    engine: async request => {
      calls.push(structuredClone(request));
      if (["inspect", "init", "verify"].includes(request.op)) return inspected();
      if (request.op === "prepare") return { ...inspected(), context: "Verified context.", frames: [], computed: {},
        loadout: [], memories: [], availableEvidence: evidence, recentHistory: [], facultyExecution };
      if (request.op === "route") return { head: inspected().head, availableEvidence: evidence,
        route: { decision: "REPLAY", antecedent: { ring: 0, answer: ANSWER, truncated: false } } };
      if (request.op === "memory") return { head: inspected().head, availableEvidence: evidence };
      if (request.op === "evaluate") return { accepted: true, verdict: "SEAL" };
      if (request.op === "commit") {
        history.push(...request.exchanges.map(exchange => ({ ...exchange, ring: 1, hash: SOURCE_HASH })));
        return { accepted: true, ring: { index: 1, hash: SOURCE_HASH } };
      }
      if (["faculty_action", "maintenance"].includes(request.op)) {
        if (!request.preview) return { accepted: true, head: inspected().head };
        return { head: inspected().head, plan: { description: "Exact native maintenance plan" },
          availableEvidence: evidence, recentHistory: [{ input: "Earlier request", output: "Earlier accepted response" }],
          ...(options.missingReviewAction ? {} : { reviewAction: { input: "Native reason and evidence", output: "Exact native proposed mutation" } }) };
      }
      if (request.op === "pack_preview") return { pack: request.pack, head: inspected().head, planHash: options.missingPlanHash ? undefined : PLAN_HASH,
        action: { input: "Import portable faculty", output: "Exact full portable mutation" }, report: { imported: [{ name: "Portable" }], errors: [], blocked: [] } };
      if (request.op === "pack_import") return { accepted: true, verified: true, imported: [{ name: "Portable" }], head: inspected().head,
        ring: { index: 1, hash: SOURCE_HASH } };
      if (request.op === "pack_export") return { pack: options.exportPack || { legacy: request.legacy } };
      throw new Error(`Unexpected fixture native operation: ${request.op}`);
    },
    generate: async (_config, args) => ({ text: args.system.startsWith("Plan retrieval")
      ? JSON.stringify({ queries: [], entities: [], shapes: ["narrow"], rings: [0], useReplay: true, labels: { senses: [], modalities: [] } }) : ANSWER }),
    review: async (_config, args) => {
      reviews.push(args);
      return options.review ? options.review(args, reviews.length) : goodReview(args.availableEvidence?.length ? [0] : []);
    },
  });
  const record = await app.store.add(path.join(dataDir, "agent"), "Contract Fixture", true);
  record.cognition = { learning: false, autoRoute: false, semanticRecall: false, autoSprout: false };
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`; let token;
  async function call(endpoint, input) {
    const response = await fetch(base + endpoint, { method: input === undefined ? "GET" : "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(input === undefined ? {} : { "content-type": "application/json" }) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  }
  token = (await call("/api/pair", { code: "CONTRACT-FIXTURE" })).body.token;
  assert.equal((await call("/api/provider", { provider: "openai", model: "synthetic-contract", apiKey: "not-a-real-credential" })).status, 200);
  t.after(async () => {
    await new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); });
    assert.ok(path.resolve(dataDir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(dataDir).startsWith("ct-server-interop-"));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...app, call, calls, reviews, record };
}
const ok = result => assert.equal(result.status, 200, JSON.stringify(result.body));

test("state, pending and sealed exchanges preserve explicit execution/revision receipts", async t => {
  const f = await fixture(t, { review: (_args, number) => number === 1 ? { ...goodReview(), approved: false, decision: "reject" } : goodReview() });
  const state = await f.call("/api/cognition"); ok(state);
  assert.deepEqual(state.body.operatorCompatibility, operatorCompatibility);
  ok(await f.call("/api/settings", { continuum: { enabled: true, mode: "bytes", targetBytes: 65536 } }));
  const chat = await f.call("/api/chat", { message: "Answer patiently." }); ok(chat);
  assert.deepEqual(chat.body.message.facultyExecution, facultyExecution);
  assert.equal(chat.body.message.replayed, false); assert.equal(chat.body.message.replayRing, null);
  assert.equal(chat.body.message.revisions, 1);
  const pending = (await f.call("/api/state")).body.pending.exchanges[0];
  assert.deepEqual(pending.facultyExecution, facultyExecution);
  assert.equal(pending.revisions, 1); assert.equal(pending.replayed, false);
  ok(await f.call("/api/continuum/flush", {}));
  const committed = f.calls.find(request => request.op === "commit").exchanges[0];
  assert.deepEqual(committed.facultyExecution, facultyExecution);
  assert.equal(committed.revisions, 1); assert.equal(committed.replayed, false);
});

test("reviewed replay has boolean metadata, distinct source ring and actual activity events", async t => {
  const f = await fixture(t);
  ok(await f.call("/api/cognition", { autoRoute: true, semanticRecall: true }));
  const result = await f.call("/api/chat", { message: "Repeat the careful answer." }); ok(result);
  assert.equal(result.body.message.replayed, true); assert.equal(result.body.message.replayRing, 0);
  const committed = f.calls.find(request => request.op === "commit").exchanges[0];
  assert.equal(committed.replayed, true); assert.equal(committed.replayRing, 0);
  const events = (await f.call("/api/activity")).body.events.filter(event => event.ability === "replay");
  assert.deepEqual(events.map(event => event.status), ["started", "completed"]);
});

test("control reviews use exact native actions and evidence, preserve reason, and never infer confirmation", async t => {
  const f = await fixture(t);
  ok(await f.call("/api/cognition", { learning: true }));
  ok(await f.call("/api/maintenance", { action: "index", preview: true, reason: "  Rebuild after local import  " }));
  assert.equal(f.calls.find(request => request.op === "maintenance").confirmed, undefined);
  assert.equal(f.reviews.length, 0);
  ok(await f.call("/api/maintenance", { action: "index", confirm: true, reason: "Rebuild after local import" }));
  const reviewed = f.reviews[0];
  assert.equal(reviewed.input, "Native reason and evidence");
  assert.equal(reviewed.candidate, "Exact native proposed mutation");
  assert.equal(reviewed.availableEvidence[0].index, 0);
  assert.equal(reviewed.recentConversation[0].content, "Earlier request");
  const native = f.calls.filter(request => request.op === "maintenance");
  assert.equal(native[1].confirmed, true);
  assert.equal(native[2].reason, "Rebuild after local import");
  assert.deepEqual(native[2].usedRings, [0]);
  const before = f.calls.length;
  for (const reason of ["x".repeat(4097), {}, 42])
    assert.equal((await f.call("/api/maintenance", { action: "train", confirm: true, reason })).status, 400);
  const reflectedKey = await f.call("/api/maintenance", { action: "train", confirm: true, reason: "not-a-real-credential" });
  assert.equal(reflectedKey.body.code, "PROVIDER_CREDENTIAL_REFLECTION");
  const pausedKey = await f.call("/api/cognition", { mode: "dormant", confirm: true, reason: "not-a-real-credential" });
  assert.equal(pausedKey.body.code, "PROVIDER_CREDENTIAL_REFLECTION");
  assert.equal(f.calls.length, before, "Invalid reason must not reach the native engine.");
});

test("missing native review action fails closed without model review or mutation", async t => {
  const f = await fixture(t, { missingReviewAction: true });
  ok(await f.call("/api/cognition", { learning: true }));
  const result = await f.call("/api/maintenance", { action: "index", confirm: true });
  assert.equal(result.status, 422); assert.equal(result.body.code, "CONTROL_PROTOCOL");
  assert.equal(f.reviews.length, 0);
  assert.equal(f.calls.some(request => request.op === "maintenance" && request.preview !== true), false);
});

test("full portable packs above the former cap reach native validation and bind import to plan hash", async t => {
  const f = await fixture(t), pack = { metadata: "x".repeat(300000) };
  ok(await f.call("/api/faculties/preview", { pack }));
  ok(await f.call("/api/faculties/import", { pack, expectedHead: HASH }));
  assert.equal(f.calls.find(request => request.op === "pack_import").planHash, PLAN_HASH);
  assert.equal((await f.call("/api/faculties/preview", { pack: { metadata: "x".repeat(4 * 1024 * 1024) } })).status, 413);
  ok(await f.call("/api/faculties/export", { keys: ["modality:2"], legacy: true }));
  assert.equal(f.calls.find(request => request.op === "pack_export").legacy, true);
});

test("portable imports without an exact native plan digest fail before review and mutation", async t => {
  const f = await fixture(t, { missingPlanHash: true });
  const result = await f.call("/api/faculties/import", { pack: { metadata: "Synthetic pack", interaction_portability: {} }, expectedHead: HASH });
  assert.equal(result.status, 422); assert.equal(result.body.code, "PACK_PROTOCOL");
  assert.equal(f.reviews.length, 0);
  assert.equal(f.calls.some(request => request.op === "pack_import"), false);
});

test("faculty export with a reflected connected credential is held before download", async t => {
  const f = await fixture(t, { exportPack: { interaction_portability: {
    artifacts: [{ kind: "authored-module", text: "PRIVATE_KEY = 'not-a-real-credential'" }],
  } } });
  const result = await f.call("/api/faculties/export", { keys: ["modality:2"] });
  assert.equal(result.body.code, "PROVIDER_CREDENTIAL_REFLECTION");
  assert.equal(result.body.pack, undefined);
  assert.equal(JSON.stringify(result.body).includes("not-a-real-credential"), false);
  assert.equal(f.reviews.length, 0);
});
