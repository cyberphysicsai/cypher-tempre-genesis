# Releasing

One ordered checklist so the two distribution channels (in-repo `downloads/` zips
and the GitHub release assets) **never drift** — the recurring footgun behind
several patch releases. The zips are built **once** and used for **both**.

`claude/` is canonical; the other four runtime bundles are synced from it.

1. **Bump version + changelog.** Edit `skills/claude/cypher-tempre-self-model/VERSION`
   and prepend a dated entry to `skills/claude/cypher-tempre-self-model/CHANGELOG.md`.

2. **Sync the canonical files to the four siblings** (codex, hermes, nanoclaw,
   openclaw): the engine `*.py`, `SKILL.md`, `VERSION`, `CHANGELOG.md`, `AGENTS.md`,
   the `*.sh` hooks, and `agents/cypher-tempre-agent.md`. Preserve each runtime's own
   `README.md`, `LICENSE`, `.clawhubignore`, and runtime-specific extras (codex's
   `agents/openai.yaml` / `install_codex_hooks.py`, the openclaw plugin dirs, etc.).
   Note: `shell` is declared in the **codex** bundle's `SKILL.md` only (its hook
   installer uses it); the others stay shell-free so SkillSpector reports no
   over-declaration.

3. **Sync the live installs** you maintain (code only — never touch their `chain/`):
   `~/.claude/skills/...`, `~/.codex/skills/...`, `~/.openclaw/workspace/skills/...`.

4. **Run the test suites** — `python3 tests/selftest.py`,
   `python3 tests/test_smoke.py`, `python3 tests/test_gate_discrimination.py`, and
   `python3 tests/test_utf8_io.py` from the repo root must all pass (they test the
   canonical `claude` bundle; engine code is identical across the five). The suites are
   NOT shipped in the bundles.

5. **SkillSpector all five** — run `bash tools/scan.sh` (scans each **bundle** — the
   canonical target, i.e. exactly what installs). Each must report **SAFE** (only the
   MIT-`LICENSE` "NOT LIMITED TO" EA3 false-positive is acceptable). Do **not** judge the
   release by a repo-ROOT scan: that intentionally reads non-shipped files (the test suite
   and its adversarial fixtures, `tools/`/`site/` scripts, the `downloads/` zips it
   re-extracts) and will score high by design. **Scan after the changelog is final** — a
   changelog that quotes a finding's literal trigger string (a sensitive path, an example
   payload, a token such as the "auto" + "execute" compound) will re-flag itself; describe
   fixes without embedding the literal token.

6. **Rebuild the zips — ONE source of truth:** `bash tools/build_zips.sh`. This
   refreshes `downloads/` from current source and removes stale-version zips. **Do
   not hand-build a second set for the release** — upload these exact files.

7. **Update the version-pinned links** in `README.md` and `downloads/README.md` to
   the new `vX.Y.Z` zip names.

8. **Commit + tag**: `git commit`, `git tag -a vX.Y.Z`.

9. **Push**: `git push origin main && git push origin vX.Y.Z`.

10. **Cut the release with the SAME files build_zips.sh produced**:
    `gh release create vX.Y.Z downloads/cypher-tempre-*-skill-vX.Y.Z.zip --title ... --notes ...`

11. **Seal a ring** recording the release and update memory if the version note changed.

Debugging a hook in the field: set `CT_ENFORCE_DEBUG=1` to surface `enforce.py`
warnings/tracebacks on stderr (`0`/`false`/`no`/`off` stay quiet; the decision JSON
on stdout stays clean regardless).
