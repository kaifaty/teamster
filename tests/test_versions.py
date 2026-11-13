"""Side-by-side installs through upgrade and versions, from a local repository and temporary homes."""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


# Isolated Python omits the script directory from its import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rotation_support import RotationTestCase
from worker_loader import load_worker


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "src/teamster/__main__.py"
PYTHON = sys.executable


def source_git(source, env, *args):
    return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                          cwd=source, env=env, check=True, capture_output=True, text=True).stdout


def make_source(source, env):
    """A local repository with this tree's src/, ready for releases."""
    shutil.copytree(ROOT / "src", source / "src", ignore=shutil.ignore_patterns("__pycache__"))
    source_git(source, env, "init", "-q", "-b", "main")


def release(source, env, version, layout=1, extra=""):
    """Commit this tree's src/ under another __version__ and DATA_LAYOUT."""
    text = (ROOT / "src/teamster/__init__.py").read_text(encoding="utf-8")
    text = re.sub(r'__version__ = "[^"]*"', '__version__ = "%s"' % version, text)
    text = text.replace("DATA_LAYOUT = 1", "DATA_LAYOUT = %d" % layout) + extra
    (source / "src/teamster/__init__.py").write_text(text, encoding="utf-8")
    source_git(source, env, "add", "-A")
    source_git(source, env, "commit", "-q", "--allow-empty", "-m", version)


class VersionInstallTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="teamster-versions-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.data = self.root / "data"
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(("TEAMSTER_", "CODEX_"))}
        self.env.update(HOME=str(self.root / "home"), TEAMSTER_HOME=str(self.data),
                        CODEX_HOME=str(self.root / "home/.codex"), GIT_CONFIG_GLOBAL=os.devnull,
                        GIT_CONFIG_NOSYSTEM="1")
        (self.root / "home").mkdir()
        self.source = self.root / "source"
        make_source(self.source, self.env)

    def release(self, version, layout=1, extra=""):
        release(self.source, self.env, version, layout, extra)

    def cli(self, *args, code=0, command=None):
        result = subprocess.run((command or [PYTHON, "-I", str(SCRIPT)]) + list(args), cwd=self.root,
                                env=self.env, capture_output=True, text=True, timeout=120)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def upgrade(self, *args, code=0):
        return self.cli("upgrade", "--source", str(self.source), "--ref", "main", *args, code=code)

    def current(self):
        return os.readlink(self.data / "versions/current")

    def fake_supervisor(self, slug, version):
        """A live process whose command line runs the version's __main__.py, like _run does."""
        main = self.data / "versions" / version / "src/teamster/__main__.py"
        proc = subprocess.Popen([PYTHON, "-c", "import time; time.sleep(120)", str(main), "_run", slug])
        self.addCleanup(proc.wait)
        self.addCleanup(proc.kill)
        task = self.data / "tasks" / slug
        task.mkdir(parents=True)
        (task / "state.json").write_text(json.dumps({"slug": slug, "pid": proc.pid, "kind": "work"}))
        return proc

    def test_bump_version_for_releases(self):
        paths = ("src/teamster/__init__.py", "plugins/teamster/.claude-plugin/plugin.json")
        current = re.search(rb'__version__ = "([^"]+)"', (ROOT / paths[0]).read_bytes())[1]
        cases = (("major", "2.0.0", ""), ("minor", "1.3.0", ""),
                 ("patch", "1.2.4", ""), ("1.10.0", "1.10.0", ""),
                 ("1.2.2", None, "greater"), ("1.2.3", None, "greater"),
                 ("mismatch", None, "differ"),
                 ("dirty-package", None, "clean"), ("staged-package", None, "clean"),
                 ("dirty-plugin", None, "clean"), ("staged-plugin", None, "clean"),
                 ("commit", "1.2.4", ""))
        for case, expected, error in cases:
            with self.subTest(case=case):
                repo = self.root / case
                for name in (*paths, "scripts/bump_version.py"):
                    target = repo / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    data = (ROOT / name).read_bytes()
                    if name in paths:
                        data = data.replace(current, b"1.2.3").replace(b"\n", b"\r\n")
                    target.write_bytes(data)

                def git(*args):
                    return source_git(repo, self.env, *args).strip()

                plugin = repo / paths[1]
                if case == "mismatch":
                    plugin.write_bytes(plugin.read_bytes().replace(b"1.2.3", b"1.2.2"))
                unrelated = repo / "unrelated.txt"
                unrelated.write_text("initial\n")
                git("init", "-q", "-b", "main")
                git("config", "user.name", "Release Test")
                git("config", "user.email", "release@example.test")
                git("add", ".")
                git("commit", "-q", "-m", "Initial files")
                if case.startswith(("dirty-", "staged-")):
                    name = paths[0] if case.endswith("package") else paths[1]
                    target = repo / name
                    target.write_bytes(target.read_bytes() + b"\r\n")
                    if case.startswith("staged-"):
                        git("add", "--", name)
                if case == "commit":
                    unrelated.write_text("staged\n")
                    git("add", "unrelated.txt")
                    unrelated.write_text("unstaged\n")
                before = [(repo / name).read_bytes() for name in paths]
                status = git("status", "--porcelain")
                staged = git("diff", "--cached")
                unstaged = git("diff")
                requested = case if case in ("major", "minor", "patch", "1.10.0", "1.2.2", "1.2.3") else "patch"
                args = [PYTHON, "-I", str(repo / "scripts/bump_version.py"), requested]
                if case == "commit":
                    args.append("--commit")
                result = subprocess.run(args, cwd=self.root, env=self.env, text=True,
                                        capture_output=True, timeout=30)
                after = [(repo / name).read_bytes() for name in paths]
                if error:
                    self.assertNotEqual(result.returncode, 0, result.stdout)
                    self.assertIn(error, result.stderr)
                    self.assertEqual(after, before)
                    self.assertEqual(git("status", "--porcelain"), status)
                    self.assertEqual(git("diff", "--cached"), staged)
                    self.assertEqual(git("rev-list", "--count", "HEAD"), "1")
                    continue
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual((result.stdout, result.stderr), (expected + "\n", ""))
                self.assertEqual(after, [data.replace(b"1.2.3", expected.encode("ascii")) for data in before])
                self.assertEqual(git("diff", "--cached"), staged)
                self.assertEqual(git("rev-list", "--count", "HEAD"), "2" if case == "commit" else "1")
                if case == "commit":
                    self.assertEqual(git("show", "-s", "--format=%s"), "Release " + expected)
                    self.assertEqual(set(git("show", "--format=", "--name-only").splitlines()), set(paths))
                    self.assertEqual(git("diff"), unstaged)
                    self.assertEqual(git("status", "--porcelain"), status)

    def test_upgrade_installs_versions_side_by_side(self):
        self.release("9.0.0")
        preview = self.upgrade()
        self.assertIn("current: none -> 9.0.0", preview)
        self.assertIn("nothing changed", preview)
        self.assertFalse((self.data / "versions").exists())
        self.assertFalse((self.data / "bin").exists())

        self.assertIn("current is now 9.0.0", self.upgrade("--yes"))
        installed = self.data / "versions/9.0.0"
        self.assertEqual((installed / "src/teamster/__init__.py").read_text(),
                         (self.source / "src/teamster/__init__.py").read_text())
        self.assertEqual(self.current(), "9.0.0")
        current_main = self.data / "versions/current/src/teamster/__main__.py"
        for name in ("teamster", "codex-worker"):
            launcher = self.data / "bin" / name
            self.assertEqual(launcher.read_text(), "#!/bin/sh\nexec %s -I %s \"$@\"\n"
                             % (os.path.abspath(PYTHON), current_main))
            self.assertTrue(os.access(launcher, os.X_OK))
        self.assertEqual(self.cli("--version", command=[str(self.data / "bin/teamster")]), "9.0.0\n")
        # The whole process lives in the resolved version directory, not behind the current link.
        self.assertEqual(self.cli("path", command=[str(self.data / "bin/teamster")]),
                         str(installed / "src/teamster") + "\n")

        self.release("9.1.0")
        self.assertIn("current: 9.0.0 -> 9.1.0", self.upgrade())
        self.assertEqual(self.current(), "9.0.0")
        launchers = {name: (self.data / "bin" / name).stat().st_mtime_ns for name in ("teamster", "codex-worker")}
        output = self.upgrade("--yes")
        self.assertIn("current is now 9.1.0", output)
        self.assertNotIn("wrote launchers", output)
        self.assertEqual(launchers, {name: (self.data / "bin" / name).stat().st_mtime_ns for name in launchers})
        self.assertTrue((installed / "src/teamster/__main__.py").is_file())
        self.assertEqual(self.cli("--version", command=[str(self.data / "bin/codex-worker")]), "9.1.0\n")

        # The same revision again changes nothing; other contents under the same version are refused.
        self.assertIn("already installed with the same contents", self.upgrade("--yes"))
        self.release("9.1.0", extra="# changed without a version bump\n")
        refused = self.upgrade("--yes", code=1)
        self.assertIn("version 9.1.0 is already installed with different contents", refused)
        self.assertIn("must raise __version__", refused)
        self.assertNotIn("changed without", (self.data / "versions/9.1.0/src/teamster/__init__.py").read_text())
        self.assertEqual(sorted(os.listdir(self.data / "versions")), [".upgrade.lock", "9.0.0", "9.1.0", "current"])

        # Switching back replaces the link in one rename: current never disappears.
        worker = load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_switch_worker")
        link = self.data / "versions/current"
        real_replace = os.replace
        seen = []

        def replace(source, target):
            seen.append((Path(source).name, os.readlink(source), os.readlink(link)))
            return real_replace(source, target)

        with mock.patch.object(worker.installs.os, "replace", side_effect=replace):
            self.assertTrue(worker.installs.switch_current("9.0.0"))
        self.assertEqual(seen, [(".current.%d" % os.getpid(), "9.0.0", "9.1.0")])
        self.assertEqual(self.current(), "9.0.0")

    def test_drain_releases_and_versions_respect_live_supervisors(self):
        for version in ("9.0.0", "9.1.0"):
            self.release(version)
            self.upgrade("--yes")
        busy = self.fake_supervisor("busy-task", "9.0.0")
        listing = self.cli("versions")
        self.assertIn("  9.0.0\tbusy-task\t0 idle tasks pinned\n", listing)
        self.assertIn("* 9.1.0\tno live supervisors\t0 idle tasks pinned\n", listing)

        # A live supervisor does not block a release with the same data layout.
        self.release("9.2.0")
        self.assertIn("busy-task\t9.0.0", self.upgrade())
        self.upgrade("--yes")
        # 9.3.0 changes the data layout and 9.4.0 keeps it: jumping over 9.3.0 still waits for busy-task.
        self.release("9.3.0", layout=2)
        self.release("9.4.0", layout=2)
        self.assertIn("finish busy-task first", self.upgrade())
        refused = self.upgrade("--yes", code=1)
        self.assertIn("version 9.4.0 has data layout 2; stop or finish busy-task first", refused)
        self.assertEqual(self.current(), "9.2.0")
        self.assertFalse((self.data / "versions/9.4.0").exists())

        pruned = self.cli("versions", "--prune")
        self.assertIn("moved 9.1.0 to", pruned)
        self.assertEqual(sorted(name for name in os.listdir(self.data / "versions") if name[0] != "."),
                         ["9.0.0", "9.2.0", "current"])
        [trashed] = os.listdir(self.data / "versions/.trash")
        self.assertTrue(trashed.startswith("9.1.0-"))
        self.assertTrue((self.data / "versions/.trash" / trashed / "src/teamster/__main__.py").is_file())

        busy.kill()
        busy.wait()
        self.assertIn("current is now 9.4.0", self.upgrade("--yes"))
        pruned = self.cli("versions", "--prune")
        self.assertIn("moved 9.0.0 to", pruned)
        self.assertIn("moved 9.2.0 to", pruned)
        self.assertEqual(sorted(name for name in os.listdir(self.data / "versions") if name[0] != "."),
                         ["9.4.0", "current"])

    def test_supervisor_and_duty_job_from_current(self):
        self.release("9.0.0")
        self.upgrade("--yes")
        current = self.data / "versions/current/src/teamster/__main__.py"
        concrete = self.data / "versions/9.0.0/src/teamster/__main__.py"
        worker = load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_current_worker", script=current)
        self.assertEqual(worker.config.SCRIPT_RESOLVED, concrete)
        st = {"slug": "pinned", "worktree": str(self.root), "rotations": []}
        (worker.config.TASKS / "pinned").mkdir(parents=True)
        with mock.patch.object(worker.supervisor.subprocess, "Popen") as popen:
            popen.return_value.pid = 12345
            worker.supervisor.spawn(st, "Do the work.")
        self.assertEqual(popen.call_args.args[0][2:], [str(concrete), "_run", "pinned"])
        self.assertEqual(worker.commands.duty_launchd_plist(30)["ProgramArguments"],
                         [str(self.data / "bin/teamster"), "duty", "tick"])

        # An installed uv tool command keeps its own command in the job, and a start creates no versions/.
        tool = self.root / "tool/bin"
        tool.mkdir(parents=True)
        (tool / "teamster").write_text("#!/bin/sh\n")
        home = self.root / "tool-home"
        worker = load_worker({"TEAMSTER_HOME": str(home)}, name="versions_tool_worker")
        with mock.patch.object(worker.commands.sys, "executable", str(tool / "python")):
            self.assertEqual(worker.commands.duty_launchd_plist(30)["ProgramArguments"],
                             [str(tool / "teamster"), "duty", "tick"])
        (worker.config.TASKS / "pinned").mkdir(parents=True)
        with mock.patch.object(worker.supervisor.subprocess, "Popen") as popen:
            popen.return_value.pid = 12345
            worker.supervisor.spawn(dict(st, rotations=[]), "Do the work.")
        self.assertEqual(popen.call_args.args[0][2:], [str(SCRIPT), "_run", "pinned"])
        self.assertFalse((home / "versions").exists())

    def test_supervisor_start_holds_off_prune_and_layout_upgrades(self):
        for version in ("9.0.0", "9.1.0"):
            self.release(version)
            self.upgrade("--yes")
        self.release("9.2.0", layout=2)
        old = self.data / "versions/9.0.0/src/teamster/__main__.py"
        worker = load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_race_worker", script=old)
        real_popen = subprocess.Popen

        def start_during_spawn(slug, *args):
            """Run the command while spawn starts a supervisor from 9.0.0; return its exit code and output."""
            racing = []

            def popen(command, **kwargs):
                with (self.data / "versions/.lock").open("a") as lock, self.assertRaises(BlockingIOError):
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                racing.append(real_popen([PYTHON, "-I", str(SCRIPT), *args], cwd=self.root, env=self.env,
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
                time.sleep(2)
                fake = real_popen([PYTHON, "-c", "import time; time.sleep(120)", *command[2:]])
                self.addCleanup(fake.wait)
                self.addCleanup(fake.kill)
                return fake

            (worker.config.TASKS / slug).mkdir(parents=True)
            with mock.patch.object(worker.supervisor.subprocess, "Popen", side_effect=popen):
                fake = worker.supervisor.spawn({"slug": slug, "worktree": str(self.root), "rotations": []},
                                               "Do the work.")
            output = racing[0].communicate(timeout=120)[0]
            fake.kill()
            fake.wait()
            return racing[0].returncode, output

        code, output = start_during_spawn("pruning", "versions", "--prune")
        self.assertEqual((code, "nothing to prune" in output), (0, True), output)
        self.assertTrue(old.is_file())
        code, output = start_during_spawn("layout", "upgrade", "--source", str(self.source), "--ref", "main",
                                          "--yes")
        self.assertEqual(code, 1, output)
        self.assertIn("finish layout first", output)
        self.assertEqual(self.current(), "9.1.0")

        # Once its version is in the trash, a start from it refuses instead of running a missing file.
        self.assertIn("moved 9.0.0 to", self.cli("versions", "--prune"))
        late = worker.config.TASKS / "late"
        late.mkdir()
        state = {"slug": "late", "worktree": str(self.root), "rotations": [], "result": {"status": "done"}}
        for name, text in (("last.md", "last result\n"), ("review.md", "last review\n"),
                           ("state.json", json.dumps(state))):
            (late / name).write_text(text)

        def refused_start(worker, reason):
            """The start refuses before it touches the task: files, state.json and st stay as they were."""
            files = {name: (late / name).read_text() for name in ("last.md", "review.md", "state.json")}
            st = json.loads(json.dumps(state))
            with mock.patch.object(worker.supervisor.subprocess, "Popen") as popen, \
                    self.assertRaises(SystemExit) as refused:
                worker.supervisor.spawn(st, "Do the work.")
            self.assertIn(reason, str(refused.exception.code))
            popen.assert_not_called()
            self.assertEqual({name: (late / name).read_text() for name in files}, files)
            self.assertEqual(st, state)

        refused_start(worker, "no longer exists: its version was pruned")

        # A start from 9.1.0 after current moved to data layout 2 refuses instead of running layout 1 beside it.
        worker = load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_stale_worker",
                             script=self.data / "versions/9.1.0/src/teamster/__main__.py")
        self.assertIn("current is now 9.2.0", self.upgrade("--yes"))
        refused_start(worker, "with data layout 2, this command has layout 1")

    def test_launchers_use_the_base_interpreter_of_a_virtual_environment(self):
        cellar = self.root / "cellar/python3"
        cellar.parent.mkdir()
        cellar.write_text("#!/bin/sh\n")
        cellar.chmod(0o755)
        base = self.root / "base"
        (base / "bin").mkdir(parents=True)
        stable = base / "bin/python3"
        stable.symlink_to(cellar)
        venv = self.root / "venv"
        (venv / "bin").mkdir(parents=True)
        (venv / "bin/python").symlink_to(stable)
        worker = load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_venv_worker")
        system = worker.installs.sys

        def environment(base_prefix, base_executable):
            return mock.patch.multiple(system, executable=str(venv / "bin/python"), prefix=str(venv),
                                       base_prefix=str(base_prefix), _base_executable=str(base_executable))

        with environment(base, stable):
            worker.installs.write_launchers()
        # The base interpreter's own link is kept, so it survives updates of what it points to.
        self.assertIn("exec %s -I " % stable, (self.data / "bin/teamster").read_text())
        with environment(base, venv / "bin/python"):
            self.assertEqual(worker.installs.python(), str(stable))
        with environment(self.root / "missing", venv / "bin/python"), self.assertRaises(SystemExit) as refused:
            worker.installs.python()
        self.assertIn("run the upgrade with the system Python", str(refused.exception.code))


# Appended to 9.0.0: a re-run (TEAMSTER_PINNED set) waits right after exec until PIN_TEST_GATE exists.
PAUSE_AFTER_RERUN = """
import os as _os
import time as _time
if _os.environ.get("TEAMSTER_PINNED") and _os.environ.get("PIN_TEST_GATE"):
    open(_os.environ["PIN_TEST_GATE"] + ".paused", "w").close()
    while not _os.path.exists(_os.environ["PIN_TEST_GATE"]):
        _time.sleep(0.02)
"""


class PinnedTaskTests(RotationTestCase):
    """Two installed versions of this tree; the fake Codex runs the turns."""
    def setUp(self):
        super().setUp()
        self.source = self.root / "source"
        make_source(self.source, self.env)
        self.install("9.0.0", extra=PAUSE_AFTER_RERUN)
        self.install("9.1.0")
        self.gate = self.root / "turn-gate"
        self.gate.touch()
        self.account(self.home, "A", self.reset, runs=[
            {"mode": "complete", "delay_gate": str(self.gate), "reply": self.work_result()}])

    def install(self, version, layout=1, extra=""):
        release(self.source, self.env, version, layout, extra)
        self.cli("upgrade", "--source", str(self.source), "--ref", "main", "--yes", timeout=120)

    def main(self, version):
        return self.home / "versions" / version / "src/teamster/__main__.py"

    def run_version(self, command, *args, env=None):
        """Run a command through a version's __main__.py, or through the launcher when command is None."""
        argv = [str(self.home / "bin/teamster")] if command is None else [PYTHON, "-I", str(self.main(command))]
        result = subprocess.run(argv + list(args), cwd=self.repo, env=env or self.env, capture_output=True,
                                text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        for line in result.stdout.splitlines():
            pid = line.rpartition(", pid ")[2]
            if pid.isdigit():
                self.extra_pids.add(int(pid))
        return result.stdout

    def say(self, *args, env=None):
        """say through the launcher (current version); return its lines before "sent to"."""
        output = self.run_version(None, "say", "pin", "Continue the task.", *args, env=env)
        self.wait("pin")
        return output.splitlines()[:-1]

    def runtime(self, version):
        return {"version": version, "script": str(self.main(version).resolve())}

    def edit_state(self, **changes):
        state = self.state("pin")
        for key, value in changes.items():
            if value is None:
                state.pop(key, None)
            else:
                state[key] = value
        (self.home / "claude-tasks/pin/state.json").write_text(json.dumps(state))

    def test_say_runs_in_the_pinned_version_until_upgrade(self):
        self.run_version("9.0.0", "start", "pin", "--brief", str(self.brief), "--repo", str(self.repo))
        self.wait("pin")
        self.assertEqual(self.state("pin")["runtime"], self.runtime("9.0.0"))
        listing = self.run_version(None, "versions")
        self.assertIn("  9.0.0\tno live supervisors\t1 idle task pinned\n", listing)
        self.assertIn("* 9.1.0\tno live supervisors\t0 idle tasks pinned\n", listing)

        # say from the current version re-runs in 9.0.0, which starts its own supervisor.
        self.gate.unlink()
        output = self.run_version(None, "say", "pin", "Continue the task.")
        self.assertEqual(output.splitlines()[:-1], [])
        pid = self.state("pin")["pid"]
        command = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
        self.assertIn("%s _run pin" % self.main("9.0.0").resolve(), command)
        self.gate.touch()
        self.wait("pin")
        self.assertEqual((self.state("pin")["runtime"], self.state("pin")["turns"]), (self.runtime("9.0.0"), 2))

        self.assertEqual(self.say("--upgrade"), ["task pin moves from 9.0.0 to 9.1.0"])
        self.assertEqual(self.state("pin")["runtime"], self.runtime("9.1.0"))
        self.assertEqual(self.say(), [])
        self.assertEqual(self.state("pin")["runtime"], self.runtime("9.1.0"))

    def test_a_re_run_holds_off_prune_and_stops_after_an_upgrade(self):
        self.run_version("9.0.0", "start", "pin", "--brief", str(self.brief), "--repo", str(self.repo))
        self.wait("pin")
        gate = self.root / "rerun-gate"
        paused = Path(str(gate) + ".paused")

        def paused_say():
            """say through the launcher, paused in its re-run into 9.0.0."""
            if paused.exists():
                paused.unlink()
            say = subprocess.Popen([str(self.home / "bin/teamster"), "say", "pin", "Continue the task."],
                                   cwd=self.repo, env=dict(self.env, PIN_TEST_GATE=str(gate)),
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.until(paused.exists, timeout=30)
            return say

        # A say --upgrade that finishes while the re-run waits is not undone by it.
        say = paused_say()
        self.assertEqual(self.say("--upgrade"), ["task pin moves from 9.0.0 to 9.1.0"])
        gate.touch()
        stdout, stderr = say.communicate(timeout=60)
        self.assertEqual(say.returncode, 1, stdout + stderr)
        self.assertIn("task pin moved to 9.1.0 while this command started; run it again", stderr)
        self.assertEqual((self.state("pin")["runtime"], self.state("pin")["turns"]), (self.runtime("9.1.0"), 2))

        # Prune waits until the re-run into 9.0.0 has ended instead of moving the version under it.
        gate.unlink()
        self.edit_state(runtime=self.runtime("9.0.0"))
        say = paused_say()
        prune = subprocess.Popen([PYTHON, "-I", str(SCRIPT), "versions", "--prune"], cwd=self.repo, env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        time.sleep(1)
        self.assertIsNone(prune.poll())
        gate.touch()
        stdout, stderr = say.communicate(timeout=60)
        self.assertEqual((say.returncode, stderr), (0, ""), stdout)
        self.assertEqual(prune.wait(timeout=60), 0, prune.stdout.read())
        prune.stdout.close()
        self.wait("pin")
        self.assertEqual((self.state("pin")["runtime"], self.state("pin")["turns"]), (self.runtime("9.0.0"), 3))

    def test_say_moves_when_the_pinned_version_cannot_run(self):
        self.run_version("9.0.0", "start", "pin", "--brief", str(self.brief), "--repo", str(self.repo))
        self.wait("pin")
        self.assertIn("moved 9.0.0 to", self.run_version(None, "versions", "--prune"))
        self.assertEqual(self.say(), ["task pin moves from 9.0.0 to 9.1.0"])
        self.assertEqual(self.state("pin")["runtime"], self.runtime("9.1.0"))

        # A record from before runtime falls back to plugin_version; one without either is unknown.
        self.edit_state(runtime=None, plugin_version="1.20.0")
        self.assertEqual(self.say(), ["task pin moves from 1.20.0 to 9.1.0"])
        self.edit_state(runtime=None, plugin_version=None)
        self.assertEqual(self.say(), ["task pin moves from unknown to 9.1.0"])
        self.assertEqual(self.state("pin")["runtime"], self.runtime("9.1.0"))

        # versions/9.5.0 holds 9.1.0: after one re-run the version still differs, and it runs no further.
        shutil.copytree(self.main("9.1.0").parents[2], self.home / "versions/9.5.0")
        self.edit_state(runtime={"version": "9.5.0", "script": "/gone/__main__.py"})
        self.assertEqual(self.say(), ["task pin moves from 9.5.0 to 9.1.0"])
        self.assertEqual(self.state("pin")["runtime"],
                         {"version": "9.1.0", "script": str(self.main("9.5.0").resolve())})

        # A pinned version with another data layout than current's is not run.
        self.edit_state(runtime=self.runtime("9.1.0"))
        self.install("9.2.0", layout=2)
        self.assertEqual(self.say(), ["task pin moves from 9.1.0 to 9.2.0"])
        self.assertEqual(self.state("pin")["runtime"], self.runtime("9.2.0"))


if __name__ == "__main__":
    unittest.main()
