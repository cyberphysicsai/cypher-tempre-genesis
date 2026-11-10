const ENDPOINT = '/api/timechain/maintenance';

function describe(plan) {
  const head = plan.head ? `\nCurrent head is ring ${plan.head.index} (${plan.head.hash}).` : '';
  switch (plan.action) {
    case 'encoding':
      return `Convert ${plan.target} to UTF-8 after preserving its original bytes.\nOriginal SHA-256 ${plan.hash}.`;
    case 'restore-registry':
      return `Restore ${plan.target} from ring ${plan.ring}. The current file will be backed up.\nSnapshot SHA-256 ${plan.hash}.${head}`;
    case 'reanchor':
      return `Seal the reviewed registry hashes. Inspect the recovered files and their backups before confirming.\n${plan.reason}${head}\n\n${JSON.stringify(plan.registryHashes, null, 2)}`;
    case 'immune-recover':
      return `Quarantine rings ${plan.first} through ${plan.last} and append the recovery receipt. The original rings stay on disk.\n${plan.reason}${head}`;
    case 'witness-init':
      return `Create ${plan.witnesses} local witnesses and require agreement from ${plan.threshold}. They will attest the current head.${head}`;
    case 'witness-attest':
      return `Ask the existing witnesses to attest the current head.${head}`;
    case 'corpus-open':
      return `Open a strict review ledger for ${plan.blocks} source blocks.\n${plan.objective}${head}`;
    case 'corpus-record':
      return `Append your review of ring ${plan.ring}.\n\n${plan.finding}${head}`;
  }
}

function witnessText(witness) {
  if (!witness) return 'Verify the immutable chain before checking witnesses.';
  if (!witness.configured) return witness.incomplete ? 'Existing witness files need local inspection.' : 'No witness quorum is configured.';
  if (!witness.historyValid) return 'Witness verification failed. Inspect the local witness ledger.';
  return `${witness.agreeingAtHead} of ${witness.witnesses} witnesses agree at the current head. ${witness.threshold} required. ${witness.headAttested ? 'Head attested.' : 'Head attestation is missing.'}`;
}

