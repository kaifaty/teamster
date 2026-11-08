"""Constellations: groups of repositories the galaxy draws together, read from a file in the data home.

The file names private projects, so it stays outside the public repository and is written by hand:

    {"constellations": [{"name": "MyWallet", "repos": ["mytonwallet-*", "my-pulse"]}]}

A pattern is a repository's name, where `*` stands for any run of characters; the map matches them, and a repository
that two constellations claim belongs to the first.
"""

import json

MAX_BYTES = 64 * 1024
MAX_CONSTELLATIONS = 32
MAX_PATTERNS = 64
MAX_NAME = 60
MAX_PATTERN = 100


def _pattern(value):
    return isinstance(value, str) and 0 < len(value.strip()) <= MAX_PATTERN and "/" not in value and "\\" not in value


def _parse(data):
    """The constellations of a parsed file, or the reason it is not one."""
    if not isinstance(data, dict) or not isinstance(data.get("constellations"), list):
        return None, "expected an object with a list in \"constellations\""
    items = data["constellations"]
    if len(items) > MAX_CONSTELLATIONS:
        return None, f"at most {MAX_CONSTELLATIONS} constellations"
    result, names = [], set()
    for index, item in enumerate(items):
        name = item.get("name") if isinstance(item, dict) else None
        repos = item.get("repos") if isinstance(item, dict) else None
        if not isinstance(name, str) or not 0 < len(name.strip()) <= MAX_NAME:
            return None, f"constellation {index + 1}: \"name\" must be a text of 1 to {MAX_NAME} characters"
        if name.strip() in names:
            return None, f"constellation {index + 1}: the name {name.strip()!r} is taken"
        if not isinstance(repos, list) or not 0 < len(repos) <= MAX_PATTERNS or not all(map(_pattern, repos)):
            return None, (f"constellation {index + 1}: \"repos\" must list 1 to {MAX_PATTERNS} repository names or patterns"
                          f" of at most {MAX_PATTERN} characters, without slashes")
        names.add(name.strip())
        result.append({"name": name.strip(), "repos": list(dict.fromkeys(repo.strip() for repo in repos))})
    return result, None


def read_constellations(path):
    """{"constellations": [...], "error": text or None}: none without the file, none and the reason for a broken one."""
    try:
        if path.is_symlink():
            return {"constellations": [], "error": "the constellations file is a symbolic link"}
        if path.stat().st_size > MAX_BYTES:
            return {"constellations": [], "error": f"the constellations file is over {MAX_BYTES // 1024} KiB"}
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"constellations": [], "error": None}
    except (OSError, UnicodeDecodeError, ValueError):
        return {"constellations": [], "error": "cannot read the constellations file as JSON"}
    constellations, error = _parse(data)
    return {"constellations": constellations or [], "error": error}
