# Smol LM controller contract

## Purpose

Use the controller when the model should never be responsible for remembering,
invoking, or locating Cypher Tempre. The model creates only a constrained draft. The
controller owns identity selection, recall, PoQ, sealing, receipt validation, and final
release.

This packet requires a separately installed `cypher-tempre-self-model` engine. It does
not copy or replace the normal Claude, Codex, OpenClaw, Hermes, or NanoClaw bundles.

## Turn sequence

Set explicit paths in the orchestrator. Do not let model output populate them.

```bash
SMOL=/path/to/cypher-tempre-smol-lm
ENGINE=/path/to/cypher-tempre-self-model
IDENTITY=/path/to/cypher-tempre-self-model
STATE=/private/path/to/smol-turn-state

python3 "$SMOL/scripts/strict_turn.py" begin \
  --engine "$ENGINE" --root "$IDENTITY" --state-dir "$STATE" \
  --input-file request.txt > controller-packet.json
```

Pass the user's request and `controller-packet.json` to the model. Require JSON output
matching the packet's `reply_contract`, then commit it:

```bash
TURN_ID="$(python3 -c 'import json; print(json.load(open("controller-packet.json", encoding="utf-8"))["turn_id"])')"
python3 "$SMOL/scripts/strict_turn.py" commit \
  --state-dir "$STATE" --turn "$TURN_ID" --draft-file model-draft.json \
  > receipt.json
```

`commit` never prints the answer. After the receipt has been accepted, release the
sealed text:

```bash
python3 "$SMOL/scripts/strict_turn.py" release \
  --state-dir "$STATE" --turn "$TURN_ID" --raw
```

If the model cannot produce a valid draft, record a controller-generated failure turn
instead of leaking its output:

```bash
python3 "$SMOL/scripts/strict_turn.py" fail \
  --state-dir "$STATE" --turn "$TURN_ID" \
  --reason "model exhausted the adapter retry budget"
python3 "$SMOL/scripts/strict_turn.py" release \
  --state-dir "$STATE" --turn "$TURN_ID" --raw
```

Use `status` for read-only inspection. Use `cancel --confirm` only to abandon an
uncommitted turn after operator review; cancellation releases the controller reservation
but does not create an adherence receipt.

```bash
python3 "$SMOL/scripts/strict_turn.py" status \
  --state-dir "$STATE" --turn "$TURN_ID"
python3 "$ENGINE/enforce.py" status --json --root "$IDENTITY"
```

The first report diagnoses the Smol controller phase and receipt. The second diagnoses
the underlying enforcement turn and exact chain-head observation. Neither status command
creates a receipt, seals a ring, appends adherence telemetry, or releases model text.

## Security and correctness properties

- One active controller turn is permitted per state directory.
- Root, registry, and engine paths are captured at `begin` and never accepted from the
  model draft.
- The model must echo the opaque `turn_id`.
- Declared ring IDs must already exist at the captured pre-turn head.
- Every text file is read and written as strict UTF-8 with physical LF delimiters.
- `commit` captures engine output and never forwards it to the user.
- A receipt binds request hash, draft hash, released-text hash, identity root, prior head,
  sealed ring, and terminal head.
- `release` reverifies the chain and the sealed ring before emitting the answer.
- If PoQ reseals uncertainty-led text, `release` emits the sealed text rather than the
  model's more confident draft.

The receipt hash is a deterministic integrity digest, not a secret-key signature. The
Timechain ring hash provides the tamper-evident anchor. A later iteration can add signed
receipts or a remote attestor without changing the model-facing schema.

## Honest boundary

This controller can make procedural accounting non-bypassable only when it owns the
actual output channel. A notification-only hook cannot do that. It also cannot guarantee
that a small model understood evidence or calibrated uncertainty well. Measure those as
separate semantic metrics instead of treating a valid receipt as proof of a good answer.

The controller requires the answer ring to be the first new ring after the captured head,
then records the later terminal head separately. This keeps the answer binding unambiguous
while permitting the installed engine's normal post-turn growth and maintenance rings.
