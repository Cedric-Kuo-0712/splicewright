import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from pathlib import Path

from ingest import setup_breezyvoice as setup


class BreezyVoiceSetupHelpersTest(unittest.TestCase):
    def test_adopts_only_known_checkout_and_allows_upstream_bytecode_cache_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / ".git").mkdir(parents=True)
            def git(args, **kwargs):
                text = setup.SOURCE_URL if "get-url" in args else setup.SOURCE_COMMIT if "rev-parse" in args else " M cosyvoice/cli/__pycache__/model.cpython-310.pyc\n" if "status" in args else ""
                return SimpleNamespace(stdout=text, returncode=0)
            with patch.object(setup.subprocess, "run", side_effect=git):
                setup.prepare_source(root, source)
            self.assertTrue((root / "source-owner.json").is_file())

    def test_refuses_unknown_source_changes_without_resetting_or_marking_checkout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            (source / ".git").mkdir(parents=True)
            def git(args, **kwargs):
                text = setup.SOURCE_URL if "get-url" in args else setup.SOURCE_COMMIT if "rev-parse" in args else " M single_inference.py\n" if "status" in args else ""
                return SimpleNamespace(stdout=text, returncode=0)
            with patch.object(setup.subprocess, "run", side_effect=git), self.assertRaisesRegex(RuntimeError, "local changes"):
                setup.prepare_source(root, source)
            self.assertFalse((root / "source-owner.json").exists())

    def test_runtime_layout_is_managed_under_one_root(self):
        paths = setup.runtime_paths(Path("/tmp/bv-test"))
        self.assertEqual(paths["source"], Path("/tmp/bv-test/source"))
        self.assertEqual(paths["env"], Path("/tmp/bv-test/env"))
        self.assertEqual(paths["model"], Path("/tmp/bv-test/model"))

    def test_model_allowlist_has_expected_core_files(self):
        self.assertEqual(len(setup.MODEL_FILES), 8)
        self.assertIn("llm.pt", setup.MODEL_FILES)
        self.assertIn("hift.pt", setup.MODEL_FILES)

    def test_atomic_json_metadata_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "setup-state.json"
            setup.write_json(path, {"stage": "READY"})
            self.assertEqual(path.read_text(encoding="utf-8"), '{\n  "stage": "READY"\n}\n')
            self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
