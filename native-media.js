/** Local native media IDs, never arbitrary remote URLs or filesystem paths. */
export const NATIVE_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
export const NATIVE_MEDIA_MAX_FILES = 10;
const types = Object.freeze({
  'image/png': 'image', 'image/jpeg': 'image', 'image/webp': 'image', 'image/gif': 'image',
  'audio/wav': 'audio', 'audio/mpeg': 'audio', 'audio/ogg': 'audio', 'audio/flac': 'audio', 'audio/mp4': 'audio',
  'video/mp4': 'video', 'video/webm': 'video', 'application/pdf': 'document', 'text/plain': 'document',
});
const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf', txt: 'text/plain' };
export const NATIVE_MEDIA_ACCEPT = Object.keys(types).join(',');
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\0\r\n/\\\u2028\u2029]/.test(value);
const validId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const sizeLabel = bytes => bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const isNative = value => value?.configured === true && value.provider === 'native' && value.tier === 'native';

export function nativeMediaAsset(value) {
  if (!validId(value?.id) || !validName(value?.fileName) || !Object.hasOwn(types, value?.mimeType) ||
      value.kind !== types[value.mimeType] || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > NATIVE_MEDIA_MAX_BYTES) return null;
  return { id: value.id, fileName: value.fileName, mimeType: value.mimeType, bytes: value.bytes, kind: value.kind };
}
export function nativeMediaFile(file) {
  const aliases = { 'audio/x-wav': 'audio/wav', 'audio/wave': 'audio/wav', 'audio/mp3': 'audio/mpeg', 'audio/x-flac': 'audio/flac' };
  const declared = typeof file?.type === 'string' ? file.type.toLowerCase().split(';')[0] : '';
  const mimeType = aliases[declared] || declared || extensions[file?.name?.split('.').at(-1)?.toLowerCase()];
  if (!validName(file?.name) || !Object.hasOwn(types, mimeType) || !Number.isSafeInteger(file?.size) || file.size < 1 || file.size > NATIVE_MEDIA_MAX_BYTES)
    throw new Error('Choose a supported image, audio, video, PDF or plain-text file within 20 MiB.');
  return { fileName: file.name, mimeType, bytes: file.size, kind: types[mimeType] };
}
async function encodeFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer()), chunks = [];
  if (bytes.length !== file.size || bytes.length > NATIVE_MEDIA_MAX_BYTES) throw new Error('The selected file size changed.');
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return btoa(chunks.join(''));
}
export function createNativeAttachmentQueue({ api, context, provider, encode = encodeFile, onChange = () => {}, onError = () => {} }) {
  let owner = context(), epoch = 0, assets = [], uploading = false;
  const snapshot = () => ({ assets: assets.map(value => ({ ...value })), uploading, totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0) });
  function sync() { if (owner !== context()) { owner = context(); epoch++; assets = []; uploading = false; onChange(snapshot()); } }
  function clear() { epoch++; assets = []; uploading = false; onChange(snapshot()); }
  async function upload(files) {
    sync(); if (uploading) return;
    if (!isNative(provider())) { onError('Choose a configured native OpenClaw model before attaching files.'); return; }
    const selected = Array.from(files || []); let metadata;
    try {
      metadata = selected.map(nativeMediaFile);
      if (!selected.length) return;
      if (assets.length + selected.length > NATIVE_MEDIA_MAX_FILES || snapshot().totalBytes + metadata.reduce((sum, asset) => sum + asset.bytes, 0) > NATIVE_MEDIA_MAX_BYTES)
        throw new Error('Use at most 10 files and 20 MiB total in one native chat request.');
    } catch (failure) { onError(failure.message); return; }
    const bound = owner, version = epoch; uploading = true; onError(''); onChange(snapshot());
    try {
      for (let index = 0; index < selected.length; index++) {
        const content = await encode(selected[index]);
        if (bound !== context() || version !== epoch || !isNative(provider())) return;
        const expected = metadata[index];
        const result = await api('/api/media/upload', { fileName: expected.fileName, mimeType: expected.mimeType, content });
        if (bound !== context() || version !== epoch || !isNative(provider())) return;
        const asset = nativeMediaAsset(result?.asset);
        if (!asset || asset.bytes !== expected.bytes || asset.mimeType !== expected.mimeType) throw new Error('The uploaded local asset did not match its selected file. Inspect the local app.');
        if (!assets.some(value => value.id === asset.id)) assets.push(asset);
        onChange(snapshot());
      }
    } catch { if (bound === context() && version === epoch) onError('The selected file could not be uploaded to the local app. Check its type, size and native session.'); }
    finally { if (bound === context() && version === epoch) { uploading = false; onChange(snapshot()); } }
  }
  function take() {
    sync();
    if (uploading) throw new Error('Wait for the local uploads to finish before sending.');
    if (assets.length && !isNative(provider())) throw new Error('Choose the native model that owns this attachment queue.');
    const selected = snapshot().assets; clear(); return { ids: selected.map(asset => asset.id), assets: selected };
  }
  function remove(id) { sync(); assets = assets.filter(asset => asset.id !== id); onChange(snapshot()); }
  return { upload, take, remove, clear, sync, snapshot };
}

