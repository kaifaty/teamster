"""Workspace sandbox rules and filter checks."""
import json
import re
import subprocess
import tempfile
import urllib.parse
from pathlib import Path

from . import config


def claude_system_prompt(worktree, task_dir):
    """Save this turn's workspace instructions outside the worktree."""
    text = ("You are the task executor in a git worktree. "
            "Make changes only inside this worktree.\n"
            "This turn runs headless: background commands and waiting for a notification end the turn "
            "and kill whatever runs in the background. Run long jobs in the foreground; if one outlasts "
            "a single command's timeout, start it with `nohup … > LOG 2>&1 &` and poll it in a blocking "
            "loop of at most 10 minutes per call until it ends.\n")
    agents = Path(worktree) / "AGENTS.md"
    if agents.is_file():
        with agents.open("rb") as stream:
            content = stream.read(65537)
        text += "\nRoot AGENTS.md:\n" + content[:65536].decode("utf-8", errors="replace")
        if len(content) > 65536:
            text += "\n[AGENTS.md truncated at 64 KiB]"
        text += "\n"
    text += ("\nRead and follow nested AGENTS.md files in the directories you change.\n")
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", prefix="claude-system-",
                                     suffix=".md", dir=task_dir, delete=False) as stream:
        stream.write(text)
        return Path(stream.name)


def unsafe_filter_driver(cwd):
    """Read every config scope without inspecting worker-written file contents."""
    result = subprocess.run(config.GIT + ["config", "--null", "--get-regexp", r"^filter\..*\.(clean|smudge|process)$"],
                            cwd=cwd, text=True, capture_output=True, errors="replace")
    if result.returncode == 1:  # No configured filter commands.
        return None
    result.check_returncode()
    # NUL-delimited records preserve embedded newlines in filter commands.
    for record in result.stdout.split("\0"):
        if not record:
            continue
        key, _, command = record.partition("\n")
        if not command.startswith(("git-lfs ", "git lfs ")):
            return key[len("filter."):key.rfind(".")]
    return None


def workspace_filter_driver(st):
    return unsafe_filter_driver(st["worktree"]) if st.get("sandbox") == "workspace" else None


def rules_path(cfg=None):
    override = config.data_path("rules")
    if override.is_file():
        return override
    cfg = config.accounts_config() if cfg is None else cfg
    filename = "rules.ru.md" if cfg.get("language", "en") == "ru" else "rules.md"
    return config.PACKAGE.resolve() / filename


def origin_remote(cwd):
    """Return the origin URL and a known non-GitHub host, resolving SSH aliases."""
    def run(args):
        return subprocess.run(args, cwd=cwd, check=True, capture_output=True,
                              text=True, errors="replace").stdout.strip()

    remote_url = run(config.GIT + ["remote", "get-url", "origin"])
    if remote_url.startswith("file://") or not re.match(r"[^/]+:", remote_url):
        return remote_url, "local path"
    url = urllib.parse.urlsplit(remote_url) if remote_url.startswith(("ssh://", "https://")) else None
    scp_url = re.fullmatch(r"[^/@:]+@([^/:]+):(.+)", remote_url) if url is None else None
    host = url.hostname if url is not None else scp_url[1] if scp_url else None
    path = url.path if url is not None else scp_url[2] if scp_url else ""
    if host and host.casefold() != "github.com" and (scp_url or url.scheme == "ssh"):
        try:
            ssh_config = run(["ssh", "-G", host])
        except (OSError, subprocess.CalledProcessError):
            ssh_config = ""
        for line in ssh_config.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0] == "hostname":
                host = parts[1]
                break
        if host.casefold() == "github.com":
            remote_url = "github.com/" + path.lstrip("/").removesuffix(".git")
    return remote_url, host if host and host.casefold() != "github.com" else ""


