import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const publicDir = path.join(__dirname, 'public');
const execFileAsync = promisify(execFile);

const HOST = process.env.CT_DASHBOARD_HOST || '127.0.0.1';
const PORT = Number(process.env.CT_DASHBOARD_PORT || 8788);
const MAX_JSON_BODY_BYTES = Math.max(1024, Number(process.env.CT_DASHBOARD_MAX_JSON_BODY_BYTES || 20_000));
const SESSION_TTL_MS = Math.max(10 * 60_000, Number(process.env.CT_DASHBOARD_SESSION_TTL_MS || 4 * 60 * 60_000));
const MAX_RING_DETAIL_BYTES = Number(process.env.CT_DASHBOARD_MAX_RING_DETAIL_BYTES || 512_000);
const MAX_BLOB_PREVIEW_BYTES = Number(process.env.CT_DASHBOARD_MAX_BLOB_PREVIEW_BYTES || 128_000);
const DOMAIN_BLOB_TEXT_LIMIT = Number(process.env.CT_DASHBOARD_DOMAIN_BLOB_TEXT_LIMIT || 64_000);
const BRIDGE_TOKEN_TTL_MS = Math.max(10 * 60_000, Number(process.env.CT_DASHBOARD_BRIDGE_TOKEN_TTL_MS || 24 * 60 * 60_000));
const PUBLIC_ORIGINS = new Set(
  (process.env.CT_DASHBOARD_PUBLIC_ORIGINS || 'https://cyphertempre.ai,https://www.cyphertempre.ai')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean),
);
const LOCAL_ORIGIN_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const BRIDGE_PAIR_CODE = createPairingCode(process.env.CT_DASHBOARD_PAIR_CODE || crypto.randomBytes(5).toString('hex'));

const sessions = new Map();
const bridgeTokens = new Map();
let timechainRoot = null;

