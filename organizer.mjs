#!/usr/bin/env node
/**
 * Claudbot organizer — the assistant's home screen.
 *
 * A local express app you open on boot (via the launcher menu). It's the working
 * surface for your day: a "day spine" timeline that folds tasks + calendar events
 * into one thread the assistant walks you down, the news Claudbot scavenged
 * overnight on the NUC, and an optional two-way Notion sync for tasks.
 *
 * Everything you add here is saved to .claudbot/organizer.json — the same file
 * Claudbot reads/writes when you talk to it ("add a task to…"), so the two stay
 * in sync. News is read from the VM mirror (.claudbot/briefing.nuc.json, written
 * by night-sync.mjs) or the local digest, whichever is newer.
 *
 * Usage:
 *   node organizer.mjs                 # serve at http://localhost:4700
 *   node organizer.mjs --port 4800
 */

import express from "express";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT       = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR  = path.join(ROOT, ".claudbot");
const STORE      = path.join(STATE_DIR, "organizer.json");
const NEWS_VM    = path.join(STATE_DIR, "briefing.nuc.json");
const NEWS_LOCAL = path.join(ROOT, "briefing", "data", "latest.json");

// ─── env ─────────────────────────────────────────────────────────────────────

function loadDotEnv() {
  const p = path.join(ROOT, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadDotEnv();

// Notion config — all optional. Property names default to a plain Tasks DB but
// can be overridden per-workspace without touching code.
const NOTION = {
  key:   process.env.NOTION_API_KEY,
  db:    process.env.NOTION_TASKS_DB,
  version: "2022-06-28",
  props: {
    title: process.env.NOTION_TITLE_PROP ?? "Name",
    done:  process.env.NOTION_DONE_PROP  ?? "Done",
    due:   process.env.NOTION_DUE_PROP   ?? "Due",
  },
};
const notionReady = () => Boolean(NOTION.key && NOTION.db);

// ─── store ───────────────────────────────────────────────────────────────────

const id = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();

function loadStore() {
  try {
    const s = JSON.parse(readFileSync(STORE, "utf8"));
    return { tasks: Array.isArray(s.tasks) ? s.tasks : [], events: Array.isArray(s.events) ? s.events : [] };
  } catch {
    return { tasks: [], events: [] };
  }
}

// Atomic write so a crash mid-save never truncates the file Claudbot also reads.
function saveStore(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STORE + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, STORE);
}

// ─── news ────────────────────────────────────────────────────────────────────

function mtimeOr0(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }

// Prefer whichever digest is newer: the VM's overnight scavenge or the local run.
function loadNews() {
  const pick = mtimeOr0(NEWS_VM) >= mtimeOr0(NEWS_LOCAL) && existsSync(NEWS_VM)
    ? { file: NEWS_VM, from: "NUC overnight" }
    : { file: NEWS_LOCAL, from: "local" };
  try {
    const data = JSON.parse(readFileSync(pick.file, "utf8"));
    return { from: pick.from, generatedAt: data.generatedAt ?? null, items: Array.isArray(data.items) ? data.items : [] };
  } catch {
    return { from: null, generatedAt: null, items: [] };
  }
}

// ─── Notion sync ─────────────────────────────────────────────────────────────

async function notion(method, pathname, body) {
  const res = await fetch(`https://api.notion.com/v1${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${NOTION.key}`,
      "Notion-Version": NOTION.version,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${pathname} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

function taskToProps(t) {
  const props = {
    [NOTION.props.title]: { title: [{ text: { content: t.title || "Untitled" } }] },
    [NOTION.props.done]:  { checkbox: Boolean(t.done) },
  };
  if (t.due) props[NOTION.props.due] = { date: { start: t.due } };
  return props;
}

function propsToTask(page) {
  const p = page.properties ?? {};
  const titleProp = p[NOTION.props.title]?.title ?? [];
  const title = titleProp.map((x) => x.plain_text ?? x.text?.content ?? "").join("").trim();
  return {
    title: title || "Untitled",
    done: Boolean(p[NOTION.props.done]?.checkbox),
    due: p[NOTION.props.due]?.date?.start ?? null,
    notionId: page.id,
  };
}

// Two-way, best-effort: push local tasks up (create/update), pull Notion tasks
// down (import any page we don't have yet). Never throws to the caller.
async function syncNotion() {
  if (!notionReady()) return { ok: false, message: "Notion isn't connected. Set NOTION_API_KEY and NOTION_TASKS_DB in .env." };
  const state = loadStore();
  let created = 0, updated = 0, imported = 0;
  try {
    // Push
    for (const t of state.tasks) {
      if (t.notionId) {
        await notion("PATCH", `/pages/${t.notionId}`, { properties: taskToProps(t) });
        updated++;
      } else {
        const page = await notion("POST", "/pages", { parent: { database_id: NOTION.db }, properties: taskToProps(t) });
        t.notionId = page.id;
        created++;
      }
    }
    // Pull
    const known = new Set(state.tasks.map((t) => t.notionId).filter(Boolean));
    const query = await notion("POST", `/databases/${NOTION.db}/query`, { page_size: 100 });
    for (const page of query.results ?? []) {
      if (known.has(page.id)) continue;
      const t = propsToTask(page);
      state.tasks.push({ id: id(), notes: "", createdAt: nowISO(), source: "notion", ...t });
      imported++;
    }
    saveStore(state);
    return { ok: true, message: `Notion synced — ${created} created, ${updated} updated, ${imported} imported.` };
  } catch (e) {
    return { ok: false, message: `Notion sync failed: ${e.message}` };
  }
}

// ─── API ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/api/state", (_req, res) => {
  const state = loadStore();
  res.json({ ...state, news: loadNews(), notion: { connected: notionReady() } });
});

app.post("/api/tasks", (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  if (!title) return res.status(400).json({ error: "A task needs a title." });
  const state = loadStore();
  const task = { id: id(), title, notes: "", done: false, due: req.body?.due || null, createdAt: nowISO(), source: "you" };
  state.tasks.push(task);
  saveStore(state);
  res.json(task);
});

app.patch("/api/tasks/:id", (req, res) => {
  const state = loadStore();
  const t = state.tasks.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "That task no longer exists." });
  for (const k of ["title", "notes", "done", "due"]) if (k in (req.body ?? {})) t[k] = req.body[k];
  saveStore(state);
  res.json(t);
});

