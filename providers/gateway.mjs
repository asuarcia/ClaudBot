/**
 * GatewayProvider — the orchestrator's model connection.
 *
 * One OpenAI-compatible client that talks to whatever is in front of it. In
 * practice that is either a local OmniRoute gateway (http://localhost:20128/v1,
 * ~115 models, quota-aware fallback, no key needed) or NVIDIA NIM directly.
 * Claudbot deliberately does not depend on OmniRoute being installed: it is
 * 830MB and would not fit the portable drive, so when it is absent the
 * orchestrator resolves to the NIM roster instead and nothing else changes.
 *
 * Three things about real gateways that a textbook OpenAI client gets wrong,
 * all found by calling OmniRoute 3.8.49 rather than by reading its docs:
 *
 *   1. `stream` must be sent EXPLICITLY as false. Omitting the field is not the
 *      same as false — OmniRoute streams SSE by default, so a client that only
 *      sets `stream: true` for streaming gets back `data: {...}` lines where it
 *      expected a JSON body, and JSON.parse dies on the first token.
 *
 *   2. `content` is null on reasoning models. The free pool routes to reasoning
 *      backends that put their trace in a separate `reasoning_content` field
 *      and leave `content` null until they are done. Treating content as a
 *      string blows up; treating null as "empty answer" silently loses replies.
 *
 *   3. Reasoning spends the completion budget before it writes a word. A
 *      max_tokens of 30 came back `finish_reason: "length"` with content null
 *      and nothing else — the model had thought its way through the entire
 *      allowance. The default here is deliberately generous.
 */

import { spawn, spawnSync } from "node:child_process";

import { BaseProvider, RateLimitError, ProviderError } from "./base.mjs";

export const DEFAULT_GATEWAY_URL = "http://localhost:20128/v1";

/**
 * The pool the orchestrator talks through by default. Lives here rather than in
 * orchestrator.mjs because `doctor` checks the same value, and a default that
 * is written down twice is a default that will disagree with itself.
 *
 * `auto/best-chat`, not `auto/smart`, on measurement rather than on the name —
 * see the note at DEFAULT_MODEL in orchestrator.mjs for the numbers.
 */
export const DEFAULT_ORCHESTRATOR_MODEL = "auto/best-chat";

/**
 * How long to wait for a cold gateway to answer.
 *
 * Measured, not guessed: a fresh `omniroute` on this machine binds port 20128
 * almost immediately but does not serve a request for roughly a minute — it
 * accepts the TCP connection and then sits on it, so a probe does not get
 * "connection refused", it gets a hang. Anything under a minute gives up on a
 * gateway that was about to work.
 */
const GATEWAY_BOOT_TIMEOUT_MS = 120_000;
const GATEWAY_POLL_MS = 2000;

/**
 * Generous on purpose — see note 3 above. A reasoning model given a tight cap
 * returns its thinking and no answer, which reads as a broken assistant.
 */
const DEFAULT_MAX_TOKENS = 8192;

/** Health checks must be snappy: a gateway that can't answer in 4s is not usable. */
const HEALTH_TIMEOUT_MS = 4000;

/** A serve probe is a real completion, so it gets longer — but not a turn's worth. */
const PROBE_TIMEOUT_MS = 30_000;

/** Attempts per completion, including the first. See the note on #post(). */
const POST_RETRIES = 3;

/**
 * Is this failure worth another attempt?
 *
 * 429 and 5xx are the ordinary "busy, try again" cases. The third clause is
 * gateway-specific: OmniRoute annotates its error bodies with
 * `"recovery":{"action":"retry"}` when the pool member failed rather than the
 * request, which is the only way to tell a genuine 401 (bad key — retrying
 * forever) from a pool member's 401 (wrong backend picked — retrying works).
 */
function retryable(status, bodyText = "") {
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /"action"\s*:\s*"retry"/.test(bodyText);
}

/**
 * The one line of an OmniRoute error body a person needs.
 *
 * The raw body is a kilobyte of routing diagnostics — pool size, exclusions,
 * attempt order, recovery hints — printed mid-conversation as `⚠ Gateway HTTP
 * 403: {"error":{"message":…`, truncated before it says anything useful. The
 * `error.message` field alone already names the provider's reason and the
 * member that failed. Falls back to the raw text for a non-JSON body.
 */
export function summarizeGatewayError(text = "") {
  try {
    const msg = JSON.parse(text)?.error?.message;
    if (typeof msg === "string" && msg) return msg.replace(/^\[\d{3}\]:\s*/, "").slice(0, 300);
  } catch { /* not JSON — a proxy page or a bare string */ }
  return String(text).slice(0, 300);
}

export class GatewayProvider extends BaseProvider {
  name = "gateway";

  #baseUrl;
  #apiKey;
  #model;
  #timeoutMs;

