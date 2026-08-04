#!/usr/bin/env python3
"""
Telemetry — the loop's notarized side-effects: the training data the chain was
already generating, finally written down.

Every pass of the per-turn loop makes judgment calls that vanish the moment the
turn ends: which past blocks retrieval OFFERED (and with what feature scores),
which of them the model actually FETCHED, which fetched rings genuinely grounded
the sealed answer (USE), and which remembered claims were later FALSIFIED against
live source. Those outcomes are exactly the supervision the v3 learners need —
positive pairs, mined hard negatives, credit assignment, negative resonance. This
module captures them as a side effect of operating; no annotation step exists,
because the loop itself is the annotator.

DESIGN RULES (mirroring the chain/index division of labor):
  - DERIVED, NOT SEALED PER-EVENT. Events append to `chain/telemetry.jsonl` —
    operational data beside the chain, never inside it. The chain record stays
    lean; `timechain verify` is unaffected by this file's presence or loss.
  - NOTARIZED IN BATCHES. `digest` seals a `telemetry-digest` ring carrying the
    SHA-256 of the log segment plus per-type counts, making the log tamper-evident
    without bloating the chain. Digests may overlap after a lost state file; that
    is harmless — coverage is what matters, not exclusivity.
  - NEVER BREAKS COGNITION. `emit` is best-effort: an unwritable log must not
    fail a retrieve or a seal. Failures return None.
  - PRIVACY FIRST. Raw queries are never logged — only a query hash and redacted
    label keywords/entities (reusing continuum's secret masking when available).
  - RESPECTS DORMANCY. While the self-model is paused (`chain/PAUSED`), the
    machinery is asleep and nothing is recorded.
  - EVERY EVENT IS SPLITTABLE. Each event stamps the chain head (index + hash),
    the embedder fingerprint, and the scorer version at the moment it happened,
    so temporal-split / like-for-like training and evaluation come for free.

Event types (schema 1) — Phase A emits the first four; the rest are reserved for
the replay / dream phases so the schema is stable from day one:
  offer            retrieval offered candidates with feature scores (choice set)
  fetch            the model pulled specific blocks from the index (its judgment)
  use              a seal attempt: decision, declared used rings, grounding
  falsify          a remembered claim failed verify-source (negative resonance)
  replay-accept    confirm-pass certified an antecedent equivalent   [reserved]
  replay-reject    looked similar, was not — a mined hard negative   [reserved]
  missed-positive  consolidation found an antecedent retrieval missed [reserved]
  route            low-confidence input routed to the model labeler  [reserved]

Kill switch: set CT_TELEMETRY=off (or 0/false) to disable all recording.

Stdlib only. Python 3.8+. Companion to timechain.py and recall.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from timechain import Timechain, now_iso

SCHEMA = 1

EVENT_TYPES = (
    "offer", "fetch", "use", "falsify",
    "replay-accept", "replay-reject", "missed-positive", "route",
    # v3.12/v3.13 additions: first-verdict gate observability, auto-maintenance
    # runs, and recall-first routing decisions (REPLAY/PARTIAL/MODEL economics)
    "gate_verdict", "auto_maintenance", "route_decision",
    "evidence",          # V4 P5: evidence-assembly calls (shapes routed, emptiness —
    #                      the abstain-on-answerable signal feed for dream digests)
    # V6 adherence layer: the hook-driven enforcement of the per-turn loop. These
    # let `telemetry.py adherence` measure whether the skill is actually being WORN
    # (turns that sealed vs. turns that needed nudging or fell open).
    "adherence_session_start", "adherence_turn_start", "adherence_turn_end",
    "adherence_loop_ran", "adherence_satisfied", "adherence_nudge",
    "adherence_violation", "adherence_audit_stalled", "adherence_root_mismatch",
    # v3.15 depth-completing governor: unmet seal obligations become recorded
    # DEBT carried across turns; a turn that truly cannot seal must WAIVE with a
    # reason. Plus regret-scored routing and calibrator adjustments.
    "adherence_debt", "adherence_waiver", "route_regret", "calibration",
)


def enabled() -> bool:
    return os.environ.get("CT_TELEMETRY", "").lower() not in ("off", "0", "false")


def query_hash(query: str, context: str = "") -> str:
    """Stable id for a query without persisting its text (privacy)."""
    return hashlib.sha256((query + "\x1f" + (context or "")).encode("utf-8")).hexdigest()


def redact_terms(terms):
    """Mask secret-shaped strings in label terms before they touch the log.
    Reuses continuum's canonical patterns; falls back to identity if absent."""
    try:
        from continuum import redact_secrets
    except Exception:
        return list(terms or [])
    out = []
    for t in terms or []:
        masked, n = redact_secrets(str(t))
        out.append(masked if n else str(t))
    return out


