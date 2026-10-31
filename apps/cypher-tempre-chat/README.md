# Cypher Tempre ChainChat

A bring-your-own-model Agentic Timechain Metaprogramming Interface for Cypher Tempre. Monochrome physics diagrams, ambient DNA helices and timechain blocks, an MMO-style ability bar, and a real Timechain underneath.

This local application includes the complete Proof of Interaction engine. Its module, gate, score fields, skill instructions, and model-facing vocabulary use PoI throughout. It does not replace an installed skill or rewrite existing history.

## OpenClaw edition

ChainChat runs the official, unmodified **OpenClaw 2026.10.9** gateway with a separate Cypher Tempre plugin. The current chat, skill bar, faculty inventory, perspective controls and native Timechain orchestrator remain the interface. The bundled native engine's 65 files are unchanged. This is an OpenClaw-backed distribution; there are no upstream source patches to rebase.

The private plugin broker verifies the paired chain, injects the actual PoI skill and equipped native faculty context, and reviews the exact generated candidate. The transport requires a matching candidate receipt, and the chat orchestrator performs the final native review and atomic commitment before releasing active-chain output. A prompt reminder alone is not the enforcement boundary. OpenClaw's standalone hooks have failure paths that continue execution, so this supported plugin/transport/orchestrator combination must stay together.

External host tools are disabled by default. This edition does not silently grant a model filesystem, browser or shell control. Its cognitive faculties, memory, native growth, perspective search and explicitly requested reviewed maintenance remain available. Utility planning calls cannot invoke tools or recursively commit. Deliberately dormant chat follows the existing plain-call behavior.

Exact dependency patches are applied separately from the unmodified upstream package. Known upstream bundled-library audit findings remain; see [the security boundary and residual risks](openclaw/SECURITY.md). This beta is not a zero-vulnerability or hallucination-free claim.

## Install on Windows

Download **CypherTempre-ChainChat-Setup-0.7.0-windows-x64.exe** from the release and run it. Setup installs verified portable Node/Python runtimes and locked dependencies for the current user, creates a Start Menu shortcut and opens the local chat. No administrator rights or global runtime installation are needed. First setup requires Internet access. The executable is not Authenticode-signed; release hashes and the open build source are supplied.

Versioned application releases are separate from persistent `data/`. Existing external Timechains stay in their original directories. Setup checks a release before activation and preserves the previous release for rollback. See [installer/README.md](installer/README.md) for installation details and [openclaw/UPSTREAM.md](openclaw/UPSTREAM.md) for tested upstream updates.

## Start from source

