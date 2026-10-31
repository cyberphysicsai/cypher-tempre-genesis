# Security boundary and upstream dependencies

This beta is a local, authenticated OpenClaw distribution with a reviewed plugin
and native Timechain orchestrator. Functional tests do not establish perfect
security, truthful model judgment or an absence of dependency vulnerabilities.

The installed UI initially authenticates with an expiring, single-use launcher
nonce. Same-tab reload can use a rotating opaque resume credential stored in
local-origin `sessionStorage`. That credential grants access to the same live
session; it is sensitive even though no provider API key or API bearer is saved
there. Resume requires both owner proof and the exact local Origin. Merely
forging loopback Origin/fetch headers cannot create a session. Session end,
expiry and runtime restart invalidate the grant; closing a tab is not a reliable
server-side revocation signal. The embedded auditor is trusted same-origin UI,
not a sandbox boundary. Its messaging protocol deliberately forwards only fixed
reads and never sends the model key or parent bearer into the frame.

The official OpenClaw source package stays at the exact commitment in
`upstream-lock.json`. A separate, exact dependency overlay selects external
Undici 8.12.3, Zod 4.6.7 and npm 12.2.1. These are ordinary dependency overrides,
not edits to the upstream source tarball. The runtime lockfile, setup integrity
checks and launcher doctor validate these selections. Adoption requires actual
Gateway and installed-application regression tests. Automatic upstream update
checks and automatic application of updates are disabled in the managed Gateway.

The overlay fixes replaceable external dependency copies. It does **not** replace
library code embedded inside OpenClaw or npm bundles:

- OpenClaw's compiled schema bundles contain Zod 4.6.5. The upstream collection
  bounds fix checks limits before parsing elements; replacing the external Zod
  npm package does not apply that fix to embedded code. See the
  [upstream Zod fix](https://github.com/colinhacks/zod/commit/a0ebf970f2d752e5f58527cd2942ff48be4f46bd).
- npm 12.2.1 still bundles Undici 6.29.0, with reported vulnerabilities. The
  [Undici advisory](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c)
  specifies a fixed 6.x version of 6.29.1. npm's own bundled files are not replaced
  by a top-level Undici override. The npm package-manager dependency tree also
  retains moderate audit findings. The
  [npm release notes](https://github.com/npm/cli/releases/tag/v12.2.1)
  do not establish that all its bundled dependencies are fixed.

The managed UI does not expose npm/package-manager tools. Host tools are
default-denied and require explicit per-agent grants, scope validation and fresh
semantic/native admission before each invocation. Exploratory search branches
and utility calls cannot use them. Gateway HTTP is authenticated and bound to numeric loopback; the UI never
receives its operator token. ChainChat constructs Gateway message envelopes,
limits them to 200 messages and sends no arbitrary browser-provided tool or
configuration schemas. Browser chat input becomes message text. The reviewed
HTTP schema uses unknown message/tool elements rather than the constrained
collection route identified in the Zod fix. Review found no identified path from
the current UI to that specific oversized-collection exploit. This is a scoped
reachability assessment, not proof that every embedded schema is safe.

The provider proxy bounds responses, refuses redirects and strips transport
encoding headers when forwarding decoded content. Provider credentials remain
in the parent process; the child receives private proxy credentials. Native
admission and exact candidate receipts remain required regardless of model
output. Default-denied tools are not an OS sandbox: explicitly approved native
operator code still runs with the local user's permissions.

Do not expose the Gateway or ChainChat HTTP ports publicly or treat arbitrary
standalone OpenClaw plugins, channels, CLI commands or tools as covered by this
configuration's tests. Extending those paths requires a fresh security review.
Use `npm audit --omit=dev` in `openclaw/runtime` when reviewing updates, inspect
embedded libraries as well as lockfile findings, and test a reviewed upstream
release containing those fixes before removing the residual notices. An audit
with zero lockfile findings would not itself prove embedded copies are fixed.


## Native controls and explicit local tools

Native goals/preferences have durable local session state; BYOK keys and wallet
authorization remain in parent-process memory. The operator token never reaches
the browser. Native schema inspection is redacted; edits cannot remove required
PoI enforcement or replace managed credentials, plugins or gateway bindings.
Deterministic native slash-command results are control output, not model answers
or fabricated conversation seals.

Granting exec/process permits broad execution as the local OS user. Directory and
requested-host lists do not sandbox arbitrary subprocesses. File grants are
canonicalized, reject symlink escapes and protect application/data/paired-chain
roots. Browser automation grants are unavailable until a managed network adapter
can safely constrain Chromium traffic; requested-navigation checks alone cannot
contain DNS changes, redirects and page subresources. Web-fetch grants retain
native DNS/private-network checks and disable redirects. These checks do not
constitute a system firewall or OS sandbox. Separate native channels/cron/operator entry points
remain guarded because they do not inherit browser-turn admission automatically.