export function nativeChatPayload(message, attachments, provider) {
  if (!Array.isArray(attachments) || attachments.length > NATIVE_MEDIA_MAX_FILES || new Set(attachments).size !== attachments.length || attachments.some(id => !validId(id))) throw new Error('Choose verified uploaded local files.');
  if (attachments.length && !isNative(provider)) throw new Error('Attachments require the selected native OpenClaw model.');
  return { message, ...(attachments.length ? { attachments: [...attachments] } : {}) };
}
export function nativeHistoryMedia(payload, direction) {
  if (!['input', 'output', 'unknown'].includes(direction)) return [];
  const groups = {input: new Map(), output: new Map(), unknown: new Map()};
  for (const [field, expected, wrapper] of [['attachments', 'input', true], ['media', 'output', true],
    ['sourceAssets', 'input', false], ['outputAssets', 'output', false], ['unknownAttachments', 'unknown', true]]) {
    for (const row of (Array.isArray(payload?.[field]) ? payload[field] : []).slice(0, NATIVE_MEDIA_MAX_FILES)) {
      const modern = nativeMediaAsset(row), asset = modern || nativeMediaAsset({ id: row?.hash, bytes: row?.size,
        mimeType: row?.mime, fileName: row?.name, kind: row?.kind });
      if (!asset) continue;
      // Canonical references require explicit attribution. Older native refs
      // without direction remain visible as unknown instead of inventing a role.
      const known = row?.direction === expected || wrapper && modern && row?.direction === undefined;
      groups[expected !== 'unknown' && known ? expected : 'unknown'].set(asset.id, asset);
    }
  }
  for (const id of [...groups.input.keys(), ...groups.output.keys()]) groups.unknown.delete(id);
  return [...groups[direction].values()].slice(0, NATIVE_MEDIA_MAX_FILES);
}
export function nativeMessageMedia(message, previous) {
  const sanitize = values => { const seen = new Set(); return (Array.isArray(values) ? values : []).slice(0, NATIVE_MEDIA_MAX_FILES).map(nativeMediaAsset).filter(asset => asset && !seen.has(asset.id) && seen.add(asset.id)); };
  let inputs = sanitize(message?.attachments);
  if (message?.role === 'assistant' && previous?.role === 'user') {
    const before = sanitize(previous.attachments);
    if (inputs.length === before.length && inputs.every(asset => before.some(other => other.id === asset.id))) inputs = [];
  }
  return { inputs, outputs: message?.role === 'assistant' && !message.held ? sanitize(message.media) : [],
    unknown: message?.held ? [] : sanitize(message?.unknownAttachments) };
}

export async function verifiedNativeMedia(api, asset, { signal, hash = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('') } = {}) {
  const expected = nativeMediaAsset(asset); if (!expected) throw new Error('Choose a verified local media asset.');
  const result = await api('/api/media/read', { assetId: expected.id }, { signal });
  const actual = nativeMediaAsset(result?.asset), content = result?.content;
  if (!actual || actual.id !== expected.id || actual.mimeType !== expected.mimeType || actual.bytes !== expected.bytes ||
      typeof content !== 'string' || content.length > Math.ceil(NATIVE_MEDIA_MAX_BYTES / 3) * 4) throw new Error('The local asset metadata changed.');
  const binary = atob(content);
  if (binary.length !== actual.bytes || btoa(binary) !== content) throw new Error('The local asset bytes are invalid.');
  const bytes = Uint8Array.from(binary, value => value.charCodeAt(0));
  if (await hash(bytes) !== expected.id) throw new Error('The local asset did not match its verified content hash.');
  return { asset: actual, bytes };
}

