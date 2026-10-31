# Upstream maintenance

OpenClaw is a pinned runtime dependency, not a copied source tree. ChainChat
changes live in this application's plugin, launcher, adapter and UI. The
upstream npm package is unmodified, and its MIT license and dependency notices
remain in the installed package. The canonical Timechain engine has its own
independent source commitment and compatibility tests.

`upstream-lock.json` records the exact OpenClaw version and npm integrity. The
runtime `package.json` and `package-lock.json` must agree with that commitment.
The Windows Node/CPython versions and official archive SHA-256 values are pinned
in the same file. Setup refuses a different upstream version or damaged archive.

An update is a reviewed release, not an unattended merge of executable code:

1. Read the upstream release notes and security advisories. Select an exact
   release; do not replace the pin with `latest`, a version range or a mutable
   Git branch.
2. Update the runtime dependency and lockfile, then update `upstream-lock.json`
   from the official npm metadata. For a Node/CPython update, verify the official
   checksum/signature metadata and update its exact URLs and SHA-256 values.
3. Run plugin hook-contract tests and a real gateway smoke test with local model
   fixtures. Exercise a rejected tool action and rejected output, interrupted
   turns, retries, paused learning, credential isolation and fresh identity.
4. Run native chain/registry verification and original-skill round trips. No
   upstream update may rewrite old rings or replace the paired chain with an
   unrelated chat-memory format.
5. Build the sanitized application and installer, validate their hashes, and run
   setup twice into an isolated installation while checking existing data bytes.
   Do not activate a candidate that cannot pass the installed runtime check.
6. Publish the tested package and pin together. Preserve the previous immutable
   release so the launcher can select it for recovery. Back up persistent state
   before adopting any intentional, separately tested schema migration.

Upstream patches improve the inherited runtime only after a compatible update
has been tested and distributed. They do not automatically audit ChainChat's
plugin, enforce a model's semantic judgment, or guarantee benchmark scores.
