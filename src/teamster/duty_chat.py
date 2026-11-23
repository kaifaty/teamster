"""The duty chat: its account, room, system prompt, recorded turns and the task notes it waits for.

The conversation is one long-lived task, slug and kind ``duty``, on the current duty
account. Its turns resume through the say machinery; each valid answer appends an entry to
``duty_turns``, and messages.jsonl keeps the user's messages and the task notes. A note arrives
when a task the duty started ends a cycle; notes wait in notes.json while the hourly cap on
note-driven turns is reached and go out with the next user message.
"""
import json
import os
import re
import shutil
import tempfile
import uuid
from pathlib import Path

from . import claude_accounts, claude_runner, clock, config, duty, executors, procs, reflection


CHAT_SLUG = "duty"
CHAT_KIND = "duty"
# The window of duty.chat_auto_turns_per_hour.
AUTO_TURN_WINDOW_SECONDS = 3600
ROLE_FILE = "duty-role.md"
NO_DUTY = "no duty account (duty.json is absent or names no account); run duty tick, nothing was started"
PLAN_FIELDS = {"repo": 400, "title": 120, "goal": 600}
PLAN_REPLY_BYTES = 32 * 1024


def chat_dir():
    return config.TASKS / CHAT_SLUG


def chat_room():
    return chat_dir() / "room"


def prepare_chat_backend(family, effort=None):
    if family == "claude":
        claude_runner.validate_work_effort(effort)
        config.require_claude()
    else:
        config.codex_binary()


def chat_account(cfg):
    """(the duty account with its family, None), or (None, why the chat cannot run on the duty)."""
    record = duty.read_duty()
    if record is None or record.get("account") is None:
        return None, NO_DUTY
    family = record["family"]
    pool = claude_accounts.accounts(cfg) if family == "claude" else cfg["accounts"]
    account = next((item for item in pool if item["name"] == record["account"]), None)
    if account is None:
        setting = "claude.accounts" if family == "claude" else "accounts"
        return None, f"the duty account {record['account']} is not in {setting}; nothing was started"
    return dict(account, family=family), None


def clear_partial_chat():
    """Remove what a creation cut short before its state.json left, except the state lock; the caller holds it."""
    for path in chat_dir().iterdir():
        if path.name == "state.lock":
            continue
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        else:
            path.unlink()


def build_chat_room(room):
    """A fresh, empty git repository where the duty writes its briefs."""
    room.mkdir()
    reflection.commit_room(room, "Duty room")


def known_repositories():
    """(name, path) of every existing repository of a work task or scout, live or archived, sorted by name."""
    found = {}
    for root in (config.TASKS, config.TASKS / ".archive"):
        for path in sorted(root.glob("*/state.json")):
            try:
                st = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            repo = st.get("repo") if isinstance(st, dict) else None
            # A scout's directory counts when it is the top of a git work tree.
            if (isinstance(repo, str) and repo and st.get("kind") not in ("reflect", CHAT_KIND) and Path(repo).is_dir()
                    and (st.get("kind") != "scout" or (Path(repo) / ".git").exists())):
                found.setdefault(repo, Path(repo).name)
    return sorted(((name, repo) for repo, name in found.items()), key=lambda item: (item[0], item[1]))


def system_text(room):
    """The lead guide, the duty's role, the user's own duty rules, the known repositories and the room."""
    parts = [(config.PACKAGE / "docs" / "lead-guide.md").read_text(encoding="utf-8").strip(),
             (config.PACKAGE / ROLE_FILE).read_text(encoding="utf-8").strip()]
    rules = config.data_path("duty_rules")
    if rules.is_file():
        parts.append("## The user's standing rules\n\nThey win over the guides above.\n\n"
                     + rules.read_text(encoding="utf-8").strip())
    repositories = known_repositories()
    parts.append("## Known repositories\n\n" + ("\n".join(f"- {name}: {path}" for name, path in repositories)
                                                if repositories else
                                                "None yet: ask the user for the repository path."))
    parts.append(f"## Your room\n\n{room}\n\nWrite briefs only here and pass them to "
                 f"`{config.COMMAND} start <slug> --brief {room}/<slug>.md --repo <path>`.")
    return "\n\n".join(parts) + "\n"


def write_system_prompt(text, task_dir):
    """Save this turn's system prompt beside the task's state; the caller removes the file."""
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="duty-system-",
                                     suffix=".md", dir=task_dir, delete=False) as stream:
        stream.write(text)
        return Path(stream.name)


def plan_text(value, limit):
    if not isinstance(value, str) or "\0" in value or len(value) > limit:
        raise ValueError("invalid plan text")
    value.encode("utf-8")
    value = value.strip()
    if not value:
        raise ValueError("empty plan text")
    return value


