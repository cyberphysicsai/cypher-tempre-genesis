const operations = new Set(['summary', 'rings', 'ring', 'blockspace', 'blob']);
const fields = new Set(['op', 'index', 'offset', 'limit', 'hash']);
export function createAuditParent({ origin, source, context, read, respond }) {
  let pending = 0;
  return async event => {
    if (event.origin !== origin || !event.source || event.source !== source()) return;
    const data = event.data;
    if (data?.type !== 'chainchat-audit:request' || !/^[A-Za-z0-9_-]{1,80}$/.test(data.id || '')) return;
    const send = value => respond(event.source, { type: 'chainchat-audit:response', id: data.id, ...value }, origin);
    const request = data.request;
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        Object.keys(request).some(key => !fields.has(key)) || !operations.has(request.op)) {
      send({ error: 'Only the selected Timechain audit reads are available.' }); return;
    }
    const before = context();
    if (!before.session || !before.agent) { send({ error: 'Connect your app and select a Timechain first.' }); return; }
    if (pending >= 4) { send({ error: 'The auditor is busy. Try again shortly.' }); return; }
    pending++;
    try {
      const result = await read(request);
      const after = context();
      if (after.session !== before.session || after.agent !== before.agent || event.source !== source())
        send({ error: 'The selected app session or Timechain changed. Refresh the auditor.' });
      else send({ result });
    } catch { send({ error: 'The Timechain audit could not be read. Check the app connection and try again.' }); }
    finally { pending--; }
  };
}
