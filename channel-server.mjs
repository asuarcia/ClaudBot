#!/usr/bin/env node
/**
 * Claudbot channel server
 *
 * Receives messages from WhatsApp (Twilio) and Telegram, processes them
 * through NIM, and sends responses back. Runs alongside the main claudbot
 * session in a separate terminal.
 *
 * Usage:
 *   node channel-server.mjs           # reads .env automatically
 *   node channel-server.mjs --port 3000
 *
 * Webhook URLs to register:
 *   WhatsApp  → https://your-domain/webhook/whatsapp
 *   Telegram  → https://your-domain/webhook/telegram
 *
 * For local dev use ngrok: npx ngrok http 3000
 */

import express from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { parse as yamlParse } from "yaml";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── paths ───────────────────────────────────────────────────────────────────

const ROOT          = path.dirname(fileURLToPath(import.meta.url));
const CLAUDBOT_ROOT = path.join(ROOT, ".claudbot");
const CLAUDE_MD     = path.join(CLAUDBOT_ROOT, "CLAUDE.md");
const CHANNELS_FILE = path.join(CLAUDBOT_ROOT, "channels.yaml");
const LOG_FILE      = path.join(CLAUDBOT_ROOT, "channel-log.md");

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

// ─── config ──────────────────────────────────────────────────────────────────

const PORT              = parseInt(process.argv[process.argv.indexOf("--port") + 1] || process.env.CHANNEL_PORT || "3000");
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "";
const TWILIO_ACCOUNT_SID= process.env.TWILIO_ACCOUNT_SID ?? "";
const TWILIO_FROM       = process.env.TWILIO_WHATSAPP_FROM ?? process.env.TWILIO_FROM ?? "";
const TELEGRAM_TOKEN    = process.env.TELEGRAM_BOT_TOKEN ?? "";
const MAX_HISTORY       = 20; // messages per user

// System prompt: use the Claudbot persona from CLAUDE.md
function loadSystemPrompt() {
  if (existsSync(CLAUDE_MD)) return readFileSync(CLAUDE_MD, "utf8");
  return "You are Claudbot, an autonomous AI agent. Be concise and helpful.";
}

// ─── NIM provider (inline, no circular import) ───────────────────────────────

const NIM_BASE = (process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
const NIM_KEY  = process.env.NIM_API_KEY ?? "";
const NIM_MODEL= process.env.NIM_MODEL   ?? "meta/llama-3.1-70b-instruct";

async function nimChat(messages) {
  if (!NIM_KEY) throw new Error("NIM_API_KEY not set");
  const res = await fetch(`${NIM_BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${NIM_KEY}` },
    body: JSON.stringify({ model: NIM_MODEL, messages, max_tokens: 1024 }),
  });
  if (!res.ok) throw new Error(`NIM HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "(empty response)";
}

// ─── conversation histories ───────────────────────────────────────────────────

const histories = new Map(); // userId → Message[]

function getHistory(userId) {
  return histories.get(userId) ?? [];
}

function addMessage(userId, role, content) {
  const h = getHistory(userId);
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, 2);
  histories.set(userId, h);
}

// ─── logging ─────────────────────────────────────────────────────────────────

function logMessage(channel, from, direction, text) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${channel}] ${direction === "in" ? "←" : "→"} ${from}: ${text.slice(0, 200)}\n`;
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

// ─── Twilio signature validation ─────────────────────────────────────────────

function validateTwilioSignature(req, res, next) {
  if (!TWILIO_AUTH_TOKEN) {
    console.warn("[channel] TWILIO_AUTH_TOKEN not set — skipping signature validation (unsafe in production)");
    return next();
  }

  const signature = req.headers["x-twilio-signature"] ?? "";
  const url = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  // Build sorted param string
  const params = req.body;
  const sortedKeys = Object.keys(params).sort();
  const paramStr = sortedKeys.map((k) => `${k}${params[k]}`).join("");
  const expected = createHmac("sha1", TWILIO_AUTH_TOKEN)
    .update(url + paramStr)
    .digest("base64");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return res.status(403).send("Forbidden");
  }
  next();
}

// ─── Twilio helper: send WhatsApp message ────────────────────────────────────

async function sendWhatsApp(to, body) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) throw new Error("Twilio credentials not set");
  const creds = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
    body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
}

// ─── Telegram helper: send message ───────────────────────────────────────────

