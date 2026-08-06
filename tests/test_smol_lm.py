#!/usr/bin/env python3
"""Cross-platform regression tests for the experimental Smol LM turn gate."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SOURCE_ENGINE = REPO / "skills" / "codex" / "cypher-tempre-self-model"
GATEWAY = (
    REPO
    / "skills"
    / "smol-lm"
    / "cypher-tempre-smol-lm"
    / "scripts"
    / "strict_turn.py"
)


class SmolGatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory(prefix="ct-smol-")
        cls.base = Path(cls._tmp.name)
        cls.engine = cls.base / "engine"
        shutil.copytree(SOURCE_ENGINE, cls.engine)
        proc = cls.run_cli(
            cls.engine / "timechain.py",
            "init",
            "--root",
            str(cls.engine),
            "--name",
            "SmolTest",
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr or proc.stdout)
        cls._state_number = 0

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    @classmethod
    def run_cli(cls, script, *args):
        env = os.environ.copy()
        env.update({
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "CT_AUTOGROW": "0",
            "CT_AUTOMAINT": "0",
        })
        return subprocess.run(
            [sys.executable, str(script), *args],
            cwd=str(REPO),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="strict",
            timeout=180,
            check=False,
        )

    def new_state_dir(self):
        type(self)._state_number += 1
        path = self.base / f"state-{type(self)._state_number}"
        path.mkdir()
        return path

    def begin(self, state_dir, request="Give a compact grounded response.", recall=3):
        request_file = state_dir / "request.txt"
        request_file.write_text(request, encoding="utf-8")
        proc = self.run_cli(
            GATEWAY,
            "begin",
            "--engine",
            str(self.engine),
            "--root",
            str(self.engine),
            "--state-dir",
            str(state_dir),
            "--input-file",
            str(request_file),
            "--recall",
            str(recall),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def write_draft(self, state_dir, packet, answer, **overrides):
        draft = {
            "turn_id": packet["turn_id"],
            "answer": answer,
            "used_rings": [],
            "uncertainties": [],
            "at_risk": [],
        }
        draft.update(overrides)
        path = state_dir / "draft.json"
        path.write_text(
            json.dumps(draft, ensure_ascii=False),
            encoding="utf-8",
        )
        return path

    def head_index(self):
        lines = (self.engine / "chain" / "rings.jsonl").read_text(encoding="utf-8").splitlines()
        return json.loads(lines[-1])["index"]

    def test_01_unicode_draft_is_withheld_until_release(self):
        state_dir = self.new_state_dir()
        packet = self.begin(state_dir, "Reply with a short readiness statement.")
        answer = "Café — small-model receipt ✓"
        draft = self.write_draft(state_dir, packet, answer)

        commit = self.run_cli(
            GATEWAY,
            "commit",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--draft-file",
            str(draft),
        )
        self.assertEqual(commit.returncode, 0, commit.stderr)
        self.assertNotIn(answer, commit.stdout)
        receipt = json.loads(commit.stdout)
        self.assertTrue(receipt["release_ready"])
        self.assertEqual(receipt["sealed_ring"]["ring_type"], "smol-turn")

        state_bytes = (state_dir / f"{packet['turn_id']}.json").read_bytes()
        self.assertIn("—".encode("utf-8"), state_bytes)
        self.assertNotIn(b"\x97", state_bytes)

        release = self.run_cli(
            GATEWAY,
            "release",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--raw",
        )
        self.assertEqual(release.returncode, 0, release.stderr)
        self.assertIn(answer, release.stdout)
        self.assertFalse((state_dir / "active.json").exists())

        verify = self.run_cli(
            self.engine / "timechain.py", "verify", "--root", str(self.engine)
        )
        self.assertEqual(verify.returncode, 0, verify.stderr)

    def test_02_bad_draft_never_advances_or_releases(self):
        state_dir = self.new_state_dir()
        packet = self.begin(state_dir, recall=0)
        self.assertEqual(packet["memory_ring_ids"], [])
        before = self.head_index()
        malformed = state_dir / "bad.json"
        malformed.write_text('{"answer":"leak me"}', encoding="utf-8")

        commit = self.run_cli(
            GATEWAY,
            "commit",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--draft-file",
            str(malformed),
        )
        self.assertNotEqual(commit.returncode, 0)
        self.assertEqual(commit.stdout, "")
        self.assertNotIn("leak me", commit.stderr)
        self.assertEqual(self.head_index(), before)

        release = self.run_cli(
            GATEWAY,
            "release",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
        )
        self.assertNotEqual(release.returncode, 0)
        self.assertEqual(release.stdout, "")

        failure = self.run_cli(
            GATEWAY,
            "fail",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--reason",
            "adapter retry budget exhausted",
        )
        self.assertEqual(failure.returncode, 0, failure.stderr)
        self.assertEqual(json.loads(failure.stdout)["status"], "controller-failure")
        released = self.run_cli(
            GATEWAY,
            "release",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--raw",
        )
        self.assertEqual(released.returncode, 0, released.stderr)
        self.assertIn("adapter retry budget exhausted", released.stdout)

    def test_03_turn_binding_and_single_active_reservation(self):
        state_dir = self.new_state_dir()
        packet = self.begin(state_dir, recall=0)
        self.assertEqual(packet["memory_ring_ids"], [])

        second_request = state_dir / "request-two.txt"
        second_request.write_text("A second request", encoding="utf-8")
        second = self.run_cli(
            GATEWAY,
            "begin",
            "--engine",
            str(self.engine),
            "--root",
            str(self.engine),
            "--state-dir",
            str(state_dir),
            "--input-file",
            str(second_request),
        )
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(second.stdout, "")

        unoffered = self.write_draft(
            state_dir,
            packet,
            "This cites memory the controller did not provide.",
            used_rings=[0],
        )
        unsupported = self.run_cli(
            GATEWAY,
            "commit",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--draft-file",
            str(unoffered),
        )
        self.assertNotEqual(unsupported.returncode, 0)
        self.assertIn("not in the controller memory packet", unsupported.stderr)

        wrong = self.write_draft(
            state_dir,
            packet,
            "This must not seal.",
            turn_id="0" * 32,
        )
        rejected = self.run_cli(
            GATEWAY,
            "commit",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--draft-file",
            str(wrong),
        )
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(rejected.stdout, "")

        cancelled = self.run_cli(
            GATEWAY,
            "cancel",
            "--state-dir",
            str(state_dir),
            "--turn",
            packet["turn_id"],
            "--confirm",
            "--reason",
            "test cleanup after reviewed mismatch",
        )
        self.assertEqual(cancelled.returncode, 0, cancelled.stderr)
        self.assertFalse(json.loads(cancelled.stdout)["receipt_created"])
        self.assertFalse((state_dir / "active.json").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
