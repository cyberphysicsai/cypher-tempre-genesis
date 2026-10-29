import test from "node:test";
import assert from "node:assert/strict";
import { Activity, defaultCognition, validateCognition, cognitionFor, parseMemoryPlan } from "../lib/cognition.mjs";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("cognition controls retain prior choices and reject type or budget coercion", () => {
  const previous = { ...defaultCognition(), learning: false, searchIterations: 9 };
  assert.deepEqual(validateCognition({ mode: "dormant" }, previous), { ...previous, mode: "dormant" });
  assert.deepEqual(cognitionFor(null), defaultCognition());
  for (const input of [null, [], true, "active", { mode: "paused" },
    { learning: "false" }, { autoRoute: 1 }, { autoSprout: null }, { autoDream: "true" },
    { semanticRecall: 0 }, { searchIterations: 0 }, { searchIterations: 65 },
    { searchIterations: 1.2 }, { searchDepth: 0 }, { searchDepth: 9 },
    { revisionLimit: -1 }, { revisionLimit: 4 }, { revisionLimit: "1" }]) {
    assert.throws(() => validateCognition(input), JSON.stringify(input));
  }
  const low = validateCognition({ searchIterations: 1, searchDepth: 1, revisionLimit: 0 });
  const high = validateCognition({ searchIterations: 64, searchDepth: 8, revisionLimit: 3 });
  assert.equal(low.revisionLimit, 0); assert.equal(high.searchIterations, 64);
  assert.equal(Object.hasOwn(validateCognition({ apiKey: "not-a-setting" }), "apiKey"), false);
});

test("default cognition objects cannot mutate another agent's configuration", () => {
  const first = defaultCognition(); first.learning = false;
  assert.equal(defaultCognition().learning, true);
  const validated = validateCognition({}, first); validated.searchDepth = 8;
  assert.equal(first.searchDepth, 3);
});

test("activity stays active through overlapping nested work until the last task settles", async () => {
  const trace = new Activity("agent-a"), first = deferred(), second = deferred();
  trace.begin("Testing operation");
  const firstWork = trace.step(["model", "fork"], "First model call", () => first.promise);
  const secondWork = trace.step("model", "Second model call", () => second.promise);
  assert.deepEqual(trace.snapshot().activeAbilities.sort(), ["fork", "model"]);
  first.resolve("first"); assert.equal(await firstWork, "first");
  assert.equal(trace.snapshot().running, true);
  assert.deepEqual(trace.snapshot().activeAbilities, ["model"]);
  second.resolve("second"); assert.equal(await secondWork, "second");
  assert.deepEqual(trace.snapshot().activeAbilities, []);
  trace.finish(); assert.equal(trace.snapshot().running, false);
});

test("activity isolates agents, returns detached snapshots and bounds history", () => {
  const a = new Activity("agent-a"), b = new Activity("agent-b");
  a.begin("One operation"); b.begin("Another operation");
  assert.notEqual(a.snapshot().operationId, b.snapshot().operationId);
  for (let i = 0; i < 190; i++) a.event("recall", "completed", "Recall complete", { count: i });
  assert.equal(a.snapshot().events.length, 160);
  assert.equal(b.snapshot().events.length, 1);
  const copy = a.snapshot(); copy.events[0].label = "mutated";
  assert.notEqual(a.snapshot().events[0].label, "mutated");
});

test("activity excludes model text, credentials and error messages from details and failures", async () => {
  const trace = new Activity("agent-a"), secret = "PRIVATE-PROMPT-KEY-OUTPUT";
  trace.begin("Test operation");
  trace.event("recall", "completed", "Bounded recall", {
    prompt: secret, apiKey: secret, output: { text: secret }, count: 3,
    enabled: true, invalidNumber: Infinity, "bad-key": 9,
  });
  await assert.rejects(trace.step("model", "Model inference", async () => {
    throw Object.assign(new Error(secret), { code: "ABORT_ERR" });
  }));
  const snapshot = trace.snapshot();
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  assert.equal(snapshot.events[1].count, 3);
  assert.equal(snapshot.events[1].enabled, true);
  assert.equal(Object.hasOwn(snapshot.events[1], "invalidNumber"), false);
  assert.equal(snapshot.events.at(-1).status, "cancelled");
  assert.deepEqual(snapshot.activeAbilities, []);
});

