#!/usr/bin/env node
/**
 * Claudbot briefing — overnight "news to learn from" daemon.
 *
 * Crawls free AI/ML/dev sources, ranks for learning value, has the `fast` agent
 * write a learning card per top item, and saves a dated JSON digest that the
 * dashboard reads. Runs headless (NIM only — no Claude Code needed), so it can
 * live on the NUC.
 *
 * Usage:
 *   node briefing.mjs            # build one digest now
 *   node briefing.mjs --watch    # rebuild on a schedule (default 6h)
 *   node briefing.mjs --top 12   # curate the top N items (default 14)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAll } from "./briefing/collectors.mjs";
import { resolveAgent, runAgent } from "./providers/agents.mjs";

const ROOT          = path.dirname(fileURLToPath(import.meta.url));
const BRIEF_DIR     = path.join(ROOT, "briefing");
const DATA_DIR      = path.join(BRIEF_DIR, "data");
const SOURCES_FILE  = path.join(BRIEF_DIR, "sources.yaml");
const INTERESTS_FILE = path.join(BRIEF_DIR, "interests.yaml");

// ─── env ─────────────────────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadDotEnv();

// Curation runs on a FAST agent. The 550B researcher times out past 120s, so it
// must not be used here; default to `fast` (Nemotron Nano).
const CURATE_AGENT = resolveAgent("CLAUDBOT_BRIEFING_AGENT", "fast");

function loadYaml(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return yamlParse(readFileSync(file, "utf8")) ?? fallback; } catch { return fallback; }
}

// ─── dedup ───────────────────────────────────────────────────────────────────

function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    url.search = "";
    return url.host.replace(/^www\./, "") + url.pathname.replace(/\/$/, "");
  } catch { return u; }
}

function dedup(items) {
  const seen = new Map();
  for (const it of items) {
    const key = canonicalUrl(it.url);
    const prev = seen.get(key);
    // Keep the higher-engagement copy when the same link shows up twice.
    if (!prev || (it.points + it.comments) > (prev.points + prev.comments)) seen.set(key, it);
  }
  return [...seen.values()];
}

// ─── ranking (pure heuristics) ───────────────────────────────────────────────

function topicScore(text, interests) {
  const t = text.toLowerCase();
  let s = 0;
  for (const term of interests.high ?? [])   if (t.includes(term.toLowerCase())) s += 3;
  for (const term of interests.medium ?? []) if (t.includes(term.toLowerCase())) s += 2;
  for (const term of interests.dev ?? [])    if (t.includes(term.toLowerCase())) s += 1.5;
  for (const term of interests.mute ?? [])   if (t.includes(term.toLowerCase())) s -= 5;
  return s;
}

function recencyBoost(publishedAt) {
  if (!publishedAt) return 0;
  const ageH = (Date.now() - new Date(publishedAt).getTime()) / 3.6e6;
  if (Number.isNaN(ageH)) return 0;
  if (ageH < 24) return 3;
  if (ageH < 48) return 1.5;
  if (ageH < 96) return 0.5;
  return 0;
}

function engagementScore(it) {
  // Log-scale so a 2000-point HN post doesn't bury everything from arXiv (0 pts).
  return Math.log10(1 + it.points + it.comments * 2);
}

function rank(items, interests) {
  return items
    .map((it) => {
      const topic = topicScore(`${it.title} ${it.raw}`, interests);
      const score = topic * 2 + engagementScore(it) + recencyBoost(it.publishedAt);
      return { ...it, _topic: topic, score: Math.round(score * 100) / 100 };
    })
    // Drop muted / off-topic-and-low-engagement noise.
    .filter((it) => it._topic > -3)
    .sort((a, b) => b.score - a.score);
}

// ─── LLM curation (learning cards) ───────────────────────────────────────────

const CURATE_SYSTEM =
  "You curate a developer's morning learning digest. You are given candidate AI/ML/dev " +
  "news items. Select the ones with real LEARNING value (techniques, papers, tools, " +
  "architectures, postmortems) over hype or announcements. For each selected item write a " +
  "compact learning card. Respond ONLY with minified JSON, no prose.";

function curatePrompt(items, top) {
  const list = items.map((it, i) =>
    `${i}. [${it.source}] ${it.title}\n   ${it.raw ? it.raw.slice(0, 220) : "(no summary)"}`,
  ).join("\n");
  return (
    `Here are ${items.length} candidate items (already pre-ranked):\n\n${list}\n\n` +
    `Pick the ${top} most worth LEARNING from. Return JSON of the exact shape:\n` +
    `{"items":[{"i":<index>,"whyItMatters":"<1 sentence>","keyTakeaway":"<the concrete thing to learn>",` +
    `"difficulty":"beginner|intermediate|advanced","readTimeMin":<int>}]}\n` +
    `Use only indices from the list. Be specific and terse.`
  );
}

function parseCuration(text) {
  // Models sometimes wrap JSON in prose or fences — extract the object.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function curate(ranked, top) {
  const pool = ranked.slice(0, Math.max(top * 2, 24)); // give the model headroom
  if (!CURATE_AGENT) {
    // No agent/key — fall back to the heuristic top N with empty cards.
    return pool.slice(0, top).map((it) => ({ ...it, card: null }));
  }
  let curation;
  try {
    const out = await runAgent(CURATE_AGENT.name, curatePrompt(pool, top), CURATE_SYSTEM);
    curation = parseCuration(out);
  } catch (err) {
    console.warn(`[briefing] curation agent failed (${err.message}); using heuristic top ${top}.`);
  }
  if (!curation?.items?.length) {
    return pool.slice(0, top).map((it) => ({ ...it, card: null }));
  }
  const picked = [];
  for (const c of curation.items) {
    const it = pool[c.i];
    if (!it) continue;
    picked.push({
      ...it,
      card: {
        whyItMatters: c.whyItMatters ?? "",
        keyTakeaway: c.keyTakeaway ?? "",
        difficulty: c.difficulty ?? "intermediate",
        readTimeMin: c.readTimeMin ?? null,
      },
    });
  }
  return picked.length ? picked : pool.slice(0, top).map((it) => ({ ...it, card: null }));
}

// ─── build one digest ────────────────────────────────────────────────────────

async function buildBriefing({ top = 14 } = {}) {
  const sources = loadYaml(SOURCES_FILE, {});
  const cfg = loadYaml(INTERESTS_FILE, {}) || {};
  const interestsBlock = { ...(cfg.interests ?? {}), mute: cfg.mute ?? [] };

  console.log("[briefing] collecting…");
  const raw = await collectAll(sources);
  console.log(`[briefing] collected ${raw.length} items`);

  const ranked = rank(dedup(raw), interestsBlock);
  console.log(`[briefing] ${ranked.length} after dedup/rank/filter`);

  console.log(`[briefing] curating top ${top} via ${CURATE_AGENT?.name ?? "heuristic"}…`);
  const curated = await curate(ranked, top);

  const digest = {
    generatedAt: new Date().toISOString(),
    agent: CURATE_AGENT?.name ?? null,
    counts: { collected: raw.length, ranked: ranked.length, curated: curated.length },
    items: curated.map((it) => ({
      title: it.title, url: it.url, source: it.source, author: it.author,
      publishedAt: it.publishedAt, points: it.points, comments: it.comments,
      score: it.score, card: it.card,
    })),
  };

  mkdirSync(DATA_DIR, { recursive: true });
  const dated = path.join(DATA_DIR, `briefing-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(dated, JSON.stringify(digest, null, 2));
  writeFileSync(path.join(DATA_DIR, "latest.json"), JSON.stringify(digest, null, 2));
  console.log(`[briefing] ✓ ${curated.length} learning cards → ${dated}`);
  return digest;
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const watch = argv.includes("--watch");
  const topIdx = argv.indexOf("--top");
  const top = topIdx !== -1 ? parseInt(argv[topIdx + 1], 10) || 14 : 14;

  if (!process.env.NIM_API_KEY) {
    console.warn("[briefing] NIM_API_KEY not set — collecting + ranking only, no learning cards.");
  }

  console.log(`\n[claudbot briefing]\n  Agent: ${CURATE_AGENT?.name ?? "(heuristic)"} → ${CURATE_AGENT?.model ?? "n/a"}\n  Data:  ${DATA_DIR}\n`);

  if (!watch) { await buildBriefing({ top }); return; }

  const intervalH = Number(process.env.CLAUDBOT_BRIEFING_INTERVAL_H ?? 6);
  console.log(`[briefing] watch mode — rebuilding every ${intervalH}h. Ctrl+C to stop.`);
  const run = () => buildBriefing({ top }).catch((e) => console.error(`[briefing] run failed: ${e.message}`));
  await run();
  setInterval(run, intervalH * 3600 * 1000);
  process.on("SIGINT", () => { console.log("\n[briefing] Stopping."); process.exit(0); });
}

main().catch((err) => { console.error("[briefing] Fatal:", err); process.exit(1); });
