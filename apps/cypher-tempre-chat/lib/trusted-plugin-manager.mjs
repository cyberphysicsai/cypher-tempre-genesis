import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createNpmPluginSourceResolver } from './npm-plugin-source.mjs';

const error = (message, code = 'TRUSTED_PLUGIN_DENIED') => Object.assign(new Error(message), { code, status: 403 });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max = 8192) => typeof value === 'string' && value.trim() && value.length <= max && !value.includes('\0');
const stable = value => JSON.stringify(value, (_key, child) => plain(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
export const pluginActionHash = value => createHash('sha256').update(stable(value)).digest('hex');
const SOURCES = {
  clawhub: ['packageName', 'version', 'expectedPluginId', 'expectedIntegrity'], official: ['pluginId', 'version', 'pin'],
  npm: ['spec', 'pin', 'expectedPluginId', 'expectedIntegrity'], git: ['spec'], local: ['path', 'link'],
  'npm-pack': ['archivePath'], marketplace: ['marketplace', 'plugin'], bundled: ['pluginId', 'spec'],
};
const REQUIRED = { clawhub: ['packageName'], official: ['pluginId'], npm: ['spec'], git: ['spec'], local: ['path'], 'npm-pack': ['archivePath'], marketplace: ['marketplace', 'plugin'], bundled: ['pluginId'] };
const RESERVED = new Set(['browser', 'chainchat_browser', 'chainchat_automation', 'read', 'write', 'edit', 'apply_patch', 'exec', 'process', 'terminal', 'get_goal', 'create_goal', 'update_goal', 'cron', 'message', 'gateway', 'config', 'secrets', 'nodes', 'computer', 'screen', 'dashboard', 'tts', 'web_fetch', 'web_search', 'tool_call', 'tool_search', 'tool_describe', 'agents_list', 'sessions', 'sessions_list', 'sessions_send', 'sessions_spawn', 'session_status']);
// Reserve the pinned native catalogue even if a plugin masks a native entry
// before effective-inventory projection. Such a collision is never a grant.
for (const name of ['decision_evaluate', 'ls', 'code_execution', 'x_search', 'memory_search', 'memory_get', 'personal_instructions',
  'presence', 'sessions_history', 'sessions_search', 'conversations_list', 'conversations_send', 'conversations_turn', 'github_identity_status',
  'github_publish', 'agents_wait', 'sessions_yield', 'subagents', 'suggest_task', 'dismiss_task', 'theme', 'portal', 'canvas', 'show_widget',
  'heartbeat_respond', 'automations', 'plugins', 'openclaw', 'mobile_ui', 'progress_card', 'ask_user', 'skill_workshop', 'skills_search',
  'skills_read', 'view_image', 'image_generate', 'music_generate', 'video_generate', 'transcripts', 'pdf']) RESERVED.add(name);
const canonicalTool = name => String(name).trim().toLowerCase().replace(/[.-]/g, '_');
function pluginId(value) {
  if (!text(value, 256) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw error('A valid native plugin identifier is required.');
  return value.trim();
}
export function normalizePluginSource(input) {
  if (!plain(input) || !Object.hasOwn(SOURCES, input.source) || Object.keys(input).some(key => key !== 'source' && !SOURCES[input.source].includes(key))) throw error('Choose one supported native plugin source without safety overrides.');
  for (const key of REQUIRED[input.source]) if (!text(input[key])) throw error('The native plugin source is incomplete.');
  for (const [key, value] of Object.entries(input)) {
    if (key === 'pin' || key === 'link') { if (typeof value !== 'boolean') throw error('Invalid native source flag.'); }
    else if (!text(value)) throw error('A bounded native source value is required.');
    if (typeof value === 'string' && /[a-z]+:\/\/[^\s/@]+:[^\s/@]+@/i.test(value)) throw error('Keep source credentials in native credential storage, not a package URL.');
  }
  return structuredClone(input);
}

/** This is a PRIVATE manager facade, never a generic browser RPC endpoint.
 * Native protocol validation still runs again in the pinned Gateway.
 */
export function trustedPluginRpcValidators({ mandatoryPluginIds = ['cypher-tempre-poi'] } = {}) {
  const protectedIds = new Set(mandatoryPluginIds.map(id => pluginId(id).toLowerCase()));
  const checkId = id => { id = pluginId(id); if (protectedIds.has(id.toLowerCase())) throw error('Mandatory plugins are not lifecycle targets.'); return id; };
  const closed = (value, keys) => { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw error('Invalid private native plugin request.'); return structuredClone(value); };
  const acknowledgement = value => { if (value !== undefined && (!plain(value) || Object.keys(value).some(key => key !== 'reviewToken') || !text(value.reviewToken, 4096))) throw error('Invalid native capability acknowledgment.'); };
  return {
    'plugins.list': params => closed(params, []),
    'plugins.inspect': params => {
      const value = closed(params, ['pluginId', 'source', 'packageName', 'version', 'catalogId']);
      if (value.pluginId) { if (Object.keys(value).length !== 1) throw error('Ambiguous plugin inspection.'); pluginId(value.pluginId); }
      else if (value.source === 'clawhub') { if (!text(value.packageName) || value.catalogId) throw error('Invalid ClawHub inspection.'); }
      else if (!text(value.catalogId, 512) || value.source || value.packageName) throw error('Invalid native catalog inspection.');
      return value;
    },
    'plugins.install': params => {
      if (!plain(params) || !Object.hasOwn(SOURCES, params.source)) throw error('Invalid native install source.');
      const value = closed(params, ['source', ...SOURCES[params.source], 'enable', 'mode', 'acknowledgeInstallPolicyWarning', 'acknowledgeCapabilities']);
      const source = normalizePluginSource(Object.fromEntries(Object.entries(value).filter(([key]) => key === 'source' || SOURCES[value.source].includes(key))));
      for (const id of [source.pluginId, source.expectedPluginId].filter(Boolean)) checkId(id);
      if (value.enable !== false || !['install', 'update'].includes(value.mode) || value.acknowledgeInstallPolicyWarning !== undefined && value.acknowledgeInstallPolicyWarning !== true) throw error('Manager installs must remain disabled and preserve native warning consent.');
      if (source.source === 'official' && source.version !== undefined && source.version !== 'latest') throw error('Official sources support the native latest selector.');
      acknowledgement(value.acknowledgeCapabilities); return value;
    },
    'plugins.setEnabled': params => { const value = closed(params, ['pluginId', 'enabled', 'allowlistPolicy', 'acknowledgeCapabilities']); checkId(value.pluginId);
      if (typeof value.enabled !== 'boolean' || value.allowlistPolicy !== 'preserve') throw error('Native enablement must preserve the managed allowlist.'); acknowledgement(value.acknowledgeCapabilities); return value; },
    'plugins.uninstall': params => { const value = closed(params, ['pluginId', 'keepFiles']); checkId(value.pluginId); if (value.keepFiles !== undefined && typeof value.keepFiles !== 'boolean') throw error('Invalid native file-retention choice.'); return value; },
    'plugins.reload': params => { const value = closed(params, ['plugins', 'waitForDrain', 'acknowledgeCapabilities']);
      if (!Array.isArray(value.plugins) || !value.plugins.length || value.plugins.length > 64 || value.waitForDrain !== true) throw error('A bounded native reload must wait for drain.');
      for (const target of value.plugins) { closed(target, ['pluginId', 'installHash', 'sourceDigests']); checkId(target.pluginId);
        if (target.installHash && !/^[a-f0-9]{64}$/i.test(target.installHash) || target.sourceDigests && (!plain(target.sourceDigests) || Object.values(target.sourceDigests).some(hash => !/^[a-f0-9]{64}$/i.test(hash)))) throw error('Invalid native reload source binding.'); }
      acknowledgement(value.acknowledgeCapabilities); return value; },
  };
}

async function localIdentity(source) {
  if (source.source !== 'local') return null;
  const root = await fs.realpath(path.resolve(source.path));
  if (!(await fs.stat(root)).isDirectory()) return null; // Archives require the native resolver.
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'openclaw.plugin.json'), 'utf8'));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const hash = createHash('sha256'); let count = 0, size = 0;
  async function walk(directory, prefix = '') {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue;
      const relative = prefix + entry.name, file = path.join(directory, entry.name), stat = await fs.lstat(file);
      if (++count > 20000 || stat.isSymbolicLink()) throw error('Mutable/external linked plugin sources require a native artifact resolver.');
      if (stat.isDirectory()) await walk(file, relative + '/');
      else if (stat.isFile()) { size += stat.size; if (size > 128 * 1024 * 1024 || stat.nlink > 1) throw error('This source requires a native artifact resolver.'); hash.update(relative + '\0'); hash.update(await fs.readFile(file)); hash.update('\0'); }
      else throw error('Plugin source contains an unsupported filesystem entry.');
    }
  }
  await walk(root);
  return { pluginId: pluginId(manifest.id), packageName: packageJson.name || manifest.id, version: packageJson.version || manifest.version,
    integrity: `sha256-${hash.digest('hex')}`, source: { ...source, path: root }, resolved: true };
}

