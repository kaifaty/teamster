"""Shared board test settings."""

import os

import pytest


@pytest.fixture(autouse=True)
def no_inherited_data_home(monkeypatch):
    # TEAMSTER_HOME takes precedence over the temporary CODEX_TASK_HOME the tests set.
    monkeypatch.delenv("TEAMSTER_HOME", raising=False)
    monkeypatch.delenv("TEAMSTER_CODEX_HOME", raising=False)
    monkeypatch.delenv("BOARD_TEAMSTER_COMMAND", raising=False)


@pytest.fixture(autouse=True)
def fake_teamster_on_path(tmp_path_factory, monkeypatch):
    # The default action command is `teamster` from PATH; task details ask its version, never the installed one's.
    directory = tmp_path_factory.mktemp("bin")
    command = directory / "teamster"
    command.write_text("#!/bin/sh\necho 1.59.0\n")
    command.chmod(0o755)
    monkeypatch.setenv("PATH", f"{directory}{os.pathsep}{os.environ.get('PATH', '')}")
