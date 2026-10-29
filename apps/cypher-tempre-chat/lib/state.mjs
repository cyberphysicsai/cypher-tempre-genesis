import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultCognition } from "./cognition.mjs";

export const defaultSettings = () => ({
  recall: true,
  fork: false,
  perspectives: 5,
  archetypes: [],
  continuum: { enabled: false, mode: "turn", targetBytes: 65536 },
});
export const defaultLoadout = () => ({
  modalities: ["2", "5", "37"],
  senses: ["5", "10", "84"],
});
export function validateSettings(input, previous = defaultSettings()) {
  const value = {
    ...previous,
    ...input,
    continuum: { ...previous.continuum, ...input.continuum },
  };
  if (
    typeof value.recall !== "boolean" ||
    typeof value.fork !== "boolean" ||
    !Number.isInteger(value.perspectives) ||
    value.perspectives < 1 ||
    value.perspectives > 21
  )
    throw new Error("Choose 1–21 perspectives and valid ability toggles.");
  if (
    !Array.isArray(value.archetypes) ||
    value.archetypes.length > 21 ||
    value.archetypes.some((a) => typeof a !== "string")
  )
    throw new Error("Choose valid perspective archetypes.");
  if (
    typeof value.continuum.enabled !== "boolean" ||
    !["turn", "bytes"].includes(value.continuum.mode) ||
    !Number.isSafeInteger(value.continuum.targetBytes) ||
    value.continuum.targetBytes < 1 ||
    value.continuum.targetBytes > 1073741824
  )
    throw new Error(
      "Block size must be an integer from 1 byte to 1 GiB. Larger corpora can span multiple blocks.",
    );
  return {
    recall: value.recall,
    fork: value.fork,
    perspectives: value.perspectives,
    archetypes: [...new Set(value.archetypes)],
    continuum: {
      enabled: value.continuum.enabled,
      mode: value.continuum.mode,
      targetBytes: value.continuum.targetBytes,
    },
  };
}
export async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(temporary, file);
}
export class StateStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, "agents.json");
    this.agents = [];
  }
  async load() {
    try {
      this.agents = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error(
          "Local agent index is unreadable. Restore it before starting.",
        );
    }
    return this;
  }
  async save() {
    await writeJSON(this.file, this.agents);
  }
  async add(root, name, owned) {
    const normalized = (value) =>
      process.platform === "win32"
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
    const existing = this.agents.find(
      (a) => normalized(a.root) === normalized(root),
    );
    if (existing) return existing;
    const record = {
      id: randomUUID(),
      name,
      root: path.resolve(root),
      owned,
      loadout: defaultLoadout(),
      settings: defaultSettings(),
      cognition: defaultCognition(),
    };
    this.agents.push(record);
    await this.save();
    return record;
  }
  pendingFile(agent) {
    return path.join(this.root, "pending", `${agent.id}.json`);
  }
  async pending(agent) {
    try {
      return JSON.parse(await fs.readFile(this.pendingFile(agent), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return { exchanges: [], bytes: 0, expectedHead: null };
    }
  }
  async savePending(agent, pending) {
    await writeJSON(this.pendingFile(agent), pending);
  }
}