app.delete("/api/tasks/:id", (req, res) => {
  const state = loadStore();
  const before = state.tasks.length;
  state.tasks = state.tasks.filter((x) => x.id !== req.params.id);
  saveStore(state);
  res.json({ removed: before - state.tasks.length });
});

app.post("/api/events", (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  const date = String(req.body?.date ?? "").trim();
  if (!title || !date) return res.status(400).json({ error: "An event needs a title and a date." });
  const state = loadStore();
  const ev = { id: id(), title, date, time: req.body?.time || null, notes: "" };
  state.events.push(ev);
  saveStore(state);
  res.json(ev);
});

app.delete("/api/events/:id", (req, res) => {
  const state = loadStore();
  const before = state.events.length;
  state.events = state.events.filter((x) => x.id !== req.params.id);
  saveStore(state);
  res.json({ removed: before - state.events.length });
});

app.post("/api/notion/sync", async (_req, res) => res.json(await syncNotion()));
app.get("/health", (_req, res) => res.json({ ok: true }));

// Amber ◆ mark, inline so the app stays a single self-contained file.
app.get("/favicon.svg", (_req, res) => res.type("image/svg+xml").send(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0a0c10"/><path d="M16 6l10 10-10 10L6 16z" fill="#f0b429"/></svg>`,
));

app.get("/", (_req, res) => { res.type("html").send(PAGE); });

const argv = process.argv.slice(2);
const portIdx = argv.indexOf("--port");
const PORT = portIdx !== -1 ? Number(argv[portIdx + 1]) : Number(process.env.ORGANIZER_PORT ?? 4700);
app.listen(PORT, () => console.log(`\n  ◆ Claudbot organizer → http://localhost:${PORT}\n`));

// ─── page ────────────────────────────────────────────────────────────────────
// Single self-contained document (no build step, no external assets). The client
// talks to the JSON API above.

