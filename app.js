const state = {
  summary: null,
  learning: null,
  rings: [],
  selectedRing: null,
  hostedMode: false,
  bridgeBase: '',
  bridgeToken: '',
  bridgeBound: false,
  dashboardBound: false,
};

const $ = (id) => document.getElementById(id);
const LOCAL_PAGE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ASSET_VERSION = '20260611-atomicage';

function isLocalPage() {
  return LOCAL_PAGE_HOSTS.has(window.location.hostname);
}

function cleanBridgeBase(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function setupBridgeState() {
  const params = new URLSearchParams(window.location.search);
  state.hostedMode = !isLocalPage() || Boolean(params.get('bridge'));
  state.bridgeBase = state.hostedMode
    ? cleanBridgeBase(params.get('bridge') || localStorage.getItem('ctBridgeBase') || 'http://127.0.0.1:8788')
    : '';
  state.bridgeToken = state.hostedMode ? localStorage.getItem('ctBridgeToken') || '' : '';
  if ($('bridgeUrl')) $('bridgeUrl').value = state.bridgeBase || 'http://127.0.0.1:8788';
}

function initMotifs() {
  const canvas = $('motifCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mid-century Atomic Age palette: cream linework with brass and dusty-teal
  // accents, every alpha kept low — the dashboard is the subject, this is the
  // wallpaper of a 1950s physics department.
  const CREAM = '238, 232, 213';
  const BRASS = '214, 168, 96';
  const TEAL = '124, 181, 169';
  const stroke = (rgb, alpha, w = 1) => {
    ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
    ctx.lineWidth = w;
  };
  const fill = (rgb, alpha) => {
    ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
  };
  const dot = (x, y, r) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  let width = 0;
  let height = 0;
  let dpr = 1;
  let animationId = null;

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- Bohr atom: precessing elliptical shells, ball electrons with comet tails ---
  function drawAtom(cx, cy, radius, phase) {
    ctx.save();
    ctx.translate(cx, cy);
    [0, Math.PI / 3, -Math.PI / 3].forEach((rotation, i) => {
      ctx.save();
      ctx.rotate(rotation + Math.sin(phase * 0.35 + i * 1.4) * 0.07);
      stroke(CREAM, 0.15, 1);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 1.22, radius * 0.36, 0, 0, Math.PI * 2);
      ctx.stroke();
      const accent = i === 1 ? TEAL : BRASS;
      const t = phase * (0.7 + i * 0.23) + i * 2.1;
      stroke(accent, 0.2, 1.2);
      ctx.beginPath();
      for (let k = 8; k >= 1; k -= 1) {
        const tt = t - k * 0.055;
        const xx = Math.cos(tt) * radius * 1.22;
        const yy = Math.sin(tt) * radius * 0.36;
        if (k === 8) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
      fill(accent, 0.55);
      dot(Math.cos(t) * radius * 1.22, Math.sin(t) * radius * 0.36, 2.6);
      ctx.restore();
    });
    fill(CREAM, 0.5);
    for (let i = 0; i < 3; i += 1) {
      const a = phase * 0.5 + (i * Math.PI * 2) / 3;
      dot(Math.cos(a) * 3.4, Math.sin(a) * 3.4, 2.1);
    }
    ctx.restore();
  }

  // --- Sputnik starburst: the 1950s atomic spark, drifting in slow rotation ---
  function drawStarburst(cx, cy, radius, phase) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(phase * 0.12);
    for (let i = 0; i < 12; i += 1) {
      const a = (i * Math.PI * 2) / 12;
      const r = radius * (i % 2 ? 0.6 : 1);
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      stroke(CREAM, 0.13, 1);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 4, Math.sin(a) * 4);
      ctx.lineTo(x, y);
      ctx.stroke();
      fill(CREAM, i % 3 === 0 ? 0.32 : 0.18);
      dot(x, y, i % 2 ? 1.3 : 2);
    }
    ctx.restore();
  }

  // --- Double helix: scrolling ribbon, alternating brass/teal base pairs,
  //     near strand drawn brighter than the far one for quiet depth ---
  function drawDna(x, y, heightPx, amplitude, phase) {
    const period = 92;
    const scroll = phase * 16;
    const steps = Math.max(30, Math.floor(heightPx / 9));
    for (const dir of [1, -1]) {
      ctx.beginPath();
      for (let i = 0; i <= steps; i += 1) {
        const yy = y + (heightPx * i) / steps;
        const xx = x + dir * Math.sin((yy + scroll) / period) * amplitude;
        if (i === 0) ctx.moveTo(xx, yy);
        else ctx.lineTo(xx, yy);
      }
      stroke(CREAM, dir === 1 ? 0.24 : 0.13, 1.25);
      ctx.stroke();
    }
    let rung = 0;
    for (let yy = y + 14; yy < y + heightPx; yy += 26, rung += 1) {
      const s = Math.sin((yy + scroll) / period) * amplitude;
      if (Math.abs(s) < amplitude * 0.22) continue;       // skip the crossover knots
      stroke(CREAM, 0.12, 1);
      ctx.beginPath();
      ctx.moveTo(x + s, yy);
      ctx.lineTo(x - s, yy);
      ctx.stroke();
      const accent = rung % 2 ? TEAL : BRASS;
      fill(accent, 0.42);
      dot(x + s, yy, 1.9);
      fill(accent, 0.26);
      dot(x - s, yy, 1.6);
    }
  }

  // --- Timechain: sealed blocks on a slow conveyor along a shallow arc;
  //     the head block periodically seals with a soft expanding ring ---
  function drawTimechain(x, y, count, spacing, phase, dir = 1) {
    const offset = ((phase * 12) % spacing) * dir;
    let previous = null;
    for (let i = 0; i < count; i += 1) {
      const px = x + i * spacing - offset;
      const py = y + Math.sin((px / 110) + phase * 0.4) * 8;
      if (previous) {
        stroke(CREAM, 0.16, 1);
        ctx.beginPath();
        ctx.moveTo(previous.x + 18, previous.y + 9);
        ctx.lineTo(px, py + 9);
        ctx.stroke();
        fill(CREAM, 0.3);
        dot((previous.x + 18 + px) / 2, (previous.y + py) / 2 + 9, 1.1);
      }
      stroke(CREAM, 0.26, 1.1);
      ctx.strokeRect(px, py, 18, 18);
      fill(BRASS, 0.22);
      ctx.fillRect(px + 6.5, py + 6.5, 5, 5);
      previous = { x: px, y: py };
    }
    // the newest block seals: a quiet ring pulse, like an oscilloscope ping
    const pulse = (phase * 0.45) % 1;
    if (previous && pulse < 0.7) {
      stroke(BRASS, 0.28 * (1 - pulse / 0.7), 1.2);
      ctx.beginPath();
      ctx.arc(previous.x + 9, previous.y + 9, 12 + pulse * 26, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // --- Lissajous: oscilloscope trace with a slowly drifting phase ratio ---
  function drawLissajous(cx, cy, w, h, phase) {
    stroke(TEAL, 0.15, 1.1);
    ctx.beginPath();
    const delta = phase * 0.22;
    for (let i = 0; i <= 220; i += 1) {
      const t = (i / 220) * Math.PI * 2;
      const xx = cx + Math.sin(3 * t + delta) * w;
      const yy = cy + Math.sin(2 * t) * h;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    const t0 = (phase * 0.8) % (Math.PI * 2);
    fill(BRASS, 0.45);
    dot(cx + Math.sin(3 * t0 + delta) * w, cy + Math.sin(2 * t0) * h, 2);
  }

  function render(time = 0) {
    const phase = time * 0.00045;
    ctx.clearRect(0, 0, width, height);
    drawAtom(width * 0.14, height * 0.18, Math.min(110, width * 0.11), phase);
    drawAtom(width * 0.87, height * 0.8, Math.min(86, width * 0.08), -phase * 0.8);
    drawStarburst(width * 0.92, height * 0.12, Math.min(46, width * 0.045), phase);
    drawStarburst(width * 0.07, height * 0.86, Math.min(36, width * 0.04), -phase * 0.7);
    drawDna(width * 0.8, Math.max(-30, height * 0.06), height * 0.66, Math.min(42, width * 0.04), phase);
    drawDna(width * 0.1, height * 0.46, height * 0.5, Math.min(32, width * 0.032), -phase * 0.65);
    drawTimechain(width * 0.3, height * 0.06, 6, 44, phase);
    drawTimechain(width * 0.55, height * 0.93, 5, 48, phase * 0.8, -1);
    drawLissajous(width * 0.4, height * 0.78, Math.min(70, width * 0.06), Math.min(34, width * 0.028), phase);
    if (!reducedMotion) animationId = window.requestAnimationFrame(render);
  }

  resize();
  window.addEventListener('resize', () => {
    resize();
    if (reducedMotion) render(0);
  });
  render(0);
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function formatNumber(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return new Intl.NumberFormat().format(Number(value));
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes || 0);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function shortHash(hash) {
  return hash ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : '—';
}

async function api(path, options = {}) {
  const response = await fetch(`${state.bridgeBase}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(state.bridgeToken ? { 'x-ct-bridge-token': state.bridgeToken } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function init() {
  setupBridgeState();
  $('dashboard').classList.add('hidden');
  if (state.hostedMode && !(await ensureBridgePaired())) return;
  await unlockDashboard();
}

async function ensureBridgePaired() {
  bindBridgeGate();
  $('bridgeGate').classList.remove('hidden');
  try {
    const status = await api('/api/bridge/status');
    if (status.paired) {
      setText('bridgeState', `Bridge paired on ${state.bridgeBase}`);
      $('bridgeGate').classList.add('hidden');
      return true;
    }
    setText('bridgeState', `Bridge found on ${state.bridgeBase}`);
    setText('bridgeMessage', 'Enter the pairing code printed in the local bridge terminal.');
    return false;
  } catch (error) {
    setText('bridgeState', 'Bridge disconnected');
    setText('bridgeMessage', `Start the local bridge, then check again. ${error.message}`);
    return false;
  }
}

function bindBridgeGate() {
  if (state.bridgeBound) return;
  state.bridgeBound = true;
  $('checkBridge').addEventListener('click', checkBridge);
  $('pairBridge').addEventListener('click', pairBridge);
}

async function checkBridge() {
  state.bridgeBase = cleanBridgeBase($('bridgeUrl').value);
  localStorage.setItem('ctBridgeBase', state.bridgeBase);
  try {
    const status = await api('/api/bridge/status');
    setText('bridgeState', status.paired ? `Bridge paired on ${state.bridgeBase}` : `Bridge found on ${state.bridgeBase}`);
    setText('bridgeMessage', status.paired ? 'Bridge ready.' : 'Enter the pairing code printed in the local bridge terminal.');
  } catch (error) {
    setText('bridgeState', 'Bridge disconnected');
    setText('bridgeMessage', error.message);
  }
}

async function pairBridge() {
  state.bridgeBase = cleanBridgeBase($('bridgeUrl').value);
  localStorage.setItem('ctBridgeBase', state.bridgeBase);
  try {
    const result = await api('/api/bridge/pair', {
      method: 'POST',
      body: JSON.stringify({ code: $('pairCode').value }),
    });
    state.bridgeToken = result.bridgeToken;
    localStorage.setItem('ctBridgeToken', state.bridgeToken);
    setText('bridgeState', `Bridge paired on ${state.bridgeBase}`);
    setText('bridgeMessage', 'Bridge ready.');
    await init();
  } catch (error) {
    setText('bridgeMessage', error.message);
  }
}

async function unlockDashboard() {
  $('bridgeGate').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  await loadDashboard();
}

async function loadDashboard() {
  state.summary = await api('/api/timechain/summary');
  renderSummary();
  loadLearning();
  loadObservatory();
  await loadRings();
  await loadBlockspace();
  if (state.dashboardBound) return;
  state.dashboardBound = true;
  $('ringSearch').addEventListener('input', debounce(loadRings, 200));
  $('ringType').addEventListener('change', loadRings);
  $('closeBlob').addEventListener('click', () => $('blobDialog').close());
  bindObservatory();
}

function renderSummary() {
  const { stats, verification } = state.summary;
  setText('rootPath', state.summary.root);
  const statItems = [
    ['Rings', stats.rings],
    ['Modalities', stats.modalities],
    ['Senses', stats.senses],
    ['Blockspace', stats.blockspaceEntries],
    ['Context Tokens', stats.approxContinuumTokens],
    ['Integrity', verification.ok ? 'PASS' : 'FAIL'],
  ];
  $('statsGrid').replaceChildren(...statItems.map(([label, value]) => {
    const div = document.createElement('div');
    div.className = 'stat';
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = typeof value === 'number' ? formatNumber(value) : value;
    div.append(span, strong);
    return div;
  }));

  const typeSelect = $('ringType');
  typeSelect.replaceChildren(new Option('All types', ''));
  for (const item of state.summary.ringTypes) {
    const opt = document.createElement('option');
    opt.value = item.name;
    opt.textContent = `${item.name} (${item.count})`;
    typeSelect.append(opt);
  }

  renderDomains();
  renderFacultyBars('modalityBars', state.summary.modalityCategories, stats.modalities);
  renderFacultyBars('senseBars', state.summary.senseCategories, stats.senses);
  setText('facultyMeta', `${stats.modalities} modalities · ${stats.senses} senses · ${stats.emergent} emergent`);
}

function renderDomains() {
  const list = $('domainList');
  const domains = state.summary.domains || [];
  setText('domainMeta', `${domains.length} detected`);
  if (!domains.length) {
    list.textContent = 'No confident domains detected.';
    return;
  }
  const maxScore = Math.max(...domains.map((d) => d.score));
  list.replaceChildren(...domains.map((domain) => {
    const row = document.createElement('article');
    row.className = 'domain-row';
    const top = document.createElement('div');
    top.className = 'domain-top';
    const name = document.createElement('strong');
    name.textContent = domain.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${domain.ringCount} rings · ${formatNumber(domain.approxTokens)} est. tokens`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(4, (domain.score / maxScore) * 100)}%`;
    const tags = document.createElement('div');
    tags.className = 'tags';
    tags.textContent = domain.evidenceTerms.map((x) => `${x.term} ×${x.count}`).join(' · ');
    top.append(name, meta);
    bar.append(fill);
    row.append(top, bar, tags);
    return row;
  }));
}

function renderFacultyBars(id, items, total) {
  const root = $(id);
  const max = Math.max(1, ...items.map((x) => x.count));
  root.replaceChildren(...items.slice(0, 8).map((item) => {
    const div = document.createElement('div');
    div.className = 'faculty-item';
    const label = document.createElement('div');
    label.className = 'faculty-label';
    const left = document.createElement('span');
    left.textContent = item.name;
    const right = document.createElement('span');
    right.textContent = `${item.count}/${total}`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${(item.count / max) * 100}%`;
    label.append(left, right);
    bar.append(fill);
    div.append(label, bar);
    return div;
  }));
}

async function loadRings() {
  const q = encodeURIComponent($('ringSearch').value.trim());
  const type = encodeURIComponent($('ringType').value);
  const data = await api(`/api/timechain/rings?q=${q}&type=${type}`);
  state.rings = data.rings;
  renderRings();
}

function renderRings() {
  const list = $('ringList');
  list.replaceChildren(...state.rings.map((ring) => {
    const row = document.createElement('article');
    row.className = `ring-row${state.selectedRing?.index === ring.index ? ' active' : ''}`;
    row.addEventListener('click', () => selectRing(ring.index));
    const top = document.createElement('div');
    top.className = 'ring-top';
    const title = document.createElement('strong');
    title.textContent = `#${ring.index} ${ring.type}`;
    const brightness = document.createElement('span');
    brightness.className = 'meta';
    brightness.textContent = ring.brightness == null ? 'b=—' : `b=${Number(ring.brightness).toFixed(1)}`;
    const summary = document.createElement('div');
    summary.className = 'meta';
    summary.textContent = ring.summary;
    const tags = document.createElement('div');
    tags.className = 'tags';
    tags.textContent = [...(ring.keywords || []).slice(0, 8), ...(ring.entities || []).slice(0, 4)].join(' · ');
    top.append(title, brightness);
    row.append(top, summary, tags);
    return row;
  }));
}

async function selectRing(index, { scroll = false } = {}) {
  const panel = $('ringDetail');
  let ring;
  try {
    ring = await api(`/api/timechain/rings/${index}`);
  } catch (error) {
    // Click surfaces (leader rows, preview rows, the landscape canvas) call this
    // without awaiting — report in the panel instead of an unhandled rejection.
    panel.querySelector('h3').textContent = `Ring #${index}`;
    panel.querySelector('pre').textContent = `Could not load ring #${index}: ${error.message}`;
    return;
  }
  state.selectedRing = ring;
  renderRings();
  panel.querySelector('h3').textContent = `Ring #${ring.index} · ${ring.ring_type || ring.type}`;
  renderRingCphyChips(ring.index);
  panel.querySelector('pre').textContent = JSON.stringify(ring, null, 2);
  if (scroll) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function loadBlockspace() {
  const data = await api('/api/blockspace');
  setText('blockspaceMeta', `${data.total} entries · ${formatBytes(data.totalBytes)}`);
  const list = $('blockspaceList');
  list.replaceChildren(...data.entries.slice(0, 80).map((blob) => {
    const row = document.createElement('article');
    row.className = 'blob-row';
    const wrap = document.createElement('div');
    const top = document.createElement('div');
    top.className = 'blob-top';
    const name = document.createElement('strong');
    name.textContent = blob.filename || shortHash(blob.hash);
    const size = document.createElement('span');
    size.className = 'meta';
    size.textContent = formatBytes(blob.size);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${shortHash(blob.hash)} · ${blob.mime || 'unknown mime'}`;
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = 'Preview';
    button.addEventListener('click', () => previewBlob(blob.hash));
    top.append(name, size);
    wrap.append(top, meta);
    row.append(wrap, button);
    return row;
  }));
}

async function previewBlob(hash) {
  const blob = await api(`/api/blockspace/${hash}`);
  const label = [
    `hash: ${blob.hash}`,
    `size: ${formatBytes(blob.size)}`,
    `verified: ${blob.verified ? 'yes' : 'no'}`,
    blob.text ? '' : 'binary preview unavailable',
    blob.truncated ? 'preview truncated' : '',
    '',
    blob.preview || '',
  ].filter((line) => line !== null).join('\n');
  $('blobPreview').textContent = label;
  $('blobDialog').showModal();
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

initMotifs();

init().catch((error) => {
  // Both branches surface through the bridge gate — there is no separate #gate
  // element (a local audit still shows the pairing/onboarding shell on failure).
  $('bridgeGate').classList.remove('hidden');
  $('dashboard').classList.add('hidden');
  setText('bridgeMessage', error.message);
});


// --------------------------------------------------------------------------- //
// P1 — the learning membrane panels: integrity triptych, operators, dreams,
// economics. Dependency-free; charts are inline SVG.
// --------------------------------------------------------------------------- //

async function loadLearning() {
  try {
    state.learning = await api('/api/learning/overview');
  } catch {
    state.learning = null;
  }
  renderLearning();
}

function setIntegrityCard(id, status, strongText, metaText) {
  const card = $(id);
  card.classList.remove('ok', 'fail', 'na');
  card.classList.add(status === true ? 'ok' : status === false ? 'fail' : 'na');
  card.querySelector('strong').textContent = strongText;
  card.querySelector('.meta').textContent = metaText;
}

function sparkline(points, { width = 520, height = 96 } = {}) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.classList.add('sparkline');
  if (!points || points.length < 2) {
    const t = document.createElementNS(ns, 'text');
    t.setAttribute('x', 8);
    t.setAttribute('y', height / 2);
    t.textContent = points && points.length ? 'one data point — keep operating' : 'no data yet — keep operating';
    svg.append(t);
    return svg;
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x) => (x1 === x0 ? width / 2 : 8 + ((x - x0) / (x1 - x0)) * (width - 16));
  const sy = (y) => (y1 === y0 ? height / 2 : height - 14 - ((y - y0) / (y1 - y0)) * (height - 28));
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', points.map((p) => `${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(' '));
  svg.append(poly);
  const lo = document.createElementNS(ns, 'text');
  lo.setAttribute('x', 8);
  lo.setAttribute('y', height - 2);
  lo.textContent = `${y0}`;
  const hi = document.createElementNS(ns, 'text');
  hi.setAttribute('x', 8);
  hi.setAttribute('y', 12);
  hi.textContent = `${y1}`;
  svg.append(lo, hi);
  return svg;
}

function learningRow(title, metaText, tagsText) {
  const row = document.createElement('article');
  row.className = 'domain-row';
  const top = document.createElement('div');
  top.className = 'domain-top';
  const name = document.createElement('strong');
  name.textContent = title;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = metaText;
  top.append(name, meta);
  row.append(top);
  if (tagsText) {
    const tags = document.createElement('div');
    tags.className = 'tags';
    tags.textContent = tagsText;
    row.append(tags);
  }
  return row;
}

function renderLearning() {
  const data = state.learning;
  if (!data) {
    setText('learningMeta', 'learning overview unavailable');
    return;
  }
  const { chain, consensus, digests } = data.integrity;

  setIntegrityCard('intChain', chain.ok,
    chain.ok === true ? 'VERIFIED' : chain.ok === false ? 'TAMPERED' : 'UNKNOWN',
    chain.rings == null ? (chain.report?.[0] || '') : `${chain.rings} rings hash-linked`);
  setIntegrityCard('intQuorum',
    consensus.configured ? consensus.ok : null,
    !consensus.configured ? 'NOT CONFIGURED' : consensus.ok === true ? 'ATTESTED' : consensus.ok === false ? 'BROKEN' : 'UNKNOWN',
    consensus.configured
      ? `${consensus.validWitnesses ?? '—'}/${consensus.witnesses ?? '—'} witnesses valid (quorum ${consensus.quorum ?? '—'})`
      : 'run consensus.py init to add witnesses');
  setIntegrityCard('intDigests',
    digests.present ? digests.ok : null,
    !digests.present ? 'NO TELEMETRY' : digests.ok === true ? 'NOTARIZED' : digests.ok === false ? 'EDITED AFTER SEAL' : 'NOT DIGESTED YET',
    digests.present ? `${digests.digests} digest ring(s) · ${digests.notarized}/${digests.bytes} bytes covered` : '');

  const tele = data.telemetry;
  const econ = $('economicsStats');
  econ.replaceChildren(
    learningRow(`${formatNumber(tele.tokensSavedTotal)} tokens saved`,
      `${data.replay.accepts || 0} replay accept(s)`,
      `replay ledger: ${data.replay.rings || 0} ring(s) cached · ${data.replay.rederiveDue || 0} re-derivation(s) due`),
    learningRow(`${formatNumber(tele.total)} telemetry events`,
      tele.lastTs ? `last ${tele.lastTs.slice(0, 19)}` : 'none yet',
      Object.entries(tele.counts).map(([k, v]) => `${k} ×${v}`).join(' · ') || '—'),
  );
  $('tokensSpark').replaceChildren(sparkline(tele.tokensSavedSeries));
  $('qualitySpark').replaceChildren(sparkline(data.quality.brightness));

  const ops = $('operatorList');
  if (!data.operators.length) {
    ops.textContent = 'No operator rings yet — the learners are gathering telemetry. Run dream.py when ready.';
  } else {
    ops.replaceChildren(...data.operators.slice(-12).reverse().map((op) => {
      const evalText = op.eval
        ? Object.entries(op.eval).filter(([, v]) => typeof v === 'number')
            .map(([k, v]) => `${k}=${v}`).join(' · ')
        : '';
      return learningRow(
        `#${op.index} ${op.operator || '?'} · ${op.action || '?'}${op.version ? ` → ${op.version}` : ''}${op.revertedTo ? ` → ${op.revertedTo}` : ''}`,
        op.ts ? op.ts.slice(0, 19) : '',
        evalText);
    }));
  }

  const dreams = $('dreamList');
  if (!data.dreams.length) {
    dreams.textContent = 'No dream rings yet — the offline cadence has not run. python3 dream.py run';
  } else {
    dreams.replaceChildren(...data.dreams.slice(-8).reverse().map((d) => {
      const trainingText = Object.entries(d.training).map(([k, v]) => `${k}: ${v}`).join(' · ');
      return learningRow(
        `#${d.index} dream · ${d.missedPositives ?? 0} missed-positive(s) · ${d.growthProposals} growth proposal(s)`,
        `${d.ts ? d.ts.slice(0, 19) : ''}${d.durationS != null ? ` · ${d.durationS}s` : ''}`,
        trainingText || '—');
    }));
  }

  setText('learningMeta',
    `${data.operators.length} operator ring(s) · ${data.dreams.length} dream(s) · ${formatNumber(tele.tokensSavedTotal)} tokens saved`);
}


// --------------------------------------------------------------------------- //
// P2 — the CPHY token metaprogramming observatory: per-block token audit,
// retrieval-order realization, scars, and the lineage tree. Everything reads
// the paired bridge; every mutation is the owner's explicit click, relayed to
// the skill's own CLIs (the page never invents an economic operation).
// --------------------------------------------------------------------------- //

const BRASS_HEX = '#d6a860';
const TEAL_HEX = '#7cb5a9';

async function loadObservatory() {
  await Promise.all([
    loadCphy().catch((e) => setText('cphyMeta', `unavailable — ${e.message}`)),
    loadRetrieval().catch((e) => setText('retrievalMeta', `unavailable — ${e.message}`)),
    loadImmune().catch((e) => setText('immuneMeta', `unavailable — ${e.message}`)),
    loadForks().catch((e) => setText('forkMeta', `unavailable — ${e.message}`)),
    loadNursery().catch((e) => setText('nurseryMeta', `unavailable — ${e.message}`)),
  ]);
}

async function loadNursery() {
  state.nursery = await api('/api/registry/emergent');
  renderNursery();
}

async function loadCphy() {
  const [overview, blocks] = await Promise.all([api('/api/cphy/overview'), api('/api/cphy/blocks')]);
  state.cphy = overview;
  state.cphyBlocks = blocks;
  state.cphyBlockMap = new Map(blocks.blocks.map((b) => [b.index, b]));
  renderCphy();
  drawLandscape();
}

async function loadRetrieval() {
  state.retrieval = await api('/api/retrieval/history?limit=8');
  renderRetrieval();
}

async function loadImmune() {
  state.immune = await api('/api/immune');
  renderImmune();
  // The landscape's quarantine bands read state.immune — repaint in case the
  // canvas drew first (the observatory lanes load in parallel).
  drawLandscape();
}

async function loadForks() {
  state.forks = await api('/api/forks');
  renderForks();
}

function chip(text, kind = '') {
  const el = document.createElement('span');
  el.className = `chip${kind ? ` ${kind}` : ''}`;
  el.textContent = text;
  return el;
}

function statCell(label, value, note) {
  const div = document.createElement('div');
  div.className = 'stat';
  const span = document.createElement('span');
  span.textContent = label;
  const strong = document.createElement('strong');
  strong.textContent = value;
  div.append(span, strong);
  if (note) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = note;
    div.append(meta);
  }
  return div;
}

function fmtCphy(value) {
  if (value === null || value === undefined) return '—';
  return `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })} CPHY`;
}

function shortAddr(addr) {
  return addr ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : '—';
}

function setMsg(id, text, isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? '#f87171' : '';
}

function renderCphy() {
  const c = state.cphy;
  if (!c || !c.present) {
    setText('cphyMeta', 'no CPHY economy on this chain yet — python3 cphy.py mint begins one');
    return;
  }
  const anchorOk = Boolean(c.anchor?.verified);
  setText('cphyMeta', `${c.onchain?.token ? `${shortAddr(c.onchain.token)} · ${c.onchain.chain}` : 'no on-chain lane'}${anchorOk ? ' · anchor verified' : ''}${c.onchain?.lastSyncTs ? ` · last sync ${new Date(c.onchain.lastSyncTs * 1000).toISOString().slice(0, 19)}` : ''}`);

  const etchCount = Object.keys(c.etches || {}).length;
  const pendingOpen = c.pending.filter((p) => p.status === 'pending');
  $('cphyStats').replaceChildren(
    statCell('Minted (earned)', fmtCphy(c.supply?.minted), 'one sealed ring mints brightness/255'),
    statCell('Locked', fmtCphy(c.supply?.locked), `${c.locks.length} lock(s) working`),
    statCell('Balance', fmtCphy(c.supply?.balance)),
    statCell('Burned on-chain', fmtCphy(c.burnedTotal), `${etchCount} etched ring(s)`),
    statCell('Ledger', `${c.supply?.events ?? 0} events`, c.audit.ok === true ? 'replay AUDIT: PASS' : c.audit.ok === false ? 'AUDIT: FAIL' : 'audit unavailable'),
    statCell('Consent', c.onchain?.approval === 'auto' ? 'AUTO' : 'REQUIRE', pendingOpen.length ? `${pendingOpen.length} burn(s) awaiting you` : 'no burns waiting'),
  );

  renderConsent(pendingOpen, c.pending);
  renderLocks(c.locks);
  renderEtches(c);
  if ($('etchN') && document.activeElement !== $('etchN')) $('etchN').value = c.onchain?.etchRecallN ?? 3;
}

// cphy.py stages pending faculty burns with type 'unlock' (the 'faculty-unlock'
// string is a ledger event kind, never a pending type) — accept both.
function isUnlockPending(p) {
  return p.type === 'unlock' || p.type === 'faculty-unlock' || p.facultyKey != null;
}

function renderConsent(open, all) {
  const wrap = $('cphyConsent');
  wrap.replaceChildren();
  if (!open.length) {
    const resolved = all.filter((p) => p.status !== 'pending').slice(-4);
    if (resolved.length) {
      const row = document.createElement('div');
      row.className = 'meta';
      row.append('Consent history: ');
      for (const p of resolved) {
        row.append(chip(`${isUnlockPending(p) ? p.name || p.facultyKey : `ring ${p.ring}`} · ${p.tokens} CPHY · ${p.status}`, (p.status === 'approved' || p.status === 'applied') ? 'ok' : 'danger'));
        row.append(' ');
      }
      wrap.append(row);
    }
    return;
  }
  const card = document.createElement('div');
  card.className = 'consent-card';
  const head = document.createElement('div');
  head.className = 'consent-row';
  const title = document.createElement('strong');
  title.textContent = `Consent membrane — ${open.length} observed burn(s) awaiting your approval`;
  const note = document.createElement('span');
  note.className = 'meta';
  note.textContent = 'Money can knock; only the owner opens the door. Tokens are burned either way.';
  head.append(title, note);
  card.append(head);
  for (const p of open) {
    const row = document.createElement('div');
    row.className = 'consent-row';
    const label = document.createElement('div');
    const what = document.createElement('strong');
    what.textContent = isUnlockPending(p) ? `Unlock faculty ${p.name || p.facultyKey}` : `Etch ring #${p.ring}`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${p.tokens} CPHY → ${shortAddr(p.address)} · detected ${String(p.detected || '').slice(0, 19)} · id ${p.id}`;
    label.append(what, meta);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const approve = document.createElement('button');
    approve.className = 'primary';
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => consentAction(p.id, 'approve'));
    const reject = document.createElement('button');
    reject.className = 'secondary danger';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => consentAction(p.id, 'reject'));
    actions.append(approve, reject);
    row.append(label, actions);
    card.append(row);
  }
  wrap.append(card);
}

async function consentAction(id, action) {
  try {
    await api(`/api/cphy/pending/${id}/${action}`, { method: 'POST', body: '{}' });
    setMsg('cphyMessage', action === 'approve' ? `Burn ${id} applied — the etch is now part of the attention landscape.` : `Burn ${id} rejected — recorded forever, never applied.`);
    await loadCphy();
  } catch (error) {
    setMsg('cphyMessage', error.message, true);
  }
}

function renderLocks(locks) {
  const list = $('lockList');
  if (!locks.length) {
    list.textContent = 'No active locks — the attention landscape is flat.';
    return;
  }
  list.replaceChildren(...locks.map((lock) => {
    const row = document.createElement('article');
    row.className = 'domain-row';
    const top = document.createElement('div');
    top.className = 'domain-top';
    const name = document.createElement('strong');
    name.append(chip(lock.op, lock.op === 'basin' ? 'brass' : 'teal'), ` ${fmtCphy(lock.amount)} · ${lock.indices.length ? `rings ${lock.indices[0]}–${lock.indices.at(-1)}` : 'rings —'}`);
    const release = document.createElement('button');
    release.className = 'ghost';
    release.textContent = 'Release';
    release.addEventListener('click', () => releaseLock(lock.lockId));
    top.append(name, release);
    const tags = document.createElement('div');
    tags.className = 'tags';
    tags.textContent = `${lock.lockId} · ${lock.memo || 'no memo'}`;
    row.append(top, tags);
    return row;
  }));
}

async function releaseLock(lockId) {
  try {
    await api('/api/cphy/release', { method: 'POST', body: JSON.stringify({ lockId }) });
    setMsg('cphyMessage', `Lock ${lockId} released — CPHY refunded to balance.`);
    await loadCphy();
  } catch (error) {
    setMsg('cphyMessage', error.message, true);
  }
}

function renderEtches(c) {
  const list = $('etchList');
  const etches = Object.entries(c.etches || {});
  if (!etches.length) {
    list.textContent = 'No etches yet — burn whole CPHY to a ring’s deposit address and (after your approval) it reads as freshly lived.';
  } else {
    list.replaceChildren(...etches.map(([ring, e]) => {
      const row = document.createElement('article');
      row.className = 'domain-row';
      const top = document.createElement('div');
      top.className = 'domain-top';
      const name = document.createElement('strong');
      name.textContent = `Ring #${ring}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `E${e.echelon}/21 · ${e.tokens} CPHY burned`;
      top.append(name, meta);
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round((e.echelon / 21) * 100)}%`;
      fill.style.background = `linear-gradient(90deg, ${BRASS_HEX}, #8a6a30)`;
      bar.append(fill);
      row.append(top, bar);
      return row;
    }));
  }
  const targets = $('targetList');
  const ringTargets = c.onchain?.targets || [];
  const facTargets = c.onchain?.facultyTargets || [];
  if (!ringTargets.length && !facTargets.length) {
    targets.textContent = '';
    return;
  }
  const rows = [];
  for (const t of ringTargets) {
    if (state.cphy.etches?.[t.ring]) continue;
    rows.push(targetRow(`Ring #${t.ring}`, t.address, 'awaiting burn'));
  }
  for (const t of facTargets) {
    rows.push(targetRow(`${t.kind} ${t.id} · ${t.name}`, t.address, `${t.status} · 1 CPHY unlocks + pins`));
  }
  targets.replaceChildren(...rows);
}

function targetRow(label, address, note) {
  const row = document.createElement('article');
  row.className = 'domain-row';
  const top = document.createElement('div');
  top.className = 'domain-top';
  const name = document.createElement('strong');
  name.textContent = label;
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = note;
  top.append(name, meta);
  const tags = document.createElement('div');
  tags.className = 'tags';
  tags.textContent = `${address} — keyless deposit: tokens sent here are burned forever; dust first; >21 buys nothing`;
  row.append(top, tags);
  return row;
}

// --- the attention landscape strip: every block, colored by what CPHY does to it --- //

function drawLandscape() {
  const canvas = $('landscapeCanvas');
  if (!canvas || !state.summary) return;
  const count = Math.max(1, state.summary.stats.rings);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth - 16;
  const cssHeight = 96;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const mid = 58;
  const colWidth = Math.max(1, cssWidth / count);
  const x = (i) => (i / count) * cssWidth;

  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(cssWidth, mid);
  ctx.stroke();

  const hits = state.cphyBlocks?.recallHits || {};
  let maxHits = 1;
  for (const v of Object.values(hits)) maxHits = Math.max(maxHits, Number(v) || 0);
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  for (const [idx, v] of Object.entries(hits)) {
    const h = Math.max(1, (Number(v) / maxHits) * 22);
    ctx.fillRect(x(Number(idx)), cssHeight - h, Math.max(1, colWidth), h);
  }

  const quarantined = new Set(state.immune?.quarantine || []);
  for (const idx of quarantined) {
    ctx.fillStyle = 'rgba(248,113,113,0.5)';
    ctx.fillRect(x(idx), 10, Math.max(1, colWidth), cssHeight - 20);
  }

  for (const b of state.cphyBlocks?.blocks || []) {
    const px = x(b.index);
    const w = Math.max(1.25, colWidth);
    const lg = Math.log2(b.multiplier || 1);
    if (lg > 0.001) {
      ctx.fillStyle = `rgba(214,168,96,${0.35 + 0.6 * (lg / 2)})`;
      ctx.fillRect(px, mid - (lg / 2) * 44, w, (lg / 2) * 44);
    } else if (lg < -0.001) {
      ctx.fillStyle = `rgba(124,181,169,${0.35 + 0.6 * (-lg / 2)})`;
      ctx.fillRect(px, mid, w, (-lg / 2) * 30);
    }
    if (b.etch) {
      ctx.fillStyle = BRASS_HEX;
      ctx.beginPath();
      ctx.moveTo(px + w / 2, 2);
      ctx.lineTo(px + w / 2 + 4, 8);
      ctx.lineTo(px + w / 2, 14);
      ctx.lineTo(px + w / 2 - 4, 8);
      ctx.closePath();
      ctx.fill();
    }
    if (b.depositAddress && !b.etch) {
      ctx.strokeStyle = 'rgba(214,168,96,0.8)';
      ctx.beginPath();
      ctx.arc(px + w / 2, 8, 3.2, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.arc(x(count - 1), mid, 3, 0, Math.PI * 2);
  ctx.fill();

  setText('landscapeMeta', `${count} blocks · ${state.cphyBlocks?.blocks.length || 0} carry weight · top-${state.cphyBlocks?.etchRecallN ?? 3} etches surfaced per turn`);
  const legend = $('landscapeLegend');
  legend.replaceChildren(
    legendItem(BRASS_HEX, 'basin / burn — weight above 1×'),
    legendItem(TEAL_HEX, 'shadow — weight below 1×'),
    legendItem('#f87171', 'quarantined (scar)'),
    legendItem('rgba(255,255,255,0.4)', 'retrieval activity'),
    legendItem(BRASS_HEX, '◆ etched · ○ deposit address', true),
  );
}

function legendItem(color, label, hollow = false) {
  const span = document.createElement('span');
  const swatch = document.createElement('i');
  if (!hollow) swatch.style.background = color;
  else { swatch.style.border = `1px solid ${color}`; swatch.style.background = 'transparent'; }
  span.append(swatch, label);
  return span;
}

function landscapeIndexAt(event) {
  const canvas = $('landscapeCanvas');
  const rect = canvas.getBoundingClientRect();
  const frac = (event.clientX - rect.left) / rect.width;
  const count = Math.max(1, state.summary?.stats.rings || 1);
  const raw = Math.max(0, Math.min(count - 1, Math.floor(frac * count)));
  // At high ring counts one pixel spans several indices while markers (etch
  // diamonds, weight bars) are drawn pixels wide — snap to the nearest block
  // that actually carries CPHY within the marker's visual radius, so the
  // pointer lands on the block the eye is on.
  if (state.cphyBlockMap && !state.cphyBlockMap.has(raw)) {
    const radius = Math.max(1, Math.ceil((count / rect.width) * 5));
    for (let d = 1; d <= radius; d += 1) {
      if (state.cphyBlockMap.has(raw - d)) return raw - d;
      if (state.cphyBlockMap.has(raw + d)) return raw + d;
    }
  }
  return raw;
}

function landscapeHover(event) {
  const tip = $('landscapeTip');
  const index = landscapeIndexAt(event);
  const b = state.cphyBlockMap?.get(index);
  const hits = state.cphyBlocks?.recallHits?.[index] ?? state.cphyBlocks?.recallHits?.[String(index)] ?? 0;
  const quarantined = (state.immune?.quarantine || []).includes(index);
  const lines = [`#${index}`];
  lines.push(`weight ×${(b?.multiplier ?? 1).toFixed(3)}${b?.exponent ? ` (Σ density ${b.exponent.toFixed(2)} log₂, clamped ±2)` : ''}`);
  if (b?.locks?.length) lines.push(`locks: ${b.locks.join(', ')}`);
  if (b?.etch) lines.push(`etched E${b.etch.echelon}/21 · ${b.etch.tokens} CPHY burned`);
  if (b?.observedTokens) lines.push(`observed on-chain: ${b.observedTokens} CPHY`);
  if (b?.depositAddress) lines.push(`deposit: ${b.depositAddress}`);
  if (quarantined) lines.push('QUARANTINED — excluded from the active self');
  lines.push(`retrieval hits: ${hits}`);
  tip.textContent = lines.join('\n');
  tip.style.whiteSpace = 'pre-line';
  tip.classList.remove('hidden');
  const wrap = tip.parentElement.getBoundingClientRect();
  const left = Math.min(event.clientX - wrap.left + 12, wrap.width - 300);
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = '8px';
}

// --- relevance realization --- //

function renderRetrieval() {
  const r = state.retrieval;
  if (!r) return;
  setText('retrievalMeta', `${r.totalOffers} retrieval(s) on record`);

  const leaders = $('retrievalLeaders');
  if (!r.rings.length) {
    leaders.textContent = 'No retrievals recorded yet — the offer log fills as the agent lives.';
  } else {
    leaders.replaceChildren(...r.rings.slice(0, 10).map((s) => {
      const row = document.createElement('article');
      row.className = 'domain-row';
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => selectRing(s.index, { scroll: true }));
      const top = document.createElement('div');
      top.className = 'domain-top';
      const name = document.createElement('strong');
      name.textContent = `#${s.index}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `chosen ${s.chosen}× of ${s.considered} · best rank ${s.bestRank}`;
      top.append(name, meta);
      const tags = document.createElement('div');
      tags.className = 'tags';
      if (s.cphy) tags.append(chip(`×${s.cphy} CPHY`, 'brass'), ' ');
      if (s.etched) tags.append(chip(`etched E${s.etched}`, 'brass'), ' ');
      tags.append(`last surfaced ${String(s.lastTs || '').slice(0, 19)}`);
      row.append(top, tags);
      return row;
    }));
  }

  const offers = $('offerList');
  if (!r.offers.length) {
    offers.textContent = 'No offer events yet.';
  } else {
    offers.replaceChildren(...r.offers.map((o) => {
      const row = document.createElement('article');
      row.className = 'domain-row';
      const top = document.createElement('div');
      top.className = 'domain-top';
      const name = document.createElement('strong');
      name.textContent = (o.queryKeywords || []).slice(0, 6).join(' · ') || '(query)';
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = `${String(o.ts || '').slice(0, 19)} · ${o.returned}/${o.considered} returned`;
      top.append(name, meta);
      const tags = document.createElement('div');
      tags.className = 'tags';
      const chosen = o.candidates.filter((c) => c.chosen);
      tags.textContent = chosen.map((c) => `#${c.index} r${c.rank}${c.parts.cphy ? ` ×${c.parts.cphy}` : ''}${c.parts.etched ? ` E${c.parts.etched}` : ''}`).join('  ');
      row.append(top, tags);
      return row;
    }));
  }
}

// Default hand-2.1 weights, used only when the scorer is the hand blend AND the
// preview did not return explicit weights. A trained scorer reports its own.
const HAND_WEIGHTS = { semantic: 0.70, path: 0.20, chronological: 0.10, faculty: 0.05, salience: 0.03 };
const PART_ORDER = ['semantic', 'path', 'chronological', 'faculty', 'salience'];

function renderPreview(data) {
  const wrap = $('previewResult');
  wrap.replaceChildren();
  const w = data.with_overlay;
  const trained = typeof w.scorer === 'string' && w.scorer.startsWith('trained');
  // Use the scorer's own weights when the preview reported them; only fall back
  // to the hand blend for the hand scorer, so bars never mislabel a trained run.
  const weights = (w.weights && typeof w.weights === 'object') ? w.weights : (trained ? null : HAND_WEIGHTS);
  const note = document.createElement('p');
  note.className = 'preview-note';
  note.textContent = `dissonance ${w.dissonance} → appetite ${w.appetite} · threshold ${w.threshold} · ${w.considered} block(s) considered, ${w.blocks.length} surfaced · scorer ${w.scorer}`
    + (w.appetite === 0 ? ' — appetite 0 means “no need”, not “no match”' : '');
  wrap.append(note);
  if (!w.blocks.length) return;
  const maxScore = Math.max(...w.blocks.map((b) => b.score || 0), 0.0001);
  for (const b of w.blocks) {
    const row = document.createElement('article');
    row.className = 'rank-row';
    row.addEventListener('click', () => selectRing(b.index, { scroll: true }));
    const rank = document.createElement('div');
    rank.className = 'rank';
    rank.textContent = `${b.rank + 1}.`;
    const sub = document.createElement('small');
    // A "lift" is only a CPHY lift when the block actually carries a token-weight
    // or etch part; a null organicRank without those parts is just a returned-set
    // boundary difference between the two runs, not something CPHY did.
    const cphyLifted = Boolean(b.parts.cphy) || Boolean(b.parts.etched);
    if (b.rankDelta > 0 && cphyLifted) { sub.textContent = `▲${b.rankDelta} by CPHY`; sub.className = 'delta-up'; }
    else if (b.rankDelta > 0) { sub.textContent = `▲${b.rankDelta}`; sub.className = 'delta-up'; }
    else if (b.rankDelta < 0) { sub.textContent = `▼${-b.rankDelta}`; sub.className = 'delta-down'; }
    else if (b.organicRank === null && cphyLifted) { sub.textContent = b.parts.etched ? 'etch-lifted' : 'token-lifted'; sub.className = 'delta-up'; }
    rank.append(sub);
    const body = document.createElement('div');
    const line = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = `#${b.index} ${b.type || ''}`;
    line.append(name, ` — score ${(b.score || 0).toFixed(3)} `);
    if (b.parts.cphy) line.append(chip(`×${b.parts.cphy} token weight`, 'brass'), ' ');
    if (b.parts.etched) line.append(chip(`etched E${b.parts.etched}`, 'brass'), ' ');
    if (b.explore) line.append(chip('ε-explore', 'teal'), ' ');
    body.append(line);
    if (weights) {
      const bar = document.createElement('div');
      bar.className = 'part-bar';
      for (const part of PART_ORDER) {
        const weight = Number(weights[part] || 0);
        if (!weight) continue;
        const value = part === 'salience' ? (b.salience ?? 0) / 255 : Number(b.parts[part] || 0);
        const contribution = weight * Math.min(1, value);
        if (contribution <= 0.001) continue;
        const seg = document.createElement('i');
        seg.className = `part-${part}`;
        seg.style.width = `${(contribution / maxScore) * 100}%`;
        seg.title = `${part} ${value.toFixed(3)} × ${weight}`;
        bar.append(seg);
      }
      body.append(bar);
    }
    const excerpt = document.createElement('div');
    excerpt.className = 'meta';
    excerpt.textContent = b.excerpt || '';
    body.append(excerpt);
    const side = document.createElement('div');
    side.className = 'meta';
    side.textContent = b.organicRank === null ? 'not in organic set' : `organic #${b.organicRank + 1}`;
    row.append(rank, body, side);
    wrap.append(row);
  }
  const legend = document.createElement('p');
  legend.className = 'preview-note';
  legend.textContent = weights
    ? `Bars show each term’s contribution to the ${trained ? 'scorer' : 'hand'} score (${PART_ORDER.filter((p) => weights[p]).map((p) => `${p} ${weights[p]}`).join(' · ')}); the CPHY multiplier and etch echelon then rerank — attention, never truth.`
    : 'A trained scorer is active — the per-term weights are learned and not shown here; the CPHY multiplier and etch echelon rerank the result. Attention, never truth.';
  wrap.append(legend);
}

async function runPreview(event) {
  event.preventDefault();
  const query = $('previewQuery').value.trim();
  if (!query) return;
  setText('retrievalMeta', 'realizing relevance…');
  try {
    const data = await api('/api/retrieval/preview', { method: 'POST', body: JSON.stringify({ query }) });
    renderPreview(data);
    setText('retrievalMeta', `${state.retrieval?.totalOffers ?? 0} retrieval(s) on record · preview ran outside the learner’s log`);
  } catch (error) {
    setText('retrievalMeta', error.message);
  }
}

// --- scars & immunity --- //

function renderImmune() {
  const im = state.immune;
  if (!im) return;
  setIntegrityCard('immLock', !im.locked && !im.paused,
    im.locked ? 'LOCKDOWN' : im.paused ? 'DORMANT' : 'OPEN',
    im.paused ? `paused: ${im.paused.reason || 'no reason'}` : im.locked ? 'seals refused except recovery' : 'sealing normally');
  setIntegrityCard('immQuarantine', im.quarantine.length === 0 ? true : null,
    String(im.quarantine.length),
    im.quarantine.length ? `heights ${contigLabel(im.quarantine)}` : 'no rings excluded');
  setIntegrityCard('immScars', im.scars.length === 0 ? true : null,
    String(im.scars.length),
    im.scars.length ? 'inert records — lessons, not filters' : 'an unwounded chain');
  setText('immuneMeta', im.doctrine);

  const list = $('scarList');
  if (!im.scars.length) {
    list.textContent = 'No scars. When a covenant drift is healed, the quarantined range and its lesson appear here.';
    return;
  }
  list.replaceChildren(...im.scars.map((scar) => {
    const row = document.createElement('article');
    row.className = 'domain-row';
    const top = document.createElement('div');
    top.className = 'domain-top';
    const name = document.createElement('strong');
    name.textContent = `${scar.id} · blocks ${scar.blocks[0]}–${scar.blocks.at(-1)}`;
    const retire = document.createElement('button');
    retire.className = 'ghost';
    retire.textContent = 'Retire';
    retire.addEventListener('click', () => forgetScar(scar.id));
    top.append(name, retire);
    const tags = document.createElement('div');
    tags.className = 'tags';
    tags.textContent = scar.lesson || 'no lesson recorded';
    row.append(top, tags);
    return row;
  }));
}

function contigLabel(indices) {
  const ranges = [];
  const sorted = [...indices].sort((a, b) => a - b);
  for (const idx of sorted) {
    const last = ranges.at(-1);
    if (last && idx === last[1] + 1) last[1] = idx;
    else ranges.push([idx, idx]);
  }
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(', ');
}

async function forgetScar(id) {
  try {
    await api('/api/immune/forget-scar', { method: 'POST', body: JSON.stringify({ id }) });
    setMsg('immuneMessage', `${id} retired — the record is kept, the label is released.`);
    await Promise.all([loadImmune(), loadForks()]);
  } catch (error) {
    setMsg('immuneMessage', error.message, true);
  }
}

// --- lineage: the fork tree --- //

function renderForks() {
  const f = state.forks;
  if (!f) return;
  setText('forkMeta', `head #${f.head?.index ?? '—'} · ${f.quarantineBranches.length} shed branch(es) · ${f.grafts.length} graft(s) · ${f.synthesisForks.length} recent perspective fork(s) · ${f.epochCount} epochs`);

  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  const W = 900;
  const H = 190;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.add('fork-svg');
  const head = Math.max(1, f.head?.index ?? 1);
  const sx = (idx) => 40 + (Math.max(0, Math.min(head, idx)) / head) * (W - 80);
  const midY = 95;

  const el = (tag, attrs, textContent) => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (textContent) node.textContent = textContent;
    return node;
  };

  const trunk = el('line', { x1: 40, y1: midY, x2: W - 40, y2: midY, class: 'trunk' });
  svg.append(trunk);
  svg.append(el('circle', { cx: 40, cy: midY, r: 3.4, class: 'headdot' }));
  svg.append(el('text', { x: 34, y: midY + 16 }, 'genesis'));
  svg.append(el('circle', { cx: W - 40, cy: midY, r: 4, class: 'headdot' }));
  svg.append(el('text', { x: W - 74, y: midY + 16 }, `head #${f.head?.index}`));

  for (const ckpt of f.checkpoints || []) {
    svg.append(el('line', { x1: sx(ckpt), y1: midY - 5, x2: sx(ckpt), y2: midY + 5, class: 'tick' }));
    // The head label occupies the right edge — a checkpoint that close keeps
    // its tick but yields its label to the head.
    if (sx(ckpt) < W - 124) svg.append(el('text', { x: sx(ckpt) - 12, y: midY + 16 }, `ckpt ${ckpt}`));
  }
  if (f.latestEpoch != null) {
    svg.append(el('line', { x1: sx(f.latestEpoch), y1: midY - 7, x2: sx(f.latestEpoch), y2: midY + 7, class: 'tick' }));
    svg.append(el('text', { x: sx(f.latestEpoch) - 16, y: midY - 12 }, `epoch #${f.latestEpoch}`));
  }

  for (const q of f.quarantineBranches) {
    const x1 = sx(q.from);
    const x2 = sx(Math.max(q.to, q.from + head / 60));
    const path = el('path', { d: `M ${x1} ${midY} C ${x1 + 14} ${midY + 34}, ${x2 - 10} ${midY + 44}, ${x2 + 6} ${midY + 46}`, class: 'branch' });
    const title = document.createElementNS(ns, 'title');
    title.textContent = `quarantined ${q.from}–${q.to}${q.scarId ? ` (${q.scarId})` : ''} — excluded from the active self, still on disk`;
    path.append(title);
    svg.append(path);
    svg.append(el('text', { x: x2 - 6, y: midY + 58 }, `${q.scarId || 'quarantine'} ${q.from}–${q.to}`));
    if (q.resumedFromHeight != null) {
      svg.append(el('circle', { cx: sx(q.resumedFromHeight), cy: midY, r: 2.6, class: 'headdot' }));
    }
  }

  f.grafts.forEach((g, i) => {
    const gx = sx(g.index);
    const gy = 38 - (i % 2) * 14;
    svg.append(el('path', { d: `M ${gx - 30} ${gy} C ${gx - 12} ${gy}, ${gx} ${gy + 16}, ${gx} ${midY}`, class: 'graft' }));
    const diamond = el('rect', { x: gx - 34, y: gy - 4, width: 8, height: 8, transform: `rotate(45 ${gx - 30} ${gy})`, fill: TEAL_HEX });
    const title = document.createElementNS(ns, 'title');
    title.textContent = `graft #${g.index} from ${g.originAuthor} (their ring ${g.originIndex}, pack ${g.originPack}) — quarantined trust (I7)`;
    diamond.append(title);
    svg.append(diamond);
    svg.append(el('text', { x: gx - 26, y: gy - 8 }, `⟵ ${g.originAuthor || 'foreign'}`));
  });

  for (const s of f.synthesisForks.slice(-6)) {
    const cx = sx(s.index);
    const n = s.forks.length;
    s.forks.forEach((fork, i) => {
      const angle = (-Math.PI / 2) + ((i - (n - 1) / 2) * (Math.PI / Math.max(6, n * 1.6)));
      const fx = cx + Math.cos(angle) * 26;
      const fy = midY - 8 + Math.sin(angle) * 26;
      const line = el('line', { x1: cx, y1: midY, x2: fx, y2: fy, class: 'fan' });
      const title = document.createElementNS(ns, 'title');
      title.textContent = `#${s.index} considered fork: ${fork.perspective} (${fork.kind}) · ${fork.visits} visits · value ${fork.value}`;
      line.append(title);
      svg.append(line);
    });
  }

  $('forkTreeWrap').replaceChildren(svg);
  if (f.exchanges.length) {
    const note = document.createElement('p');
    note.className = 'preview-note';
    note.textContent = `Exchanges: ${f.exchanges.map((x) => `${x.kind} ${x.pack || ''} ${x.author ? `(${x.author})` : ''}`).join(' · ')}`;
    $('forkTreeWrap').append(note);
  }
}

// --- the emergent nursery: copy / paste / activate faculties --- //

function facultyAsJson(f) {
  const out = {
    kind: f.kind,
    name: f.name,
    function: f.function,
    category: f.category || 'knowledge',
    seed_terms: f.seedTerms || [],
  };
  if (f.opCode) out.code = f.opCode;
  return JSON.stringify(out, null, 2);
}

function nurseryInSelf(f) {
  return f.promotedToId != null || f.status === 'activated' || f.status === 'promoted';
}

function renderNursery() {
  const n = state.nursery;
  if (!n) return;
  const c = n.counts;
  setText('nurseryMeta', `${c.emergent} emergent · ${c.proposed} proposed · ${c.inSelf} already in the self — active: ${c.activeModalities} modalities, ${c.activeSenses} senses`);

  const facultyRow = (f, { withActivate }) => {
    const row = document.createElement('article');
    row.className = 'domain-row';
    const top = document.createElement('div');
    top.className = 'domain-top';
    const name = document.createElement('strong');
    name.append(chip(f.kind, f.kind === 'modality' ? 'brass' : 'teal'), ` ${f.name}`);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${f.eid || '—'} · ${f.status}${f.recurrence > 1 ? ` · recurred ×${f.recurrence}` : ''}${f.opCodeChars ? ` · op code ${f.opCodeChars} chars (inert)` : ''}${f.promotedToId != null ? ` · grown #${f.promotedToId}` : ''}`;
    top.append(name, meta);
    const fn = document.createElement('div');
    fn.className = 'tags';
    fn.textContent = f.function || '';
    const actions = document.createElement('div');
    actions.className = 'actions nursery-actions';
    if (f.seedTerms?.length) {
      const seeds = document.createElement('span');
      seeds.className = 'meta';
      seeds.textContent = f.seedTerms.join(' · ');
      actions.append(seeds);
    }
    const copy = document.createElement('button');
    copy.className = 'ghost';
    copy.textContent = 'Copy JSON';
    copy.addEventListener('click', () => copyFaculty(f));
    actions.append(copy);
    if (withActivate) {
      const act = document.createElement('button');
      act.className = 'primary';
      act.textContent = 'Activate';
      act.addEventListener('click', () => activateFaculty(f.eid || f.name));
      actions.append(act);
    }
    row.append(top, fn, actions);
    return row;
  };

  const waiting = n.faculties.filter((f) => !nurseryInSelf(f));
  const done = n.faculties.filter(nurseryInSelf);
  const list = $('emergentList');
  const WAITING_SHOWN = 24;
  if (!waiting.length) {
    list.textContent = 'The Dream Cache is empty — emergent faculties appear here as the mind proposes them (or paste one).';
  } else {
    const rows = waiting.slice(-WAITING_SHOWN).reverse().map((f) => facultyRow(f, { withActivate: true }));
    if (waiting.length > WAITING_SHOWN) {
      const note = document.createElement('p');
      note.className = 'meta';
      note.textContent = `Showing the latest ${WAITING_SHOWN} of ${waiting.length} waiting faculties — the full cache lives in registry/emergent.json.`;
      rows.push(note);
    }
    list.replaceChildren(...rows);
  }
  const doneList = $('activatedList');
  if (!done.length) {
    doneList.textContent = 'Nothing from the nursery is in the active self yet.';
  } else {
    const rows = done.slice(-8).reverse().map((f) => facultyRow(f, { withActivate: false }));
    if (done.length > 8) {
      const note = document.createElement('p');
      note.className = 'meta';
      note.textContent = `Showing the latest 8 of ${done.length} promoted/activated faculties.`;
      rows.push(note);
    }
    doneList.replaceChildren(...rows);
  }
}

async function copyFaculty(f) {
  const json = facultyAsJson(f);
  try {
    await navigator.clipboard.writeText(json);
    setMsg('nurseryMessage', `${f.name} copied as JSON — paste it into any chain's nursery.`);
  } catch {
    // Clipboard can be denied — surface the JSON for manual copying instead.
    const pre = $('nurseryOpCode');
    pre.textContent = json;
    pre.classList.remove('hidden');
    setMsg('nurseryMessage', 'Clipboard unavailable — copy the JSON shown below.');
  }
}

async function activateFaculty(selector) {
  try {
    const out = await api('/api/registry/activate', { method: 'POST', body: JSON.stringify({ selector }) });
    const f = out.faculty || {};
    const epochNote = out.epoch?.resealed ? 'epoch resealed' : `epoch reseal: ${out.epoch?.note || 'no change'}`;
    if (f.opCode) {
      const pre = $('nurseryOpCode');
      pre.textContent = `# ${f.name} is registered (grown #${f.promotedToId}). Its op code stays INERT until you\n# place it in active_ops.py yourself (OPS = {"${f.name}": <callable>}):\n\n${String(f.opCode).slice(0, 2000)}`;
      pre.classList.remove('hidden');
      setMsg('nurseryMessage', `${f.name || selector} activated into the registry (${epochNote}) — its op code is shown below for manual placement.`);
    } else {
      setMsg('nurseryMessage', `${f.name || selector} activated into the active registry as grown #${f.promotedToId ?? '?'} (${epochNote}).`);
    }
    await Promise.all([loadNursery(), loadDashboardSummaryOnly()]);
  } catch (error) {
    setMsg('nurseryMessage', error.message, true);
  }
}

async function submitPaste(event) {
  event.preventDefault();
  const raw = $('pasteJson').value.trim();
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    setMsg('nurseryMessage', 'That is not valid JSON — copy a faculty from a dashboard, or write {"kind","name","function","seed_terms"}.', true);
    return;
  }
  try {
    const body = {
      kind: parsed.kind,
      name: parsed.name,
      function: parsed.function || '',
      category: parsed.category || 'knowledge',
      seedTerms: parsed.seed_terms || parsed.seedTerms || [],
      code: parsed.code || parsed.op_code || '',
    };
    const out = await api('/api/registry/propose', { method: 'POST', body: JSON.stringify(body) });
    const epochNote = out.epoch?.resealed ? 'epoch resealed' : `epoch reseal: ${out.epoch?.note || 'no change'}`;
    const f = out.faculty;
    if (f && nurseryInSelf(f)) {
      setMsg('nurseryMessage', `${f.name} pasted and ENABLED in the active self as grown #${f.promotedToId} (${epochNote}).`);
    } else if (f) {
      setMsg('nurseryMessage', `${f.name} staged as an inert ${f.status} (${epochNote}) — review it in the Dream Cache, then Activate.`);
    } else {
      // The skill took the paste but resolved it another way (e.g. it woke a
      // dormant faculty covering the same vocabulary) — show its own words.
      setMsg('nurseryMessage', `The skill absorbed the paste: ${String(out.result || '').replace(/\s+/g, ' ').trim().slice(0, 240)} (${epochNote})`);
    }
    $('pasteJson').value = '';
    await Promise.all([loadNursery(), loadDashboardSummaryOnly()]);
  } catch (error) {
    setMsg('nurseryMessage', error.message, true);
  }
}

// --- edit / exchange / splice actions --- //

async function submitLock(event) {
  event.preventDefault();
  try {
    // Number('') is 0 — a blank field would silently lock from ring 0.
    if (!$('lockFrom').value.trim() || !$('lockTo').value.trim() || !$('lockAmount').value.trim()) {
      setMsg('cphyMessage', 'A lock needs explicit from/to ring numbers and a CPHY amount.', true);
      return;
    }
    const body = {
      op: $('lockOp').value,
      from: Number($('lockFrom').value),
      to: Number($('lockTo').value),
      amount: Number($('lockAmount').value),
      memo: $('lockMemo').value,
    };
    const out = await api('/api/cphy/lock', { method: 'POST', body: JSON.stringify(body) });
    setMsg('cphyMessage', `Lock placed: ${JSON.stringify(out.result).slice(0, 160)}`);
    await loadCphy();
  } catch (error) {
    setMsg('cphyMessage', error.message, true);
  }
}

async function submitEtchN(event) {
  event.preventDefault();
  try {
    await api('/api/cphy/etch-recall-n', { method: 'POST', body: JSON.stringify({ n: Number($('etchN').value) }) });
    setMsg('cphyMessage', `etch_recall_n set to ${$('etchN').value} — the load you choose to pay for.`);
    await loadCphy();
  } catch (error) {
    setMsg('cphyMessage', error.message, true);
  }
}

async function submitTarget(event) {
  event.preventDefault();
  try {
    if (!$('targetFrom').value.trim()) {
      setMsg('cphyMessage', 'Deposit addresses need an explicit starting ring number.', true);
      return;
    }
    const from = Number($('targetFrom').value);
    const to = Number($('targetTo').value || from);
    await api('/api/cphy/target', { method: 'POST', body: JSON.stringify({ from, to }) });
    setMsg('cphyMessage', `Deposit addresses registered for rings ${from}–${to}. Burns land in the consent queue after the agent’s next sync.`);
    await loadCphy();
  } catch (error) {
    setMsg('cphyMessage', error.message, true);
  }
}

async function submitExport(event) {
  event.preventDefault();
  try {
    if (!$('exportFrom').value.trim() || !$('exportTo').value.trim()) {
      setMsg('forkMessage', 'A pack export needs explicit from/to ring numbers.', true);
      return;
    }
    const body = {
      from: Number($('exportFrom').value),
      to: Number($('exportTo').value),
      price: Number($('exportPrice').value || 0),
      memo: $('exportMemo').value,
    };
    const out = await api('/api/pack/export', { method: 'POST', body: JSON.stringify(body) });
    if (out.pack) {
      const blob = new Blob([JSON.stringify(out.pack, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${out.pack.pack_hash?.slice(0, 12) || 'pack'}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
    setMsg('forkMessage', `Pack exported (${out.pack?.rings?.length ?? '?'} ring(s), hash ${out.pack?.pack_hash?.slice(0, 12) || '—'}) — also saved at ${out.packPath}`);
    await loadForks();
  } catch (error) {
    setMsg('forkMessage', error.message, true);
  }
}

async function submitImport(event) {
  event.preventDefault();
  const file = $('importFile').files?.[0];
  if (!file) {
    setMsg('forkMessage', 'Choose a pack file first.', true);
    return;
  }
  try {
    const pack = JSON.parse(await file.text());
    const out = await api('/api/pack/import', { method: 'POST', body: JSON.stringify({ pack }) });
    const r = out.result || {};
    setMsg('forkMessage', `Spliced: ${(r.sealed || []).length} ring(s) grafted in quarantined trust (I7)${(r.refused || []).length ? `, ${r.refused.length} refused` : ''}${r.price_burned ? ` · ${r.price_burned} CPHY burned as price` : ''}.`);
    await Promise.all([loadForks(), loadCphy(), loadRings()]);
  } catch (error) {
    setMsg('forkMessage', error.message, true);
  }
}

async function submitSeal(event) {
  event.preventDefault();
  try {
    const out = await api('/api/ring/seal', { method: 'POST', body: JSON.stringify({ summary: $('sealSummary').value }) });
    const text = typeof out.result === 'string' ? out.result : JSON.stringify(out.result);
    const sealed = text.match(/[Rr]ing\s+#?(\d+)/);
    setMsg('forkMessage', sealed ? `Sealed ring ${sealed[1]} — the annotation is now chain history.` : `Conscience verdict: ${text.slice(0, 240)}`);
    $('sealSummary').value = '';
    await Promise.all([loadRings(), loadForks()]);
  } catch (error) {
    setMsg('forkMessage', error.message, true);
  }
}

async function submitRollback(event) {
  event.preventDefault();
  try {
    const body = {
      height: Number($('rollbackHeight').value),
      lesson: $('rollbackLesson').value,
      confirm: $('rollbackConfirm').value.trim(),
    };
    const out = await api('/api/immune/rollback', { method: 'POST', body: JSON.stringify(body) });
    const text = typeof out.result === 'string' ? out.result : JSON.stringify(out.result);
    setMsg('forkMessage', `Quarantined: ${text.slice(0, 240)}`);
    await Promise.all([loadImmune(), loadForks(), loadRings(), loadDashboardSummaryOnly()]);
  } catch (error) {
    setMsg('forkMessage', error.message, true);
  }
}

async function loadDashboardSummaryOnly() {
  state.summary = await api('/api/timechain/summary');
  renderSummary();
  drawLandscape();
}

function renderRingCphyChips(index) {
  const panel = $('ringDetail');
  let strip = panel.querySelector('.ring-cphy');
  if (!strip) {
    strip = document.createElement('div');
    strip.className = 'ring-cphy tags';
    panel.insertBefore(strip, panel.querySelector('pre'));
  }
  strip.replaceChildren();
  const b = state.cphyBlockMap?.get(Number(index));
  const stats = state.retrieval?.rings?.find((s) => s.index === Number(index));
  if (b?.multiplier && b.multiplier !== 1) strip.append(chip(`token weight ×${b.multiplier.toFixed(2)}`, 'brass'), ' ');
  if (b?.etch) strip.append(chip(`etched E${b.etch.echelon}/21 · ${b.etch.tokens} CPHY`, 'brass'), ' ');
  if (b?.depositAddress) strip.append(chip(`deposit ${shortAddr(b.depositAddress)}`), ' ');
  if (stats) strip.append(chip(`retrieved ${stats.chosen}× · best rank ${stats.bestRank}`, 'teal'), ' ');
  if ((state.immune?.quarantine || []).includes(Number(index))) strip.append(chip('quarantined', 'danger'), ' ');
}

function bindObservatory() {
  $('previewForm')?.addEventListener('submit', runPreview);
  $('pasteForm')?.addEventListener('submit', submitPaste);
  $('lockForm')?.addEventListener('submit', submitLock);
  $('etchNForm')?.addEventListener('submit', submitEtchN);
  $('targetForm')?.addEventListener('submit', submitTarget);
  $('exportForm')?.addEventListener('submit', submitExport);
  $('importForm')?.addEventListener('submit', submitImport);
  $('sealForm')?.addEventListener('submit', submitSeal);
  $('rollbackForm')?.addEventListener('submit', submitRollback);
  const canvas = $('landscapeCanvas');
  if (canvas) {
    canvas.addEventListener('mousemove', landscapeHover);
    canvas.addEventListener('mouseleave', () => $('landscapeTip').classList.add('hidden'));
    canvas.addEventListener('click', (event) => selectRing(landscapeIndexAt(event), { scroll: true }));
  }
  window.addEventListener('resize', debounce(drawLandscape, 150));
}