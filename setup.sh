#!/usr/bin/env sh
# Claudbot first-run on a new macOS/Linux device. Needs only sh.
# Usage: sh setup.sh [--yes]
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed - Claudbot needs it (>= 22)."
  if [ "$1" = "--yes" ]; then a=y; else printf "Install Node.js now? [y/N] "; read a; fi
  case "$a" in y|Y|yes) ;; *) echo "Install Node from https://nodejs.org, then re-run."; exit 1 ;; esac
  if command -v brew >/dev/null 2>&1; then brew install node
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y nodejs npm
  else echo "No supported package manager; install from https://nodejs.org"; exit 1; fi
  echo "Node installed. Open a NEW terminal and re-run setup.sh."
  exit 0
fi
exec node "$here/scripts/bootstrap.mjs" "$@"
