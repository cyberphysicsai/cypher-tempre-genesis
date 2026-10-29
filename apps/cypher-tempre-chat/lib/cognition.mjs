import { randomUUID } from "node:crypto";

export const defaultCognition = () => ({
  mode: "active", learning: true, autoRoute: true, autoSprout: true,
  autoDream: false, semanticRecall: true, searchIterations: 6,
  searchDepth: 3, revisionLimit: 1,
});
export function validateCognition(input = {}, previous = defaultCognition()) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Choose valid cognition controls.");
  const value = { ...defaultCognition(), ...previous, ...input };
  if (!["active", "dormant"].includes(value.mode)) throw new Error("Choose active Timechain or paused ordinary chat.");
  for (const key of ["learning", "autoRoute", "autoSprout", "autoDream", "semanticRecall"])
    if (typeof value[key] !== "boolean") throw new Error("Cognition switches must be on or off.");
  for (const [key, min, max] of [["searchIterations", 1, 64], ["searchDepth", 1, 8], ["revisionLimit", 0, 3]])
    if (!Number.isInteger(value[key]) || value[key] < min || value[key] > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}.`);
  return Object.fromEntries(Object.keys(defaultCognition()).map(key => [key, value[key]]));
}
export const cognitionFor = record => validateCognition(record?.cognition || {});

// Only implementation-owned labels and counters enter this feed. Never append
// prompts, model output, credentials, provider errors or private chain text.
export class Activity {
  constructor(agentId) {
    this.agentId = agentId; this.revision = 0; this.running = false;
    this.stage = "idle"; this.events = []; this.active = new Map(); this.operationId = null;
  }
  event(ability, status, label, detail = {}) {
    const owned = new Set(["id", "at", "operationId", "stage", "ability", "status", "label"]);
    const safeDetail = Object.fromEntries(Object.entries(detail).filter(([key, value]) =>
      !owned.has(key) && /^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key) && (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))));
    const event = { id: ++this.revision, at: new Date().toISOString(), operationId: this.operationId,
      stage: ability, ability, status, label, ...safeDetail };
    this.events.push(event); if (this.events.length > 160) this.events.shift();
    this.stage = ability; return event;
  }
  begin(label) {
    this.running = true; this.active.clear(); this.operationId = randomUUID();
    this.event("operation", "started", label);
  }
  finish(status = "completed") {
    this.active.clear(); this.running = false;
    this.event("operation", status, status === "completed" ? "Operation complete" : status === "cancelled" ? "Operation stopped" : "Operation held");
  }
  async step(abilities, label, action, detail) {
    const list = Array.isArray(abilities) ? abilities : [abilities];
    for (const ability of list) {
      this.active.set(ability, (this.active.get(ability) || 0) + 1);
      this.event(ability, "started", label, detail);
    }
    try {
      const value = await action();
      for (const ability of list) this.event(ability, "completed", label, detail);
      return value;
    } catch (error) {
      const status = /CANCEL|ABORT/.test(String(error?.code)) ? "cancelled" : "held";
      for (const ability of list) this.event(ability, status, label, detail);
      throw error;
    } finally {
      for (const ability of list) {
        const count = (this.active.get(ability) || 1) - 1;
        if (count) this.active.set(ability, count); else this.active.delete(ability);
      }
    }
  }
  snapshot() {
    return { agentId: this.agentId, revision: this.revision, running: this.running, stage: this.stage,
      operationId: this.operationId, activeAbilities: [...this.active.keys()], events: structuredClone(this.events) };
  }
}

export const CAPABILITIES = Object.freeze([
  { id: "loop", name: "Verify, perceive, review and seal", status: "integrated", control: "Timechain active" },
  { id: "route", name: "Native routing and reviewed replay", status: "integrated", control: "autoRoute" },
  { id: "memory", name: "Shaped recall, temporal evidence and model-selected memory", status: "integrated", control: "semanticRecall" },
  { id: "search", name: "Native scored perspective tree and rollouts", status: "integrated", control: "Chronosynaptic" },
  { id: "learning", name: "Extractor teaching and Cambium growth", status: "integrated", control: "learning / autoSprout" },
  { id: "dormancy", name: "Manual dormancy and ordinary model chat", status: "integrated", control: "Pause / resume" },
  { id: "faculties", name: "Inspect, promote, equip, hibernate and restore faculties", status: "integrated", control: "Faculty manager" },
  { id: "continuum", name: "Source ingestion and configurable conversation blocks", status: "integrated", control: "Continuum" },
  { id: "maintenance", name: "Index, train and dream consolidation", status: "manual", control: "Cognition maintenance" },
  { id: "exchange", name: "Complete reviewed faculty exchange", status: "integrated", control: "Faculty exchange / original-skill companion" },
  { id: "authored", name: "Exact-source approved native Python operators", status: "operator", control: "Explicit local CLI approval; bounded process with user OS permissions" },
  { id: "recovery", name: "Encoding recovery, registry restoration and trust re-anchoring", status: "operator", control: "Bundled native CLI; explicit reviewed recovery" },
  { id: "consensus", name: "Witness administration and task-chain identity links", status: "operator", control: "Bundled native CLI; existing attestations are verified" },
  { id: "external", name: "Coding tools, browser, game or robotics environments", status: "external", control: "Requires a separate environment adapter; no arbitrary command executor" },
]);

const SHAPES = new Set(["narrow", "relative", "aggregate", "interval", "ordering", "update"]);
export function parseMemoryPlan(text, allowedRings = []) {
  let data; try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  for (const key of ["queries", "entities", "shapes", "rings"])
    if (key in data && !Array.isArray(data[key])) return null;
  if ("useReplay" in data && typeof data.useReplay !== "boolean") return null;
  if ("labels" in data && (!data.labels || typeof data.labels !== "object" || Array.isArray(data.labels))) return null;
  const strings = (value, cap, size) => Array.isArray(value) && value.length <= cap && value.every(v => typeof v === "string" && v.length <= size);
  if (!strings(data.queries || [], 4, 1000) || !strings(data.entities || [], 12, 160) ||
      !strings(data.shapes || [], 6, 40) || (data.shapes || []).some(v => !SHAPES.has(v)) ||
      !Array.isArray(data.rings || []) || (data.rings || []).length > 40 ||
      (data.rings || []).some(v => !Number.isSafeInteger(v) || !allowedRings.includes(v))) return null;
  const label = data.labels || {};
  for (const key of ["senses", "modalities"])
    if (key in label && !Array.isArray(label[key])) return null;
  if (!strings(label.senses || [], 24, 160) || !strings(label.modalities || [], 24, 160)) return null;
  return { queries: data.queries || [], entities: data.entities || [], shapes: data.shapes || [],
    rings: [...new Set(data.rings || [])], useReplay: data.useReplay === true,
    labels: { senses: label.senses || [], modalities: label.modalities || [] } };
}
