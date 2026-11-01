/** Canonical native-channel interception. Import/compose from the mandatory plugin.
 * Broker operations are private transport operations, never model invocation grants.
 */
import { createHash, randomUUID } from 'node:crypto';

const DENIED = 'Proof of Interaction did not authorize this channel operation.';
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const bounded = (value, maximum) => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= maximum && !value.includes('\0');
const deny = () => { throw new Error(DENIED); };
function equalMirror(event, context, eventKey, contextKey = eventKey) {
  if (event[eventKey] !== undefined && context[contextKey] !== undefined && event[eventKey] !== context[contextKey]) deny();
}
export function canonicalNativeInbound(event = {}, context = {}) {
  for (const name of ['messageId', 'senderId', 'sessionKey']) equalMirror(event, context, name);
  equalMirror(event, context, 'channel', 'channelId');
  for (const [name, maximum] of [['channelId', 128], ['accountId', 128], ['conversationId', 512], ['senderId', 512], ['messageId', 512], ['sessionKey', 2048]])
    if (!bounded(context[name], maximum)) deny();
  if (!bounded(event.content, 32768)) deny();
  // Never derive authority from event.body, metadata, owner flags or message text.
  return { channelId: context.channelId, accountId: context.accountId, conversationId: context.conversationId,
    senderId: context.senderId, messageId: context.messageId, sessionKey: context.sessionKey, text: event.content };
}
export function canonicalNativeOutgoing(event = {}, context = {}) {
  for (const [name, maximum] of [['channelId', 128], ['accountId', 128], ['sessionKey', 2048]]) if (!bounded(context[name], maximum)) deny();
  if (!bounded(event.to, 512) || !bounded(event.content, 131072)) deny();
  return { channelId: context.channelId, accountId: context.accountId, sessionKey: context.sessionKey,
    to: event.to, ...(bounded(context.conversationId, 512) ? { conversationId: context.conversationId } : {}),
    text: event.content, candidateSha256: hash(event.content) };
}

export function createChannelHooks(request, { channelIds = () => [], onHeld = () => {} } = {}) {
  if (typeof request !== 'function' || typeof channelIds !== 'function') throw new TypeError('Private channel admission callbacks are required.');
  const enabled = context => typeof context?.channelId === 'string' && channelIds().includes(context.channelId);
  const binding = sessionKey => ({ sessionKey, runId: 'channel-transport:' + randomUUID() });
  return {
    async before_dispatch(event, context = {}) {
      if (!enabled(context)) return { handled: false };
      try {
        const channel = canonicalNativeInbound(event, context);
        const result = await request('channel_ingress', binding(channel.sessionKey), { channel });
        if (result?.allowed !== true || result.accepted !== true) deny();
      } catch { onHeld({ kind: 'ingress', reason: 'channel_admission_held' }); }
      // Never let an unregistered native model run or synthetic direct reply escape.
      return { handled: true };
    },
    async message_sending(event, context = {}) {
      if (!enabled(context)) return null; // Compose with the ordinary PoI sender.
      try {
        const channel = canonicalNativeOutgoing(event, context);
        const result = await request('channel_delivery_gate', binding(channel.sessionKey), { channel, phase: 'message' });
        if (result?.allowed !== true || result.candidateSha256 !== channel.candidateSha256) deny();
        return { cancel: false };
      } catch { onHeld({ kind: 'outgoing', reason: 'channel_delivery_held' }); return { cancel: true, cancelReason: DENIED }; }
    },
    async reply_payload_sending(event, context = {}) {
      if (!enabled(context)) return null;
      try {
        if (event.kind !== 'final' || !event.payload || !bounded(event.payload.text, 131072) || Object.entries(event.payload).some(([key, value]) =>
          ['mediaUrl', 'mediaUrls', 'channelData', 'buttons', 'audioAsVoice', 'attachments'].includes(key) && value)) deny();
        const channel = canonicalNativeOutgoing({ content: event.payload.text, to: context.conversationId }, context);
        const result = await request('channel_delivery_gate', binding(channel.sessionKey), { channel, phase: 'payload' });
        if (result?.allowed !== true || result.candidateSha256 !== channel.candidateSha256) deny();
        return { cancel: false };
      } catch { return { cancel: true, reason: DENIED }; }
    },
  };
}

/** Closed native `send` RPC shape. The caller must register a fresh server-owned
 * delivery claim before using this result; the private service validator and
 * mandatory channel_delivery_gate both validate that same claim/target/text.
 */
export function nativeChannelDelivery({ target, text, occurrenceId, authorization } = {}) {
  if (!target || !bounded(target.channelId, 128) || !bounded(target.accountId, 128) || !bounded(target.conversationId, 512) ||
      !bounded(text, 131072) || !/^[a-f0-9]{64}$/.test(occurrenceId || '') || authorization?.allowed !== true ||
      !bounded(authorization.sessionKey, 2048)) deny();
  const to = target.to ?? target.conversationId;
  if (!bounded(to, 512)) deny();
  return { method: 'send', params: { channel: target.channelId, accountId: target.accountId, to, message: text,
    sessionKey: authorization.sessionKey, idempotencyKey: 'chainchat:' + occurrenceId } };
}
