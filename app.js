import { initMotifs } from "./motifs.js";
import { initThemes } from "./themes.js";
import { initFontModes } from "./font-modes.js";
import { mountNativeModelPicker } from "./model-catalogue.js";
import { mountNativeAuth } from "./native-auth.js";
import { mountNativeMediaComposer, nativeChatPayload, nativeHistoryMedia, nativeMessageMedia, renderNativeMedia } from "./native-media.js";
import { mergeHistoryMessages } from "./native-history.js";
import { blockHeight, supportedBridgeVersion, modelCatalogueView, modelSwitchPayload, providerConnectionView, covenantThresholdLabel, gateRequirementsNote } from "./chainchat-display.js";
import {
  DEFAULT_COGNITION, normalizeCognition, normalizeActivity,
  abilityIndicators, facultyIdentity, facultyLifecycleAction, messageIsDormant, nativeSearchView,
  activityLineState, pollWithDeadline, routeControlState, reviewReceipt, facultyExecutionView, portabilityView,
  operatorCompatibilityView, facultyIsExportable, cognitionModeView, messageIsReviewedPause,
} from "./cognition-display.js";
import {
  bridgeApiUrl,
  bridgePort,
  isLocalBridgePage,
} from "./bridge-connection.js";
import { connectLocalSession, clearLocalResume, localTabStorage } from "./local-session.js";
import { createAuditParent } from "./audit-parent.js";
import { initOpenClawSettings } from "./openclaw-settings.js";
import { chatFailure, providerLimits, loadoutRepairNotice } from "./chat-errors.js";
import { mountSetupWizard } from "./setup-wizard.js";
import { createRuntimeHealthDisplay } from "./runtime-health.js";
import { composerCommand, mountChatCommands } from "./chat-commands.js";
import { mountAgentSkills } from "./agent-skills.js";
import { mountEmergencyHalt } from "./emergency-halt.js";
import { mountTimechainBackups } from "./timechain-backup.js";
import { mountTimechainMaintenance } from "./timechain-maintenance.js";
const $ = (id) => document.getElementById(id);
const localBridgePage = isLocalBridgePage(location.origin);
let selectedBridgePort = "8790";
let auditedAgent = null;
let modelCatalogue = null, modelCatalogueLoading = false, modelSwitchBusy = false,
  modelCatalogueRevision = 0, modelCatalogueError = '', lastByokDetails = null, nativeModelPicker = null, nativeAuthControls = null;
let nativeMediaComposer = null, messageMediaDisposers = [];
let setupWizard = null, setupSessionGeneration = 0;
let nativePanel = null, agentSkills = null;
let emergencyHalt = null, emergencyHaltBlocksWork = false;
const runtimeHealthDisplay = createRuntimeHealthDisplay();
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
let loadoutResetTarget = null;
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
        `Overall covenant: ${gate.scores.covenant} / 255 · required minimum: ${covenantThresholdLabel(gate)}.`,
      ),
    );
  if (typeof gate.rationale === "string" && gate.rationale)
    details.append(el("p", "review-note", gate.rationale));
  return details;
}

