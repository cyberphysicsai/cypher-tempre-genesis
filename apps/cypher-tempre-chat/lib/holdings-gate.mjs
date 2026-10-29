import fs from "node:fs/promises";
import { createHash, randomBytes, sign } from "node:crypto";
import { getAddress, hashMessage, Interface, verifyMessage } from "ethers";
import { loadIdentity } from "./bridge-identity.mjs";
import { rpcResult, quantity, words } from "./base-rpc.mjs";

export const HOLDINGS_NETWORK = Object.freeze({
  mode: "holdings",
  chainId: 8453,
  token: "0x08df470d41c11ba5cb60242747d76c65ca52c94c",
  minimumBalance: "21000000000000000000000",
  decimals: 18,
});
const CHALLENGE_TTL = 300_000,
  CACHE_TTL = 30_000;
const ZERO = "0x" + "0".repeat(40);
const ERC1271 = new Interface([
  "function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)",
]);
const fail = (code, message, status = 401) =>
  Object.assign(new Error(message), { code, status });
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameAddress = (a, b) =>
  String(a).toLowerCase() === String(b).toLowerCase();

export function validateHoldingsConfig(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    input.mode !== "holdings"
  )
    throw fail(
      "LICENSE_CONFIG_INVALID",
      "A holdings-gate configuration is required.",
      503,
    );
  const config = {
    ...HOLDINGS_NETWORK,
    required: true,
    rpcUrl: "https://mainnet.base.org",
    confirmations: 2,
    sessionTtlMs: 1_800_000,
    ...input,
  };
  let rpc;
  try {
    rpc = new URL(config.rpcUrl);
  } catch {}
  if (
    config.chainId !== 8453 ||
    !sameAddress(config.token, HOLDINGS_NETWORK.token) ||
    config.minimumBalance !== HOLDINGS_NETWORK.minimumBalance ||
    config.decimals !== 18 ||
    typeof config.required !== "boolean" ||
    !Number.isInteger(config.confirmations) ||
    config.confirmations < 2 ||
    config.confirmations > 128 ||
    !Number.isInteger(config.sessionTtlMs) ||
    config.sessionTtlMs < 60_000 ||
    config.sessionTtlMs > 1_800_000 ||
    !rpc ||
    rpc.protocol !== "https:" ||
    rpc.username ||
    rpc.password ||
    rpc.hash ||
    ["registry", "treasury", "unitPrice"].some((key) =>
      Object.hasOwn(input, key),
    )
  )
    throw fail(
      "LICENSE_CONFIG_INVALID",
      "Use the approved Base CPHY holdings threshold, HTTPS RPC and bounded session settings.",
      503,
    );
  return Object.freeze({
    ...HOLDINGS_NETWORK,
    required: config.required,
    rpcUrl: rpc.href,
    confirmations: config.confirmations,
    sessionTtlMs: config.sessionTtlMs,
  });
}

function walletAddress(value) {
  if (
    typeof value !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(value) ||
    sameAddress(value, ZERO)
  )
    throw fail(
      "WALLET_ADDRESS_INVALID",
      "Choose a valid public wallet address.",
      400,
    );
  try {
    return getAddress(value);
  } catch {
    throw fail(
      "WALLET_ADDRESS_INVALID",
      "The wallet address checksum is invalid.",
      400,
    );
  }
}

export function siweMessage(challenge) {
  const origin = new URL(challenge.origin);
  const authority = `${origin.protocol === "http:" ? "http://" : ""}${origin.host}`;
  return `${authority} wants you to sign in with your Ethereum account:\n${challenge.address}\n\nUnlock Cypher Tempre ChainChat by proving control of this wallet. No transaction, token transfer, or approval.\n\nURI: ${challenge.uri}\nVersion: 1\nChain ID: 8453\nNonce: ${challenge.nonce}\nIssued At: ${challenge.issuedAt}\nExpiration Time: ${new Date(challenge.expiresAt).toISOString()}\nRequest ID: ${challenge.requestId}\nResources:\n- urn:cypher-tempre:device:${challenge.deviceKey}\n- urn:cypher-tempre:session:${challenge.sessionBinding}`;
}