Use Node **24.22.1+ within 24.x, or 26.12.1+**, and Python 3.10+. Install both locked dependency sets; no Python packages are needed.

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix openclaw/runtime
npm start
```

The launcher opens **http://127.0.0.1:8790** with an expiring one-use pairing link. A subsequent launch reopens the running instance with a new link. You can also enter the local terminal's pairing code manually. Then:

1. Connect your wallet and sign the readable ChainChat sign-in message. Keep at least **21,000 CPHY** in that wallet on Base. Signing does not transfer tokens or approve spending.
2. Seal a fresh genesis, or pair the absolute directory of an existing Timechain skill containing `chain/` and `registry/`. **Find existing local Timechains** searches bounded known agent locations only when clicked; select a result and explicitly verify/pair it. You can always enter a path manually. Existing chains can be paired and inspected before wallet verification.
3. Connect your provider, exact model ID, optional base URL, and API key.
4. Equip modalities and senses. Enable perspective forking or adjust Continuum if desired.
5. Chat. OpenClaw executes model turns; the private PoI service and native orchestrator review candidates and commit accepted interactions according to the selected block policy. The ability bar reflects actual runtime events.

**Current block height** is the paired chain's last sealed block index. Genesis is height 0. Pending exchanges do not advance it. An unpaired chain shows a dash, and refreshes read the actual chain head rather than predicting the next index.

Use `CT_CHAT_PYTHON` to select a Python executable, `CT_CHAT_PORT` to change the port, or `CT_CHAT_DATA` to select a local data directory. Source defaults to `.local/`, excluded from Git; setup uses its installation's persistent `data/`. `node openclaw/launcher.mjs --check` verifies the pinned runtime and native engine. `node openclaw/launcher.mjs --stop` authenticates and stops only this installation's owned runtime. Reloading clears browser pairing and requires a fresh launch/pairing and model connection. Developer-only `npm run dev` retains the earlier direct-provider server and does not exercise OpenClaw enforcement.

## Live beta at cyphertempre.ai

Launch the installed ChainChat shortcut or run `npm run beta` on the same machine as your Timechain. In the local chat, open the connection panel and choose **Show website pairing code**. At https://cyphertempre.ai, pair with that code and allow local-network access if your browser requests it. The official site uses loopback port 8790; it does not tunnel or expose that port to the Internet. The complete chat also works on its local page. Hosted pairing tokens are restricted to their exact originating site and remain in memory.

The hosted interface requires runtime **0.7.0 or newer** before pairing. Updating the website does not update a previously running local installation: install the new package and launch its shortcut.

The chat is followed by the preserved read-only chain auditor. It pairs independently with the original audit bridge on port 8788. Existing chain and registry files are not included in downloads or uploaded to hosting.

The UI, Gateway, native chain, registries and pending blocks run on the user's machine. Model requests still go to the chosen provider, and wallet balance checks go to Base RPC. Provider API keys stay in ChainChat process memory and the local authenticated proxy, never the Gateway's configuration, transcripts, exported faculty packs or browser storage. The Gateway receives private temporary proxy credentials instead. Upstream may store local conversation/runtime artifacts inside the installation's data directory; these are local data, not a cloud backup. Stop the local runtime to clear its credential sessions.

## CPHY holdings access

ChainChat requires at least **21,000 existing CPHY** at `0x08Df470d41C11Ba5Cb60242747D76C65Ca52c94c` on **Base Mainnet (8453)**. `public/license-config.json` enables holdings access by default. No payment registry, token transfer, spending approval, permit, or wallet transaction is used. The earlier contract prototype in `contracts/` is unused by ChainChat; do not deploy it or send tokens to obtain holdings access.

Wallet control is verified using a fresh, single-use Sign-In with Ethereum message scoped to the page origin, Base, pairing session and bridge key. The challenge expires after five minutes; wallet authorization expires after 30 minutes. Normal account signatures and supported deployed ERC-1271 smart-wallet signatures are verified by the bridge. Connecting a wallet or typing an address does not unlock access.

The bridge reads the exact token balance at a canonical Base block, using integer units and a two-block confirmation delay. Successful balance results expire within 30 seconds. Model calls and native writes check access again, including after long generation/review work. Insufficient holdings, session expiry or failed RPC verification pause new protected operations. Pairing, inspection, verification, faculty preview/export and disconnect remain available; a failed holdings check never deletes local history.

Each native mutation is authorized immediately before it starts. An atomic block write already in progress may finish if eligibility changes during that write; its real receipt and committed history are retained. Further blocks and model calls are held. This avoids reporting an already-written block as failed or silently duplicating it on retry.

A random Ed25519 identity stays in `.local/bridge-identity.json`. Keep it private. The browser verifies a fresh proof of that identity, configuration and access state. Wallet signatures and authorization grants are held only in memory, bound to one pairing session. Wallet/network changes revoke the session; restarting or ending the bridge session requires signing in again. No customer account database is created, and no chain or model key is sent to a wallet service.

This gate is enforced by the distributed bridge and frontend. It is not a hosted authorization service: people controlling an open-source copy can change the checks. One eligible wallet may authorize more than one installation; the threshold does not reserve exclusive seats, prove unique hardware, or prove continuous historical ownership. A copied software key can be reused. Wallet addresses and balances are public, and hosting/RPC providers can observe connection metadata. These limits also apply when using the official static website.

## Your ability bar

| Ability | Actual behavior |
| --- | --- |
| Recall | Retrieves relevant verified memories through the skill engine and includes them in the model context. |
| Chronosynaptic | Select 1–21 modality archetypes in the radial picker, plus 1–64 continuation attempts and depth 1–8. Each candidate and continuation is a real model call with semantic review and native gating. Native UIC selection, backpropagation, profile contrast and starvation choose the tree path. Final synthesis is reviewed again. |
| Continuum | One accepted input/output pair per conversation block by default. Optional byte thresholds accumulate approved turns in a durable pending buffer. Commit immediately with **Commit pending block**. Manual text ingestion creates native source-data blocks. |
| Faculties | Equip actual base and grown modalities/senses. Their descriptions, executable computations, and frames condition the model. The catalogue refreshes from the paired chain. Emergent proposals are visible but cannot be equipped until promoted. |
| Faculty Exchange | Preview and import another agent's native JSON faculty pack, or export selected learned faculties for someone else to import. Imported faculties appear in the live inventory and can be equipped immediately. |
| Verify | Rechecks canonical hashes, linked blockspace, registry epochs, and an existing witness quorum. |
| Covenant | Required for every active-Timechain answer and reviewed capability mutation. Missing or low scores hold output; a bounded revision can be generated and reviewed afresh. Deliberately paused ordinary chat has no Timechain gate. |
| Route / Replay | Native routing proposes relevant antecedents. Reuse requires model confirmation, canonical source evidence and fresh semantic/native review. Failed replay falls back to fresh generation. Recall-off also disables routing. |
| Learning | Enables equipped-faculty teaching, local telemetry and optional Cambium gap growth. Turning it off freezes learned state while active chat still reviews and records conversation history. |
| Dream | Preview and deliberately run native consolidation, index rebuilding or guarded local operator training. Optional idle consolidation runs after 100 new blocks while learning is on. |
| Cognition | Pause/resume, semantic recall, growth, revision and search controls, live execution timeline, faculty lifecycle and a capability manifest. |

An outlined skill button means configured; a glowing button means the bridge reports that stage currently executing. Completed, held and cancelled events remain in the activity timeline. This feed contains operation labels and counters, not prompt text or API keys. Stale, disconnected or other-agent activity is not displayed as current execution.

Each accepted chain response can also include **Faculty receipts**. **COMPUTED** means the bridge completed the listed mechanism; **FRAME APPLIED** means a faculty instruction entered model context. **UNSUPPORTED**, **UNAVAILABLE**, **EXECUTION FAILED**, and **CODE QUARANTINED** make execution limits visible. Inventory badges explicitly refer to the **last chain turn**, independently of the current equipment selection. They are not live running indicators or evidence of improved answer quality. Reviewed memory replay and response revisions appear beside the accepted message's seal receipt and remain available in saved history when the bridge provides their metadata.

The chain grows through native Cambium after a successful conversation commit when learning and growth are enabled. Newly sprouted, imported or promoted faculties appear in inventory **unequipped** until chosen. Inspect a proposal before promotion; **Prune** means reversible hibernation, preserving its identity and history. Wake restores availability, not automatic equipment. Faculties with authored code require the native explicit local code-review workflow. Descriptive faculties condition model context; supported primitive operators also produce concrete computed features.

Growth and maintenance can create auxiliary faculty and registry-epoch rings; “one turn per block” refers to the conversation ring, not the absence of bookkeeping rings. Learning feedback is derived from an already accepted exchange. A failed learning update is reported without losing its successful seal receipt.

Maintenance writes a durable recovery journal before changing active operators. Changed operator files must match sealed native adoption records before completion. An interruption, inconsistent adoption or failed final receipt holds further chain work and preserves backups and history for local review; the interface never clears that hold automatically.

## Pause and learning controls

**Pause Timechain** is a deliberate, confirmed user action. It requests cancellation of in-flight model work and then uses native dormancy. A native atomic write that already started may finish and retains its receipt. Subsequent paused chat requests are stateless ordinary API calls: no chain memory, faculties, PoI review, teaching, growth or conversation commitment. Native integrity/status inspection still works. Paused messages are not added to chain history or used as context for another paused call. Resume preserves the existing genesis, chain and pending active conversation block.

**Learning off** is distinct: the active agent still recalls, reviews and seals accepted conversation, but learning telemetry, teaching, growth, training and consolidation are suppressed. Resume learning to change learned faculties or run maintenance. Pause and Stop remain available if wallet eligibility expires; enabling work still requires holdings verification.

Semantic recall asks the model to select valid memory shapes, queries, offered ring IDs and equipped faculty labels. The bridge validates the plan and uses native shaped retrieval, temporal structures and canonical evidence. Invalid plans use a bounded native fallback. At most two retrieval requests and 40 canonical evidence records enter a turn; coverage limitations travel with the context. A selected evidence page is not proof of an exhaustive corpus total or absence.

## Exchange modalities and senses

Open **Faculty Exchange** in the loadout panel. On **Receive**, load or paste a faculty-pack JSON file and preview it. The preview checks its schema, checksum, duplicate coverage, and immune screen without modifying the chain. Its mechanism compatibility report distinguishes supported computations, context frames, unsupported mechanisms and quarantined authored code. It lists the metadata field names preserved for each faculty and any companion-runtime requirement. A checksum alone does not establish execution support. Import requires a connected model: the complete proposed capability change is reviewed against genesis and the native PoI gate before the registry changes. After a successful import, the catalogue refreshes with the adopted senses/modalities available for inspection and equipment where supported. Covered duplicates are reported instead of being added again.

On **Share**, select faculties the bridge marks exportable, name the pack, and download its JSON file. This can include quarantined faculty data without making it equippable or executable. Give that file to another agent's owner, who imports it through the same flow. This is portable capability exchange; there is no payment system or marketplace service. The original format supports up to 50 faculties per pack and 800 characters per faculty function. The base catalogue is already installed on every agent and is not exported.

Complete packs preserve faculty definitions, recipes, frames, routing hints, seed terms, lifecycle records, donor learned-head snapshots and provenance. Authored source travels as quarantined data; import does not approve or execute it. Donor learning snapshots remain inactive; they are not counted as recipient experience. Whole-chain pairing retains the agent's own active learned state. Browser exports default to the complete format, bounded to 4 MiB and 50 faculties. Old lens-only packs still import, but cannot recover data their exporter omitted.

The bridge never includes its stored conversation history or session API key in a faculty export. Faculty definitions, learned metadata and authored source can themselves contain private material: inspect the JSON before sharing it. An authored pack may include the whole `active_ops.py` module and its helper functions. A checksum detects changes; it does **not** authenticate donor identity or capability quality. Existing chain history and genesis remain intact.

### Exchange with an original skill installation

Use the included `skill_interop.py` companion alongside the unchanged original skill. Its native `faculties.py` importer only reads the lens projection; use this companion for full fidelity. Run these from the ChainChat package directory, substituting your trusted engine path, agent root and faculty keys:

```powershell
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\my-agent" export --keys modality:108 sense:109 --out full-pack.json
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" preview --pack full-pack.json
```

Import the exported JSON through ChainChat's Faculty Exchange, or have your coding agent freshly review the companion preview against the recipient's genesis. Save the review as JSON containing `planHash`, `expectedHead`, UTC `reviewedAt`, all six integer `scores`, and `assessment` with `approved`, all nine integer `fruitages`, and `rationale`. The CLI validates the review, native gate, current head and exact plan before applying it:

```powershell
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" import --pack full-pack.json --review review.json --expected-head HEAD_HASH --plan-hash PLAN_HASH --confirm
```

Reviews expire after ten minutes. Imports use a write-ahead journal, native registry epochs and a sealed adoption receipt. A failed partial import holds the chain for local recovery review; `recovery-status` reports the journal without performing a blind rollback.

### Authored operators

For a paired agent that already has `active_ops.py`, review its code and imports, then run `approve-code` locally with the exact digest shown in Cognition controls. When receiving a module in a pack, `materialize-code` first places the exact reviewed module from its authenticated artifact. It refuses to overwrite an existing module. **An original skill may autoload the materialized file on its next run.** ChainChat additionally requires separate approval:

```powershell
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" materialize-code --sha256 SOURCE_SHA256 --confirm
python skill_interop.py --engine "C:\trusted\skill" --root "C:\agents\recipient" approve-code --sha256 SOURCE_SHA256 --confirm
python skill_interop.py --root "C:\agents\recipient" revoke-code --confirm
```

Approval binds the source, authorized faculty names, local Python dependencies, native runtime, root and genesis to a sealed receipt. Changing these requires renewed approval. Static `OPS` dictionary names are detected without executing code; for a dynamic mapping, explicitly supply `--names "Exact Faculty Name"` during approval. Only equipped, authorized names can launch that module. Proposed faculties still require native promotion; approval does not invent an earned faculty. After approval, equip the supported grown faculty in ChainChat. Execution uses a bounded child process, with timeout and output limits. **This is not a security sandbox:** approved Python and its imports have the user's OS permissions. Dependencies must be installed locally; missing or unsupported mechanisms are reported rather than silently described as executed. No browser or model endpoint can grant code approval.

Execution also requires a matching installation-local approval record in `.local/operator-approvals/`, outside the agent directory. Keep that directory private and preserve it with the local ChainChat installation. A chain-carried receipt or copied approval manifest has no authority on its own. A fresh installation or moved agent requires local review and approval again; importing a chain or faculty pack never grants execution permission. The approval directory cannot be inside the selected agent or traverse symbolic links. Revoking approval removes its local record as well as appending the chain revocation receipt.

## Genesis and release gate

New agents begin with **love, peace, joy, kindness, mildness, self-control, goodness, patience, and faith** in their genesis covenant. Existing genesis values are retained and supplied to the reviewer alongside these nine required values.

Generated text is held on the local server. A separate model call assesses the complete proposed response against the actual genesis covenant and supplies all six PoI dimensions and all nine fruitage scores. Every fruitage and the covenant score must reach **180/255**, or a stricter native policy floor. Missing, malformed, failed, or low assessments hold the response. The native PoI gate independently enforces its policy thresholds and mechanical grounding checks. It uses the model-supplied consistency score; it does not independently establish the semantic truth of the response. Only accepted text can be released.

The reviewer is a separate call to the selected model, not an independent source of truth. These checks enforce the assessments supplied; they cannot guarantee moral correctness, factual accuracy, or resistance to every prompt injection. No unreviewed token streaming is used. This preview has **no shell, browser, filesystem-editing, purchasing, messaging, or arbitrary tool executor** for generated model actions. It cannot carry out commands contained in a response.

The reviewer receives bounded canonical evidence and recent conversation context, and must identify the ring indices it actually relied on. The bridge validates those indices against verified, released, nonquarantined history. The native gate reads the corresponding evidence directly from that history; retrieved memories are not automatically counted as evidence used. This activates the native aggregate-coverage checks and, when the chain policy enables it, entity-grounding enforcement. These are finite checks of supplied evidence, not external fact verification: a false statement can still pass when the model judges it incorrectly.

Generation, review and native grounding also receive verified agent identity and runtime facts derived from genesis and the installed interface. This supports honest introductions on a fresh chain without requiring invented memories. The review rubric assesses completeness relative to the request: a brief greeting need not demonstrate every emotion or add unnecessary novelty and detail. Identity facts do not establish personal memories, completed actions, external benchmark scores or historical corpus totals. Browser-supplied identity metadata cannot replace the verified source, and all score floors remain enforced.

In size-based mode, approved responses may be shown as **pending** before a conversation block is sealed. Pending data is stored locally and is explicitly distinguished from verified chain history. A manual flush rechecks the pending exchanges. A chain changed by another writer causes stale work to be held rather than overwriting that writer’s history. Lost commit receipts can be recovered without duplicating a turn. Held candidates are excluded from browser history and pending-response recovery until the release checks succeed.

## Model providers and privacy

Supported protocol adapters:

- OpenAI Responses API.
- OpenAI-compatible chat completions, including a local model server.
- Anthropic Messages API.
- Google Gemini `generateContent`.

Model IDs are supplied by you. Your API key stays in bridge-session memory, is never written to an agent chain or settings file, and is not put into browser storage. **Disconnect model**, **End session**, server shutdown, or session expiry removes the stored credential. Reloading loses the browser token; use End session for explicit immediate cleanup. The bridge sends credentials only in request headers, requires HTTPS for remote endpoints, and refuses redirects. HTTP is allowed for loopback model servers. Use a provider endpoint you trust.

**This chat sends your prompt, selected recalled memories, equipped faculty context, and generated candidate responses to the provider you choose.** It differs from the original read-only auditor, which makes no model calls. Provider retention and billing depend on that provider; OpenAI requests set `store: false`. With all candidates accepted, N initial perspectives use 2N + 2 model calls; every accepted continuation adds two more calls. Semantic planning adds one, and revisions or reviewed maintenance add further calls. Search iterations bound continuation attempts; the tree reports actual explored depth and counts. Paused ordinary chat uses one call.

The bridge rejects exact occurrences of the active API credential in model-bound content, returned model data and decoded reviewer data before they can become output or chain records. This prevents accidental credential reflection; it is not a general secret detector or protection against an untrusted provider. Source ingestion applies the native secret-pattern redactor before provider calls and storage, and records redaction counts. Patterns cannot identify every secret; inspect sensitive source material before submitting it.

The official website does not upload entered model keys or chain history to its host. However, its JavaScript runs in the browser where keys are entered and chain data is displayed. A compromised site, extension or local machine could access that data. Local-only serving reduces dependence on future hosted-page changes; remote model and RPC services still receive their respective requests. Wallet addresses and RPC connection metadata are not anonymous.

OpenCode Go can use the OpenAI Responses adapter with base URL `https://opencode.ai/inference/go/openai/v1`. ChainChat sends its own user agent and a random session identifier to the official Go endpoint. For example, `muse-spark-1.3-contributor` requires the user's existing Go access and applicable privacy settings. Its provider terms permit training on prompts and completions; use synthetic or otherwise shareable content. Consult the [current provider documentation](https://opencode.ai/v2/docs/console/go) for access, pricing and retention.

