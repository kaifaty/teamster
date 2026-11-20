"""OpenCode provider discovery and the Board's local model bindings."""

import fcntl
import json
import re
import subprocess
from pathlib import Path


PROVIDER = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")
MODEL = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]*")


def _read(*arguments):
    return subprocess.run(
        ["opencode", *arguments], cwd=Path.home(), stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, encoding="utf-8",
        timeout=15, check=True,
    ).stdout


def discover():
    """Only offer catalog models belonging to an authenticated integration."""
    try:
        integrations = json.loads(_read("auth", "list", "--format", "json"))
        if not isinstance(integrations, list):
            raise ValueError("Invalid integration list")
        providers = {}
        for item in integrations:
            provider, name, connections = item["id"], item["name"], item["connections"]
            if not isinstance(connections, list) or not isinstance(name, str):
                raise ValueError("Invalid integration")
            if connections and PROVIDER.fullmatch(provider):
                providers[provider] = {"id": provider, "name": name, "models": []}
        if providers:
            for model in _read("models").strip().splitlines():
                provider, slash, part = model.partition("/")
                if not slash or not part:
                    raise ValueError("Invalid model list")
                if provider in providers and MODEL.fullmatch(part):
                    providers[provider]["models"].append(model)
        return {"status": "ok", "providers": list(providers.values())}
    except FileNotFoundError:
        return {"status": "unavailable", "providers": []}
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        return {"status": "error", "providers": []}


def read_bindings(path):
    try:
        saved = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    if saved["version"] != 1:
        raise ValueError("Unknown OpenCode bindings version")
    return {row["provider"]: {key: row[key] for key in ("provider", "name", "model")}
            for row in saved["bindings"]}


def update_binding(path, provider, binding):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        rows = read_bindings(path)
        if binding is None:
            rows.pop(provider, None)
        else:
            rows[provider] = binding
        saved = {"version": 1, "bindings": list(rows.values())}
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(saved, ensure_ascii=False) + "\n", encoding="utf-8")
        temporary.replace(path)
        return rows