def repository_rules(text, cwd):
    """Replace the standard PR publication rule for known non-GitHub origins."""
    replacements = (
        ("At the end, push the branch; do not open or edit PRs yourself. "
         "The supervisor publishes the PR against `{base}` from `pr_title` and `pr_body` in your result.",
         "This repository is not hosted on GitHub, so the supervisor does not publish PRs here: "
         "open or edit a PR only if the brief tells you to, otherwise push the branch and stop."),
        ("Коммить по ходу, в конце запушь ветку; не открывай и не редактируй PR сам. "
         "Надзиратель публикует PR в `{base}` по `pr_title` и `pr_body` из твоего результата.",
         "Коммить по ходу. Репозиторий не на GitHub, и надзиратель PR здесь не публикует: "
         "открывай или правь PR, только если это велит бриф, иначе запушь ветку и закончи."),
        ("Do not open or edit PRs yourself: the supervisor does it from pr_title/pr_body.",
         "This repository is not hosted on GitHub, so the supervisor does not publish PRs here: "
         "open or edit a PR only if the brief tells you to, otherwise push the branch and stop."),
        ("Не открывай и не редактируй PR: надзиратель делает это из pr_title/pr_body.",
         "Репозиторий не на GitHub, и надзиратель PR здесь не публикует: "
         "открывай или правь PR, только если это велит бриф, иначе запушь ветку и закончи."),
    )
    if any(before in text for before, _ in replacements) and origin_remote(cwd)[1]:
        for before, after in replacements:
            text = text.replace(before, after)
    return text


def rules_text(cfg=None, no_push=False):
    text = rules_path(cfg).read_text(encoding="utf-8")
    if not no_push:
        return text
    lines = text.splitlines(keepends=True)
    replaced = False
    for index, line in enumerate(lines):
        if line.startswith("- Commit as you go."):
            lines[index] = ("- Commit as you go. Keep commits local; do not publish the branch or open or edit PRs. "
                            "Do not merge the PR or deploy anything: the lead handles review and merging.\n")
            replaced = True
        elif line.startswith("- Коммить по ходу,"):
            lines[index] = ("- Коммить по ходу локально. Не публикуй ветку, не открывай и не редактируй PR. "
                            "Не мержи PR и ничего не выкатывай: ревью и слияние делает ведущий.\n")
            replaced = True
    if not replaced:
        cfg = config.accounts_config() if cfg is None else cfg
        rule = ("Коммить локально; не пушь ветку, не открывай и не редактируй PR. "
                "Это отменяет правила о публикации выше." if cfg.get("language", "en") == "ru" else
                "Commit locally; do not push the branch or open or edit PRs. "
                "This overrides any publication rule above.")
        lines.append(("\n" if text.endswith("\n") else "\n\n") + "- " + rule + "\n")
    return "".join(lines)


def sandbox_rules(cfg, reviewing=False, no_push=False):
    if cfg.get("language", "en") == "ru":
        rules = ("## Песочница worktree\n\n"
                 "Этот раздел отменяет правила про коммиты и публикацию выше. ")
        rules += (("git commit в песочнице недоступен, не пытайся его запускать. "
                   "Не публикуй ветку, не открывай и не редактируй PR. ") if no_push else
                  ("git commit и git push в песочнице недоступны, не пытайся их запускать. "
                   "Не открывай и не редактируй PR: надзиратель делает это из pr_title/pr_body. "))
        if reviewing:
            return rules + "Файлы не меняй; верни только JSON по схеме ревью."
        rules += ("Оставь изменения в worktree: надзиратель закоммитит их локально после хода. " if no_push else
                  "Оставь изменения в worktree: надзиратель закоммитит и опубликует их после хода. ")
        return rules + ("В итоге дай commit_message по правилам репозитория: первая строка — заголовок. "
                        "Если изменений нет или ты уже закоммитил их сам, commit_message — пустая строка.")
    rules = ("## Workspace sandbox\n\n"
             "This section overrides the commit and publication rules above. ")
    rules += (("git commit is unavailable in the sandbox; do not try it. "
               "Do not publish the branch or open or edit PRs. ") if no_push else
              ("git commit and git push are unavailable in the sandbox; do not try them. "
               "Do not open or edit PRs yourself: the supervisor does it from pr_title/pr_body. "))
    if reviewing:
        return rules + "Do not change files; return only JSON matching the review schema."
    rules += ("Leave changes in the worktree: the supervisor will commit them locally after the turn. " if no_push else
              "Leave changes in the worktree: the supervisor will commit and publish them after the turn. ")
    return rules + ("Return commit_message following the repository's rules; the first line is the subject. "
                    "Use an empty commit_message if there are no changes or you already committed them yourself.")


def sandbox_args(st):
    if st.get("sandbox", "off") != "workspace":
        return []
    # JSON strings are TOML basic strings too; TOML also requires escaping DEL.
    roots = json.dumps(st.get("writable_dirs", []), ensure_ascii=False).replace("\x7f", "\\u007f")
    return ["-c", 'sandbox_mode="workspace-write"',
            "-c", "sandbox_workspace_write.network_access=true",
            "-c", "sandbox_workspace_write.writable_roots=" + roots]
