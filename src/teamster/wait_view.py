"""Wait output rendering and the wait command."""
import json
import time
from pathlib import Path

from . import account_rotation, checking, ci_runs, clock, config, executors, procs, reflection, result_schema, reviewers, sandboxing, task_state, threads, turn_monitor


def wait_rotation_lines(st):
    if st.get("weekly_budget_warning"):
        yield st["weekly_budget_warning"]
    for r in st["rotations"][st.get("rotation_start", 0):]:
        if r.get("event") == "sleep":
            yield f"== sleeping until {config.local_time(r['until'])} ({r['account'] or 'unknown'}): {r['reason']}"
        elif r.get("event") == "wake":
            yield f"== woke at {config.local_time(r['at'])} to recheck account limits"
        elif r.get("event") == "reset_credit":
            if r.get("outcome") in ("success", "consumed (inferred)"):
                yield f"== used a free limit reset on {r['account']} ({r['credit_id']}), expires {config.local_time(r.get('expires_at'))}"
        elif r.get("event") == "needs_login":
            yield f"== account {r['account']} needs login: run login {r['account']}"
        else:
            yield f"== rotated {r['from']} → {r['to']}: {r['reason']}, new thread {r['thread'] or '?'}"
    if st.get("outcome") == "sleeping":
        if procs.alive(st.get("pid")):
            s = st["sleeping"]
            label = "account status unknown; retry at" if s.get("probe") else "all accounts at limit; auto-continue at"
            yield f"== {label} {config.local_time(s['until'])} ({s['account'] or 'unknown'}); run wait again to follow"
        else:
            yield "== paused, supervisor gone; continue with say"
    if st.get("exhausted"):
        e = st["exhausted"]
        reset = f"{config.local_time(e['reset'])} ({e['account']})" if e["reset"] is not None else "unknown"
        if e.get("reason"):
            yield f"== paused: {e['reason']}"
        yield f"== all accounts at limit; earliest reset {reset}; continue with say after that"


def wait_publication_lines(st):
    if st.get("no_push"):
        yield "== push disabled (--no-push)"
    if st.get("sandbox") == "workspace":
        yield "== sandbox: workspace"
    publication = st.get("publish")
    if publication and (st.get("kind") != "review" or st.get("work_completed")):
        if publication["sha"]:
            subject = procs.sh(config.GIT + ["log", "-1", "--format=%s", publication["sha"]], cwd=st["worktree"], check=False)
            yield (f"== committed {publication['sha']} " + json.dumps(subject, ensure_ascii=False)
                   + ("; pushed" if publication["pushed"] else "")
                   + ("; PR " + publication["pr"] if publication["pr"] else ""))
        error = publication["error"]
        if error.startswith(("commit: ", "push: ")):
            yield "== publish error: " + error
        action = publication.get("action")
        if action in ("created", "updated", "skipped"):
            yield "== PR " + ("skipped: " + error if action == "skipped" else action + " " + publication["pr"])
    if st.get("ci"):
        yield "\n".join(ci_runs.ci_lines(st["ci"]))


