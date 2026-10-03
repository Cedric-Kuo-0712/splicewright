"""Local Kokoro ONNX CPU service. Setup is explicit; generate never downloads files."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

LANGUAGES = {"en-us": "English (US)", "en-gb": "English (UK)", "zh": "Mandarin Chinese"}
VOICES = [
    {"id": "af_heart", "name": "Heart (US, feminine)", "language": "en-us"},
    {"id": "am_adam", "name": "Adam (US, masculine)", "language": "en-us"},
    {"id": "bf_emma", "name": "Emma (UK, feminine)", "language": "en-gb"},
    {"id": "bm_george", "name": "George (UK, masculine)", "language": "en-gb"},
    {"id": "zf_001", "name": "Chinese voice 001 (feminine)", "language": "zh"},
    {"id": "zm_010", "name": "Chinese voice 010 (masculine)", "language": "zh"},
]
FILES = {
    "en-us": {
        "kokoro-v1.0.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx",
        "voices-v1.0.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin",
    },
    "en-gb": {},
    "zh": {
        "kokoro-v1.1-zh.onnx": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.1-zh.onnx",
        "voices-v1.1-zh.bin": "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.1-zh.bin",
        "config.json": "https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/resolve/main/config.json",
    },
}


def models_dir(root: Path) -> Path:
    return root / "models"


def python_path(root: Path) -> Path:
    return root / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def package_ok(root: Path, module: str) -> bool:
    py = python_path(root)
    if not py.exists():
        return False
    return subprocess.run([str(py), "-c", f"import importlib.util; raise SystemExit(0 if importlib.util.find_spec('{module}') else 1)"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8).returncode == 0


def status(root: Path) -> dict:
    models = models_dir(root)
    installed = package_ok(root, "kokoro_onnx") and package_ok(root, "soundfile") and package_ok(root, "onnxruntime")
    zh_installed = installed and package_ok(root, "misaki")
    installed_languages = []
    if installed and (models / "kokoro-v1.0.onnx").is_file() and (models / "voices-v1.0.bin").is_file():
        installed_languages.extend(["en-us", "en-gb"])
    if zh_installed and all((models / name).is_file() for name in FILES["zh"]):
        installed_languages.append("zh")
    return {
        "ready": bool(installed_languages),
        "voices": VOICES,
        "languages": [{"id": key, "name": value, "ready": key in installed_languages} for key, value in LANGUAGES.items()],
        "installedLanguages": installed_languages,
        "pythonInstalled": installed,
        "setupCommand": "splicewright tts setup --language en-us,zh",
        "root": str(root),
    }


def download(url: str, dest: Path) -> None:
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Splicewright/1 Kokoro setup"})
        with urllib.request.urlopen(req, timeout=60) as response, tmp.open("wb") as out:
            total = int(response.headers.get("Content-Length", "0"))
            done = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                out.write(block)
                done += len(block)
                if total:
                    print(f"download {dest.name}: {done * 100 // total}%", flush=True)
        if total and done != total:
            raise RuntimeError(f"incomplete download: {dest.name} ({done}/{total} bytes)")
        if tmp.stat().st_size == 0:
            raise RuntimeError(f"downloaded empty file: {dest.name}")
        tmp.replace(dest)
    finally:
        tmp.unlink(missing_ok=True)


@contextmanager
def setup_lock(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    with (root / ".setup.lock").open("a+b") as lock:
        # Kernel locks are released even when setup is killed; a crashed installer cannot leave a stale lock.
        if os.name == "nt":
            import msvcrt
            if lock.seek(0, os.SEEK_END) == 0:
                lock.write(b"\0")
                lock.flush()
            lock.seek(0)
            try:
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise RuntimeError("another Kokoro setup is already running") from error
        else:
            import fcntl
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise RuntimeError("another Kokoro setup is already running") from error
        try:
            yield
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def setup(root: Path, languages: list[str]) -> dict:
    with setup_lock(root):
        return setup_unlocked(root, languages)


def setup_unlocked(root: Path, languages: list[str]) -> dict:
    for language in languages:
        if language not in LANGUAGES:
            raise ValueError(f"unsupported language: {language}")
    version = sys.version_info
    if version < (3, 10) or version >= (3, 13):
        raise RuntimeError(f"Kokoro setup requires Python 3.10–3.12; found {version.major}.{version.minor}")
    root.mkdir(parents=True, exist_ok=True)
    venv = python_path(root)
    if not venv.exists():
        print(f"creating isolated venv at {root / '.venv'}", flush=True)
        subprocess.run([sys.executable, "-m", "venv", str(root / ".venv")], check=True, timeout=180)
    py = str(venv)
    packages = ["kokoro-onnx==0.6.1", "onnxruntime>=1.20,<2", "soundfile>=0.12,<1"]
    if "zh" in languages and not package_ok(root, "misaki"):
        packages.append("misaki-fork[zh]==0.9.6")
    if not package_ok(root, "kokoro_onnx") or not package_ok(root, "onnxruntime") or not package_ok(root, "soundfile") or ("zh" in languages and not package_ok(root, "misaki")):
        subprocess.run([py, "-m", "pip", "install", "--disable-pip-version-check", *packages], check=True, timeout=900)
    model_dir = models_dir(root)
    model_dir.mkdir(parents=True, exist_ok=True)
    wanted = set(languages)
    if wanted & {"en-us", "en-gb"}:
        wanted.update({"en-us", "en-gb"})
    files = {}
    for language in wanted:
        files.update(FILES[language])
    for name, url in files.items():
        dest = model_dir / name
        if dest.is_file() and dest.stat().st_size:
            print(f"already present: {name}", flush=True)
            continue
        print(f"downloading {name}", flush=True)
        download(url, dest)
    result = status(root)
    result["installed"] = sorted(wanted)
    return result


def generate(root: Path, request: dict) -> dict:
    with setup_lock(root):
        return generate_unlocked(root, request)


def generate_unlocked(root: Path, request: dict) -> dict:
    state = status(root)
    language = request["language"]
    if language not in state["installedLanguages"]:
        raise RuntimeError(f"{language} model is not installed; run `{state['setupCommand']}` first")
    from kokoro_onnx import Kokoro
    import onnxruntime as ort
    import soundfile as sf
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
    options.inter_op_num_threads = 1
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    model_dir = models_dir(root)
    if language == "zh":
        model = model_dir / "kokoro-v1.1-zh.onnx"
        voices = model_dir / "voices-v1.1-zh.bin"
        session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        kokoro = Kokoro.from_session(session, voices_path=str(voices), vocab_config=str(model_dir / "config.json"))
        from misaki import zh
        phonemes, _ = zh.ZHG2P(version="1.1")(request["text"])
        samples, rate = kokoro.create(phonemes, request["voice"], speed=request["speed"], is_phonemes=True)
    else:
        model = model_dir / "kokoro-v1.0.onnx"
        voices = model_dir / "voices-v1.0.bin"
        session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        kokoro = Kokoro.from_session(session, voices_path=str(voices))
        samples, rate = kokoro.create(request["text"], request["voice"], speed=request["speed"], lang=language)
    output = Path(request["output"])
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), samples, rate, format="WAV", subtype="PCM_16")
    return {"output": str(output), "sampleRate": int(rate), "samples": int(len(samples))}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["status", "setup", "generate"])
    parser.add_argument("--root", required=True)
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()
    try:
        request = json.load(sys.stdin) if args.command != "status" else {}
        if args.command == "status":
            result = status(root)
        elif args.command == "setup":
            result = setup(root, request.get("languages", []))
        else:
            result = generate(root, request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "error": {"code": "tts_failed", "message": str(error)}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
