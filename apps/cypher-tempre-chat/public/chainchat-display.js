export function supportedBridgeVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) return false;
  const value = version.split(".").map(Number);
  if (!value.every(Number.isSafeInteger)) return false;
  const minimum = [0, 9, 2];
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
