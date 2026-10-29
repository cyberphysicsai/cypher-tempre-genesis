import { initMotifs } from "./motifs.js";
import {
  purchaseBoundSeats,
  rebindSeat,
  validateDeployment,
  verifyBridgeIdentity,
  matchingConfiguration,
} from "./seat-wallet.js";
import {
  bridgeApiUrl,
  bridgePort,
  isLocalBridgePage,
} from "./bridge-connection.js";
const $ = (id) => document.getElementById(id);
const localBridgePage = isLocalBridgePage(location.origin);
let selectedBridgePort = "8790";
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
  if (!localBridgePage && !token && path !== "/api/pair")
    throw new Error("Pair your local bridge before connecting to it.");
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
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
      "Could not reach the local bridge. Check its port, start it with this site's exact trusted origin, and allow local network access if your browser requests it. You can also use the local bridge page.",
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The local bridge returned an unreadable response.");
  }
  if (!response.ok) {
    const error = new Error(
      typeof result.error === "string"
        ? result.error
        : result.error?.message || "The request could not be completed.",
    );
    error.code = result.code;
    error.gate = result.gate;
    if (response.status === 401 && path !== "/api/pair") clearLocalSession();
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
function requirePair(action) {
  if (token) {
    action();
    return;
  }
  pendingAction = action;
  openDialog("pairDialog");
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
    if (!token) activity("Session ended. Pair your bridge to reconnect.");
    else console.warn("State refresh unavailable.");
  } finally {
    polling = false;
  }
}
function normalizeFaculties() {
  const all = state.agent?.faculties;
  let entries = Array.isArray(all)
    ? all
    : all
      ? [
          ...(all.modalities || []).map((f) => ({ ...f, kind: "modality" })),
          ...(all.senses || []).map((f) => ({ ...f, kind: "sense" })),
        ]
      : catalogue;
  return entries.map((f) => ({
    ...f,
    kind: cleanKind(f.kind),
    id: f.id ?? f.key,
  }));
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
  const modalities = faculties.filter((f) => f.kind === "modality"),
    senses = faculties.filter((f) => f.kind === "sense");
  $("availableCount").textContent = faculties.length || "—";
  $("modalityCount").textContent = modalities.length;
  $("senseCount").textContent = senses.length;
  const equipped = state.agent ? faculties.filter(isEquipped).length : 0;
  $("equippedCount").textContent = equipped;
  $("facultyStatus").textContent = state.agent
    ? `${equipped} EQUIPPED`
    : "LOADOUT";
  $("loadoutAbility").classList.toggle("active", equipped > 0);
  $("catalogueStatus").textContent = state.agent
    ? "LIVE AGENT\nCATALOGUE"
    : "BASE\nCATALOGUE";
  $("growthNote").textContent = state.agent
    ? "Your live catalogue refreshes as this agent learns. Loadout choices apply to its next turn."
    : "Your catalogue grows as your agent learns. Pair a chain to equip faculties.";
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
    const button = el(
      "button",
      `faculty-card${selected ? " equipped" : ""}${faculty.equippable === false ? " emerging" : ""}`,
    );
    button.type = "button";
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
    const meta = el("span", "faculty-meta");
    meta.append(
      el("span", "", (faculty.category || faculty.kind).toUpperCase()),
      el(
        "span",
        "",
        selected
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
      if (faculty.equippable === false) {
        toast(
          "This proposed faculty is still emerging. It becomes equippable after promotion.",
        );
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
  $("disconnectModel").classList.toggle("hidden", !state.provider?.configured);
  const id = agentId();
  $("bridgeDot").classList.toggle("online", paired);
  $("bridgeStatus").textContent = paired
    ? "LOCAL BRIDGE CONNECTED"
    : "LOCAL-FIRST WORKSPACE";
  $("pairButton").querySelector("span").textContent = paired
    ? "Bridge paired"
    : "Pair bridge";
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
  $("conversationTitle").textContent =
    paired && agent
      ? `${agent.name || "Your agent"} · The next ring`
      : "The next ring";
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
      `Every fruitage must meet the server-enforced minimum (${state.gate.threshold}/255), alongside native PoI acceptance. This workspace does not execute model-supplied commands or tools.`;
}
function renderConversation() {
  const messages = conversations.get(agentId()) || [];
  $("welcome").classList.toggle("hidden", messages.length > 0);
  const list = $("messages");
  list.replaceChildren();
  for (const message of messages) {
    const node = el(
      "article",
      `message ${message.role}${message.held ? " held" : ""}`,
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
          message.pending
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
      node.append(meta);
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
    }
    list.append(node);
  }
  requestAnimationFrame(() =>
    $("conversationScroll").scrollTo({
      top: messages.length ? $("conversationScroll").scrollHeight : 0,
      behavior: messages.length ? "smooth" : "instant",
    }),
  );
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
$("pairButton").addEventListener("click", () => openDialog("pairDialog"));
function clearLocalSession() {
  chatController?.abort();
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
  activeAgentId = null;
  $("apiKey").value = "";
  $("pairCode").value = "";
  $("messageInput").value = "";
  $("packJson").value = "";
  $("packFile").value = "";
  renderState();
  renderConversation();
  activity("Bridge disconnected. Pair again to continue your saved Timechain.");
}
$("endSession").addEventListener("click", async () => {
  const button = $("endSession");
  button.disabled = true;
  try {
    await api("/api/unpair", {});
    clearLocalSession();
    closeDialog("pairDialog");
    toast("Bridge session ended. Its model credential was cleared.");
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
    renderState();
    closeDialog("modelDialog");
    toast("Model disconnected. Its key was cleared from bridge memory.");
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
    const result = await api("/api/pair", { code: $("pairCode").value.trim() });
    token = result.token;
    $("pairCode").value = "";
    applyState(await api("/api/state"));
    closeDialog("pairDialog");
    toast("Local bridge paired.");
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
    toast("Existing Timechain verified and paired.");
    if (!state.provider?.configured) openModel();
  });
});
$("agentSelectButton").addEventListener("click", () =>
  requirePair(() => $("agentChoices").classList.toggle("hidden")),
);
function openModel() {
  const provider = state.provider || {};
  $("provider").value = provider.provider || "openai";
  $("modelId").value = provider.model || "";
  $("baseUrl").value = provider.baseUrl || "";
  $("apiKey").value = "";
  updateProviderPlaceholder();
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
      : "Held only in this bridge session";
}
$("provider").addEventListener("change", () => {
  $("baseUrl").value = "";
  $("modelId").value = "";
  updateProviderPlaceholder();
});
$("modelForm").addEventListener("submit", (event) => {
  event.preventDefault();
  runForm(event.currentTarget, async () => {
    const data = {
      provider: $("provider").value,
      model: $("modelId").value.trim(),
      baseUrl: $("baseUrl").value.trim() || $("baseUrl").placeholder,
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
  if (!message || requestBusy) return;
  if (!token) {
    requirePair(() => $("messageInput").focus());
    return;
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
  requestBusy = true;
  const chatSession = token;
  chatController = new AbortController();
  $("sendButton").disabled = true;
  $("messageInput").disabled = true;
  addMessage({ role: "user", content: message });
  $("messageInput").value = "";
  activity(
    settings().fork
      ? `Exploring ${settings().perspectives} perspectives · the response will appear after covenant review.`
      : "Recalling, generating, and checking the genesis covenant…",
    "busy",
  );
  try {
    const result = await api(
      "/api/chat",
      { message },
      { signal: chatController.signal },
    );
    if (token !== chatSession) return;
    if (result.state) applyState(result.state);
    const response = result.message || result;
    if (typeof response.content !== "string")
      throw new Error(
        "No accepted response was returned. Inspect the bridge before trying again.",
      );
    addMessage({ role: "assistant", input: message, ...response });
    activity(
      response.pending
        ? `Covenant accepted · ${bytes(state.pending?.bytes)} pending toward the next block.`
        : `Accepted and sealed${response.ring?.index !== undefined ? ` in ring ${response.ring.index}` : ""}.`,
    );
  } catch (error) {
    if (token !== chatSession) return;
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
        : "The request was not completed. No unreviewed answer was released.",
      "error",
    );
  } finally {
    chatController = null;
    requestBusy = false;
    $("sendButton").disabled = false;
    $("messageInput").disabled = false;
    $("messageInput").focus();
    await refreshState();
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
    `Up to ${2 * draftPerspectives + 2} model requests per turn. Standard chat uses 2.`;
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
        "The archetype catalogue is unavailable. Pair your bridge and try again.",
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
      await saveSettings({
        ...settings(),
        fork: $("forkEnabled").checked,
        perspectives: draftArchetypes.size,
        archetypes: [...draftArchetypes],
      });
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
    /^[1-6]$/.test(event.key)
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
  $("importPackButton").disabled = !ready;
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
  return normalizeFaculties().filter(
    (f) => ["grown", "imported"].includes(f.source) && f.equippable !== false,
  );
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
        `${faculty.kind.toUpperCase()} · ${faculty.source.toUpperCase()}${faculty.dormant ? " · DORMANT" : ""}`,
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
  if (file.size > 2 * 1024 * 1024) {
    toast(
      "This pack exceeds 2 MB. Share a smaller set of faculty definitions.",
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
    } else button.disabled = false;
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
      throw new Error("The bridge did not return a non-empty faculty pack.");
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
  licenseMethods = {},
  currentLicense = null,
  walletBusy = false;
function licenseMessage(info) {
  if (!info?.paymentsOpen)
    return "Local beta testing is open. Payments are not open; do not send CPHY directly.";
  if (info.status === "verification-unavailable")
    return "Activation could not be verified. Check your network and try again; do not pay again.";
  if (info.status === "choose-owner")
    return "Enter the seat owner's public wallet address to check an existing seat, or purchase a new seat with your wallet.";
  if (info.status === "active")
    return `Instance active. Seat ${info.verification?.seatId || "verified"}; Base L2 confirmation is provisional.`;
  return "This bridge has no active paid seat. Purchase one or rebind a seat owned by your wallet.";
}
function renderLicense(info) {
  currentLicense = info;
  $("licenseDeviceKey").value = info?.deviceKey || "";
  if (info?.selectedOwner) $("licenseOwner").value = info.selectedOwner;
  $("licenseStatus").textContent = licenseMessage(info);
  $("licenseSummary").textContent = licenseMessage(info);
  let enabled = false;
  try {
    validateDeployment(licenseDeployment);
    enabled = Boolean(
      info?.identityVerified &&
        info.paymentsOpen &&
        info.deviceKey &&
        info.status !== "verification-unavailable" &&
        matchingConfiguration(licenseDeployment, info.configuration),
    );
    if (
      info?.paymentsOpen &&
      !matchingConfiguration(licenseDeployment, info.configuration)
    )
      $("licenseError").textContent =
        "The website and bridge have different license settings. Update the bridge before paying.";
  } catch {}
  $("purchaseSeatsButton").disabled = !enabled || walletBusy;
  $("rotateSeatButton").disabled = !enabled || walletBusy;
  $("purchaseSeatsButton").textContent = enabled
    ? "Review purchase in wallet"
    : info?.paymentsOpen
      ? "Activation check required"
      : "Payments are not open";
  updateSeatTotal();
}
async function readLicense(owner) {
  const challenge = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  const info = await api("/api/license/check", {
    challenge,
    ...(owner ? { owner } : {}),
  });
  await verifyBridgeIdentity(info, challenge, location.origin);
  return { ...info, identityVerified: true };
}
async function showLicense() {
  openDialog("licenseDialog");
  $("licenseError").textContent = "";
  try {
    renderLicense(await readLicense());
  } catch (error) {
    $("licenseError").textContent = error.message;
  }
}
$("licenseButton").addEventListener("click", () => requirePair(showLicense));
$("loadAuditor").addEventListener("click", () => {
  $("auditFrame").src = "./audit/";
  $("auditFrame").classList.remove("hidden");
  $("loadAuditor").classList.add("hidden");
});
function updateSeatTotal() {
  const count =
    (currentLicense?.status === "active" ? 0 : 1) +
    $("additionalDeviceKeys").value.trim().split(/\s+/).filter(Boolean).length;
  $("seatPurchaseTotal").textContent =
    `${count} instance${count === 1 ? "" : "s"} / ${(count * 21000).toLocaleString()} CPHY`;
}
$("additionalDeviceKeys").addEventListener("input", updateSeatTotal);
$("checkLicenseButton").addEventListener("click", async () => {
  $("checkLicenseButton").disabled = true;
  $("licenseError").textContent = "";
  try {
    renderLicense(await readLicense($("licenseOwner").value.trim()));
  } catch (error) {
    $("licenseError").textContent = error.message;
  } finally {
    $("checkLicenseButton").disabled = false;
  }
});
async function walletAction(action) {
  if (walletBusy) return;
  walletBusy = true;
  renderLicense(currentLicense);
  $("licenseError").textContent = "";
  try {
    const result = await action((text) => {
      $("licenseStatus").textContent = text;
    });
    $("licenseOwner").value = result.owner;
    renderLicense(await readLicense(result.owner));
    $("licenseStatus").textContent =
      `Transaction included on Base: ${result.hash}. Wait for two confirmations, then choose Check activation.`;
  } catch (error) {
    $("licenseError").textContent =
      error.message || "Wallet request could not complete.";
  } finally {
    walletBusy = false;
    const pendingStatus = $("licenseStatus").textContent;
    renderLicense(currentLicense);
    $("licenseStatus").textContent = pendingStatus;
  }
}
$("purchaseSeatsForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const keys = [
    ...(currentLicense?.status === "active" ? [] : [currentLicense?.deviceKey]),
    ...$("additionalDeviceKeys").value.trim().split(/\s+/).filter(Boolean),
  ];
  walletAction((report) =>
    purchaseBoundSeats({
      config: licenseDeployment,
      methods: licenseMethods,
      wallet: window.ethereum,
      keys,
      report,
    }),
  );
});
$("rotateSeatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  walletAction((report) =>
    rebindSeat({
      config: licenseDeployment,
      methods: licenseMethods,
      wallet: window.ethereum,
      seatId: $("rotateSeatId").value.trim(),
      key: currentLicense?.deviceKey,
      report,
    }),
  );
});
async function start() {
  initMotifs();
  renderState();
  $("hostedBridgeSetup").classList.toggle("hidden", localBridgePage);
  $("bridgePort").disabled = localBridgePage || ["cyphertempre.ai","www.cyphertempre.ai"].includes(location.hostname);
  $("bridgePort").value = selectedBridgePort;
  $("hostedOrigin").textContent = location.origin;
  try {
    const [config, registry] = await Promise.all([
      fetch("./license-config.json", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      }).then((r) => r.json()),
      fetch("./seat-registry.json", {
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      }).then((r) => r.json()),
    ]);
    licenseDeployment = config;
    licenseMethods = registry.methodIdentifiers || {};
    $("licenseSummary").textContent = config.required
      ? "Pair a local bridge to check its paid instance. One seat costs 21,000 CPHY on Base."
      : "Local beta testing is open. Paid activation is not open yet.";
  } catch {
    $("licenseSummary").textContent =
      "Payment configuration unavailable. Do not send tokens.";
  }
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
    $("bridgeStatus").textContent = "PAIR YOUR LOCAL BRIDGE";
    activity("Pair your local bridge to connect your Timechain.");
    setInterval(refreshState, 10000);
    return;
  }
  try {
    const status = await api("/api/status");
    $("bridgeStatus").textContent = "LOCAL BRIDGE READY";
    if (status.version) $("appVersion").textContent = `v${status.version}`;
  } catch {
    activity("Start the local bridge to connect your agent.", "error");
    $("bridgeStatus").textContent = "BRIDGE OFFLINE";
  }
  try {
    const result = await api("/api/archetypes");
    if (result.archetypes?.length) archetypes = result.archetypes;
  } catch {}
  setInterval(refreshState, 10000);
}
start();
