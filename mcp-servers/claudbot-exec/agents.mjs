/**
 * claudbot-exec/agents.mjs — calling the sub-agent roster.
 *
 * Extracted from index.mjs so that callers other than the MCP server can reach
 * the roster. Forge's CAD generator is the first: cost-routing requires that
 * background generation goes to NIM rather than the Claude plan, which means it
 * needs exactly this code path. A second copy of it would be a config schema
 * maintained in two places — the failure that silently broke memory once
 * already, when onboarding and the launcher disagreed about where MCP servers
 * were written.
 *
 * index.mjs keeps the MCP wiring and imports from here.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.join(__dirname, "../../.claudbot/agents.yaml");

// Load .env so API keys reach sub-agents even if the shell didn't source it
function loadDotEnv() {
  const envPath = path.join(__dirname, "../../.env");
  if (!existsSync(envPath)) return;
  try {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch { /* non-fatal */ }
}
loadDotEnv();

// Safe agent name: lowercase letters, numbers, hyphens only
const SAFE_NAME = /^[a-z0-9-]{1,64}$/;

export function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return [];
  try {
    const parsed = parse(readFileSync(REGISTRY_PATH, "utf8"));
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}

export function findAgent(name) {
  if (!SAFE_NAME.test(name)) throw new Error(`Invalid agent name "${name}"`);
  const agents = loadRegistry();
  const agent = agents.find((a) => a.name === name);
  if (!agent) {
    const names = agents.map((a) => a.name).join(", ");
    throw new Error(`Agent "${name}" not found. Available: ${names}`);
  }
  return agent;
}

// 120s proved too short for the bigger NIM models (researcher/longcontext, and
// coder/fast under load all exceed it); overridable per install.
const envTimeout = Number(process.env.CLAUDBOT_AGENT_TIMEOUT_MS);
const REQUEST_TIMEOUT_MS = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 300_000;

// Completion cap sent to the endpoint: per-agent `maxTokens` in agents.yaml,
// else CLAUDBOT_AGENT_MAX_TOKENS, else 4096.
function agentMaxTokens(agent) {
  for (const v of [agent?.maxTokens, process.env.CLAUDBOT_AGENT_MAX_TOKENS]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 4096;
}

function agentMaxOutputChars() {
  const n = Number(process.env.CLAUDBOT_AGENT_MAX_OUTPUT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24_000;
}

// Reasoning models (Nemotron reasoning, Kimi) emit <think> traces that can
// dwarf the actual answer; never forward them into the caller's context.
function sanitizeAgentOutput(text, maxChars) {
  let s = typeof text === "string" ? text : "";
  s = s.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  s = s.replace(/<think(?:ing)?>[\s\S]*$/i, ""); // unclosed trace
  const lastClose = s.toLowerCase().lastIndexOf("</think");
  if (lastClose !== -1) s = s.slice(s.indexOf(">", lastClose) + 1); // orphaned close tag
  s = s.trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + `\n\n[output truncated at ${maxChars} chars]`;
  return s;
}

// ---------------------------------------------------------------------------
// CLI transport
//
// Some providers are only free through their own CLI, where auth is an OAuth
// login tied to a subscription rather than a metered API key (Gemini CLI on a
// Google AI Pro account is the case this was built for). Those have no
// OpenAI-compatible endpoint, so the agent is run as a subprocess instead.
// ---------------------------------------------------------------------------

// npm installs JS bins on Windows as a .cmd shim, which spawn() cannot execute
// without a shell — and a shell is not an option here, because the prompt is
// untrusted text. The shim names the real .js entrypoint, so extract it and run
// it under this same node binary.
// Matches both npm shim dialects: "%dp0%\...js" (current) and "%~dp0\...js".
const SHIM_TARGET = /"%~?dp0%?\\([^"]+\.[cm]?js)"/i;

function resolveCliCommand(command) {
  if (command === "node") return { file: process.execPath, prefix: [] };
  if (command.includes("/") || command.includes("\\")) return { file: command, prefix: [] };

  // On Windows an extensionless match is the bash shim, which spawn() cannot
  // execute — only ever take a real .exe or a .cmd/.bat we can unwrap.
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      if (!existsSync(candidate)) continue;
      if (ext !== ".cmd" && ext !== ".bat") return { file: candidate, prefix: [] };

      // A shim: point node at the script it wraps.
      const shim = readFileSync(candidate, "utf8");
      const target = shim.match(SHIM_TARGET)?.[1];
      if (target) {
        const script = path.join(dir, target);
        if (existsSync(script)) return { file: process.execPath, prefix: [script] };
      }
      throw new Error(
        `Command "${command}" resolved to a shell shim (${candidate}) whose target ` +
          `could not be read. Set "command:" to the .js entrypoint and run it via node.`
      );
    }
  }
  throw new Error(
    `Command "${command}" was not found on PATH. Install it, or set "command:" to an absolute path.`
  );
}

