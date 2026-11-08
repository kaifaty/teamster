"""Reflection lessons, the newest batch and pending records from a temporary archive."""

import json
import os

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
    ]
    assert lessons[1] == {"date": "2026-11-02", "entry": "beta-20261102T000000Z", "scope": "domain",
                          "scope_text": "domain a, b", "repos": ["a", "b"], "cue": "a flaky check",
                          "status": "applied", "status_text": "applied AGENTS.md in a"}


def test_batch_selection_counts_pending_and_bounded_reads(tmp_path, monkeypatch):
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
    write_record(archive, "old-20261104T000000Z", {"repo": "/r/old", "result": {"status": "blocked"}})
    write_record(archive, "one-20261106T000000Z", {"repo": "/r/alpha"})
    write_record(archive, "two-20261107T051647Z", {"repo": "/r/alpha", "result": {"status": "blocked"}})
    write_record(archive, "three-20261107T000000Z", {"repo": "/r/beta"})
    write_record(archive, "new-20261108T010000Z", {"repo": "/r/alpha", "result": {"status": "done"}})
    write_record(archive, "late-20261108T020000Z", {"repo": "/r/beta", "outcome": "refused"})
    write_record(archive, "later-20261108T030000Z", {"result": {"status": "needs_decision"}})
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
    # Records up to the previous batch's through are never read.
    assert "old-20261104T000000Z" not in reads
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
    assert view == {"lessons": [], "batch": None,
                    "pending": {"records": 0, "signals": 0, "repos": {}, "items": []},
                    "reflection_task": "weekly"}


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
