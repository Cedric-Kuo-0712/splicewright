#!/usr/bin/env python3
"""Install the pinned, isolated BreezyVoice runtime. Progress is written to stderr."""
from __future__ import annotations

from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import threading
import traceback
import urllib.request

SOURCE_URL = "https://github.com/mtkresearch/BreezyVoice.git"
SOURCE_COMMIT = "d592c9d3e8927a0f53f68616387060dcd32a05ea"
MODEL_ID = "MediaTek-Research/BreezyVoice"
MODEL_FILES = (
    "cosyvoice.yaml", "configuration.json", "campplus.onnx",
    "speech_tokenizer_v1.onnx", "spk2info.pt", "llm.pt", "flow.pt", "hift.pt",
)
DEFAULT_ROOT = Path("~/.splicewright/breezyvoice").expanduser().resolve()
ROOT = Path(os.environ.get("SPLICEWRIGHT_BREEZYVOICE_HOME", DEFAULT_ROOT)).expanduser().resolve()


def python_path(root: Path) -> Path:
    return root / "env" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def runtime_paths(root: Path) -> dict[str, Path]:
    return {"root": root, "source": root / "source", "env": root / "env", "model": root / "model"}


def stage(root: Path, name: str) -> None:
    print(f"BreezyVoice setup: {name}", file=sys.stderr, flush=True)
    state = {"stage": name, "updatedAt": datetime.now(timezone.utc).isoformat()}
    write_json(root / "setup-state.json", state)


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def run(args: list[str | Path], *, cwd: Path | None = None, timeout: int = 1800) -> subprocess.CompletedProcess:
    command = [str(arg) for arg in args]
    print("$ " + " ".join(command), file=sys.stderr, flush=True)
    with open(ROOT / "setup.log", "a", encoding="utf-8") as log:
        log.write("$ " + " ".join(command) + "\n")
        log.flush()
        process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        def stream_output() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                sys.stderr.write(line)
                log.write(line)
                log.flush()
        reader = threading.Thread(target=stream_output, daemon=True)
        reader.start()
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            reader.join()
            raise
        reader.join()
        if code:
            raise subprocess.CalledProcessError(code, command)
        return subprocess.CompletedProcess(command, code)


def resolve_micromamba(root: Path) -> Path:
    for name in ("micromamba", "mamba", "conda"):
        found = shutil.which(name)
        if found:
            return Path(found)

    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "darwin":
        os_tag = "osx"
        arch = "arm64" if machine in ("arm64", "aarch64") else "64"
    elif system == "linux":
        os_tag = "linux"
        arch = "aarch64" if machine in ("arm64", "aarch64") else "64"
    else:
        raise RuntimeError("BreezyVoice setup supports macOS and Linux/WSL2 only; use WSL2 on Windows")
    manager = root / "bin" / "micromamba"
    manager.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://micro.mamba.pm/api/micromamba/{os_tag}-{arch}/latest"
    stage(root, f"downloading local micromamba from {url}")
    archive = manager.parent / "micromamba.tar.bz2.part"
    request = urllib.request.Request(url, headers={"User-Agent": "Splicewright/1"})
    with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as out:
        shutil.copyfileobj(response, out)
    try:
        with tarfile.open(archive, "r:bz2") as bundle:
            member = next((item for item in bundle.getmembers() if item.name == "bin/micromamba" and item.isfile()), None)
            if member is None:
                raise RuntimeError("micromamba archive did not contain bin/micromamba")
            source = bundle.extractfile(member)
            if source is None:
                raise RuntimeError("could not extract micromamba executable")
            with source, manager.open("wb") as out:
                shutil.copyfileobj(source, out)
    finally:
        archive.unlink(missing_ok=True)
    manager.chmod(0o755)
    return manager


