#!/usr/bin/env python3
"""Local profile and synthesis adapter for the pinned BreezyVoice runtime."""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

SETUP_COMMAND = "splicewright tts setup --engine breezyvoice"
MAX_TEXT = 300
MODEL_FILES = ("cosyvoice.yaml", "configuration.json", "campplus.onnx", "speech_tokenizer_v1.onnx", "spk2info.pt", "llm.pt", "flow.pt", "hift.pt")
REQUIRED_MODULES = ("torch", "torchaudio", "whisper", "opencc", "hyperpyyaml", "huggingface_hub", "g2pw", "transformers", "onnxruntime")


def default_root() -> Path:
    return Path(os.environ.get("SPLICEWRIGHT_BREEZYVOICE_HOME", Path.home() / ".splicewright" / "breezyvoice")).expanduser()


def profile_view(profile: dict) -> dict:
    return {key: profile[key] for key in ("id", "name", "transcript", "durationSeconds", "language")}


@contextlib.contextmanager
def profile_lock(root: Path, filename: str = ".profiles.lock"):
    root.mkdir(parents=True, exist_ok=True)
    with (root / filename).open("a+b") as lock:
        if os.name == "nt":
            import msvcrt
            if lock.seek(0, os.SEEK_END) == 0:
                lock.write(b"\0")
                lock.flush()
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def safe_profiles(root: Path) -> list[dict]:
    directory = root / "voices"
    if not directory.exists():
        return []
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("voice profile directory is invalid")
    values = []
    for entry in directory.iterdir():
        if entry.name.startswith("."):
            continue
        if entry.is_symlink():
            raise ValueError("symlinks are not allowed in voice profiles")
        if not entry.is_dir():
            continue
        try:
            profile = json.loads((entry / "profile.json").read_text(encoding="utf-8"))
            profile_id = str(uuid.UUID(profile["id"]))
            audio = entry / "reference.wav"
            if profile_id != entry.name or audio.is_symlink() or not audio.is_file():
                raise ValueError("profile audio is missing or unsafe")
            if not isinstance(profile["name"], str) or not (1 <= len(profile["name"]) <= 100):
                raise ValueError("profile name is malformed")
            if not isinstance(profile["transcript"], str) or not (1 <= len(profile["transcript"]) <= 2000):
                raise ValueError("profile transcript is malformed")
            duration = profile["durationSeconds"]
            if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 3 <= duration <= 30:
                raise ValueError("profile duration is malformed")
            if profile["language"] != "zh":
                raise ValueError("profile language is malformed")
            values.append(profile_view(profile))
        except (OSError, KeyError, TypeError, json.JSONDecodeError, ValueError) as error:
            raise ValueError(f"invalid voice profile {entry.name}: {error}") from error
    return sorted(values, key=lambda value: (value["name"].casefold(), value["id"]))


def probe(path: Path) -> float:
    result = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration", "-of", "json", str(path)], check=True, capture_output=True, text=True, timeout=20)
    streams = json.loads(result.stdout).get("streams", [])
    seconds = float(streams[0]["duration"]) if streams and streams[0].get("duration") else 0
    if not math.isfinite(seconds) or seconds <= 0:
        raise ValueError("audio must contain a valid non-empty audio stream")
    return seconds


def reject_symlink_path(path: Path) -> None:
    if path.is_symlink():
        raise ValueError("audio path must not be a symlink")


def register(root: Path, request: dict) -> dict:
    name = request.get("name")
    transcript = request.get("transcript")
    audio_arg = request.get("audioPath")
    if not isinstance(name, str) or not (1 <= len(name.strip()) <= 100):
        raise ValueError("name must contain 1 to 100 characters")
    if not isinstance(transcript, str) or not (1 <= len(transcript.strip()) <= 2000):
        raise ValueError("transcript must contain 1 to 2000 characters")
    if not isinstance(audio_arg, str) or not audio_arg.strip():
        raise ValueError("audioPath is required")
    source = Path(audio_arg).expanduser()
    reject_symlink_path(source)
    source = source.resolve(strict=True)
    if not source.is_file() or source.suffix.lower() not in {".wav", ".mp3", ".m4a", ".flac", ".ogg", ".aac", ".wma"}:
        raise ValueError("audioPath must point to a supported audio file")
    seconds = probe(source)
    if not 3 <= seconds <= 30:
        raise ValueError("reference audio must be 3 to 30 seconds; 15 to 20 seconds is recommended")
    identifier = str(uuid.uuid4())
    voices = root / "voices"
    voices.mkdir(parents=True, exist_ok=True)
    if voices.is_symlink():
        raise ValueError("voice profile directory is unsafe")
    with profile_lock(root):
        staging = Path(tempfile.mkdtemp(prefix=f".{identifier}-", dir=voices))
        try:
            wav = staging / "reference.wav"
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(source), "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(wav)], check=True, capture_output=True, timeout=120)
            if not wav.is_file() or wav.stat().st_size <= 44:
                raise ValueError("audio conversion produced an empty reference")
            stored_duration = probe(wav)
            if not 3 <= stored_duration <= 30:
                raise ValueError("converted reference audio must be 3 to 30 seconds")
            profile = {"id": identifier, "name": name.strip(), "transcript": transcript, "durationSeconds": round(stored_duration, 3), "language": "zh", "audioFile": "reference.wav"}
            (staging / "profile.json").write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding="utf-8")
            staging.rename(voices / identifier)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            raise
    return profile_view(profile)


