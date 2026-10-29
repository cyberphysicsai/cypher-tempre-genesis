import fs from "node:fs/promises";
import path from "node:path";
import { writeJSON } from "./state.mjs";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";

export const SEAT_NETWORK = Object.freeze({
  chainId: 8453,
  token: "0x08df470d41c11ba5cb60242747d76c65ca52c94c",
  treasury: "0x7932cca1bd502d6850842c423d21f527de47a0ca",
  unitPrice: "21000000000000000000000",
  decimals: 18,
});
// Generated from the registry's Solidity ABI, not caller-supplied selectors.
export const SEAT_SELECTORS = Object.freeze({
  token: "fc0c546a",
  treasury: "61d027b3",
  unitPrice: "afa40bbd",
  seatOfDevice: "d94a2e60",
  seats: "3b33c702",
});
const ZERO_ADDRESS = "0x" + "0".repeat(40);
const MAX_CACHE_MS = 30_000;
const MAX_RPC_BYTES = 131_072;
const fail = (code, message, status = 503) =>
  Object.assign(new Error(message), { code, status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const isAddress = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);

export function validateSeatConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail(
      "LICENSE_CONFIG_INVALID",
      "The instance license configuration is invalid.",
    );
  const config = {
    chainId: SEAT_NETWORK.chainId,
    token: SEAT_NETWORK.token,
    treasury: SEAT_NETWORK.treasury,
    unitPrice: SEAT_NETWORK.unitPrice,
    registry: null,
    rpcUrl: "https://mainnet.base.org",
    confirmations: 2,
    required: false,
    runtimeCodeSha256: null,
    ...input,
  };
  let rpc;
  try {
    rpc = new URL(config.rpcUrl);
  } catch {}
  if (
    config.chainId !== SEAT_NETWORK.chainId ||
    !isAddress(config.token) ||
    config.token.toLowerCase() !== SEAT_NETWORK.token ||
    !isAddress(config.treasury) ||
    config.treasury.toLowerCase() !== SEAT_NETWORK.treasury ||
    config.unitPrice !== SEAT_NETWORK.unitPrice ||
    typeof config.required !== "boolean" ||
    !Number.isInteger(config.confirmations) ||
    config.confirmations < 2 ||
    config.confirmations > 128 ||
    !rpc ||
    rpc.protocol !== "https:" ||
    rpc.username ||
    rpc.password ||
    rpc.hash
  )
    throw fail(
      "LICENSE_CONFIG_INVALID",
      "Use the approved Base token and treasury, an HTTPS RPC, and at least two confirmation blocks.",
    );
  if (
    config.registry !== null &&
    (!isAddress(config.registry) ||
      config.registry.toLowerCase() === ZERO_ADDRESS)
  )
    throw fail(
      "LICENSE_CONFIG_INVALID",
      "The instance registry address is invalid.",
    );
  if (
    config.registry &&
    (typeof config.runtimeCodeSha256 !== "string" ||
      !/^(?:0x)?[0-9a-fA-F]{64}$/.test(config.runtimeCodeSha256))
  )
    throw fail(
      "LICENSE_CONFIG_INVALID",
      "A deployed registry requires its pinned runtime bytecode hash.",
    );
  return Object.freeze({
    chainId: config.chainId,
    token: config.token.toLowerCase(),
    treasury: config.treasury.toLowerCase(),
    registry: config.registry?.toLowerCase() || null,
    rpcUrl: rpc.href,
    confirmations: config.confirmations,
    required: config.required,
    runtimeCodeSha256: config.registry
      ? config.runtimeCodeSha256.replace(/^0x/, "").toLowerCase()
      : null,
  });
}

async function loadIdentity(root) {
  const file = path.join(path.resolve(root), "bridge-identity.json");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.lstat(file);
  } catch (error) {
    if (error.code !== "ENOENT")
      throw fail(
        "BRIDGE_IDENTITY_INVALID",
        "The local bridge identity could not be opened.",
      );
    const { privateKey } = generateKeyPairSync("ed25519");
    const publicKey = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    const value = {
      version: 1,
      algorithm: "Ed25519",
      privateKeyPKCS8: privateKey
        .export({ format: "der", type: "pkcs8" })
        .toString("base64"),
      publicKeySPKI: publicKey.toString("base64"),
      deviceKey: "0x" + hash(publicKey),
    };
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    try {
      // Publish a complete identity once; a racing process cannot replace it.
      await fs.link(temporary, file);
    } catch (error) {
      if (error.code !== "EEXIST")
        throw fail(
          "BRIDGE_IDENTITY_INVALID",
          "The local bridge identity could not be saved.",
        );
    } finally {
      await fs.unlink(temporary);
    }
  }
  try {
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 8192)
      throw new Error("Invalid identity file.");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (
      value.version !== 1 ||
      value.algorithm !== "Ed25519" ||
      typeof value.privateKeyPKCS8 !== "string"
    )
      throw new Error("Invalid identity format.");
    const privateKey = createPrivateKey({
      key: Buffer.from(value.privateKeyPKCS8, "base64"),
      format: "der",
      type: "pkcs8",
    });
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw new Error("Invalid identity algorithm.");
    const publicKey = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    const publicKeySPKI = publicKey.toString("base64"),
      deviceKey = "0x" + hash(publicKey);
    if (publicKeySPKI !== value.publicKeySPKI || deviceKey !== value.deviceKey)
      throw new Error("Identity public and private keys disagree.");
    await fs.chmod(file, 0o600);
    return { privateKey, publicKeySPKI, deviceKey };
  } catch {
    throw fail(
      "BRIDGE_IDENTITY_INVALID",
      "The local bridge identity is invalid. Restore its backup; it was not replaced.",
    );
  }
}

