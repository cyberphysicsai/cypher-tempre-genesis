# ChainChat validation

Validation separates deterministic engine behavior, application orchestration and real-model observations. Passing a transport or gate test does not establish equal answer quality across models, perfect security or elimination of hallucinations.

## OpenClaw edition: 0.7.0

The complete local Node suite passed **236 tests**, with one expected Windows case-sensitivity skip (237 total). Both independent original-skill reference variables and the actual pinned OpenClaw package/Node runtime were explicitly supplied. The Python suite passed **92 tests**, with one Windows symlink-privilege skip (93 total). Separate launcher tests passed after hardening browser-helper failure handling and crash-released Windows startup ownership. Syntax, whitespace, terminology and dependency-pin checks passed. All 65 bundled native engine files remain byte-identical to the independent PoI source commitment.

The external dependency overlay selects Undici 8.12.3, Zod 4.6.7 and npm 12.2.1; the Gateway's native automatic update checks/applications are explicitly disabled. The regression and real-Gateway tests are rerun for this overlay, and setup/doctor verify the actual installed versions. npm audit still reports one high and 34 moderate affected package entries in bundled npm dependencies. OpenClaw also embeds an older Zod copy which that lockfile audit does not enumerate. See [the exact residual boundary](openclaw/SECURITY.md); neither successful tests nor the overlay imply zero vulnerabilities.

Actual unmodified OpenClaw 2026.10.9 executed controlled local provider fixtures for OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages and Gemini. Tests exercised exact receipt enforcement, mismatched output rejection, cancellation, child restart and application restart. Six retained chat-API cases exercised verified introductions with equipped native faculties and existing-chain prefixes, covenant rejection, mutated receipts, utility memory planning, paused plain chat, and two perspective candidates plus synthesis with one final conversation seal. They asserted real provider/review calls, real native receipts and chain bytes, activity events, and absence of the supplied fixture API key in configuration. These tests use deterministic text/review scores, not paid-model quality benchmarks.

The private broker tests reject unknown/expired/mismatched runs, changed output, low fruitage and all ungranted tools. Plugin hooks alone are not the release boundary: the transport independently validates the exact candidate receipt, and the orchestrator requires its native commitment/release policy. External host tools remain disabled; this is not a claim that arbitrary shell/browser workflows have been enabled or benchmarked.

Windows setup has executable self-tests for archive traversal, Windows path collisions, long paths, tampering, fonts and atomic activation. `installer/acceptance_windows.py` performs a real isolated fresh/repeat installation with locked dependency downloads, embedded-Python native genesis/verification, data-preservation checks, installed-launcher HTTP mode, authenticated shutdown, tampered-candidate rejection and rollback. It does not touch a user's normal installation or use provider credentials. The real Gateway suites can also target the installed application through `CT_CHAINCHAT_PACKAGE`, `CT_OPENCLAW_PACKAGE`, `CT_OPENCLAW_NODE` and `CT_CHAT_PYTHON`.

To repeat the real runtime cases after installing the exact OpenClaw lockfile:

```powershell
$env:CT_OPENCLAW_PACKAGE = (Resolve-Path openclaw/runtime/node_modules/openclaw).Path
$env:CT_OPENCLAW_NODE = (Get-Command node).Source
node --test test/openclaw-gateway.test.mjs test/openclaw-integration.test.mjs
python installer/check_upstream.py
```

Use a supported Node runtime (24.22.1+ within 24.x, or 26.12.1+) and Python 3.10+. Public benchmark scores and an elimination of hallucinations are not established by these integration tests.

## Current conversation grounding fix: 0.6.1

The previous wrapper could withhold a fresh-chain introduction with six semantic scores of 235/255: it omitted the agent's genesis identity from native grounding and supplied no agent name to the separate reviewer. The native gate reported zero grounding and forced uncertainty for the otherwise supported introduction. The reviewer also required demonstrated strength of every value, which could penalize an ordinary greeting without a value conflict.

The adapter now derives a narrow identity/runtime context from verified genesis and the installed interface. Generation, review and native grounding receive that context; browser-supplied context cannot replace it. Identity is not counted as a historical evidence ring or as support for corpus totals. The reviewer assesses completeness relative to the task, while retaining all score floors and rejection of unsupported chain-specific claims.

