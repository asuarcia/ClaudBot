# widgets/

Rainmeter desktop widgets for Claudbot. Full documentation: [`docs/widgets.md`](../docs/widgets.md).

```
bridge.mjs              data pump — polls, writes .claudbot/widgets/*.txt, handles click actions
install.mjs             copies skins into Rainmeter and generates paths.inc for this machine
skins/Claudbot/
  @Resources/
    common.inc          shared palette and type — edit to restyle all four at once
    paths.inc           GENERATED at install time, gitignored, never commit
  Status/Status.ini     service status, agent usage, CLI launchers
  PostIt/PostIt.ini     sticky note — self-contained, no bridge needed
  Stocks/Stocks.ini     three-symbol Finnhub watchlist
  Todo/Todo.ini         organizer tasks, synced with Notion
```

## Quick start

```powershell
winget install --id Rainmeter.Rainmeter -e
claudbot widgets install
claudbot widgets
```

## Adding a widget

1. Have `bridge.mjs` build a `fields` array and register it in `refresh()`.
   Order matters and is the contract — the skin's regex is positional.
2. Add a skin directory with a WebParser measure reading
   `file://#DataDir#\<name>.txt` and one `(.*)\n` group per field.
3. Include `@Resources/common.inc` and `@Resources/paths.inc` so it inherits the
   palette and this machine's paths.

Two rules the format depends on:

- **Every field must be one line.** `sanitize()` collapses newlines and tabs,
  because a stray newline shifts every field after it and silently corrupts the
  whole widget.
- **Fixed field count.** Empty rows are emitted as blanks rather than omitted,
  so the line offsets never move.

## Rainmeter gotchas

Each of these cost a debugging round, and three of the four fail *silently* —
nothing in `Rainmeter.log`, the meter just doesn't draw.

| Rule | What happens if you break it |
|---|---|
| A `MeterStyle` target must contain options only — **no `Meter=` line** | Every meter inheriting the style renders nothing. No error. |
| Skin files must be **UTF-16LE**; a UTF-8 BOM is not enough | Non-ASCII is read as ANSI — `○` displays as `â—‹`. `install.mjs` converts on copy, so keep the repo copies UTF-8. |
| `StringAlign=Center` centers text *on* `X`, but `SolidColor` draws the box *from* `X` | Buttons drift off the card. Use padding-sized chips instead of fixed `W`/`H`. |
| Gradients must be defined **in the meter section**, never `[Variables]` | `LinearGradient has invalid parameters`. Also `;` opens a comment in an ini and eats the stops. |
| Path segments need explicit commands (`LineTo`); only the first point is bare | `Invalid Path type` — where "type" means the *segment command*, not the coordinates. |
| Path points must be literal numbers | Formulas like `(#W#-30)` are not evaluated inside a Path. |

Data files read through WebParser are a different code path and are fine as
UTF-8 with `CodePage=65001`.

To debug, turn on logging (`Logging=1` in `Rainmeter.ini`) and watch
`%APPDATA%\Rainmeter\Rainmeter.log`. Note that a full Rainmeter restart is
sometimes needed; `!RefreshApp` does not always pick up encoding changes.

## Actions

Skins invoke `node bridge.mjs action <verb> …` on click:

| Verb | Effect |
|---|---|
| `task-done <id>` | complete a task, then push to Notion |
| `task-add <title…>` | create a task |
| `notion-sync` | force a two-way sync now |
| `open-notion` | open the tasks database in a browser |
| `open-organizer` | open `localhost:4700` |
| `watchlist-set <1-3> <symbol>` | change a watchlist slot |
| `refresh [name]` | rewrite one widget file, or all of them |

An empty argument means the user cancelled the input box — Rainmeter fires the
action either way — so actions ignore blank input instead of acting on it.