async function rpcResult(fetchImpl, rpcUrl, method, params) {
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

function quantity(value) {
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
function words(value, count = 1) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^0x[0-9a-fA-F]{${64 * count}}$`).test(value)
  )
    throw fail(
      "LICENSE_CONTRACT_INVALID",
      "The registry returned an invalid contract value.",
    );
  return value.slice(2).toLowerCase().match(/.{64}/g);
}
function address(word) {
  if (!/^0{24}[0-9a-f]{40}$/.test(word))
    throw fail(
      "LICENSE_CONTRACT_INVALID",
      "The registry returned an invalid address.",
    );
  return "0x" + word.slice(24);
}

export async function createSeatLicense({
  root,
  configPath,
  config,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  if (!root)
    throw new Error("A local data root is required for the bridge identity.");
  let raw = config;
  if (raw === undefined && configPath) {
    try {
      raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT")
        throw fail(
          "LICENSE_CONFIG_INVALID",
          "The instance license configuration could not be read.",
        );
    }
  }
  const settings = validateSeatConfig(raw);
  const identity = await loadIdentity(root);
  const selectionFile = path.join(path.resolve(root), "license-selection.json");
  let selectedOwner = null;
  try {
    const selection = JSON.parse(await fs.readFile(selectionFile, "utf8"));
    if (
      selection.version !== 1 ||
      !isAddress(selection.owner) ||
      selection.owner.toLowerCase() === ZERO_ADDRESS
    )
      throw new Error("Invalid owner selection.");
    selectedOwner = selection.owner.toLowerCase();
  } catch (error) {
    if (error.code !== "ENOENT")
      throw fail(
        "LICENSE_SELECTION_INVALID",
        "The locally selected license owner is invalid. Restore or correct its public address before continuing.",
      );
  }
  const configuration = Object.freeze({
    required: settings.required,
    chainId: settings.chainId,
    token: settings.token,
    treasury: settings.treasury,
    registry: settings.registry,
    unitPrice: SEAT_NETWORK.unitPrice,
    priceTokens: "21000",
    decimals: SEAT_NETWORK.decimals,
    confirmations: settings.confirmations,
    runtimeCodeSha256: settings.runtimeCodeSha256,
    rpcOrigin: new URL(settings.rpcUrl).origin,
  });
  let cached = null,
    inFlight = null,
    selectionEpoch = 0,
    selectionQueue = Promise.resolve();
  async function selectOwner(owner) {
    if (!isAddress(owner) || owner.toLowerCase() === ZERO_ADDRESS)
      throw fail(
        "LICENSE_OWNER_INVALID",
        "Enter the public wallet address that purchased this instance.",
        400,
      );
    const normalized = owner.toLowerCase();
    const write = selectionQueue.then(async () => {
      await writeJSON(selectionFile, { version: 1, owner: normalized });
      if (selectedOwner !== normalized) {
        selectedOwner = normalized;
        selectionEpoch++;
        cached = null;
      }
      return selectedOwner;
    });
    selectionQueue = write.catch(() => {});
    return write;
  }
  async function verifyRegistry(expectedOwner) {
    const rpc = (method, params) =>
      rpcResult(fetchImpl, settings.rpcUrl, method, params);
    const [chainId, head] = await Promise.all([
      rpc("eth_chainId", []),
      rpc("eth_blockNumber", []),
    ]);
    if (quantity(chainId) !== BigInt(settings.chainId))
      throw fail(
        "LICENSE_NETWORK_MISMATCH",
        "The RPC is not connected to Base mainnet.",
      );
    const height = quantity(head) - BigInt(settings.confirmations);
    if (height < 0n)
      throw fail(
        "LICENSE_CONFIRMATIONS_PENDING",
        "Wait for the configured Base confirmation blocks.",
      );
    const blockNumber = "0x" + height.toString(16);
    const block = await rpc("eth_getBlockByNumber", [blockNumber, false]);
    if (
      !block ||
      quantity(block.number) !== height ||
      typeof block.hash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(block.hash)
    )
      throw fail(
        "LICENSE_RPC_INVALID",
        "The Base RPC returned an invalid confirmation block.",
      );
    // EIP-1898 pins all reads to one canonical block, avoiding mixed state during a reorg.
    const blockRef = {
      blockHash: block.hash.toLowerCase(),
      requireCanonical: true,
    };
    const code = await rpc("eth_getCode", [settings.registry, blockRef]);
    if (
      typeof code !== "string" ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) ||
      hash(Buffer.from(code.slice(2), "hex")) !== settings.runtimeCodeSha256
    )
      throw fail(
        "LICENSE_CODE_MISMATCH",
        "The deployed registry bytecode does not match the pinned release.",
      );
    const call = (selector, argument = "") =>
      rpc("eth_call", [
        { to: settings.registry, data: "0x" + selector + argument },
        blockRef,
      ]);
    const [token, treasury, price, deviceSeat] = await Promise.all([
      call(SEAT_SELECTORS.token),
      call(SEAT_SELECTORS.treasury),
      call(SEAT_SELECTORS.unitPrice),
      call(
        SEAT_SELECTORS.seatOfDevice,
        expectedOwner.slice(2).padStart(64, "0") + identity.deviceKey.slice(2),
      ),
    ]);
    if (
      address(words(token)[0]) !== SEAT_NETWORK.token ||
      address(words(treasury)[0]) !== SEAT_NETWORK.treasury ||
      BigInt("0x" + words(price)[0]) !== BigInt(SEAT_NETWORK.unitPrice)
    )
      throw fail(
        "LICENSE_CONTRACT_MISMATCH",
        "The registry token, treasury, or price does not match this product.",
      );
    const seatId = BigInt("0x" + words(deviceSeat)[0]);
    let seat = null;
    if (seatId !== 0n) {
      const [ownerWord, generationWord, keyWord] = words(
        await call(SEAT_SELECTORS.seats, seatId.toString(16).padStart(64, "0")),
        3,
      );
      const owner = address(ownerWord),
        generation = BigInt("0x" + generationWord);
      if (
        owner !== expectedOwner ||
        generation === 0n ||
        generation > 0xffffffffffffffffn ||
        "0x" + keyWord !== identity.deviceKey
      )
        throw fail(
          "LICENSE_BINDING_INVALID",
          "The registry seat is not bound to this bridge identity.",
        );
      seat = {
        seatId: seatId.toString(),
        owner,
        generation: generation.toString(),
      };
    }
    const current = await rpc("eth_getBlockByNumber", [blockNumber, false]);
    if (current?.hash?.toLowerCase() !== blockRef.blockHash)
      throw fail(
        "LICENSE_REORG",
        "The verification block changed. Check the license again.",
      );
    const checkedAt = now();
    return {
      status: seat ? "active" : "unlicensed",
      verification: {
        ...seat,
        checkedAt,
        expiresAt: checkedAt + MAX_CACHE_MS,
        blockNumber: height.toString(),
        blockHash: blockRef.blockHash,
        confirmations: settings.confirmations,
        assurance: "l2-confirmed-not-final",
      },
    };
  }
  async function check(force = false) {
    if (!settings.registry)
      return { status: "payments-not-open", verification: null };
    if (!selectedOwner) return { status: "choose-owner", verification: null };
    if (
      !force &&
      cached &&
      now() < cached.verification.expiresAt &&
      now() >= cached.verification.checkedAt
    )
      return cached;
    if (!inFlight || inFlight.epoch !== selectionEpoch) {
      cached = null;
      const pending = { epoch: selectionEpoch, promise: null };
      inFlight = pending;
      pending.promise = verifyRegistry(selectedOwner)
        .then((result) => {
          if (pending.epoch !== selectionEpoch)
            throw fail(
              "LICENSE_SELECTION_CHANGED",
              "The selected license owner changed during verification. Check again.",
            );
          return (cached = result);
        })
        .catch((error) => ({
          status: "verification-unavailable",
          verification: null,
          error: {
            code: error.code || "LICENSE_RPC_UNAVAILABLE",
            message: error.code
              ? error.message
              : "Base license verification is unavailable.",
          },
        }))
        .finally(() => {
          if (inFlight === pending) inFlight = null;
        });
    }
    return inFlight.promise;
  }
  async function describe({
    origin,
    force = false,
    challenge: browserChallenge,
  } = {}) {
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
    const result = await check(force);
    const challenge = {
      purpose: "cypher-tempre-instance",
      origin: String(origin || ""),
      challenge: browserChallenge || null,
      nonce: randomBytes(32).toString("hex"),
      issuedAt: now(),
      deviceKey: identity.deviceKey,
      selectedOwner,
      status: result.status,
      configurationSha256: hash(JSON.stringify(configuration)),
    };
    const message = JSON.stringify(challenge);
    return {
      required: settings.required,
      paymentsOpen: !!settings.registry,
      ...result,
      deviceKey: identity.deviceKey,
      publicKeySPKI: identity.publicKeySPKI,
      selectedOwner,
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
  async function requireActive() {
    if (!settings.required) return;
    const result = await check();
    if (result.status !== "active")
      throw fail(
        result.status === "verification-unavailable"
          ? "LICENSE_UNAVAILABLE"
          : "LICENSE_REQUIRED",
        result.status === "verification-unavailable"
          ? "The instance license could not be verified. Try again before continuing."
          : "This operation requires a confirmed instance license bound to this local bridge.",
        result.status === "verification-unavailable" ? 503 : 402,
      );
  }
  return Object.freeze({
    describe,
    requireActive,
    selectOwner,
    required: settings.required,
  });
}
