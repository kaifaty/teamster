"""Recoverable archive for operator-owned, completed worktrees."""

import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import tarfile
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path

from . import clock, config, procs, task_state, telemetry_log


def _git(path, *args):
    result = subprocess.run([*config.GIT, "-C", str(path), *args], capture_output=True, timeout=120)
    if result.returncode:
        raise ValueError(f"Git {args[0]} failed: {os.fsdecode(result.stderr).strip()}")
    return result.stdout


def _write(path, value):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            json.dump(value, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
            temporary.replace(path)
            _sync_dir(path.parent)
        finally:
            temporary.unlink(missing_ok=True)


def _sync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _hash(stream):
    digest = hashlib.sha256()
    for block in iter(lambda: stream.read(1024 * 1024), b""):
        digest.update(block)
    return digest.hexdigest()


def _manifest(path):
    tracked = {Path(os.fsdecode(raw)) for raw in _git(path, "ls-files", "-z", "--cached").split(b"\0") if raw}
    manifest = {}

    def add(relative):
        if relative in tracked:
            return False
        member = path / relative
        if (relative.is_absolute() or ".." in relative.parts or relative.parts[0] == ".git"
                or any(parent.is_symlink() for parent in member.parents if parent != path and path in parent.parents)):
            raise ValueError("Unsafe artifact path")
        key = relative.as_posix()
        info = member.lstat()
        if stat.S_ISLNK(info.st_mode):
            manifest[key] = ["link", os.readlink(member)]
        elif stat.S_ISREG(info.st_mode):
            fd = os.open(member, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "rb") as stream:
                manifest[key] = ["file", info.st_size, _hash(stream)]
        elif stat.S_ISDIR(info.st_mode):
            children = sorted(member.iterdir())
            local = [add(relative / child.name) for child in children]
            if children and not any(local):
                return False
            manifest[key] = ["directory"]
        else:
            raise ValueError(f"Unsupported worktree artifact: {relative}")
        return True

    for child in sorted(path.iterdir()):
        if child.name != ".git":
            add(Path(child.name))
    return manifest


def _verify_bundle(bundle, manifest):
    with tarfile.open(bundle, "r:gz") as archive:
        actual = {}
        for entry in archive:
            if entry.name in actual:
                raise ValueError("Duplicate archive member")
            if entry.issym():
                actual[entry.name] = ["link", entry.linkname]
            elif entry.isfile():
                with archive.extractfile(entry) as stream:
                    actual[entry.name] = ["file", entry.size, _hash(stream)]
            elif entry.isdir():
                actual[entry.name] = ["directory"]
            else:
                raise ValueError("Unsupported archive member")
        if actual != manifest:
            raise ValueError("Worktree artifact archive did not verify")


def _bundle(path, bundle, manifest):
    with tempfile.NamedTemporaryFile(dir=bundle.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            with tarfile.open(fileobj=stream, mode="w:gz", dereference=False) as archive:
                for name in manifest:
                    # Store the bytes of each file even if artifacts share an inode.
                    archive.inodes.clear()
                    archive.add(path / name, arcname=name, recursive=False)
            stream.flush()
            os.fsync(stream.fileno())
            _verify_bundle(temporary, manifest)
            temporary.replace(bundle)
            _sync_dir(bundle.parent)
        finally:
            temporary.unlink(missing_ok=True)


def _check_tree(repo, path, branch, head):
    common = os.fsdecode(_git(path, "rev-parse", "--path-format=absolute", "--git-common-dir")).strip()
    root = os.fsdecode(_git(path, "rev-parse", "--show-toplevel")).strip()
    if (Path(common).resolve() != (repo / ".git").resolve() or Path(root).resolve() != path
            or _git(path, "symbolic-ref", "HEAD").decode().strip() != f"refs/heads/{branch}"
            or _git(path, "rev-parse", "HEAD").decode().strip() != head):
        raise ValueError("Worktree identity or HEAD changed")
    if _git(path, "status", "--porcelain", "--untracked-files=no", "--ignore-submodules=none"):
        raise ValueError("Worktree has changes to tracked files")


def _recover_complete(path, receipt, target):
    manifest = target / "operator-artifact-manifest.json"
    if (receipt["phase"] not in ("verified", "archived") or target.is_symlink()
            or manifest.is_symlink() or not manifest.is_file()):
        raise ValueError("Archive outcome is unknown")
    if receipt["phase"] == "verified":
        _verify_bundle(target / "operator-artifacts.tar.gz", json.loads(manifest.read_text()))
        receipt["phase"] = "archived"
        _write(path, receipt)
    return receipt


@contextmanager
def idle_chat(record):
    fd = os.open(record / "board-acp.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("Board task chat is still open") from exc
        yield
    finally:
        os.close(fd)


def _archive(args, receipt_file, receipt):
    slug, head = args.slug, args.expect_head
    record = config.TASKS / slug
    if config.TASKS.is_symlink() or record.is_symlink():
        raise ValueError("Task record path is a symbolic link")
    if receipt:
        target = Path(receipt["archive"])
        if (target.parent != config.TASKS / ".archive" or target.is_symlink()
                or not re.fullmatch(re.escape(slug) + r"-[0-9]{8}T[0-9]{6}Z", target.name)):
            raise ValueError("The saved archive path is invalid")
    if receipt and not record.exists():
        return _recover_complete(receipt_file, receipt, Path(receipt["archive"]))
    with task_state.state_lock(slug), idle_chat(record):
        st = task_state.load(slug)
        if st.get("created") != args.expect_created:
            if receipt and Path(receipt["archive"]).is_dir():
                return _recover_complete(receipt_file, receipt, Path(receipt["archive"]))
            raise ValueError("Run identity changed")
        if (st.get("turns") != args.expect_turn or st.get("kind") not in ("work", "review")
                or not st.get("turn_finished") or st.get("pending")
                or procs.alive(st.get("pid")) or task_state.session_process(st, terminals=True)[1] is not None
                or task_state.read_queue(slug)["waiting"]):
            raise ValueError("Run is active, has pending work, or cannot be archived")
        verdict = telemetry_log.current_run_verdict(st)
        if not verdict or verdict["verdict"] != args.expect_verdict:
            raise ValueError("Expected verdict is no longer current")
        repo, worktree = Path(st["repo"]), Path(st["worktree"])
        relative = Path(f"claude-{slug}") / repo.name
        managed = config.WORKTREES.resolve() / relative
        if (worktree != config.WORKTREES / relative or worktree.resolve() != managed
                or repo.resolve() != repo or repo.is_symlink() or not (repo / ".git").is_dir()):
            raise ValueError("Worktree is outside the managed repository")
        worktree = managed
        branch = st["branch"]
        if not branch.startswith("codex/") or _git(repo, "rev-parse", "--verify", f"refs/heads/{branch}").decode().strip() != head:
            raise ValueError("Expected commit is not on the retained branch")
        staging = worktree.with_name(f".operator-{args.operation_id}")
        if staging.is_symlink():
            raise ValueError("Archive staging path is a symbolic link")
        if not receipt:
            if staging.exists():
                raise ValueError("Archive staging path already exists")
            stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(clock.CLOCK.time()))
            target = config.TASKS / ".archive" / f"{slug}-{stamp}"
            if target.exists() or target.is_symlink():
                raise ValueError("Task archive already exists")
            _check_tree(repo, worktree, branch, head)
            receipt = {"slug": slug, "created": args.expect_created, "sha": head, "branch": branch,
                       "operation_id": args.operation_id, "turn": args.expect_turn, "verdict": args.expect_verdict,
                       "archive": str(target), "phase": "started"}
            _write(receipt_file, receipt)
        target = Path(receipt["archive"])
        if target.exists() or target.is_symlink():
            raise ValueError("Task archive already exists")
        bundle = record / "operator-artifacts.tar.gz"
        manifest_file = record / "operator-artifact-manifest.json"
        if worktree.exists():
            if staging.exists():
                raise ValueError("Original and staged worktrees both exist")
            _check_tree(repo, worktree, branch, head)
            _git(repo, "worktree", "move", "--", str(worktree), str(staging))
        if staging.exists():
            # Stage first so the original checkout cannot receive new task writes during verification.
            try:
                _check_tree(repo, staging, branch, head)
                manifest = _manifest(staging)
                _bundle(staging, bundle, manifest)
                if _manifest(staging) != manifest:
                    raise ValueError("Worktree artifacts changed while archiving")
                _check_tree(repo, staging, branch, head)
                _write(manifest_file, manifest)
                receipt.update(phase="verified", files=sum(entry[0] != "directory" for entry in manifest.values()))
                _write(receipt_file, receipt)
                _git(repo, "worktree", "remove", "--force", "--", str(staging))
            except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError):
                if staging.exists() and not worktree.exists():
                    _git(repo, "worktree", "move", "--", str(staging), str(worktree))
                raise
        elif receipt["phase"] != "verified":
            raise ValueError("Worktree disappeared before the archive was verified")
        else:
            _verify_bundle(bundle, json.loads(manifest_file.read_text()))
        try:
            worktree.parent.rmdir()
        except OSError:
            pass
        record.rename(target)
        _sync_dir(target.parent)
        _sync_dir(record.parent)
        (target / "state.lock").unlink(missing_ok=True)
        (target / "board-acp.lock").unlink(missing_ok=True)
        return _recover_complete(receipt_file, receipt, target)


def clean(args):
    if (not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,40}", args.slug)
            or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", args.expect_head or "")
            or not re.fullmatch(r"[0-9a-f]{32}", args.operation_id or "")
            or args.expect_created is None or not (args.expect_turn or 0) > 0
            or args.expect_verdict not in telemetry_log.LEAD_VERDICTS):
        procs.die("safe archive requires an expected run identity, HEAD and operation ID")
    ledger = config.TASKS / ".archive" / ".operator-receipts"
    try:
        if ledger.is_symlink() or ledger.parent.is_symlink():
            raise ValueError("Archive journal path is a symbolic link")
        ledger.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = ledger / (args.operation_id + ".json")
        if path.is_symlink():
            raise ValueError("Operation receipt is a symbolic link")
        receipt = json.loads(path.read_text()) if path.exists() else None
        if receipt and (receipt["slug"], receipt["created"], receipt["turn"], receipt["sha"], receipt["verdict"]) != (
                args.slug, args.expect_created, args.expect_turn, args.expect_head, args.expect_verdict):
            raise ValueError("Operation ID belongs to a different archive")
        result = _archive(args, path, receipt)
    except (OSError, ValueError, subprocess.SubprocessError, tarfile.TarError) as exc:
        procs.die(f"safe archive: {exc}")
    print(json.dumps(result, ensure_ascii=False))