Reviews, retrieval plans and Chronosynaptic candidates for that exact Muse model through the official Go Responses endpoint receive an output allowance of **8,192 tokens**. Real-model benchmarks exhausted smaller limits during review and perspective generation. Other models retain 2,048 tokens for those steps. Ordinary chat and final synthesis retain 4,096 tokens; source summaries retain 1,536. Incomplete provider responses fail closed. A valid held assessment can trigger the configured 0–3 fresh revision attempts; no failed candidate is released without passing review and the native gate.

The server binds to loopback, validates Host and Origin, requires a terminal pairing code and an in-memory bearer token, and rejects cross-origin requests by default. `CT_CHAT_PUBLIC_ORIGINS` can explicitly allow a trusted hosted frontend; local serving is the tested preview path. The application does not upload a whole chain, but selected recall content can be sensitive. Agent state and pending conversation files are local sensitive data; protect the account and disk accordingly.

## Compatibility and limits

The bundled `engine/proof-of-interaction` is the complete [Proof of Interaction engine](https://github.com/cyberphysicsai/proof-of-interaction), under its MIT license. The runtime uses `PoI.py`, `PoIGate`, `POI_DIMENSIONS`, `poi` scores, and `poi_verdict` records. Coherence, relevance, novelty, consistency, depth, covenant, brightness, policy thresholds, immune screening, recall, perspective collapse, Continuum, and growth retain their scoring and operational behavior.

Existing chains retain their immutable historical bytes and hashes. The adapter reads earlier score-policy structure in memory, while new blocks use the PoI schema. A history created by another application can contain older user-authored vocabulary; provider-bound text is normalized to interaction terminology before generation or review. This presentation step does not rewrite archived records, API keys, provider URLs, or model IDs. Archived original material should be inspected directly when exact quotations matter.

Use this application's adapter to continue an earlier chain. Standalone bundled CLI commands expect the PoI schema and are not a general migration tool for earlier score-field names.

This is a working chat surface for the core abilities requested, not a graphical replacement for every maintenance CLI in the skill. Repair, witness setup, advanced pack authoring, specialized benchmarks, full-corpus review ledgers, and other administrative operations remain available through the bundled engine. The UI's **Verify** button is integrity verification; it is not a claim that every source block was cognitively audited.

The chat now orchestrates native routing/reviewed replay, bounded model-directed shaped memory, native MCTS with model-generated continuations, equipped-label teaching, controlled growth, dormancy and local maintenance. Those controls change actual execution and model context. Recovery, witness administration, task-chain links, full-corpus audit queues and arbitrary coding/browser/game/robotics tool environments remain outside the chat orchestration. The capability manifest identifies these boundaries. Bundling a CLI does not mean the chat automatically invokes it.

Identical engine code and matching deterministic scores do not establish equal answer quality, latency, cost or long-horizon learning across models. Exact benchmark parity requires the same environment, observations/actions, data, checkpoint/model settings, initial chain, budget and evaluator. Local LIBERO and RoboCurve artifacts inspected for this work use specialist simulation policies and harnesses; they do not establish that a text-only API call reproduces those results. No new paid model benchmark was run for this release.

Each local HTTP request accepts up to 16 MiB. Model transports enforce bounded text/context sizes and providers have their own context windows. Manual source ingestion keeps your selected KB/MB storage boundaries, while reviewing source text in UTF-8-safe windows up to 128 KiB. Larger blocks combine those reviewed findings through bounded groups of at most eight, reviewing every combined synopsis as well. The lowest score from any window or reduction remains binding; the native PoI gate checks the final block synopsis. Only then does that storage block commit and the next block begin. Window findings and counts are retained in the source ring. A failure reports how many prior blocks committed; it never claims the whole source completed.

Conversation accumulation supports targets up to 1 GiB, with a maximum of 1,000 exchanges per batch. It commits at the target or the exchange cap. Turns are never split mid-message, so a final turn can take a block above the selected target. This is a byte measure of paired input/output JSON, not model tokens. Review and final output generation are bounded by the selected provider's context window, independently of the storage target.

## Checks

```sh
npm run check
npm test
npm run test:engine
```

Provider tests use local HTTP fixtures and never need paid credentials. Python tests use disposable chains to verify engine interoperability, rejected scores, concurrency checks, faculty execution, and Unicode source blocks. See `VALIDATION.md` for the completed checks and any remaining verification limits.

## Layout

- `public/` — buildless browser app, local assets only.
- `server.mjs` — authenticated local bridge, chat orchestration and pending blocks.
- `lib/providers.mjs` — four credential-isolated model transports and semantic reviewer.
- `engine_bridge.py` — JSON adapter to the Proof of Interaction Python engine.
- `engine/proof-of-interaction/` — skill, documentation and runtime.
- `.local/` — your agents and pending blocks; never distribute this directory.

MIT licensed. Engine attribution is retained in `LICENSE` and the bundled skill. The locally bundled Orbitron typeface has its own open-font license in `public/fonts/`.
