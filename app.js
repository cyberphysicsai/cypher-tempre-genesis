import { initMotifs } from "./motifs.js";
import { initThemes } from "./themes.js";
import {
  validateHoldingsConfig,
  verifyHoldingsWithWallet,
  freshChallenge,
  watchWallet,
  verifyBridgeIdentity,
  matchingConfiguration,
} from "./holdings-wallet.js";
import { blockHeight, formatTokenBalance, requiresHoldings, supportedBridgeVersion } from "./chainchat-display.js";
import {
  DEFAULT_COGNITION, normalizeCognition, normalizeActivity,
  abilityIndicators, facultyIdentity, facultyLifecycleAction, messageIsDormant, nativeSearchView,
  activityLineState, pollWithDeadline, routeControlState, reviewReceipt, facultyExecutionView, portabilityView,
  operatorCompatibilityView, facultyIsExportable,
} from "./cognition-display.js";
import {
  bridgeApiUrl,
  bridgePort,
  isLocalBridgePage,
} from "./bridge-connection.js";
import { connectLocalSession, clearLocalResume, localTabStorage } from "./local-session.js";
import { createAuditParent } from "./audit-parent.js";
import { initOpenClawSettings } from "./openclaw-settings.js";
const $ = (id) => document.getElementById(id);
const localBridgePage = isLocalBridgePage(location.origin);
let selectedBridgePort = "8790";
let auditedAgent = null;
const FRUITS = [
  "Love",
  "Peace",
  "Joy",
  "Kindness",
  "Mildness",
  "Self-control",
  "Goodness",
  "Patience",
  "Faith",
];
const DEFAULT_SETTINGS = {
  recall: true,
  fork: false,
  perspectives: 5,
  archetypes: [],
  continuum: { enabled: false, mode: "turn", targetBytes: 65536 },
};
let token = "",
  state = {
    agent: null,
    agents: [],
    provider: { configured: false },
    loadout: { modalities: [], senses: [] },
    settings: structuredClone(DEFAULT_SETTINGS),
  },
  catalogue = [],
  archetypes = [],
  currentKind = "modality",
  pendingAction = null,
  requestBusy = false,
  activeAgentId = null,
  polling = false,
  toastTimer;
let draftPerspectives = 5,
  draftArchetypes = new Set(),
  chatController = null;
const conversations = new Map();
let packPreviewState = null,
  previewGeneration = 0;
const exportSelection = new Set();
let runtimeActivity = null, activityReceivedAt = 0, activityPolling = false,
  cognitionBusy = false, stoppingBusy = false, lifecycleSelection = null, capabilities = [];
const seenFacultyIds = new Map(), newFacultyIds = new Map();
const icon = (name) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS(svg.namespaceURI, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
const el = (tag, cls, text) => {
  const item = document.createElement(tag);
  if (cls) item.className = cls;
  if (text !== undefined) item.textContent = text;
  return item;
};
const agentId = () => state.agent?.id || state.agent?.root || "unpaired";
const bytes = (n) =>
  Number(n) >= 1048576
    ? `${(Number(n) / 1048576).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB`
    : Number(n) >= 1024
      ? `${(Number(n) / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`
      : `${Number(n) || 0} B`;
const facultyId = (faculty) => String(faculty.key ?? faculty.id);
const rawId = (value) => String(value).split(":").at(-1);
const cleanKind = (value) =>
  String(value || "").startsWith("modal") ? "modality" : "sense";

// A deliberately small renderer: model text never becomes HTML or a link target.
function inlineText(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    const code = match[0].startsWith("`");
    parent.append(
      el(
        code ? "code" : "strong",
        "",
        match[0].slice(code ? 1 : 2, code ? -1 : -2),
      ),
    );
    cursor = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}
function messageBody(message) {
  const body = el("div", "message-body");
  if (message.role !== "assistant" || message.held) {
    body.textContent = message.content;
    return body;
  }
  body.classList.add("formatted");
  const lines = String(message.content).replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [],
    fence = null,
    codeLines = [],
    list = null;
  const flush = () => {
    if (paragraph.length) {
      const p = el("p");
      inlineText(p, paragraph.join("\n"));
      body.append(p);
      paragraph = [];
    }
    list = null;
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (fence !== null) {
        const pre = el("pre");
        pre.append(el("code", "", codeLines.join("\n")));
        body.append(pre);
        fence = null;
        codeLines = [];
      } else {
        flush();
        fence = line.trim().slice(3);
      }
      continue;
    }
    if (fence !== null) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flush();
      const h = el("h3");
      inlineText(h, heading[1]);
      body.append(h);
      continue;
    }
    const item = line.match(/^\s*(?:([-*])|\d+\.)\s+(.+)$/);
    if (item) {
      if (paragraph.length) flush();
      const kind = item[1] ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== kind) {
        list = el(kind);
        body.append(list);
      }
      const li = el("li");
      inlineText(li, item[2]);
      list.append(li);
      continue;
    }
    list = null;
    paragraph.push(line);
  }
  if (fence !== null) {
    const pre = el("pre");
    pre.append(el("code", "", codeLines.join("\n")));
    body.append(pre);
  }
  flush();
  return body;
}
function covenantReview(gate) {
  const fruits = gate?.fruits || gate?.fruitages;
  if (!fruits || typeof fruits !== "object") return null;
  const details = el("details", "perspective-details covenant-review");
  details.append(el("summary", "", "Covenant review · scored against genesis"));
  const grid = el("div", "review-grid");
  for (const fruit of FRUITS) {
    const score = fruits[fruit.toLowerCase()];
    const cell = el("div");
    cell.append(
      el("span", "", fruit),
      el(
        "strong",
        "",
        Number.isFinite(score) ? `${score} / 255` : "Not reported",
      ),
    );
    grid.append(cell);
  }
  details.append(grid);
  if (Number.isFinite(gate.scores?.covenant))
    details.append(
      el(
        "p",
        "review-note",
        `Overall covenant: ${gate.scores.covenant} / 255 · required minimum: ${gate.threshold ?? 180} / 255.`,
      ),
    );
  if (typeof gate.rationale === "string" && gate.rationale)
    details.append(el("p", "review-note", gate.rationale));
  return details;
}

