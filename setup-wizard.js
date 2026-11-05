// The guide delegates to the same connection and chain forms as the main chat.
// It stores no setup answers, credentials, paths or completion flags in the browser.
const STEP_NAMES = ['Install', 'Choose model', 'Choose Timechain', 'Ready check'];
const text = (value, limit = 120) => typeof value === 'string' ? value.slice(0, limit) : '';

export function setupContext(snapshot) {
  const { state = {} } = snapshot || {};
  return JSON.stringify([snapshot?.connected === true, snapshot?.generation || 0,
    state.agent?.id || null, state.agent?.head?.hash || null, state.agent?.verified,
    state.agent?.locked === true, state.agent?.maintenancePending === true,
    state.provider?.configured === true, state.provider?.provider || null,
    state.provider?.tier || null, state.provider?.model || null,
    state.agent?.paused === true, state.executionRuntime?.backend || null,
    state.executionRuntime?.version || null, state.executionRuntime?.running,
    state.executionRuntime?.healthy, state.executionRuntime?.enforcementHealthy,
    state.canonicalSkill?.commit || null, state.canonicalSkill?.origin || null,
    state.canonicalSkill?.immutableTurnSnapshot, state.cognition?.mode || null]);
}

export function setupProgress(snapshot, report = null) {
  const connected = snapshot?.connected === true, state = snapshot?.state || {};
  const model = connected && state.provider?.configured === true;
  const chain = connected && !!state.agent && [true, 'PASS'].includes(state.agent.verified);
  const ready = connected && model && chain && report?.version === 1 && report?.setupReady === true
    && ['connection', 'runtime', 'model', 'timechain', 'proof'].every(key => report.checks?.[key]?.ready === true);
  const complete = [connected, model, chain, ready];
  return { complete, next: complete.findIndex(value => !value) < 0 ? 3 : complete.findIndex(value => !value), ready };
}

export function setupCheckRows(report) {
  const checks = report?.checks || {};
  return [
    ['Local connection', checks.connection?.ready === true, 'Authenticated local app'],
    ['OpenClaw runtime', checks.runtime?.ready === true,
      checks.runtime?.reason === 'RUNTIME_UNHEALTHY' ? 'Runtime health needs attention — reopen ChainChat'
        : checks.runtime?.running === true ? 'Running' : 'Runtime stopped — reopen ChainChat'],
    ['Model selected', checks.model?.ready === true,
      checks.model?.availability === 'unavailable' ? 'Free model currently unavailable — choose another model'
        : checks.model?.configured === true ? `${text(checks.model.model)} · credentials not tested yet` : 'Connect a model'],
    ['Timechain integrity', checks.timechain?.ready === true,
      checks.timechain?.error === 'CHAIN_LOCKED' ? 'Recovery hold — review agent state in runtime settings'
        : checks.timechain?.error === 'CHAIN_PAUSED' ? 'Chain paused — resume it before using active memory'
        : checks.timechain?.verified === true ? `${text(checks.timechain.name) || 'Your agent'} · verified` : 'Create or verify a Timechain'],
    ['Proof of Interaction', checks.proof?.ready === true, checks.proof?.ready === true
      ? 'Required review and verified skill bundle' : 'Skill verification needs attention — update or reopen ChainChat'],
  ].map(([label, ready, detail]) => ({ label, ready, detail }));
}

