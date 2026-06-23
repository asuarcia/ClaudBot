#!/usr/bin/env node
/**
 * Claudbot onboarding wizard
 *
 * Steps:
 *   1. Welcome + risk acknowledgment
 *   2. Claude Code auth
 *   3. Fallback inference provider
 *   4. Obsidian memory vault (optional)
 *   5. Sub-agent creation (loop, any endpoint)
 *   6. Channel connections (Discord, Telegram, Slack, WhatsApp)
 *   7. Restrictions (pre-loaded safety set — deselect to remove)
 *   8. Default permission mode
 *   9. Write all config files
 *  10. Health check
 *  11. Launch instructions
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

const ROOT          = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLAUDBOT_DIR  = path.join(ROOT, ".claudbot");
const ENV_FILE      = path.join(ROOT, ".env");
const AGENTS_FILE   = path.join(CLAUDBOT_DIR, "agents.yaml");
const CHANNELS_FILE = path.join(CLAUDBOT_DIR, "channels.yaml");
const RESTRICT_FILE = path.join(CLAUDBOT_DIR, "restrictions.yaml");
const SETTINGS_FILE = path.join(CLAUDBOT_DIR, ".claude", "settings.json");

// ─── helpers ─────────────────────────────────────────────────────────────────

function bail(msg) {
  p.cancel(msg ?? "Onboarding cancelled.");
  process.exit(0);
}

function checkCancel(val) {
  if (p.isCancel(val)) bail();
  return val;
}

function tryRun(file, args = []) {
  const r = spawnSync(file, args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout.trim() : null;
}

function readEnvKey(key) {
  if (!existsSync(ENV_FILE)) return null;
  const line = readFileSync(ENV_FILE, "utf8").split("\n").find((l) => l.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : null;
}

function writeEnv(key, value) {
  let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  content = re.test(content) ? content.replace(re, line) : content + (content.endsWith("\n") || !content ? "" : "\n") + line + "\n";
  writeFileSync(ENV_FILE, content);
}

function readYaml(filePath, defaultVal) {
  try { return yamlParse(readFileSync(filePath, "utf8")) ?? defaultVal; }
  catch { return defaultVal; }
}

// ─── banner ──────────────────────────────────────────────────────────────────

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

// ─── provider registry ───────────────────────────────────────────────────────

const PROVIDERS = [
  // ── Cloud ──
  { value: "nim",        label: "NVIDIA NIM",       hint: "cloud · free tier · nvapi-…",        url: "https://integrate.api.nvidia.com/v1",                          keyEnv: "NIM_API_KEY" },
  { value: "openai",     label: "OpenAI",            hint: "GPT-4o, o3, o4-mini · sk-…",         url: "https://api.openai.com/v1",                                    keyEnv: "OPENAI_API_KEY" },
  { value: "anthropic",  label: "Anthropic",         hint: "Claude API · billed per token",       url: "https://api.anthropic.com/v1",                                 keyEnv: "ANTHROPIC_API_KEY" },
  { value: "gemini",     label: "Google Gemini",     hint: "Gemini 2.0 / 1.5 · AIza-…",          url: "https://generativelanguage.googleapis.com/v1beta/openai",      keyEnv: "GEMINI_API_KEY" },
  { value: "mistral",    label: "Mistral AI",        hint: "Mistral Large, Codestral",            url: "https://api.mistral.ai/v1",                                    keyEnv: "MISTRAL_API_KEY" },
  { value: "groq",       label: "Groq",              hint: "ultra-fast inference · gsk_…",        url: "https://api.groq.com/openai/v1",                               keyEnv: "GROQ_API_KEY" },
  { value: "together",   label: "Together AI",       hint: "many open models",                    url: "https://api.together.xyz/v1",                                  keyEnv: "TOGETHER_API_KEY" },
  { value: "openrouter", label: "OpenRouter",        hint: "unified multi-provider · sk-or-…",    url: "https://openrouter.ai/api/v1",                                 keyEnv: "OPENROUTER_API_KEY" },
  { value: "xai",        label: "xAI",               hint: "Grok models",                         url: "https://api.x.ai/v1",                                          keyEnv: "XAI_API_KEY" },
  { value: "cohere",     label: "Cohere",            hint: "Command R+",                          url: "https://api.cohere.ai/compatibility/v1",                       keyEnv: "COHERE_API_KEY" },
  { value: "deepinfra",  label: "DeepInfra",         hint: "cheap hosted open models",            url: "https://api.deepinfra.com/v1/openai",                          keyEnv: "DEEPINFRA_API_KEY" },
  { value: "fireworks",  label: "Fireworks AI",      hint: "fast open model hosting",             url: "https://api.fireworks.ai/inference/v1",                        keyEnv: "FIREWORKS_API_KEY" },
  // ── Local ──
  { value: "ollama",     label: "Ollama",            hint: "local · free · no key needed",        url: "http://localhost:11434/v1",                                    keyEnv: null },
  { value: "lmstudio",   label: "LM Studio",         hint: "local · free · no key needed",        url: "http://localhost:1234/v1",                                     keyEnv: null },
  { value: "nim_local",  label: "NVIDIA NIM (local)","hint": "self-hosted NIM container",          url: "http://localhost:8000/v1",                                     keyEnv: null },
  { value: "vllm",       label: "vLLM",              hint: "self-hosted",                          url: "http://localhost:8000/v1",                                     keyEnv: null },
  { value: "custom",     label: "Custom",            hint: "any OpenAI-compatible endpoint",       url: null,                                                           keyEnv: null },
];

function getProvider(value) {
  return PROVIDERS.find((p) => p.value === value);
}

// ─── step 1: welcome ─────────────────────────────────────────────────────────

async function stepWelcome() {
  p.intro(chalk.bold("Claudbot Setup Wizard"));

  p.note(
    [
      chalk.yellow("⚠  Security notice"),
      "",
      "By default Claudbot runs with full system access.",
      "It can read files, run shell commands, and browse the web",
      "without asking for permission.",
      "",
      "This wizard will configure safety restrictions and a permission",
      "mode before you run it.",
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

  p.note("You need a Claude subscription (claude.ai/code).\nA browser window will open.", "Claude Code login");

  const doLogin = checkCancel(await p.confirm({ message: "Open browser to log in now?" }));
  if (!doLogin) bail("Claude Code auth is required. Run `claude auth login` first.");

  const result = spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
  if (result.status !== 0) bail("Login failed. Run `claude auth login` manually and try again.");

  p.log.success("Claude Code authenticated.");
}

// ─── step 3: fallback provider ───────────────────────────────────────────────

async function stepFallbackProvider() {
  p.log.step("Fallback inference provider");
  p.note(
    "When Claude Code hits its rate limit, Claudbot switches to this provider.\n" +
    "It also powers your sub-agents.",
    "Fallback provider"
  );

  const choice = checkCancel(await p.select({
    message: "Select your fallback provider:",
    options: PROVIDERS.map((pr) => ({
      value: pr.value,
      label: pr.label,
      hint: pr.hint,
    })),
  }));

  const provider = getProvider(choice);

  let url = provider.url;
  if (!url) {
    url = checkCancel(await p.text({
      message: "Base URL:",
      validate: (v) => (v.startsWith("http") ? undefined : "Must start with http"),
    }));
  }

  const model = checkCancel(await p.text({
    message: "Default model ID for this provider:",
    placeholder: "e.g. meta/llama-3.3-70b-instruct",
    validate: (v) => (v.trim().length < 2 ? "Required" : undefined),
  }));

  if (provider.keyEnv) {
    const existingKey = process.env[provider.keyEnv] ?? readEnvKey(provider.keyEnv);
    const update = checkCancel(await p.confirm({
      message: existingKey ? `${provider.keyEnv} already set. Update it?` : `Enter API key for ${provider.label}?`,
      initialValue: !existingKey,
    }));

    if (update) {
      const key = checkCancel(await p.password({
        message: `${provider.keyEnv}:`,
        validate: (v) => (v.trim().length < 5 ? "Key looks too short" : undefined),
      }));
      writeEnv(provider.keyEnv, key.trim());
    }

    writeEnv("NIM_API_KEY", readEnvKey(provider.keyEnv) ?? process.env[provider.keyEnv] ?? "");
  }

  writeEnv("NIM_BASE_URL", url.trim());
  writeEnv("NIM_MODEL", model.trim());

  p.log.success(`Fallback provider set: ${provider.label} · ${model.trim()}`);
}

// ─── step 4: obsidian ────────────────────────────────────────────────────────

async function stepObsidian() {
  p.log.step("Obsidian memory vault (optional)");

  const use = checkCancel(await p.confirm({
    message: "Connect an Obsidian vault for long-term memory?",
    initialValue: true,
  }));

  const settings = readYaml(SETTINGS_FILE, {});
  settings.mcpServers = settings.mcpServers ?? {};

  if (!use) {
    delete settings.mcpServers["obsidian-brain"];
    mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    p.log.info("Skipping Obsidian.");
    return;
  }

  const defaultVault = process.platform === "win32" ? "C:\\Repo\\MyBrain" : `${process.env.HOME}/MyBrain`;
  const vaultPath = checkCancel(await p.text({
    message: "Path to your Obsidian vault:",
    initialValue: defaultVault,
    validate: (v) => (v.trim().length === 0 ? "Required" : undefined),
  }));

  settings.mcpServers["obsidian-brain"] = {
    command: "npx",
    args: ["-y", "mcp-obsidian", vaultPath.trim()],
  };
  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  p.log.success(`Obsidian vault: ${vaultPath.trim()}`);
}

// ─── step 5: sub-agents ──────────────────────────────────────────────────────

async function createOneAgent() {
  const name = checkCancel(await p.text({
    message: "Agent name:",
    placeholder: "e.g. coder, researcher, devops",
    validate: (v) => (/^[a-z0-9-]+$/.test(v.trim()) ? undefined : "Lowercase letters, numbers, hyphens only"),
  }));

  const providerChoice = checkCancel(await p.select({
    message: "Inference provider:",
    options: PROVIDERS.map((pr) => ({
      value: pr.value,
      label: pr.label,
      hint: pr.hint,
    })),
  }));

  const provider = getProvider(providerChoice);

  let url = provider.url;
  if (!url) {
    url = checkCancel(await p.text({
      message: "Base URL:",
      validate: (v) => (v.startsWith("http") ? undefined : "Must start with http"),
    }));
  }

  const model = checkCancel(await p.text({
    message: "Model ID:",
    placeholder: "e.g. deepseek-ai/deepseek-v3",
    validate: (v) => (v.trim().length < 2 ? "Required" : undefined),
  }));

  const description = checkCancel(await p.text({
    message: "What is this agent good at?",
    placeholder: "e.g. Code generation, debugging, refactoring. Best for writing and reviewing code.",
    validate: (v) => (v.trim().length < 10 ? "Please describe the agent's specialty" : undefined),
  }));

  let apiKeyEnv = provider.keyEnv ?? null;

  if (provider.keyEnv) {
    const existingKey = process.env[provider.keyEnv] ?? readEnvKey(provider.keyEnv);
    if (!existingKey) {
      const key = checkCancel(await p.password({
        message: `API key for ${provider.label} (${provider.keyEnv}):`,
      }));
      if (key?.trim()) writeEnv(provider.keyEnv, key.trim());
    } else {
      p.log.info(`Using existing ${provider.keyEnv}.`);
    }
  } else if (providerChoice !== "ollama" && providerChoice !== "lmstudio" &&
             providerChoice !== "nim_local" && providerChoice !== "vllm") {
    const customKeyEnv = checkCancel(await p.text({
      message: "Environment variable name for API key (or leave blank if none):",
      initialValue: `${name.toUpperCase()}_API_KEY`,
    }));
    if (customKeyEnv?.trim()) {
      apiKeyEnv = customKeyEnv.trim();
      const key = checkCancel(await p.password({ message: `Value for ${apiKeyEnv}:` }));
      if (key?.trim()) writeEnv(apiKeyEnv, key.trim());
    }
  }

  return {
    name: name.trim(),
    model: model.trim(),
    endpoint: url.trim(),
    apiKeyEnv: apiKeyEnv ?? null,
    jobDescription: description.trim(),
  };
}

async function stepSubAgents() {
  p.log.step("Sub-agents");

  p.note(
    "Sub-agents are specialized models Claude delegates to.\n" +
    "You can use any provider — NIM, OpenAI, Ollama, Groq, etc.\n" +
    "Add more later by editing .claudbot/agents.yaml.",
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
  p.note("discord.com/developers/applications → create app → enable bot → copy token.", "Discord");
  const token    = checkCancel(await p.password({ message: "Bot token:" }));
  const guildId  = checkCancel(await p.text({ message: "Server (guild) ID:" }));
  const channelId= checkCancel(await p.text({ message: "Default channel ID:" }));
  writeEnv("DISCORD_BOT_TOKEN", token.trim());
  return { type: "discord", guildId: guildId.trim(), channelId: channelId.trim(), tokenEnv: "DISCORD_BOT_TOKEN" };
}

async function setupTelegram() {
  p.note("Message @BotFather on Telegram to create a bot.", "Telegram");
  const token  = checkCancel(await p.password({ message: "Bot token:" }));
  const chatId = checkCancel(await p.text({ message: "Chat ID:" }));
  writeEnv("TELEGRAM_BOT_TOKEN", token.trim());
  return { type: "telegram", chatId: chatId.trim(), tokenEnv: "TELEGRAM_BOT_TOKEN" };
}

async function setupSlack() {
  p.note("api.slack.com/apps → create app → add bot → install → copy Bot OAuth Token.", "Slack");
  const token   = checkCancel(await p.password({ message: "Bot token (xoxb-…):" }));
  const channel = checkCancel(await p.text({ message: "Default channel (e.g. #general):" }));
  writeEnv("SLACK_BOT_TOKEN", token.trim());
  return { type: "slack", channel: channel.trim(), tokenEnv: "SLACK_BOT_TOKEN" };
}

async function setupWhatsApp() {
  p.note("console.twilio.com → enable WhatsApp sandbox → copy credentials.", "WhatsApp");
  const sid   = checkCancel(await p.text({ message: "Twilio Account SID:" }));
  const token = checkCancel(await p.password({ message: "Twilio Auth Token:" }));
  const from  = checkCancel(await p.text({ message: "From number (whatsapp:+14155238886):" }));
  const to    = checkCancel(await p.text({ message: "Your WhatsApp number (whatsapp:+1…):" }));
  writeEnv("TWILIO_ACCOUNT_SID", sid.trim());
  writeEnv("TWILIO_AUTH_TOKEN", token.trim());
  return { type: "whatsapp", from: from.trim(), to: to.trim(), sidEnv: "TWILIO_ACCOUNT_SID", tokenEnv: "TWILIO_AUTH_TOKEN" };
}

async function stepChannels() {
  p.log.step("Channel connections (optional)");

  const selected = checkCancel(await p.multiselect({
    message: "Connect messaging channels:",
    options: [
      { value: "discord",  label: "Discord" },
      { value: "telegram", label: "Telegram" },
      { value: "slack",    label: "Slack" },
      { value: "whatsapp", label: "WhatsApp  (via Twilio)" },
    ],
    required: false,
  }));

  if (!selected.length) {
    p.log.info("No channels selected. Edit .claudbot/channels.yaml later.");
    return;
  }

  const channels = [];
  for (const ch of selected) {
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
}

// ─── step 7: restrictions ─────────────────────────────────────────────────────

const RESTRICTION_PRESETS = [
  // Destructive
  { value: "Bash(rm -rf *)",                   label: "rm -rf                  destructive recursive delete" },
  { value: "Bash(del /f /s /q *)",             label: "del /f /s /q            Windows force delete" },
  { value: "Bash(rd /s /q *)",                 label: "rd /s /q                Windows remove directory" },
  { value: "Bash(Remove-Item -Recurse -Force *)", label: "Remove-Item -Force      PowerShell delete" },
  // Disk / boot
  { value: "Bash(format *)",                   label: "format                  disk formatting" },
  { value: "Bash(diskpart *)",                 label: "diskpart                disk partitioning" },
  { value: "Bash(dd *)",                       label: "dd                      disk write tool" },
  { value: "Bash(bcdedit *)",                  label: "bcdedit                 boot config editor" },
  // System control
  { value: "Bash(shutdown *)",                 label: "shutdown                system shutdown" },
  { value: "Bash(Restart-Computer *)",         label: "Restart-Computer        PowerShell restart" },
  { value: "Bash(Stop-Computer *)",            label: "Stop-Computer           PowerShell shutdown" },
  { value: "Bash(taskkill *)",                 label: "taskkill                kill processes" },
  // Services / users
  { value: "Bash(sc delete *)",                label: "sc delete               delete system services" },
  { value: "Bash(sc stop *)",                  label: "sc stop                 stop system services" },
  { value: "Bash(net user *)",                 label: "net user                user account management" },
  { value: "Bash(net localgroup *)",           label: "net localgroup          admin group management" },
  // Registry
  { value: "Bash(reg delete *)",               label: "reg delete              registry deletion" },
  { value: "Bash(reg add *)",                  label: "reg add                 registry modification" },
  { value: "Bash(regedit *)",                  label: "regedit                 registry editor" },
  // Scheduled tasks
  { value: "Bash(schtasks /create *)",         label: "schtasks /create        create scheduled task" },
  { value: "Bash(schtasks /delete *)",         label: "schtasks /delete        delete scheduled task" },
  { value: "Bash(icacls *)",                   label: "icacls                  modify file permissions" },
  { value: "Bash(takeown *)",                  label: "takeown                 take file ownership" },
  // Remote code execution
  { value: "Bash(curl * | bash)",              label: "curl | bash             remote code execution" },
  { value: "Bash(curl * | sh)",                label: "curl | sh               remote code execution" },
  { value: "Bash(wget * | bash)",              label: "wget | bash             remote code execution" },
  { value: "Bash(wget * -O- | sh)",            label: "wget | sh               remote code execution" },
  { value: "Bash(iex *)",                      label: "iex                     PowerShell remote exec" },
  { value: "Bash(Invoke-Expression *)",        label: "Invoke-Expression       PowerShell remote exec" },
  // Git guardrails
  { value: "Bash(git push --force *)",         label: "git push --force        destructive force push" },
  { value: "Bash(git push -f *)",              label: "git push -f             destructive force push" },
  { value: "Bash(git reset --hard *)",         label: "git reset --hard        destructive git reset" },
  // Publishing
  { value: "Bash(npm publish *)",              label: "npm publish             package publishing" },
  { value: "Bash(winget install *)",           label: "winget install          system package install" },
  { value: "Bash(choco install *)",            label: "choco install           chocolatey install" },
  // System paths
  { value: "Edit(C:/Windows/*)",               label: "Edit  C:/Windows/       system directory" },
  { value: "Write(C:/Windows/*)",              label: "Write C:/Windows/       system directory" },
  { value: "Edit(C:/Program Files/*)",         label: "Edit  C:/Program Files/ program directory" },
  { value: "Write(C:/Program Files/*)",        label: "Write C:/Program Files/ program directory" },
  { value: "Write(C:/Users/*/AppData/Roaming/*)", label: "Write AppData/Roaming/  user app data" },
  { value: "Write(C:/Users/*/AppData/Local/*)",   label: "Write AppData/Local/    user local app data" },
  // Credentials
  { value: "Edit(C:/Users/*/.ssh/*)",          label: "Edit  .ssh/             SSH keys" },
  { value: "Write(C:/Users/*/.ssh/*)",         label: "Write .ssh/             SSH keys" },
  { value: "Write(C:/Users/*/.aws/*)",         label: "Write .aws/             AWS credentials" },
  { value: "Write(C:/Users/*/.claude*)",       label: "Write .claude           Claude auth tokens" },
];