async function api(path, data, options = {}) {
  if (!localBridgePage && !token && !["/api/pair", "/api/status"].includes(path))
    throw new Error("Install and launch ChainChat, or connect in optional website mode.");
  if (requiresHoldings(path, data)) await ensureHoldings();
  const requestToken = token;
  const headers = { Accept: "application/json" };
  if (requestToken) headers.Authorization = `Bearer ${requestToken}`;
  if (data !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(
      bridgeApiUrl(path, location.origin, selectedBridgePort),
      {
        method: data === undefined ? "GET" : "POST",
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
        cache: "no-store",
        ...options,
        credentials: "omit",
        redirect: "error",
      },
    );
  } catch (error) {
    if (error.name === "AbortError" || localBridgePage) throw error;
    throw new Error(
      "Could not reach the installed app. Open ChainChat using its application launcher. Optional website mode may also need local-network permission.",
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The local app returned an unreadable response.");
  }
  if (!response.ok) {
    const error = new Error(
      typeof result.error === "string"
        ? result.error
        : result.error?.message || "The request could not be completed.",
    );
    error.code = result.code;
    error.gate = result.gate;
    if (response.status === 401 && path !== "/api/pair" &&
        !path.startsWith("/api/license/") && token === requestToken) clearLocalSession();
    throw error;
  }
  return result;
}
function toast(message, bad = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").className = `toast visible${bad ? " error" : ""}`;
  toastTimer = setTimeout(() => $("toast").classList.remove("visible"), 5000);
}
function activity(message, kind = "") {
  $("activityText").textContent = message;
  $("activityLine").className = `activity-line ${kind}`;
}
function openDialog(id) {
  const dialog = $(id);
  dialog
    .querySelectorAll(".dialog-error")
    .forEach((node) => (node.textContent = ""));
  if (!dialog.open) dialog.showModal();
}
function closeDialog(id) {
  $(id).close();
}
function refreshEmbeddedAuditor() {
  const frame = $("auditFrame");
  if (!token || !state.agent) {
    frame.classList.add("hidden");
    frame.removeAttribute("src");
    $("loadAuditor").classList.remove("hidden");
    auditedAgent = null;
  } else if (!frame.classList.contains("hidden") && auditedAgent !== agentId()) {
    auditedAgent = agentId();
    frame.src = "./audit/?chainchat=1";
  }
}
window.addEventListener("message", createAuditParent({ origin: location.origin,
  source: () => $("auditFrame").contentWindow,
  context: () => ({ session: token, agent: state.agent?.id || null }),
  read: request => api("/api/audit/read", request),
  respond: (target, message, origin) => target.postMessage(message, origin),
}));
function requirePair(action) {
  if (token) {
    action();
    return;
  }
  pendingAction = action;
  openDialog("installDialog");
}
function requireAgent(action) {
  requirePair(() => {
    if (state.agent) action();
    else {
      toast("Create a genesis or pair an existing Timechain first.");
      openDialog("genesisDialog");
    }
  });
}
async function runForm(form, callback) {
  const button = form.querySelector('button[type="submit"]');
  const errors =
    form.querySelector(".dialog-error") ||
    form.closest("dialog").querySelector(".dialog-error");
  if (errors) errors.textContent = "";
  if (button) button.disabled = true;
  try {
    await callback();
  } catch (error) {
    if (errors) errors.textContent = error.message;
    else toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
    renderHoldingsControls();
  }
}
function settings() {
  return {
    ...DEFAULT_SETTINGS,
    ...state.settings,
    continuum: { ...DEFAULT_SETTINGS.continuum, ...state.settings?.continuum },
  };
}
function applyState(result) {
  const next = result.state || result;
  const incomingId = next.agent?.id || next.agent?.root;
  if (incomingId && incomingId !== agentId()) {
    delete state.faculties;
    delete state.operatorCompatibility;
    state.cognition = { ...DEFAULT_COGNITION };
    lifecycleSelection = null;
    runtimeActivity = null;
    activityReceivedAt = 0;
  }
  if (next.agent !== undefined || next.agents !== undefined) {
    state = { ...state, ...next };
    state.settings = {
      ...DEFAULT_SETTINGS,
      ...state.settings,
      continuum: {
        ...DEFAULT_SETTINGS.continuum,
        ...state.settings?.continuum,
      },
    };
  }
  if (next.cognition) state.cognition = normalizeCognition(next.cognition);
  if (next.faculties) state.faculties = next.faculties;
  else if (next.agent?.faculties) state.faculties = next.agent.faculties;
  if (next.operatorCompatibility) state.operatorCompatibility = next.operatorCompatibility;
  renderState();
}
async function refreshState() {
  if (!token || polling || requestBusy) return;
  polling = true;
  const sessionToken = token;
  try {
    const result = await api("/api/state");
    if (token === sessionToken) applyState(result);
  } catch (error) {
    if (!token) activity("Session ended. Open ChainChat using its application launcher to reconnect.");
    else console.warn("State refresh unavailable.");
  } finally {
    polling = false;
  }
}
function normalizeFaculties() {
  const all = state.faculties || state.agent?.faculties;
  let entries = Array.isArray(all)
    ? all
    : all
      ? [
          ...(all.modalities || []).map((f) => ({ ...f, kind: "modality" })),
          ...(all.senses || []).map((f) => ({ ...f, kind: "sense" })),
          ...(all.emergent || []).map((f) => ({ ...f, source: "emergent", equippable: false })),
          ...(all.dormant || []).map((f) => ({ ...f, dormant: true })),
        ]
      : catalogue;
  return entries.map((f) => ({
    ...f,
    kind: cleanKind(f.kind),
    id: f.id ?? f.key,
  }));
}

function cognition() {
  return normalizeCognition(state.cognition);
}

function trackFacultyGrowth(faculties) {
  if (!state.agent) return;
  const id = agentId(), ids = new Set(faculties.map(facultyIdentity));
  const previous = seenFacultyIds.get(id);
  if (previous) {
    const additions = newFacultyIds.get(id) || new Set();
    for (const key of ids) if (!previous.has(key)) additions.add(key);
    newFacultyIds.set(id, additions);
  }
  seenFacultyIds.set(id, ids);
}

function renderCognition() {
  const paired = !!token && !!state.agent, current = cognition(), dormant = current.mode === "dormant";
  const held = !!(state.agent?.locked || state.agent?.maintenancePending);
  $("cognitionMode").textContent = !paired ? "TIMECHAIN UNPAIRED" : dormant ? "TIMECHAIN PAUSED · PLAIN CHAT" : held ? "TIMECHAIN HELD · LOCAL REVIEW" : "TIMECHAIN ACTIVE";
  $("cognitionMode").classList.toggle("dormant", paired && dormant);
  $("cognitionMode").closest(".cognition-strip").classList.toggle("dormant", paired && dormant);
  $("learningIndicator").textContent = !paired ? "LEARNING —" : dormant ? "LEARNING PAUSED" : current.learning ? "LEARNING ON" : "LEARNING OFF";
  $("composerGateLabel").textContent = dormant && paired ? "Plain model chat · no Timechain review or recording" : "Proof of Interaction active with Timechain";
  $("gateStatus").textContent = dormant && paired ? "PAUSED" : held ? "CHAIN HELD" : "ACTIVE WITH CHAIN";
  $("gateAbility").classList.toggle("active", paired && !dormant);
  $("gateAbility").classList.toggle("locked", !dormant);
  const route = routeControlState(current, settings().recall);
  $("routeAbility").classList.toggle("active", paired && route.enabled);
  $("routeStatus").textContent = route.label;
  $("learningAbility").classList.toggle("active", paired && !dormant && current.learning);
  $("learningStatus").textContent = dormant ? "PAUSED" : current.learning ? "ENABLED" : "OFF · HISTORY ON";
  $("dreamAbility").classList.toggle("active", paired && !dormant && current.learning && current.autoDream);
  $("dreamStatus").textContent = dormant ? "PAUSED" : current.autoDream && current.learning ? "EVERY 100 BLOCKS" : "MANUAL";
  $("cognitionStatus").textContent = dormant ? "PLAIN CHAT" : "MONITOR";
  $("cognitionModeTitle").textContent = dormant ? "Timechain paused · plain model chat" : held ? "Timechain held for local review" : "Timechain active";
  $("cognitionModeDescription").textContent = dormant
    ? "No Timechain context, faculty computations, PoI review, learning or new chain blocks. Each plain request is sent on its own; earlier displayed messages are not added as context. Resume whenever you choose."
    : held ? "The native agent is locked or has an incomplete maintenance journal. Review and recover it locally before continuing chain work. Existing history is preserved; this interface will not clear the hold automatically."
    : current.learning
      ? "Memory, faculties, covenant review and accepted conversation blocks are active. Learning and growth follow your selected settings."
      : "Memory, faculties, covenant review and accepted conversation blocks remain active. Learner training and automatic growth are off.";
  $("toggleChainMode").textContent = dormant ? "Resume Timechain" : "Pause Timechain · plain model chat";
  $("toggleChainMode").disabled = !paired || cognitionBusy || (dormant && !hasHoldingsAccess());
  if (paired && dormant) {
    for (const id of ["recallAbility", "forkAbility", "continuumAbility", "loadoutAbility"])
      $(id).classList.remove("active");
    for (const id of ["recallAbility", "forkAbility", "continuumAbility"])
      $(id).querySelector(".slot-status").textContent = "PAUSED";
    $("loadoutAbility").querySelector(".slot-status").textContent = "LOADOUT SAVED";
  }
  $("sessionTag").textContent = paired && dormant ? "PLAIN CHAT · CHAIN PAUSED" : $("sessionTag").textContent;
  renderOperatorCompatibility();
  renderRuntimeActivity();
}

function renderOperatorCompatibility() {
  const panel = $("operatorCompatibility"), view = operatorCompatibilityView(state.operatorCompatibility);
  panel.replaceChildren();
  panel.append(el("div", "section-caption", "LOCAL OPERATOR COMPATIBILITY"));
  if (!view) {
    panel.append(el("p", "fine-print", "Pair or refresh your agent to inspect its local operator module. No browser action can approve authored code."));
    return;
  }
  panel.append(el("strong", "", `${view.source} · ${view.label}`));
  if (view.reason) panel.append(el("p", "fine-print", view.reason));
  if (view.sha256) panel.append(el("p", "fine-print", "Detected module SHA-256"), el("code", "operator-digest", view.sha256));
  if (view.environmentSha256) panel.append(el("p", "fine-print", "Environment SHA-256"), el("code", "operator-digest", view.environmentSha256));
  if (view.declaredNames.length) panel.append(el("p", "fine-print", `Declared operators: ${view.declaredNames.join(", ")}`));
  if (view.available) panel.append(el("p", "quarantine-note", "Locally approved code executes under your operating-system permissions. It is not sandboxed. Inspect the code and its dependencies before approving the exact digest in your local terminal."));
  if (view.notice) panel.append(el("p", "fine-print", view.notice));
  if (view.command) panel.append(el("p", "fine-print", "Companion CLI instructions · replace the agent-directory placeholder after review:"), el("code", "operator-command", view.command));
}

function renderRuntimeActivity() {
  const paired = !!token && !!state.agent;
  const fresh = paired && runtimeActivity?.agentId === agentId() && Date.now() - activityReceivedAt < 6000;
  for (const [id, indicator] of Object.entries(abilityIndicators(runtimeActivity, fresh))) {
    const button = $(id);
    button.classList.toggle("running", indicator.active);
    button.dataset.runStatus = indicator.status;
    button.setAttribute("aria-busy", String(indicator.active));
    let badge = button.querySelector(".slot-live");
    if (!badge) { badge = el("span", "slot-live"); button.append(badge); }
    badge.textContent = paired ? indicator.status : "IDLE";
  }
  $("monitorConnection").textContent = !paired ? "NOT CONNECTED" : fresh ? "LIVE APP" : "ACTIVITY UNAVAILABLE";
  const running = fresh && runtimeActivity?.running;
  $("cancelTurn").classList.toggle("hidden", !(requestBusy || running));
  $("cancelTurn").disabled = stoppingBusy;
  const events = runtimeActivity?.events || [];
  const last = events.at(-1);
  const mainStatus = activityLineState(runtimeActivity, { paired, fresh, requestBusy });
  $("monitorStage").textContent = !paired ? "Pair a Timechain to see its actual runtime stages."
    : !fresh ? "Live activity is unavailable. No ability is shown as running until the app confirms it."
      : running ? mainStatus.text
        : last?.label || "Idle. Equipped abilities will light up when the app runs them.";
  if (mainStatus) activity(mainStatus.text, mainStatus.kind);
  const list = $("activityTimeline");
  list.replaceChildren();
  for (const event of events.slice(-30).reverse()) {
    const row = el("li"); row.dataset.status = event.status;
    const date = new Date(event.at);
    const timestamp = Number.isFinite(date.getTime()) ? date.toLocaleTimeString() : "";
    row.append(el("small", "", `${timestamp} · ${event.ability.toUpperCase()} · ${event.status.toUpperCase()}`), el("span", "", event.label || event.stage));
    if (event.detail) row.append(el("p", "fine-print", event.detail));
    list.append(row);
  }
  if (!events.length) list.append(el("li", "", "No activity recorded in this app session yet."));
}

async function refreshActivity() {
  if (!token || !state.agent || activityPolling) return;
  activityPolling = true;
  const sessionToken = token, id = agentId();
  try {
    const result = await pollWithDeadline(signal => api("/api/activity", undefined, { signal }));
    if (sessionToken !== token || id !== agentId()) return;
    const next = normalizeActivity(result.activity || result, id);
    if (!next || (runtimeActivity?.agentId === id && next.revision < runtimeActivity.revision)) return;
    runtimeActivity = next; activityReceivedAt = Date.now();
  } catch { if (sessionToken === token && id === agentId()) activityReceivedAt = 0; }
  finally { activityPolling = false; renderRuntimeActivity(); }
}

async function refreshCognition() {
  if (!token || !state.agent) return;
  const sessionToken = token, id = agentId();
  const result = await api("/api/cognition");
  if (sessionToken !== token || id !== agentId()) return;
  state.cognition = normalizeCognition(result.cognition || result.state?.cognition);
  if (result.faculties) state.faculties = result.faculties;
  const operatorCompatibility = result.operatorCompatibility || result.state?.operatorCompatibility;
  if (operatorCompatibility) state.operatorCompatibility = operatorCompatibility;
  if (Array.isArray(result.capabilities)) capabilities = result.capabilities;
  renderState();
  renderLifecycle();
  return result;
}

function renderCapabilities() {
  const target = $("capabilityList"); target.replaceChildren();
  for (const capability of capabilities) {
    if (!capability || typeof capability !== "object") continue;
    const row = el("div", "capability-item");
    row.append(el("strong", "", String(capability.name || capability.id || "Capability")), el("span", "", String(capability.status || (capability.available === false ? "UNAVAILABLE" : "AVAILABLE")).toUpperCase()));
    if (capability.description || capability.detail || capability.control) row.append(el("p", "", String(capability.description || capability.detail || capability.control)));
    target.append(row);
  }
}

async function openCognition() {
  openDialog("cognitionDialog");
  try {
    await refreshCognition();
    const current = cognition();
    for (const [id, key] of [["learningEnabled", "learning"], ["autoRoute", "autoRoute"], ["semanticRecall", "semanticRecall"], ["autoSprout", "autoSprout"], ["autoDream", "autoDream"]]) $(id).checked = current[key];
    $("revisionLimit").value = current.revisionLimit;
    const result = await api("/api/capabilities");
    capabilities = Array.isArray(result.capabilities) ? result.capabilities : Array.isArray(result.items) ? result.items : [];
    renderCapabilities();
    await refreshActivity();
  } catch (error) { $("cognitionDialog").querySelector(".dialog-error").textContent = error.message; }
}

async function saveCognition(change) {
  const result = await api("/api/cognition", change);
  state.cognition = normalizeCognition(result.cognition || result.state?.cognition || { ...cognition(), ...change });
  applyState(result);
  await refreshCognition();
  return result;
}
function isEquipped(faculty) {
  const chosen =
    state.loadout?.[faculty.kind === "modality" ? "modalities" : "senses"] ||
    [];
  return chosen.some((id) => rawId(id) === rawId(facultyId(faculty)));
}
function renderFaculties() {
  const faculties = normalizeFaculties(),
    query = $("facultySearch").value.toLowerCase().trim();
  const lastChainTurn = [...(conversations.get(agentId()) || historyMessages())].reverse()
    .find(message => message.role === "assistant" && !message.held && !messageIsDormant(message));
  const executions = facultyExecutionView(lastChainTurn?.facultyExecution);
  trackFacultyGrowth(faculties);
  const freshIds = newFacultyIds.get(agentId()) || new Set();
  const freshCount = faculties.filter(f => freshIds.has(facultyIdentity(f))).length;
  $("newFacultiesNotice").classList.toggle("hidden", !freshCount || !state.agent);
  $("newFacultiesNotice").textContent = `${freshCount} new facult${freshCount === 1 ? "y" : "ies"} · inspect before equipping ↗`;
  const modalities = faculties.filter((f) => f.kind === "modality"),
    senses = faculties.filter((f) => f.kind === "sense");
  $("availableCount").textContent = faculties.length || "—";
  $("modalityCount").textContent = modalities.length;
  $("senseCount").textContent = senses.length;
  const equipped = state.agent ? faculties.filter(isEquipped).length : 0;
  $("equippedCount").textContent = equipped;
  $("facultyStatus").textContent = state.agent
    ? cognition().mode === "dormant" ? "LOADOUT SAVED" : `${equipped} EQUIPPED`
    : "LOADOUT";
  $("loadoutAbility").classList.toggle("active", equipped > 0 && cognition().mode !== "dormant");
  $("catalogueStatus").textContent = state.agent
    ? "LIVE AGENT\nCATALOGUE"
    : "BASE\nCATALOGUE";
  $("growthNote").textContent = state.agent
    ? cognition().mode === "dormant" ? "Timechain is paused. Equipped faculties are saved for when you resume."
      : "Your live catalogue refreshes as this agent learns. New faculties wait for your equipment choice."
    : "Your catalogue grows as your agent learns. Pair a chain to equip faculties.";
  if (executions.length) $("growthNote").textContent += " Receipt badges describe the last chain turn; equipped does not mean running.";
  const list = $("facultyList");
  list.replaceChildren();
  const shown = faculties
    .filter(
      (f) =>
        f.kind === currentKind &&
        `${f.name} ${f.function} ${f.category}`.toLowerCase().includes(query),
    )
    .sort((a, b) => Number(isEquipped(b)) - Number(isEquipped(a)));
  if (!shown.length) {
    list.append(el("p", "faculty-empty", "No matching faculties."));
    return;
  }
  for (const faculty of shown) {
    const selected = !!state.agent && isEquipped(faculty);
    const execution = executions.find(entry => entry.kind === faculty.kind && entry.key === facultyId(faculty));
    const button = el(
      "button",
      `faculty-card${selected ? " equipped" : ""}${faculty.equippable === false ? " emerging" : ""}${freshIds.has(facultyIdentity(faculty)) ? " new-faculty" : ""}`,
    );
    button.type = "button";
    button.disabled = !!token && !hasHoldingsAccess();
    button.title = `${faculty.function || faculty.description || ""}${faculty.dormant ? " · Dormant faculty" : ""}`;
    button.setAttribute("aria-pressed", String(selected));
    button.setAttribute(
      "aria-label",
      `${selected ? "Unequip" : "Equip"} ${faculty.name}`,
    );
    const frame = el("span", "faculty-icon");
    frame.append(icon(faculty.kind === "modality" ? "spark" : "eye"));
    const copy = el("span", "faculty-copy");
    copy.append(
      el("strong", "", faculty.name),
      el(
        "p",
        "",
        faculty.function ||
          faculty.description ||
          "A faculty from this agent’s registry.",
      ),
    );
    if (execution) {
      const receipt = el("span", "faculty-execution", `LAST CHAIN TURN · ${execution.label}`);
      receipt.dataset.mode = execution.mode;
      receipt.title = [execution.mechanism, execution.reason].filter(Boolean).join(" · ");
      copy.append(receipt);
      button.setAttribute("aria-label", `${selected ? "Unequip" : "Equip"} ${faculty.name}. Last chain turn: ${execution.label.toLowerCase()}`);
    }
    const meta = el("span", "faculty-meta");
    meta.append(
      el("span", "", (faculty.category || faculty.kind).toUpperCase()),
      el(
        "span",
        "",
        freshIds.has(facultyIdentity(faculty)) ? "NEW · " + (faculty.equippable === false ? "EMERGING" : "AVAILABLE") : selected
          ? "EQUIPPED"
          : faculty.equippable === false
            ? "EMERGING"
            : faculty.dormant
              ? "DORMANT"
              : faculty.source === "imported"
                ? "IMPORTED"
                : state.agent
                  ? "AVAILABLE"
                  : "PREVIEW",
      ),
    );
    copy.append(meta);
    button.append(frame, copy);
    if (selected) button.append(el("span", "faculty-check", "✓"));
    button.addEventListener("click", () => {
      if (faculty.dormant) {
        requireAgent(() => openLifecycle("dormant"));
        return;
      }
      if (faculty.equippable === false) {
        requireAgent(() => openLifecycle("emergent"));
        return;
      }
      requireAgent(() => toggleFaculty(faculty));
    });
    list.append(button);
  }
}
async function toggleFaculty(faculty) {
  if (requestBusy) {
    toast(
      "Your current turn is using this loadout. Change it after the turn completes.",
    );
    return;
  }
  const kind = faculty.kind === "modality" ? "modalities" : "senses";
  const loadout = {
    modalities: [...(state.loadout?.modalities || [])],
    senses: [...(state.loadout?.senses || [])],
  };
  if (isEquipped(faculty))
    loadout[kind] = loadout[kind].filter(
      (id) => rawId(id) !== rawId(facultyId(faculty)),
    );
  else loadout[kind].push(facultyId(faculty));
  try {
    const result = await api("/api/loadout", loadout);
    state.loadout = result.loadout || result.state?.loadout || loadout;
    applyState(result);
    toast(
      `${faculty.name} ${isEquipped(faculty) ? "equipped" : "unequipped"}.`,
    );
  } catch (error) {
    toast(error.message, true);
  }
}
function historyMessages() {
  const history = state.agent?.history || [];
  const result = [];
  for (const turn of history) {
    const payload = turn.payload || turn;
    const input = payload.input ?? payload.user ?? payload.prompt;
    const output =
      payload.output ??
      payload.assistant ??
      payload.response ??
      payload.content;
    const ring =
      typeof turn.ring === "number"
        ? { index: turn.ring, hash: turn.hash }
        : turn.ring || { index: turn.index, hash: turn.ring_hash || turn.hash };
    if (input && typeof input === "string")
      result.push({ role: "user", content: input, fromHistory: true });
    if (output && typeof output === "string")
      result.push({
        role: "assistant",
        content: output,
        input,
        ring,
        gate: payload.gate || payload.poi_verdict,
        perspectives: payload.perspectives,
        search: payload.search,
        replayed: payload.replayed,
        revisions: payload.revisions,
        facultyExecution: payload.facultyExecution,
        learning: payload.learning,
        fromHistory: true,
      });
  }
  for (const pending of state.pending?.exchanges || []) {
    if (typeof pending.input === "string")
      result.push({ role: "user", content: pending.input, fromHistory: true });
    if (typeof pending.output === "string")
      result.push({
        role: "assistant",
        content: pending.output,
        input: pending.input,
        pending: true,
        gate: pending.gate,
        perspectives: pending.perspectives,
        search: pending.search,
        replayed: pending.replayed,
        revisions: pending.revisions,
        facultyExecution: pending.facultyExecution,
        learning: pending.learning,
        fromHistory: true,
      });
  }
  return result;
}
function reconcilePending() {
  let changed = false;
  for (const message of conversations.get(agentId()) || []) {
    if (!message.pending) continue;
    const stillPending = (state.pending?.exchanges || []).some(
      (item) =>
        item.output === message.content &&
        (!message.input || item.input === message.input),
    );
    if (stillPending) continue;
    const receipt = [...(state.agent?.history || [])]
      .reverse()
      .find(
        (item) =>
          item.output === message.content &&
          (!message.input || item.input === message.input),
      );
    if (receipt) {
      message.pending = false;
      message.ring =
        typeof receipt.ring === "number"
          ? { index: receipt.ring, hash: receipt.hash }
          : receipt.ring;
      changed = true;
    }
  }
  return changed;
}
function renderState() {
  const paired = !!token,
    agent = state.agent;
  $("pairForm").classList.toggle("hidden", paired);
  $("pairedSession").classList.toggle("hidden", !paired);
  $("showPairingCode").classList.toggle("hidden", !paired || !localBridgePage);
  if (!paired) {
    $("websitePairingCode").textContent = "";
    $("websitePairingCode").classList.add("hidden");
  }
  $("disconnectModel").classList.toggle("hidden", !state.provider?.configured);
  const id = agentId();
  $("installNotice").classList.toggle("hidden", localBridgePage || paired);
  refreshEmbeddedAuditor();
  $("bridgeDot").classList.toggle("online", paired);
  $("bridgeStatus").textContent = paired
    ? state.executionRuntime?.backend === "openclaw" ? "OPENCLAW CONNECTED" : "LOCAL RUNTIME CONNECTED"
    : localBridgePage ? "OPEN INSTALLED CHAINCHAT" : "INSTALL & LAUNCH CHAINCHAT";
  $("pairButton").querySelector("span").textContent = paired
    ? "App connected"
    : "Install & open";
  $("modelLabel").textContent =
    paired && state.provider?.configured
      ? state.provider.model
      : "Connect a model";
  $("modelButton").title = state.provider?.configured
    ? `${state.provider.provider} · ${state.provider.model}`
    : "Connect your own model API";
  $("agentName").textContent =
    paired && agent
      ? agent.name || agent.genesis?.payload?.name || "Cypher agent"
      : "No agent paired";
  $("agentIdentity").textContent =
    paired && agent
      ? `TIMECHAIN · ${agent.head?.index ?? 0}`
      : "A beginning awaits";
  $("ringCount").textContent =
    paired && agent
      ? Number(
          agent.ringCount ?? agent.rings ?? Number(agent.head?.index ?? 0) + 1,
        ).toLocaleString()
      : "—";
  const verified = agent?.verified === true || agent?.verified === "PASS";
  $("integrityStatus").textContent =
    paired && agent ? (verified ? "VERIFIED" : "CHECK REQUIRED") : "UNPAIRED";
  $("integrityStatus").className =
    `integrity${paired && agent ? (verified ? " pass" : " fail") : ""}`;
  $("headHash").textContent =
    paired && agent
      ? agent.head?.hash || agent.head?.ring_hash || "No hash available"
      : "Awaiting genesis";
  $("headHash").title =
    paired && agent ? agent.head?.hash || agent.head?.ring_hash || "" : "";
  $("sessionTag").textContent =
    paired && agent
      ? verified
        ? "VERIFIED CHAIN"
        : "CHAIN NEEDS REVIEW"
      : "UNPAIRED";
  $("currentBlockHeight").textContent = blockHeight(agent, paired);
  $("chainNote").textContent = agent
    ? "Your history belongs to this agent.\nSwitch models without resetting it."
    : "One identity. Across models.\nEvery accepted turn, a new ring.";
  $("welcomeStart").replaceChildren(
    document.createTextNode(
      paired && agent ? "Start a conversation " : "Begin your Timechain ",
    ),
    el("span", "", "↗"),
  );
  const chosen = settings();
  $("recallAbility").classList.toggle("active", chosen.recall);
  $("recallAbility").setAttribute("aria-pressed", String(chosen.recall));
  $("recallAbility").querySelector(".slot-status").textContent = chosen.recall
    ? "EQUIPPED"
    : "OFF";
  $("forkAbility").classList.toggle("active", chosen.fork);
  $("forkStatus").textContent = chosen.fork
    ? `${chosen.perspectives} PERSPECTIVES`
    : "CONFIGURE";
  $("continuumAbility").classList.toggle("active", chosen.continuum.enabled);
  $("continuumStatus").textContent =
    chosen.continuum.enabled && chosen.continuum.mode === "bytes"
      ? `${bytes(chosen.continuum.targetBytes)} / BLOCK`
      : "1 TURN / BLOCK";
  $("bufferBytes").textContent = bytes(state.pending?.bytes || 0);
  $("heldBlockNote").classList.toggle("hidden", !state.pending?.heldCount);
  $("heldBlockNote").textContent = state.pending?.heldCount
    ? `${state.pending.heldCount} held response${state.pending.heldCount === 1 ? "" : "s"} awaiting recheck. Use Commit pending block to review again before release.`
    : "";
  if (state.pending?.heldCount && !requestBusy)
    activity(
      "A held response is awaiting recheck. Open Continuum to review the pending block.",
      "error",
    );
  $("agentChoices").replaceChildren();
  for (const item of state.agents || []) {
    const button = el("button", "", item.name || item.id);
    button.type = "button";
    button.addEventListener("click", () => selectAgent(item.id));
    $("agentChoices").append(button);
  }
  if (!state.agents?.length)
    $("agentChoices").append(
      el("p", "fine-print", "No agents yet. Create your genesis."),
    );
  renderFaculties();
  if (activeAgentId !== id) {
    invalidatePackPreview();
    exportSelection.clear();
    activeAgentId = id;
    if (!conversations.has(id)) conversations.set(id, historyMessages());
    renderConversation();
  }
  if (reconcilePending()) renderConversation();
  if ($("exchangeDialog").open) renderExportFaculties();
  if (state.gate?.threshold)
    $("thresholdNote").textContent =
      `While Timechain is active, every fruitage must meet the server-enforced minimum (${state.gate.threshold}/255), alongside native PoI acceptance. Deliberate dormancy uses plain model chat without this gate or chain recording.`;
  renderHoldingsControls();
  renderCognition();
}
function renderConversation() {
  const messages = conversations.get(agentId()) || [];
  $("welcome").classList.toggle("hidden", messages.length > 0);
  const list = $("messages");
  list.replaceChildren();
  for (const message of messages) {
    const node = el(
      "article",
      `message ${message.role}${message.held ? " held" : ""}${messageIsDormant(message) ? " plain" : ""}`,
    );
    const label = el("div", "message-label");
    if (message.role === "assistant")
      label.append(icon(message.held ? "shield" : "orbit"));
    label.append(
      el(
        "span",
        "",
        message.held
          ? "RESPONSE HELD"
          : message.control ? "OPENCLAW CONTROL"
          : message.role === "user"
            ? "YOU"
            : state.agent?.name?.toUpperCase() || "CYPHER AGENT",
      ),
    );
    node.append(label, messageBody(message));
    if (message.role === "assistant" && !message.held) {
      const meta = el("div", "message-meta");
      const ring = message.ring;
      meta.append(
        el(
          "span",
          "",
          messageIsDormant(message)
            ? "Plain model chat · not reviewed or recorded in Timechain"
            : message.control ? "Native control result · Timechain history preserved"
            : message.pending
            ? "✓ Covenant accepted · pending block"
            : ring
              ? `✓ Sealed · Ring ${ring.index ?? ring}`
              : "✓ Covenant accepted",
        ),
      );
      if (ring?.hash || ring?.ring_hash)
        meta.append(
          el(
            "code",
            "",
            `${String(ring.hash || ring.ring_hash).slice(0, 20)}…`,
          ),
        );
      if (message.gate?.brightness !== undefined)
        meta.append(el("span", "", `PoI ${message.gate.brightness}/255`));
      for (const receipt of reviewReceipt(message)) meta.append(el("span", "review-receipt", receipt));
      node.append(meta);
      const executions = messageIsDormant(message) ? [] : facultyExecutionView(message.facultyExecution);
      if (executions.length) {
        const details = el("details", "perspective-details faculty-execution-details");
        details.append(el("summary", "", `Faculty receipts · ${executions.length} equipped`));
        details.append(el("p", "fine-print", "Computed means the app completed a mechanism. Frame applied means a faculty instruction was added to model context. Neither label measures answer quality."));
        for (const execution of executions) {
          const row = el("div", "perspective-note");
          row.dataset.mode = execution.mode;
          row.append(el("strong", "", `${execution.name} · ${execution.label}`),
            el("p", "fine-print", [execution.kind, execution.mechanism, execution.reason].filter(Boolean).join(" · ")));
          details.append(row);
        }
        node.append(details);
      }
      if (Number.isInteger(message.learning?.held) && message.learning.held > 0)
        node.append(el("p", "learning-note", `${message.learning.held} derived learning step${message.learning.held === 1 ? " was" : "s were"} held. The accepted conversation receipt above is unchanged; those learning updates were not applied.`));
      const review = covenantReview(message.gate);
      if (review) node.append(review);
      if (Array.isArray(message.perspectives) && message.perspectives.length) {
        const details = el("details", "perspective-details");
        details.append(
          el(
            "summary",
            "",
            `${message.perspectives.length} perspective findings`,
          ),
        );
        for (const perspective of message.perspectives) {
          const item = el("div", "perspective-note");
          item.append(
            el(
              "strong",
              "",
              perspective.name || perspective.archetype || "Perspective",
            ),
            el(
              "p",
              "",
              perspective.summary ||
                perspective.finding ||
                perspective.conclusion ||
                "",
            ),
          );
          details.append(item);
        }
        node.append(details);
      }
      if (message.search && typeof message.search === "object") {
        const details = el("details", "perspective-details search-details");
        const search = nativeSearchView(message.search);
        details.append(el("summary", "", "Native Chronosynaptic search"));
        details.append(el("p", "fine-print", `Explored depth: ${search.depth} · iterations: ${search.iterations} · winner: ${search.winner}`));
        if (search.selectedPath.length) details.append(el("p", "fine-print", `Selected path: ${search.selectedPath.join(" → ")}`));
        for (const item of search.nodes) {
          const card = el("div", "perspective-note search-node");
          card.dataset.selected = String(item.selected);
          card.append(el("strong", "", `${item.selected ? "SELECTED · " : ""}${item.name} · visits ${item.visits} · value ${item.value}`));
          if (item.summary) card.append(el("p", "", item.summary));
          details.append(card);
        }
        if (search.epitaphs.length) details.append(el("strong", "search-epitaph-title", "Candidate records · not selected"));
        for (const item of search.epitaphs) details.append(el("p", "fine-print", `${item.path ? item.path + ": " : ""}${item.summary || "Candidate not selected."}`));
        node.append(details);
      }
    }
    list.append(node);
  }
  requestAnimationFrame(() =>
    $("conversationScroll").scrollTo({
      top: messages.length ? $("conversationScroll").scrollHeight : 0,
      behavior: messages.length ? "smooth" : "instant",
    }),
  );
  renderFaculties();
}
function addMessage(message) {
  const id = agentId();
  if (!conversations.has(id)) conversations.set(id, []);
  conversations.get(id).push(message);
  renderConversation();
}
async function selectAgent(id) {
  if (requestBusy) {
    toast("Wait for your active turn to finish before switching agents.");
    return;
  }
  try {
    applyState(await api("/api/agents/select", { id }));
    $("agentChoices").classList.add("hidden");
    $("agentSidebar").classList.remove("mobile-open");
    toast("Agent Timechain selected.");
  } catch (error) {
    toast(error.message, true);
  }
}
async function saveSettings(next) {
  const result = await api("/api/settings", next);
  state.settings = result.settings ||
    result.state?.settings || { ...settings(), ...next };
  applyState(result);
  return result;
}

document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
document.querySelectorAll("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        event.clientX < r.left ||
        event.clientX > r.right ||
        event.clientY < r.top ||
        event.clientY > r.bottom
      )
        dialog.close();
    }
  }),
);
$("pairButton").addEventListener("click", () => openDialog(token ? "pairDialog" : "installDialog"));
$("getStartedButton").addEventListener("click", () => openDialog("installDialog"));
$("advancedWebsitePairing").addEventListener("click", () => {
  closeDialog("installDialog");
  openDialog("pairDialog");
});
$("showPairingCode").addEventListener("click", async () => {
  const button = $("showPairingCode");
  button.disabled = true;
  try {
    const result = await api("/api/local-pairing");
    $("websitePairingCode").textContent = `Website pairing code: ${result.code}. Enter it only at cyphertempre.ai. It grants access to this local runtime.`;
    $("websitePairingCode").classList.remove("hidden");
  } catch (error) {
    $("pairedSession").querySelector(".dialog-error").textContent = error.message;
  } finally { button.disabled = false; }
});
function clearLocalSession() {
  nativePanel.close();
  clearLocalResume(localBridgePage ? localTabStorage() : null);
  chatController?.abort();
  walletController?.abort();
  walletWatch?.close();
  walletWatch = null;
  currentLicense = null;
  walletRevoked = true;
  licenseRevision++;
  token = "";
  pendingAction = null;
  state = {
    agent: null,
    agents: [],
    provider: { configured: false },
    loadout: { modalities: [], senses: [] },
    settings: structuredClone(DEFAULT_SETTINGS),
  };
  conversations.clear();
  seenFacultyIds.clear(); newFacultyIds.clear();
  runtimeActivity = null; activityReceivedAt = 0; capabilities = [];
  lifecycleSelection = null;
  activeAgentId = null;
  $("apiKey").value = "";
  $("pairCode").value = "";
  $("messageInput").value = "";
  $("packJson").value = "";
  $("packFile").value = "";
  renderLicense(null);
  renderState();
  renderConversation();
  activity("App disconnected. Open ChainChat using its application launcher to continue your saved Timechain.");
}
$("endSession").addEventListener("click", async () => {
  const button = $("endSession");
  button.disabled = true;
  try {
    await api("/api/unpair", {});
    clearLocalSession();
    closeDialog("pairDialog");
    toast("App session ended. Its model credential was cleared.");
  } catch (error) {
    $("pairedSession").querySelector(".dialog-error").textContent =
      error.message;
  } finally {
    button.disabled = false;
  }
});
$("disconnectModel").addEventListener("click", async () => {
  const button = $("disconnectModel");
  button.disabled = true;
  try {
    const result = await api("/api/provider", { disconnect: true });
    chatController?.abort();
    state.provider = result.provider || { configured: false };
    $("apiKey").value = "";
    $("modelId").value = "";
    $("baseUrl").value = "";
    $("reasoningCapable").checked = false;
    renderState();
    closeDialog("modelDialog");
    toast("Model disconnected. Its key was cleared from app memory.");
  } catch (error) {
    $("modelForm").querySelector(".dialog-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
$("pairForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    if (!localBridgePage)
      selectedBridgePort = bridgePort($("bridgePort").value);
    const bridge = await api("/api/status");
    if (!supportedBridgeVersion(bridge.version))
      throw new Error("Install ChainChat 0.8.0 or newer to use this interface. OpenClaw and PoI are included.");
    const result = await api("/api/pair", { code: $("pairCode").value.trim() });
    token = result.token;
    $("pairCode").value = "";
    applyState(await api("/api/state"));
    await refreshLicense();
    closeDialog("pairDialog");
    toast("Website connected to the local app.");
    try {
      const data = await api("/api/archetypes");
      archetypes = data.archetypes || [];
    } catch {}
    const action = pendingAction;
    pendingAction = null;
    if (action) action();
  });
});
$("newAgentButton").addEventListener("click", () =>
  requirePair(() => openDialog("genesisDialog")),
);
$("welcomeStart").addEventListener("click", () =>
  requirePair(() => {
    if (!state.agent) openDialog("genesisDialog");
    else if (!state.provider?.configured) openModel();
    else $("messageInput").focus();
  }),
);
for (const id of ["existingAgentButton", "welcomePair"])
  $(id).addEventListener("click", () =>
    requirePair(() => openDialog("existingDialog")),
  );
$("genesisForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    applyState(
      await api("/api/agents", { name: $("newAgentName").value.trim() }),
    );
    closeDialog("genesisDialog");
    $("newAgentName").value = "Cypher Tempre";
    toast("Genesis sealed. Your Timechain has begun.");
    if (!state.provider?.configured) openModel();
  });
});
$("existingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    applyState(
      await api("/api/agents/pair", { root: $("existingRoot").value.trim() }),
    );
    closeDialog("existingDialog");
    if (hasHoldingsAccess()) {
      toast("Existing Timechain verified and paired.");
      if (!state.provider?.configured) openModel();
    } else {
      toast("Timechain paired. Verify CPHY holdings to enable chat.");
    }
  });
});
$("discoverChains").addEventListener("click", async () => {
  const button = $("discoverChains"), results = $("discoveredChains");
  button.disabled = true; results.replaceChildren(); results.classList.remove("hidden");
  results.textContent = "Checking known agent directories on this machine…";
  try {
    const found = await api("/api/agents/discover", {});
    results.replaceChildren();
    for (const candidate of found.candidates || []) {
      const choice = document.createElement("button"); choice.type = "button"; choice.className = "text-button full-width";
      choice.textContent = `${candidate.label} · ${candidate.root}`;
      choice.addEventListener("click", () => { $("existingRoot").value = candidate.root; toast("Selected. Verify and pair to continue this chain."); });
      results.append(choice);
    }
    const note = document.createElement("p");
    note.textContent = found.candidates?.length ? "Select a chain, then verify and pair. Discovery does not change its files." : "No chain found in known agent directories. Enter its path below.";
    if (!found.complete) note.textContent += " Search limits were reached; other chains may exist.";
    results.append(note);
  } catch (error) { results.textContent = error.message; }
  finally { button.disabled = false; }
});
$("agentSelectButton").addEventListener("click", () =>
  requirePair(() => $("agentChoices").classList.toggle("hidden")),
);
function openModel() {
  const provider = state.provider || {};
  $("provider").value = provider.provider || "openai";
  $("modelId").value = provider.model || "";
  $("baseUrl").value = provider.baseUrl || "";
  $("reasoningCapable").checked = provider.reasoningCapable === true;
  $("apiKey").value = "";
  updateProviderPlaceholder();
  renderHoldingsControls();
  openDialog("modelDialog");
}
$("modelButton").addEventListener("click", () => requirePair(openModel));
function updateProviderPlaceholder() {
  const provider = $("provider").value;
  const bases = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
    gemini: "https://generativelanguage.googleapis.com/v1beta",
    compatible: "http://127.0.0.1:11434/v1",
  };
  $("baseUrl").placeholder = bases[provider];
  $("apiKey").required = provider !== "compatible";
  $("apiKey").placeholder =
    provider === "compatible"
      ? "Optional for an unauthenticated local provider"
      : "Held only in this app session";
}
$("provider").addEventListener("change", () => {
  $("baseUrl").value = "";
  $("modelId").value = "";
  $("reasoningCapable").checked = false;
  updateProviderPlaceholder();
});
$("modelForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    const data = {
      provider: $("provider").value,
      model: $("modelId").value.trim(),
      baseUrl: $("baseUrl").value.trim() || $("baseUrl").placeholder,
      reasoningCapable: $("reasoningCapable").checked,
      apiKey: $("apiKey").value,
    };
    try {
      const result = await api("/api/provider", data);
      state.provider = result.provider ||
        result.state?.provider || {
          ...data,
          apiKey: undefined,
          configured: true,
        };
      applyState(result);
      closeDialog("modelDialog");
      toast("Model configured. Your Timechain stays the same.");
    } finally {
      $("apiKey").value = "";
      data.apiKey = "";
    }
  });
});
$("modelDialog").addEventListener("close", () => ($("apiKey").value = ""));
$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = $("messageInput").value.trim();
  if (!message) return;
  if (requestBusy && /^\/stop\s*$/i.test(message)) {
    chatController?.abort();
    await api('/api/cancel', {}).catch(() => {});
    return;
  }
  if (requestBusy) return;
  if (!token) {
    requirePair(() => $("messageInput").focus());
    return;
  }
  if (/^\/[a-z][a-z0-9_-]*(?:\s|$)/i.test(message)) {
    try {
      const result = await api('/api/openclaw/command', { command: message });
      if (result.state) applyState(result.state);
      if (result.kind !== 'turn') {
        $("messageInput").value = '';
        addMessage({ role: 'user', content: message });
        addMessage({ role: 'assistant', content: result.text || 'Native command completed.', control: true });
        if (result.action === 'model') openModel();
        if (result.action === 'config') nativePanel.open();
        if (result.action === 'stop') chatController?.abort();
        return;
      }
    } catch (error) { toast(error.message, true); return; }
  }
  if (!state.agent) {
    toast("Begin a new genesis or pair your existing agent first.");
    openDialog("genesisDialog");
    return;
  }
  if (!state.provider?.configured) {
    openModel();
    return;
  }
  try { await ensureHoldings(); } catch (error) {
    toast(error.message, true);
    return;
  }
  requestBusy = true;
  const turnMode = cognition().mode;
  const chatSession = token;
  const chatAgent = agentId();
  chatController = new AbortController();
  $("sendButton").disabled = true;
  $("messageInput").disabled = true;
  addMessage({ role: "user", content: message });
  $("messageInput").value = "";
  activity(
    turnMode === "dormant" ? "Starting plain model chat · no Timechain review or recording."
      : "Starting the Timechain run · waiting for live app activity…",
    "busy",
  );
  try {
    const result = await api(
      "/api/chat",
      { message },
      { signal: chatController.signal },
    );
    if (token !== chatSession || agentId() !== chatAgent) return;
    if (result.state) applyState(result.state);
    const response = result.message || result;
    if (typeof response.content !== "string")
      throw new Error(
        "No accepted response was returned. Inspect the app before trying again.",
      );
    addMessage({ role: "assistant", input: message, mode: turnMode, ...response });
    activity(
      response.control ? "Native OpenClaw control completed."
        : messageIsDormant(response)
        ? "Plain model response · Timechain remains paused and unchanged."
        : response.pending
        ? `Covenant accepted · ${bytes(state.pending?.bytes)} pending toward the next block.`
        : `Accepted and sealed${response.ring?.index !== undefined ? ` in ring ${response.ring.index}` : ""}.`,
    );
  } catch (error) {
    if (token !== chatSession || agentId() !== chatAgent) return;
    addMessage({
      role: "assistant",
      held: true,
      content:
        error.name === "AbortError"
          ? "The model request was cancelled."
          : error.message,
      gate: error.gate,
    });
    activity(
      error.gate
        ? "The proposed response was held by the alignment gate."
        : turnMode === "dormant" ? "The plain model request did not complete. Your Timechain remains paused." : "The request was not completed. No unreviewed answer was released.",
      "error",
    );
  } finally {
    chatController = null;
    requestBusy = false;
    renderHoldingsControls();
    $("messageInput").disabled = false;
    $("messageInput").focus();
    await refreshState();
    await refreshActivity();
  }
});
$("messageInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    $("chatForm").requestSubmit();
  }
});
$("messageInput").addEventListener("input", () => {
  $("messageInput").style.height = "auto";
  $("messageInput").style.height =
    `${Math.min($("messageInput").scrollHeight, 180)}px`;
});
document.querySelectorAll("[data-prompt]").forEach((button) =>
  button.addEventListener("click", () => {
    $("messageInput").value = button.dataset.prompt;
    $("messageInput").focus();
  }),
);
$("recallAbility").addEventListener("click", () =>
  requireAgent(async () => {
    try {
      await saveSettings({ ...settings(), recall: !settings().recall });
      toast(
        `Memory recall ${settings().recall ? "equipped" : "unequipped"} for your next turn.`,
      );
    } catch (error) {
      toast(error.message, true);
    }
  }),
);

