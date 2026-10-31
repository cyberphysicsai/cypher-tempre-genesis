# Cypher Tempre OpenClaw enforcement plugin

This module targets the pinned OpenClaw `2026.10.9` public plugin contract. It
registers prompt preparation, input admission, pre-tool decisions, finalization,
and reply-delivery checks through `api.on`. It does not modify upstream files or
replace the native Timechain format.

The trusted ChainChat process registers each unique Gateway session before
inference. The plugin calls that process's numeric-loopback HTTP broker using a
private bearer held in `CHAINCHAT_BROKER_TOKEN`. The normal configuration stores
only `brokerTokenEnv`, not the credential, in Gateway configuration. Never inject
the credential into model instructions or log transport errors.

Every broker response binds `version:1`, the exact `sessionKey` and `runId`, a
registered `purpose` (`candidate` or `utility`), and an explicit boolean `allowed`.
Unknown runs and failures deny action/delivery. Prompt preparation receives only
the broker's verified native skill context and explicitly allowed tool names.
Utility inference is a host-registered model call for review/planning, or an
explicitly paused plain request; it cannot acquire tools or turn itself into a
candidate run.

Candidate finalization requires a fresh receipt with the exact candidate SHA-256,
genesis hash, expected head, semantic/native review acknowledgement, and bounded
expiry. Tool calls require an equipped name and review of their exact argument
envelope before execution. Partial replies, tool summaries, changed text and
unsupported media are cancelled. No raw prompt, model response or tool argument
is written to plugin logs or disk.

Finalization hooks can request bounded revision but cannot themselves establish
that every Gateway API path withheld output. The supported ChainChat transport
therefore independently checks the candidate receipt before accepting Gateway
output; the existing native conversation transaction must seal before the UI can
release a response. This two-process contract is required. Do not advertise a
standalone arbitrary OpenClaw installation as having equivalent delivery
enforcement just because this module loaded successfully.

The installation enables `hooks.allowConversationAccess` and
`hooks.allowPromptInjection` for this reviewed plugin. The broker's transport
deadline is shorter than the registered hook deadline, so failures normally
return explicit deny/cancel results instead of an upstream timeout fallback.
Health checks and upgrade tests must exercise actual hooks and held candidates,
not merely check the plugin inventory.

Run `node --test test/openclaw-enforcement.test.mjs` for protocol and hook
negatives. The real Gateway and UI acceptance tests also require
`CT_OPENCLAW_PACKAGE` (the pinned npm package directory) and
`CT_OPENCLAW_NODE` (its supported Node executable). Run
`test/openclaw-gateway.test.mjs` and `test/openclaw-integration.test.mjs` with
those variables when upgrading the pin. To test an installed release, set
`CT_CHAINCHAT_PACKAGE` to the installed application directory and
`CT_CHAT_PYTHON` to its embedded Python executable. The UI tests then load the
installed server, Gateway, plugin and native engine. Their providers and scores
are local deterministic fixtures; they verify enforcement and integration,
not answer-quality improvement or public benchmark results.
