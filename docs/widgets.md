# Desktop widgets

Four Rainmeter widgets that put Claudbot on the Windows desktop: a status and
launcher panel, a sticky note, a stock watchlist, and your Notion-backed tasks.

[Rainmeter](https://www.rainmeter.net) is GPL v2 and the skins here are plain
text `.ini` files — nothing is compiled, and you can read every line of what
renders on your desktop.

---

## Install

```powershell
winget install --id Rainmeter.Rainmeter -e
claudbot widgets install     # copy the skins + generate this machine's paths
claudbot widgets autostart   # start them now, and at every logon from here on
```

Then right-click the Rainmeter tray icon → **Refresh all**, and load
`Claudbot ▸ Status`, `PostIt`, `Stocks`, `Todo`.

`claudbot widgets install` is safe to re-run; do it again after moving or
renaming the Claudbot checkout.

If you'd rather run the feed in a terminal you can watch, `claudbot widgets`
does that instead. It also starts automatically as part of `claudbot night`.
Only one copy ever runs — see [One feed at a time](#one-feed-at-a-time).

---

## Surviving a reboot

Nothing about Rainmeter or the feed is persistent on its own. Rainmeter is an
ordinary application that has to be launched, and the feed is an ordinary
process that dies with its terminal. After a restart you get a bare desktop
until you start both by hand.

```powershell
claudbot widgets autostart             # register it (and start them right now)
claudbot widgets autostart status      # what's registered, what's running
claudbot widgets autostart uninstall   # stop doing that
```

This registers one Scheduled Task, `\Claudbot\Widgets`, which runs a supervisor
that starts whichever of the two isn't already up:

```
logon +30s ─┐
            ├──> supervisor ──> Rainmeter.exe not running?  start it
every 15min ┘                └─> bridge.mjs not running?     start it
```

It's a supervisor rather than two "launch this program" shortcuts so that a
crashed feed, or a Rainmeter you exited by accident, comes back on the next
tick instead of staying gone until the next reboot. Both checks are cheap and
the whole pass exits in well under a second.

The 30-second logon delay lets the desktop finish coming up first — Rainmeter
draws onto the shell, and starting it while Explorer is still settling is how
skins end up in the wrong place.

Rainmeter restores whichever skins were loaded when it last closed (it keeps an
`Active=1` line per skin in `Rainmeter.ini`), so the supervisor deliberately
does **not** force the four Claudbot skins back on. Closing one has to mean
something.

### Why a VBScript shim is involved

A Scheduled Task action that runs `node.exe` directly puts a console window on
your desktop at every logon. The task's **Hidden** setting does not prevent it —
that flag hides the *task* in the Task Scheduler UI, not the window. Measured on
Windows 11 build 26200:

| Task action | Console window? |
|---|---|
| `node.exe bridge.mjs` | **visible** |
| `node.exe` with the task's `Hidden` setting | **visible** |
| `powershell -WindowStyle Hidden` → `Start-Process -WindowStyle Hidden` | **visible** (PowerShell's own window flashes) |
| `wscript.exe autostart.vbs` | none |
| `conhost.exe --headless node.exe …` | none |

So the task runs `wscript.exe` against a generated one-line `autostart.vbs`,
which starts the supervisor with window style `0`. `wscript` is the primary
because it is documented and unchanged for decades; `conhost --headless` is the
automatic fallback for a machine without it, since VBScript is a Feature on
Demand as of Windows 11 24H2 and is on Microsoft's deprecation path.

`autostart.vbs` and `autostart.xml` (the task definition) are generated into
`.claudbot/widgets/` at install time and are gitignored, for the same reason
`paths.inc` is: they contain this machine's absolute paths.

### No admin required

The task is registered under `\Claudbot\` rather than the Task Scheduler root.
Creating a task in the root folder needs elevation; creating one in a subfolder
does not. Running whether-you-are-logged-on-or-not (`S4U`) would also avoid the
window entirely, but *that* needs elevation, so it isn't used.

To see or remove the task by hand: Task Scheduler → **Task Scheduler Library ▸
Claudbot ▸ Widgets**.

### One feed at a time

Three things can start `bridge.mjs --watch`: `claudbot widgets`, `claudbot
night`, and the logon task. Two at once wouldn't corrupt anything — every write
is atomic — but it doubles the Finnhub calls against a free-tier key.

So the bridge claims `.claudbot/widgets/bridge.pid` on start, and a second copy
prints `already running (pid N)` and exits 0. The pid check also matches the
process image name, not just the pid, because Windows recycles pids and a stale
file would otherwise eventually name some unrelated live process — convincing
the supervisor the feed was healthy forever.

Night mode understands that exit: a `--watch` child that exits 0 within five
seconds declined to start rather than crashed, so it isn't restarted on a
backoff loop.

### Logs

The supervisor runs with no console, so it writes to
`.claudbot/widgets/autostart.log`, and hands the bridge's stdout and stderr to
`.claudbot/widgets/bridge.log`. Both are trimmed to the most recent 128 KB.
`claudbot widgets autostart status` prints the last few lines of the first.

---

## How it works

Rainmeter skins are display-only. They can read a file and run a command, but
they can't hold a secret or speak an authenticated API without leaving the key
in a plaintext `.ini` inside your Documents folder. So none of the skins touch
the network:

```
Finnhub ─┐
Notion  ─┼──> widgets/bridge.mjs ──> .claudbot/widgets/*.txt ──> Rainmeter
local   ─┘         ^                                                │
                   └────────── click actions ─────────────────────┘
```

`widgets/bridge.mjs` polls, writes three flat text files, and exposes a set of
one-shot actions the skins invoke on click. API keys stay in `.env`.

**Why flat `.txt` and not JSON** — Rainmeter parses with a regular expression,
not a JSON parser. One value per line in a fixed order collapses to a single
clean `(?siU)` capture per widget. A `.json` twin is written alongside when you
pass `--debug`, purely for troubleshooting.

Files are written atomically (tmp + rename), so a widget polling every five
seconds can never catch a half-written file. If the bridge stops, the widgets
keep showing the last good values rather than going blank — a stale price beats
an empty panel — and the header switches to `bridge not running`.

### Refresh cadence

| Widget | Interval | Env override |
|---|---|---|
| Status | 30s | `CLAUDBOT_WIDGETS_STATUS_S` |
| Todo | 30s | `CLAUDBOT_WIDGETS_TODO_S` |
| Stocks (market open) | 60s | `CLAUDBOT_WIDGETS_STOCKS_S` |
| Stocks (market closed) | 15min | `CLAUDBOT_WIDGETS_STOCKS_CLOSED_S` |

Stocks are the only network cost. Three symbols once a minute is about 5% of
the Finnhub free tier. The cadence re-arms itself each tick, so it follows the
market opening and closing without a restart.

---

## The widgets

### Status

Service state (organizer, briefing, dream, screen), today's agent usage, and
eight one-click launchers for the CLI subcommands. Clicking the title opens the
organizer in your browser.

The usage figures come from `.claudbot/usage.json`, which is new — `runAgent()`
in `providers/agents.mjs` now records the `usage` block every NIM response
already returned and used to discard. Rolling 30-day window, per day, per agent.

Cost shows `—` by default. The NIM endpoints these agents run against are
credit-based, so rather than inventing a dollar figure it stays blank unless you
opt in with `CLAUDBOT_USAGE_RATE_PER_MTOK` in `.env`.

### Post-it

The only widget with no dependency on anything — not the bridge, not Claudbot,
not the network. Click a line to type on it, right-click to change the colour
(yellow, pink, blue, green, orange) or clear the note.

Text and colour persist via Rainmeter's own `!WriteKeyValue`, written into the
installed `PostIt.ini`. That means **your notes live in the installed copy**, so
`claudbot widgets uninstall` deletes them, and `claudbot widgets install`
overwrites them. Copy the note out first if it matters.

The paper is drawn with shape meters rather than an image: a two-stop gradient
for the sheen, three offset translucent rectangles standing in for a blurred
shadow, and two triangles making the folded corner. No binary assets in the repo.

### Stocks

Three symbols via [Finnhub](https://finnhub.io) — free key, 60 calls/minute.
Right-click any row to change its symbol. The watchlist lives in
`.claudbot/widgets/watchlist.json`.

Without `FINNHUB_API_KEY` the widget still renders, showing `no key`. Finnhub
answers `200` with all-zero fields for an unknown ticker rather than erroring,
so a zero price is treated as "no such symbol", not "worth $0".

Market hours are US regular session, derived from the `America/New_York` wall
clock so daylight saving is handled without a timezone library. Market holidays
aren't tracked — on a holiday it reads as open but Finnhub returns the previous
close, so the numbers stay truthful.

### Todo

The organizer's tasks, ordered exactly like its day spine: overdue (amber)
first, then due today, then undated, then future. Click a circle to complete a
task; that goes through the organizer's API and then pushes to Notion.

Reads the live organizer at `:4700` when it's running so Notion changes show up
promptly, and falls back to reading `.claudbot/organizer.json` directly when it
isn't — the header says `offline` so you know which you're looking at. Writes go
through the API whenever the organizer is up, which is what keeps two processes
from racing for the same file.

---

## Notion setup

Both values are required; either alone leaves sync switched off.

1. Create an internal integration at <https://www.notion.so/my-integrations>
   and copy its secret.
2. Open your tasks database in Notion → **⋯** → **Connections** → add the
   integration. Without this step the API returns 404 for the database.
3. Copy the database id out of the URL. In
   `notion.so/workspace/`**`1f2e3d4c5b6a7890abcdef1234567890`**`?v=…` the bold
   part is the id.
4. Put both in `.env`:

```
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
NOTION_TASKS_DB=1f2e3d4c5b6a7890abcdef1234567890
```

The sync assumes properties named `Name`, `Done`, and `Due`. Override with
`NOTION_TITLE_PROP` / `NOTION_DONE_PROP` / `NOTION_DUE_PROP` if yours differ.

### Checkbox or status — both work

The done flag can be either Notion property type. Older task databases use a
**checkbox**; Notion's current task template ships a **status** property with
`Not started / In progress / Done`. These are different types and no amount of
renaming bridges them, so `syncNotion()` fetches the database schema once per
sync (`loadDoneSchema()`) and writes whichever shape the database actually has.

For a status property, "done" maps to the first option in Notion's **Complete**
group and "not done" to the first in **To-do** — read back by checking whether
the current option is in the Complete group. If the schema lookup fails it falls
back to checkbox, which is the original behaviour.

**Due dates are optional.** Notion allows a date property with a blank name,
which can't be addressed through the API. Set `NOTION_DUE_PROP=` (empty) and
the sync simply omits due dates instead of sending a `""` key, which would fail
the whole request.

This workspace's `Todo List` (`374186c5b9a58005a745f8a377e55004`) is configured
that way: `NOTION_TITLE_PROP=Task name`, `NOTION_DONE_PROP=Status`,
`NOTION_DUE_PROP=` (blank).

Sync is poll-based, not push — changes made in Notion appear at the next sync,
not instantly. Hit **sync** on the widget to force one.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Nothing on the desktop after a reboot | Autostart isn't registered — `claudbot widgets autostart` |
| Widgets there, but only when no window covers the desktop | Expected: skins sit on the desktop layer (`AlwaysOnTop=-2`). Right-click a skin → **Settings ▸ Position** to change it |
| Registered, but still nothing after a reboot | `claudbot widgets autostart status`, then read `.claudbot/widgets/autostart.log` |
| `bridge not running` in a header | `claudbot widgets` isn't running |
| Skins don't appear in Rainmeter | Wrong skins folder. The installer reads `SkinPath` from `Rainmeter.ini`; override with `RAINMETER_SKINS` |
| Garbled characters (`â—‹`) | An installed skin file isn't UTF-16. Re-run `claudbot widgets install` |
| A meter silently doesn't draw | Usually a `MeterStyle` mistake — see the gotchas table in `widgets/README.md` |
| Everything blank after moving the repo | Re-run `claudbot widgets install` to regenerate `paths.inc` |
| Buttons do nothing | Check `NodeExe` in `@Resources/paths.inc` points at a real `node.exe` |
| Stocks say `no key` | `FINNHUB_API_KEY` missing from `.env` |
| Stocks say `unavailable` | Key is set but rejected, or the symbol doesn't exist |
| Todo header says `offline` | The organizer isn't running; tasks are read straight from disk |
| Notion dot is grey | `NOTION_API_KEY` or `NOTION_TASKS_DB` missing, or the DB isn't shared with the integration |

Run the feed with `--debug` to get `.json` twins of every widget file showing
the raw data behind them:

```
node widgets/bridge.mjs --watch --debug
node widgets/bridge.mjs --once            # write once and exit
```

---

## Not portable

These are desktop-only. Rainmeter is a host-installed application that reads
skins from `Documents\Rainmeter\Skins`, which a USB stick can't provide.

The bridge itself follows the portable rules — every path resolves through
`portable/paths.mjs`, so nothing breaks when the drive is in use. The widgets
simply aren't part of the portable drive, and `widgets/install.mjs` is the only
desktop-only piece.

`@Resources/paths.inc` is generated at install time and gitignored, because
Rainmeter can't read an environment variable or resolve a relative path — a
skin has to name the Node binary and the data directory outright, and those
absolute paths must never be committed.

The installer also finds the skins folder by reading `SkinPath` out of
`Rainmeter.ini` rather than guessing `~/Documents`, which matters here: OneDrive
redirects Documents, so the obvious guess installs to a folder Rainmeter never
looks at — and nothing reports an error when that happens.
