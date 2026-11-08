"""Immutable side-by-side installs: upgrade, versions, launchers, the current link and task pins."""
import ast
import datetime
import fcntl
import io
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from contextlib import contextmanager, nullcontext
from pathlib import Path

from . import config, procs, task_state


DEFAULT_SOURCE = "https://github.com/kaifaty/teamster.git"
DEFAULT_REF = "origin/main"
LAUNCHERS = ("teamster", "codex-worker")
ENTRYPOINT = Path("src/teamster/__main__.py")
VERSION_NAME = re.compile(r"[0-9][0-9A-Za-z.+-]*")
VERIFY_TIMEOUT = 120
# Set for a say or review that re-ran itself in the task's pinned version.
PINNED_VARIABLE = "TEAMSTER_PINNED"


def versions_dir():
    return config.DATA_HOME / "versions"


def bin_dir():
    return config.DATA_HOME / "bin"


def current_link():
    return versions_dir() / "current"


def current_version():
    """The version directory name the current link points to, or None."""
    link = current_link()
    if not link.is_symlink():
        return None
    return Path(os.readlink(link)).name


def installed_versions():
    directory = versions_dir()
    if not directory.is_dir():
        return []
    names = [path.name for path in directory.iterdir()
             if VERSION_NAME.fullmatch(path.name) and path.is_dir() and not path.is_symlink()]
    return sorted(names, key=version_key)


def version_key(name):
    return [(0, int(part), "") if part.isdigit() else (1, 0, part) for part in re.split(r"[.+-]", name)]


def running_from_versions():
    """Whether this process runs from a version directory of this data home."""
    return versions_dir().resolve() in config.SCRIPT_RESOLVED.parents


@contextmanager
def locked(name, mode):
    directory = versions_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / name).open("a") as lock:
        fcntl.flock(lock, mode)
        yield


def upgrade_lock():
    """One upgrade or prune at a time, cache clone fetch included."""
    return locked(".upgrade.lock", fcntl.LOCK_EX)


def versions_lock():
    """Exclusive against supervisor starts: prune and data layout changes check supervisors under it."""
    return locked(".lock", fcntl.LOCK_EX)


def spawn_lock():
    """Held shared while a supervisor starts; without versions/ (a uv tool install) nothing to hold."""
    return locked(".lock", fcntl.LOCK_SH) if versions_dir().is_dir() else nullcontext()


