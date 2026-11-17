#!/usr/bin/env python3
"""Claude Code PreToolUse hook for the Bash tool of writable Claude turns.

Usage: python3 -I bash_guard.py [--duty-room ROOM] < hook-event.json

It rejects commands that start a process in the background or kill processes
by name or pattern: exit status 2 with the reason on stderr, which Claude Code
shows to the model. Every other command, and unreadable input, exits 0. The
shell text is only tokenized, never run. Runs by path and never imports the
package.

With --duty-room it guards a duty chat turn and fails closed: each simple
command of the text must be on the duty allowlist (git only with switches
that keep the repository's config from running programs), shell expansions
are refused, and redirections and the file tools (Write, Edit, MultiEdit,
NotebookEdit) may write only inside ROOM, outside its .git.
"""
import json
import os
import re
import sys

BACKGROUND = frozenset({"nohup", "setsid", "disown", "coproc"})
PATTERN_KILLS = frozenset({"pkill", "killall"})
PROCESS_LOOKUPS = frozenset({"pgrep", "pidof"})
SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh"})
KEYWORDS = frozenset({"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac"})
# Words of these commands up to the next separator are not commands.
NO_COMMAND = frozenset({"for", "select", "case", "in"})
# Commands that run their arguments as a command: options that take a value, then operands before it.
WRAPPERS = {
    "sudo": ({"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"}, 0),
    "env": ({"-u", "-C", "-P"}, 0),
    "command": (set(), 0), "builtin": (set(), 0), "exec": ({"-a"}, 0), "time": (set(), 0),
    "nice": ({"-n"}, 0), "stdbuf": ({"-i", "-o", "-e"}, 0), "caffeinate": ({"-t", "-w"}, 0),
    "timeout": ({"-s", "-k", "--signal", "--kill-after"}, 1),
    "gtimeout": ({"-s", "-k", "--signal", "--kill-after"}, 1),
    "xargs": ({"-I", "-J", "-L", "-n", "-P", "-R", "-S", "-s", "-d", "-E", "-a"}, 0),
    "nohup": (set(), 0), "setsid": (set(), 0),
}
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?=")
SHELL_SCRIPT_OPTION = re.compile(r"-[A-Za-z]*c[A-Za-z]*")
SUBSTITUTION = "$()"
# The characters after a $ that start a parameter expansion.
EXPANSION_START = re.compile(r"[A-Za-z0-9_@*#?$!-]")

BACKGROUND_REASON = (
    "Blocked by teamster: this command starts a process in the background (`nohup`, `setsid`, "
    "`disown`, `coproc` or a lone `&`). This headless turn can end before that process does, and "
    "nothing reports its result back to you.")
KILL_REASON = (
    "Blocked by teamster: this command kills processes by name or pattern (`pkill`, `killall`, or "
    "`kill` of PIDs that `pgrep` or `pidof` found). A pattern also matches this turn's own shell and "
    "other agents' processes on this shared machine.")


def advice():
    """What to do instead, with this turn's Bash timeout limit when Claude Code passed it on."""
    limit = os.environ.get("BASH_MAX_TIMEOUT_MS", "")
    cap = f" (up to {int(limit) // 60000} minutes in this turn)" if limit.isdecimal() and int(limit) >= 60000 else ""
    return (" Run a long command in the foreground and set the Bash tool's `timeout` parameter"
            f"{cap} so that it can finish. Stop only processes whose PIDs you recorded yourself, "
            "with `kill <PID>`. Commit your work before any command that may run longer than 10 minutes.")


def command_names(words, shell):
    """Return the names a simple command of ``shell`` runs, wrappers first, and the index of the last name."""
    names, index, last = [], 0, -1
    while index < len(words) and (words[index] in KEYWORDS or words[index] == "function"):
        # `function NAME` precedes a body whose commands may follow on the same line.
        index += 2 if words[index] == "function" else 1
    if index < len(words) and words[index] in NO_COMMAND:
        return names, last
    while index < len(words):
        while index < len(words) and ASSIGNMENT.match(words[index]):
            index += 1
        if index == len(words):
            break
        name = words[index].rsplit("/", 1)[-1]
        names.append(name)
        last = index
        if name not in WRAPPERS:
            break
        valued, operands = WRAPPERS[name]
        index += 1
        while index < len(words) and words[index].startswith("-") and words[index] != "-":
            option = words[index]
            index += 1
            if option == "--":
                break
            if name == "command" and option in ("-v", "-V"):
                return names, last  # It only describes the next name.
            if name == "env" and option == "-S" and index < len(words):
                # env -S splits its value into a command; the words after the value are its arguments.
                return names + shell.nested(words[index], words[index + 1:]), len(words)
            if option in valued:
                index += 1
        index += operands
    return names, last


