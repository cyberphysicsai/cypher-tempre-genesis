# Cypher Tempre Chat

A bring-your-own-model Agentic Timechain Metaprogramming Interface for Cypher Tempre. Monochrome physics diagrams, ambient DNA helices and timechain blocks, an MMO-style ability bar, and a real Timechain underneath.

This local application includes the complete Proof of Interaction engine. Its module, gate, score fields, skill instructions, and model-facing vocabulary use PoI throughout. It does not replace an installed skill or rewrite existing history.

## Start

Install Node.js 20+ and Python 3.10+. No npm packages or Python packages are needed.

```sh
npm start
```

Open **http://127.0.0.1:8790**. Enter the pairing code printed in the terminal, then:

1. Seal a fresh genesis, or pair the absolute directory of an existing Timechain skill containing `chain/` and `registry/`.
2. Connect your provider, exact model ID, optional base URL, and API key.
3. Equip modalities and senses. Enable perspective forking or adjust Continuum if desired.
4. Chat. The bridge reviews the generated answer, runs the native PoI gate, and commits accepted interactions according to the selected block policy.

Use `CT_CHAT_PYTHON` to select a Python executable, `CT_CHAT_PORT` to change the port, or `CT_CHAT_DATA` to select a local data directory. The default data directory is `.local/`, excluded from Git. Close the server to end its credential sessions. Reloading the browser requires a new pairing and model connection.

## Live beta at cyphertempre.ai

Run `npm run beta` on the same machine as your Timechain, then open https://cyphertempre.ai and pair using the code printed by the bridge. Approve your browser's local-network permission when requested. The official site uses loopback port 8790; it does not tunnel or expose that port to the Internet. A local-only alternative is `npm start` and http://127.0.0.1:8790. Hosted pairing tokens are restricted to their exact originating site and remain in memory.

The chat is followed by the preserved read-only chain auditor. It pairs independently with the original audit bridge on port 8788. Existing chain and registry files are not included in downloads or uploaded to hosting.

Paid activation is **not open in this beta build**. The Base registry is implemented and tested locally, but not deployed. `public/license-config.json` deliberately has `required:false`, `registry:null` and no runtime hash. **Do not send CPHY directly to the treasury; direct transfers do not register seats.**

After a reviewed deployment, one persistent bridge instance costs 21,000 CPHY. N seats cost N times that amount. The browser requires the reviewed runtime bytecode, exact token, treasury and price before offering wallet transactions, and requests exact token approval. The bridge checks the same deployment and owner-scoped key binding at a canonical Base block, after two L2 confirmations. This is provisional activation, not final settlement. RPC errors hold required operations; license approvals are cached for at most 30 seconds.

A random Ed25519 identity stays in `.local/bridge-identity.json`. Back it up securely: never publish it or send it to someone else. A fresh browser challenge verifies possession before payment. The purchasing wallet owns the seat and can rotate it to a replacement bridge; a sponsor buying seats for others retains that recovery authority. The chosen public owner address is saved only locally in `.local/license-selection.json`.

This does not prove unique physical hardware or prevent people from copying keys or modifying open-source checks. It needs no customer account database, but wallet addresses, payments, seat ownership, and key commitments are public. Hosting/RPC providers can observe network metadata. See `contracts/README.md` and `contracts/artifacts/base-deployment.json` for the undeployed contract, tests and wallet handoff. No production deployment or payment is performed by the bridge.

## Your ability bar

| Ability | Actual behavior |
| --- | --- |
| Recall | Retrieves relevant verified memories through the skill engine and includes them in the model context. |
| Chronosynaptic | Select 1–21 original modality archetypes in an orbital picker. Generates independent candidate answers, reviews them, synthesizes accepted candidates, and preserves their public findings in the sealed turn through the native explicit-note interface. |
| Continuum | One accepted input/output pair per conversation block by default. Optional byte thresholds accumulate approved turns in a durable pending buffer. Commit immediately with **Commit pending block**. Manual text ingestion creates native source-data blocks. |
| Faculties | Equip actual base and grown modalities/senses. Their descriptions, executable computations, and frames condition the model. The catalogue refreshes from the paired chain. Emergent proposals are visible but cannot be equipped until promoted. |
| Faculty Exchange | Preview and import another agent's native JSON faculty pack, or export selected learned faculties for someone else to import. Imported faculties appear in the live inventory and can be equipped immediately. |
| Verify | Rechecks canonical hashes, linked blockspace, registry epochs, and an existing witness quorum. |
| Covenant | Always active. Cannot be unequipped or bypassed through a client-supplied score. |

The chain grows through the native Cambium interface after a successful conversation commit. Growth can create auxiliary faculty and registry-epoch rings; “one turn per block” refers to the conversation ring, not the absence of bookkeeping rings.

## Exchange modalities and senses

Open **Faculty Exchange** in the loadout panel. On **Receive**, load or paste a faculty-pack JSON file and preview it. The preview checks its schema, checksum, duplicate coverage, and immune screen without modifying the chain. Import requires a connected model: the complete proposed capability change is reviewed against genesis and the native PoI gate before the registry changes. After a successful import, the catalogue refreshes with the adopted senses/modalities ready to equip. Covered duplicates are reported instead of being added again.

