import json

import pytest

from teamster_board.constellations import MAX_BYTES, read_constellations


def write(tmp_path, value):
    path = tmp_path / "board-constellations.json"
    path.write_text(value if isinstance(value, str) else json.dumps(value))
    return path


def test_no_file_means_no_constellations(tmp_path):
    assert read_constellations(tmp_path / "board-constellations.json") == {"constellations": [], "error": None}


def test_reads_names_and_patterns_trimmed_without_repeats(tmp_path):
    path = write(tmp_path, {"constellations": [
        {"name": " MyWallet ", "repos": ["mytonwallet-*", " my-pulse", "my-pulse"]},
        {"name": "Gothic", "repos": ["gothic"]},
    ]})
    assert read_constellations(path) == {"constellations": [
        {"name": "MyWallet", "repos": ["mytonwallet-*", "my-pulse"]},
        {"name": "Gothic", "repos": ["gothic"]},
    ], "error": None}


@pytest.mark.parametrize("value", [
    "not json",
    [],
    {"constellations": {}},
    {"constellations": [{"name": "", "repos": ["a"]}]},
    {"constellations": [{"name": "A", "repos": []}]},
    {"constellations": [{"name": "A", "repos": ["../etc"]}]},
    {"constellations": [{"name": "A", "repos": [3]}]},
    {"constellations": [{"name": "A", "repos": ["a"]}, {"name": "A", "repos": ["b"]}]},
    {"constellations": [{"name": f"c{i}", "repos": ["a"]} for i in range(33)]},
])
def test_a_broken_file_gives_none_and_says_why(tmp_path, value):
    result = read_constellations(write(tmp_path, value))
    assert result["constellations"] == []
    assert result["error"]


def test_a_symbolic_link_or_a_huge_file_is_not_read(tmp_path):
    target = write(tmp_path, {"constellations": []})
    link = tmp_path / "link.json"
    link.symlink_to(target)
    assert "symbolic link" in read_constellations(link)["error"]
    huge = write(tmp_path, " " * (MAX_BYTES + 1))
    assert "KiB" in read_constellations(huge)["error"]
