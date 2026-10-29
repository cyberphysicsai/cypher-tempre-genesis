"""Read-only external-baseline comparison; all created state uses a disposable root."""
import contextlib
import importlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys


mode, source, raw = sys.argv[1:4]
request = json.loads(raw)
source = Path(source).resolve()
sys.path.insert(0, str(source))
with contextlib.redirect_stdout(io.StringIO()):
    if mode == "bridge-thresholds":
        spec = importlib.util.spec_from_file_location("reference_bridge", source / "engine_bridge.py")
        bridge = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(bridge)
        result = bridge.poi.policy_thresholds(request["root"])
    else:
        gate = importlib.import_module(request["module"])
        if mode == "parity":
            klass = getattr(gate, request["gateClass"])
            result = [klass(thresholds=case.get("thresholds")).evaluate(
                case["candidate"], case.get("chain", []), case.get("context", ""),
                external_scores=case.get("scores"),
                declared_evidence=case.get("declaredEvidence"),
                evidence_texts=case.get("evidenceTexts"),
            ) for case in request["cases"]]
        elif mode == "init":
            from timechain import Timechain
            root = Path(request["root"]).resolve()
            if root == source or source in root.parents:
                raise ValueError("The comparison cannot write into the external engine.")
            (root / "registry").mkdir(parents=True, exist_ok=True)
            for name in ("senses.json", "modalities.json"):
                shutil.copyfile(source / "registry" / name, root / "registry" / name)
            (root / "registry" / "policy.json").write_text(json.dumps(request["policy"]), encoding="utf-8")
            tc = Timechain(root)
            tc.genesis("Existing Agent", params={"alignment_note": request["legacyText"]})
            tc.seal("experience", {"summary": request["legacyText"],
                    "input": "What does the earlier gate mean?", "output": request["legacyText"]},
                    **{request["scoreKey"]: request["scores"]})
            result = {"thresholds": gate.policy_thresholds(root), "verified": tc.verify()[0]}
        else:
            raise ValueError("Unknown comparison operation.")
print(json.dumps(result, ensure_ascii=False))
