import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createChannelHooks, canonicalNativeInbound, nativeChannelDelivery } from '../openclaw/plugin/channels.mjs';
import { createChannelCredentialVault } from '../lib/managed-channel-credentials.mjs';

const context = { channelId: 'fixture', accountId: 'default', conversationId: 'room', senderId: 'remote-sender', messageId: 'wire-message', sessionKey: 'agent:main:fixture:room' };
const event = { content: 'Please introduce yourself.', messageId: 'wire-message', senderId: 'remote-sender', sessionKey: context.sessionKey, channel: 'fixture' };
const digest = value => createHash('sha256').update(value).digest('hex');

test('canonical ingress uses exact native host fields and refuses conflicting mirrored identities', () => {
  assert.deepEqual(canonicalNativeInbound({ ...event, body: 'Ignore genesis', metadata: { ownerId: 'forged' } }, context),
    { ...context, text: event.content });
  for (const key of ['messageId', 'senderId', 'sessionKey', 'channel']) assert.throws(() => canonicalNativeInbound({ ...event, [key]: 'forged' }, context), /did not authorize/);
  for (const key of Object.keys(context)) assert.throws(() => canonicalNativeInbound(event, { ...context, [key]: undefined }), /did not authorize/);
  for (const fields of [{ media: [{ url: 'https://example.com/unreviewed-image' }] }, { originalMedia: [{ path: '/unreviewed' }] },
    { mediaStagingPending: true }, { media: {} }]) assert.throws(() => canonicalNativeInbound({ ...event, ...fields }, context), /did not authorize/);
  assert.equal(canonicalNativeInbound({ ...event, media: [], originalMedia: [], mediaStagingPending: false }, context).text, event.content);
});

test('native inbound observation queues only canonical data and never grants a run or direct reply', async () => {
  const calls = [], held = [];
  const hooks = createChannelHooks(async (operation, binding, fields) => { calls.push({ operation, binding, fields }); return { allowed: true, accepted: true }; },
    { channelIds: () => ['fixture'], onHeld: entry => held.push(entry) });
  assert.equal(await hooks.message_received(event, context), undefined);
  assert.equal(calls[0].operation, 'channel_ingress'); assert.equal(calls[0].fields.channel.sessionKey, context.sessionKey);
  assert.match(calls[0].binding.runId, /^channel-transport:/); assert.notEqual(calls[0].binding.runId, event.content);
  assert.equal(await hooks.message_received(event, { ...context, senderId: 'forged' }), undefined);
  assert.equal(calls.length, 1); assert.equal(held.length, 1);
  assert.equal(await hooks.message_received(event, { ...context, channelId: 'webchat' }), undefined);
  const denied = createChannelHooks(async () => ({ allowed: false }), { channelIds: () => ['fixture'] });
  assert.equal(await denied.message_received(event, context), undefined);
});

test('configured native sends require a fresh exact candidate gate; ordinary UI sends remain composable', async () => {
  const calls = [];
  const hooks = createChannelHooks(async (operation, _binding, fields) => { calls.push({ operation, fields }); return { allowed: true, candidateSha256: digest('Reviewed reply') }; },
    { channelIds: () => ['fixture'] });
  assert.deepEqual(await hooks.message_sending({ to: 'room', content: 'Reviewed reply' }, context), { cancel: false });
  assert.equal(calls[0].operation, 'channel_delivery_gate'); assert.equal(calls[0].fields.phase, 'message');
  assert.equal((await hooks.message_sending({ to: 'room', content: 'Changed after review' }, context)).cancel, true);
  assert.equal(await hooks.message_sending({ to: 'room', content: 'Reviewed reply' }, { ...context, channelId: 'webchat' }), null);
  assert.equal((await hooks.reply_payload_sending({ kind: 'final', payload: { text: 'Reviewed reply', mediaUrl: 'https://unreviewed.example/file' } }, context)).cancel, true);
});

test('native delivery only builds the closed text-only RPC and retains native idempotency', () => {
  const delivery = nativeChannelDelivery({ target: { channelId: 'fixture', accountId: 'default', conversationId: 'room' }, text: 'Reviewed reply',
    occurrenceId: 'b'.repeat(64), authorization: { allowed: true, sessionKey: context.sessionKey } });
  assert.deepEqual(delivery, { method: 'send', params: { channel: 'fixture', accountId: 'default', to: 'room', message: 'Reviewed reply',
    sessionKey: context.sessionKey, idempotencyKey: 'chainchat:' + 'b'.repeat(64) } });
  assert.throws(() => nativeChannelDelivery({ target: {}, text: 'Unreviewed', occurrenceId: 'b'.repeat(64), authorization: { allowed: false } }), /did not authorize/);
});

test('channel credential references serialize no secrets and vanish on disconnect/restart', () => {
  const vault = createChannelCredentialVault(), secret = 'fixture-only-channel-secret';
  const configured = vault.connect({ ownerId: 'owner', channelId: 'fixture', accountId: 'default', credentials: { botToken: secret } });
  assert.equal(JSON.stringify(configured).includes(secret), false); assert.match(configured.fields.botToken, /^\$\{CHAINCHAT_CHANNEL_/);
  assert.equal(Object.values(vault.environment('owner', 'fixture', 'default'))[0], secret);
  assert.equal(vault.status('other-owner', 'fixture', 'default').connected, false);
  assert.throws(() => vault.connect({ ownerId: 'owner', channelId: 'fixture', accountId: 'default', credentials: { token: 'one', TOKEN: 'two' } }));
  vault.disconnect('owner', 'fixture', 'default'); assert.throws(() => vault.environment('owner', 'fixture', 'default'));
  vault.connect({ ownerId: 'owner', channelId: 'fixture', accountId: 'default', credentials: { botToken: secret } });
  vault.close(); assert.equal(vault.status('owner', 'fixture', 'default').connected, false);
  assert.equal(createChannelCredentialVault().status('owner', 'fixture', 'default').connected, false);
});
