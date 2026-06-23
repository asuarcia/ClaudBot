---
name: memory
description: When and how to read and write Claudbot's Obsidian memory in MyBrain
---

# Memory Protocol

Claudbot's long-term memory lives in the Obsidian vault at `C:\Repo\MyBrain`. Use the `obsidian-brain` MCP tools to read and write.

## Before any non-trivial task

Search for relevant prior context:
```
obsidian-brain:search-vault(query="<keywords from user request>")
```

If you find a matching note, read it and factor it in before responding.

## After completing a task

Save the result if it:
- Contains research, analysis, or code the user may want later
- Reveals a user preference or fact worth remembering
- Produced an agent output that could be reused

### Where to save

| Type | Vault path |
|------|-----------|
| Session summaries | `Claudbot/sessions/YYYY-MM-DD-<topic>.md` |
| Sub-agent outputs | `Claudbot/agent-outputs/<agent-name>/<topic>.md` |
| User preferences / facts | `Claudbot/context/user-context.md` |

### Note format

```markdown
---
date: YYYY-MM-DD
tags: [claudbot, <agent-used-if-any>]
---

<content>
```

## Do not save

- Transient scratchpad work
- Things already in CLAUDE.md or skills/
- Duplicate notes — search first, update existing notes instead of creating new ones
