"""Reflection lessons, the newest batch and pending records from a temporary archive."""

import json
import os
import time
from datetime import datetime, timedelta, timezone

import pytest

from teamster_board import research as research_module
from teamster_board.research import Research, signals


INDEX = """# Lessons

| date | entry | scope | cue | status |
|------|-------|:-----:|-----|--------|
| 2026-11-01 | alpha-20261101T000000Z | invariant | review spiral | proposed |
| 2026-11-02 | beta-20261102T000000Z | domain a, b | a flaky check | applied AGENTS.md in a |
| 2026-11-03 | gamma-20261103T000000Z | `domain` c | pipes | declined: x | y |
| 2026-11-04 | delta-20261104T000000Z | brief only | other | held |
| 2026-11-05 | batch-2026-11-05.md L1 | invariant | agreed lesson | accepted: pending application |
| broken | row |
not a table row
| | | | | |
"""


def write_record(archive, name, state):
    directory = archive / name
    directory.mkdir(parents=True)
    path = directory / "state.json"
    path.write_text(state if isinstance(state, str) else json.dumps(state))
    return path


def counting(monkeypatch):
    reads = []
    original = research_module.load_json

    def load_json(path):
        reads.append(path.parent.name)
        return original(path)

    monkeypatch.setattr(research_module, "load_json", load_json)
    return reads


def test_index_rows_scopes_statuses_and_extra_cells(tmp_path):
    archive = tmp_path / ".archive"
    archive.mkdir()
    (archive / "INDEX.md").write_text(INDEX)
    lessons = Research(tmp_path).view()["lessons"]
    assert [(row["scope"], row["repos"], row["status"], row["status_text"]) for row in lessons] == [
        ("invariant", [], "proposed", "proposed"),
        ("domain", ["a", "b"], "applied", "applied AGENTS.md in a"),
        ("domain", ["c"], "declined", "declined: x | y"),
        ("other", [], "other", "held"),
        ("invariant", [], "accepted", "accepted: pending application"),
    ]
    assert lessons[1] == {"date": "2026-11-02", "entry": "beta-20261102T000000Z", "scope": "domain",
                          "scope_text": "domain a, b", "repos": ["a", "b"], "cue": "a flaky check",
                          "status": "applied", "status_text": "applied AGENTS.md in a",
                          "title": None, "lesson": None, "proposal": None, "evidence": None, "caveats": None,
                          "implementation": None}


def test_lesson_sections_batch_study_and_signature_cache(tmp_path, monkeypatch):
    archive = tmp_path / ".archive"
    archive.mkdir()
    batch = archive / "batch-2026-11-09.md"
    study = archive / "study-2026-11-09-checks.md"
    (archive / "INDEX.md").write_text("""| date | entry | scope | cue | status |
| --- | --- | --- | --- | --- |
| 2026-11-09 | batch-2026-11-09.md W2 | invariant | CI | proposed |
| 2026-11-09 | study-2026-11-09-checks.md T4 | domain gothic | checks | accepted |
| 2026-11-09 | batch-2026-11-09.md W3 | invariant | absent | proposed |
""")
    batch.write_text("""# Batch 2026-11-09
through: 20261109T000000Z
## Proposed lessons
### W20. Another lesson
lesson: Ignore this.
### W2. The CI waiter waits for the last run
cue: a pending check
lesson: Wait for the current commit.
Keep its run id.
evidence:
- task one, check round 2
- task two, finding R1
scope: invariant
earlier: no earlier lesson
proposal: Change the CI waiter.
### W4. A different lesson
caveats: This belongs to W4.
""")
    study.write_text("""# Study 2026-11-09
## Lessons
#### T4. gothic: keep targeted checks
cue: a changed module
lesson: Run the module's checks.
evidence: task gothic, check.log line 12
caveats: One repository.
proposal:
""")
    (archive / "batch-2026-11-10.md").write_text("""## Additions to proposed lessons
### W3. This is in a later file
lesson: Never read this for W3.
""")
    opened = []
    original = type(batch).open

    def track(path, *args, **kwargs):
        if path in (batch, study):
            opened.append(path)
        return original(path, *args, **kwargs)

    monkeypatch.setattr(type(batch), "open", track)
    research = Research(tmp_path, seconds=0)
    lessons = research.view()["lessons"]
    fields = lambda row: {key: row[key] for key in research_module.LESSON_FIELDS}
    assert fields(lessons[0]) == {
        "title": "The CI waiter waits for the last run",
        "lesson": "Wait for the current commit.\nKeep its run id.",
        "evidence": "- task one, check round 2\n- task two, finding R1",
        "proposal": "Change the CI waiter.", "caveats": None,
    }
    assert fields(lessons[1]) == {
        "title": "gothic: keep targeted checks", "lesson": "Run the module's checks.",
        "evidence": "task gothic, check.log line 12", "caveats": "One repository.", "proposal": None,
    }
    assert fields(lessons[2]) == dict.fromkeys(research_module.LESSON_FIELDS)
    assert research.view()["lessons"] == lessons
    assert opened == [batch, study]
    with original(study, "w") as stream:
        stream.write("## T4 Keep checks\nlesson: " + "x" * 2100 + "\nscope: domain\n")
    assert research.view()["lessons"][1]["lesson"] == "x" * 2000
    assert opened == [batch, study, study]
    study.unlink()
    study.symlink_to(batch)
    assert fields(research.view()["lessons"][1]) == dict.fromkeys(research_module.LESSON_FIELDS)
    # A heading past the archive's existing 64 KiB read limit is not read.
    with original(batch, "w") as stream:
        stream.write(" " * research_module.BATCH_LIMIT + "\n## W2 Hidden\nlesson: hidden")
    assert fields(research.view()["lessons"][0]) == dict.fromkeys(research_module.LESSON_FIELDS)