def wait_turn_lines(st, slug):
    sleeping = st.get("outcome") == "sleeping"
    publication = st.get("publish")
    yield (f"== {slug}: turn {st.get('turns')} {'paused' if sleeping else 'finished'} after "
          f"{(st.get('turn_finished', clock.CLOCK.time()) - st.get('turn_started', clock.CLOCK.time())) / 60:.1f} min")
    if st.get("task_model"):
        yield f"== model {st['task_model']}  effort {st.get('reasoning_effort') or st.get('effort') or 'default'}"
    if st.get("capacity_retries", 0) > st.get("capacity_start", 0):
        yield f"== retried: model at capacity ×{st['capacity_retries']}"
    if st.get("turn_stop"):
        yield "== turn stopped: " + turn_monitor.turn_stop_message(st["turn_stop"])
    if st.get("outcome") == "interrupted":
        yield "== " + task_state.interruption_message(st)
    if st.get("outcome") == "refused" and st.get("kind") != "review":
        yield "== refused by the model: " + st.get("refusal", "")[:200]
    if (st.get("kind") != "review" or st.get("work_completed")) and not (
            st.get("outcome") == "refused" and st.get("kind") != "review"):
        last = config.TASKS / slug / "last.md"
        if ((st.get("exhausted") or sleeping) and executors.from_state(st).event_log
                and len(threads.events(st)) == st.get("event_start", 0)):
            # Paused before any exec: the thread's last message belongs to an earlier turn.
            yield "(Codex did not run this turn)"
        else:
            raw = ("(no wrap-up result)" if st.get("wrapup", {}).get("outcome") not in (None, "completed")
                   else last.read_text().strip() if last.exists() else threads.last_message(st) or "(no final message)")
            if st.get("kind") == "reflect":
                yield from wait_reflect_lines(st, raw)
            else:
                yield raw if st.get("kind") == "scout" else "\n".join(result_schema.result_lines(st.get("result"), raw))
            if publication and publication["pr"]:
                yield "PR: " + publication["pr"]
    yield from checking.guarded_lines(checking.guarded_changes(st))


def wait_reflect_lines(st, raw):
    result = st.get("result")
    if result is None:
        yield "== result: unknown (no valid reflect result)"
        yield raw
        return
    yield "== result: " + ("NEEDS DECISION" if result["status"] == "needs_decision" else "done")
    yield result["summary"]
    if st.get("reflect_file"):
        yield f"== {reflection.file_kind(st)}: " + str(Path(st["repo"]) / st["reflect_file"])
    if result["lessons"]:
        yield "Lessons:"
        yield from (f"- {lesson['id']}: {lesson['cue']}" for lesson in result["lessons"])
    if result["questions"]:
        yield "Questions:"
        for number, (question, answers) in enumerate(zip(result["questions"], result["options"]), 1):
            yield f"{number}. {question}"
            yield from ("   - " + answer for answer in answers)


def wait_round_lines(st):
    for number, entry in enumerate(st.get("rounds", []), 1):
        findings = (entry.get("review") or {}).get("findings", [])
        counts = ", ".join(f"{severity} {sum(f['severity'] == severity for f in findings)}"
                           for severity in ("P1", "P2", "P3") if any(f["severity"] == severity for f in findings))
        source = (f"{len(findings)} findings" + (f" ({counts})" if counts else "")
                  if entry.get("review") is not None else "check failure")
        if entry.get("base_merge"):
            merge = entry["base_merge"]
            source = f"base merge {merge['base']}: " + ", ".join(merge["files"])
        decisions = entry.get("decisions", [])
        fixed, rejected = (sum(d["decision"] == action for d in decisions) for action in ("fixed", "rejected"))
        code = entry.get("code")
        size = f"; code +{code['added']} −{code['removed']}" if code is not None else ""
        yield f"== round {number}: {source} → fixed {fixed}, rejected {rejected}{size}"
        yield from (f"- rejected {d['id']}: {d['note']}" for d in decisions if d["decision"] == "rejected")


def wait_check_lines(st):
    checks = [] if st.get("kind") in ("scout", "reflect") else st.get("checks", [])[st.get("check_start", 0):]
    for check in checks:
        for name, item in ((f"check `{check['cmd']}`", check), ("base tests", check.get("base_check"))):
            if not item:
                continue
            if name == "base tests" and item["outcome"] == "skipped":
                yield f"== base tests: skipped ({item['reason']})"
            elif item["outcome"] == "unavailable":
                yield (f"== {name}: unavailable (exit {item['exit']}) after {item['seconds']:.0f} s; "
                       "the check did not run, run it yourself before merging")
            else:
                label = item["outcome"] if item["outcome"] in ("passed", "stopped", "interrupted") else "FAILED"
                reason = "timeout, " if item["outcome"] == "timeout" else ""
                yield f"== {name}: {label} ({reason}exit {item['exit']}, {item['seconds']:.0f} s)"
            if name != "base tests" and item["outcome"] in ("failed", "timeout", "unavailable"):
                yield item.get("tail", checking.check_tail(st))
            elif name == "base tests" and item.get("tail"):
                yield item["tail"]


