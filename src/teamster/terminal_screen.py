"""A small terminal screen: what a person would see of full-screen tool output.

Renderers that redraw only the cells that changed move the cursor over the
unchanged ones, so their output reads correctly only after it is applied to a
grid. Screen applies the cursor, erase and scroll sequences such renderers use,
ignores attributes and every other sequence, and strips OSC, DCS, SOS, PM and
APC strings while keeping the text between them (the text of an OSC 8 link).
"""
import unicodedata

# Rows kept after they scroll off the top of the main screen.
SCROLLBACK_ROWS = 1000
TAB_WIDTH = 8
# The alternate screen modes: 1049 also saves and restores the cursor.
ALTERNATE_MODES = ("1049", "1047", "47")
# Applications bracket a frame with this mode (synchronized output).
SYNCHRONIZED_MODE = "2026"

GROUND, ESCAPE, CSI, STRING, STRING_ESCAPE = range(5)


def width(char):
    """Cells a printable character takes: 0 joins the previous cell."""
    if unicodedata.combining(char) or unicodedata.category(char) in ("Mn", "Me"):
        return 0
    return 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1


class Screen:
    """A grid of cells with a cursor, fed decoded terminal output.

    A cell holds one character and its combining marks; the right half of a
    wide character holds "". Rows that scroll off the top of the main screen
    are kept in `scrollback` as text; `scrolled` counts every such row.
    """

    def __init__(self, rows, columns):
        self.rows, self.columns = rows, columns
        self.scrollback = []
        self.scrolled = 0
        self.synchronized = False
        self.grid = [self._blank() for _ in range(rows)]
        self.y = self.x = 0
        self.top, self.bottom = 0, rows - 1
        self.pending_wrap = False
        self.saved = (0, 0, False)
        self.main = None
        self.state = GROUND
        self.osc = False
        self.sequence = ""

    def _blank(self):
        return [" "] * self.columns

    def lines(self):
        """The screen rows as text, right-stripped."""
        return [self._text(row) for row in self.grid]

    def text(self):
        """Scrollback and screen rows, one per line."""
        return "\n".join(self.scrollback + self.lines())

    def _text(self, row):
        cells, wide = [], False
        for cell in row:
            if cell == "" and wide:
                wide = False
                continue
            wide = cell != "" and width(cell[0]) == 2
            cells.append(cell or " ")
        return "".join(cells).rstrip()

    def feed(self, text):
        for char in text:
            code = ord(char)
            if self.state == GROUND:
                if code < 0x20 or 0x7f <= code < 0xa0:
                    self._control(char)
                else:
                    self._print(char)
            elif char in "\x18\x1a":
                self.state = GROUND
            elif self.state == STRING:
                if char == "\x1b":
                    self.state = STRING_ESCAPE
                elif char == "\x9c" or char == "\x07" and self.osc:
                    self.state = GROUND
            elif self.state == STRING_ESCAPE:
                if char == "\\":
                    self.state = GROUND
                else:
                    self.state = ESCAPE
                    self.sequence = ""
                    self._escape(char)
            elif char == "\x1b":
                self.state, self.sequence = ESCAPE, ""
            elif code < 0x20:
                self._control(char)
            elif self.state == ESCAPE:
                self._escape(char)
            elif 0x20 <= code < 0x40:
                self.sequence += char
            else:
                self.state = GROUND
                if 0x40 <= code < 0x7f:
                    self._csi(char)

    def _control(self, char):
        if char == "\x1b":
            self.state, self.sequence = ESCAPE, ""
        elif char == "\x9b":
            self.state, self.sequence = CSI, ""
        elif char in "\x9d\x90\x98\x9e\x9f":
            self.state, self.osc = STRING, char == "\x9d"
        elif char == "\r":
            self.x, self.pending_wrap = 0, False
        elif char in "\n\x0b\x0c\x84":
            self._index()
        elif char == "\x85":
            self.x = 0
            self._index()
        elif char == "\x8d":
            self._reverse_index()
        elif char == "\b":
            self.x, self.pending_wrap = max(0, self.x - 1), False
        elif char == "\t":
            self.x = min(self.columns - 1, (self.x // TAB_WIDTH + 1) * TAB_WIDTH)

    def _escape(self, char):
        if "\x20" <= char < "\x30":
            self.sequence += char
            return
        self.state = GROUND
        if self.sequence:
            return
        if char == "[":
            self.state = CSI
        elif char in "]PX^_":
            self.state, self.osc = STRING, char == "]"
        elif char == "7":
            self.saved = (self.y, self.x, self.pending_wrap)
        elif char == "8":
            self._restore(self.saved)
        elif char == "D":
            self._index()
        elif char == "E":
            self.x = 0
            self._index()
        elif char == "M":
            self._reverse_index()

    def _print(self, char):
        size = width(char)
        if size == 0:
            self._combine(char)
            return
        if unicodedata.category(char) == "Cf":
            return
        if self.pending_wrap:
            self._wrap()
        if size == 2 and self.columns > 1 and self.x == self.columns - 1:
            self._wrap()
        row = self.grid[self.y]
        self._split(row, self.x)
        row[self.x] = char
        if size == 2 and self.x + 1 < self.columns:
            self._split(row, self.x + 1)
            row[self.x + 1] = ""
        self.x += size
        if self.x >= self.columns:
            self.x, self.pending_wrap = self.columns - 1, True

    def _combine(self, char):
        x = self.x if self.pending_wrap else self.x - 1
        row = self.grid[self.y]
        if x > 0 and row[x] == "":
            x -= 1
        if x >= 0:
            row[x] += char

    def _split(self, row, x):
        """Blank the other half of a wide character before cell x is overwritten."""
        if row[x] == "" and x > 0:
            row[x - 1] = " "
        if x + 1 < self.columns and row[x + 1] == "":
            row[x + 1] = " "

    def _wrap(self):
        self.x, self.pending_wrap = 0, False
        self._index()

    def _index(self):
        self.pending_wrap = False
        if self.y == self.bottom:
            self._scroll_up(1)
        elif self.y < self.rows - 1:
            self.y += 1

    def _reverse_index(self):
        self.pending_wrap = False
        if self.y == self.top:
            self._scroll_down(1)
        elif self.y > 0:
            self.y -= 1

    def _scroll_up(self, count):
        for _ in range(min(count, self.bottom - self.top + 1)):
            row = self.grid.pop(self.top)
            if self.top == 0 and self.main is None:
                self.scrollback.append(self._text(row))
                del self.scrollback[:-SCROLLBACK_ROWS]
                self.scrolled += 1
            self.grid.insert(self.bottom, self._blank())

    def _scroll_down(self, count):
        for _ in range(min(count, self.bottom - self.top + 1)):
            del self.grid[self.bottom]
            self.grid.insert(self.top, self._blank())

    def _restore(self, saved):
        y, x, pending = saved
        self.y, self.x = min(y, self.rows - 1), min(x, self.columns - 1)
        self.pending_wrap = pending

    def _unwide(self, row, start, end):
        """Blank wide characters that cells start..end would cut in half."""
        if start > 0 and row[start] == "":
            row[start - 1] = " "
        if end < self.columns and row[end] == "":
            row[end] = " "

    def _erase(self, y, start, end):
        row = self.grid[y]
        self._unwide(row, start, end)
        row[start:end] = [" "] * (end - start)

    def _csi(self, final):
        private = self.sequence[:1] in ("<", "=", ">", "?")
        body = self.sequence[1:] if private else self.sequence
        if any(char in body for char in " !\"#$%&'()*+,-./"):
            return  # Intermediate bytes select other functions.
        if private:
            if self.sequence[0] == "?" and final in "hl":
                for mode in body.split(";"):
                    self._mode(mode, final == "h")
            return
        values = [int(value.split(":")[0] or 0) if value.split(":")[0].isdigit() else 0
                  for value in body.split(";")]
        count = max(1, values[0])
        mode = values[0]
        last_row, last_column = self.rows - 1, self.columns - 1
        if final in "ABCDEFGHfd":
            self.pending_wrap = False
        if final == "A":
            self.y = max(self.top if self.y >= self.top else 0, self.y - count)
        elif final == "B":
            self.y = min(self.bottom if self.y <= self.bottom else last_row, self.y + count)
        elif final == "C":
            self.x = min(last_column, self.x + count)
        elif final == "D":
            self.x = max(0, self.x - count)
        elif final == "E":
            self.y = min(self.bottom if self.y <= self.bottom else last_row, self.y + count)
            self.x = 0
        elif final == "F":
            self.y = max(self.top if self.y >= self.top else 0, self.y - count)
            self.x = 0
        elif final == "G":
            self.x = min(last_column, count - 1)
        elif final in "Hf":
            column = values[1] if len(values) > 1 else 0
            self.y, self.x = min(last_row, count - 1), min(last_column, max(1, column) - 1)
        elif final == "d":
            self.y = min(last_row, count - 1)
        elif final == "J":
            self.pending_wrap = False
            if mode == 0:
                self._erase(self.y, self.x, self.columns)
                rows = range(self.y + 1, self.rows)
            elif mode == 1:
                self._erase(self.y, 0, self.x + 1)
                rows = range(self.y)
            else:
                rows = range(self.rows) if mode == 2 else ()
            for y in rows:
                self.grid[y] = self._blank()
        elif final == "K":
            self.pending_wrap = False
            start, end = {0: (self.x, self.columns), 1: (0, self.x + 1)}.get(mode, (0, self.columns))
            if mode in (0, 1, 2):
                self._erase(self.y, start, end)
        elif final == "X":
            self.pending_wrap = False
            self._erase(self.y, self.x, min(self.columns, self.x + count))
        elif final in "P@":
            self.pending_wrap = False
            row = self.grid[self.y]
            count = min(count, self.columns - self.x)
            if final == "P":
                self._unwide(row, self.x, self.x + count)
                row[self.x:] = row[self.x + count:] + [" "] * count
            else:
                self._unwide(row, self.x, self.x)
                self._unwide(row, self.columns - count, self.columns)
                row[self.x:] = [" "] * count + row[self.x:self.columns - count]
        elif final == "S":
            self._scroll_up(count)
        elif final == "T" and len(values) == 1:
            self._scroll_down(count)
        elif final == "r":
            top = max(1, values[0]) - 1
            bottom = (values[1] if len(values) > 1 and values[1] else self.rows) - 1
            if top < min(bottom, last_row):
                self.top, self.bottom = top, min(bottom, last_row)
                self.y, self.x, self.pending_wrap = 0, 0, False
        elif final == "s":
            self.saved = (self.y, self.x, self.pending_wrap)
        elif final == "u":
            self._restore(self.saved)

    def _mode(self, mode, on):
        if mode == SYNCHRONIZED_MODE:
            self.synchronized = on
        elif mode in ALTERNATE_MODES:
            if on and self.main is None:
                self.main = (self.grid, (self.y, self.x, self.pending_wrap))
                self.grid = [self._blank() for _ in range(self.rows)]
            elif not on and self.main is not None:
                self.grid, cursor = self.main
                self.main = None
                if mode == "1049":
                    self._restore(cursor)
