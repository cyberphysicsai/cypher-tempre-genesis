/** Bounded projections of a paired native Timechain. No writes or code loading. */
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const WINDOW_BYTES = 8 * 1024 * 1024;
const RING_BYTES = 1024 * 1024;
const JSON_BYTES = 2 * 1024 * 1024;
const BLOB_BYTES = 16 * 1024 * 1024;
const PREVIEW_BYTES = 128 * 1024;
const OPS = new Set(['summary', 'rings', 'ring', 'blockspace', 'blob']);
const failure = (message, code = 'AUDIT_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const shortened = (value, maximum = 360) => typeof value === 'string' ? value.slice(0, maximum) : '';
const text = value => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
const integer = (value, fallback, maximum) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw failure('Audit indices and page bounds must be valid integers.');
  return value;
};

async function safeRoot(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw failure('A paired agent root is required.');
  const absolute = path.resolve(value);
  try {
    const real = await fs.realpath(absolute), info = await fs.lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink() || normalized(real) !== normalized(absolute))
      throw failure('Symlinked audit roots are not permitted.', 'AUDIT_PATH', 403);
    return real;
  } catch (error) { if (error.code?.startsWith('AUDIT_')) throw error; throw failure('The paired audit root is unavailable.', 'AUDIT_ROOT', 404); }
}

async function openSafe(root, parts, { optional = false } = {}) {
  let current = root;
  try {
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const info = await fs.lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory()))
        throw failure('Symlinked audit files are not permitted.', 'AUDIT_PATH', 403);
    }
    const real = await fs.realpath(current);
    if (!normalized(real).startsWith(normalized(root + path.sep))) throw failure('Audit path is outside its paired root.', 'AUDIT_PATH', 403);
    const handle = await fs.open(current, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.nlink > 1) { await handle.close(); throw failure('Only ordinary agent-owned audit files are permitted.', 'AUDIT_PATH', 403); }
    return { handle, info };
  } catch (error) {
    if (error.code?.startsWith('AUDIT_')) throw error;
    if (optional && error.code === 'ENOENT') return null;
    throw failure('The requested audit file is unavailable.', 'AUDIT_FILE', 404);
  }
}

async function jsonFile(root, parts, fallback, notices) {
  const opened = await openSafe(root, parts, { optional: true });
  if (!opened) return fallback;
  try {
    if (opened.info.size > JSON_BYTES) { notices.push('An oversized metadata file was omitted from this bounded view.'); return fallback; }
    const buffer = Buffer.alloc(JSON_BYTES + 1); let bytes = 0;
    while (bytes < buffer.length) { const part = await opened.handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!part.bytesRead) break; bytes += part.bytesRead; }
    if (bytes > JSON_BYTES) { notices.push('A metadata file exceeded the bounded read limit.'); return fallback; }
    const result = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
    return object(result) || Array.isArray(result) ? result : fallback;
  } catch { notices.push('An unreadable metadata file was omitted.'); return fallback; }
  finally { await opened.handle.close(); }
}

