"""Finish lesson implementations, with durable receipts for each external action."""

import copy
import json
import logging
import re
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit

from . import landing_release
from .research import IMPLEMENTATION, RECORD
from .store import Record, Store, alive, mapping, turn_check


LOGGER = logging.getLogger("uvicorn.error")
TIMEOUT = 120
MYWALLET = "В MyWallet PR сливаешь ты: там свои правила и боты ревью"
MANUAL = "В этом репозитории PR сливаешь ты: доска сливает сама только в своих репозиториях"
FIELDS = ("stage", "text", "pr", "version")


def remote_parts(value):
    """Read HTTPS, SSH and scp-style origin addresses without substring host matching."""
    match = re.fullmatch(r"(?:[^/@:]+@)?([^/:]+):([^/]+)/([^/]+)", value)
    if match and "://" not in value:
        host, owner, repo = match.groups()
    else:
        parsed = urlsplit(value)
        parts = parsed.path.strip("/").split("/")
        if parsed.scheme not in ("http", "https", "ssh", "git") or len(parts) != 2:
            return None, None, None
        host, (owner, repo) = parsed.hostname, parts
    return (host or "").lower(), owner.lower(), repo.removesuffix(".git")


def cycle(state):
    return [state.get(key) for key in ("turns", "turn_started", "turn_finished")]