function lower(value) {
  return String(value || '').toLowerCase();
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizePairingCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function createPairingCode(value) {
  const code = normalizePairingCode(value);
  if (code.length < 8) {
    throw new Error('CT_DASHBOARD_PAIR_CODE must contain at least 8 letters or digits.');
  }
  return code;
}

function displayPairingCode(value) {
  return normalizePairingCode(value).replace(/(.{4})(?=.)/g, '$1-');
}

function timingDigest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function pairingCodeMatches(value) {
  return crypto.timingSafeEqual(timingDigest(normalizePairingCode(value)), timingDigest(BRIDGE_PAIR_CODE));
}

function createSession() {
  const id = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  sessions.set(id, {
    id,
    nonce,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return sessions.get(id);
}

function bridgeRecord(req) {
  const token = String(req.headers['x-ct-bridge-token'] || '').trim();
  if (!token) return null;
  const record = bridgeTokens.get(token);
  if (!record || record.expiresAt < Date.now()) {
    bridgeTokens.delete(token);
    return null;
  }
  return record;
}

function getSession(req, res) {
  const record = bridgeRecord(req);
  if (record) {
    let session = record.sessionId ? sessions.get(record.sessionId) : null;
    if (!session || session.expiresAt < Date.now()) {
      session = createSession();
      record.sessionId = session.id;
    }
    record.expiresAt = Date.now() + BRIDGE_TOKEN_TTL_MS;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  const cookies = parseCookies(req.headers.cookie || '');
  let session = cookies.ctdash ? sessions.get(cookies.ctdash) : null;
  if (!session || session.expiresAt < Date.now()) {
    session = createSession();
    res.setHeader('Set-Cookie', `ctdash=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  }
  return session;
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) out[key] = rest.join('=');
  }
  return out;
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return isTrustedLocalDirectRequest(req);
  try {
    const url = new URL(origin);
    if (LOCAL_ORIGIN_HOSTS.has(url.hostname)) return true;
    return PUBLIC_ORIGINS.has(url.origin);
  } catch {
    return false;
  }
}

function isRemoteOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return !isTrustedLocalDirectRequest(req);
  try {
    return !LOCAL_ORIGIN_HOSTS.has(new URL(origin).hostname);
  } catch {
    return true;
  }
}

function requestHostName(req) {
  const host = String(req.headers.host || '').trim();
  if (!host) return '';
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.replace(/:\d+$/, '');
  }
}

function isLoopbackRemoteAddress(value) {
  const address = String(value || '');
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || address.startsWith('::ffff:127.');
}

function isTrustedLocalDirectRequest(req) {
  const host = requestHostName(req);
  return LOCAL_ORIGIN_HOSTS.has(host) && isLoopbackRemoteAddress(req.socket?.remoteAddress);
}

function applyCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (!origin || !allowedOrigin(req)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ct-bridge-token');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method');
  if (req.headers['access-control-request-private-network']) {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
}

function requireBridgePairing(req) {
  // The no-token local fast path is granted only when the request is BOTH
  // local-looking AND arrives on a loopback socket — a forged `Origin: localhost`
  // from a non-loopback client (possible only if the operator bound the bridge
  // to a non-loopback address) is treated as remote and must present a token.
  if (!isRemoteOrigin(req) && isLoopbackRemoteAddress(req.socket?.remoteAddress)) return;
  if (bridgeRecord(req)) return;
  const error = new Error('Pair this browser with the local Cypher Tempre bridge first.');
  error.status = 401;
  throw error;
}

function securityHeaders() {
  return {
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "img-src 'self' data: blob: https:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function discoverTimechainRoot() {
  const explicit = process.env.CT_DASHBOARD_ROOT || process.env.CT_TIMECHAIN_ROOT;
  const candidates = [
    explicit,
    path.join(os.homedir(), '.codex', 'skills', 'cypher-tempre-self-model'),
    path.join(os.homedir(), '.claude', 'skills', 'cypher-tempre-self-model'),
    path.join(os.homedir(), '.openclaw', 'workspace', 'skills', 'cypher-tempre-self-model'),
    path.join(repoRoot, 'skills', 'codex', 'cypher-tempre-self-model'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (await isSkillRoot(resolved)) return await fs.realpath(resolved);
  }
  throw new Error('No Cypher Tempre skill root found. Set CT_DASHBOARD_ROOT to a local cypher-tempre-self-model directory.');
}

async function isSkillRoot(root) {
  const required = ['SKILL.md', 'timechain.py', 'registry/modalities.json', 'registry/senses.json'];
  for (const rel of required) {
    if (!fsSync.existsSync(path.join(root, rel))) return false;
  }
  return true;
}

function ensureInsideRoot(target) {
  const resolved = path.resolve(target);
  const prefix = `${timechainRoot}${path.sep}`;
  if (resolved !== timechainRoot && !resolved.startsWith(prefix)) {
    throw new Error('Path escapes configured Timechain root.');
  }
  return resolved;
}

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function loadRings() {
  const ringsPath = ensureInsideRoot(path.join(timechainRoot, 'chain', 'rings.jsonl'));
  if (!fsSync.existsSync(ringsPath)) return [];
  const text = await fs.readFile(ringsPath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line, lineIndex) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return { index: lineIndex, ring_type: 'parse-error', payload: { error: error.message }, ring_hash: null };
    }
  });
}

async function loadRegistries() {
  const modalitiesPath = ensureInsideRoot(path.join(timechainRoot, 'registry', 'modalities.json'));
  const sensesPath = ensureInsideRoot(path.join(timechainRoot, 'registry', 'senses.json'));
  const emergentPath = ensureInsideRoot(path.join(timechainRoot, 'registry', 'emergent.json'));
  const modalities = (await readJsonSafe(modalitiesPath, { modalities: [] })).modalities || [];
  const senses = (await readJsonSafe(sensesPath, { senses: [] })).senses || [];
  const emergentRaw = await readJsonSafe(emergentPath, {});
  const emergent = Array.isArray(emergentRaw) ? emergentRaw : Object.values(emergentRaw).flat().filter(Boolean);
  return { modalities, senses, emergent };
}

async function loadBlockspace() {
  const indexPath = ensureInsideRoot(path.join(timechainRoot, 'chain', 'blockspace', 'index.json'));
  const blobsDir = ensureInsideRoot(path.join(timechainRoot, 'chain', 'blockspace', 'blobs'));
  const index = await readJsonSafe(indexPath, {});
  const entries = Object.entries(index).map(([hash, meta]) => ({
    hash,
    size: Number(meta.size || 0),
    filename: meta.filename || '',
    mime: meta.mime || '',
    added_at: meta.added_at || '',
  }));
  let blobFiles = [];
  try {
    blobFiles = await fs.readdir(blobsDir);
  } catch {
    blobFiles = [];
  }
  return {
    entries,
    blobFiles,
    totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
  };
}

async function verifyChainWithPython() {
  const script = `
import json, hashlib, sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
rings_path = root / "chain" / "rings.jsonl"
genesis_prev = "0" * 64
def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
def h(data):
    return hashlib.sha256(data).hexdigest()
def ring_hash(ring):
    return h(canonical({k: v for k, v in ring.items() if k != "ring_hash"}))
ok = True
report = []
rings = []
if rings_path.exists():
    for line in rings_path.read_text().splitlines():
        line = line.strip()
        if line:
            rings.append(json.loads(line))
if not rings:
    print(json.dumps({"ok": True, "report": ["empty chain"], "rings": 0}))
    raise SystemExit
prev = genesis_prev
for i, ring in enumerate(rings):
    if ring.get("index") != i:
        ok = False
        report.append(f"ring {i}: index mismatch (got {ring.get('index')})")
    if ring.get("prev_hash") != prev:
        ok = False
        report.append(f"ring {i}: prev_hash broken")
    recomputed = ring_hash(ring)
    if recomputed != ring.get("ring_hash"):
        ok = False
        report.append(f"ring {i}: ring_hash mismatch")
    for ref in ring.get("blockspace_refs", []):
        bh = ref.get("hash")
        blob = root / "chain" / "blockspace" / "blobs" / str(bh)
        if not blob.exists():
            ok = False
            report.append(f"ring {i}: blockspace blob missing ({ref.get('role')})")
        elif h(blob.read_bytes()) != bh:
            ok = False
            report.append(f"ring {i}: blockspace blob corrupted ({ref.get('role')})")
    prev = ring.get("ring_hash")
if ok:
    report.append(f"verified {len(rings)} rings -> chain intact, all hashes link, blockspace consistent")
print(json.dumps({"ok": ok, "report": report, "rings": len(rings)}))
`;
  // Bounded + memoized on chain state: a hammered GET must not fork unbounded
  // python verifier processes. memoizedRead is defined below (hoisted at call time).
  try {
    const tag = await chainStateTag();
    return await memoizedRead(`chain-verify:${tag}`, async () => {
      const { stdout } = await execFileAsync('python3', ['-c', script, timechainRoot], {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      return JSON.parse(stdout);
    });
  } catch (error) {
    return {
      ok: null,
      report: [`python verifier unavailable: ${error.message}`],
      rings: null,
    };
  }
}


// --------------------------------------------------------------------------- //
// P1 — the learning membrane, audited. Everything below is a read-only view of
// files the bridge already trusts: rings.jsonl (operators, dreams, digests),
// telemetry.jsonl (economics), replay.json (the antecedent ledger), and the
// consensus directory (witness quorum). No skill code runs; no data leaves.
// --------------------------------------------------------------------------- //

async function consensusStatus(rings) {
  const cfgPath = path.join(timechainRoot, 'chain', 'consensus', 'config.json');
  if (!fsSync.existsSync(cfgPath)) return { configured: false, ok: null };
  try {
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    const witnesses = cfg.witnesses || [];
    const quorum = Number(cfg.quorum ?? cfg.k ?? Math.ceil((witnesses.length * 2) / 3));
    const head = rings.at(-1);
    if (!head) return { configured: true, ok: null, detail: 'empty chain', quorum, witnesses: witnesses.length };
    const attPath = path.join(timechainRoot, 'chain', 'consensus', 'attestations.jsonl');
    const byWitness = new Map();
    if (fsSync.existsSync(attPath)) {
      for (const line of (await fs.readFile(attPath, 'utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue;
        let att;
        try { att = JSON.parse(line); } catch { continue; }
        if (att.height === head.index && att.ring_hash === head.ring_hash) byWitness.set(att.witness, att.mac);
      }
    }
    const msg = `${head.index}:${head.ring_hash}`;
    let valid = 0;
    for (const w of witnesses) {
      const mac = crypto.createHmac('sha256', Buffer.from(String(w.key), 'hex')).update(msg).digest('hex');
      if (byWitness.get(w.id) === mac) valid += 1;
    }
    return { configured: true, ok: valid >= quorum, validWitnesses: valid,
             witnesses: witnesses.length, quorum, head: head.index };
  } catch (error) {
    return { configured: true, ok: null, detail: error.message };
  }
}

async function telemetryDigestStatus(rings) {
  const telPath = path.join(timechainRoot, 'chain', 'telemetry.jsonl');
  const digests = rings
    .filter((r) => r.payload?.telemetry_digest)
    .map((r) => ({ ring: r.index, ...r.payload.telemetry_digest }));
  if (!fsSync.existsSync(telPath)) {
    return { present: false, digests: digests.length, ok: digests.length ? false : null, notarized: 0, bytes: 0 };
  }
  const raw = await fs.readFile(telPath);
  let ok = digests.length ? true : null;
  const report = [];
  for (const d of digests) {
    const seg = raw.subarray(d.from_offset, d.to_offset);
    const good = crypto.createHash('sha256').update(seg).digest('hex') === d.segment_sha256;
    if (!good) ok = false;
    report.push({ ring: d.ring, from: d.from_offset, to: d.to_offset, ok: good });
  }
  return { present: true, ok, digests: digests.length, bytes: raw.length,
           notarized: digests.at(-1)?.to_offset || 0, report };
}

async function telemetryOverview() {
  const telPath = path.join(timechainRoot, 'chain', 'telemetry.jsonl');
  const counts = {};
  let total = 0;
  let lastTs = null;
  let tokensCum = 0;
  const tokensSavedSeries = [];
  if (fsSync.existsSync(telPath)) {
    for (const line of (await fs.readFile(telPath, 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      counts[e.event] = (counts[e.event] || 0) + 1;
      total += 1;
      lastTs = e.ts || lastTs;
      if (e.event === 'replay-accept') {
        tokensCum += Number(e.data?.tokens_saved || 0);
        tokensSavedSeries.push({ x: total, y: tokensCum, ts: e.ts });
      }
    }
  }
  const routed = counts['route'] || 0;
  return { total, counts, lastTs, tokensSavedTotal: tokensCum, tokensSavedSeries,
           missedPositives: counts['missed-positive'] || 0, routeEvents: routed };
}

function operatorsTimeline(rings) {
  return rings
    .filter((r) => r.ring_type === 'operator')
    .map((r) => {
      const p = r.payload || {};
      return {
        index: r.index,
        ts: r.timestamp,
        operator: p.operator || null,
        action: p.action || null,
        version: p.scorer?.scorer_version || p.lens_version || p.labeler_version || null,
        eval: p.scorer?.eval || p.eval || null,
        revertedTo: p.reverted_to || null,
        summary: p.summary || '',
      };
    });
}

function dreamsTimeline(rings) {
  return rings
    .filter((r) => r.ring_type === 'dream')
    .map((r) => {
      const d = r.payload?.dream || {};
      const training = {};
      for (const [k, v] of Object.entries(d.training || {})) {
        if (!v || typeof v !== 'object') continue;
        training[k] = v.error ? 'error' : v.adopted ? `adopted ${v.version || ''}`.trim() : 'held';
      }
      return {
        index: r.index,
        ts: r.timestamp,
        summary: r.payload?.summary || '',
        verify: d.verify || null,
        missedPositives: d.missed_positives?.mined ?? null,
        training,
        growthProposals: (d.growth?.proposals || []).length,
        salienceRings: d.salience?.rings ?? null,
        durationS: d.duration_s ?? null,
      };
    });
}

function qualitySeries(rings) {
  const brightness = [];
  const spanGrounding = [];
  for (const r of rings) {
    if (typeof r.poq?.brightness === 'number') brightness.push({ x: r.index, y: r.poq.brightness });
    const sg = r.payload?.poq_verdict?.span_grounding?.span_grounding;
    if (typeof sg === 'number') spanGrounding.push({ x: r.index, y: sg });
  }
  return { brightness, spanGrounding };
}

async function replayOverview() {
  const ledgerPath = path.join(timechainRoot, 'chain', 'replay.json');
  if (!fsSync.existsSync(ledgerPath)) return { present: false, rings: 0, accepts: 0, rederiveDue: 0 };
  try {
    const ledger = JSON.parse(await fs.readFile(ledgerPath, 'utf8'));
    const entries = Object.entries(ledger).filter(([, v]) => v && typeof v === 'object');
    return {
      present: true,
      rings: entries.length,
      accepts: entries.reduce((sum, [, v]) => sum + Number(v.accepts || 0), 0),
      rederiveDue: entries.filter(([, v]) => v.rederive_due).length,
    };
  } catch (error) {
    return { present: true, error: error.message };
  }
}

async function buildLearningOverview() {
  const rings = await loadRings();
  const [verification, consensus, digests, telemetry, replay] = await Promise.all([
    verifyChainWithPython(),
    consensusStatus(rings),
    telemetryDigestStatus(rings),
    telemetryOverview(),
    replayOverview(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    integrity: { chain: verification, consensus, digests },
    operators: operatorsTimeline(rings),
    dreams: dreamsTimeline(rings),
    telemetry,
    replay,
    quality: qualitySeries(rings),
  };
}

function countBy(items, getKey) {
  const counts = new Map();
  for (const item of items) {
    const key = getKey(item) || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
}

function compactRing(ring) {
  const payload = ring.payload || {};
  const labels = payload.labels || {};
  const summary = payload.summary || payload.synthesis || payload.context || payload.event || payload.task || ring.ring_type;
  return {
    index: ring.index,
    type: ring.ring_type,
    timestamp: ring.timestamp,
    hash: ring.ring_hash,
    prevHash: ring.prev_hash,
    brightness: ring.poq?.brightness ?? null,
    blockspaceRefs: ring.blockspace_refs || [],
    summary: truncate(String(summary || ''), 360),
    keywords: labels.keywords || [],
    entities: labels.entities || [],
    modalities: (labels.modalities || []).map((x) => x.name || x.id).slice(0, 8),
    senses: (labels.senses || []).map((x) => x.name || x.id).slice(0, 8),
  };
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function ringText(ring) {
  return JSON.stringify(ring.payload || {}) + ' ' + (ring.ring_type || '') + ' ' + JSON.stringify(ring.blockspace_refs || []);
}

function estimateTokens(text) {
  return Math.ceil((text || '').split(/\s+/).filter(Boolean).length * 1.25);
}

const DOMAIN_RULES = [
  ['Timechain & Self-Model', ['timechain', 'ring', 'poq', 'modality', 'modalities', 'sense', 'senses', 'continuum', 'chronosynaptic', 'cambium', 'immune', 'self-model', 'recursive', 'genesis']],
  ['Code & Software', ['code', 'repo', 'repository', 'function', 'class', 'python', 'javascript', 'typescript', 'test', 'commit', 'git', 'source', 'linux', 'bitcoin', 'kubernetes']],
  ['Security & Audit', ['audit', 'vulnerability', 'exploit', 'tamper', 'risk', 'verify', 'verification', 'consensus', 'policy', 'rollback', 'compliance']],
  ['Finance & Markets', ['nasdaq', 'market', 'trading', 'trade', 'drawdown', 'price', 'volume', 'return', 'cagr', 'token', 'wallet', 'payment']],
  ['Blockchain & Web3', ['ethereum', 'base', 'erc20', 'wallet', 'transaction', 'contract', 'bitcoin', 'chain', 'block', 'hash', 'token', 'onchain']],
  ['Biology & Genomics', ['genome', 'dna', 'chromosome', 'sequence', 'entropy', 'gene', 'genomic', 'basepair', 'grch']],
  ['Data Science & Statistics', ['data', 'dataset', 'json', 'csv', 'statistics', 'quantile', 'distribution', 'outlier', 'regression', 'model']],
  ['Documents & Writing', ['document', 'report', 'readme', 'markdown', 'summary', 'poster', 'writing', 'changelog']],
  ['Design & Frontend', ['dashboard', 'frontend', 'ui', 'browser', 'react', 'css', 'layout', 'visual']],
  ['Operations & Packaging', ['release', 'package', 'zip', 'install', 'deploy', 'ci', 'selftest', 'version']],
  ['Law & Governance', ['legal', 'regulation', 'fiduciary', 'sec', 'finra', 'governance', 'compliance']],
  ['Research & Knowledge', ['research', 'paper', 'finding', 'evidence', 'hypothesis', 'analysis', 'source']],
];

async function buildDomains(rings, blockspace) {
  const domains = new Map();
  const add = (name, score, ring, term, tokens) => {
    if (!domains.has(name)) {
      domains.set(name, { name, score: 0, rings: new Set(), terms: new Map(), approxTokens: 0 });
    }
    const d = domains.get(name);
    d.score += score;
    d.approxTokens += tokens;
    if (ring != null) d.rings.add(ring);
    d.terms.set(term, (d.terms.get(term) || 0) + 1);
  };

  for (const ring of rings) {
    const text = ringText(ring).toLowerCase();
    const tokens = estimateTokens(text);
    for (const [domain, terms] of DOMAIN_RULES) {
      for (const term of terms) {
        const hits = text.split(term).length - 1;
        if (hits > 0) add(domain, hits, ring.index, term, tokens);
      }
    }
    const labels = ring.payload?.labels || {};
    for (const keyword of labels.keywords || []) {
      add(`Keyword: ${String(keyword).slice(0, 36)}`, 0.25, ring.index, keyword, Math.max(1, Math.round(tokens / 12)));
    }
    const data = ring.payload?.data || {};
    if (data.language) add(`Language: ${data.language}`, 2, ring.index, data.language, tokens);
    if (data.top_dir) add(`Top Dir: ${data.top_dir}`, 1, ring.index, data.top_dir, tokens);
    if (data.path_role) add(`Role: ${data.path_role}`, 1, ring.index, data.path_role, tokens);
  }

  for (const entry of blockspace.entries) {
    const textBits = [entry.filename, entry.mime].join(' ').toLowerCase();
    for (const [domain, terms] of DOMAIN_RULES) {
      for (const term of terms) {
        const hits = textBits.split(term).length - 1;
        if (hits > 0) add(domain, hits, null, term, estimateTokens(textBits));
      }
    }
    if (entry.size && entry.size <= DOMAIN_BLOB_TEXT_LIMIT && /^[0-9a-f]{64}$/i.test(entry.hash)) {
      try {
        const blobPath = ensureInsideRoot(path.join(timechainRoot, 'chain', 'blockspace', 'blobs', entry.hash));
        const buffer = await fs.readFile(blobPath);
        if (looksText(buffer)) {
          const text = buffer.toString('utf8').toLowerCase();
          for (const [domain, terms] of DOMAIN_RULES) {
            for (const term of terms) {
              const hits = text.split(term).length - 1;
              if (hits > 0) add(domain, Math.min(hits, 20), null, term, estimateTokens(text));
            }
          }
        }
      } catch {
        // Blob disappeared or is unreadable; integrity status will surface elsewhere.
      }
    }
  }

  return [...domains.values()]
    .filter((d) => d.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((d) => ({
      name: d.name,
      score: Number(d.score.toFixed(2)),
      ringCount: d.rings.size,
      approxTokens: d.approxTokens,
      evidenceTerms: [...d.terms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([term, count]) => ({ term, count })),
      sampleRings: [...d.rings].slice(0, 8),
    }));
}

function looksText(buffer) {
  if (!buffer.length) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 0 || (byte < 7) || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length < 0.02;
}

async function buildSummary() {
  const [rings, registries, blockspace] = await Promise.all([loadRings(), loadRegistries(), loadBlockspace()]);
  const verification = await verifyChainWithPython();
  const latest = rings.at(-1) || null;
  const poqScores = rings.map((ring) => ring.poq?.brightness).filter((n) => typeof n === 'number');
  const continuumRings = rings.filter((ring) => ring.ring_type === 'continuum');
  const maxContinuumTokens = Math.max(0, ...continuumRings.map((ring) => ring.payload?.state?.metrics?.approx_tokens_ingested || 0));
  const domains = await buildDomains(rings, blockspace);

  return {
    root: timechainRoot,
    generatedAt: new Date().toISOString(),
    verification,
    stats: {
      rings: rings.length,
      modalities: registries.modalities.length,
      senses: registries.senses.length,
      emergent: registries.emergent.length,
      blockspaceEntries: blockspace.entries.length,
      blockspaceFiles: blockspace.blobFiles.length,
      blockspaceBytes: blockspace.totalBytes,
      blockspaceRefs: rings.reduce((sum, ring) => sum + (ring.blockspace_refs || []).length, 0),
      continuumBlocks: continuumRings.length,
      approxContinuumTokens: maxContinuumTokens,
      averageBrightness: poqScores.length ? poqScores.reduce((a, b) => a + b, 0) / poqScores.length : null,
    },
    latest: latest ? compactRing(latest) : null,
    ringTypes: countBy(rings, (ring) => ring.ring_type),
    modalityCategories: countBy(registries.modalities, (item) => item.category),
    senseCategories: countBy(registries.senses, (item) => item.category),
    domains,
  };
}

async function ringDetail(index) {
  const rings = await loadRings();
  const ring = rings.find((item) => Number(item.index) === Number(index));
  if (!ring) return null;
  const raw = JSON.stringify(ring);
  if (Buffer.byteLength(raw, 'utf8') > MAX_RING_DETAIL_BYTES) {
    return { ...compactRing(ring), payload: { notice: `Ring payload is larger than ${MAX_RING_DETAIL_BYTES} bytes; compact view only.` } };
  }
  return ring;
}

async function listRings(url) {
  const rings = await loadRings();
  const query = (url.searchParams.get('q') || '').toLowerCase();
  const type = url.searchParams.get('type') || '';
  const filtered = rings.filter((ring) => {
    if (type && ring.ring_type !== type) return false;
    if (!query) return true;
    return ringText(ring).toLowerCase().includes(query);
  });
  return {
    total: filtered.length,
    rings: filtered.map(compactRing).reverse(),
  };
}

async function listBlockspace() {
  const blockspace = await loadBlockspace();
  return {
    total: blockspace.entries.length,
    totalBytes: blockspace.totalBytes,
    entries: blockspace.entries.sort((a, b) => b.size - a.size),
  };
}

async function blobPreview(hash) {
  if (!/^[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Invalid blockspace hash.');
  const blobPath = ensureInsideRoot(path.join(timechainRoot, 'chain', 'blockspace', 'blobs', hash));
  const stat = await fs.stat(blobPath);
  const buffer = await fs.readFile(blobPath);
  const actual = sha256Hex(buffer);
  const text = looksText(buffer);
  return {
    hash,
    size: stat.size,
    verified: actual === lower(hash),
    text,
    preview: text ? buffer.subarray(0, MAX_BLOB_PREVIEW_BYTES).toString('utf8') : '',
    truncated: text && buffer.length > MAX_BLOB_PREVIEW_BYTES,
  };
}

// --------------------------------------------------------------------------- //
// P2 — the CPHY token metaprogramming observatory. Read lanes mirror the files
// the economy itself replays (chain/cphy/ledger.jsonl is the source of truth;
// registry/cphy/*.json are derived snapshots). Mutations shell out to the
// skill's own CLIs — the bridge never invents an economic operation, it only
// relays the owner's consent. Doctrine surfaced verbatim: tokens buy salience,
// never truth (I1); the multiplier is clamped 0.25x-4x (I2); etches cap below
// the current turn's top (ETCH_CEILING); the bridge makes NO outbound network
// calls — on-chain burns are observed by the agent's own turn loop, never here.
// --------------------------------------------------------------------------- //

const EXP_CAP = 2.0;                 // mirrors cphy.py:60 — log2 clamp ±2 → [0.25x, 4x]
const ETCH_MAX_ECHELON = 21;         // mirrors cphy.py:749
const ETCH_CEILING = 0.97;           // mirrors cphy.py:751
const MAX_PACK_BODY_BYTES = Math.max(1024 * 1024, Number(process.env.CT_DASHBOARD_MAX_PACK_BODY_BYTES || 8 * 1024 * 1024));
const PY_READ_TIMEOUT_MS = 30_000;
const PY_MUTATE_TIMEOUT_MS = 90_000;

function clampMultiplier(exponent) {
  const e = Math.max(-EXP_CAP, Math.min(EXP_CAP, Number(exponent) || 0));
  return Number(Math.pow(2, e).toFixed(4));
}

async function readLedgerEvents() {
  const ledgerPath = ensureInsideRoot(path.join(timechainRoot, 'chain', 'cphy', 'ledger.jsonl'));
  if (!fsSync.existsSync(ledgerPath)) return [];
  const text = await fs.readFile(ledgerPath, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return { kind: 'parse-error', error: error.message };
    }
  });
}

// One serialized queue for every operation that shells into the skill: the
// economy's writers assume a single writer, and the ledger is append-only.
let mutationQueue = Promise.resolve();
function enqueueMutation(fn) {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.catch(() => {});
  return next;
}

// A bounded pool for READ shell-outs (chain verify, cphy audit, retrieval
// preview). These are read-only so they need not serialize like writes, but
// an already-trusted page must not be able to fork unbounded python processes
// by hammering a GET — cap the concurrent count and queue the overflow.
const MAX_READ_PROCS = Math.max(1, Number(process.env.CT_DASHBOARD_MAX_READ_PROCS || 2));
let activeReadProcs = 0;
const readWaiters = [];
function enqueueRead(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      activeReadProcs += 1;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        activeReadProcs -= 1;
        const next = readWaiters.shift();
        if (next) next();
      });
    };
    if (activeReadProcs < MAX_READ_PROCS) run();
    else readWaiters.push(run);
  });
}

// Short-TTL memo for read shell-outs keyed on the chain/ledger state they read,
// so identical concurrent GETs reuse one subprocess instead of forking N.
const readMemo = new Map();
async function memoizedRead(key, fn, ttlMs = 4000) {
  const hit = readMemo.get(key);
  const now = memoNow();
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = await enqueueRead(fn);
  readMemo.set(key, { value, at: memoNow() });
  if (readMemo.size > 64) {
    for (const k of readMemo.keys()) { readMemo.delete(k); if (readMemo.size <= 32) break; }
  }
  return value;
}

// A monotonic-ish clock that tolerates environments where Date is unavailable.
function memoNow() {
  try { return Date.now(); } catch { return 0; }
}

async function chainStateTag() {
  // Cheap fingerprint of the two files the read shell-outs depend on.
  const parts = [];
  for (const rel of [['chain', 'rings.jsonl'], ['chain', 'cphy', 'ledger.jsonl']]) {
    try {
      const stat = await fs.stat(path.join(timechainRoot, ...rel));
      parts.push(`${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push('none');
    }
  }
  return parts.join('|');
}

async function runSkillCli(scriptName, args, { timeout = PY_MUTATE_TIMEOUT_MS, env = {} } = {}) {
  const script = path.join(timechainRoot, scriptName);
  if (!fsSync.existsSync(script)) {
    throw httpError(`${scriptName} not found in the paired skill root.`, 501);
  }
  try {
    const { stdout, stderr } = await execFileAsync('python3', [script, ...args], {
      cwd: timechainRoot,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error.stdout || '', stderr: error.stderr || '', message: error.message };
  }
}

function parseMaybeJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

async function cphyOverview() {
  const registryDir = path.join(timechainRoot, 'registry', 'cphy');
  const [weights, onchain, anchor, pending, events] = await Promise.all([
    readJsonSafe(path.join(registryDir, 'weights.json'), null),
    readJsonSafe(path.join(registryDir, 'onchain.json'), null),
    readJsonSafe(path.join(registryDir, 'anchor.json'), null),
    readJsonSafe(path.join(registryDir, 'pending.json'), []),
    readLedgerEvents(),
  ]);

  // Fold the ledger's on-chain lanes (weights.json carries only the lock lane).
  // Mirror cphy.py's compile_state semantics exactly: on-chain observations and
  // etch tokens are CUMULATIVE snapshots per ring, so later events REPLACE (never
  // add to) earlier ones — compile_state keeps the LAST observation set and the
  // LAST etch per ring, not the sum. Getting this wrong inflates the burn total.
  let observed = {};              // ring index -> cumulative tokens observed on-chain (last-wins)
  let observedRate = 1;           // density_per_token RECORDED IN the last observe event —
                                  // compile_state/WeightMap apply this frozen rate, not the
                                  // current config value, which diverges after a rate change
  const etches = {};              // ring index -> {tokens (cumulative), echelon}
  const unlockMap = new Map();    // faculty key -> last unlock event (cumulative tokens),
                                  // mirroring compile_state's dict: last-wins, never summed
  const kindCounts = {};
  for (const ev of events) {
    kindCounts[ev.kind] = (kindCounts[ev.kind] || 0) + 1;
    if (ev.kind === 'onchain-observe' && ev.observations) {
      observed = {};              // last-wins replacement, matching compile_state
      for (const [idx, tokens] of Object.entries(ev.observations)) {
        observed[idx] = Number(tokens) || 0;
      }
      observedRate = Number(ev.density_per_token ?? 1) || 1;
    }
    if (ev.kind === 'etch' && ev.ring != null) {
      const tokens = Number(ev.tokens) || 0;
      const echelon = Math.min(ETCH_MAX_ECHELON, Math.max(0, Math.trunc(tokens)));
      // Deepening top-ups append a new etch whose tokens is the cumulative total;
      // keep the latest (highest echelon), never accumulate across events.
      etches[ev.ring] = { tokens, echelon, address: ev.address || null, ts: ev.ts || null };
    }
    // Faculty-unlock: cphy.py's append_event lets the faculty kind field shadow
    // the top-level event kind (a skill-side collision), so the on-disk event
    // reads kind='sense'/'modality'. Detect unlocks by their faculty_key instead.
    if (ev.faculty_key != null || ev.kind === 'faculty-unlock') {
      // Unlock tokens are the cumulative balance of the faculty's deposit
      // address, so a repeated event for the same faculty REPLACES the earlier
      // one (compile_state keys unlocks by faculty_key) — summing would double-count.
      unlockMap.set(ev.faculty_key ?? `event-${ev.seq}`, { facultyKey: ev.faculty_key, kind: ev.faculty_kind ?? ev.kind, id: ev.id, name: ev.name, tokens: Number(ev.tokens) || 0, ts: ev.ts });
    }
  }
  const unlocks = [...unlockMap.values()];
  // Burn total = the LAST cumulative burn per etched ring + the LAST cumulative
  // burn per unlocked faculty — never the sum of superseded snapshots.
  const burnedTotal = Object.values(etches).reduce((sum, e) => sum + (Number(e.tokens) || 0), 0)
    + unlocks.reduce((sum, u) => sum + (Number(u.tokens) || 0), 0);

  // Ledger integrity: the skill's own replay is authoritative (python float repr
  // differs from JS, so we do not re-hash in JS — we ask the organ itself).
  // Fail-soft like verifyChainWithPython: a root without cphy.py still audits.
  // Bounded + memoized on chain state so repeated GETs can't fork unbounded procs.
  let auditLine = '';
  let auditOk = null;
  try {
    const tag = await chainStateTag();
    const audit = await memoizedRead(`cphy-audit:${tag}`, () => runSkillCli('cphy.py', ['audit'], { timeout: PY_READ_TIMEOUT_MS }));
    auditLine = (audit.stdout || audit.stderr || '').trim().split(/\r?\n/).pop() || '';
    // cmd_audit exits 1 on tamper (printing "FAIL  ..."), so ok:false with a
    // FAIL line IS the tamper verdict — only an inconclusive failure (timeout,
    // crash with no verdict) maps to null alongside a missing cphy.py.
    auditOk = audit.ok
      ? /AUDIT:\s*PASS/.test(auditLine)
      : /FAIL/i.test(`${audit.stdout || ''}\n${audit.stderr || ''}`) ? false : null;
  } catch {
    auditLine = 'cphy.py not present in this root — ledger replay unavailable';
  }

  return {
    present: Boolean(weights || onchain || events.length),
    doctrine: 'CPHY programs attention, never truth: tokens buy retrieval salience (clamped 0.25x-4x), PoQ judgment is never for sale.',
    supply: weights ? {
      minted: weights.minted ?? null,
      locked: weights.locked ?? null,
      balance: weights.balance ?? null,
      events: weights.events ?? events.length,
      ledgerHead: weights.ledger_head ?? null,
    } : null,
    burnedTotal: Number(burnedTotal.toFixed(6)),
    audit: { ok: auditOk, line: auditLine },
    anchor,
    onchain: onchain ? {
      token: onchain.token ?? null,
      chain: onchain.chain ?? null,
      rpc: onchain.rpc ?? null,
      densityPerToken: onchain.density_per_token ?? null,
      approval: onchain.approval || 'require',
      etchRecallN: onchain.etch_recall_n ?? 3,
      lastSyncTs: onchain.last_sync_ts ?? null,
      targets: Object.entries(onchain.targets || {}).map(([ring, t]) => ({
        ring: Number(ring),
        address: t.address,
        ringHash: t.ring_hash,
        // Real-token accounting: cumulative CPHY (Base) burned to this ring
        // across all rotations, and which one-shot rotation is current.
        burnedTotal: Number(t.burned_total || 0),
        rotation: Number(t.rotation || 0),
      })),
      facultyTargets: Object.entries(onchain.faculty_targets || {}).map(([key, t]) => ({
        key, kind: t.kind, id: t.id, name: t.name, address: t.address, status: t.status,
      })),
    } : null,
    locks: (weights?.active_locks || []).map((lock) => ({
      lockId: lock.lock_id,
      op: lock.op,
      amount: lock.amount,
      // Bridge locks carry a_indices/b_indices instead of indices; both
      // endpoints receive density (compile_exponents), so both are covered.
      indices: lock.indices || [...(lock.a_indices || []), ...(lock.b_indices || [])],
      memo: lock.memo || '',
      ts: lock.ts || null,
    })),
    exponents: weights?.exponents || {},
    observed,
    observedRate,
    etches,
    unlocks,
    pending: (Array.isArray(pending) ? pending : []).map((item) => ({
      id: item.id,
      status: item.status,
      type: item.type,
      ring: item.ring ?? null,
      facultyKey: item.faculty_key ?? null,
      name: item.name ?? null,
      tokens: item.tokens ?? null,
      address: item.address ?? null,
      detected: item.detected ?? null,
      resolved: item.resolved ?? null,
    })),
    ledgerKinds: kindCounts,
    constants: { expCap: EXP_CAP, etchMaxEchelon: ETCH_MAX_ECHELON, etchCeiling: ETCH_CEILING },
  };
}

// The per-block token audit map: every ring the economy touches, with the
// weight it actually exerts on retrieval (clamped), what was burned to it,
// and its dream-written salience RESONANCE. Note: chain/salience.json is a
// SIGNED resonance overlay (dream.py), not a retrieval hit count — a positive
// value is reinforced salience, a negative value is dampened. The true
// surfacing frequency lives in the offer telemetry (see retrievalHistory).
async function cphyBlocks() {
  const overview = await cphyOverview();
  const saliencePath = path.join(timechainRoot, 'chain', 'salience.json');
  const resonance = await readJsonSafe(saliencePath, {});
  const blocks = new Map();
  const touch = (index) => {
    const key = Number(index);
    if (!blocks.has(key)) {
      blocks.set(key, {
        index: key, exponent: 0, multiplier: 1, locks: [], observedTokens: 0,
        etch: null, depositAddress: null, resonance: Number(resonance[key] ?? resonance[String(key)] ?? 0),
      });
    }
    return blocks.get(key);
  };
  for (const [idx, exp] of Object.entries(overview.exponents)) {
    const b = touch(idx);
    b.exponent = Number(exp) || 0;
  }
  for (const lock of overview.locks) {
    for (const idx of lock.indices) {
      const b = touch(idx);
      b.locks.push(lock.lockId);
    }
  }
  for (const [idx, tokens] of Object.entries(overview.observed)) {
    const b = touch(idx);
    b.observedTokens = tokens;
    // WeightMap.load applies the rate FROZEN INTO the last observe event
    // (positive contributions only) — not the current config rate.
    b.exponent += Math.max(0, tokens) * (overview.observedRate ?? 1);
  }
  for (const [idx, etch] of Object.entries(overview.etches)) {
    const b = touch(idx);
    b.etch = etch;
  }
  for (const target of overview.onchain?.targets || []) {
    const b = touch(target.ring);
    b.depositAddress = target.address;
  }
  for (const b of blocks.values()) {
    b.multiplier = clampMultiplier(b.exponent);
  }
  // True surfacing frequency per ring, from the offer telemetry — this is the
  // "retrieval activity" lane the landscape draws (resonance is NOT a hit count).
  const recallHits = {};
  for (const e of await readOfferEvents()) {
    for (const c of e.data?.candidates || []) {
      if (c.chosen) recallHits[c.i] = (recallHits[c.i] || 0) + 1;
    }
  }
  return {
    etchRecallN: overview.onchain?.etchRecallN ?? 3,
    approval: overview.onchain?.approval ?? 'require',
    blocks: [...blocks.values()].sort((a, b) => a.index - b.index),
    resonance,
    recallHits,
  };
}

// ---- Relevance realization: history (telemetry offers) + live preview ---- //

// Every 'offer' event from the retrieval telemetry log, parsed leniently.
async function readOfferEvents() {
  const telPath = path.join(timechainRoot, 'chain', 'telemetry.jsonl');
  if (!fsSync.existsSync(telPath)) return [];
  const events = [];
  for (const line of (await fs.readFile(telPath, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.event === 'offer') events.push(e);
    } catch { /* torn line — skip */ }
  }
  return events;
}

async function retrievalHistory(url) {
  const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 12)));
  const offers = [];
  const perRing = new Map();
  let totalOffers = 0;
  for (const e of await readOfferEvents()) {
    totalOffers += 1;
    const d = e.data || {};
    for (const c of d.candidates || []) {
      const s = perRing.get(c.i) || { index: c.i, considered: 0, chosen: 0, bestRank: null, lastRank: null, lastTs: null, cphy: null, etched: null };
      s.considered += 1;
      if (c.chosen) s.chosen += 1;
      if (s.bestRank == null || c.rank < s.bestRank) s.bestRank = c.rank;
      s.lastRank = c.rank;
      s.lastTs = e.ts || s.lastTs;
      if (c.parts?.cphy != null) s.cphy = Math.max(Number(s.cphy || 0), Number(c.parts.cphy));
      if (c.parts?.etched != null) s.etched = Number(c.parts.etched);
      perRing.set(c.i, s);
    }
    // Keep the top 16 by log order PLUS every chosen candidate past the cut —
    // an ε-exploration pick can rank ~appetite+window deep, and dropping it
    // would hide a block that actually surfaced.
    const rawCandidates = d.candidates || [];
    const kept = rawCandidates.slice(0, 16);
    for (const c of rawCandidates.slice(16)) if (c.chosen) kept.push(c);
    offers.push({
      ts: e.ts || null,
      headIndex: e.head_index ?? null,
      scorer: d.scorer || e.scorer_version || null,
      queryKeywords: d.query_keywords || [],
      queryEntities: d.query_entities || [],
      dissonance: d.dissonance ?? null,
      appetite: d.appetite ?? null,
      threshold: d.threshold ?? null,
      considered: d.considered ?? null,
      returned: d.returned ?? null,
      candidates: kept.map((c) => ({
        index: c.i, rank: c.rank, score: c.score, chosen: Boolean(c.chosen),
        explore: Boolean(c.explore), parts: c.parts || {},
      })),
    });
  }
  return {
    totalOffers,
    offers: offers.slice(-limit).reverse(),
    rings: [...perRing.values()].sort((a, b) => b.chosen - a.chosen || b.considered - a.considered).slice(0, 40),
  };
}

// Live preview: run the skill's OWN retrieval twice (with and without the CPHY
// overlay) so the token bias is shown, never inferred. CT_TELEMETRY=off keeps
// preview queries out of the learner's credit-assignment log.
const PREVIEW_SCRIPT = `
import json, random, sys
root = sys.argv[1]
sys.path.insert(0, root)
from recall import Recall
query = sys.argv[2]
max_blocks = int(sys.argv[3])
budget = int(sys.argv[4])
out = {}
for key, no_overlay in (("with_overlay", False), ("without_overlay", True)):
    # Same seed for both runs: epsilon-exploration draws identical rolls, so a
    # random explore pick cannot appear in only one run and read as a CPHY effect.
    random.seed(0xC1A5)
    r = Recall(root).retrieve(query, budget_tokens=budget, max_blocks=max_blocks, no_overlay=no_overlay)
    # Deterministic tie-break (scores arrive rounded to 3 decimals): equal scores
    # resolve by chain index IDENTICALLY in both runs, so the with/without
    # comparison never reports a phantom rank delta on a tie.
    blocks = sorted(r.get("blocks", []), key=lambda b: (-(b.get("score") or 0), b.get("index") or 0))
    scorer = str(r.get("scorer") or "")
    out[key] = {
        "dissonance": r.get("dissonance"), "appetite": r.get("appetite"),
        "threshold": r.get("threshold"), "considered": r.get("considered"),
        "returned": r.get("returned"), "scorer": r.get("scorer"),
        # retrieve() always reports the HAND blend here even when the trained
        # scorer produced the ranking (learned weights go only to telemetry) ->
        # suppress weights for trained runs so the UI never mislabels the bars.
        "weights": (None if scorer.startswith("trained") else r.get("weights")),
        "blocks": [{
            "index": b.get("index"), "type": b.get("type"),
            "score": b.get("score"), "parts": b.get("score_parts") or {},
            "explore": bool(b.get("explore")),
            "salience": (b.get("labels") or {}).get("salience"),
            "excerpt": (b.get("excerpt") or "")[:280],
        } for b in blocks],
    }
print(json.dumps(out))
`;

async function retrievalPreview(body) {
  const query = String(body.query || '').trim();
  if (!query) throw httpError('A query is required for a retrieval preview.');
  if (query.length > 2000) throw httpError('Preview query too long (2000 chars max).');
  const maxBlocks = Math.max(1, Math.min(16, Number(body.maxBlocks) || 8));
  const budget = Math.max(200, Math.min(8000, Number(body.budget) || 1600));
  // A preview is read-only (CT_TELEMETRY=off, no chain write) so it runs on the
  // bounded READ pool, not the write queue — it must never stall the owner's
  // mutations, and the pool caps concurrent python forks.
  const run = await enqueueRead(() => execFileAsync('python3', ['-c', PREVIEW_SCRIPT, timechainRoot, query, String(maxBlocks), String(budget)], {
    cwd: timechainRoot,
    timeout: PY_READ_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CT_TELEMETRY: 'off' },
  }).then(
    ({ stdout }) => ({ ok: true, stdout }),
    (error) => ({ ok: false, message: error.message, stderr: error.stderr || '' }),
  ));
  if (!run.ok) throw httpError(`Retrieval preview failed: ${(run.stderr || run.message || '').slice(0, 400)}`, 502);
  const parsed = parseMaybeJson(run.stdout);
  if (!parsed) throw httpError('Retrieval preview returned no JSON.', 502);
  const withB = parsed.with_overlay?.blocks || [];
  const withoutRank = new Map((parsed.without_overlay?.blocks || []).map((b, i) => [b.index, i]));
  for (let i = 0; i < withB.length; i += 1) {
    const organic = withoutRank.get(withB[i].index);
    withB[i].rank = i;
    withB[i].organicRank = organic ?? null;
    withB[i].rankDelta = organic == null ? null : organic - i;
  }
  return { query, maxBlocks, budget, ...parsed };
}

// ---- Scars, lineage, forks ---- //

async function immuneOverview() {
  const immunePath = path.join(timechainRoot, 'chain', 'immune.json');
  const state = await readJsonSafe(immunePath, { locked: false, safe_height: null, quarantine: [], scars: [] });
  const lockedFlag = fsSync.existsSync(path.join(timechainRoot, 'chain', 'LOCKED'));
  const paused = await readJsonSafe(path.join(timechainRoot, 'chain', 'PAUSED'), null);
  return {
    locked: Boolean(state.locked) || lockedFlag,
    safeHeight: state.safe_height ?? null,
    quarantine: state.quarantine || [],
    scars: (state.scars || []).map((scar) => ({ id: scar.id, blocks: scar.blocks || [], lesson: scar.lesson || '' })),
    paused: paused ? { since: paused.since, reason: paused.reason, height: paused.paused_at_height } : null,
    doctrine: 'Scars are inert records since v3.26 — quarantined rings stay on disk, excluded from the active self, never deleted.',
  };
}

function contiguousRanges(indices) {
  const sorted = [...new Set(indices.map(Number))].sort((a, b) => a - b);
  const ranges = [];
  for (const idx of sorted) {
    const last = ranges.at(-1);
    if (last && idx === last.to + 1) last.to = idx;
    else ranges.push({ from: idx, to: idx });
  }
  return ranges;
}

async function forkTree() {
  const rings = await loadRings();
  const immune = await immuneOverview();
  const head = rings.at(-1) || null;
  const recoveries = rings.filter((r) => r.ring_type === 'recovery').map((r) => ({
    index: r.index,
    ts: r.timestamp,
    resumedFromHeight: r.payload?.resumed_from_height ?? null,
    quarantined: r.payload?.quarantined || [],
    scar: r.payload?.scar || null,
    summary: truncate(String(r.payload?.summary || ''), 240),
  }));
  const grafts = rings.filter((r) => r.ring_type === 'imported').map((r) => ({
    index: r.index,
    ts: r.timestamp,
    originAuthor: r.payload?.origin_author || null,
    originIndex: r.payload?.origin_index ?? null,
    originHash: r.payload?.origin_hash || null,
    originPack: r.payload?.origin_pack || null,
    trust: r.payload?.trust || null,
    summary: truncate(String(r.payload?.summary || ''), 240),
  }));
  const synthesisForks = rings
    .filter((r) => r.ring_type === 'synthesis' && Array.isArray(r.payload?.considered_forks))
    .slice(-12)
    .map((r) => ({
      index: r.index,
      ts: r.timestamp,
      summary: truncate(String(r.payload?.summary || ''), 200),
      chosen: r.payload?.chosen_perspective || null,
      forks: (r.payload.considered_forks || []).slice(0, 10).map((f) => ({
        perspective: f.perspective, kind: f.kind, visits: f.visits, value: f.value,
      })),
    }));
  const ledger = await readLedgerEvents();
  const exchanges = ledger
    .filter((ev) => ev.kind === 'export' || ev.kind === 'import')
    .map((ev) => ({ kind: ev.kind, ts: ev.ts, pack: ev.pack || null, author: ev.author || null, rings: ev.rings ?? ev.sealed ?? null, price: ev.price ?? null }));
  const epochs = rings.filter((r) => r.ring_type === 'epoch');
  return {
    head: head ? { index: head.index, hash: head.ring_hash, ts: head.timestamp } : null,
    rings: rings.length,
    quarantineBranches: contiguousRanges(immune.quarantine).map((range) => {
      const recovery = recoveries.find((rec) => (rec.quarantined || []).includes(range.from));
      return { ...range, scarId: recovery?.scar?.id || null, recoveryRing: recovery?.index ?? null, resumedFromHeight: recovery?.resumedFromHeight ?? null };
    }),
    recoveries,
    grafts,
    synthesisForks,
    exchanges,
    epochCount: epochs.length,
    latestEpoch: epochs.at(-1)?.index ?? null,
    checkpoints: (await readJsonlSafe(path.join(timechainRoot, 'chain', 'checkpoints.jsonl'))).map((c) => c.index),
  };
}

async function readJsonlSafe(file) {
  if (!fsSync.existsSync(file)) return [];
  const text = await fs.readFile(file, 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

// ---- The Emergent Nursery: Dream-Cache faculties -> the active self ---- //
// The Dream Cache (registry/emergent.json) holds faculties the mind proposed
// for itself. The nursery lets the owner COPY one out as JSON, PASTE one in
// (it lands as an INERT proposal via cambium.py propose-op), and ACTIVATE one
// into the active registry (cambium.py activate — the explicit human-consent
// step). Op code is stored inert and never executed by any of this: the CLI
// returns it for the owner to place in active_ops.py by hand.

async function emergentOverview() {
  const emergent = await readJsonSafe(path.join(timechainRoot, 'registry', 'emergent.json'), { faculties: [] });
  const grown = await readJsonSafe(path.join(timechainRoot, 'registry', 'grown.json'), {});
  const baseModalities = await readJsonSafe(path.join(timechainRoot, 'registry', 'modalities.json'), {});
  const baseSenses = await readJsonSafe(path.join(timechainRoot, 'registry', 'senses.json'), {});
  const faculties = (emergent.faculties || []).map((f) => ({
    eid: f.eid ?? null,
    kind: f.kind === 'modality' ? 'modality' : 'sense',
    name: String(f.name || ''),
    function: truncate(String(f.function || ''), 400),
    category: f.category || 'knowledge',
    origin: f.origin || null,
    seedTerms: (f.seed_terms || []).slice(0, 16),
    status: f.status || 'emergent',
    recurrence: f.recurrence ?? 1,
    bornAt: f.born_at || null,
    promotedToId: f.promoted_to_id ?? null,
    // Full op code up to the paste cap (20k) so a copied faculty round-trips
    // intact; the UI truncates for DISPLAY only.
    opCode: f.op_code ? truncate(String(f.op_code), 20000) : null,
    opCodeChars: f.op_code ? String(f.op_code).length : 0,
  }));
  // Lifecycle in the wild: 'emergent' (sprouted), 'proposed'/'proposal'
  // (model-authored, awaiting the human), 'promoted' (recurrence path) and
  // 'activated' (human path) — the last two are already in the active self.
  const inSelf = (f) => f.promotedToId != null || f.status === 'activated' || f.status === 'promoted';
  return {
    doctrine: 'The Dream Cache proposes; the owner disposes. Nothing model-authored runs on activation — op code stays inert until you place it in active_ops.py yourself.',
    faculties,
    counts: {
      emergent: faculties.filter((f) => !inSelf(f) && f.status === 'emergent').length,
      proposed: faculties.filter((f) => !inSelf(f) && (f.status === 'proposed' || f.status === 'proposal')).length,
      inSelf: faculties.filter(inSelf).length,
      activeModalities: (baseModalities.modalities || []).length + (grown.modalities || []).length,
      activeSenses: (baseSenses.senses || []).length + (grown.senses || []).length,
    },
  };
}

// ---- The Organ Panel: every organ of the skill, one audited view ---- //
// One pass over the chain + registries + telemetry computes all sections;
// the whole panel is memoized on ledger/telemetry state so a hammered GET
// costs one compute. Every section fails soft: a missing organ renders as
// its honest zero-state, never as a dashboard error.

async function readTelemetryLines() {
  const telPath = path.join(timechainRoot, 'chain', 'telemetry.jsonl');
  if (!fsSync.existsSync(telPath)) return [];
  const events = [];
  for (const line of (await fs.readFile(telPath, 'utf8')).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return events;
}

async function organsOverview() {
  const parts = [];
  for (const rel of [['chain', 'rings.jsonl'], ['chain', 'telemetry.jsonl'], ['registry', 'grown.json']]) {
    try {
      const st = await fs.stat(path.join(timechainRoot, ...rel));
      parts.push(`${st.size}:${st.mtimeMs}`);
    } catch { parts.push('none'); }
  }
  return memoizedRead(`organs:${parts.join('|')}`, () => computeOrgans(), 30_000);
}

async function computeOrgans() {
  const rings = await loadRings();
  const telemetry = await readTelemetryLines();
  const out = {};
  const section = async (name, fn) => {
    try { out[name] = await fn(); } catch (error) { out[name] = { error: String(error.message || error).slice(0, 240) }; }
  };
  await section('vitals', () => vitalsSection(rings));
  await section('census', () => censusSection(rings));
  await section('chronosynaptic', () => chronoSection(rings));
  await section('cambium', () => cambiumSection(rings));
  await section('conscience', () => conscienceSection(rings, telemetry));
  await section('reflective', () => reflectiveSection(rings, telemetry));
  await section('continuum', () => continuumSection());
  return out;
}

async function vitalsSection(rings) {
  const head = rings.at(-1) || null;
  let doctor = null;
  const run = await runSkillCli('doctor.py', ['--json'], { timeout: PY_READ_TIMEOUT_MS }).catch(() => null);
  if (run) {
    // doctor exits non-zero when any check degrades — the JSON is still the verdict.
    const parsed = parseMaybeJson(run.stdout);
    if (parsed?.results) {
      doctor = { worst: parsed.worst ?? null, checks: parsed.results.map((r) => ({ check: r.check, status: r.status, detail: truncate(String(r.detail || ''), 160) })) };
    }
  }
  const paused = await readJsonSafe(path.join(timechainRoot, 'chain', 'PAUSED'), null);
  const enforce = await readJsonSafe(path.join(timechainRoot, 'chain', '.enforce.json'), {});
  const hippo = await readJsonSafe(path.join(timechainRoot, 'chain', 'hippocampus', 'meta.json'), null);
  const digest = await readJsonSafe(path.join(timechainRoot, 'chain', 'telemetry.digest.json'), null);
  let telemetrySize = 0;
  try { telemetrySize = (await fs.stat(path.join(timechainRoot, 'chain', 'telemetry.jsonl'))).size; } catch { /* absent */ }
  const checkpoints = await readJsonlSafe(path.join(timechainRoot, 'chain', 'checkpoints.jsonl'));
  const consensusCfg = await readJsonSafe(path.join(timechainRoot, 'chain', 'consensus', 'config.json'), null);
  const vault = await readJsonSafe(path.join(timechainRoot, 'registry', 'cphy', 'vault.json'), null);
  const attests = rings.filter((r) => r.ring_type === 'cphy-digest');
  return {
    doctor,
    dormancy: paused ? { paused: true, since: paused.since, reason: paused.reason } : { paused: false },
    enforcement: { turnHead: enforce.turn_head ?? null, nudges: enforce.nudges ?? 0, head: head?.index ?? null },
    hippocampus: hippo ? { indexed: hippo.indexed_count ?? null, headIndex: hippo.head_index ?? null, fresh: hippo.head_index === (head?.index ?? -1) } : null,
    telemetryBacklog: digest ? { digestedTo: digest.digested_to ?? 0, size: telemetrySize, undigested: Math.max(0, telemetrySize - (digest.digested_to || 0)), lastDigestRing: digest.ring_index ?? null } : { digestedTo: 0, size: telemetrySize, undigested: telemetrySize, lastDigestRing: null },
    checkpoints: { count: checkpoints.length, latest: checkpoints.at(-1)?.index ?? null, unanchored: head && checkpoints.length ? head.index - checkpoints.at(-1).index : (head?.index ?? 0) },
    // Never expose witness keys — presence and shape only.
    consensus: consensusCfg ? { configured: true, n: consensusCfg.n ?? null, quorum: consensusCfg.quorum ?? null } : { configured: false },
    vault: vault?.secrets ? { present: true, secrets: Object.keys(vault.secrets).length } : { present: false },
    ledgerAttests: { count: attests.length, latest: attests.at(-1)?.index ?? null },
  };
}

async function censusSection(rings) {
  const byType = {};
  let largest = { bytes: 0, index: null, type: null };
  let longestGap = { seconds: 0, from: null, to: null };
  let prevTs = null;
  const days = new Set();
  for (const r of rings) {
    byType[r.ring_type] = (byType[r.ring_type] || 0) + 1;
    const bytes = JSON.stringify(r.payload || {}).length;
    if (bytes > largest.bytes) largest = { bytes, index: r.index, type: r.ring_type };
    const ts = Date.parse(r.timestamp || '');
    if (Number.isFinite(ts)) {
      days.add(String(r.timestamp).slice(0, 10));
      if (prevTs != null) {
        const gap = (ts - prevTs) / 1000;
        if (gap > longestGap.seconds) longestGap = { seconds: Math.round(gap), from: r.index - 1, to: r.index };
      }
      prevTs = ts;
    }
  }
  const genesis = rings[0] || null;
  const head = rings.at(-1) || null;
  const spanDays = genesis && head ? Math.max(1, (Date.parse(head.timestamp) - Date.parse(genesis.timestamp)) / 86_400_000) : 1;
  const blobIndex = await readJsonSafe(path.join(timechainRoot, 'chain', 'blockspace', 'index.json'), {});
  const blobs = Object.values(blobIndex);
  let ringsBytes = 0;
  try { ringsBytes = (await fs.stat(path.join(timechainRoot, 'chain', 'rings.jsonl'))).size; } catch { /* absent */ }
  const growthTypes = ['faculty', 'promotion', 'faculty-wake', 'faculty-activated', 'faculty-op-proposed'];
  return {
    total: rings.length,
    head: head ? { index: head.index, ts: head.timestamp } : null,
    genesis: genesis ? { ts: genesis.timestamp, name: genesis.payload?.name || null, covenant: genesis.payload?.covenant || null } : null,
    byType: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1])),
    ringsPerDay: Number((rings.length / spanDays).toFixed(1)),
    activeDays: days.size,
    blockspace: { blobs: blobs.length, bytes: blobs.reduce((s, b) => s + (Number(b.size) || 0), 0) },
    chainBytes: ringsBytes,
    largestRing: largest,
    longestGap,
    growthShare: rings.length ? Number((growthTypes.reduce((s, t) => s + (byType[t] || 0), 0) / rings.length).toFixed(3)) : 0,
  };
}

async function chronoSection(rings) {
  const collapses = rings.filter((r) => r.ring_type === 'synthesis'
    && ['chronosynaptic_collapse', 'chronosynaptic_explicit_collapse'].includes(r.payload?.event));
  const winner = (p) => p.chosen_path?.[0] ?? p.chosen_perspective ?? null;
  const leaderboard = {};
  const breadths = {};
  let flushes = 0;
  for (const r of collapses) {
    const w = winner(r.payload);
    if (w) leaderboard[w] = (leaderboard[w] || 0) + 1;
    const breadth = r.payload.collapsed_from ?? (r.payload.considered_forks || []).length;
    breadths[breadth] = (breadths[breadth] || 0) + 1;
    if (Array.isArray(r.payload.dream_cache_flush) && r.payload.dream_cache_flush.length) flushes += 1;
  }
  const emergent = await readJsonSafe(path.join(timechainRoot, 'registry', 'emergent.json'), { faculties: [] });
  const discards = (emergent.faculties || []).filter((f) => String(f.origin || '').includes('chronosynaptic-discard'));
  const latest = collapses.at(-1) || null;
  const forks = (latest?.payload.considered_forks || []).map((f) => ({ perspective: f.perspective, kind: f.kind, visits: f.visits ?? null, value: f.value ?? null }));
  const values = forks.map((f) => Number(f.value)).filter(Number.isFinite);
  return {
    collapses: collapses.length,
    auto: collapses.filter((r) => r.payload.event === 'chronosynaptic_collapse').length,
    explicit: collapses.filter((r) => r.payload.event === 'chronosynaptic_explicit_collapse').length,
    dreamCacheFlushes: flushes,
    discardFaculties: discards.length,
    leaderboard: Object.entries(leaderboard).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, wins]) => ({ name, wins })),
    latest: latest ? {
      index: latest.index,
      ts: latest.timestamp,
      query: truncate(String(latest.payload.query || ''), 200),
      chosen: winner(latest.payload),
      synthesis: truncate(String(latest.payload.synthesis || latest.payload.summary || ''), 280),
      forks,
      spread: values.length > 1 ? Number((Math.max(...values) - Math.min(...values)).toFixed(1)) : null,
      uqc: latest.payload.uqc || null,
      epitaphs: (latest.payload.loser_epitaphs || []).slice(0, 3).map((e) => truncate(String(e.epitaph || e.perspective || ''), 140)),
    } : null,
  };
}