On **Share**, select promoted, learned or imported faculties, name the pack, and download its JSON file. Give that file to another agent's owner, who imports it through the same flow. This is portable capability exchange; there is no payment system or marketplace service. The original format supports up to 50 faculties per pack and 800 characters per faculty function. The base catalogue is already installed on every agent and is not exported; emerging proposals must be promoted first.

Packs carry lens definitions and limited provenance, not conversation history, private sources, API keys, model weights, or executable Python. A checksum detects changes to the pack body; it does **not** authenticate the declared donor's identity. An imported lens is evaluated and calibrated through the receiving agent's own experience. Existing chain history and genesis remain intact.

## Genesis and release gate

New agents begin with **love, peace, joy, kindness, mildness, self-control, goodness, patience, and faith** in their genesis covenant. Existing genesis values are retained and supplied to the reviewer alongside these nine required values.

Generated text is held on the local server. A separate model call assesses the complete proposed response against the actual genesis covenant and supplies all six PoI dimensions and all nine fruitage scores. Every fruitage and the covenant score must reach **180/255**, or a stricter native policy floor. Missing, malformed, failed, or low assessments hold the response. The native PoI gate then independently evaluates the candidate using its original policy, grounding, and consistency checks. Only accepted text can be released.

The reviewer is a separate call to the selected model, not an independent source of truth. These checks enforce the assessments supplied; they cannot guarantee moral correctness, factual accuracy, or resistance to every prompt injection. No unreviewed token streaming is used. This preview has **no shell, browser, filesystem-editing, purchasing, messaging, or arbitrary tool executor** for generated model actions. It cannot carry out commands contained in a response.

In size-based mode, approved responses may be shown as **pending** before a conversation block is sealed. Pending data is stored locally and is explicitly distinguished from verified chain history. A manual flush rechecks the pending exchanges. A chain changed by another writer causes stale work to be held rather than overwriting that writer’s history. Lost commit receipts can be recovered without duplicating a turn. Held candidates are excluded from browser history and pending-response recovery until the release checks succeed.

## Model providers and privacy

Supported protocol adapters:

- OpenAI Responses API.
- OpenAI-compatible chat completions, including a local model server.
- Anthropic Messages API.
- Google Gemini `generateContent`.

Model IDs are supplied by you. Your API key stays in bridge-session memory, is never written to an agent chain or settings file, and is not put into browser storage. **Disconnect model**, **End session**, server shutdown, or session expiry removes the stored credential. Reloading loses the browser token; use End session for explicit immediate cleanup. The bridge sends credentials only in request headers, requires HTTPS for remote endpoints, and refuses redirects. HTTP is allowed for loopback model servers. Use a provider endpoint you trust.

**This chat sends your prompt, selected recalled memories, equipped faculty context, and generated candidate responses to the provider you choose.** It differs from the original read-only auditor, which makes no model calls. Provider retention and billing depend on that provider; OpenAI requests set `store: false`. More perspectives require more requests. With all candidates accepted, N perspectives use 2N + 2 model calls (candidate/review for each, then synthesis/review).

The server binds to loopback, validates Host and Origin, requires a terminal pairing code and an in-memory bearer token, and rejects cross-origin requests by default. `CT_CHAT_PUBLIC_ORIGINS` can explicitly allow a trusted hosted frontend; local serving is the tested preview path. The application does not upload a whole chain, but selected recall content can be sensitive. Agent state and pending conversation files are local sensitive data; protect the account and disk accordingly.

## Compatibility and limits

The bundled `engine/proof-of-interaction` is the complete [Proof of Interaction engine](https://github.com/cyberphysicsai/proof-of-interaction), under its MIT license. The runtime uses `PoI.py`, `PoIGate`, `POI_DIMENSIONS`, `poi` scores, and `poi_verdict` records. Coherence, relevance, novelty, consistency, depth, covenant, brightness, policy thresholds, immune screening, recall, perspective collapse, Continuum, and growth retain their scoring and operational behavior.

Existing chains retain their immutable historical bytes and hashes. The adapter reads earlier score-policy structure in memory, while new blocks use the PoI schema. A history created by another application can contain older user-authored vocabulary; provider-bound text is normalized to interaction terminology before generation or review. This presentation step does not rewrite archived records, API keys, provider URLs, or model IDs. Archived original material should be inspected directly when exact quotations matter.

Use this application's adapter to continue an earlier chain. Standalone bundled CLI commands expect the PoI schema and are not a general migration tool for earlier score-field names.

This is a working chat surface for the core abilities requested, not a graphical replacement for every maintenance CLI in the skill. Repair, witness setup, advanced pack authoring, specialized benchmarks, full-corpus review ledgers, and other administrative operations remain available through the bundled engine. The UI's **Verify** button is integrity verification; it is not a claim that every source block was cognitively audited.

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
