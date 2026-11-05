const goalControls = new Set(['status', 'edit', 'pause', 'complete', 'done', 'block', 'blocked', 'clear']);

export function composerCommand(value) {
  const command = value.trim();
  const match = command.match(/^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  const args = match[2]?.trim() || '';
  const goalAction = args.split(/\s/, 1)[0].toLowerCase();
  // The server admits goal turns and selected skill invocations in the chat
  // pipeline. All other slash commands belong to its native control parser.
  const turn = name === 'skill' || name === 'goal' && !!args && !goalControls.has(goalAction);
  return {
    command,
    name,
    path: turn ? '/api/chat' : '/api/openclaw/command',
    interrupt: !args && name === 'stop' || name === 'goal' && args.toLowerCase() === 'pause',
  };
}

const examples = [
  ['/help', 'List chat commands and guarded operations.'],
  ['/goal', 'Read the current OpenClaw goal.'],
  ['/goal start ', 'Add an objective to begin a reviewed goal turn.'],
  ['/goal resume', 'Continue the current goal in a reviewed turn.'],
  ['/goal pause', 'Pause the current goal.'],
  ['/skill ', 'Add the name of a selected, user-invocable skill.'],
  ['/compact', 'Request an optional PoI-reviewed conversation summary.'],
  ['/context', 'Inspect the native conversation context.'],
  ['/tools', 'Inspect the selected agent’s tool policy.'],
  ['/model', 'Open the model picker.'],
  ['/config', 'Open OpenClaw settings.'],
  ['/stop', 'Request cancellation of current work.'],
];

export function mountChatCommands({ document, input, panel, choices }) {
  if (!input || !panel || !choices) return;
  const prefix = () => /^\/[a-z0-9_-]*$/i.test(input.value.trimStart()) ? input.value.trimStart().toLowerCase() : '';
  function render() {
    const query = prefix();
    choices.replaceChildren();
    for (const [example, description] of examples) {
      if (query && !example.startsWith(query)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'native-command';
      const label = document.createElement('strong');
      label.textContent = example.trimEnd();
      const detail = document.createElement('span');
      detail.textContent = description;
      button.append(label, detail);
      button.addEventListener('click', () => {
        input.value = example;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        panel.open = false;
        input.focus();
      });
      choices.append(button);
    }
    if (!choices.childElementCount) {
      const notice = document.createElement('p');
      notice.className = 'fine-print';
      notice.textContent = 'Run /help for the full command list.';
      choices.append(notice);
    }
  }
  input.addEventListener('input', () => {
    panel.open = !!prefix();
    if (panel.open) render();
  });
  panel.addEventListener('toggle', () => { if (panel.open) render(); });
  function dismiss(event) {
    if (event.key !== 'Escape' || !panel.open) return;
    event.preventDefault();
    event.stopPropagation();
    panel.open = false;
    input.focus();
  }
  input.addEventListener('keydown', dismiss);
  panel.addEventListener('keydown', dismiss);
}
