"""Run the selected installed harnesses' non-interactive updaters."""
import fcntl
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

from . import config, procs


COMMANDS = {"opencode": "upgrade", "qwen": "update", "codex": "update", "claude": "update",
            "agy": "update", "orcacode": "update"}


def search_path():
    return os.pathsep.join(directory for directory in os.get_exec_path() if os.path.isabs(directory)) or os.defpath


def update_command(name, environment):
    path = environment["PATH"]
    program = name
    if name == "codex":
        program = config.codex_override() or name
    elif name == "claude":
        program = config.env("CODEX_TASK_CLAUDE") or name
    binary = shutil.which(os.path.expanduser(program), path=path)
    if not binary:
        raise ValueError(f"{program} is not installed")
    binary = os.path.abspath(binary)
    target = Path(binary).resolve()
    if any(parent.name == "Contents" and parent.parent.suffix == ".app" for parent in target.parents):
        raise ValueError(f"{binary} is managed by its macOS app; update the app itself")
    casks = {"claude": ("claude-code", "claude-code@latest"), "codex": ("codex",)}
    for parent in target.parents:
        if parent.parent.name == "Caskroom" and parent.name in casks.get(name, ()):
            brew = parent.parent.parent / "bin/brew"
            return [str(brew), "upgrade", "--cask", parent.name]
    # Keep global installs in their own prefix even when PATH supplies a different npm.
    npm_root = next((parent for parent in target.parents
                     if parent.name == "node_modules" and parent.parent.name == "lib"), None)
    if npm_root:
        prefix = str(npm_root.parent.parent)
        environment["npm_config_prefix"] = prefix
        packages = {"qwen": "@qwen-code/qwen-code", "codex": "@openai/codex"}
        package = packages.get(name)
        if package and target.is_relative_to(npm_root / package):
            npm = shutil.which("npm", path=path)
            if not npm:
                raise ValueError(f"npm is required for this {name} installation")
            return [npm, "install", "--global", "--prefix", prefix, package + "@latest"]
    if name == "codex":
        # Older Codex versions interpret an unknown subcommand as a prompt.
        help_text = subprocess.check_output([binary, "--help"], cwd=Path.home(), env=environment,
                                            stdin=subprocess.DEVNULL, timeout=15, text=True, errors="replace")
        if not re.search(r"^\s*update\s+", help_text, re.MULTILINE):
            raise ValueError(f"{binary} does not provide a non-interactive update command")
    if name == "orcacode":
        environment["ORCACODE_INSTALL_DIR"] = str(target.parent)
    if name == "qwen":
        # Outside a standalone install, "qwen update" can just print instructions and exit zero.
        manifest = Path(binary).parent.parent / "lib/qwen-code/manifest.json"
        if not manifest.is_file() and not (target.parent.parent / "manifest.json").is_file():
            raise ValueError(f"cannot identify a standalone or global npm installation for {binary}")
    return [binary, COMMANDS[name]]


def update(names):
    with (config.DATA_HOME / "harness-updates.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            procs.die("another harness update is running")
        failed = []
        for name in dict.fromkeys(names):
            try:
                environment = {**os.environ, "PATH": search_path()}
                argv = update_command(name, environment)
                print(f"Updating {name} with {argv[0]}", flush=True)
                with subprocess.Popen(argv, cwd=Path.home(), env=environment, stdin=subprocess.DEVNULL,
                                      start_new_session=True) as process:
                    try:
                        code = process.wait(timeout=600)
                    except (subprocess.TimeoutExpired, KeyboardInterrupt):
                        procs.terminate(process)
                        raise
                if code:
                    raise ValueError(f"updater exited with status {code}")
            except (ValueError, OSError, subprocess.SubprocessError) as exc:
                print(f"teamster: {name}: {exc}", file=sys.stderr, flush=True)
                failed.append(name)
        if failed:
            procs.die("harness update failed: " + ", ".join(failed))