def status(root: Path) -> dict:
    source = root / "source"
    env_python = root / "env" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    model = root / "model"
    config_path = root / "backend.json"
    device = "cpu"
    if config_path.is_file():
        try:
            config = json.loads(config_path.read_text(encoding="utf-8"))
            device = config.get("device", "cpu")
            if device not in {"cpu", "mps", "cuda"} or config.get("llm_device", "cpu") not in {"cpu", "mps", "cuda"}:
                raise ValueError("backend.json contains an unsupported device")
        except (OSError, json.JSONDecodeError, AttributeError) as error:
            raise ValueError(f"invalid backend.json: {error}") from error
    missing_models = [name for name in MODEL_FILES if not (model / name).is_file() or (model / name).is_symlink() or (model / name).stat().st_size == 0]
    manifest = root / "model-manifest.json"
    if manifest.is_file():
        try:
            sizes = json.loads(manifest.read_text(encoding="utf-8"))["files"]
            missing_models.extend(name for name in MODEL_FILES if not isinstance(sizes.get(name), int) or sizes[name] <= 0 or not (model / name).is_file() or (model / name).stat().st_size != sizes[name])
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            missing_models.append("invalid model manifest")
    missing_source = not source.is_dir() or not (source / "single_inference.py").is_file()
    missing_config = not config_path.is_file()
    missing_dependencies = list(REQUIRED_MODULES)
    mps_available = True
    if env_python.is_file():
        check = "import importlib.util,json,torch; names=" + repr(REQUIRED_MODULES) + "; print(json.dumps({'missing':[n for n in names if importlib.util.find_spec(n) is None], 'mps':bool(getattr(torch.backends,'mps',None) and torch.backends.mps.is_available())}))"
        try:
            result = subprocess.run([str(env_python), "-c", check], capture_output=True, text=True, timeout=20, check=True)
            probe_result = json.loads(result.stdout)
            missing_dependencies = probe_result["missing"]
            mps_available = probe_result["mps"]
        except (OSError, subprocess.SubprocessError, KeyError, TypeError, json.JSONDecodeError):
            missing_dependencies = ["runtime dependency check failed"]
    missing = []
    if missing_source: missing.append("source")
    if not env_python.is_file(): missing.append("Python environment")
    if missing_config: missing.append("backend.json")
    missing.extend(missing_models)
    missing.extend(missing_dependencies)
    if device == "mps" and not mps_available: missing.append("MPS backend")
    ready = not missing
    profiles = safe_profiles(root)
    return {"ready": ready, "setupCommand": SETUP_COMMAND, "device": device, "voices": profiles, "root": str(root), "detail": None if ready else f"BreezyVoice setup is incomplete: {', '.join(missing)}. Run setup."}


def select_profile(root: Path, voice_id: str) -> tuple[dict, Path]:
    try:
        identifier = str(uuid.UUID(voice_id))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("voiceId must be a registered voice UUID") from error
    directory = root / "voices" / identifier
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("voice profile was not found")
    profile_path = directory / "profile.json"
    audio = directory / "reference.wav"
    if profile_path.is_symlink() or audio.is_symlink():
        raise ValueError("voice profile contains an unsafe symlink")
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    if profile.get("id") != identifier or profile.get("audioFile") != "reference.wav" or not audio.is_file():
        raise ValueError("voice profile is malformed")
    profile_view(profile)
    return profile, audio


def generate(root: Path, request: dict) -> dict:
    with profile_lock(root, ".setup.lock"):
        return _generate(root, request)


