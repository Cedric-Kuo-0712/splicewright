"""Small installer checks; no models, network, or inference dependencies required."""
import io
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
