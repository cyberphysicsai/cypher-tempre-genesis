import { mountNativeConfigForm, nativeConfigValue } from './native-config-form.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const pointer = path => `/${path.map(value => value.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
const decodePointer = target => target.startsWith('/') ? target.slice(1).split('/').map(value => value.replace(/~1/g, '/').replace(/~0/g, '~')) : [];

export function nativeChannelCredentialTarget(field, { channelId, accountId }) {
  const path = Array.isArray(field.path) ? [...field.path] : decodePointer(text(field.target));
  for (let index = 0; index < path.length; index++) if (path[index] === '*') {
    if (path[index - 1] === 'channels') path[index] = channelId;
    else if (path[index - 1] === 'accounts') path[index] = accountId;
  }
  if (!path.length || path.some(value => typeof value !== 'string' || !value || value === '*' || reserved.has(value))) throw new Error('This credential needs a concrete native account target.');
  if (path[0] !== 'channels' || path[1] !== channelId) throw new Error('The credential does not belong to the selected channel.');
  return pointer(path);
}

export async function nativeChannelCredentialName(target) {
  if (!globalThis.crypto?.subtle) throw new Error('A secure local context is required to save credentials.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(target));
  return `channel_${Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('').slice(0, 56)}`;
}

function localHints(hints, path) {
  const result = {}, prefix = path.join('.');
  for (const [key, hint] of Object.entries(hints || {})) {
    if (key.startsWith(`${prefix}.`)) result[key.slice(prefix.length + 1)] = hint;
    else if (key.split('.').length > path.length && path.every((segment, index) => key.split('.')[index] === segment || key.split('.')[index] === '*')) result[key.split('.').slice(path.length).join('.')] = hint;
    else if (!key.startsWith('channels.')) result[key] = hint;
  }
  return result;
}

/** A pure owner-facing renderer: all native effects go through explicit injected
 * facade callbacks. It never connects to the Gateway or handles its RPC token. */
export function mountNativeChannelSetup({ document: doc, mount, onSave = async () => {}, onAction = async () => {}, onRefresh = async () => {}, onSaved = async () => {}, onInstall, onError = () => {}, context = () => '', ...initial }) {
  if (!doc?.createElement || !mount?.append) throw new Error('A native channel setup mount is required.');
  const make = (tag, label = '', className = '') => { const node = doc.createElement(tag); node.textContent = label; if (className) node.className = className; return node; };
  const card = make('section', '', 'native-channel-setup'), toolbar = make('div', '', 'native-channel-toolbar');
  const channelLabel = make('label', 'Native integration'), channel = make('select'); channel.setAttribute('aria-label', 'Native integration'); channelLabel.append(channel);
  const accountLabel = make('label', 'Account'), account = make('select'); account.setAttribute('aria-label', 'Native channel account'); accountLabel.append(account);
  const newAccountLabel = make('label', 'New account ID'), newAccount = make('input'); newAccount.type = 'text'; newAccount.autocomplete = 'off'; newAccount.setAttribute('aria-label', 'New native account ID'); newAccountLabel.append(newAccount);
  const refresh = make('button', 'Refresh native integrations', 'secondary-button'); refresh.type = 'button';
  refresh.title = 'Reload native integrations and discard unsaved channel settings and credential entries.';
  toolbar.append(channelLabel, accountLabel, newAccountLabel, refresh);
  const status = make('div', '', 'native-channel-status'), setup = make('div'), secrets = make('div', '', 'native-channel-secrets');
  const save = make('button', 'Save native channel configuration', 'secondary-button'); save.type = 'button';
  const actions = make('div', '', 'native-channel-actions'), pairing = make('div', '', 'native-channel-pairing'), login = make('div');
  const message = make('p', '', 'fine-print'); message.setAttribute('role', 'status');
  card.append(make('h3', 'Native channels & integrations'), toolbar, status, setup, secrets, save, actions, pairing, login, message); mount.append(card);
  let state = { items: [] }, destroyed = false, busy = false, generation = 0, form, passwords = [], actionButtons = [], installButton, challenge, accountBaseHash, staleSnapshot = false, reloadNext = false;
  const selected = () => (state.items || []).find(item => item.id === channel.value);
  const accountId = () => account.value === '__new__' ? newAccount.value.trim() : account.value;
  function validAccount() {
    const value = accountId();
    if (!value || value.length > 128 || /[\x00-\x1f\x7f]/.test(value) || reserved.has(value)) throw new Error('Enter a valid native account ID.');
    return value;
  }
  function clearPasswords(rows = passwords) { for (const row of rows) { row.input.value = ''; if (row.multilineInput) row.multilineInput.value = ''; } }
  function disable() {
    const disabled = busy || !!state.disabled || !selected();
    channel.disabled = account.disabled = newAccount.disabled = refresh.disabled = busy || !!state.disabled;
    save.disabled = disabled || staleSnapshot || selected()?.installed === false;
    if (installButton) installButton.disabled = disabled;
    for (const button of actionButtons) button.disabled = disabled;
    for (const row of passwords) { row.input.disabled = disabled; row.remember.disabled = disabled; row.multiline.disabled = disabled; row.multilineInput.disabled = disabled; }
    form?.update({ disabled });
  }
  async function run(operation) {
    if (busy || state.disabled || destroyed) return;
    const mine = generation, owner = context(), enteredPasswords = passwords;
    const isCurrent = () => !destroyed && generation === mine && context() === owner;
    busy = true; disable(); message.textContent = 'Waiting for the local OpenClaw runtime…';
    try {
      const result = await operation(isCurrent);
      if (!isCurrent()) return;
      return result;
    } catch (error) { if (!destroyed && generation === mine && context() === owner) { message.textContent = text(error?.message) || 'The native channel request did not complete.'; onError(message.textContent); } }
    finally { clearPasswords(enteredPasswords); if (isCurrent()) { busy = false; disable(); } }
  }
  function actionButton(label, action, extra = {}, handler) {
    const button = make('button', label, 'quiet-button'); button.type = 'button'; actionButtons.push(button);
    button.addEventListener('click', () => run(async isCurrent => {
      const item = selected(), result = await onAction({ action, channelId: item.id, accountId: validAccount(), ...extra });
      if (!isCurrent()) return;
      if (handler) handler(result); else message.textContent = text(result?.message) || 'Native request completed. Refresh to inspect the current account status.';
      return result;
    })); return button;
  }
  function pairingResult(result) {
    pairing.replaceChildren();
    const requests = Array.isArray(result?.requests) ? result.requests : [];
    for (const request of requests) {
      if (!text(request.requestId) || request.channel && request.channel !== selected()?.id || request.accountId && request.accountId !== accountId()) continue;
      const row = make('article'); row.append(make('p', `Pairing request ${text(request.requestId, 180)}`), make('p', text(request.senderId, 300)));
      row.append(actionButton('Approve pairing', 'pairing-approve', { requestId: request.requestId, notify: false }, () => { row.replaceChildren(make('p', 'Pairing approved by the local owner.')); }),
        actionButton('Dismiss pairing', 'pairing-dismiss', { requestId: request.requestId }, () => { row.replaceChildren(make('p', 'Pairing request dismissed.')); })); pairing.append(row);
    }
    message.textContent = requests.length ? 'Review the sender before approving. Notifications are disabled unless configured separately.' : 'No pending pairing requests for this account.';
  }
  function loginResult(result) {
    login.replaceChildren(); challenge = undefined;
    if (text(result?.message)) login.append(make('p', text(result.message)));
    const data = result?.qrDataUrl;
    if (typeof data === 'string' && data.length < 524288 && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) {
      const image = make('img', '', 'native-channel-login-qr'); image.src = data; image.alt = 'Native integration login QR code'; login.append(image);
    }
    if (text(result?.challengeId) && !result.connected) {
      challenge = result.challengeId;
      login.append(actionButton('Check login completion', 'web-login-wait', { challengeId: challenge, timeoutMs: 1000 }, loginResult));
    }
    message.textContent = result?.connected ? 'The native runtime reports that this account is connected.' : text(result?.message) || 'Complete the native login, then check its status.';
  }
  function drawStatus(item, chosen) {
    status.replaceChildren(); installButton = undefined;
    if (!item) { status.append(make('p', 'Connect the local runtime to discover its installed and available integrations.')); return; }
    status.append(make('strong', text(item.label) || item.id));
    if (item.description) status.append(make('p', text(item.description)));
    status.append(make('p', `Plugin: ${item.installed === false ? 'not installed' : 'installed'} · Enabled: ${item.enabled ? 'yes' : 'no'} · Configured: ${chosen?.configured || item.configured ? 'yes' : 'no'} · Running: ${chosen?.running ? 'yes' : 'no'} · Connected: ${chosen?.connected ? 'yes' : 'no'}`));
    if (item.installed === false) {
      status.append(make('p', 'Install and explicitly trust this integration in the native plugin controls, then refresh its configuration schema.'));
      if (typeof onInstall === 'function') {
        installButton = make('button', 'Review integration plugin', 'secondary-button'); installButton.type = 'button';
        installButton.addEventListener('click', () => run(async isCurrent => {
          // Only discovery metadata crosses into the native plugin review form.
          // Configuration, credential fields and account values stay here.
          const details = { id: text(item.id, 128), label: text(item.label, 256), ...(text(item.pluginId, 256) ? { pluginId: text(item.pluginId, 256) } : {}),
            ...(object(item.install) ? { install: nativeConfigValue(item.install) } : {}), ...(object(item.installSource) ? { installSource: nativeConfigValue(item.installSource) } : {}),
            ...(['official', 'external'].includes(item.sourceType) ? { sourceType: item.sourceType } : {}), ...(typeof item.requiresExplicitTrust === 'boolean' ? { requiresExplicitTrust: item.requiresExplicitTrust } : {}) };
          await onInstall(details);
          if (isCurrent()) message.textContent = 'Review the native plugin source and exact artifact before explicitly trusting or installing it.';
        })); status.append(installButton);
      }
    }
    if (chosen?.lastError) status.append(make('p', text(chosen.lastError)));
  }
  function drawAccount() {
    generation++; busy = false; challenge = undefined; staleSnapshot = false; reloadNext = false; accountBaseHash = state.baseHash; clearPasswords(); passwords = []; actionButtons = []; form?.destroy(); setup.replaceChildren(); secrets.replaceChildren(); actions.replaceChildren(); status.replaceChildren(); pairing.replaceChildren(); login.replaceChildren(); message.textContent = '';
    const item = selected(); newAccountLabel.hidden = account.value !== '__new__';
    if (!item) { status.append(make('p', 'Connect the local runtime to discover its installed and available integrations.')); disable(); return; }
    const chosen = (item.accounts || []).find(row => row.accountId === accountId()), defaultId = item.defaultAccountId || 'default', custom = account.value === '__new__' || accountId() !== defaultId || chosen?.configPath?.includes?.('accounts');
    const schema = chosen?.schema || (custom ? item.accountSchema || item.schema : item.schema), path = chosen?.configPath || (custom ? ['channels', item.id, 'accounts', accountId()] : ['channels', item.id]);
    drawStatus(item, chosen);
    if (schema) form = mountNativeConfigForm({ document: doc, mount: setup, schema, uiHints: localHints(chosen?.uiHints || item.uiHints, path), effective: chosen?.values || item.values || {}, editable: {}, baseHash: state.baseHash,
      contextKey: `${state.contextKey || ''}:${item.id}:${accountId()}`, onError, disabled: !!state.disabled });
    else setup.append(make('p', 'The native runtime has not supplied a configuration schema for this integration yet.'));
    const credentialFields = new Map();
    for (const field of item.credentialFields || []) {
      try {
        const target = nativeChannelCredentialTarget(field, { channelId: item.id, accountId: accountId() || defaultId });
        const previous = credentialFields.get(target), exact = !field.path?.includes?.('*') && !field.target?.includes?.('/*/');
        if (!previous || exact) credentialFields.set(target, field);
      } catch { /* A wildcard template needs a concrete account before it can be used. */ }
    }
    for (const field of credentialFields.values()) {
      let target; try { target = nativeChannelCredentialTarget(field, { channelId: item.id, accountId: accountId() || defaultId }); } catch { continue; }
      const exactPath = decodePointer(target), accountIndex = exactPath.indexOf('accounts');
      if (custom && item.supportsAccounts && accountIndex < 0) continue;
      if (!custom && accountIndex >= 0) continue;
      if (accountIndex >= 0 && exactPath[accountIndex + 1] !== accountId() && account.value !== '__new__') continue;
      const label = make('label', `${text(field.label) || exactPath.at(-1)}${field.required ? ' · required' : ''}${field.configured ? ' · configured' : ''}`), input = make('input');
      input.type = 'password'; input.autocomplete = 'new-password'; input.spellcheck = false; input.setAttribute('aria-label', `Credential ${text(field.label) || exactPath.at(-1)}`); input.placeholder = field.configured ? 'Leave empty to keep the existing credential' : 'Stored only through the local credential controls';
      input.maxLength = 16384;
      const multilineLabel = make('label', '', 'native-check'), multiline = make('input'); multiline.type = 'checkbox'; multiline.setAttribute('aria-label', `Use multiline credential ${text(field.label) || exactPath.at(-1)}`);
      multilineLabel.append(multiline, make('span', 'Use multiline credential · visible on this machine'));
      const multilineInput = make('textarea'); multilineInput.rows = 5; multilineInput.hidden = true; multilineInput.maxLength = 16384; multilineInput.autocomplete = 'off'; multilineInput.spellcheck = false;
      multilineInput.setAttribute('aria-label', `Multiline credential ${text(field.label) || exactPath.at(-1)}`);
      multilineInput.placeholder = 'Paste the complete PEM, JSON or multiline credential here. This field is visible locally.';
      multiline.addEventListener('change', () => { input.value = ''; multilineInput.value = ''; input.hidden = multiline.checked === true; multilineInput.hidden = multiline.checked !== true; });
      const rememberLabel = make('label', '', 'native-check'), remember = make('input'); remember.type = 'checkbox'; rememberLabel.append(remember, make('span', 'Remember encrypted on this machine'));
      label.append(input, multilineLabel, multilineInput); secrets.append(label, rememberLabel); passwords.push({ field, target, input, remember, multiline, multilineInput });
    }
    if (passwords.length) secrets.append(make('p', 'Credentials use dedicated local controls. Their values never enter the configuration JSON, URL, or channel-status display.', 'fine-print'));
    for (const [capability, label, action] of [['start', 'Start channel', 'start'], ['stop', 'Stop channel', 'stop'], ['logout', 'Disconnect account', 'logout']]) if (item.capabilities?.[capability]) actions.append(actionButton(label, action));
    if (item.capabilities?.pairing) actions.append(actionButton('Review pairing requests', 'pairing-list', {}, pairingResult));
    if (item.capabilities?.webLogin) actions.append(actionButton(item.webLoginAvailability === 'native-check' ? 'Check native web login' : 'Start native web login', 'web-login-start', {}, loginResult));
    disable();
  }
  function drawChannel(preferredAccount) {
    const item = selected(), prior = preferredAccount ?? account.value; account.replaceChildren();
    const accounts = [...(item?.accounts || [])], defaultId = item?.defaultAccountId || 'default';
    if (!accounts.some(row => row.accountId === defaultId)) accounts.unshift({ accountId: defaultId });
    for (const row of accounts) { const option = make('option', text(row.label) || row.accountId); option.value = row.accountId; account.append(option); }
    if (item?.supportsAccounts) { const option = make('option', 'Add an account…'); option.value = '__new__'; account.append(option); }
    account.value = accounts.some(row => row.accountId === prior) || prior === '__new__' && item?.supportsAccounts ? prior : defaultId; drawAccount();
  }
  function render(next = {}, { reload = false } = {}) {
    if (destroyed) return;
    const prior = channel.value, priorAccount = account.value, priorItem = selected(), changedContext = next.contextKey !== undefined && next.contextKey !== state.contextKey;
    if (next.contextKey !== undefined && next.contextKey !== state.contextKey) { generation++; clearPasswords(); newAccount.value = ''; }
    state = { ...state, ...next }; channel.replaceChildren();
    for (const item of state.items || []) { if (!text(item.id) || reserved.has(item.id)) continue; const option = make('option', `${text(item.label) || item.id}${item.installed === false ? ' · available plugin' : ''}`); option.value = item.id; channel.append(option); }
    channel.value = (state.items || []).some(item => item.id === prior) ? prior : state.items?.[0]?.id || '';
    const item = selected(), chosen = item?.accounts?.find(row => row.accountId === accountId());
    if (!reload && !reloadNext && !changedContext && priorItem && item && item.id === prior && (chosen || priorAccount === '__new__' && item.supportsAccounts || priorAccount === (item.defaultAccountId || 'default'))) {
      // The parent polls live account health. A passive status refresh must not
      // erase typed settings, PEM input, or an in-progress native login challenge.
      drawStatus(item, chosen);
      if (state.baseHash !== accountBaseHash) { staleSnapshot = true; message.textContent = 'Native configuration changed. Refresh native integrations before applying this draft.'; }
      form?.update({ disabled: !!state.disabled }); disable(); return;
    }
    drawChannel(priorAccount);
  }
  channel.addEventListener('change', () => drawChannel()); account.addEventListener('change', drawAccount);
  newAccount.addEventListener('change', drawAccount);
  refresh.addEventListener('click', () => run(async isCurrent => { const snapshot = await onRefresh(); if (isCurrent() && snapshot) render(snapshot, { reload: true }); return snapshot; }));
  save.addEventListener('click', () => run(async isCurrent => {
    const item = selected(), selectedAccount = validAccount(), secretValues = [], enteredPasswords = [...passwords], values = nativeConfigValue(form?.getPatch() || {}), baseHash = state.baseHash;
    if (staleSnapshot) throw new Error('Native configuration changed. Refresh native integrations before applying this draft.');
    if (!item || item.installed === false) throw new Error('Install and trust this native integration before configuring it.');
    for (const row of enteredPasswords) {
      const value = row.multiline.checked === true ? row.multilineInput.value : row.input.value;
      if (!value) { if (row.field.required && !row.field.configured) throw new Error(`Enter ${text(row.field.label) || 'the required channel credential'}.`); continue; }
      if (new TextEncoder().encode(value).byteLength > 16384) throw new Error('A native channel credential must be at most 16 KiB.');
      const target = nativeChannelCredentialTarget(row.field, { channelId: item.id, accountId: selectedAccount });
      secretValues.push({ name: await nativeChannelCredentialName(target), target, value, remember: row.remember.checked === true });
    }
    if (!isCurrent()) return;
    const result = await onSave({ channelId: item.id, accountId: selectedAccount, values, secretValues, ...(baseHash ? { baseHash } : {}) });
    if (!isCurrent()) return;
    clearPasswords(); reloadNext = true; message.textContent = 'Configuration applied by the native runtime. Refresh to verify its account status.'; await onSaved(result); return result;
  }));
  render(initial);
  return { render, update: render, reset() { generation++; clearPasswords(); busy = false; state = { items: [], disabled: true }; render(state); }, destroy() { destroyed = true; generation++; clearPasswords(); form?.destroy(); card.remove?.(); if (!card.remove) mount.replaceChildren(); } };
}