export function mountSetupWizard({ document: doc, snapshot, api, actions, defer = callback => setTimeout(callback, 0), now = () => Date.now() }) {
  const $ = id => doc.getElementById(id), dialog = $('setupDialog');
  let active = false, delegated = null, step = 0, report = null, context = '', busy = false, request = 0;
  let reportExpiresAt = 0;
  let initialized = false, automaticallyOpened = false;
  const nodes = name => [...dialog.querySelectorAll(name)];
  const show = () => { if (!dialog.open) dialog.showModal(); };
  const hide = () => { if (dialog.open) dialog.close(); };

  function syncContext() {
    const next = setupContext(snapshot());
    if (next !== context || report && now() >= reportExpiresAt) { context = next; report = null; request++; busy = false; }
  }
  function render() {
    syncContext();
    const current = snapshot(), progress = setupProgress(current, report);
    step = Math.min(step, progress.next);
    $('setupProgressText').textContent = `Step ${step + 1} of 4 · ${STEP_NAMES[step]}`;
    for (const button of nodes('[data-setup-step]')) {
      const index = Number(button.dataset.setupStep);
      button.disabled = busy || index > progress.next;
      button.setAttribute('aria-current', index === step ? 'step' : 'false');
      button.dataset.complete = String(progress.complete[index]);
      button.querySelector('.setup-step-state').textContent = progress.complete[index] ? 'Complete' : index === step ? 'Current' : 'Next';
    }
    for (const panel of nodes('[data-setup-panel]')) panel.hidden = Number(panel.dataset.setupPanel) !== step;
    $('setupBack').disabled = busy || step === 0;
    $('setupNext').hidden = step === 3;
    $('setupNext').disabled = busy || !progress.complete[step];
    $('setupNext').textContent = step === 2 ? 'Check my setup →' : 'Continue →';
    $('setupLocalStatus').textContent = current.connected ? 'Installed app connected ✓'
      : current.local ? 'Open ChainChat from its application launcher to connect securely.' : 'Download the installer for your computer to begin.';
    $('setupModelStatus').textContent = current.connected && current.state?.provider?.configured
      ? `Selected: ${text(current.state.provider.model)}` : 'Choose an available free model, your own API connection, or native OpenClaw sign-in.';
    $('setupModelAction').disabled = !current.connected || busy;
    for (const id of ['setupNewChain', 'setupExistingChain', 'setupSelectSaved']) $(id).disabled = !current.connected || busy;
    $('setupChainStatus').textContent = current.connected && current.state?.agent
      ? `${text(current.state.agent.name) || 'Selected agent'} · ${progress.complete[2] ? 'chain verified ✓' : 'verification required'}`
      : 'Start fresh or continue an agent you already use. Existing history is preserved.';
    const select = $('setupSavedAgents'), selected = select.value;
    const choices = (current.connected ? current.state?.agents || [] : []).slice(0, 100);
    select.replaceChildren();
    for (const agent of choices) {
      if (typeof agent.id !== 'string') continue;
      const option = doc.createElement('option'); option.value = agent.id;
      option.textContent = text(agent.name) || 'Saved agent'; select.append(option);
    }
    if (choices.some(agent => agent.id === selected)) select.value = selected;
    else if (current.state?.agent?.id) select.value = current.state.agent.id;
    $('setupSavedSection').hidden = choices.length === 0;
    select.disabled = busy;
    $('setupCheck').disabled = busy || !current.connected || !progress.complete[1] || !progress.complete[2];
    $('setupCheck').textContent = busy ? 'Checking local setup…' : report ? 'Run checks again' : 'Check readiness';
    $('setupFinish').disabled = busy || !progress.ready;
    $('setupFirstMessage').disabled = busy || !progress.ready;
    $('setupReadyTitle').textContent = progress.ready ? 'Your chat is ready to try.' : 'Let’s verify your setup.';
    $('setupReadyNote').textContent = progress.ready
      ? 'The local app, Timechain and PoI checks passed. Your first message will test provider access and answer review; provider limits or credentials can still need attention.'
      : 'This check makes no model call and has no API charge. It checks configuration, current shared-free availability, chain integrity and PoI.';
    $('setupPausedNote').hidden = report?.memoryPaused !== true;
    const list = $('setupCheckList'); list.replaceChildren();
    if (report) for (const row of setupCheckRows(report)) {
      const item = doc.createElement('li'), label = doc.createElement('strong'), detail = doc.createElement('span');
      item.dataset.ready = String(row.ready); label.textContent = `${row.ready ? '✓' : '○'} ${row.label}`;
      detail.textContent = row.detail; item.append(label, detail); list.append(item);
    }
    $('setupRepairModel').hidden = !report || report.checks?.model?.ready === true;
    $('setupRepairChain').hidden = !report || report.checks?.timechain?.ready === true;
    $('setupRepairRuntime').hidden = !report || (report.checks?.runtime?.ready === true && report.checks?.proof?.ready === true && report.checks?.timechain?.error !== 'CHAIN_LOCKED');
  }
  function open({ automatic = false } = {}) {
    syncContext(); active = true; delegated = null;
    if (automatic) automaticallyOpened = true;
    step = setupProgress(snapshot(), report).next;
    $('setupError').textContent = ''; render(); show();
  }
  function dismiss() { active = false; delegated = null; request++; busy = false; hide(); }
  async function check() {
    if (busy) return;
    syncContext();
    const current = setupProgress(snapshot());
    if (!current.complete.slice(0, 3).every(Boolean)) { render(); return; }
    const expected = context, id = ++request; busy = true; report = null;
    $('setupError').textContent = ''; render();
    try {
      const result = await api('/api/setup/readiness');
      if (!active || id !== request || expected !== setupContext(snapshot())) return;
      if (result?.version !== 1 || typeof result.setupReady !== 'boolean') throw new Error('Invalid readiness response');
      const current = snapshot().state, model = current?.provider;
      const tier = model?.provider === 'native' ? 'native' : model?.tier === 'free' ? 'free' : 'byok';
      if (result.checks?.timechain?.agentId !== current?.agent?.id
        || result.checks?.timechain?.verified === true && result.checks.timechain.headHash !== current?.agent?.head?.hash
        || result.checks?.model?.model !== model?.model
        || result.checks?.model?.provider !== model?.provider || result.checks?.model?.tier !== tier)
        throw new Error('Setup changed during verification');
      report = result;
      reportExpiresAt = now() + 60_000;
    } catch {
      if (active && id === request) $('setupError').textContent = 'The readiness check could not finish. Update or reopen the installed app if needed, then try again. No test message was sent.';
    } finally {
      if (id === request) { busy = false; render(); }
    }
  }
  function delegate(id, action) {
    if (busy) return;
    delegated = id; hide(); action();
  }
  for (const id of ['modelDialog', 'genesisDialog', 'existingDialog', 'pairDialog']) {
    $(id).addEventListener('close', () => {
      if (!active || delegated !== id) return;
      delegated = null; report = null;
      defer(() => { if (active && !doc.querySelector('dialog[open]')) open(); });
    });
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener('close', () => { if (!delegated) { active = false; request++; busy = false; } });
  $('setupDismiss').addEventListener('click', dismiss);
  $('setupLater').addEventListener('click', dismiss);
  $('setupBack').addEventListener('click', () => { if (!busy && step > 0) { step--; render(); } });
  $('setupNext').addEventListener('click', () => {
    const progress = setupProgress(snapshot(), report);
    if (busy || !progress.complete[step] || step >= 3) return;
    step++; render(); if (step === 3) void check();
  });
  for (const button of nodes('[data-setup-step]')) button.addEventListener('click', () => {
    const next = Number(button.dataset.setupStep);
    if (!busy && next <= setupProgress(snapshot(), report).next) { step = next; render(); }
  });
  $('setupModelAction').addEventListener('click', () => delegate('modelDialog', actions.model));
  $('setupNewChain').addEventListener('click', () => delegate('genesisDialog', actions.genesis));
  $('setupExistingChain').addEventListener('click', () => delegate('existingDialog', actions.existing));
  $('setupAdvancedPair').addEventListener('click', () => delegate('pairDialog', actions.pair));
  $('setupSelectSaved').addEventListener('click', async () => {
    if (busy || !$('setupSavedAgents').value) return;
    syncContext();
    const id = ++request;
    busy = true; render();
    try { await actions.selectAgent($('setupSavedAgents').value); }
    catch { if (active && id === request) $('setupError').textContent = 'The saved agent could not be selected. Choose it again or verify an existing Timechain.'; }
    finally { if (active && id === request) { busy = false; report = null; step = setupProgress(snapshot()).next; render(); } }
  });
  $('setupCheck').addEventListener('click', check);
  $('setupRepairModel').addEventListener('click', () => delegate('modelDialog', actions.model));
  $('setupRepairChain').addEventListener('click', () => delegate('existingDialog', actions.existing));
  $('setupRepairRuntime').addEventListener('click', () => { dismiss(); actions.settings(); });
  for (const id of ['setupFinish', 'setupFirstMessage']) $(id).addEventListener('click', () => {
    syncContext();
    render();
    if (!setupProgress(snapshot(), report).ready || busy) return;
    dismiss(); actions.finish({ prepareIntroduction: id === 'setupFirstMessage' });
  });
  const downloads = doc.querySelector('#installDialog .platform-downloads');
  if (downloads) $('setupDownloads').append(downloads.cloneNode(true));
  return {
    open, dismiss, get active() { return active; },
    update() { if (active) render(); },
    start() {
      if (initialized) return;
      initialized = true;
      const current = snapshot();
      if (current.local && !automaticallyOpened && (!current.connected || !current.state?.provider?.configured || !current.state?.agent)) open({ automatic: true });
    },
  };
}
