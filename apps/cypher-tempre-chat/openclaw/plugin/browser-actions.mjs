/** Pure compound expansion shared by the native wrapper and private host broker. */
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function expandBrowserActions(input) {
  if (!plain(input)) throw new Error('A native browser action object is required.');
  const request = input.request || input;
  if (input.action === 'act' && request.kind === 'fill' && Array.isArray(request.fields) && request.fields.length > 1) {
    if (request.fields.length > 20) throw new Error('Form fills require at most 20 individually admitted fields.');
    return request.fields.map(field => ({ action: 'act', ...(input.targetId ? { targetId: input.targetId } : {}),
      request: { kind: 'fill', fields: [structuredClone(field)] } }));
  }
  if (input.action !== 'act' || request.kind !== 'batch') return [structuredClone(input)];
  if (!Array.isArray(request.actions) || !request.actions.length || request.actions.length > 20) throw new Error('A browser batch requires 1–20 explicit actions.');
  const expanded = request.actions.flatMap(action => {
    if (!plain(action) || action.kind === 'batch') throw new Error('Nested browser batches are denied.');
    return expandBrowserActions({ action: 'act', ...(input.targetId ? { targetId: input.targetId } : {}), request: structuredClone(action) });
  });
  if (expanded.length > 40) throw new Error('A browser batch requires at most 40 individually admitted actions.');
  return expanded;
}
