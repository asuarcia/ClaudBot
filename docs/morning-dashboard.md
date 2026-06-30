# Morning Dashboard — design

A personal "command center" the user wakes up to. Two halves:

1. **Briefing daemon** (`briefing.mjs`) — an overnight idle process (sibling of
   `dream.mjs`) that crawls the internet for high-signal **AI / ML / dev** news
   meant to *learn from*, ranks and curates it into learning cards, and writes a
   dated JSON digest.
2. **Dashboard** (`dashboard.mjs`) — a local express web app the user opens in the
   morning. Panels: curated news, important Gmail, Notion tasks/projects, calendar
   agenda, local git/project status, dream-log highlights, and "where we left off".

Designed to run on the **Proxmox NUC** (192.168.1.191 / node `nuc11`) in a VM so the
PC doesn't stay on overnight. Modular + config-driven so **TradeAlgo** can reuse it
(swap in finance sources + its own panels).

---

## Briefing pipeline

```
collectors → normalize → dedup → rank (heuristics) → LLM curate (fast agent) → JSON digest
```

- **Collectors** (`briefing/collectors.mjs`), each returns normalized items
  `{ id, title, url, source, author, publishedAt, points, comments, raw }`:
  - **Hacker News** — Algolia API (`https://hn.algolia.com/api/v1/search_by_date?tags=story`),
    front-page + Show HN, filtered by points. No auth.
  - **arXiv** — `http://export.arxiv.org/api/query` for `cs.AI cs.LG cs.CL cs.SE`,
    recent submissions. No auth.
  - **Reddit** — public JSON (`https://www.reddit.com/r/<sub>/top.json?t=day`) for
    r/MachineLearning, r/LocalLLaMA, r/programming. No auth (set a UA).
  - **RSS/Atom** — generic puller over `briefing/sources.yaml`: Simon Willison,
    Anthropic, OpenAI, Google AI, Sebastian Raschka, Lobste.rs, etc.
  - **GitHub Trending** — daily trending repos in relevant languages/topics.
  - **X/Twitter** *(deferred)* — no reliable free API in 2026; substitute with
    Bluesky (AT protocol public feeds), Mastodon, or curated Nitter/RSS bridges.
- **Dedup** — by canonical URL + fuzzy title match.
- **Rank** — score = source authority × engagement (points/comments, normalized)
  × recency decay × topic match to `briefing/interests.yaml`. Pure heuristics, no
  training.
- **LLM curation** — top N go to the **`fast`** agent (Nemotron Nano — quick;
  the 550B `researcher` times out past 120s and must NOT be used here). It selects
  the most "learn-from" items and writes a learning card per item:
  `{ whyItMatters, keyTakeaway, difficulty, readTimeMin, goDeeperUrl }`.
- **Output** — `briefing/data/briefing-YYYY-MM-DD.json` + `briefing/data/latest.json`.

Run: `claudbot briefing` (once) / `claudbot briefing --watch` (scheduled, e.g. 5am).

---

## Dashboard panels

`claudbot dashboard` serves `http://localhost:<port>` (default 4500), reading
`latest.json` plus live panels. Panel adapters live in `briefing/connectors/`:

| Panel | Source | Auth | Status |
|-------|--------|------|--------|
| News (learning cards) | briefing `latest.json` | none | **v1** |
| Email (important only) | Gmail API | OAuth token | adapter stub |
| Tasks / Projects | Notion API | `NOTION_API_KEY` + db ids | adapter stub |
| Agenda | Google Calendar API | OAuth token | adapter stub |
| Project/git status | local `git log` across repos | none | **v1 (local)** |
| Dream highlights | `.claudbot/dream-log.md` | none | **v1 (local)** |
| Where we left off | `memory.mjs` recall | none | **v1 (reuse)** |
| Weather / focus / top-3 | free weather API + a todo file | none | nice-to-have |

Connector interface: `export async function fetchPanel(config) -> { items, error }`,
so a missing/unconfigured connector degrades to an empty panel, never crashes.

---

## NUC deployment (idle processes off the PC)

Goal: run `dream --watch` + `briefing --watch` + `dashboard` on the NUC, so the user
just opens `http://<vm-ip>:4500` in the morning.

- A small Debian/Ubuntu VM on Proxmox `nuc11` (cloud-init template), git-clones
  claudbot, `npm run setup`, copies `.env`.
- `systemd` units: `claudbot-dream.service`, `claudbot-briefing.timer` (5am),
  `claudbot-dashboard.service`. Units + a `deploy/nuc-setup.sh` live under `deploy/`.
- Provisioning can be scripted via the Proxmox API token (see memory `proxmox-nuc`)
  as a follow-up; v1 is the setup script + units + README.
- The briefing daemon does **not** need Claude Code — it talks to NIM directly (like
  dream), so it runs headless on a tiny VM with just Node + a NIM key.

---

## Reuse for TradeAlgo

Everything is config-driven: `sources.yaml`, `interests.yaml`, the connector
registry, and the panel list. TradeAlgo copies `briefing.mjs` + `dashboard.mjs`,
swaps in finance/market sources and panels (positions, P&L, watchlist news), and
reuses the same rank → curate → digest → dashboard skeleton.

---

## Build phases

1. ✅ **Briefing core** — HN + arXiv + Reddit + RSS collectors, dedup, rank,
   `fast` curation, JSON digest, `claudbot briefing`.
2. ✅ **Dashboard** — express app, news + local panels (git, dream, recall).
3. ✅ **Night supervisor** — `claudbot night` runs dream + briefing + dashboard
   together with crash-restart (`night.mjs`).
4. ✅ **NUC deploy kit** — `deploy/`: `nuc-setup.sh`, `claudbot-night.service`,
   `proxmox-provision.mjs`.
5. ⬜ **Personal connectors** — Gmail (important only), Notion, Calendar with
   OAuth, under `briefing/connectors/` (the dashboard already has the stub slots).
6. ⬜ **GitHub Trending / Bluesky** collectors; a local todos panel.
7. ⬜ **Port to TradeAlgo** (finance sources + panels, same skeleton).