def process_command(pid):
    """The command line of a live process, read with ps so it works on macOS and Linux."""
    try:
        result = subprocess.run(["ps", "-o", "command=", "-p", str(pid)],
                                capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""


def supervisor_version(command):
    """The installed version whose __main__.py the command line runs, or None."""
    directory = versions_dir().resolve()
    entry = os.sep + str(ENTRYPOINT)
    for name in installed_versions():
        if str(directory / name) + entry in command:
            return name
    if str(directory / "current") + entry in command:
        return current_version()
    return None


def live_supervisors():
    """(slug, version or None) for every live supervisor of this data home, scouts included."""
    out = []
    for slug in sorted(task_state.running_tasks(scouts=True)):
        pid = task_state.load(slug).get("pid")
        out.append((slug, supervisor_version(process_command(pid)) if pid else None))
    return out


def supervisor_lines(supervisors):
    if not supervisors:
        return ["live supervisors: none"]
    return ["live supervisors:"] + [f"  {slug}\t{version or 'outside ' + str(versions_dir())}"
                                    for slug, version in supervisors]


def git(repo, *args, binary=False):
    result = subprocess.run(config.GIT + list(args), cwd=str(repo), capture_output=True,
                            text=not binary)
    if result.returncode != 0:
        error = result.stderr.decode(errors="replace") if binary else result.stderr
        procs.die(f"git {' '.join(args)} failed in {repo}:\n{error.strip()}")
    return result.stdout


def source_repo(source):
    """A local clone to archive from: the given path, or the fetched cache clone of a URL."""
    path = Path(source).expanduser()
    if path.is_dir():
        return path.resolve()
    cache = versions_dir() / ".source"
    if not (cache / ".git").is_dir():
        if cache.exists():
            shutil.rmtree(cache)
        versions_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
        result = subprocess.run(config.GIT + ["clone", "--quiet", "--no-checkout", source, str(cache)],
                                capture_output=True, text=True)
        if result.returncode != 0:
            procs.die(f"git clone {source} failed:\n{result.stderr.strip()}")
    else:
        git(cache, "remote", "set-url", "origin", source)
        git(cache, "fetch", "--quiet", "--prune", "origin")
    return cache


def init_values(text):
    values = {}
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    values[target.id] = node.value.value
    return values


def layout_value(values):
    layout = values.get("DATA_LAYOUT", 1)
    return layout if isinstance(layout, int) and not isinstance(layout, bool) else 1


def version_layout(version):
    """DATA_LAYOUT from an installed version's __init__.py; outside versions/, this process's."""
    if version is None:
        return config.data_layout()
    try:
        text = (versions_dir() / version / "src/teamster/__init__.py").read_text(encoding="utf-8")
    except OSError:
        return 1
    return layout_value(init_values(text))


def release_info(repo, commit):
    """(__version__, DATA_LAYOUT) from the revision's src/teamster/__init__.py."""
    values = init_values(git(repo, "show", f"{commit}:src/teamster/__init__.py"))
    version = values.get("__version__")
    if not isinstance(version, str) or not VERSION_NAME.fullmatch(version):
        procs.die(f"{commit} has no usable __version__ in src/teamster/__init__.py")
    return version, layout_value(values)


def extract(repo, commit, destination):
    archive = git(repo, "archive", "--format=tar", commit, "--", "src", binary=True)
    root = destination.resolve()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tree:
        for member in tree.getmembers():
            target = (root / member.name).resolve()
            if root not in target.parents or not (member.isfile() or member.isdir()):
                procs.die("unsupported archive entry: " + member.name)
        if hasattr(tarfile, "data_filter"):
            tree.extractall(str(root), filter="data")
        else:
            tree.extractall(str(root))


def verify_environment(home):
    """No inherited homes, accounts, clocks or overrides: only the tree under test."""
    return {"PATH": os.defpath, "HOME": str(home), "CODEX_TASK_HOME": str(home / ".codex"),
            "CODEX_TASK_CODEX": str(home / "codex-disabled"), "CODEX_HOME": str(home / ".codex"),
            "CLAUDE_CONFIG_DIR": str(home / ".claude"), "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"), "LC_ALL": "C", "COLUMNS": "80", "TERM": "dumb"}


def verify(tree, version):
    script = tree / ENTRYPOINT
    with tempfile.TemporaryDirectory(prefix="teamster-verify-") as home:
        environment = verify_environment(Path(home))
        for args, expect in ((["--version"], version + "\n"), (["docs", "lead-guide"], None)):
            try:
                result = subprocess.run([python(), "-I", "-B", str(script)] + args, cwd=home,
                                        env=environment, capture_output=True, text=True,
                                        timeout=VERIFY_TIMEOUT)
            except subprocess.TimeoutExpired:
                return f"{' '.join(args)} did not finish in {VERIFY_TIMEOUT} s"
            if result.returncode != 0:
                return f"{' '.join(args)} exited with {result.returncode}: {result.stderr.strip()[-500:]}"
            if expect is not None and result.stdout != expect:
                return f"{' '.join(args)} printed {result.stdout.strip()!r}, expected {version!r}"
    return None


def tree_files(root):
    files = {}
    for directory, names, filenames in os.walk(root):
        names[:] = sorted(name for name in names if name != "__pycache__")
        for name in filenames:
            path = Path(directory, name)
            files[str(path.relative_to(root))] = path.read_bytes()
    return files


def python():
    """The launchers' Python: the base interpreter when upgrade runs inside a virtual environment.

    Symbolic links stay unresolved, so a path such as a package manager's stable link survives its updates.
    """
    if sys.prefix == sys.base_prefix:
        return os.path.abspath(sys.executable)
    environment = os.path.abspath(sys.prefix) + os.sep
    release = "python%d.%d" % sys.version_info[:2]
    candidates = [getattr(sys, "_base_executable", None)]
    candidates += [os.path.join(sys.base_prefix, "bin", name) for name in (release, "python3")]
    for candidate in candidates:
        if (candidate and os.path.isabs(candidate) and not os.path.abspath(candidate).startswith(environment)
                and os.path.isfile(candidate) and os.access(candidate, os.X_OK)):
            return os.path.abspath(candidate)
    procs.die("upgrade: this Python runs in a virtual environment and its base interpreter was not found; "
              f"run the upgrade with the system Python: python3 -I \"$({config.COMMAND} path)/__main__.py\" upgrade")


