#!/usr/bin/env node
/**
 * Claudbot dream mode
 *
 * Runs background autonomous tasks when Claudbot is idle — memory
 * consolidation, proactive research, reflection on recent work.
 *
 * Usage:
 *   node dream.mjs              # run all tasks once
 *   node dream.mjs --watch      # run on schedule (reads interval from dream-tasks.yaml)
 *   node dream.mjs --task memory # run a specific task by name
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgent } from "./providers/agents.mjs";

// ─── paths ───────────────────────────────────────────────────────────────────

const ROOT          = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT = path.join(ROOT, ".claudbot");
const TASKS_FILE    = path.join(CLAUDBOT_ROOT, "dream-tasks.yaml");
const DREAM_LOG     = path.join(CLAUDBOT_ROOT, "dream-log.md");

// ─── env loading ─────────────────────────────────────────────────────────────

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadDotEnv();

// ─── NIM (inline) ────────────────────────────────────────────────────────────

const NIM_BASE  = (process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
const NIM_KEY   = process.env.NIM_API_KEY ?? "";

// Dreaming runs on a dedicated agent (default: `researcher` = Nemotron 3 Ultra),
// chosen separately from the fallback agent so background reflection and a
// rate-limit fallback never share one model. Resolved from agents.yaml by name
// via CLAUDBOT_DREAM_AGENT; individual tasks may override with their own
// `agent:` field. Falls back to NIM_MODEL if nothing is registered.
const DREAM_AGENT  = resolveAgent("CLAUDBOT_DREAM_AGENT", "researcher");
const DREAM_MODEL  = DREAM_AGENT?.model ?? process.env.NIM_MODEL ?? "meta/llama-3.1-70b-instruct";

// Resolve the model for a task: its own `agent:` override, else the dream agent.
function modelForTask(task) {
  if (task?.agent) {
    const a = resolveAgent("", task.agent);
    if (a?.model) return a.model;
  }
  return DREAM_MODEL;
}

async function nimComplete(systemPrompt, userPrompt, model = DREAM_MODEL) {
  if (!NIM_KEY) throw new Error("NIM_API_KEY not set");
  const res = await fetch(`${NIM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${NIM_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 2048,
    }),
  });
  if (!res.ok) throw new Error(`NIM HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "(empty)";
}

// ─── default dream tasks ─────────────────────────────────────────────────────

const DEFAULT_TASKS = [
  {
    name: "memory",
    description: "Memory consolidation — organize and summarize recent work",
    intervalMinutes: 60,
    systemPrompt:
      "You are Claudbot's background memory process. Your job is to consolidate information into clear, concise notes.",
    prompt:
      "Reflect on what you've worked on recently. Identify key decisions, patterns, and learnings worth remembering. " +
      "Format your response as structured Markdown that could be saved to an Obsidian note. " +
      "Be concise — bullet points over paragraphs.",
  },
  {
    name: "reflection",
    description: "Self-reflection — analyze behavior and identify improvements",
    intervalMinutes: 120,
    systemPrompt:
      "You are Claudbot's introspection process. Be honest and analytical.",
    prompt:
      "Reflect on your recent performance as an autonomous agent. " +
      "What went well? What could be improved? What recurring patterns do you notice in how you approach tasks? " +
      "End with 3 concrete action items to improve your work.",
  },
  {
    name: "research",
    description: "Proactive research — look up things that came up recently",
    intervalMinutes: 180,
    systemPrompt:
      "You are Claudbot's research background process. Your job is to proactively gather information.",
    prompt:
      "Based on recent activity and context, what topics or technologies would be valuable to research right now? " +
      "Pick the most important one and provide a concise but thorough summary of current best practices, " +
      "recent developments, and practical takeaways. Format as a structured Markdown note.",
  },
  {
    name: "planning",
    description: "Background planning — think ahead about upcoming work",
    intervalMinutes: 240,
    systemPrompt:
      "You are Claudbot's planning process. Think strategically about upcoming work.",
    prompt:
      "Think about likely upcoming tasks and how to approach them effectively. " +
      "What tools, context, or preparation would make future sessions more efficient? " +
      "Generate a brief action plan with priorities.",
  },
];

// ─── task loading ─────────────────────────────────────────────────────────────

function loadTasks() {
  if (!existsSync(TASKS_FILE)) {
    writeFileSync(TASKS_FILE, yamlStringify({ tasks: DEFAULT_TASKS }, { lineWidth: 0 }));
    return DEFAULT_TASKS;
  }
  try {
    const data = yamlParse(readFileSync(TASKS_FILE, "utf8"));
    return data?.tasks ?? DEFAULT_TASKS;
  } catch {
    return DEFAULT_TASKS;
  }
}

// ─── logging ─────────────────────────────────────────────────────────────────

function logDream(taskName, content) {
  const ts = new Date().toISOString();
  const entry = `\n## [${ts}] ${taskName}\n\n${content}\n\n---\n`;
  try {
    mkdirSync(path.dirname(DREAM_LOG), { recursive: true });
    appendFileSync(DREAM_LOG, entry);
  } catch { /* non-fatal */ }
}