def _generate(root: Path, request: dict) -> dict:
    text = request.get("text")
    if not isinstance(text, str) or not (1 <= len(text.strip()) <= MAX_TEXT):
        raise ValueError("text must contain 1 to 300 characters")
    if not any("\u3400" <= c <= "\u9fff" for c in text):
        raise ValueError("text must contain Taiwanese Mandarin Chinese")
    output_arg = request.get("output")
    if not isinstance(output_arg, str) or not output_arg:
        raise ValueError("output path is required")
    output = Path(output_arg).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    try:
        output.parent.relative_to(temp_root)
    except ValueError as error:
        raise ValueError("output path must be under the system temporary directory") from error
    if not output.parent.name.startswith("swr-breezyvoice-") or output.name != "narration.wav":
        raise ValueError("output must be narration.wav in a private temporary directory")
    if output.is_symlink():
        raise ValueError("output path must not be a symlink")
    prompt_audio = output.parent / "voice-prompt.wav"
    converted = output.with_name("narration-pcm16.wav")
    try:
        with profile_lock(root):
            profile, saved_prompt = select_profile(root, request.get("voiceId"))
            shutil.copyfile(saved_prompt, prompt_audio)
        state = status(root)
        if not state["ready"]:
            raise RuntimeError("BreezyVoice is not configured; run setup first")
        source, model = root / "source", root / "model"
        config = json.loads((root / "backend.json").read_text(encoding="utf-8"))
        output.parent.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "BREEZYVOICE_BACKEND_CONFIG": str(root / "backend.json"), "BREEZYVOICE_DEVICE": config["device"], "BREEZYVOICE_LLM_DEVICE": config.get("llm_device", "cpu")})
        logs = root / "logs"
        logs.mkdir(exist_ok=True)
        log_path = logs / f"narration-{uuid.uuid4()}.log"
        try:
            with log_path.open("w", encoding="utf-8") as log:
                subprocess.run([str(root / "env" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")), "-u", str(source / "single_inference.py"), "--content_to_synthesize", text.strip(), "--speaker_prompt_audio_path", str(prompt_audio), "--speaker_prompt_text_transcription", profile["transcript"], "--output_path", str(output), "--model_path", str(model)], cwd=source, env=env, check=True, timeout=600, stdout=log, stderr=subprocess.STDOUT)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            with log_path.open("rb") as log:
                log.seek(max(0, log_path.stat().st_size - 1800))
                detail = log.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"BreezyVoice inference failed; log: {log_path}\n{detail}") from error
        raw_size = output.stat().st_size if output.is_file() else 0
        if raw_size <= 44:
            raise RuntimeError("BreezyVoice generated an empty WAV")
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(output), "-vn", "-ac", "1", "-ar", "22050", "-c:a", "pcm_s16le", str(converted)], check=True, capture_output=True, timeout=120)
        if not converted.is_file() or converted.stat().st_size <= 44:
            raise RuntimeError("audio conversion produced an empty WAV")
        os.replace(converted, output)
        seconds = probe(output)
        return {"output": str(output), "sampleRate": 22050, "durationSeconds": seconds}
    except Exception:
        output.unlink(missing_ok=True)
        raise
    finally:
        prompt_audio.unlink(missing_ok=True)
        converted.unlink(missing_ok=True)


def delete(root: Path, voice_id: str) -> dict:
    try:
        identifier = str(uuid.UUID(voice_id))
    except (ValueError, TypeError, AttributeError) as error:
        raise ValueError("voiceId must be a registered voice UUID") from error
    voices = root / "voices"
    entry = voices / identifier
    with profile_lock(root):
        if entry.is_symlink() or not entry.is_dir():
            raise ValueError("voice profile was not found")
        shutil.rmtree(entry)
    return {"deleted": identifier}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["status", "voices", "register", "delete", "generate"])
    parser.add_argument("--root")
    args = parser.parse_args()
    root = Path(args.root or default_root()).expanduser().resolve()
    try:
        request = json.load(sys.stdin) if args.command not in {"status", "voices"} else {}
        if args.command == "status": result = status(root)
        elif args.command == "voices": result = safe_profiles(root)
        elif args.command == "register": result = register(root, request)
        elif args.command == "delete": result = delete(root, request.get("voiceId"))
        else: result = generate(root, request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        code = "busy" if isinstance(error, BlockingIOError) else "not_found" if isinstance(error, FileNotFoundError) else "invalid_args" if isinstance(error, (ValueError, TypeError)) else "breezyvoice_failed"
        print(json.dumps({"ok": False, "error": {"code": code, "message": str(error)}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