async function cambiumSection(rings) {
  const grown = await readJsonSafe(path.join(timechainRoot, 'registry', 'grown.json'), {});
  const baseM = await readJsonSafe(path.join(timechainRoot, 'registry', 'modalities.json'), {});
  const baseS = await readJsonSafe(path.join(timechainRoot, 'registry', 'senses.json'), {});
  const census = (list) => ({
    total: list.length,
    active: list.filter((f) => f.status !== 'dormant').length,
    dormant: list.filter((f) => f.status === 'dormant').length,
  });
  const effects = { op: 0, frame: 0, hint: 0, none: 0 };
  const wakeHitsPending = [];
  let imported = 0;
  for (const f of [...(grown.modalities || []), ...(grown.senses || [])]) {
    effects[f.effect?.type || 'none'] = (effects[f.effect?.type || 'none'] || 0) + 1;
    if (f.wake_hits) wakeHitsPending.push(f.name);
    if (f.provenance) imported += 1;
  }
  // Most-lived faculties: every appearance in a sealed ring's labels is one fire.
  const fires = new Map();
  for (const r of rings) {
    const labels = r.payload?.labels;
    if (!labels) continue;
    for (const [kind, key] of [['sense', 'senses'], ['modality', 'modalities']]) {
      for (const item of labels[key] || []) {
        const name = typeof item === 'string' ? item : item?.name;
        if (!name) continue;
        const k = `${kind}:${name}`;
        fires.set(k, (fires.get(k) || 0) + 1);
      }
    }
  }
  const mostLived = [...fires.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([k, count]) => ({ kind: k.split(':')[0], name: k.slice(k.indexOf(':') + 1), fires: count }));
  const wakes = rings.filter((r) => r.ring_type === 'faculty-wake');
  const prunes = rings.filter((r) => r.ring_type === 'prune');
  return {
    base: { modalities: (baseM.modalities || []).length, senses: (baseS.senses || []).length },
    grownModalities: census(grown.modalities || []),
    grownSenses: census(grown.senses || []),
    effects,
    imported,
    wakeRings: { count: wakes.length, latest: wakes.at(-1)?.index ?? null },
    pruneRings: { count: prunes.length, latestSummary: truncate(String(prunes.at(-1)?.payload?.summary || ''), 160) },
    wakeHitsPending: wakeHitsPending.slice(0, 8),
    mostLived,
  };
}