function renderRadial() {
  const root = $("radialButtons");
  root.replaceChildren();
  for (let n = 1; n <= 21; n++) {
    const angle = ((n - 1) / 21) * Math.PI * 2 - Math.PI / 2;
    const button = el(
      "button",
      `radial-number${n <= draftPerspectives ? " in-range" : ""}${n === draftPerspectives ? " selected" : ""}`,
      n,
    );
    button.type = "button";
    button.style.left = `${50 + Math.cos(angle) * 39}%`;
    button.style.top = `${50 + Math.sin(angle) * 39}%`;
    button.setAttribute("aria-label", `${n} perspective${n === 1 ? "" : "s"}`);
    button.setAttribute("aria-pressed", String(n === draftPerspectives));
    button.addEventListener("click", () => setPerspectiveCount(n));
    root.append(button);
  }
  $("perspectiveNumber").textContent = draftPerspectives;
  $("perspectiveRange").value = draftPerspectives;
  $("archetypeSelected").textContent =
    `${draftArchetypes.size} / ${archetypes.length || 21}`;
  $("forkCost").textContent =
    `${draftPerspectives} initial perspectives, plus bounded search, synthesis and reviews. Replay and recall selection can change the number of model calls.`;
}
function setPerspectiveCount(n) {
  draftPerspectives = Math.min(21, Math.max(1, Number(n)));
  let chosen = [...draftArchetypes].filter((id) =>
    archetypes.some((a) => String(a.id) === id),
  );
  if (chosen.length > draftPerspectives)
    chosen = chosen.slice(0, draftPerspectives);
  for (const archetype of archetypes) {
    if (chosen.length >= draftPerspectives) break;
    if (!chosen.includes(String(archetype.id)))
      chosen.push(String(archetype.id));
  }
  draftArchetypes = new Set(chosen);
  renderRadial();
  renderArchetypes();
}
function renderArchetypes() {
  const list = $("archetypeList");
  list.replaceChildren();
  for (const archetype of archetypes) {
    const label = el("label", "archetype-option");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = draftArchetypes.has(String(archetype.id));
    input.addEventListener("change", () => {
      if (input.checked) draftArchetypes.add(String(archetype.id));
      else draftArchetypes.delete(String(archetype.id));
      draftPerspectives = Math.max(1, draftArchetypes.size);
      renderRadial();
    });
    const copy = el("span");
    copy.append(
      el("strong", "", archetype.name),
      el("small", "", archetype.description || archetype.function || ""),
    );
    label.append(input, copy);
    list.append(label);
  }
  if (!archetypes.length)
    list.append(
      el(
        "p",
        "fine-print",
        "The archetype catalogue is unavailable. Open ChainChat and try again.",
      ),
    );
}
$("forkAbility").addEventListener("click", async () => {
  try {
    if (!archetypes.length) {
      const result = await api("/api/archetypes");
      archetypes = result.archetypes || [];
    }
  } catch {}
  draftArchetypes = new Set((settings().archetypes || []).map(String));
  draftPerspectives = settings().perspectives || 5;
  $("forkEnabled").checked = settings().fork;
  $("searchIterations").value = cognition().searchIterations;
  $("searchDepth").value = cognition().searchDepth;
  setPerspectiveCount(draftPerspectives);
  openDialog("forkDialog");
});
$("perspectiveRange").addEventListener("input", (event) =>
  setPerspectiveCount(event.target.value),
);
$("saveFork").addEventListener("click", () => {
  if (!token || !state.agent) {
    closeDialog("forkDialog");
    requireAgent(() => $("forkAbility").click());
    return;
  }
  const button = $("saveFork");
  button.disabled = true;
  (async () => {
    try {
      if (draftArchetypes.size < 1)
        throw new Error("Choose at least one archetype.");
      const iterations = Number($("searchIterations").value), depth = Number($("searchDepth").value);
      if (!Number.isInteger(iterations) || iterations < 1 || iterations > 64 || !Number.isInteger(depth) || depth < 1 || depth > 8)
        throw new Error("Choose 1–64 search iterations and a depth of 1–8.");
      await saveSettings({
        ...settings(),
        fork: $("forkEnabled").checked,
        perspectives: draftArchetypes.size,
        archetypes: [...draftArchetypes],
      });
      await saveCognition({ searchIterations: iterations, searchDepth: depth });
      closeDialog("forkDialog");
      toast(
        settings().fork
          ? `${settings().perspectives} perspectives equipped.`
          : "Perspective forking is off. Your selection is saved.",
      );
    } catch (error) {
      $("forkDialog").querySelector(".dialog-error").textContent =
        error.message;
    } finally {
      button.disabled = false;
      renderHoldingsControls();
    }
  })();
});