def test_repositories_from_all_tasks_are_resolved_filtered_sorted_and_capped(tmp_path):
    tasks = tmp_path / "tasks"
    archive = tasks / ".archive"
    alpha = tmp_path / "alpha"
    other_alpha = tmp_path / "other" / "alpha"
    beta = tmp_path / "beta"
    for path in (alpha, other_alpha):
        (path / ".git").mkdir(parents=True)
    beta.mkdir()
    (beta / ".git").write_text("gitdir: /some/worktree\n")
    alias = tmp_path / "alias"
    alias.symlink_to(alpha, target_is_directory=True)
    no_git = tmp_path / "no-git"
    no_git.mkdir()
    reflect_repo = tmp_path / "reflect-only"
    (reflect_repo / ".git").mkdir(parents=True)
    for index, repo in enumerate((alpha, alias, alpha / ".." / "alpha", no_git, tmp_path / "absent")):
        write_record(tasks, f"live-{index}", {"repo": str(repo)})
    write_record(archive, "old-20200101T000000Z", {"repo": str(beta)})
    write_record(archive, "no-timestamp", {"repo": str(other_alpha)})
    for root in (tasks, archive):
        write_record(root, "reflection", {"kind": "reflect", "repo": str(reflect_repo)})
    (archive / ".git").mkdir()
    write_record(tasks, "archive-repo", {"repo": str(archive)})
    research = Research(tasks, seconds=0)
    assert research.view()["repos"] == [
        {"name": "alpha", "path": str(alpha)},
        {"name": "alpha", "path": str(other_alpha)},
        {"name": "beta", "path": str(beta)},
    ]
    for index in range(101):
        repo = tmp_path / f"repo-{index:03}"
        (repo / ".git").mkdir(parents=True)
        write_record(tasks, f"extra-{index}", {"repo": str(repo)})
    repos = research.view()["repos"]
    assert len(repos) == 100
    assert repos == sorted(repos, key=lambda row: (row["name"], row["path"]))
    assert repos[-1]["name"] == "repo-096"