The final local suite passed **193 Node tests** with one expected Windows platform skip (194 total), and **85 Python tests** with one symlink-privilege skip (86 total). JavaScript syntax and Git whitespace checks passed. New tests cover fresh named/generic introductions, custom names, native evaluation and commitment, recalled-memory-disabled HTTP chat, context delivery to the actual provider request serializer, malformed/forged context, armed entity grounding, unsupported dates/measurements/totals, and low fruitage/consistency rejection. The native engine source remains unchanged.

These checks use disposable chains and local model/reviewer fixtures. No new paid-provider benchmark was run. Semantic model judgments remain fallible; the tests establish the reproduced mechanical fix and review protocol, not universal acceptance across all providers.

## Earlier interoperability release: 0.6.0

Eight independent interoperability acceptance cases pass against an unchanged original 3.30.08 installation. They use real Python engines, local HTTP, disposable chains and synthetic generation/review transports. No paid provider calls, personal chains or real wallet signatures were used for these new changes.

| Area | Evidence |
| --- | --- |
| Original chain continuation | Pair an original-created chain, append through ChainChat, then resume native original sealing and growth. Historical bytes remain a prefix; both verifiers pass. |
| Faculty mechanisms | Original safe primitive outputs match; frames reach model context; original growth is equipable in ChainChat and ChainChat growth remains readable by the original engine. |
| Full portable packs | Original companion export → bundled-engine import → original companion return preserves safe specs, frame/hint/op effects, seed terms, dormant status, local ID rebinding and exact source lineage. HTTP import, equipment, export and return also pass. |
| Learned state | An original labeler is trained from synthetic teaching examples and adopted through its native holdout guard. Learning-frozen chat preserves its bytes. Gifted learned heads remain in authenticated provenance without silently becoming recipient training. |
| Model changes | The same verified memory, active frames and computed features reach another model configuration; unequipping removes current frame/computation activation. Provider weights do not transfer. |
| Semantic controls | Hibernation and Dream reviews receive the actual user reason, explicit confirmation, relevant canonical memory and precise reversible scope. Accepted controls preserve native verification. |
| Authored code | Pair, prepare, export and import do not execute pending code. A complete imported module can be materialized locally, separately approved by exact digest and deliberately equipped. Its output matches the original engine. |
| Approval boundaries | Source, native-runtime and local dependency bindings are checked. A copied approval on another root, changed source or changed local dependency suppresses execution. Code runs in a bounded subprocess with local OS permissions, not an OS sandbox. |

The original native format-1 importer still accepts the lens projection, with its original limited fidelity. Full restoration of rich state on an old skill installation requires `skill_interop.py`. The companion does not alter the original engine or the 65 bundled native files. Donor identity is unverified; hashes establish content integrity. Authored code and donor approval never activate automatically in a recipient.

An earlier separate local comparison matched all 42 base-faculty native computations. The regression suites cover 44 scoring parity cases and all four decisions, review/revision holds, pause/resume, stateless raw calls, learning freeze, activity isolation, stale heads, cancellation, replay, native tree search, Continuum and post-seal release checks. Maintenance and portable imports retain recovery journals and hold further work after interrupted or uncommitted mutations.

The final hardened suite, with both original-reference environment variables explicitly set, passed **187 Node tests**, with zero failures and one expected Windows platform skip (188 total). **77 Python tests** passed, with one symlink-privilege skip (78 total). JavaScript syntax and Git whitespace checks passed. The eight independent acceptance cases include actual materialization, original-runtime approval, HTTP equipment and dependency-change rejection. Additional hardening tests cover trust anchors, named operator approval and reflected-key rejection.

A local browser check with synthetic model transport sealed a real chat ring, displayed six computed faculty receipts and cleared completed activity indicators. A full original-engine pack then imported two faculties at ring 4; equipping Brillouin Resonator Reasoning and chatting sealed ring 5 with a visible **COMPUTED** receipt. Paused plain chat left height unchanged, and resume passed. Disabling Recall showed Route and Replay as **RECALL OFF**. These browser checks used disposable chains and provide interface/orchestration evidence, not paid-model quality evidence; the local screenshot is `chainchat-interoperability-browser.png`. The interface requires local bridge version 0.6.0 or newer for these capabilities.