function openContinuum() {
  const current = settings().continuum;
  $("continuumEnabled").checked = current.enabled;
  document
    .querySelectorAll('[name="blockMode"]')
    .forEach((input) => (input.checked = input.value === current.mode));
  $("blockUnit").value = current.targetBytes >= 1048576 ? "mb" : "kb";
  $("blockSize").value =
    current.targetBytes / ($("blockUnit").value === "mb" ? 1048576 : 1024);
  $("bufferBytes").textContent = bytes(state.pending?.bytes || 0);
  openDialog("continuumDialog");
}
$("continuumAbility").addEventListener("click", openContinuum);
function targetBytes() {
  const amount =
    Number($("blockSize").value) *
    ($("blockUnit").value === "mb" ? 1048576 : 1024);
  if (
    !Number.isFinite(amount) ||
    amount < 1 ||
    !Number.isSafeInteger(Math.round(amount))
  )
    throw new Error("Choose a valid positive block size.");
  return Math.round(amount);
}
$("continuumForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!token || !state.agent) {
    closeDialog("continuumDialog");
    requireAgent(openContinuum);
    return;
  }
  runForm(event.currentTarget, async () => {
    await saveSettings({
      ...settings(),
      continuum: {
        enabled: $("continuumEnabled").checked,
        mode: document.querySelector('[name="blockMode"]:checked').value,
        targetBytes: targetBytes(),
      },
    });
    closeDialog("continuumDialog");
    toast("Continuum block settings applied.");
  });
});
$("flushContinuum").addEventListener("click", () => {
  if (!token || !state.agent) {
    toast("Pair an agent before committing a block.");
    return;
  }
  const button = $("flushContinuum");
  button.disabled = true;
  (async () => {
    try {
      const result = await api("/api/continuum/flush", {});
      applyState(result);
      await refreshState();
      toast(
        result.committed === false
          ? "No pending data to commit."
          : "Pending data committed.",
      );
    } catch (error) {
      $("continuumForm").querySelector(".dialog-error").textContent =
        error.message;
    } finally {
      button.disabled = false;
      renderHoldingsControls();
    }
  })();
});
$("ingestFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    $("ingestText").value = await file.text();
    $("ingestName").value = file.name;
  } catch {
    toast("The selected file could not be read as text.", true);
  }
});
$("ingestForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!token || !state.agent) {
    toast("Pair an agent before ingesting data.");
    return;
  }
  runForm(event.currentTarget, async () => {
    const result = await api("/api/continuum", {
      text: $("ingestText").value,
      name: $("ingestName").value,
      targetBytes: targetBytes(),
    });
    applyState(result);
    await refreshState();
    toast(
      `Source data ingested${result.blocks !== undefined ? ` into ${result.blocks} blocks` : ""}.`,
    );
    $("ingestText").value = "";
    $("ingestFile").value = "";
  });
});
for (const id of ["gateAbility", "covenantLink"])
  $(id).addEventListener("click", () => openDialog("covenantDialog"));
