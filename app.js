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
  await loadRings();
  await loadBlockspace();
  if (state.dashboardBound) return;
  state.dashboardBound = true;
  $('ringSearch').addEventListener('input', debounce(loadRings, 200));
  $('ringType').addEventListener('change', loadRings);
  $('closeBlob').addEventListener('click', () => $('blobDialog').close());
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

async function selectRing(index) {
  const ring = await api(`/api/timechain/rings/${index}`);
  state.selectedRing = ring;
  renderRings();
  const panel = $('ringDetail');
  panel.querySelector('h3').textContent = `Ring #${ring.index} · ${ring.ring_type || ring.type}`;
  panel.querySelector('pre').textContent = JSON.stringify(ring, null, 2);
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
  if (state.hostedMode) {
    $('bridgeGate').classList.remove('hidden');
    setText('bridgeMessage', error.message);
  } else {
    $('gate').classList.remove('hidden');
    setText('gateMessage', error.message);
  }
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