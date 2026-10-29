import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COGNITION, normalizeCognition, normalizeActivity, abilityIndicators,
  facultyIdentity, facultyLifecycleAction, messageIsDormant, nativeSearchView,
  activityLineState, pollWithDeadline, routeControlState, reviewReceipt, facultyExecutionView, portabilityView,
  operatorCompatibilityView, facultyIsExportable,
} from "../public/cognition-display.js";
import { requiresHoldings } from "../public/chainchat-display.js";

const feed = (overrides = {}) => ({
  agentId: "chain-a", revision: 3, running: true, stage: "model",
  activeAbilities: ["model"], events: [
    { id: 1, at: "2026-10-28T12:00:00Z", ability: "recall", status: "completed", label: "Memory retrieved" },
    { id: 2, at: "2026-10-28T12:00:01Z", ability: "model", status: "started", label: "Generating candidate" },
  ], ...overrides,
});

test("only current, fresh backend activity lights an ability", () => {
  const current = normalizeActivity(feed(), "chain-a");
  const indicators = abilityIndicators(current, true);
  assert.deepEqual(indicators.cognitionAbility, { active: true, status: "RUNNING" });
  assert.deepEqual(indicators.recallAbility, { active: false, status: "COMPLETED" });
  assert.deepEqual(indicators.forkAbility, { active: false, status: "IDLE" });
  assert.equal(abilityIndicators(current, false).cognitionAbility.active, false);
  assert.equal(abilityIndicators(current, false).cognitionAbility.status, "UNKNOWN");
  assert.equal(normalizeActivity(feed(), "chain-b"), null, "A prior agent must not light the selected agent's bar.");
  const finished = normalizeActivity(feed({ running: false }), "chain-a");
  assert.deepEqual(finished.activeAbilities, []);
  assert.equal(abilityIndicators(finished).cognitionAbility.active, false, "Old active fields cannot survive a completed operation.");
});

test("short completed, held and cancelled native steps remain visible without pretending to run", () => {
  for (const status of ["completed", "held", "cancelled", "failed"]) {
    const current = normalizeActivity(feed({ running: false, events: [
      { ability: "growth", status, label: "Native growth" },
      { ability: "operation", status, label: "Operation ended" },
    ] }), "chain-a");
    assert.deepEqual(abilityIndicators(current).learningAbility, { active: false, status: status.toUpperCase() });
    assert.equal(current.events.at(-1).ability, "operation", "Operation events should remain in the monitor.");
  }
});

test("activity display bounds untrusted fields and drops invalid statuses and ability names", () => {
  const current = normalizeActivity(feed({ revision: -2, stage: "x".repeat(200),
    events: [
      ...Array.from({ length: 110 }, () => ({ ability: "recall", status: "completed", label: "x".repeat(500) })),
      { ability: "recall", status: "pretend-running" },
      { ability: "<script>", status: "started" },
    ], activeAbilities: ["model", "model", "<script>", "unknown"] }), "chain-a");
  assert.equal(current.revision, 0);
  assert.equal(current.stage.length, 80);
  assert.ok(current.events.length <= 80);
  assert.equal(current.events.every(event => event.label.length <= 180), true);
  assert.deepEqual(current.activeAbilities, ["model"]);
  assert.equal(normalizeActivity(null, "chain-a"), null);
});

test("settings retain deliberate off states and validate bounded search budgets", () => {
  const value = normalizeCognition({ mode: "dormant", learning: false, autoRoute: false, autoSprout: false,
    semanticRecall: false, autoDream: true, searchIterations: 64, searchDepth: 8, revisionLimit: 0 });
  assert.equal(value.learning, false);
  assert.equal(value.mode, "dormant");
  assert.equal(value.autoRoute, false);
  assert.equal(value.semanticRecall, false);
  assert.equal(value.searchIterations, 64);
  assert.equal(value.searchDepth, 8);
  assert.equal(value.revisionLimit, 0);
  assert.deepEqual(normalizeCognition({ mode: "unknown", learning: "false", searchIterations: 65,
    searchDepth: 1.5, revisionLimit: -1 }), DEFAULT_COGNITION);
  assert.deepEqual(normalizeCognition(null), DEFAULT_COGNITION);
});

test("faculty pruning is reversible, promotes emerging faculties, and never removes base faculties", () => {
  assert.equal(facultyLifecycleAction({ source: "base" }), null);
  assert.equal(facultyLifecycleAction({ source: "emergent", equippable: false }), "promote");
  assert.equal(facultyLifecycleAction({ source: "grown", dormant: false }), "hibernate");
  assert.equal(facultyLifecycleAction({ source: "grown", dormant: true }), "wake");
  assert.equal(facultyLifecycleAction({ source: "imported" }), "hibernate");
  assert.equal(facultyLifecycleAction({ source: "emergent", canPromote: false }), null);
  assert.equal(facultyLifecycleAction({ source: "grown", dormant: true, equippable: false }), "wake");
  assert.equal(facultyLifecycleAction({ source: "grown", canHibernate: false }), null);
  assert.notEqual(facultyIdentity({ kind: "modality", id: "signal" }), facultyIdentity({ kind: "sense", id: "signal" }));
});

