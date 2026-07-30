# Claudbot on a USB drive

Carry the whole assistant — code, runtime, credentials, the Obsidian vault and
every conversation transcript — on a stick, and run it on any machine without
installing anything or leaving anything behind.

This is deliberately *not* "clone the repo somewhere else". A fresh clone gives
you the code. This gives you the code **plus everything that makes it yours**.

## Build a drive

```
npm run make-portable -- --target E:\
```

Options:

| flag | effect |
|---|---|
| `--target <path>` | where to build. Required. `E:\`, `/Volumes/CLAUDBOT`, … |
| `--mode store\|veracrypt` | protection mode, default `store` |
| `--refresh` | update code + runtimes, leave the encrypted data alone |
| `--skip-runtimes` | don't download Node (~150 MB); host must supply it |
| `--include-voice` | include the shelved voice venv + models (+762 MB) |

You'll be asked for a passphrase twice. **It cannot be recovered.** There is no
backdoor, no recovery key, and no way to read the drive without it.

## Use it

| host | do this |
|---|---|
| Windows | double-click `Claudbot.cmd` |
| macOS | double-click `claudbot.command` |
| Linux | `./claudbot.sh` |

Enter the passphrase and Claudbot starts, with all of your history intact.

**Always exit normally** (menu → Exit, or Ctrl-C) so the drive re-encrypts. If
you yank it mid-session, plaintext stays on the stick until the next launch
notices and offers to recover or shred it.

## Syncing desktop ↔ drive

The drive and your desktop install are two real copies. Work in one and the
other goes stale. **Menu → 🔄 Sync drive**, or:

```
claudbot sync                 auto-detect the drive
claudbot sync --drive E:\     point at one explicitly
claudbot sync --yes           skip the confirmation
```

It unlocks the drive, shows you exactly what it plans to do, asks, applies, and
re-locks. Ctrl-C at any point still re-encrypts.

### Why a baseline, not "newest wins"

If a file differs between the two sides, the timestamps cannot tell you whether
*one* side changed or *both* did. Taking the newer one silently destroys the
other edit — and for a second brain that's the worst possible failure.

So each sync records a hash per file, and the next sync compares three ways:

| situation | what happens |
|---|---|
| changed on one side only | copied across |
| changed on both, same content | nothing |
| changed on both, different | **conflict — both kept** |
| present on one side only | copied across |

### Two rules that make data loss impossible

**Sync never deletes.** A file missing on one side is treated as new on the
other and copied back. Propagating deletions would mean one stray `rm` wipes
your vault from both places at once. If you want something gone, delete it in
both — that's the price of the guarantee.

**Conflicts never overwrite.** The newer version stays put and the older is
written beside it as `note.conflict-<host>-<date>.md`, on *both* sides. You
resolve it by reading both files, not by discovering a loss weeks later.

Transcripts (`*.jsonl`) are the exception: they're append-only, so the longer
file strictly contains the shorter one and is taken without a conflict.

`.env` is **reported but never synced automatically.** Silently overwriting API
keys is a worse failure than being told they differ.

Only Claudbot's own transcript directories are synced — your desktop
`~/.claude/projects` holds history for every repo you've ever opened, and none
of that belongs on the stick.

The baseline lives on the drive (`portable/sync-baseline.json`), because the
drive is the thing that travels and so is the only place that can hold a
baseline shared by every machine it visits.

## What's on the drive

```
E:\
  Claudbot.cmd  claudbot.sh  claudbot.command   launchers (plaintext)
  README-FIRST.txt                              instructions + "please return"
  runtime/win-x64  darwin-arm64  darwin-x64  linux-x64
  runtime/claude-code/                          the Claude Code CLI
  app/                                          Claudbot source
  portable/                                     boot, store, veracrypt, paths
  store.enc                                     ← everything personal