async function stepRestrictions() {
  p.log.step("Safety restrictions");

  p.note(
    "All restrictions are enabled by default.\n" +
    "Deselect any you want to remove.\n" +
    "These are hard blocks — enforced even in full-autonomous mode.",
    "Restrictions"
  );

  const allValues = RESTRICTION_PRESETS.map((r) => r.value);

  const kept = checkCancel(await p.multiselect({
    message: "Active restrictions (deselect to remove):",
    options: RESTRICTION_PRESETS,
    initialValues: allValues,
    required: false,
  }));

  const addCustom = checkCancel(await p.confirm({
    message: "Add any custom deny rules?",
    initialValue: false,
  }));

  const customRules = [];
  if (addCustom) {
    p.note(
      "Examples:\n" +
      "  Bash(git push --force *)   block force pushes\n" +
      "  Edit(C:/sensitive/*)       block edits to a path\n" +
      "  Write(/etc/*)              block writes to /etc",
      "Custom deny rule syntax"
    );
    let more = true;
    while (more) {
      const rule = checkCancel(await p.text({
        message: "Rule (leave blank to stop):",
        placeholder: "Bash(rm *) or Edit(C:/path/*)",
      }));
      if (!rule?.trim()) break;
      customRules.push(rule.trim());
    }
  }

  const allRules = [...kept, ...customRules];
  writeFileSync(RESTRICT_FILE, yamlStringify({ deny: allRules }, { lineWidth: 0 }));
  p.log.success(`restrictions.yaml saved (${allRules.length} rule${allRules.length !== 1 ? "s" : ""} active).`);
}

