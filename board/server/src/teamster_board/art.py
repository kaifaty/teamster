"""A repository's own map art, kept in the data home so that it stays out of the public repository."""

from urllib.parse import quote

from .store import Store

# The only files served, each with its fixed type; the listing names them by the part before the dot.
MEDIA_TYPES = {"sky.jpg": "image/jpeg", "planet.png": "image/png", "emblem.png": "image/png"}


def art_file(root, repo, name):
    """The path of one picture, or None. Only known names, and no symbolic link on the way."""
    if name not in MEDIA_TYPES or root.is_symlink() or not Store._safe_slug(repo):
        return None
    return Store._file(root / repo, name)


def art_index(root):
    """{repo: {"sky": url, …}} for the pictures that exist. The mtime in the url shows a replaced file."""
    if root.is_symlink() or not root.is_dir():
        return {}
    index = {}
    for repo in sorted(path.name for path in root.iterdir()):
        pictures = {}
        for name in MEDIA_TYPES:
            path = art_file(root, repo, name)
            try:
                version = path.stat().st_mtime_ns if path else None
            except OSError:
                continue
            if version is not None:
                pictures[name.partition(".")[0]] = f"/api/art/{quote(repo, safe='')}/{name}?v={version}"
        if pictures:
            index[repo] = pictures
    return index