def prepare_source(root: Path, source: Path) -> None:
    ownership = root / "source-owner.json"
    if source.exists():
        if not (source / ".git").is_dir():
            raise RuntimeError(f"refusing to replace unmanaged source directory: {source}")
        owner = json.loads(ownership.read_text(encoding="utf-8")) if ownership.is_file() else {}
        if owner and owner.get("repository") != SOURCE_URL:
            raise RuntimeError(f"runtime source ownership metadata does not match {SOURCE_URL}")
        origin = subprocess.run(["git", "remote", "get-url", "origin"], cwd=source, capture_output=True, text=True, check=True).stdout.strip()
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, capture_output=True, text=True, check=True).stdout.strip()
        if origin.rstrip("/").removesuffix(".git") != SOURCE_URL.removesuffix(".git") or commit != SOURCE_COMMIT:
            raise RuntimeError("refusing to replace a BreezyVoice checkout with a different origin or revision")
        # Upstream tracks .pyc files. Importing its modules changes them; retain these runtime caches.
        dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=source, capture_output=True, text=True, check=True).stdout.splitlines()
        dirty = [line for line in dirty if not (line.startswith(" M ") and "__pycache__" in Path(line[3:]).parts and line.endswith(".pyc"))]
        patch = Path(__file__).with_name("breezyvoice-mps.patch")
        patched_files = {line.split()[1][2:] for line in patch.read_text(encoding="utf-8").splitlines() if line.startswith("+++ b/")}
        allowed_patch = bool(dirty) and all(line.startswith(" M ") and line[3:] in patched_files for line in dirty)
        patch_is_applied = subprocess.run(["git", "apply", "--reverse", "--check", str(patch)], cwd=source, capture_output=True).returncode == 0
        if dirty and not (allowed_patch and patch_is_applied):
            raise RuntimeError(f"BreezyVoice source has local changes; preserve and inspect them before setup: {source}")
        # This pinned revision is already present; no checkout/reset touches local caches or files.
    else:
        source.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "clone", "--filter=blob:none", "--no-checkout", SOURCE_URL, source], cwd=root)
        run(["git", "checkout", "--detach", SOURCE_COMMIT], cwd=source)
    actual = subprocess.run(["git", "rev-parse", "HEAD"], cwd=source, capture_output=True, text=True, check=True).stdout.strip()
    if actual != SOURCE_COMMIT:
        raise RuntimeError(f"source revision mismatch: expected {SOURCE_COMMIT}, got {actual}")
    write_json(ownership, {"repository": SOURCE_URL, "managedBy": "Splicewright", "sourceCommit": SOURCE_COMMIT})


def setup(request: dict) -> dict:
    global ROOT
    root = Path(os.environ.get("SPLICEWRIGHT_BREEZYVOICE_HOME") or request.get("root") or DEFAULT_ROOT).expanduser().resolve()
    ROOT = root
    paths = runtime_paths(root)
    root.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(root).free < 8 * 1024**3:
        raise RuntimeError("BreezyVoice setup requires at least 8 GiB free disk space")
    if platform.system() == "Windows":
        raise RuntimeError("native Windows is unsupported because BreezyVoice requires pynini; install inside WSL2")
    if platform.system() not in ("Darwin", "Linux"):
        raise RuntimeError(f"unsupported platform: {platform.system()}")

    lock_path = root / ".setup.lock"
    with lock_path.open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                if lock.read(1) == b"":
                    lock.write(b"\0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, ImportError) as exc:
            raise RuntimeError("another BreezyVoice setup is already running") from exc
        try:
            if request.get("languages") not in (None, [], ["en-us", "zh"], ["zh", "en-us"]):
                raise RuntimeError("BreezyVoice currently supports languages en-us and zh")
            _install(paths)
        finally:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_UN)
    backend = root / "backend.json"
    device = json.loads(backend.read_text(encoding="utf-8")).get("device", "cpu") if backend.exists() else "cpu"
    return {"ready": True, "setupCommand": "splicewright tts setup --engine breezyvoice",
            "root": str(root), "device": device, "voices": []}


