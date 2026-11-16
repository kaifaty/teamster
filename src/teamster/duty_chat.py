"""The duty chat: its account, room, system prompt, recorded turns and the task notes it waits for.

The conversation is one long-lived task, slug and kind ``duty``, on the current Claude duty
account. Its turns resume through the say machinery; each valid answer appends an entry to
``duty_turns``, and messages.jsonl keeps the user's messages and the task notes. A note arrives
when a task the duty started ends a cycle; notes wait in notes.json while the hourly cap on
note-driven turns is reached and go out with the next user message.
"""
import json
import os
import shutil
import tempfile
from pathlib import Path

from . import claude_accounts, clock, config, duty, procs, reflection


CHAT_SLUG = "duty"
CHAT_KIND = "duty"
# The window of duty.chat_auto_turns_per_hour.
AUTO_TURN_WINDOW_SECONDS = 3600
ROLE_FILE = "duty-role.md"
NO_DUTY = "no duty account (duty.json is absent or names no account); run duty tick, nothing was started"


def chat_dir():
    return config.TASKS / CHAT_SLUG


def chat_room():
    return chat_dir() / "room"


def chat_account(cfg):
    """(the Claude duty account, None), or (None, why the chat cannot run on the duty)."""
    record = duty.read_duty()
    if record is None or record.get("account") is None:
        return None, NO_DUTY
    if record["family"] != "claude":
        return None, (f"the duty chat needs a Claude duty account; the duty is {duty.duty_label(record)}, "
                      "nothing was started")
    account = next((item for item in claude_accounts.accounts(cfg) if item["name"] == record["account"]), None)
    if account is None:
        return None, f"the duty account {record['account']} is not in claude.accounts; nothing was started"
    return account, None


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
    """(name, path) of every existing repository of a work task, live or archived, sorted by name."""
    found = {}
    for root in (config.TASKS, config.TASKS / ".archive"):
        for path in sorted(root.glob("*/state.json")):
            try:
                st = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            repo = st.get("repo") if isinstance(st, dict) else None
            if (isinstance(repo, str) and repo and st.get("kind") not in ("scout", "reflect", CHAT_KIND)
                    and Path(repo).is_dir()):
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


def write_system_prompt(room, task_dir):
    """Save this turn's system prompt beside the task's state; the caller removes the file."""
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="duty-system-",
                                     suffix=".md", dir=task_dir, delete=False) as stream:
        stream.write(system_text(room))
        return Path(stream.name)


def record_chat_turn(st):
    """Append the valid answer of the turn that just completed to duty_turns."""
    result = st["result"]
    st.setdefault("duty_turns", []).append({
        "at": clock.CLOCK.time(), "turn": st.get("turns", 0), "account": st.get("claude_account"),
        "status": result["status"], "reply": result["reply"], "question": result["question"],
        "options": result["options"], "started": result["started"]})


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
    """Keep notes for later; the caller holds the duty state lock."""
    write_held_notes(held_notes() + list(notes))


def take_held_notes():
    """Return the held notes and empty the store; the caller holds the duty state lock."""
    notes = held_notes()
    if notes:
        write_held_notes([])
    return notes


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

    Held notes join any user message. Notes alone start a turn while the hourly cap and a Claude
    duty allow it; otherwise they wait in notes.json and the end sends nothing.
    """
    if not orders:
        return []
    cfg = config.accounts_config()
    now = clock.CLOCK.time()
    if any(order.get("source") != "note" for order in orders):
        return take_held_notes() + orders
    if auto_turn_allowed(st, cfg, now) and chat_account(cfg)[0] is not None:
        mark_auto_turn(st, now)
        return take_held_notes() + orders
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
