#!/usr/bin/env python3
"""Claude Code PreToolUse hook for the Bash tool of writable Claude turns.

Usage: python3 -I bash_guard.py < hook-event.json

It rejects commands that start a process in the background or kill processes
by name or pattern: exit status 2 with the reason on stderr, which Claude Code
shows to the model. Every other command, and unreadable input, exits 0. The
shell text is only tokenized, never run. Runs by path and never imports the
package.
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
        return inner.names

    def end(self, words, mark):
        """Record a finished simple command and the script a shell, eval or trap runs.

        Names from ``mark`` on belong to this command's substitutions and to the
        earlier commands of its pipeline. Returns the next command's words and mark.
        """
        found = set(self.names[mark:])
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
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char in " \t":
                self.pos += 1
            elif self.starts("\\\n"):
                self.pos += 2
            elif char == "\n":
                self.pos += 1
                words, mark = self.end(words, mark)
                self.read_heredocs()
            elif char == "#":
                while self.pos < len(self.text) and self.text[self.pos] != "\n":
                    self.pos += 1
            elif char == ";":
                # `;;`, `;&` and `;;&` end case items.
                self.pos += 3 if self.starts(";;&") else 2 if self.starts(";;", ";&") else 1
                words, mark = self.end(words, mark)
            elif char == "&":
                if self.starts("&&"):
                    self.pos += 2
                    words, mark = self.end(words, mark)
                elif self.starts("&>"):
                    self.pos += 3 if self.starts("&>>") else 2
                    target = True
                else:
                    self.pos += 1
                    self.background = True
                    words, mark = self.end(words, mark)
            elif char == "|":
                pipe = not self.starts("||")
                self.pos += 2 if self.starts("||", "|&") else 1
                words, next_mark = self.end(words, mark)
                # Later commands of a pipeline may kill the PIDs that earlier ones found.
                mark = mark if pipe else next_mark
            elif char == "(":
                self.pos += 1
                if not words and self.peek() == "(":
                    self.pos += 1
                    self.skip_arithmetic()
                else:
                    depth += 1
                    words, mark = self.end(words, mark)
            elif char == ")":
                self.pos += 1
                words, mark = self.end(words, mark)
                if depth:
                    depth -= 1
                elif closer == ")":
                    return
            elif char in "<>" and self.peek(1) != "(":
                target = self.redirect()
            else:
                start = self.pos
                word, quoted = self.read_word()
                if self.pos == start:
                    self.pos += 1
                elif not quoted and word.isdigit() and self.starts("<", ">"):
                    pass  # The file descriptor of a redirection.
                elif target:
                    target = False
                else:
                    words.append(word)
        self.end(words + self.arguments if closer is None else words, mark)

    def redirect(self):
        """Skip a redirection operator; return whether a target word follows it."""
        if self.starts("<<<"):
            self.pos += 3
            return True
        if self.starts("<<"):
            self.pos += 2
            strip = self.peek() == "-"
            self.pos += strip
            while self.peek() in (" ", "\t"):
                self.pos += 1
            delimiter, _ = self.read_word()
            self.heredocs.append((delimiter, strip))
            return False
        self.pos += 2 if self.starts("<>", ">>", ">|", ">&", "<&") else 1
        return True

    def read_heredocs(self):
        for delimiter, strip in self.heredocs:
            while self.pos < len(self.text):
                end = self.text.find("\n", self.pos)
                end = len(self.text) if end < 0 else end
                line = self.text[self.pos:end]
                self.pos = end + 1
                if (line.lstrip("\t") if strip else line) == delimiter:
                    break
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
                    value.append(self.ansi_c())
                    quoted = True
                else:
                    value.append(self.dollar())
            else:
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


def main():
    try:
        event = json.loads(sys.stdin.buffer.read())
    except ValueError:
        return 0
    tool_input = event.get("tool_input") if isinstance(event, dict) else None
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    reason = denial(command) if isinstance(command, str) else None
    if reason is None:
        return 0
    sys.stderr.write(reason + "\n")
    return 2


if __name__ == "__main__":
    sys.exit(main())
