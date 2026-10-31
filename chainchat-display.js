export function supportedBridgeVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) return false;
  const value = version.split(".").map(Number);
  if (!value.every(Number.isSafeInteger)) return false;
  const minimum = [0, 6, 1];
  for (let i = 0; i < minimum.length; i++) {
    if (value[i] > minimum[i]) return true;
    if (value[i] < minimum[i]) return false;
  }
  return true;
}

export function blockHeight(agent, paired = true) {
  if (!paired || !agent) return "—";
  const index = agent.head?.index;
  if (typeof index === "number")
    return Number.isSafeInteger(index) && index >= 0
      ? index.toLocaleString()
      : "—";
  if (typeof index === "string" && /^(0|[1-9][0-9]*)$/.test(index))
    return BigInt(index).toLocaleString();
  return "—";
}

export function formatTokenBalance(raw) {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return "—";
  const units = BigInt(raw), scale = 10n ** 18n;
  const fraction = (units % scale).toString().padStart(18, "0").replace(/0+$/, "");
  return `${(units / scale).toLocaleString()}${fraction ? `.${fraction}` : ""}`;
}

export function requiresHoldings(path, data) {
  if (data === undefined) return false;
  if (path === "/api/cancel") return false;
  if (path === "/api/cognition" && data?.mode === "dormant" && data.confirm === true &&
      Object.keys(data).every(key => ["mode", "confirm"].includes(key))) return false;
  if (["/api/pair", "/api/unpair", "/api/agents/pair", "/api/agents/select",
    "/api/verify", "/api/faculties/preview", "/api/faculties/export"].includes(path)) return false;
  if (path.startsWith("/api/license/")) return false;
  if (path === "/api/provider" && data?.disconnect === true) return false;
  return true;
}
