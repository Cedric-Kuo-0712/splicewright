"""Readiness receipts are an optimization; loading models always requires their hashes."""
import contextlib
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import breezyvoice
from ingest import setup_breezyvoice as installer


class ModelIntegrityReceiptTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.model = self.root / "model"
        self.model.mkdir()
        self.file = self.model / "tiny.bin"
        self.file.write_bytes(b"good")
        self.expected = {"tiny.bin": {"size": 4, "sha256": hashlib.sha256(b"good").hexdigest()}}
        self.pinned = {"revision": "a" * 40, "repository": "example/model", "files": self.expected}
        artifacts = self.root / "artifacts.json"
        artifacts.write_text(json.dumps({"model": self.pinned}), encoding="utf-8")
        self.manifest = self.root / "model-manifest.json"
        self.installed = {"revision": self.pinned["revision"], "files": self.expected,
                          "fileStats": {"tiny.bin": installer.file_identity(self.file)}}
        self.write_receipt()
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(breezyvoice, "MODEL_FILES", ("tiny.bin",)))
        stack.enter_context(patch.object(breezyvoice, "ARTIFACTS_PATH", artifacts))

    def write_receipt(self):
        self.manifest.write_text(json.dumps(self.installed), encoding="utf-8")

    def test_unchanged_status_skips_content_reads_but_forced_verification_hashes(self):
        with patch.object(breezyvoice, "sha256_file", wraps=installer.sha256_file) as digest:
            for _ in range(2):
                self.assertNotIn("checksum mismatch", breezyvoice.status(self.root)["detail"])
            digest.assert_not_called()
            self.assertNotIn("checksum mismatch", breezyvoice.status(self.root, verify_model=True)["detail"])
            digest.assert_called_once_with(self.file)

    def test_same_size_content_change_invalidates_the_receipt(self):
        before = self.file.stat()
        self.file.write_bytes(b"evil")
        os.utime(self.file, ns=(before.st_atime_ns, before.st_mtime_ns + 1_000_000_000))
        result = breezyvoice.status(self.root)
        self.assertFalse(result["ready"])
        self.assertIn("checksum mismatch: tiny.bin", result["detail"])

    def test_generation_rechecks_hashes_even_with_a_forged_matching_receipt(self):
        self.file.write_bytes(b"evil")
        self.installed["fileStats"]["tiny.bin"] = installer.file_identity(self.file)
        self.write_receipt()
        output_dir = self.root / "swr-breezyvoice-integrity"
        output_dir.mkdir()
        prompt = self.root / "prompt.wav"
        prompt.write_bytes(b"offline fixture")
        with patch.object(breezyvoice, "select_profile", return_value=({}, prompt)), \
                patch.object(breezyvoice, "status", wraps=breezyvoice.status) as status, \
                patch.object(breezyvoice.subprocess, "run") as inference:
            with self.assertRaisesRegex(RuntimeError, "not configured"):
                breezyvoice.generate(self.root, {"text": "測試", "output": str(output_dir / "narration.wav")})
            status.assert_called_once_with(self.root, verify_model=True)
            inference.assert_not_called()

    def test_installer_publishes_receipt_only_after_verifying_the_staged_model(self):
        def download(*args, **kwargs):
            staging = self.root / "model.part"
            staging.mkdir()
            (staging / "tiny.bin").write_bytes(b"good")

        with patch.object(installer, "MODEL_FILES", ("tiny.bin",)), \
                patch.object(installer, "artifact_manifest", return_value={"model": self.pinned}), \
                patch.object(installer, "run", side_effect=download):
            self.assertEqual(installer.install_model_snapshot(self.root, Path("unused-python"), self.root / "source"), self.pinned["revision"])
        installed = json.loads(self.manifest.read_text(encoding="utf-8"))
        self.assertEqual(installed["files"], self.expected)
        self.assertEqual(installed["fileStats"], {"tiny.bin": installer.file_identity(self.file)})