export function mountTimechainMaintenance({ document, api, local, connected, onChange }) {
  const $ = id => document.getElementById(id);
  const dialog = $('timechainMaintenance');
  const form = $('timechainMaintenanceControls');
  const agent = $('maintenanceAgent');
  const target = $('maintenanceTarget');
  const notice = $('timechainMaintenanceNotice');
  const preview = $('maintenancePreview');
  const confirm = $('maintenanceApply');
  const change = (id, hidden) => $(id).classList.toggle('hidden', hidden);
  let generation = 0;
  let pending = null;
  let source = null;
  let working = false;

  function setOptions(select, rows, selected) {
    select.replaceChildren(...rows.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    if (rows.some(row => String(row.value) === selected)) select.value = selected;
  }

  function clearPreview() {
    pending = null;
    preview.classList.add('hidden');
    $('maintenancePreviewText').textContent = '';
  }

  function clearSource() {
    source = null;
    change('maintenanceSourceBlock', true);
    $('maintenanceSourceText').textContent = '';
    $('maintenanceFinding').value = '';
    $('maintenanceFindingConfirmed').checked = false;
  }

  function clearPrivateView() {
    clearPreview();
    clearSource();
    change('maintenanceSnapshotChoice', true);
    change('maintenanceReport', true);
    $('maintenanceReport').textContent = '';
    $('maintenanceCorpusObjective').value = '';
    $('maintenanceRecoveryReason').value = '';
    $('maintenanceFirstRing').value = '';
  }

  function updateTarget() {
    $('maintenanceEncoding').disabled = !target.value;
    $('maintenanceSnapshots').disabled = !target.value.startsWith('registry/');
  }

  function showCorpus(corpus) {
    const roles = corpus?.scope?.roles;
    const exclusions = corpus?.scope?.exclude_roles;
    const scope = `${roles?.length ? ` Included roles: ${roles.join(', ')}.` : ''}${exclusions?.length ? ` Excluded roles: ${exclusions.join(', ')}.` : ''}`;
    $('maintenanceCorpusStatus').textContent = corpus
      ? `${corpus.deep} of ${corpus.total} blocks have deep review records. ${corpus.reviewed} have any review record.${corpus.quarantinedPending ? ` ${corpus.quarantinedPending} quarantined blocks are held.` : ''}${corpus.challengeFailures ? ` ${corpus.challengeFailures} spot checks failed.` : ''}${scope}`
      : 'Verify the immutable chain before starting a corpus review.';
    change('maintenanceCorpusSetup', !corpus || corpus.open || !corpus.total);
    $('maintenanceNextBlock').disabled = !corpus?.open || corpus.next === null;
    $('maintenanceCorpusReport').disabled = !corpus?.open;
  }

  function showWitness(witness, writable) {
    $('maintenanceWitnessStatus').textContent = witnessText(witness);
    change('maintenanceWitnessSetup', !writable || !witness || witness.configured || witness.incomplete);
    $('maintenanceInitWitnesses').disabled = !writable || !witness || witness.configured || witness.incomplete;
    $('maintenanceVerifyWitnesses').disabled = !witness?.configured;
    $('maintenanceAttestHead').disabled = !writable || !witness?.historyValid || witness.headRowsPresent;
  }

  function selected(action, details = {}) {
    return api(ENDPOINT, { agentId: agent.value, action, ...details });
  }

  async function refresh(active) {
    const { status, offlineRecovery } = await selected('status');
    if (!active()) return;
    const held = status.interruptedMaintenance || status.locked || status.paused;
    const head = status.head ? `Verified immutable ledger at ring ${status.head.index}.` : 'The immutable ledger failed verification.';
    const transaction = status.interruptedMaintenance;
    const journal = transaction?.id ? ` Review chain/maintenance-transactions/${transaction.id}/transaction.json.` : '';
    $('maintenanceSummary').textContent = `${offlineRecovery ? 'Emergency Halt is active. Local recovery only. ' : ''}${head}${transaction ? ` An interrupted maintenance transaction requires local review.${journal}` : ''}${status.locked ? ' Immune lockdown is active.' : ''}${status.paused ? ' The Timechain is paused.' : ''}`;
    setOptions(target, status.targets.map(value => ({ value, label: value })), target.value);
    updateTarget();
    $('maintenanceReanchor').disabled = !status.integrity || held;
    $('maintenanceFirstRing').max = status.head?.index || 1;
    change('maintenanceImmune', !status.integrity || !status.locked || status.interruptedMaintenance || status.head.index < 1);
    showWitness(status.witness, status.integrity && !held);
    showCorpus(status.corpus);
    change('maintenanceWitnessGroup', offlineRecovery === true);
    change('maintenanceCorpusGroup', offlineRecovery === true);
    $('maintenanceOpenCorpus').disabled = held;
    $('maintenanceRecordFinding').disabled = held;
  }

  async function work(operation) {
    if (working) return;
    working = true;
    form.disabled = true;
    confirm.disabled = true;
    const current = generation;
    const active = () => current === generation && dialog.open;
    try { await operation(active); }
    catch (error) { if (active()) notice.textContent = error.message || 'The local maintenance operation was held.'; }
    finally {
      working = false;
      form.disabled = false;
      confirm.disabled = false;
    }
  }

  function draft(action, details = {}) {
    return work(async active => {
      clearPreview();
      notice.textContent = 'Checking the local preview…';
      const response = await selected(action, { ...details, phase: 'preview' });
      if (!active()) return;
      if (action === 'encoding' && !response.plan.recoverable) {
        notice.textContent = response.plan.state === 'already-valid-utf8'
          ? 'This store already uses valid UTF-8.' : 'The native engine could not validate a legacy encoding conversion for this store.';
        return;
      }
      pending = { agentId: agent.value, action, details, previewDigest: response.previewDigest };
      notice.textContent = 'Review the exact change before applying it.';
      $('maintenancePreviewText').textContent = describe(response.plan);
      preview.classList.remove('hidden');
      $('maintenancePreviewTitle').focus();
    });
  }

  function showSource(block) {
    if (!block) { clearSource(); return; }
    source = block;
    change('maintenanceSourceBlock', false);
    $('maintenanceSourceCaption').textContent = `Ring ${block.index} · characters ${block.offset + 1}–${block.nextOffset ?? block.characters} of ${block.characters}`;
    $('maintenanceSourceText').textContent = block.text;
    change('maintenanceNextPage', block.nextOffset === null);
    change('maintenanceFindingControls', block.nextOffset !== null);
    $('maintenanceSourceText').focus();
  }

  const click = (id, action) => $(id).addEventListener('click', action);
  click('openTimechainMaintenance', () => {
    if (working) return;
    if (!dialog.open) dialog.showModal();
    if (!local || !connected()) {
      form.classList.add('hidden');
      notice.textContent = 'Open ChainChat from the installed application launcher to use these local owner controls.';
      return;
    }
    void work(async active => {
      notice.textContent = 'Loading saved local Timechains…';
      const result = await api(ENDPOINT, { action: 'list' });
      if (!active()) return;
      setOptions(agent, result.agents.map(({ id, name }) => ({ value: id, label: name })), result.selected);
      if (!agent.value) {
        notice.textContent = 'Create or pair a Timechain in the local app first.';
        return;
      }
      await refresh(active);
      if (active()) { form.classList.remove('hidden'); notice.textContent = ''; }
    });
  });
  dialog.addEventListener('close', () => {
    generation++;
    clearPrivateView();
    form.classList.add('hidden');
  });
  form.addEventListener('input', clearPreview);
  agent.addEventListener('change', () => {
    clearPrivateView();
    void work(async active => { notice.textContent = ''; await refresh(active); });
  });
  target.addEventListener('change', () => {
    change('maintenanceSnapshotChoice', true);
    updateTarget();
  });

  click('maintenanceEncoding', () => draft('encoding', { target: target.value }));
  click('maintenanceSnapshots', () => work(async active => {
    clearPreview();
    const { snapshots } = await selected('snapshots', { target: target.value });
    if (!active()) return;
    const usable = snapshots.filter(row => row.valid);
    setOptions($('maintenanceSnapshotRing'), usable.map(row => ({ value: row.ring, label: `Ring ${row.ring} · ${row.hash.slice(0, 16)}` })));
    change('maintenanceSnapshotChoice', !usable.length);
    notice.textContent = usable.length ? 'Choose a verified snapshot to preview.' : 'No usable sealed snapshot was found.';
  }));
  click('maintenanceRestoreRegistry', () => draft('restore-registry', { target: target.value, ring: Number($('maintenanceSnapshotRing').value) }));
  const reason = () => $('maintenanceRecoveryReason').value;
  click('maintenanceReanchor', () => draft('reanchor', { reason: reason() }));
  click('maintenanceRecoverImmune', () => draft('immune-recover', { reason: reason(), ring: $('maintenanceFirstRing').valueAsNumber }));
  click('maintenanceInitWitnesses', () => draft('witness-init', { witnesses: $('maintenanceWitnessCount').valueAsNumber,
    threshold: $('maintenanceWitnessThreshold').valueAsNumber }));
  click('maintenanceVerifyWitnesses', () => work(async active => {
    const { witness } = await selected('witness-verify');
    if (active()) notice.textContent = witnessText(witness);
  }));
  click('maintenanceAttestHead', () => draft('witness-attest'));
  click('maintenanceOpenCorpus', () => draft('corpus-open', { reason: $('maintenanceCorpusObjective').value }));
  click('maintenanceNextBlock', () => work(async active => {
    clearPreview();
    clearSource();
    const { corpus, block } = await selected('corpus-next');
    if (active()) { showCorpus(corpus); showSource(block); }
  }));
  click('maintenanceNextPage', () => work(async active => {
    if (!source || source.nextOffset === null) return;
    const { block } = await selected('corpus-next', { ring: source.index, offset: source.nextOffset });
    if (active()) showSource(block);
  }));
  click('maintenanceRecordFinding', () => {
    if (!source || source.nextOffset !== null || !$('maintenanceFindingConfirmed').checked) {
      notice.textContent = 'Read every page and confirm that your finding cites the source.';
      return;
    }
    void draft('corpus-record', { ring: source.index, finding: $('maintenanceFinding').value });
  });
  click('maintenanceCorpusReport', () => work(async active => {
    const { corpus, report } = await selected('corpus-report');
    if (!active()) return;
    showCorpus(corpus);
    $('maintenanceReport').textContent = report.text;
    change('maintenanceReport', false);
    $('maintenanceReport').focus();
  }));
  click('maintenanceCancelPreview', () => { clearPreview(); notice.textContent = 'Preview canceled.'; });
  click('maintenanceApply', () => work(async active => {
    if (!pending || pending.agentId !== agent.value) return;
    const { action, details, previewDigest } = pending;
    clearPreview();
    notice.textContent = 'Applying the confirmed local change…';
    const { receipt } = await selected(action, { ...details, phase: 'apply', previewDigest, confirm: true });
    onChange();
    if (!active()) return;
    clearSource();
    change('maintenanceReport', true);
    change('maintenanceSnapshotChoice', true);
    notice.textContent = receipt.backup ? `Change applied. Original bytes saved as ${receipt.backup}.` : 'Confirmed change applied.';
    await refresh(active);
  }));
}