test("activity detail counters cannot forge event identity or stage fields", () => {
  const trace = new Activity("agent-a"); trace.begin("Operation");
  const operationId = trace.snapshot().operationId;
  const event = trace.event("model", "started", "Model inference", {
    id: 999, at: false, operationId: false, stage: false,
    ability: false, status: false, label: false, count: 2,
  });
  assert.equal(event.id, 2);
  assert.equal(event.operationId, operationId);
  assert.equal(event.stage, "model");
  assert.equal(event.status, "started");
  assert.equal(event.label, "Model inference");
  assert.equal(event.count, 2);
});

test("memory planner allows only offered integer ring IDs and known question shapes", () => {
  const plan = parseMemoryPlan(JSON.stringify({ queries: ["latest preference"], entities: ["book"],
    shapes: ["update", "relative"], rings: [2, 2, 5], useReplay: true,
    labels: { senses: ["5"], modalities: ["2"] } }), [2, 5]);
  assert.deepEqual(plan.rings, [2, 5]); assert.equal(plan.useReplay, true);
  for (const candidate of [{ rings: [9] }, { rings: ["2"] }, { rings: [2.5] },
    { rings: [Number.MAX_SAFE_INTEGER + 1] }, { shapes: ["execute-shell"] },
    { queries: [1] }, { entities: [false] }, { labels: { senses: [{}] } }]) {
    assert.equal(parseMemoryPlan(JSON.stringify(candidate), [2, 5]), null, JSON.stringify(candidate));
  }
  assert.equal(parseMemoryPlan("not JSON", [2]), null);
  assert.equal(parseMemoryPlan("[]", [2]), null);
});

test("memory planner enforces bounded queries, entities, labels, shapes and ring count", () => {
  for (const invalid of [{ queries: Array(5).fill("q") }, { queries: ["q".repeat(1001)] },
    { entities: Array(13).fill("e") }, { entities: ["e".repeat(161)] },
    { shapes: Array(7).fill("narrow") }, { rings: Array(41).fill(2) },
    { labels: { senses: Array(25).fill("s") } }, { labels: { modalities: ["m".repeat(161)] } }]) {
    assert.equal(parseMemoryPlan(JSON.stringify(invalid), [2]), null);
  }
  assert.ok(parseMemoryPlan(JSON.stringify({ queries: Array(4).fill("q".repeat(1000)),
    entities: Array(12).fill("e".repeat(160)), shapes: Array(6).fill("narrow"),
    rings: Array(40).fill(2), labels: { senses: Array(24).fill("s".repeat(160)) } }), [2]));
});

test("memory planner accepts exactly the native evidence shapes", () => {
  const native = ["narrow", "relative", "aggregate", "interval", "ordering", "update"];
  assert.deepEqual(parseMemoryPlan(JSON.stringify({ shapes: native })).shapes, native);
  for (const shape of ["temporal", "factual", "general", "day", "lineage", "code", ""])
    assert.equal(parseMemoryPlan(JSON.stringify({ shapes: [shape] })), null, shape);
});

test("memory planner rejects malformed container and boolean fields rather than accepting defaults", () => {
  for (const invalid of [{ labels: [] }, { labels: "not-labels" }, { labels: null },
    { queries: null }, { rings: null }, { useReplay: "yes" }, { useReplay: 1 }]) {
    assert.equal(parseMemoryPlan(JSON.stringify(invalid), [2]), null, JSON.stringify(invalid));
  }
  assert.ok(parseMemoryPlan("{}", []));
});
