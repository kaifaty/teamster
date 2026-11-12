#!/usr/bin/env python3
"""Raise the package and plugin versions together, optionally committing them."""
import argparse
import json
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
FILES = ("src/teamster/__init__.py", "plugins/teamster/.claude-plugin/plugin.json")
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"


def git(*args):
    result = subprocess.run(["git", *args], cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or result.stdout.strip() or "git command failed")
    return result.stdout


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

    for name, content, match in zip(FILES, contents, matches):
        start, end = match.span(1)
        (ROOT / name).write_bytes(content[:start] + version.encode("ascii") + content[end:])
    if commit:
        git("commit", "--only", "-m", "Release " + version, "--", *FILES)
    return version


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", help="major, minor, patch or an explicit X.Y.Z")
    parser.add_argument("--commit", action="store_true", help="commit only the two version files")
    args = parser.parse_args()
    try:
        version = bump(args.version, args.commit)
    except (OSError, ValueError, KeyError) as error:
        parser.exit(1, "error: %s\n" % error)
    print(version)


if __name__ == "__main__":
    main()
