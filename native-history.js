const ringHash = message => typeof message?.ring?.hash === 'string' ? message.ring.hash :
  typeof message?.ring?.ring_hash === 'string' ? message.ring.ring_hash : null;
const sameExchange = (left, right) => left?.role === 'assistant' && !left.held && !left.control &&
  left.content === right.content && left.input === right.input;
/** Merge verified saved exchanges into the browser view without discarding local
 * held responses, control receipts, paused-memory turns or pending drafts. */
export function mergeHistoryMessages(current, history) {
  const messages = [...(Array.isArray(current) ? current : [])], used = new Set(); let changed = false;
  for (let index = 0; index < (Array.isArray(history) ? history.length : 0); index++) {
    const saved = history[index]; if (saved?.role !== 'assistant') continue;
    const hash = ringHash(saved);
    if (!hash && !saved.pending) continue;
    const pair = history[index - 1]?.role === 'user' && history[index - 1].content === saved.input ? history[index - 1] : null;
    let match = messages.findIndex((item, slot) => !used.has(slot) && sameExchange(item, saved) &&
      (hash ? ringHash(item) === hash : !ringHash(item) && item.pending));
    if (match < 0 && hash) match = messages.findIndex((item, slot) => !used.has(slot) && sameExchange(item, saved) &&
      !ringHash(item) && item.raw !== true && item.memoryPaused !== true && item.mode !== 'dormant');
    if (match >= 0) {
      const previous = messages[match], next = { ...previous, ...saved, pending: saved.pending === true };
      used.add(match);
      if (JSON.stringify(previous) !== JSON.stringify(next)) { messages[match] = next; changed = true; }
      if (saved.nativeCompletion && messages[match - 1]?.role === 'user' && messages[match - 1].fromHistory && messages[match - 1].content === saved.input) {
        const removed = match - 1, matched = [...used]; messages.splice(removed, 1); used.clear();
        for (const slot of matched) if (slot !== removed) used.add(slot > removed ? slot - 1 : slot);
        changed = true;
      }
      continue;
    }
    // A request may already be visible while its accepted receipt arrives in a
    // later refresh. Reuse its unpaired user row, preserving any held diagnostic.
    let hasUnpairedInput = false;
    for (let slot = messages.length - 1; slot >= 0; slot--) {
      const item = messages[slot];
      if (item.role === 'assistant' && !item.held && !item.control) break;
      if (item.role === 'user') { hasUnpairedInput = !!pair && item.content === pair.content; break; }
    }
    if (pair && !hasUnpairedInput && !saved.nativeCompletion) messages.push(pair);
    messages.push({ ...saved, pending: saved.pending === true }); used.add(messages.length - 1); changed = true;
  }
  return { messages, changed };
}