test("raw model responses have an explicit mode marker, never inferred from missing gate data", () => {
  for (const message of [{ mode: "dormant" }, { raw: true }, { dormant: true }]) assert.equal(messageIsDormant(message), true);
  for (const message of [{}, { gate: null }, { mode: "active" }, { raw: "true" }]) assert.equal(messageIsDormant(message), false);
});

test("stopping remains available after wallet eligibility expires without bypassing settings protection", () => {
  assert.equal(requiresHoldings("/api/cancel", {}), false);
  assert.equal(requiresHoldings("/api/cognition", { mode: "dormant", confirm: true }), false);
  for (const input of [{ mode: "active", confirm: true }, { mode: "dormant" },
    { mode: "dormant", confirm: true, learning: false }, { learning: false }])
    assert.equal(requiresHoldings("/api/cognition", input), true);
  for (const path of ["/api/maintenance", "/api/faculties/lifecycle"])
    assert.equal(requiresHoldings(path, { confirm: true }), true);
});

test("native search paths and winner render from the actual engine report shape", () => {
  const view = nativeSearchView({iterationsRun: 6, exploredDepth: 2,
    winner: {name: "Verification", path: ["Analytic", "Verification"], summary: "Public finding"},
    nodes: [{path: ["Analytic"], visits: 6, value: 230}, {path: ["Analytic", "Verification"], visits: 4, value: 240}],
    loserEpitaphs: [{path: ["Analytic"], summary: "Public earlier candidate"}],
  });
  assert.equal(view.winner, "Verification");
  assert.equal(view.nodes[1].name, "Analytic → Verification");
  assert.equal(view.nodes[1].selected, true);
  assert.equal(view.nodes[0].selected, false);
  assert.equal(view.nodes[1].value, 240);
  assert.deepEqual(view.epitaphs[0], {path: "Analytic", summary: "Public earlier candidate"});
  assert.equal(view.depth, 2);
  assert.equal(view.iterations, 6);
});

test("stale activity clears the main busy status and active labels ignore unrelated completions", () => {
  const current = normalizeActivity(feed({ events: [
    { ability: "review", status: "started", label: "Reviewing covenant" },
    { ability: "model", status: "completed", label: "Model finished" },
  ], activeAbilities: ["review"] }), "chain-a");
  assert.deepEqual(activityLineState(current, { paired: true, fresh: true }), { text: "Reviewing covenant", kind: "busy" });
  const stale = activityLineState(current, { paired: true, fresh: false, requestBusy: true });
  assert.equal(stale.kind, "");
  assert.match(stale.text, /unknown/);
  assert.equal(activityLineState(current, { paired: false, fresh: false }), null);
  assert.equal(activityLineState({ running: false, events: [] }, { paired: true, fresh: true, requestBusy: true }).kind, "");
});

test("a stalled activity transport times out, aborts, and permits a later poll", async () => {
  let stalledSignal;
  await assert.rejects(pollWithDeadline(signal => {
    stalledSignal = signal;
    return new Promise(() => {}); // Deliberately ignores abort, like a stuck transport.
  }, 15), /timed out/);
  assert.equal(stalledSignal.aborted, true);
  assert.deepEqual(await pollWithDeadline(async () => ({ revision: 4 }), 100), { revision: 4 });
  await assert.rejects(pollWithDeadline(async () => { throw new Error("Bridge offline"); }, 100), /Bridge offline/);
});

test("Route reflects effective Recall and pause dependencies without changing stored preference", () => {
  const preferred = { mode: "active", autoRoute: true };
  assert.deepEqual(routeControlState(preferred, false), { enabled: false, label: "RECALL OFF" });
  assert.equal(preferred.autoRoute, true);
  assert.deepEqual(routeControlState(preferred, true), { enabled: true, label: "AUTOMATIC" });
  assert.deepEqual(routeControlState({ ...preferred, mode: "dormant" }, true), { enabled: false, label: "PAUSED" });
  assert.deepEqual(routeControlState({ ...preferred, autoRoute: false }, true), { enabled: false, label: "OFF" });
});

test("accepted replay and revision receipts need explicit metadata and never label plain chat", () => {
  assert.deepEqual(reviewReceipt({ replayed: true, revisions: 2 }), ["Reviewed memory replay", "2 revisions before acceptance"]);
  assert.deepEqual(reviewReceipt({ replayed: true, revisions: 1, mode: "dormant" }), []);
  assert.deepEqual(reviewReceipt({ replayed: "true", revisions: "2" }), []);
  assert.deepEqual(reviewReceipt({ replayed: 0, revisions: -1 }), []);
  assert.deepEqual(reviewReceipt({ revisions: 4 }), []);
});