async function ringWindow(root) {
  const { handle, info } = await openSafe(root, ['chain', 'rings.jsonl']);
  const notices = [];
  try {
    const length = Math.min(info.size, WINDOW_BYTES), start = info.size - length;
    const buffer = Buffer.alloc(length); let received = 0;
    while (received < length) {
      const part = await handle.read(buffer, received, length - received, start + received);
      if (!part.bytesRead) break; received += part.bytesRead;
    }
    let raw = buffer.subarray(0, received);
    if (start) { const boundary = raw.indexOf(10); raw = boundary < 0 ? Buffer.alloc(0) : raw.subarray(boundary + 1);
      notices.push('Showing the most recent 8 MiB of chain data; older history remains on your machine.'); }
    const rings = []; let invalid = 0, capped = false;
    for (const line of raw.toString('utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > RING_BYTES) { invalid++; continue; }
      try {
        const ring = JSON.parse(line);
        if (!object(ring) || !Number.isSafeInteger(ring.index) || ring.index < 0 || !object(ring.payload)) { invalid++; continue; }
        rings.push(ring);
        if (rings.length > 10000) { rings.shift(); capped = true; }
      } catch { invalid++; }
    }
    if (invalid) notices.push(`${invalid} malformed or oversized ring record(s) were omitted; this projection cannot certify them.`);
    if (capped) notices.push('The ring window is limited to 10,000 recent records.');
    return { rings, notices, partial: start > 0 || invalid > 0 || capped, invalid, fileBytes: info.size };
  } finally { await handle.close(); }
}

function compactRing(ring) {
  const payload = ring.payload || {}, labels = payload.labels || {};
  const score = ring.poi || ring[['po', 'q'].join('')] || {};
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, 20).map(item => shortened(item, 128)) : [];
  return { index: ring.index, type: shortened(ring.ring_type || 'unknown', 80), timestamp: shortened(ring.timestamp, 80),
    hash: shortened(ring.ring_hash, 64), prevHash: shortened(ring.prev_hash, 64), brightness: Number.isFinite(score.brightness) ? score.brightness : null,
    summary: shortened(text(payload.summary || payload.synthesis || payload.context || payload.event || payload.task || ring.ring_type || '')),
    keywords: strings(labels.keywords), entities: strings(labels.entities), blockspaceRefs: Array.isArray(ring.blockspace_refs) ? ring.blockspace_refs.slice(0, 20).map(ref => ({ hash: shortened(ref?.hash, 64), role: shortened(ref?.role, 128) })) : [] };
}
function categories(items, key) {
  const counts = new Map();
  for (const item of items) { const name = shortened(text(key(item)) || 'unknown', 100); counts.set(name, (counts.get(name) || 0) + 1); }
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 100);
}
async function blockIndex(root, notices) {
  const index = await jsonFile(root, ['chain', 'blockspace', 'index.json'], {}, notices);
  const entries = [];
  for (const [hash, metadata] of Object.entries(index)) {
    if (!/^[a-f0-9]{64}$/i.test(hash) || !object(metadata)) continue;
    entries.push({ hash: hash.toLowerCase(), size: Number.isSafeInteger(metadata.size) && metadata.size >= 0 ? metadata.size : 0,
      filename: shortened(metadata.filename, 512), mime: shortened(metadata.mime, 128), added_at: shortened(metadata.added_at, 80) });
    if (entries.length >= 20000) { notices.push('Blockspace metadata is limited to 20,000 entries.'); break; }
  }
  return entries;
}

