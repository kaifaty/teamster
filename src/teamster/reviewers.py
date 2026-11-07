"""Reviewer contract and registry, independent of transports and task I/O.

Register a Reviewer (or subclass) with register(instance). Its name is the
persisted reviewer value and a CLI choice; fallback is another reviewer name
or None. from_entry selects a saved task/review (legacy entries use Codex).
State-only policies account_label(entry) and phase_fields(cost_usd) format the
review account in wait output and supply reviewer-specific telemetry fields.

Higher-layer owners bind hooks at import with bind(module, operation="function").
Hooks store the module and attribute name, never the function, so later patches
of the owning module remain visible. Required run and optional I/O hooks are:
  prepare(cfg) validates startup/review and requires its binary
  run(st, cfg, prompt, stopped, used_accounts, effort=None, sleep=None,
      new_turn=False) -> outcome
  clean(entry, cfg) archives an entry's transport history
  stats(entry, cfg) prints an entry's transport statistics
Missing required hooks fail explicitly; absent optional hooks do nothing.
Run hooks own transport, account retries, telemetry and state writes. The
review cycle follows fallback on an unavailable outcome unless stopped.
This module neither imports those owners nor changes the disk schema.
"""


class Reviewer:
    """State policies and late-bound review and I/O hooks."""

    def __init__(self, name, fallback=None):
        self.name = name
        self.fallback = fallback
        self.hooks = {}

    def bind(self, module, **operations):
        for operation, attribute in operations.items():
            self.hooks[operation] = (module, attribute)

    def call(self, operation, *args, **kwargs):
        module, attribute = self.hooks[operation]
        return getattr(module, attribute)(*args, **kwargs)

    def prepare(self, cfg):
        if "prepare" in self.hooks:
            self.call("prepare", cfg)

    def run(self, st, cfg, prompt, stopped, used_accounts, effort=None, sleep=None, new_turn=False):
        return self.call("run", st, cfg, prompt, stopped, used_accounts,
                         effort=effort, sleep=sleep, new_turn=new_turn)

    def clean(self, entry, cfg):
        if "clean" in self.hooks:
            self.call("clean", entry, cfg)

    def stats(self, entry, cfg):
        if "stats" in self.hooks:
            self.call("stats", entry, cfg)

    def account_label(self, entry):
        return entry["account"]

    def phase_fields(self, cost_usd):
        return {}


class ClaudeReviewer(Reviewer):
    def __init__(self):
        super().__init__("claude", fallback="codex")

    def account_label(self, entry):
        return self.name + "/" + entry["account"]

    def phase_fields(self, cost_usd):
        return {"thread": None, "weekly_spent": 0, "cost_usd": cost_usd}


REVIEWERS = {}


def register(reviewer):
    if reviewer.name in REVIEWERS:
        raise ValueError("reviewer already registered: " + reviewer.name)
    REVIEWERS[reviewer.name] = reviewer


def get(name):
    return REVIEWERS[name]


def names():
    return REVIEWERS.keys()


def from_entry(entry):
    return get(entry.get("reviewer", "codex"))


CODEX_REVIEWER = Reviewer("codex")
CLAUDE_REVIEWER = ClaudeReviewer()
register(CODEX_REVIEWER)
register(CLAUDE_REVIEWER)
