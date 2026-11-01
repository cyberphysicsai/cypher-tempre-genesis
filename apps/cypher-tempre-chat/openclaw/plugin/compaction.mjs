/** Reviewed native transcript compaction. Uses only the published agent-sessions SDK. */
import { createHash, randomUUID } from 'node:crypto';

export const COMPACTION_ENGINE_ID = 'cypher-tempre-poi';
// Leave room for the verified skill context and native/tool instructions in the
// pinned 131k-token summary route. Larger histories use bounded complete turns.
const MAX_SOURCE = 288 * 1024, MAX_SUMMARY = 128 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').digest('hex');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
const bounded = (value, limit) => typeof value === 'string' && value.trim().length > 0 && bytes(value) <= limit;
const check = signal => signal?.throwIfAborted();
const failure = message => Object.assign(new Error(message), { code: 'OPENCLAW_COMPACTION_HELD' });
const estimate = messages => Math.max(1, Math.ceil(bytes(messages) / 4));
export function nativeBranchDigest(branch) {
  const digest = createHash('sha256'); digest.update('[');
  branch.forEach((entry, index) => { if (index) digest.update(','); digest.update(JSON.stringify(entry)); });
  return digest.update(']').digest('hex');
}
const canonicalTarget = params => {
  const target = params.sessionTarget ?? params.runtimeContext?.sessionTarget;
  if (!target || !bounded(params.sessionId, 512) || !bounded(params.sessionKey, 2048) ||
      target.sessionId !== params.sessionId || target.sessionKey !== params.sessionKey ||
      !bounded(target.agentId, 512) || !bounded(target.storePath, 32768) ||
      params.agentId && params.agentId !== target.agentId)
    throw failure('Compaction requires the exact native session target.');
  // Preserve the host's exact trusted target, including future SDK fencing
  // metadata. Only its public identity projection is returned to the caller.
  return target;
};

function transcriptCompletion(messages) {
  if (!Array.isArray(messages)) return { paired: false, complete: false };
  const pending = new Set(); let invalid = false, terminal = false;
  for (const message of messages) {
    if (message.role === 'assistant') {
      const calls = Array.isArray(message.content) ? message.content.filter(block => block?.type === 'toolCall') : [];
      if (calls.length) {
        terminal = false;
        for (const call of calls) {
          if (!bounded(call.id, 512) || pending.has(call.id)) invalid = true;
          else pending.add(call.id);
        }
      } else {
        const hasContent = typeof message.content === 'string' ? !!message.content.trim() : Array.isArray(message.content) && message.content.length > 0;
        terminal = pending.size === 0 && !['toolUse', 'error', 'aborted'].includes(message.stopReason) && (hasContent || message.stopReason === 'stop');
      }
    } else if (message.role === 'toolResult') {
      if (!bounded(message.toolCallId, 512) || !pending.delete(message.toolCallId)) invalid = true;
      terminal = false;
    } else if (message.role === 'user') terminal = false;
  }
  return { paired: !invalid && pending.size === 0, complete: !invalid && pending.size === 0 && terminal };
}

function effectiveNativeTranscript(branch, buildSessionContext) {
  const latestBoundary = branch.findLastIndex(entry => entry.type === 'reset' || entry.type === 'compaction');
  const boundary = branch[latestBoundary];
  const firstRetained = boundary ? branch.findIndex(entry => entry.id === boundary.firstKeptEntryId) : -1;
  // Old physical branches remain in SQLite after native compaction. Select only
  // the effective summary/retained suffix, then link a detached projection for
  // the native codec; never resurrect already summarized history.
  const effective = (boundary?.type === 'compaction' ? [boundary, ...branch.slice(firstRetained >= 0 && firstRetained < latestBoundary ? firstRetained : latestBoundary + 1)
    .filter(entry => entry !== boundary)] : branch).map((entry, index, entries) => ({ ...entry, parentId: index ? entries[index - 1].id : null }));
  const users = effective.flatMap((entry, index) => (boundary?.type !== 'reset' || index > latestBoundary) &&
    entry.type === 'message' && entry.message?.role === 'user' && entry.message.excludeFromContext !== true ? [index] : []);
  const completeUsers = users.filter((start, index) => transcriptCompletion(buildSessionContext(effective.slice(start, users[index + 1] ?? effective.length)).messages).complete);
  return { effective, users, completeUsers };
}