function callAgentCli(agent, prompt, systemPrompt) {
  if (!agent.command || typeof agent.command !== "string") {
    throw new Error(`Agent "${agent.name}" uses transport "cli" but has no "command" configured.`);
  }

  const system = systemPrompt || agent.jobDescription?.trim() || "";
  const combined = system ? `${system}\n\n${prompt}` : prompt;

  // Default to stdin: it keeps untrusted prompt text out of argv entirely and
  // sidesteps the ~32k Windows command-line limit on long research prompts.
  const useStdin = agent.stdin !== false;
  const { file, prefix } = resolveCliCommand(agent.command);
  const args = [
    ...prefix,
    ...(Array.isArray(agent.args) ? agent.args : []).map((arg) =>
      String(arg)
        .replaceAll("{prompt}", useStdin ? "" : combined)
        .replaceAll("{model}", agent.model || "")
    ),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
      ...(agent.cwd ? { cwd: agent.cwd } : {}),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Agent "${agent.name}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`));
    }, REQUEST_TIMEOUT_MS);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    }

    child.on("error", (err) => {
      const hint = err.code === "ENOENT" ? ` — "${agent.command}" is not installed` : "";
      finish(new Error(`Agent "${agent.name}" could not start${hint}: ${err.message}`));
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

    // Always close stdin. A CLI left waiting on an open pipe hangs until the
    // timeout even when the prompt went in through argv.
    child.stdin.on("error", () => {});
    if (useStdin) child.stdin.end(combined);
    else child.stdin.end();

    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const tail = stderr.trim().slice(-500) || "(no stderr)";
        finish(new Error(`Agent "${agent.name}" exited with code ${code}: ${tail}`));
        return;
      }
      const clean = sanitizeAgentOutput(stdout, agentMaxOutputChars());
      if (!clean) {
        const tail = stderr.trim().slice(-500);
        finish(
          new Error(
            `Agent "${agent.name}" returned an empty response.` + (tail ? ` stderr: ${tail}` : "")
          )
        );
        return;
      }
      finish(null, clean);
    });
  });
}

export async function callAgent(agent, prompt, systemPrompt) {
  if (agent.transport !== "cli") return callAgentHttp(agent, prompt, systemPrompt);
  try {
    return await callAgentCli(agent, prompt, systemPrompt);
  } catch (err) {
    // The CLI is the cheap path, not the only one. If it is missing or not
    // logged in, fall through to the HTTP endpoint when a key is available.
    const keyed = agent.apiKeyEnv && process.env[agent.apiKeyEnv];
    if (!agent.endpoint || !keyed) throw err;
    return callAgentHttp(agent, prompt, systemPrompt);
  }
}

async function callAgentHttp(agent, prompt, systemPrompt) {
  if (!agent.endpoint || typeof agent.endpoint !== "string") {
    throw new Error(`Agent "${agent.name}" has no valid endpoint configured.`);
  }

  const needsKey = agent.apiKeyEnv && agent.apiKeyEnv !== "null";
  const apiKey = needsKey ? process.env[agent.apiKeyEnv] : null;

  if (needsKey && !apiKey) {
    throw new Error(
      `API key env var "${agent.apiKeyEnv}" is not set. ` +
        `Add it to .env before running claudbot.`
    );
  }

  const baseUrl = agent.endpoint.replace(/\/$/, "");
  const url = `${baseUrl}/chat/completions`;

  const system = systemPrompt || agent.jobDescription?.trim() || "";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });

  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`; // omit for local/keyless

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: agent.model, messages, max_tokens: agentMaxTokens(agent) }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`Agent "${agent.name}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Agent "${agent.name}" request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "(no body)");
    throw new Error(`Agent "${agent.name}" HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`Agent "${agent.name}" returned an empty response.`);
  }
  const maxChars = agentMaxOutputChars();
  const clean = sanitizeAgentOutput(content, maxChars);
  // If the model put its entire answer inside a think block, the raw text is
  // better than nothing.
  return clean || sanitizeAgentOutput(content.replace(/<\/?think(?:ing)?>/gi, ""), maxChars);
}