export function renderNativeMedia({ document: doc, mount, assets, label = 'Attached inputs', api, context = () => '',
  createURL = value => URL.createObjectURL(value), revokeURL = value => URL.revokeObjectURL(value), read = verifiedNativeMedia }) {
  const make = (tag, content = '', className = '') => { const node = doc.createElement(tag); node.textContent = content; node.className = className; return node; };
  const seen = new Set(), entries = (Array.isArray(assets) ? assets : []).slice(0, 10).map(nativeMediaAsset).filter(asset => asset && !seen.has(asset.id) && seen.add(asset.id));
  if (!entries.length) return () => {};
  const section = make('section', '', 'native-message-media'); section.append(make('h4', label)); mount.append(section);
  const urls = new Set(), controllers = new Set(), mediaNodes = new Set(); let disposed = false;
  for (const asset of entries) {
    const row = make('article', '', 'native-media-item'), title = make('p', `${asset.fileName} · ${sizeLabel(asset.bytes)}`, 'native-media-name');
    const actionLabel = asset.kind === 'image' ? 'View image' : asset.kind === 'audio' ? 'Load audio controls' : asset.kind === 'video' ? 'Load video controls' : 'Read local file';
    const action = make('button', actionLabel, 'text-button'); action.type = 'button';
    const preview = make('div', '', 'native-media-preview'), status = make('p', '', 'fine-print'); status.setAttribute('role', 'status');
    let loaded = false, rowURL = null, rowNode = null;
    function clearPreview() {
      if (rowNode) { rowNode.pause?.(); rowNode.removeAttribute?.('src'); mediaNodes.delete(rowNode); rowNode = null; }
      if (rowURL) { revokeURL(rowURL); urls.delete(rowURL); rowURL = null; }
      preview.replaceChildren(); loaded = false; action.textContent = actionLabel; status.textContent = '';
    }
    row.append(title, action, status, preview); section.append(row);
    action.addEventListener('click', async () => {
      if (disposed || action.disabled) return;
      if (loaded) { clearPreview(); return; }
      const owner = context(), controller = new AbortController(); controllers.add(controller); action.disabled = true;
      status.textContent = 'Reading and verifying the selected local asset…';
      try {
        const result = await read(api, asset, { signal: controller.signal });
        if (disposed || owner !== context()) return;
        if (asset.mimeType === 'text/plain') {
          const content = new TextDecoder('utf-8', { fatal: true }).decode(result.bytes);
          preview.append(make('pre', content.slice(0, 200000), 'native-media-text'));
          status.textContent = content.length > 200000 ? 'Local text preview truncated at 200,000 characters.' : 'Verified local text.';
        } else {
          const url = createURL(new Blob([result.bytes], { type: asset.mimeType }));
          if (typeof url !== 'string' || !url.startsWith('blob:')) throw new Error('Use a local Blob URL.');
          urls.add(url); rowURL = url;
          if (['image', 'audio', 'video'].includes(asset.kind)) {
            const node = make(asset.kind === 'image' ? 'img' : asset.kind); node.src = url;
            if (asset.kind === 'image') { node.alt = asset.fileName; node.loading = 'lazy'; }
            else { node.controls = true; node.preload = 'none'; }
            mediaNodes.add(node); rowNode = node; preview.append(node);
          } else {
            const download = make('a', 'Download verified local file', 'text-button'); download.href = url; download.download = asset.fileName; preview.append(download);
          }
          status.textContent = 'Verified local asset. No external media URL was loaded.';
        }
        loaded = true; action.textContent = 'Hide preview'; action.disabled = false;
      } catch { if (!disposed && owner === context()) { clearPreview(); status.textContent = 'This local media asset could not be verified or loaded.'; action.disabled = false; } }
      finally { controllers.delete(controller); }
    });
  }
  return () => { disposed = true; for (const controller of controllers) controller.abort(); for (const node of mediaNodes) { node.pause?.(); node.removeAttribute?.('src'); } for (const url of urls) revokeURL(url); urls.clear(); mediaNodes.clear(); };
}

export function mountNativeMediaComposer({ document: doc, button, input, notice, queueMount, api, context, provider, isBusy = () => false, onError = () => {}, onChange = () => {}, encode }) {
  const make = (tag, content = '', className = '') => { const node = doc.createElement(tag); node.textContent = content; node.className = className; return node; };
  let cleanups = [], lastAvailability = '';
  function render(snapshot) {
    for (const cleanup of cleanups) cleanup(); cleanups = []; queueMount.replaceChildren();
    for (const asset of snapshot.assets) {
      const row = make('article', '', 'native-queued-asset'), remove = make('button', 'Remove', 'text-button'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${asset.fileName}`);
      row.append(make('span', `${asset.fileName} · ${sizeLabel(asset.bytes)}`, 'native-media-name'), remove); remove.addEventListener('click', () => queue.remove(asset.id)); remove.disabled = isBusy() || snapshot.uploading;
      cleanups.push(renderNativeMedia({ document: doc, mount: row, assets: [asset], label: 'Queued input', api, context })); queueMount.append(row);
    }
    queueMount.classList.toggle('hidden', !snapshot.assets.length); sync(); onChange(snapshot);
  }
  const queue = createNativeAttachmentQueue({ api, context, provider, encode, onChange: render, onError });
  function sync() {
    queue.sync(); const snapshot = queue.snapshot(), available = isNative(provider());
    button.disabled = !available || isBusy() || snapshot.uploading; input.disabled = button.disabled; input.accept = NATIVE_MEDIA_ACCEPT;
    const description = !available ? 'Attachments require a paired agent and configured native OpenClaw model.' : snapshot.uploading ? 'Uploading selected files to your local app…'
      : 'Files upload locally; native providers receive content when you send. Up to 10 files / 20 MiB. Add a message; the selected model or its configured observation adapters must support each type. Readiness is checked on send.';
    if (description !== lastAvailability) { notice.textContent = description; lastAvailability = description; }
    button.title = description;
  }
  button.addEventListener('click', () => { sync(); if (!button.disabled) input.click(); });
  input.addEventListener('change', () => { const files = Array.from(input.files || []); input.value = ''; return queue.upload(files); });
  sync(); return { sync, take: queue.take, snapshot: queue.snapshot,
    dispose() { queue.clear(); for (const cleanup of cleanups) cleanup(); cleanups = []; } };
}
