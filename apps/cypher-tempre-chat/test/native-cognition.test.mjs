import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enrichPrepared as enrichNative, searchPerspectives as searchNative } from "../lib/native-cognition.mjs";
import { defaultCognition } from "../lib/cognition.mjs";
import { engine as runEngine } from "../lib/engine.mjs";
import { DIMENSIONS, FRUITS } from "../lib/providers.mjs";

const head = { index: 4, hash: "a".repeat(64) };
const config = { provider: "compatible", model: "local-test", baseUrl: "http://127.0.0.1:11434/v1" };
const enrichPrepared = args => enrichNative({ config, ...args });
const searchPerspectives = args => searchNative({ config, ...args });
const evidence = index => ({ index, hash: String(index).padStart(64, "0"), text: `Measured observation ${index}.`, truncated: false });
const preparedFor = () => ({ head, runtime: { supported: true }, context: "Verified context",
  availableEvidence: [evidence(1)], memories: [evidence(1)],
  loadout: [{ key: "modality:1", kind: "modality", name: "Careful Analysis", function: "Review uncertainty." },
    { key: "sense:2", kind: "sense", name: "Evidence Sensing", function: "Notice evidence." }] });
const recordFor = cognition => ({ root: "/disposable-agent", settings: { recall: true },
  cognition: { ...defaultCognition(), ...cognition } });
const planFor = overrides => ({ queries: ["measurements"], entities: [], shapes: ["narrow"], rings: [],
  useReplay: false, labels: { modalities: [], senses: [] }, ...overrides });

test("native enrichment honors recall, native support, and each routing switch", async () => {
  const unexpected = async () => { throw new Error("Disabled ability ran"); };
  for (const option of ["recall", "support", "dormant", "both"]) {
    const prepared = preparedFor();
    const record = recordFor(option === "both" ? { autoRoute: false, semanticRecall: false } : {});
    if (option === "recall") record.settings.recall = false;
    if (option === "support") prepared.runtime.supported = false;
    if (option === "dormant") record.cognition.mode = "dormant";
    const out = await enrichPrepared({ engine: unexpected, model: unexpected, record, prepared, message: "test" });
    assert.equal(out.prepared, prepared); assert.equal(out.plan, null); assert.equal(out.route, null);
  }
});

test("model plan uses native shapes and only equipped labels; replay stays a proposal", async () => {
  const calls = [];
  const engine = async request => {
    calls.push(request);
    if (request.op === "route") return { head, route: { decision: "REPLAY", requiresReview: true,
      antecedent: { ring: 1, answer: "Candidate only" } }, availableEvidence: [evidence(1)] };
    return { head, availableEvidence: [evidence(2)], coverage: { complete: false, selectionBounded: true },
      result: { shapes: request.shapes, native: { rows: [{ index: 2, quantities: [11] }] } } };
  };
  let prompts;
  const model = async (_config, args) => { prompts = args; return { text: JSON.stringify(planFor({ shapes: ["aggregate"],
    entities: ["observation"], useReplay: true, labels: { modalities: ["Careful Analysis", "Invented Ability"], senses: ["Evidence Sensing"] } })) }; };
  const out = await enrichPrepared({ engine, model, record: recordFor({ learning: false }), prepared: preparedFor(), message: "How many?" });
  assert.deepEqual(calls.map(c => c.op), ["route", "memory", "memory"]);
  assert.deepEqual(calls.filter(c => c.op === "memory").map(c => c.action), ["evidence", "gather"]);
  assert.ok(calls.every(c => c.learning === false));
  assert.deepEqual(out.plan.labels.modalities, ["Careful Analysis"]);
  assert.deepEqual(out.plan.shapes, ["aggregate"]);
  assert.equal(out.route.requiresReview, true); assert.equal(out.output, undefined);
  assert.match(prompts.system, /relative/); assert.equal(out.prepared.memoryCoverage.complete, false);
});

test("malformed planner response fails closed to bounded native retrieval", async () => {
  const requests = [];
  const out = await enrichPrepared({ record: recordFor({ autoRoute: false }), prepared: preparedFor(), message: "Recall observations",
    model: async () => ({ text: JSON.stringify(planFor({ rings: [999], shapes: ["not-a-native-shape"], useReplay: true })) }),
    engine: async request => { requests.push(request); return { head, availableEvidence: [], coverage: { complete: false } }; } });
  assert.equal(out.plan.validated, false); assert.equal(out.plan.useReplay, false);
  assert.deepEqual(out.plan.labels, { senses: [], modalities: [] });
  assert.equal(requests.length, 1); assert.equal(requests[0].action, "evidence");
});

