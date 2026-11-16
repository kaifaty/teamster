"""Finish lesson implementations, with durable receipts for each external action."""

import copy
import fcntl
import hashlib
import json
import logging
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import quote, urlsplit

from . import landing_release
from .research import IMPLEMENTATION, RECORD
from .store import Record, Store, alive, mapping, turn_check


LOGGER = logging.getLogger("uvicorn.error")
TIMEOUT = 120
RETRY_SECONDS = 30
MYWALLET = "В MyWallet PR сливаешь ты: там свои правила и боты ревью"
MANUAL = "В этом репозитории PR сливаешь ты: доска сливает сама только в своих репозиториях"
FIELDS = ("stage", "text", "pr", "version")

# The inherited lock stays held across a board restart, until the runner writes its result.
RUNNER = '''import json, os, signal, subprocess, sys
from pathlib import Path
result = Path(sys.argv[1])
try:
    process = subprocess.Popen(sys.argv[2:], start_new_session=True)
    try:
        code = process.wait(timeout=7200)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
        print("Landing command timed out after two hours", flush=True)
        code = 124
except OSError as exc:
    print(str(exc), flush=True)
    code = 127
temporary = result.with_suffix(".tmp")
temporary.write_text(json.dumps({"returncode": code}))
temporary.replace(result)
'''


def pr_url(value):
    return value if isinstance(value, str) and value.startswith(("http://", "https://")) else None


def fingerprint(state):
    return hashlib.sha256(json.dumps(state, sort_keys=True).encode()).hexdigest()