class Shell:
    """Collect the command names and lone `&` operators of shell text, substitutions included."""

    def __init__(self, text, arguments=()):
        self.text = text
        # Words that extend the last simple command of the text, never parsed as code.
        self.arguments = list(arguments)
        self.pos = 0
        self.heredocs = []
        self.names = []
        self.background = False
        self.pattern_kill = False
        # The duty guard judges every simple command and every redirection target.
        self.commands = []
        self.targets = []
        self.operator = ""
        # Expansions, arithmetic, globs, braces and heredoc bodies that expand: none is a literal word.
        self.expansions = 0

    def peek(self, offset=0):
        index = self.pos + offset
        return self.text[index] if index < len(self.text) else ""

    def starts(self, *prefixes):
        return self.text.startswith(prefixes, self.pos)

    def nested(self, text, arguments=()):
        """Parse a script this shell runs and return its command names."""
        inner = Shell(text, arguments)
        inner.parse()
        self.names += inner.names
        self.background = self.background or inner.background
        self.pattern_kill = self.pattern_kill or inner.pattern_kill
        self.commands += inner.commands
        self.targets += inner.targets
        self.expansions += inner.expansions
        return inner.names

    def end(self, words, mark, piped=False):
        """Record a finished simple command and the script a shell, eval or trap runs.

        Names from ``mark`` on belong to this command's substitutions and to the
        earlier commands of its pipeline. Returns the next command's words and mark.
        """
        found = set(self.names[mark:])
        if words:
            self.commands.append((list(words), piped))
        names, last = command_names(words, self)
        if "kill" in names and found & PROCESS_LOOKUPS:
            self.pattern_kill = True
        self.names += names
        if names and names[-1] in SHELLS:
            arguments = words[last + 1:]
            for position, word in enumerate(arguments[:-1]):
                if SHELL_SCRIPT_OPTION.fullmatch(word):
                    self.nested(arguments[position + 1])
                    break
        elif names and names[-1] == "eval":
            self.nested(" ".join(words[last + 1:]))
        elif names and names[-1] == "trap":
            arguments = words[last + 1:]
            arguments = arguments[1:] if arguments[:1] == ["--"] else arguments
            if arguments and not arguments[0].startswith("-"):
                self.nested(arguments[0])
        return [], len(self.names)

    def parse(self, closer=None):
        """Read a command list up to EOF or, inside `$(`, its closing parenthesis."""
        words, depth, target, mark = [], 0, False, len(self.names)
        piped = False
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char in " \t":
                self.pos += 1
            elif self.starts("\\\n"):
                self.pos += 2
            elif char == "\n":
                self.pos += 1
                if words:
                    words, mark = self.end(words, mark, piped)
                    piped = False
                self.read_heredocs()
            elif char == "#":
                while self.pos < len(self.text) and self.text[self.pos] != "\n":
                    self.pos += 1
            elif char == ";":
                # `;;`, `;&` and `;;&` end case items.
                self.pos += 3 if self.starts(";;&") else 2 if self.starts(";;", ";&") else 1
                words, mark = self.end(words, mark, piped)
                piped = False
            elif char == "&":
                if self.starts("&&"):
                    self.pos += 2
                    words, mark = self.end(words, mark, piped)
                    piped = False
                elif self.starts("&>"):
                    self.operator = "&>>" if self.starts("&>>") else "&>"
                    self.pos += len(self.operator)
                    target = True
                else:
                    self.pos += 1
                    self.background = True
                    words, mark = self.end(words, mark, piped)
                    piped = False
            elif char == "|":
                pipe = not self.starts("||")
                self.pos += 2 if self.starts("||", "|&") else 1
                words, next_mark = self.end(words, mark, piped)
                piped = pipe
                # Later commands of a pipeline may kill the PIDs that earlier ones found.
                mark = mark if pipe else next_mark
            elif char == "(":
                self.pos += 1
                if not words and self.peek() == "(":
                    self.pos += 1
                    self.expansions += 1
                    self.skip_arithmetic()
                else:
                    depth += 1
                    words, mark = self.end(words, mark, piped)
                    piped = False
            elif char == ")":
                self.pos += 1
                words, mark = self.end(words, mark, piped)
                piped = False
                if depth:
                    depth -= 1
                elif closer == ")":
                    return
            elif char in "<>" and self.peek(1) != "(":
                if char == "<":
                    piped = False
                target = self.redirect()
            else:
                start = self.pos
                word, quoted = self.read_word()
                if self.pos == start:
                    self.pos += 1
                elif not quoted and word.isdigit() and self.starts("<", ">"):
                    pass  # The file descriptor of a redirection.
                elif target:
                    self.targets.append((self.operator, word))
                    target = False
                else:
                    words.append(word)
        self.end(words + self.arguments if closer is None else words, mark, piped)

    def redirect(self):
        """Skip a redirection operator; return whether a target word follows it."""
        if self.starts("<<<"):
            self.operator = "<<<"
            self.pos += 3
            return True
        if self.starts("<<"):
            self.pos += 2
            strip = self.peek() == "-"
            self.pos += strip
            while self.peek() in (" ", "\t"):
                self.pos += 1
            delimiter, quoted = self.read_word()
            self.heredocs.append((delimiter, strip, quoted))
            return False
        self.operator = next(operator for operator in ("<>", ">>", ">|", ">&", "<&", ">", "<")
                             if self.starts(operator))
        self.pos += len(self.operator)
        return True

    def read_heredocs(self):
        for delimiter, strip, quoted in self.heredocs:
            while self.pos < len(self.text):
                end = self.text.find("\n", self.pos)
                end = len(self.text) if end < 0 else end
                line = self.text[self.pos:end]
                self.pos = end + 1
                if (line.lstrip("\t") if strip else line) == delimiter:
                    break
                if not quoted and ("$" in line or "`" in line):
                    # The body of an unquoted delimiter expands like double quotes.
                    self.expansions += 1
        self.heredocs = []

    def read_word(self):
        """Return a word without its quotes, and whether any part of it was quoted."""
        value, quoted = [], False
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char in "<>" and not value and self.peek(1) == "(":
                self.pos += 2
                self.parse(")")
                value.append(SUBSTITUTION)
            elif char in " \t\n;&|()<>":
                break
            elif char == "\\":
                if self.peek(1) != "\n":
                    value.append(self.peek(1))
                    quoted = True
                self.pos += 2
            elif char == "'":
                end = self.text.find("'", self.pos + 1)
                end = len(self.text) if end < 0 else end
                value.append(self.text[self.pos + 1:end])
                self.pos = end + 1
                quoted = True
            elif char == '"':
                self.pos += 1
                value.append(self.double_quoted())
                quoted = True
            elif char == "`":
                self.pos += 1
                self.backticks()
                value.append(SUBSTITUTION)
            elif char == "$":
                if self.starts("$'"):
                    # The guard does not decode escapes such as \x2f: the duty refuses the word.
                    self.expansions += 1
                    value.append(self.ansi_c())
                    quoted = True
                else:
                    value.append(self.dollar())
            else:
                if char in "*?[]{}":
                    # Unquoted globs and braces expand into words the guard never sees.
                    self.expansions += 1
                value.append(char)
                self.pos += 1
        return "".join(value), quoted

    def double_quoted(self):
        value = []
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char == '"':
                self.pos += 1
                break
            if char == "\\" and self.peek(1) in ("$", "`", '"', "\\", "\n"):
                value.append(self.peek(1) if self.peek(1) != "\n" else "")
                self.pos += 2
            elif char == "`":
                self.pos += 1
                self.backticks()
                value.append(SUBSTITUTION)
            elif char == "$":
                value.append(self.dollar())
            else:
                value.append(char)
                self.pos += 1
        return "".join(value)

    def ansi_c(self):
        self.pos += 2
        value = []
        while self.pos < len(self.text) and self.text[self.pos] != "'":
            if self.text[self.pos] == "\\":
                value.append(self.peek(1))
                self.pos += 2
            else:
                value.append(self.text[self.pos])
                self.pos += 1
        self.pos += 1
        return "".join(value)

    def dollar(self):
        """Read one expansion; parse the commands of a command substitution."""
        if self.peek(1) in ("(", "{") or EXPANSION_START.match(self.peek(1)):
            self.expansions += 1
        if self.starts("$(("):
            self.pos += 3
            self.skip_arithmetic()
            return SUBSTITUTION
        if self.starts("$("):
            self.pos += 2
            self.parse(")")
            return SUBSTITUTION
        if self.starts("${"):
            self.pos += 2
            depth = 1
            while self.pos < len(self.text) and depth:
                if self.starts("$(") and not self.starts("$(("):
                    self.pos += 2
                    self.parse(")")
                    continue
                char = self.text[self.pos]
                depth += {"{": 1, "}": -1}.get(char, 0)
                self.pos += 2 if char == "\\" else 1
            return SUBSTITUTION
        self.pos += 1
        return "$"

    def skip_arithmetic(self):
        depth = 2
        while self.pos < len(self.text) and depth:
            depth += {"(": 1, ")": -1}.get(self.text[self.pos], 0)
            self.pos += 1

    def backticks(self):
        self.expansions += 1
        chars = []
        while self.pos < len(self.text) and self.text[self.pos] != "`":
            if self.text[self.pos] == "\\" and self.peek(1) in ("`", "\\", "$"):
                chars.append(self.peek(1))
                self.pos += 2
            else:
                chars.append(self.text[self.pos])
                self.pos += 1
        self.pos += 1
        self.nested("".join(chars))