def _install(paths: dict[str, Path]) -> None:
    root, source, model = paths["root"], paths["source"], paths["model"]
    stage(root, "checking managed BreezyVoice source")
    prepare_source(root, source)

    stage(root, "creating isolated Python 3.10 environment with pynini")
    manager = resolve_micromamba(root)
    py = python_path(root)
    if not py.exists():
        run([manager, "create", "--yes", "--prefix", paths["env"], "--override-channels", "--channel", "conda-forge", "python=3.10", "pynini=2.1.5", "pip"], cwd=root, timeout=3600)

    stage(root, "preparing legacy Whisper build dependencies")
    run([py, "-m", "pip", "install", "--disable-pip-version-check", "setuptools==80.9.0", "wheel", "packaging"], cwd=root)
    run([py, "-m", "pip", "install", "--disable-pip-version-check", "--no-build-isolation", "--no-deps", "openai-whisper==20231117"], cwd=root, timeout=3600)
    stage(root, "installing pinned BreezyVoice dependencies")
    if platform.system() == "Linux":
        # The default Linux PyPI wheel includes CUDA dependencies; this runtime is CPU-only.
        run([py, "-m", "pip", "install", "--index-url", "https://download.pytorch.org/whl/cpu", "torch==2.3.1", "torchaudio==2.3.1"], cwd=root, timeout=3600)
    run([py, "-m", "pip", "install", "--disable-pip-version-check", "-r", Path(__file__).with_name("breezyvoice-requirements.txt")], cwd=root, timeout=7200)

    stage(root, "applying explicit CPU/MPS backend selection")
    patch = Path(__file__).with_name("breezyvoice-mps.patch")
    reverse = subprocess.run(["git", "apply", "--reverse", "--check", str(patch)], cwd=source, capture_output=True).returncode == 0
    if not reverse:
        run(["git", "apply", "--check", patch], cwd=source)
        run(["git", "apply", patch], cwd=source)

    stage(root, "checking BreezyVoice imports and entrypoint")
    run([py, source / "single_inference.py", "--help"], cwd=source)
    run([py, "-c", "import sys; sys.path.insert(0, 'third_party/Matcha-TTS'); import cosyvoice.flow.flow_matching; import cosyvoice.hifigan.generator"], cwd=source)

    stage(root, "resolving and downloading pinned model snapshot")
    with urllib.request.urlopen(f"https://huggingface.co/api/models/{MODEL_ID}", timeout=30) as response:
        revision = json.load(response).get("sha")
    if not revision or len(revision) != 40:
        raise RuntimeError("Hugging Face did not return a pinned model revision")
    files = list(MODEL_FILES)
    code = ("from huggingface_hub import HfApi,snapshot_download; import json; from pathlib import Path; "
            f"info=HfApi().model_info({MODEL_ID!r},revision={revision!r},files_metadata=True); "
            f"sizes={{f.rfilename:f.size for f in info.siblings if f.rfilename in {files!r}}}; "
            f"assert all(isinstance(sizes.get(f),int) and sizes[f]>0 for f in {files!r}), 'model size metadata missing'; "
            f"snapshot_download({MODEL_ID!r}, revision={revision!r}, local_dir={str(model)!r}, allow_patterns={files!r}, max_workers=2); "
            f"assert all((Path({str(model)!r})/f).stat().st_size==sizes[f] for f in {files!r}), 'model download size mismatch'; "
            f"Path({str(root / 'model-manifest.json')!r}).write_text(json.dumps({{'revision':{revision!r},'files':sizes}}),encoding='utf-8')")
    run([py, "-c", code], cwd=root, timeout=7200)
    for filename in MODEL_FILES:
        if not (model / filename).is_file() or (model / filename).stat().st_size == 0:
            raise RuntimeError(f"model snapshot is missing or empty: {filename}")

    stage(root, "warming pronunciation and text normalization assets")
    run([py, "-c", "from g2pw import G2PWConverter; g=G2PWConverter(); g('你好，欢迎。'); from tn.chinese.normalizer import Normalizer as Zh; from tn.english.normalizer import Normalizer as En; Zh(remove_erhua=False, full_to_half=False).normalize('你好。'); En().normalize('Hello.')"], cwd=source, timeout=1800)
    device = "cpu"
    if platform.system() == "Darwin" and platform.machine().lower() in ("arm64", "aarch64"):
        result = subprocess.run([str(py), "-c", "import torch; print(int(torch.backends.mps.is_available()))"], capture_output=True, text=True, check=True)
        if result.stdout.strip().endswith("1"):
            device = "mps"
    write_json(root / "backend.json", {"device": device, "llm_device": "cpu"})
    write_json(root / "environment.json", {"sourceCommit": SOURCE_COMMIT, "model": MODEL_ID, "modelRevision": revision,
                                            "device": device, "python": str(py),
                                            "preparedAt": datetime.now(timezone.utc).isoformat()})


def main() -> int:
    if "--help" in sys.argv[1:] or "-h" in sys.argv[1:]:
        print("Usage: python setup_breezyvoice.py < setup-options.json\nReads optional {root, languages} JSON from stdin.")
        return 0
    try:
        try:
            request = json.load(sys.stdin) if not sys.stdin.isatty() else {}
        except json.JSONDecodeError as exc:
            raise RuntimeError("stdin must contain one JSON object") from exc
        result = setup(request)
        write_json(ROOT / "setup-state.json", {"stage": "READY", "updatedAt": datetime.now(timezone.utc).isoformat()})
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False), flush=True)
        return 0
    except Exception as exc:  # return a machine-readable final envelope and keep details in the durable log
        try:
            ROOT.mkdir(parents=True, exist_ok=True)
            with (ROOT / "setup.log").open("a", encoding="utf-8") as log:
                traceback.print_exc(file=log)
            write_json(ROOT / "setup-state.json", {"stage": "FAILED", "error": str(exc), "updatedAt": datetime.now(timezone.utc).isoformat()})
        except OSError:
            pass
        print(json.dumps({"ok": False, "error": {"code": "BREEZYVOICE_SETUP_FAILED", "message": str(exc)}}, ensure_ascii=False), flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
