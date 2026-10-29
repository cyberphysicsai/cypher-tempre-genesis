# Preview validation

## Beta 0.3.0

- Full Node integration suite: 83 passed, 1 Windows-specific skip. Native scoring parity reference was supplied. JavaScript syntax checks pass.
- Solidity registry: 13 local EVM tests passed, including atomic payment, exact receipt, owner-only recovery, owner-scoped front-running resistance, malicious token callbacks and compiled runtime comparison.
- Wallet tests cover exact quantities, pinned selectors and runtime, network/account changes, disabled payments, and fresh Ed25519 bridge proofs.
- Hosted bridge tests cover exact HTTPS origins, session-origin binding, loopback endpoint restrictions, CORS and auditor embedding. License checks use a pinned deployment and a canonical Base block; verification failure and mid-generation expiry prevent release.
- Current payment configuration is deliberately disabled. No mainnet contract deployment, wallet transaction or live paid model request was performed.
- The existing auditor is preserved below the chat, with memory-only pairing credentials and Orbitron typography. It continues to use its separate original bridge on port 8788.
- Browser automation stopped before final beta UI/deployment verification. Unit and HTTP integration checks passed; actual hosted-to-local pairing must be checked after Hostinger deployment and the user's local bridge restart. Prior 0.2.1 layout checks below are retained as earlier evidence, not claimed as beta browser verification.

Version 0.2.1 presentation validated locally on 2026-10-28. The engine and provider results below were established for 0.2.0; their implementation is unchanged in this typography update. This is a working local preview; no change was deployed to the original GitHub repository or website.

## Presentation update

- Browser title and brand subtitle read **Agentic Timechain Metaprogramming Interface**.
- Orbitron is the only declared and bundled typeface. Every interface element reports Orbitron in browser computed styles, including chat input, code, forms, menus and faculty text. Native file controls and placeholders explicitly inherit it.
- Desktop 1440×1000 and mobile 390×844 layouts have no horizontal overflow. The mobile header has separate rows for branding and actions; the conversation heading does not overlap its status controls. The narrower ability bar uses three columns.
- The perspective dialog has no horizontal overflow on mobile and uses Orbitron throughout. The previous handwriting asset, preload, and font stacks were removed.
- JavaScript syntax checks pass. No live provider request was made for this presentation update.

## Results

| Check | Result |
| --- | --- |
| Node.js 22.23.2: providers, bridge security, faculty exchange, native integration and external compatibility | 53 passed; 1 test skipped because it specifically checks case-sensitive non-Windows paths |
| Python 3.12.10 on Windows: adapter regressions | 29 passed |
| Python 3.14.4 on WSL Linux, extracted onto a native `/tmp` filesystem | 29 passed |
| JavaScript syntax checks | Passed |
| Bundled engine Git blobs and executable modes | All 65 files identical to the published Proof of Interaction engine |
| Native scoring comparison against an independently stored original engine | 44 cases match exactly: six dimensions, brightness, grounding, policy thresholds and all four decisions |
| Retired product terminology in source and release archive | Zero case-insensitive matches in paths or contents, including the bundled skill and font assets |
| Desktop 1440×1000 and mobile 390×844 browser inspection | Passed; no horizontal overflow on the phone layout |
| Source archive | Git-tracked files only; no `.local`, chains, pending conversations, credentials, caches, or private learned registries |

## Behavior exercised

- Fresh genesis contains all nine requested fruitages.
- Pairing an original-skill chain leaves its existing bytes unchanged. After a chat append, the original `timechain.py verify` still passes.
- Model changes retain the same genesis, root, and history.
- Selected faculties run their native computations. Different equipment selections are retained per exchange inside a batched block.
- Three-perspective chat integration produces reviewed candidates and a native explicit-note collapse; a separate adapter regression covers all 21 perspectives.
- Native low-consistency rejection, each low fruitage, missing assessments, malformed review data, missing native acceptance, and invalid commit receipts hold output.
- A post-seal guard failure cannot expose its candidate through history, recall, or pending-response polling.
- A deliberately lost receipt recovers the same committed ring, without duplicating it.
- Two concurrent native writers cannot both commit against the same expected head.
- Size-based conversation accumulation, automatic thresholds, manual re-reviewed flush, stale external appends, and exact paired input/output storage work.
- Continuum preserves source whitespace and UTF-8 bytes. Each source block contains reviewed findings in canonical Continuum state. A source exceeding 1 MiB at a 2 MiB commitment boundary produces exactly one source ring after all semantic-window reviews. Rejecting its second window leaves the chain unchanged.
- Growth produces actual faculties and auxiliary registry epochs; full verification remains valid.
- Host/Origin checks, pairing throttling, bearer authentication, key exclusion from persisted state, provider disconnect, and session cancellation are exercised.
- Faculty pack preview and export leave the complete agent tree byte-identical. Tampered hashes, malformed entries, active code fields, name collisions, stale heads, low fruitage reviews, and native low-consistency scores reject imports. Invalid later entries cannot cause a partial import.
- A real native sense imports, equips, exports, and imports into a second fresh agent with its definition, category, and seed terms intact. The recipient retains its own genesis and empty conversation history. Export excludes private history and credentials; declared donor identity is explicitly unverified.
- Transaction failure regressions cover byte-exact registry rollback before an epoch commit and retention of the committed epoch plus recovery evidence after a later failure.
- Browser QA covered bridge pairing, fresh Cypher Tempre genesis, verified state, equipment selection, the 21-position radial menu, KB/MB controls, and mobile drawers. The monochrome revision also exercised valid pack preview, model-connection gating, empty share inventory, and the exchange modal at phone width.
- All interface CSS/SVG color literals are grayscale. The original dashboard's animated atom, DNA, timechain, and Lissajous motifs are adapted with reduced-motion support.
- Native runtime, skill text, new score fields and verdicts use Proof of Interaction (PoI). The central tree/atom illustration and history headline remain removed.
- Generation and review tests cover all four provider protocols, inherited memory and faculty text, input/output normalization, retained credentials, cancellation signals, and unchanged original input in local history. Normalized output is reviewed before release; the rename does not weaken the gate.
- A true external original-engine fixture retains its byte-identical historical prefix and policy file after a new PoI append. Both engine verifiers pass. Its stricter 200 consistency floor still rejects a score of 190. The original native brightness cap remains binding.
- Orbitron is bundled with its SIL OFL license and serves locally as `font/ttf` for all interface text.
- Output formatting uses DOM nodes, never injected HTML. Script-looking content and links in model text remain inert.

## Remaining verification limits

Cloud provider calls used local protocol fixtures; no live paid API key was supplied or used. The full HTTP-to-Python-to-Timechain integration uses the real engine and filesystem, with only model generation/review replaced by test fixtures. A live provider/model combination should be checked using the user's own key before a public launch.

No external action/tool executor is exposed. Semantic model assessments are fallible; the enforced gate is not a guarantee of correctness or moral judgment. Large source ingestion, context windows, block thresholds, and optional administration CLI limits are described in `README.md`.

The original remote remained at `73c5013f654979b26dc10bbec58d834d976f3c34` throughout this work. No existing personal Timechain was paired or modified by the chat preview. The active browser preview uses a separate, fresh Cypher Tempre genesis; the prior demo genesis was archived locally without rewriting its history.

The external parity checks can be repeated by setting `CT_PARITY_REFERENCE` to an independently stored original skill directory outside this product, then running `node --test test/compatibility.test.mjs`. They skip when that optional reference is unavailable. The reference engine is never included in the release. Compatibility of earlier schemas is provided by the app adapter; standalone CLI commands assume the current schema.
