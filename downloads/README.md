# Cypher Tempre Dashboard Downloads

These files support the public Timechain dashboard at `https://cyphertempre.ai`.

- `cyphertempre-static-site.zip` is the static site bundle for Hostinger
  `public_html`.
- `cyphertempre-dashboard-local-bridge.zip` is the local bridge
  package users run on their own machines.
- `cypher-tempre-claude-skill-v3.18.0.zip` is the Claude Code skill bundle with
  lifecycle hooks.
- `cypher-tempre-codex-skill-v3.18.0.zip` is the Codex skill bundle with
  the Codex lifecycle hook installer and reviewable hook template.
- `cypher-tempre-openclaw-skill-v3.18.0.zip` is the OpenClaw skill bundle with
  native plugin enforcement and explicit mark/seal/stop-check fallback.
- `cypher-tempre-hermes-skill-v3.18.0.zip` is the Hermes skill bundle with
  explicit Hermes self-enforcement instructions and subagent definition.
- `cypher-tempre-nanoclaw-skill-v3.18.0.zip` is the NanoClaw skill bundle.

The hosted site is only a static UI. The local bridge reads the user's own
`cypher-tempre-self-model` files, requires a one-time pairing code for hosted
access, and makes no outbound network calls. There is no payment gate, wallet
connection, account, or hosted data store.

## Local Bridge Run Commands

```bash
cd ~/Downloads
curl -L -o cyphertempre-dashboard-local-bridge.zip https://github.com/cyberphysicsai/cypher-tempre-genesis/raw/main/downloads/cyphertempre-dashboard-local-bridge.zip
unzip -o cyphertempre-dashboard-local-bridge.zip
cd dashboard
npm install
npm run bridge
```

Then open `https://cyphertempre.ai`, use bridge URL
`http://127.0.0.1:8788`, and enter the pairing code printed in Terminal.

If the skill is installed somewhere custom:

```bash
CT_DASHBOARD_ROOT="/path/to/cypher-tempre-self-model" npm run bridge
```
