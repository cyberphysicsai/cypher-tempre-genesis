// These are the actual 21 shipped reasoning modalities, not invented character powers.
import { readFileSync } from "node:fs";
const registry = JSON.parse(
  readFileSync(
    new URL(
      "../engine/proof-of-interaction/registry/modalities.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
export const archetypes = registry.modalities.map((f) => ({
  id: String(f.id),
  name: f.name,
  description: f.function,
  category: f.category,
}));

export function chooseArchetypes(settings) {
  const selected = new Set(settings.archetypes.map(String));
  const ordered = [
    ...archetypes.filter((a) => selected.has(a.id)),
    ...archetypes.filter((a) => !selected.has(a.id)),
  ];
  return ordered.slice(0, settings.perspectives);
}