$("covenantValues").replaceChildren(
  ...FRUITS.map((fruit, index) => {
    const item = el("div", "covenant-value");
    item.append(
      el("span", "", String(index + 1).padStart(2, "0")),
      document.createTextNode(fruit),
    );
    return item;
  }),
);
for (const id of ["verifyAbility", "verifyMini"])
  $(id).addEventListener("click", () =>
    requireAgent(async () => {
      activity("Verifying chain hashes and registry commitments…", "busy");
      try {
        const result = await api("/api/verify", {});
        if (result.state) applyState(result.state);
        else {
          state.agent = {
            ...state.agent,
            verified: result.verified,
            head: result.head || state.agent.head,
          };
          renderState();
        }
        activity(
          result.verified
            ? "Chain verification passed."
            : "Chain verification requires attention.",
          result.verified ? "" : "error",
        );
        toast(
          result.verified
            ? "Timechain integrity verified."
            : "Chain verification did not pass.",
          !result.verified,
        );
      } catch (error) {
        activity(error.message, "error");
        toast(error.message, true);
      }
    }),
  );
function renderHistory() {
  const content = $("historyContent");
  content.replaceChildren();
  const agent = state.agent;
  if (!agent) {
    content.append(
      el("p", "fine-print", "Pair an agent to inspect its Timechain."),
    );
    return;
  }
  const stats = el("div", "history-stats");
  for (const [name, value] of [
    ["RINGS", Number(agent.head?.index ?? 0) + 1],
    ["INTEGRITY", agent.verified ? "PASS" : "REVIEW"],
    ["FACULTIES", normalizeFaculties().length],
  ]) {
    const box = el("div", "", name);
    box.append(el("strong", "", value));
    stats.append(box);
  }
  content.append(stats, el("p", "history-root", agent.root || ""));
  const genesis = el("div", "history-row");
  const title = el("header");
  title.append(el("span", "", "RING 0 · GENESIS"));
  genesis.append(
    title,
    el(
      "p",
      "",
      JSON.stringify(agent.genesis?.payload || agent.genesis || {}, null, 2),
    ),
  );
  content.append(genesis);
  for (const item of [...(agent.history || [])].reverse()) {
    const row = el("div", "history-row"),
      header = el("header");
    header.append(
      el(
        "span",
        "",
        `RING ${item.index ?? item.ring?.index ?? (typeof item.ring === "number" ? item.ring : "—")}`,
      ),
      el("span", "", item.ring_type || "conversation"),
    );
    row.append(
      header,
      el(
        "p",
        "",
        (
          item.payload?.output ||
          item.output ||
          item.content ||
          item.payload?.thought ||
          JSON.stringify(item.payload || item)
        ).slice(0, 500),
      ),
      el("code", "", item.ring_hash || item.ring?.hash || item.hash || ""),
    );
    content.append(row);
  }
  if (!agent.history?.length)
    content.append(
      el(
        "p",
        "fine-print",
        "Conversation history will appear after accepted turns.",
      ),
    );
}
$("historyButton").addEventListener("click", () =>
  requireAgent(() => {
    renderHistory();
    openDialog("historyDialog");
  }),
);
function toggleLoadout() {
  $("loadoutSidebar").classList.toggle("mobile-open");
  $("facultySearch").focus();
  $("agentSidebar").classList.remove("mobile-open");
}
for (const id of ["loadoutAbility", "mobileLoadout"])
  $(id).addEventListener("click", toggleLoadout);