def plan_criteria(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 3:
        raise ValueError("invalid completion criteria")
    return [plan_text(item, 200) for item in value]


def valid_plan_tasks(tasks):
    """Normalize a bounded task plan, or return an empty list for an absent or unusable plan."""
    if not isinstance(tasks, list) or not 1 <= len(tasks) <= 3:
        return []
    normalized = []
    for task in tasks:
        if not isinstance(task, dict) or task.keys() != PLAN_FIELDS.keys() | {"done_when"}:
            return []
        try:
            normalized.append({**{key: plan_text(task[key], limit) for key, limit in PLAN_FIELDS.items()},
                               "done_when": plan_criteria(task["done_when"])})
        except ValueError:
            return []
    return normalized


def answer_plan(result):
    if result["status"] != "needs_decision" or not result["question"].strip() or result["started"]:
        return []
    return valid_plan_tasks(result["task_plan"])


def record_chat_turn(st):
    """Append the valid answer of the turn that just completed to duty_turns."""
    result = st["result"]
    entry = {
        "at": clock.CLOCK.time(), "turn": st.get("turns", 0), "account": executors.from_state(st).account(st),
        "status": result["status"], "reply": result["reply"], "question": result["question"],
        "options": result["options"], "started": result["started"]}
    if result["task_plan"]:
        entry["task_plan"] = {"id": uuid.uuid4().hex, "tasks": result["task_plan"]}
    st.setdefault("duty_turns", []).append(entry)


def read_plan_reply(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(PLAN_REPLY_BYTES + 1)
    if len(raw) > PLAN_REPLY_BYTES:
        raise ValueError("plan reply is too large")
    value = json.loads(raw.decode("utf-8"))
    if not isinstance(value, dict) or set(value) != {"plan_id", "selected"}:
        raise ValueError("invalid plan reply")
    plan_id, selected = value["plan_id"], value["selected"]
    if not isinstance(plan_id, str) or not re.fullmatch(r"[a-f0-9]{32}", plan_id):
        raise ValueError("invalid plan ID")
    if not isinstance(selected, list) or not 1 <= len(selected) <= 3:
        raise ValueError("invalid plan selection")
    choices = {}
    for item in selected:
        if not isinstance(item, dict) or set(item) != {"index", "done_when"}:
            raise ValueError("invalid plan selection")
        index = item["index"]
        if type(index) is not int or not 0 <= index < 3 or index in choices:
            raise ValueError("invalid or duplicate plan index")
        choices[index] = plan_criteria(item["done_when"])
    return plan_id, choices


def plan_turn(state, plan_id):
    """Find a proposal in this conversation, including a prior proposal with a receipt."""
    return next((turn for turn in reversed(state.get("duty_turns", ()))
                 if (turn.get("task_plan") or {}).get("id") == plan_id), None)


def plan_reply_text(tasks, choices, language):
    """Render only the selected tasks, with their edited criteria, as one user message."""
    if not tasks or max(choices) >= len(tasks):
        raise ValueError("selection does not belong to the plan")
    if language == "ru":
        lines = ["Запусти только выбранные задачи из плана. Остальные отложи."]
        repository, goal, done = "Репозиторий", "Цель", "Критерии готовности"
    else:
        lines = ["Start only the selected tasks from the plan. Leave the other tasks aside."]
        repository, goal, done = "Repository", "Goal", "Done when"
    for index, criteria in sorted(choices.items()):
        task = tasks[index]
        lines.extend(("", task["title"], f"{repository}: {task['repo']}", f"{goal}: {task['goal']}", f"{done}:"))
        lines.extend(f"- {criterion}" for criterion in criteria)
    return "\n".join(lines)


def notes_path():
    return chat_dir() / "notes.json"


def held_notes():
    """The task notes waiting for the next user message or for room under the hourly cap; the caller holds the duty state lock."""
    path = notes_path()
    return json.loads(path.read_text(encoding="utf-8")).get("held", []) if path.exists() else []


def write_held_notes(notes):
    path = notes_path()
    temporary = path.with_suffix(f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"held": notes}, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def hold_notes(notes):
    """Keep notes for later, each once; the caller holds the duty state lock."""
    held = held_notes()
    added = [note for note in notes if note not in held]
    if added:
        write_held_notes(held + added)


def release_held_notes(sent):
    """Remove the held notes that a started and saved turn carries; the caller holds the duty state lock.

    Until then they stay held: a start that fails or a process that dies first loses none of them,
    at the cost of a note journaled twice.
    """
    held = held_notes()
    left = [note for note in held if note not in sent]
    if len(left) != len(held):
        write_held_notes(left)


def auto_turn_allowed(st, cfg, now):
    """Whether another note-driven turn fits under duty.chat_auto_turns_per_hour."""
    recent = [at for at in st.get("duty_auto_turns", []) if now - at < AUTO_TURN_WINDOW_SECONDS]
    return len(recent) < cfg["duty"]["chat_auto_turns_per_hour"]


def mark_auto_turn(st, now):
    st["duty_auto_turns"] = [at for at in st.get("duty_auto_turns", [])
                             if now - at < AUTO_TURN_WINDOW_SECONDS] + [now]


def note_order(st, report):
    """The queue order of a task note: the end of a cycle of a task the duty started, with its wait report."""
    text = (f"Task note: {st['slug']} ended turn {st.get('turns', 0)} with outcome {st.get('outcome')}. "
            "Report it to the user, or send it a follow-up.\n\n" + report.strip())
    return {"at": clock.CLOCK.time(), "text": text, "options": {}, "source": "note", "task": st["slug"]}


def cycle_orders(st, orders):
    """The orders the end of a duty cycle sends; the caller holds the duty state lock.

    Held notes join any user message; the caller releases them once that turn has started. Notes alone
    start a turn while the hourly cap and a duty account allow it; otherwise they wait in notes.json and
    the end sends nothing.
    """
    if not orders:
        return []
    cfg = config.accounts_config()
    now = clock.CLOCK.time()
    if any(order.get("source") != "note" for order in orders):
        return held_notes() + orders
    if auto_turn_allowed(st, cfg, now) and chat_account(cfg)[0] is not None:
        mark_auto_turn(st, now)
        return held_notes() + orders
    hold_notes(orders)
    return []


def drop_chat_orders(orders):
    """The user orders a failed or stopped duty cycle drops; its notes wait. The caller holds the duty state lock."""
    notes = [order for order in orders if order.get("source") == "note"]
    if notes:
        hold_notes(notes)
    return [order for order in orders if order.get("source") != "note"]


def require_chat_task(st):
    if st.get("kind") != CHAT_KIND:
        procs.die(f"task {CHAT_SLUG!r} exists and is not the duty chat; clean it first")