async function sendTelegram(chatId, text) {
  if (!TELEGRAM_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

// ─── process a message ───────────────────────────────────────────────────────

async function processMessage(userId, userText) {
  const systemPrompt = loadSystemPrompt();
  addMessage(userId, "user", userText);

  const messages = [
    { role: "system", content: systemPrompt },
    ...getHistory(userId),
  ];

  const reply = await nimChat(messages);
  addMessage(userId, "assistant", reply);
  return reply;
}

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check
app.get("/health", (_req, res) => {
  const channels = [];
  if (TWILIO_ACCOUNT_SID) channels.push("whatsapp");
  if (TELEGRAM_TOKEN)      channels.push("telegram");
  res.json({ status: "ok", channels, model: NIM_MODEL });
});

// ── WhatsApp via Twilio ──────────────────────────────────────────────────────

app.post("/webhook/whatsapp", validateTwilioSignature, async (req, res) => {
  const from    = String(req.body.From ?? "").trim();
  const msgBody = String(req.body.Body ?? "").trim();

  if (!from || !msgBody) return res.sendStatus(200);

  logMessage("whatsapp", from, "in", msgBody);
  console.log(`[whatsapp] ← ${from}: ${msgBody.slice(0, 80)}`);

  // Respond with TwiML immediately; send actual reply async via REST API
  // so we're not blocked by the 15s Twilio webhook timeout on long responses
  res.type("text/xml").send("<Response></Response>");

  try {
    const reply = await processMessage(from, msgBody);
    logMessage("whatsapp", from, "out", reply);
    console.log(`[whatsapp] → ${from}: ${reply.slice(0, 80)}`);

    // Twilio has a 1600 char message limit — chunk if needed
    const chunks = chunkText(reply, 1500);
    for (const chunk of chunks) {
      await sendWhatsApp(from, chunk);
    }
  } catch (err) {
    console.error(`[whatsapp] Error: ${err.message}`);
    await sendWhatsApp(from, "Sorry, I ran into an error. Try again in a moment.").catch(() => {});
  }
});

// ── Telegram ────────────────────────────────────────────────────────────────

app.post("/webhook/telegram", async (req, res) => {
  res.sendStatus(200); // ack immediately

  const message = req.body?.message;
  if (!message?.text) return;

  const chatId  = String(message.chat.id);
  const from    = message.from?.username ?? chatId;
  const msgText = message.text.trim();

  logMessage("telegram", from, "in", msgText);
  console.log(`[telegram] ← ${from}: ${msgText.slice(0, 80)}`);

  try {
    const reply = await processMessage(chatId, msgText);
    logMessage("telegram", from, "out", reply);
    console.log(`[telegram] → ${from}: ${reply.slice(0, 80)}`);

    const chunks = chunkText(reply, 4000); // Telegram limit
    for (const chunk of chunks) {
      await sendTelegram(chatId, chunk);
    }
  } catch (err) {
    console.error(`[telegram] Error: ${err.message}`);
    await sendTelegram(chatId, "Error processing your message. Try again.").catch(() => {});
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function chunkText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    // Try to break at a newline or space
    let end = i + maxLen;
    if (end < text.length) {
      const nl = text.lastIndexOf("\n", end);
      const sp = text.lastIndexOf(" ", end);
      end = nl > i + maxLen / 2 ? nl : sp > i + maxLen / 2 ? sp : end;
    }
    chunks.push(text.slice(i, end).trim());
    i = end;
  }
  return chunks.filter(Boolean);
}

// ─── startup ─────────────────────────────────────────────────────────────────

function printStartup() {
  const hasWhatsApp = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
  const hasTelegram = Boolean(TELEGRAM_TOKEN);

  console.log(`
[claudbot channels] Server running on port ${PORT}

  Channels active:
    WhatsApp  ${hasWhatsApp ? "✓" : "✗  (set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_WHATSAPP_FROM)"}
    Telegram  ${hasTelegram ? "✓" : "✗  (set TELEGRAM_BOT_TOKEN)"}

  Webhook URLs (register these in your provider dashboard):
    WhatsApp  → POST http://YOUR-DOMAIN:${PORT}/webhook/whatsapp
    Telegram  → POST http://YOUR-DOMAIN:${PORT}/webhook/telegram

  For local testing:  npx ngrok http ${PORT}
  Health check:       http://localhost:${PORT}/health
`);

  if (!NIM_KEY) {
    console.warn("  ⚠  NIM_API_KEY not set — responses will fail.\n     Source your .env file or set the key.\n");
  }
}

app.listen(PORT, () => printStartup());