def denial(command):
    """Return why the hook rejects a Bash command, or None to let it run."""
    shell = Shell(command)
    shell.parse()
    names = set(shell.names)
    if shell.background or names & BACKGROUND:
        return BACKGROUND_REASON + advice()
    if names & PATTERN_KILLS or shell.pattern_kill:
        return KILL_REASON + advice()
    return None


# The duty chat's allowlist: teamster commands, read-only git and gh, and plain readers.
# Each teamster command takes only these exact option names: argparse would expand an abbreviation
# such as --ci-comm into --ci-command, whose shell command the supervisor runs outside the hook.
DUTY_TEAMSTER = {
    "start": frozenset({"--brief", "--repo", "--base", "--branch", "--no-push", "--executor", "--effort", "--model",
                        "--review-model", "--task-type", "--parallel", "--sandbox", "--max-minutes", "--max-weekly",
                        "--review", "--reviewer", "--review-angles", "--fix-rounds", "--ci", "--ci-rounds",
                        "--check-timeout", "--guard", "--base-check"}),
    "say": frozenset({"--file", "--effort", "--model", "--review-model", "--task-type", "--max-minutes",
                      "--max-weekly", "--review", "--reviewer", "--review-angles", "--fix-rounds", "--ci", "--no-ci",
                      "--no-ci-command", "--ci-rounds", "--no-check", "--check-timeout", "--no-base-check",
                      "--upgrade", "--queue"}),
    "scout": frozenset({"--file", "--repo", "--executor", "--effort"}),
    "review": frozenset({"--effort", "--review-model", "--max-weekly", "--reviewer", "--review-angles"}),
    "stop": frozenset(), "status": frozenset(), "docs": frozenset(),
    "wait": frozenset({"--timeout", "--through-sleep"}),
    "report": frozenset({"--since", "--repo", "--slug", "--by", "--json"}),
    "accounts": frozenset({"--json", "--refresh"}),
}
DUTY_HELP = frozenset({"-h", "--help"})
# Commands on the duty conversation itself, which only the user sends.
DUTY_SELF = frozenset({"say", "stop", "review", "wait"})
DUTY_SLUG = "duty"
DUTY_GIT = frozenset({"log", "show", "diff", "ls-files", "grep"})
# Before its subcommand every git command turns off the pager, the fsmonitor hook and the hooks
# that the repository's config may name: the repository's config is not the duty's to trust.
DUTY_GIT_PREFIX = "git --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null"
DUTY_GIT_SETTINGS = {"core.fsmonitor": "false", "core.hookspath": "/dev/null"}
# log, show and diff also turn off external diffs, textconv, signature checks (gpg.program) and submodule diffs.
DUTY_GIT_DIFF_FLAGS = ("--no-ext-diff", "--no-textconv", "--no-show-signature", "--submodule=short")
# Options, and every abbreviation of them, that run a program, write a file or read through the repository's filters.
DUTY_GIT_REFUSED = ("--ext-diff", "--textconv", "--show-signature", "--output", "--open-files-in-pager", "--no-index",
                    "--submodule", "--recurse-submodules")
