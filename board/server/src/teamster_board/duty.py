"""Quick duty commands through the installed teamster executable."""

import json
import subprocess
from pathlib import Path

from . import actions


class Duty:
    def __init__(self, action_commands):
        self.actions = action_commands

    def reason(self):
        if self.actions.reason is not None:
            return self.actions.reason
        return None if self.actions.duty_choose() else "old_teamster"

    def execute(self, arguments):
        reason = self.reason()
        if reason is not None:
            return actions.error(409 if reason == "old_teamster" else 403, reason)
        argv = [self.actions.command, "duty", *arguments]
        try:
            result = subprocess.run(
                argv, stdin=subprocess.DEVNULL, capture_output=True,
                encoding="utf-8", errors="replace", timeout=actions.COMMAND_TIMEOUT,
                cwd=Path.home(),
            )
        except subprocess.TimeoutExpired:
            actions.LOGGER.info("/api/actions/duty argv=%s exit=timeout", json.dumps(argv))
            return actions.error(504, "timeout")
        except OSError as exc:
            actions.LOGGER.info("/api/actions/duty argv=%s exit=unavailable", json.dumps(argv))
            return actions.error(422, str(exc)[-2000:])
        actions.LOGGER.info("/api/actions/duty argv=%s exit=%s", json.dumps(argv), result.returncode)
        if result.returncode:
            return actions.error(422, (result.stderr.strip() or result.stdout.strip())[-2000:]
                                 or f"teamster exited with {result.returncode}")
        warnings = [line for line in result.stdout.splitlines() if line.lstrip().lower().startswith("warning:")]
        if result.stderr.strip():
            warnings.append(result.stderr.strip())
        return {"ok": True, "warning": "\n".join(warnings)[-2000:] or None}
