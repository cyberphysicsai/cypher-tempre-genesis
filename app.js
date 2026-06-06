const state = {
  config: null,
  account: null,
  summary: null,
  rings: [],
  selectedRing: null,
  hostedMode: false,
  bridgeBase: '',
  bridgeToken: '',
  bridgeBound: false,
  gateBound: false,
  dashboardBound: false,
  walletProvider: null,
  walletProviders: [],
  walletConnect: null,
  walletConnectLoad: null,
};

const $ = (id) => document.getElementById(id);
const LOCAL_PAGE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const ASSET_VERSION = '20260606-signedgate';

window.addEventListener('eip6963:announceProvider', (event) => {
  const detail = event.detail;
  if (!detail?.provider) return;
  const key = detail.info?.uuid || detail.info?.rdns || detail.info?.name || String(state.walletProviders.length);
  if (state.walletProviders.some((item) => item.key === key)) return;
  state.walletProviders.push({ key, ...detail });
});

function isLocalPage() {
  return LOCAL_PAGE_HOSTS.has(window.location.hostname);
}

function cleanBridgeBase(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function publicConfig() {
  return window.CYPHER_TEMPRE_PUBLIC_CONFIG || {};
}

function walletConnectProjectId() {
  return String(state.config?.walletConnect?.projectId || publicConfig().walletConnectProjectId || '').trim();
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

  function setStroke(alpha, lineWidth = 1) {
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
    ctx.lineWidth = lineWidth;
  }

  function setFill(alpha) {
    ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  }

  function drawAtom(cx, cy, radius, phase) {
    ctx.save();
    ctx.translate(cx, cy);
    setStroke(0.36, 1.45);
    for (const rotation of [0, Math.PI / 3, -Math.PI / 3]) {
      ctx.save();
      ctx.rotate(rotation + phase * 0.22);
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * 1.24, radius * 0.34, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    setStroke(0.52, 1.25);
    ctx.rotate(Math.PI / 4);
    ctx.strokeRect(-4, -4, 8, 8);
    setFill(0.5);
    for (let i = 0; i < 3; i += 1) {
      const angle = phase + i * ((Math.PI * 2) / 3);
      const x = Math.cos(angle) * radius * 1.05;
      const y = Math.sin(angle) * radius * 0.32;
      ctx.fillRect(x - 2, y - 2, 4, 4);
    }
    ctx.restore();
  }

  function drawDna(x, y, heightPx, amplitude, phase) {
    const period = 82;
    const steps = Math.max(28, Math.floor(heightPx / 10));
    setStroke(0.34, 1.35);
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const yy = y + (heightPx * i) / steps;
      const xx = x + Math.sin((yy + phase * 26) / period) * amplitude;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
    ctx.beginPath();
    for (let i = 0; i <= steps; i += 1) {
      const yy = y + (heightPx * i) / steps;
      const xx = x - Math.sin((yy + phase * 26) / period) * amplitude;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();

    setStroke(0.3, 1.1);
    for (let yy = y + 18; yy < y + heightPx; yy += 34) {
      const left = x + Math.sin((yy + phase * 26) / period) * amplitude;
      const right = x - Math.sin((yy + phase * 26) / period) * amplitude;
      ctx.beginPath();
      ctx.moveTo(left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
      setFill(0.44);
      ctx.fillRect(left - 2, yy - 2, 4, 4);
      ctx.fillRect(right - 2, yy - 2, 4, 4);
    }
  }

  function drawBlockLattice(x, y, cols, rows, step, phase) {
    const cells = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const jitter = Math.sin(phase + row * 1.7 + col * 0.9) * 2;
        cells.push({
          x: x + col * step + jitter,
          y: y + row * step + Math.cos(phase + col) * 2,
        });
      }
    }
    setStroke(0.28, 1);
    for (let i = 0; i < cells.length; i += 1) {
      const current = cells[i];
      const right = cells[i + 1];
      const down = cells[i + cols];
      if (right && (i + 1) % cols !== 0) {
        ctx.beginPath();
        ctx.moveTo(current.x + 8, current.y + 8);
        ctx.lineTo(right.x + 8, right.y + 8);
        ctx.stroke();
      }
      if (down) {
        ctx.beginPath();
        ctx.moveTo(current.x + 8, current.y + 8);
        ctx.lineTo(down.x + 8, down.y + 8);
        ctx.stroke();
      }
    }
    setStroke(0.42, 1.1);
    for (const cell of cells) {
      ctx.strokeRect(cell.x, cell.y, 16, 16);
      setFill(0.16);
      ctx.fillRect(cell.x + 6, cell.y + 6, 4, 4);
    }
  }

  function drawHashChain(x, y, length, phase) {
    setStroke(0.34, 1.25);
    let previous = null;
    for (let i = 0; i < length; i += 1) {
      const cell = {
        x: x + i * 46,
        y: y + Math.sin(phase + i * 0.9) * 10,
      };
      if (previous) {
        ctx.beginPath();
        ctx.moveTo(previous.x + 22, previous.y + 11);
        ctx.lineTo(cell.x, cell.y + 11);
        ctx.stroke();
      }
      ctx.strokeRect(cell.x, cell.y, 22, 22);
      setFill(0.22);
      ctx.fillRect(cell.x + 8, cell.y + 8, 6, 6);
      previous = cell;
    }
  }

  function render(time = 0) {
    const phase = time * 0.00055;
    ctx.clearRect(0, 0, width, height);
    drawAtom(width * 0.16, height * 0.2, Math.min(116, width * 0.12), phase);
    drawAtom(width * 0.84, height * 0.78, Math.min(98, width * 0.09), -phase * 0.8);
    drawDna(width * 0.78, Math.max(-40, height * 0.05), height * 0.72, Math.min(46, width * 0.045), phase);
    drawDna(width * 0.12, height * 0.5, height * 0.52, Math.min(34, width * 0.035), -phase * 0.65);
    drawBlockLattice(width * 0.56, height * 0.13, 4, 3, 42, phase);
    drawBlockLattice(width * 0.68, height * 0.88, 5, 2, 38, -phase);
    drawHashChain(width * 0.31, height * 0.07, 6, phase);
    drawHashChain(width * 0.58, height * 0.5, 5, -phase);
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
  $('gate').classList.add('hidden');
  $('dashboard').classList.add('hidden');
  if (state.hostedMode && !(await ensureBridgePaired())) return;

  state.config = await api('/api/gate/config');
  setText('tokenLabel', `${state.config.token.requiredAmount} ${state.config.token.symbol}`);
    setText('recipientLabel', `${state.config.recipient.name}`);
  if (!state.config.locked) {
    await unlockDashboard();
  } else {
    $('bridgeGate').classList.add('hidden');
    $('gate').classList.remove('hidden');
    bindGate();
    setText('gateMessage', `Connect the payer wallet, send ${state.config.token.requiredAmount} ${state.config.token.symbol} on Base to ${state.config.recipient.name}, then sign this session challenge to unlock.`);
  }
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

function bindGate() {
  if (state.gateBound) return;
  state.gateBound = true;
  if (walletConnectProjectId()) {
    $('connectWallet').textContent = 'Connect WalletConnect';
  }
  $('connectWallet').addEventListener('click', connectWallet);
  $('payToken').addEventListener('click', payToken);
  $('verifyPayment').addEventListener('click', verifyPayment);
  $('txHash').addEventListener('input', () => {
    $('verifyPayment').disabled = !$('txHash').value.trim();
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function detectWalletProvider() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  await wait(500);
  if (window.ethereum) {
    state.walletProvider = window.ethereum;
    return state.walletProvider;
  }
  const preferred = state.walletProviders.find((item) => /metamask|coinbase|rabby/i.test(`${item.info?.name || ''} ${item.info?.rdns || ''}`));
  const selected = preferred || state.walletProviders[0];
  state.walletProvider = selected?.provider || null;
  return state.walletProvider;
}

async function loadWalletConnect() {
  const projectId = walletConnectProjectId();
  if (!projectId) return null;
  if (!state.walletConnectLoad) {
    state.walletConnectLoad = import(`./reown-wallet.js?v=${ASSET_VERSION}`).then((module) => {
      state.walletConnect = module.createCypherTempreWalletConnect({
        projectId,
        metadata: {
          name: 'Cypher Tempre Timechain Dashboard',
          description: 'Local-first Timechain audit dashboard with Base token-gated access.',
          url: window.location.origin,
          icons: [`${window.location.origin}/favicon.ico`],
        },
      });
      return state.walletConnect;
    });
  }
  return state.walletConnectLoad;
}

async function connectWalletConnect() {
  const connector = await loadWalletConnect();
  if (!connector) return null;
  setText('gateMessage', 'Opening WalletConnect…');
  const { provider, account } = await connector.connect();
  if (!provider?.request || !account) {
    throw new Error('WalletConnect did not return an EVM account.');
  }
  state.walletProvider = provider;
  state.account = account;
  return provider;
}

async function connectInjectedWallet() {
  const provider = await detectWalletProvider();
  if (!provider?.request) {
    throw new Error('No browser wallet detected. Install MetaMask, Coinbase Wallet, Rabby, or configure WalletConnect in dashboard/public/config.js.');
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  if (!accounts?.[0]) throw new Error('Wallet did not return an account.');
  state.account = accounts[0];
  return provider;
}

function walletProvider() {
  if (!state.walletProvider) {
    throw new Error('Wallet disconnected. Connect a wallet first.');
  }
  return state.walletProvider;
}

async function connectWalletProvider() {
  setText('gateMessage', walletConnectProjectId() ? 'Opening WalletConnect…' : 'Looking for browser wallet provider…');
  let provider = null;
  try {
    provider = await connectWalletConnect();
  } catch (error) {
    if (!window.ethereum && !state.walletProviders.length) throw error;
    setText('gateMessage', `WalletConnect did not finish: ${error.message}. Trying browser wallet…`);
  }
  if (!provider) {
    provider = await connectInjectedWallet();
  }
  await ensureBase();
  setText('walletState', `${state.account.slice(0, 6)}…${state.account.slice(-4)} on Base`);
  $('payToken').disabled = false;
  $('verifyPayment').disabled = !$('txHash').value.trim();
  return provider;
}

function normalizeAccount(value) {
  const text = String(value || '').trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) {
    throw new Error('Wallet did not return a valid EVM account.');
  }
  return text;
}

async function activeWalletAccount() {
  const provider = walletProvider();
  try {
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (accounts?.[0]) state.account = normalizeAccount(accounts[0]);
  } catch {
    state.account = normalizeAccount(state.account);
  }
  return normalizeAccount(state.account);
}

async function signPersonalMessage(provider, account, message) {
  try {
    return await provider.request({
      method: 'personal_sign',
      params: [message, account],
    });
  } catch (error) {
    if (error.code === 4001) throw error;
    return provider.request({
      method: 'personal_sign',
      params: [account, message],
    });
  }
}

async function connectWallet() {
  try {
    await connectWalletProvider();
    setText('gateMessage', 'Wallet connected. Pay here, or paste a transaction hash from this same payer wallet and sign to unlock.');
  } catch (error) {
    setText('gateMessage', error.message);
  }
}

async function ensureBase() {
  const provider = walletProvider();
  const current = await provider.request({ method: 'eth_chainId' });
  if (current === state.config.chain.idHex) return;
  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: state.config.chain.idHex }],
    });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: state.config.chain.idHex,
        chainName: 'Base',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: ['https://mainnet.base.org'],
        blockExplorerUrls: ['https://basescan.org'],
      }],
    });
  }
}

