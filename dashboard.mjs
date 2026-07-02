#!/usr/bin/env node
/**
 * Claudbot dashboard — the morning command center.
 *
 * A local express app you open after the machine boots. Reads the briefing
 * digest (briefing/data/latest.json) and assembles live panels: learning news,
 * project/git status, dream highlights, and "where we left off". Personal
 * connectors (Gmail / Notion / Calendar) are pluggable adapters under
 * briefing/connectors/ — until configured they render a tidy "connect me" card.
 *
 * Usage:
 *   node dashboard.mjs              # serve at http://localhost:4500
 *   node dashboard.mjs --port 4600
 */

import express from "express";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT      = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = path.join(ROOT, "briefing", "data");
const DREAM_LOG = path.join(ROOT, ".claudbot", "dream-log.md");
const SEP = "\x1f"; // ASCII unit separator — safe git-log field delimiter

function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadDotEnv();

// ─── panel data ──────────────────────────────────────────────────────────────

function loadBriefing() {
  try { return JSON.parse(readFileSync(path.join(DATA_DIR, "latest.json"), "utf8")); }
  catch { return null; }
}

// Recent commits across the user's repos — fully local, no API.
function projectPanel() {
  const repos = [ROOT, "C:\\Repo\\TradeAlgo", "C:\\Repo\\MyBrain"].filter((r) => existsSync(path.join(r, ".git")));
  const out = [];
  for (const repo of repos) {
    const log = spawnSync("git", ["log", "-3", `--pretty=%h${SEP}%s${SEP}%cr`], { cwd: repo, encoding: "utf8" });
    const commits = (log.stdout ?? "").trim().split("\n").filter(Boolean).map((l) => {
      const [hash, subject, when] = l.split(SEP);
      return { hash, subject, when };
    });
    out.push({ name: path.basename(repo), commits });
  }
  return out;
}