class Telemetry:
    def __init__(self, root):
        self.tc = Timechain(root)
        self.path = self.tc.dir / "telemetry.jsonl"
        self.state_path = self.tc.dir / "telemetry.digest.json"

    # ---- recording ----
    def emit(self, event_type, data, embedder_fingerprint=None, scorer_version=None):
        """Append one event. Best-effort by design: telemetry must NEVER break the
        loop it observes — on any failure it returns None and cognition proceeds."""
        if event_type not in EVENT_TYPES:
            raise ValueError(f"unknown telemetry event type: {event_type!r}")
        if not enabled():
            return None
        if (self.tc.dir / "PAUSED").exists():       # dormant = the machinery sleeps
            return None
        head = self.tc._tail_ring()
        event_data = dict(data or {})
        # v3.30.06: adherence is a per-turn metric, so every new adherence event
        # carries the durable id created by enforce.cmd_mark/codex-notify. Keep
        # this fallback in the recorder so loop/watchdog callers cannot forget it.
        if event_type.startswith("adherence_") and not event_data.get("turn_id"):
            try:
                state = json.loads((self.tc.dir / ".enforce.json").read_text(encoding="utf-8"))
                if state.get("turn_id"):
                    event_data["turn_id"] = state["turn_id"]
            except Exception:
                pass
        event = {
            "schema": SCHEMA,
            "event": event_type,
            "ts": now_iso(),
            "head_index": head.get("index") if head else None,
            "head_hash": head.get("ring_hash") if head else None,
            "embedder_fingerprint": embedder_fingerprint,
            "scorer_version": scorer_version,
            "data": event_data,
        }
        try:
            with self.path.open("a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
        except OSError:
            return None
        return event

    # ---- reading ----
    def events(self, since_offset=0):
        """Yield (byte_offset, event) from the log; tolerates torn lines (the
        digest hash, not line-perfection, is the integrity story)."""
        if not self.path.exists():
            return
        with self.path.open("rb") as f:
            f.seek(since_offset)
            while True:
                off = f.tell()
                raw = f.readline()
                if not raw:
                    break
                line = raw.strip()
                if not line:
                    continue
                try:
                    yield off, json.loads(line)
                except Exception:
                    continue

    def stats(self):
        counts, total, last_ts = {}, 0, None
        for _, e in self.events():
            counts[e.get("event", "?")] = counts.get(e.get("event", "?"), 0) + 1
            total += 1
            last_ts = e.get("ts", last_ts)
        size = self.path.stat().st_size if self.path.exists() else 0
        state = self._state()
        return {"events": total, "by_type": counts, "bytes": size, "last_ts": last_ts,
                "digested_to": state.get("digested_to", 0),
                "undigested_bytes": max(0, size - state.get("digested_to", 0)),
                "last_digest_ring": state.get("ring_index"),
                "path": str(self.path)}

    def _adherence_rollup(self):
        """Reduce adherence events into one record per logical turn.

        New events carry ``data.turn_id``. Pre-v3.30.06 events are associated with
        the most recent legacy turn-start, which also repairs historical logs where
        repeated Stop checks or a second hook channel emitted duplicate outcomes.
        Orphan outcomes are reported but never invented into the denominator.
        """
        turns, loops = {}, {}
        sessions, last_ts, legacy_current = 0, None, None
        orphan_outcomes = raw_nudges = 0
        outcome_events = {
            "adherence_satisfied", "adherence_nudge", "adherence_violation",
            "adherence_audit_stalled", "adherence_debt", "adherence_waiver",
        }
        for offset, e in self.events():
            ev, d = e.get("event", ""), e.get("data", {}) or {}
            if not ev.startswith("adherence_"):
                continue
            last_ts = e.get("ts", last_ts)
            if ev == "adherence_session_start":
                sessions += 1
                legacy_current = None
                continue
            if ev == "adherence_turn_start":
                turn_id = d.get("turn_id") or f"legacy:{offset}"
                legacy_current = turn_id
                rec = turns.setdefault(turn_id, {})
                rec["started"] = True
                rec.setdefault("ts", e.get("ts"))
                continue
            if ev == "adherence_loop_ran":
                turn_id = d.get("turn_id")
                key = turn_id or f"legacy-loop:{offset}"
                loops[key] = d
                continue
            if ev == "adherence_turn_end":
                if not d.get("turn_id"):
                    legacy_current = None
                continue
            if ev not in outcome_events:
                continue
            if ev == "adherence_nudge":
                raw_nudges += 1
            turn_id = d.get("turn_id") or legacy_current
            if not turn_id:
                orphan_outcomes += 1
                continue
            rec = turns.setdefault(turn_id, {})
            if ev == "adherence_satisfied":
                rec["satisfied"] = True
            elif ev == "adherence_nudge":
                rec["nudged"] = True
            elif ev in ("adherence_violation", "adherence_audit_stalled"):
                rec["violated"] = True
            elif ev == "adherence_debt":
                rec["debt"] = True
            elif ev == "adherence_waiver":
                rec["waived"] = True
        return {"turns": turns, "loops": loops, "sessions": sessions,
                "last_ts": last_ts, "orphan_outcomes": orphan_outcomes,
                "raw_nudges": raw_nudges}

    def adherence(self):
        """Is the skill actually being WORN? Ratios are deduplicated by turn id,
        so repeated Stop checks and mixed hook channels can never exceed 100%."""
        roll = self._adherence_rollup()
        started = {k: v for k, v in roll["turns"].items() if v.get("started")}
        satisfied = {k for k, v in started.items() if v.get("satisfied")}
        violated = {k for k, v in started.items() if v.get("violated")}
        nudged = {k for k, v in started.items() if v.get("nudged")}
        debt = {k for k, v in started.items() if v.get("debt")}
        waived = {k for k, v in started.items() if v.get("waived")}
        loop_decisions = {}
        for d in roll["loops"].values():
            dec = d.get("decision", "?")
            loop_decisions[dec] = loop_decisions.get(dec, 0) + 1
        c = {
            "sessions": roll["sessions"], "turns": len(started),
            "loops": len(roll["loops"]), "satisfied": len(satisfied),
            "nudges": len(nudged), "nudge_events": roll["raw_nudges"],
            "violations": len(violated), "debt": len(debt),
            "waivers": len(waived),
            "resealed": sum(1 for d in roll["loops"].values() if d.get("resealed")),
            "blocked": sum(1 for d in roll["loops"].values()
                           if d.get("decision") == "BLOCKED"),
            "orphan_outcomes": roll["orphan_outcomes"],
        }
        decided = satisfied | violated
        rate = (len(satisfied) / len(decided)) if decided else None
        nudge_rate = (len(nudged) / len(started)) if started else None
        reseal_rate = (c["resealed"] / c["loops"]) if c["loops"] else None
        # v3.12 honest metric: wear rate = honored turns / ALL turns started.
        # The old headline (honored/(honored+violations)) hid the nudging — a
        # 99.8% "adherence" over turns that mostly had to be forced. Both are
        # published now; the covenant demands the unflattering one too.
        wear_rate = (len(satisfied) / len(started)) if started else None
        # v3.15 accounted rate: sealed OR reasoned-waiver turns / all turns —
        # the governor's target is 100% ACCOUNTED (no silent skips), while
        # wear_rate stays the raw discipline number.
        accounted_turns = satisfied | waived
        accounted = (len(accounted_turns) / len(started)) if started else None
        return {"counts": c, "loop_decisions": loop_decisions,
                "last_ts": roll["last_ts"],
                "adherence_rate": rate, "nudge_rate": nudge_rate,
                "reseal_rate": reseal_rate, "wear_rate": wear_rate,
                "accounted_rate": accounted}

    def wear_trend(self, days: int = 7):
        """v3.15: per-day wear rate over the trailing window + slope sign, so the
        conscience can SEE its own discipline decaying (or recovering) instead of
        only knowing the lifetime average. Returns {days:[(date, rate)], slope}."""
        from datetime import datetime, timedelta, timezone
        cutoff = datetime.now(timezone.utc) - timedelta(days=days)
        per = {}
        roll = self._adherence_rollup()
        for rec in roll["turns"].values():
            if not rec.get("started"):
                continue
            ts = rec.get("ts", "")
            try:
                when = datetime.fromisoformat(ts)
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
            except Exception:
                continue
            if when < cutoff:
                continue
            day = when.date().isoformat()
            d = per.setdefault(day, {"turns": 0, "honored": 0})
            d["turns"] += 1
            if rec.get("satisfied"):
                d["honored"] += 1
        rows = [(day, (v["honored"] / v["turns"]) if v["turns"] else None)
                for day, v in sorted(per.items())]
        rated = [(i, r) for i, (_, r) in enumerate(rows) if r is not None]
        slope = None
        if len(rated) >= 2:  # least-squares slope over day index
            n = len(rated)
            sx = sum(i for i, _ in rated); sy = sum(r for _, r in rated)
            sxx = sum(i * i for i, _ in rated); sxy = sum(i * r for i, r in rated)
            den = n * sxx - sx * sx
            slope = ((n * sxy - sx * sy) / den) if den else None
        return {"days": rows, "slope": slope}

    # ---- notarization ----
    def _state(self):
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except Exception:
                return {}
        return {}

    def digest(self, do_seal=True):
        """Seal a `telemetry-digest` ring over the log segment appended since the
        last digest: segment SHA-256 + per-type counts. The state file is derived;
        if it is ever lost the next digest simply covers from byte 0 again."""
        state = self._state()
        start = state.get("digested_to", 0)
        size = self.path.stat().st_size if self.path.exists() else 0
        if size <= start:
            return {"sealed": False, "reason": "no new telemetry since last digest",
                    "from": start, "to": size}
        with self.path.open("rb") as f:
            f.seek(start)
            segment = f.read(size - start)
        seg_hash = hashlib.sha256(segment).hexdigest()
        counts = {}
        for _, e in self.events(since_offset=start):
            counts[e.get("event", "?")] = counts.get(e.get("event", "?"), 0) + 1
        payload = {
            "summary": (f"Telemetry digest: notarized {sum(counts.values())} loop event(s) "
                        f"[{', '.join(f'{k}:{v}' for k, v in sorted(counts.items()))}] "
                        f"covering log bytes {start}..{size}."),
            "telemetry_digest": {
                "schema": SCHEMA,
                "segment_sha256": seg_hash,
                "from_offset": start,
                "to_offset": size,
                "event_counts": counts,
            },
        }
        result = {"sealed": False, "from": start, "to": size,
                  "segment_sha256": seg_hash, "event_counts": counts}
        if do_seal:
            ring = self.tc.seal("telemetry-digest", payload)
            try:
                self.state_path.write_text(json.dumps(
                    {"digested_to": size, "ring_index": ring["index"],
                     "segment_sha256": seg_hash}), encoding="utf-8")
            except OSError:
                pass                              # state is derived; digests may overlap
            result.update({"sealed": True, "ring_index": ring["index"],
                           "ring_hash": ring["ring_hash"]})
        return result

    def verify_digests(self):
        """Re-hash every digested segment against its sealed claim. Returns
        (ok, report). A mismatch means the log was edited after notarization."""
        report, ok = [], True
        if not self.path.exists():
            return True, ["no telemetry log"]
        raw = self.path.read_bytes()
        for ring in self.tc.load():
            d = ring.get("payload", {}).get("telemetry_digest")
            if not d:
                continue
            seg = raw[d["from_offset"]:d["to_offset"]]
            actual = hashlib.sha256(seg).hexdigest()
            good = actual == d["segment_sha256"]
            ok = ok and good
            report.append(f"ring {ring['index']}: bytes {d['from_offset']}..{d['to_offset']} "
                          f"{'ok' if good else 'MISMATCH — log edited after notarization'}")
        if not report:
            report.append("no digests sealed yet")
        return ok, report


def join_offers(root):
    """The canonical offer-join: walk events once, in order, attributing each
    fetch/use to the most recent offer (mirroring the loop: retrieve -> fetch ->
    seal) and each replay accept/reject to its offer by query hash. Both
    learners (decisions and representation) train from THIS join, so credit
    assignment can never drift apart between them.

    Yields per offer: {seq, query_hash, proxy, dissonance, candidates (raw),
    fetched:set, used:set, replay_pos:set, replay_neg:set}."""
    offers, by_hash = [], {}
    group, group_id = [], None        # consecutive offers sharing a fanout id
    seq = 0
    for _, e in Telemetry(root).events():
        kind, d = e.get("event"), e.get("data", {})
        if kind == "offer":
            seq += 1
            current = {"seq": seq, "query_hash": d.get("query_hash"),
                       "proxy": " ".join((d.get("query_keywords") or [])
                                         + (d.get("query_entities") or [])),
                       "dissonance": d.get("dissonance"),
                       "candidates": d.get("candidates") or [],
                       "fetched": set(), "used": set(),
                       "replay_pos": set(), "replay_neg": set()}
            offers.append(current)
            # Fan-out sub-queries form ONE choice set: a fetch/use that follows
            # the group credits every sub-offer (the union answered, not the
            # last sub-query alone).
            fo = d.get("fanout") or {}
            if fo.get("id") and fo.get("id") == group_id:
                group.append(current)
            else:
                group, group_id = [current], fo.get("id")
            if d.get("query_hash"):
                by_hash[d["query_hash"]] = current
        elif group and kind == "fetch":
            for o in group:
                o["fetched"] |= set(d.get("ids") or [])
        elif group and kind == "use":
            for o in group:
                o["used"] |= set(d.get("used_rings") or [])
        elif kind == "replay-accept":
            o = by_hash.get(d.get("query_hash"))
            if o is not None and d.get("ring_index") is not None:
                o["replay_pos"].add(d["ring_index"])
        elif kind == "replay-reject":
            o = by_hash.get(d.get("query_hash"))
            if o is not None and d.get("ring_index") is not None:
                o["replay_neg"].add(d["ring_index"])
    return offers


def record(root, event_type, data, embedder_fingerprint=None, scorer_version=None):
    """Module-level convenience for callers that don't hold a Telemetry handle."""
    return Telemetry(root).emit(event_type, data,
                                embedder_fingerprint=embedder_fingerprint,
                                scorer_version=scorer_version)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def cmd_stats(args):
    st = Telemetry(args.root).stats()
    print(f"events: {st['events']}   bytes: {st['bytes']}   last: {st['last_ts'] or '-'}")
    for k, v in sorted(st["by_type"].items()):
        print(f"  {k:<16} {v}")
    print(f"digested_to: {st['digested_to']}   undigested: {st['undigested_bytes']} bytes   "
          f"last digest ring: {st['last_digest_ring'] if st['last_digest_ring'] is not None else '-'}")
    print(f"log: {st['path']}")


def cmd_tail(args):
    events = list(Telemetry(args.root).events())
    for _, e in events[-args.n:]:
        data = json.dumps(e["data"], ensure_ascii=False)
        print(f"{e['ts']}  {e['event']:<14} head=#{e['head_index']}  "
              f"{data[:140]}{'…' if len(data) > 140 else ''}")
    if not events:
        print("(no telemetry yet)")


def cmd_digest(args):
    r = Telemetry(args.root).digest()
    if r["sealed"]:
        print(f"telemetry-digest sealed: Ring {r['ring_index']}  "
              f"bytes {r['from']}..{r['to']}  sha256 {r['segment_sha256'][:16]}..")
        for k, v in sorted(r["event_counts"].items()):
            print(f"  {k:<16} {v}")
    else:
        print(f"not sealed: {r.get('reason', 'unknown')}")


def _pct(x):
    return f"{x*100:.1f}%" if x is not None else "n/a"


def cmd_adherence(args):
    a = Telemetry(args.root).adherence()
    c = a["counts"]
    print("Cypher Tempre — adherence (is the skill being WORN?)")
    print(f"  sessions primed : {c['sessions']}")
    print(f"  turns started   : {c['turns']}")
    print(f"  turns honored   : {c['satisfied']}   (sealed a ring before turn-end)")
    print(f"  violations      : {c['violations']}   (exhausted nudges, failed open)")
    print(f"  adherence rate  : {_pct(a['adherence_rate'])}   "
          f"(unique honored / unique decided turns)")
    print(f"  wear rate       : {_pct(a.get('wear_rate'))}   "
          f"(honored / ALL turns started — the unflattering, honest number)")
    print(f"  accounted rate  : {_pct(a.get('accounted_rate'))}   "
          f"(sealed OR reasoned-waiver — the governor target is 100%)")
    print(f"  seal debt       : {c.get('debt', 0)} recorded   "
          f"waivers: {c.get('waivers', 0)}")
    print(f"  turns nudged    : {c['nudges']}   nudge rate: {_pct(a['nudge_rate'])}")
    print(f"  nudge events    : {c.get('nudge_events', c['nudges'])}   "
          f"(repeated pressure within a turn; not a second turn)")
    print(f"  one-call loops  : {c['loops']}   "
          f"(of which immune-blocked: {c['blocked']})")
    print(f"  uncertainty-led : {c['resealed']}   reseal rate: {_pct(a['reseal_rate'])}   "
          f"(conscience caught over-claims and recorded them honestly)")
    if a["loop_decisions"]:
        decs = "  ".join(f"{k}:{v}" for k, v in sorted(a["loop_decisions"].items()))
        print(f"  loop verdicts   : {decs}")
    if c.get("orphan_outcomes"):
        print(f"  legacy orphans  : {c['orphan_outcomes']} outcome event(s) excluded "
              f"because no turn-start could be identified")
    print(f"  last adherence event: {a['last_ts'] or '-'}")
    try:
        tr = Telemetry(args.root).wear_trend()
        if tr["days"]:
            spark = "  ".join(f"{d[5:]}:{_pct(r)}" for d, r in tr["days"][-7:])
            direction = ("improving" if (tr["slope"] or 0) > 0.005 else
                         "DECAYING" if (tr["slope"] or 0) < -0.005 else "flat")
            print(f"  wear trend (7d) : {spark}   slope: {direction}")
    except Exception:
        pass
    if c["turns"] == 0 and c["sessions"] == 0:
        print("  (no adherence events yet — wire the hooks and run a few turns)")


def cmd_verify(args):
    ok, report = Telemetry(args.root).verify_digests()
    for line in report:
        print(f"  {'ok ' if ok else '!! '} {line}")
    print("TELEMETRY VERIFY:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def cmd_emit(args):
    e = Telemetry(args.root).emit(args.type, json.loads(args.data or "{}"))
    print(json.dumps(e, ensure_ascii=False) if e else "(not recorded: disabled, dormant, or unwritable)")


def build_parser():
    default_root = Path(__file__).resolve().parent
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", type=Path, default=default_root)
    p = argparse.ArgumentParser(description="Telemetry — the loop's notarized side-effects.")
    sub = p.add_subparsers(dest="cmd", required=True)

    ps = sub.add_parser("stats", parents=[common], help="event counts, log size, digest coverage")
    ps.set_defaults(func=cmd_stats)
    pa = sub.add_parser("adherence", parents=[common],
                        help="is the skill being WORN? turns honored vs nudged vs violated")
    pa.set_defaults(func=cmd_adherence)
    pt = sub.add_parser("tail", parents=[common], help="show the most recent events")
    pt.add_argument("-n", type=int, default=10)
    pt.set_defaults(func=cmd_tail)
    pd = sub.add_parser("digest", parents=[common], help="seal a telemetry-digest ring over new events")
    pd.set_defaults(func=cmd_digest)
    pv = sub.add_parser("verify", parents=[common], help="re-hash digested segments against their sealed claims")
    pv.set_defaults(func=cmd_verify)
    pe = sub.add_parser("emit", parents=[common], help="manually record an event (mainly for tests)")
    pe.add_argument("type", choices=EVENT_TYPES)
    pe.add_argument("--data", default="{}", help="JSON object for the event data")
    pe.set_defaults(func=cmd_emit)
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
