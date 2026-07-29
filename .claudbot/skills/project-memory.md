---
name: project-memory
description: How the main chat and per-project chats differ, and how to load a project's memory on demand
---

# Chats and memory

There are two kinds of chat and they behave differently on purpose.

**Main chat** (`claudbot` bare) — one global scratchpad with **no memory**. Clean
slate every time. It does not load project context or past transcripts. Quick
questions live here. Don't go hunting through old sessions to "remember"
something in this chat; there is deliberately nothing to remember.

**Project chat** (`claudbot project <repo>`) — scoped to one repo and persistent.
It runs with that repo as cwd and carries a rolling memory of every past session
there. Leaving and coming back resumes.

## "Let's go into repo X"

When the user says that mid-conversation, you cannot change your own process's
working directory or system prompt. Do this instead:

```
node project-memory.mjs show X
```

That prints the project's compact memory block. Read it, acknowledge what you now
know about the project, and carry on in the current chat. Then mention that
`claudbot project X` opens a dedicated chat for it that will keep the memory
going forward.

If the project isn't found, ask for the path once — `resolveProject` accepts an
absolute path, a relative path, or a bare name it can match against known
projects and their sibling directories.

## How the memory works — do not work around it

The whole design is **remember without re-reading everything**:

- Claude Code already writes a JSONL transcript per session per cwd. Those are
  the source; nothing extra is captured.
- Each session is summarized **once** by the `fast` NIM agent and cached in
  `.claudbot/conversation-index.json`.
- Summaries are merged into one compact file per project:
  `.claudbot/projects/<slug>/memory.md` — Facts, Decisions, Open threads, Recent.
- Only that file is loaded at session start. It is capped at a few thousand
  characters on purpose.
- Refresh is incremental: sessions older than the last merge are never looked at
  again.

So: **never try to rebuild project memory by reading past transcripts yourself.**
It is slow, it burns plan usage on work NIM already did, and it produces a worse
result than the merged file. If the memory looks stale, run the refresh:

```
node project-memory.mjs refresh <project>
```

## Long-term notes

The Obsidian vault is the durable layer. A project chat for repo X automatically
points at `C:\Repo\MyBrain\Projects\X.md` when it exists. Read that file when you
need detail the rolling memory doesn't cover, and update it at the end of a
session — see `skills/memory.md`.

Rolling memory is for resuming work. The vault is for what you'd want a year
from now.

## Commands

| | |
|---|---|
| `claudbot` | main chat, no memory |
| `claudbot project` | pick from known project chats |
| `claudbot project <path or name>` | open that project's chat |
| `claudbot project list` | list every project chat |
| `node project-memory.mjs show <p>` | print a project's memory block |
| `node project-memory.mjs refresh <p>` | fold in new sessions now |
