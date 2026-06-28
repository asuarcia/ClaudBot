import { BaseProvider, RateLimitError, ProviderError } from "./base.mjs";

/**
 * NVIDIA NIM endpoint provider — OpenAI-compatible HTTP inference.
 *
 * Configure via env vars or the agents.yaml registry:
 *   NIM_BASE_URL   — endpoint URL (e.g. https://integrate.api.nvidia.com/v1)
 *   NIM_API_KEY    — API key
 *   NIM_MODEL      — model name (e.g. meta/llama-3.1-70b-instruct)
 */
export class NimProvider extends BaseProvider {
  name = "NVIDIA NIM";

  #baseUrl;
  #apiKey;
  #model;

  constructor({
    baseUrl = process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey = process.env.NIM_API_KEY,
    model = process.env.NIM_MODEL ?? "meta/llama-3.1-70b-instruct",
  } = {}) {
    super();
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#apiKey = apiKey;
    this.#model = model;
  }

  get isConfigured() {
    return Boolean(this.#apiKey);
  }

  /**
   * Non-streaming chat that supports OpenAI-style tool calling. Returns the raw
   * assistant message ({ content, tool_calls }). Used by the fallback REPL so it
   * can delegate to sub-agents; gracefully usable without tools too.
   */
  async chat(messages, { tools } = {}) {
    if (!this.#apiKey) {
      throw new ProviderError("NIM_API_KEY not set.", { code: "NO_API_KEY" });
    }
    const body = { model: this.#model, messages, max_tokens: 4096 };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (response.status === 429) throw new RateLimitError("NIM rate limit (HTTP 429)");
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderError(`NIM HTTP ${response.status}: ${text}`, { code: response.status });
    }
    const data = await response.json();
    return data?.choices?.[0]?.message ?? { content: "" };
  }

  async *query(prompt, { history = [] } = {}) {
    if (!this.#apiKey) {
      throw new ProviderError(
        "NIM_API_KEY not set. Configure it to enable NIM fallback.",
        { code: "NO_API_KEY" }
      );
    }

    const messages = [
      ...history,
      { role: "user", content: prompt },
    ];

    const response = await fetch(`${this.#baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.#model,
        messages,
        stream: true,
        max_tokens: 4096,
      }),
    });

    if (response.status === 429) {
      throw new RateLimitError(`NIM rate limit (HTTP 429)`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ProviderError(`NIM HTTP ${response.status}: ${body}`, {
        code: response.status,
      });
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") return;

        try {
          const chunk = JSON.parse(data);
          const text = chunk.choices?.[0]?.delta?.content;
          if (text) yield { type: "assistant_text", text };
        } catch {
          // malformed chunk — skip
        }
      }
    }
  }
}
