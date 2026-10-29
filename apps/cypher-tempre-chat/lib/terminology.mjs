/** Normalize copied model context; never rewrite authenticated chain bytes. */
const priorName = ["qua", "lia"].join("");
const priorGate = ["Po", "Q"].join("");
const namePattern = new RegExp(priorName, "gi");
const gatePattern = new RegExp(priorGate, "gi");
const modulePattern = new RegExp(`${priorGate}\\.py`, "gi");

function matchCase(match, replacement) {
  if (match === match.toUpperCase()) return replacement.toUpperCase();
  if (match === match.toLowerCase()) return replacement.toLowerCase();
  return replacement;
}

export function sanitizeModelText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(namePattern, (match) => matchCase(match, "Interaction"))
    .replace(modulePattern, "PoI.py")
    .replace(gatePattern, (match) => matchCase(match, "PoI"));
}

/** Provider credentials/configuration must never be passed into this function. */
export function sanitizeModelValue(value) {
  if (typeof value === "string") return sanitizeModelText(value);
  if (Array.isArray(value)) return value.map(sanitizeModelValue);
  if (
    value !== null &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = sanitizeModelText(key);
      if (Object.hasOwn(result, normalizedKey))
        throw new TypeError(
          "Model context contains conflicting compatibility keys.",
        );
      Object.defineProperty(result, normalizedKey, {
        value: sanitizeModelValue(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  // AbortSignal, Date and other non-JSON transport objects retain their identity.
  return value;
}