test("canonical merge caps evidence and drops structural references outside the page", async () => {
  const prepared = { ...preparedFor(), availableEvidence: Array.from({ length: 40 }, (_, i) => evidence(i + 1)) };
  const out = await enrichPrepared({ record: recordFor({ autoRoute: false }), prepared, message: "Recall observations",
    model: async () => ({ text: JSON.stringify(planFor()) }), engine: async () => ({ head,
      availableEvidence: [evidence(41)], coverage: { complete: false },
      result: { selectedRings: [41], native: { rows: [{ index: 41, quote: "Not in the reviewer page" }] } } }) });
  assert.equal(out.prepared.availableEvidence.length, 40);
  assert.equal(out.prepared.memoryCoverage.droppedAtMerge, 1);
  assert.doesNotMatch(out.prepared.context, /Not in the reviewer page/);
});

test("changed heads and conflicting source hashes stop enrichment", async () => {
  await assert.rejects(enrichPrepared({ record: recordFor({ semanticRecall: false }), prepared: preparedFor(), message: "Recall",
    engine: async () => ({ head: { ...head, hash: "b".repeat(64) }, route: {}, availableEvidence: [] }) }), { code: "STALE_HEAD" });
  await assert.rejects(enrichPrepared({ record: recordFor({ semanticRecall: false }), prepared: preparedFor(), message: "Recall",
    engine: async () => ({ head, route: {}, availableEvidence: [{ ...evidence(1), hash: "b".repeat(64) }] }) }), { code: "INTEGRITY_FAILED" });
});

test("native frontier drives real generated reviewed rollouts without sealing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ct-native-search-"));
  try {
    const root = path.join(directory, "agent");
    const inspected = await runEngine({ op: "init", root, name: "Search Test" });
    const prepared = { ...preparedFor(), head: inspected.head, availableEvidence: [] };
    const record = { ...recordFor({ searchIterations: 2, searchDepth: 3, learning: false }), root };
    const scores = Object.fromEntries(DIMENSIONS.map(d => [d, 230]));
    const assessment = { approved: true, scores, fruitages: Object.fromEntries(FRUITS.map(f => [f, 235])),
      rationale: "The candidate is careful, helpful, and acknowledges uncertainty." };
    const summary = "We can reason patiently and clearly about the question, while acknowledging uncertainty.";
    const perspectives = [{ name: "Careful Analysis", summary, scores, assessment, usedRings: [] }];
    let generated = 0, reviewed = 0;
    const search = await searchPerspectives({ engine: runEngine, record, prepared, message: "Help me reason patiently about this question.",
      conversation: [], system: "Reason carefully and honestly.", perspectives,
      model: async () => { generated++; return { text: summary }; },
      reviewCandidate: async () => { reviewed++; return { approved: true, scores, assessment, usedRings: [] }; } });
    assert.equal(search.algorithm, "native-uic-mcts"); assert.equal(search.modelRollouts, 2);
    assert.equal(search.exploredDepth, 3); assert.equal(generated, 2); assert.equal(reviewed, 2);
    assert.ok(search.nodes.some(n => n.path.length === 3 && n.visits));
    assert.equal((await runEngine({ op: "inspect", root })).head.hash, inspected.head.hash);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function fakeSearchEngine(evaluate) {
  return async request => request.op === "evaluate" ? evaluate(request) : { head, search: {
    algorithm: "native-uic-mcts", winner: { name: "Careful", summary: "Reviewed initial" },
    exploredDepth: 1, nodes: [], frontier: [{ path: ["Careful"], visits: 1, selectionPriority: 0.8 }],
  } };
}
function fakeSearchArgs() {
  return { record: recordFor({ searchIterations: 2, searchDepth: 2 }), prepared: preparedFor(), message: "Question",
    perspectives: [{ name: "Careful", summary: "Reviewed initial", scores: {}, assessment: { approved: true } }],
    model: async () => ({ text: "An alternative answer." }), conversation: [], system: "Careful answer." };
}

test("rejected model rollouts are excluded and operational errors propagate", async () => {
  const args = fakeSearchArgs();
  const result = await searchPerspectives({ ...args, engine: fakeSearchEngine(() => { throw new Error("Never evaluate rejected candidate"); }),
    reviewCandidate: async () => ({ approved: false }) });
  assert.equal(result.modelRollouts, 0); assert.equal(result.heldRollouts, 1); assert.equal(result.exploredDepth, 1);
  await assert.rejects(searchPerspectives({ ...args,
    reviewCandidate: async () => ({ approved: true, assessment: { approved: true }, scores: {}, usedRings: [] }),
    engine: fakeSearchEngine(() => { throw Object.assign(new Error("Locked"), { code: "CHAIN_LOCKED" }); }) }), { code: "CHAIN_LOCKED" });
});

test("cancellation stops before any new native operation", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(enrichPrepared({ record: recordFor(), prepared: preparedFor(), signal: controller.signal,
    engine: async () => { throw new Error("Must not run"); }, message: "Question" }), { code: "CANCELLED" });
  await assert.rejects(searchPerspectives({ ...fakeSearchArgs(), signal: controller.signal,
    engine: async () => { throw new Error("Must not run"); } }), { code: "CANCELLED" });
});
