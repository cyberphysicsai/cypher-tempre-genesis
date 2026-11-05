// This entry stores one visual preference only. Model, wallet, chain and
// authentication data never belong in font preferences or presentation messages.
export const FONT_MODE_STORAGE_KEY = 'cypher-tempre.font-mode.v1';
export const FONT_MODES = Object.freeze(['cyber', 'typewriter', 'clarity']);

export function normalizeFontMode(value) {
  return FONT_MODES.includes(value) ? value : 'cyber';
}
export function storedFontMode(storage) {
  try { return normalizeFontMode(storage?.getItem(FONT_MODE_STORAGE_KEY)); }
  catch { return 'cyber'; }
}

export function initFontModes({ document: doc = globalThis.document, window: view = globalThis.window, storage } = {}) {
  if (!doc?.documentElement || !view) return null;
  if (storage === undefined) try { storage = view.localStorage; } catch { storage = null; }
  let current = storedFontMode(storage);
  const buttons = [...doc.querySelectorAll('[data-font-choice]')];
  const frame = doc.getElementById('auditFrame');
  const sendToAudit = () => {
    try { frame?.contentWindow?.postMessage({ type: 'chainchat-font-mode', mode: current }, view.location.origin); } catch {}
  };
  function apply(value, persist = true) {
    current = normalizeFontMode(value);
    doc.documentElement.dataset.fontMode = current;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.fontChoice === current));
    if (persist) try { storage?.setItem(FONT_MODE_STORAGE_KEY, current); } catch {}
    view.dispatchEvent(new view.CustomEvent('chainchat-font-mode-change', { detail: { mode: current } }));
    sendToAudit();
    return current;
  }
  for (const button of buttons) button.addEventListener('click', () => apply(button.dataset.fontChoice));
  view.addEventListener('storage', event => {
    if (event.key === FONT_MODE_STORAGE_KEY || event.key === null) apply(event.newValue, false);
  });
  view.addEventListener('message', event => {
    // An embedded auditor accepts only its exact parent's same-origin,
    // whitelisted presentation choice; child frames cannot pilot the parent.
    if (view.parent !== view && event.source === view.parent && event.origin === view.location.origin &&
        event.data?.type === 'chainchat-font-mode' && FONT_MODES.includes(event.data.mode)) apply(event.data.mode, false);
  });
  frame?.addEventListener('load', sendToAudit);
  apply(current, false);
  return { apply, current: () => current };
}
