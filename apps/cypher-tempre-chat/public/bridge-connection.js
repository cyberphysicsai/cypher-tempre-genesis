// Hosted pages can contact only an explicitly selected loopback port. Neither a
// query parameter nor a caller-supplied URL can redirect a pairing code or key.
export function isLocalBridgePage(pageOrigin) {
  const url = new URL(pageOrigin);
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  );
}

export function bridgePort(value) {
  const port = String(value).trim();
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535)
    throw new Error("Enter the local bridge port, from 1 to 65535.");
  return port;
}

export function bridgeApiUrl(path, pageOrigin, port = "8790") {
  if (!/^\/api\/[a-z]+(?:[-/][a-z]+)*$/.test(path))
    throw new Error("Invalid local bridge request path.");
  if (isLocalBridgePage(pageOrigin)) return path;
  if (new URL(pageOrigin).protocol !== "https:")
    throw new Error(
      "Open the hosted interface over HTTPS or use the local bridge page.",
    );
  return `http://127.0.0.1:${bridgePort(port)}${path}`;
}
