/**
 * Briefing collectors — pull AI/ML/dev news from free, no-auth sources.
 *
 * Each collector is independent and resilient: on any failure it logs a warning
 * and returns []. Every item is normalized to:
 *   { id, title, url, source, author, publishedAt, points, comments, raw }
 *
 * No external dependencies — Node's global fetch + lightweight XML parsing.
 */

const UA = "claudbot-briefing/0.1 (+https://github.com/asuarcia/ClaudBot)";

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function warn(source, err) {
  console.warn(`[briefing] collector "${source}" failed: ${err.message}`);
  return [];
}

// Strip tags + decode the handful of entities that show up in feeds/titles.
function clean(text = "") {
  return text
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

// ─── Hacker News (Algolia API) ───────────────────────────────────────────────

export async function collectHackerNews(cfg = {}) {
  if (cfg.enabled === false) return [];
  const minPoints = cfg.minPoints ?? 80;
  const tags = cfg.tags ?? "story";
  try {
    // The Algolia HN index no longer allows numericFilters on `points`, so we
    // pull the front page and filter by score client-side.
    const data = await getJSON(
      `https://hn.algolia.com/api/v1/search?tags=${encodeURIComponent(tags)}&hitsPerPage=80`,
    );
    return (data.hits ?? [])
      .filter((h) => h.title && (h.url || h.objectID) && (h.points ?? 0) >= minPoints)
      .map((h) => ({
        id: `hn:${h.objectID}`,
        title: clean(h.title),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        source: "Hacker News",
        author: h.author ?? null,
        publishedAt: h.created_at ?? null,
        points: h.points ?? 0,
        comments: h.num_comments ?? 0,
        raw: clean(h.story_text || ""),
      }));
  } catch (err) { return warn("hackernews", err); }
}

// ─── arXiv (Atom API) ────────────────────────────────────────────────────────

export async function collectArxiv(cfg = {}) {
  if (cfg.enabled === false) return [];
  const cats = cfg.categories ?? ["cs.AI", "cs.LG", "cs.CL"];
  const max = cfg.maxPerCategory ?? 8;
  const items = [];
  for (const cat of cats) {
    try {
      const xml = await getText(
        `http://export.arxiv.org/api/query?search_query=cat:${cat}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`,
      );
      const entries = xml.split(/<entry>/).slice(1).map((e) => e.split(/<\/entry>/)[0]);
      for (const e of entries) {
        const id = tag(e, "id").trim();
        const title = clean(tag(e, "title"));
        if (!id || !title) continue;
        items.push({
          id: `arxiv:${id}`,
          title,
          url: id,
          source: `arXiv ${cat}`,
          author: clean(tag(e, "name")) || null,
          publishedAt: tag(e, "published").trim() || null,
          points: 0,
          comments: 0,
          raw: clean(tag(e, "summary")).slice(0, 800),
        });
      }
    } catch (err) { warn(`arxiv:${cat}`, err); }
  }
  return items;
}

// ─── Reddit (public JSON) ────────────────────────────────────────────────────

export async function collectReddit(cfg = {}) {
  if (cfg.enabled === false) return [];
  const subs = cfg.subs ?? ["MachineLearning", "LocalLLaMA"];
  const window = cfg.window ?? "day";
  const minScore = cfg.minScore ?? 100;
  const items = [];
  for (const sub of subs) {
    try {
      const data = await getJSON(`https://www.reddit.com/r/${sub}/top.json?t=${window}&limit=25`);
      for (const c of data?.data?.children ?? []) {
        const p = c.data;
        if (!p || p.score < minScore || p.stickied) continue;
        items.push({
          id: `reddit:${p.id}`,
          title: clean(p.title),
          url: p.url_overridden_by_dest || `https://www.reddit.com${p.permalink}`,
          source: `r/${sub}`,
          author: p.author ?? null,
          publishedAt: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
          points: p.score ?? 0,
          comments: p.num_comments ?? 0,
          raw: clean(p.selftext || "").slice(0, 800),
        });
      }
    } catch (err) { warn(`reddit:${sub}`, err); }
  }
  return items;
}

// ─── Generic RSS / Atom ──────────────────────────────────────────────────────

function parseFeed(xml, name) {
  // Works for both RSS <item> and Atom <entry>.
  const chunks = xml.includes("<item")
    ? xml.split(/<item[\s>]/).slice(1).map((c) => c.split(/<\/item>/)[0])
    : xml.split(/<entry[\s>]/).slice(1).map((c) => c.split(/<\/entry>/)[0]);

  return chunks.map((c) => {
    const title = clean(tag(c, "title"));
    // Atom link is an attribute; RSS link is a text node.
    let url = clean(tag(c, "link"));
    if (!url) {
      const m = c.match(/<link[^>]*href="([^"]+)"/i);
      if (m) url = m[1];
    }
    const date = tag(c, "pubDate").trim() || tag(c, "published").trim() || tag(c, "updated").trim();
    return { title, url, date, summary: clean(tag(c, "description") || tag(c, "summary") || tag(c, "content")) };
  }).filter((x) => x.title && x.url);
}

export async function collectRSS(cfg = {}) {
  if (cfg.enabled === false) return [];
  const feeds = cfg.feeds ?? [];
  const items = [];
  for (const feed of feeds) {
    try {
      const xml = await getText(feed.url);
      for (const e of parseFeed(xml, feed.name).slice(0, 10)) {
        items.push({
          id: `rss:${feed.name}:${e.url}`,
          title: e.title,
          url: e.url,
          source: feed.name,
          author: null,
          publishedAt: e.date ? new Date(e.date).toISOString() : null,
          points: 0,
          comments: 0,
          raw: e.summary.slice(0, 800),
        });
      }
    } catch (err) { warn(`rss:${feed.name}`, err); }
  }
  return items;
}

// ─── orchestrator ────────────────────────────────────────────────────────────

export async function collectAll(sources = {}) {
  const results = await Promise.all([
    collectHackerNews(sources.hackernews),
    collectArxiv(sources.arxiv),
    collectReddit(sources.reddit),
    collectRSS(sources.rss),
  ]);
  return results.flat();
}