def test_implementation_matches_first_line_and_uses_newest_live_or_archived_state(tmp_path):
    archive = tmp_path / ".archive"
    archive.mkdir()
    entry = "batch-2026-11-09.md W2"
    (archive / "INDEX.md").write_text(
        f"| 2026-11-09 | {entry} | invariant | CI | accepted |\n"
        "| 2026-11-09 | batch-2026-11-09.md W3 | invariant | missing | proposed |\n")
    state = {"created": 20, "repo": "/repos/project", "pid": os.getpid(),
             "publish": {"pr": "https://github.com/owner/project/pull/42"},
             "result": {"status": "needs_decision", "pr": "unused", "summary": "Latest result\nDetails",
                        "questions": [False, "  Which check?\nKeep both?  ", *["q" * 250] * 22]}}
    brief = f"Внедрить урок «  {entry}  »: Keep the check.\n"
    write_record(tmp_path, "lesson-live", state).with_name("brief.md").write_text(brief)
    archived = write_record(archive, "lesson-older-name-20200101T000000Z", dict(state, created=40, pid=None))
    archived.with_name("brief.md").write_text(brief)
    for slug, content in (("lesson-wrong-line", "Other work\n" + brief),
                          ("regular-task", brief),
                          ("lesson-other-entry", "Внедрить урок «unrelated»: Other lesson.\n")):
        write_record(tmp_path, slug, dict(state, created=100)).with_name("brief.md").write_text(content)
    write_record(tmp_path, "lesson-no-brief", dict(state, created=200))
    research = Research(tmp_path, seconds=0)
    lessons = research.view()["lessons"]
    assert lessons[1]["implementation"] is None
    implementation = lessons[0]["implementation"]
    assert implementation == {
        "slug": "lesson-older-name", "archived": True, "alive": False, "repo": "project",
        "result_status": "needs_decision", "pr": "https://github.com/owner/project/pull/42",
        "questions": ["Which check? Keep both?", *["q" * 200] * 19], "summary": "Latest result",
        "created": 40, "updated_at": archived.stat().st_mtime_ns / 1_000_000_000,
    }
    latest = write_record(tmp_path, "lesson-newest", dict(state, created=50))
    latest.with_name("brief.md").write_text(brief)
    assert research.view()["lessons"][0]["implementation"] == {
        **implementation, "slug": "lesson-newest", "created": 50,
        "updated_at": latest.stat().st_mtime_ns / 1_000_000_000, "alive": True, "archived": False,
    }