def own_forgejo(origin):
    parsed = urlsplit(origin)
    host, owner, _ = remote_parts(origin)
    return (parsed.scheme == "ssh" and parsed.port == 2222
            and host in ("192.168.1.150", "kaifaty.ru") and owner == "kaifaty")


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
        self.run_lock = threading.Lock()
        self.thread = None
        self.retry_at = {}
        self.processes = []
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

    def _stage(self, receipt, stage, text):
        if receipt.get("stage") == stage and receipt.get("text") == text:
            return
        receipt.update(stage=stage, text=text)
        self._save()
        self.publish()

    def _state_failed(self, receipt, state, text, stage="failed"):
        receipt["state_gate"] = fingerprint(state)
        self._stage(receipt, stage, text)
        self._save()

    def _run(self, argv, cwd):
        try:
            result = subprocess.run(argv, cwd=cwd, stdin=subprocess.DEVNULL, capture_output=True,
                                    encoding="utf-8", errors="replace", timeout=TIMEOUT)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ValueError(f"{Path(argv[0]).name}: {exc}") from exc
        # gh pr checks uses exit 8 while checks are pending; its JSON still contains their buckets.
        pending = argv[:3] == ["gh", "pr", "checks"] and result.returncode == 8
        absent_ref = (argv[:4] == ["gh", "api", "--method", "DELETE"]
                      and re.search(r"\(HTTP (?:404|422)\)", result.stderr) is not None)
        if result.returncode and not (pending or absent_ref):
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
        with self.run_lock:
            self.processes = [process for process in self.processes if process.poll() is None]
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
                receipt = self.receipts.setdefault(key, {"pr": None, "version": None})
                gate = receipt.get("state_gate")
                if gate == fingerprint(state):
                    continue
                if gate:
                    receipt.pop("state_gate")
                elif time.monotonic() < self.retry_at.get(key, 0):
                    continue
                if receipt.get("stage") == "landed":
                    continue
                if (lesson["status"] in ("declined", "applied")
                        and not (receipt.get("merged") or receipt.get("outside"))):
                    continue
                try:
                    if self.load_error:
                        raise ValueError(self.load_error)
                    self._land(lesson, implementation, state, receipt)
                except Exception as exc:
                    LOGGER.exception("Lesson landing failed: %s", implementation["slug"])
                    self._stage(receipt, "failed", f"Не удалось довести внедрение: {str(exc)[-1000:]}")
                if receipt.get("stage") in ("waiting", "failed", "manual"):
                    self.retry_at[key] = time.monotonic() + RETRY_SECONDS

    def _land(self, lesson, implementation, state, receipt):
        slug = implementation["slug"]
        result = mapping(state.get("result"))
        pr = (pr_url(mapping(state.get("publish")).get("pr")) or pr_url(result.get("pr"))
              or (receipt.get("pr") if receipt.get("forgejo") else None))
        receipt["pr"] = pr
        number = pr.rstrip("/").rsplit("/", 1)[-1] if isinstance(pr, str) else ""
        label = f"PR #{number}"
        if state.get("no_push") and (pr or not lesson["outside"] or receipt.get("forgejo")
                                     or receipt.get("merged")):
            self._state_failed(receipt, state, "Публикация запрещена: задача запущена с --no-push")
            return
        if not receipt.get("merged") and not receipt.get("outside"):
            if alive(state.get("pid")):
                self._stage(receipt, "waiting", "Жду завершения задачи")
                return
            if result.get("questions"):
                if receipt.get("stage"):
                    self._stage(receipt, None, "")
                return
            if receipt.get("repair_cycle") == cycle(state):
                if receipt.get("repair_sent"):
                    self._stage(receipt, "waiting", "Жду завершения исправления CI" if receipt.get("ci_repair")
                                else "Жду завершения исправления конфликтов")
                else:
                    self._stage(receipt, "failed", "Не удалось подтвердить запуск исправления конфликтов")
                return
            if result.get("status") != "done":
                status = result.get("status") or "unknown"
                reason = "Агент остановился" if status == "blocked" else "Агент не закончил"
                self._state_failed(receipt, state, f"{reason}: итог {status}")
                return
            if state.get("outcome") != "completed":
                self._state_failed(receipt, state, f"Агент остановился: {state.get('outcome') or 'unknown'}")
                return
            if not pr:
                origin = self._run(["git", "remote", "get-url", "origin"], Path(state["repo"]))
                forgejo = own_forgejo(origin)
                outside_only = bool(lesson["outside"]) and not receipt.get("forgejo")
                if (forgejo or state.get("no_push")) and outside_only:
                    outside_only = int(self._run(["git", "rev-list", "--count", f"{state['base']}..HEAD"],
                                                 Path(state["worktree"]))) == 0
                if outside_only:
                    receipt["outside"] = True
                    self._save()
                else:
                    if state.get("no_push"):
                        self._state_failed(receipt, state, "Публикация запрещена: задача запущена с --no-push")
                        return
                    if forgejo:
                        self._forgejo(slug, state, receipt, origin)
                    else:
                        host, owner, _ = remote_parts(origin)
                        if host != "github.com" or owner != "kaifaty":
                            self._stage(receipt, "manual", MYWALLET if owner == "mytonwallet-org" else MANUAL)
                        else:
                            self._state_failed(receipt, state, "У задачи нет PR для слияния")
                    if not receipt.get("merged"):
                        return
            if pr and not receipt.get("merged"):
                self._merge(slug, state, receipt, pr, label)
                if not receipt.get("merged"):
                    return
        pr = receipt.get("pr")
        label = f"PR #{pr.rstrip('/').rsplit('/', 1)[-1]}" if pr else "PR"
        if (receipt.get("merged") and not receipt.get("forgejo")
                and (Path(state["repo"]) / "scripts/bump_version.py").is_file()):
            repo = Path(state["repo"])
            host, owner, name = remote_parts(self._run(["git", "remote", "get-url", "origin"], repo))
            if (host, owner, name) == ("github.com", "kaifaty", "teamster"):
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
                record = Record(Path(), archived=False, state=state)
                verdict, _ = store.lead_verdict(slug, record, Path(state["repo"]).name)
                already_accepted = verdict == "accepted"
            if not (already_applied or already_accepted) and (step != "cleaned" or not implementation["archived"]):
                self._run([self.actions.command, *argv], Path.home())
            receipt[step] = True
            self._save()
        if receipt.get("merged") and not receipt.get("remote_deleted"):
            self._run(["gh", "api", "--method", "DELETE", receipt["remote_ref"]], Path(state["repo"]))
            receipt["remote_deleted"] = True
            self._save()
        text = f"Внедрено: {label} слит" if pr else "Внедрено: файлы вне репозитория обновлены"
        if receipt.get("version"):
            text += f", teamster {receipt['version']}"
        self._stage(receipt, "landed", text)

    def _merge(self, slug, state, receipt, pr, label):
        repo = Path(state["repo"])
        origin = self._run(["git", "remote", "get-url", "origin"], repo)
        host, owner, name = remote_parts(origin)
        if own_forgejo(origin):
            self._forgejo(slug, state, receipt, origin)
            return
        if host != "github.com" or owner != "kaifaty":
            self._stage(receipt, "manual", MYWALLET if owner == "mytonwallet-org" else MANUAL)
            return
        parsed = urlsplit(pr)
        if (parsed.scheme != "https" or parsed.netloc.lower() != "github.com"
                or re.fullmatch(rf"/{re.escape(owner)}/{re.escape(name)}/pull/[0-9]+", parsed.path, re.I) is None):
            raise ValueError("PR URL does not belong to origin")
        fields = "state,mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid,mergeCommit,files,url,number"
        view = json.loads(self._run(["gh", "pr", "view", pr, "--json", fields], repo))
        branch = view.get("headRefName")
        if not isinstance(branch, str) or not branch:
            raise ValueError("Missing PR head branch")
        if not self._matching_head(state, receipt, view.get("headRefOid"), label,
                                   merged=view.get("state") == "MERGED"):
            return
        receipt["remote_ref"] = f"repos/{owner}/{name}/git/refs/heads/{quote(branch, safe='/')}"
        if view.get("state") == "MERGED":
            self._merged(receipt, view)
            return
        if view.get("state") != "OPEN":
            self._stage(receipt, "failed", f"{label} закрыт без слияния")
            return
        if not self._ready(state, receipt):
            return
        ci = mapping(state.get("ci"))
        conflicting = view.get("mergeable") == "CONFLICTING" or view.get("mergeStateStatus") == "DIRTY"
        repair_without_ci = conflicting and ci.get("outcome") in ("none", "skipped")
        if ci.get("outcome") != "passed" and not repair_without_ci:
            if ci.get("outcome") == "pending":
                self._state_failed(receipt, state, f"Жду CI {label}", stage="waiting")
            else:
                rounds = ci.get("rounds", 0)
                reason = f"CI не прошёл после {rounds} попыток починки" if rounds else "CI не прошёл"
                self._state_failed(receipt, state, reason)
            return
        head = view.get("headRefOid")
        if (not isinstance(head, str) or re.fullmatch(r"[0-9a-fA-F]{40,64}", head) is None
                or (not repair_without_ci and head != ci.get("sha"))):
            self._stage(receipt, "failed", f"HEAD {label} не совпадает с коммитом, прошедшим CI задачи")
            return
        if conflicting:
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
        if view.get("mergeStateStatus") != "CLEAN":
            self._stage(receipt, "waiting", f"Жду готовности {label} к слиянию")
            return
        checks = json.loads(self._run(["gh", "pr", "checks", pr, "--json", "bucket"], repo))
        if isinstance(checks, list) and any(row.get("bucket") == "pending" for row in checks):
            self._stage(receipt, "waiting", f"Жду CI {label}")
            return
        if (not isinstance(checks, list) or not checks
                or any(row.get("bucket") not in ("pass", "skip", "skipping") for row in checks)):
            self._stage(receipt, "failed", f"Проверки {label} не прошли")
            return
        receipt["files"] = [row["path"] for row in view.get("files", [])]
        self._stage(receipt, "merging", f"Сливаю {label}")
        self._run(["gh", "pr", "merge", pr, "--merge", "--match-head-commit", head], repo)
        view = json.loads(self._run(["gh", "pr", "view", pr, "--json", fields], repo))
        if view.get("state") != "MERGED":
            raise ValueError("GitHub did not confirm the merge")
        if not self._matching_head(state, receipt, view.get("headRefOid"), label, merged=True):
            return
        self._merged(receipt, view)

    def _matching_head(self, state, receipt, head, label, merged=False):
        checked = self._run(["git", "rev-parse", "HEAD"], Path(state["worktree"]))
        publication = mapping(state.get("publish"))
        reason = f"Ветка задачи не запушена: {label} отстаёт от проверенного коммита"
        if (head != checked or (publication.get("sha") and publication["sha"] != checked)):
            self._stage(receipt, "failed", reason)
            return False
        if not merged and publication.get("pushed") is False:
            self._state_failed(receipt, state, reason)
            return False
        return True

    def _ready(self, state, receipt):
        check = turn_check(state)
        if check is not None and check.get("outcome") != "passed":
            self._state_failed(receipt, state, "Проверка не прошла")
            return False
        review = mapping(state.get("review_result"))
        if ((review.get("verdict") == "clean" and review.get("findings") == [])
                or state.get("auto_fix_stop") in ("clean", "only P3")):
            return True
        severities = sorted({row.get("severity") for row in review.get("findings", [])
                             if isinstance(row, dict) and row.get("severity") in ("P0", "P1", "P2", "P3")})
        reason = (f"Ревью нашло замечания {', '.join(severities)}" if severities
                  else "Ревью не подтвердило готовность: нет чистого результата")
        self._state_failed(receipt, state, reason)
        return False

    def _tea(self, path, cwd, body=None):
        argv = ["tea", "api", "--login", "forgejo"]
        if body is not None:
            argv += ["-X", "POST", "-d", json.dumps(body)]
        output = self._run([*argv, path], cwd)
        return json.loads(output) if output else None

    def _start_job(self, slug, state, receipt, argv, kind, sha=None):
        directory = self.path.parent / "board-landing-jobs"
        directory.mkdir(parents=True, exist_ok=True)
        name = f"{slug}-{state.get('created', 0)}-{int(bool(receipt.get('forgejo_repair')))}"
        log, result = directory / f"{name}.log", directory / f"{name}.json"
        receipt["forgejo_job"] = {"log": str(log), "result": str(result), "kind": kind, "sha": sha}
        self._save()
        # Lock before spawning so recovery cannot mistake the runner's startup for a dead job.
        with log.open("a+") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            stream.seek(0)
            stream.truncate()
            result.unlink(missing_ok=True)
            process = subprocess.Popen([sys.executable, "-c", RUNNER, str(result), *argv],
                                       cwd=state["worktree"], stdin=subprocess.DEVNULL,
                                       stdout=stream, stderr=subprocess.STDOUT, start_new_session=True,
                                       pass_fds=(stream.fileno(),))
        self.processes.append(process)

    def _job_result(self, receipt):
        job = receipt["forgejo_job"]
        result, log = Path(job["result"]), Path(job["log"])
        if not log.exists() and not result.exists():
            receipt.pop("forgejo_job")
            self._save()
            return None, ""
        with log.open("rb") as stream:
            stream.seek(0, 2)
            stream.seek(max(0, stream.tell() - 4000))
            output = stream.read().decode("utf-8", errors="replace")
            if result.exists():
                return json.loads(result.read_text())["returncode"], output
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return None, output
            if result.exists():
                return json.loads(result.read_text())["returncode"], output
            if not output:
                receipt.pop("forgejo_job")
                self._save()
                return None, ""
        raise ValueError(f"Landing process exited without a result: {output[-1000:]}")

    def _forgejo_repair(self, slug, state, receipt, output, conflict=False):
        if receipt.get("forgejo_repair"):
            self._stage(receipt, "failed", f"Повторное доведение не удалось: {output[-1000:]}")
            return
        receipt.update(forgejo_repair=True, repair_cycle=cycle(state), ci_repair=not conflict)
        receipt.pop("forgejo_job", None)
        self._stage(receipt, "waiting", "Отправляю задаче исправление конфликтов с базой" if conflict
                    else "Отправляю задаче исправление CI")
        order = ("Merge origin/main, resolve conflicts, run checks and push." if conflict
                 else f"CI failed: {output[-1000:]}. Fix it, run checks and push.")
        self._run([self.actions.command, "say", slug, order, "--max-minutes", "30",
                   "--review", "--fix-rounds", "1", "--ci"], Path.home())
        receipt["repair_sent"] = True
        self._save()

    def _forgejo(self, slug, state, receipt, origin):
        if not self._ready(state, receipt):
            return
        receipt["forgejo"] = True
        _, owner, name = remote_parts(origin)
        endpoint = f"/repos/{owner}/{name}/pulls"
        repo, worktree = Path(state["repo"]), Path(state["worktree"])
        branch, base = state["branch"], state["base"].removeprefix("origin/")
        result = mapping(state.get("result"))
        title, body = result.get("pr_title") or f"Merge {slug}", result.get("pr_body") or ""
        scripts = Path.home() / ".codex/checks" / repo.name
        land = scripts / "land.py"
        job = receipt.get("forgejo_job")
        code, output = self._job_result(receipt) if job else (None, "")
        job = receipt.get("forgejo_job")
        # land.py prints the PR URL as soon as it has opened it, before waiting for CI.
        for candidate in re.findall(r"https?://[^\s]+", output):
            parsed = urlsplit(candidate)
            if (parsed.hostname in ("192.168.1.150", "kaifaty.ru")
                    and re.fullmatch(rf"/{owner}/{re.escape(name)}/pulls/[0-9]+", parsed.path)):
                receipt["pr"] = candidate
        number = receipt.get("pr", "").rstrip("/").rsplit("/", 1)[-1] if receipt.get("pr") else None
        label = f"PR #{number}" if number else "PR"
        if job:
            if code is None:
                self._stage(receipt, "waiting", f"Жду CI {label} на Forgejo")
                return
            if code:
                if ((job["kind"] == "waiter" and code == 75)
                        or (job["kind"] == "land" and "CI did not pass (exit 75)" in output)):
                    receipt.pop("forgejo_job")
                    self._stage(receipt, "failed", f"CI не читается: {output[-1000:]}")
                    self._save()
                elif job["kind"] == "waiter" and code == 1:
                    self._forgejo_repair(slug, state, receipt, output)
                elif job["kind"] == "land" and re.search(
                        r"conflict|main moved|origin/main has commits|not in main after", output, re.I):
                    self._forgejo_repair(slug, state, receipt, output, conflict=True)
                elif (job["kind"] == "land" and "CI did not pass (exit 1)" in output
                      and code != 124):
                    self._forgejo_repair(slug, state, receipt, output)
                else:
                    self._stage(receipt, "failed", f"Не удалось довести внедрение: {output[-1000:] or f'exit {code}'}")
                return
        checked = self._run(["git", "rev-parse", "HEAD"], worktree)
        if number:
            parsed = urlsplit(receipt["pr"])
            if (parsed.hostname not in ("192.168.1.150", "kaifaty.ru")
                    or re.fullmatch(rf"/{owner}/{re.escape(name)}/pulls/[0-9]+", parsed.path) is None):
                raise ValueError("PR URL does not belong to origin")
            pull = self._tea(f"{endpoint}/{number}", repo)
        else:
            pulls = self._tea(f"{endpoint}?state=all&limit=50", repo)
            candidates = [row for row in pulls if mapping(row.get("head")).get("ref") == branch
                          and mapping(row.get("base")).get("ref") == base]
            pull = next((row for row in candidates if row.get("state") == "open"), None)
            if pull is None:
                pull = next((row for row in candidates if row.get("merged")
                             and mapping(row.get("head")).get("sha") == checked), None)
        if pull:
            if (mapping(pull.get("head")).get("ref") != branch
                    or mapping(pull.get("base")).get("ref") != base):
                raise ValueError("PR head or base does not match the task")
            receipt["pr"] = pull["html_url"]
            number, label = pull["number"], f"PR #{pull['number']}"
            self._save()
            if not self._matching_head(state, receipt, mapping(pull.get("head")).get("sha"), label,
                                       merged=bool(pull.get("merged"))):
                return
            if pull.get("merged"):
                receipt.update(merged=True, remote_deleted=True)
                self._save()
                return
            if pull.get("state") != "open":
                self._stage(receipt, "failed", f"{label} закрыт без слияния")
                return
        if not job and land.is_file():
            if not pull and not self._matching_head(state, receipt, checked, label):
                return
            if not title.startswith("Merge "):
                title = f"Merge {title}"
            self._start_job(slug, state, receipt, ["python3", str(land), title, body], "land")
            self._stage(receipt, "waiting", f"Жду CI {label} на Forgejo")
            return
        if job and job["kind"] == "land":
            # The landing script's exit 0 is its merge receipt.
            if not pull:
                raise ValueError("land.py succeeded without a PR URL")
            receipt.update(merged=True, remote_deleted=True)
            self._save()
            return
        if not pull:
            if not self._matching_head(state, receipt, checked, label):
                return
            pull = self._tea(endpoint, repo, {"head": branch, "base": base, "title": title, "body": body})
            number, label = pull["number"], f"PR #{pull['number']}"
            receipt["pr"] = pull["html_url"]
            self._save()
            if not self._matching_head(state, receipt, mapping(pull.get("head")).get("sha"), label):
                return
        if not job:
            waiter = next((scripts / name for name in ("pr_ci.py", "ci_wait.py")
                           if (scripts / name).is_file()), None)
            if waiter:
                self._start_job(slug, state, receipt, ["python3", str(waiter)], "waiter", pull["head"]["sha"])
                self._stage(receipt, "waiting", f"Жду CI {label} на Forgejo")
                return
            if (worktree / ".forgejo/workflows").is_dir():
                self._stage(receipt, "failed", f"Нет скрипта ожидания CI в ~/.codex/checks/{repo.name}/")
                return
        if job and job.get("sha") != pull["head"]["sha"]:
            self._stage(receipt, "failed", f"HEAD {label} изменился после запуска ожидания CI")
            return
        self._stage(receipt, "merging", f"Сливаю {label}")
        self._tea(f"{endpoint}/{number}/merge", repo,
                  {"Do": "merge", "delete_branch_after_merge": True,
                   "head_commit_id": pull["head"]["sha"]})
        pull = self._tea(f"{endpoint}/{number}", repo)
        if not pull.get("merged"):
            raise ValueError("Forgejo did not confirm the merge")
        if not self._matching_head(state, receipt, mapping(pull.get("head")).get("sha"), label, merged=True):
            return
        receipt.update(merged=True, remote_deleted=True)
        self._save()

    def _merged(self, receipt, view):
        sha = mapping(view.get("mergeCommit")).get("oid")
        if not isinstance(sha, str) or re.fullmatch(r"[0-9a-fA-F]{40,64}", sha) is None:
            raise ValueError("Missing merge commit SHA")
        receipt.update(merged=True, merge_sha=sha,
                       files=[row["path"] for row in view.get("files", [])])
        self._save()