// ─── step 8: permission mode ──────────────────────────────────────────────────

async function stepPermissionMode() {
  p.log.step("Default permission mode");

  const mode = checkCancel(await p.select({
    message: "How should Claudbot behave by default?",
    options: [
      { value: "full",     label: "Full autonomous", hint: "no prompts — restrictions still apply" },
      { value: "auto",     label: "Auto",            hint: "runs safe ops automatically, asks for risky ones" },
      { value: "safe",     label: "Safe",            hint: "edits files freely, asks before every bash command" },
      { value: "readonly", label: "Read-only",       hint: "no file edits or bash at all" },
    ],
  }));

  writeEnv("CLAUDBOT_DEFAULT_MODE", mode);
  p.log.success(`Default mode: ${mode}`);
  return mode;
}

// ─── step 9: finalize settings ───────────────────────────────────────────────

async function stepFinalizeSettings() {
  const settings = readYaml(SETTINGS_FILE, {});
  settings.mcpServers = settings.mcpServers ?? {};
  settings.mcpServers["claudbot-exec"] = {
    command: "node",
    args: ["../../mcp-servers/claudbot-exec/index.mjs"],
    env: {},
  };
  settings.permissions = settings.permissions ?? {};
  if (!settings.permissions.allow?.length) {
    settings.permissions.allow = [
      "Bash(*)", "Read(*)", "Write(*)", "Edit(*)",
      "Glob(*)", "Grep(*)", "WebSearch(*)", "WebFetch(*)",
    ];
  }

  mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));

  // Keep secrets out of git
  const giPath = path.join(ROOT, ".gitignore");
  const gi = existsSync(giPath) ? readFileSync(giPath, "utf8") : "";
  const toAdd = [".env", ".claudbot/channels.yaml"].filter((l) => !gi.includes(l));
  if (toAdd.length) appendFileSync(giPath, "\n" + toAdd.join("\n") + "\n");
}