$("closeLoadout").addEventListener("click", () => {
  $("loadoutSidebar").classList.remove("mobile-open");
  $("mobileLoadout").focus();
});
$("closeAgents").addEventListener("click", () => {
  $("agentSidebar").classList.remove("mobile-open");
  $("mobileAgents").focus();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
    $("loadoutSidebar").classList.remove("mobile-open");
    $("agentSidebar").classList.remove("mobile-open");
  }
});
$("mobileAgents").addEventListener("click", () => {
  $("agentSidebar").classList.toggle("mobile-open");
  $("loadoutSidebar").classList.remove("mobile-open");
});
for (const id of ["modalitiesTab", "sensesTab"])
  $(id).addEventListener("click", (event) => {
    currentKind = event.currentTarget.dataset.kind;
    document
      .querySelectorAll(".faculty-tabs button")
      .forEach((button) =>
        button.setAttribute(
          "aria-selected",
          String(button.dataset.kind === currentKind),
        ),
      );
    renderFaculties();
  });
$("facultySearch").addEventListener("input", renderFaculties);
$("refreshFaculties").addEventListener("click", () =>
  requireAgent(async () => {
    await refreshState();
    toast("Agent faculty catalogue refreshed.");
  }),
);
document.addEventListener("keydown", (event) => {
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !document.querySelector("dialog[open]") &&
    /^[0-9]$/.test(event.key)
  ) {
    event.preventDefault();
    document.querySelector(`[data-shortcut="${event.key}"]`)?.click();
  }
});
document
  .querySelectorAll(".skill-slot")
  .forEach(
    (button) =>
      (button.title = `${button.querySelector(".slot-title").textContent} · Alt + ${button.dataset.shortcut}`),
  );

for (const id of ["quickCognition", "cognitionAbility", "routeAbility", "learningAbility", "dreamAbility"])
  $(id).addEventListener("click", () => requireAgent(openCognition));

$("cognitionForm").addEventListener("submit", event => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    await saveCognition({
      learning: $("learningEnabled").checked,
      autoRoute: $("autoRoute").checked,
      semanticRecall: $("semanticRecall").checked,
      autoSprout: $("autoSprout").checked,
      autoDream: $("autoDream").checked,
      revisionLimit: Number($("revisionLimit").value),
    });
    toast("Cognition settings saved for this agent.");
  });
});

$("toggleChainMode").addEventListener("click", async () => {
  if (cognition().mode !== "dormant") {
    closeDialog("cognitionDialog"); openDialog("pauseChainDialog"); return;
  }
  cognitionBusy = true; renderCognition();
  try {
    await saveCognition({ mode: "active", confirm: true });
    toast("Timechain resumed. New accepted turns can be recorded again.");
  } catch (error) { $("cognitionDialog").querySelector(".dialog-error").textContent = error.message; }
  finally { cognitionBusy = false; renderCognition(); }
});

$("confirmPauseChain").addEventListener("click", async () => {
  if (cognitionBusy) return;
  cognitionBusy = true; $("confirmPauseChain").disabled = true;
  try {
    await saveCognition({ mode: "dormant", confirm: true });
    chatController?.abort();
    closeDialog("pauseChainDialog");
    activity("Timechain paused. Plain model chat does not change its history.");
    toast("Timechain paused. Resume from Cognition controls at any time.");
  } catch (error) { $("pauseChainDialog").querySelector(".dialog-error").textContent = error.message; }
  finally { cognitionBusy = false; $("confirmPauseChain").disabled = false; renderCognition(); await refreshActivity(); }
});

$("cancelTurn").addEventListener("click", async () => {
  if (!token || stoppingBusy) return;
  stoppingBusy = true; renderRuntimeActivity();
  try {
    await api("/api/cancel", {});
    chatController?.abort();
    activity("Cancellation requested. An atomic commit already underway may finish.");
  } catch (error) { toast(error.message, true); }
  finally { stoppingBusy = false; await refreshActivity(); renderRuntimeActivity(); }
});

for (const button of document.querySelectorAll("[data-maintenance]")) {
  button.addEventListener("click", async () => {
    if (requestBusy || cognitionBusy) { toast("Finish or stop the current operation first."); return; }
    cognitionBusy = true; renderHoldingsControls();
    $("cognitionDialog").querySelector(".dialog-error").textContent = "";
    try {
      const result = await api("/api/maintenance", { action: button.dataset.maintenance, confirm: true });
      applyState(result); await refreshState(); await refreshCognition();
      toast("Native maintenance completed. Inspect its recorded activity below.");
    } catch (error) { $("cognitionDialog").querySelector(".dialog-error").textContent = error.message; }
    finally { cognitionBusy = false; renderHoldingsControls(); await refreshActivity(); }
  });
}

function renderLifecycle() {
  const list = $("lifecycleList"); list.replaceChildren();
  const readOnly = cognition().mode === "dormant" || !cognition().learning;
  $("lifecycleControlNotice").textContent = cognition().mode === "dormant"
    ? "Resume your Timechain before changing learned faculties."
    : !cognition().learning ? "Learning is off. Enable it in Cognition controls before promoting, hibernating or waking learned faculties. You can still change your equipment." : "";
  const filter = $("lifecycleFilter").value;
  const freshIds = newFacultyIds.get(agentId()) || new Set();
  const items = normalizeFaculties().filter(faculty => {
    if (faculty.source === "base") return false;
    if (filter === "new") return freshIds.has(facultyIdentity(faculty));
    if (filter === "emergent") return faculty.equippable === false;
    if (filter === "dormant") return !!faculty.dormant;
    if (filter === "active") return faculty.equippable !== false && !faculty.dormant;
    return true;
  });
  if (!items.length) list.append(el("p", "faculty-empty", "No learned faculties match this view. New proposals will appear here as your agent grows."));
  for (const faculty of items) {
    const card = el("article", "lifecycle-card");
    const header = el("header");
    const status = faculty.equippable === false ? "EMERGING" : faculty.dormant ? "HIBERNATING" : "AVAILABLE";
    header.append(el("strong", "", faculty.name), el("span", "lifecycle-badge", `${freshIds.has(facultyIdentity(faculty)) ? "NEW · " : ""}${status}`));
    card.append(header, el("p", "", faculty.function || faculty.description || "No description supplied."));
    card.append(el("p", "faculty-meta", `${faculty.kind.toUpperCase()} · ${faculty.category || "learned"}${Number.isFinite(faculty.uses) ? ` · ${faculty.uses} uses` : ""}`));
    const action = facultyLifecycleAction(faculty);
    if (action) {
      const button = el("button", "text-button", action === "promote" ? "Review promotion ↗" : action === "wake" ? "Wake faculty ↗" : "Prune to hibernation ↗");
      button.type = "button"; button.disabled = requestBusy || cognitionBusy || !hasHoldingsAccess() || readOnly;
      button.addEventListener("click", () => previewLifecycle(faculty, action));
      card.append(button);
    }
    if (faculty.requiresLocalCodeReview) card.append(el("p", "fine-print", "This proposal contains authored code. Review it locally before activation; ChainChat will not execute it."));
    if (faculty.equippable !== false && !faculty.dormant) {
      const equip = el("button", "text-button", isEquipped(faculty) ? "Unequip" : "Equip");
      equip.type = "button"; equip.disabled = requestBusy || cognitionBusy || !hasHoldingsAccess();
      equip.addEventListener("click", async () => { await toggleFaculty(faculty); renderLifecycle(); });
      card.append(equip);
    }
    list.append(card);
  }
}

async function openLifecycle(filter = "all") {
  $("lifecycleFilter").value = filter;
  lifecycleSelection = null; $("lifecyclePreview").classList.add("hidden");
  openDialog("facultyLifecycleDialog");
  try { await refreshCognition(); renderLifecycle(); }
  catch (error) { $("facultyLifecycleDialog").querySelector(".dialog-error").textContent = error.message; }
}

async function previewLifecycle(faculty, action) {
  if (requestBusy || cognitionBusy) return;
  cognitionBusy = true; renderLifecycle();
  lifecycleSelection = null;
  $("lifecyclePreview").classList.add("hidden");
  const id = agentId(), sessionToken = token;
  try {
    const request = { action, key: faculty.key || facultyId(faculty), preview: true };
    const result = await api("/api/faculties/lifecycle", request);
    if (id !== agentId() || sessionToken !== token) return;
    const preview = typeof result.preview === "object" ? result.preview : result;
    lifecycleSelection = { ...request, agentId: id, name: faculty.name, allowed: preview.allowed !== false && result.allowed !== false, previewToken: result.previewToken || preview.previewToken, expectedHead: result.expectedHead || preview.expectedHead };
    $("lifecyclePreviewTitle").textContent = `${action === "promote" ? "Promote" : action === "wake" ? "Wake" : "Hibernate"} ${faculty.name}`;
    $("lifecyclePreviewDescription").textContent = preview.plan?.description || preview.description || preview.message || preview.reason || (action === "hibernate" ? "This faculty will leave the active working set. Its full definition and historical records are preserved, and you can wake it later." : action === "promote" ? "The native engine will evaluate this emerging faculty for promotion. Promotion does not equip it automatically." : "This faculty will become available again. Choose Equip separately when you want to use it.");
    $("confirmLifecycle").disabled = preview.allowed === false || result.allowed === false;
    $("lifecyclePreview").classList.remove("hidden");
  } catch (error) { $("facultyLifecycleDialog").querySelector(".dialog-error").textContent = error.message; }
  finally { cognitionBusy = false; renderLifecycle(); }
}

$("confirmLifecycle").addEventListener("click", async () => {
  const selection = lifecycleSelection;
  if (!selection || !selection.allowed || selection.agentId !== agentId() || cognitionBusy) return;
  cognitionBusy = true; $("confirmLifecycle").disabled = true;
  try {
    const request = { action: selection.action, key: selection.key, preview: false, confirm: true };
    if (selection.previewToken) request.previewToken = selection.previewToken;
    if (selection.expectedHead) request.expectedHead = selection.expectedHead;
    const result = await api("/api/faculties/lifecycle", request);
    applyState(result);
    lifecycleSelection = null; $("lifecyclePreview").classList.add("hidden");
    await refreshState(); await refreshCognition();
    toast(`${selection.name}: ${selection.action === "hibernate" ? "hibernated; history preserved" : selection.action === "wake" ? "available to equip" : "promotion reviewed"}.`);
  } catch (error) { $("facultyLifecycleDialog").querySelector(".dialog-error").textContent = error.message; }
  finally { cognitionBusy = false; renderLifecycle(); await refreshActivity(); }
});
$("cancelLifecycle").addEventListener("click", () => { lifecycleSelection = null; $("lifecyclePreview").classList.add("hidden"); });
$("manageFaculties").addEventListener("click", () => requireAgent(() => openLifecycle()));
$("newFacultiesNotice").addEventListener("click", () => requireAgent(() => openLifecycle("new")));
$("refreshLifecycle").addEventListener("click", async () => { try { await refreshCognition(); } catch (error) { toast(error.message, true); } });
$("lifecycleFilter").addEventListener("change", renderLifecycle);