export async function createHoldingsGate({
  root,
  configPath,
  config,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  let raw = config;
  if (raw === undefined) {
    try {
      raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch {
      throw fail(
        "LICENSE_CONFIG_INVALID",
        "The holdings-gate configuration could not be read.",
        503,
      );
    }
  }
  const settings = validateHoldingsConfig(raw);
  const identity = await loadIdentity(root);
  const configuration = Object.freeze({
    ...HOLDINGS_NETWORK,
    required: settings.required,
    confirmations: settings.confirmations,
    sessionTtlMs: settings.sessionTtlMs,
    rpcOrigin: new URL(settings.rpcUrl).origin,
  });
  const sessions = new WeakMap();
  function recordFor(session) {
    const record = session && sessions.get(session);
    if (!record)
      throw fail(
        "WALLET_SESSION_INVALID",
        "Pair this browser with its local bridge again.",
      );
    return record;
  }
  function attach(session) {
    if (sessions.has(session))
      throw fail(
        "WALLET_SESSION_INVALID",
        "The paired session is already registered.",
      );
    const url = new URL(session.origin);
    if (
      url.origin !== session.origin ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw fail(
        "WALLET_ORIGIN_INVALID",
        "The paired browser origin is invalid.",
        400,
      );
    sessions.set(session, {
      origin: session.origin,
      binding: randomBytes(32).toString("hex"),
      epoch: 0,
      challenge: null,
      grant: null,
      cached: null,
      inFlight: null,
      lastStatus: "wallet-required",
    });
  }
  function invalidate(record, status = "wallet-required") {
    record.epoch++;
    record.challenge = null;
    record.grant = null;
    record.cached = null;
    record.inFlight = null;
    record.lastStatus = status;
  }
  function revoke(session) {
    invalidate(recordFor(session));
  }
  function epoch(session) {
    return recordFor(session).epoch;
  }
  function live(record) {
    if (record.grant && now() >= record.grant.expiresAt)
      invalidate(record, "session-expired");
    return !!record.grant;
  }
  function unchanged(record, expected) {
    if (record.epoch !== expected)
      throw fail(
        "WALLET_SESSION_CHANGED",
        "The wallet session changed. Start this operation again.",
        403,
      );
  }
  function challenge(session, address) {
    const record = recordFor(session),
      normalized = walletAddress(address);
    invalidate(record);
    const issued = now();
    const value = {
      address: normalized,
      origin: record.origin,
      uri: record.origin + "/",
      chainId: 8453,
      requestId: randomBytes(16).toString("hex"),
      nonce: randomBytes(32).toString("hex"),
      issuedAt: new Date(issued).toISOString(),
      challengeExpiresAt: issued + CHALLENGE_TTL,
      expiresAt: issued + settings.sessionTtlMs,
      deviceKey: identity.deviceKey,
      sessionBinding: record.binding,
    };
    value.message = siweMessage(value);
    record.challenge = value;
    return { ...value };
  }
  async function walletSnapshot(grant) {
    const rpc = (method, params) =>
      rpcResult(fetchImpl, settings.rpcUrl, method, params);
    const [chain, head] = await Promise.all([
      rpc("eth_chainId", []),
      rpc("eth_blockNumber", []),
    ]);
    if (quantity(chain) !== 8453n)
      throw fail(
        "LICENSE_NETWORK_MISMATCH",
        "The RPC is not connected to Base mainnet.",
        503,
      );
    const height = quantity(head) - BigInt(settings.confirmations);
    if (height < 0n)
      throw fail(
        "LICENSE_CONFIRMATIONS_PENDING",
        "Wait for the configured Base confirmation blocks.",
        503,
      );
    const number = "0x" + height.toString(16);
    const block = await rpc("eth_getBlockByNumber", [number, false]);
    if (
      !block ||
      quantity(block.number) !== height ||
      !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
    )
      throw fail(
        "LICENSE_RPC_INVALID",
        "The RPC returned an invalid confirmation block.",
        503,
      );
    const blockRef = {
      blockHash: block.hash.toLowerCase(),
      requireCanonical: true,
    };
    const code = await rpc("eth_getCode", [grant.wallet, blockRef]);
    if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(code))
      throw fail(
        "LICENSE_RPC_INVALID",
        "The RPC returned invalid wallet bytecode.",
        503,
      );
    let walletType;
    if (code === "0x" || /^0xef0100[0-9a-fA-F]{40}$/.test(code)) {
      let recovered;
      try {
        recovered = verifyMessage(grant.message, grant.signature);
      } catch {}
      if (!recovered || !sameAddress(recovered, grant.wallet))
        throw fail(
          "WALLET_SIGNATURE_INVALID",
          "The signature does not prove control of this wallet. Undeployed smart wallets are not supported.",
        );
      walletType = "eoa";
    } else {
      const result = await rpc("eth_call", [
        {
          to: grant.wallet,
          data: ERC1271.encodeFunctionData("isValidSignature", [
            hashMessage(grant.message),
            grant.signature,
          ]),
        },
        blockRef,
      ]);
      if (
        typeof result !== "string" ||
        result.toLowerCase() !== "0x1626ba7e" + "0".repeat(56)
      )
        throw fail(
          "WALLET_CONTRACT_SIGNATURE_INVALID",
          "This deployed wallet did not approve the ERC-1271 signature. Unsupported smart-wallet signatures are rejected.",
        );
      walletType = "erc1271";
    }
    const [decimals, rawBalance] = await Promise.all([
      rpc("eth_call", [{ to: settings.token, data: "0x313ce567" }, blockRef]),
      rpc("eth_call", [
        {
          to: settings.token,
          data:
            "0x70a08231" +
            grant.wallet.slice(2).toLowerCase().padStart(64, "0"),
        },
        blockRef,
      ]),
    ]);
    if (BigInt("0x" + words(decimals)[0]) !== 18n)
      throw fail(
        "LICENSE_TOKEN_MISMATCH",
        "The configured CPHY token did not report 18 decimals.",
        503,
      );
    const balance = BigInt("0x" + words(rawBalance)[0]);
    const current = await rpc("eth_getBlockByNumber", [number, false]);
    if (current?.hash?.toLowerCase() !== blockRef.blockHash)
      throw fail(
        "LICENSE_REORG",
        "The verification block changed. Check holdings again.",
        503,
      );
    const checkedAt = now();
    return {
      status:
        balance >= BigInt(settings.minimumBalance)
          ? "active"
          : "insufficient-balance",
      walletType,
      verification: {
        wallet: grant.wallet,
        balance: balance.toString(),
        checkedAt,
        expiresAt: Math.min(checkedAt + CACHE_TTL, grant.expiresAt),
        blockNumber: height.toString(),
        blockHash: blockRef.blockHash,
        confirmations: settings.confirmations,
        assurance: "l2-confirmed-not-final",
      },
    };
  }
  async function authenticate(session, input) {
    const record = recordFor(session),
      pending = record.challenge;
    if (!pending)
      throw fail(
        "WALLET_CHALLENGE_USED",
        "Request a fresh wallet sign-in message; this challenge is missing or already used.",
      );
    // Consume before any await. Concurrent verification cannot reuse the nonce.
    invalidate(record);
    const expected = record.epoch;
    if (
      !input ||
      input.requestId !== pending.requestId ||
      input.message !== pending.message ||
      pending.sessionBinding !== record.binding ||
      pending.origin !== record.origin
    )
      throw fail(
        "WALLET_CHALLENGE_MISMATCH",
        "The signed message does not match this paired browser's challenge.",
      );
    if (
      now() >= pending.challengeExpiresAt ||
      now() >= pending.expiresAt ||
      now() < Date.parse(pending.issuedAt)
    )
      throw fail(
        "WALLET_CHALLENGE_EXPIRED",
        "The wallet challenge expired. Request a fresh message.",
      );
    if (
      typeof input.signature !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2}){1,8192}$/.test(input.signature)
    )
      throw fail(
        "WALLET_SIGNATURE_INVALID",
        "The wallet returned an invalid signature.",
      );
    if (input.signature.toLowerCase().endsWith("6492".repeat(16)))
      throw fail(
        "WALLET_COUNTERFACTUAL_UNSUPPORTED",
        "Counterfactual wallet signatures are not supported. Use a deployed ERC-1271 wallet or a standard account.",
      );
    const grant = {
      wallet: pending.address,
      message: pending.message,
      signature: input.signature,
      walletType: null,
      authenticatedAt: now(),
      expiresAt: pending.expiresAt,
    };
    const result = await walletSnapshot(grant);
    unchanged(record, expected);
    if (now() >= pending.challengeExpiresAt || now() >= grant.expiresAt)
      throw fail(
        "WALLET_CHALLENGE_EXPIRED",
        "Wallet verification took too long. Request a fresh message.",
      );
    grant.walletType = result.walletType;
    record.grant = grant;
    record.cached = result;
    record.lastStatus = result.status;
    return result;
  }
  async function check(session, force = false) {
    const record = recordFor(session);
    if (!settings.required)
      return { status: "local-test-mode", verification: null };
    if (!live(record)) return { status: record.lastStatus, verification: null };
    if (
      !force &&
      record.cached &&
      now() >= record.cached.verification.checkedAt &&
      now() < record.cached.verification.expiresAt
    )
      return record.cached;
    if (!record.inFlight) {
      record.cached = null;
      const expected = record.epoch,
        grant = record.grant;
      const pending = { promise: null };
      record.inFlight = pending;
      pending.promise = walletSnapshot(grant)
        .then((result) => {
          unchanged(record, expected);
          if (!live(record))
            throw fail(
              "WALLET_SESSION_EXPIRED",
              "Sign in with your wallet again.",
            );
          grant.walletType = result.walletType;
          record.cached = result;
          record.lastStatus = result.status;
          return result;
        })
        .catch((error) => {
          if (record.epoch !== expected || !record.grant)
            return { status: record.lastStatus, verification: null };
          record.cached = null;
          return {
            status: "verification-unavailable",
            verification: null,
            error: {
              code: error.code || "LICENSE_RPC_UNAVAILABLE",
              message: error.code
                ? error.message
                : "Base holdings verification is unavailable.",
            },
          };
        })
        .finally(() => {
          if (record.inFlight === pending) record.inFlight = null;
        });
    }
    return record.inFlight.promise;
  }
  async function requireActive(session, expectedEpoch) {
    if (!settings.required) return;
    const record = recordFor(session);
    unchanged(record, expectedEpoch);
    const result = await check(session);
    unchanged(record, expectedEpoch);
    if (result.status !== "active")
      throw fail(
        result.status === "verification-unavailable"
          ? "LICENSE_UNAVAILABLE"
          : "HOLDINGS_REQUIRED",
        result.status === "verification-unavailable"
          ? "CPHY holdings could not be verified. Try again before continuing."
          : "Sign in with a wallet holding at least 21,000 CPHY on Base to use agent actions.",
        result.status === "verification-unavailable" ? 503 : 403,
      );
  }
  async function describe(
    session,
    { challenge: browserChallenge, force = false } = {},
  ) {
    if (
      browserChallenge !== undefined &&
      (typeof browserChallenge !== "string" ||
        !/^[0-9a-fA-F]{64}$/.test(browserChallenge))
    )
      throw fail(
        "LICENSE_CHALLENGE_INVALID",
        "Use a fresh 32-byte hexadecimal browser challenge.",
        400,
      );
    const record = recordFor(session);
    let result;
    // A descriptor must never combine an old balance with a replacement grant.
    // Retry once after revocation/reauthentication; repeated changes fail closed.
    for (let attempt = 0; attempt < 2; attempt++) {
      const expected = record.epoch;
      const snapshot = await check(session, force && attempt === 0);
      if (record.epoch === expected) {
        result = snapshot;
        break;
      }
    }
    result ||= {
      status: live(record) ? "verification-unavailable" : record.lastStatus,
      verification: null,
    };
    const grant = record.grant;
    const sessionInfo = grant
      ? {
          wallet: grant.wallet,
          walletType: grant.walletType,
          authenticatedAt: grant.authenticatedAt,
          expiresAt: grant.expiresAt,
        }
      : null;
    const verification = result.verification;
    const selectedOwner = grant?.wallet || null;
    const payload = {
      purpose: "cypher-tempre-holdings",
      origin: record.origin,
      challenge: browserChallenge || null,
      nonce: randomBytes(32).toString("hex"),
      issuedAt: now(),
      deviceKey: identity.deviceKey,
      selectedOwner,
      status: result.status,
      configurationSha256: digest(configuration),
      verificationSha256: digest(verification),
      sessionSha256: digest(sessionInfo),
    };
    const message = JSON.stringify(payload);
    return {
      required: settings.required,
      status: result.status,
      verification,
      session: sessionInfo,
      selectedOwner,
      ...(result.error ? { error: result.error } : {}),
      deviceKey: identity.deviceKey,
      publicKeySPKI: identity.publicKeySPKI,
      proof: {
        algorithm: "Ed25519",
        challenge: browserChallenge || null,
        message,
        signature: sign(
          null,
          Buffer.from(message),
          identity.privateKey,
        ).toString("base64"),
      },
      configuration,
    };
  }
  return Object.freeze({
    attach,
    epoch,
    revoke,
    challenge,
    authenticate,
    describe,
    requireActive,
    required: settings.required,
  });
}