/** Keep complete recent user turns, including every assistant/tool-result pair. */
export function planNativeCompaction(branch, buildSessionContext, { retainTurns = 2 } = {}) {
  if (!Array.isArray(branch) || !branch.length || branch.some(entry => !entry || typeof entry.id !== 'string') ||
      !Number.isSafeInteger(retainTurns) || retainTurns < 2 || retainTurns > 50)
    throw failure('The native transcript cannot be compacted within its bounded review window.');
  const { effective, users, completeUsers } = effectiveNativeTranscript(branch, buildSessionContext);
  if (completeUsers.length <= retainTurns) return null;
  const firstRetainedCompleteTurn = completeUsers.at(-retainTurns);
  let selected;
  // Compact as many complete older turns as fit in one review window. A large
  // cumulative history is processed incrementally instead of permanently held.
  for (const cut of users.slice(1).filter(index => index <= firstRetainedCompleteTurn)) {
    const messages = buildSessionContext(effective.slice(0, cut)).messages;
    if (!Array.isArray(messages) || !messages.length) continue;
    if (!transcriptCompletion(messages).paired) continue;
    if (bytes(messages) > MAX_SOURCE) break;
    selected = { firstKeptEntryId: effective[cut].id, messages, retainedCompleteTurns: completeUsers.filter(index => index >= cut).length };
  }
  if (!selected) throw failure('A complete oldest turn exceeds the summary review window.');
  return { branchSha256: nativeBranchDigest(branch), ...selected,
    tokensBefore: estimate(buildSessionContext(branch).messages) };
}

function checkedReceipt(result, expected) {
  const receipt = result?.receipt;
  if (result?.allowed !== true || !receipt || Object.entries(expected).some(([key, value]) => receipt[key] !== value) ||
      !Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt) <= Date.now())
    throw failure('A current exact-summary compaction receipt is required.');
  return receipt;
}

/** Host-only read probe. Return budget metadata, never transcript content. */
export async function inspectNativeCompaction({ sdk, sessionTarget, workspaceDir, signal } = {}) {
  if (typeof sdk?.SessionManager?.openAsync !== 'function' || typeof sdk?.buildSessionContext !== 'function')
    throw failure('Published native session APIs are required.');
  const params = { sessionId: sessionTarget?.sessionId, sessionKey: sessionTarget?.sessionKey, sessionTarget };
  const target = canonicalTarget(params); check(signal);
  const manager = await sdk.SessionManager.openAsync(target, workspaceDir, undefined, signal); check(signal);
  const branch = manager.getBranch(), messages = sdk.buildSessionContext(branch).messages;
  if (!Array.isArray(messages)) throw failure('The native budget view could not be read.');
  const plan = branch.length ? planNativeCompaction(branch, sdk.buildSessionContext) : null;
  return { sessionId: target.sessionId, sessionKey: target.sessionKey, branchSha256: nativeBranchDigest(branch),
    estimatedTokens: estimate(messages), messageCount: messages.length, completeTurns: effectiveNativeTranscript(branch, sdk.buildSessionContext).completeUsers.length, compactable: !!plan,
    latestCompactionId: branch.findLast(entry => entry.type === 'compaction')?.id ?? null };
}

/**
 * The host supplies private broker transport; model text is never a user reply.
 * A denied operation returns normally, so native failure isolation cannot switch
 * to an unreviewed legacy summarizer. Native owner/CAS checks still own writes.
 */