  constructor({ baseUrl, apiKey, model, timeoutMs = 300_000 } = {}) {
    super();
    this.#baseUrl = (baseUrl ?? process.env.OMNIROUTE_URL ?? DEFAULT_GATEWAY_URL).replace(/\/$/, "");
    // Optional by design. OmniRoute serves loopback without auth, and sending
    // `Bearer undefined` is worse than sending nothing — some upstreams reject
    // a malformed key with a 401 that reads like a configuration problem.
    this.#apiKey = apiKey ?? process.env.OMNIROUTE_API_KEY;
    this.#model = model ?? process.env.OMNIROUTE_MODEL;
    this.#timeoutMs = timeoutMs;
  }

  get isConfigured() {
    return typeof this.#baseUrl === "string" && this.#baseUrl.length > 0;
  }

  get baseUrl() { return this.#baseUrl; }
  get model() { return this.#model; }

  /**
   * Is anything listening, and what can it serve? Never throws — callers use
   * this to decide whether to use the gateway at all, and an exception there
   * would just become a try/catch at every call site.
   */
  async health() {
    try {
      const res = await this.#fetch(`${this.#baseUrl}/models`, {}, HEALTH_TIMEOUT_MS);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      const models = (data?.data ?? []).map((m) => m?.id).filter(Boolean);
      return { ok: true, models };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Can this gateway actually answer with `model`? One real, tiny completion.
   *
   * health() only proves something is listening, and on OmniRoute that proves
   * very little: on 2026-10-07 `/v1/models` listed 115 ids while every member
   * of every `auto/*` pool was refusing requests — OpenCode had locked its free
   * tier to its own client, and that keyless connection was the only one
   * configured. A gateway that is up but serves nothing is worse than none: each
   * turn spends ~5s and three retries before failing. Only a call tells them apart.
   *
   * One attempt, no retries — a pool that cannot answer the first time at
   * startup is not the brain to start a conversation on. Never throws.
   *
   * @returns {Promise<{ok: boolean, ms: number, error?: string}>}
   */
  async serves(model = this.#model, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const started = Date.now();
    try {
      const res = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: this.#headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with: ok" }],
          // Not tiny: a reasoning backend spends its budget thinking first,
          // and a "length" finish with null content is still a served request.
          max_tokens: 256,
          stream: false,
        }),
      }, timeoutMs);
      const ms = Date.now() - started;
      if (res.ok) return { ok: true, ms };
      const text = await res.text().catch(() => "");
      return { ok: false, ms, error: `HTTP ${res.status}: ${summarizeGatewayError(text)}` };
    } catch (err) {
      return { ok: false, ms: Date.now() - started, error: err.message };
    }
  }

  /**
   * One non-streaming turn, with optional tool calling. Returns the raw
   * assistant message so the caller can inspect `tool_calls` itself.
   */
  async chat(messages, { tools, maxTokens = DEFAULT_MAX_TOKENS, model } = {}) {
    const body = {
      model: model ?? this.#model,
      messages,
      max_tokens: maxTokens,
      stream: false, // explicit, not defaulted — see note 1 in the file header
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await this.#post(body);
    const data = await res.json();
    const message = data?.choices?.[0]?.message;
    if (!message) return { content: "", usage: data?.usage };

    return {
      // Normalised to a string so callers never have to null-check it, while
      // tool_calls stays untouched — a null content WITH tool calls is the
      // normal shape of a delegating turn, not an error.
      content: typeof message.content === "string" ? message.content : "",
      tool_calls: message.tool_calls,
      // Kept rather than dropped: the orchestrator shows it under /verbose, and
      // it is the only clue when a model burns its budget thinking.
      reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
      finishReason: data?.choices?.[0]?.finish_reason,
      usage: data?.usage,
    };
  }

  /** Streaming text, for the plain-chat path where there is nothing to delegate. */
  async *query(prompt, { history = [], model } = {}) {
    const messages = [...history, { role: "user", content: prompt }];
    const res = await this.#post({
      model: model ?? this.#model,
      messages,
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: true,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      // The last element is whatever arrived mid-line; it goes back in the
      // buffer. Dropping it loses a token every time a chunk lands on a
      // boundary, which is often enough to corrupt roughly every long reply.
      buffer = lines.pop() ?? "";

      for (const raw of lines) {
        const line = raw.replace(/\r$/, "").trim();
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") return;
        try {
          const chunk = JSON.parse(payload);
          const text = chunk?.choices?.[0]?.delta?.content;
          if (text) yield { type: "assistant_text", text };
        } catch {
          // Keepalive comments and split frames land here; skipping is correct.
        }
      }
    }
  }

