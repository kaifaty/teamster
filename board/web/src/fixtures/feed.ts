// The fixture agents' feeds (`GET /api/tasks/{slug}/feed`): what an implementing agent and an analyst do, one item after
// another while they work, with every kind of item, a long message of several paragraphs and a run of eight commands.
// A cursor counts the items from the feed's beginning; like the server, a feed without one gives its newest 400.
import type { FeedItem, TaskFeed } from "../types";

type Step = [FeedItem["kind"], string];

/** An implementing agent's turn. */
export const AGENT_WORK: Step[] = [
  ["thinking", "Сначала найду, где проверяется формат сохранения.\nПотом посмотрю, какие тесты уже есть, и только затем решу, куда записать правило."],
  ["command", "rg -n \"save_format\" src tests"],
  ["tool", "Read src/save/loader.py"],
  ["message", "Формат проверяется в `src/save/loader.py`, но теста, который грузит сохранение прошлой версии, нет."],
  ["command", "ls tests tests/fixtures"],
  ["command", "git log --oneline -5 -- src/save"],
  ["command", "python -m pytest tests/test_save.py -q"],
  ["command", "head -40 tests/fixtures/save-v3.json"],
  ["command", "python tools/make_save.py --version 3 --out /tmp/save-v3.json --seed 7 --with-inventory --with-quests --with-settings --compress none"],
  ["command", "diff <(jq -S . /tmp/save-v3.json) <(jq -S . tests/fixtures/save-v3.json)"],
  ["command", "rg -n \"def migrate\" src/save"],
  ["command", "python -c \"import save.loader as l; print(l.SUPPORTED)\""],
  ["edit", "tests/test_save_migration.py"],
  ["command", "python -m pytest tests/test_save_migration.py -q"],
  ["thinking", "Тест падает на поле inventory: в третьей версии оно было списком, теперь словарь.\nМиграция есть, но вызывается только для второй версии."],
  ["edit", "src/save/loader.py, tests/fixtures/save-v3.json"],
  ["tool", "Grep migration"],
  ["command", "python -m pytest tests -q"],
  ["edit", "AGENTS.md"],
  [
    "message",
    "Готово: правило записано, проверка добавлена.\n\n" +
      "Что сделал. В `AGENTS.md` появилось правило: изменение формата сохранения приходит вместе с тестом, который " +
      "загружает сохранение прошлой версии. Тест `tests/test_save_migration.py` берёт файл третьей версии и проверяет, " +
      "что инвентарь, задания и настройки переносятся без потерь.\n\n" +
      "Что нашёл по дороге. Миграция третьей версии не вызывалась: загрузчик знал только о второй. Это исправлено в " +
      "`src/save/loader.py`, иначе новый тест не проходил бы.\n\n" +
      "Проверки: весь набор тестов проходит, 214 тестов за 38 с.",
  ],
  ["command", "git commit -m \"Test the save migration with the format change\""],
  ["command", "git push -u origin lesson/save-migration"],
];

/** An analyst's turn. */
export const STUDY_WORK: Step[] = [
  ["thinking", "Сначала прочитаю записи по задачам, потом сравню, где ушло время."],
  ["tool", "Read records/demo-wallet/died-supervisor.md"],
  ["tool", "Read records/demo-vault/merge-conflict-fix.md"],
  ["command", "rg -n \"check_failed\" records"],
  ["command", "rg -n \"fix_rounds\" records"],
  ["message", "В обеих задачах полный набор тестов гоняли по три раза, прежде чем воспроизвести падение одним тестом."],
  ["tool", "Grep \"pytest -x\""],
  ["thinking", "Похоже на один урок, но в demo-vault причина ещё и в конфликте с main.\nНадо проверить, был ли там rebase."],
  ["command", "rg -n \"rebase\" records/demo-vault"],
  ["edit", "study-2026-11-07.md"],
];

const HELD = 400;

interface Feed {
  /** The newest items; `offset` counts those dropped before them. */
  items: FeedItem[];
  offset: number;
  /** Older work that did not fit even before the fixtures began. */
  truncated: boolean;
  script: Step[];
  step: number;
}

export function fixtureFeeds() {
  const feeds = new Map<string, Feed>();
  const feedOf = (slug: string, script: Step[]) => {
    let feed = feeds.get(slug);
    if (!feed) feeds.set(slug, (feed = { items: [], offset: 0, truncated: false, script, step: 0 }));
    return feed;
  };
  /** The agent's next step, at `at`; returns it. */
  function push(slug: string, script: Step[], at: number): FeedItem {
    const feed = feedOf(slug, script);
    const [kind, text] = feed.script[feed.step++ % feed.script.length]!;
    const item = { at, kind, text };
    feed.items.push(item);
    if (feed.items.length > HELD) {
      feed.items.shift();
      feed.offset++;
    }
    return item;
  }
  /** A feed with `count` steps already done, one per `every` seconds up to `until`. */
  function seed(slug: string, script: Step[], count: number, until: number, every: number, truncated = false) {
    for (let index = 0; index < count; index++) push(slug, script, until - (count - 1 - index) * every);
    feedOf(slug, script).truncated = truncated;
  }
  /** As the server answers: everything held without `after`, what is new after it otherwise; null for an unknown task. */
  function read(slug: string, after: string | null): TaskFeed | null {
    const feed = feeds.get(slug);
    if (!feed) return null;
    const end = feed.offset + feed.items.length;
    const cursor = String(end);
    const from = after === null ? NaN : Number(after);
    if (Number.isInteger(from) && from >= feed.offset && from <= end) {
      return { items: feed.items.slice(from - feed.offset), cursor, reset: false, truncated: false };
    }
    return { items: [...feed.items], cursor, reset: after !== null, truncated: feed.truncated || feed.offset > 0 };
  }
  return { push, seed, read, has: (slug: string) => feeds.has(slug) };
}

/** A fixture agent's report, the whole summary of its last result. */
export function fixtureReport(summary: string | null, questions: readonly string[]): string | null {
  if (!summary && !questions.length) return null;
  const asked = questions.length ? `\n\nВопросы:\n${questions.map((question) => `- ${question}`).join("\n")}` : "";
  return `${summary ?? ""}\n\nЧто сделано:\n- прочитал урок и нашёл места, которых он касается;\n- добавил проверку и запустил набор тестов.${asked}`.trim();
}