// Latest few dream-log sections.
function dreamPanel() {
  if (!existsSync(DREAM_LOG)) return [];
  try {
    const text = readFileSync(DREAM_LOG, "utf8");
    const blocks = text.split(/\n## /).slice(1).slice(-3).reverse();
    return blocks.map((b) => {
      const head = b.split("\n")[0];
      const body = b.split("\n").slice(1).join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
      return { head: head.replace(/[\[\]]/g, ""), body };
    });
  } catch { return []; }
}

async function recallPanel() {
  try {
    const mem = await import("./memory.mjs");
    const [last] = mem.listSessions({ limit: 1 });
    if (!last) return null;
    return { topic: last.topic, lastUser: last.lastUser, when: mem.relativeTime(last.end) };
  } catch { return null; }
}

// Personal connectors — phase 2. Each returns {connected, name, hint}.
function connectorState(envKey, name, hint) {
  return { connected: Boolean(process.env[envKey]), name, hint };
}
function personalPanels() {
  return {
    email:  connectorState("GMAIL_TOKEN",   "Important email", "Set GMAIL_TOKEN + run the Gmail connector (phase 2)."),
    tasks:  connectorState("NOTION_API_KEY", "Notion tasks & projects", "Set NOTION_API_KEY + database ids (phase 2)."),
    agenda: connectorState("GCAL_TOKEN",     "Today's agenda", "Set GCAL_TOKEN for Google Calendar (phase 2)."),
  };
}

// ─── view ────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

function newsCard(it) {
  const c = it.card;
  const diff = c?.difficulty ? `<span class="tag t-${esc(c.difficulty)}">${esc(c.difficulty)}</span>` : "";
  const time = c?.readTimeMin ? `<span class="muted">${esc(c.readTimeMin)} min</span>` : "";
  return `<article class="card">
    <div class="card-src">${esc(it.source)} ${diff} ${time}</div>
    <a class="card-title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>
    ${c?.whyItMatters ? `<p class="why">${esc(c.whyItMatters)}</p>` : ""}
    ${c?.keyTakeaway ? `<p class="take"><span>Learn:</span> ${esc(c.keyTakeaway)}</p>` : ""}
  </article>`;
}

function renderPage({ briefing, projects, dreams, recall, personal }) {
  const news = (briefing?.items ?? []).map(newsCard).join("") ||
    `<p class="muted">No digest yet. Run <code>claudbot briefing</code>.</p>`;
  const gen = briefing?.generatedAt ? new Date(briefing.generatedAt).toLocaleString() : "never";

  const projectsHtml = projects.map((p) => `
    <div class="sub"><b>${esc(p.name)}</b></div>
    ${p.commits.map((c) => `<div class="row"><code>${esc(c.hash)}</code> ${esc(c.subject)} <span class="muted">${esc(c.when)}</span></div>`).join("") || '<div class="muted">no commits</div>'}
  `).join("") || `<p class="muted">No git repos found.</p>`;

  const dreamsHtml = dreams.map((d) => `<div class="row"><b>${esc(d.head)}</b><br><span class="muted">${esc(d.body)}…</span></div>`).join("")
    || `<p class="muted">No dream entries yet.</p>`;

  const stub = (p) => p.connected
    ? `<p class="muted">Connected — panel coming in phase 2.</p>`
    : `<div class="connect"><span class="dot"></span> Not connected<p class="muted">${esc(p.hint)}</p></div>`;

  const recallHtml = recall
    ? `<p class="take"><span>Topic:</span> ${esc(recall.topic)}</p><p class="muted">Last: ${esc(recall.lastUser)} · ${esc(recall.when)}</p>`
    : `<p class="muted">No prior session.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claudbot · Command Center</title>
<style>
  :root{--bg:#0b0d10;--panel:#14181d;--line:#222a31;--ink:#e7edf3;--mut:#7d8a97;--acc:#5ed3a0;--acc2:#6aa8ff}
  *{box-sizing:border-box} html{color-scheme:dark}
  body{margin:0;background:radial-gradient(1200px 600px at 80% -10%,#16202a 0,var(--bg) 60%);color:var(--ink);
    font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  header{padding:28px 32px 8px;display:flex;justify-content:space-between;align-items:baseline}
  h1{font-size:26px;margin:0;letter-spacing:-.5px} h1 b{color:var(--acc)}
  .when{color:var(--mut);font-size:13px}
  main{display:grid;grid-template-columns:1.6fr 1fr;gap:18px;padding:16px 32px 40px;max-width:1400px}
  @media(max-width:900px){main{grid-template-columns:1fr}}
  section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 20px}
  section>h2{margin:0 0 14px;font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:var(--mut);font-weight:600}
  .col{display:flex;flex-direction:column;gap:18px}
  .card{padding:12px 0;border-bottom:1px solid var(--line)} .card:last-child{border:0}
  .card-src{font-size:12px;color:var(--mut);margin-bottom:4px;display:flex;gap:8px;align-items:center}
  .card-title{color:var(--ink);text-decoration:none;font-weight:600;font-size:15.5px} .card-title:hover{color:var(--acc2)}
  .why{margin:6px 0 2px;color:#c4cdd6;font-size:14px}
  .take{margin:2px 0;font-size:13.5px;color:#b9e7d3} .take span{color:var(--acc);font-weight:600}
  .tag{font-size:11px;padding:1px 7px;border-radius:20px;border:1px solid var(--line)}
  .t-beginner{color:#7fd9a3} .t-intermediate{color:#e2c878} .t-advanced{color:#e88f8f}
  .muted{color:var(--mut)} code{background:#0d1117;padding:1px 5px;border-radius:5px;color:#9fb4c8;font-size:12px}
  .row{padding:5px 0;border-bottom:1px solid var(--line);font-size:13.5px} .row:last-child{border:0}
  .sub{margin-top:10px;color:var(--acc2)} .sub:first-child{margin-top:0}
  .connect{display:flex;flex-direction:column;gap:2px} .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#e88f8f;margin-right:6px}
  footer{padding:0 32px 30px;color:var(--mut);font-size:12px}
</style></head><body>
<header>
  <h1>${esc(greeting())}, <b>Carlos</b></h1>
  <div class="when">${esc(new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }))} · digest ${esc(gen)}</div>
</header>
<main>
  <div class="col">
    <section><h2>Learn today · ${(briefing?.items ?? []).length} picks</h2>${news}</section>
  </div>
  <div class="col">
    <section><h2>Where we left off</h2>${recallHtml}</section>
    <section><h2>Projects</h2>${projectsHtml}</section>
    <section><h2>Important email</h2>${stub(personal.email)}</section>
    <section><h2>Tasks &amp; projects (Notion)</h2>${stub(personal.tasks)}</section>
    <section><h2>Today's agenda</h2>${stub(personal.agenda)}</section>
    <section><h2>Dream highlights</h2>${dreamsHtml}</section>
  </div>
</main>
<footer>claudbot dashboard · refresh after <code>claudbot briefing</code> · phase-2 connectors: Gmail, Notion, Calendar</footer>
</body></html>`;
}

// ─── server ──────────────────────────────────────────────────────────────────

const app = express();

app.get("/", async (_req, res) => {
  const recall = await recallPanel();
  res.send(renderPage({
    briefing: loadBriefing(),
    projects: projectPanel(),
    dreams: dreamPanel(),
    recall,
    personal: personalPanels(),
  }));
});

app.get("/api/briefing", (_req, res) => res.json(loadBriefing() ?? { items: [] }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Raw dream log — consumed by night-sync.mjs on the PC to merge the VM's
// overnight dreams into the local dream-log.md.
app.get("/api/dream-log", (_req, res) => {
  res.type("text/plain; charset=utf-8");
  try { res.send(existsSync(DREAM_LOG) ? readFileSync(DREAM_LOG, "utf8") : ""); }
  catch { res.send(""); }
});

const argv = process.argv.slice(2);
const portIdx = argv.indexOf("--port");
const PORT = portIdx !== -1 ? Number(argv[portIdx + 1]) : Number(process.env.DASHBOARD_PORT ?? 4500);

app.listen(PORT, () => {
  console.log(`\n  ⬢ Claudbot dashboard → http://localhost:${PORT}\n  Build the digest with: claudbot briefing\n`);
});
