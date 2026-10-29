import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COGNITION, normalizeCognition, normalizeActivity, abilityIndicators,
  facultyIdentity, facultyLifecycleAction, messageIsDormant, nativeSearchView,
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
