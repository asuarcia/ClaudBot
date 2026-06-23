#!/usr/bin/env node
/**
 * Claudbot onboarding wizard
 *
 * Steps:
 *   1. Welcome + risk acknowledgment
 *   2. Claude Code auth
 *   3. NIM API key (fallback + sub-agents)
 *   4. Obsidian memory vault (optional)
 *   5. Sub-agent creation (loop)
 *   6. Channel connections (Discord, Telegram, Slack, WhatsApp)
 *   7. Restrictions (paths / commands Claude can never touch)
 *   8. Default permission mode
 *   9. Write all config files
 *  10. Health check
 *  11. Launch
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";
import { spawnSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── paths ───────────────────────────────────────────────────────────────────

const ROOT         = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDBOT_DIR = path.join(ROOT, ".claudbot");
const ENV_FILE     = path.join(ROOT, ".env");
const AGENTS_FILE  = path.join(CLAUDBOT_DIR, "agents.yaml");
const CHANNELS_FILE= path.join(CLAUDBOT_DIR, "channels.yaml");
const RESTRICT_FILE= path.join(CLAUDBOT_DIR, "restrictions.yaml");
const SETTINGS_FILE= path.join(CLAUDBOT_DIR, ".claude", "settings.json");

// ─── helpers ─────────────────────────────────────────────────────────────────

function bail(msg) {
  p.cancel(msg ?? "Onboarding cancelled.");
  process.exit(0);
}

function checkCancel(val) {
  if (p.isCancel(val)) bail();
  return val;
}

/** Run a command safely (no shell) and return stdout, or null on failure */
function tryRun(file, args = []) {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["pipe","pipe","pipe"] });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Read a key from the .env file directly (no shell, no interpolation) */
function readEnvKey(key) {
  if (!existsSync(ENV_FILE)) return null;
  const line = readFileSync(ENV_FILE, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

/** Write or merge a key into .env */
function writeEnv(key, value) {
  let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content += (content.endsWith("\n") || !content ? "" : "\n") + line + "\n";
  }
  writeFileSync(ENV_FILE, content);
}

/** Read existing YAML file or return default */
function readYaml(filePath, defaultVal) {
  try {
    return yamlParse(readFileSync(filePath, "utf8")) ?? defaultVal;
  } catch {
    return defaultVal;
  }
}

// ─── ascii banner ─────────────────────────────────────────────────────────────

function printBanner() {
  console.log(chalk.cyan(`
  ██████╗██╗      █████╗ ██╗   ██╗██████╗ ██████╗  ██████╗ ████████╗
 ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔══██╗██╔═══██╗╚══██╔══╝
 ██║     ██║     ███████║██║   ██║██║  ██║██████╔╝██║   ██║   ██║
 ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══██╗██║   ██║   ██║
 ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝██████╔╝╚██████╔╝   ██║
  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝  ╚═════╝   ╚═╝
`));
}

// ─── step 1: welcome + risk ──────────────────────────────────────────────────

async function stepWelcome() {
  p.intro(chalk.bold("Claudbot Setup Wizard"));

  p.note(
    [
      chalk.yellow("⚠  Security notice"),
      "",
      "By default, Claudbot runs with full system access.",
      "It can read files, run shell commands, and browse the web",
      "on your machine without asking for permission.",
      "",
      "You will set restrictions and a permission mode during this",
      "setup, but understand what you are enabling.",
    ].join("\n"),
    "Before you continue"
  );

  const accept = checkCancel(await p.confirm({
    message: "I understand Claudbot will have significant system access",
  }));

  if (!accept) bail("Setup cancelled. Run again when ready.");
}

// ─── step 2: claude code auth ────────────────────────────────────────────────

async function stepClaudeAuth() {
  const spin = p.spinner();
  spin.start("Checking Claude Code authentication…");

  const status = tryRun("claude", ["auth", "status", "--text"]);
  const loggedIn = status && !status.includes("not logged") && !status.includes("No account");

  if (loggedIn) {
    spin.stop(chalk.green("✓ Claude Code is authenticated"));
    return;
  }

  spin.stop(chalk.yellow("Claude Code is not logged in"));

  p.note(
    "You need a Claude subscription (claude.ai/code).\n" +
    "A browser window will open to complete sign-in.",
    "Claude Code login"
  );

  const doLogin = checkCancel(await p.confirm({ message: "Open browser to log in now?" }));
  if (!doLogin) bail("Claude Code auth is required. Run again after logging in.");

  const result = spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
  if (result.status !== 0) bail("Login failed. Run `claude auth login` manually and try again.");

  p.log.success("Claude Code authenticated.");
}

// ─── step 3: NIM API key ─────────────────────────────────────────────────────

async function stepNim() {
  p.log.step("NVIDIA NIM — fallback provider + sub-agent inference");

  const existingKey = process.env.NIM_API_KEY ?? readEnvKey("NIM_API_KEY");

  const skip = checkCancel(await p.confirm({
    message: existingKey
      ? "NIM_API_KEY already set. Update it?"
      : "Set up NIM API key? (needed for fallback + NIM sub-agents)",
    initialValue: !existingKey,
  }));

  if (!skip && existingKey) {
    p.log.info("Keeping existing NIM_API_KEY.");
    return;
  }

  if (!skip) {
    p.log.warn("Skipping NIM. Fallback provider will be unavailable.");
    return;
  }

  const key = checkCancel(await p.password({
    message: "NIM API key (nvapi-…):",
    validate: (v) => (v.trim().length < 10 ? "Key looks too short" : undefined),
  }));

  const model = checkCancel(await p.text({
    message: "Default NIM model:",
    initialValue: "meta/llama-3.1-70b-instruct",
  }));

  const base = checkCancel(await p.text({
    message: "NIM base URL:",
    initialValue: "https://integrate.api.nvidia.com/v1",
  }));

  const spin = p.spinner();
  spin.start("Testing NIM key…");

  try {
    const res = await fetch(`${base.trim()}/models`, {
      headers: { Authorization: `Bearer ${key.trim()}` },
    });
    if (res.ok) {
      spin.stop(chalk.green("✓ NIM key valid"));
    } else {
      spin.stop(chalk.yellow(`NIM returned HTTP ${res.status} — key saved anyway`));
    }
  } catch {
    spin.stop(chalk.yellow("Could not reach NIM endpoint — key saved anyway"));
  }

  writeEnv("NIM_API_KEY", key.trim());
  writeEnv("NIM_BASE_URL", base.trim());
  writeEnv("NIM_MODEL", model.trim());
  p.log.success(".env updated with NIM credentials.");
}

// ─── step 4: obsidian memory ──────────────────────────────────────────────────

async function stepObsidian() {
  p.log.step("Obsidian memory vault (optional)");

  const useObsidian = checkCancel(await p.confirm({
    message: "Connect an Obsidian vault for long-term memory?",
    initialValue: true,
  }));

  if (!useObsidian) {
    // Remove obsidian-brain from settings
    const settings = readYaml(SETTINGS_FILE, {});
    if (settings?.mcpServers?.["obsidian-brain"]) {
      delete settings.mcpServers["obsidian-brain"];
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
      p.log.info("Obsidian MCP removed from settings.");
    }
    return;
  }

  const defaultVault = process.platform === "win32"
    ? "C:\\Repo\\MyBrain"
    : `${process.env.HOME}/MyBrain`;

  const vaultPath = checkCancel(await p.text({
    message: "Path to your Obsidian vault:",
    initialValue: defaultVault,
    validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
  }));

  // Update settings.json
  const settings = readYaml(SETTINGS_FILE, { mcpServers: {}, permissions: { allow: [], deny: [] } });
  settings.mcpServers = settings.mcpServers ?? {};
  settings.mcpServers["obsidian-brain"] = {
    command: "npx",
    args: ["-y", "mcp-obsidian", vaultPath.trim()],
  };
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  p.log.success(`Obsidian vault set to: ${vaultPath.trim()}`);
}

// ─── step 5: sub-agents ──────────────────────────────────────────────────────

const ENDPOINT_PRESETS = {
  nim:    "https://integrate.api.nvidia.com/v1",
  ollama: "http://localhost:11434/v1",
  custom: null,
};

const NIM_POPULAR_MODELS = [
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.1-8b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "mistralai/mistral-7b-instruct-v0.3",
  "google/gemma-2-27b-it",
];

async function createOneAgent() {
  const name = checkCancel(await p.text({
    message: "Agent name (short identifier, e.g. researcher):",
    validate: (v) => (/^[a-z0-9-]+$/.test(v.trim()) ? undefined : "Lowercase letters, numbers, hyphens only"),
  }));

  const endpointType = checkCancel(await p.select({
    message: "Endpoint:",
    options: [
      { value: "nim",    label: "NVIDIA NIM  (integrate.api.nvidia.com)" },
      { value: "ollama", label: "Ollama       (local, http://localhost:11434)" },
      { value: "custom", label: "Custom       (any OpenAI-compatible URL)" },
    ],
  }));

  let endpoint = ENDPOINT_PRESETS[endpointType];
  if (!endpoint) {
    endpoint = checkCancel(await p.text({
      message: "Base URL (e.g. https://your-endpoint.com/v1):",
      validate: (v) => (v.startsWith("http") ? undefined : "Must start with http"),
    }));
  }

  let model;
  if (endpointType === "nim") {
    const modelChoice = checkCancel(await p.select({
      message: "Model:",
      options: [
        ...NIM_POPULAR_MODELS.map((m) => ({ value: m, label: m })),
        { value: "__custom__", label: "Enter model ID manually" },
      ],
    }));
    if (modelChoice === "__custom__") {
      model = checkCancel(await p.text({ message: "Model ID:" }));
    } else {
      model = modelChoice;
    }
  } else {
    model = checkCancel(await p.text({
      message: "Model ID (as the endpoint expects it):",
    }));
  }

  const description = checkCancel(await p.text({
    message: "What is this agent good at? (Claude reads this to decide when to delegate):",
    placeholder: "e.g. Deep research and summarization. Best for factual lookups and literature review.",
    validate: (v) => (v.trim().length < 10 ? "Please describe the agent's specialty" : undefined),
  }));

  const apiKeyEnv = endpointType === "ollama"
    ? null
    : checkCancel(await p.text({
        message: "Environment variable name holding the API key:",
        initialValue: endpointType === "nim" ? "NIM_API_KEY" : `${name.toUpperCase()}_API_KEY`,
      }));

  if (apiKeyEnv && endpointType !== "nim") {
    const keyValue = checkCancel(await p.password({
      message: `Value for ${apiKeyEnv} (leave blank to set manually later):`,
    }));
    if (keyValue?.trim()) writeEnv(apiKeyEnv, keyValue.trim());
  }

  return {
    name: name.trim(),
    model: model.trim(),
    endpoint: endpoint.trim(),
    apiKeyEnv: apiKeyEnv?.trim() ?? null,
    jobDescription: description.trim(),
  };
}

async function stepSubAgents() {
  p.log.step("Sub-agents");

  p.note(
    "Sub-agents are specialized models Claude delegates tasks to.\n" +
    "You can add more later by editing .claudbot/agents.yaml.",
    "Sub-agents"
  );

  const existing = readYaml(AGENTS_FILE, { agents: [] });
  const agents = existing.agents ?? [];

  let addMore = checkCancel(await p.confirm({ message: "Create a sub-agent now?" }));

  while (addMore) {
    const agent = await createOneAgent();
    agents.push(agent);
    p.log.success(`Sub-agent "${agent.name}" added.`);

    addMore = checkCancel(await p.confirm({ message: "Add another sub-agent?" }));
  }

  writeFileSync(AGENTS_FILE, yamlStringify({ agents }, { lineWidth: 0 }));
  p.log.info(`agents.yaml saved (${agents.length} agent${agents.length !== 1 ? "s" : ""}).`);
}

// ─── step 6: channels ────────────────────────────────────────────────────────

async function setupDiscord() {
  p.note(
    "Create a Discord app at discord.com/developers/applications\n" +
    "then enable a bot and copy its token.",
    "Discord setup"
  );
  const token = checkCancel(await p.password({ message: "Discord bot token:" }));
  const guildId = checkCancel(await p.text({ message: "Server (guild) ID (right-click server → Copy ID):" }));
  const channelId = checkCancel(await p.text({ message: "Default channel ID to post in:" }));
  writeEnv("DISCORD_BOT_TOKEN", token.trim());
  return { type: "discord", guildId: guildId.trim(), channelId: channelId.trim(), tokenEnv: "DISCORD_BOT_TOKEN" };
}

async function setupTelegram() {
  p.note(
    "Message @BotFather on Telegram to create a bot and get its token.",
    "Telegram setup"
  );
  const token = checkCancel(await p.password({ message: "Telegram bot token:" }));
  const chatId = checkCancel(await p.text({ message: "Chat ID to send messages to:" }));
  writeEnv("TELEGRAM_BOT_TOKEN", token.trim());
  return { type: "telegram", chatId: chatId.trim(), tokenEnv: "TELEGRAM_BOT_TOKEN" };
}

async function setupSlack() {
  p.note(
    "Create a Slack app at api.slack.com/apps, add a bot, and install it.\n" +
    "Copy the Bot User OAuth Token (starts with xoxb-).",
    "Slack setup"
  );
  const token = checkCancel(await p.password({ message: "Slack bot token (xoxb-…):" }));
  const channel = checkCancel(await p.text({ message: "Default channel (e.g. #general or channel ID):" }));
  writeEnv("SLACK_BOT_TOKEN", token.trim());
  return { type: "slack", channel: channel.trim(), tokenEnv: "SLACK_BOT_TOKEN" };
}

async function setupWhatsApp() {
  p.note(
    "WhatsApp integration uses Twilio's WhatsApp API.\n" +
    "Set up at console.twilio.com — enable the WhatsApp sandbox or buy a number.",
    "WhatsApp setup"
  );
  const sid    = checkCancel(await p.text({ message: "Twilio Account SID:" }));
  const token  = checkCancel(await p.password({ message: "Twilio Auth Token:" }));
  const from   = checkCancel(await p.text({ message: "Your Twilio WhatsApp number (e.g. whatsapp:+14155238886):" }));
  const to     = checkCancel(await p.text({ message: "Your WhatsApp number to message (e.g. whatsapp:+1234567890):" }));
  writeEnv("TWILIO_ACCOUNT_SID", sid.trim());
  writeEnv("TWILIO_AUTH_TOKEN", token.trim());
  return { type: "whatsapp", from: from.trim(), to: to.trim(), sidEnv: "TWILIO_ACCOUNT_SID", tokenEnv: "TWILIO_AUTH_TOKEN" };
}

async function stepChannels() {
  p.log.step("Channel connections (optional)");

  p.note(
    "Connect messaging platforms so Claudbot can send notifications\n" +
    "and receive commands from outside the terminal.\n\n" +
    "Skip this for now — channels can be added later in channels.yaml.",
    "Channels"
  );

  const selected = checkCancel(await p.multiselect({
    message: "Which channels do you want to connect?",
    options: [
      { value: "discord",  label: "Discord" },
      { value: "telegram", label: "Telegram" },
      { value: "slack",    label: "Slack" },
      { value: "whatsapp", label: "WhatsApp  (via Twilio)" },
    ],
    required: false,
  }));

  if (!selected.length) {
    p.log.info("No channels selected. Edit .claudbot/channels.yaml later to add them.");
    return;
  }

  const channels = [];

  for (const ch of selected) {
    p.log.step(`Setting up ${ch}…`);
    try {
      if (ch === "discord")  channels.push(await setupDiscord());
      if (ch === "telegram") channels.push(await setupTelegram());
      if (ch === "slack")    channels.push(await setupSlack());
      if (ch === "whatsapp") channels.push(await setupWhatsApp());
    } catch {
      p.log.warn(`${ch} setup skipped.`);
    }
  }

  writeFileSync(CHANNELS_FILE, yamlStringify({ channels }, { lineWidth: 0 }));
  p.log.success(`channels.yaml saved (${channels.length} channel${channels.length !== 1 ? "s" : ""}).`);
  p.log.warn("Add channels.yaml to .gitignore — it contains API credentials.");
}

// ─── step 7: restrictions ─────────────────────────────────────────────────────

const RESTRICTION_PRESETS = [
  { value: "Bash(rm -rf *)",         label: "Block  rm -rf  (destructive deletes)" },
  { value: "Bash(del /f /s /q *)",   label: "Block  del /f  (Windows force delete)" },
  { value: "Bash(format *)",         label: "Block  format   (disk formatting)" },
  { value: "Bash(dd *)",             label: "Block  dd       (disk write tool)" },
  { value: "Bash(sudo rm *)",        label: "Block  sudo rm  (root deletes)" },
  { value: "Bash(curl * | bash)",    label: "Block  curl|bash (remote code execution)" },
  { value: "Bash(wget * -O- | sh)", label: "Block  wget|sh   (remote code execution)" },
];

async function stepRestrictions() {
  p.log.step("Restrictions — commands and paths Claude can never touch");

  p.note(
    "Deny rules are hard blocks enforced even in full-autonomous mode.\n" +
    "Claude literally cannot run a blocked command or edit a blocked path.",
    "Restrictions"
  );

  const presets = checkCancel(await p.multiselect({
    message: "Select built-in restrictions to enable:",
    options: RESTRICTION_PRESETS,
    required: false,
  }));

  const addCustom = checkCancel(await p.confirm({
    message: "Add custom deny rules? (file paths or bash patterns)",
    initialValue: false,
  }));

  const customRules = [];
  if (addCustom) {
    p.note(
      "Examples:\n" +
      "  Edit(C:/Users/*/Documents/*)   block editing this folder\n" +
      "  Write(/etc/*)                   block writing to /etc\n" +
      "  Bash(git push --force *)        block force pushes\n" +
      "  Bash(npm publish *)             block publishing packages",
      "Deny rule syntax"
    );

    let more = true;
    while (more) {
      const rule = checkCancel(await p.text({
        message: "Deny rule (or leave blank to stop):",
        placeholder: "e.g. Bash(rm *) or Edit(C:/sensitive/*)",
      }));
      if (!rule?.trim()) break;
      customRules.push(rule.trim());
      more = true;
    }
  }

  const allRules = [...presets, ...customRules];

  writeFileSync(RESTRICT_FILE, yamlStringify({ deny: allRules }, { lineWidth: 0 }));
  p.log.success(`restrictions.yaml saved (${allRules.length} rule${allRules.length !== 1 ? "s" : ""}).`);
}

// ─── step 8: permission mode ──────────────────────────────────────────────────

async function stepPermissionMode() {
  p.log.step("Default permission mode");

  const mode = checkCancel(await p.select({
    message: "How should Claudbot behave by default?",
    options: [
      {
        value: "full",
        label: "Full autonomous  (no prompts, applies restrictions only)",
        hint: "recommended for power users",
      },
      {
        value: "auto",
        label: "Auto             (runs safe ops automatically, asks for risky ones)",
        hint: "good balance",
      },
      {
        value: "safe",
        label: "Safe             (edits files freely, asks before every bash command)",
      },
      {
        value: "readonly",
        label: "Read-only        (no file edits or bash at all)",
      },
    ],
  }));

  writeEnv("CLAUDBOT_DEFAULT_MODE", mode);
  p.log.success(`Default mode set to: ${mode}  (override anytime with --mode <mode>)`);
  return mode;
}

// ─── step 9: write / merge settings.json ─────────────────────────────────────

async function stepFinalizeSettings(channels) {
  const settings = readYaml(SETTINGS_FILE, {});

  // Ensure claudbot-exec MCP is present
  settings.mcpServers = settings.mcpServers ?? {};
  settings.mcpServers["claudbot-exec"] = {
    command: "node",
    args: ["../../mcp-servers/claudbot-exec/index.mjs"],
    env: {},
  };

  // Permissions
  settings.permissions = settings.permissions ?? { allow: [], deny: [] };
  if (!settings.permissions.allow?.length) {
    settings.permissions.allow = [
      "Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
      "Glob(*)", "Grep(*)", "WebSearch(*)", "WebFetch(*)",
    ];
  }

  // Add channels.yaml to .gitignore if not already there
  const gitignorePath = path.join(ROOT, ".gitignore");
  const gi = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const linesToAdd = [".env", ".claudbot/channels.yaml"].filter((l) => !gi.includes(l));
  if (linesToAdd.length) appendFileSync(gitignorePath, "\n" + linesToAdd.join("\n") + "\n");

  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ─── step 10: health check ────────────────────────────────────────────────────

async function stepHealthCheck() {
  p.log.step("Health check");

  const spin = p.spinner();

  // Claude Code
  spin.start("Verifying Claude Code auth…");
  const claudeOk = tryRun("claude", ["auth", "status", "--text"]);
  if (claudeOk && !claudeOk.includes("not logged")) {
    spin.stop(chalk.green("✓ Claude Code authenticated"));
  } else {
    spin.stop(chalk.yellow("⚠ Claude Code auth unclear — run `claude auth login` if needed"));
  }

  // NIM key
  const nimKey = process.env.NIM_API_KEY || readEnvKey("NIM_API_KEY");
  if (nimKey?.startsWith("nvapi-")) {
    spin.start("Testing NIM key…");
    try {
      const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
        headers: { Authorization: `Bearer ${nimKey}` },
      });
      spin.stop(res.ok ? chalk.green("✓ NIM API key valid") : chalk.yellow(`⚠ NIM returned ${res.status}`));
    } catch {
      spin.stop(chalk.yellow("⚠ Could not reach NIM — check your connection"));
    }
  } else {
    p.log.warn("NIM API key not set — fallback provider will be unavailable");
  }

  // restrictions.yaml
  if (existsSync(RESTRICT_FILE)) {
    const r = readYaml(RESTRICT_FILE, { deny: [] });
    p.log.info(`Restrictions: ${(r.deny ?? []).length} deny rule(s) active`);
  }

  // agents.yaml
  if (existsSync(AGENTS_FILE)) {
    const a = readYaml(AGENTS_FILE, { agents: [] });
    p.log.info(`Sub-agents: ${(a.agents ?? []).length} registered`);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  await stepWelcome();
  await stepClaudeAuth();
  await stepNim();
  await stepObsidian();
  await stepSubAgents();
  await stepChannels();
  await stepRestrictions();
  const defaultMode = await stepPermissionMode();
  await stepFinalizeSettings();
  await stepHealthCheck();

  p.outro(
    chalk.bold.green("Claudbot is ready!") + "\n\n" +
    "  Start it:          " + chalk.cyan("node claudbot.mjs") + "\n" +
    "  With a mode:       " + chalk.cyan(`node claudbot.mjs --mode ${defaultMode}`) + "\n" +
    "  Add sub-agents:    " + chalk.cyan("edit .claudbot/agents.yaml") + "\n" +
    "  Add restrictions:  " + chalk.cyan("edit .claudbot/restrictions.yaml") + "\n" +
    "  Add channels:      " + chalk.cyan("edit .claudbot/channels.yaml") + "\n\n" +
    chalk.dim("Tip: source .env before running to load your API keys")
  );
}

main().catch((err) => {
  p.log.error(err.message ?? String(err));
  process.exit(1);
});