const PAGE = /* html */ `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>Claudbot · Organizer</title>
<style>
  :root{
    --bg:#0a0c10; --bg2:#0e1218; --panel:#12171f; --panel2:#161c26; --line:#232c38;
    --ink:#e8edf4; --mut:#8593a3; --dim:#5c6774;
    --amber:#f0b429; --amber-soft:#f5cf6b; --mint:#57d9a3; --blue:#6aa8ff; --rose:#e8798f;
    --shadow:0 1px 0 rgba(255,255,255,.02) inset, 0 12px 32px -18px rgba(0,0,0,.9);
  }
  *{box-sizing:border-box}
  html{color-scheme:dark}
  body{margin:0;background:
      radial-gradient(1100px 520px at 88% -12%, #17202c 0, transparent 62%),
      radial-gradient(900px 500px at -8% 8%, #131a22 0, transparent 55%),
      var(--bg);
    color:var(--ink);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  .mono{font-family:ui-monospace,"SF Mono","Cascadia Code",Consolas,monospace}
  a{color:var(--blue);text-decoration:none} a:hover{text-decoration:underline}
  button{font:inherit;cursor:pointer;border:0;background:none;color:inherit}

  /* header */
  header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;
    padding:34px clamp(20px,4vw,52px) 10px}
  .hi{font-size:clamp(24px,3.4vw,34px);font-weight:650;letter-spacing:-.02em;margin:0}
  .hi b{color:var(--amber);font-weight:650}
  .sub{color:var(--mut);font-size:13.5px;margin-top:4px}
  .sub .mono{color:var(--dim)}
  .sync{display:flex;align-items:center;gap:10px}
  .sync-btn{display:inline-flex;align-items:center;gap:8px;padding:9px 15px;border-radius:10px;
    background:var(--panel);border:1px solid var(--line);color:var(--ink);font-size:13px;font-weight:550;
    transition:border-color .15s, transform .05s}
  .sync-btn:hover{border-color:var(--amber)} .sync-btn:active{transform:translateY(1px)}
  .sync-btn[disabled]{opacity:.5;cursor:default}
  .dot{width:7px;height:7px;border-radius:50%;flex:none}
  .dot.on{background:var(--mint);box-shadow:0 0 0 3px rgba(87,217,163,.15)}
  .dot.off{background:var(--dim)}
  .sync-note{font-size:12px;color:var(--mut);max-width:230px}

  main{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:20px;
    padding:14px clamp(20px,4vw,52px) 56px;max-width:1360px}
  @media(max-width:920px){main{grid-template-columns:1fr}}
  .col{display:flex;flex-direction:column;gap:20px;min-width:0}
  section{background:linear-gradient(180deg,var(--panel) 0,var(--bg2) 140%);
    border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);overflow:hidden}
  .head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px 12px}
  .eyebrow{font-size:11.5px;text-transform:uppercase;letter-spacing:.18em;color:var(--mut);font-weight:650}
  .count{font-size:11.5px;color:var(--dim)} .body{padding:4px 20px 20px}

  /* day spine */
  .spine{position:relative;padding-left:34px}
  .spine::before{content:"";position:absolute;left:11px;top:6px;bottom:6px;width:2px;
    background:linear-gradient(180deg,transparent,var(--line) 8%,var(--line) 92%,transparent)}
  .node{position:relative;padding:9px 0;border-bottom:1px solid var(--line)}
  .node:last-child{border-bottom:0}
  .node::before{content:"";position:absolute;left:-27px;top:16px;width:11px;height:11px;border-radius:50%;
    background:var(--bg2);border:2px solid var(--dim)}
  .node.event::before{border-color:var(--blue);background:var(--blue)}
  .node.task::before{border-color:var(--amber)}
  .node.done::before{border-color:var(--mint);background:var(--mint)}
  .node.overdue::before{border-color:var(--rose)}
  .when{font-size:11.5px;color:var(--dim);letter-spacing:.02em}
  .node.overdue .when{color:var(--rose)}
  .line{display:flex;align-items:flex-start;gap:11px;margin-top:2px}
  .check{margin-top:2px;width:18px;height:18px;border-radius:6px;border:1.5px solid var(--dim);flex:none;
    display:grid;place-items:center;transition:border-color .15s,background .15s}
  .check:hover{border-color:var(--amber)}
  .check.on{border-color:var(--mint);background:var(--mint)}
  .check.on::after{content:"";width:5px;height:9px;border:2px solid #06110c;border-top:0;border-left:0;
    transform:rotate(42deg) translateY(-1px)}
  .title{flex:1;font-size:14.5px;min-width:0;word-wrap:break-word}
  .node.done .title{color:var(--dim);text-decoration:line-through}
  .kind{font-size:10.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--dim);margin-left:4px}
  .del{color:var(--dim);opacity:0;font-size:16px;line-height:1;padding:0 2px;transition:opacity .12s,color .12s}
  .node:hover .del{opacity:1} .del:hover{color:var(--rose)}

  /* quick add */
  .add{display:flex;gap:8px;margin:14px 20px 4px;padding:0}
  .add input[type=text]{flex:1;min-width:0;background:var(--bg);border:1px solid var(--line);border-radius:10px;
    padding:10px 13px;color:var(--ink);font:inherit}
  .add input[type=text]::placeholder{color:var(--dim)}
  .add input[type=text]:focus{outline:none;border-color:var(--amber)}
  .add input[type=date],.add input[type=time]{background:var(--bg);border:1px solid var(--line);border-radius:10px;
    padding:10px;color:var(--mut);font:inherit;font-size:12.5px}
  .add button{padding:10px 16px;border-radius:10px;background:var(--amber);color:#1a1204;font-weight:650;font-size:13.5px;
    transition:filter .12s} .add button:hover{filter:brightness(1.08)}
  .seg{display:flex;gap:2px;margin:0 20px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:3px;width:max-content}
  .seg button{padding:6px 13px;border-radius:7px;font-size:12.5px;color:var(--mut)}
  .seg button.on{background:var(--panel2);color:var(--ink)}

  /* calendar */
  .cal{padding:6px 20px 20px}
  .cal-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
  .cal-top b{font-size:14px} .cal-top button{color:var(--mut);padding:2px 8px;border-radius:6px}
  .cal-top button:hover{color:var(--ink);background:var(--panel2)}
  .grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
  .dow{font-size:10.5px;color:var(--dim);text-align:center;padding:4px 0;letter-spacing:.06em}
  .day{aspect-ratio:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;
    border-radius:9px;font-size:12.5px;color:var(--mut);position:relative;border:1px solid transparent}
  .day.pad{color:transparent} .day.today{border-color:var(--amber);color:var(--ink);font-weight:650}
  .day.has{color:var(--ink)} .day .pip{width:4px;height:4px;border-radius:50%;background:var(--blue)}
  .day.today .pip{background:var(--amber)}

  /* news */
  .news .item{padding:13px 0;border-bottom:1px solid var(--line)} .news .item:last-child{border-bottom:0}
  .src{display:flex;gap:8px;align-items:center;font-size:11.5px;color:var(--dim);margin-bottom:5px}
  .news a.t{font-weight:600;font-size:15px;color:var(--ink);display:block;line-height:1.35}
  .news a.t:hover{color:var(--amber-soft);text-decoration:none}
  .why{color:#c2ccd6;font-size:13.5px;margin:6px 0 3px}
  .learn{font-size:13px;color:var(--mint);margin:2px 0} .learn b{color:var(--mint);font-weight:600}
  .tag{font-size:10.5px;padding:1px 7px;border-radius:20px;border:1px solid var(--line);color:var(--mut)}

  .empty{color:var(--dim);font-size:13.5px;padding:14px 0 4px}
  .toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(12px);opacity:0;
    background:var(--panel2);border:1px solid var(--line);color:var(--ink);padding:11px 17px;border-radius:11px;
    font-size:13.5px;box-shadow:var(--shadow);transition:opacity .2s,transform .2s;pointer-events:none;max-width:80vw}
  .toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
  @media(prefers-reduced-motion:reduce){*{transition:none!important}}
  :focus-visible{outline:2px solid var(--amber);outline-offset:2px;border-radius:6px}
</style></head><body>
<header>
  <div>
    <h1 class="hi">Good <span id="tod">day</span>, <b>Carlos</b></h1>
    <div class="sub" id="sub">Loading your day…</div>
  </div>
  <div class="sync">
    <div class="sync-note" id="syncNote"></div>
    <button class="sync-btn" id="syncBtn"><span class="dot off" id="ndot"></span><span id="slabel">Notion</span></button>
  </div>
</header>
<main>
  <div class="col">
    <section>
      <div class="head"><span class="eyebrow">Today</span><span class="count" id="todayCount"></span></div>
      <form class="add" id="addTask" autocomplete="off">
        <input type="text" name="title" placeholder="Add a task — or tell Claudbot and it lands here" aria-label="New task">
        <input type="date" name="due" aria-label="Due date">
        <button type="submit">Add</button>
      </form>
      <div class="body"><div class="spine" id="spine"></div></div>
    </section>
    <section>
      <div class="head"><span class="eyebrow">Calendar</span></div>
      <form class="add" id="addEvent" autocomplete="off">
        <input type="text" name="title" placeholder="Add an event" aria-label="New event">
        <input type="date" name="date" aria-label="Event date">
        <input type="time" name="time" aria-label="Event time">
        <button type="submit">Add</button>
      </form>
      <div class="cal" id="cal"></div>
    </section>
  </div>
  <div class="col">
    <section class="news">
      <div class="head"><span class="eyebrow">Scavenged overnight</span><span class="count" id="newsFrom"></span></div>
      <div class="body" id="news"></div>
    </section>
  </div>
</main>
<div class="toast" id="toast"></div>
<script>
const $ = (s) => document.querySelector(s);
let STATE = { tasks: [], events: [], news: { items: [] }, notion: { connected:false } };
let calRef = new Date();

const api = async (m, url, body) => {
  const r = await fetch(url, { method:m, headers: body?{ "Content-Type":"application/json" }:undefined, body: body?JSON.stringify(body):undefined });
  return r.json().catch(()=>({}));
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
// Only ever emit http(s) links — never a javascript:/data: scheme from a crawled URL.
const safeUrl = (u) => { try { const p=new URL(u, location.origin); return (p.protocol==="http:"||p.protocol==="https:")?p.href:"#"; } catch { return "#"; } };
const toast = (msg) => { const t=$("#toast"); t.textContent=msg; t.classList.add("show"); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove("show"),2600); };
const todayStr = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local

function greet(){ const h=new Date().getHours(); $("#tod").textContent = h<5?"night":h<12?"morning":h<18?"afternoon":"evening"; }

function fmtTime(t){ if(!t) return ""; const [H,M]=t.split(":").map(Number); const ap=H<12?"am":"pm"; const h=((H+11)%12)+1; return h+":"+String(M).padStart(2,"0")+ap; }

async function load(){
  STATE = await api("GET","/api/state");
  greet();
  renderSub(); renderSpine(); renderCal(); renderNews(); renderNotion();
}

function renderSub(){
  const t = todayStr();
  const open = STATE.tasks.filter(x=>!x.done).length;
  const evToday = STATE.events.filter(e=>e.date===t).length;
  const d = new Date().toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
  $("#sub").innerHTML = '<span class="mono">'+esc(d)+'</span> · '+open+' open · '+evToday+' event'+(evToday===1?"":"s")+' today';
}

function renderNotion(){
  const on = STATE.notion?.connected;
  $("#ndot").className = "dot "+(on?"on":"off");
  $("#slabel").textContent = on ? "Sync Notion" : "Notion";
  $("#syncNote").textContent = on ? "" : "Connect a Notion tasks database in .env to sync both ways.";
  $("#syncBtn").disabled = !on;
}

// The day spine: timed events + tasks, ordered — timed things by clock, then
// undated tasks. Overdue (past due date, not done) float to the top.
function renderSpine(){
  const t = todayStr();
  const nodes = [];
  for(const e of STATE.events.filter(e=>e.date===t)) nodes.push({ kind:"event", time:e.time, sort:e.time||"99:99", ev:e });
  for(const task of STATE.tasks){
    const overdue = task.due && task.due < t && !task.done;
    nodes.push({ kind:"task", time:null, sort: task.due && task.due<=t ? "00:00" : "50:00", task, overdue });
  }
  nodes.sort((a,b)=> (a.sort).localeCompare(b.sort));
  const open = STATE.tasks.filter(x=>!x.done).length;
  $("#todayCount").textContent = open ? open+" to do" : "all clear";

  if(!nodes.length){ $("#spine").innerHTML = '<div class="empty">Nothing scheduled. Add a task above, or ask Claudbot to plan your day.</div>'; return; }
  $("#spine").innerHTML = nodes.map(n=>{
    if(n.kind==="event"){
      return '<div class="node event"><div class="when mono">'+(n.time?esc(fmtTime(n.time)):"all day")+'</div>'+
        '<div class="line"><div class="title">'+esc(n.ev.title)+'<span class="kind">event</span></div>'+
        '<button class="del" data-ev="'+n.ev.id+'" title="Remove">×</button></div></div>';
    }
    const cls = "node task"+(n.task.done?" done":"")+(n.overdue?" overdue":"");
    const when = n.task.done ? "done" : n.task.due ? (n.overdue?"overdue · ":"due ")+esc(n.task.due) : "anytime";
    return '<div class="'+cls+'">'+
      '<div class="when'+(n.task.due?" mono":"")+'">'+when+'</div>'+
      '<div class="line"><button class="check'+(n.task.done?" on":"")+'" data-check="'+n.task.id+'" aria-label="Toggle done"></button>'+
      '<div class="title">'+esc(n.task.title)+(n.task.source==="notion"?'<span class="kind">notion</span>':n.task.source==="claudbot"?'<span class="kind">claudbot</span>':"")+'</div>'+
      '<button class="del" data-task="'+n.task.id+'" title="Delete">×</button></div></div>';
  }).join("");
}

function renderCal(){
  const y=calRef.getFullYear(), m=calRef.getMonth();
  const first=new Date(y,m,1), start=first.getDay(), days=new Date(y,m+1,0).getDate();
  const marks=new Set(STATE.events.map(e=>e.date));
  const dueMarks=new Set(STATE.tasks.filter(x=>!x.done&&x.due).map(x=>x.due));
  const monthName=first.toLocaleDateString(undefined,{month:"long",year:"numeric"});
  const t=todayStr();
  let cells="";
  for(const d of ["S","M","T","W","T","F","S"]) cells+='<div class="dow">'+d+'</div>';
  for(let i=0;i<start;i++) cells+='<div class="day pad"></div>';
  for(let d=1;d<=days;d++){
    const iso=y+"-"+String(m+1).padStart(2,"0")+"-"+String(d).padStart(2,"0");
    const has=marks.has(iso)||dueMarks.has(iso);
    cells+='<div class="day'+(iso===t?" today":"")+(has?" has":"")+'">'+d+(has?'<span class="pip"></span>':"")+'</div>';
  }
  $("#cal").innerHTML='<div class="cal-top"><button id="pm">‹</button><b>'+esc(monthName)+'</b><button id="nm">›</button></div><div class="grid">'+cells+'</div>';
  $("#pm").onclick=()=>{calRef=new Date(y,m-1,1);renderCal();};
  $("#nm").onclick=()=>{calRef=new Date(y,m+1,1);renderCal();};
}

function renderNews(){
  const n=STATE.news||{items:[]};
  $("#newsFrom").textContent = n.from ? n.from+(n.generatedAt?" · "+new Date(n.generatedAt).toLocaleDateString():"") : "";
  const items=n.items||[];
  if(!items.length){ $("#news").innerHTML='<div class="empty">No digest yet. Claudbot builds one overnight on the NUC, or run <span class="mono">claudbot briefing</span>.</div>'; return; }
  $("#news").innerHTML=items.map(it=>{
    const c=it.card||{};
    const diff=c.difficulty?'<span class="tag">'+esc(c.difficulty)+'</span>':"";
    const time=c.readTimeMin?'<span>'+esc(c.readTimeMin)+' min</span>':"";
    return '<div class="item"><div class="src">'+esc(it.source||"")+' '+diff+' '+time+'</div>'+
      '<a class="t" href="'+esc(safeUrl(it.url))+'" target="_blank" rel="noopener">'+esc(it.title)+'</a>'+
      (c.whyItMatters?'<p class="why">'+esc(c.whyItMatters)+'</p>':"")+
      (c.keyTakeaway?'<p class="learn"><b>Learn:</b> '+esc(c.keyTakeaway)+'</p>':"")+'</div>';
  }).join("");
}

// events
$("#addTask").addEventListener("submit", async (e)=>{
  e.preventDefault(); const f=e.target; const title=f.title.value.trim(); if(!title) return;
  await api("POST","/api/tasks",{ title, due:f.due.value||null }); f.reset(); await load(); toast("Task added.");
});
$("#addEvent").addEventListener("submit", async (e)=>{
  e.preventDefault(); const f=e.target; const title=f.title.value.trim(); const date=f.date.value; if(!title||!date){ toast("An event needs a title and a date."); return; }
  await api("POST","/api/events",{ title, date, time:f.time.value||null }); f.reset(); await load(); toast("Event added.");
});
document.addEventListener("click", async (e)=>{
  const check=e.target.closest("[data-check]");
  const delT=e.target.closest("[data-task]");
  const delE=e.target.closest("[data-ev]");
  if(check){ const t=STATE.tasks.find(x=>x.id===check.dataset.check); await api("PATCH","/api/tasks/"+check.dataset.check,{ done:!t.done }); await load(); }
  else if(delT){ await api("DELETE","/api/tasks/"+delT.dataset.task); await load(); toast("Task removed."); }
  else if(delE){ await api("DELETE","/api/events/"+delE.dataset.ev); await load(); toast("Event removed."); }
});
$("#syncBtn").addEventListener("click", async ()=>{
  if(!STATE.notion?.connected) return;
  $("#syncBtn").disabled=true; toast("Syncing with Notion…");
  const r=await api("POST","/api/notion/sync"); toast(r.message||"Done."); await load();
});
load();
setInterval(load, 60000); // keep news + any Claudbot-added tasks fresh
</script></body></html>`;
