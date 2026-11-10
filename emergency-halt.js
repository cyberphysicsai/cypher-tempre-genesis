import { HALT_CPHY_TOKEN } from "./emergency-halt-protocol.js";

const address = /^0x[0-9a-f]{40}$/i;

export function downloadHaltJson(document, filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountEmergencyHalt({ document, api, local, connected, requireConnection, onChange, onError }) {
  const byId = id => document.getElementById(id);
  const controls = byId("emergencyHaltControls");
  if (!controls) return null;
  const banner = byId("emergencyHaltBanner");
  const stop = byId("emergencyHaltStop");
  const manage = byId("emergencyHaltManage");
  const dialog = byId("emergencyHaltDialog");
  const dialogStop = byId("emergencyHaltDialogStop");
  const rearm = byId("emergencyHaltRearm");
  const status = byId("emergencyHaltStatus");
  const form = byId("emergencyHaltRemoteForm");
  const wallet = byId("emergencyHaltWallet");
  const feed = byId("emergencyHaltFeed");
  const destination = byId("emergencyHaltDestination");
  const disableRemote = byId("emergencyHaltDisableRemote");
  const profileControls = byId("emergencyHaltProfileControls");
  const exportProfile = byId("emergencyHaltExport");
  const error = byId("emergencyHaltError");
  byId("emergencyHaltToken").textContent = HALT_CPHY_TOKEN;

  let view = null, details = null, busy = "", stopping = false, blocked = false;

  function render() {
    const halted = view?.halted === true;
    const transitioning = !!view?.transitioning;
    const storageError = !!view?.storageError;
    const locked = halted || transitioning || storageError || stopping;
    const owner = local && connected();
    controls.hidden = !local || (!view && !owner);
    stop.hidden = dialogStop.hidden = halted && !view.stopError && view.transitioning !== "rearming" && busy !== "rearm";
    stop.disabled = dialogStop.disabled = stopping || view?.transitioning === "halting";
    stop.textContent = view?.stopError ? "Retry emergency halt" : "Emergency halt";
    manage.textContent = halted ? "Re-arm & settings" : "Halt settings";
    rearm.hidden = !halted;
    rearm.disabled = !owner || !!busy || stopping || transitioning || storageError || !!view?.stopError;
    banner.hidden = !locked;
    const pending = !stopping && (busy === "rearm" || view?.transitioning === "rearming")
      ? "Verifying the Timechain and Proof of Interaction before re-arming…"
      : "Stopping work through the local supervisor…";
    const haltedText = "Emergency Halt is active. ChainChat work is blocked.";
    banner.textContent = storageError ? "Emergency Halt storage needs attention. Open the installed app to review it."
      : transitioning || stopping ? pending
        : halted ? haltedText + (local ? "" : " Open the installed app to re-arm.") : "";
    status.textContent = storageError ? "The supervisor cannot confirm its saved halt state."
      : transitioning || stopping || busy === "rearm" ? pending
        : halted ? haltedText + (view.stopError ? " An owned runtime did not stop cleanly." : "")
          : view ? "Ready to halt. Local halt works without a wallet or an internet connection." : "Checking local supervisor…";
    for (const input of form.querySelectorAll("input, button")) input.disabled = !owner || !!busy || stopping || !details || transitioning;
    disableRemote.hidden = !details?.config;
    profileControls.hidden = !details?.config || locked;
    exportProfile.disabled = !owner || !!busy;
    if (locked !== blocked) {
      blocked = locked;
      onChange(locked);
    }
  }

  function sync(next) {
    if (!next || typeof next.halted !== "boolean") return false;
    if (Number.isSafeInteger(view?.revision) && Number.isSafeInteger(next.revision) && next.revision < view.revision)
      return false;
    if (details?.profile && (next.halted || next.transitioning || next.revision !== view?.revision)) {
      // Reload the full owner view before exporting a nonce after an external change.
      details = { ...details, profile: null };
    }
    view = { halted: next.halted, transitioning: next.transitioning, stopError: next.stopError,
      storageError: next.storageError, revision: next.revision };
    render();
    return true;
  }

  function applyDetails(next, { setFields = false } = {}) {
    if (!sync(next)) return;
    details = { profile: next.profile || null, config: next.config || null };
    if (setFields) {
      wallet.value = details.config?.wallet || "";
      feed.value = details.config?.feedUrl || "";
      destination.value = details.config?.cphyDestination || "";
    }
    render();
  }

  async function perform(operation, input, setFields = operation === "load" || operation === "configure") {
    const isStop = operation === "stop";
    if (!local || !connected() || stopping || (isStop ? view?.transitioning === "halting" : busy)) return;
    if (isStop) stopping = true;
    else busy = operation;
    error.textContent = "";
    render();
    try {
      const path = operation === "load" ? "/api/emergency-halt" : `/api/emergency-halt/${operation}`;
      const next = await api(path, input);
      if (connected()) applyDetails(next, { setFields });
      return connected();
    } catch (failure) {
      if (isStop || operation === "rearm") {
        // Shutdown can fail after the latch is set. Confirm the owner state.
        try { if (connected()) applyDetails(await api("/api/emergency-halt")); } catch {}
      }
      if (dialog.open) error.textContent = failure.message;
      else onError(failure.message);
    } finally {
      if (isStop) stopping = false;
      else busy = "";
      render();
    }
  }

  function halt() {
    if (local) requireConnection(() => { void perform("stop", { confirm: true }); });
  }
  stop.addEventListener("click", halt);
  dialogStop.addEventListener("click", halt);
  manage.addEventListener("click", () => {
    if (!local) return;
    requireConnection(() => {
      error.textContent = "";
      if (!dialog.open) dialog.showModal();
      void perform("load");
    });
  });
  rearm.addEventListener("click", () => { void perform("rearm", { confirm: true }); });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const owner = wallet.value.trim();
    const cphyDestination = destination.value.trim();
    if (!address.test(owner) || (cphyDestination && !address.test(cphyDestination))) {
      error.textContent = "Enter valid Ethereum wallet addresses.";
      return;
    }
    void perform("configure", { config: {
      wallet: owner, feedUrl: feed.value.trim(), ...(cphyDestination ? { cphyDestination } : {}),
    } });
  });
  disableRemote.addEventListener("click", () => { void perform("configure", { config: null }); });
  exportProfile.addEventListener("click", async () => {
    if (busy || !local || !connected()) return;
    if (await perform("load", undefined, false) && details?.profile && !blocked)
      downloadHaltJson(document, "chainchat-halt-profile.json", details.profile);
  });
  render();
  return {
    sync,
    syncConnection() {
      if (!connected()) {
        details = null;
        if (view) view.revision = undefined;
      }
      render();
    },
  };
}