function invalidatePackPreview() {
  previewGeneration += 1;
  packPreviewState = null;
  $("packPreview").replaceChildren();
  $("packPreview").classList.add("hidden");
  $("importPackButton").disabled = true;
  $("importPackButton").classList.add("hidden");
  $("importPackError").textContent = "";
  $("importPackResult").classList.add("hidden");
}
function packReportList(target, title, items, fallback) {
  if (!items?.length) return;
  target.append(el("h3", "", `${title} · ${items.length}`));
  const list = el("ul", "pack-report-list");
  for (const item of items) {
    const row = el("li");
    if (typeof item === "string") row.textContent = item;
    else {
      row.append(el("strong", "", item.name || fallback));
      row.append(el("span", "", item.reason || item.kind || fallback));
    }
    list.append(row);
  }
  target.append(list);
}
function renderPackPreview(result) {
  const panel = $("packPreview"),
    pack = result.pack,
    report = result.report || {};
  panel.replaceChildren();
  panel.classList.remove("hidden");
  panel.append(
    el("div", "section-caption", "VERIFIED PACK CHECKSUM"),
    el("h3", "pack-name", pack.name),
  );
  panel.append(
    el(
      "p",
      "pack-metadata",
      `${pack.version} · ${pack.faculties?.length || 0} faculties · ${pack.domain || "General"}`,
    ),
  );
  const summary = el("div", "pack-summary");
  for (const [label, count] of [
    ["NEW", report.imported?.length || 0],
    ["COVERED", report.skipped_covered?.length || 0],
    ["BLOCKED", report.blocked?.length || 0],
  ]) {
    const box = el("div");
    box.append(el("strong", "", count), el("span", "", label));
    summary.append(box);
  }
  panel.append(summary, el("code", "pack-checksum", pack.pack_sha256 || ""));
  const donor = pack.donor?.genesis_name || pack.author || "Unknown";
  panel.append(
    el(
      "p",
      "fine-print",
      `Declared donor: ${donor}. Identity is not independently verified; the checksum verifies the pack body.`,
    ),
  );
  const definitions = el("details", "perspective-details");
  definitions.append(el("summary", "", "Review faculty definitions"));
  for (const faculty of pack.faculties || []) {
    const row = el("div", "perspective-note");
    row.append(
      el("strong", "", `${faculty.name} · ${faculty.kind}`),
      el("p", "", faculty.function || ""),
    );
    definitions.append(row);
  }
  panel.append(definitions);
  const portability = portabilityView(report.portability);
  if (portability) {
    const details = el("details", "perspective-details portability-details");
    details.open = true;
    details.append(el("summary", "", `Mechanism compatibility${portability.formatVersion ? " · format " + portability.formatVersion : ""}`));
    if (portability.requiresCompanion) details.append(el("p", "fine-print", "Portable mechanisms require a compatible ChainChat companion runtime. Check each faculty’s compatibility before importing into another skill installation."));
    if (portability.quarantinedCodeCount) details.append(el("p", "quarantine-note", `${portability.quarantinedCodeCount} authored code item${portability.quarantinedCodeCount === 1 ? " is" : "s are"} preserved in quarantine. Importing does not authorize code execution.`));
    for (const item of portability.items) {
      const row = el("div", "perspective-note portability-item");
      row.dataset.compatibility = item.compatibility;
      row.append(el("strong", "", `${item.name} · ${item.label}`), el("p", "", `Mechanism: ${item.mechanism}`));
      if (item.preservedFields.length) row.append(el("p", "fine-print", `Preserved fields: ${item.preservedFields.join(", ")}`));
      if (item.reason) row.append(el("p", "fine-print", item.reason));
      details.append(row);
    }
    panel.append(details);
  } else panel.append(el("p", "fine-print", "This app did not provide a mechanism compatibility report. A verified checksum alone does not establish that a faculty can execute."));
  packReportList(
    panel,
    "Ready for covenant review",
    report.imported,
    "Faculty",
  );
  packReportList(
    panel,
    "Already covered — will be skipped",
    report.skipped_covered,
    "Covered",
  );
  packReportList(
    panel,
    "Blocked — will not be imported",
    report.blocked,
    "Blocked",
  );
  packReportList(panel, "Errors", report.errors, "Invalid pack");
  const ready = (report.imported?.length || 0) > 0 && !report.errors?.length;
  $("importPackButton").classList.remove("hidden");
  $("importPackButton").disabled = !ready || !hasHoldingsAccess();
  if (!ready)
    panel.append(
      el(
        "p",
        "fine-print",
        "There are no new importable faculties in this preview.",
      ),
    );
}
function exportableFaculties() {
  return normalizeFaculties().filter(facultyIsExportable);
}
function renderExportFaculties() {
  const list = $("exportFacultyList"),
    faculties = exportableFaculties();
  const available = new Set(faculties.map(facultyId));
  for (const key of exportSelection)
    if (!available.has(key)) exportSelection.delete(key);
  list.replaceChildren();
  if (!faculties.length)
    list.append(
      el(
        "p",
        "faculty-empty",
        "No learned faculties to share yet. Your agent’s promoted and imported faculties will appear here as its catalogue grows.",
      ),
    );
  for (const faculty of faculties) {
    const label = el("label", "archetype-option"),
      input = el("input");
    input.type = "checkbox";
    input.checked = exportSelection.has(facultyId(faculty));
    input.addEventListener("change", () => {
      if (input.checked) exportSelection.add(facultyId(faculty));
      else exportSelection.delete(facultyId(faculty));
      $("exportPackButton").disabled = !exportSelection.size;
    });
    const copy = el("span");
    copy.append(
      el("strong", "", faculty.name),
      el(
        "small",
        "",
        `${faculty.kind.toUpperCase()} · ${faculty.source.toUpperCase()}${faculty.dormant ? " · DORMANT" : ""}${faculty.requiresLocalCodeReview ? " · CODE QUARANTINED" : ""}`,
      ),
      el("small", "", faculty.function),
    );
    label.append(input, copy);
    list.append(label);
  }
  $("exportPackButton").disabled = !exportSelection.size;
}
function selectExchangeTab(kind) {
  const importing = kind === "import";
  $("importPackTab").setAttribute("aria-selected", String(importing));
  $("exportPackTab").setAttribute("aria-selected", String(!importing));
  $("importPackPanel").classList.toggle("hidden", !importing);
  $("exportPackPanel").classList.toggle("hidden", importing);
  if (!importing) renderExportFaculties();
}
$("exchangeButton").addEventListener("click", () =>
  requireAgent(() => {
    $("exportPackName").value =
      `${state.agent.name || "Cypher Tempre"} faculties`;
    renderExportFaculties();
    openDialog("exchangeDialog");
  }),
);
$("importPackTab").addEventListener("click", () => selectExchangeTab("import"));
$("exportPackTab").addEventListener("click", () => selectExchangeTab("export"));
$("packJson").addEventListener("input", invalidatePackPreview);
$("packFile").addEventListener("change", async (event) => {
  invalidatePackPreview();
  $("packJson").value = "";
  const generation = previewGeneration,
    file = event.target.files[0];
  if (!file) return;
  if (file.size > 4 * 1024 * 1024) {
    toast(
      "This pack exceeds 4 MiB. Share a smaller set of faculty definitions.",
      true,
    );
    return;
  }
  try {
    const content = await file.text();
    if (generation === previewGeneration) $("packJson").value = content;
  } catch {
    toast("The pack file could not be read.", true);
  }
});
$("previewPackForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    invalidatePackPreview();
    let pack;
    try {
      pack = JSON.parse($("packJson").value);
    } catch {
      throw new Error(
        "The pack is not valid JSON. Choose a faculty pack or correct the JSON.",
      );
    }
    if (!pack || typeof pack !== "object" || Array.isArray(pack))
      throw new Error("A faculty pack must be a JSON object.");
    const generation = previewGeneration,
      previewAgent = agentId();
    const result = await api("/api/faculties/preview", { pack });
    if (generation !== previewGeneration || previewAgent !== agentId()) return;
    packPreviewState = {
      pack,
      expectedHead: result.head.hash,
      agentId: previewAgent,
      result,
    };
    renderPackPreview(result);
  });
});
$("importPackButton").addEventListener("click", async () => {
  if (!packPreviewState || packPreviewState.agentId !== agentId()) {
    invalidatePackPreview();
    toast("Preview the pack for the current agent first.");
    return;
  }
  if (!state.provider?.configured) {
    toast(
      "Connect your model for the covenant review, then return to import this pack.",
    );
    openModel();
    return;
  }
  const button = $("importPackButton"),
    preview = packPreviewState;
  button.disabled = true;
  $("importPackError").textContent = "";
  try {
    const result = await api("/api/faculties/import", {
      pack: preview.pack,
      expectedHead: preview.expectedHead,
    });
    if (result.state) applyState(result.state);
    else await refreshState();
    const count = result.imported?.length || 0,
      report = result.report || {};
    invalidatePackPreview();
    $("importPackResult").textContent =
      `${count} ${count === 1 ? "faculty" : "faculties"} imported into this agent’s inventory. ${report.skipped_covered?.length || 0} already covered; ${report.blocked?.length || 0} blocked.${result.ring ? ` Recorded in ring ${result.ring.index}.` : ""} Select any imported faculty in your loadout to equip it.`;
    $("importPackResult").classList.remove("hidden");
    toast(`${count} ${count === 1 ? "faculty" : "faculties"} imported.`);
  } catch (error) {
    $("importPackError").textContent = error.message;
    if (["STALE_HEAD", "PREVIEW_STALE"].includes(error.code)) {
      packPreviewState = null;
      button.disabled = true;
    } else button.disabled = !hasHoldingsAccess();
  }
});
$("selectAllExport").addEventListener("click", () => {
  const entries = exportableFaculties();
  if (entries.length && entries.every((f) => exportSelection.has(facultyId(f))))
    exportSelection.clear();
  else entries.forEach((f) => exportSelection.add(facultyId(f)));
  renderExportFaculties();
});
$("exportPackForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    if (!exportSelection.size)
      throw new Error("Choose at least one learned faculty to share.");
    const result = await api("/api/faculties/export", {
      name: $("exportPackName").value.trim(),
      keys: [...exportSelection],
      version: $("exportPackVersion").value.trim(),
      domain: $("exportPackDomain").value.trim(),
    });
    if (!result.pack || !result.count)
      throw new Error("The app did not return a non-empty faculty pack.");
    const blob = new Blob([JSON.stringify(result.pack, null, 2) + "\n"], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob),
      link = el("a");
    link.href = url;
    link.download = String(
      result.filename || "cypher-tempre-faculties.json",
    ).replace(/[^A-Za-z0-9._-]/g, "-");
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(
      `Downloaded a pack with ${result.count} ${result.count === 1 ? "faculty" : "faculties"}.`,
    );
  });
});
let licenseDeployment = null,
  currentLicense = null,
  walletBusy = false,
  licensePolling = false,
  walletWatch = null,
  walletController = null,
  walletRevoked = false,
  licenseRevision = 0;

