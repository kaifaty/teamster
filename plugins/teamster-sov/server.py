# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp==1.30.0"]
# ///
"""Read one Teamster repository through Board's loopback External Duty API."""

import argparse
import http.client
import json
import re
import stat
from pathlib import Path
from typing import Any
from urllib.parse import quote

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from mcp.types import ToolAnnotations


API = "/api/external-duty/v1/tasks"
TOKEN = re.compile(r"[A-Za-z0-9._~-]{32,256}")
TASK_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}")
PR_URL = re.compile(r"https://github\.com/[\w.-]+/[\w.-]+/pull/[1-9][0-9]*", re.ASCII)
PRIVATE_TEXT = re.compile(
    r"""(?ix)\b(?:authorization|(?:[\w-]*[-_])?(?:token|secret|password)|api[-_ ]?key)\s*["']?\s*[:=]
    | \bbearer\s+\S+ | -----BEGIN\ [^-]+PRIVATE\ KEY-----
    | \b(?:sk-[\w-]{16,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[\w]+|xox[baprs]-[\w-]+)
    | \beyJ[\w-]+\.eyJ[\w-]+\.[\w-]+"""
)
LOCATIONS = re.compile(
    r"""(?i)(["'`])(?:~?/|[A-Z]:[\\/]|\\\\).*?\1
    | \b[a-z][a-z0-9+.-]*://[^\s<>"'`]+
    | (?<![\w./-])(?:-[A-Z])?(?:~?/|[A-Z]:[\\/]|\\\\)[^\s<>"'`\[\]()]+""",
    re.VERBOSE,
)
CARD_VALUES = {
    "status": {"running", "stopping", "needs_decision", "blocked", "succeeded", "partial",
               "failed", "stopped", "idle"},
    "phase": {"idle", "sleeping", "check", "ci", "review", "fix", "turn"},
    "outcome": {"completed", "failed", "stopped", "interrupted", "budget_exhausted", "conflict",
                "stuck", "refused", "unavailable", "exhausted", "running", "sleeping", "timeout"},
    "result_status": {"done", "partial", "blocked", "needs_decision", "failed"},
}
CHECK_OUTCOMES = {"passed", "failed", "not_run", "timeout", "pending", "unavailable", "skipped",
                  "none", "stopped", "interrupted"}
NOT_FOUND = "Teamster task not found."


def load_config(path: Path) -> tuple[str, str]:
    mode = path.stat().st_mode
    if not stat.S_ISREG(mode) or mode & 0o077:
        raise ValueError("External Duty config must be a private file.")
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config, dict):
        raise ValueError("Invalid External Duty config.")
    token, repos = config.get("token"), config.get("repositories")
    if not isinstance(token, str) or not TOKEN.fullmatch(token):
        raise ValueError("Invalid External Duty token.")
    if (not isinstance(repos, list) or len(repos) != 1 or not isinstance(repos[0], str)
            or not Path(repos[0]).name or not Path(repos[0]).is_absolute()
            or str(Path(repos[0]).resolve()) != repos[0]):
        raise ValueError("External Duty config must allow exactly one canonical repository.")
    return token, repos[0]


def read_board(port: int, token: str, route: str) -> dict:
    # Direct loopback connection. HTTPConnection does not follow redirects or use proxy settings.
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request("GET", route, headers={"Authorization": f"Bearer {token}"})
        with connection.getresponse() as response:
            if response.status == 404 and route != API:
                raise ToolError(NOT_FOUND)
            if response.status == 403:
                raise ToolError("Board denied access to External Duty.")
            if response.status != 200:
                raise ToolError(f"External Duty read failed (HTTP {response.status}).")
            data = json.load(response)
    except (OSError, http.client.HTTPException):
        raise ToolError("Board is unreachable or did not complete the read.") from None
    except ValueError:
        raise ToolError("Board returned an invalid External Duty response.") from None
    finally:
        connection.close()
    if not isinstance(data, dict):
        raise ToolError("Board returned an invalid External Duty response.")
    return data


