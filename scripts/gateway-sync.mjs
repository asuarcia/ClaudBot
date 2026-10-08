#!/usr/bin/env node
/**
 * gateway-sync — make OmniRoute's provider list match the keys in `.env`, then
 * rebuild the `claudbot` combo from models that were PROVEN to answer.
 *
 *   node scripts/gateway-sync.mjs           # add new providers, re-verify, rebuild
 *   node scripts/gateway-sync.mjs --dry     # report only, change nothing
 *
 * Why this exists rather than "paste keys into the dashboard":
 *
 *   - OmniRoute 3.8.49 reads provider keys from its dashboard DB only. The
 *     documented `NVIDIA_API_KEY`-style env vars are ignored for chat (verified
 *     2026-10-07), so `.env` cannot feed it directly. This script is that bridge,
 *     and makes `.env` the one place keys live — a reinstall is one command.
 *
 *   - The built-in `auto/*` pools route to stale ids. On 2026-10-07 they picked
 *     `llm7/gpt-4.1-nano`, which llm7 no longer serves anonymously; the 401 made
 *     OmniRoute deactivate the WHOLE llm7 connection, and every working llm7
 *     model went with it. So Claudbot does not use the auto pools. It uses one
 *     combo, `claudbot`, whose members are only models this script called —
 *     plain answer AND a tool call, since the orchestrator lives on tool calls.
 *
 * Keys stay in `.env` (gitignored) and in OmniRoute's encrypted store. Nothing
 * is printed but the provider name.
 *
 * NVIDIA is deliberately not here: the user manages that one by hand.
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
loadDotEnv();

const BASE  = (process.env.OMNIROUTE_URL ?? "http://localhost:20128/v1").replace(/\/v1\/?$/, "");
const DRY   = process.argv.includes("--dry");
const COMBO = "claudbot";
const TAG   = "(claudbot)"; // connections this script owns carry this in their name

/**
 * The providers worth having, best first — order becomes the combo's priority
 * order. `key` is the .env variable; `keyless` providers accept any string.
 * `gapMs` paces probes for providers whose free tier is a few requests a minute;
 * probing them back-to-back reads as a broken model when it is only throttled.
 */
const PROVIDERS = [
  { provider: "gemini",     key: "GEMINI_API_KEY" },
  { provider: "groq",       key: "GROQ_API_KEY" },
  { provider: "mistral",    key: "MISTRAL_API_KEY" },
  { provider: "openrouter", key: "OPENROUTER_API_KEY", only: /:free$/ },
  { provider: "cohere",     key: "COHERE_API_KEY" },
  { provider: "sambanova",  key: "SAMBANOVA_API_KEY" },
  // Anonymous llm7 is ~4 requests a minute across all models; a free llm7
  // account key lifts that. Last in priority either way.
  { provider: "llm7",       key: "LLM7_API_KEY", keyless: true, gapMs: 16_000,
    // Anonymous llm7 only serves its "turbo" tier; the rest 401 without a key.
    only: (id) => !!process.env.LLM7_API_KEY || LLM7_TURBO.test(id) },
];
const LLM7_TURBO = /^(DeepSeek-V4-Flash|GLM-5\.3-Flash|codestral|deepseek-v4-pro|gemma4|glm-5\.2|gpt-oss|minimax-m|mistral-Nemo|nemotron-3-nano)/;

/** Names that are not chat models. Probing them only burns quota. */
const NOT_CHAT = /embed|whisper|tts|speech|transcri|audio|voxtral|image|imagen|veo|guard|rerank|moderation|ocr|lyria|aqa|learnlm|-vl\b|vision/i;
const PROBES_PER_PROVIDER = 8; // stop looking after this many calls
const KEEP_PER_PROVIDER   = 2; // members each provider contributes to the combo

// ─── OmniRoute management API ───────────────────────────────────────────────