def wait_review_lines(st, slug):
    switch = st.get("base_switch")
    if switch:
        yield f"base {switch['from']} is gone; checked against {switch['to']}"
    for merge in st.get("base_merges", []):
        if merge["outcome"] == "skipped":
            yield f"== base merge {merge['base']}: skipped ({merge['reason']})"
    if st.get("review_skipped"):
        yield "== review skipped: " + st["review_skipped"]
    if st.get("auto_fix_stop") == "escalate":
        for finding in st.get("auto_fix_escalations", []):
            yield (f"== auto-fix: stop: escalate — {finding['id']} {finding['file']}:{finding['line']} "
                   f"targets code from fix round {finding['round']} ({finding['commit']})")
    reviews = st.get("reviews", [])[st.get("review_start", 0):]
    for entry in reviews:
        reviewer = reviewers.from_entry(entry)
        if "retry_account" in entry:
            reason = " (token unavailable)" if entry.get("unavailable") == "token unavailable" else ""
            yield (f"== {reviewer.name} account {entry['account']} limited until "
                   f"{config.local_time(entry.get('limited_until'))}{reason}; review by {entry['retry_account']}")
        elif entry.get("unavailable"):
            yield f"== reviewer {reviewer.name} unavailable: {entry['unavailable']}; review by {reviewer.fallback}"
    reviews = [entry for entry in reviews if not entry.get("unavailable")]
    if not (st.get("kind") == "review" or st.get("rounds") or reviews):
        return
    aggregate = st.get("review_result")
    angles = aggregate and aggregate.get("angles")
    if not angles and st.get("kind") == "review" and st.get("outcome") == "refused":
        yield "== refused by the model: " + st.get("refusal", "")[:200]
        return
    entries = angles or reviews[-1:]
    for entry in entries:
        minutes = ((entry["finished"] if angles else entry.get("finished") or clock.CLOCK.time()) - entry["started"]) / 60
        account = reviewers.from_entry(entry).account_label(entry)
        heading = "== review " + (f"angle {entry['angle']} " if angles else "") + f"by {account} ({minutes:.1f} min):"
        result = entry.get("result")
        if angles and entry["outcome"] == "refused":
            yield heading + " refused"
            yield "== refused by the model: " + entry.get("refusal", "")[:200]
        elif result is None:
            yield heading + (" " + entry["outcome"] + " (result unknown)" if angles else "")
            if not angles:
                if st.get("kind") == "review" and st.get("wrapup"):
                    yield "(review interrupted; no wrap-up result)"
                else:
                    yield "== result: unknown (unstructured final message)"
                    review = config.TASKS / slug / "review.md"
                    yield review.read_text().strip() if review.exists() else "(no final review)"
        else:
            count = len(result["findings"])
            yield heading + (f" {count} defect{'s' if count != 1 else ''}" if count else " no defects")
    result = aggregate if angles else entries[-1].get("result") if entries else None
    if result is not None:
        yield result["summary"]
        for finding in result["findings"]:
            angle = f"[{finding['angle']}] " if angles else ""
            yield f"[{finding['severity']}] {angle}{finding['id']} {finding['file']}:{finding['line']} — {finding['title']}"
            yield from (finding["detail"], "verify: " + finding["verify"])
    elif not entries:
        yield "(Codex did not run review)"


