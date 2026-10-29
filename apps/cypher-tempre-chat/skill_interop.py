#!/usr/bin/env python3
"""Portable faculty companion for an explicitly selected trusted native skill.

Examples (both global and per-command --root/--engine are accepted):
  python skill_interop.py --engine /trusted/skill --root /agent export --keys sense:108 --out full-pack.json
  python skill_interop.py --engine /trusted/skill --root /agent preview --pack full-pack.json
  python skill_interop.py --engine /trusted/skill --root /agent import --pack full-pack.json --review review.json --expected-head HASH --plan-hash HASH --confirm

The review file contains planHash, expectedHead, reviewedAt (UTC ISO timestamp),
six scores, and assessment {approved, fruitages, rationale}. The attached model
must freshly assess the actual preview. No review is fabricated by this CLI.
An unmodified native importer can consume the format-1 projection but loses the
extension; use this companion on both sides for complete capability exchange.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import types


def _read(path):
    path = Path(path)
    if path.stat().st_size > 4 * 1024 * 1024:
        raise ValueError("Input exceeds four MiB.")
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv=None):
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--root", type=Path, default=argparse.SUPPRESS)
    common.add_argument("--engine", type=Path, default=argparse.SUPPRESS)
    parser = argparse.ArgumentParser(description=__doc__, parents=[common])
    sub = parser.add_subparsers(dest="command", required=True)
    export = sub.add_parser("export", parents=[common])
    export.add_argument("--keys", nargs="+", required=True)
    export.add_argument("--name", default="Cypher Tempre portable faculties")
    export.add_argument("--version", default="1.0.0")
    export.add_argument("--domain", default="")
    export.add_argument("--out", type=Path, required=True)
    preview = sub.add_parser("preview", parents=[common])
    preview.add_argument("--pack", type=Path, required=True)
    apply = sub.add_parser("import", parents=[common])
    apply.add_argument("--pack", type=Path, required=True)
    apply.add_argument("--review", type=Path, required=True)
    apply.add_argument("--expected-head", required=True)
    apply.add_argument("--plan-hash", required=True)
    apply.add_argument("--confirm", action="store_true")
    sub.add_parser("recovery-status", parents=[common])
    approve = sub.add_parser("approve-code", parents=[common])
    approve.add_argument("--sha256", required=True)
    approve.add_argument("--names", nargs="+", help="Exact faculty names to authorize when OPS is assembled dynamically")
    approve.add_argument("--confirm", action="store_true")
    revoke = sub.add_parser("revoke-code", parents=[common])
    revoke.add_argument("--confirm", action="store_true")
    materialize = sub.add_parser("materialize-code", parents=[common])
    materialize.add_argument("--sha256", required=True)
    materialize.add_argument("--confirm", action="store_true")
    args = parser.parse_args(argv)
    args.root = getattr(args, "root", None)
    args.engine = getattr(args, "engine", None)
    if args.root is None:
        parser.error("--root must name the recipient/donor agent directory")
    if args.command in ("approve-code", "revoke-code", "materialize-code"):
        # Approved-code inspection may itself use the trusted native verifier.
        # Keep native optional imports inert even for explicit local approval.
        inert = types.ModuleType("active_ops"); inert.OPS = {}
        sys.modules["active_ops"] = inert
        if args.engine:
            sys.path.insert(0, str(args.engine.resolve()))
            # Load the caller-selected trusted implementation before the
            # approval helper's bundled fallback can choose a different one.
            import timechain
            import epochs
        import approved_ops
        if args.command == "approve-code":
            result = approved_ops.approve_source(args.root.resolve(), args.sha256, confirmed=args.confirm, names=args.names)
        elif args.command == "materialize-code":
            result = approved_ops.materialize_source(args.root.resolve(), args.sha256, confirmed=args.confirm)
        else:
            result = approved_ops.revoke_source(args.root.resolve(), confirmed=args.confirm)
    else:
        if args.engine is None:
            parser.error("--engine must name the trusted native skill installation")
        engine = args.engine.resolve()
        if not (engine / "timechain.py").is_file() or not (engine / "immune.py").is_file():
            parser.error("--engine does not contain a supported native skill")
        # Native modality_ops has an optional static authored-code import. The
        # companion only transports it as data; no donor/recipient custom module
        # is executed while inspecting, reviewing, or importing a pack.
        inert = types.ModuleType("active_ops")
        inert.OPS = {}
        sys.modules["active_ops"] = inert
        sys.path.insert(0, str(engine))
        import portable_faculties as portable
        if args.command == "export":
            pack = portable.export_pack(args.root, args.keys, name=args.name, version=args.version, domain=args.domain)
            if args.out.exists():
                raise ValueError("Export destination exists; choose a new filename to preserve it.")
            args.out.parent.mkdir(parents=True, exist_ok=True)
            with args.out.open("x", encoding="utf-8") as stream:
                json.dump(pack, stream, indent=2, ensure_ascii=False)
                stream.write("\n")
            result = {"path": str(args.out.resolve()), "count": len(pack["faculties"]),
                      "portable_sha256": pack["portable_sha256"], "requiresCompanion": True}
        elif args.command == "preview":
            result = portable.preview_import(args.root, _read(args.pack))
        elif args.command == "import":
            result = portable.import_pack(args.root, _read(args.pack), args.expected_head,
                _read(args.review), args.plan_hash, confirmed=args.confirm)
        else:
            result = portable.recovery_status(args.root)
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"error": getattr(exc, "code", "INTEROP_ERROR"), "message": str(exc),
                          "details": getattr(exc, "details", {})}, ensure_ascii=False))
        raise SystemExit(1)
