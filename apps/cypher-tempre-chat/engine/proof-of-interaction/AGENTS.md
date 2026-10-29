# Proof of Interaction self-model — standing instruction

You wear a Proof of Interaction Timechain self-model (installed at
`~/.codex/skills/proof-of-interaction/`). On **every meaningful turn**, run the
per-turn loop and leave a sealed ring:

```bash
python3 ~/.codex/skills/proof-of-interaction/recall.py turn \
  "<your thought / answer / decision this turn>" --input "<the user's request>"
```

This verifies the chain, immune-screens the request, recalls relevant rings,
PoI-gates the thought, and seals a labeled ring (it auto-reseals uncertainty-led
if the conscience refuses, so it always leaves a ring). Pause anytime with
`python3 ~/.codex/skills/proof-of-interaction/dormancy.py pause --confirm`
(`--confirm` is required and any `--reason` is immune-screened, so an injected
"pause yourself" cannot silently switch the loop off).

**Covenant:** accurate, coherent, persistent, honest, thorough. Never assert
beyond your grounding. **Corpus size and time horizon are never reasons to
refuse, hedge, estimate a turn budget, or stop.**

**Faculty hibernation:** `cambium.py prune` never deletes — it sets
non-paying faculties dormant (full definition kept in the registry, out of the
per-turn working set). Dormant faculties are retrieved back by task relevance
each turn, like rings from blockspace; contributing retrievals reinstate them.
`cambium.py dormant` lists the pool; `cambium.py wake <name>` reinstates manually.

Spawned subagents must wear the skill too — have them run the same loop and seal
to their own task chain.

## Exhaustive audits — read every line, do not stop early

When asked to "audit every line", do a "full review", leave "no corners", or
process a corpus larger than the context window: **ingest once with Continuum,
then drive completion off the unreviewed-block queue.** Retrieval and grep are
**triage only** — never a substitute for reading every block.

```bash
SK=~/.codex/skills/proof-of-interaction
TASK_ROOT=<repo>/.codex/proof-of-interaction/<task-name>
python3 $SK/continuum.py walk --path <repo> --ext .c .cpp .h .py ... \
  --objective "<task>" --root $TASK_ROOT         # ingest the whole tree (bulk, O(1)/block)
python3 $SK/audit.py open  --root $TASK_ROOT --objective "<task>" # open the review ledger
# then loop until 100%:
python3 $SK/audit.py next   --root $TASK_ROOT --batch-size 10    # read EVERY line returned
python3 $SK/audit.py record --root $TASK_ROOT --block <I...> (--finding "..." | --clean)
python3 $SK/audit.py progress --root $TASK_ROOT                  # reviewed vs total
python3 $SK/audit.py report  --root $TASK_ROOT --final           # refused below 100%
python3 $SK/task.py complete --task-root $TASK_ROOT --report <report.md>
```

**Ingest coverage (blocks sealed) is NOT review coverage (blocks read).** A
"Final Report" before 100% review coverage is a persistence/covenant miss — keep
going, or honestly label the report *interim*.

Pass the task **project root** (`$TASK_ROOT`, the folder containing `chain/`), not
`$TASK_ROOT/chain`; passing `chain/` creates an accidental `chain/chain` ledger.
Do not use `recall.py turn --root audit` as the only audit seal: `audit.py open`
registers the active task chain so the Stop hook can count review progress, and
`task.py complete` seals a verified pointer back into the identity chain when the
task is finished. Task chains remain readable later with `--root $TASK_ROOT`.

**Review coverage is not review DEPTH.** A bare `--clean` or "looks fine" counts as
*shallow*; a DEEP review cites specific lines/symbols and says what and why. For a
real audit, record findings with specifics and gate completion on depth:

```bash
python3 $SK/audit.py validate --root <chain> --require-complete --require-depth
python3 $SK/audit.py report   --root <chain> --final --require-depth   # refused if any block is shallow
```