// ─── run a single task ───────────────────────────────────────────────────────

async function runTask(task) {
  const start = Date.now();
  console.log(`\n[dream] Running: ${task.name} — ${task.description}`);

  try {
    const result = await nimComplete(task.systemPrompt, task.prompt, modelForTask(task));
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`[dream] ✓ ${task.name} completed in ${elapsed}s`);
    console.log(`\n--- ${task.name} output ---`);
    console.log(result);
    console.log("---\n");

    logDream(task.name, result);
    return { task: task.name, success: true, result };
  } catch (err) {
    console.error(`[dream] ✗ ${task.name} failed: ${err.message}`);
    return { task: task.name, success: false, error: err.message };
  }
}

// ─── watch mode ──────────────────────────────────────────────────────────────

function startWatch(tasks) {
  console.log("[dream] Watch mode active. Tasks will run on their configured intervals.");
  console.log("        Ctrl+C to stop.\n");

  const lastRun = new Map();

  const tick = async () => {
    const now = Date.now();
    for (const task of tasks) {
      const interval = (task.intervalMinutes ?? 60) * 60 * 1000;
      const last = lastRun.get(task.name) ?? 0;
      if (now - last >= interval) {
        lastRun.set(task.name, now);
        await runTask(task);
      }
    }
  };

  // Run immediately on first tick, then every minute check schedules
  tick();
  setInterval(tick, 60_000);

  process.on("SIGINT", () => {
    console.log("\n[dream] Stopping.");
    process.exit(0);
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const watchMode  = argv.includes("--watch");
  const taskFilter = argv.includes("--task") ? argv[argv.indexOf("--task") + 1] : null;

  if (!NIM_KEY) {
    console.error("[dream] NIM_API_KEY not set. Load your .env file first.");
    console.error("        Windows: Get-Content .env | ForEach-Object { ... }");
    process.exit(1);
  }

  console.log(`
[claudbot dream mode]
  Agent:  ${DREAM_AGENT?.name ?? "(unregistered)"}  →  ${DREAM_MODEL}
  Log:    ${DREAM_LOG}
  Tasks:  ${TASKS_FILE}
`);

  const tasks = loadTasks();
  const filtered = taskFilter ? tasks.filter((t) => t.name === taskFilter) : tasks;

  if (filtered.length === 0) {
    const names = tasks.map((t) => t.name).join(", ");
    console.error(`[dream] Task "${taskFilter}" not found. Available: ${names}`);
    process.exit(1);
  }

  if (watchMode) {
    startWatch(filtered);
  } else {
    console.log(`[dream] Running ${filtered.length} task(s) once...\n`);
    const results = [];
    for (const task of filtered) {
      results.push(await runTask(task));
    }
    const passed = results.filter((r) => r.success).length;
    console.log(`\n[dream] Done. ${passed}/${results.length} tasks succeeded.`);
    console.log(`        Log saved to: ${DREAM_LOG}`);
  }
}

main().catch((err) => {
  console.error("[dream] Fatal:", err);
  process.exit(1);
});
