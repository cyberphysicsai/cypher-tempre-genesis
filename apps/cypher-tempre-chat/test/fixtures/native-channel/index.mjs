// First-party native integration fixture. It can contact numeric loopback only.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createChatChannelPlugin, createChannelPluginBase } from 'openclaw/plugin-sdk/channel-core';
const channelId = 'chainchat-fixture', secret = randomBytes(32).toString('hex');
const equal = value => typeof value === 'string' && value.length === secret.length && timingSafeEqual(Buffer.from(value), Buffer.from(secret));
export function register(api) {
  const url = new URL(api.pluginConfig.sinkUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) throw new Error('Fixture transport requires numeric loopback.');
  const plugin = createChatChannelPlugin({
    base: createChannelPluginBase({ id: channelId,
      config: { listAccountIds: () => ['default'], resolveAccount: (_cfg, accountId) => ({ accountId: accountId || 'default', enabled: true, configured: true }),
        inspectAccount: () => ({ enabled: true, configured: true }) },
      setup: { applyAccountConfig: ({ cfg }) => cfg },
    }),
    outbound: { attachedResults: { channel: channelId, sendText: async ({ to, text }) => {
      const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' }, body: JSON.stringify({ to, text }) });
      if (!response.ok) throw new Error('Fixture sink refused delivery.'); return { messageId: (await response.json()).id };
    } } },
  });
  api.registerChannel({ plugin });
  api.registerGatewayMethod('chainchatFixture.credentials', async ({ respond }) => { respond(true, { secret }); });
  api.registerHttpRoute({ path: '/chainchat-fixture/inbound', auth: 'plugin', handler: async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || !equal(String(req.headers.authorization || '').replace(/^Bearer /, ''))) { res.statusCode = 403; res.end('{}'); return true; }
    let raw = ''; for await (const part of req) { raw += part; if (Buffer.byteLength(raw) > 32768) { res.statusCode = 413; res.end('{}'); return true; } }
    let message; try { message = JSON.parse(raw); } catch { res.statusCode = 400; res.end('{}'); return true; }
    if (!message || Object.keys(message).some(key => !['id', 'sender', 'text'].includes(key)) || ['id', 'sender', 'text'].some(key => typeof message[key] !== 'string' || !message[key])) {
      res.statusCode = 400; res.end('{}'); return true;
    }
    const context = api.runtime.channel.inbound.buildContext({ channel: channelId, accountId: 'default', provider: channelId, surface: channelId,
      messageId: message.id, from: message.sender, sender: { id: message.sender }, conversation: { kind: 'direct', id: 'room' },
      route: { agentId: 'main', accountId: 'default', routeSessionKey: 'agent:main:chainchat-fixture:direct:room' }, reply: { to: 'room' },
      message: { rawBody: message.text, body: message.text }, channelIngress: 'unsupported' });
    await api.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({ ctx: context, cfg: api.config,
      dispatcherOptions: { deliver: async () => { throw new Error('Unreviewed fixture direct reply must never deliver.'); } } });
    res.end('{"accepted":true}'); return true;
  } });
}
export default { id: 'chainchat-fixture', name: 'ChainChat local native test channel', register };