def launcher_text():
    script = current_link() / ENTRYPOINT
    return f"#!/bin/sh\nexec {shlex.quote(python())} -I {shlex.quote(str(script))} \"$@\"\n"


def write_launchers():
    """Write launchers that are missing or differ; return the names written."""
    text = launcher_text()
    written = []
    bin_dir().mkdir(mode=0o755, parents=True, exist_ok=True)
    for name in LAUNCHERS:
        path = bin_dir() / name
        if path.is_file() and path.read_text(encoding="utf-8") == text and os.access(path, os.X_OK):
            continue
        temporary = path.with_name(f".{name}.{os.getpid()}")
        temporary.write_text(text, encoding="utf-8")
        temporary.chmod(0o755)
        os.replace(temporary, path)
        written.append(name)
    return written


def switch_current(version):
    """Point current at the version in one rename; return False when it already does."""
    link = current_link()
    if link.is_symlink() and os.readlink(link) == version:
        return False
    if link.exists() and not link.is_symlink():
        procs.die(f"{link} is not a symbolic link; move it aside and run upgrade again")
    temporary = link.with_name(f".current.{os.getpid()}")
    if temporary.is_symlink() or temporary.exists():
        temporary.unlink()
    os.symlink(version, temporary)
    os.replace(temporary, link)
    return True


def install(repo, commit, version):
    """Archive, verify and move the revision into versions/<version>; return False if already there."""
    target = versions_dir() / version
    staging = Path(tempfile.mkdtemp(prefix=".tmp-", dir=str(versions_dir())))
    try:
        extract(repo, commit, staging)
        problem = verify(staging, version)
        if problem:
            procs.die(f"upgrade: {commit[:12]} failed verification, nothing installed: {problem}")
        if target.exists():
            if tree_files(target) != tree_files(staging):
                procs.die(f"upgrade: version {version} is already installed with different contents; "
                          "the release must raise __version__ in src/teamster/__init__.py")
            return False
        os.replace(staging, target)
        return True
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def task_version(st):
    """The version a task is pinned to: that of its last spawn, else the one that started it, or None."""
    runtime = st.get("runtime")
    if isinstance(runtime, dict) and isinstance(runtime.get("version"), str):
        return runtime["version"]
    version = st.get("plugin_version")
    return version if isinstance(version, str) else None


def follow_pin(st, upgrade=False):
    """Re-run this command in the task's pinned version while it is installed with the current data layout.

    Otherwise, or with upgrade, the command goes on in this version: return the line that reports
    the move, or None when the task already runs this version. A command that is itself a re-run
    (PINNED_VARIABLE set) never runs again, so a mismatch cannot loop.
    """
    rerun = os.environ.pop(PINNED_VARIABLE, None)
    pinned, own = task_version(st), config.plugin_version()
    if pinned == own:
        return None
    if not upgrade and rerun is None and pinned and VERSION_NAME.fullmatch(pinned):
        script = versions_dir() / pinned / ENTRYPOINT
        if script.is_file() and version_layout(pinned) == version_layout(current_version()):
            os.environ[PINNED_VARIABLE] = pinned
            sys.stdout.flush()
            sys.stderr.flush()
            flags = ["-I"] if sys.flags.isolated else []
            os.execv(sys.executable, [sys.executable, *flags, str(script), *sys.argv[1:]])
    return f"task {st['slug']} moves from {pinned or 'unknown'} to {own}"


def pinned_idle_tasks():
    """{version: count} of tasks pinned to a version whose supervisor is not alive; the archive is skipped."""
    counts = {}
    for path in sorted(config.TASKS.glob("*/state.json")):
        st = task_state.load(path.parent.name)
        version = task_version(st)
        if version and not procs.alive(st.get("pid")):
            counts[version] = counts.get(version, 0) + 1
    return counts


def idle_label(count):
    return f"{count} idle task{'' if count == 1 else 's'} pinned"


