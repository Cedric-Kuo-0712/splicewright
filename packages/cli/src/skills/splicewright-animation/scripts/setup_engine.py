"""Scaffold optional animation engines locally; never overwrite authored files."""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def safe_directory(value: str) -> Path:
    root = Path.cwd().resolve()
    target = root / value
    if Path(value).is_absolute() or '..' in Path(value).parts:
        raise ValueError('--dir must be a relative directory inside the video project')
    if not Path(value).parts or Path(value).parts[0] in ('raw', '.agents'):
        raise ValueError('use a separate authored-source directory such as animations/manim')
    for parent in [target, *target.parents]:
        if parent.is_symlink():
            raise ValueError(f'refusing symlink destination: {parent}')
        if parent == root:
            break
    return target


def prepare(engine: str, target: Path, install: bool) -> list[str]:
    source = Path(__file__).resolve().parent.parent / 'assets' / engine
    created = []
    # Check all paths before any mutation, including existing destination files.
    paths = sorted(source.rglob('*.template'))
    if not paths:
        raise ValueError(f'missing bundled assets for {engine}')
    for path in paths:
        dest = target / path.relative_to(source).with_suffix('')
        if path.is_symlink() or any(p.is_symlink() for p in [dest, *dest.parents]):
            raise ValueError(f'refusing symlink: {dest}')
    for path in paths:
        dest = target / path.relative_to(source).with_suffix('')
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, dest)
        created.append(str(dest.relative_to(Path.cwd())))
    if install:
        if engine == 'motion-canvas':
            if not shutil.which('npm'):
                raise ValueError('npm is required to install Motion Canvas')
            subprocess.run(['npm', 'install', '--no-audit', '--no-fund'], cwd=target, check=True)
        else:
            if not shutil.which('pkg-config'):
                raise ValueError('Manim needs pkg-config and native Cairo/Pango; install these for your OS, then retry --install')
            if subprocess.run(['pkg-config', '--exists', 'cairo', 'pangocairo']).returncode:
                raise ValueError('Manim needs native Cairo and Pango, and pkg-config cannot find them; install these for your OS, then retry --install')
            env = target / '.venv'
            if env.is_symlink():
                raise ValueError('refusing symlink .venv')
            subprocess.run([sys.executable, '-m', 'venv', str(env)], check=True)
            python = env / ('Scripts/python.exe' if sys.platform == 'win32' else 'bin/python')
            subprocess.run([str(python), '-m', 'pip', 'install', '-r', 'requirements.txt'], cwd=target, check=True)
    return created


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('engine', choices=['motion-canvas', 'manim'])
    parser.add_argument('--dir', required=True)
    parser.add_argument('--install', action='store_true')
    args = parser.parse_args()
    try:
        for path in prepare(args.engine, safe_directory(args.dir), args.install):
            print(path)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'animation setup: {error}\n')


if __name__ == '__main__':
    main()
