import fs from "node:fs/promises";
import path from "node:path";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
} from "node:crypto";
const fail = (code, message, status = 503) =>
  Object.assign(new Error(message), { code, status });
const hash = (value) => createHash("sha256").update(value).digest("hex");
export async function loadIdentity(root) {
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
