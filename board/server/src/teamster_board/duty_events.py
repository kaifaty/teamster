"""The resumable external-duty feed over Teamster's local work-cycle journal."""

import json
import os
import stat

from .duty_tasks import check_results, task_id, task_status
from .store import integer, mapping, number, text


def project(row, allowed_repos):
    row = mapping(row)
    repository = text(row.get("repository"))
    event_type = row.get("type")
    if (row.get("v") != 1 or repository not in allowed_repos
            or event_type not in ("needs_decision", "task_finished")):
        return None
    identity = task_id(row.get("slug"), row.get("created"))
    event_id = text(row.get("id"))
    at = number(row.get("at"))
    if identity is None or event_id is None or at is None:
        return None
    result = mapping(row.get("result"))
    question = text(row.get("question"))
    if event_type == "needs_decision" and not question:
        return None
    status = task_status({**row, "result": {**result, "questions": [question] if question else []}}, False)
    item = {
        "id": event_id, "type": event_type, "task_id": identity, "repository": repository,
        "turn": integer(row.get("turn")), "at": at, "status": status, "outcome": text(row.get("outcome")),
        "result_status": text(result.get("status")), "summary": text(result.get("summary")),
        "checks": check_results(row), "pr": text(row.get("pr")),
    }
    if event_type == "needs_decision":
        item["question"] = question
    return item


def events(path, allowed_repos, after=0, limit=100):
    """Replay complete rows in append order, advancing across hidden rows too."""
    if after < 0 or not 1 <= limit <= 100:
        raise ValueError("Invalid event cursor or page size")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if after:
            raise ValueError("Event cursor is no longer available") from None
        return {"events": [], "next_cursor": 0}
    items, offset = [], after
    with os.fdopen(descriptor, "rb") as stream:
        metadata = os.fstat(stream.fileno())
        if not stat.S_ISREG(metadata.st_mode):
            raise OSError("Event journal is not a regular file")
        if after > metadata.st_size:
            raise ValueError("Event cursor is no longer available")
        if after:
            stream.seek(after - 1)
            if stream.read(1) != b"\n":
                raise ValueError("Invalid event cursor")
        while offset < metadata.st_size and len(items) < limit:
            raw = stream.readline()
            if not raw.endswith(b"\n") or stream.tell() > metadata.st_size:
                # An append may be in flight. Leave the incomplete row for the next read.
                break
            offset = stream.tell()
            try:
                row = json.loads(raw)
            except (ValueError, RecursionError):
                continue
            item = project(row, allowed_repos)
            if item is not None:
                items.append(item)
    return {"events": items, "next_cursor": offset}