def wait_stop_lines(st):
    if st.get("fix_rounds") or st.get("auto_fix_stop", "").startswith("result "):
        if (st.get("review_result") or {}).get("angles"):
            results = [entry.get("review") for entry in st.get("rounds", [])] + [st["review_result"]]
        else:
            results = [entry.get("result") for entry in st.get("reviews", [])[st.get("review_start", 0):]]
        trajectory = " → ".join(str(len(result["findings"])) for result in results if result is not None) or "unknown"
        reason = st.get("auto_fix_stop", st.get("outcome", "unknown"))
        yield f"== auto-fix: {len(st.get('rounds', []))} rounds, findings {trajectory}; stop: {reason}"
    if st.get("auto_fix_stop") == "base conflict":
        merge = next(item for item in reversed(st["base_merges"]) if item["outcome"] == "conflict")
        yield f"== auto-fix: stop: base conflict — {merge['base']}: " + ", ".join(merge["files"])
    failed = [e for e in threads.events(st)[st.get("exec_event_start", st.get("event_start", 0)):]
              if e.get("type") in ("turn.failed", "error") and account_rotation.refusal_message(e) is None]
    if failed:
        yield "== errors: " + json.dumps(failed[-1], ensure_ascii=False)[:500]
    if st.get("error"):
        yield "== supervisor error: " + str(st["error"])
    if st.get("kind") in ("scout", "reflect"):
        return
    yield f"== commits on {st['branch']}:"
    yield procs.sh(config.GIT + ["log", "--oneline", f"{st['base']}..HEAD"], cwd=st["worktree"], check=False) or "(none)"
    dirty = (procs.sh(config.GIT + ["status", "--short"], cwd=st["worktree"], check=False)
             if sandboxing.workspace_filter_driver(st) is None else "")
    if dirty:
        yield "== uncommitted:\n" + dirty


def wait_report_lines(st, slug):
    """What wait prints for a cycle that ended; the supervisor also saves it when its cycle sends the queue."""
    for section in (wait_rotation_lines(st), wait_publication_lines(st), wait_turn_lines(st, slug),
                    wait_round_lines(st), wait_check_lines(st), wait_review_lines(st, slug),
                    wait_stop_lines(st)):
        yield from section


def wait_queue_sent_lines(slug, turn, st):
    """The reports of cycles from turn on whose end started a later turn of st with queued orders."""
    if st.get("turns", 0) <= turn:
        return
    for sent in task_state.locked_queue_log(slug, task_state.queue_sent_path(slug)):
        if turn <= sent["turn"] < st["turns"]:
            yield sent["report"]
            yield f"== queued orders sent: {sent['count']}, turn {sent['next_turn']} started"


def wait_queue_dropped_lines(st):
    """Every message the end of this cycle dropped, including those past the dropped history in queue.json."""
    for dropped in task_state.locked_queue_log(st["slug"], task_state.queue_dropped_path(st["slug"])):
        if dropped["turn"] == st.get("turns", 0):
            yield f"== queued orders not sent (outcome {dropped['outcome']}):"
            yield from ("- " + text for text in dropped["texts"])


def cmd_wait(a):
    st = task_state.load(a.slug)
    start = time.monotonic()
    # A cycle that sends queued orders starts the next turn: report it and follow that turn.
    turn = st.get("turns", 0)
    while True:
        while procs.alive(st.get("pid")):
            if st.get("outcome") == "sleeping" and not getattr(a, "through_sleep", False):
                break
            if a.timeout and time.monotonic() - start > a.timeout:
                print(f"{a.slug}: still running after {a.timeout} s")
                return
            time.sleep(config.WAIT_POLL_SECONDS)
            st = task_state.load(a.slug)
            for line in wait_queue_sent_lines(a.slug, turn, st):
                print(line, flush=True)
            turn = max(turn, st.get("turns", 0))
        if not st.get("pid") or procs.alive(st["pid"]):
            break
        # The supervisor may have published its final state, or handed its queue to a new one, since the last poll.
        st = task_state.load(a.slug)
        sent = list(wait_queue_sent_lines(a.slug, turn, st))
        for line in sent:
            print(line, flush=True)
        turn = max(turn, st.get("turns", 0))
        if sent and procs.alive(st.get("pid")):
            continue
        if st.get("pid") and not procs.alive(st["pid"]):
            st["pid"] = None
            task_state.save(st)
        break
    for line in wait_report_lines(st, a.slug):
        print(line)
    for line in wait_queue_dropped_lines(st):
        print(line)
