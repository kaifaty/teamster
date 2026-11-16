"""Role-neutral Claude Code accounts and credential-free cached limit snapshots."""
import fcntl
import json
import os
from contextlib import contextmanager

from . import clock, config, result_schema

TOKEN_RETRY_SECONDS = 3600


def accounts(cfg):
    return cfg["claude"]["accounts"]


def format_windows(info):
    windows, parts = info.get("unifiedWindows") or {}, []
    for name, label in (("five_hour", "5h"), ("seven_day", "7d")):
        window = windows.get(name) or {}
        used = window.get("utilization")
        percent = f"{used * 100:g}%" if type(used) in (int, float) else "unknown"
        parts.append(f"{label} {percent} (reset {config.local_time(window.get('resetsAt'))})")
    return "; ".join(parts)


def read_limits():
    try:
        limits = json.loads((config.TASKS / "claude-limits.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(limits, dict):
        return {}
    if (isinstance(limits.get("status"), str) or result_schema.is_finite_number(limits.get("utilization"))
            or result_schema.is_finite_number(limits.get("resetsAt")) or "unifiedWindows" in limits):
        return {"default": limits}
    limits = {name: info for name, info in limits.items() if isinstance(info, dict)}
    for info in limits.values():
        if info.get("token_unavailable") and not result_schema.is_finite_number(info.get("token_retry_at")):
            # Earlier versions kept this mark until the next login; give it one hour.
            marked = info.get("limited_at")
            info["token_retry_at"] = marked + TOKEN_RETRY_SECONDS if result_schema.is_finite_number(marked) else 0
            if not result_schema.is_finite_number(info.get("limited_until")):
                info["limited_until"] = info["token_retry_at"]
    return limits


@contextmanager
def _locked_limits():
    config.TASKS.mkdir(parents=True, exist_ok=True)
    path = config.TASKS / "claude-limits.json"
    with (config.TASKS / "claude-limits.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        limits = read_limits()
        yield limits
        temporary = path.with_suffix(".%s.tmp" % os.getpid())
        temporary.write_text(json.dumps(limits), encoding="utf-8")
        temporary.replace(path)


def save_limits(name, info, event_time=None, model=None):
    """Store only documented numeric fields, never arbitrary CLI output.

    An allowance on ``model`` newer than that model's mark clears the mark.
    """
    selected = {}
    if info.get("status") in ("allowed", "allowed_warning", "rejected"):
        selected["status"] = info["status"]
    for key in ("utilization", "resetsAt"):
        if result_schema.is_finite_number(info.get(key)):
            selected[key] = info[key]
    windows = info.get("unifiedWindows")
    if isinstance(windows, dict):
        selected["unifiedWindows"] = {
            window_name: {key: window[key] for key in ("utilization", "resetsAt")
                          if result_schema.is_finite_number(window.get(key))}
            for window_name in ("five_hour", "seven_day")
            for window in [windows.get(window_name)] if isinstance(window, dict)}
    with _locked_limits() as limits:
        if selected:
            selected["updated_at"] = clock.CLOCK.time()
        previous = limits.get(name, {})
        authentication_failed = previous.get("reason") == "authentication failed"
        active = limited(previous)
        marked_at = previous.get("limited_at")
        fresh = (result_schema.is_finite_number(event_time)
                 and result_schema.is_finite_number(marked_at) and event_time > marked_at)
        previous.update(selected)
        if selected.get("status") in ("allowed", "allowed_warning"):
            previous.pop("reason", None)
        if (selected.get("status") in ("allowed", "allowed_warning") and (not active or fresh or authentication_failed)
                and not token_marked(previous)):
            previous.pop("limited_until", None)
            previous.pop("limited_at", None)
        if selected.get("status") in ("allowed", "allowed_warning"):
            _clear_model_mark(previous, model, event_time)
        _prune_model_marks(previous)
        limits[name] = previous


def _model_marks(info):
    marks = info.get("model_limits")
    return marks if isinstance(marks, dict) else {}


def _mark_active(mark, now):
    reset = mark.get("limited_until")
    return not result_schema.is_finite_number(reset) or reset > now


def _prune_model_marks(info, now=None):
    now = clock.CLOCK.time() if now is None else now
    marks = {model: mark for model, mark in _model_marks(info).items()
             if isinstance(mark, dict) and _mark_active(mark, now)}
    if marks:
        info["model_limits"] = marks
    else:
        info.pop("model_limits", None)


def _clear_model_mark(info, model, event_time):
    """Drop the mark of ``model`` when the success at ``event_time`` is newer than it."""
    mark = _model_marks(info).get(model) if model else None
    if (isinstance(mark, dict) and result_schema.is_finite_number(event_time)
            and (not result_schema.is_finite_number(mark.get("limited_at")) or event_time > mark["limited_at"])):
        del info["model_limits"][model]


def model_limits(info, now=None):
    """Active per-model marks of one account as ``{model: limited_until or None}``."""
    now = clock.CLOCK.time() if now is None else now
    return {model: mark.get("limited_until") for model, mark in sorted(_model_marks(info).items())
            if isinstance(mark, dict) and _mark_active(mark, now)}


def model_succeeded(name, model, event_time=None):
    """A successful request on ``model`` newer than its mark lifts that mark only."""
    if not model or model not in _model_marks(read_limits().get(name, {})):
        return
    event_time = clock.CLOCK.time() if event_time is None else event_time
    with _locked_limits() as limits:
        info = limits.get(name)
        if info:
            _clear_model_mark(info, model, event_time)
            _prune_model_marks(info)


def clear_limits(name):
    with _locked_limits() as limits:
        limits.pop(name, None)


def rename_limits(old, new):
    with _locked_limits() as limits:
        if old in limits:
            limits[new] = limits.pop(old)


def token_available(name):
    """Drop a missing-token mark after a successful read; keep a later limit."""
    if not read_limits().get(name, {}).get("token_unavailable"):
        return
    with _locked_limits() as limits:
        info = limits.get(name)
        if not info or not info.get("token_unavailable"):
            return
        until = info.pop("token_retry_at")
        info.pop("token_unavailable", None)
        if info.get("reason") == "token unavailable":
            info.pop("reason", None)
        reset = info.get("limited_until")
        if result_schema.is_finite_number(reset) and reset <= until:
            info.pop("limited_until", None)
            info.pop("limited_at", None)


def window_used(window, now):
    reset = window.get("resetsAt")
    if result_schema.is_finite_number(reset) and reset <= now:
        return 0
    used = window.get("utilization")
    return used * 100 if result_schema.is_finite_number(used) else 0


def stale(cfg, info, now=None):
    now = clock.CLOCK.time() if now is None else now
    updated = info.get("updated_at")
    max_age = cfg["claude"].get("limits_max_age_minutes", 30)
    return (max_age == 0 or not result_schema.is_finite_number(updated)
            or now - updated > max_age * 60)


def probe_due(cfg, info, now=None):
    now = clock.CLOCK.time() if now is None else now
    attempted = info.get("probe_attempted_at")
    max_age = cfg["claude"].get("limits_max_age_minutes", 30)
    return stale(cfg, info, now) and (
        max_age == 0 or not result_schema.is_finite_number(attempted)
        or now - attempted >= max_age * 60)


def mark_probe_attempt(name):
    with _locked_limits() as limits:
        limits.setdefault(name, {})["probe_attempted_at"] = clock.CLOCK.time()


def token_marked(info, now=None):
    """Whether a missing-token mark from read_limits() is still active."""
    now = clock.CLOCK.time() if now is None else now
    return bool(info.get("token_unavailable")) and info.get("token_retry_at", 0) > now


def limited(info, now=None, model=None):
    """Whether the whole account, or with ``model`` that model on it, is limited."""
    now = clock.CLOCK.time() if now is None else now
    if "limited_until" in info:
        reset = info["limited_until"]
        if not result_schema.is_finite_number(reset) or reset > now:
            return True
    elif info.get("status") == "rejected":
        reset = info.get("resetsAt")
        if not result_schema.is_finite_number(reset) or reset > now:
            return True
    return model is not None and model in model_limits(info, now)


def limit_end(info, now=None, model=None):
    """When the account returns for ``model``; None while not limited or the end is unknown."""
    now = clock.CLOCK.time() if now is None else now
    ends = [info.get("limited_until", info.get("resetsAt"))] if limited(info, now) else []
    marks = model_limits(info, now)
    if model is not None and model in marks:
        ends.append(marks[model])
    if not ends or not all(result_schema.is_finite_number(end) for end in ends):
        return None
    return max(ends)


def authenticated(name):
    """A successful API response clears the reason, lifting an authentication block."""
    if not read_limits().get(name, {}).get("reason"):
        return
    with _locked_limits() as limits:
        info = limits.get(name, {})
        reason = info.pop("reason", None)
        if reason == "authentication failed":
            info.pop("limited_until", None)
            info.pop("limited_at", None)


def mark_limited(name, token_unavailable=False, reason=None, model=None):
    """Exclude an account until its known reset, or until fresh login/limit data.

    A missing token excludes it for TOKEN_RETRY_SECONDS; the next selection
    after that reads the token again. A usage limit on ``model`` while every
    known window of the account is below 100% excludes the account for that
    model only.
    """
    return mark_scope(name, token_unavailable, reason, model)[0]


def mark_scope(name, token_unavailable=False, reason=None, model=None):
    """Mark as mark_limited(); return (limit end, the model when only it was limited, else None)."""
    now = clock.CLOCK.time()
    with _locked_limits() as limits:
        info = limits.setdefault(name, {})
        windows = info.get("unifiedWindows") if isinstance(info.get("unifiedWindows"), dict) else {}
        windows = {key: window for key, window in windows.items() if isinstance(window, dict)}
        model_only = (not token_unavailable and reason == "usage limit" and bool(model)
                      and any(result_schema.is_finite_number(window.get("utilization"))
                              for window in windows.values())
                      and all(window_used(window, now) < 100 for window in windows.values()))
        if token_unavailable:
            info["reason"] = "token unavailable"
        elif reason in ("authentication failed", "usage limit") and not model_only:
            info["reason"] = reason
        if token_unavailable:
            until = now + TOKEN_RETRY_SECONDS
            if limited(info, now):
                # An unknown reset would exclude the account for good; keep the hour.
                reset = info.get("limited_until", info.get("resetsAt"))
                if result_schema.is_finite_number(reset) and reset > until:
                    until = reset
            info.update(token_unavailable=True, token_retry_at=now + TOKEN_RETRY_SECONDS,
                        limited_until=until, limited_at=now)
            return until, None
        depleted = [window.get("resetsAt") for window in windows.values() if window_used(window, now) >= 100]
        depleted = [reset for reset in depleted if result_schema.is_finite_number(reset) and reset > now]
        resets = [window.get("resetsAt") for window in windows.values()]
        resets = [reset for reset in resets if result_schema.is_finite_number(reset) and reset > now]
        reset = info.get("resetsAt")
        if not result_schema.is_finite_number(reset) or reset <= now:
            reset = max(depleted) if depleted else min(resets, default=None)
        if model_only:
            # The rejected snapshot belongs to this model; other models keep the account.
            if info.get("status") == "rejected":
                info.pop("status")
            _prune_model_marks(info, now)
            info.setdefault("model_limits", {})[model] = {"limited_until": reset, "limited_at": now}
            return reset, model
        if token_marked(info, now) and (not result_schema.is_finite_number(reset)
                                        or reset < info["token_retry_at"]):
            reset = info["token_retry_at"]
        info["limited_until"] = reset
        info["limited_at"] = now
        return reset, None


def select(cfg, role, exclude=(), prefer_unused=(), model=None):
    """Choose the weighted weekly headroom that must be spent fastest, skipping limits on ``model``."""
    limits, now = read_limits(), clock.CLOCK.time()
    choices = [account for account in accounts(cfg) if account["name"] not in exclude
               and not limited(limits.get(account["name"], {}), now, model)]
    thresholds = (cfg.get("soft_switch_at", cfg["switch_at"]), cfg["switch_at"])
    if role == "work":
        # Work keeps the top of each account's week in reserve for reviews.
        work = cfg["claude"].get("work_switch_at", 85)
        thresholds = (min(work, thresholds[0]), work)
    for threshold in thresholds:
        available = [account for account in choices if all(
            window_used((limits.get(account["name"], {}).get("unifiedWindows") or {}).get(window) or {}, now)
            < threshold for window in ("five_hour", "seven_day"))]
        if available:
            available = [account for account in available if account["name"] not in prefer_unused] or available

            def priority(account):
                windows = limits.get(account["name"], {}).get("unifiedWindows") or {}
                weekly = windows.get("seven_day") or {}
                reset = weekly.get("resetsAt")
                hours = (reset - now) / 3600 if result_schema.is_finite_number(reset) and reset > now else 168
                score = (100 - window_used(weekly, now)) * account.get("weight", 1) / max(hours, 1)
                return -score, window_used(windows.get("five_hour") or {}, now)

            return min(available, key=priority)
    return None
