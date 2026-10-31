const pretty = value => JSON.stringify(value ?? null, null, 2);
export function schemaFields(schema, query = '') {
  const result = [], filter = query.trim().toLowerCase();
  function walk(node, prefix = '', depth = 0) {
    if (!node || typeof node !== 'object' || depth > 15 || result.length > 500) return;
    for (const [key, child] of Object.entries(node.properties || {})) {
      const name = prefix ? `${prefix}.${key}` : key;
      const description = String(child.description || child.title || '');
      if (!filter || `${name} ${description}`.toLowerCase().includes(filter)) result.push({ name, description: description.slice(0, 1500), type: child.type || (child.properties ? 'object' : '') });
      walk(child, name, depth + 1);
    }
  }
  walk(schema?.schema || schema);
  return result.slice(0, 500);
}
export function initOpenClawSettings({ api, requireConnection, executeCommand, document: doc = globalThis.document, onClose }) {
  const $ = id => doc.getElementById(id), panel = $('openclawPanel');
  let snapshot = null, loading = false;
  function error(message = '') { $('nativeError').textContent = message; }
  function close() {
    panel.classList.add('hidden');
    doc.querySelector('main.workspace')?.classList.remove('hidden');
    doc.querySelector('.beta-access')?.classList.remove('hidden');
    $('chain-auditor')?.classList.remove('hidden');
    onClose?.();
  }
  function section(name) {
    for (const button of doc.querySelectorAll('[data-native-tab]')) button.setAttribute('aria-selected', String(button.dataset.nativeTab === name));
    for (const item of doc.querySelectorAll('[data-native-section]')) item.classList.toggle('hidden', item.dataset.nativeSection !== name);
  }
  function reference() {
    const list = $('nativeSchemaFields'); list.replaceChildren();
    for (const field of schemaFields(snapshot?.schema, $('nativeSchemaSearch').value)) {
      const row = doc.createElement('div'); row.className = 'native-schema-field';
      const title = doc.createElement('strong'); title.textContent = `${field.name}${field.type ? ` · ${field.type}` : ''}`;
      const description = doc.createElement('p'); description.textContent = field.description;
      row.append(title, description); list.append(row);
    }
  }
  function render(next) {
    snapshot = next;
    $('nativeConnection').textContent = `OpenClaw ${next.runtime?.version || ''} · ${next.sessionKey ? 'Selected agent session' : 'Select a Timechain to use session controls'}`;
    $('nativeConfigEditor').value = pretty(next.config?.editable || {});
    $('nativeConfigNotice').textContent = next.config?.notice || 'Changes are validated against the pinned native schema.';
    $('nativeProtectedPaths').textContent = (next.config?.protectedPaths || []).join('\n');
    $('nativeSchemaJson').textContent = pretty(next.schema);
    $('nativeEffectiveConfig').textContent = pretty(next.nativeConfig);
    $('nativeRuntimeState').textContent = pretty({ runtime: next.runtime, sessionKey: next.sessionKey, session: next.session });
    $('nativeGoalState').textContent = next.goal ? pretty(next.goal) : 'No native goal is set for this agent.';
    $('startNativeGoal').disabled = !next.sessionKey;
    const commands = $('nativeCommandCatalogue'); commands.replaceChildren();
    for (const item of next.commands || []) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'native-command';
      const name = doc.createElement('strong'); name.textContent = item.name;
      const description = doc.createElement('span'); description.textContent = `${item.description}${item.mode ? ` · ${item.mode}` : ''}`;
      button.append(name, description); button.addEventListener('click', () => { $('nativeCommandInput').value = item.name; $('nativeCommandInput').focus(); }); commands.append(button);
    }
    const grant = next.toolAuthority?.grant || {};
    $('nativeToolsEnabled').checked = grant.enabled === true;
    $('nativeExecutionAllowed').checked = grant.allowExecution === true;
    $('nativeToolsAcknowledged').checked = grant.acknowledged === true;
    $('nativeToolRoots').value = (grant.roots || []).join('\n');
    $('nativeToolHosts').value = (grant.networkHosts || []).join('\n');
    const tools = $('nativeToolChoices'); tools.replaceChildren();
    for (const entry of next.toolCatalogue || []) {
      const name = typeof entry === 'string' ? entry : entry.name;
      if (!name) continue;
      const label = doc.createElement('label'); label.className = 'native-check';
      const checkbox = doc.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.hostTool = name; checkbox.checked = (grant.tools || []).includes(name);
      checkbox.disabled = entry.available === false;
      const text = doc.createElement('span'); text.textContent = typeof entry === 'string' ? name : `${name}${entry.description ? ` · ${entry.description}` : ''}`;
      label.append(checkbox, text); tools.append(label);
    }
    reference();
  }
  async function refresh() {
    if (loading) return; loading = true; error();
    try { render(await api('/api/openclaw')); } catch (failure) { error(failure.message); }
    finally { loading = false; }
  }
  function open() {
    requireConnection(() => {
      for (const item of doc.querySelectorAll('main.workspace,.beta-access,#chain-auditor,#installNotice')) item.classList.add('hidden');
      panel.classList.remove('hidden'); section('configuration'); void refresh();
    });
  }
  async function run(command) {
    error();
    try {
      const result = await executeCommand(command);
      $('nativeCommandResult').textContent = result?.text || (result?.kind === 'turn' ? 'The native goal turn is opening in ChainChat.' : 'Native command completed.');
      if (!panel.classList.contains('hidden')) await refresh();
    } catch (failure) { error(failure.message); }
  }
  $('openclawSettingsButton').addEventListener('click', open);
  $('closeOpenclawPanel').addEventListener('click', close);
  for (const button of doc.querySelectorAll('[data-native-tab]')) button.addEventListener('click', () => section(button.dataset.nativeTab));
  $('refreshNativeControls').addEventListener('click', refresh);
  $('nativeSchemaSearch').addEventListener('input', reference);
  $('saveNativeConfig').addEventListener('click', async () => {
    error();
    try { const patch = JSON.parse($('nativeConfigEditor').value); await api('/api/openclaw/config', { patch, revision: snapshot?.config?.revision }); await refresh(); }
    catch (failure) { error(failure.message); }
  });
  $('nativeCommandForm').addEventListener('submit', event => { event.preventDefault(); void run($('nativeCommandInput').value.trim()); });
  $('startNativeGoal').addEventListener('click', () => { const objective = $('nativeGoalObjective').value.trim(); if (objective) void run(`/goal start ${objective}`); else error('Write a goal objective first.'); });
  for (const button of doc.querySelectorAll('[data-goal-command]')) button.addEventListener('click', () => run(button.dataset.goalCommand));
  const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  $('nativeToolsForm').addEventListener('submit', async event => {
    event.preventDefault(); error();
    const grant = { enabled: $('nativeToolsEnabled').checked, tools: [...doc.querySelectorAll('[data-host-tool]:checked')].map(node => node.dataset.hostTool),
      roots: lines($('nativeToolRoots').value), networkHosts: lines($('nativeToolHosts').value),
      allowExecution: $('nativeExecutionAllowed').checked, acknowledged: $('nativeToolsAcknowledged').checked };
    try { await api('/api/openclaw/tools', grant); await refresh(); } catch (failure) { error(failure.message); }
  });
  $('disableNativeTools').addEventListener('click', async () => {
    try { await api('/api/openclaw/tools', { enabled: false, tools: [], roots: [], networkHosts: [], allowExecution: false, acknowledged: false }); await refresh(); }
    catch (failure) { error(failure.message); }
  });
  return { open, close, refresh, isOpen: () => !panel.classList.contains('hidden') };
}
