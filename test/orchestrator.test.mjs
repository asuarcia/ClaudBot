/**
 * Orchestrator + gateway tests.
 *
 * These run against a stub HTTP server rather than a live gateway, on purpose:
 * the behaviours worth pinning down here are the ones a real gateway only
 * exhibits occasionally (a pool member failing, a reasoning model returning
 * null content), and a test that depends on catching those in the wild is not
 * a test. Each one encodes a bug that was actually hit against OmniRoute
 * 3.8.49 — see docs/orchestrator.md.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";

import { GatewayProvider, listModels } from "../providers/gateway.mjs";
import { RateLimitError, ProviderError } from "../providers/base.mjs";

/** Spin up a throwaway gateway. `handler(req, body)` returns { status, json }. */
async function stubGateway(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ url: req.url, body, auth: req.headers.authorization });
      const { status = 200, json, text } = handler(req, body, seen.length) ?? {};
      res.writeHead(status, { "Content-Type": text ? "text/plain" : "application/json" });
      res.end(text ?? JSON.stringify(json ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/v1`;
  return { url, seen, close: () => new Promise((r) => server.close(r)) };
}

const message = (m) => ({ choices: [{ message: m, finish_reason: "stop" }] });

test("chat() sends stream:false explicitly", async (t) => {
  // Omitting the field is not the same as false: OmniRoute streams SSE by
  // default, so a client that leaves it out gets `data:` lines, not a body.
  const gw = await stubGateway(() => ({ json: message({ content: "ok" }) }));
  t.after(() => gw.close());

  const p = new GatewayProvider({ baseUrl: gw.url, model: "m" });
  await p.chat([{ role: "user", content: "hi" }]);

  assert.equal(gw.seen[0].body.stream, false);
  assert.ok("stream" in gw.seen[0].body, "stream must be present, not merely falsy by absence");
});

test("null content from a reasoning model becomes a string, and the trace survives", async (t) => {
  const gw = await stubGateway(() => ({
    json: { choices: [{ message: { content: null, reasoning_content: "thinking out loud" }, finish_reason: "length" }] },
  }));
  t.after(() => gw.close());

  const r = await new GatewayProvider({ baseUrl: gw.url, model: "m" }).chat([]);
  assert.equal(r.content, "");
  assert.equal(r.reasoning, "thinking out loud");
  assert.equal(r.finishReason, "length");
});

test("tool_calls pass through untouched alongside null content", async (t) => {
  // A delegating turn is normally content:null WITH tool_calls. Treating that
  // as an empty answer would silently drop every delegation.
  const calls = [{ id: "c1", type: "function", function: { name: "run_agent", arguments: "{}" } }];
  const gw = await stubGateway(() => ({ json: { choices: [{ message: { content: null, tool_calls: calls } }] } }));
  t.after(() => gw.close());

  const r = await new GatewayProvider({ baseUrl: gw.url, model: "m" }).chat([]);
  assert.equal(r.content, "");
  assert.deepEqual(r.tool_calls, calls);
});

test("a pool member's 401 is retried when the body says recovery:retry", async (t) => {
  // Observed live: auto/smart 401'd on one broken backend while five healthy
  // ones sat behind it. A normal client calls 401 terminal and looks broken.
  const gw = await stubGateway((req, body, n) => {
    if (n === 1) {
      return {
        status: 401,
        json: { error: { message: "Model north-mini-code-free is not supported" },
                diagnostics: { recovery: { action: "retry" } } },
      };
    }
    return { json: message({ content: "second time lucky" }) };
  });
  t.after(() => gw.close());

  const r = await new GatewayProvider({ baseUrl: gw.url, model: "m" }).chat([]);
  assert.equal(r.content, "second time lucky");
  assert.equal(gw.seen.length, 2);
});

test("a genuine 401 with no retry marker fails immediately", async (t) => {
  const gw = await stubGateway(() => ({ status: 401, json: { error: { message: "invalid key" } } }));
  t.after(() => gw.close());

  const p = new GatewayProvider({ baseUrl: gw.url, model: "m" });
  await assert.rejects(() => p.chat([]), (e) => e instanceof ProviderError && e.code === 401);
  assert.equal(gw.seen.length, 1, "a bad key must not be retried");
});

test("429 raises RateLimitError after exhausting retries", async (t) => {
  const gw = await stubGateway(() => ({ status: 429, json: { error: "slow down" } }));
  t.after(() => gw.close());

  const p = new GatewayProvider({ baseUrl: gw.url, model: "m" });
  await assert.rejects(() => p.chat([]), (e) => e instanceof RateLimitError);
  assert.equal(gw.seen.length, 3, "429 is retried up to the attempt cap");
});

test("no Authorization header when there is no key", async (t) => {
  // Loopback OmniRoute needs no key, and "Bearer undefined" reads as a bad key.
  const gw = await stubGateway(() => ({ json: message({ content: "ok" }) }));
  t.after(() => gw.close());

  await new GatewayProvider({ baseUrl: gw.url, apiKey: undefined, model: "m" }).chat([]);
  assert.equal(gw.seen[0].auth, undefined);
});

test("a key, when present, is sent as a bearer token", async (t) => {
  const gw = await stubGateway(() => ({ json: message({ content: "ok" }) }));
  t.after(() => gw.close());

  await new GatewayProvider({ baseUrl: gw.url, apiKey: "sk-test", model: "m" }).chat([]);
  assert.equal(gw.seen[0].auth, "Bearer sk-test");
});

test("health() reports models and never throws on a dead gateway", async () => {
  const dead = new GatewayProvider({ baseUrl: "http://127.0.0.1:1/v1" });
  const r = await dead.health();
  assert.equal(r.ok, false);
  assert.ok(r.error, "a failure must explain itself");
  assert.deepEqual(await listModels("http://127.0.0.1:1/v1"), []);
});

test("health() extracts model ids", async (t) => {
  const gw = await stubGateway(() => ({ json: { data: [{ id: "auto/smart" }, { id: "auto/cheap" }, {}] } }));
  t.after(() => gw.close());

  const r = await new GatewayProvider({ baseUrl: gw.url }).health();
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["auto/smart", "auto/cheap"]);
});

test("SSE frames split across chunk boundaries are not lost", async (t) => {
  // The buffer must retain the trailing partial line. Dropping it loses a token
  // whenever a chunk lands mid-frame, which corrupts most long replies.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"Hel');   // split mid-JSON
    res.write('lo "}}]}\n\ndata: {"choices":[{"delta":{"content":"wor');
    res.write('ld"}}]}\n\ndata: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));

  const p = new GatewayProvider({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "m" });
  let out = "";
  for await (const ev of p.query("hi")) out += ev.text;
  assert.equal(out, "Hello world");
});

test("trailing slash on the base URL does not double up", async (t) => {
  const gw = await stubGateway(() => ({ json: message({ content: "ok" }) }));
  t.after(() => gw.close());

  await new GatewayProvider({ baseUrl: `${gw.url}/`, model: "m" }).chat([]);
  assert.equal(gw.seen[0].url, "/v1/chat/completions");
});

/* ── run_agent against a gateway endpoint ───────────────────────────────────
 *
 * The roster can now hold keyless gateway agents alongside the NIM ones, which
 * put runAgent on a code path it never had to handle: OmniRoute's defaults are
 * not a plain endpoint's defaults. These pin the four differences. Every one
 * of them was a live failure first — a gateway agent added to agents.yaml
 * before this simply threw on the SSE it got back.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** A one-agent registry pointing at `endpoint`, installed via the env override. */
function stubRegistry(t, endpoint, extra = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "claudbot-agents-"));
  const file = path.join(dir, "agents.yaml");
  writeFileSync(file, JSON.stringify({
    agents: [{ name: "stub", model: "m", endpoint, apiKeyEnv: null, jobDescription: "stub", ...extra }],
  })); // YAML is a superset of JSON, so this parses as-is
  const prev = process.env.CLAUDBOT_AGENTS_FILE;
  process.env.CLAUDBOT_AGENTS_FILE = file;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDBOT_AGENTS_FILE;
    else process.env.CLAUDBOT_AGENTS_FILE = prev;
  });
}

test("runAgent sends stream:false — a gateway streams SSE without it", async (t) => {
  const gw = await stubGateway(() => ({ json: message({ content: "hi" }) }));
  t.after(() => gw.close());
  stubRegistry(t, gw.url);

  const { runAgent } = await import("../providers/agents.mjs");
  await runAgent("stub", "hello");
  assert.equal(gw.seen[0].body.stream, false);
});

test("runAgent sends no Authorization header for a keyless agent", async (t) => {
  // `Bearer none` was worse than nothing: some upstreams reject a malformed
  // key with a 401 that reads like a configuration problem.
  const gw = await stubGateway(() => ({ json: message({ content: "hi" }) }));
  t.after(() => gw.close());
  stubRegistry(t, gw.url);

  const { runAgent } = await import("../providers/agents.mjs");
  await runAgent("stub", "hello");
  assert.equal(gw.seen[0].auth, undefined);
});

test("runAgent retries a pool member's 401 when the body says recovery:retry", async (t) => {
  const gw = await stubGateway((_req, _body, n) =>
    n === 1
      ? { status: 401, json: { error: { message: "Model x is not supported" }, recovery: { action: "retry" } } }
      : { json: message({ content: "second time lucky" }) });
  t.after(() => gw.close());
  stubRegistry(t, gw.url);

  const { runAgent } = await import("../providers/agents.mjs");
  assert.equal(await runAgent("stub", "hi"), "second time lucky");
  assert.equal(gw.seen.length, 2);
});

test("runAgent still fails fast on a genuine 401", async (t) => {
  const gw = await stubGateway(() => ({ status: 401, json: { error: { message: "bad key" } } }));
  t.after(() => gw.close());
  stubRegistry(t, gw.url);

  const { runAgent } = await import("../providers/agents.mjs");
  await assert.rejects(() => runAgent("stub", "hi"), /HTTP 401/);
  assert.equal(gw.seen.length, 1, "a terminal 401 must not be retried");
});

test("runAgent falls back to reasoning_content when content is null", async (t) => {
  // A reasoning model that spends its whole budget thinking returns exactly
  // this shape. Reporting it as "empty response" throws away the only output.
  const gw = await stubGateway(() => ({
    json: { choices: [{ message: { content: null, reasoning_content: "the trace" }, finish_reason: "length" }] },
  }));
  t.after(() => gw.close());
  stubRegistry(t, gw.url);

  const { runAgent } = await import("../providers/agents.mjs");
  assert.equal(await runAgent("stub", "hi"), "the trace");
});

test("runAgent names the finish reason when there is genuinely nothing", async (t) => {
  const gw = await stubGateway(() => ({
    json: { choices: [{ message: { content: null }, finish_reason: "length" }] },
  }));
  t.after(() => gw.close());
  stubRegistry(t, gw.url);

  const { runAgent } = await import("../providers/agents.mjs");
  await assert.rejects(() => runAgent("stub", "hi"), /finish_reason: length.*maxTokens/s);
});
