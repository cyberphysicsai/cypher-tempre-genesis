import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  CPHY_TOKEN, CPHY_MINIMUM, validateHoldingsConfig, matchingConfiguration,
  validateSignInRequest, verifyBridgeIdentity, verifyHoldingsWithWallet, watchWallet,
} from "../public/holdings-wallet.js";

const origin = "https://cyphertempre.ai", address = "0x" + "44".repeat(20);
const config = {
  mode: "holdings", required: true, chainId: 8453, token: CPHY_TOKEN,
  minimumBalance: CPHY_MINIMUM, decimals: 18, confirmations: 2,
  sessionTtlMs: 1800000, rpcUrl: "https://mainnet.base.org",
};
const configuration = { ...config, rpcOrigin: "https://mainnet.base.org" };
delete configuration.rpcUrl;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ type: "spki", format: "der" });
const hash = (data) => createHash("sha256").update(data).digest("hex");
const deviceKey = "0x" + hash(spki);

function challengeRequest(overrides = {}) {
  const now = Date.now();
  const request = {
    address, origin, uri: origin + "/", chainId: 8453,
    requestId: "ab".repeat(16), nonce: "cd".repeat(32),
    issuedAt: new Date(now).toISOString(), expiresAt: now + config.sessionTtlMs,
    challengeExpiresAt: now + 300000, deviceKey, sessionBinding: "ef".repeat(32),
    ...overrides,
  };
  const page = new URL(request.origin);
  const authority = `${page.protocol === "http:" ? "http://" : ""}${page.host}`;
  request.message = `${authority} wants you to sign in with your Ethereum account:\n${request.address}\n\nUnlock Cypher Tempre ChainChat by proving control of this wallet. No transaction, token transfer, or approval.\n\nURI: ${request.uri}\nVersion: 1\nChain ID: ${request.chainId}\nNonce: ${request.nonce}\nIssued At: ${request.issuedAt}\nExpiration Time: ${new Date(request.expiresAt).toISOString()}\nRequest ID: ${request.requestId}\nResources:\n- urn:cypher-tempre:device:${request.deviceKey}\n- urn:cypher-tempre:session:${request.sessionBinding}`;
  return request;
}
function signedInfo(challenge, overrides = {}) {
  const now = Date.now();
  const info = {
    deviceKey, publicKeySPKI: spki.toString("base64"), selectedOwner: address,
    status: "active", configuration,
    verification: { wallet: address, balance: CPHY_MINIMUM, checkedAt: now, expiresAt: now + 30000 },
    session: { wallet: address, walletType: "eoa", authenticatedAt: now, expiresAt: now + 1800000 },
    ...overrides,
  };
  const message = JSON.stringify({
    purpose: "cypher-tempre-holdings", origin, challenge, nonce: "ff".repeat(32),
    issuedAt: now, deviceKey: info.deviceKey, selectedOwner: info.selectedOwner,
    status: info.status,
    configurationSha256: hash(JSON.stringify(info.configuration)),
    verificationSha256: hash(JSON.stringify(info.verification ?? null)),
    sessionSha256: hash(JSON.stringify(info.session ?? null)),
  });
  info.proof = { algorithm: "Ed25519", challenge, message,
    signature: sign(null, Buffer.from(message), privateKey).toString("base64") };
  return info;
}
function fixture({ onSign, onChallenge, onVerify, chain = "0x2105", requestOverride } = {}) {
  const requests = [], calls = [], listeners = new Map();
  let currentAccount = address, currentChain = chain;
  const wallet = {
    on(event, fn) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event).add(fn); },
    removeListener(event, fn) { listeners.get(event)?.delete(fn); },
    emit(event, value) { for (const fn of [...(listeners.get(event) || [])]) fn(value); },
    changeAccount(value, emit = true) { currentAccount = value; if (emit) this.emit("accountsChanged", [value]); },
    changeChain(value, emit = true) { currentChain = value; if (emit) this.emit("chainChanged", value); },
    async request(req) {
      requests.push(req);
      if (req.method === "eth_requestAccounts" || req.method === "eth_accounts") return [currentAccount];
      if (req.method === "eth_chainId") return currentChain;
      if (req.method === "personal_sign") { await onSign?.(wallet, req); return "0x" + "11".repeat(65); }
      throw new Error("Unexpected wallet method " + req.method);
    },
  };
  const api = async (path, body) => {
    calls.push({ path, body });
    if (path === "/api/license/challenge") {
      await onChallenge?.(wallet);
      return requestOverride || challengeRequest();
    }
    if (path === "/api/license/verify") {
      await onVerify?.(wallet);
      return signedInfo(body.challenge);
    }
    if (path === "/api/license/logout") return { status: "wallet-required" };
    throw new Error("Unexpected bridge path " + path);
  };
  return { wallet, api, requests, calls, listeners };
}
const execute = (f, extra = {}) => verifyHoldingsWithWallet({
  wallet: f.wallet, api: f.api, config, origin, deviceKey, ...extra,
});

test("holdings configuration pins the Base token, threshold, decimals and bounded session", () => {
  assert.equal(validateHoldingsConfig(config), config);
  assert.ok(matchingConfiguration(config, configuration));
  for (const change of [
    { mode: "payment" }, { required: "true" }, { chainId: 1 }, { token: address },
    { minimumBalance: "1" }, { decimals: 6 }, { confirmations: 0 }, { sessionTtlMs: 3600000 },
    { rpcUrl: "http://example.test" }, { rpcUrl: "https://user:password@example.test" },
  ]) assert.throws(() => validateHoldingsConfig({ ...config, ...change }));
  for (const field of ["mode", "required", "chainId", "token", "minimumBalance", "decimals", "confirmations", "sessionTtlMs", "rpcOrigin"])
    assert.equal(matchingConfiguration(config, { ...configuration, [field]: "changed" }), false);
});