async function conscienceSection(rings, telemetry) {
  const verdicts = { SEAL: 0, REVISE: 0, FORCE_UNCERTAINTY: 0, REJECT: 0 };
  let lastNonSeal = null;
  for (const e of telemetry) {
    if (e.event !== 'gate_verdict') continue;
    const d = e.data?.decision;
    if (d in verdicts) verdicts[d] += 1;
    if (d && d !== 'SEAL') lastNonSeal = { decision: d, ts: e.ts, reasons: (e.data.reasons || []).slice(0, 2).map((s) => truncate(String(s), 160)) };
  }
  const frames = {};
  for (const r of rings) {
    if (r.payload?.frame) frames[r.payload.frame] = (frames[r.payload.frame] || 0) + 1;
  }
  const latestVerdictRing = [...rings].reverse().find((r) => r.payload?.poq_verdict?.span_grounding);
  const policy = await readJsonSafe(path.join(timechainRoot, 'registry', 'policy.json'), null);
  const scorer = await readJsonSafe(path.join(timechainRoot, 'registry', 'scorer.json'), null);
  const calibrators = await readJsonSafe(path.join(timechainRoot, 'registry', 'calibrators.json'), null);
  return {
    verdicts,
    lastNonSeal,
    frames,
    conjectures: (() => {
      // A conjecture is open until SOME score ring cites it — score rings can
      // repeat for one conjecture, so dedupe by the cited ring, never subtract.
      const scoredRings = new Set(rings.filter((r) => r.ring_type === 'conjecture-score')
        .map((r) => r.payload?.conjecture_ring).filter((i) => i != null));
      return {
        open: rings.filter((r) => r.ring_type === 'conjecture' && !scoredRings.has(r.index)).length,
        scored: scoredRings.size,
      };
    })(),
    spanGrounding: latestVerdictRing ? { ring: latestVerdictRing.index, ...latestVerdictRing.payload.poq_verdict.span_grounding } : null,
    scorer: scorer?.status === 'active' ? `trained ${scorer.version || ''}`.trim() : 'hand-2.1 (no trained operator active)',
    entityGate: Boolean(policy?.floors?.entity_grounding_enforce),
    appetiteCalibrated: Boolean(policy?.appetite?.calibrated),
    calibratorsAdjusted: calibrators ? Object.keys(calibrators).length : 0,
  };
}