let cookie = "";
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${json?.error?.message ?? text.slice(0, 200)}`);
  return { json, res };
}

async function login() {
  // OmniRoute's shipped placeholder. If the dashboard password was changed —
  // which it should be — put the new one in .env as OMNIROUTE_PASSWORD.
  const password = process.env.OMNIROUTE_PASSWORD ?? "CHANGEME";
  const { res } = await api("POST", "/api/auth/login", { password });
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("login returned no session cookie");
}

// ─── probing ────────────────────────────────────────────────────────────────

const TOOL = [{ type: "function", function: {
  name: "read_file", description: "Read a file from disk",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }];

async function complete(model, extra) {
  const started = Date.now();
  try {
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: false, max_tokens: 1500, ...extra }),
      signal: AbortSignal.timeout(45_000),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, ms: Date.now() - started, msg: json?.choices?.[0]?.message, err: json?.error?.message };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, err: e.name === "TimeoutError" ? "timeout" : e.message };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Does `model` answer, and can it call a tool? Both, or it is not a brain. */
async function verify(model, gapMs = 0) {
  const a = await complete(model, { messages: [{ role: "user", content: "What is 17*23? Reply with just the number." }] });
  if (!a.ok) return { ok: false, why: a.err ?? "failed" };
  const text = `${a.msg?.content ?? ""}${a.msg?.reasoning_content ?? ""}`;
  if (!/391/.test(text)) return { ok: false, why: "wrong answer" };
  if (gapMs) await sleep(gapMs);
  const b = await complete(model, {
    tools: TOOL, tool_choice: "auto",
    messages: [{ role: "user", content: "Read the file C:/notes/todo.txt using your tool." }],
  });
  if (!b.ok) return { ok: false, why: b.err ?? "tool call failed" };
  if (!b.msg?.tool_calls?.length) return { ok: false, why: "no tool call" };
  return { ok: true, ms: a.ms };
}

// ─── main ───────────────────────────────────────────────────────────────────

const log = (s = "") => console.log(`  ${s}`);

await login().catch((e) => {
  console.error(`\n  ✗ cannot log in to OmniRoute at ${BASE}: ${e.message}\n    Is it running, and is OMNIROUTE_PASSWORD in .env right?\n`);
  process.exit(1);
});

const { json: listing } = await api("GET", "/api/providers");
const existing = listing?.connections ?? [];
const members = [];

log(`OmniRoute ${BASE}${DRY ? "  (dry run)" : ""}\n`);

for (const spec of PROVIDERS) {
  const key = process.env[spec.key]?.trim() || (spec.keyless ? "claudbot" : "");
  let conn = existing.find((c) => c.provider === spec.provider);

  if (!key) { log(`·  ${spec.provider.padEnd(11)} no ${spec.key} in .env — skipped`); continue; }

  if (!conn) {
    if (DRY) { log(`+  ${spec.provider.padEnd(11)} would be added`); continue; }
    ({ json: { connection: conn } } = await api("POST", "/api/providers", {
      provider: spec.provider, name: `${spec.provider} ${TAG}`, apiKey: key,
    }));
  }

  // Re-test every run: it also re-activates a connection OmniRoute switched off
  // after one bad model returned 401.
  const { json: test } = await api("POST", `/api/providers/${conn.id}/test`);
  if (!test?.valid) { log(`✗  ${spec.provider.padEnd(11)} key rejected — ${test?.error ?? "invalid"}`); continue; }

  const { json: catalog } = await api("GET", `/api/providers/${conn.id}/models`);
  const only = typeof spec.only === "function" ? spec.only : (id) => !spec.only || spec.only.test(id);
  const candidates = (catalog?.models ?? []).map((m) => m.id).filter((id) => !NOT_CHAT.test(id) && only(id));

  if (DRY) {
    log(`?  ${spec.provider.padEnd(11)} would probe up to ${PROBES_PER_PROVIDER} of ${candidates.length}: ${candidates.slice(0, 4).join(", ")}…`);
    continue;
  }

  const kept = [];
  let probes = 0;
  for (const id of candidates) {
    if (kept.length >= KEEP_PER_PROVIDER || probes >= PROBES_PER_PROVIDER) break;
    if (probes++ && spec.gapMs) await sleep(spec.gapMs);
    const model = `${spec.provider}/${id}`;
    const r = await verify(model, spec.gapMs);
    if (r.ok) kept.push(model);
    log(`${r.ok ? "✓" : "–"}  ${model}${r.ok ? `  ${(r.ms / 1000).toFixed(1)}s` : `  (${String(r.why).slice(0, 90)})`}`);
    // A free tier's rate limit is per account, not per model: once one model
    // is throttled the rest will be too, and probing on only digs the hole
    // deeper. Stop, and let the next sync try again.
    if (!r.ok && /429|rate limit|quota/i.test(r.why)) {
      log(`   ${spec.provider} is rate-limited — stopping here; re-run the sync later`);
      break;
    }
  }
  if (!kept.length) log(`✗  ${spec.provider.padEnd(11)} nothing answered with tools (${probes} tried)`);
  members.push(...kept);
}

log("");
if (DRY) { log("dry run — nothing changed"); process.exit(0); }
if (!members.length) {
  log("No verified models — the claudbot combo is left as it was. Claudbot will run on NIM.");
  process.exit(DRY ? 0 : 2);
}

if (DRY) { log(`would set ${COMBO} → ${members.join(", ")}`); process.exit(0); }

const { json: combos } = await api("GET", "/api/combos");
const current = (combos?.combos ?? combos ?? []).find?.((c) => c.name === COMBO);
const body = { name: COMBO, strategy: "priority", models: members };
if (current) await api("PUT", `/api/combos/${current.id}`, body);
else await api("POST", "/api/combos", body);

log(`✓  ${COMBO} → ${members.join(" › ")}`);
log(`   the orchestrator and the gateway agents use it; run \`claudbot doctor\` to confirm.\n`);

function loadDotEnv() {
  // Same rules as everywhere else in Claudbot: CRLF-safe, never overrides the
  // real environment. A trailing \r on a key fails auth like a wrong key.
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
