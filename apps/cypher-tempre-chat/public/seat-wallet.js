// Wallet operations run only after an explicit button click in the interface.
// No wallet keys, account list or signatures are stored by this application.
export const CPHY_TOKEN = "0x08df470d41c11ba5cb60242747d76c65ca52c94c";
export const CPHY_TREASURY = "0x7932cca1bd502d6850842c423d21f527de47a0ca";
export const CPHY_PRICE = 21000n * 10n ** 18n;
export const SEAT_METHODS = Object.freeze({
  "purchaseAndBind(bytes32[])": "a62919de",
  "rotate(uint256,bytes32)": "a292a54a",
  "token()": "fc0c546a",
  "treasury()": "61d027b3",
  "UNIT_PRICE()": "afa40bbd",
  "seatOfDevice(address,bytes32)": "d94a2e60",
});
const address = (value) => /^0x[0-9a-f]{40}$/i.test(value || "");
const bytes32 = (value) =>
  /^0x[0-9a-f]{64}$/i.test(value || "") && !/^0x0{64}$/i.test(value);
export const uintWord = (value) => {
  const n = BigInt(value);
  if (n < 0n || n >= 2n ** 256n) throw new Error("Invalid integer.");
  return n.toString(16).padStart(64, "0");
};
export async function verifyBridgeIdentity(info, challenge, origin) {
  const fail = () => {
    throw new Error(
      "The bridge identity proof could not be verified. No payment was requested.",
    );
  };
  if (
    !/^[0-9a-f]{64}$/i.test(challenge) ||
    info?.proof?.challenge !== challenge ||
    info.proof.algorithm !== "Ed25519"
  )
    return fail();
  try {
    const decode = (value) =>
      Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    const digest = async (value) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
        .map((n) => n.toString(16).padStart(2, "0"))
        .join("");
    const publicKey = decode(info.publicKeySPKI);
    if ("0x" + (await digest(publicKey)) !== info.deviceKey) return fail();
    const message = JSON.parse(info.proof.message);
    if (
      message.purpose !== "cypher-tempre-instance" ||
      message.origin !== origin ||
      message.challenge !== challenge ||
      message.deviceKey !== info.deviceKey ||
      message.status !== info.status ||
      message.selectedOwner !== info.selectedOwner ||
      !Number.isFinite(message.issuedAt) ||
      Math.abs(Date.now() - message.issuedAt) > 60000
    )
      return fail();
    if (
      message.configurationSha256 !==
      (await digest(
        new TextEncoder().encode(JSON.stringify(info.configuration)),
      ))
    )
      return fail();
    const key = await crypto.subtle.importKey(
      "spki",
      publicKey,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    if (
      !(await crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        decode(info.proof.signature),
        new TextEncoder().encode(info.proof.message),
      ))
    )
      return fail();
    return true;
  } catch {
    return fail();
  }
}
export function matchingConfiguration(expected, actual) {
  if (!expected || !actual) return false;
  return [
    "chainId",
    "required",
    "confirmations",
    "unitPrice",
    "registry",
    "runtimeCodeSha256",
    "token",
    "treasury",
  ].every(
    (key) =>
      String(expected[key]).toLowerCase() === String(actual[key]).toLowerCase(),
  );
}
const addressWord = (value) => {
  if (!address(value)) throw new Error("Invalid contract address.");
  return value.slice(2).toLowerCase().padStart(64, "0");
};
export function encodeDevicePurchase(selector, keys) {
  if (selector !== SEAT_METHODS["purchaseAndBind(bytes32[])"])
    throw new Error(
      "Registry purchase interface does not match the reviewed release.",
    );
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 64 ||
    keys.some((k) => !bytes32(k))
  )
    throw new Error("Provide 1–64 valid bridge keys.");
  if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length)
    throw new Error("Each seat needs a different bridge key.");
  return `0x${selector}${uintWord(32)}${uintWord(keys.length)}${keys.map((k) => k.slice(2)).join("")}`;
}
export function validateDeployment(config) {
  if (
    config?.required !== true ||
    !address(config.registry) ||
    !/^([0-9a-f]{64})$/i.test(config.runtimeCodeSha256 || "")
  )
    throw new Error(
      "Payments are not open. Do not send CPHY directly; a direct transfer does not register a seat.",
    );
  if (
    config.chainId !== 8453 ||
    config.token.toLowerCase() !== CPHY_TOKEN ||
    config.treasury.toLowerCase() !== CPHY_TREASURY ||
    BigInt(config.unitPrice) !== CPHY_PRICE
  )
    throw new Error(
      "The payment configuration does not match this application.",
    );
  return config;
}
export async function checkedWallet(
  config,
  methods,
  wallet,
  allowSwitch = true,
) {
  validateDeployment(config);
  if (!wallet?.request)
    throw new Error(
      "Open this page in a browser with an Ethereum wallet extension.",
    );
  let chain = await wallet.request({ method: "eth_chainId" });
  if (chain.toLowerCase() !== "0x2105") {
    if (!allowSwitch)
      throw new Error(
        "Wallet network changed. Return to Base and review the pending transaction before retrying.",
      );
    await wallet.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x2105" }],
    });
    chain = await wallet.request({ method: "eth_chainId" });
    if (chain.toLowerCase() !== "0x2105")
      throw new Error("Switch your wallet to Base Mainnet.");
  }
  const code = await wallet.request({
    method: "eth_getCode",
    params: [config.registry, "latest"],
  });
  if (!/^0x(?:[0-9a-f]{2})+$/i.test(code))
    throw new Error("The license registry is not deployed.");
  const raw = Uint8Array.from(
    code
      .slice(2)
      .match(/../g)
      .map((h) => parseInt(h, 16)),
  );
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
  if (digest !== config.runtimeCodeSha256.toLowerCase())
    throw new Error(
      "The license registry code does not match the reviewed release.",
    );
  const call = async (name) => {
    const selector = methods[name];
    if (selector !== SEAT_METHODS[name])
      throw new Error(
        "Registry interface does not match the reviewed release.",
      );
    const value = await wallet.request({
      method: "eth_call",
      params: [{ to: config.registry, data: `0x${selector}` }, "latest"],
    });
    if (!/^0x[0-9a-f]{64}$/i.test(value))
      throw new Error("Invalid registry response.");
    return value.toLowerCase();
  };
  if (
    (await call("token()")).slice(-40) !== CPHY_TOKEN.slice(2) ||
    (await call("treasury()")).slice(-40) !== CPHY_TREASURY.slice(2) ||
    BigInt(await call("UNIT_PRICE()")) !== CPHY_PRICE
  )
    throw new Error("The registry has unexpected payment settings.");
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  const account = accounts?.[0];
  if (!address(account)) throw new Error("Select a wallet account.");
  return account;
}
function watchWallet(wallet) {
  let changed = false;
  const onChange = () => {
    changed = true;
  };
  wallet.on?.("chainChanged", onChange);
  wallet.on?.("accountsChanged", onChange);
  return {
    async check(account) {
      if (changed)
        throw new Error(
          "Wallet account or network changed. Review any submitted transaction before retrying.",
        );
      const [chain, accounts] = await Promise.all([
        wallet.request({ method: "eth_chainId" }),
        wallet.request({ method: "eth_accounts" }),
      ]);
      if (
        changed ||
        chain.toLowerCase() !== "0x2105" ||
        accounts?.[0]?.toLowerCase() !== account.toLowerCase()
      )
        throw new Error(
          "Wallet account or network changed. Review any submitted transaction before retrying.",
        );
    },
    close() {
      wallet.removeListener?.("chainChanged", onChange);
      wallet.removeListener?.("accountsChanged", onChange);
    },
  };
}
export async function waitForReceipt(wallet, hash, report, signal) {
  if (!/^0x[0-9a-f]{64}$/i.test(hash || ""))
    throw new Error("The wallet returned an invalid transaction hash.");
  report(`Submitted on Base: ${hash}. Waiting for inclusion.`);
  for (let i = 0; i < 90; i++) {
    if (signal?.aborted)
      throw new Error(
        "Stopped waiting. The submitted transaction may still complete; check your wallet before retrying.",
      );
    const receipt = await wallet.request({
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (receipt) {
      if (receipt.status !== "0x1")
        throw new Error(
          "The transaction reverted. No seat was registered by this transaction.",
        );
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    "Still waiting for the transaction. Check your wallet before sending another payment.",
  );
}
export async function purchaseBoundSeats({
  config,
  methods,
  wallet,
  keys,
  report,
  signal,
}) {
  // Validate keys before connecting a wallet or requesting a token approval.
  const data = encodeDevicePurchase(
    methods["purchaseAndBind(bytes32[])"],
    keys,
  );
  const from = await checkedWallet(config, methods, wallet);
  const guard = watchWallet(wallet);
  try {
    for (const key of keys) {
      const bound = await wallet.request({
        method: "eth_call",
        params: [
          {
            to: config.registry,
            data: `0x${SEAT_METHODS["seatOfDevice(address,bytes32)"]}${addressWord(from)}${key.slice(2)}`,
          },
          "latest",
        ],
      });
      if (!/^0x[0-9a-f]{64}$/i.test(bound))
        throw new Error(
          "Could not check existing bridge bindings. No payment was requested.",
        );
      if (BigInt(bound) !== 0n)
        throw new Error(
          "This wallet already has a seat for one of these bridge keys. Check activation instead of paying again.",
        );
    }
    const amount = CPHY_PRICE * BigInt(keys.length);
    const allowance = await wallet.request({
      method: "eth_call",
      params: [
        {
          to: CPHY_TOKEN,
          data: `0xdd62ed3e${addressWord(from)}${addressWord(config.registry)}`,
        },
        "latest",
      ],
    });
    if (!/^0x[0-9a-f]{64}$/i.test(allowance))
      throw new Error("Could not read token allowance.");
    if (BigInt(allowance) < amount) {
      report(
        `Approve exactly ${21000 * keys.length} CPHY for the reviewed seat registry in your wallet.`,
      );
      await guard.check(from);
      const hash = await wallet.request({
        method: "eth_sendTransaction",
        params: [
          {
            from,
            chainId: "0x2105",
            to: CPHY_TOKEN,
            data: `0x095ea7b3${addressWord(config.registry)}${uintWord(amount)}`,
            value: "0x0",
          },
        ],
      });
      await waitForReceipt(wallet, hash, report, signal);
    }
    if (signal?.aborted)
      throw new Error(
        "Purchase cancelled before sending. An approved token allowance may remain; manage it in your wallet.",
      );
    // Revalidate chain, bytecode and immutables after an approval wait.
    await guard.check(from);
    const current = await checkedWallet(config, methods, wallet, false);
    if (current.toLowerCase() !== from.toLowerCase())
      throw new Error(
        "Wallet account changed. Review your approval before starting again.",
      );
    report(
      `Confirm ${keys.length} seat${keys.length === 1 ? "" : "s"} for ${21000 * keys.length} CPHY in your wallet. Base gas is additional.`,
    );
    await guard.check(from);
    const hash = await wallet.request({
      method: "eth_sendTransaction",
      params: [
        { from, chainId: "0x2105", to: config.registry, data, value: "0x0" },
      ],
    });
    await waitForReceipt(wallet, hash, report, signal);
    return { hash, owner: from };
  } finally {
    guard.close();
  }
}
export async function rebindSeat({
  config,
  methods,
  wallet,
  seatId,
  key,
  report,
  signal,
}) {
  if (!bytes32(key) || !/^[1-9][0-9]*$/.test(String(seatId)))
    throw new Error("Enter a valid seat ID and pair the replacement bridge.");
  const selector = methods["rotate(uint256,bytes32)"];
  if (selector !== SEAT_METHODS["rotate(uint256,bytes32)"])
    throw new Error(
      "Registry rotation interface does not match the reviewed release.",
    );
  const from = await checkedWallet(config, methods, wallet);
  const guard = watchWallet(wallet);
  try {
    report(
      "Confirm moving this seat to the paired bridge. The previous bridge binding will stop working.",
    );
    await guard.check(from);
    const hash = await wallet.request({
      method: "eth_sendTransaction",
      params: [
        {
          from,
          chainId: "0x2105",
          to: config.registry,
          data: `0x${selector}${uintWord(seatId)}${key.slice(2)}`,
          value: "0x0",
        },
      ],
    });
    await waitForReceipt(wallet, hash, report, signal);
    return { hash, owner: from };
  } finally {
    guard.close();
  }
}