test("faculty execution receipts distinguish computations, frames, failures and nonexecuted code", () => {
  const entries = [
    { key: "a", kind: "modality", name: "Analytic", mode: "computed", mechanism: "base-op", status: "completed" },
    { key: "b", kind: "sense", name: "Custom lens", mode: "frame", mechanism: "lens", status: "completed" },
    { key: "c", kind: "modality", name: "Missing recipe", mode: "unsupported", status: "unavailable" },
    { key: "d", kind: "sense", name: "Authored", mode: "quarantined", status: "completed" },
    { key: "e", kind: "sense", name: "Failed recipe", mode: "computed", status: "failed" },
  ];
  const view = facultyExecutionView({ scope: "turn", entries });
  assert.deepEqual(view.map(item => item.label), ["COMPUTED", "FRAME APPLIED", "UNSUPPORTED", "CODE QUARANTINED", "EXECUTION FAILED"]);
  assert.equal(view[3].status, "unavailable", "Code quarantine cannot become an execution success claim.");
  assert.deepEqual(facultyExecutionView({ scope: "equipped", entries }), []);
  assert.deepEqual(facultyExecutionView({ scope: "turn", entries: [{ ...entries[0], status: "running" }] }), [], "No invented live execution from last-turn receipts.");
});

test("faculty receipts bound untrusted metadata, deduplicate identity, and discard private output", () => {
  const item = { key: "shared", kind: "sense", mode: "frame", status: "completed", name: "n".repeat(500), reason: "r".repeat(1000), output: "private model text", code: "private code" };
  const view = facultyExecutionView({ scope: "turn", entries: [item, item, { ...item, kind: "modality" }, { ...item, key: "invalid", mode: "magic" }] });
  assert.equal(view.length, 2);
  assert.equal(view[0].name.length, 200);
  assert.equal(view[0].reason.length, 600);
  assert.equal(Object.hasOwn(view[0], "output"), false);
  assert.equal(Object.hasOwn(view[0], "code"), false);
});

test("portability preview keeps compatibility and field names while excluding code and private metadata values", () => {
  const view = portabilityView({ formatVersion: 2, requiresCompanion: true, quarantinedCodeCount: 1, items: [
    { name: "Recipe", mechanism: "recipe", compatibility: "supported", preservedFields: ["recipe", "provenance"], recipe: "private value" },
    { name: "Authored", mechanism: "authored-code", compatibility: "quarantined", preservedFields: ["code"], code: "do not execute" },
    { name: "Unknown", compatibility: "trust-me", preservedFields: [null, "metadata"], reason: "r".repeat(700) },
  ] });
  assert.equal(view.requiresCompanion, true);
  assert.equal(view.quarantinedCodeCount, 1);
  assert.deepEqual(view.items.map(item => item.label), ["SUPPORTED", "CODE QUARANTINED", "UNSUPPORTED"]);
  assert.deepEqual(view.items[0].preservedFields, ["recipe", "provenance"]);
  assert.equal(Object.hasOwn(view.items[1], "code"), false);
  assert.equal(view.items[2].reason.length, 600);
  assert.equal(portabilityView(null), null);
});

test("local code instructions are tied to the detected digest and never provide a browser activation", () => {
  const digest = "a".repeat(64);
  const view = operatorCompatibilityView({ available: true, approved: false, source: "active_ops.py", sha256: digest,
    declaredNames: ["pattern_match"], code: "private source" });
  assert.equal(view.label, "LOCAL REVIEW REQUIRED");
  assert.equal(view.command, `python skill_interop.py approve-code --root "<agent directory>" --sha256 ${digest} --confirm`);
  assert.equal(Object.hasOwn(view, "code"), false);
  assert.equal(Object.hasOwn(view, "activationUrl"), false);
  assert.equal(operatorCompatibilityView({ available: true, sha256: "a; execute command" }).command, "");
  assert.equal(operatorCompatibilityView({ available: true, approved: true, sha256: digest }).command, "");
  assert.equal(operatorCompatibilityView({ available: false, approved: true, sha256: digest }).label, "NO LOCAL MODULE");
  assert.equal(operatorCompatibilityView(null), null);
});

test("export permission is separate from equipment permission and respects explicit native refusals", () => {
  assert.equal(facultyIsExportable({ source: "emergent", equippable: false, exportable: true, requiresLocalCodeReview: true }), true);
  assert.equal(facultyIsExportable({ source: "grown", equippable: true, exportable: false }), false);
  assert.equal(facultyIsExportable({ source: "grown", equippable: true }), true);
  assert.equal(facultyIsExportable({ source: "base", equippable: true }), false);
  assert.equal(facultyIsExportable({ source: "emergent", equippable: false }), false);
});
