#!/usr/bin/env python3
"""Raise the package and plugin versions together, optionally committing them.

When the STATE_FIELDS names differ from the release being replaced, the script first
writes tests/fixtures/state-<that release>/ with that release's own
tests/make_state_fixtures.py, in a temporary worktree of its release commit.
"""
import argparse
import ast
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]
FILES = ("src/teamster/__init__.py", "plugins/teamster/.claude-plugin/plugin.json")
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
STATE_MODULE = "src/teamster/task_state.py"
FIXTURE_SCRIPT = "tests/make_state_fixtures.py"
FIXTURE_TIMEOUT = 1800


def git(*args):
    result = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or "git command failed")
    return result.stdout


def state_fields(source):
    """Names of the STATE_FIELDS literal in task_state.py source."""
    for node in ast.parse(source).body:
        if (isinstance(node, ast.Assign) and isinstance(node.value, ast.Dict)
                and any(isinstance(target, ast.Name) and target.id == "STATE_FIELDS" for target in node.targets)):
            return {key.value for key in node.value.keys if isinstance(key, ast.Constant)}
    raise ValueError("no STATE_FIELDS literal in " + STATE_MODULE)


def release_commit(version):
    """The commit that set __version__ to the current version."""
    rev = git("log", "-n", "1", "--format=%H", "-G", r"^__version__", "--", FILES[0]).strip()
    if not rev or not re.search(r'(?m)^__version__[ \t]*=[ \t]*[\'"]%s[\'"]' % re.escape(version),
                                git("show", rev + ":" + FILES[0])):
        raise ValueError("cannot find the release commit of " + version)
    return rev


def write_state_fixtures(version):
    """Write tests/fixtures/state-<version>/ on that release when HEAD changes its state fields.

    Returns the fixture directory relative to ROOT, or None when no fixture is needed.
    """
    target = "tests/fixtures/state-" + version
    if (ROOT / target).exists() or git("ls-files", "--", STATE_MODULE).strip() != STATE_MODULE:
        return None
    rev = release_commit(version)
    if git("ls-tree", "--name-only", rev, "--", STATE_MODULE).strip() != STATE_MODULE:
        return None
    if state_fields(git("show", rev + ":" + STATE_MODULE)) == state_fields(git("show", "HEAD:" + STATE_MODULE)):
        return None
    if git("ls-tree", "--name-only", rev, "--", FIXTURE_SCRIPT).strip() != FIXTURE_SCRIPT:
        raise ValueError("state fields changed, but %s has no %s; add %s by hand"
                         % (version, FIXTURE_SCRIPT, target))
    with tempfile.TemporaryDirectory(prefix="teamster-release-") as temporary:
        checkout = Path(temporary) / version
        git("worktree", "add", "--detach", str(checkout), rev)
        try:
            result = subprocess.run([sys.executable, "-I", FIXTURE_SCRIPT, str(ROOT / target)], cwd=checkout,
                                    text=True, capture_output=True, timeout=FIXTURE_TIMEOUT)
        except subprocess.TimeoutExpired:
            result = None
        finally:
            git("worktree", "remove", "--force", str(checkout))
    if result is None or result.returncode:
        shutil.rmtree(ROOT / target, ignore_errors=True)
        output = "timed out" if result is None else (result.stdout + result.stderr).strip()[-2000:]
        raise ValueError("%s failed on %s:\n%s" % (FIXTURE_SCRIPT, version, output))
    return target


def bump(requested, commit=False):
    contents = [(ROOT / name).read_bytes() for name in FILES]
    patterns = (rb'(?m)^__version__[ \t]*=[ \t]*[\'"](' + VERSION.encode() + rb')[\'"]',
                rb'"version"\s*:\s*"(' + VERSION.encode() + rb')"')
    matches = []
    for name, content, pattern in zip(FILES, contents, patterns):
        found = list(re.finditer(pattern, content))
        if len(found) != 1:
            raise ValueError("expected one X.Y.Z version in " + name)
        matches.append(found[0])
    current = matches[0][1].decode("ascii")
    plugin_version = json.loads(contents[1])["version"]
    if plugin_version != current or matches[1][1].decode("ascii") != current:
        raise ValueError("package and plugin versions differ")

    parts = tuple(map(int, current.split(".")))
    if requested in ("major", "minor", "patch"):
        position = ("major", "minor", "patch").index(requested)
        new_parts = parts[:position] + (parts[position] + 1,) + (0,) * (2 - position)
    else:
        if not re.fullmatch(VERSION, requested):
            raise ValueError("version must be major, minor, patch or X.Y.Z")
        new_parts = tuple(map(int, requested.split(".")))
        if new_parts <= parts:
            raise ValueError("new version must be greater than " + current)
    version = ".".join(map(str, new_parts))
    if git("status", "--porcelain", "--untracked-files=all", "--", *FILES):
        raise ValueError("version files must be clean in the working tree and index")
    fixtures = write_state_fixtures(current)

    for name, content, match in zip(FILES, contents, matches):
        start, end = match.span(1)
        (ROOT / name).write_bytes(content[:start] + version.encode("ascii") + content[end:])
    if commit:
        paths = FILES + ((fixtures,) if fixtures else ())
        if fixtures:
            git("add", "--", fixtures)
        git("commit", "--only", "-m", "Release " + version, "--", *paths)
    return version, fixtures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="major, minor, patch or an explicit X.Y.Z")
    parser.add_argument("--commit", action="store_true", help="commit only the two version files")
    args = parser.parse_args()
    try:
        version, fixtures = bump(args.version, args.commit)
    except (OSError, ValueError, KeyError, SyntaxError) as error:
        parser.exit(1, "error: %s\n" % error)
    print(version)
    if fixtures:
        print("state fixtures: " + fixtures)


if __name__ == "__main__":
    main()