test("SIWE text must exactly scope the correct website, Base wallet, bridge and expiry", () => {
  const request = challengeRequest();
  const expected = { origin, address, deviceKey, config };
  assert.equal(validateSignInRequest(request, expected), request.message);
  for (const change of [
    { origin: "https://attacker.example" }, { uri: origin + "/other" }, { address: "0x" + "55".repeat(20) },
    { chainId: 1 }, { deviceKey: "0x" + "66".repeat(32) }, { nonce: "short" },
    { requestId: "bad" }, { sessionBinding: "bad" }, { issuedAt: new Date(Date.now() - 70000).toISOString() },
    { expiresAt: Date.now() + 3600000 }, { challengeExpiresAt: Date.now() - 1 },
    { challengeExpiresAt: Date.now() + 600000 },
  ]) assert.throws(() => validateSignInRequest(challengeRequest(change), expected));
  for (const text of [request.message + "\nTransfer approved", request.message.replace("Chain ID: 8453", "Chain ID: 1"), request.message.replace("\nResources:", "\nResources:\n- https://attacker.example")])
    assert.throws(() => validateSignInRequest({ ...request, message: text }, expected));
});

test("wallet verification uses account access and one sign-in signature only", async () => {
  const f = fixture(), info = await execute(f);
  assert.equal(info.status, "active");
  assert.equal(info.identityVerified, true);
  assert.equal(f.requests.filter((r) => r.method === "personal_sign").length, 1);
  assert.ok(f.requests.every((r) => ["eth_requestAccounts", "eth_accounts", "eth_chainId", "personal_sign"].includes(r.method)));
  const signed = f.requests.find((r) => r.method === "personal_sign");
  const message = Buffer.from(signed.params[0].slice(2), "hex").toString("utf8");
  assert.equal(message, f.calls.find((c) => c.path === "/api/license/verify").body.message);
  assert.equal(signed.params[1], address);
  assert.ok([...f.listeners.values()].every((set) => !set.size));
});

test("local HTTP bridge sign-in declares its scheme instead of implying HTTPS", () => {
  const local = "http://127.0.0.1:8790";
  const request = challengeRequest({ origin: local, uri: local + "/" });
  assert.ok(request.message.startsWith(local + " wants you"));
  assert.equal(validateSignInRequest(request, { origin: local, address, deviceKey, config }), request.message);
  assert.throws(() => validateSignInRequest({ ...request, message: request.message.replace("http://127.0.0.1:8790 wants", "127.0.0.1:8790 wants") },
    { origin: local, address, deviceKey, config }));
});

test("wrong network and substituted sign-in messages never reach wallet signing", async () => {
  for (const f of [fixture({ chain: "0x1" }), fixture({ requestOverride: challengeRequest({ origin: "https://attacker.example" }) })]) {
    await assert.rejects(execute(f));
    assert.ok(!f.requests.some((r) => r.method === "personal_sign"));
    assert.ok(!f.calls.some((c) => c.path === "/api/license/verify"));
  }
});

test("account or chain changes during wallet prompts prevent authentication", async () => {
  for (const options of [
    { onSign: (wallet) => wallet.changeAccount("0x" + "55".repeat(20)) },
    { onSign: (wallet) => wallet.changeChain("0x1", false) },
    { onChallenge: (wallet) => wallet.emit("disconnect") },
  ]) {
    const f = fixture(options);
    await assert.rejects(execute(f), /changed/);
    assert.ok(!f.calls.some((c) => c.path === "/api/license/verify"));
  }
});

test("late wallet changes and cancellation revoke a potentially issued session", async () => {
  const controller = new AbortController();
  for (const [options, extra] of [
    [{ onVerify: (wallet) => wallet.changeAccount("0x" + "55".repeat(20)) }, {}],
    [{ onVerify: () => controller.abort() }, { signal: controller.signal }],
  ]) {
    const f = fixture(options);
    await assert.rejects(execute(f, extra));
    assert.equal(f.calls.at(-1).path, "/api/license/logout");
  }
});

test("bridge proofs bind fresh origin, status, wallet, exact balance, grant and configuration", async () => {
  const challenge = "77".repeat(32), info = signedInfo(challenge);
  assert.equal(await verifyBridgeIdentity(info, challenge, origin), true);
  await assert.rejects(verifyBridgeIdentity(info, "88".repeat(32), origin));
  await assert.rejects(verifyBridgeIdentity(info, challenge, "https://attacker.example"));
  for (const change of [
    { deviceKey: "0x" + "11".repeat(32) }, { status: "insufficient-balance" }, { selectedOwner: "0x" + "55".repeat(20) },
    { configuration: { ...configuration, required: false } },
    { verification: { ...info.verification, balance: "999999999999999999999999" } },
    { session: { ...info.session, expiresAt: Date.now() + 86400000 } },
  ]) await assert.rejects(verifyBridgeIdentity({ ...info, ...change }, challenge, origin));
});

test("a persistent wallet watcher revokes after authentication until explicitly closed", async () => {
  const f = fixture();
  let invalidations = 0;
  const watcher = watchWallet(f.wallet, () => invalidations++);
  await watcher.check(address);
  f.wallet.changeAccount("0x" + "55".repeat(20));
  await assert.rejects(watcher.check(address));
  f.wallet.changeChain("0x1");
  assert.equal(invalidations, 1);
  watcher.close();
  assert.ok([...f.listeners.values()].every((set) => !set.size));
});
