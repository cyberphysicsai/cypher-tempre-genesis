import { validateManagedSchedule } from './managed-automation.mjs';
const fail = () => Object.assign(new Error('Choose a supported operation on this agent’s managed jobs or channels.'), { code: 'MANAGED_SERVICE_SCOPE', status: 403 });
const text = (value, max) => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= max && !value.includes('\0');
export function validateManagedServiceTool(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail();
  const fields = { list: [], list_channels: [], create_job: ['name', 'prompt', 'schedule', 'channelBindingId'], pause: ['kind', 'id'], resume: ['kind', 'id'] };
  if (!Object.hasOwn(fields, input.action) || Object.keys(input).some(key => key !== 'action' && !fields[input.action].includes(key))) throw fail();
  const result = structuredClone(input);
  if (input.action === 'create_job') {
    if (!text(input.name, 256) || !text(input.prompt, 32768) || input.channelBindingId !== undefined && !text(input.channelBindingId, 512)) throw fail();
    result.schedule = validateManagedSchedule(input.schedule);
  }
  if (['pause', 'resume'].includes(input.action) && (!['cron', 'channel'].includes(input.kind) || !text(input.id, 512))) throw fail();
  return result;
}
