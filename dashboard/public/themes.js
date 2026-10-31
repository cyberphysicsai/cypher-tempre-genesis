// Only a visual preference is persisted. Authentication and model keys do not
// belong in this module or its storage entry.
export const THEME_STORAGE_KEY = 'cypher-tempre.visual-mode.v1';
export const THEMES = Object.freeze(['dark', 'light', 'matrix']);
export const MOTIF_PALETTES = Object.freeze({
  dark: Object.freeze({ main: '238, 238, 238', secondary: '214, 214, 214', soft: '170, 170, 170' }),
  light: Object.freeze({ main: '23, 27, 25', secondary: '55, 63, 59', soft: '86, 96, 91' }),
  matrix: Object.freeze({ main: '101, 255, 145', secondary: '57, 229, 108', soft: '29, 173, 74' }),
});
const BAR_COLORS = Object.freeze({ dark: '#080808', light: '#f7f7f7', matrix: '#010803' });

export function normalizeTheme(value) {
  return THEMES.includes(value) ? value : 'dark';
}
export function motifPalette(value) { return MOTIF_PALETTES[normalizeTheme(value)]; }
export function storedTheme(storage) {
  try { return normalizeTheme(storage?.getItem(THEME_STORAGE_KEY)); } catch { return 'dark'; }
}

export function initThemes({ document: doc = globalThis.document, window: view = globalThis.window, storage } = {}) {
  if (!doc?.documentElement || !view) return null;
  if (storage === undefined) try { storage = view.localStorage; } catch { storage = null; }
  let current = storedTheme(storage);
  const buttons = [...doc.querySelectorAll('[data-theme-choice]')];
  const frame = doc.getElementById('auditFrame');
  const sendToAudit = () => {
    try { frame?.contentWindow?.postMessage({ type: 'chainchat-theme', theme: current }, view.location.origin); } catch {}
  };
  function apply(value, persist = true) {
    current = normalizeTheme(value);
    doc.documentElement.dataset.theme = current;
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.themeChoice === current));
    doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', BAR_COLORS[current]);
    if (persist) try { storage?.setItem(THEME_STORAGE_KEY, current); } catch {}
    view.dispatchEvent(new view.CustomEvent('chainchat-theme-change', { detail: { theme: current } }));
    sendToAudit();
    return current;
  }
  for (const button of buttons) button.addEventListener('click', () => apply(button.dataset.themeChoice));
  view.addEventListener('storage', event => { if (event.key === THEME_STORAGE_KEY) apply(event.newValue, false); });
  view.addEventListener('message', event => {
    // The embedded auditor accepts presentation only from its exact parent.
    if (view.parent !== view && event.source === view.parent && event.origin === view.location.origin &&
        event.data?.type === 'chainchat-theme' && THEMES.includes(event.data.theme)) apply(event.data.theme, false);
  });
  frame?.addEventListener('load', sendToAudit);
  const measureChrome = () => {
    const topbar = doc.querySelector('.topbar'), notice = doc.querySelector('.responsibility-notice');
    if (!topbar || !notice) return;
    const height = Math.ceil(topbar.getBoundingClientRect().height + notice.getBoundingClientRect().height);
    if (height > 0 && Number.isFinite(height)) doc.documentElement.style.setProperty('--app-chrome-height', `${height}px`);
  };
  if (view.ResizeObserver) {
    const observer = new view.ResizeObserver(measureChrome);
    for (const node of [doc.querySelector('.topbar'), doc.querySelector('.responsibility-notice')]) if (node) observer.observe(node);
  }
  view.addEventListener('resize', measureChrome);
  apply(current, false);
  measureChrome();
  return { apply, current: () => current };
}