async function reflectiveSection(rings, telemetry) {
  const autos = rings.filter((r) => r.ring_type === 'autobiography');
  const dreams = rings.filter((r) => r.ring_type === 'dream');
  const head = rings.at(-1)?.index ?? 0;
  const latestAuto = autos.at(-1) || null;
  const latestDream = dreams.at(-1) || null;
  const dreamState = await readJsonSafe(path.join(timechainRoot, 'chain', 'dream.json'), null);
  const salience = await readJsonSafe(path.join(timechainRoot, 'chain', 'salience.json'), {});
  const salEntries = Object.entries(salience).map(([k, v]) => ({ ring: Number(k), score: Number(v) })).filter((e) => Number.isFinite(e.score));
  let hippoTerms = null;
  try {
    const postings = JSON.parse(await fs.readFile(path.join(timechainRoot, 'chain', 'hippocampus', 'postings.json'), 'utf8'));
    hippoTerms = Object.keys(postings).length;
  } catch { /* absent */ }
  return {
    autobiography: latestAuto ? {
      index: latestAuto.index, ts: latestAuto.timestamp,
      authored: Boolean(latestAuto.payload?.authored),
      portrait: truncate(String(latestAuto.payload?.summary || ''), 480),
      ringsSince: head - latestAuto.index,
      count: autos.length,
    } : null,
    dreams: {
      count: dreams.length,
      latest: latestDream ? { index: latestDream.index, ts: latestDream.timestamp, summary: truncate(String(latestDream.payload?.summary || ''), 240) } : null,
      minedTo: dreamState?.mined_to ?? null,
      missedPositives: telemetry.filter((e) => e.event === 'missed-positive').length,
    },
    hippocampus: { terms: hippoTerms },
    salience: {
      scored: salEntries.length,
      top: salEntries.sort((a, b) => b.score - a.score).slice(0, 5),
      decayed: salEntries.filter((e) => e.score < 0).length,
    },
  };
}