DUTY_GIT_LS_FILES = frozenset({"-z", "-s", "--stage", "--cached", "--full-name", "--error-unmatch", "--"})
# diff takes only options without a separate value, so every other word before -- is a revision.
DUTY_GIT_DIFF_OPTIONS = frozenset(DUTY_GIT_DIFF_FLAGS) | {
    "--cached", "--staged", "--merge-base", "--stat", "--numstat", "--shortstat", "--name-only", "--name-status",
    "--summary", "-p", "--patch", "-w", "--ignore-all-space", "--no-color"}
DUTY_GIT_DIFF_VALUES = ("--stat=", "--unified=", "--diff-filter=", "-U")
# log and show name their format, so that format.pretty from the config (with %G, which runs gpg) never applies.
DUTY_GIT_FORMATS = frozenset({"oneline", "short", "medium", "full", "fuller", "reference", "raw"})
DUTY_GH = {"pr": frozenset({"view", "diff", "checks", "list"}), "run": frozenset({"view", "list"})}
DUTY_READERS = frozenset({"ls", "cat", "head", "tail", "wc", "rg"})
# Only readers may consume work from stdin: Codex can send input to an approved process.
DUTY_STDIN_PATHS = frozenset({"/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"})
# Options that make rg run another program.
DUTY_RG_OPTIONS = ("--pre", "--hostname-bin")
OUTPUT_REDIRECTIONS = frozenset({">", ">>", ">|", "&>", "&>>", "<>", ">&"})
FILE_TOOLS = {"Write": "file_path", "Edit": "file_path", "MultiEdit": "file_path", "NotebookEdit": "notebook_path"}
DUTY_ALLOWED = (
    "`teamster start|say|scout|review|stop|status|wait|report|docs|accounts` and `teamster duty status` "
    "with their exact option names; `" + DUTY_GIT_PREFIX + " [-C <path>] log|show|diff|ls-files|grep`, where "
    "log, show and diff also take `" + " ".join(DUTY_GIT_DIFF_FLAGS) + "`, log and show a format (`--oneline` or "
    "`--format=…`), and diff two commits before `--` (`A...B --`); `gh pr view|diff|checks|list` and "
    "`gh run view|list`; `ls`, `cat`, `head`, `tail`, `wc` and `rg`")