async function api(path, data, options = {}) {
  if (!localBridgePage && !token && !["/api/pair", "/api/status"].includes(path))
    throw new Error("Install and launch ChainChat, or connect in optional website mode.");
  const requestToken = token;
  const healthRevision = runtimeHealthDisplay.revision;
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
    if (error.name !== 'AbortError' && requestToken === token && runtimeHealthDisplay.unavailable(healthRevision)) invalidateRuntimeConfirmation();
    if (error.name === "AbortError" || localBridgePage) throw error;
    throw new Error(
      "Could not reach the installed app. Open ChainChat using its application launcher. Optional website mode may also need local-network permission.",
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    if (requestToken === token && runtimeHealthDisplay.unavailable(healthRevision)) invalidateRuntimeConfirmation();
    throw new Error("The local app returned an unreadable response.");
  }
  if (requestToken === token) {
    const haltStatus = (result.state || result).emergencyHalt;
    if (haltStatus) emergencyHalt?.sync(haltStatus);
  }
  if (!response.ok) {
    const error = new Error(
      typeof result.error === "string"
        ? result.error
        : result.error?.message || "The request could not be completed.",
    );
    error.code = result.code;
    error.stage = result.stage;
    error.gate = result.gate;
    error.pluginNotice = result.pluginNotice;
    if (requestToken === token && runtimeHealthDisplay.failed(error.code, healthRevision)) invalidateRuntimeConfirmation();
    if (response.status === 401 && path !== "/api/pair" && token === requestToken) clearLocalSession();
    throw error;
  }
  if (requestToken === token) {
    const current = result.state || result;
    const runtime = current.executionRuntime || (path === '/api/status' ? result.runtime : null);
    if (runtime && runtimeHealthDisplay.observe(runtime, healthRevision, { agentVerified: current.agent?.verified === true || current.agent?.verified === 'PASS' })) {
      // Keep the setup guide's existing health binding current as well. A cheap
      // activity response must invalidate its cached readiness immediately.
      state.executionRuntime = { ...state.executionRuntime, ...runtime, backend: runtime.backend, running: runtime.running === true,
        healthy: runtime.healthy === true, enforcementHealthy: runtime.enforcementHealthy === true,
        healthState: runtime.healthState, healthRevision: runtime.healthRevision, generation: runtime.generation };
      renderRuntimeConnection(); setupWizard?.update();
    }
  }
  return result;
}
function invalidateRuntimeConfirmation() {
  state.executionRuntime = { ...state.executionRuntime, healthy: false, enforcementHealthy: false };
  renderRuntimeConnection(); setupWizard?.update();
}
function renderRuntimeConnection() {
  const view = emergencyHaltBlocksWork
    ? { online: false, label: "EMERGENCY HALT", detail: "" }
    : runtimeHealthDisplay.view({ paired: !!token, local: localBridgePage });
  $("bridgeDot").classList.toggle("online", view.online);
  $("bridgeStatus").textContent = view.label;
  $("bridgeStatus").title = view.detail;
  $("runtimeHealthNotice").textContent = view.detail;
  $("runtimeHealthNotice").classList.toggle('hidden', !view.detail);
  nativePanel?.syncConnection({ connected: !!token, agentId: agentId(), agentName: state.agent?.name,
    memoryPaused: cognition().mode === 'dormant', runtimeReady: view.online && state.executionRuntime?.backend === 'openclaw',
    modelConfigured: state.provider?.configured === true, chainHeld: !!(state.agent?.locked || state.agent?.maintenancePending), local: localBridgePage });
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
  if (setupWizard) setupWizard.open();
  else openDialog("installDialog");
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
    renderOperationControls();
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
  // api() admits health observations in response order. Merging a late full
  // state must not resurrect the runtime readiness it already rejected.
  const executionRuntime = state.executionRuntime;
  const incomingId = next.agent?.id || next.agent?.root;
  if (incomingId && incomingId !== agentId()) {
    delete state.faculties;
    delete state.operatorCompatibility;
    delete state.loadoutRepair;
    delete state.nativeCompletions;
    state.cognition = { ...DEFAULT_COGNITION };
    lifecycleSelection = null;
    runtimeActivity = null;
    activityReceivedAt = 0;
  }
  if (next.agent !== undefined || next.agents !== undefined) {
    state = { ...state, ...next };
    state.provider = providerConnectionView(state.provider);
    if (executionRuntime) state.executionRuntime = executionRuntime;
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
  const modeView = cognitionModeView(current, { paired, held });
  $("cognitionMode").textContent = modeView.status;
  $("cognitionMode").classList.toggle("dormant", paired && dormant);
  $("cognitionMode").closest(".cognition-strip").classList.toggle("dormant", paired && dormant);
  $("learningIndicator").textContent = !paired ? "LEARNING —" : dormant ? "LEARNING PAUSED" : current.learning ? "LEARNING ON" : "LEARNING OFF";
  $("composerGateLabel").textContent = modeView.composer;
  $("gateStatus").textContent = modeView.gateStatus;
  $("gateAbility").classList.toggle("active", modeView.gateActive);
  $("gateAbility").classList.toggle("locked", true);
  const route = routeControlState(current, settings().recall);
  $("routeAbility").classList.toggle("active", paired && route.enabled);
  $("routeStatus").textContent = route.label;
  $("learningAbility").classList.toggle("active", paired && !dormant && current.learning);
  $("learningStatus").textContent = dormant ? "PAUSED" : current.learning ? "ENABLED" : "OFF · HISTORY ON";
  $("dreamAbility").classList.toggle("active", paired && !dormant && current.learning && current.autoDream);
  $("dreamStatus").textContent = dormant ? "PAUSED" : current.autoDream && current.learning ? "EVERY 100 BLOCKS" : "MANUAL";
  $("cognitionStatus").textContent = dormant ? "MEMORY PAUSED" : "MONITOR";
  $("cognitionModeTitle").textContent = modeView.title;
  $("cognitionModeDescription").textContent = modeView.description;
  $("toggleChainMode").textContent = modeView.toggle;
  $("toggleChainMode").disabled = !paired || cognitionBusy;
  if (paired && dormant) {
    for (const id of ["recallAbility", "forkAbility", "continuumAbility", "loadoutAbility"])
      $(id).classList.remove("active");
    for (const id of ["recallAbility", "forkAbility", "continuumAbility"])
      $(id).querySelector(".slot-status").textContent = "PAUSED";
    $("loadoutAbility").querySelector(".slot-status").textContent = "LOADOUT SAVED";
  }
  $("sessionTag").textContent = paired && dormant ? "MEMORY PAUSED · PoI ENFORCED" : $("sessionTag").textContent;
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
  nativePanel?.renderToolActivity?.(runtimeActivity, fresh);
  for (const [id, indicator] of Object.entries(abilityIndicators(runtimeActivity, fresh))) {
    const button = $(id);
    button.classList.toggle("running", indicator.active);
    button.dataset.runStatus = indicator.status;
    button.setAttribute("aria-busy", String(indicator.active));
    let badge = button.querySelector(".slot-live");
    if (!badge) { badge = el("span", "slot-live"); button.append(badge); }
    badge.textContent = paired ? indicator.status : "IDLE";
    button.setAttribute('aria-label', `${button.dataset.abilityLabel || button.querySelector('.slot-title').textContent} · ${button.querySelector('.slot-status').textContent} · ${badge.textContent}`);
  }
  $("monitorConnection").textContent = !paired ? "NOT CONNECTED" : fresh ? "LIVE APP" : "ACTIVITY UNAVAILABLE";
  const running = fresh && runtimeActivity?.running;
  $("cancelTurn").classList.toggle("hidden", !(requestBusy || running));
  $("cancelTurn").disabled = stoppingBusy;
  renderSendButton();
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
  const sessionToken = token, id = agentId(), healthRevision = runtimeHealthDisplay.revision;
  try {
    const result = await pollWithDeadline(signal => api("/api/activity", undefined, { signal }));
    if (sessionToken !== token || id !== agentId()) return;
    const next = normalizeActivity(result.activity || result, id);
    if (!next || (runtimeActivity?.agentId === id && next.revision < runtimeActivity.revision)) return;
    runtimeActivity = next; activityReceivedAt = Date.now();
  } catch {
    if (sessionToken === token && id === agentId()) {
      activityReceivedAt = 0;
      if (runtimeHealthDisplay.unavailable(healthRevision)) invalidateRuntimeConfirmation();
    }
  }
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
    $("sessionAutoEquip").checked = state.sessionEquipment?.enabled === true;
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
  return isSessionEquipped(faculty) || chosen.some((id) => rawId(id) === rawId(facultyId(faculty)));
}
function isSessionEquipped(faculty) {
  const field = faculty.kind === "modality" ? "modalities" : "senses";
  return state.sessionEquipment?.[field]?.includes(facultyId(faculty)) === true;
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
      : state.sessionEquipment?.enabled ? "Newly promoted faculties can equip for this chat session."
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
    button.disabled = requestBusy || cognitionBusy;
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
        isSessionEquipped(faculty) ? "EQUIPPED FOR SESSION" :
          freshIds.has(facultyIdentity(faculty)) ? "NEW · " + (faculty.equippable === false ? "EMERGING" : selected ? "EQUIPPED" : "AVAILABLE") : selected
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
  if (isSessionEquipped(faculty)) {
    try {
      applyState(await api("/api/loadout/session", { unequip: facultyId(faculty) }));
      toast(`${faculty.name} unequipped for this session.`);
    } catch (error) { toast(error.message, true); }
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
    const nativeCompletion = (state.nativeCompletions?.rows || []).some(row =>
      row.agentId === state.agent?.id && row.genesisHash === state.agent?.genesis?.hash &&
      row.ringHash === (ring.hash || ring.ring_hash) && row.ringIndex === ring.index);
    if (input && typeof input === "string" && !nativeCompletion)
      result.push({ role: "user", content: input, attachments: nativeHistoryMedia(payload, 'input'),
        ...(!output ? {unknownAttachments: nativeHistoryMedia(payload, 'unknown')} : {}), fromHistory: true });
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
        ...(nativeCompletion ? {nativeCompletion: true} : {}),
        media: nativeHistoryMedia(payload, 'output'),
        unknownAttachments: nativeHistoryMedia(payload, 'unknown'),
        fromHistory: true,
      });
  }
  for (const pending of state.pending?.exchanges || []) {
    if (typeof pending.input === "string")
      result.push({ role: "user", content: pending.input, attachments: nativeHistoryMedia(pending, 'input'),
        ...(!pending.output ? {unknownAttachments: nativeHistoryMedia(pending, 'unknown')} : {}), fromHistory: true });
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
        media: nativeHistoryMedia(pending, 'output'),
        unknownAttachments: nativeHistoryMedia(pending, 'unknown'),
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
  renderRuntimeConnection();
  $("pairButton").querySelector("span").textContent = paired
    ? "App connected"
    : "Install & open";
  $("modelLabel").textContent =
    paired && state.provider?.configured
      ? state.provider.model
      : "Connect a model";
  $("modelButton").title = state.provider?.configured
    ? `${state.provider.provider} · ${state.provider.model}`
    : "Connect your API provider or choose a local OpenClaw model";
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
  if (!requestBusy && conversations.has(id)) {
    const merged = mergeHistoryMessages(conversations.get(id), historyMessages());
    if (merged.changed) { conversations.set(id, merged.messages); renderConversation(); }
  }
  const repairNotice = loadoutRepairNotice(state.loadoutRepair);
  $("loadoutRepairNotice").textContent = repairNotice;
  $("loadoutRepairNotice").classList.toggle("hidden", !repairNotice);
  $("clearLoadout").disabled = !token || !state.agent || requestBusy;
  if ($("exchangeDialog").open) renderExportFaculties();
  $("thresholdNote").textContent = gateRequirementsNote(state.gate);
  renderOperationControls();
  renderCognition();
  nativeMediaComposer?.sync();
  agentSkills?.sync();
  setupWizard?.update();
}
function renderConversation() {
  for (const cleanup of messageMediaDisposers) cleanup(); messageMediaDisposers = [];
  const messages = conversations.get(agentId()) || [];
  $("welcome").classList.toggle("hidden", messages.length > 0);
  const list = $("messages");
  list.replaceChildren();
  for (const [messageIndex, message] of messages.entries()) {
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
          ? message.failure?.title || "RESPONSE HELD"
          : message.control ? "OPENCLAW CONTROL"
          : message.nativeCompletion ? "NATIVE TASK COMPLETION"
          : message.role === "user"
            ? "YOU"
            : state.agent?.name?.toUpperCase() || "CYPHER AGENT",
      ),
    );
    node.append(label, messageBody(message));
    const media = nativeMessageMedia(message, messages[messageIndex - 1]);
    const mediaContext = () => `${token}:${agentId()}`;
    messageMediaDisposers.push(renderNativeMedia({ document, mount: node, assets: media.inputs, label: 'Attached inputs', api, context: mediaContext }),
      renderNativeMedia({ document, mount: node, assets: media.outputs, label: 'Native output media', api, context: mediaContext }),
      renderNativeMedia({ document, mount: node, assets: media.unknown, label: 'Attachments · origin unspecified', api, context: mediaContext }));
    if (message.held && message.failure) {
      const diagnostic = el("div", "message-meta chat-error-meta");
      diagnostic.append(el("code", "", message.failure.code), el("span", "", `Stage: ${message.failure.stageLabel}`));
      if (message.failure.action && message.failure.actionLabel) {
        const recover = el("button", "text-button", message.failure.actionLabel);
        recover.type = "button";
        recover.addEventListener("click", () => recoverChatFailure(message.failure.action));
        diagnostic.append(recover);
      }
      node.append(diagnostic);
    }
    if (message.held && message.gate) {
      const review = covenantReview(message.gate);
      if (review) node.append(review);
    }
    if (message.role === "assistant" && !message.held) {
      const meta = el("div", "message-meta");
      const ring = message.ring;
      meta.append(
        el(
          "span",
          "",
          messageIsReviewedPause(message)
            ? "Memory paused · PoI reviewed · no new Timechain block"
            : messageIsDormant(message)
            ? "Historical plain model chat · no Timechain review or block"
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
function recoverChatFailure(action) {
  if (requestBusy) { toast("Wait for the current operation to finish."); return; }
  if (action === "model") requirePair(openModel);
  else if (action === "continuum") { openContinuum(); $("flushContinuum").focus(); }
  else if (action === "loadout") requireAgent(openClearLoadout);
  else if (action === "inspect") $("historyButton").click();
  else if (action === "native") requirePair(() => nativePanel.open());
  else if (action === "connect") openDialog(localBridgePage ? "installDialog" : "pairDialog");
}
function openClearLoadout() {
  if (requestBusy) { toast("Wait for the current turn before changing equipment."); return; }
  loadoutResetTarget = { token, agent: agentId() };
  openDialog("clearLoadoutDialog");
}
$("clearLoadout").addEventListener("click", () => requireAgent(openClearLoadout));
$("clearLoadoutDialog").addEventListener("close", () => { loadoutResetTarget = null; });
$("clearLoadoutForm").addEventListener("submit", event => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    if (!loadoutResetTarget || loadoutResetTarget.token !== token || loadoutResetTarget.agent !== agentId() || requestBusy)
      throw new Error("The selected agent or session changed. Open this confirmation again.");
    const result = await api("/api/loadout/reset", { confirm: true });
    state.loadout = result.loadout || result.state?.loadout || { modalities: [], senses: [] };
    applyState(result);
    await refreshState();
    closeDialog("clearLoadoutDialog");
    toast("Equipment cleared. Available faculties can be equipped again.");
  });
});
async function selectAgent(id) {
  if (requestBusy) {
    toast("Wait for your active turn to finish before switching agents.");
    return;
  }
  try {
    applyState(await api("/api/agents/select", { id }));
    $("agentChoices").classList.add("hidden");
    focusWorkspaceSection("chainchatWorkspace");
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
$("pairButton").addEventListener("click", () => token ? openDialog("pairDialog") : setupWizard.open());
$("getStartedButton").addEventListener("click", () => setupWizard.open());
$("setupGuideButton").addEventListener("click", () => setupWizard.open());
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
  token = "";
  emergencyHalt?.syncConnection();
  runtimeHealthDisplay.reset();
  setupSessionGeneration++;
  modelCatalogueRevision++; modelCatalogue = null; modelCatalogueLoading = false; modelSwitchBusy = false;
  modelCatalogueError = ''; lastByokDetails = null;
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
  clearComposerDraft();
  $("packJson").value = "";
  $("packFile").value = "";
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
    state.provider = providerConnectionView(result.provider);
    modelCatalogueRevision++; modelCatalogue = null; modelCatalogueLoading = false; lastByokDetails = null;
    $("apiKey").value = "";
    $("modelId").value = "";
    $("baseUrl").value = "";
    $("reasoningCapable").checked = false;
    $("modelContextWindow").value = "";
    $("modelOutputLimit").value = "";
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
      throw new Error("Install ChainChat 1.0.4 or newer to use this interface and its setup guide. OpenClaw and PoI are included.");
    const result = await api("/api/pair", { code: $("pairCode").value.trim() });
    token = result.token;
    setupSessionGeneration++;
    $("pairCode").value = "";
    applyState(await api("/api/state"));
    closeDialog("pairDialog");
    toast("Website connected to the local app.");
    try {
      const data = await api("/api/archetypes");
      archetypes = data.archetypes || [];
    } catch {}
    const action = pendingAction;
    pendingAction = null;
    if (action && !setupWizard?.active) action();
  });
});
$("newAgentButton").addEventListener("click", () =>
  requirePair(() => openDialog("genesisDialog")),
);
$("welcomeStart").addEventListener("click", () =>
  !token || !state.agent || !state.provider?.configured
    ? setupWizard.open() : $("messageInput").focus(),
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
    if (!setupWizard?.active && !state.provider?.configured) openModel();
  });
});
$("existingForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    applyState(
      await api("/api/agents/pair", { root: $("existingRoot").value.trim() }),
    );
    closeDialog("existingDialog");
    toast("Existing Timechain verified and paired.");
    if (!setupWizard?.active && !state.provider?.configured) openModel();
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
function rememberByokProvider(provider) {
  if (!provider?.configured || !['openai', 'anthropic', 'gemini', 'compatible'].includes(provider.provider)) return;
  lastByokDetails = Object.fromEntries(['provider', 'model', 'baseUrl', 'reasoningCapable', 'contextWindow', 'maxOutputTokens', 'configured', 'tier']
    .filter(key => provider[key] !== undefined).map(key => [key, provider[key]]));
}
function renderModelCatalogue() {
  const { active, tiers: [connection] } = modelCatalogueView(modelCatalogue);
  const query = $("modelCatalogueSearch").value.trim().toLowerCase();
  const shown = connection.models.filter(model => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query));
  const list = $("modelCatalogueList"); list.replaceChildren();
  $("modelCatalogueStatus").textContent = modelCatalogueLoading ? 'Checking models from your API provider…'
    : modelCatalogueError || `${shown.length} of ${connection.models.length} provider models`;
  $("modelConnectionNotice").textContent = connection.notice ||
    'Connect your API provider below. If it has no model-list endpoint, use its exact model ID with the current connection.';
  if (!connection.models.length) list.append(el('p', 'fine-print', 'No provider model list is currently available. You can enter a model ID below.'));
  else if (!shown.length) list.append(el('p', 'fine-print', 'No models match this search.'));
  for (const model of shown) {
    const selected = state.provider?.configured && active?.tier === 'byok' && active.model === model.id;
    const button = el('button', `model-choice${selected ? ' selected' : ''}`); button.type = 'button';
    button.disabled = !model.available || modelCatalogueLoading || modelSwitchBusy || requestBusy;
    button.setAttribute('aria-label', `${selected ? 'Active' : 'Use'} ${model.name}${model.available ? '' : ' · unavailable'}`);
    button.setAttribute('aria-pressed', String(selected));
    const heading = el('span', 'model-choice-heading'); heading.append(el('strong', '', model.name), el('small', '', selected ? 'ACTIVE' : !model.available ? 'UNAVAILABLE' : 'SELECT'));
    button.append(heading, el('span', 'model-choice-id', model.id));
    const limits = [model.contextWindow ? `${model.contextWindow.toLocaleString()} context` : '', model.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString()} output` : '', model.reasoningCapable ? 'Reasoning settings supported' : ''].filter(Boolean);
    if (limits.length) button.append(el('span', 'model-choice-details', limits.join(' · ')));
    if (!model.available) button.append(el('span', 'model-choice-reason', model.reason || connection.notice || 'Not currently available.'));
    if (model.privacyNotice) button.append(el('span', 'model-choice-privacy', model.privacyNotice));
    button.addEventListener('click', () => { void switchModel(model.id); });
    list.append(button);
  }
  $("restoreByokModel").classList.toggle('hidden', !connection.available || active?.tier === 'byok');
  $("restoreByokModel").disabled = modelCatalogueLoading || modelSwitchBusy || requestBusy;
  $("modelCustomId").disabled = !connection.available || modelCatalogueLoading || modelSwitchBusy || requestBusy;
  $("switchCustomModel").disabled = $("modelCustomId").disabled;
  $("byokConnectionFields").disabled = modelSwitchBusy;
  $("refreshModelCatalogue").disabled = modelCatalogueLoading || modelSwitchBusy;
  $("modelKeyStatus").textContent = lastByokDetails?.configured
    ? lastByokDetails.provider === 'compatible' ? 'Provider connection active' : 'API key connected' : '';
  nativeModelPicker?.sync();
  nativeAuthControls?.sync();
  nativeMediaComposer?.sync();
}
async function refreshModelCatalogue(force = false) {
  if (!token || modelSwitchBusy) return;
  const owner = token, revision = ++modelCatalogueRevision;
  modelCatalogueLoading = true; modelCatalogueError = ''; renderModelCatalogue();
  try {
    let result;
    if (force) {
      try { result = await api('/api/models/refresh', {}); }
      catch (error) { if (error.code !== 'NOT_FOUND') throw error; }
    }
    result ||= await api('/api/models');
    if (owner !== token || revision !== modelCatalogueRevision) return;
    modelCatalogue = modelCatalogueView(result);
  } catch {
    if (owner === token && revision === modelCatalogueRevision) {
      modelCatalogue = null;
      modelCatalogueError = 'The model catalogue could not be refreshed. Manual API setup remains available.';
    }
  } finally {
    if (owner === token && revision === modelCatalogueRevision) { modelCatalogueLoading = false; renderModelCatalogue(); }
  }
}
async function switchModel(model) {
  if (requestBusy || modelSwitchBusy) { toast('Finish or stop the current operation before switching models.'); return; }
  const errors = $("modelForm").querySelector('.dialog-error'); errors.textContent = '';
  let payload;
  try { payload = modelSwitchPayload(modelCatalogue, model); }
  catch (error) { errors.textContent = error.message; return; }
  const owner = token, revision = ++modelCatalogueRevision;
  modelSwitchBusy = true; modelCatalogueLoading = false; $("apiKey").value = ''; renderModelCatalogue();
  try {
    const result = await api('/api/model', payload);
    if (owner !== token || revision !== modelCatalogueRevision) return;
    state.provider = providerConnectionView(result.provider);
    rememberByokProvider(state.provider);
    if (result.active) modelCatalogue = modelCatalogueView({ ...modelCatalogue, active: result.active });
    renderState(); closeDialog('modelDialog'); toast('Model switched. Your Timechain stays the same.');
  } catch (error) { if (owner === token && revision === modelCatalogueRevision) errors.textContent = error.message; }
  finally {
    if (owner === token && revision === modelCatalogueRevision) { modelSwitchBusy = false; renderModelCatalogue(); }
  }
}
function openModel() {
  rememberByokProvider(state.provider);
  const provider = state.provider?.configured && state.provider.provider !== 'native' ? state.provider : lastByokDetails || {};
  $("provider").value = ['openai', 'anthropic', 'gemini', 'compatible'].includes(provider.provider) ? provider.provider : 'openai';
  $("modelId").value = provider.model || "";
  $("baseUrl").value = provider.baseUrl || "";
  $("reasoningCapable").checked = provider.reasoningCapable === true;
  $("modelContextWindow").value = provider.contextWindow ?? "";
  $("modelOutputLimit").value = provider.maxOutputTokens ?? "";
  $("apiKey").value = "";
  nativeModelPicker?.reset();
  nativeAuthControls?.reset();
  $("modelCustomId").value = provider.model || '';
  $("modelCatalogueSearch").value = '';
  $("byokManualDetails").open = !provider.configured;
  updateProviderPlaceholder();
  renderOperationControls();
  renderModelCatalogue();
  openDialog("modelDialog");
  void refreshModelCatalogue();
}
nativeModelPicker = mountNativeModelPicker({ document, mount: $("nativeModelPickerMount"), api,
  context: () => `${token}:${agentId()}`, activeModel: () => state.provider?.provider === 'native' ? state.provider.model : '',
  isBusy: () => requestBusy || modelSwitchBusy,
  onBusy(value) { modelSwitchBusy = value; if (value) { modelCatalogueRevision++; modelCatalogueLoading = false; $("apiKey").value = ''; } renderModelCatalogue(); },
  onSelected(provider) {
    state.provider = provider;
    modelCatalogue = modelCatalogueView({ ...modelCatalogue, active: { tier: 'native', provider: 'native', model: provider.model } });
    renderState(); closeDialog('modelDialog'); toast('Native OpenClaw model selected. Your Timechain stays the same.');
  },
});
nativeAuthControls = mountNativeAuth({ document, mount: $("nativeModelPickerMount"), api,
  context: () => `${token}:${agentId()}`, isBusy: () => requestBusy || modelSwitchBusy,
  onBusy(value) { modelSwitchBusy = value; if (value) { modelCatalogueRevision++; modelCatalogueLoading = false; $("apiKey").value = ''; } renderModelCatalogue(); },
  onUpdated: () => nativeModelPicker.refresh(),
  openSettings() { setupWizard?.dismiss(); closeDialog('modelDialog'); nativePanel.open('configuration'); $("nativeSchemaSearch").value = 'models.providers'; $("nativeSchemaSearch").dispatchEvent(new Event('input')); },
});
$("modelButton").addEventListener("click", () => requirePair(openModel));
$("modelCatalogueSearch").addEventListener('input', renderModelCatalogue);
$("refreshModelCatalogue").addEventListener('click', () => { void refreshModelCatalogue(true); });
$("switchCustomModel").addEventListener('click', () => { void switchModel($("modelCustomId").value); });
$("restoreByokModel").addEventListener('click', () => { void switchModel(); });
$("modelCustomId").addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void switchModel($("modelCustomId").value); } });
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
  $("modelContextWindow").value = "";
  $("modelOutputLimit").value = "";
  updateProviderPlaceholder();
});
$("modelForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (modelSwitchBusy) return;
  runForm(event.currentTarget, async () => {
    let data;
    try {
      data = {
        provider: $("provider").value,
        model: $("modelId").value.trim(),
        baseUrl: $("baseUrl").value.trim() || $("baseUrl").placeholder,
        reasoningCapable: $("reasoningCapable").checked,
        apiKey: $("apiKey").value,
        ...providerLimits({ contextWindow: $("modelContextWindow").value, maxOutputTokens: $("modelOutputLimit").value }),
      };
      const result = await api("/api/provider", data);
      state.provider = result.provider ||
        result.state?.provider || {
          provider: data.provider, model: data.model, baseUrl: data.baseUrl, tier: 'byok',
          reasoningCapable: data.reasoningCapable,
          ...providerLimits(data),
          configured: true,
        };
      rememberByokProvider(state.provider);
      modelCatalogueRevision++; modelCatalogue = null; modelCatalogueLoading = false;
      applyState(result);
      closeDialog("modelDialog");
      toast("Model configured. Your Timechain stays the same.");
    } finally {
      $("apiKey").value = "";
      if (data) data.apiKey = "";
    }
  });
});
$("modelDialog").addEventListener("close", () => { $("apiKey").value = ""; nativeAuthControls?.reset(); });
function clearComposerDraft() {
  const input = $("messageInput");
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function runComposerCommand(route, { fromComposer = false } = {}) {
  if (emergencyHaltBlocksWork) throw new Error("Emergency Halt is active.");
  if (!route) throw new Error('Enter a native slash command.');
  if (!token) throw new Error('Open the installed ChainChat app to run commands.');
  if (state.executionRuntime?.backend === 'direct')
    throw new Error('Launch the installed OpenClaw edition to use chat commands.');
  if (stoppingBusy || (requestBusy || modelSwitchBusy) && !route.interrupt)
    throw new Error('Wait for the current operation before running this command.');

  if (route.path === '/api/chat') {
    if (!fromComposer) nativePanel.close();
    return sendChatMessage(route.command, { fromComposer, command: true });
  }

  const commandSession = token, commandAgent = agentId();
  const stoppedController = route.name === 'stop' ? chatController : null;
  const isCurrent = () => token === commandSession && agentId() === commandAgent;
  if (route.interrupt) {
    stoppingBusy = true;
    renderRuntimeActivity();
  } else {
    requestBusy = true;
    renderOperationControls();
    activity(`Running /${route.name} in the local OpenClaw runtime…`, 'busy');
  }
  let result;
  try {
    result = await api(route.path, { command: route.command });
    if (!isCurrent()) return;
    if (result.kind === 'turn') throw new Error('This command needs a supported reviewed chat route. Check /help for the available syntax.');
    if (result.state) applyState(result.state);
    if (fromComposer) {
      if ($('messageInput').value.trim() === route.command) clearComposerDraft();
      addMessage({ role: 'user', content: route.command });
      addMessage({ role: 'assistant', content: result.text || (result.action === 'stop' ? 'Cancellation requested.' : 'Native command completed.'), control: true });
    }
    if (result.action === 'stop') stoppedController?.abort();
    activity(result.action === 'stop' ? 'Cancellation requested.' : 'Native OpenClaw control completed.');
  } catch (error) {
    if (!isCurrent()) return;
    activity(`/${route.name} could not complete. ${error.message}`, 'error');
    throw error;
  } finally {
    if (route.interrupt) {
      stoppingBusy = false;
      renderRuntimeActivity();
    } else {
      requestBusy = false;
      renderOperationControls();
    }
    if (isCurrent()) void refreshActivity();
  }
  if (result.action === 'model') openModel();
  if (result.action === 'config') nativePanel.open();
  return result;
}
async function sendChatMessage(message, { fromComposer = true, command = false } = {}) {
  if (emergencyHaltBlocksWork) throw new Error("Emergency Halt is active.");
  if (!state.agent) {
    openDialog("genesisDialog");
    throw new Error("Begin a new genesis or pair your existing agent first.");
  }
  if (!state.provider?.configured) {
    openModel();
    if (command) throw new Error('Connect a model before running this command.');
    return;
  }
  if (!command && nativeMediaComposer?.snapshot().uploading)
    throw new Error('Wait for the local file uploads to finish before sending.');
  const mediaDraft = (!command && nativeMediaComposer?.take()) || { ids: [], assets: [] };
  const payload = nativeChatPayload(message, mediaDraft.ids, state.provider);
  requestBusy = true;
  const turnMode = cognition().mode;
  const chatSession = token;
  const chatAgent = agentId();
  chatController = new AbortController();
  renderOperationControls();
  renderRuntimeActivity();
  addMessage({ role: "user", content: message, attachments: mediaDraft.assets });
  if (fromComposer) clearComposerDraft();
  activity(
    turnMode === "dormant" ? "Memory paused · starting required PoI review; no new chain block."
      : "Starting the Timechain run · waiting for live app activity…",
    "busy",
  );
  try {
    const result = await api(
      "/api/chat",
      payload,
      { signal: chatController.signal },
    );
    if (emergencyHaltBlocksWork || token !== chatSession || agentId() !== chatAgent) return;
    if (result.state) applyState(result.state);
    const response = result.message || result;
    if (typeof response.content !== "string")
      throw new Error(
        "No accepted response was returned. Inspect the app before trying again.",
      );
    addMessage({ role: "assistant", input: message, mode: turnMode, ...response });
    activity(
      response.control ? "Native OpenClaw control completed."
        : messageIsReviewedPause(response)
        ? "PoI-reviewed response · memory remains paused; no new chain block."
        : messageIsDormant(response)
        ? "Historical plain response · no new Timechain block."
        : response.pending
        ? `Covenant accepted · ${bytes(state.pending?.bytes)} pending toward the next block.`
        : `Accepted and sealed${response.ring?.index !== undefined ? ` in ring ${response.ring.index}` : ""}.`,
    );
    return { kind: 'turn', text: 'Reviewed chat command completed.' };
  } catch (error) {
    if (token !== chatSession || agentId() !== chatAgent) return;
    if (emergencyHaltBlocksWork && error.name === "AbortError") return;
    const failure = chatFailure(error);
    addMessage({
      role: "assistant",
      held: true,
      content: failure.message,
      failure,
      gate: error.gate,
    });
    activity(
      `${failure.title} · ${failure.code} · ${failure.stageLabel}`,
      "error",
    );
    if (!fromComposer) throw error;
  } finally {
    chatController = null;
    requestBusy = false;
    renderOperationControls();
    $("messageInput").focus();
    await refreshState();
    await refreshActivity();
  }
}
$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (emergencyHaltBlocksWork) return;
  const message = $("messageInput").value.trim();
  if (!message) return;
  if (message === '/' && $("chatCommands")) {
    $("chatCommands").open = true;
    return;
  }
  const command = composerCommand(message);
  if (stoppingBusy || (requestBusy || modelSwitchBusy) && !command?.interrupt) return;
  if (!token) {
    requirePair(() => $("messageInput").focus());
    return;
  }
  try {
    if (command) await runComposerCommand(command, { fromComposer: true });
    else await sendChatMessage(message);
  } catch (error) { toast(error.message, true); }
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
  renderSendButton();
});
mountChatCommands({ document, input: $("messageInput"), panel: $("chatCommands"), choices: $("chatCommandChoices") });
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
      renderOperationControls();
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
      renderOperationControls();
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
// Persistent workspace cards replace the former mobile side drawers.
function focusWorkspaceSection(sectionId, focusId = sectionId) {
  const section = $(sectionId);
  if (!section) return;
  $(focusId)?.focus({ preventScroll: true });
  section.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant" : "smooth",
    block: "start",
  });
}
function toggleLoadout() {
  focusWorkspaceSection("loadoutSidebar", "facultyTitle");
}
for (const id of ["loadoutAbility", "mobileLoadout"])
  $(id).addEventListener("click", toggleLoadout);
$("closeLoadout").addEventListener("click", () => {
  focusWorkspaceSection("chainchatWorkspace");
});
$("closeAgents").addEventListener("click", () => {
  focusWorkspaceSection("chainchatWorkspace");
});
$("mobileAgents").addEventListener("click", () => {
  focusWorkspaceSection("agentSidebar", "agentDetailsTitle");
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
      (button.title = `${button.dataset.abilityLabel || button.querySelector(".slot-title").textContent} · Alt + ${button.dataset.shortcut}`),
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
$("sessionAutoEquip").addEventListener("change", async event => {
  const toggle = event.currentTarget;
  const previous = state.sessionEquipment?.enabled === true;
  if (requestBusy || cognitionBusy) {
    toggle.checked = previous;
    toast("Change session equipment after the current turn.");
    return;
  }
  toggle.disabled = true;
  try {
    applyState(await api("/api/loadout/session", { enabled: toggle.checked }));
    toast(state.sessionEquipment?.enabled ? "Newly promoted faculties can equip for this session." : "Session equipment cleared.");
  } catch (error) { toast(error.message, true); }
  finally {
    toggle.checked = state.sessionEquipment?.enabled === true;
    toggle.disabled = false;
  }
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
    activity("Real-time memory paused. PoI remains required; action tools are off and no new blocks are recorded.");
    toast("Memory paused · PoI enforced. Resume memory from Cognition controls.");
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
    cognitionBusy = true; renderOperationControls();
    $("cognitionDialog").querySelector(".dialog-error").textContent = "";
    try {
      const result = await api("/api/maintenance", { action: button.dataset.maintenance, confirm: true });
      applyState(result); await refreshState(); await refreshCognition();
      toast("Native maintenance completed. Inspect its recorded activity below.");
    } catch (error) { $("cognitionDialog").querySelector(".dialog-error").textContent = error.message; }
    finally { cognitionBusy = false; renderOperationControls(); await refreshActivity(); }
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
      button.type = "button"; button.disabled = requestBusy || cognitionBusy || !token || readOnly;
      button.addEventListener("click", () => previewLifecycle(faculty, action));
      card.append(button);
    }
    if (faculty.requiresLocalCodeReview) card.append(el("p", "fine-print", "This proposal contains authored code. Review it locally before activation; ChainChat will not execute it."));
    if (faculty.equippable !== false && !faculty.dormant) {
      const equip = el("button", "text-button", isEquipped(faculty) ? "Unequip" : "Equip");
      equip.type = "button"; equip.disabled = requestBusy || cognitionBusy || !token;
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
  $("importPackButton").disabled = !ready || !token;
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
    } else button.disabled = !token || requestBusy;
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
function renderSendButton() {
  const held = !!(state.agent?.locked || state.agent?.maintenancePending);
  const dormant = cognition().mode === "dormant";
  const command = composerCommand($("messageInput").value);
  const nativeControl = command?.path === '/api/openclaw/command';
  const blockedByHold = held && !dormant && !nativeControl;
  const button = $("sendButton");
  button.disabled = emergencyHaltBlocksWork || stoppingBusy || (requestBusy && !command?.interrupt) ||
    (!command && nativeMediaComposer?.snapshot().uploading === true) || blockedByHold;
  button.title = emergencyHaltBlocksWork ? "Emergency Halt is active"
    : blockedByHold ? "Review the native recovery hold before continuing" : command ? "Run chat command" : "Send message";
  button.setAttribute('aria-label', command ? "Run chat command" : "Send message");
}
function renderOperationControls() {
  const held = !!(state.agent?.locked || state.agent?.maintenancePending);
  const dormant = cognition().mode === "dormant";
  renderSendButton();
  $("newAgentButton").disabled = requestBusy;
  for (const selector of ['#genesisForm button[type="submit"]', '#modelForm button[type="submit"]',
    '#continuumForm button[type="submit"]', '#ingestForm button[type="submit"]', '#saveFork', '#flushContinuum']) {
    const control = document.querySelector(selector);
    if (control) control.disabled = requestBusy;
  }
  $("recallAbility").disabled = requestBusy;
  document.querySelectorAll(".faculty-card").forEach((card) => {
    if (card.tagName === "BUTTON") card.disabled = requestBusy || cognitionBusy;
  });
  $("cognitionForm").querySelectorAll("input,button").forEach(control => {
    control.disabled = requestBusy || cognitionBusy;
  });
  document.querySelectorAll("[data-maintenance]").forEach(control => {
    control.disabled = held || requestBusy || cognitionBusy || dormant || !cognition().learning;
  });
  $("toggleChainMode").disabled = !token || !state.agent || cognitionBusy;
  $("confirmLifecycle").disabled = !token || held || requestBusy || cognitionBusy || dormant || !cognition().learning || !lifecycleSelection?.allowed;
  nativeMediaComposer?.sync();
}
$("loadAuditor").addEventListener("click", () => {
  requireAgent(() => {
    $("auditFrame").src = "./audit/?chainchat=1";
    $("auditFrame").classList.remove("hidden");
    $("loadAuditor").classList.add("hidden");
    auditedAgent = agentId();
  });
});
function initTranscriptSize() {
  const storageKey = "cypher-tempre.transcript-lines.v1";
  const buttons = document.querySelectorAll("[data-transcript-size]");
  const transcript = $("conversationScroll");
  function apply(value) {
    const lines = ["21", "52", "121"].includes(value) ? value : "21";
    const atBottom = transcript.scrollHeight - transcript.clientHeight - transcript.scrollTop <= 1;
    document.documentElement.dataset.transcriptLines = lines;
    for (const button of buttons)
      button.setAttribute("aria-pressed", String(button.dataset.transcriptSize === lines));
    if (atBottom) transcript.scrollTop = transcript.scrollHeight;
  }
  let saved;
  try { saved = localStorage.getItem(storageKey); } catch {}
  apply(saved);
  for (const button of buttons) button.addEventListener("click", () => {
    const lines = button.dataset.transcriptSize;
    apply(lines);
    try { localStorage.setItem(storageKey, lines); } catch {}
  });
}
async function start() {
  const bootstrap = localBridgePage ? new URLSearchParams(location.hash.slice(1)).get("launch") : null;
  if (bootstrap !== null) history.replaceState(null, "", location.pathname + location.search);
  initThemes();
  initFontModes();
  initTranscriptSize();
  initMotifs();
  renderState();
  setInterval(() => { void refreshActivity(); }, 1000);
  setInterval(() => { renderRuntimeActivity(); }, 2000);
  $("hostedBridgeSetup").classList.toggle("hidden", localBridgePage);
  $("bridgePort").disabled = localBridgePage || ["cyphertempre.ai","www.cyphertempre.ai"].includes(location.hostname);
  $("bridgePort").value = selectedBridgePort;
  $("hostedOrigin").textContent = location.origin;
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
    if (!emergencyHaltBlocksWork)
      $("bridgeStatus").textContent = supportedBridgeVersion(status.version)
        ? "CONNECTING TO LOCAL APP"
        : "APP UPDATE REQUIRED";
    if (status.version) $("appVersion").textContent = `v${status.version}`;
    if (!supportedBridgeVersion(status.version)) throw new Error("Install ChainChat 1.0.4 or newer to connect automatically.");
    const paired = await connectLocalSession({ origin: location.origin, nonce: bootstrap,
      storage: localTabStorage(), request: api });
    token = paired.token;
    emergencyHalt?.syncConnection();
    setupSessionGeneration++;
    applyState(await api("/api/state"));
    toast("Local app session connected. Check the runtime status above.");
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
  setupWizard.start();
  setInterval(refreshState, 10000);
}
nativePanel = initOpenClawSettings({ api, requireConnection: requirePair, isConnected: () => !!token, onClose: renderState,
  executeCommand: command => runComposerCommand(composerCommand(command)),
});
mountTimechainMaintenance({ document, api, local: localBridgePage, connected: () => !!token,
  onChange: () => { void refreshState(); } });
agentSkills = mountAgentSkills({ document, api, connected: () => !!token && state.executionRuntime?.backend === 'openclaw',
  agentId: () => state.agent?.id || null });
emergencyHalt = mountEmergencyHalt({
  document, api, local: localBridgePage, connected: () => !!token, requireConnection: requirePair,
  onChange(blocked) {
    emergencyHaltBlocksWork = blocked;
    if (blocked) {
      chatController?.abort();
      invalidateRuntimeConfirmation();
    } else {
      renderRuntimeConnection();
      void refreshState();
    }
    renderOperationControls();
  },
  onError: message => toast(message, true),
});
mountTimechainBackups({
  document, local: localBridgePage, openDialog, requirePair, refreshState,
  session: () => ({ token, agent: state.agent }),
});
nativeMediaComposer = mountNativeMediaComposer({ document, button: $("attachMedia"), input: $("nativeMediaFiles"), notice: $("nativeMediaNotice"), queueMount: $("nativeAttachmentQueue"), api,
  context: () => `${token}:${agentId()}:${state.provider?.provider}:${state.provider?.tier}:${state.provider?.model}`,
  provider: () => token && state.agent && !emergencyHaltBlocksWork ? state.provider : { configured: false }, isBusy: () => requestBusy || modelSwitchBusy,
  onError: message => { if (message) toast(message, true); }, onChange: () => renderOperationControls(),
});
window.addEventListener('pagehide', () => { nativeMediaComposer?.dispose(); for (const cleanup of messageMediaDisposers) cleanup(); messageMediaDisposers = []; });
window.addEventListener('pageshow', event => { if (event.persisted) { renderConversation(); nativeMediaComposer?.sync(); } });
setupWizard = mountSetupWizard({ document, api,
  snapshot: () => ({ local: localBridgePage, connected: !!token, generation: setupSessionGeneration, state }),
  actions: {
    model: openModel,
    genesis: () => openDialog('genesisDialog'),
    existing: () => openDialog('existingDialog'),
    pair: () => openDialog('pairDialog'),
    selectAgent,
    settings: () => nativePanel.open(),
    finish({ prepareIntroduction }) {
      if (prepareIntroduction && !$("messageInput").value.trim()) $("messageInput").value = 'Please introduce yourself.';
      focusWorkspaceSection('chainchatWorkspace');
      $("messageInput").focus();
      toast('Setup checks passed. Send a message when you are ready.');
    },
  },
});
start();
