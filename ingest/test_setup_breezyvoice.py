import hashlib
import io
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

    def test_pinned_artifact_manifest_covers_model_and_supported_micromamba_archives(self):
        manifest = setup.artifact_manifest()
        self.assertEqual(manifest["model"]["revision"], "e33b502e0ac21c16b0ee0d00df66ac3fa737393d")
        self.assertEqual(set(manifest["model"]["files"]), set(setup.MODEL_FILES))
        self.assertEqual(set(manifest["micromamba"]["archives"]), {
            "darwin-arm64", "darwin-x86_64", "linux-aarch64", "linux-x86_64",
        })
        self.assertTrue(all("latest" not in item["url"] for item in manifest["micromamba"]["archives"].values()))

    def test_same_size_model_corruption_fails_sha256_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory)
            (model / "model.bin").write_bytes(b"nope")
            manifest = {"model": {"files": {"model.bin": {
                "size": 4, "sha256": hashlib.sha256(b"good").hexdigest(),
            }}}}
            with patch.object(setup, "MODEL_FILES", ("model.bin",)), self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                setup.verify_model_files(model, manifest)

    def test_model_checksum_failure_does_not_publish_model_or_manifest(self):
        expected = {"size": 4, "sha256": hashlib.sha256(b"good").hexdigest()}
        pinned = {"repository": "MediaTek-Research/BreezyVoice", "revision": "a" * 40,
                  "files": {"model.bin": expected}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def fake_run(_args, **_kwargs):
                (root / "model.part").mkdir()
                (root / "model.part" / "model.bin").write_bytes(b"evil")
            with patch.object(setup, "MODEL_FILES", ("model.bin",)), \
                 patch.object(setup, "artifact_manifest", return_value={"model": pinned}), \
                 patch.object(setup, "run", side_effect=fake_run), \
                 self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                setup.install_model_snapshot(root, Path("python"), Path("source"))
            self.assertFalse((root / "model-manifest.json").exists())
            self.assertFalse((root / "model").exists())
            self.assertFalse((root / "model.part").exists())

    def test_micromamba_checksum_mismatch_is_rejected_before_archive_extraction(self):
        class Response(io.BytesIO):
            def __enter__(self): return self
            def __exit__(self, *_args): self.close()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(setup.platform, "system", return_value="Darwin"), \
                 patch.object(setup.platform, "machine", return_value="arm64"), \
                 patch.object(setup.urllib.request, "urlopen", return_value=Response(b"tampered")), \
                 patch.object(setup.tarfile, "open") as archive_open, \
                 self.assertRaisesRegex(RuntimeError, "archive checksum mismatch"):
                setup.resolve_micromamba(root)
            archive_open.assert_not_called()
            self.assertFalse((root / "bin" / "micromamba").exists())

    def test_atomic_json_metadata_write(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "setup-state.json"
            setup.write_json(path, {"stage": "READY"})
            self.assertEqual(path.read_text(encoding="utf-8"), '{\n  "stage": "READY"\n}\n')
            self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
