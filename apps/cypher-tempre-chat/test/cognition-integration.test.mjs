/** Real HTTP and native engine; model transports are deterministic, local fixtures. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createApp } from "../server.mjs";
import { engine as nativeEngine } from "../lib/engine.mjs";
import { FRUITS, DIMENSIONS } from "../lib/providers.mjs";

const ANSWER = "We can approach this carefully, honestly and patiently, while acknowledging missing information.";
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const goodReview = () => ({ usedRings: [], approved: true, decision: "approve",
  scores: Object.fromEntries(DIMENSIONS.map(key => [key, 240])),
  fruits: Object.fromEntries(FRUITS.map(key => [key, 240])),
  rationale: "Patient, honest and consistent with the genesis covenant." });
const readRings = async root => (await fs.readFile(path.join(root, "chain", "rings.jsonl"), "utf8"))
  .trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const chatRings = async root => (await readRings(root)).filter(r => r.payload?.event === "web_chat_turn");

async function fingerprint(root) {
  const result = {};
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__" || entry.name.endsWith(".lock")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else result[path.relative(root, file).replaceAll("\\", "/")] =
        createHash("sha256").update(await fs.readFile(file)).digest("hex");
    }
  }
  await visit(root);
  return result;
}

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ct-cognition-integration-"));
  const root = path.join(dataDir, "agent"), calls = [], generated = [], reviewed = [];
  await nativeEngine({ op: "init", root, name: "Cognition Fixture" });
  const app = await createApp({ dataDir, pairingCode: "COGNITION-FIXTURE",
    licenseConfig: { mode: "holdings", required: options.holdings === true },
    engine: async request => {
      calls.push(structuredClone(request));
      const result = await nativeEngine(request);
      await options.afterEngine?.(request, result);
      return result;
    },
    generate: async (config, args) => {
      generated.push({ config, args });
      return options.generate ? options.generate(config, args) : { text: ANSWER, usage: {} };
    },
    review: async (config, args) => {
      reviewed.push({ config, args });
      return options.review ? options.review(config, args) : goodReview();
    },
  });
  const record = await app.store.add(root, "Cognition Fixture", true);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => { app.server.closeAllConnections(); app.server.close(resolve); });
    const resolved = path.resolve(dataDir);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith("ct-cognition-integration-"));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  async function client() {
    let token;
    const call = async (endpoint, input) => {
      const res = await fetch(base + endpoint, { method: input === undefined ? "GET" : "POST",
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(input === undefined ? {} : { "content-type": "application/json" }) },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
      return { status: res.status, body: await res.json() };
    };
    const paired = await call("/api/pair", { code: "COGNITION-FIXTURE" });
    assert.equal(paired.status, 200); token = paired.body.token;
    return { call, token };
  }
  const owner = await client();
  if (!options.holdings) {
    const provider = await owner.call("/api/provider", { provider: "openai", model: "fixture-model", apiKey: "test-memory-only-key" });
    assert.equal(provider.status, 200);
    const controls = await owner.call("/api/cognition", { autoRoute: false, semanticRecall: false, autoSprout: false });
    assert.equal(controls.status, 200, JSON.stringify(controls.body));
  }
  return { ...app, ...owner, client, root, record, dataDir, calls, generated, reviewed };
}
const ok = response => assert.equal(response.status, 200, JSON.stringify(response.body));
const activity = body => body.activity || body;

test("real engine: active review/seal, manual pause, stateless raw calls and resume", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const active = await f.call("/api/chat", { message: "Help me consider a patient response." }); ok(active);
  assert.equal(f.reviewed.length, 1); assert.equal((await chatRings(f.root)).length, 1);
  const unconfirmed = await f.call("/api/cognition", { mode: "dormant" });
  assert.ok(unconfirmed.status >= 400); assert.equal((await nativeEngine({ op: "inspect", root: f.root })).runtime.mode, "active");
  ok(await f.call("/api/cognition", { mode: "dormant", confirm: true }));
  const before = await fingerprint(f.root), callIndex = f.calls.length, reviewCount = f.reviewed.length;
  const rawOne = await f.call("/api/chat", { message: "PRIVATE_RAW_ONE" }); ok(rawOne);
  const rawTwo = await f.call("/api/chat", { message: "PRIVATE_RAW_TWO" }); ok(rawTwo);
  assert.equal(rawTwo.body.message.raw, true);
  assert.equal(rawTwo.body.message.mode, "dormant");
  assert.equal(rawTwo.body.message.pending, false);
  assert.equal(rawTwo.body.message.ring, null);
  assert.equal(rawTwo.body.message.gate.required, false);
  assert.equal(rawTwo.body.message.gate.decision, "DORMANT");
  assert.equal(f.reviewed.length, reviewCount);
  assert.deepEqual(await fingerprint(f.root), before, "Raw chat must not mutate native chain, faculties or telemetry.");
  assert.equal(f.calls.slice(callIndex).some(c => ["prepare", "route", "memory", "evaluate", "commit", "teach", "search", "maintenance"].includes(c.op)), false);
  assert.equal(JSON.stringify(f.generated.at(-1).args).includes("PRIVATE_RAW_ONE"), false, "Ordinary calls are stateless and cannot silently retain prior raw turns.");
  assert.equal((await f.call("/api/state")).body.gate.required, false);
  ok(await f.call("/api/cognition", { mode: "active", confirm: true }));
  ok(await f.call("/api/chat", { message: "Resume a careful, patient response." }));
  assert.equal((await chatRings(f.root)).length, 2);
  assert.equal(f.reviewed.length, reviewCount + 1);
});

test("real engine: learning-off retains accepted conversation but suppresses growth and teaching", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  ok(await f.call("/api/cognition", { learning: false, autoSprout: true, autoDream: true }));
  const before = await fingerprint(f.root), offset = f.calls.length;
  ok(await f.call("/api/chat", { message: "Consider a novel magnetohydrodynamic synchronization question carefully." }));
  const calls = f.calls.slice(offset), commit = calls.find(c => c.op === "commit");
  assert.ok(commit); assert.equal(commit.learning, false); assert.equal(commit.growth, false);
  assert.equal(calls.some(c => ["teach", "maintenance"].includes(c.op)), false);
  assert.equal((await chatRings(f.root)).length, 1);
  const after = await fingerprint(f.root);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (/registry\/|telemetry|teach|extractor|calibrat|learned|lens|auto_sprout/.test(name))
      assert.equal(after[name], before[name], `Learning-off changed ${name}`);
  }
});

test("real engine: activity reflects a deferred call, hides content and is isolated by paired session", { timeout: 180000 }, async t => {
  const started = deferred(), release = deferred();
  const f = await fixture(t, { generate: async () => { started.resolve(); await release.promise; return { text: ANSWER }; } });
  t.after(() => release.resolve());
  const other = await f.client();
  const running = f.call("/api/chat", { message: "PRIVATE_ACTIVITY_PROMPT" });
  await started.promise;
  const own = await f.call("/api/activity"), peer = await other.call("/api/activity"); ok(own); ok(peer);
  assert.equal(activity(own.body).running, true);
  assert.ok(activity(own.body).activeAbilities.includes("model"));
  assert.equal(activity(peer.body).running, false);
  assert.deepEqual(activity(peer.body).events, []);
  const serialized = JSON.stringify(own.body);
  for (const privateValue of ["PRIVATE_ACTIVITY_PROMPT", "test-memory-only-key", ANSWER]) assert.equal(serialized.includes(privateValue), false);
  release.resolve(); ok(await running);
  const finished = activity((await f.call("/api/activity")).body);
  assert.equal(finished.running, false); assert.deepEqual(finished.activeAbilities, []);
  assert.ok(finished.events.some(event => event.ability === "model" && event.status === "completed"));
  assert.ok(finished.events.some(event => event.ability === "seal" && event.status === "completed"));
});

test("real engine: externally paused native chain forces raw mode despite stored active settings", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  const inspected = await nativeEngine({ op: "inspect", root: f.root });
  await nativeEngine({ op: "dormancy", root: f.root, expectedHead: inspected.head.hash, action: "pause", confirmed: true });
  const before = await fingerprint(f.root), offset = f.calls.length;
  const state = await f.call("/api/state"); ok(state); assert.equal(state.body.cognition.mode, "dormant");
  const raw = await f.call("/api/chat", { message: "Ordinary call after external pause." }); ok(raw);
  assert.equal(raw.body.message.raw, true); assert.equal(f.reviewed.length, 0);
  assert.equal(f.calls.slice(offset).some(c => ["prepare", "commit", "evaluate", "teach"].includes(c.op)), false);
  assert.deepEqual(await fingerprint(f.root), before);
});

test("real engine: pausing during generation cancels stale output before review or seal", { timeout: 180000 }, async t => {
  const started = deferred(), release = deferred();
  let modelSignal;
  const f = await fixture(t, { generate: async (_config, args) => {
    modelSignal = args.signal; started.resolve(); await release.promise;
    return { text: "This stale response must never be released." };
  } });
  t.after(() => release.resolve());
  const generating = f.call("/api/chat", { message: "Begin a long response." });
  await started.promise;
  const pause = f.call("/api/cognition", { mode: "dormant", confirm: true });
  // Give the HTTP control request a chance to cancel the in-flight transport.
  for (let i = 0; i < 30 && !modelSignal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(modelSignal.aborted, true);
  release.resolve();
  const [response, paused] = await Promise.all([generating, pause]);
  assert.ok(response.status >= 400, JSON.stringify(response.body));
  assert.equal(response.body.message, undefined);
  ok(paused);
  assert.equal(f.reviewed.length, 0); assert.equal((await chatRings(f.root)).length, 0);
  assert.equal((await nativeEngine({ op: "inspect", root: f.root })).runtime.mode, "dormant");
  const trace = activity((await f.call("/api/activity")).body);
  assert.equal(trace.running, false); assert.deepEqual(trace.activeAbilities, []);
});

test("real engine: manual maintenance requires confirmation and cannot train with learning disabled", { timeout: 180000 }, async t => {
  const f = await fixture(t), offset = f.calls.length;
  for (const action of ["index", "dream", "train"]) {
    const denied = await f.call("/api/maintenance", { action });
    assert.ok(denied.status >= 400, action);
  }
  assert.equal(f.calls.slice(offset).some(c => c.op === "maintenance" && c.preview !== true), false);
  ok(await f.call("/api/cognition", { learning: false }));
  const denied = await f.call("/api/maintenance", { action: "train", confirm: true });
  assert.ok(denied.status >= 400);
  ok(await f.call("/api/cognition", { mode: "dormant", confirm: true }));
  const asleep = await f.call("/api/maintenance", { action: "dream", confirm: true });
  assert.ok(asleep.status >= 400);
});

test("real engine: holdings gate protects enabling work while pause and cancellation stay available", { timeout: 180000 }, async t => {
  const f = await fixture(t, { holdings: true }), before = await fingerprint(f.root);
  for (const [endpoint, body] of [["/api/cognition", { learning: false }],
    ["/api/maintenance", { action: "dream", confirm: true }],
    ["/api/faculties/lifecycle", { action: "hibernate", key: "sense:5", confirm: true }]]) {
    const denied = await f.call(endpoint, body);
    assert.equal(denied.status, 403, `${endpoint}: ${denied.body.code}`);
    assert.equal(denied.body.code, "HOLDINGS_REQUIRED");
  }
  ok(await f.call("/api/cancel", {}));
  assert.deepEqual(await fingerprint(f.root), before);
  assert.equal(f.calls.some(c => ["dormancy", "maintenance", "faculty_action"].includes(c.op)), false);
  ok(await f.call("/api/cognition", { mode: "dormant", confirm: true }));
  assert.equal((await nativeEngine({ op: "inspect", root: f.root })).runtime.mode, "dormant");
  const resume = await f.call("/api/cognition", { mode: "active", confirm: true });
  assert.equal(resume.status, 403); assert.equal(resume.body.code, "HOLDINGS_REQUIRED");
});

test("real engine: semantic memory toggles invoke shaped evidence and propagate canonical sources into generation", { timeout: 180000 }, async t => {
  let invalidPlan = false;
  const plans = [];
  const f = await fixture(t, { generate: async (_config, args) => {
    if (args.system.startsWith("Plan retrieval for a local Timechain agent.")) {
      const offered = JSON.parse(args.messages.at(-1).content);
      plans.push(offered);
      return { text: JSON.stringify({ queries: ["blue notebook", "notebook preference"],
        entities: ["notebook"], shapes: ["update", "relative"],
        rings: invalidPlan ? [999999] : offered.availableEvidence.slice(0, 1).map(e => e.index),
        useReplay: false, labels: { senses: ["Invented faculty must not be taught"], modalities: [] } }) };
    }
    return { text: ANSWER };
  } });
  ok(await f.call("/api/chat", { message: "Please remember that I prefer my blue notebook." }));
  assert.equal(plans.length, 0);
  ok(await f.call("/api/cognition", { semanticRecall: true, autoRoute: true }));
  let offset = f.calls.length;
  ok(await f.call("/api/chat", { message: "What notebook preference did I share earlier?" }));
  assert.equal(plans.length, 1);
  assert.ok(plans[0].availableEvidence.length > 0);
  const calls = f.calls.slice(offset), memory = calls.filter(c => c.op === "memory");
  assert.ok(calls.some(c => c.op === "route"));
  assert.ok(memory.some(c => c.action === "fetch"));
  assert.ok(memory.some(c => c.action === "evidence" && c.shapes.includes("update")));
  assert.ok(memory.every(c => c.embed === true));
  const generation = f.generated.filter(item => !item.args.system.startsWith("Plan retrieval")).at(-1);
  assert.match(generation.args.system, /canonicalEvidence/);
  assert.match(generation.args.system, /blue notebook/);
  assert.match(generation.args.system, /bounded evidence selection/);
  for (const call of calls.filter(c => c.op === "teach"))
    assert.equal(JSON.stringify(call.labels).includes("Invented faculty"), false);
  invalidPlan = true; offset = f.calls.length;
  ok(await f.call("/api/chat", { message: "Please consider the notebook preference carefully." }));
  assert.equal(f.calls.slice(offset).some(c => c.op === "memory" && c.action === "fetch"), false,
    "An unoffered ring ID must invalidate the plan and fall back to bounded native evidence.");
  ok(await f.call("/api/cognition", { semanticRecall: false, autoRoute: false }));
  offset = f.calls.length;
  ok(await f.call("/api/chat", { message: "Offer a patient next step." }));
  assert.equal(f.calls.slice(offset).some(c => ["route", "memory"].includes(c.op)), false);
  assert.equal(plans.length, 2);
});

test("real engine: perspective settings produce reviewed model rollouts and a native tree receipt", { timeout: 180000 }, async t => {
  const continuationInputs = [];
  const f = await fixture(t, { generate: async (_config, args) => {
    if (args.system.includes("Extend a previously reviewed candidate")) {
      continuationInputs.push(JSON.parse(args.messages.at(-1).content));
      return { text: `A careful continuation: ${ANSWER}` };
    }
    return { text: ANSWER };
  } });
  ok(await f.call("/api/cognition", { searchIterations: 2, searchDepth: 2 }));
  ok(await f.call("/api/settings", { fork: true, perspectives: 2, archetypes: ["2", "5"] }));
  const result = await f.call("/api/chat", { message: "Compare two careful perspectives on choosing a patient next step." }); ok(result);
  const search = result.body.message.search;
  assert.equal(search.algorithm, "native-uic-mcts");
  assert.equal(search.modelInferenceBudget, 2);
  assert.equal(search.rolloutAttempts, 2);
  assert.equal(search.modelRollouts, 2);
  assert.equal(search.exploredDepth, 2);
  assert.equal(continuationInputs.length, 2);
  assert.ok(continuationInputs.every(input => input.perspectivePath.length === 2 && input.previousCandidate === ANSWER));
  assert.ok(search.nodes.some(node => node.path.length === 2 && node.visits > 0));
  assert.equal(search.reviewedRollouts.length, 2);
  assert.ok(search.reviewedRollouts.every(r => r.summary.startsWith("A careful continuation:")));
  const nativeSearchCalls = f.calls.filter(c => c.op === "search");
  assert.equal(nativeSearchCalls.length, 3);
  assert.equal(nativeSearchCalls.at(-1).rollouts.length, 2);
  const synthesis = f.generated.find(item => item.args.system.includes("Synthesize the strongest supported answer"));
  assert.equal(JSON.parse(synthesis.args.messages.at(-1).content).nativeSearch.modelRollouts, 2);
  const sealed = (await chatRings(f.root)).at(-1);
  assert.equal(sealed.payload.exchanges[0].search.modelRollouts, 2);
  ok(await f.call("/api/settings", { fork: false }));
  const offset = f.calls.length;
  ok(await f.call("/api/chat", { message: "Offer a careful ordinary next step." }));
  assert.equal(f.calls.slice(offset).some(c => c.op === "search"), false);
});

test("real engine: bounded revision rechecks a held candidate and never seals an exhausted candidate", { timeout: 180000 }, async t => {
  let shouldReject = true;
  const f = await fixture(t, { review: () => {
    const result = goodReview();
    if (shouldReject) {
      shouldReject = false;
      result.approved = false; result.decision = "reject";
      result.fruits.kindness = 60;
    }
    return result;
  } });
  ok(await f.call("/api/cognition", { revisionLimit: 1 }));
  const recovered = await f.call("/api/chat", { message: "Help me respond kindly and patiently." }); ok(recovered);
  assert.equal(recovered.body.message.revisions, 1);
  assert.equal(f.generated.length, 2); assert.equal(f.reviewed.length, 2);
  assert.match(f.generated[1].args.system, /prior candidate was withheld/);
  assert.equal((await chatRings(f.root)).length, 1);
  const rejecting = await fixture(t, { review: () => {
    const result = goodReview(); result.approved = false; result.decision = "reject";
    result.fruits.kindness = 60; return result;
  } });
  ok(await rejecting.call("/api/cognition", { revisionLimit: 2 }));
  const held = await rejecting.call("/api/chat", { message: "Help me respond kindly and patiently." });
  assert.equal(held.status, 422); assert.equal(held.body.code, "COVENANT_REJECTED");
  assert.equal(held.body.message, undefined);
  assert.equal(rejecting.generated.length, 3); assert.equal(rejecting.reviewed.length, 3);
  assert.equal((await chatRings(rejecting.root)).length, 0);
  assert.equal(rejecting.calls.some(c => c.op === "commit" || c.op === "teach"), false);
  assert.equal((await rejecting.call("/api/state")).body.pending.count, 0);
});

test("real engine: post-commit teaching learns only selected equipped labels and stays off when frozen", { timeout: 180000 }, async t => {
  const f = await fixture(t, { generate: async (_config, args) => {
    if (args.system.startsWith("Plan retrieval for a local Timechain agent.")) {
      const offered = JSON.parse(args.messages.at(-1).content);
      return { text: JSON.stringify({ queries: [], entities: [], shapes: ["narrow"], rings: [],
        useReplay: false, labels: {
          senses: offered.equipped.filter(e => e.kind === "sense").slice(0, 1).map(e => e.name),
          modalities: offered.equipped.filter(e => e.kind === "modality").slice(0, 1).map(e => e.name),
        } }) };
    }
    return { text: ANSWER };
  } });
  ok(await f.call("/api/cognition", { semanticRecall: true }));
  const response = await f.call("/api/chat", { message: "Help me reason patiently about a new topic." }); ok(response);
  assert.equal(response.body.message.learning.enabled, true);
  assert.equal(response.body.message.learning.taught, 1);
  assert.equal(response.body.message.learning.held, 0);
  const commitIndex = f.calls.findIndex(c => c.op === "commit");
  const teachIndex = f.calls.findIndex(c => c.op === "teach");
  assert.ok(teachIndex > commitIndex);
  assert.equal(f.calls[teachIndex].labels.senses.length, 1);
  assert.equal(f.calls[teachIndex].labels.modalities.length, 1);
  const before = await fingerprint(f.root), offset = f.calls.length;
  ok(await f.call("/api/cognition", { learning: false }));
  const frozen = await f.call("/api/chat", { message: "Consider another patient response without learning." }); ok(frozen);
  assert.equal(frozen.body.message.learning.enabled, false);
  assert.equal(f.calls.slice(offset).some(c => c.op === "teach"), false);
  const after = await fingerprint(f.root);
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (/extractor|teach|telemetry|calibrat|lens/.test(name)) assert.equal(after[name], before[name], name);
});

test("real engine: opted-in idle Dream runs after the turn and requires a fresh semantic review", { timeout: 180000 }, async t => {
  const f = await fixture(t);
  ok(await f.call("/api/cognition", { autoDream: true }));
  f.record.lastDreamHeight = -100; await f.store.save();
  const result = await f.call("/api/chat", { message: "Consider this patiently before idle consolidation." }); ok(result);
  const end = Date.now() + 15000;
  while (Date.now() < end && !f.calls.some(c => c.op === "maintenance" && c.confirmed === true && c.preview !== true))
    await new Promise(resolve => setTimeout(resolve, 25));
  const dream = f.calls.find(c => c.op === "maintenance" && c.confirmed === true && c.preview !== true);
  assert.ok(dream, JSON.stringify({ message: "Opted-in scheduled consolidation did not reach the native executor.",
    calls: f.calls.slice(-10).map(({ op, action, preview, confirmed }) => ({ op, action, preview, confirmed })),
    cognition: f.record.cognition, lastDreamHeight: f.record.lastDreamHeight,
    activity: (await f.call("/api/activity")).body }));
  assert.equal(dream.action, "dream"); assert.equal(dream.assessment.approved, true);
  assert.ok(f.calls.findIndex(c => c.op === "commit") < f.calls.indexOf(dream));
  const reviewedDream = f.reviewed.find(r => {
    try { return JSON.parse(r.args.candidate).action === "dream"; } catch { return false; }
  });
  assert.ok(reviewedDream, "Native Dream plan must receive a semantic review before mutation.");
  assert.equal(JSON.parse(reviewedDream.args.candidate).userConfirmed, true);
  assert.equal(JSON.parse(reviewedDream.args.candidate).userReason, dream.reason);
  while (Date.now() < end && (await f.call("/api/activity")).body.running)
    await new Promise(resolve => setTimeout(resolve, 25));
  const state = await f.call("/api/state"); ok(state);
  assert.equal(state.body.activity.running, false);
  assert.ok((await readRings(f.root)).some(r => r.payload?.action === "dream"));
  assert.ok(f.record.lastDreamHeight >= 1);
});

test("real engine: replay uses a reviewed antecedent and records acceptance after its new seal", { timeout: 180000 }, async t => {
  let replayRing = null;
  const f = await fixture(t, {
    generate: async (_config, args) => {
      if (args.system.startsWith("Plan retrieval for a local Timechain agent.")) {
        const offered = JSON.parse(args.messages.at(-1).content);
        replayRing = offered.route?.antecedent?.ring ?? null;
        return { text: JSON.stringify({ queries: [], entities: [], shapes: ["narrow"],
          rings: replayRing === null ? [] : [replayRing], useReplay: true,
          labels: { senses: [], modalities: [] } }) };
      }
      return { text: ANSWER };
    },
    review: (_config, args) => {
      const review = goodReview();
      if (replayRing !== null) {
        assert.ok(args.availableEvidence.some(e => e.index === replayRing));
        review.usedRings = [replayRing];
      }
      return review;
    },
  });
  ok(await f.call("/api/chat", { message: ANSWER }));
  const firstRing = (await chatRings(f.root))[0].index;
  ok(await f.call("/api/cognition", { autoRoute: true, semanticRecall: true }));
  const offset = f.calls.length;
  const replayed = await f.call("/api/chat", { message: ANSWER }); ok(replayed);
  assert.equal(replayRing, firstRing);
  assert.equal(replayed.body.message.replayed, true);
  assert.equal(replayed.body.message.content, ANSWER);
  assert.equal(f.generated.length, 2, "Only the first answer and second-turn retrieval plan use generation calls.");
  assert.equal(f.reviewed.length, 2, "Replay must receive a fresh semantic review.");
  const calls = f.calls.slice(offset), teaching = calls.find(c => c.op === "teach");
  assert.ok(teaching); assert.deepEqual(teaching.replay, { action: "accept", ring: firstRing });
  assert.ok(calls.findIndex(c => c.op === "commit") < calls.indexOf(teaching));
  assert.equal(replayed.body.message.learning.held, 0);
  assert.equal((await chatRings(f.root)).length, 2);
  const files = await fingerprint(f.root);
  assert.ok(Object.keys(files).some(name => /replay.*\.json$/.test(name)), "Native replay feedback must have a local ledger.");
});

test("real engine: Stop targets the operation's original chain after its owner selects another agent", { timeout: 180000 }, async t => {
  const entered = deferred(), release = deferred();
  let signal;
  const f = await fixture(t, { generate: async (_config, args) => {
    signal = args.signal; entered.resolve(); await release.promise; return { text: ANSWER };
  } });
  t.after(() => release.resolve());
  const created = await f.call("/api/agents", { name: "Second cognition fixture" });
  assert.equal(created.status, 201, created.body.code);
  const secondId = created.body.agent.id, secondRoot = created.body.agent.root;
  ok(await f.call("/api/agents/select", { id: f.record.id }));
  const observer = await f.client();
  ok(await observer.call("/api/agents/select", { id: f.record.id }));
  const generating = f.call("/api/chat", { message: "Keep this operation bound to the first chain." });
  await entered.promise;
  ok(await f.call("/api/agents/select", { id: secondId }));
  ok(await f.call("/api/cancel", {}));
  assert.equal(signal.aborted, false, "Stopping chain B must not abort an operation started on A.");
  ok(await observer.call("/api/cancel", {}));
  assert.equal(signal.aborted, true, "Stopping A from another paired session must find A's original controller.");
  release.resolve();
  const held = await generating;
  assert.equal(held.status, 499, held.body.code);
  assert.equal(held.body.code, "CANCELLED"); assert.equal(held.body.message, undefined);
  assert.equal(f.reviewed.length, 0);
  assert.equal((await chatRings(f.root)).length, 0);
  assert.equal((await chatRings(secondRoot)).length, 0);
  assert.equal(f.calls.some(c => c.op === "commit"), false);
});

test("real engine: Stop removes a queued idle Dream before the chain becomes idle", { timeout: 180000 }, async t => {
  const entered = deferred(), release = deferred();
  let committed = false, heldInspection = false;
  const f = await fixture(t, { afterEngine: async request => {
    if (request.op === "commit") committed = true;
    if (request.op === "inspect" && committed && !heldInspection) {
      heldInspection = true; entered.resolve(); await release.promise;
    }
  } });
  t.after(() => release.resolve());
  ok(await f.call("/api/cognition", { autoDream: true }));
  f.record.lastDreamHeight = -100; await f.store.save();
  const generating = f.call("/api/chat", { message: "Seal a patient response before scheduling consolidation." });
  await entered.promise;
  // The first idle timer fires while the final state inspection holds the
  // transaction open; its replacement timer must also be cancelled by Stop.
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(f.calls.some(c => c.op === "maintenance"), false);
  ok(await f.call("/api/cancel", {}));
  release.resolve();
  const response = await generating;
  assert.ok([200, 499].includes(response.status), response.body.code);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.calls.some(c => c.op === "maintenance"), false);
  assert.equal(f.reviewed.length, 1, "Cancelled idle work must not make a second control-review call.");
  assert.equal(f.record.lastDreamHeight, -100);
  assert.equal((await chatRings(f.root)).length, 1, "An atomic conversation seal completed before Stop remains valid.");
  assert.equal((await readRings(f.root)).some(r => r.payload?.action === "dream"), false);
});

test("real engine: an answer finishing after agent selection changes retains its original message and state attribution", { timeout: 180000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { generate: async () => {
    entered.resolve(); await release.promise; return { text: ANSWER };
  } });
  t.after(() => release.resolve());
  const created = await f.call("/api/agents", { name: "Second attribution fixture" });
  assert.equal(created.status, 201, created.body.code);
  const secondId = created.body.agent.id, secondRoot = created.body.agent.root;
  ok(await f.call("/api/agents/select", { id: f.record.id }));
  const generating = f.call("/api/chat", { message: "Keep this answer attributed to its original chain." });
  await entered.promise;
  const switched = await f.call("/api/agents/select", { id: secondId }); ok(switched);
  assert.equal(switched.body.agent.id, secondId);
  release.resolve();
  const completed = await generating; ok(completed);
  assert.equal(completed.body.message.agentId, f.record.id);
  assert.equal(completed.body.state.agent.id, f.record.id);
  assert.equal(completed.body.state.agent.root, f.root);
  const current = await f.call("/api/state"); ok(current);
  assert.equal(current.body.agent.id, secondId, "Completing A must not switch the browser back from B.");
  assert.equal((await chatRings(f.root)).length, 1);
  assert.equal((await chatRings(secondRoot)).length, 0);
});