function transferData(recipient, amountRaw) {
  const addressWord = recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const valueWord = BigInt(amountRaw).toString(16).padStart(64, '0');
  return `0xa9059cbb${addressWord}${valueWord}`;
}

async function payToken() {
  try {
    await ensureBase();
    const txHash = await walletProvider().request({
      method: 'eth_sendTransaction',
      params: [{
        from: state.account,
        to: state.config.token.address,
        value: '0x0',
        data: transferData(state.config.recipient.address, state.config.token.requiredAmountRaw),
      }],
    });
    $('txHash').value = txHash;
    $('verifyPayment').disabled = false;
    setText('gateMessage', `Submitted ${shortHash(txHash)}. Waiting for confirmation.`);
  } catch (error) {
    setText('gateMessage', error.message);
  }
}

function accessMessage(account, txHash) {
  return state.config.accessMessageTemplate
    .replace('{account}', account.toLowerCase())
    .replace('{txHash}', txHash.toLowerCase());
}

async function verifyPayment() {
  try {
    const txHash = $('txHash').value.trim();
    if (!txHash) throw new Error('Paste a Base transaction hash first.');
    if (!state.walletProvider || !state.account) {
      await connectWalletProvider();
    }
    await ensureBase();
    state.config = await api('/api/gate/config');
    const account = await activeWalletAccount();
    const message = accessMessage(account, txHash);
    setText('gateMessage', 'Sign this session challenge with the payer wallet…');
    const signature = await signPersonalMessage(walletProvider(), account, message);
    setText('gateMessage', 'Verifying signed payment on Base…');
    await api('/api/gate/verify', {
      method: 'POST',
      body: JSON.stringify({ txHash, account, signature }),
    });
    await unlockDashboard();
  } catch (error) {
    setText('gateMessage', error.message);
  }
}

async function unlockDashboard() {
  $('bridgeGate').classList.add('hidden');
  $('gate').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  await loadDashboard();
}

async function loadDashboard() {
  state.summary = await api('/api/timechain/summary');
  renderSummary();
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
