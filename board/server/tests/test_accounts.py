"""The accounts subprocess is fake, isolated, rate limited and nonblocking."""

import asyncio
import json
from types import SimpleNamespace

import pytest

from teamster_board import accounts as accounts_module
from teamster_board.accounts import Accounts, Reports


def write_script(path, body):
    path.write_text(
        "import sys\nassert sys.flags.isolated\n"
        "assert sys.argv[1:] == ['accounts', '--json']\n" + body
    )


def test_accounts_success_and_rate_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    script = tmp_path / "accounts.py"
    marker = tmp_path / "calls"
    payload = {"accounts": [{"name": "fake", "remaining": 42}], "extra": [None, True]}
    write_script(script, f"from pathlib import Path\nPath({str(marker)!r}).open('a').write('call\\n')\n"
                 f"print({json.dumps(payload)!r})\n")

    async def check():
        accounts = Accounts(script, 300)
        assert accounts.value == {"fetched_at": None, "error": None, "data": None}
        result = await accounts.refresh()
        assert result["data"] == payload
        assert result["error"] is None
        assert isinstance(result["fetched_at"], float)
        assert await accounts.refresh() is None
        assert marker.read_text().splitlines() == ["call"]

    asyncio.run(check())


def test_accounts_error_and_timeout_keep_previous_data(tmp_path, monkeypatch):
    monkeypatch.setenv("CODEX_TASK_HOME", str(tmp_path))
    script = tmp_path / "accounts.py"
    write_script(script, "print('{\"cached\": [1, 2]}')\n")

    async def check():
        accounts = Accounts(script, 0)
        first = await accounts.refresh()
        assert first["error"] is None
        write_script(script, "print('fake accounts failure', file=sys.stderr)\nsys.exit(7)\n")
        failed = await accounts.refresh()
        assert failed["error"] == "accounts exited with status 7"
        assert failed["data"] == first["data"]
        monkeypatch.setattr(accounts_module, "ACCOUNTS_TIMEOUT", 0.2)
        write_script(script, "import time\ntime.sleep(30)\n")
        pending = asyncio.create_task(accounts.refresh())
        # A subprocess waiting for timeout must leave the event loop responsive.
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.1)
        assert not pending.done()
        timed_out = await asyncio.wait_for(pending, timeout=10)
        assert "timed out" in timed_out["error"]
        assert "0.2" in timed_out["error"]
        assert timed_out["data"] == first["data"]

    asyncio.run(check())


def test_reports_arguments_and_cache_per_pair(tmp_path, monkeypatch):
    script, marker = tmp_path / "report.py", tmp_path / "calls"
    script.write_text(
        "import json, sys\nfrom pathlib import Path\nassert sys.flags.isolated\n"
        "assert sys.argv[1:3] == ['report', '--json']\n"
        f"Path({str(marker)!r}).open('a').write(json.dumps(sys.argv[3:]) + '\\n')\n"
        "print(json.dumps({'args': sys.argv[3:]}))\n"
    )
    clock = [100.0]
    monkeypatch.setattr(accounts_module, "time", SimpleNamespace(
        monotonic=lambda: clock[0], time=lambda: 1000.0 + clock[0],
    ))

    async def check():
        reports = Reports(script)
        first = await reports.get("2026-11-08")
        assert first == {"fetched_at": 1100.0, "error": None,
                         "data": {"args": ["--since", "2026-11-08"]}}
        assert await reports.get("2026-11-08") is first
        grouped = await reports.get("2026-11-08", "task-type,effort,model,executor,reviewer")
        assert grouped["data"]["args"] == [
            "--since", "2026-11-08", "--by", "task-type,effort,model,executor,reviewer",
        ]
        await reports.get("2026-11-07")
        assert len(marker.read_text().splitlines()) == 3
        clock[0] = 159.9
        assert await reports.get("2026-11-08") is first
        clock[0] = 160.0
        assert (await reports.get("2026-11-08"))["fetched_at"] == 1160.0
        assert len(marker.read_text().splitlines()) == 4

    asyncio.run(check())


@pytest.mark.parametrize("since,by", [
    ("2026-1-01", None), ("2026-11-08;touch marker", None),
    ("2026-11-08", "model,unknown"), ("2026-11-08", "model,"),
])
def test_reports_reject_invalid_arguments_before_start(tmp_path, since, by):
    # Even a missing executable must not be reached for invalid arguments.
    with pytest.raises(ValueError):
        asyncio.run(Reports(tmp_path / "missing.py").get(since, by))


def test_reports_bound_stdout_and_keep_stderr_in_logs(tmp_path, caplog):
    script = tmp_path / "report.py"
    script.write_text("import sys\nprint('private diagnostic', file=sys.stderr)\nsys.exit(7)\n")

    async def check():
        failed = await Reports(script).get("2026-11-08")
        assert failed["error"] == "report exited with status 7"
        assert failed["data"] is None
        assert "private diagnostic" not in json.dumps(failed)
        assert "private diagnostic" in caplog.text
        script.write_text("import sys\nsys.stdout.write('x' * (2 * 1024 * 1024))\n")
        oversized = await asyncio.wait_for(Reports(script).get("2026-11-08"), timeout=10)
        assert oversized["error"] == "output exceeds 1 MiB"
        assert oversized["data"] is None

    asyncio.run(check())
