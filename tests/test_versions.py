"""Side-by-side installs through upgrade and versions, from a local repository and temporary homes."""
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock


# Isolated Python omits the script directory from its import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from worker_loader import load_worker


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "src/teamster/__main__.py"
PYTHON = sys.executable


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
        shutil.copytree(ROOT / "src", self.source / "src", ignore=shutil.ignore_patterns("__pycache__"))
        self.git("init", "-q", "-b", "main")

    def git(self, *args):
        return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args],
                              cwd=self.source, env=self.env, check=True, capture_output=True, text=True).stdout

    def release(self, version, layout=1, extra=""):
        init = self.source / "src/teamster/__init__.py"
        text = (ROOT / "src/teamster/__init__.py").read_text(encoding="utf-8")
        text = text.replace('__version__ = "%s"' % self.worker_version(), '__version__ = "%s"' % version)
        text = text.replace("DATA_LAYOUT = 1", "DATA_LAYOUT = %d" % layout) + extra
        init.write_text(text, encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", version)

    def worker_version(self):
        return load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_worker").config.plugin_version()

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
        self.assertIn("  9.0.0\tbusy-task\n", listing)
        self.assertIn("* 9.1.0\tno live supervisors\n", listing)

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
        (worker.config.TASKS / "late").mkdir()
        with mock.patch.object(worker.supervisor.subprocess, "Popen") as popen, \
                self.assertRaises(SystemExit) as refused:
            worker.supervisor.spawn({"slug": "late", "worktree": str(self.root), "rotations": []}, "Do the work.")
        self.assertIn("no longer exists: its version was pruned", str(refused.exception.code))
        popen.assert_not_called()

        # A start from 9.1.0 after current moved to data layout 2 refuses instead of running layout 1 beside it.
        worker = load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_stale_worker",
                             script=self.data / "versions/9.1.0/src/teamster/__main__.py")
        self.assertIn("current is now 9.2.0", self.upgrade("--yes"))
        with mock.patch.object(worker.supervisor.subprocess, "Popen") as popen, \
                self.assertRaises(SystemExit) as refused:
            worker.supervisor.spawn({"slug": "late", "worktree": str(self.root), "rotations": []}, "Do the work.")
        self.assertIn("with data layout 2, this command has layout 1", str(refused.exception.code))
        popen.assert_not_called()

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


if __name__ == "__main__":
    unittest.main()
