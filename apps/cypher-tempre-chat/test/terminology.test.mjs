import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeModelText, sanitizeModelValue } from "../lib/terminology.mjs";

const priorName = ["qua", "lia"].join("");
const priorGate = ["Po", "Q"].join("");
const retired = new RegExp(`${priorName}|${priorGate}`, "i");

test("model context uses current terminology without mutating raw history or signals", () => {
  const signal = new AbortController().signal;
  const source = {
    system: `Proof of ${priorName}, ${priorGate}Gate, ${priorGate.toLowerCase()}.py`,
    messages: [{ role: "user", content: `Explain ${priorName} carefully.` }],
    covenant: ["love", "kindness"],
    perspectives: [
      { [priorGate.toLowerCase()]: { rationale: priorName.toUpperCase() } },
    ],
    signal,
  };
  const serialized = JSON.stringify(source);
  const normalized = sanitizeModelValue(source);
  assert.equal(JSON.stringify(source), serialized);
  assert.notEqual(normalized.messages, source.messages);
  assert.equal(normalized.signal, signal);
  assert.doesNotMatch(JSON.stringify(normalized), retired);
  assert.equal(normalized.system, "Proof of interaction, PoIGate, PoI.py");
  assert.equal(
    normalized.messages[0].content,
    "Explain interaction carefully.",
  );
  assert.equal(normalized.perspectives[0].poi.rationale, "INTERACTION");
  assert.equal(
    sanitizeModelText("Peace, facts, and honest disagreement."),
    "Peace, facts, and honest disagreement.",
  );
});

test("model context cannot silently collapse conflicting compatibility keys or pollute prototypes", () => {
  assert.throws(
    () => sanitizeModelValue({ [priorGate.toLowerCase()]: 1, poi: 2 }),
    /conflicting/,
  );
  const value = sanitizeModelValue(JSON.parse('{"__proto__":{"safe":true}}'));
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, "__proto__"), true);
  assert.equal({}.safe, undefined);
});

test("shipped source and filenames contain only current interaction terminology", async () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const ignored = new Set([".git", ".local", "node_modules", "__pycache__"]);
  const binary = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".ico",
    ".woff",
    ".woff2",
    ".ttf",
    ".otf",
    ".pyc",
  ]);
  const failures = [];
  let inspected = 0;
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename);
      if (retired.test(relative)) failures.push(relative);
      if (entry.isDirectory()) await visit(filename);
      else if (
        entry.isFile() &&
        !binary.has(path.extname(filename).toLowerCase())
      ) {
        inspected++;
        if (retired.test(await fs.readFile(filename, "utf8")))
          failures.push(relative);
      }
    }
  }
  await visit(root);
  assert.ok(
    inspected > 60,
    "The scan includes the bundled native engine and application source.",
  );
  assert.deepEqual(
    failures,
    [],
    "Source still contains retired branding in these files.",
  );
});
