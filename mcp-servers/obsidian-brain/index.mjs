#!/usr/bin/env node
/**
 * obsidian-brain MCP server
 *
 * A self-contained replacement for the abandoned `mcp-obsidian` npm package,
 * which shipped an unpinned `zod` dependency. npm resolved zod v4, but its
 * `zod-to-json-schema@3` only understands zod v3 internals, so it silently
 * emitted an empty inputSchema (no `type: "object"`) and Claude Code rejected
 * the tool list. This server hand-writes plain JSON Schema instead, so there
 * is no zod/zod-to-json-schema version coupling to break.
 *
 * Tools (drop-in compatible with the original):
 *   read_notes    — read the contents of one or more notes by relative path
 *   search_notes  — find notes by name (case-insensitive, regex-aware)
 *
 * Usage: node index.mjs <vault-directory>
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const SEARCH_LIMIT = 200;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: obsidian-brain <vault-directory>");
  process.exit(1);
}

function normalizePath(p) {
  return path.normalize(p).toLowerCase();
}

function expandHome(filepath) {
  if (filepath.startsWith("~/") || filepath === "~") {
    return path.join(os.homedir(), filepath.slice(1));
  }
  return filepath;
}

const vaultDirectories = [normalizePath(path.resolve(expandHome(args[0])))];

// True only when `candidate` (already normalized) is the vault itself or a real
// descendant of it. A plain `startsWith(dir)` would wrongly allow a sibling like
// `<vault>-secrets`, so we require an exact match or a separator boundary.
function isInsideVault(candidate) {
  return vaultDirectories.some((dir) => {
    const withSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return candidate === dir || candidate.startsWith(withSep);
  });
}

// Validate the vault exists before we accept any requests.
await Promise.all(
  args.map(async (dir) => {
    try {
      const stats = await fs.stat(dir);
      if (!stats.isDirectory()) {
        console.error(`Error: ${dir} is not a directory`);
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error accessing directory ${dir}:`, error);
      process.exit(1);
    }
  })
);

// Resolve a requested path and confirm it stays inside the vault.
async function validatePath(requestedPath) {
  // Split on both separators: path.sep is only "\" on Windows, but Node also
  // accepts "/" there, so "Areas/.secret" must still be caught.
  const pathParts = requestedPath.split(/[\\/]/);
  if (pathParts.some((part) => part.startsWith("."))) {
    throw new Error("Access denied - hidden files/directories not allowed");
  }
  const expandedPath = expandHome(requestedPath);
  const absolute = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(process.cwd(), expandedPath);
  const normalizedRequested = normalizePath(absolute);
  if (!isInsideVault(normalizedRequested)) {
    throw new Error(
      `Access denied - path outside allowed directories: ${absolute} not in ${vaultDirectories.join(", ")}`
    );
  }
  try {
    const realPath = await fs.realpath(absolute);
    const normalizedReal = normalizePath(realPath);
    if (!isInsideVault(normalizedReal)) {
      throw new Error(
        "Access denied - symlink target outside allowed directories"
      );
    }
    return realPath;
  } catch {
    // New file that doesn't exist yet: validate its parent directory instead.
    const parentDir = path.dirname(absolute);
    try {
      const realParentPath = await fs.realpath(parentDir);
      const normalizedParent = normalizePath(realParentPath);
      const isParentAllowed = isInsideVault(normalizedParent);
      if (!isParentAllowed) {
        throw new Error(
          "Access denied - parent directory outside allowed directories"
        );
      }
      return absolute;
    } catch {
      throw new Error(`Parent directory does not exist: ${parentDir}`);
    }
  }
}

async function searchNotes(query) {
  const results = [];
  async function search(basePath, currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      try {
        await validatePath(fullPath);
        let matches = entry.name.toLowerCase().includes(query.toLowerCase());
        try {
          matches =
            matches ||
            new RegExp(query.replace(/[*]/g, ".*"), "i").test(entry.name);
        } catch {
          // Ignore invalid regex.
        }
        if (entry.name.endsWith(".md") && matches) {
          results.push(fullPath.replace(basePath, ""));
        }
        if (entry.isDirectory()) {
          await search(basePath, fullPath);
        }
      } catch {
        continue;
      }
    }
  }
  await Promise.all(vaultDirectories.map((dir) => search(dir, dir)));
  return results;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new Server(
  { name: "obsidian-brain", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "read_notes",
      description:
        "Read the contents of multiple notes. Each note's content is returned " +
        "with its path as a reference. Failed reads for individual notes won't " +
        "stop the entire operation. Reading too many at once may result in an error.",
      inputSchema: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description:
              "Vault-relative paths of the notes to read (e.g. 'Projects/foo.md').",
          },
        },
        required: ["paths"],
      },
    },
    {
      name: "search_notes",
      description:
        "Searches for a note by its name. The search is case-insensitive and " +
        "matches partial names. Queries can also be a valid regex. Returns paths " +
        "of the notes that match the query.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Note name fragment or regex to match against.",
          },
        },
        required: ["query"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: toolArgs } = request.params;
    switch (name) {
      case "read_notes": {
        const paths = toolArgs?.paths;
        if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
          throw new Error("Invalid arguments for read_notes: 'paths' must be an array of strings");
        }
        const results = await Promise.all(
          paths.map(async (filePath) => {
            try {
              const validPath = await validatePath(
                path.join(vaultDirectories[0], filePath)
              );
              const content = await fs.readFile(validPath, "utf-8");
              return `${filePath}:\n${content}\n`;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              return `${filePath}: Error - ${errorMessage}`;
            }
          })
        );
        return { content: [{ type: "text", text: results.join("\n---\n") }] };
      }
      case "search_notes": {
        const query = toolArgs?.query;
        if (typeof query !== "string") {
          throw new Error("Invalid arguments for search_notes: 'query' must be a string");
        }
        const results = await searchNotes(query);
        const limitedResults = results.slice(0, SEARCH_LIMIT);
        return {
          content: [
            {
              type: "text",
              text:
                (limitedResults.length > 0
                  ? limitedResults.join("\n")
                  : "No matches found") +
                (results.length > SEARCH_LIMIT
                  ? `\n\n... ${results.length - SEARCH_LIMIT} more results not shown.`
                  : ""),
            },
          ],
        };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("obsidian-brain MCP server running on stdio");
console.error("Vault:", vaultDirectories);
