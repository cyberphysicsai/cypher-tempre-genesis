/** Native chat access to owner-bound managed schedules and channel bindings. */
export const MANAGED_SERVICES_TOOL = 'chainchat_automation';
const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const closed = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const schedule = { oneOf: [closed({ kind: { const: 'at' }, at: string(100) }, ['kind', 'at']),
  closed({ kind: { const: 'every' }, everyMs: { type: 'integer', minimum: 60000, maximum: 31536000000 } }, ['kind', 'everyMs']),
  closed({ kind: { const: 'cron' }, expr: string(256), tz: string(128) }, ['kind', 'expr', 'tz'])] };
export const MANAGED_SERVICES_SCHEMA = { oneOf: [
  closed({ action: { enum: ['list', 'list_channels'] } }, ['action']),
  closed({ action: { const: 'create_job' }, name: string(256), prompt: string(32768), schedule, channelBindingId: string(512) }, ['action', 'name', 'prompt', 'schedule']),
  closed({ action: { enum: ['pause', 'resume'] }, kind: { enum: ['cron', 'channel'] }, id: string(512) }, ['action', 'kind', 'id']),
] };
const denied = () => new Error('Proof of Interaction did not authorize this managed automation operation.');

export function managedServicesFactory(request) {
  if (typeof request !== 'function') throw new TypeError('Private managed-service transport is required.');
  return { contextVersion: 2, create(context) {
    if (typeof context?.sessionKey !== 'string' || typeof context.assertInvocationCurrent !== 'function') throw denied();
    return { name: MANAGED_SERVICES_TOOL, label: 'Reviewed jobs and channels', parameters: MANAGED_SERVICES_SCHEMA,
      description: 'List this paired agent’s managed jobs or channel bindings; create a bounded scheduled prompt; pause or resume an existing owned job/channel by ID. Every action requires fresh PoI approval. Only already owner-authorized channel bindings may receive results. This grants no arbitrary cron commands, recipients, provider credentials or plugin installation.',
      async execute(toolCallId, params, signal) {
        if (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 512 || !params || typeof params !== 'object' || Array.isArray(params)) throw denied();
        signal?.throwIfAborted(); context.assertInvocationCurrent();
        const response = await request('managed_service_execute', { sessionKey: context.sessionKey, runId: toolCallId }, { params }, signal);
        if (response?.allowed !== true || !Object.hasOwn(response, 'result')) throw denied();
        signal?.throwIfAborted(); context.assertInvocationCurrent();
        return { content: [{ type: 'text', text: JSON.stringify(response.result) }], details: response.result };
      } };
  } };
}
