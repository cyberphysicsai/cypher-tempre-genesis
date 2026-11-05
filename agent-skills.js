const MAX_SKILL_BYTES = 32 * 1024;

export function mountAgentSkills({ document, api, connected, agentId }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('chatSkillsDialog');
  if (!dialog) return { sync() {} };
  const open = byId('chatSkillsButton'), notice = byId('chatSkillsNotice');
  const list = byId('chatSkillsList'), manage = byId('chatSkillsManage');
  const acknowledge = byId('chatSkillsAcknowledged'), apply = byId('chatSkillsApply');
  const file = byId('chatSkillsFile'), preview = byId('chatSkillsPreview');
  const save = byId('chatSkillsImport'), error = byId('chatSkillsError');
  let currentAgent, generation = 0, fileRead = 0, snapshot = null, draft = new Map();
  let busy = false, fileText = '';

  function refreshButtons() {
    const selected = snapshot?.skills.filter(skill => skill.selected) || [];
    const changed = selected.length !== draft.size ||
      selected.some(skill => draft.get(skill.id) !== skill.selectedSha256);
    const valid = snapshot?.skills.every(skill =>
      !draft.has(skill.id) || draft.get(skill.id) === skill.sha256);
    apply.disabled = busy || !snapshot?.canManage || !acknowledge.checked || !changed || !valid;
    save.disabled = busy || !snapshot?.canManage || !fileText;
    file.disabled = busy;
    acknowledge.disabled = busy;
    for (const checkbox of list.querySelectorAll('input')) {
      checkbox.disabled = busy || !snapshot?.canManage ||
        (checkbox.dataset.unavailable === 'true' && !checkbox.checked);
    }
  }

  function clearFile() {
    fileRead++;
    file.value = '';
    fileText = '';
    preview.textContent = '';
    preview.hidden = true;
  }

  function render(data) {
    snapshot = data;
    draft = new Map(data.skills.filter(skill => skill.selected).map(skill => [skill.id, skill.selectedSha256]));
    acknowledge.checked = false;
    list.replaceChildren();
    manage.hidden = !data.canManage;
    notice.textContent = data.canManage
      ? 'Import and review a SKILL.md, then equip it here. Use /skill followed by its name and your request to invoke it explicitly.'
      : 'Manage equipped skills from the local ChainChat app.';
    if (!data.skills.length) list.textContent = 'No additional skills saved.';
    for (const skill of data.skills) {
      const row = document.createElement('label');
      row.className = 'native-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = skill.selected;
      const unavailable = skill.status === 'changed' || skill.status === 'missing';
      checkbox.dataset.unavailable = String(unavailable);
      const description = document.createElement('span');
      description.textContent = skill.name;
      const detail = document.createElement('small');
      detail.textContent = unavailable
        ? `Document ${skill.status}. Unequip it to continue using this agent.`
        : `${skill.selected ? 'Equipped' : 'Available'} · SHA-256 ${skill.sha256}`;
      description.append(detail);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) draft.set(skill.id, skill.sha256);
        else draft.delete(skill.id);
        acknowledge.checked = false;
        refreshButtons();
      });
      row.append(checkbox, description);
      list.append(row);
    }
    refreshButtons();
  }

  async function load() {
    const ticket = ++generation, selected = currentAgent;
    busy = false;
    snapshot = null;
    manage.hidden = true;
    error.textContent = '';
    list.replaceChildren();
    clearFile();
    notice.textContent = selected ? 'Loading equipped skills…' : 'Connect local OpenClaw and select a verified Timechain.';
    if (!selected) return;
    try {
      const data = await api('/api/openclaw/skills');
      if (ticket === generation && dialog.open && data.agentId === selected) render(data);
    } catch (failure) {
      if (ticket === generation) {
        notice.textContent = 'Skills are unavailable for this agent.';
        error.textContent = failure.message;
      }
    }
  }

  async function update(operation, payload) {
    if (busy || !snapshot?.canManage) return;
    const ticket = generation, selected = currentAgent;
    busy = true;
    error.textContent = '';
    refreshButtons();
    try {
      const data = await api(`/api/openclaw/skills/${operation}`, {
        agentId: selected, acknowledged: true, ...payload,
      });
      if (ticket !== generation || !dialog.open) return;
      if (operation === 'import') {
        await load();
        if (currentAgent === selected && snapshot && dialog.open)
          notice.textContent = 'Instructions saved. Select the skill and apply to equip it.';
      } else if (data.agentId === selected) {
        render(data);
        notice.textContent = 'Equipped skills saved for this Timechain.';
      }
    } catch (failure) {
      if (ticket === generation) error.textContent = failure.message;
    } finally {
      if (ticket === generation) {
        busy = false;
        refreshButtons();
      }
    }
  }

  const sync = () => {
    const next = connected() ? agentId() : null;
    if (next === currentAgent) return;
    currentAgent = next;
    if (dialog.open) void load();
  };
  open.addEventListener('click', () => {
    currentAgent = connected() ? agentId() : null;
    if (!dialog.open) dialog.showModal();
    void load();
  });
  byId('chatSkillsClose').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    generation++;
    snapshot = null;
    clearFile();
  });
  acknowledge.addEventListener('change', refreshButtons);
  apply.addEventListener('click', () => {
    if (!apply.disabled) void update('select', { revision: snapshot.revision,
      skills: Array.from(draft, ([id, sha256]) => ({ id, sha256 })) });
  });
  file.addEventListener('change', async () => {
    const ticket = ++fileRead, selected = file.files[0];
    fileText = '';
    preview.textContent = '';
    preview.hidden = true;
    error.textContent = '';
    refreshButtons();
    if (!selected) return;
    try {
      if (selected.size > MAX_SKILL_BYTES) throw new Error('Choose a SKILL.md of at most 32 KiB.');
      const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await selected.arrayBuffer());
      if (ticket !== fileRead) return;
      fileText = decoded;
      preview.textContent = decoded;
      preview.hidden = false;
    } catch (failure) {
      if (ticket === fileRead) error.textContent = failure.message;
    }
    refreshButtons();
  });
  save.addEventListener('click', () => {
    if (!save.disabled) void update('import', { text: fileText });
  });
  return { sync };
}
