"""Release an implemented lesson from a fresh main and update the installed tool."""

import re
import shutil
import subprocess
import tempfile
from pathlib import Path


COMMAND_TIMEOUT = 120
UPGRADE_TIMEOUT = 300
RELEASE = re.compile(r"Release ([0-9]+\.[0-9]+\.[0-9]+)")


def _run(argv, cwd, timeout=COMMAND_TIMEOUT, check=True):
    try:
        result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True,
                                encoding="utf-8", errors="replace", timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"{argv[0]} failed: {exc}") from exc
    if check and result.returncode:
        raise ValueError(f"{argv[0]} failed: {(result.stderr or result.stdout).strip()[-2000:]}")
    return result


def _git(repo, *args, check=True):
    return _run(["git", *args], repo, check=check)


def _published(repo, merge_sha, receipt, save):
    if _git(repo, "merge-base", "--is-ancestor", merge_sha, "origin/main", check=False).returncode:
        raise ValueError("The merged PR is not on origin/main")
    history = _git(repo, "log", "--ancestry-path", "--reverse", "--format=%H%x00%s",
                   f"{merge_sha}..origin/main").stdout
    for row in history.splitlines():
        commit, _, subject = row.partition("\0")
        match = RELEASE.fullmatch(subject)
        if match:
            version = match[1]
            receipt.update(release_merge=merge_sha, release_commit=commit,
                           release_version=version, released=True)
            save()
            return version
    return None


def _cleanup(repo, receipt, save):
    name = receipt.get("release_worktree")
    if name is None:
        return
    worktree = Path(name)
    if (not worktree.is_absolute() or worktree.name != "worktree"
            or not worktree.parent.name.startswith("teamster-release-")
            or worktree.is_symlink() or worktree.parent.is_symlink()):
        raise ValueError("Invalid release worktree path")
    registered = _git(repo, "worktree", "list", "--porcelain", "-z").stdout.split("\0")
    if any(row.startswith("worktree ") and Path(row[9:]).resolve() == worktree.resolve()
           for row in registered):
        _git(repo, "worktree", "remove", "--force", str(worktree))
    if worktree.parent.exists():
        shutil.rmtree(worktree.parent)
    receipt.pop("release_worktree")
    save()


def release(repo, merge_sha, files, receipt, save):
    """Publish at most one release after this merge, reconciling an interrupted push."""
    repo = Path(repo)
    _cleanup(repo, receipt, save)
    _git(repo, "fetch", "origin", "main")
    published = _published(repo, merge_sha, receipt, save)
    if published is not None:
        return published
    # Inspect the fresh base: the caller's checkout may predate the lesson's merge.
    if _git(repo, "cat-file", "-e", "origin/main:scripts/bump_version.py", check=False).returncode:
        return None
    level = "patch" if files and all(name.endswith(".md") for name in files) else "minor"
    for attempt in range(2):
        base = _git(repo, "rev-parse", "origin/main").stdout.strip()
        with tempfile.TemporaryDirectory(prefix="teamster-release-") as directory:
            worktree = Path(directory) / "worktree"
            receipt["release_worktree"] = str(worktree)
            save()
            try:
                _git(repo, "worktree", "add", "--detach", str(worktree), "origin/main")
                version = _run(["python3", "-I", "scripts/bump_version.py", level, "--commit"],
                               worktree).stdout.strip().splitlines()[-1]
                if not RELEASE.fullmatch("Release " + version):
                    raise ValueError("The version bump returned no version")
                commit = _git(worktree, "rev-parse", "HEAD").stdout.strip()
                receipt.update(release_merge=merge_sha, release_base=base,
                               release_commit=commit, release_version=version, released=False)
                save()
                pushed = _git(worktree, "push", "origin", "HEAD:main", check=False)
                if pushed.returncode == 0:
                    receipt["released"] = True
                    save()
                    return version
                _git(repo, "fetch", "origin", "main")
                published = _published(repo, merge_sha, receipt, save)
                if published is not None:
                    return published
                current = _git(repo, "rev-parse", "origin/main").stdout.strip()
                advanced = (current != base and _git(
                    repo, "merge-base", "--is-ancestor", base, current, check=False).returncode == 0)
                if attempt or not advanced:
                    raise ValueError("git push failed: " + (pushed.stderr or pushed.stdout).strip()[-2000:])
            finally:
                _cleanup(repo, receipt, save)
    raise ValueError("The release could not be pushed")


def upgrade():
    command = shutil.which("uv")
    if command is None:
        candidate = Path.home() / ".local/bin/uv"
        if not candidate.is_file():
            raise ValueError("uv was not found on PATH or in ~/.local/bin")
        command = str(candidate)
    _run([command, "tool", "upgrade", "teamster"], Path.home(), timeout=UPGRADE_TIMEOUT)
