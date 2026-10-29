// This module only requests account access and a scoped sign-in signature.
// It never requests a transfer, approval, permit, or transaction.
export const CPHY_TOKEN = "0x08df470d41c11ba5cb60242747d76c65ca52c94c";
export const CPHY_MINIMUM = "21000000000000000000000";
const isAddress = (value) => /^0x[0-9a-f]{40}$/i.test(value || "");
const isKey = (value) => /^0x[0-9a-f]{64}$/i.test(value || "");
export function freshChallenge() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0")).join("");
}
export function validateHoldingsConfig(config) {
  let rpc;
  try { rpc = new URL(config?.rpcUrl); } catch {}
  if (config?.mode !== "holdings" || typeof config.required !== "boolean" ||
      config.chainId !== 8453 || String(config.token).toLowerCase() !== CPHY_TOKEN ||
      config.minimumBalance !== CPHY_MINIMUM || config.decimals !== 18 ||
      !Number.isInteger(config.confirmations) || config.confirmations < 2 || config.confirmations > 128 ||
      !Number.isInteger(config.sessionTtlMs) || config.sessionTtlMs < 60000 || config.sessionTtlMs > 1800000 ||
      !rpc || rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash)
    throw new Error("The CPHY holdings configuration is invalid. Update ChainChat before verifying a wallet.");
  return config;
}
export function matchingConfiguration(expected, actual) {
  try { validateHoldingsConfig(expected); } catch { return false; }
  if (!actual) return false;
  const fields = ["mode", "chainId", "required", "token", "minimumBalance", "decimals", "confirmations", "sessionTtlMs"];
  return fields.every((field) => String(expected[field]).toLowerCase() === String(actual[field]).toLowerCase()) &&
    new URL(expected.rpcUrl).origin === actual.rpcOrigin;
}
export async function verifyBridgeIdentity(info, challenge, origin) {
  const fail = () => { throw new Error("The paired bridge's holdings proof could not be verified. Reconnect your bridge."); };
  if (!/^[0-9a-f]{64}$/i.test(challenge) || info?.proof?.challenge !== challenge ||
      info.proof.algorithm !== "Ed25519") return fail();
  try {
    const decode = (value) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    const digest = async (value) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const jsonDigest = (value) => digest(new TextEncoder().encode(JSON.stringify(value)));
    const publicKey = decode(info.publicKeySPKI), message = JSON.parse(info.proof.message);
    if ("0x" + (await digest(publicKey)) !== info.deviceKey ||
        message.purpose !== "cypher-tempre-holdings" || message.origin !== origin ||
        message.challenge !== challenge || message.deviceKey !== info.deviceKey ||
        message.status !== info.status || message.selectedOwner !== info.selectedOwner ||
        !Number.isFinite(message.issuedAt) || Math.abs(Date.now() - message.issuedAt) > 60000 ||
        message.configurationSha256 !== await jsonDigest(info.configuration) ||
        message.verificationSha256 !== await jsonDigest(info.verification ?? null) ||
        message.sessionSha256 !== await jsonDigest(info.session ?? null)) return fail();
    const key = await crypto.subtle.importKey("spki", publicKey, { name: "Ed25519" }, false, ["verify"]);
    if (!await crypto.subtle.verify({ name: "Ed25519" }, key, decode(info.proof.signature),
      new TextEncoder().encode(info.proof.message))) return fail();
    return true;
  } catch { return fail(); }
}

export function watchWallet(wallet, onInvalidated = () => {}) {
  let invalidated = false;
  const changed = () => { if (!invalidated) { invalidated = true; onInvalidated(); } };
  wallet.on?.("accountsChanged", changed);
  wallet.on?.("chainChanged", changed);
  wallet.on?.("disconnect", changed);
  return {
    async check(address) {
      if (invalidated) throw new Error("Wallet account or network changed. Verify holdings again.");
      const [chain, accounts] = await Promise.all([
        wallet.request({ method: "eth_chainId" }), wallet.request({ method: "eth_accounts" }),
      ]);
      if (invalidated || typeof chain !== "string" || chain.toLowerCase() !== "0x2105" ||
          accounts?.[0]?.toLowerCase() !== address.toLowerCase()) {
        changed();
        throw new Error("Wallet account or network changed. Verify holdings again.");
      }
    },
    close() {
      wallet.removeListener?.("accountsChanged", changed);
      wallet.removeListener?.("chainChanged", changed);
      wallet.removeListener?.("disconnect", changed);
    },
  };
}

