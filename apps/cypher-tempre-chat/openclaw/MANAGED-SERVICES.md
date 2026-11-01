# Managed OpenClaw services

ChainChat runs the pinned, unmodified OpenClaw package. Its mandatory local
plugin and parent process supply action admission, exact-content review receipts
and the final Timechain commitment. These controls apply to model actions; they
are not an operating-system sandbox or a guarantee that model judgments are true.

## Browser

Enable Browser in OpenClaw settings and grant exact public hostnames. It uses a
new, installation-owned Chromium profile, never a personal signed-in profile.
The original native browser schema and executor run in the pinned first-party browser plugin.
Each concrete action receives a fresh semantic review, native PoI evaluation and
target check. Use one primitive action or form field per call. Compound batches and
multiple-field calls are held; the model can issue separate reviewed calls.
Cross-origin frame element references are held when the target cannot be
verified against the current top-level tab. A failure stops the remaining
sequence. Outcomes, rather than approvals alone, ground subsequent responses.

The owned process uses an authenticated loopback proxy with DNS resolution and
public-address checks on every connection. Redirects, frames and subresources
remain inside the hostname grant. Network access is paused between admitted
invocations. Both automation clients use a private, capability-authenticated CDP
relay. The parent answers only Basic-auth challenges from the exact owned proxy;
it never supplies that credential to website login challenges. The browser child
receives only the OS environment it needs. Credential fields and payment or wallet interactions require
additional explicit grants. Model-supplied JavaScript requires all three
evaluation, credential and payment acknowledgments because arbitrary page code
cannot be safely restricted by checking its words. The private metadata-only
perception helper does not grant model-supplied code execution. Uploads require granted
file roots; downloads remain in the owned download directory. Local/private
destinations and unrelated browser profiles are unavailable through this adapter.

On Ubuntu 23.10+ and systems with restricted unprivileged user namespaces,
downloaded Chromium may be refused by AppArmor before the browser starts. Use
an OS-supported Chrome/Chromium installation with its distribution security
profile, or ask an administrator to review an AppArmor namespace exception for
the exact managed executable. The exception is specific to that executable;
keep its installation directory private and review it again when the binary
path changes. ChainChat keeps Chromium's sandbox enabled and does not modify
system policy or disable namespace restrictions globally. See the
[Chromium AppArmor guidance](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)
and [Linux setup notes](../installer/POSIX.md#linux-browser-sandbox-policy).

## Channels and scheduled turns

First enable the matching bundled or third-party channel plugin through Trusted
native plugins. Its exact reviewed artifact must declare the channel ID.
Connect native channel credentials in the separate password fields, then bind a
channel/account/conversation and explicit sender allowlist to a verified genesis.
Incoming text cannot choose an owner, chain, tool grant or recipient. Authorized
text messages enter the same prepare/generate/review/commit pipeline as chat.
Outgoing text receives a separate review and a one-use exact-route/content
authorization before the native transport sends it. Media payloads require their
own reviewed adapter and are held by the current text transport.

Ingress uses the published `message_received` observation hook with native
channel, account, conversation, sender and message identities. Observation does
not admit the native channel's model run: that unregistered run and its replies
remain held. Only the separately admitted managed turn may infer and deliver.
This keeps native goals compatible with OpenClaw's restart-safety rules.
Human operator commands follow OpenClaw's own channel authorization. PoI's
model-action boundary does not turn those explicit human controls into model
actions; ChainChat's local pause and revocation controls remain available.

Native cron schedules run a fixed, inert local signal. The parent then starts the
reviewed turn; cron cannot select an arbitrary command, independent model run or
direct recipient. Unknown enabled native jobs are quarantined before the managed
scheduler starts. One-shot, interval and five-field cron/timezone schedules are
supported. The optional model automation tool can manage only the current agent's
managed jobs and bindings, after its separate per-agent grant and PoI review.

Automation requires the local app, a live eligible owner session and a connected
model. Background work retains the exact authorizing session, provider and
wallet-authorization epoch; it never borrows another client's API key. After a
restart or provider change, explicitly resume or wake the selected agent's work.
Pausing a channel also revokes dependent scheduled deliveries. Pausing the chain
or losing credentials holds work. Native history and the
local durable queue preserve accepted occurrences; ambiguous outgoing outcomes
are marked for inspection and are never blindly resent. Inference consumes the
selected provider's normal API budget. Changing chain selection in the UI does
not redirect an existing binding to another genesis.

Channel credentials are passed through private child-process environment
references and are not stored in the trust/job files or model context. Reconnect
them after app restart. Native channel implementations may maintain their own
local authorization/session state; this is platform-specific. Model API keys
remain in the parent process's session memory. Model requests and relevant
context are sent to the user's chosen provider, as with ordinary BYOK chat.

## Compaction

`/compact` and native context pressure use the mandatory reviewed context engine.
It summarizes complete older transcript turns while preserving recent complete
turns and tool-call/result relationships. The parent reviews the exact selected
source and summary, checks the current Timechain head and issues a short-lived
one-use receipt before native transcript persistence. A summary is a record of
conversation, not proof of outside facts or a new canonical Timechain ring.
Denied/stale summaries leave the native transcript and Timechain unchanged.

Accepted native-turn advancement has a retained, atomic idempotency receipt.
Private model-route capabilities are stripped before requests reach the provider;
unregistered summary calls cannot authorize generation. The parent checks the
actual mandatory engine at startup, before native work and before every provider
forward. Factory and context faults latch a held engine instead of allowing a
legacy writer. An unexpected accepted-turn commit fault stops the owned Gateway
before upstream recovery can write a fallback; no success receipt is fabricated.

## Native plugins

Installing or activating native plugins requires explicit owner trust in an exact
package, version and resolved artifact identity, as well as PoI admission of the
lifecycle action. Native install-policy warnings and capability-consent checks
remain active. Updated artifacts require renewed trust. The mandatory PoI plugin
and context-engine slot cannot be disabled or replaced through these controls.

**Trusted native plugins run inside the Gateway with the user's OS permissions.**
They can execute arbitrary code outside model hooks. PoI reviews model-invoked
tools; it cannot intercept every filesystem, network or background operation in
arbitrary plugin code. Only install code you explicitly trust. Imported chains
and faculty packs do not automatically grant native-plugin trust.

The pinned native browser hook and context-engine contracts must be revalidated
when updating OpenClaw. See [upstream maintenance](UPSTREAM.md).
