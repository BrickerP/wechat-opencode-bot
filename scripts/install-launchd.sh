#!/usr/bin/env bash
# Render config/launchd/*.plist for this machine and install them into ~/Library/LaunchAgents.
# Dry run by default; --apply backs up whatever it replaces. It never runs launchctl: it prints the commands.
set -euo pipefail

usage() { echo "Usage: scripts/install-launchd.sh [--apply]"; }

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA_DIR="${OWB_DATA_DIR:-$HOME/.wechat-opencode-bot}"
SRC_DIR="$REPO/config/launchd"
DEST_DIR="$HOME/Library/LaunchAgents"
BACKUP="$DATA_DIR/backups/launchd-$(date +%Y%m%d-%H%M%S)"
# The server first: a bot that finds no server on its port starts one of its own. The watchdog last, after the jobs it checks.
LABELS="com.yupeng.opencode-wechat-server com.yupeng.opencode-wechat-bot com.yupeng.opencode-wechat-watchdog"

apply=0
case "${1:-}" in
  --apply) apply=1 ;;
  '') ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [ $# -gt 1 ]; then usage >&2; exit 2; fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/wechat-bot-launchd.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
repo=$(sed_escape "$REPO")
home=$(sed_escape "$HOME")
uid=$(id -u)

changes=0
commands=
echo "$SRC_DIR -> $DEST_DIR"
for label in $LABELS; do
  name=$label.plist
  rendered=$WORK/$name
  dest=$DEST_DIR/$name
  sed -e "s|__REPO__|$repo|g" -e "s|__HOME__|$home|g" "$SRC_DIR/$name" > "$rendered"
  if ! plutil -lint -s "$rendered"; then
    echo "install-launchd: $name does not render to a valid plist" >&2
    exit 1
  fi
  if [ ! -e "$dest" ]; then
    echo "  new        $name"
  elif cmp -s "$rendered" "$dest"; then
    echo "  unchanged  $name"
    continue
  else
    echo "  changed    $name"
    diff -u "$dest" "$rendered" | sed 's/^/    /' || true
    commands="$commands  launchctl bootout gui/$uid/$label"$'\n'
  fi
  commands="$commands  launchctl bootstrap gui/$uid $dest"$'\n'
  changes=$((changes + 1))
  [ $apply = 1 ] || continue
  mkdir -p "$DEST_DIR"
  if [ -e "$dest" ]; then
    mkdir -p "$BACKUP"
    cp -p "$dest" "$BACKUP/"
  fi
  # A name without .plist until the rename, so nothing ever reads a half-written job.
  cp "$rendered" "$dest.tmp.$$"
  chmod 644 "$dest.tmp.$$"
  mv -f "$dest.tmp.$$" "$dest"
done

if [ $changes = 0 ]; then
  echo "nothing to change"
  exit 0
fi
if [ $apply = 0 ]; then
  echo "dry run: $changes change(s); rerun with --apply"
  exit 0
fi

echo "installed $changes plist(s)"
if [ -d "$BACKUP" ]; then echo "backup: $BACKUP"; fi
echo "launchd keeps running the old definitions. Load the new ones while no task is running:"
printf '%s' "$commands"
echo "To restart a job without reloading its definition:"
for label in $LABELS; do echo "  launchctl kickstart -k gui/$uid/$label"; done
