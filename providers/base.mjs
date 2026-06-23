export class RateLimitError extends Error {
  constructor(message = "Rate limit or quota exceeded") {
    super(message);
    this.name = "RateLimitError";
  }
}

export class ProviderError extends Error {
  constructor(message, { code, stderr } = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.stderr = stderr;
  }
}

/**
 * Base class for all providers. Each provider wraps one inference backend.
 *
 * query() returns an async iterable of output chunks (strings) and
 * resolves via `return` with { sessionId } when done. To get the session ID,
 * use the yielded { type: "session_id", value } event or the final metadata.
 *
 * Callers should iterate with `for await (const event of provider.query(...))`.
 */
export class BaseProvider {
  /** Human-readable name shown in the UI */
  name = "base";

  /**
   * @param {string} prompt
   * @param {{ sessionId?: string, cwd?: string }} options
   * @returns {AsyncGenerator<{ type: string, [key: string]: any }>}
   */
  // eslint-disable-next-line no-unused-vars
  async *query(prompt, options = {}) {
    throw new Error(`${this.name}.query() not implemented`);
  }
}
