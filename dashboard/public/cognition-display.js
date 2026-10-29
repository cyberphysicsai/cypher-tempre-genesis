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

export function activityLineState(activity, { paired, fresh, requestBusy = false } = {}) {
  if (!paired) return null;
  if (!fresh) return { text: "Live activity unavailable · execution status unknown", kind: "" };
  const events = activity?.events || [], last = events.at(-1);
  if (activity?.running) {
    const current = [...events].reverse().find(event => event.status === "started" && activity.activeAbilities.includes(event.ability));
    return { text: current?.label || activity.stage || "Agent operation running", kind: "busy" };
  }
  if (requestBusy) return { text: "Awaiting bridge response · no ability currently reported running", kind: "" };
  return { text: last?.label || "Agent idle · waiting for your next turn", kind: ["failed", "held"].includes(last?.status) ? "error" : "" };
}

// A hung transport must not lock all later activity polls, even if it ignores abort.
export async function pollWithDeadline(action, timeoutMs = 4000) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => action(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Activity request timed out."));
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

export function routeControlState(cognition, recallEnabled) {
  if (cognition?.mode === "dormant") return { enabled: false, label: "PAUSED" };
  if (recallEnabled !== true) return { enabled: false, label: "RECALL OFF" };
  return { enabled: cognition?.autoRoute === true, label: cognition?.autoRoute === true ? "AUTOMATIC" : "OFF" };
}

export function reviewReceipt(message) {
  if (messageIsDormant(message)) return [];
  const labels = [];
  if (message?.replayed === true)
    labels.push("Reviewed memory replay");
  if (Number.isSafeInteger(message?.revisions) && message.revisions > 0 && message.revisions <= 3)
    labels.push(`${message.revisions} revision${message.revisions === 1 ? "" : "s"} before acceptance`);
  return labels;
}

export function facultyExecutionView(receipt) {
  if (receipt?.scope !== "turn" || !Array.isArray(receipt.entries)) return [];
  const modes = new Set(["computed", "frame", "unsupported", "quarantined"]), seen = new Set();
  return receipt.entries.slice(0, 2000).flatMap(item => {
    if (!item || !["modality", "sense"].includes(item.kind) || !modes.has(item.mode) ||
      !["completed", "unavailable", "failed"].includes(item.status)) return [];
    const key = bounded(item.key, 256);
    if (!key || seen.has(`${item.kind}:${key}`)) return [];
    seen.add(`${item.kind}:${key}`);
    const status = ["unsupported", "quarantined"].includes(item.mode) && item.status === "completed" ? "unavailable" : item.status;
    const label = item.mode === "quarantined" ? "CODE QUARANTINED"
      : item.mode === "unsupported" ? "UNSUPPORTED"
      : status === "failed" ? "EXECUTION FAILED"
      : status === "unavailable" ? "UNAVAILABLE"
      : item.mode === "frame" ? "FRAME APPLIED" : "COMPUTED";
    return [{ key, kind: item.kind, name: bounded(item.name, 200) || key,
      mode: item.mode, status, label, mechanism: bounded(item.mechanism, 120), reason: bounded(item.reason, 600) }];
  });
}

export function portabilityView(report) {
  if (!report || typeof report !== "object") return null;
  const labels = { supported: "SUPPORTED", "frame-only": "FRAME ONLY", quarantined: "CODE QUARANTINED", unsupported: "UNSUPPORTED" };
  const items = (Array.isArray(report.items) ? report.items : []).slice(0, 2000).filter(item => item && typeof item === "object").map(item => ({
    name: bounded(item.name || item.key, 200) || "Faculty",
    mechanism: bounded(item.mechanism, 120) || "Unspecified mechanism",
    compatibility: Object.hasOwn(labels, item.compatibility) ? item.compatibility : "unsupported",
    label: labels[item.compatibility] || "UNSUPPORTED",
    preservedFields: (Array.isArray(item.preservedFields) ? item.preservedFields : []).slice(0, 40).map(name => bounded(name, 100)).filter(Boolean),
    reason: bounded(item.reason, 600),
  }));
  return { formatVersion: bounded(String(report.formatVersion ?? ""), 40), items,
    requiresCompanion: report.requiresCompanion === true,
    quarantinedCodeCount: integerIn(report.quarantinedCodeCount, 0, 100000, items.filter(item => item.compatibility === "quarantined").length) };
}

export function operatorCompatibilityView(value) {
  if (!value || typeof value !== "object") return null;
  const digest = name => typeof value[name] === "string" && /^[a-f0-9]{64}$/i.test(value[name]) ? value[name].toLowerCase() : "";
  const sha256 = digest("sha256"), available = value.available === true;
  const approved = available && value.approved === true;
  return { available, approved, label: !available ? "NO LOCAL MODULE" : approved ? "LOCALLY APPROVED" : "LOCAL REVIEW REQUIRED",
    source: bounded(value.source, 120) || "active_ops.py", sha256, environmentSha256: digest("environmentSha256"),
    declaredNames: (Array.isArray(value.declaredNames) ? value.declaredNames : []).slice(0, 200).map(name => bounded(name, 160)).filter(Boolean),
    reason: bounded(value.reason, 600), notice: bounded(value.notice, 600),
    command: available && sha256 && !approved ? `python skill_interop.py approve-code --root "<agent directory>" --sha256 ${sha256} --confirm` : "" };
}

export function facultyIsExportable(faculty) {
  if (typeof faculty?.exportable === "boolean") return faculty.exportable;
  return ["grown", "imported"].includes(faculty?.source) && faculty?.equippable !== false;
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