def duty_reason(detail):
    return ("Blocked by teamster: " + detail + ". The duty may run only " + DUTY_ALLOWED
            + ", with literal arguments; it writes only inside its room (briefs) and never merges, "
            "releases or accepts work: that stays with the user.")


def has_option(words, options):
    """Whether any word is one of ``options``, given alone, with =VALUE, or as a short option with its value attached."""
    return any(word == option or word.startswith(option + "=")
               or (len(option) == 2 and word.startswith(option)) for word in words for option in options)


def inside_room(path, room, cwd):
    """Whether ``path`` resolves inside ``room`` and outside its .git and .claude, following every symbolic link.

    .claude/settings.json in the room would be the turn's project settings: hooks, env and permissions.
    """
    root = os.path.realpath(room)
    target = os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))
    if os.path.commonpath([root, target]) != root:
        return False
    return not {".git", ".claude"} & set(os.path.relpath(target, root).split(os.sep))


def teamster_denial(arguments):
    """Why the duty may not run ``teamster`` with these arguments, or None."""
    command = arguments[0] if arguments else ""
    if command == "duty":
        allowed, rest = frozenset({"--json"}), arguments[2:]
        if arguments[1:2] != ["status"]:
            return f"`teamster duty {' '.join(arguments[1:2])}` is refused"
    elif command in DUTY_TEAMSTER:
        allowed, rest = DUTY_TEAMSTER[command], arguments[1:]
    else:
        return f"`teamster {command}` is refused"
    if command in DUTY_SELF and DUTY_SLUG in rest:
        return f"`teamster {command}` on the duty conversation itself is refused"
    for word in rest:
        name = word.split("=", 1)[0]
        # argparse reads a word with a space before any = as a positional value, like a message.
        if word.startswith("-") and word != "-" and " " not in name and name not in allowed | DUTY_HELP:
            return (f"the option `{name}` of `teamster {command}` is refused: only exact option names are allowed, "
                    "and `--check`, `--check-loaded` and `--ci-command` never (the supervisor would run that shell "
                    "command; put the checks in the brief)")
    return None