## Reproduce locally

Use Node 20+ and Python 3.10+. Point the reference variables at a trusted, independently stored original skill directory containing its native Python modules and registries. The reference is not included in the product.

```powershell
$env:CT_ORIGINAL_SKILL = "C:\\path\\to\\original-skill"
$env:CT_PARITY_REFERENCE = $env:CT_ORIGINAL_SKILL
node --test test/interoperability.test.mjs
node --test test/compatibility.test.mjs
npm test
python -m unittest discover -s test -p "test_*.py"
npm run check
git diff --check
```

The interoperability tests fall back to the development workspace's `work/source-v3.30.08/skills/codex/cypher-tempre-self-model`. If no original reference exists, they explicitly skip. Such skips are not successful original-engine verification. Tests create marked disposable fixture roots and do not use private chains or real credentials.

## Earlier real Muse evidence

A separate beta 0.5.0 run used OpenCode Go `muse-spark-1.3-contributor` for 181 actual provider requests across 55 functional rows. Recorded statuses were 50 passed, two failed and three held. Reported token usage and configured pricing produced an estimated value of $0.103099662; this is not a provider invoice.

- All 42 base faculties were selected, prepared and computed, with a real generation and review for each. Forty-one released and sealed; one was held.
- Two requested depth-two continuations executed and were reviewed but were held before entering the tree. The requested depth was not achieved.
- All 21 requested perspectives executed and were reviewed. Eight entered the tree and 13 were held. The first synthesis was held; a revision passed. The failed all-approved-branches expectation remains a failure.
- Import and equipped chat succeeded, but hibernation was held because the review lacked sufficient user intent and reversible-scope context. Index and training controls succeeded; Dream was held for insufficient scope and consent context. The current change improves those review inputs; it has not yet been rerun with real Muse.
- Recall, unknown-fact abstention, equipment, byte/source Continuum, learning on/off and pause/resume had passing functional cases. The unknown-fact case is not a hallucination-rate estimate.
- The browser fixture paired, but its conflicting holdings policies disabled Send. That run did not establish successful paid browser chat.

The raw results remain unchanged. Local deliverables are `chainchat-muse-live-abilities-results.json`, `chainchat-muse-verification-summary.json`, `chainchat-live-abilities-interpretation.json` and `chainchat-live-abilities-source-verification.json`. The interpretation's source checkpoint SHA-256 is `5ff8291c3fffb4cdbd2c00ab9c97fc4a1ad2a57a245f8539caa832d6bffeeb58`; its source verification records base commit `03ec44618e63eac84552fdaaeca3b91a179f3cbc` plus the then-local Windows maintenance path fix.

Those 181 calls predate the full portability and authored-operator approval changes. They are not live-model validation of the new interoperability release. Earlier smaller benchmark runs used different configurations and are not combined into a new accuracy claim.

## Security and performance boundaries

Regression coverage includes origin/host restrictions, memory-only credentials, active-key reflection rejection, source redaction, wallet challenge/session binding, holdings expiry and authorization races. Wallet fixtures exercise scoped message signatures; the interface does not request token spending approval, a permit or a transaction. Model and RPC providers remain external services, and wallet use is not anonymous.

Model reviews are semantic judgments and remain fallible. A deliberately false arithmetic answer can pass both native and wrapped gates if a synthetic reviewer supplies high scores. Mechanical parity alone cannot prove arbitrary factual truth, moral judgment or cross-model quality uplift.

No ARC-AGI, LongMemEval, Pokemon, robotics or MazeBench result is reproduced by these application tests. Those tasks require their actual environments, datasets, tools, start states, budgets and scoring protocols. Local approved faculty operators do not supply a complete coding, browser, game or robotics agent harness.

Production deployment and real-wallet/live-browser checks are separate from these local test results. The current interoperability changes require an updated local bridge and corresponding public interface; the prior deployed asset checks do not establish that this revision is live.
