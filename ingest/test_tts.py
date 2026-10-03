"""Small installer checks; no models, network, or inference dependencies required."""
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import tts


class DownloadTests(unittest.TestCase):
    def test_incomplete_download_is_not_published(self):
        response = io.BytesIO(b"short")
        response.headers = {"Content-Length": "100"}
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "model.onnx"
            with patch.object(tts.urllib.request, "urlopen", return_value=response):
                with self.assertRaisesRegex(RuntimeError, "incomplete download"):
                    tts.download("https://example.test/model", dest)
            self.assertFalse(dest.exists())
            self.assertFalse(dest.with_suffix(".onnx.part").exists())

    def test_setup_lock_refuses_concurrent_install_and_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with tts.setup_lock(root):
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    with tts.setup_lock(root):
                        self.fail("concurrent setup acquired the same lock")
            with tts.setup_lock(root):
                pass

    def test_generation_refuses_setup_lock_before_status_or_model_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with tts.setup_lock(root):
                with patch.object(tts, "status", side_effect=AssertionError("status must not run")):
                    with self.assertRaisesRegex(RuntimeError, "already running"):
                        tts.generate(root, {"language": "en-us"})

    def test_setup_cannot_mutate_during_generation_in_another_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attempts = []

            def mocked_generation(_root, _request):
                code = "\n".join([
                    "import sys, tts",
                    "from pathlib import Path",
                    "tts.setup_unlocked = lambda *_: (_ for _ in ()).throw(AssertionError('mutated'))",
                    "try:",
                    "    tts.setup(Path(sys.argv[1]), ['en-us'])",
                    "    print('setup-ran')",
                    "except RuntimeError as error:",
                    "    print(error)",
                ])
                attempt = subprocess.run(
                    [sys.executable, "-c", code, str(root)],
                    cwd=Path(__file__).parent,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=10,
                )
                attempts.append(attempt)
                return {"generated": True}

            with patch.object(tts, "generate_unlocked", side_effect=mocked_generation):
                self.assertEqual(tts.generate(root, {"language": "en-us"}), {"generated": True})
            self.assertEqual(len(attempts), 1)
            self.assertEqual(attempts[0].returncode, 0, attempts[0].stderr)
            self.assertIn("already running", attempts[0].stdout)
            self.assertNotIn("setup-ran", attempts[0].stdout)

    def test_generation_releases_setup_lock_when_inference_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with patch.object(tts, "generate_unlocked", side_effect=RuntimeError("inference failed")):
                with self.assertRaisesRegex(RuntimeError, "inference failed"):
                    tts.generate(root, {})
            with tts.setup_lock(root):
                pass


if __name__ == "__main__":
    unittest.main()
