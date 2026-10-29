import { randomUUID } from "node:crypto";
const MAX_RPC_BYTES = 131072;
const fail = (code, message, status = 503) =>
  Object.assign(new Error(message), { code, status });
export async function rpcResult(fetchImpl, rpcUrl, method, params) {
  const id = randomUUID();
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("RPC HTTP error.");
    const reader = response.body.getReader();
    let length = 0;
    const pieces = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_RPC_BYTES) {
          await reader.cancel();
          throw new Error("Oversized RPC result.");
        }
        pieces.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const data = JSON.parse(Buffer.concat(pieces).toString("utf8"));
    if (
      data.jsonrpc !== "2.0" ||
      data.id !== id ||
      data.error ||
      !("result" in data)
    )
      throw new Error("Invalid RPC result.");
    return data.result;
  } catch {
    throw fail(
      "LICENSE_RPC_UNAVAILABLE",
      "Base license verification is unavailable. No stale license approval was used.",
    );
  }
}

export function quantity(value) {
  if (
    typeof value !== "string" ||
    !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value) ||
    value.length > 66
  )
    throw fail(
      "LICENSE_RPC_INVALID",
      "The Base RPC returned an invalid block value.",
    );
  return BigInt(value);
}
export function words(value, count = 1) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^0x[0-9a-fA-F]{${64 * count}}$`).test(value)
  )
    throw fail(
      "LICENSE_CONTRACT_INVALID",
      "The token or wallet contract returned an invalid value.",
    );
  return value.slice(2).toLowerCase().match(/.{64}/g);
}
