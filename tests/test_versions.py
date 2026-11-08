"""Side-by-side installs through upgrade and versions, from a local repository and temporary homes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
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

    def release(self, version, drain=False, extra=""):
        init = self.source / "src/teamster/__init__.py"
        text = (ROOT / "src/teamster/__init__.py").read_text(encoding="utf-8")
        text = text.replace('__version__ = "%s"' % self.worker_version(), '__version__ = "%s"' % version)
        text = text.replace("REQUIRES_DRAIN = False", "REQUIRES_DRAIN = %s" % drain) + extra
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
        self.assertEqual(sorted(os.listdir(self.data / "versions")), [".lock", "9.0.0", "9.1.0", "current"])

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

        # Without REQUIRES_DRAIN a live supervisor does not block the upgrade.
        self.release("9.2.0")
        self.assertIn("busy-task\t9.0.0", self.upgrade())
        self.upgrade("--yes")
        self.release("9.3.0", drain=True)
        self.assertIn("requires drained tasks", self.upgrade())
        refused = self.upgrade("--yes", code=1)
        self.assertIn("finish busy-task first", refused)
        self.assertEqual(self.current(), "9.2.0")
        self.assertFalse((self.data / "versions/9.3.0").exists())

        pruned = self.cli("versions", "--prune")
        self.assertIn("moved 9.1.0 to", pruned)
        self.assertEqual(sorted(name for name in os.listdir(self.data / "versions") if name[0] != "."),
                         ["9.0.0", "9.2.0", "current"])
        [trashed] = os.listdir(self.data / "versions/.trash")
        self.assertTrue(trashed.startswith("9.1.0-"))
        self.assertTrue((self.data / "versions/.trash" / trashed / "src/teamster/__main__.py").is_file())

        busy.kill()
        busy.wait()
        self.assertIn("current is now 9.3.0", self.upgrade("--yes"))
        pruned = self.cli("versions", "--prune")
        self.assertIn("moved 9.0.0 to", pruned)
        self.assertIn("moved 9.2.0 to", pruned)
        self.assertEqual(sorted(name for name in os.listdir(self.data / "versions") if name[0] != "."),
                         ["9.3.0", "current"])

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

        # An installed uv tool command keeps its own command in the job.
        tool = self.root / "tool/bin"
        tool.mkdir(parents=True)
        (tool / "teamster").write_text("#!/bin/sh\n")
        worker = load_worker({"TEAMSTER_HOME": str(self.data)}, name="versions_tool_worker")
        with mock.patch.object(worker.commands.sys, "executable", str(tool / "python")):
            self.assertEqual(worker.commands.duty_launchd_plist(30)["ProgramArguments"],
                             [str(tool / "teamster"), "duty", "tick"])


if __name__ == "__main__":
    unittest.main()
