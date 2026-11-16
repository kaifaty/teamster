"""The terminal screen model that reads Claude setup-token's redrawn output."""
from pathlib import Path
import sys
import unittest


# Isolated Python omits the script directory from its import path.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from worker_loader import load_worker


class TerminalScreenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_worker(name="terminal_screen_worker").terminal_screen

    def screen(self, text, rows=4, columns=10):
        screen = self.module.Screen(rows, columns)
        screen.feed(text)
        return screen

    def lines(self, text, rows=4, columns=10):
        return self.screen(text, rows, columns).lines()

    def test_printing_wide_characters_combining_marks_and_autowrap(self):
        self.assertEqual(self.lines("abc"), ["abc", "", "", ""])
        # Wide characters take two cells; one that does not fit wraps whole.
        self.assertEqual(self.lines("日本\x1b[1;3Hx", rows=1, columns=6), ["日x"])
        self.assertEqual(self.lines("abcd日", rows=2, columns=5), ["abcd", "日"])
        self.assertEqual(self.lines("ab日\x1b[1;4Hz", rows=1), ["ab z"])
        self.assertEqual(self.lines("\uff21x\x1b[1;3HZ", rows=1), ["\uff21Z"])
        self.assertEqual(self.lines("e\u0301x", rows=1), ["e\u0301x"])
        self.assertEqual(self.lines("日\u0301", rows=1), ["日\u0301"])
        self.assertEqual(self.lines("a\u200bb", rows=1), ["ab"])
        # Autowrap waits at the last column until the next character.
        self.assertEqual(self.lines("abcdefghij", rows=2), ["abcdefghij", ""])
        self.assertEqual(self.lines("abcdefghijk", rows=2), ["abcdefghij", "k"])
        self.assertEqual(self.lines("abcdefghij\rX", rows=2), ["Xbcdefghij", ""])

    def test_carriage_return_newline_backspace_and_tab(self):
        self.assertEqual(self.lines("abc\rX"), ["Xbc", "", "", ""])
        # A line feed keeps the column, as on a terminal; the line discipline adds CR.
        self.assertEqual(self.lines("ab\ncd\r\nef"), ["ab", "  cd", "ef", ""])
        self.assertEqual(self.lines("abc\b\bX"), ["aXc", "", "", ""])
        self.assertEqual(self.lines("\bX"), ["X", "", "", ""])
        self.assertEqual(self.lines("a\tb", columns=20), ["a       b", "", "", ""])
        self.assertEqual(self.lines("a\t\t\tb", columns=12), ["a          b", "", "", ""])

    def test_cursor_moves_and_positions(self):
        base = "0123456789\r\n0123456789\r\n0123456789\r\n0123456789"
        cases = {"\x1b[2;3HA": (1, "01A3456789"), "\x1b[2;3fA": (1, "01A3456789"),
                 "\x1b[HA": (0, "A123456789"), "\x1b[;5HA": (0, "0123A56789"),
                 "\x1b[99;99HA": (3, "012345678A"), "\x1b[3dA": (2, "012345678A"),
                 "\x1b[2;2H\x1b[AA": (0, "0A23456789"), "\x1b[1;2H\x1b[2BA": (2, "0A23456789"),
                 "\x1b[1;2H\x1b[CA": (0, "01A3456789"), "\x1b[1;2H\x1b[3CA": (0, "0123A56789"),
                 "\x1b[1;5H\x1b[2DA": (0, "01A3456789"), "\x1b[1;5H\x1b[EA": (1, "A123456789"),
                 "\x1b[3;5H\x1b[2FA": (0, "A123456789"), "\x1b[1;5H\x1b[GA": (0, "A123456789"),
                 "\x1b[1;1H\x1b[7GA": (0, "012345A789"), "\x1b[1;1H\x1b[9AA": (0, "A123456789"),
                 "\x9b2;4HA": (1, "012A456789")}
        for sequence, (row, text) in cases.items():
            with self.subTest(sequence=repr(sequence)):
                self.assertEqual(self.lines(base + sequence)[row], text)

    def test_erase_display_and_line(self):
        base = "abcdef\r\nghijkl\r\nmnopqr\x1b[2;3H"
        self.assertEqual(self.lines(base + "\x1b[J"), ["abcdef", "gh", "", ""])
        self.assertEqual(self.lines(base + "\x1b[0J"), ["abcdef", "gh", "", ""])
        self.assertEqual(self.lines(base + "\x1b[1J"), ["", "   jkl", "mnopqr", ""])
        self.assertEqual(self.lines(base + "\x1b[2J"), ["", "", "", ""])
        self.assertEqual(self.lines(base + "\x1b[K"), ["abcdef", "gh", "mnopqr", ""])
        self.assertEqual(self.lines(base + "\x1b[1K"), ["abcdef", "   jkl", "mnopqr", ""])
        self.assertEqual(self.lines(base + "\x1b[2K"), ["abcdef", "", "mnopqr", ""])
        # Erasing half of a wide character erases both halves.
        self.assertEqual(self.lines("a日b\x1b[1;3H\x1b[K", rows=1), ["a"])
        self.assertEqual(self.lines("a日b\x1b[1;2H\x1b[X", rows=1), ["a  b"])

    def test_erase_delete_and_insert_characters(self):
        base = "abcdefgh\x1b[1;3H"
        self.assertEqual(self.lines(base + "\x1b[2X", rows=1), ["ab  efgh"])
        self.assertEqual(self.lines(base + "\x1b[X", rows=1), ["ab defgh"])
        self.assertEqual(self.lines(base + "\x1b[2P", rows=1), ["abefgh"])
        self.assertEqual(self.lines(base + "\x1b[99P", rows=1), ["ab"])
        self.assertEqual(self.lines(base + "\x1b[2@", rows=1), ["ab  cdefgh"])
        self.assertEqual(self.lines(base + "\x1b[4@", rows=1), ["ab    cdef"])
        self.assertEqual(self.lines("abcd\x1b[1;2H\x1b[P", rows=1), ["acd"])
        self.assertEqual(self.lines("abcd\x1b[1;2H\x1b[@", rows=1), ["a bcd"])
        # Shifting never leaves half of a wide character.
        self.assertEqual(self.lines("abc日\x1b[1;1H\x1b[@", rows=1, columns=5), [" abc"])
        self.assertEqual(self.lines("a日b\x1b[1;3H\x1b[P", rows=1, columns=5), ["a b"])
        self.assertEqual(self.lines("a日bc\x1b[1;2H\x1b[P", rows=1, columns=5), ["a bc"])
        self.assertEqual(self.lines("a日b\x1b[1;3H\x1b[@", rows=1, columns=5), ["a   b"])

    def test_scrolling_into_scrollback_and_scroll_regions(self):
        screen = self.screen("1\r\n2\r\n3\r\n4\r\n5\r\n6", rows=3)
        self.assertEqual(screen.lines(), ["4", "5", "6"])
        self.assertEqual((screen.scrollback, screen.scrolled), (["1", "2", "3"], 3))
        self.assertEqual(screen.text(), "1\n2\n3\n4\n5\n6")
        screen.feed("\x1b[2S")
        self.assertEqual((screen.lines(), screen.scrollback), (["6", "", ""], ["1", "2", "3", "4", "5"]))
        screen.feed("\x1b[T")
        self.assertEqual(screen.lines(), ["", "6", ""])
        many = self.screen("x\r\n" * (self.module.SCROLLBACK_ROWS + 5), rows=2)
        self.assertEqual((len(many.scrollback), many.scrolled),
                         (self.module.SCROLLBACK_ROWS, self.module.SCROLLBACK_ROWS + 4))
        # Inside a region, lines scroll within it and never into the scrollback.
        region = self.screen("a\r\nb\r\nc\r\nd\x1b[2;3r\x1b[3;1H\nX", rows=4)
        self.assertEqual((region.lines(), region.scrollback), (["a", "c", "X", "d"], []))
        region.feed("\x1b[2;1H\x1bMY")
        self.assertEqual(region.lines(), ["a", "Y", "c", "d"])
        region.feed("\x1b[r\x1b[4;1H\nZ")
        self.assertEqual((region.lines(), region.scrollback), (["Y", "c", "d", "Z"], ["a"]))
        # A region with its top below its bottom is ignored.
        self.assertEqual(self.lines("a\x1b[3;2r\x1b[4;1H\nb", rows=4), ["", "", "", "b"])

    def test_saving_restoring_and_escape_moves(self):
        self.assertEqual(self.lines("ab\x1b7\x1b[3;5Hx\x1b8c"), ["abc", "", "    x", ""])
        self.assertEqual(self.lines("ab\x1b[s\x1b[3;5Hx\x1b[uc"), ["abc", "", "    x", ""])
        self.assertEqual(self.lines("ab\x1bDc"), ["ab", "  c", "", ""])
        self.assertEqual(self.lines("ab\x1bEc"), ["ab", "c", "", ""])
        self.assertEqual(self.lines("\r\nab\x1bMc"), ["  c", "ab", "", ""])
        screen = self.screen("a\x1bMb", rows=2)
        self.assertEqual((screen.lines(), screen.scrollback), ([" b", "a"], []))

    def test_alternate_screen_modes_clear_on_switch(self):
        for mode in ("1049", "1047", "47"):
            with self.subTest(mode=mode):
                screen = self.screen("main\x1b[?%sh" % mode)
                self.assertEqual(screen.lines(), ["", "", "", ""])
                screen.feed("\x1b[2;1Halt\r\n" * 5)
                self.assertEqual(screen.scrollback, [])
                screen.feed("\x1b[?%slmore" % mode)
                restored = screen.lines()
                self.assertEqual(restored[0], "mainmore" if mode == "1049" else "main")
                screen.feed("\x1b[?%shz" % mode)
                self.assertNotIn("alt", screen.text())

    def test_attributes_strings_and_unknown_sequences_are_ignored(self):
        self.assertEqual(self.lines("\x1b[1;31ma\x1b[38:2::1:2:3mb\x1b[0mc\x1b[?25l\x1b[?2004h\x1b(Bd"),
                         ["abcd", "", "", ""])
        self.assertEqual(self.lines("\x1b]0;title\x07a\x1b]2;t\x1b\\b\x9d0;t\x9cc"), ["abc", "", "", ""])
        # OSC 8 links keep their text.
        self.assertEqual(self.lines("\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\", columns=20),
                         ["link", "", "", ""])
        self.assertEqual(self.lines("a\x1bPq#0;1\x1b\\b\x1b_apc\x1b\\c\x1b^pm\x9cd\x1bXsos\x1b\\e\x90x\x9cf",
                                    columns=20), ["abcdef", "", "", ""])
        # A string's BEL ends only OSC; CAN aborts a sequence; a new escape ends a string.
        self.assertEqual(self.lines("\x1bPa\x07b\x1b\\c\x1b[3\x18Cd\x1b]0;t\x1b[2Ce"), ["cCd  e", "", "", ""])
        self.assertEqual(self.lines("\x7fa\x07\x00b\x1b[>4;2mc\x1b[5 qd\x1b#8e"), ["abcde", "", "", ""])
        screen = self.screen("\x1b[?2026h")
        self.assertTrue(screen.synchronized)
        screen.feed("\x1b[?2026l")
        self.assertFalse(screen.synchronized)

    def test_sequences_split_across_feeds(self):
        screen = self.module.Screen(2, 20)
        for piece in ("ab\x1b", "[", "2;", "3Hc\x1b]8;;htt", "ps://x\x1b", "\\d\x1b]8;;\x1b\\"):
            screen.feed(piece)
        self.assertEqual(screen.lines(), ["ab", "  cd"])

    def test_a_diff_redraw_keeps_unchanged_cells(self):
        screen = self.module.Screen(3, 70)
        screen.feed("\x1b[H\x1b[2JPaste code here if prompted >")
        # Only the changed cells are written; CUP, CUF and CHA jump over the rest.
        screen.feed("\x1b[1;1Hsk-ant-\x1b[9Gat01-event-secre\x1b[1C\x1b[K")
        self.assertEqual(screen.lines()[0], "sk-ant-oat01-event-secret")


if __name__ == "__main__":
    unittest.main()
