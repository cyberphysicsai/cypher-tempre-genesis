/** Native OpenClaw operator controls, separated from browser credentials. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail = (message, code = 'OPENCLAW_CONTROL_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export const CONTROL_GUARDS = Object.freeze({
  gateway: 'Loopback binding, private operator authentication and HTTP admission remain supervisor-owned.',
  models: 'Private provider routes and credential placeholders are managed by the in-memory BYOK transport.',
  plugins: 'The pinned enforcement plugin and its private broker route must remain enabled.',
  env: 'Child-process environment and private transport credentials are supervisor-owned.',
  auth: 'Provider authentication is supplied in memory through the BYOK connection.',
  secrets: 'Raw credentials cannot be written through browser configuration.',
  update: 'Updates use the reviewed downstream installer and upstream security pins.',
  discovery: 'The managed Gateway remains private to the local machine.',
  tools: 'Host tools require an explicit scoped grant and PoI action admission.',
  browser: 'Browser configuration requires an explicit host-tool grant; isolation and network admission remain managed.',
  'browser.ssrfPolicy': 'Requested-navigation network policy is derived from the current explicit host grant.',
  'browser.profiles.openclaw': 'The model uses an isolated managed browser profile, never an imported signed-in profile.',
  'browser.evaluateEnabled': 'The navigation grant does not authorize arbitrary browser JavaScript.',
  'browser.executablePath': 'Custom executables require a reviewed execution adapter.',
  'browser.extraArgs': 'Managed browser process isolation cannot be overridden.',
  'browser.cdpUrl': 'The managed browser cannot attach to an unrelated signed-in browser.',
  'browser.attachOnly': 'The model uses only its owned isolated browser.',
  'browser.defaultProfile': 'The model uses only its owned isolated browser.',
  'browser.noSandbox': 'Native Chromium sandbox protection remains enabled.',
  'tools.web.fetch.maxRedirects': 'Fetch redirects remain disabled to preserve the exact requested-host grant.',
  'tools.web.fetch.ssrfPolicy': 'Upstream DNS and private-network protections remain enabled.',
  'tools.toolSearch': 'The managed direct tool surface preserves exact per-action PoI enforcement without a generic dispatcher grant.',
  channels: 'External channels require a managed admission adapter and explicit authorization.',
  cron: 'Scheduled actions require a managed admission adapter and explicit authorization.',
  hooks: 'External hooks require a managed admission adapter and explicit authorization.',
  bindings: 'Additional agent bindings require managed admission and explicit authorization.',
  'agents.list': 'Additional agents require their own verified Timechain and enforcement binding.',
  'agents.defaults.workspace': 'The managed workspace belongs to this installed runtime.',
  'agents.defaults.agentDir': 'Private agent state belongs to this installed runtime.',
  'agents.defaults.model': 'Choose the connected provider and model through the BYOK selector.',
  'agents.defaults.heartbeat': 'Unattended model runs require a managed admission adapter.',
});
const protectedRoots = Object.keys(CONTROL_GUARDS);
const credentialKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passphrase|secret|client[_-]?secret|credential|credentials|authorization|auth[_-]?token|broker[_-]?token)$/i;
const COMMAND_ALIASES = Object.freeze({ thinking: 'think', t: 'think', reason: 'reasoning', v: 'verbose' });
const editableRoots = new Set(['messages', 'session', 'ui', 'audio', 'talk', 'logging', 'agents', 'browser', 'canvas', 'media', 'memory', 'skills']);
const grantedConfigurationRoots = new Set(['tools', 'browser']);
export const NATIVE_PREFERENCES = Object.freeze(['thinkingLevel', 'fastMode', 'verboseLevel', 'traceLevel', 'reasoningLevel', 'responseUsage', 'contextWindow']);
const safeSessionFields = new Set(['key', 'sessionKey', 'sessionId', 'updatedAt', 'label', 'goal', 'totalTokens', 'inputTokens', 'outputTokens', 'contextTokens', 'model', 'modelProvider', 'compactionCount', ...NATIVE_PREFERENCES]);
function safeSession(entry) { return entry ? Object.fromEntries(Object.entries(entry).filter(([key]) => safeSessionFields.has(key))) : null; }
export const CONTROL_COMMANDS = Object.freeze([
  ['help', 'Show the native-control command catalogue.', 'system'],
  ['commands', 'Show command availability and guarded settings.', 'system'],
  ['status', 'Read native Gateway and selected session status.', 'system'],
  ['goal', 'Native durable session objective: start/status/edit/pause/resume/complete/block/clear.', 'native'],
  ['think', 'Set native per-session reasoning effort.', 'preference'],
  ['reasoning', 'Set native per-session reasoning display preference.', 'preference'],
  ['verbose', 'Set native per-session verbosity preference.', 'preference'],
  ['trace', 'Set native per-session trace preference.', 'preference'],
  ['fast', 'Set native per-session fast mode.', 'preference'],
  ['usage', 'Set native response usage display, or read selected session usage.', 'preference'],
  ['name', 'Set the native session display name.', 'preference'],
  ['models', 'List configured native model routes; use BYOK to select the actual model.', 'system'],
  ['tools', 'Inspect native effective tool policy and current managed action authority.', 'system'],
  ['queue', 'Read or set the selected native session queue policy.', 'native'],
  ['context', 'Read the actual native context assembly report: list/detail/map/json.', 'native'],
  ['compact', 'Model compaction requires a managed summary admission adapter.', 'guarded'],
  ['new', 'Reset native conversation context; the Timechain is preserved.', 'native'],
  ['reset', 'Reset native conversation context; the Timechain is preserved.', 'native'],
  ['stop', 'Cancel the current ChainChat operation.', 'host'],
  ['model', 'Open the ChainChat BYOK model selector.', 'host'],
  ['config', 'Open reviewed OpenClaw settings.', 'host'],
  ['bash', 'External shell commands require a scoped host-tool grant.', 'guarded'],
  ['exec', 'External execution remains unavailable without a scoped local grant.', 'guarded'],
  ['elevated', 'This distribution does not silently elevate host permissions.', 'guarded'],
  ['plugins', 'Plugin installation requires a separate reviewed runtime release.', 'guarded'],
  ['restart', 'Use the installed launcher to restart the owned runtime.', 'guarded'],
  ['update', 'Use a reviewed ChainChat update to preserve its enforcement contract.', 'guarded'],
].map(([name, description, mode]) => Object.freeze({ name: '/' + name, description, mode })));

export function controlSessionKey({ agentId, genesisHash }) {
  if (typeof agentId !== 'string' || !agentId || agentId.length > 512 || !/^[a-f0-9]{64}$/i.test(genesisHash || ''))
    throw fail('A verified paired agent identity is required.');
  return 'agent:main:chainchat-control:' + createHash('sha256').update(agentId + '\0' + genesisHash.toLowerCase()).digest('hex');
}
export function redactNativeControl(value, secrets = []) {
  const walk = (item, depth = 0) => {
    if (depth > 40) return '[bounded]';
    if (typeof item === 'string') return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('[private]'), item).slice(0, 200000);
    if (Array.isArray(item)) return item.slice(0, 20000).map(child => walk(child, depth + 1));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) =>
      [key, credentialKey.test(key) && typeof child === 'string' ? '[managed private value]' : walk(child, depth + 1)]));
    return item;
  };
  return walk(value);
}
export function validateControlPatch(patch, { allowHostConfiguration = false } = {}) {
  if (!plain(patch) || !Object.keys(patch).length || Buffer.byteLength(JSON.stringify(patch)) > 256 * 1024) throw fail('A bounded settings patch is required.');
  const visit = (value, trail = []) => {
    if (trail.length > 20) throw fail('Settings nesting is too deep.');
    const prefix = trail.join('.');
    if (!plain(value) && protectedRoots.some(field => !(allowHostConfiguration && grantedConfigurationRoots.has(field)) && field.startsWith(prefix + '.')))
      throw fail('A managed settings parent cannot be replaced or removed.', 'OPENCLAW_SETTING_GUARDED', 403);
    if (Array.isArray(value)) { if (value.length > 1000) throw fail('A settings array exceeds its limit.'); value.forEach(child => visit(child, trail)); return; }
    if (plain(value)) for (const [key, child] of Object.entries(value)) {
      const field = [...trail, key].join('.');
      const guarded = protectedRoots.find(prefix => !(allowHostConfiguration && grantedConfigurationRoots.has(prefix)) && (field === prefix || field.startsWith(prefix + '.')));
      if (['__proto__', 'prototype', 'constructor'].includes(key) || credentialKey.test(key) || guarded)
        throw fail(guarded ? CONTROL_GUARDS[guarded] : 'Credentials and prototype fields cannot be written through settings.', 'OPENCLAW_SETTING_GUARDED', 403);
      visit(child, [...trail, key]);
    }
    else if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) throw fail('Settings must contain ordinary JSON values.');
    else if (typeof value === 'number' && !Number.isFinite(value)) throw fail('Settings numbers must be finite.');
  };
  for (const [key, value] of Object.entries(patch)) {
    if ((!editableRoots.has(key) && !(allowHostConfiguration && grantedConfigurationRoots.has(key))) || key === 'browser' && !allowHostConfiguration)
      throw fail(CONTROL_GUARDS[key] || 'This native configuration root requires managed admission.', 'OPENCLAW_SETTING_GUARDED', 403);
    visit(value, [key]);
  }
  return structuredClone(patch);
}
function merge(base, patch) {
  const result = structuredClone(base || {});
  for (const [key, value] of Object.entries(patch)) result[key] = plain(value) && plain(result[key]) ? merge(result[key], value) : structuredClone(value);
  return result;
}
export function createNativeControls({ rpc, getRuntime, readOverlay, saveOverlay, applyOverlay, runSystemCommand, sanitize = redactNativeControl }) {
  async function session(identity) {
    const key = controlSessionKey(identity);
    const result = await rpc('sessions.describe', { key, includeDerivedTitles: false, includeLastMessage: false });
    return { key, entry: safeSession(result.session || null) };
  }
  async function sessionControls(identity) {
    if (!identity) return { sessionKey: null, session: null, goal: null };
    const target = await session(identity);
    return { sessionKey: target.key, session: target.entry, goal: target.entry?.goal || null };
  }
  async function describeControls(identity) {
    const [schema, nativeConfig, selected, overlay] = await Promise.all([
      rpc('config.schema', {}), rpc('config.get', {}), identity ? session(identity) : null, readOverlay(),
    ]);
    const safeConfig = sanitize(nativeConfig);
    let nativeCommands = [];
    const inventory = await rpc('commands.list', { ...(selected?.entry ? { sessionKey: selected.key } : {}), scope: 'text', includeArgs: true });
    nativeCommands = sanitize(inventory.commands || inventory);
    const catalogue = [...CONTROL_COMMANDS];
    const names = new Set(catalogue.map(item => item.name));
    for (const item of Array.isArray(nativeCommands) ? nativeCommands : []) {
      for (const alias of [item.name, ...(item.textAliases || [])]) {
        if (typeof alias !== 'string' || !/^\/?[a-z][a-z0-9_-]*$/i.test(alias)) continue;
        const name = '/' + alias.replace(/^\//, '');
        if (names.has(name)) continue;
        const aliasOf = COMMAND_ALIASES[name.slice(1)];
        const supported = aliasOf ? CONTROL_COMMANDS.find(entry => entry.name === '/' + aliasOf) : null;
        names.add(name); catalogue.push({ name, mode: supported?.mode || 'guarded',
          description: supported ? `Alias of /${aliasOf}. ${supported.description}` : `${item.description || 'Native OpenClaw command.'} This command requires a managed adapter before it can run in ChainChat.` });
      }
    }
    return { runtime: getRuntime(), sessionKey: selected?.key || null, session: selected?.entry || null,
      goal: selected?.entry?.goal || null, schema, nativeConfig: safeConfig,
      config: { revision: overlay.revision, editable: overlay.patch, protectedPaths: protectedRoots, guards: CONTROL_GUARDS,
        notice: 'Execution authority, provider credentials, required PoI enforcement, loopback binding and updater pins remain managed. Supported presentation/session/agent defaults can be edited here. Integrations that can initiate unattended actions require managed admission.' }, commands: catalogue, nativeCommands };
  }
  async function updateControls({ patch, revision, authority }) {
    const current = await readOverlay();
    if (revision !== current.revision) throw fail('Settings changed. Refresh before saving.', 'OPENCLAW_CONFIG_STALE', 409);
    const next = merge(current.patch, validateControlPatch(patch, { allowHostConfiguration: authority?.enabled === true && authority?.acknowledged === true }));
    await applyOverlay(next);
    let saved;
    try { saved = await saveOverlay(next, current.revision); }
    catch (error) { await applyOverlay(current.patch).catch(() => {}); throw error; }
    return { config: { revision: saved.revision, editable: saved.patch, protectedPaths: protectedRoots, guards: CONTROL_GUARDS } };
  }
  async function executeCommand({ command, ...identity }) {
    if (typeof command !== 'string' || command.length > 20000 || !command.trim().startsWith('/')) throw fail('A native slash command is required.');
    const match = command.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/i);
    if (!match) throw fail('Invalid native command.');
    const name = COMMAND_ALIASES[match[1].toLowerCase()] || match[1].toLowerCase(), text = (match[2] || '').trim();
    if (['help', 'commands'].includes(name)) return { kind: 'system', text: CONTROL_COMMANDS.map(item => `${item.name} — ${item.description}${item.mode === 'guarded' ? ' [guarded]' : ''}`).join('\n'), commands: CONTROL_COMMANDS };
    if (['stop', 'model', 'config'].includes(name)) return { kind: 'host', action: name };
    const known = CONTROL_COMMANDS.find(item => item.name === '/' + name);
    if (!known || known.mode === 'guarded') throw fail(known?.description || 'This native command is not exposed by the managed chat.', 'OPENCLAW_COMMAND_GUARDED', 403);
    const target = await session(identity);
    if (name === 'models') return { kind: 'system', text: JSON.stringify(await rpc('models.list', { sessionKey: target.key, preparedOnly: true, includeDetails: true, includeProviderCapabilities: true }), null, 2) };
    if (name === 'tools') return { kind: 'system', text: JSON.stringify({ native: await rpc('tools.effective', { sessionKey: target.key }), managedAuthority: getRuntime().hostTools }, null, 2) };
    if (name === 'status') return { kind: 'system', text: JSON.stringify({ runtime: getRuntime(), session: target.entry }, null, 2), session: target.entry };
    if (name === 'queue' || name === 'context' || name === 'usage' && ['cost', 'reset'].includes(text)) {
      if (!runSystemCommand) throw fail('The native deterministic command adapter is unavailable.', 'OPENCLAW_COMMAND_GUARDED', 403);
      if (name === 'queue' && !/^(?:(?:steer|followup|collect|steer-backlog|queue|interrupt|default|reset|status)(?:\s+(?:debounce:\d+(?:\.\d+)?(?:ms|s)?|cap:\d+|drop:(?:old|new|summarize)))*|)$/i.test(text)) throw fail('Invalid native queue settings.');
      if (name === 'context' && !['', 'list', 'detail', 'map', 'json'].includes(text)) throw fail('Choose list, detail, map, or json.');
      const result = await runSystemCommand({ sessionKey: target.key, command: '/' + name + (text ? ' ' + text : '') });
      return { kind: 'system', text: sanitize(result.text), state: { native: true, command: name } };
    }
    if (name === 'goal') {
      const parsed = text.match(/^(status|start|set|create|edit|pause|resume|complete|done|block|blocked|clear)(?:\s+([\s\S]*))?$/i);
      const action = !text ? 'status' : parsed ? parsed[1].toLowerCase() : 'start';
      const rest = parsed ? (parsed[2] || '').trim() : text;
      const goal = target.entry?.goal || null;
      if (action === 'status') return { kind: 'system', text: goal ? JSON.stringify(goal, null, 2) : 'No native session goal is set.', goal };
      if (['start', 'set', 'create'].includes(action)) {
        if (!rest || rest.length > 16000) throw fail('A goal objective of 1–16,000 characters is required.');
        if (goal) throw fail('Clear the current native goal before starting another.');
        return { kind: 'turn', message: rest, native: { sessionKey: target.key,
          intent: { kind: 'session-goal-start', version: 1, issuedAtMs: Date.now() } } };
      }
      if (!goal?.id) throw fail('No native session goal exists.');
      const args = { sessionKey: target.key, goalId: goal.id, operationId: randomUUID(), issuedAtMs: Date.now(),
        ...(target.entry?.sessionId ? { sessionId: target.entry.sessionId } : {}) };
      const normalized = ({ done: 'complete', blocked: 'block' })[action] || action;
      if (normalized === 'resume') return { kind: 'turn', message: rest ? `Continue pursuing the current goal.\nOperator note: ${rest}` : 'Continue pursuing the current goal.',
        native: { sessionKey: target.key, goalOperation: { ...args, action: 'resume', ...(rest ? { note: rest } : {}) } } };
      const result = normalized === 'clear' ? await rpc('sessions.goal.clear', args) : await rpc('sessions.goal.update', {
        ...args, action: normalized, ...(normalized === 'edit' ? { objective: rest } : rest ? { note: rest } : {}) });
      return { kind: 'system', text: JSON.stringify(result.goal || { status: result.status }, null, 2), goal: result.goal || null, receipt: result };
    }
    const expected = target.entry?.sessionId ? { expectedSessionId: target.entry.sessionId } : {};
    if (name === 'new' || name === 'reset') {
      const result = await rpc('sessions.reset', { key: target.key, reason: name, ...expected });
      return { kind: 'system', text: 'Native session context reset. The paired Timechain is unchanged.', state: result };
    }
    if (name === 'name') {
      if (!text) return { kind: 'system', text: target.entry?.label || 'No explicit native session name is set.' };
      const result = await rpc('sessions.patch', { key: target.key, ...expected, label: text });
      return { kind: 'system', text: 'Native session name updated.', state: redactNativeControl(result) };
    }
    const prefs = { think: ['thinkingLevel', ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'adaptive', 'ultra']],
      reasoning: ['reasoningLevel', ['off', 'on', 'stream']], verbose: ['verboseLevel', ['off', 'on', 'full']],
      trace: ['traceLevel', ['off', 'on']], fast: ['fastMode', ['on', 'off', 'auto', 'ultrafast']], usage: ['responseUsage', ['off', 'tokens', 'full', 'on']] };
    if (prefs[name]) {
      if (!text || text === 'status') return { kind: 'system', text: JSON.stringify({ sessionKey: target.key, [prefs[name][0]]: target.entry?.[prefs[name][0]] ?? 'default' }) };
      const value = text.toLowerCase();
      const inherited = ['default', 'inherit', 'reset'].includes(value);
      if (!inherited && !prefs[name][1].includes(value)) throw fail(`Choose ${prefs[name][1].join(', ')}, or default.`);
      const setting = inherited ? null : name === 'fast' && ['on', 'off'].includes(value) ? value === 'on' : value;
      const result = await rpc('sessions.patch', { key: target.key, ...expected, [prefs[name][0]]: setting });
      return { kind: 'system', text: JSON.stringify({ [prefs[name][0]]: setting ?? 'default' }), state: redactNativeControl(result) };
    }
    throw fail('The native command is unavailable.');
  }
  return { describeControls, updateControls, executeCommand, session, sessionControls };
}

export async function readControlOverlay(directory) {
  try {
    const file = path.join(directory, 'controls.json'), info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 300000) throw fail('The local settings file requires inspection.');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.revision || '')) throw fail('The local settings file is invalid.');
    const patch = Object.keys(value.patch || {}).length ? validateControlPatch(value.patch, { allowHostConfiguration: true }) : {};
    return { revision: value.revision, patch };
  } catch (error) {
    if (error.code === 'ENOENT') return { revision: createHash('sha256').update('{}').digest('hex'), patch: {} };
    throw error;
  }
}
export function mergeControlOverlay(base, overlay) { return merge(base, overlay); }