// Long-horizon ingestion lives in PER-TASK chain roots (dirs beside chain/
// that carry their own chain/rings.jsonl) — the worn identity chain itself
// seals no continuum blocks.
async function discoverContinuumRoots() {
  const roots = [];
  const candidates = [];
  for (const entry of await fs.readdir(timechainRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && entry.name !== 'chain' && !entry.name.startsWith('.')) candidates.push(entry.name);
  }
  for (const name of ['tasks']) {
    for (const entry of await fs.readdir(path.join(timechainRoot, name), { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory()) candidates.push(path.join(name, entry.name));
    }
  }
  for (const rel of candidates) {
    const ringsPath = path.join(timechainRoot, rel, 'chain', 'rings.jsonl');
    try { ensureInsideRoot(ringsPath); } catch { continue; }
    if (fsSync.existsSync(ringsPath)) roots.push(rel);
  }
  return roots;
}

async function continuumSection() {
  const roots = await discoverContinuumRoots();
  const tasks = [];
  const totals = { blocks: 0, tokens: 0, redactions: 0, roots: roots.length };
  for (const rel of roots.slice(0, 12)) {
    const lines = await readJsonlSafe(path.join(timechainRoot, rel, 'chain', 'rings.jsonl'));
    let current = null;
    const segments = [];
    for (const r of lines) {
      if (r.payload?.event === 'task_open') {
        current = { root: rel, objective: truncate(String(r.payload.objective || ''), 160), openedAt: r.timestamp, blocks: 0, tokens: 0, items: 0, chunks: 0, redactions: 0, minTokens: null, maxTokens: null, audit: null, nextAction: null };
        segments.push(current);
      }
      if (!current) continue;
      if (r.payload?.event === 'continuum') {
        current.blocks += 1;
        const t = Number(r.payload.data?.approx_tokens) || 0;
        current.minTokens = current.minTokens == null ? t : Math.min(current.minTokens, t);
        current.maxTokens = current.maxTokens == null ? t : Math.max(current.maxTokens, t);
        if (r.payload.data?.chunk_index === 1) current.redactions += Number(r.payload.data?.redaction_count) || 0;
      }
      const m = r.payload?.state?.metrics;
      if (m) {
        current.tokens = Number(m.approx_tokens_ingested) || current.tokens;
        current.items = Number(m.items_done) || current.items;
        current.chunks = Number(m.chunks_sealed) || current.chunks;
      }
      if (r.payload?.state?.audit) current.audit = { reviewed: r.payload.state.audit.review_cursor ?? null, total: r.payload.state.audit.total_blocks ?? null, findings: r.payload.state.audit.findings_total ?? null, complete: Boolean(r.payload.state.audit.complete) };
      if (r.payload?.state?.next_action) current.nextAction = truncate(String(r.payload.state.next_action), 100);
    }
    let coherent = null;
    const validate = await runSkillCli('continuum.py', ['validate', '--root', path.join(timechainRoot, rel)], { timeout: PY_READ_TIMEOUT_MS }).catch(() => null);
    if (validate) coherent = /CONTINUUM:\s*COHERENT/.test(validate.stdout || '') ? true : /INCOHERENT/.test(`${validate.stdout}${validate.stderr}`) ? false : null;
    for (const seg of segments) {
      totals.blocks += seg.blocks;
      totals.tokens += seg.tokens;
      totals.redactions += seg.redactions;
      tasks.push({ ...seg, coherent });
    }
  }
  tasks.sort((a, b) => b.tokens - a.tokens);
  return {
    roots,
    tasks: tasks.slice(0, 16),
    totals,
    largest: tasks[0] || null,
  };
}

// ---- Mutations: the owner's hands on their own blockspace ---- //
// Every mutation requires either the paired bridge token (remote page) or a
// trusted local direct request — and is serialized through one queue because
// the skill's writers assume a single writer per chain root.

function requireMutationAuth(req) {
  if (bridgeRecord(req)) return;
  if (isTrustedLocalDirectRequest(req) && !isRemoteOrigin(req)) return;
  throw httpError('Mutations require a paired bridge (enter the pairing code first).', 401);
}

async function mutateViaCli(scriptName, args, { timeout = PY_MUTATE_TIMEOUT_MS } = {}) {
  const run = await enqueueMutation(() => runSkillCli(scriptName, args, { timeout }));
  const parsed = parseMaybeJson(run.stdout);
  if (!run.ok) {
    const detail = (run.stderr || run.stdout || run.message || '').trim().slice(0, 600);
    throw httpError(detail || `${scriptName} ${args[0]} failed.`, 422);
  }
  return { ok: true, result: parsed ?? run.stdout.trim(), stderr: run.stderr?.trim() || '' };
}

function requireRingIndex(value, name = 'ring') {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw httpError(`${name} must be a non-negative ring index.`);
  return n;
}

function cleanMemo(value, cap = 400) {
  return String(value || '').replace(/[\r\n]+/g, ' ').slice(0, cap);
}

async function handleCphyMutation(req, url) {
  requireMutationAuth(req);
  const pendingMatch = url.pathname.match(/^\/api\/cphy\/pending\/([0-9a-f]{6,64})\/(approve|reject)$/);
  if (pendingMatch) {
    return mutateViaCli('cphy.py', [pendingMatch[2], pendingMatch[1]]);
  }
  if (url.pathname === '/api/cphy/lock') {
    const body = await jsonBody(req);
    const op = body.op === 'shadow' ? 'shadow' : 'basin';
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw httpError('amount must be a positive number of CPHY.');
    const args = ['lock', op, '--amount', String(amount), '--memo', cleanMemo(body.memo)];
    if (body.match) {
      args.push('--match', String(body.match).slice(0, 200));
    } else {
      args.push('--from', String(requireRingIndex(body.from, 'from')), '--to', String(requireRingIndex(body.to, 'to')));
    }
    return mutateViaCli('cphy.py', args);
  }
  if (url.pathname === '/api/cphy/release') {
    const body = await jsonBody(req);
    const lockId = String(body.lockId || '').trim();
    if (!/^[0-9a-f]{6,32}$/.test(lockId)) throw httpError('lockId must be a lock id from the active locks table.');
    return mutateViaCli('cphy.py', ['release', lockId]);
  }
  if (url.pathname === '/api/cphy/etch-recall-n') {
    const body = await jsonBody(req);
    const n = Number(body.n);
    if (!Number.isInteger(n) || n < 0 || n > 64) throw httpError('n must be an integer 0-64.');
    return mutateViaCli('cphy.py', ['etch', 'n', '--set', String(n)]);
  }
  if (url.pathname === '/api/cphy/target') {
    const body = await jsonBody(req);
    const from = requireRingIndex(body.from, 'from');
    const to = requireRingIndex(body.to ?? body.from, 'to');
    if (to < from || to - from > 32) throw httpError('Register at most 33 rings per call (from <= to).');
    return mutateViaCli('cphy.py', ['onchain', 'target', '--from', String(from), '--to', String(to)]);
  }
  if (url.pathname === '/api/cphy/sync') {
    // The ONLY way tokens register: cphy.py reads the pinned canonical
    // contract's balances at the keyless deposit addresses over allowlisted
    // RPCs (read-only — never sends, never signs), appends an
    // onchain-observe event when a balance changed, and STAGES etches for
    // the owner's consent. Genuinely longer than the mutate default: the
    // oracle makes sequential RPC round-trips (15s worst case per address).
    return mutateViaCli('cphy.py', ['onchain', 'sync'], { timeout: 8 * 60_000 });
  }
  return null;
}

async function handlePackMutation(req, url) {
  requireMutationAuth(req);
  if (url.pathname === '/api/pack/export') {
    const body = await jsonBody(req);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const packsDir = ensureInsideRoot(path.join(timechainRoot, 'chain', 'packs'));
    await fs.mkdir(packsDir, { recursive: true });
    const outPath = path.join(packsDir, `pack-${stamp}.json`);
    const args = ['export-pack', '--out', outPath, '--memo', cleanMemo(body.memo)];
    if (body.match) {
      args.push('--match', String(body.match).slice(0, 200));
    } else {
      args.push('--from', String(requireRingIndex(body.from, 'from')), '--to', String(requireRingIndex(body.to, 'to')));
    }
    if (body.price != null && Number(body.price) > 0) args.push('--price', String(Number(body.price)));
    if (body.expires) args.push('--expires', String(body.expires).slice(0, 40));
    if (body.grantTo) args.push('--grant-to', cleanMemo(body.grantTo, 80));
    const outcome = await mutateViaCli('cphy.py', args);
    let pack = null;
    try {
      const raw = await fs.readFile(outPath, 'utf8');
      if (raw.length <= 4 * 1024 * 1024) pack = JSON.parse(raw);
    } catch {
      pack = null;
    }
    return { ...outcome, packPath: outPath, pack };
  }
  if (url.pathname === '/api/pack/import') {
    const body = await jsonBody(req, MAX_PACK_BODY_BYTES);
    const pack = body.pack;
    if (!pack || typeof pack !== 'object' || !Array.isArray(pack.rings)) {
      throw httpError('Body must carry {pack} — a Cypher Tempre pack object with rings[].');
    }
    const packsDir = ensureInsideRoot(path.join(timechainRoot, 'chain', 'packs'));
    await fs.mkdir(packsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const inPath = path.join(packsDir, `import-${stamp}.json`);
    await fs.writeFile(inPath, JSON.stringify(pack));
    return mutateViaCli('cphy.py', ['import-pack', inPath]);
  }
  return null;
}

async function handleChainMutation(req, url) {
  requireMutationAuth(req);
  if (url.pathname === '/api/ring/seal') {
    const body = await jsonBody(req);
    const summary = String(body.summary || '').trim();
    if (summary.length < 8) throw httpError('A sealed annotation needs a real summary (8+ chars).');
    if (summary.length > 4000) throw httpError('Summary too long (4000 chars max).');
    const type = /^[a-z][a-z-]{1,30}$/.test(String(body.type || '')) ? String(body.type) : 'annotation';
    return mutateViaCli('recall_cli.py', ['seal', summary, '--type', type]);
  }
  if (url.pathname === '/api/immune/forget-scar') {
    const body = await jsonBody(req);
    const id = String(body.id || '').trim();
    if (!/^scar\d{1,6}$/.test(id)) throw httpError('id must look like scarN.');
    return mutateViaCli('immune.py', ['forget-scar', '--id', id]);
  }
  if (url.pathname === '/api/immune/rollback') {
    const body = await jsonBody(req);
    const height = requireRingIndex(body.height, 'height');
    if (String(body.confirm || '') !== `QUARANTINE ${height}`) {
      throw httpError(`Confirmation phrase required: "QUARANTINE ${height}". Ring ${height} is treated as the FIRST BAD ring — it and everything after it are quarantined (kept on disk as a scar, excluded from the active self).`, 428);
    }
    const lesson = cleanMemo(body.lesson || 'dashboard-initiated rollback', 400);
    return mutateViaCli('immune.py', ['rollback', '--height', String(height), '--lesson', lesson]);
  }
  return null;
}

// Names/selectors become argparse POSITIONALS or option values — a leading
// dash would be read as a flag, so the first char must be alphanumeric.
const FACULTY_NAME_RX = /^[A-Za-z0-9][A-Za-z0-9 .'’-]{2,79}$/;
const SEED_TERM_RX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,24}$/;

// cambium's propose-op/activate mutate files INSIDE the epoch hash perimeter
// (emergent.json, grown.json) but — unlike wake/prune — do not reseal it.
// Reseal here so the owner's own dashboard edit never reads as TAMPERED.
// Fail-soft: the mutation already succeeded; a reseal failure is reported.
async function resealRegistryEpoch(reason) {
  try {
    const run = await enqueueMutation(() => runSkillCli('epochs.py', ['seal', '--reason', reason.slice(0, 120)]));
    return { resealed: run.ok, note: (run.stdout || run.stderr || '').trim().split(/\r?\n/).pop() || '' };
  } catch (error) {
    return { resealed: false, note: error.message };
  }
}

async function handleRegistryMutation(req, url) {
  requireMutationAuth(req);
  if (url.pathname === '/api/registry/activate') {
    const body = await jsonBody(req);
    const selector = String(body.selector || '').trim();
    if (!FACULTY_NAME_RX.test(selector) && !/^E\d{1,6}$/.test(selector)) {
      throw httpError('selector must be an emergent eid (like E12) or the faculty name.');
    }
    const outcome = await mutateViaCli('cambium.py', ['activate', selector]);
    const cliText = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result || '');
    // cmd_activate declines with exit 0 ("-> no emergent proposal matched …");
    // the registry, not the exit code, is the proof of activation.
    if (/->\s*no emergent/i.test(cliText)) {
      throw httpError(`The skill declined the activation: ${truncate(cliText.replace(/\s+/g, ' ').trim(), 300)}`, 422);
    }
    const after = await emergentOverview();
    const selLc = selector.toLowerCase();
    const faculty = after.faculties.find((f) => String(f.eid || '').toLowerCase() === selLc
      || f.name.toLowerCase() === selLc) || null;
    if (!faculty || (faculty.status !== 'activated' && faculty.promotedToId == null)) {
      throw httpError(`Activation did not take — ${selector} is not marked active in the registry. CLI said: ${truncate(cliText, 200)}`, 502);
    }
    outcome.faculty = faculty;
    outcome.epoch = await resealRegistryEpoch(`dashboard: activated ${selector}`);
    return outcome;
  }
  if (url.pathname === '/api/registry/propose') {
    // A pasted faculty may carry up to 20k of inert op code — the default
    // 20k body cap would 413 before the friendlier 400 below could speak.
    const body = await jsonBody(req, 64 * 1024);
    const kind = body.kind === 'modality' ? 'modality' : body.kind === 'sense' ? 'sense' : null;
    if (!kind) throw httpError("kind must be 'sense' or 'modality'.");
    const name = String(body.name || '').trim();
    if (!FACULTY_NAME_RX.test(name)) throw httpError('name must be 3-80 chars starting with a letter or digit.');
    const func = cleanMemo(body.function, 400);
    const category = /^[a-z][a-z-]{0,30}$/.test(String(body.category || '')) ? String(body.category) : 'knowledge';
    const seedTerms = (Array.isArray(body.seedTerms) ? body.seedTerms : [])
      .map((term) => String(term).trim().toLowerCase()).filter(Boolean);
    if (seedTerms.length > 12 || seedTerms.some((term) => !SEED_TERM_RX.test(term))) {
      throw httpError('seedTerms must be at most 12 short tokens (letters/digits/dash/underscore, no leading dash).');
    }
    const code = String(body.code || '');
    if (code.length > 20000) throw httpError('op code too large (20k chars max) — it is stored inert, never executed.');
    // Two skill-sanctioned lanes (both exit 0 even when they decline, so the
    // registry itself — not the exit code — is the proof of what happened):
    //  - WITH code: cambium propose-op -> INERT 'proposed' entry awaiting the
    //    human Activate step (model-authored code never auto-runs).
    //  - WITHOUT code: cambium grow --mode sprout -> the canonical promotion
    //    path (PROMOTE_AT=1 enables it immediately, WITH an attached effect).
    let outcome;
    if (code) {
      // --function=/--code= forms: argparse never misreads the value as a flag.
      const args = ['propose-op', name, '--kind', kind, `--function=${func}`, '--category', category, `--code=${code}`];
      if (seedTerms.length) args.push('--seed-terms', ...seedTerms);
      outcome = await mutateViaCli('cambium.py', args);
    } else {
      const inputText = [name, ...seedTerms, func].join(' ').slice(0, 600);
      const args = ['grow', inputText, '--mode', 'sprout', '--kind', kind, `--name=${name}`];
      if (func) args.push(`--function=${func}`);
      outcome = await mutateViaCli('cambium.py', args);
    }
    const cliText = typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result || '');
    // grow declines when existing faculties already cover the vocabulary;
    // propose-op declines when code is missing. Surface a decline AS a decline.
    if (/no growth|provide --code/i.test(cliText)) {
      throw httpError(`The skill declined the paste: ${truncate(cliText.replace(/\s+/g, ' ').trim(), 300)}`, 422);
    }
    // The registry is the truth: find what the paste actually became. grow()
    // appends 'Sensing'/'Reasoning' when the name lacks the kind suffix.
    const after = await emergentOverview();
    const nameLc = name.toLowerCase();
    const faculty = after.faculties.slice().reverse().find((f) => {
      const fn = f.name.toLowerCase();
      return fn === nameLc || fn === `${nameLc} sensing` || fn === `${nameLc} reasoning`;
    }) || null;
    outcome.faculty = faculty;
    outcome.epoch = await resealRegistryEpoch(`dashboard: pasted faculty ${name}`);
    return outcome;
  }
  return null;
}