def test_batch_selection_counts_pending_and_bounded_reads(tmp_path, monkeypatch):
    now = datetime(2026, 11, 9, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(research_module.time, "time", lambda: now)
    archive = tmp_path / ".archive"
    archive.mkdir()
    (archive / "batch-2026-11-01.md").write_text("through: 20261101T000000Z\n")
    # The b file has the later name; the other file of the same day has the greater stamp.
    (archive / "batch-2026-11-07b.md").write_text("# Batch\n\nthrough: 20261105T000000Z\n")
    (archive / "batch-2026-11-07.md").write_text("# Batch\n\n- through: `20261107T051647Z`\n")
    (archive / "batch-2026-11-08.md").write_text("no stamp here\n")
    outside = tmp_path / "outside.md"
    outside.write_text("through: 20991231T000000Z\n")
    (archive / "batch-2026-12-01.md").symlink_to(outside)
    write_record(archive, "ancient-20261001T000000Z", {"repo": "/r/ancient"})
    write_record(archive, "old-20261104T000000Z", {"repo": "/r/old", "result": {"status": "blocked"}})
    write_record(archive, "one-20261106T000000Z", {"repo": "/r/alpha"})
    write_record(archive, "two-20261107T051647Z", {"repo": "/r/alpha", "result": {"status": "blocked"}})
    write_record(archive, "three-20261107T000000Z", {"repo": "/r/beta"})
    write_record(archive, "new-20261108T010000Z", {"repo": "/r/alpha", "result": {"status": "done"}})
    write_record(archive, "late-20261108T020000Z", {"repo": "/r/beta", "outcome": "refused"})
    write_record(archive, "later-20261108T030000Z", {"result": {"status": "needs_decision"}})
    write_record(archive, "reflect-batch-20261106T010000Z",
                 {"kind": "reflect", "repo": "/r/research", "result": {"status": "blocked"}})
    write_record(archive, "reflect-pending-20261108T033000Z",
                 {"kind": "reflect", "repo": "/r/research", "result": {"status": "needs_decision"}})
    write_record(archive, "bad-20261108T040000Z", "{not json")
    write_record(archive, "list-20261108T050000Z", "[]")
    write_record(archive, "nostamp", {"repo": "/r/alpha", "result": {"status": "blocked"}})
    outside_record = tmp_path / "outside-record"
    write_record(tmp_path, "outside-record", {"repo": "/r/x", "result": {"status": "blocked"}})
    (archive / "linked-20261108T060000Z").symlink_to(outside_record, target_is_directory=True)
    (archive / "linkstate-20261108T070000Z").mkdir()
    (archive / "linkstate-20261108T070000Z" / "state.json").symlink_to(outside_record / "state.json")
    reads = counting(monkeypatch)
    view = Research(tmp_path, seconds=0).view()
    assert view["batch"] == {"name": "batch-2026-11-07.md", "date": "2026-11-07",
                             "through": "20261107T051647Z", "records": 3,
                             "repos": {"alpha": 2, "beta": 1}}
    assert view["pending"] == {
        "records": 3, "signals": 2, "repos": {"(unknown)": 1, "beta": 1},
        "items": [
            {"slug": "later", "repo": "(unknown)", "stamp": "20261108T030000Z", "signals": ["needs_decision"]},
            {"slug": "late", "repo": "beta", "stamp": "20261108T020000Z", "signals": ["refused"]},
        ],
    }
    # All records are read for repository discovery, regardless of the material floor.
    assert "ancient-20261001T000000Z" in reads
    assert len(reads) == len(set(reads))
    assert not {name for name in reads if "link" in name}


def test_pending_items_are_capped_and_all_records_count_without_a_batch(tmp_path):
    archive = tmp_path / ".archive"
    for index in range(60):
        write_record(archive, f"task{index:02}-202611{index // 24 + 1:02}T{index % 24:02}0000Z",
                     {"repo": "/r/alpha", "result": {"status": "blocked"}})
    write_record(archive, "quiet-20261201T000000Z", {"repo": "/r/beta"})
    view = Research(tmp_path).view()
    assert view["batch"] is None
    assert view["lessons"] == []
    pending = view["pending"]
    assert (pending["records"], pending["signals"], pending["repos"]) == (61, 60, {"alpha": 60})
    assert len(pending["items"]) == 50
    assert pending["items"][0]["slug"] == "task59"
    assert pending["items"][-1]["slug"] == "task10"


@pytest.mark.parametrize("state,expected", [
    ({"result": {"status": "blocked"}}, ["blocked"]),
    ({"outcome": "refused"}, ["refused"]),
    ({"result": {"status": "needs_decision"}}, ["needs_decision"]),
    ({"auto_fix_stop": "escalate"}, ["escalate"]),
    ({"auto_fix_stop": "rounds_exhausted"}, ["round_cap"]),
    ({"auto_fix_stop": "check failed"}, ["round_cap"]),
    ({"auto_fix_stop": "base conflict", "rounds": [{}]}, ["round_cap"]),
    ({"rounds": [{}, {}]}, ["fix_rounds"]),
    ({"checks": [{"exit": 0}, {"exit": 1}]}, ["check_failed"]),
    ({"ci": {"outcome": "passed", "rounds": 1}}, ["ci_repair"]),
    ({"turn_stops": [{"outcome": "stuck"}, {"outcome": "budget_exhausted"}]}, ["budget_exhausted"]),
    ({"outcome": "budget_exhausted"}, ["budget_exhausted"]),
    ({"result": {"status": "done"}, "outcome": "completed", "auto_fix_stop": "clean", "rounds": [{}],
      "checks": [{"exit": 0}, {"exit": None}], "ci": {"rounds": 0}, "turn_stops": [{"outcome": "stuck"}]}, []),
    ({"result": "done", "rounds": "xx", "checks": [1], "ci": [], "turn_stops": {}}, []),
])
def test_each_signal(state, expected):
    assert signals(state) == expected


@pytest.mark.parametrize("make", ["missing", "empty", "tasks link", "archive link"])
def test_missing_empty_and_linked_archives_give_an_empty_view(tmp_path, make):
    real = tmp_path / "real"
    write_record(real / ".archive", "one-20261108T000000Z", {"result": {"status": "blocked"}})
    (real / ".archive" / "INDEX.md").write_text(INDEX)
    tasks = tmp_path / "tasks"
    if make == "empty":
        (tasks / ".archive").mkdir(parents=True)
    elif make == "tasks link":
        tasks.symlink_to(real, target_is_directory=True)
    elif make == "archive link":
        tasks.mkdir()
        (tasks / ".archive").symlink_to(real / ".archive", target_is_directory=True)
    view = Research(tasks, reflection_task="weekly").view()
    assert view == {"lessons": [], "repos": [], "batch": None,
                    "pending": {"records": 0, "signals": 0, "repos": {}, "items": []},
                    "studies": [], "reflection_task": "weekly", "schedule": None}


def test_linked_and_broken_index_and_batch_files_are_skipped(tmp_path):
    archive = tmp_path / ".archive"
    archive.mkdir()
    outside = tmp_path / "INDEX.md"
    outside.write_text(INDEX)
    (archive / "INDEX.md").symlink_to(outside)
    (archive / "batch-2026-11-07.md").write_bytes(b"\xff\xfe through: 20261107T000000Z")
    write_record(archive, "one-20261108T000000Z", {"repo": "/r/a", "rounds": [{}, {}, {}]})
    view = Research(tmp_path).view()
    assert view["lessons"] == []
    assert view["batch"]["through"] == "20261107T000000Z"
    assert view["pending"]["items"][0]["signals"] == ["fix_rounds"]


def test_unchanged_records_are_not_read_again_and_cache_lasts_its_interval(tmp_path, monkeypatch):
    archive = tmp_path / ".archive"
    (archive).mkdir()
    (archive / "INDEX.md").write_text(INDEX)
    state = write_record(archive, "one-20261108T000000Z", {"repo": "/r/a"})
    reads = counting(monkeypatch)
    clock = [100.0]
    monkeypatch.setattr(research_module.time, "monotonic", lambda: clock[0])
    research = Research(tmp_path, seconds=30)
    first = research.view()
    assert reads == ["one-20261108T000000Z"]
    clock[0] += 31
    assert research.view() == first
    assert reads == ["one-20261108T000000Z"]
    state.write_text(json.dumps({"repo": "/r/a", "result": {"status": "blocked"}}))
    os.utime(state, ns=(1, 1))
    write_record(archive, "two-20261108T010000Z", {"repo": "/r/b"})
    clock[0] += 29
    assert research.view() == first
    clock[0] += 1
    view = research.view()
    assert sorted(reads) == ["one-20261108T000000Z", "one-20261108T000000Z", "two-20261108T010000Z"]
    assert (view["pending"]["records"], view["pending"]["signals"]) == (2, 1)


def test_live_and_archived_study_conversations_waiting_and_cached_reads(tmp_path, monkeypatch):
    now = datetime(2026, 11, 9, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(research_module.time, "time", lambda: now)
    lesson_text = "  Keep targeted checks.\n" + "l" * 600
    proposal_text = "  Update the project rule.\n" + "p" * 600
    state = {"kind": "reflect", "reflect_mode": "study", "reflect_order": "Compare the failed checks",
             "reflect_records": ["one-20261108T000000Z", "two-20261108T010000Z"],
             "reflect_file": "batch-2026-11-09.md", "pid": os.getpid(), "outcome": "running",
             "executor": "claude", "claude_account": "observatory", "account": "unused", "created": now - 100,
             "reflect_turns": [{"at": now - 90, "status": "needs_decision", "summary": "Which check should we keep?",
                                "questions": [False, "Keep the targeted check?"],
                                "options": [["ignored"], ["Yes", None, "No"]],
                                "lessons": [{"id": "L1", "cue": "slow full checks", "scope": "invariant",
                                             "lesson": lesson_text, "proposal": proposal_text},
                                            {"id": "L2", "cue": "local checks", "scope": "domain", "lesson": "", "proposal": ""},
                                            {"id": "L3", "cue": "older lesson"},
                                            {"id": "L4", "cue": "invalid metadata", "scope": [], "lesson": 42, "proposal": {}}],
                                "file": "batch-2026-11-09.md"}]}
    live = write_record(tmp_path, "reflect-live", state)
    archived = dict(state, created=now - 500, pid=None, executor="codex", account="lab",
                    reflect_order=None, reflect_mode="batch", outcome="completed", error="x" * 350)
    archived["reflect_turns"] = [
        {"at": now - 200, "status": "done", "summary": "The targeted check is sufficient", "file": "batch-2026-11-08.md"},
        {"at": now - 400, "status": "needs_decision", "summary": "Keep both checks?", "questions": ["Which one?"],
         "options": [["Targeted", "Full"]]},
        {"at": True, "status": "done", "summary": "invalid time"},
        "invalid turn",
    ]
    saved = write_record(tmp_path / ".archive", "reflect-old-20261108T000000Z", archived)
    (saved.parent / "messages.jsonl").write_text("\n".join([
        json.dumps({"at": now - 300, "source": "lead", "text": "Keep the targeted check"}),
        json.dumps({"at": now - 100, "source": "analyst", "text": "not a lead message"}),
        json.dumps({"at": False, "source": "lead", "text": "invalid time"}),
        "{broken", "[]",
    ]))
    write_record(tmp_path, "broken-study", "{broken")
    write_record(tmp_path / ".archive", "broken-20261108T010000Z", "{broken")
    old_stamp = datetime.fromtimestamp(now, timezone.utc) - timedelta(days=31)
    write_record(tmp_path / ".archive", f"expired-{old_stamp:%Y%m%dT%H%M%SZ}", archived)
    reads = counting(monkeypatch)
    message_reads = []
    original = research_module.load_messages

    def load_messages(path):
        message_reads.append(path)
        return original(path)

    monkeypatch.setattr(research_module, "load_messages", load_messages)
    research = Research(tmp_path, seconds=0)
    studies = research.view()["studies"]
    assert [study["slug"] for study in studies] == ["reflect-live", "reflect-old"]
    current, old = studies
    assert (current["archived"], current["alive"], current["waiting"], current["mode"]) == (False, True, False, "study")
    assert (current["executor"], current["account"], current["records"], current["file"]) == (
        "claude", "observatory", 2, "batch-2026-11-09.md")
    assert current["messages"][1]["questions"] == [{"text": "Keep the targeted check?", "options": ["Yes", "No"]}]
    assert current["messages"][1]["lessons"] == [
        {"id": "L1", "cue": "slow full checks", "entry": "batch-2026-11-09.md L1", "scope": "invariant",
         "lesson": lesson_text[:600], "proposal": proposal_text[:600]},
        {"id": "L2", "cue": "local checks", "entry": "batch-2026-11-09.md L2", "scope": "domain", "lesson": "", "proposal": ""},
        {"id": "L3", "cue": "older lesson", "entry": "batch-2026-11-09.md L3", "scope": None, "lesson": None, "proposal": None},
        {"id": "L4", "cue": "invalid metadata", "entry": "batch-2026-11-09.md L4", "scope": None, "lesson": None, "proposal": None},
    ]
    assert (old["archived"], old["mode"], old["account"], old["waiting"], len(old["error"])) == (True, "batch", "lab", False, 300)
    assert [(message["from"], message["text"]) for message in old["messages"]] == [
        ("lead", None), ("analyst", "Keep both checks?"),
        ("lead", "Keep the targeted check"), ("analyst", "The targeted check is sufficient"),
    ]
    assert old["messages"][0]["at"] == archived["created"]
    previous_reads = reads.copy()
    assert research.view()["studies"] == studies
    assert reads == previous_reads
    assert len(message_reads) == 1

    state["pid"] = None
    live.write_text(json.dumps(state))
    assert research.view()["studies"][0]["waiting"] is True
    assert reads.count("reflect-live") == 2
    assert len(message_reads) == 1
    messages = live.parent / "messages.jsonl"
    messages.write_text(json.dumps({"at": now - 80, "text": "Yes", "source": "lead"}) + "\n")
    answered = research.view()["studies"][0]
    assert answered["waiting"] is False
    assert answered["messages"][-1]["text"] == "Yes"
    assert reads.count("reflect-live") == 2
    assert len(message_reads) == 2
    previous = messages.stat()
    messages.write_text(json.dumps({"at": now - 80, "text": "Yes " + "x" * 4100, "source": "lead"}) + "\n")
    os.utime(messages, ns=(previous.st_atime_ns, previous.st_mtime_ns))
    assert len(research.view()["studies"][0]["messages"][-1]["text"]) == 4000
    assert len(message_reads) == 3


def test_studies_are_capped_newest_first_without_an_archive(tmp_path):
    for index in range(23):
        write_record(tmp_path, f"reflect-{index:02}",
                     {"kind": "reflect", "created": index, "reflect_order": {"invalid": True},
                      "reflect_records": "invalid", "reflect_turns": [None, {"at": "invalid"}],
                      "error": False})
    studies = Research(tmp_path).view()["studies"]
    assert len(studies) == 20
    assert [study["slug"] for study in studies] == [f"reflect-{index:02}" for index in range(22, 2, -1)]
    assert studies[0]["messages"] == [{"at": 22, "from": "lead", "text": None, "status": None,
                                       "questions": [], "lessons": [], "file": None}]
    assert (studies[0]["mode"], studies[0]["records"], studies[0]["waiting"], studies[0]["error"]) == ("batch", 0, False, None)


@pytest.fixture
def local_timezone(monkeypatch):
    with monkeypatch.context() as environment:
        def use(zone):
            environment.setenv("TZ", zone)
            time.tzset()

        use("Etc/GMT-3")
        yield use
    time.tzset()


def write_schedule(root, rows, directory="account/org"):
    path = root / "claude-code-sessions" / directory / "scheduled-tasks.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"scheduledTasks": rows}))
    return path


def test_schedule_selects_id_latest_run_and_enabled_tie(tmp_path, monkeypatch, local_timezone):
    now = datetime(2026, 11, 9, 6, 10, tzinfo=timezone.utc).timestamp()
    monkeypatch.setattr(research_module.time, "time", lambda: now)
    desktop = tmp_path / "desktop"
    row = {"id": "weekly", "cronExpression": "  0 9 * * *  ", "enabled": True,
           "displayName": "Daily reflection", "lastRunAt": "2026-11-09T06:09:39.700Z",
           "lastScheduledFor": "2026-11-09T06:00:00.000Z"}
    write_schedule(desktop, [dict(row, lastRunAt="2026-11-08T06:00:00Z")], "a/org")
    write_schedule(desktop, [dict(row, enabled=False)], "b/org")
    write_schedule(desktop, [dict(row, id="unrelated", lastRunAt="2026-11-10T06:00:00Z"),
                             dict(row, cronExpression=42), dict(row, enabled=1), row], "b/other-org")
    schedule = Research(tmp_path / "tasks", reflection_task="weekly", claude_desktop_dir=desktop).view()["schedule"]
    assert schedule == {
        "source": "desktop", "name": "Daily reflection", "cron": "0 9 * * *", "enabled": True,
        "last_run_at": datetime(2026, 11, 9, 6, 9, 39, 700000, tzinfo=timezone.utc).timestamp(),
        "last_scheduled_for": datetime(2026, 11, 9, 6, tzinfo=timezone.utc).timestamp(),
        "next_at": datetime(2026, 11, 10, 6, tzinfo=timezone.utc).timestamp(),
    }


def test_disabled_schedule_keeps_cron_and_invalid_optional_fields_are_null(tmp_path):
    write_schedule(tmp_path, [{"id": "codex-batch-reflection", "cronExpression": "0 9 * * *", "enabled": False,
                               "displayName": [], "lastRunAt": 42, "lastScheduledFor": "invalid"}])
    assert Research(tmp_path / "tasks", claude_desktop_dir=tmp_path).view()["schedule"] == {
        "source": "desktop", "name": None, "cron": "0 9 * * *", "enabled": False,
        "last_run_at": None, "last_scheduled_for": None, "next_at": None,
    }


@pytest.mark.parametrize("make", ["unconfigured", "missing directory", "missing file", "other id",
                                  "broken json", "oversized", "wrong shape"])
def test_missing_and_invalid_schedule_files_give_null(tmp_path, make):
    desktop = tmp_path / "desktop"
    if make not in ("unconfigured", "missing directory"):
        path = write_schedule(desktop, [{"id": "other", "cronExpression": "* * * * *", "enabled": True}])
        if make == "missing file":
            path.unlink()
        elif make == "broken json":
            path.write_text("{broken")
        elif make == "oversized":
            path.write_text(" " * (1024 * 1024) + path.read_text().replace('"other"', '"codex-batch-reflection"'))
        elif make == "wrong shape":
            path.write_text('{"scheduledTasks": {"id": "codex-batch-reflection"}}')
    research = Research(tmp_path / "tasks", claude_desktop_dir=None if make == "unconfigured" else desktop)
    assert research.view()["schedule"] is None


@pytest.mark.parametrize("component", ["desktop", "claude-code-sessions", "account", "org", "scheduled-tasks.json"])
def test_schedule_symlinks_are_not_read(tmp_path, component, monkeypatch):
    desktop = tmp_path / "desktop"
    path = write_schedule(desktop, [{"id": "codex-batch-reflection", "cronExpression": "* * * * *", "enabled": True}])
    target = next(part for part in (path, *path.parents) if part.name == component)
    outside = tmp_path / "outside"
    target.rename(outside)
    target.symlink_to(outside, target_is_directory=outside.is_dir())
    reads = counting(monkeypatch)
    assert Research(tmp_path / "tasks", claude_desktop_dir=desktop).view()["schedule"] is None
    assert reads == []


@pytest.mark.parametrize("cron,now,expected", [
    ("0 9 * * *", "2026-11-09T06:00:00+00:00", "2026-11-10T06:00:00+00:00"),
    ("*/15 * * * *", "2026-11-09T06:09:39.700+00:00", "2026-11-09T06:15:00+00:00"),
    ("30 8 * * 1-5", "2026-11-13T05:30:00+00:00", "2026-11-16T05:30:00+00:00"),
    ("0 10 1 * 1", "2026-11-09T06:00:00+00:00", "2026-11-09T07:00:00+00:00"),
    ("0 10 1 * 1", "2026-11-30T08:00:00+00:00", "2026-12-01T07:00:00+00:00"),
    ("5,20-40/10 8-10/2 * 11 1-5", "2026-11-09T05:30:00+00:00", "2026-11-09T05:40:00+00:00"),
    ("0 10 * * 0,7", "2026-11-09T06:00:00+00:00", "2026-11-15T07:00:00+00:00"),
    ("0 9 31 2 *", "2026-11-09T06:00:00+00:00", None),
    ("@daily", "2026-11-09T06:00:00+00:00", None),
    ("0 9 * * MON", "2026-11-09T06:00:00+00:00", None),
    ("0 9 * JAN *", "2026-11-09T06:00:00+00:00", None),
    ("0 0 9 * * *", "2026-11-09T06:00:00+00:00", None),
    ("60 9 * * *", "2026-11-09T06:00:00+00:00", None),
    ("*/0 * * * *", "2026-11-09T06:00:00+00:00", None),
])
def test_schedule_next_at_in_local_time(tmp_path, monkeypatch, local_timezone, cron, now, expected):
    monkeypatch.setattr(research_module.time, "time", lambda: datetime.fromisoformat(now).timestamp())
    write_schedule(tmp_path, [{"id": "codex-batch-reflection", "cronExpression": cron, "enabled": True}])
    schedule = Research(tmp_path / "tasks", claude_desktop_dir=tmp_path).view()["schedule"]
    assert schedule["cron"] == cron
    assert schedule["next_at"] == (datetime.fromisoformat(expected).timestamp() if expected else None)


@pytest.mark.parametrize("cron,now,expected", [
    ("30 2 * * *", "2026-03-08T05:00:00+00:00", "2026-03-09T06:30:00+00:00"),
    ("*/15 * * * *", "2026-11-01T05:20:00+00:00", "2026-11-01T05:30:00+00:00"),
    ("*/15 * * * *", "2026-11-01T06:05:00+00:00", "2026-11-01T06:15:00+00:00"),
])
def test_schedule_dst_gaps_and_repeated_times(local_timezone, cron, now, expected):
    local_timezone("EST5EDT,M3.2.0/2,M11.1.0/2")
    assert research_module.next_cron(cron, datetime.fromisoformat(now).timestamp()) == datetime.fromisoformat(expected).timestamp()


def test_schedule_rebuilds_next_at_but_reads_only_changed_files(tmp_path, monkeypatch, local_timezone):
    wall = [datetime(2026, 11, 9, 5, 59, tzinfo=timezone.utc).timestamp()]
    clock = [100.0]
    monkeypatch.setattr(research_module.time, "time", lambda: wall[0])
    monkeypatch.setattr(research_module.time, "monotonic", lambda: clock[0])
    row = {"id": "codex-batch-reflection", "cronExpression": "0 9 * * *", "enabled": True}
    path = write_schedule(tmp_path, [row])
    reads = counting(monkeypatch)
    research = Research(tmp_path / "tasks", seconds=30, claude_desktop_dir=tmp_path)
    first = research.view()
    assert first["schedule"]["next_at"] == wall[0] + 60
    wall[0] += 120
    clock[0] += 29
    assert research.view() is first
    clock[0] += 1
    assert research.view()["schedule"]["next_at"] == first["schedule"]["next_at"] + 24 * 3600
    assert reads == ["org"]
    row["cronExpression"] = "0 8 * * *"
    write_schedule(tmp_path, [row])
    os.utime(path, ns=(1, 1))
    clock[0] += 30
    assert research.view()["schedule"]["next_at"] == first["schedule"]["next_at"] + 23 * 3600
    row["cronExpression"] = "*/15 * * * *"
    write_schedule(tmp_path, [row])
    os.utime(path, ns=(1, 1))
    clock[0] += 30
    assert research.view()["schedule"]["next_at"] == wall[0] + 14 * 60
    assert reads == ["org", "org", "org"]
    path.unlink()
    clock[0] += 30
    assert research.view()["schedule"] is None