def git_denial(arguments, room, cwd):
    """Why the duty may not run ``git`` with these arguments, or None."""
    index, settings = 0, set()
    while index < len(arguments) and arguments[index].startswith("-"):
        option = arguments[index]
        if option == "-C" and index + 1 < len(arguments):
            # The room is writable: a repository planted in it could run its own config.
            if inside_room(arguments[index + 1], room, cwd):
                return "`git -C` inside the room is refused"
            index += 2
        elif option in ("--no-pager", "-P"):
            settings.add("--no-pager")
            index += 1
        elif option == "-c" and index + 1 < len(arguments):
            key, _, value = arguments[index + 1].partition("=")
            if DUTY_GIT_SETTINGS.get(key.lower()) != value:
                return f"`git -c {arguments[index + 1]}` is refused"
            settings.add(key.lower())
            index += 2
        else:
            return f"the git option `{option}` is refused"
    command, rest = (arguments[index], arguments[index + 1:]) if index < len(arguments) else ("", [])
    if command == "status":
        return ("`git status` is refused: it can run the repository's clean filters; compare commits with "
                f"`{DUTY_GIT_PREFIX} -C <path> diff {' '.join(DUTY_GIT_DIFF_FLAGS)} A...B --`, or ask "
                "`teamster status <slug>`")
    if command == "fetch":
        return ("`git fetch` is refused: the repository's config can make it run credential helpers, ssh commands, "
                "proxies, upload-pack and hooks; `teamster start` fetches by itself")
    if command not in DUTY_GIT:
        return f"`git {command}` is refused; git is read-only here"
    if settings != {"--no-pager", *DUTY_GIT_SETTINGS}:
        return (f"git must start with `{DUTY_GIT_PREFIX}`: otherwise the repository's config can start a pager, "
                "an fsmonitor hook or another hook")
    options = rest[:rest.index("--")] if "--" in rest else rest
    for word in options:
        name = word.split("=", 1)[0]
        if (name.startswith("--") and len(name) > 2 and word != "--submodule=short"
                and any(refused.startswith(name) for refused in DUTY_GIT_REFUSED)):
            return f"the git option `{name}` is refused: it runs a program, writes a file or reads through filters"
        if command == "grep" and word.startswith("-") and not word.startswith("--") and "O" in word:
            return "`git grep -O` is refused: it opens a pager"
        if command in ("log", "show") and "%G" in word:
            return "signature placeholders (`%G…`) are refused: they run gpg.program"
        if command in ("log", "show") and name in ("--format", "--pretty") and "=" in word and not (
                word.partition("=")[2] in DUTY_GIT_FORMATS or word.partition("=")[2].startswith(("format:", "tformat:"))
                or "%" in word):
            return f"`{word}` is refused: a format name may come from the repository's config"
        if command == "diff" and word.startswith("-") and word not in DUTY_GIT_DIFF_OPTIONS and not any(
                word.startswith(prefix) and len(word) > len(prefix) for prefix in DUTY_GIT_DIFF_VALUES):
            return (f"the git diff option `{word}` is refused: diff takes only "
                    + ", ".join(f"`{option}`" for option in sorted(DUTY_GIT_DIFF_OPTIONS))
                    + ", and " + ", ".join(f"`{prefix}…`" for prefix in DUTY_GIT_DIFF_VALUES))
    if command in ("log", "show", "diff") and not set(DUTY_GIT_DIFF_FLAGS) <= set(options):
        return (f"`git {command}` needs `{' '.join(DUTY_GIT_DIFF_FLAGS)}`: otherwise the repository's config can "
                "run an external diff, textconv, gpg or a submodule diff")
    if command in ("log", "show") and not any(
            word in ("--oneline", "--pretty") or word.startswith(("--format=", "--pretty=")) for word in options):
        return (f"`git {command}` needs its format, such as `--oneline` or `--format=%h %s`: the repository's "
                "format.pretty could show signatures, which runs gpg.program")
    if command == "diff" and not {"--cached", "--staged"} & set(options):
        revisions = [word for word in options if not word.startswith("-")]
        if "--" not in rest or not (len(revisions) == 2 or len(revisions) == 1 and ".." in revisions[0]):
            return ("`git diff` against the working tree is refused: it runs the repository's clean filters; "
                    "compare commits, written `A...B --` or `A B --`, or the index with `--cached`")
    if command == "ls-files" and any(word not in DUTY_GIT_LS_FILES for word in options if word.startswith("-")):
        return ("`git ls-files` takes only " + ", ".join(f"`{option}`" for option in sorted(DUTY_GIT_LS_FILES))
                + ": the others compare the working tree through filters")
    return None