async function jsonBody(req, limitBytes = MAX_JSON_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw httpError('Request body too large.', 413);
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError('Invalid JSON request body.');
  }
}

function bridgeStatus(req) {
  const paired = Boolean(bridgeRecord(req));
  return {
    ok: true,
    bridge: 'cypher-tempre-local',
    host: HOST,
    port: PORT,
    paired,
    remoteOrigin: isRemoteOrigin(req),
    rootDetected: Boolean(timechainRoot),
    publicOrigins: [...PUBLIC_ORIGINS],
  };
}

function createBridgeToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  bridgeTokens.set(token, {
    token,
    createdAt: now,
    expiresAt: now + BRIDGE_TOKEN_TTL_MS,
    sessionId: null,
  });
  return token;
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    ...securityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

async function serveStatic(req, res, url) {
  // Keep this original read-only bridge's local entry point in the auditor.
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/audit/') {
    res.writeHead(302, { Location: '/audit/index.html', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const target = path.resolve(publicDir, rel);
  if (target !== publicDir && !target.startsWith(`${publicDir}${path.sep}`)) {
    sendJson(res, 403, { error: 'Forbidden' });
    return;
  }
  const file = fsSync.existsSync(target) && fsSync.statSync(target).isFile() ? target : path.join(publicDir, 'index.html');
  const ext = path.extname(file);
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ttf': 'font/ttf',
    '.woff2': 'font/woff2',
  };
  res.writeHead(200, {
    ...securityHeaders(),
    'content-type': types[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fsSync.createReadStream(file).pipe(res);
}

async function handle(req, res) {
  if (!allowedOrigin(req)) {
    sendJson(res, 403, { error: 'Cross-origin access denied.' });
    return;
  }
  applyCorsHeaders(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...securityHeaders(),
      'cache-control': 'no-store',
    });
    res.end();
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname === '/api/bridge/status') {
      sendJson(res, 200, bridgeStatus(req));
      return;
    }
    if (url.pathname === '/api/bridge/pair' && req.method === 'POST') {
      const body = await jsonBody(req);
      if (!pairingCodeMatches(body.code)) {
        const error = new Error('Pairing code did not match this local bridge.');
        error.status = 401;
        throw error;
      }
      const bridgeToken = createBridgeToken();
      sendJson(res, 200, {
        ok: true,
        paired: true,
        bridgeToken,
        expiresInSeconds: Math.floor(BRIDGE_TOKEN_TTL_MS / 1000),
      });
      return;
    }
    requireBridgePairing(req);
    const session = getSession(req, res);
    if (url.pathname === '/api/timechain/summary') {
      sendJson(res, 200, await buildSummary());
      return;
    }
    if (url.pathname === '/api/learning/overview') {
      sendJson(res, 200, await buildLearningOverview());
      return;
    }
    if (url.pathname === '/api/timechain/rings') {
      sendJson(res, 200, await listRings(url));
      return;
    }
    const ringMatch = url.pathname.match(/^\/api\/timechain\/rings\/(\d+)$/);
    if (ringMatch) {
      const ring = await ringDetail(ringMatch[1]);
      if (!ring) sendJson(res, 404, { error: 'Ring not found.' });
      else sendJson(res, 200, ring);
      return;
    }
    if (url.pathname === '/api/blockspace') {
      sendJson(res, 200, await listBlockspace());
      return;
    }
    const blobMatch = url.pathname.match(/^\/api\/blockspace\/([0-9a-fA-F]{64})$/);
    if (blobMatch) {
      sendJson(res, 200, await blobPreview(blobMatch[1]));
      return;
    }
    if (url.pathname === '/api/cphy/overview') {
      sendJson(res, 200, await cphyOverview());
      return;
    }
    if (url.pathname === '/api/cphy/blocks') {
      sendJson(res, 200, await cphyBlocks());
      return;
    }
    if (url.pathname === '/api/cphy/ledger') {
      sendJson(res, 200, { events: await readLedgerEvents() });
      return;
    }
    if (url.pathname === '/api/retrieval/history') {
      sendJson(res, 200, await retrievalHistory(url));
      return;
    }
    if (url.pathname === '/api/retrieval/preview' && req.method === 'POST') {
      sendJson(res, 200, await retrievalPreview(await jsonBody(req)));
      return;
    }
    if (url.pathname === '/api/immune') {
      sendJson(res, 200, await immuneOverview());
      return;
    }
    if (url.pathname === '/api/forks') {
      sendJson(res, 200, await forkTree());
      return;
    }
    if (url.pathname === '/api/registry/emergent') {
      sendJson(res, 200, await emergentOverview());
      return;
    }
    if (url.pathname === '/api/organs') {
      sendJson(res, 200, await organsOverview());
      return;
    }
    if (req.method === 'POST' && (url.pathname.startsWith('/api/cphy/') || url.pathname.startsWith('/api/pack/')
        || url.pathname === '/api/ring/seal' || url.pathname.startsWith('/api/immune/')
        || url.pathname.startsWith('/api/registry/'))) {
      const outcome = (await handleCphyMutation(req, url))
        ?? (await handlePackMutation(req, url))
        ?? (await handleChainMutation(req, url))
        ?? (await handleRegistryMutation(req, url));
      if (outcome) {
        sendJson(res, 200, outcome);
        return;
      }
    }
    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'Not found.' });
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, error.status || 500, { error: error.message || 'Unexpected error.' });
  }
}

timechainRoot = await discoverTimechainRoot();
const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => sendJson(res, 500, { error: error.message || 'Unexpected error.' }));
});

server.on('error', (error) => {
  console.error(`Dashboard server failed to listen on ${HOST}:${PORT}: ${error.message}`);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Cypher Tempre Dashboard listening on http://${HOST}:${PORT}`);
  console.log(`Timechain root: ${timechainRoot}`);
  console.log('Audit is free, local, and private: no payment gate, no accounts, no outbound network calls.');
  console.log(`Public origins: ${[...PUBLIC_ORIGINS].join(', ')}`);
  console.log(`Bridge pairing code: ${displayPairingCode(BRIDGE_PAIR_CODE)}`);
  console.log('Enter that pairing code on cyphertempre.ai to connect this local bridge.');
});