function safeConfig(value, depth = 0) {
  if (depth > 20) throw error('Plugin configuration exceeds its depth limit.');
  if (Array.isArray(value)) return value.map(child => safeConfig(child, depth + 1));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw error('Invalid plugin configuration key.');
    return [key, /api.?key|password|secret|credential|authorization|private.?key|access.?token|refresh.?token|(?:^|[_-])token(?:$|[_-])|token$/i.test(key) ? '[redacted credential]' : safeConfig(child, depth + 1)];
  }));
  return value;
}

/** Trusted plugins execute native code with the user's OS permissions. This
 * manager enforces explicit owner trust and native lifecycle checks, not a VM.
 */
export async function createTrustedPluginManager({ directory, rpc, authorizeAction, configureManagedServices, resolveSource,
  inspectArtifact, effectiveToolCatalogue, mandatoryPluginIds = ['cypher-tempre-poi'], contextEngineId = 'cypher-tempre-poi',
  upstreamIntegrity, packageRoot, mandatoryLoadPaths = [], now = Date.now, previewTtlMs = 600000 } = {}) {
  if (!path.isAbsolute(directory || '') || ![rpc, authorizeAction, configureManagedServices].every(value => typeof value === 'function')) throw error('Private native plugin and owner authorities are required.');
  const protectedIds = new Set([...mandatoryPluginIds, contextEngineId].map(id => pluginId(id).toLowerCase()));
  const file = path.join(directory, 'trusted-native-plugins.json'), views = new Map(), usedPermits = new Set();
  let records = new Map(), queue = Promise.resolve();
  const npmResolver = createNpmPluginSourceResolver({ packageRoot });
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 2 * 1024 * 1024) throw error('The local plugin trust record needs inspection.');
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (saved.version !== 1 || !plain(saved.plugins)) throw error('Invalid local plugin trust record.');
    records = new Map(Object.entries(saved.plugins));
  } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  const serial = action => { const pending = queue.then(action); queue = pending.catch(() => {}); return pending; };
  function mutable(id) { id = pluginId(id); if (protectedIds.has(id.toLowerCase())) throw error('The mandatory PoI plugin and context engine cannot be replaced, disabled or removed.'); return id; }
  async function save(id, value) {
    const next = new Map(records); next.set(id, value);
    const temporary = path.join(directory, `.plugin-trust-${randomBytes(12).toString('hex')}.tmp`);
    await fs.writeFile(temporary, JSON.stringify({ version: 1, plugins: Object.fromEntries(next) }), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file); records = next;
  }
  async function permit(context, action) {
    const actionHash = pluginActionHash(action), result = await authorizeAction(context, structuredClone({ ...action, actionHash }));
    if (result?.allowed !== true || !text(result.permitId, 512) || result.actionHash !== actionHash || usedPermits.has(result.permitId)) throw error('No fresh owner permit authorizes this exact native plugin action.');
    usedPermits.add(result.permitId); return actionHash;
  }
  async function resolved(source, inspection) {
    let value = resolveSource ? await resolveSource(structuredClone(source), inspection) : null;
    value ||= await localIdentity(source);
    value ||= await npmResolver(source);
    if (!value && inspection?.plugin) value = { pluginId: inspection.plugin.id, packageName: inspection.source?.packageName || inspection.plugin.id,
      version: inspection.plugin.version, integrity: inspection.source?.integrity || (inspection.source?.kind === 'bundled' ? upstreamIntegrity : undefined), source, resolved: true };
    if (!value?.resolved || !text(value.pluginId, 256) || !text(value.version, 256) || !text(value.integrity, 4096)) return null;
    mutable(value.pluginId);
    return { pluginId: pluginId(value.pluginId), packageName: value.packageName || value.pluginId, version: value.version,
      integrity: value.integrity, source: normalizePluginSource(value.source || source), ...(value.installHash ? { installHash: value.installHash } : {}),
      ...(value.sourceDigests ? { sourceDigests: structuredClone(value.sourceDigests) } : {}) };
  }
  async function installed(id) {
    const inspection = await rpc('plugins.inspect', { pluginId: id });
    let artifact = inspectArtifact ? await inspectArtifact(id, inspection) : null;
    if (!artifact && inspection.source?.integrity) artifact = { pluginId: id, packageName: inspection.source.packageName || id,
      version: inspection.plugin.version, integrity: inspection.source.integrity };
    if (!artifact && inspection.source?.kind === 'bundled' && upstreamIntegrity) artifact = { pluginId: id, packageName: id, version: inspection.plugin.version, integrity: upstreamIntegrity };
    const record = records.get(id);
    if (!artifact && record?.identity?.source?.source === 'local') artifact = await localIdentity(record.identity.source);
    if (artifact && (!text(artifact.version, 256) || !text(artifact.integrity, 4096) || artifact.pluginId !== id)) artifact = null;
    return { inspection, artifact };
  }
  function digestArtifact(artifact, declared) { return pluginActionHash({ artifact, declared: declared || null }); }
  async function preview(context, input) {
    if (!plain(input) || !['install', 'enable', 'disable', 'uninstall', 'update', 'configure', 'reload'].includes(input.operation)) throw error('A concrete native plugin operation is required.');
    const source = input.source ? normalizePluginSource(input.source) : null;
    let inspection = null, artifact = null, id = input.pluginId ? mutable(input.pluginId) : null;
    if (source) {
      if (source.pluginId) mutable(source.pluginId); if (source.expectedPluginId) mutable(source.expectedPluginId);
      if (source.source === 'clawhub') inspection = await rpc('plugins.inspect', { source: 'clawhub', packageName: source.packageName, ...(source.version ? { version: source.version } : {}) });
      else if (['official', 'bundled'].includes(source.source)) inspection = await rpc('plugins.inspect', { pluginId: source.pluginId });
      artifact = await resolved(source, inspection); if (artifact) id = artifact.pluginId;
    } else if (id) { const current = await installed(id); inspection = current.inspection; artifact = current.artifact; }
    else throw error('A plugin identifier or native source is required.');
    if (id) mutable(id);
    const trustDigest = artifact ? digestArtifact(artifact, inspection?.declared) : null;
    const previewId = randomBytes(24).toString('hex');
    const view = { previewId, operation: input.operation, pluginId: id, source, artifact, inspection, trustDigest, expiresAt: now() + previewTtlMs };
    views.set(previewId, view);
    return { ...structuredClone(view), resolved: !!artifact, requiresNativeResolver: !artifact,
      warning: 'Trusted native plugins run with this user’s OS permissions. This is not a security sandbox.' };
  }
  function take(input, operation) {
    const view = views.get(input?.previewId);
    if (!view || view.operation !== operation || view.expiresAt <= now()) throw error('Preview this exact plugin action again before continuing.');
    if (!view.artifact && !['disable', 'uninstall'].includes(operation)) throw error('A native source resolver must attest the package, version and integrity before this operation.', 'PLUGIN_SOURCE_UNRESOLVED');
    if (view.pluginId) mutable(view.pluginId);
    return view;
  }
  function trust(view, value) {
    if (!value?.acknowledged || value.trustDigest !== view.trustDigest || value.pluginId !== view.artifact?.pluginId ||
        value.version !== view.artifact?.version || value.integrity !== view.artifact?.integrity) throw error('Explicit owner trust must match this exact plugin version and artifact integrity.');
    if (view.inspection?.trust?.disposition === 'blocked') throw error('The native plugin trust policy blocks this package.');
  }
  function acknowledgements(input) {
    const result = {};
    if (input.acknowledgeInstallPolicyWarning === true) result.acknowledgeInstallPolicyWarning = true;
    if (input.acknowledgeCapabilities?.reviewToken) result.acknowledgeCapabilities = { reviewToken: String(input.acknowledgeCapabilities.reviewToken) };
    return result;
  }
  async function fresh(view) {
    const current = view.source ? { artifact: await resolved(view.source, view.inspection), inspection: view.inspection } : await installed(view.pluginId);
    const latest = current.artifact;
    if (!latest || digestArtifact(latest, current.inspection?.declared) !== view.trustDigest) throw error('The plugin artifact changed after owner review.');
    return latest;
  }
  async function verifiedEnabledIds(excludeId) {
    const allowed = [];
    for (const [id, record] of records) if (id !== excludeId && record.enabled && record.trustDigest) {
      try {
        const current = await installed(id);
        if (current.artifact && digestArtifact(current.artifact, current.inspection.declared) === record.trustDigest) allowed.push(id);
      } catch { /* Changed or missing artifacts cannot inherit an allowlist slot. */ }
    }
    return allowed;
  }
  async function stage(context, input, operation = 'install') {
    return serial(async () => {
      const view = take(input, operation); trust(view, input.trust); const artifact = await fresh(view);
      if (!view.source) throw error('Installing or updating requires an explicit native source.');
      await permit(context, { operation: operation === 'update' ? 'update-disabled-plugin' : 'stage-disabled-plugin', artifact, trustDigest: view.trustDigest, acknowledgements: acknowledgements(input) });
      if (operation === 'update') {
        const current = await rpc('plugins.inspect', { pluginId: artifact.pluginId });
        if (current.plugin.enabled) throw error('Disable the current plugin explicitly before staging a resolved update.');
      }
      const request = { ...(artifact.source || view.source), enable: false, mode: operation, ...acknowledgements(input) };
      if (['npm', 'clawhub'].includes(request.source)) { request.expectedPluginId = artifact.pluginId; request.expectedIntegrity = artifact.integrity; }
      const result = await rpc('plugins.install', request); // Native warnings/errors are never auto-acknowledged or retried.
      if (result.plugin?.id !== artifact.pluginId || result.plugin?.enabled === true) throw error('The native install did not preserve disabled staged identity.');
      await save(artifact.pluginId, { identity: artifact, enabled: false, stagedAt: new Date(now()).toISOString(), trustDigest: null });
      views.delete(view.previewId);
      return { result, awaitingActivationTrust: true, preview: await preview(context, { operation: 'enable', pluginId: artifact.pluginId }) };
    });
  }
  async function activation(context, input, operation) {
    return serial(async () => {
      const view = take(input, operation); trust(view, input.trust); const artifact = await fresh(view);
      await permit(context, { operation, artifact, trustDigest: view.trustDigest, acknowledgements: acknowledgements(input) });
      await fresh(view);
      // Native origin-default enabled flags are not owner trust. Recheck every
      // previously trusted artifact before preserving its execution authority.
      const allowed = [...new Set([...protectedIds, ...await verifiedEnabledIds(), artifact.pluginId])];
      // Allowlisting can activate origin-default plugins. Pin this selected
      // entry disabled until the OFFICIAL enable RPC has applied its consent.
      const patch = { plugins: { allow: allowed, entries: { [artifact.pluginId]: { enabled: false } } } };
      let result;
      if (operation === 'reload') result = await rpc('plugins.reload', { plugins: [{ pluginId: artifact.pluginId, ...(artifact.installHash ? { installHash: artifact.installHash } : {}), ...(artifact.sourceDigests ? { sourceDigests: artifact.sourceDigests } : {}) }], waitForDrain: true, ...acknowledgements(input) });
      else {
        await configureManagedServices(context, patch);
        let enabled = false;
        try {
          result = await rpc('plugins.setEnabled', { pluginId: artifact.pluginId, enabled: true, allowlistPolicy: 'preserve', ...(input.acknowledgeCapabilities ? { acknowledgeCapabilities: acknowledgements(input).acknowledgeCapabilities } : {}) });
          enabled = true;
        } finally {
          // Native enabling also selects exclusive slots from plugin kind.
          // Rebuild our managed configuration even when native partially wrote
          // then failed; no foreign context engine may survive the lifecycle.
          await configureManagedServices(context, { plugins: { slots: { contextEngine: contextEngineId },
            entries: { [artifact.pluginId]: { enabled } } } }, { forceReload: true });
        }
      }
      await save(artifact.pluginId, { identity: artifact, enabled: true, trustDigest: view.trustDigest, trustedAt: new Date(now()).toISOString() });
      views.delete(view.previewId); return result;
    });
  }
  async function remove(context, input, operation) {
    return serial(async () => {
      const id = mutable(input.pluginId), inspection = await rpc('plugins.inspect', { pluginId: id });
      await permit(context, { operation, pluginId: id, version: inspection.plugin.version, integrity: inspection.source?.integrity || null });
      // Adopt revocation in the supervisor before touching native lifecycle
      // state; a later generated config must never resurrect removed authority.
      await configureManagedServices(context, { plugins: { allow: [...new Set([...protectedIds, ...await verifiedEnabledIds(id)])], entries: { [id]: { enabled: false } } } });
      const result = operation === 'disable' ? await rpc('plugins.setEnabled', { pluginId: id, enabled: false, allowlistPolicy: 'preserve' }) : await rpc('plugins.uninstall', { pluginId: id, keepFiles: input.keepFiles === true });
      if (records.has(id)) await save(id, { ...records.get(id), enabled: false, ...(operation === 'uninstall' ? { uninstalled: true } : {}) });
      return result;
    });
  }
  async function configure(context, input) {
    return serial(async () => {
      const view = take(input, 'configure'); trust(view, input.trust); await fresh(view);
      if (!plain(input.config) || Buffer.byteLength(JSON.stringify(input.config)) > 512 * 1024) throw error('A bounded plugin configuration object is required.');
      const config = structuredClone(input.config), redacted = safeConfig(config);
      if (stable(config) !== stable(redacted)) throw error('Use native private credential storage for plugin secrets; browser configuration cannot persist raw credential fields.');
      await permit(context, { operation: 'configure', pluginId: view.pluginId, artifact: view.artifact, trustDigest: view.trustDigest, config });
      await fresh(view);
      const result = await configureManagedServices(context, { plugins: { entries: { [view.pluginId]: { config } } } });
      if (records.has(view.pluginId)) await save(view.pluginId, { ...records.get(view.pluginId), config });
      views.delete(view.previewId); return result;
    });
  }
  return { preview, stage, install: (context, input) => stage(context, input, 'install'), update: (context, input) => stage(context, input, 'update'),
    async channelAllowed(id, channelId) {
      id = pluginId(id);
      const record = records.get(id);
      if (!record?.enabled || !record.trustDigest) return false;
      const current = await installed(id);
      return current.inspection.plugin.enabled === true && current.inspection.trust?.disposition !== 'blocked' &&
        Array.isArray(current.inspection.declared?.channels) && current.inspection.declared.channels.includes(channelId) &&
        !!current.artifact && digestArtifact(current.artifact, current.inspection.declared) === record.trustDigest;
    },
    enable: (context, input) => activation(context, input, 'enable'), reload: (context, input) => activation(context, input, 'reload'),
    disable: (context, input) => remove(context, input, 'disable'), uninstall: (context, input) => remove(context, input, 'uninstall'), configure,
    async catalogue() { return rpc('plugins.list', {}); },
    async restoreTrustedConfiguration(context) {
      if (records.size === 0) return { result: null, restored: [], warnings: [] };
      const entries = {}, allow = [...protectedIds], paths = [...mandatoryLoadPaths], warnings = [];
      for (const [id, record] of records) if (record.enabled && record.trustDigest) {
        entries[id] = { enabled: false };
        try {
          const current = await installed(id);
          if (!current.artifact || digestArtifact(current.artifact, current.inspection.declared) !== record.trustDigest) { warnings.push(`Trust changed for ${id}; it remains inactive.`); continue; }
          if (record.config && stable(record.config) !== stable(safeConfig(record.config))) { warnings.push(`Credentials for ${id} require private native storage.`); continue; }
          allow.push(id); entries[id] = { enabled: true, ...(record.config ? { config: structuredClone(record.config) } : {}) };
          if (record.identity.source?.source === 'local' && record.identity.source.link === true) paths.push(record.identity.source.path);
        } catch { warnings.push(`Could not verify ${id}; it remains inactive.`); }
      }
      const patch = { plugins: { allow: [...new Set(allow)], entries, ...(paths.length ? { load: { paths: [...new Set(paths)] } } : {}) } };
      // This is restoration of exact prior explicit owner trust, never a fresh
      // install or an acknowledgement of changed native capabilities.
      const result = await configureManagedServices(context, patch);
      return { result, restored: Object.keys(entries).filter(id => entries[id].enabled), warnings };
    },
    async toolCatalogue(context) {
      if (![...records.values()].some(record => record.enabled && record.trustDigest)) return [];
      if (typeof effectiveToolCatalogue !== 'function') return [];
      const native = await effectiveToolCatalogue(context);
      const all = Array.isArray(native) ? native : (native.groups || []).flatMap(group => group.tools || []);
      const reserved = new Set([...RESERVED, ...all.filter(tool => tool.source !== 'plugin').map(tool => canonicalTool(tool.id || tool.name))]);
      const installedList = await rpc('plugins.list', {}), enabled = new Set(installedList.plugins.filter(plugin => plugin.enabled).map(plugin => plugin.id));
      const accepted = new Map();
      for (const [id, record] of records) if (record.enabled && record.trustDigest && enabled.has(id)) {
        const current = await installed(id); if (!current.artifact) continue;
        if (digestArtifact(current.artifact, current.inspection.declared) === record.trustDigest) accepted.set(id, record);
      }
      return all.filter(tool => tool.source === 'plugin' && accepted.has(tool.pluginId) && !reserved.has(canonicalTool(tool.id || tool.name)) && !/^(?:sessions?|agents?|cron|config|gateway|message|secrets|browser|chainchat_(?:browser|automation))(?:_|$)/.test(canonicalTool(tool.id || tool.name))).map(tool => ({
        name: tool.id || tool.name, pluginId: tool.pluginId, trustDigest: accepted.get(tool.pluginId).trustDigest,
        description: String(tool.description || '').slice(0, 16000), ...(tool.parameters || tool.inputSchema || tool.schema ? { parameters: tool.parameters || tool.inputSchema || tool.schema } : {}),
      }));
    },
  };
}