function hasHoldingsAccess() {
  if (!token || !currentLicense?.identityVerified ||
      !matchingConfiguration(licenseDeployment, currentLicense.configuration)) return false;
  if (!licenseDeployment.required && currentLicense.status === "local-test-mode") return true;
  if (walletRevoked) return false;
  return currentLicense.status === "active" &&
    currentLicense.session?.expiresAt > Date.now() &&
    currentLicense.verification?.expiresAt > Date.now();
}
function licenseMessage(info) {
  if (!token) return "Launch the installed ChainChat app, then verify at least 21,000 CPHY held on Base.";
  if (info?.status === "local-test-mode") return "Local test configuration: holdings enforcement is disabled.";
  if (info?.status === "verification-unavailable")
    return "Holdings could not be verified. New operations are paused; your saved history remains available.";
  if (info?.status === "session-expired" || (info?.session && info.session.expiresAt <= Date.now()))
    return "Your wallet sign-in has expired. Verify holdings again to continue.";
  if (info?.status === "insufficient-balance")
    return "This wallet holds less than 21,000 CPHY. New operations are paused; your saved history remains available.";
  if (info?.status === "active" && hasHoldingsAccess())
    return "Holdings verified. Keep at least 21,000 CPHY in this wallet while using ChainChat.";
  if (info?.status === "active") return "Your balance verification needs a refresh. Recheck before continuing.";
  return "Connect your wallet on Base and sign in to verify at least 21,000 CPHY. Your tokens stay yours.";
}
function renderHoldingsControls() {
  const active = hasHoldingsAccess(), blocked = !!token && !active;
  const held = !!(state.agent?.locked || state.agent?.maintenancePending);
  const testMode = active && licenseDeployment?.required === false && currentLicense?.status === "local-test-mode";
  $("modelHoldingsNotice").classList.toggle("hidden", !blocked);
  $("sendButton").disabled = requestBusy || blocked || (held && cognition().mode !== "dormant");
  $("newAgentButton").disabled = blocked;
  for (const selector of ['#genesisForm button[type="submit"]', '#modelForm button[type="submit"]',
    '#continuumForm button[type="submit"]', '#ingestForm button[type="submit"]', '#saveFork', '#flushContinuum']) {
    const control = document.querySelector(selector);
    if (control) control.disabled = blocked || requestBusy;
  }
  $("recallAbility").disabled = blocked;
  document.querySelectorAll(".faculty-card").forEach((card) => {
    if (card.tagName === "BUTTON") card.disabled = blocked;
  });
  if (blocked) $("importPackButton").disabled = true;
  $("holdingsPrompt").classList.toggle("verified", active);
  $("holdingsPromptLabel").textContent = active
    ? testMode ? "LOCAL TEST MODE · CPHY holdings are not checked" : "CPHY holdings verified · your tokens remain in your wallet"
    : token ? "Verify at least 21,000 CPHY to enable new operations" : "Hold 21,000 CPHY on Base to use ChainChat";
  $("holdingsPromptAction").textContent = active ? "View access ↗" : "Verify holdings ↗";
  $("sendButton").title = blocked ? "Verify your CPHY holdings to send a message" : held && cognition().mode !== "dormant" ? "Review the native recovery hold before continuing" : "Send message";
  const dormant = cognition().mode === "dormant";
  $("cognitionForm").querySelectorAll("input,button").forEach(control => {
    control.disabled = blocked || requestBusy || cognitionBusy;
  });
  document.querySelectorAll("[data-maintenance]").forEach(control => {
    control.disabled = blocked || held || requestBusy || cognitionBusy || dormant || !cognition().learning;
  });
  $("toggleChainMode").disabled = !token || !state.agent || cognitionBusy || (dormant && blocked);
  $("confirmLifecycle").disabled = blocked || held || requestBusy || cognitionBusy || dormant || !cognition().learning || !lifecycleSelection?.allowed;
}
function renderLicense(info) {
  currentLicense = info;
  $("licenseDeviceKey").value = info?.deviceKey || "";
  $("licenseOwner").value = info?.identityVerified ? info.selectedOwner || "" : "";
  const status = licenseMessage(info);
  $("licenseStatus").textContent = status;
  $("licenseSummary").textContent = status;
  $("holdingsBalance").textContent = info?.identityVerified
    ? formatTokenBalance(info.verification?.balance) : "—";
  $("holdingsChecked").textContent = info?.identityVerified && info.verification?.checkedAt
    ? new Date(info.verification.checkedAt).toLocaleTimeString() : "Not verified";
  $("holdingsExpiry").textContent = info?.identityVerified && info.session?.expiresAt
    ? `Sign-in expires ${new Date(info.session.expiresAt).toLocaleTimeString()}` : "Sign in to begin a session";
  const matched = !!(info?.identityVerified && matchingConfiguration(licenseDeployment, info.configuration));
  $("verifyHoldingsButton").disabled = !token || !matched || walletBusy || !licenseDeployment?.required;
  $("checkLicenseButton").disabled = !token || !info?.session || walletBusy;
  $("logoutHoldingsButton").disabled = !token || !info?.session || walletBusy;
  if (info?.identityVerified && !matched)
    $("licenseError").textContent = "This website and local app use different holdings settings. Install the matching ChainChat app release.";
  renderHoldingsControls();
}
async function readLicense() {
  const challenge = freshChallenge(), sessionToken = token, revision = licenseRevision;
  const info = await api("/api/license/check", { challenge });
  await verifyBridgeIdentity(info, challenge, location.origin);
  if (!sessionToken || token !== sessionToken || revision !== licenseRevision)
    throw new Error("The app or wallet session changed during verification. Verify again.");
  if (!matchingConfiguration(licenseDeployment, info.configuration))
    throw new Error("The website and local app have different holdings settings. Install the matching ChainChat release.");
  if (walletRevoked && info.session)
    throw new Error("This wallet sign-in was revoked. Sign out and verify holdings again.");
  if (info.session && walletWatch) await walletWatch.check(info.selectedOwner);
  if (token !== sessionToken || revision !== licenseRevision)
    throw new Error("The wallet session changed during verification. Verify again.");
  return { ...info, identityVerified: true };
}
async function refreshLicense() {
  if (!token || licensePolling || walletBusy) return;
  licensePolling = true;
  const revision = licenseRevision, sessionToken = token;
  try {
    const info = await readLicense();
    if (revision === licenseRevision && sessionToken === token) renderLicense(info);
  } catch (error) {
    if (revision === licenseRevision && sessionToken === token) {
      renderLicense(currentLicense ? { ...currentLicense, identityVerified: false, status: "verification-unavailable" } : null);
      $("licenseError").textContent = error.message;
    }
  } finally { licensePolling = false; }
}
async function ensureHoldings() {
  if (hasHoldingsAccess() && walletWatch) await walletWatch.check(currentLicense.selectedOwner);
  if (hasHoldingsAccess()) return;
  await refreshLicense();
  if (hasHoldingsAccess()) return;
  openDialog("licenseDialog");
  throw new Error("Verify a wallet holding at least 21,000 CPHY before starting a new operation. Your saved history remains available.");
}
async function showLicense() {
  openDialog("licenseDialog");
  await refreshLicense();
}
async function invalidateWalletSession(message = "Wallet account or network changed. Verify holdings again.") {
  licenseRevision++;
  walletRevoked = true;
  walletController?.abort();
  walletWatch?.close();
  walletWatch = null;
  chatController?.abort();
  renderLicense(null);
  $("licenseStatus").textContent = message;
  $("licenseSummary").textContent = message;
  const sessionToken = token;
  if (sessionToken) {
    try {
      await api("/api/license/logout", {});
      if (token === sessionToken) await refreshLicense();
    } catch {
      $("licenseError").textContent = "Could not confirm wallet sign-out with the app. End the app session or stop the local app before reconnecting.";
    }
  }
}
for (const id of ["licenseButton", "holdingsPrompt"])
  $(id).addEventListener("click", () => requirePair(showLicense));
$("modelVerifyHoldings").addEventListener("click", () => {
  closeDialog("modelDialog");
  requirePair(showLicense);
});
$("loadAuditor").addEventListener("click", () => {
  requireAgent(() => {
    $("auditFrame").src = "./audit/?chainchat=1";
    $("auditFrame").classList.remove("hidden");
    $("loadAuditor").classList.add("hidden");
    auditedAgent = agentId();
  });
});
$("checkLicenseButton").addEventListener("click", refreshLicense);
$("logoutHoldingsButton").addEventListener("click", () => invalidateWalletSession("Wallet signed out. Your saved Timechain remains available."));
$("verifyHoldingsButton").addEventListener("click", async () => {
  if (walletBusy || !token) return;
  walletBusy = true;
  walletController = new AbortController();
  const sessionToken = token, revision = ++licenseRevision;
  walletRevoked = true;
  walletWatch?.close();
  walletWatch = null;
  renderLicense(currentLicense);
  $("licenseError").textContent = "";
  try {
    await api("/api/license/logout", {});
    if (token !== sessionToken || revision !== licenseRevision)
      throw new Error("The app changed before wallet sign-in. Verify again.");
    const info = await verifyHoldingsWithWallet({
      wallet: window.ethereum,
      config: licenseDeployment,
      origin: location.origin,
      deviceKey: currentLicense?.deviceKey,
      api: (path, data) => {
        if (token !== sessionToken) throw new Error("The app session changed during wallet verification.");
        return api(path, data);
      },
      signal: walletController.signal,
      report: (text) => { $("licenseStatus").textContent = text; },
      onInvalidated: () => { void invalidateWalletSession(); },
    });
    if (token !== sessionToken || revision !== licenseRevision)
      throw new Error("The app or wallet changed during sign-in. Verify again.");
    walletWatch = watchWallet(window.ethereum, () => { void invalidateWalletSession(); });
    await walletWatch.check(info.selectedOwner);
    if (token !== sessionToken || revision !== licenseRevision)
      throw new Error("The app or wallet changed during sign-in. Verify again.");
    walletRevoked = false;
    renderLicense(info);
    if (info.status === "active") toast("CPHY holdings verified. Your tokens remain in your wallet.");
  } catch (error) {
    if (sessionToken === token) {
      walletRevoked = true;
      walletWatch?.close();
      walletWatch = null;
      await api("/api/license/logout", {}).catch(() => {});
      currentLicense = currentLicense ? { ...currentLicense, identityVerified: false } : null;
      $("licenseError").textContent = error.message || "Wallet verification could not complete.";
    }
  } finally {
    walletBusy = false;
    walletController = null;
    renderLicense(currentLicense);
    await refreshLicense();
  }
});
async function start() {
  const bootstrap = localBridgePage ? new URLSearchParams(location.hash.slice(1)).get("launch") : null;
  if (bootstrap !== null) history.replaceState(null, "", location.pathname + location.search);
  initThemes();
  initMotifs();
  renderState();
  setInterval(() => { void refreshActivity(); }, 1000);
  setInterval(() => { renderRuntimeActivity(); }, 2000);
  $("hostedBridgeSetup").classList.toggle("hidden", localBridgePage);
  $("bridgePort").disabled = localBridgePage || ["cyphertempre.ai","www.cyphertempre.ai"].includes(location.hostname);
  $("bridgePort").value = selectedBridgePort;
  $("hostedOrigin").textContent = location.origin;
  try {
    const response = await fetch("./license-config.json", {
      cache: "no-store", credentials: "omit", redirect: "error",
    });
    if (!response.ok) throw new Error("Holdings configuration unavailable.");
    licenseDeployment = validateHoldingsConfig(await response.json());
    renderLicense(null);
  } catch {
    $("licenseSummary").textContent = "Holdings configuration unavailable. Update ChainChat before connecting your wallet.";
  }
  setInterval(() => {
    if (token && currentLicense?.session && !walletBusy) void refreshLicense();
    renderHoldingsControls();
  }, 20000);
  try {
    const response = await fetch("/catalogue.json", { cache: "no-store" });
    const data = await response.json();
    catalogue = data.faculties || [];
    archetypes = data.archetypes || [];
    renderFaculties();
  } catch {
    console.warn("Base catalogue preview is unavailable.");
  }
  if (!localBridgePage) {
    $("bridgeStatus").textContent = "INSTALL & LAUNCH CHAINCHAT";
    activity("Install ChainChat. The app opens its local chat with OpenClaw and PoI already included.");
    setInterval(refreshState, 10000);
    return;
  }
  try {
    const status = await api("/api/status");
    $("bridgeStatus").textContent = supportedBridgeVersion(status.version)
      ? "LOCAL APP READY"
      : "APP UPDATE REQUIRED";
    if (status.version) $("appVersion").textContent = `v${status.version}`;
    if (status.runtime?.backend === "openclaw") $("bridgeStatus").textContent = "OPENCLAW RUNTIME READY";
    if (!supportedBridgeVersion(status.version)) throw new Error("Install the latest ChainChat app to connect automatically.");
    const paired = await connectLocalSession({ origin: location.origin, nonce: bootstrap,
      storage: localTabStorage(), request: api });
    token = paired.token;
    applyState(await api("/api/state"));
    await refreshLicense();
    toast("Connected to your local OpenClaw app. PoI is ready for active Timechain chats.");
    if (currentLicense?.identityVerified) {
      try {
        walletWatch?.close();
        walletWatch = watchWallet(window.ethereum, () => { void invalidateWalletSession(); });
        await walletWatch.check(currentLicense.selectedOwner);
      } catch {
        await invalidateWalletSession("Verify your wallet again to continue this resumed session.");
      }
    }
    if (!paired.resumable) activity("Connected. To reopen this chat, use the ChainChat application launcher; tab storage is unavailable.");
  } catch (error) {
    console.warn("Local app connection unavailable.", error.code || error.name || "CONNECTION_FAILED");
    activity("Open ChainChat using its application launcher. Its authenticated local chat opens automatically.");
    $("bridgeStatus").textContent = "OPEN INSTALLED CHAINCHAT";
  }
  try {
    const result = await api("/api/archetypes");
    if (result.archetypes?.length) archetypes = result.archetypes;
  } catch {}
  setInterval(refreshState, 10000);
}
const nativePanel = initOpenClawSettings({ api, requireConnection: requirePair, onClose: renderState,
  executeCommand: async command => {
    const result = await api('/api/openclaw/command', { command });
    if (result.state) applyState(result.state);
    if (result.kind === 'turn') {
      nativePanel.close();
      $("messageInput").value = command;
      $("chatForm").requestSubmit();
    } else if (result.action === 'model') openModel();
    else if (result.action === 'config') nativePanel.open();
    else if (result.action === 'stop') chatController?.abort();
    return result;
  },
});
start();