export function createReviewedContextEngine({ sdk, request, workspaceDir, commitStore, targetRegistry } = {}) {
  if (typeof sdk?.SessionManager?.openAsync !== 'function' || typeof sdk?.buildSessionContext !== 'function' || typeof request !== 'function' ||
      typeof commitStore?.registerIfAbsent !== 'function' || typeof commitStore?.lookup !== 'function')
    throw new TypeError('Published native session APIs, a durable accepted-turn store and private broker transport are required.');
  const contextEngine = {
    info: { id: COMPACTION_ENGINE_ID, name: 'Cypher Tempre reviewed native context', version: '1.0.0', ownsCompaction: true,
      acceptedHostParams: ['sessionKey', 'sessionTarget', 'runtimeContext', 'runtimeSettings', 'abortSignal', 'prompt'],
      transcriptSemantics: { currentTurnFence: 'before-current-turn-entry-v1', turnAdvancementIdempotency: 'atomic-idempotent-v1' },
      hostRequirements: { 'agent-run': { requiredCapabilities: ['assemble-before-prompt'] },
        'manual-compact': { requiredCapabilities: ['compact'] } } },
    async ingest() { return { ingested: false }; },
    async bootstrap(params) {
      if (targetRegistry) await targetRegistry.remember(canonicalTarget(params));
      return { bootstrapped: true, importedMessages: 0 };
    },
    async commitTurn({ advancementKey, sessionKey, sessionId, admission, terminal, messages }) {
      if (!bounded(advancementKey, 4096) || !bounded(sessionKey, 2048) || !bounded(sessionId, 512) ||
          !admission || !terminal || !Array.isArray(messages) || !messages.length)
        throw failure('An accepted native transcript range is required.');
      // The native transcript owns the messages. This retained atomic receipt
      // acknowledges that exact accepted range once, including restart replay.
      const record = { sessionKey, sessionId, payloadSha256: hash({ admission, terminal, messages }) };
      if (await commitStore.registerIfAbsent(advancementKey, record)) return { status: 'committed' };
      const existing = await commitStore.lookup(advancementKey);
      if (!existing || existing.sessionKey !== sessionKey || existing.sessionId !== sessionId || existing.payloadSha256 !== record.payloadSha256)
        throw failure('A native accepted-turn advancement key was reused with different content.');
      return { status: 'duplicate' };
    },
    async assemble({ messages, sessionKey }) {
      let systemPromptAddition = '';
      try {
        if (!bounded(sessionKey, 2048)) throw failure('No selected native context exists.');
        const supplied = await request('model_context', { sessionKey, runId: 'context-assembly:' + randomUUID() });
        if (supplied?.allowed !== true || !bounded(supplied.context, 4 * 1024 * 1024)) throw failure('Managed context was not admitted.');
        systemPromptAddition = supplied.context;
      } catch { /* Missing capability makes the private provider proxy deny. */ }
      // The supervisor performs reviewed compaction through the official
      // sessions.compact lifecycle BEFORE admitting the next user input. A
      // separate SDK writer here would stale the active native session/fence.
      return { messages, estimatedTokens: estimate(messages) + Math.ceil(bytes(systemPromptAddition) / 4),
        promptAuthority: 'preassembly_may_overflow', systemPromptAddition };
    },
    async compact(params) {
      let committed = false, completed;
      try {
        check(params.abortSignal);
        const target = canonicalTarget(params);
        if (targetRegistry) await targetRegistry.remember(target);
        const manager = await sdk.SessionManager.openAsync(target, workspaceDir, undefined, params.abortSignal);
        check(params.abortSignal);
        const plan = planNativeCompaction(manager.getBranch(), sdk.buildSessionContext);
        if (!plan) return { ok: true, compacted: false, reason: 'At least three complete user turns are needed; two recent turns are retained.' };
        const instructions = params.customInstructions ?? '';
        if (typeof instructions !== 'string' || bytes(instructions) > 16000) throw failure('Compaction focus is too large.');
        const binding = { sessionKey: params.sessionKey, runId: randomUUID() };
        const source = { sessionId: params.sessionId, branchSha256: plan.branchSha256,
          firstKeptEntryId: plan.firstKeptEntryId, messages: plan.messages };
        const prepared = await request('compaction_prepare', binding, { source, instructions }, params.abortSignal);
        check(params.abortSignal);
        if (prepared?.allowed !== true || !bounded(prepared.claimId, 512) || !bounded(prepared.summary, MAX_SUMMARY))
          throw failure('The compaction summary was not admitted.');
        const summary = prepared.summary;
        const expected = { claimId: prepared.claimId, sessionId: params.sessionId, firstKeptEntryId: plan.firstKeptEntryId,
          branchSha256: plan.branchSha256, summarySha256: hash(summary) };
        if (!HASH.test(expected.branchSha256) || !HASH.test(expected.summarySha256)) throw failure('Invalid compaction digests.');
        const reviewed = await request('compaction_review', binding, { ...expected, summary }, params.abortSignal);
        const receipt = checkedReceipt(reviewed, expected);
        check(params.abortSignal);
        // Rehydrate before the final grant. The native append also checks its
        // own transcript version and active writer inside the write transaction.
        await manager.reloadPersistedTranscriptAsync(params.abortSignal);
        if (nativeBranchDigest(manager.getBranch()) !== plan.branchSha256) throw failure('The native transcript changed during summary review.');
        const final = await request('compaction_commit', binding, { ...expected, receipt }, params.abortSignal);
        checkedReceipt(final, expected); check(params.abortSignal);
        if (nativeBranchDigest(manager.getBranch()) !== plan.branchSha256) throw failure('The native transcript changed before summary persistence.');
        const beforeAppend = manager.getBranch();
        const tokensAfter = estimate(sdk.buildSessionContext([...beforeAppend, { id: randomUUID(), type: 'compaction',
          parentId: beforeAppend.at(-1)?.id ?? null, timestamp: new Date().toISOString(), summary,
          firstKeptEntryId: plan.firstKeptEntryId, tokensBefore: plan.tokensBefore }]).messages);
        completed = { ok: true, compacted: true, result: { summary, firstKeptEntryId: plan.firstKeptEntryId,
          tokensBefore: plan.tokensBefore, tokensAfter, sessionTarget: { agentId: target.agentId, sessionId: target.sessionId,
            sessionKey: target.sessionKey, storePath: target.storePath },
          details: { kind: 'reviewed-native-summary', summarySha256: expected.summarySha256, sourceSha256: plan.branchSha256,
            retainedCompleteTurns: plan.retainedCompleteTurns, tokenCounts: 'estimated', reviewed: true } } };
        await manager.appendCompactionAsync(summary, plan.firstKeptEntryId, plan.tokensBefore, completed.result.details, true, { runId: binding.runId }, tokensAfter);
        committed = true;
        return completed;
      } catch {
        // Never return a failure after an accepted native append, and never
        // expose raw provider/broker errors or rejected summaries to the UI.
        return committed ? completed : { ok: false, compacted: false, reason: 'Proof of Interaction held compaction; the existing transcript was preserved.' };
      }
    },
  };
  return contextEngine;
}