// ─── step 10: health check ────────────────────────────────────────────────────

async function stepHealthCheck() {
  p.log.step("Health check");
  const spin = p.spinner();

  spin.start("Verifying Claude Code…");
  const claudeOk = tryRun("claude", ["auth", "status", "--text"]);
  spin.stop(claudeOk && !claudeOk.includes("not logged")
    ? chalk.green("✓ Claude Code authenticated")
    : chalk.yellow("⚠ Claude Code auth unclear — run `claude auth login` if needed"));

  const nimKey = process.env.NIM_API_KEY || readEnvKey("NIM_API_KEY");
  const nimBase = readEnvKey("NIM_BASE_URL") || "https://integrate.api.nvidia.com/v1";
  if (nimKey) {
    spin.start("Testing fallback provider key…");
    try {
      const res = await fetch(`${nimBase}/models`, { headers: { Authorization: `Bearer ${nimKey}` } });
      spin.stop(res.ok ? chalk.green("✓ Fallback provider key valid") : chalk.yellow(`⚠ Provider returned ${res.status}`));
    } catch {
      spin.stop(chalk.yellow("⚠ Could not reach provider — check your connection"));
    }
  } else {
    p.log.warn("No fallback API key set — fallback provider unavailable");
  }

  const restrict = readYaml(RESTRICT_FILE, { deny: [] });
  p.log.info(`Restrictions: ${(restrict.deny ?? []).length} rules active`);

  const agents = readYaml(AGENTS_FILE, { agents: [] });
  p.log.info(`Sub-agents: ${(agents.agents ?? []).length} registered`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  await stepWelcome();
  await stepClaudeAuth();
  await stepFallbackProvider();
  await stepObsidian();
  await stepSubAgents();
  await stepChannels();
  await stepRestrictions();
  const defaultMode = await stepPermissionMode();
  await stepFinalizeSettings();
  await stepHealthCheck();

  p.outro(
    chalk.bold.green("Claudbot is ready!") + "\n\n" +
    "  Load keys:         " + chalk.cyan(
      process.platform === "win32"
        ? "Get-Content .env | ForEach-Object { if ($_ -match '^([^#=][^=]*)=(.+)$') { [System.Environment]::SetEnvironmentVariable($matches[1],$matches[2],'Process') } }"
        : "source .env"
    ) + "\n" +
    "  Start:             " + chalk.cyan(`node claudbot.mjs`) + "\n" +
    "  With mode:         " + chalk.cyan(`node claudbot.mjs --mode ${defaultMode}`) + "\n\n" +
    chalk.dim("Edit .claudbot/agents.yaml to add/change sub-agents anytime.")
  );
}

main().catch((err) => {
  p.log.error(err.message ?? String(err));
  process.exit(1);
});
