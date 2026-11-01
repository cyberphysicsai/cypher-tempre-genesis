/** Native scheduled signals + channel ingress routed through the host's PoI turn.
 * Provider/channel credentials and delivery authorizations never enter this store.
 * native.rpc/subscribe and acceptInbound are private host capabilities, not HTTP APIs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeJSON } from './state.mjs';

const fail = (message, code = 'AUTOMATION_INVALID', status = 400) => Object.assign(new Error(message), { code, status });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0')) throw fail(`A bounded ${label} is required.`);
  return value;
};
const exact = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('Unexpected automation fields.');
};
const ownerBinding = value => {
  exact(value, ['ownerId', 'agentId', 'genesisHash']);
  return { ownerId: text(value.ownerId, 512, 'owner identity'), agentId: text(value.agentId, 512, 'agent identity'),
    genesisHash: /^[a-f0-9]{64}$/.test(value.genesisHash || '') ? value.genesisHash : (() => { throw fail('A verified genesis hash is required.'); })() };
};
const terminal = new Set(['delivered', 'completed', 'rejected', 'revoked', 'uncertain']);
const resumable = new Set(['pending', 'held', 'reviewed']);
export const AUTOMATION_LIMITS = Object.freeze({ jobs: 128, channels: 128, pending: 512, retained: 10000,
  inputBytes: 32768, outputBytes: 131072, minimumIntervalMs: 60000, maximumIntervalMs: 365 * 86400000 });
export const NATIVE_SIGNAL_SOURCE = 'process.stdout.write("NO_REPLY")';

export function validateManagedSchedule(value, now = Date.now()) {
  if (!value || typeof value !== 'object') throw fail('Choose a bounded native schedule.');
  if (value.kind === 'at') {
    exact(value, ['kind', 'at']);
    const timestamp = Date.parse(value.at);
    if (!Number.isFinite(timestamp) || timestamp < now - 1000 || timestamp > now + AUTOMATION_LIMITS.maximumIntervalMs) throw fail('Choose a one-shot time within the next year.');
    return { kind: 'at', at: new Date(timestamp).toISOString() };
  }
  if (value.kind === 'every') {
    exact(value, ['kind', 'everyMs']);
    if (!Number.isSafeInteger(value.everyMs) || value.everyMs < AUTOMATION_LIMITS.minimumIntervalMs || value.everyMs > AUTOMATION_LIMITS.maximumIntervalMs) throw fail('Recurring jobs must run between once a minute and once a year.');
    return { kind: 'every', everyMs: value.everyMs };
  }
  if (value.kind === 'cron') {
    exact(value, ['kind', 'expr', 'tz']);
    // Five fields intentionally omit seconds. The native parser owns cron semantics.
    const expr = text(value.expr, 256, 'five-field cron expression');
    if (expr.trim().split(/\s+/).length !== 5 || !/^[\d\s*/,+?\-LW#A-Za-z]+$/.test(expr)) throw fail('Use a five-field native cron expression.');
    const tz = text(value.tz, 128, 'IANA time zone');
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { throw fail('Choose a valid IANA time zone.'); }
    return { kind: 'cron', expr: expr.trim(), tz };
  }
  throw fail('Only native at, every and five-field cron schedules are admitted.');
}

export function nativeSignalDefinition(job, nodePath) {
  return { name: `ChainChat ${job.id}`, declarationKey: `chainchat-managed:${job.id}`, enabled: false,
    deleteAfterRun: false, agentId: 'main', sessionTarget: 'isolated', wakeMode: 'next-heartbeat',
    schedule: { ...structuredClone(job.schedule), ...(job.schedule.kind === 'every' ? { anchorMs: job.anchorMs } : {}),
      ...(job.schedule.kind === 'cron' ? { staggerMs: 0 } : {}) }, payload: { kind: 'command', argv: [nodePath, '--input-type=module', '-e', NATIVE_SIGNAL_SOURCE],
      timeoutSeconds: 15, noOutputTimeoutSeconds: 10, outputMaxBytes: 64, toolsAllow: [] }, delivery: { mode: 'none' } };
}
function sameNativeDefinition(native, expected) {
  return native && native.declarationKey === expected.declarationKey && native.name === expected.name &&
    native.agentId === 'main' && native.sessionTarget === 'isolated' && native.wakeMode === expected.wakeMode &&
    native.deleteAfterRun === false && isDeepStrictEqual(native.schedule, expected.schedule) &&
    isDeepStrictEqual(native.payload, expected.payload) && isDeepStrictEqual(native.delivery, expected.delivery);
}

