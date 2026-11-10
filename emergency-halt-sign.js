import {
  HALT_CHAIN_ID, HALT_ZERO_HASH, HALT_WALLET_LIFETIME_SECONDS, HALT_CPHY_LIFETIME_SECONDS,
  emergencyHaltTypedData,
} from "./emergency-halt-protocol.js";
import { downloadHaltJson } from "./emergency-halt.js";

const bytes32 = /^0x[0-9a-f]{64}$/i;
const address = /^0x[0-9a-f]{40}$/i;
const zeroAddress = "0x" + "0".repeat(40);
const signaturePattern = /^0x[0-9a-f]{130}$/i;
const matches = (value, pattern) => typeof value === "string" && pattern.test(value);

function parseProfile(value) {
  const fields = ["installationId", "nonce", "wallet", "cphyDestination"];
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.includes(key)) ||
      !matches(value.installationId, bytes32) || value.installationId === HALT_ZERO_HASH ||
      !matches(value.nonce, bytes32) || value.nonce === HALT_ZERO_HASH ||
      !matches(value.wallet, address) || value.wallet === zeroAddress ||
      (value.cphyDestination !== undefined && (!matches(value.cphyDestination, address) ||
        value.cphyDestination === zeroAddress || value.cphyDestination.toLowerCase() === value.wallet.toLowerCase())))
    throw new Error("Choose an enrollment profile exported by the installed ChainChat app.");
  return value;
}

const byId = id => document.getElementById(id);
const form = byId("haltSignerForm");
const input = byId("haltSignerProfile");
const cphy = byId("haltSignerCphy");
const transaction = byId("haltSignerTransaction");
const summary = byId("haltSignerSummary");
const submit = byId("haltSignerSign");
const download = byId("haltSignerDownload");
const result = byId("haltSignerResult");
const error = byId("haltSignerError");
let profile = null, signed = null, busy = false, readRevision = 0;

function clearCommand() {
  signed = null;
  download.hidden = true;
  result.textContent = "";
  error.textContent = "";
}

input.addEventListener("change", async () => {
  const revision = ++readRevision;
  const file = input.files?.[0];
  profile = null;
  submit.disabled = true;
  cphy.hidden = true;
  transaction.value = "";
  summary.textContent = "";
  clearCommand();
  if (!file) return;
  try {
    if (file.size > 8192) throw new Error("The enrollment profile exceeds 8 KiB.");
    const next = parseProfile(JSON.parse(await file.text()));
    if (revision !== readRevision) return;
    profile = next;
    cphy.hidden = !profile.cphyDestination;
    summary.textContent = `Installation ${profile.installationId}. Owner wallet ${profile.wallet}.` +
      (profile.cphyDestination ? ` Dedicated CPHY destination ${profile.cphyDestination}.` : "");
    submit.disabled = false;
  } catch (failure) {
    if (revision === readRevision) error.textContent = failure instanceof SyntaxError ? "The profile file is not valid JSON." : failure.message;
  }
});

transaction.addEventListener("input", clearCommand);

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (!profile || busy) return;
  clearCommand();
  const provider = window.ethereum;
  const requestedTransaction = transaction.value.trim();
  if (!provider?.request) {
    error.textContent = "Open this page in a browser with the enrolled Ethereum wallet.";
    return;
  }
  if (requestedTransaction && (!profile.cphyDestination || !bytes32.test(requestedTransaction) ||
      requestedTransaction.toLowerCase() === HALT_ZERO_HASH)) {
    error.textContent = "Enter a valid finalized Base transaction hash for the enrolled CPHY destination.";
    return;
  }

  busy = true;
  submit.disabled = input.disabled = transaction.disabled = true;
  result.textContent = "Check your wallet to continue…";
  try {
    const accounts = await provider.request({ method: "eth_requestAccounts" });
    const account = Array.isArray(accounts) ? accounts[0] : null;
    if (typeof account !== "string" || account.toLowerCase() !== profile.wallet.toLowerCase())
      throw new Error("Switch to the wallet enrolled in this profile.");
    const chainId = await provider.request({ method: "eth_chainId" });
    if (Number(chainId) !== HALT_CHAIN_ID) throw new Error("Switch your wallet network to Base before signing.");
    const lifetime = requestedTransaction ? HALT_CPHY_LIFETIME_SECONDS : HALT_WALLET_LIFETIME_SECONDS;
    const command = {
      installationId: profile.installationId,
      nonce: profile.nonce,
      expiresAt: Math.floor(Date.now() / 1000) + lifetime,
      transactionHash: requestedTransaction.toLowerCase() || HALT_ZERO_HASH,
    };
    const signature = await provider.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(emergencyHaltTypedData(command))],
    });
    if (typeof signature !== "string" || !signaturePattern.test(signature)) throw new Error("The wallet did not return a supported signature.");
    signed = { ...command, signature };
    download.hidden = false;
    result.textContent = `Publish the signed JSON at the HTTPS feed URL configured in ChainChat before this command expires in ${lifetime / 60} minutes.`;
  } catch (failure) {
    result.textContent = "";
    error.textContent = failure.code === 4001 ? "Wallet signing was cancelled." : failure.message || "Wallet signing failed.";
  } finally {
    busy = false;
    submit.disabled = input.disabled = transaction.disabled = false;
  }
});

download.addEventListener("click", () => {
  if (!signed) return;
  if (signed.expiresAt <= Date.now() / 1000) {
    clearCommand();
    error.textContent = "This command expired. Sign a new command before publishing.";
    return;
  }
  downloadHaltJson(document, "chainchat-halt.json", signed);
});
