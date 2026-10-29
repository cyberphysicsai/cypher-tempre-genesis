export const DEFAULT_COGNITION = Object.freeze({
  mode: "active", learning: true, autoRoute: true, autoSprout: true,
  autoDream: false, semanticRecall: true, searchIterations: 6,
  searchDepth: 3, revisionLimit: 1,
});

export const ABILITY_GROUPS = Object.freeze({
  recallAbility: ["recall", "memory"],
  forkAbility: ["fork", "search"],
  continuumAbility: ["continuum", "seal"],
  loadoutAbility: ["faculties", "perceive"],
  verifyAbility: ["verify", "immune"],
  gateAbility: ["review", "gate", "revise"],
  routeAbility: ["route", "replay"],
  learningAbility: ["learning", "growth", "extractor"],
  dreamAbility: ["dream", "train", "index"],
  cognitionAbility: ["model", "generation", "cognition"],
});
const statuses = new Set(["started", "completed", "failed", "cancelled", "held"]);
const knownAbilities = new Set(Object.values(ABILITY_GROUPS).flat());
const bounded = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";
const integerIn = (value, lo, hi, fallback) => Number.isSafeInteger(value) && value >= lo && value <= hi ? value : fallback;

export function normalizeCognition(value = {}) {
  const result = { ...DEFAULT_COGNITION };
  result.mode = value?.mode === "dormant" ? "dormant" : "active";
  for (const key of ["learning", "autoRoute", "autoSprout", "autoDream", "semanticRecall"])
    if (typeof value?.[key] === "boolean") result[key] = value[key];
  result.searchIterations = integerIn(value?.searchIterations, 1, 64, 6);
  result.searchDepth = integerIn(value?.searchDepth, 1, 8, 3);
  result.revisionLimit = integerIn(value?.revisionLimit, 0, 3, 1);
  return result;
}

export function normalizeActivity(value, expectedAgent) {
  if (!value || typeof value !== "object" || value.agentId !== expectedAgent) return null;
  const events = (Array.isArray(value.events) ? value.events : []).slice(-80)
    .filter(e => e && typeof e.ability === "string" && /^[a-z][a-z0-9_-]{0,39}$/.test(e.ability) && statuses.has(e.status))
    .map(e => ({ id: e.id, at: e.at, ability: e.ability, status: e.status,
      stage: bounded(e.stage, 60), label: bounded(e.label, 180), detail: bounded(e.detail, 500) }));
  return {
    agentId: expectedAgent,
    revision: integerIn(value.revision, 0, Number.MAX_SAFE_INTEGER, 0),
    running: value.running === true,
    stage: bounded(value.stage, 80),
    activeAbilities: value.running === true && Array.isArray(value.activeAbilities)
      ? [...new Set(value.activeAbilities.filter(a => knownAbilities.has(a)))] : [],
    events,
  };
}

export function abilityIndicators(activity, fresh = true) {
  return Object.fromEntries(Object.entries(ABILITY_GROUPS).map(([id, abilities]) => {
    const active = fresh && !!activity?.running && abilities.some(a => activity.activeAbilities.includes(a));
    const last = [...(activity?.events || [])].reverse().find(event => abilities.includes(event.ability));
    return [id, { active, status: !fresh ? "UNKNOWN" : active ? "RUNNING" : last ? last.status.toUpperCase() : "IDLE" }];
  }));
}

export function facultyIdentity(faculty) {
  return `${faculty.kind === "sense" ? "sense" : "modality"}:${String(faculty.key ?? faculty.id ?? faculty.name)}`;
}

export function facultyLifecycleAction(faculty) {
  if (!faculty || faculty.source === "base") return null;
  if (faculty.dormant) return faculty.canWake === false ? null : "wake";
  if (faculty.equippable === false || faculty.source === "emergent") return faculty.canPromote === false ? null : "promote";
  return faculty.canHibernate === false ? null : "hibernate";
}

export function messageIsDormant(message) {
  return message?.mode === "dormant" || message?.dormant === true || message?.raw === true;
}

// Render the native engine's public path/score report, never hidden model reasoning.
export function nativeSearchView(search = {}) {
  const pathNames = value => Array.isArray(value) ? value.slice(0, 8).map(item =>
    bounded(typeof item === "string" ? item : item?.name || item?.id || "Node", 128)) : [];
  const selectedPath = pathNames(search.winner?.path || search.path);
  const winner = bounded(typeof search.winner === "string" ? search.winner : search.winner?.name || search.winner?.id, 128) || selectedPath.at(-1) || "—";
  return {
    winner, selectedPath, depth: integerIn(search.exploredDepth, 0, 8, 0),
    iterations: integerIn(search.iterationsRun, 0, 64, 0),
    nodes: (Array.isArray(search.nodes) ? search.nodes : []).slice(0, 100).filter(item => item && typeof item === "object").map(item => {
      const path = pathNames(item.path);
      return { path, name: path.join(" → ") || bounded(item.name || item.archetype || item.id, 128) || "Node",
        selected: path.length > 0 && JSON.stringify(path) === JSON.stringify(selectedPath),
        visits: integerIn(item.visits, 0, Number.MAX_SAFE_INTEGER, 0),
        value: Number.isFinite(item.value) ? item.value : "—",
        summary: bounded(item.summary || item.text, 32000) };
    }),
    epitaphs: (Array.isArray(search.loserEpitaphs) ? search.loserEpitaphs : []).slice(0, 100).map(item => ({
      path: pathNames(item?.path).join(" → "),
      summary: bounded(typeof item === "string" ? item : item?.summary || item?.reason, 1000),
    })),
  };
}