/** `inspect` is a trusted server callback/result, never a browser-supplied field. */
export async function readChainAudit({ root: requestedRoot, op, index, offset, limit, hash, inspect, ...extra } = {}) {
  if (!OPS.has(op) || Object.keys(extra).length) throw failure('Unsupported read-only audit operation.');
  const start = integer(offset, 0, 10000), page = integer(limit, 100, 100);
  if (!page || (index !== undefined && op !== 'ring') || (hash !== undefined && op !== 'blob') ||
      ((offset !== undefined || limit !== undefined) && !['rings', 'blockspace'].includes(op))) throw failure('Unexpected audit operation parameters.');
  if (op === 'ring') integer(index, undefined, Number.MAX_SAFE_INTEGER);
  if (op === 'ring' && index === undefined) throw failure('A ring index is required.');
  if (op === 'blob' && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))) throw failure('A blockspace SHA-256 digest is required.');
  const root = await safeRoot(requestedRoot);
  if (op === 'blob') {
    const { handle, info } = await openSafe(root, ['chain', 'blockspace', 'blobs', hash]);
    try {
      if (info.size > BLOB_BYTES) throw failure('This blob exceeds the 16 MiB verification limit; inspect it locally.', 'AUDIT_LIMIT', 413);
      const digest = createHash('sha256'), chunks = []; let bytes = 0, previewSize = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false })) {
        bytes += chunk.length; if (bytes > BLOB_BYTES) throw failure('The blob changed while being read.', 'AUDIT_CHANGED', 409);
        digest.update(chunk);
        if (previewSize < PREVIEW_BYTES) { const kept = chunk.subarray(0, PREVIEW_BYTES - previewSize); chunks.push(kept); previewSize += kept.length; }
      }
      const preview = Buffer.concat(chunks); let text = !preview.includes(0), decoded = '';
      if (text) try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(preview, { stream: true }); } catch { text = false; }
      return { hash, size: bytes, verified: digest.digest('hex') === hash, text, truncated: bytes > preview.length,
        preview: text ? decoded : '', readOnly: true };
    } finally { await handle.close(); }
  }
  if (op === 'blockspace') {
    const notices = [], entries = await blockIndex(root, notices);
    entries.sort((a, b) => b.size - a.size);
    return { total: entries.length, totalBytes: entries.reduce((sum, item) => sum + item.size, 0), entries: entries.slice(start, start + page),
      offset: start, limit: page, hasMore: start + page < entries.length, notices, readOnly: true };
  }
  const window = await ringWindow(root);
  if (op === 'ring') {
    const ring = window.rings.find(item => item.index === index);
    if (!ring) throw failure('The ring is outside this bounded audit window or unavailable.', 'AUDIT_RING', 404);
    return ring;
  }
  if (op === 'rings') {
    const sorted = [...window.rings].reverse();
    return { total: sorted.length, rings: sorted.slice(start, start + page).map(compactRing), offset: start, limit: page,
      hasMore: start + page < sorted.length, partial: window.partial, notices: window.notices, readOnly: true };
  }
  const notices = [...window.notices];
  let native = null, verificationFailed = false;
  try { native = typeof inspect === 'function' ? await inspect() : inspect; }
  catch { verificationFailed = true; notices.push('Native verification did not complete; no integrity PASS is asserted.'); }
  const modalitiesRaw = await jsonFile(root, ['registry', 'modalities.json'], {}, notices);
  const sensesRaw = await jsonFile(root, ['registry', 'senses.json'], {}, notices);
  const emergent = await jsonFile(root, ['registry', 'emergent.json'], {}, notices);
  const modalities = Array.isArray(modalitiesRaw.modalities) ? modalitiesRaw.modalities : [];
  const senses = Array.isArray(sensesRaw.senses) ? sensesRaw.senses : [];
  const blocks = await blockIndex(root, notices), latest = window.rings.at(-1);
  let verified = native?.verified === true ? true : native?.verified === false || verificationFailed ? false : null;
  if (window.invalid) verified = false;
  if (verified && native.head?.hash && latest?.ring_hash !== native.head.hash) { verified = null; notices.push('The native head and bounded projection differ; refresh before relying on this snapshot.'); }
  const count = Number.isSafeInteger(native?.height) ? native.height : Number.isSafeInteger(native?.head?.index) ? native.head.index + 1 : latest ? latest.index + 1 : 0;
  return { root, generatedAt: new Date().toISOString(), readOnly: true, partial: window.partial, notices,
    verification: { ok: verified, report: Array.isArray(native?.verification) ? native.verification.slice(0, 40).map(item => shortened(text(item), 512)) : [], head: native?.head || null },
    stats: { rings: count, modalities: modalities.length, senses: senses.length,
      emergent: Array.isArray(emergent) ? emergent.length : Object.values(emergent).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0),
      blockspaceEntries: blocks.length, blockspaceBytes: blocks.reduce((sum, item) => sum + item.size, 0),
      approxContinuumTokens: Math.max(0, ...window.rings.map(ring => { const count = ring.payload?.state?.metrics?.approx_tokens_ingested; return Number.isFinite(count) && count >= 0 ? count : 0; })) },
    latest: latest ? compactRing(latest) : null, ringTypes: categories(window.rings, item => item.ring_type),
    modalityCategories: categories(modalities, item => item?.category), senseCategories: categories(senses, item => item?.category), domains: [] };
}
