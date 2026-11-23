#!/usr/bin/env bash
# Link OpenCode's wechat-* agents to the prompts of the deployed release (current/config/agents), and its
# plugins directory to the release's bridge plugin (current/plugin/wechat-bridge.js), which gives the
# orchestrators the tools they answer with. Dry run by default; --apply backs up whatever it replaces.
# It never reloads OpenCode.
set -euo pipefail

usage() { echo "Usage: scripts/install-agents.sh [--apply]"; }

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA_DIR="${OWB_DATA_DIR:-$HOME/.wechat-opencode-bot}"
ROOT="$REPO/current"
# A source checkout has no release yet: link its own config/agents and plugin. After a deploy, rerun this
# script so the links follow current/ and a release brings its own prompts and plugin.
if [ ! -d "$ROOT/config/agents" ]; then
  ROOT="$REPO"
  echo "install-agents: no release under current/; linking the repo's config/agents and plugin" >&2
fi
SRC_DIR="$ROOT/config/agents"
PLUGIN_SRC="$ROOT/plugin/wechat-bridge.js"
AGENTS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/agents"
# OpenCode loads every *.js file here as a server plugin.
PLUGIN_LINK="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/wechat-bridge.js"
# Not inside AGENTS_DIR: OpenCode loads .md files in its subdirectories, hidden ones too, as agents.
BACKUP="$DATA_DIR/backups/agents-$(date +%Y%m%d-%H%M%S)"

apply=0
case "${1:-}" in
  --apply) apply=1 ;;
  '') ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [ $# -gt 1 ]; then usage >&2; exit 2; fi

if [ ! -d "$SRC_DIR" ]; then
  echo "install-agents: $SRC_DIR is missing; run this from the repository" >&2
  exit 1
fi

backup() {
  mkdir -p "$BACKUP"
  cp -pR "$1" "$BACKUP/"
}

changes=0
# Adding, removing or changing a prompt only reaches OpenCode after a reload.
reload=0
echo "$AGENTS_DIR -> $SRC_DIR"
echo "$PLUGIN_LINK -> $PLUGIN_SRC"
for src in "$SRC_DIR"/*.md; do
  [ -e "$src" ] || continue
  name=$(basename "$src")
  [ "$name" != README.md ] || continue
  link="$AGENTS_DIR/$name"
  if [ "$(readlink "$link" 2>/dev/null || true)" = "$src" ]; then
    echo "  ok       $name"
    continue
  fi
  changes=$((changes + 1))
  if [ ! -e "$link" ] && [ ! -L "$link" ]; then
    echo "  add      $name"
    reload=1
  elif cmp -s "$link" "$src"; then
    echo "  replace  $name (same content)"
  else
    echo "  replace  $name (content differs from the release)"
    reload=1
  fi
  [ $apply = 1 ] || continue
  mkdir -p "$AGENTS_DIR"
  if [ -e "$link" ] || [ -L "$link" ]; then backup "$link"; fi
  # Rename over the old file so the agent never goes missing; "x.md.new" is not an agent name.
  ln -sf "$src" "$link.new"
  mv -f "$link.new" "$link"
done

# The plugin, as the prompts: a release without it leaves a link that points nowhere, which goes too.
plugin_target="$(readlink "$PLUGIN_LINK" 2>/dev/null || true)"
if [ -f "$PLUGIN_SRC" ] && [ "$plugin_target" = "$PLUGIN_SRC" ]; then
  echo "  ok       plugin wechat-bridge.js"
elif [ -f "$PLUGIN_SRC" ]; then
  changes=$((changes + 1))
  reload=1
  if [ -e "$PLUGIN_LINK" ] || [ -L "$PLUGIN_LINK" ]; then echo "  replace  plugin wechat-bridge.js"; else echo "  add      plugin wechat-bridge.js"; fi
  if [ $apply = 1 ]; then
    mkdir -p "$(dirname "$PLUGIN_LINK")"
    if [ -e "$PLUGIN_LINK" ] || [ -L "$PLUGIN_LINK" ]; then backup "$PLUGIN_LINK"; fi
    # "wechat-bridge.js.new" is no *.js file, so OpenCode never loads it as a plugin.
    ln -sf "$PLUGIN_SRC" "$PLUGIN_LINK.new"
    mv -f "$PLUGIN_LINK.new" "$PLUGIN_LINK"
  fi
elif [ -L "$PLUGIN_LINK" ] && [ ! -e "$PLUGIN_LINK" ]; then
  case "$plugin_target" in "$ROOT"/*)
    changes=$((changes + 1))
    reload=1
    echo "  remove   plugin wechat-bridge.js (the release has no plugin)"
    if [ $apply = 1 ]; then backup "$PLUGIN_LINK"; rm -f "$PLUGIN_LINK"; fi
    ;;
  esac
fi

# A prompt dropped from the release leaves its link pointing nowhere.
for link in "$AGENTS_DIR"/*.md; do
  [ -L "$link" ] && [ ! -e "$link" ] || continue
  case "$(readlink "$link")" in "$SRC_DIR"/*) ;; *) continue ;; esac
  changes=$((changes + 1))
  reload=1
  echo "  remove   $(basename "$link") (the release has no such prompt)"
  [ $apply = 1 ] || continue
  backup "$link"
  rm -f "$link"
done

if [ $changes = 0 ]; then
  echo "nothing to change"
  exit 0
fi
if [ $apply = 0 ]; then
  echo "dry run: $changes change(s); rerun with --apply"
  exit 0
fi

failed=0
for src in "$SRC_DIR"/*.md; do
  [ -e "$src" ] || continue
  name=$(basename "$src")
  [ "$name" != README.md ] || continue
  if [ "$(readlink "$AGENTS_DIR/$name" 2>/dev/null || true)" != "$src" ] || [ ! -f "$AGENTS_DIR/$name" ]; then
    echo "install-agents: $AGENTS_DIR/$name does not resolve to $src" >&2
    failed=1
  fi
done
if [ -f "$PLUGIN_SRC" ] && { [ "$(readlink "$PLUGIN_LINK" 2>/dev/null || true)" != "$PLUGIN_SRC" ] || [ ! -f "$PLUGIN_LINK" ]; }; then
  echo "install-agents: $PLUGIN_LINK does not resolve to $PLUGIN_SRC" >&2
  failed=1
fi
if [ $failed = 1 ]; then exit 1; fi

echo "applied $changes change(s); every link resolves into $ROOT"
if [ -d "$BACKUP" ]; then echo "backup: $BACKUP"; fi
if [ $reload = 1 ]; then
  echo "OpenCode caches agents and plugins. Reload them while no task is running:"
  printf '  (set -a; . %s; set +a; opencode reload --server "${OPENCODE_URL:-http://127.0.0.1:4096}")\n' "$DATA_DIR/env"
fi