class Landing:
    def __init__(self, actions, disabled=False, publish=None):
        self.actions = actions
        self.disabled = disabled or actions.reason is not None
        self.publish = publish or (lambda: None)
        self.path = actions.research.tasks_path.parent / "board-landings.json"
        self.lock = threading.Lock()
        self.worker_lock = threading.Lock()
        self.thread = None
        self.failed = set()
        self.receipts = {}
        self.load_error = None
        try:
            if self.path.is_symlink():
                raise ValueError("Landing receipts must not be a symbolic link")
            if self.path.exists():
                receipts = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(receipts, dict) or any(not isinstance(row, dict) for row in receipts.values()):
                    raise ValueError("Invalid landing receipts")
                self.receipts = receipts
        except (OSError, ValueError) as exc:
            self.load_error = str(exc)

    @staticmethod
    def _key(slug, created):
        return f"{slug}:{created}"

    def value(self, slug, created):
        if self.disabled:
            return None
        with self.lock:
            row = self.receipts.get(self._key(slug, created), {})
            return {key: row.get(key) for key in FIELDS} if row.get("stage") else None

    def poll(self):
        research = self.actions.research
        view = research._view
        if self.disabled or (view is None and research._next_scan == 0):
            return
        if (view is not None and not any(lesson["implementation"] for lesson in view["lessons"])
                and time.monotonic() < research._next_scan):
            return
        if not self.worker_lock.acquire(blocking=False):
            return
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self.thread.start()

    def _worker(self):
        try:
            self.run_once(refresh=False)
        except Exception:
            LOGGER.exception("Lesson landing scan failed")
        finally:
            self.worker_lock.release()

    def _save(self):
        if self.load_error is None:
            with self.lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                temporary = self.path.with_suffix(".tmp")
                temporary.write_text(json.dumps(self.receipts, ensure_ascii=False), encoding="utf-8")
                temporary.replace(self.path)
        self.actions.research.invalidate()
        self.publish()

    def _stage(self, receipt, stage, text):
        if receipt.get("stage") == stage and receipt.get("text") == text:
            return
        receipt.update(stage=stage, text=text)
        self._save()

    def _run(self, argv, cwd):
        try:
            result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True,
                                    encoding="utf-8", errors="replace", timeout=TIMEOUT)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError(f"{Path(argv[0]).name}: {exc}") from exc
        if result.returncode:
            message = (result.stderr.strip() or result.stdout.strip())[-1000:]
            raise ValueError(f"{Path(argv[0]).name}: {message or f'exit {result.returncode}'}")
        return result.stdout.strip()

    def _state(self, implementation, entry):
        tasks = self.actions.research.tasks_path
        slug = implementation["slug"]
        directories = [tasks / slug]
        if implementation["archived"]:
            directories = [path for path in Store._directories(tasks / ".archive")
                           if (match := RECORD.fullmatch(path.name)) and match[1] == slug]
        for directory in directories:
            state_file = Store._file(directory, "state.json")
            brief = Store._file(directory, "brief.md")
            if state_file is None or brief is None:
                continue
            try:
                state = json.loads(state_file.read_text(encoding="utf-8"))
                with brief.open(encoding="utf-8") as stream:
                    match = IMPLEMENTATION.match(stream.readline())
                if (isinstance(state, dict) and match and match[1].strip() == entry
                        and state.get("created", implementation["created"]) == implementation["created"]):
                    return state
            except (OSError, ValueError):
                continue
        return None

    def run_once(self, refresh=True):
        if self.disabled:
            return
        with self.actions.lock:
            if refresh:
                self.actions.research.invalidate()
            lessons = copy.deepcopy(self.actions.research.view()["lessons"])
            for lesson in lessons:
                implementation = lesson["implementation"]
                if implementation is None or not implementation["slug"].startswith("lesson-"):
                    continue
                state = self._state(implementation, lesson["entry"])
                if state is None:
                    continue
                key = self._key(implementation["slug"], implementation["created"])
                signature = (key, json.dumps(state, sort_keys=True))
                if signature in self.failed:
                    continue
                receipt = self.receipts.setdefault(key, {"pr": None, "version": None})
                if receipt.get("stage") == "landed":
                    continue
                if (lesson["status"] in ("declined", "applied")
                        and not (receipt.get("merged") or receipt.get("outside"))):
                    continue
                try:
                    if self.load_error:
                        raise ValueError(self.load_error)
                    self._land(lesson, implementation, state, receipt)
                    if receipt.get("stage") in ("failed", "manual"):
                        self.failed.add(signature)
                except Exception as exc:
                    LOGGER.exception("Lesson landing failed: %s", implementation["slug"])
                    self.failed.add(signature)
                    self._stage(receipt, "failed", f"Не удалось довести внедрение: {str(exc)[-1000:]}")

    def _land(self, lesson, implementation, state, receipt):
        slug = implementation["slug"]
        result = mapping(state.get("result"))
        pr = mapping(state.get("publish")).get("pr") or result.get("pr") or None
        receipt["pr"] = pr
        number = pr.rstrip("/").rsplit("/", 1)[-1] if isinstance(pr, str) else ""
        label = f"PR #{number}"
        if not receipt.get("merged") and not receipt.get("outside"):
            if alive(state.get("pid")):
                self._stage(receipt, "waiting", "Жду завершения задачи")
                return
            if result.get("questions"):
                if receipt.get("stage"):
                    receipt["stage"] = None
                    self._save()
                return
            if receipt.get("repair_cycle") == cycle(state):
                if receipt.get("repair_sent"):
                    self._stage(receipt, "waiting", "Жду завершения исправления конфликтов")
                else:
                    self._stage(receipt, "failed", "Не удалось подтвердить запуск исправления конфликтов")
                return
            if state.get("outcome") != "completed":
                self._stage(receipt, "failed", "Цикл задачи не завершился успешно")
                return
            if result.get("status") != "done":
                text = {"needs_decision": "Для внедрения нужно решение пользователя",
                        "blocked": "Задача заблокирована", "partial": "Задача выполнена только частично"}
                self._stage(receipt, "failed", text.get(result.get("status"), "Нет готового результата задачи"))
                return
            if not pr:
                if not lesson["outside"]:
                    self._stage(receipt, "failed", "У задачи нет PR для слияния")
                    return
                receipt["outside"] = True
                self._save()
            else:
                self._stage(receipt, "waiting", f"Проверяю готовность {label} к слиянию")
                self._merge(slug, state, receipt, pr, label)
                if not receipt.get("merged"):
                    return
        if receipt.get("merged") and (Path(state["repo"]) / "scripts/bump_version.py").is_file():
            repo = Path(state["repo"])
            host, owner, _ = remote_parts(self._run(["git", "remote", "get-url", "origin"], repo))
            if host != "github.com" or owner != "kaifaty":
                self._stage(receipt, "manual", MYWALLET if owner == "mytonwallet-org" else MANUAL)
                return
            self._stage(receipt, "releasing", "Выпускаю версию teamster")
            version = landing_release.release(repo, receipt["merge_sha"], receipt["files"], receipt, self._save)
            if version:
                receipt["version"] = version
                if not receipt.get("upgraded"):
                    self._stage(receipt, "upgrading", "Обновляю teamster")
                    landing_release.upgrade()
                    receipt["upgraded"] = True
                    self._save()
        note = pr or ", ".join(lesson["outside"])
        steps = (("applied", ["lesson", lesson["entry"], "applied", "--note", note]),
                 ("accepted", ["verdict", slug, "accepted", "--note", "landed by the board"]),
                 ("cleaned", ["clean", slug]))
        for step, argv in steps:
            if receipt.get(step):
                continue
            already_applied = step == "applied" and lesson["status"] == "applied"
            already_accepted = False
            if step == "accepted":
                # A crash can happen after the verdict reaches the journal, before its receipt is saved.
                store = self.actions.store
                with store.lock:
                    store._poll_log()
                    record = Record(Path(), archived=False, state=state)
                    verdict, _ = store._lead_verdict(slug, record, Path(state["repo"]).name)
                already_accepted = verdict == "accepted"
            if not (already_applied or already_accepted) and (step != "cleaned" or not implementation["archived"]):
                self._run([self.actions.command, *argv], Path.home())
            receipt[step] = True
            self._save()
        text = f"Внедрено: {label} слит" if pr else "Внедрено: файлы вне репозитория обновлены"
        if receipt.get("version"):
            text += f", teamster {receipt['version']}"
        self._stage(receipt, "landed", text)

    def _merge(self, slug, state, receipt, pr, label):
        repo = Path(state["repo"])
        origin = self._run(["git", "remote", "get-url", "origin"], repo)
        host, owner, name = remote_parts(origin)
        if host != "github.com" or owner != "kaifaty":
            self._stage(receipt, "manual", MYWALLET if owner == "mytonwallet-org" else MANUAL)
            return
        parsed = urlsplit(pr)
        if (parsed.scheme != "https" or parsed.netloc.lower() != "github.com"
                or re.fullmatch(rf"/{re.escape(owner)}/{re.escape(name)}/pull/[0-9]+", parsed.path, re.I) is None):
            raise ValueError("PR URL does not belong to origin")
        fields = "state,mergeable,mergeStateStatus,baseRefName,headRefOid,mergeCommit,files,url,number"
        view = json.loads(self._run(["gh", "pr", "view", pr, "--json", fields], repo))
        if view.get("state") == "MERGED":
            self._merged(receipt, view)
            return
        if view.get("state") != "OPEN":
            self._stage(receipt, "failed", f"{label} закрыт без слияния")
            return
        if view.get("mergeable") == "CONFLICTING" or view.get("mergeStateStatus") == "DIRTY":
            if receipt.get("conflict_attempted"):
                self._stage(receipt, "failed", "После исправления PR всё ещё конфликтует с базой")
                return
            base = view.get("baseRefName")
            if not isinstance(base, str) or not re.fullmatch(r"[A-Za-z0-9._/-]+", base):
                raise ValueError("Invalid PR base branch")
            receipt.update(conflict_attempted=True, repair_cycle=cycle(state))
            self._stage(receipt, "waiting", "Отправляю задаче исправление конфликтов с базой")
            self._run([self.actions.command, "say", slug,
                       f"Merge origin/{base}, resolve conflicts, run checks and push.",
                       "--max-minutes", "30", "--review", "--fix-rounds", "1", "--ci"], Path.home())
            receipt["repair_sent"] = True
            self._save()
            return
        check = turn_check(state)
        if check is not None and check.get("outcome") != "passed":
            self._stage(receipt, "failed", "Сохранённая проверка последнего хода не прошла")
            return
        review = mapping(state.get("review_result"))
        if not ((review.get("verdict") == "clean" and review.get("findings") == [])
                or state.get("auto_fix_stop") in ("clean", "only P3")):
            self._stage(receipt, "failed", "Ревью не подтвердило готовность: остались дефекты или нет результата")
            return
        ci = mapping(state.get("ci"))
        if ci.get("outcome") != "passed":
            if ci.get("outcome") == "pending":
                self._stage(receipt, "waiting", f"Жду CI {label}")
            else:
                rounds = ci.get("rounds", 0)
                reason = f"CI не прошёл после {rounds} попыток починки" if rounds else "CI задачи не прошёл"
                self._stage(receipt, "failed", reason)
            return
        if view.get("mergeStateStatus") != "CLEAN":
            self._stage(receipt, "failed", f"{label} пока не готов к слиянию")
            return
        checks = json.loads(self._run(["gh", "pr", "checks", pr, "--json", "bucket"], repo))
        if not isinstance(checks, list) or not checks or any(row.get("bucket") not in ("pass", "skip") for row in checks):
            self._stage(receipt, "failed", f"Проверки {label} не прошли")
            return
        receipt["files"] = [row["path"] for row in view.get("files", [])]
        self._stage(receipt, "merging", f"Сливаю {label}")
        self._run(["gh", "pr", "merge", pr, "--merge", "--delete-branch"], repo)
        view = json.loads(self._run(["gh", "pr", "view", pr, "--json", fields], repo))
        if view.get("state") != "MERGED":
            raise ValueError("GitHub did not confirm the merge")
        self._merged(receipt, view)

    def _merged(self, receipt, view):
        sha = mapping(view.get("mergeCommit")).get("oid")
        if not isinstance(sha, str) or re.fullmatch(r"[0-9a-fA-F]{40,64}", sha) is None:
            raise ValueError("Missing merge commit SHA")
        receipt.update(merged=True, merge_sha=sha,
                       files=[row["path"] for row in view.get("files", [])])
        self._save()