def duty_command_denial(words, room, cwd):
    """Why the duty may not run one simple command, or None."""
    if ASSIGNMENT.match(words[0]):
        return f"variable assignments are refused (`{words[0]}`)"
    name = words[0]
    if "/" in name:
        return f"commands run by path are refused (`{name}`); use the bare command name"
    arguments = words[1:]
    if name in {"teamster", "git", "gh"}:
        stdin_paths = {os.path.realpath(path) for path in DUTY_STDIN_PATHS}
        for argument in arguments:
            value = argument.split("=", 1)[1] if argument.startswith("-") and "=" in argument else argument
            if name == "git" and argument.startswith("-") and not argument.startswith("--") and "f" in argument:
                value = argument.partition("f")[2] or value  # git grep -nfFILE reads its patterns from FILE.
            if (value == "-" or value in DUTY_STDIN_PATHS
                    or os.path.realpath(os.path.join(cwd, os.path.expanduser(value))) in stdin_paths):
                return f"`{name}` may not take work from standard input (`{argument}`)"
            if name == "git" and len(argument) > 2 and "--stdin".startswith(argument):
                return "git options that take work from standard input (`--stdin`) are refused"
    if name == "teamster":
        return teamster_denial(arguments)
    if name == "git":
        return git_denial(arguments, room, cwd)
    if name == "gh":
        group, command = (arguments + ["", ""])[:2]
        if command not in DUTY_GH.get(group, ()):
            return f"`gh {' '.join(arguments[:2])}` is refused; gh is read-only here"
        return None
    if name in DUTY_READERS:
        if name == "rg" and has_option(arguments, DUTY_RG_OPTIONS):
            return "rg options that run programs (`--pre`, `--hostname-bin`) are refused"
        return None
    return f"`{name}` is not on the duty allowlist"


