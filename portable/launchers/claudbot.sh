#!/usr/bin/env bash
# ============================================================================
#  Claudbot portable — macOS / Linux launcher
#
#  Finds the Node runtime bundled on this drive for the current platform and
#  hands over to portable/boot.mjs, which prompts for the passphrase.
#
#  Nothing here hardcodes a mount point: the drive may be /Volumes/CLAUDBOT,
#  /media/you/CLAUDBOT, /mnt/usb, or anywhere else.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in
      arm64) KEY="darwin-arm64" ;;
      *)     KEY="darwin-x64"   ;;
    esac
    ;;
  Linux)
    case "$(uname -m)" in
      x86_64)         KEY="linux-x64"   ;;
      aarch64|arm64)  KEY="linux-arm64" ;;
      *)              KEY=""            ;;
    esac
    ;;
  *) KEY="" ;;
esac

BUNDLED="$DIR/runtime/$KEY/bin/node"

# USB sticks are usually exFAT or FAT32, which carry no POSIX permission bits,
# so the executable flag set at build time may not have survived. Try to restore
# it before giving up on the bundled runtime. (chmod is a no-op on filesystems
# that don't support it, hence the second test rather than trusting the exit.)
if [ -n "$KEY" ] && [ -f "$BUNDLED" ] && [ ! -x "$BUNDLED" ]; then
  chmod +x "$BUNDLED" 2>/dev/null || true
fi

NODE=""
if [ -n "$KEY" ] && [ -x "$BUNDLED" ]; then
  NODE="$BUNDLED"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
  if [ -n "$KEY" ] && [ -f "$BUNDLED" ]; then
    echo "  Note: the bundled runtime isn't executable on this mount; using the host's Node." >&2
  fi
fi

if [ -z "$NODE" ]; then
  if [ -n "$KEY" ] && [ -f "$BUNDLED" ]; then
    # Present but not executable. exFAT and FAT32 store no permission bits, so
    # the exec flag comes from the mount options and the chmod above was a
    # no-op. Say that plainly: telling someone the file is missing sends them
    # off to rebuild a drive that is perfectly fine.
    # Work out the backing device so the suggested command is copy-pasteable.
    SRC=""
    if command -v findmnt >/dev/null 2>&1; then
      SRC="$(findmnt -no SOURCE --target "$DIR" 2>/dev/null || true)"
    fi
    cat >&2 <<EOF

  The bundled Node runtime is present but cannot be executed.

    $BUNDLED

  This mount grants no execute permission. That is normal for exFAT/FAT32,
  where permissions come from the mount options rather than the filesystem,
  which is also why chmod cannot fix it.

  Mount the drive again with execute permission. Note that "mount -o remount"
  does NOT change these masks — it has to be a full unmount and mount:

    sudo umount "$DIR"
    sudo mount -o fmask=0022,dmask=0022 ${SRC:-/dev/sdXN} "$DIR"

  Or, simplest, start Claudbot through any Node 22+ already on this machine:
    node "$DIR/portable/boot.mjs"

EOF
  else
    cat >&2 <<EOF

  No Node runtime found.

  This drive has no runtime/${KEY:-<this platform>}/bin/node and Node is not
  installed on this machine. Re-run make-portable including this platform's
  runtime, or install Node 22+ here.

EOF
  fi
  exit 1
fi

exec "$NODE" "$DIR/portable/boot.mjs" "$@"