export function validateSignInRequest(request, { origin, address, deviceKey, config, now = Date.now() }) {
  const fail = () => { throw new Error("The bridge requested an unexpected wallet signature. No signature was requested from your wallet."); };
  const issuedAt = Date.parse(request?.issuedAt);
  if (!isAddress(address) || !isKey(deviceKey) || !request ||
      request.origin !== origin || request.uri !== `${origin}/` || request.chainId !== 8453 ||
      !isAddress(request.address) || request.address.toLowerCase() !== address.toLowerCase() ||
      request.deviceKey !== deviceKey || !/^[a-f0-9]{32}$/i.test(request.requestId || "") ||
      !/^[a-f0-9]{64}$/i.test(request.nonce || "") || !/^[a-f0-9]{64}$/i.test(request.sessionBinding || "") ||
      !Number.isFinite(issuedAt) || Math.abs(now - issuedAt) > 60000 ||
      new Date(issuedAt).toISOString() !== request.issuedAt ||
      !Number.isFinite(request.expiresAt) || request.expiresAt <= now ||
      !Number.isInteger(config?.sessionTtlMs) || config.sessionTtlMs > 1800000 || config.sessionTtlMs < 60000 ||
      request.expiresAt !== issuedAt + config.sessionTtlMs ||
      !Number.isFinite(request.challengeExpiresAt) || request.challengeExpiresAt <= now ||
      request.challengeExpiresAt <= issuedAt || request.challengeExpiresAt - issuedAt > 300000) return fail();
  const page = new URL(origin);
  const authority = `${page.protocol === "http:" ? "http://" : ""}${page.host}`;
  const expected = `${authority} wants you to sign in with your Ethereum account:\n${request.address}\n\nUnlock Cypher Tempre ChainChat by proving control of this wallet. No transaction, token transfer, or approval.\n\nURI: ${origin}/\nVersion: 1\nChain ID: 8453\nNonce: ${request.nonce}\nIssued At: ${request.issuedAt}\nExpiration Time: ${new Date(request.expiresAt).toISOString()}\nRequest ID: ${request.requestId}\nResources:\n- urn:cypher-tempre:device:${deviceKey}\n- urn:cypher-tempre:session:${request.sessionBinding}`;
  if (request.message !== expected) return fail();
  return expected;
}

export async function verifyHoldingsWithWallet({ wallet, config, origin, deviceKey, api,
  report = () => {}, onInvalidated = () => {}, signal }) {
  validateHoldingsConfig(config);
  if (!config.required) throw new Error("Wallet verification is disabled in this local test configuration.");
  if (!wallet?.request) throw new Error("Open ChainChat in a browser with an Ethereum-compatible wallet, then connect on Base.");
  if (!isKey(deviceKey)) throw new Error("Verify your local bridge identity first.");
  const abort = () => {
    if (signal?.aborted) throw new Error("Wallet verification was cancelled. No tokens were moved.");
  };
  abort();
  report("Choose your CPHY wallet on Base. No payment or token approval will be requested.");
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  const address = accounts?.[0];
  if (!isAddress(address)) throw new Error("The wallet did not provide a valid account.");
  const chain = await wallet.request({ method: "eth_chainId" });
  if (typeof chain !== "string" || chain.toLowerCase() !== "0x2105")
    throw new Error("Switch your wallet to Base, then choose Verify holdings again.");
  const guard = watchWallet(wallet, onInvalidated);
  let attemptedVerification = false;
  try {
    abort();
    await guard.check(address);
    const request = await api("/api/license/challenge", { address });
    const message = validateSignInRequest(request, { origin, address, deviceKey, config });
    abort();
    await guard.check(address);
    report("Review the ChainChat sign-in message in your wallet. It grants no token-spending permission.");
    const hexMessage = "0x" + [...new TextEncoder().encode(message)]
      .map((n) => n.toString(16).padStart(2, "0")).join("");
    const signature = await wallet.request({ method: "personal_sign", params: [hexMessage, address] });
    if (typeof signature !== "string" || !/^0x(?:[a-f0-9]{2})+$/i.test(signature) || signature.length > 32770)
      throw new Error("The wallet returned an invalid sign-in signature.");
    abort();
    await guard.check(address);
    const challenge = freshChallenge();
    attemptedVerification = true;
    report("Checking your signature and confirmed CPHY balance on Base…");
    const info = await api("/api/license/verify", {
      requestId: request.requestId, message, signature, challenge,
    });
    abort();
    await guard.check(address);
    await verifyBridgeIdentity(info, challenge, origin);
    if (!matchingConfiguration(config, info.configuration) || info.deviceKey !== deviceKey ||
        info.selectedOwner?.toLowerCase() !== address.toLowerCase())
      throw new Error("The website and paired bridge did not agree on this wallet verification.");
    return { ...info, identityVerified: true };
  } catch (error) {
    // A late account change, cancellation, or failed proof must not leave a grant behind.
    if (attemptedVerification) await api("/api/license/logout", {}).catch(() => {});
    throw error;
  } finally { guard.close(); }
}
