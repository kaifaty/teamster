"""Console entry point for the local board server."""

import argparse
import os
import plistlib
import sys
from pathlib import Path

from .app import LAYOUT_FILES, REPOSITORY, resolve_data_home

LAUNCHD_LABEL = "teamster.board"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787


def launchd_plist(host, port, teamster=None, read_only=False):
    """A launchd job that keeps the board running; printing it never installs or loads anything."""
    task_home, layout = resolve_data_home()
    # launchd starts the job in WorkingDirectory: relative homes must not change meaning there.
    task_home = Path(os.path.abspath(task_home))
    environment = {"PATH": os.pathsep.join(["/opt/homebrew/bin", "/usr/local/bin", str(Path.home() / ".local/bin"),
                                            "/usr/bin", "/bin", "/usr/sbin", "/sbin"])}
    if layout == "legacy":
        environment["CODEX_TASK_HOME"] = str(task_home)
    else:
        environment["TEAMSTER_HOME"] = str(task_home)
        codex_home = (os.environ.get("TEAMSTER_CODEX_HOME") if os.environ.get("TEAMSTER_HOME") else None)
        codex_home = codex_home or os.environ.get("CODEX_TASK_HOME")
        if codex_home:
            # The accounts command the board runs still needs a non-default Codex home.
            environment["TEAMSTER_CODEX_HOME"] = os.path.abspath(Path(codex_home).expanduser())
    environment.update((key, value) for key, value in os.environ.items() if key.startswith("BOARD_"))
    # The venv interpreter is a symlink; its own directory holds the console script.
    command = Path(sys.executable).parent / "teamster-board"
    options = ["--host", host, "--port", str(port)]
    if teamster is not None:
        options.extend(["--teamster", str(Path(teamster).expanduser().absolute())])
    if read_only:
        options.append("--read-only")
    program = [str(command)] + options if command.is_file() else [sys.executable, "-m", "teamster_board"] + options
    log = str(task_home / LAYOUT_FILES[layout]["board_log"])
    return {"Label": LAUNCHD_LABEL, "ProgramArguments": program, "WorkingDirectory": str(REPOSITORY),
            "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10,
            "EnvironmentVariables": environment, "StandardOutPath": log, "StandardErrorPath": log}


def add_address(parser):
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--teamster", metavar="PATH", help="installed teamster for science station actions")
    parser.add_argument("--read-only", action="store_true", help="disable science station actions")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local teamster task board")
    add_address(parser)
    commands = parser.add_subparsers(dest="command")
    plist = commands.add_parser("plist", help="print a launchd job that keeps the board running")
    add_address(plist)
    args = parser.parse_args(argv)
    if args.command == "plist":
        sys.stdout.write(plistlib.dumps(launchd_plist(args.host, args.port, args.teamster, args.read_only)).decode("utf-8"))
        return
    import uvicorn

    from .app import Settings, create_app

    settings = Settings.from_env()
    if args.teamster is not None:
        settings.action_teamster = str(Path(args.teamster).expanduser())
    settings.read_only = args.read_only
    uvicorn.run(create_app(settings), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