def compact_text(value: object, token: str) -> str | None:
    if not isinstance(value, str):
        return None
    line = next((line.strip() for line in value.splitlines() if line.strip()), "")
    if PRIVATE_TEXT.search(line):
        return None
    line = LOCATIONS.sub("[location omitted]", line.replace(token, "[credential omitted]"))
    line = line.encode("utf-8", errors="replace").decode("utf-8")
    line = " ".join(line.split())
    return (line[:397] + "..." if len(line) > 400 else line) or None


def check_result(value: object, *numbers: str) -> dict:
    if not isinstance(value, dict):
        return {}
    outcome = value.get("outcome")
    if not isinstance(outcome, str) or outcome not in CHECK_OUTCOMES:
        return {}
    return {"outcome": outcome, **{
        key: value[key] for key in numbers if type(value.get(key)) is int
    }}


def compact_checks(value: object) -> dict:
    if not isinstance(value, dict):
        return {}
    checks = {
        "saved": check_result(value.get("saved"), "exit"),
        "ci": check_result(value.get("ci"), "passed", "failed", "total"),
    }
    reported = value.get("reported")
    if isinstance(reported, list):
        checks["reported"] = [row for item in reported[:10] if (row := check_result(item))]
    return {key: data for key, data in checks.items() if data}


def compact_card(card: object, repository: str, token: str) -> dict | None:
    if not isinstance(card, dict) or card.get("repository") != repository:
        return None
    task_id = card.get("id")
    if (not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id)
            or token in task_id or PRIVATE_TEXT.search(task_id.partition(":")[0])):
        return None
    result = {"id": task_id, "repository": Path(repository).name}
    for key, allowed in CARD_VALUES.items():
        value = card.get(key)
        if isinstance(value, str) and value in allowed:
            result[key] = value
    if type(card.get("turn")) is int:
        result["turn"] = card["turn"]
    progress = compact_text(card.get("summary"), token)
    if not progress and result.get("status") in ("running", "stopping", "idle"):
        progress = compact_text(card.get("goal"), token)
    if progress:
        result["progress"] = progress
    question = compact_text(card.get("question"), token)
    blocker = compact_text(card.get("blocker"), token)
    if question:
        result["question"] = question
    elif blocker:
        result["blocker"] = blocker
    checks = compact_checks(card.get("checks"))
    if checks:
        result["checks"] = checks
    pr = card.get("pr")
    if isinstance(pr, str) and PR_URL.fullmatch(pr) and token not in pr and not PRIVATE_TEXT.search(pr):
        result["pr"] = pr
    return result


def create_server(token: str, repository: str, port: int) -> FastMCP:
    server = FastMCP("Teamster", log_level="WARNING")
    read_only = ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False)

    @server.tool(annotations=read_only)
    def list_tasks() -> dict[str, Any]:
        """Read compact Teamster task cards for the pilot repository from Board."""
        tasks = read_board(port, token, API).get("tasks")
        if not isinstance(tasks, list):
            raise ToolError("Board returned an invalid Teamster task list.")
        return {"tasks": [card for task in tasks if (card := compact_card(task, repository, token))]}

    @server.tool(annotations=read_only)
    def get_task(task_id: str) -> dict[str, Any]:
        """Read one Teamster task card by the exact ID returned by list_tasks."""
        if not TASK_ID.fullmatch(task_id):
            raise ToolError("Pass a Teamster task ID from list_tasks.")
        task = read_board(port, token, f"{API}/{quote(task_id, safe='')}").get("task")
        card = compact_card(task, repository, token)
        if card is None or card["id"] != task_id:
            raise ToolError(NOT_FOUND)
        return {"task": card}

    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("config", type=Path, help="private Board External Duty JSON config")
    parser.add_argument("--board-port", type=int, default=8787, help="loopback Board port")
    args = parser.parse_args()
    if not 1 <= args.board_port <= 65535:
        parser.error("Board port must be between 1 and 65535.")
    try:
        token, repository = load_config(args.config.expanduser())
    except (OSError, ValueError, RuntimeError):
        parser.exit(1, "Could not load private External Duty config with one allowed repository.\n")
    create_server(token, repository, args.board_port).run(transport="stdio")


if __name__ == "__main__":
    main()
