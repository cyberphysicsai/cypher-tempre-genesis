const backupName = 'chainchat-timechain.ctbackup';
const mime = 'application/octet-stream';
const maxArchive = 521 * 1024 * 1024;

export function mountTimechainBackups({ document, local, openDialog, requirePair, refreshState, session }) {
  const byId = id => document.getElementById(id);
  const dialog = byId('timechainBackupDialog');
  const exportForm = byId('timechainBackupForm'), restoreForm = byId('timechainRestoreForm');
  const status = byId('timechainBackupStatus'), error = dialog.querySelector('.dialog-error');
  const cancel = byId('cancelTimechainBackup');
  const password = byId('timechainBackupPassword'), confirmation = byId('timechainBackupConfirmation');
  const restorePassword = byId('timechainRestorePassword'), fileInput = byId('timechainRestoreFile');
  const submitButtons = [exportForm, restoreForm].map(form => form.querySelector('button[type="submit"]'));
  let operation;
  let selectedAgent;

  function clearPasswords() {
    password.value = '';
    confirmation.value = '';
    restorePassword.value = '';
  }
  function open() {
    selectedAgent = session().agent;
    status.textContent = '';
    clearPasswords();
    fileInput.value = '';
    byId('timechainBackupLocalNotice').hidden = local;
    byId('timechainBackupLocalControls').hidden = !local;
    byId('timechainBackupAgent').textContent = selectedAgent
      ? `Backing up ${selectedAgent.name}.`
      : 'Create or pair a Timechain before making a backup.';
    submitButtons[0].disabled = !!operation || !selectedAgent;
    submitButtons[1].disabled = !!operation;
    openDialog('timechainBackupDialog');
  }
  byId('openTimechainBackup').addEventListener('click', () => local ? requirePair(open) : open());
  cancel.addEventListener('click', () => operation?.abort());
  dialog.addEventListener('close', () => {
    operation?.abort();
    clearPasswords();
    fileInput.value = '';
  });

  async function post(route, body, contentType, signal) {
    const { token } = session();
    if (!local || !token) throw new Error('Open an authenticated local ChainChat session first.');
    const response = await fetch(route, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
      body, signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
    if (response.ok) return response;
    const result = await response.json().catch(() => null);
    throw new Error(result?.error || 'The local backup operation did not complete.');
  }

  async function run(message, task) {
    if (!local || operation) return;
    operation = new AbortController();
    status.textContent = message;
    error.textContent = '';
    submitButtons.forEach(button => { button.disabled = true; });
    cancel.hidden = false;
    try {
      status.textContent = await task(operation.signal);
    } catch (failure) {
      status.textContent = failure.name === 'AbortError' ? 'Operation cancelled.' : '';
      if (failure.name !== 'AbortError') error.textContent = failure.message;
    } finally {
      cancel.hidden = true;
      submitButtons[0].disabled = !selectedAgent;
      submitButtons[1].disabled = false;
      operation = null;
    }
  }

  exportForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!selectedAgent || selectedAgent.id !== session().agent?.id) {
      error.textContent = 'The selected Timechain changed. Reopen the backup guide.';
      return;
    }
    const passphrase = password.value;
    if (passphrase !== confirmation.value) {
      error.textContent = 'Both passphrase entries must match.';
      return;
    }
    clearPasswords();
    void run('Verifying and encrypting the selected Timechain…', async signal => {
      let save;
      if (typeof window.showSaveFilePicker === 'function') {
        try {
          save = await window.showSaveFilePicker({ suggestedName: backupName,
            types: [{ description: 'ChainChat backup', accept: { [mime]: ['.ctbackup'] } }] });
        } catch (failure) {
          if (!['SecurityError', 'NotAllowedError'].includes(failure.name)) throw failure;
        }
      }
      signal.throwIfAborted();
      const response = await post('/api/timechain/backup', JSON.stringify({ agentId: selectedAgent.id, passphrase }), 'application/json', signal);
      if (save) {
        const output = await save.createWritable();
        await response.body.pipeTo(output, { signal });
        return 'Verified backup saved. Keep the file and passphrase in separate safe places.';
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = backupName;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return 'Backup download started. Check your browser downloads for the saved file.';
    });
  });

  restoreForm.addEventListener('submit', event => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file || file.size > maxArchive) {
      error.textContent = 'Choose a ChainChat backup within the supported size limit.';
      return;
    }
    const passphrase = new TextEncoder().encode(restorePassword.value);
    if (!passphrase.length || passphrase.length > 1024) {
      passphrase.fill(0);
      error.textContent = 'Enter the backup passphrase. It can use up to 1024 UTF-8 bytes.';
      return;
    }
    clearPasswords();
    const size = Uint8Array.of(passphrase.length >> 8, passphrase.length & 0xff);
    const upload = new Blob([size, passphrase, file], { type: mime });
    passphrase.fill(0);
    void run('Authenticating and verifying the backup…', async signal => {
      const response = await post('/api/timechain/restore', upload, mime, signal);
      const { restored } = await response.json();
      fileInput.value = '';
      await refreshState();
      return `${restored.name} is in your agent list. Verified through ring ${restored.head.index}.`;
    });
  });
}
