import json
import tempfile
import unittest
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import breezyvoice


class BreezyVoiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "runtime"
        self.root.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def test_register_normalizes_audio_and_public_profile_has_no_paths(self):
        source = Path(self.temp.name) / "sample.wav"
        source.write_bytes(b"source")

        def run(args, **kwargs):
            Path(args[-1]).write_bytes(b"RIFF" + b"\0" * 48)

        with patch.object(breezyvoice, "probe", side_effect=[16.2, 16.2]), patch.object(breezyvoice.subprocess, "run", side_effect=run):
            profile = breezyvoice.register(self.root, {"name": "  Demo  ", "audioPath": str(source), "transcript": "逐字稿"})
        self.assertEqual(profile["name"], "Demo")
        self.assertEqual(profile["language"], "zh")
        self.assertEqual(profile["durationSeconds"], 16.2)
        self.assertNotIn("audioFile", profile)
        stored = self.root / "voices" / profile["id"]
        self.assertTrue((stored / "reference.wav").is_file())
        self.assertEqual(breezyvoice.safe_profiles(self.root), [profile])

    def test_register_rejects_duration_before_creating_profile(self):
        source = Path(self.temp.name) / "sample.wav"
        source.write_bytes(b"source")
        with patch.object(breezyvoice, "probe", return_value=2.99):
            with self.assertRaisesRegex(ValueError, "3 to 30 seconds"):
                breezyvoice.register(self.root, {"name": "Demo", "audioPath": str(source), "transcript": "逐字稿"})
        self.assertFalse((self.root / "voices").exists())

    def test_rejects_symlink_source(self):
        source = Path(self.temp.name) / "source.wav"
        source.write_bytes(b"source")
        link = Path(self.temp.name) / "link.wav"
        link.symlink_to(source)
        with self.assertRaisesRegex(ValueError, "symlink"):
            breezyvoice.register(self.root, {"name": "Demo", "audioPath": str(link), "transcript": "逐字稿"})

    def test_generate_uses_local_model_and_offline_environment(self):
        (self.root / "source").mkdir()
        (self.root / "source" / "single_inference.py").touch()
        interpreter = self.root / "env" / "bin"
        interpreter.mkdir(parents=True)
        (interpreter / "python").touch()
        (self.root / "model").mkdir()
        (self.root / "backend.json").write_text(json.dumps({"device": "mps", "llm_device": "cpu"}), encoding="utf-8")
        voice = str(__import__("uuid").uuid4())
        directory = self.root / "voices" / voice
        directory.mkdir(parents=True)
        (directory / "reference.wav").write_bytes(b"RIFF" + b"\0" * 48)
        (directory / "profile.json").write_text(json.dumps({"id": voice, "name": "Demo", "transcript": "逐字稿", "durationSeconds": 16, "language": "zh", "audioFile": "reference.wav"}), encoding="utf-8")
        out_dir = Path(self.temp.name) / "swr-breezyvoice-test"
        out_dir.mkdir()
        output = out_dir / "narration.wav"
        captured = {}

        def run(args, **kwargs):
            if "--output_path" in args:
                captured["args"] = args
                captured["env"] = kwargs["env"]
                destination = args[args.index("--output_path") + 1]
            else:
                destination = args[-1]
            Path(destination).write_bytes(b"RIFF" + b"\0" * 48)

        with patch.object(breezyvoice, "probe", return_value=2.1), patch.object(breezyvoice, "status", return_value={"ready": True}), patch.object(breezyvoice.subprocess, "run", side_effect=run):
            result = breezyvoice.generate(self.root, {"text": "這是一段中文語音", "voiceId": voice, "output": str(output)})
        self.assertEqual(result["durationSeconds"], 2.1)
        self.assertIn(str(self.root / "model"), captured["args"])
        self.assertEqual(captured["args"][captured["args"].index("--speaker_prompt_text_transcription") + 1], "逐字稿")
        self.assertEqual(captured["env"]["BREEZYVOICE_DEVICE"], "mps")
        self.assertEqual(captured["env"]["BREEZYVOICE_LLM_DEVICE"], "cpu")
        self.assertEqual(captured["env"]["HF_HUB_OFFLINE"], "1")

    def test_status_requires_model_files_and_runtime(self):
        result = breezyvoice.status(self.root)
        self.assertFalse(result["ready"])
        self.assertIn("cosyvoice.yaml", result["detail"])
        self.assertIn("Python environment", result["detail"])

    def test_failed_generation_removes_partial_output(self):
        out_dir = Path(self.temp.name) / "swr-breezyvoice-test"
        out_dir.mkdir()
        output = out_dir / "narration.wav"
        voice = str(__import__("uuid").uuid4())
        directory = self.root / "voices" / voice
        directory.mkdir(parents=True)
        (directory / "reference.wav").write_bytes(b"RIFF" + b"\0" * 48)
        (directory / "profile.json").write_text(json.dumps({"id": voice, "name": "Demo", "transcript": "逐字稿", "durationSeconds": 16, "language": "zh", "audioFile": "reference.wav"}), encoding="utf-8")
        def fail(*args, **kwargs):
            output.write_bytes(b"partial")
            raise RuntimeError("inference failed")

        (self.root / "source").mkdir()
        (self.root / "source" / "single_inference.py").touch()
        (self.root / "env" / "bin").mkdir(parents=True)
        (self.root / "env" / "bin" / "python").touch()
        (self.root / "model").mkdir()
        (self.root / "backend.json").write_text(json.dumps({"device": "cpu", "llm_device": "cpu"}), encoding="utf-8")
        with patch.object(breezyvoice, "status", return_value={"ready": True}), patch.object(breezyvoice.subprocess, "run", side_effect=fail):
            with self.assertRaisesRegex(RuntimeError, "inference failed"):
                breezyvoice.generate(self.root, {"text": "你好", "voiceId": voice, "output": str(output)})
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