```

Encrypted inside `store.enc`:

- `.env` — NIM key, Proxmox token
- `vault/` — the MyBrain Obsidian vault
- `claude-home/` — Claude Code auth **and every transcript**

Measured on a real build:

| part | size |
|---|---|
| `runtime/claude-code` | 254 MB |
| `runtime/linux-x64` | 120 MB |
| `runtime/darwin-x64` | 111 MB |
| `runtime/darwin-arm64` | 108 MB |
| `runtime/win-x64` | 100 MB |
| `app/` | 75 MB (68 MB of it the three MCP servers' own SDK copies) |
| `store.enc` | 7.9 MB (from 32 MB of personal data) |
| **total** | **~775 MB** |

`--skip-runtimes` brings that down to ~85 MB if every machine you use already
has Node 22+ and Claude Code.

Only `bin/node` is taken from the macOS and Linux tarballs — npm, npx, corepack,
the headers and `lib/node_modules` are all dead weight when the binary's only
job is running JS, and skipping them avoids the symlinks Windows can't create.

## Format the stick as exFAT

This matters more than it looks:

| filesystem | verdict |
|---|---|
| **exFAT** | **Use this.** Read/write on Windows, macOS and Linux. |
| NTFS | macOS mounts it **read-only** — Claudbot can't re-lock the store. |
| FAT32 | Works, but a 4 GB per-file limit your store could eventually hit. |
| APFS / ext4 | Native to one OS, unreadable or awkward on the others. |

exFAT carries no POSIX permission bits, so the executable flag on the bundled
macOS/Linux `node` may not survive the trip. The launcher re-applies it at
startup and falls back to the host's Node with a clear message if it can't.

## The two protection modes

Exactly one is active, recorded in `portable/manifest.json`. There is no
"both at once" — two copies of your vault that drift apart is worse than either
mode alone.

### `store` (default)

AES-256-GCM with an scrypt KDF (N=2¹⁶), driven by the bundled Node.

- **No admin rights, no installed software.** Works on a locked-down work
  laptop, which is the whole point of a portable drive.
- No dependencies — `node:crypto` and `node:zlib` only, so a missing or
  ABI-mismatched native module can't brick the stick.
- GCM authenticates: a wrong passphrase or a tampered file fails loudly rather
  than returning garbage.

### `veracrypt`

A real VeraCrypt container.

- Stronger and far more battle-tested.
- **Needs VeraCrypt installed AND administrator rights on every host.** Without
  those the drive simply will not open.
- The passphrase is passed on VeraCrypt's command line, so it is briefly
  visible in the host's process list. `store` mode has no such exposure.

Switch with:

```
node portable/boot.mjs --convert store
```

Conversion **must** happen on a machine that can already open the drive. If you
set VeraCrypt mode and then find yourself on a machine without admin, you are
locked out until you get back to one that has it. This is why `store` is the
default.

## How your history follows you

Claude Code names each project's transcript directory after the absolute cwd,
dashed out. On a USB that changes with the mount point:

```
E:  ->  projects/E--app--claudbot
F:  ->  projects/F--app--claudbot
Mac ->  projects/-Volumes-CLAUDBOT-app--claudbot
```

Left alone, every machine would start a fresh, empty history and `recall` would
silently forget everything from the others. So on each boot
`portable/reconcile.mjs` renames the previous directory to the one this host
will use, and records the new name.

Two things make this safe:

- **Rename, not copy** — atomic on the same filesystem, and there is only ever
  one canonical history rather than N diverging ones.
- **Merge on collision** — if you return to a machine you've used before, both
  directories exist. It merges the union, and where the same session id appears
  twice it keeps the longer file, because transcripts only grow.

If the manifest is ever lost it falls back to the most recently modified
directory that actually contains transcripts.

## Nothing is left on the host

`CLAUDE_CONFIG_DIR` is pointed at `work/claude-home` on the drive, which moves
Claude Code's auth, `projects/` and `sessions/` off the host entirely. Verified
empirically: setting it makes Claude Code create `.claude.json`, `projects/` and
`sessions/` in the target and read auth from there.

## Honest limitations

- **Shredding on flash is best-effort.** Overwriting a file does not reliably
  destroy the old bytes — wear levelling means the controller writes to a
  different physical cell and the original may survive until garbage collection.
  This defeats casual recovery, not forensics. The real protection is that the
  store is encrypted at rest and the passphrase never touches disk.
- **A crash leaves plaintext on the stick** until the next launch cleans it up.
  Unavoidable: the data has to be readable while you're using it.
- **VeraCrypt mode passes the passphrase via argv**, visible in the process
  list. Inherent to driving its CLI; another reason `store` is the default.
- **`--include-voice` is untested on the drive.** The voice subsystem needs a
  Python venv with absolute paths baked in, which does not survive relocation.
  The code is copied, but you'd have to re-run `claudbot voice setup` per host.
- **No backup is created for you.** USB sticks fail and get lost. Keep the
  desktop install, or make a second drive.

## Verifying the machinery

```
npm run check:portable
```

43 checks: transcript continuity across drive letters (including the merge and
lost-manifest cases), archive round-trip, path-traversal rejection, encryption
round-trip, wrong-passphrase and tamper detection, lock/unlock/shred, and
passphrase keystroke handling.