export async function createManagedAutomation({ directory, native, checkEligibility, executeTurn, authorizeDelivery, deliver,
  now = Date.now, maximumPending = AUTOMATION_LIMITS.pending } = {}) {
  if (!native || typeof native.rpc !== 'function' || typeof native.subscribe !== 'function' || !path.isAbsolute(native.nodePath || '') ||
      [checkEligibility, executeTurn, authorizeDelivery, deliver].some(callback => typeof callback !== 'function')) throw fail('Managed native automation callbacks are required.');
  const root = path.resolve(directory), filename = path.join(root, 'automation.json');
  if ((await fs.lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isSymbolicLink()) throw fail('Automation state cannot be symlinked.');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(filename).catch(error => { if (error.code !== 'ENOENT') throw error; }))?.isSymbolicLink()) throw fail('Automation state cannot be symlinked.');
  let state;
  try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw fail('Managed automation state needs inspection.', 'AUTOMATION_STORE_INVALID', 409); }
  state ||= { version: 1, jobs: [], channels: [], occurrences: [] };
  if (state.version !== 1 || !['jobs', 'channels', 'occurrences'].every(key => Array.isArray(state[key])) || state.occurrences.length > AUTOMATION_LIMITS.retained)
    throw fail('Managed automation state needs inspection.', 'AUTOMATION_STORE_INVALID', 409);
  for (const occurrence of state.occurrences) {
    // Interrupted executions may have completed host actions; never blindly replay.
    if (['running', 'delivering'].includes(occurrence.status)) Object.assign(occurrence, { status: 'uncertain', reason: 'interrupted_outcome_requires_inspection' });
  }
  for (const job of state.jobs) if (job.target && !job.channelBindingId) {
    // A copied recipient is not continuing permission to use a channel. Older
    // target-only state needs an explicit fresh binding, never inferred authority.
    job.enabled = false; job.reason = 'channel_binding_requires_repair';
  }
  let writes = Promise.resolve(), draining = null, closed = false, drainRequested = false;
  const active = new Map();
  function mutation(callback) {
    const operation = writes.then(async () => { const value = await callback(); await writeJSON(filename, state); return value; });
    writes = operation.catch(() => {}); return operation;
  }
  await mutation(() => {});
  const findOwned = (collection, id, ownerId) => {
    const entry = state[collection].find(item => item.id === id && item.binding.ownerId === ownerId);
    if (!entry) throw fail('Managed automation was not found for this owner.', 'AUTOMATION_NOT_FOUND', 404);
    return entry;
  };
  function currentSource(occurrence) {
    const source = state[occurrence.kind === 'cron' ? 'jobs' : 'channels'].find(item => item.id === occurrence.sourceId);
    if (!source?.enabled || source.revision !== occurrence.revision || hash(source.binding) !== hash(occurrence.binding)) return null;
    if (occurrence.kind === 'cron' && occurrence.target) {
      const channel = state.channels.find(item => item.id === source.channelBindingId);
      if (!channel?.enabled || channel.id !== occurrence.channelBindingId || channel.revision !== occurrence.channelRevision ||
          hash(channel.binding) !== hash(source.binding) || hash(channel.target) !== hash(occurrence.target)) return null;
    }
    return source;
  }
  function assertCurrent(occurrence, controller) {
    if (closed || controller.signal.aborted || !currentSource(occurrence)) throw fail('This automation occurrence was revoked.', 'AUTOMATION_REVOKED', 409);
  }
  async function eligible(occurrence, controller, phase) {
    assertCurrent(occurrence, controller);
    const result = await checkEligibility(structuredClone(occurrence.binding), { phase, source: occurrence.kind, signal: controller.signal });
    assertCurrent(occurrence, controller);
    if (result?.eligible !== true) throw fail('Automation is held until its live owner, verified chain, wallet and provider are eligible.', 'AUTOMATION_HELD', 409);
  }
  async function processOccurrence(occurrence) {
    const controller = new AbortController(); active.set(occurrence.id, controller);
    try {
      await eligible(occurrence, controller, 'before_turn');
      if (!occurrence.result) {
        await mutation(() => { occurrence.status = 'running'; occurrence.reason = null; });
        const result = await executeTurn({ binding: structuredClone(occurrence.binding), input: occurrence.input,
          occurrenceId: occurrence.id, source: occurrence.kind, signal: controller.signal });
        assertCurrent(occurrence, controller);
        if (result?.approved !== true) throw fail('PoI withheld the automation result.', 'AUTOMATION_REVIEW_REJECTED', 422);
        const approvedText = text(result.text, AUTOMATION_LIMITS.outputBytes, 'reviewed automation response');
        await mutation(() => { occurrence.result = { text: approvedText, sha256: hash(approvedText) }; occurrence.status = 'reviewed'; });
      }
      await eligible(occurrence, controller, 'before_delivery');
      if (!occurrence.target) {
        await mutation(() => { occurrence.status = 'completed'; occurrence.completedAt = now(); }); return;
      }
      const authorization = await authorizeDelivery({ binding: structuredClone(occurrence.binding), target: structuredClone(occurrence.target),
        text: occurrence.result.text, occurrenceId: occurrence.id, signal: controller.signal });
      assertCurrent(occurrence, controller);
      if (authorization?.allowed !== true) throw fail('PoI withheld outgoing delivery.', 'AUTOMATION_DELIVERY_REJECTED', 422);
      await eligible(occurrence, controller, 'delivery_commit');
      await mutation(() => { assertCurrent(occurrence, controller); occurrence.status = 'delivering'; });
      // A failed/unknown send is not automatically retried: it may have delivered.
      const receipt = await deliver({ binding: structuredClone(occurrence.binding), target: structuredClone(occurrence.target),
        text: occurrence.result.text, occurrenceId: occurrence.id, authorization, signal: controller.signal });
      await mutation(() => { occurrence.status = receipt?.delivered === true ? 'delivered' : 'uncertain';
        occurrence.reason = receipt?.delivered === true ? null : 'delivery_outcome_requires_inspection'; occurrence.completedAt = now(); });
    } catch (error) {
      await mutation(() => {
        if (occurrence.status === 'delivering') { occurrence.status = 'uncertain'; occurrence.reason = 'delivery_outcome_requires_inspection'; }
        else if (occurrence.status === 'revoked' || !currentSource(occurrence)) { occurrence.status = 'revoked'; occurrence.reason = 'authority_revoked'; }
        else if (['AUTOMATION_REVIEW_REJECTED', 'AUTOMATION_DELIVERY_REJECTED'].includes(error.code)) { occurrence.status = 'rejected'; occurrence.reason = 'poi_withheld'; }
        else { occurrence.status = 'held'; occurrence.reason = 'live_admission_unavailable'; }
      });
    } finally { controller.abort(); active.delete(occurrence.id); }
  }
  async function drain() {
    if (closed) return;
    if (draining) { drainRequested = true; return draining; }
    draining = (async () => {
      // Each wake considers each occurrence once, preventing a held-work spin loop.
      const attempted = new Set();
      do {
        drainRequested = false;
        const candidates = state.occurrences.filter(item => resumable.has(item.status) && !attempted.has(item.id)).map(item => item.id);
        for (const id of candidates) {
          if (closed) break;
          attempted.add(id);
          const occurrence = state.occurrences.find(item => item.id === id);
          if (occurrence && resumable.has(occurrence.status)) await processOccurrence(occurrence);
        }
      } while (!closed && drainRequested);
    })().finally(() => { draining = null; });
    return draining;
  }
  function enqueue(fields) {
    return mutation(() => {
      const duplicate = state.occurrences.find(item => item.id === fields.id);
      if (duplicate) return { accepted: true, duplicate: true, id: duplicate.id, status: duplicate.status };
      if (state.occurrences.length >= AUTOMATION_LIMITS.retained || state.occurrences.filter(item => !terminal.has(item.status)).length >= maximumPending)
        throw fail('The durable automation queue is full; keep the source event pending.', 'AUTOMATION_QUEUE_FULL', 503);
      state.occurrences.push({ ...fields, status: 'pending', reason: null, createdAt: now() });
      return { accepted: true, duplicate: false, id: fields.id, status: 'pending' };
    });
  }
  async function consumeCron(event) {
    if (event?.action !== 'finished' || event.status !== 'ok' || !Number.isSafeInteger(event.runAtMs) || event.runAtMs < 1) return;
    const job = state.jobs.find(item => item.nativeId === event.jobId && item.enabled);
    if (!job || event.runAtMs < job.activatedAt) return;
    const actual = await native.rpc('cron.get', { id: job.nativeId });
    if (!sameNativeDefinition(actual.job || actual, nativeSignalDefinition(job, native.nodePath))) {
      await mutation(() => { job.enabled = false; job.reason = 'native_definition_changed'; });
      await native.rpc('cron.update', { id: job.nativeId, patch: { enabled: false } }); return;
    }
    try {
      await enqueue({ id: hash(['cron', job.id, event.runAtMs]), kind: 'cron', sourceId: job.id,
        revision: job.revision, binding: structuredClone(job.binding), input: job.prompt, target: job.target,
        ...(job.target ? { channelBindingId: job.channelBindingId, channelRevision: state.channels.find(item => item.id === job.channelBindingId)?.revision } : {}),
        nativeRunId: `cron:${event.jobId}:${event.runAtMs}` });
    } catch (error) {
      if (error.code !== 'AUTOMATION_QUEUE_FULL') throw error;
      // Native run history retains the unaccepted signal for later reconciliation.
      await mutation(() => { job.reason = 'native_history_pending_queue_capacity'; job.nativePaused = true; });
      await native.rpc('cron.update', { id: job.nativeId, patch: { enabled: false } }); return;
    }
    void drain();
  }
  async function auditScheduler() {
    const audited = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const page = await native.rpc('cron.list', { includeDisabled: true, limit: 200, offset });
      const jobs = page.jobs;
      if (!Array.isArray(jobs) || jobs.length > 200) throw fail('The native scheduler inventory needs inspection.', 'AUTOMATION_SCHEDULER_HELD', 409);
      for (const nativeJob of jobs) {
        const owned = state.jobs.find(job => job.nativeId === nativeJob.id);
        const managed = owned && sameNativeDefinition(nativeJob, nativeSignalDefinition(owned, native.nodePath));
        const inertMonitor = nativeJob.enabled === false && nativeJob.declarationKey === 'heartbeat:main' && nativeJob.agentId === 'main' &&
          nativeJob.sessionTarget === 'main' && nativeJob.wakeMode === 'next-heartbeat' && isDeepStrictEqual(nativeJob.payload, { kind: 'heartbeat' });
        if (nativeJob.enabled && (!managed || !owned.enabled)) {
          // Unknown commands/scripts/agent turns never get a chance to run merely
          // because the wrapper enabled its scheduler. Preserve them disabled.
          await native.rpc('cron.update', { id: text(nativeJob.id, 512, 'native job identity'), patch: { enabled: false } });
          const checked = await native.rpc('cron.get', { id: nativeJob.id });
          if ((checked.job || checked).enabled !== false) throw fail('An unmanaged native job could not be held.', 'AUTOMATION_SCHEDULER_HELD', 409);
          if (owned && !managed) await mutation(() => { owned.enabled = false; owned.reason = 'native_definition_changed'; });
          audited.push({ nativeId: nativeJob.id, disposition: 'quarantined_unadmitted' });
        } else audited.push({ nativeId: nativeJob.id, disposition: inertMonitor ? 'known_inert_heartbeat_monitor' : managed ? 'managed_signal' : 'unmanaged_disabled' });
      }
      if (jobs.length < 200 || page.hasMore === false) {
        await mutation(() => { state.schedulerAudit = { at: now(), jobs: audited }; }); return structuredClone(state.schedulerAudit);
      }
    }
    throw fail('The bounded native scheduler audit is incomplete; activation remains held.', 'AUTOMATION_SCHEDULER_HELD', 409);
  }
  // The caller keeps global native cron disabled until this initial audit succeeds.
  await auditScheduler();
  const unsubscribe = native.subscribe(event => { if (event?.event === 'cron') void consumeCron(event.payload).catch(() => {}); });
  return {
    auditScheduler,
    async bindChannel(binding, definition) {
      binding = ownerBinding(binding); exact(definition, ['channelId', 'accountId', 'conversationId', 'allowSenders', 'name']);
      if (!Array.isArray(definition.allowSenders) || !definition.allowSenders.length || definition.allowSenders.length > 100) throw fail('Choose an explicit channel sender allowlist.');
      const target = { channelId: text(definition.channelId, 128, 'channel'), accountId: text(definition.accountId, 128, 'channel account'),
        conversationId: text(definition.conversationId, 512, 'conversation') };
      return mutation(() => {
        if (state.channels.length >= AUTOMATION_LIMITS.channels) throw fail('The channel binding limit was reached.');
        const entry = { id: randomUUID(), binding, target, allowSenders: [...new Set(definition.allowSenders.map(value => text(value, 512, 'sender identity')))],
          name: text(definition.name, 256, 'channel name'), enabled: true, revision: 1, createdAt: now() };
        state.channels.push(entry); return structuredClone(entry);
      });
    },
    async acceptInbound(event) {
      exact(event, ['channelId', 'accountId', 'conversationId', 'senderId', 'messageId', 'text']);
      const target = { channelId: text(event.channelId, 128, 'channel'), accountId: text(event.accountId, 128, 'channel account'),
        conversationId: text(event.conversationId, 512, 'conversation') };
      const senderId = text(event.senderId, 512, 'sender identity'), messageId = text(event.messageId, 512, 'message identity');
      const matches = state.channels.filter(entry => entry.enabled && hash(entry.target) === hash(target) && entry.allowSenders.includes(senderId));
      if (matches.length !== 1) throw fail('No unique authorized Timechain is bound to this channel sender.', 'AUTOMATION_INGRESS_DENIED', 403);
      const source = matches[0];
      const accepted = await enqueue({ id: hash(['channel', target, messageId]), kind: 'channel', sourceId: source.id,
        revision: source.revision, binding: structuredClone(source.binding), input: text(event.text, AUTOMATION_LIMITS.inputBytes, 'incoming message'), target });
      void drain(); return accepted;
    },
    async createJob(binding, definition) {
      binding = ownerBinding(binding); exact(definition, ['name', 'prompt', 'schedule', 'channelBindingId']);
      let target = null;
      if (definition.channelBindingId) {
        const channel = findOwned('channels', definition.channelBindingId, binding.ownerId);
        if (!channel.enabled || hash(channel.binding) !== hash(binding)) throw fail('The outgoing channel must bind the same verified Timechain.');
        target = structuredClone(channel.target);
      }
      const entry = { id: randomUUID(), binding, name: text(definition.name, 256, 'job name'), prompt: text(definition.prompt, AUTOMATION_LIMITS.inputBytes, 'scheduled request'),
        schedule: validateManagedSchedule(definition.schedule, now()), target, channelBindingId: definition.channelBindingId || null,
        revision: 1, enabled: false, activatedAt: now(), anchorMs: now(), nativeId: null, reason: 'provisioning' };
      await mutation(() => { if (state.jobs.length >= AUTOMATION_LIMITS.jobs) throw fail('The scheduled job limit was reached.'); state.jobs.push(entry); });
      const added = await native.rpc('cron.add', nativeSignalDefinition(entry, native.nodePath));
      const nativeId = text(added.id || added.job?.id, 512, 'native job identity');
      await mutation(() => { entry.nativeId = nativeId; entry.enabled = true; entry.reason = null; entry.activatedAt = now(); });
      try { await native.rpc('cron.update', { id: nativeId, patch: { enabled: true } }); }
      catch (error) { await mutation(() => { entry.enabled = false; entry.reason = 'native_enable_failed'; }); throw error; }
      return structuredClone(entry);
    },
    async setEnabled(ownerId, kind, id, enabled) {
      if (!['cron', 'channel'].includes(kind) || typeof enabled !== 'boolean') throw fail('Choose a managed job/channel state.');
      const source = findOwned(kind === 'cron' ? 'jobs' : 'channels', id, ownerId);
      if (enabled && kind === 'cron' && source.target) {
        const channel = state.channels.find(item => item.id === source.channelBindingId);
        if (!channel?.enabled || hash(channel.binding) !== hash(source.binding) || hash(channel.target) !== hash(source.target))
          throw fail('Choose an enabled exact channel binding and recreate this schedule before resuming delivery.', 'AUTOMATION_CHANNEL_REQUIRED', 409);
      }
      await mutation(() => { source.enabled = enabled; source.revision++; source.reason = enabled ? null : 'owner_paused'; source.activatedAt = now();
        for (const occurrence of state.occurrences) if ((occurrence.sourceId === id || occurrence.channelBindingId === id) && !terminal.has(occurrence.status)) {
          active.get(occurrence.id)?.abort(); occurrence.status = 'revoked'; occurrence.reason = 'source_revision_changed';
        } });
      if (kind === 'cron' && source.nativeId) await native.rpc('cron.update', { id: source.nativeId, patch: { enabled } });
      return structuredClone(source);
    },
    async holdOwner(ownerId) {
      for (const occurrence of state.occurrences) if (occurrence.binding.ownerId === ownerId) active.get(occurrence.id)?.abort();
      await writes;
    },
    async reconcile() {
      for (const job of state.jobs.filter(item => item.enabled && item.nativeId)) {
        const recovered = [];
        for (let offset = 0; offset < 10000; offset += 200) {
          const page = await native.rpc('cron.runs', { id: job.nativeId, limit: 200, offset });
          const entries = page.entries || page.runs || [];
          recovered.push(...entries);
          if (entries.length < 200 || page.hasMore === false) break;
          if (offset === 9800) throw fail('Native run history exceeds this bounded reconciliation; pending work is retained.', 'AUTOMATION_HISTORY_HELD', 409);
        }
        for (const event of recovered.reverse()) await consumeCron({ ...event, jobId: job.nativeId, action: 'finished' });
        if (job.nativePaused && state.occurrences.filter(item => !terminal.has(item.status)).length < maximumPending) {
          await native.rpc('cron.update', { id: job.nativeId, patch: { enabled: true } });
          await mutation(() => { job.nativePaused = false; job.reason = null; });
        }
      }
      await drain();
    },
    async wake() { return drain(); },
    async status(ownerId) { await writes; return structuredClone({ jobs: state.jobs.filter(item => item.binding.ownerId === ownerId),
      channels: state.channels.filter(item => item.binding.ownerId === ownerId), occurrences: state.occurrences.filter(item => item.binding.ownerId === ownerId) }); },
    async close() { closed = true; unsubscribe?.(); for (const controller of active.values()) controller.abort(); await draining; await writes; },
  };
}