def drain_blockers(supervisors, layout):
    return [slug for slug, version in supervisors if version_layout(version) != layout]


def drain_message(version, layout, blockers):
    return (f"version {version} has data layout {layout}; stop or finish "
            f"{', '.join(blockers)} first, which run another layout")


def cmd_upgrade(a):
    source = a.source or DEFAULT_SOURCE
    local = Path(source).expanduser().is_dir()
    # A preview from a local clone only reads; anything that fetches or installs runs one at a time.
    with upgrade_lock() if a.yes or not local else nullcontext():
        upgrade(a, source, a.ref or DEFAULT_REF)


def upgrade(a, source, ref):
    repo = source_repo(source)
    resolved = subprocess.run(config.GIT + ["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
                              cwd=str(repo), capture_output=True, text=True)
    if resolved.returncode != 0:
        procs.die(f"upgrade: revision {ref!r} was not found in {repo}")
    commit = resolved.stdout.strip()
    version, layout = release_info(repo, commit)
    before = current_version()
    changes_layout = layout != version_layout(before)
    supervisors = live_supervisors()
    blockers = drain_blockers(supervisors, layout)
    print(f"source: {source} {ref} ({commit[:12]})")
    print(f"current: {before or 'none'} -> {version}  (data layout {version_layout(before)} -> {layout})")
    print(f"install: {versions_dir() / version}" + ("  (present)" if (versions_dir() / version).exists() else ""))
    print(f"launchers: {', '.join(str(bin_dir() / name) for name in LAUNCHERS)} with {python()}")
    print("\n".join(supervisor_lines(supervisors)))
    if blockers:
        if a.yes:
            procs.die("upgrade: " + drain_message(version, layout, blockers))
        print(drain_message(version, layout, blockers))
    if not a.yes:
        print(f"nothing changed; run {config.COMMAND} upgrade --yes to install")
        return
    # A data layout change keeps supervisors from starting until current points at the new layout.
    with versions_lock() if changes_layout else nullcontext():
        if changes_layout:
            blockers = drain_blockers(live_supervisors(), layout)
            if blockers:
                procs.die("upgrade: " + drain_message(version, layout, blockers))
        installed = install(repo, commit, version)
        written = write_launchers()
        switched = switch_current(version)
    print(f"installed {version}" if installed else f"{version} is already installed with the same contents")
    if written:
        print("wrote launchers: " + ", ".join(written))
    print(f"current is now {version}" if switched else f"current already was {version}")
    if str(bin_dir()) not in os.environ.get("PATH", "").split(os.pathsep):
        print(f"add {bin_dir()} to PATH to run the launchers")


def trash_target(name):
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = versions_dir() / ".trash" / f"{name}-{stamp}"
    counter = 1
    while target.exists():
        counter += 1
        target = versions_dir() / ".trash" / f"{name}-{stamp}-{counter}"
    return target


def cmd_versions(a):
    names = installed_versions()
    if not names:
        print(f"no versions installed in {versions_dir()}; run {config.COMMAND} upgrade")
        return
    current = current_version()
    supervisors = live_supervisors()
    users = {name: [slug for slug, version in supervisors if version == name] for name in names}
    idle = pinned_idle_tasks()
    for name in names:
        print(("* " if name == current else "  ") + name + "\t"
              + (", ".join(users[name]) if users[name] else "no live supervisors")
              + "\t" + idle_label(idle.get(name, 0)))
    outside = [slug for slug, version in supervisors if version is None]
    if outside:
        print(f"outside {versions_dir()}: {', '.join(outside)}")
    if not a.prune:
        return
    with upgrade_lock(), versions_lock():
        supervisors = live_supervisors()
        current = current_version()
        busy = {version for _, version in supervisors}
        idle = pinned_idle_tasks()
        moved = 0
        for name in installed_versions():
            if name == current or name in busy:
                continue
            target = trash_target(name)
            target.parent.mkdir(mode=0o700, exist_ok=True)
            os.replace(versions_dir() / name, target)
            pinned = idle.get(name, 0)
            print(f"moved {name} to {target}"
                  + (f"; {idle_label(pinned)} to it will move to {current} at the next say" if pinned else ""))
            moved += 1
    if not moved:
        print("nothing to prune")