def codex_reader_denial(words, cwd, piped=False):
    """Codex readers take finite files or pipeline input, never tail's follow mode."""
    name, arguments = words[0], words[1:]
    if name not in DUTY_READERS or name == "ls":
        return None
    refusal = f"Codex duty `{name}` requires explicit finite file operands and supported options"
    flags = {"cat": "benstuvAET", "head": "qvz", "tail": "qvrz", "wc": "clmwL", "rg": "nNiIlwxoUvqFSPcHha"}[name]
    valued = ({"n": "count", "c": "count", "--lines": "count", "--bytes": "count"}
              if name in ("head", "tail") else
              {"e": "pattern", "f": "patterns", "A": "count", "B": "count", "C": "count", "m": "count",
               "g": "glob", "t": "type", "--regexp": "pattern", "--file": "patterns",
               "--after-context": "count", "--before-context": "count", "--context": "count",
               "--max-count": "count", "--glob": "glob", "--type": "type"} if name == "rg" else {})
    long_flags = {"cat": {"--number", "--number-nonblank", "--squeeze-blank", "--show-all", "--show-ends",
                           "--show-tabs", "--show-nonprinting"},
                  "head": {"--quiet", "--silent", "--verbose", "--zero-terminated"},
                  "tail": {"--quiet", "--silent", "--verbose", "--zero-terminated"},
                  "wc": {"--bytes", "--chars", "--lines", "--words", "--max-line-length"},
                  "rg": {"--files", "--line-number", "--no-line-number", "--ignore-case", "--case-sensitive",
                         "--fixed-strings", "--smart-case", "--word-regexp", "--line-regexp", "--only-matching",
                         "--files-with-matches", "--files-without-match", "--count", "--count-matches", "--hidden",
                         "--no-ignore", "--quiet", "--multiline", "--text", "--no-heading", "--heading"}}[name]
    files, pattern_files = [], []
    pattern_given, list_files, options = False, False, True
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if options and argument == "--":
            options = False
        elif options and argument.startswith("--"):
            option, equals, value = argument.partition("=")
            if name == "tail" and "--follow".startswith(option):
                return "Codex duty tail follow mode is refused; read a finite file instead"
            if option in long_flags and not equals:
                list_files = list_files or option == "--files"
            elif option in valued:
                if not equals:
                    index += 1
                    if index == len(arguments):
                        return refusal
                    value = arguments[index]
                pattern_given = pattern_given or valued[option] in ("pattern", "patterns")
                if valued[option] == "patterns":
                    pattern_files.append(value)
            else:
                return refusal
        elif options and argument.startswith("-") and argument != "-":
            position = 1
            while position < len(argument):
                option = argument[position]
                if name == "tail" and option in "fF":
                    return "Codex duty tail follow mode is refused; read a finite file instead"
                if option in valued:
                    value = argument[position + 1:]
                    if not value:
                        index += 1
                        if index == len(arguments):
                            return refusal
                        value = arguments[index]
                    pattern_given = pattern_given or valued[option] in ("pattern", "patterns")
                    if valued[option] == "patterns":
                        pattern_files.append(value)
                    break
                if option not in flags:
                    return refusal
                position += 1
        else:
            files.append(argument)
        index += 1
    if name == "rg" and not pattern_given and not list_files:
        files = files[1:]  # The first positional is the pattern, never a data file.
    if not files and not piped and not (name == "rg" and list_files):
        return refusal
    stdin_paths = {os.path.realpath(path) for path in DUTY_STDIN_PATHS}
    for path in files + pattern_files:
        if (path == "-" or path in DUTY_STDIN_PATHS
                or os.path.realpath(os.path.join(cwd, os.path.expanduser(path))) in stdin_paths):
            return "Codex duty readers require finite file operands instead of standard input"
    return None


def duty_denial(event, room):
    """Return why the duty's hook rejects a tool call, or None to let it run. Unreadable input is rejected."""
    if not isinstance(event, dict) or not isinstance(event.get("tool_input"), dict):
        return duty_reason("unreadable hook input")
    tool, tool_input = event.get("tool_name"), event["tool_input"]
    cwd = event.get("cwd") if isinstance(event.get("cwd"), str) and event.get("cwd") else room
    if tool in FILE_TOOLS:
        path = tool_input.get(FILE_TOOLS[tool])
        if not isinstance(path, str) or not path or not inside_room(path, room, cwd):
            return duty_reason(f"{tool} outside the room {room} (or inside its .git) is refused")
        return None
    if tool != "Bash":
        return None
    command = tool_input.get("command")
    if not isinstance(command, str):
        return duty_reason("unreadable command")
    reason = denial(command)
    if reason is not None:
        return reason
    shell = Shell(command)
    shell.parse()
    if shell.expansions:
        return duty_reason("shell expansions (`$VAR`, `$(…)`, backticks, `$'…'`, arithmetic, globs, braces, "
                           "unquoted heredocs that expand) are refused")
    for operator, target in shell.targets:
        if operator in (">&", "<&") and (target.isdigit() or target == "-"):
            continue
        if operator in OUTPUT_REDIRECTIONS and target != "/dev/null" and not inside_room(target, room, cwd):
            return duty_reason(f"redirection to `{target}` outside the room (or inside its .git) is refused")
    for words, piped in shell.commands:
        reason = duty_command_denial(words, room, cwd)
        if reason is None and event.get("duty_transport") == "codex":
            reason = codex_reader_denial(words, cwd, piped)
        if reason is not None:
            return duty_reason(reason)
    return None


def main():
    arguments = sys.argv[1:]
    room = arguments[1] if arguments[:1] == ["--duty-room"] and len(arguments) == 2 else None
    try:
        event = json.loads(sys.stdin.buffer.read())
    except ValueError:
        event = None
    if room is not None:
        reason = duty_denial(event, room)
    else:
        tool_input = event.get("tool_input") if isinstance(event, dict) else None
        command = tool_input.get("command") if isinstance(tool_input, dict) else None
        reason = denial(command) if isinstance(command, str) else None
    if reason is None:
        return 0
    sys.stderr.write(reason + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