  #headers(extra = {}) {
    const headers = { ...extra };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
    return headers;
  }

  /**
   * POST to /chat/completions, retrying the failures that are worth retrying.
   *
   * A gateway fails differently from a single endpoint. `auto/*` is a POOL, and
   * a request can die because the one member it happened to pick is broken
   * while five healthy ones sit behind it — observed live: `auto/smart` 401'd
   * with "Model north-mini-code-free is not supported" and the identical
   * request succeeded seconds later on a different backend. Treating that 401
   * as terminal (which it would be against a normal endpoint) makes the
   * orchestrator look broken perhaps one turn in five.
   *
   * OmniRoute says so itself: the error body carries a `recovery.action` field,
   * and "retry" means exactly that. Honour it, and fall back to the usual
   * status-code rules when it is absent.
   */
  async #post(body) {
    const url = `${this.#baseUrl}/chat/completions`;
    const init = {
      method: "POST",
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    };

    for (let attempt = 1; ; attempt++) {
      const res = await this.#fetch(url, init, this.#timeoutMs);
      if (res.ok) return res;

      const text = await res.text().catch(() => "");
      const last = attempt >= POST_RETRIES;

      if (!last && retryable(res.status, text)) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
        continue;
      }

      if (res.status === 429) {
        throw new RateLimitError(`Gateway rate limit (HTTP 429): ${summarizeGatewayError(text)}`);
      }
      throw new ProviderError(`Gateway HTTP ${res.status}: ${summarizeGatewayError(text)}`, { code: res.status });
    }
  }

  /**
   * fetch with a timeout. A fresh AbortController per call, always — an
   * aborted controller stays aborted, so a shared one would make every
   * subsequent request fail instantly with the first one's timeout.
   */
  async #fetch(url, init, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err.name === "AbortError") {
        throw new ProviderError(`Gateway timed out after ${Math.round(ms / 1000)}s.`, { code: "TIMEOUT" });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Model ids the gateway can serve right now. Empty array on any failure. */
export async function listModels(baseUrl, apiKey) {
  const provider = new GatewayProvider({ baseUrl, apiKey });
  const { models } = await provider.health();
  return models ?? [];
}

/**
 * Is an OmniRoute-shaped gateway reachable? Used at startup to choose between
 * the gateway and the NIM roster without making the user configure anything.
 */
export async function gatewayAvailable(baseUrl = process.env.OMNIROUTE_URL ?? DEFAULT_GATEWAY_URL) {
  const { ok } = await new GatewayProvider({ baseUrl }).health();
  return ok;
}

/**
 * Where is the `omniroute` executable, if anywhere?
 *
 * Deliberately a PATH lookup rather than a guess at the global npm prefix:
 * the prefix differs per platform and per install method, and a wrong guess
 * would be indistinguishable from "not installed". Returns null when absent,
 * which is the normal case on the portable drive — OmniRoute is an 830MB
 * global install that does not ship there.
 */
export function findGatewayBinary() {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(probe, ["omniroute"], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) return null;
    const first = (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Make sure a gateway is answering, starting one if it is installed and idle.
 *
 * This exists because the gateway being *installed* and the gateway *running*
 * are different things, and only the second one matters. OmniRoute is a
 * long-running server with no service registration: after a reboot nothing
 * starts it, so Claudbot would silently fall back to the NIM roster and the
 * user would just notice that their assistant had got worse, with no
 * indication that the good model was one command away.
 *
 * Never throws and never blocks forever — every outcome is a status the caller
 * can print and carry on from.
 *
 * @returns {Promise<{ok: boolean, started: boolean, models?: string[], reason?: string}>}
 */
export async function ensureGateway({
  baseUrl = process.env.OMNIROUTE_URL ?? DEFAULT_GATEWAY_URL,
  timeoutMs = GATEWAY_BOOT_TIMEOUT_MS,
  onProgress,
} = {}) {
  const provider = new GatewayProvider({ baseUrl });

  const first = await provider.health();
  if (first.ok) return { ok: true, started: false, models: first.models };

  // Opt out entirely: some hosts want the gateway managed elsewhere, and a
  // background daemon should never spawn an 830MB server behind the user's back.
  if (process.env.CLAUDBOT_GATEWAY_AUTOSTART === "0") {
    return { ok: false, started: false, reason: "autostart disabled (CLAUDBOT_GATEWAY_AUTOSTART=0)" };
  }

  // Only ever start something listening on this machine. A remote gateway is
  // someone else's to run, and spawning a local server would not fix it anyway.
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(baseUrl)) {
    return { ok: false, started: false, reason: `no gateway at ${baseUrl} (remote — not starting one)` };
  }

  const bin = findGatewayBinary();
  if (!bin) return { ok: false, started: false, reason: "omniroute is not installed" };

  onProgress?.("starting gateway");

  // Detached and fully unhooked: the gateway has to outlive this process, or
  // every `claudbot` would pay the cold-start cost again. `shell: true` because
  // the PATH entry on Windows is a .cmd shim, which CreateProcess cannot exec.
  //
  // `serve --no-open --no-tray`, never the bare command: bare `omniroute` opens
  // the dashboard in a browser on boot, which is a background launcher taking
  // over the desktop a minute after the user stopped looking at it.
  try {
    const child = spawn(bin, ["serve", "--no-open", "--no-tray"], {
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, started: false, reason: `could not start omniroute: ${err.message}` };
  }

  // Poll rather than trust a fixed sleep: boot time varies with how many
  // providers it probes, and the port opens long before the server answers.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, GATEWAY_POLL_MS));
    const h = await provider.health();
    if (h.ok) return { ok: true, started: true, models: h.models };
    onProgress?.("waiting for gateway");
  }

  return {
    ok: false,
    started: true,
    reason: `gateway did not answer within ${Math.round(timeoutMs / 1000)}s of starting`,
  };
}
