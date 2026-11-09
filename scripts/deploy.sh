#!/usr/bin/env bash
# Install a release in releases/<tag>, point current at it and restart the bot on it.
# Dry run by default. --apply backs up state.db first and rolls back if the bot comes up unhealthy.
# Only --migrate-wrapper edits run-bot.sh: once, so that it starts current/dist/main.js (docs/DEPLOY.md).
# It never restarts the OpenCode server.
set -euo pipefail

usage() { echo "Usage: scripts/deploy.sh [--apply] [--migrate-wrapper] <tag | path/to/wechat-bot-<tag>.tgz>"; }
die() { echo "deploy: $*" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA_DIR="${OWB_DATA_DIR:-$HOME/.wechat-opencode-bot}"
BACKUP_DIR="$DATA_DIR/backups"
ENV_FILE="$DATA_DIR/env"
DB="$DATA_DIR/state.db"
AGENTS_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/agents"
RELEASES="$REPO/releases"
CURRENT="$REPO/current"
WRAPPER="$REPO/run-bot.sh"
ENTRY=current/dist/main.js
BOT_LABEL=com.yupeng.opencode-wechat-bot
# A bot still on the same pid this long after its restart is not crash-looping.
STABLE_SECONDS=15
TS=$(date +%Y%m%d-%H%M%S)

apply=0
migrate=0
target=
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    --migrate-wrapper) migrate=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *)
      if [ -n "$target" ]; then usage >&2; exit 2; fi
      target=$arg
      ;;
  esac
done
if [ -z "$target" ]; then usage >&2; exit 2; fi

# A file is a tarball; anything else is a tag in releases/.
if [ -f "$target" ]; then
  TARBALL="$(cd "$(dirname "$target")" && pwd -P)/$(basename "$target")"
  TAG=$(basename "$target" .tgz)
  TAG=${TAG#wechat-bot-}
else
  TAG=$target
  TARBALL="$RELEASES/wechat-bot-$TAG.tgz"
fi
case "$TAG" in v[0-9]*) ;; *) die "not a release tag: $TAG" ;; esac
case "$TAG" in *[!0-9A-Za-z._-]*) die "not a release tag: $TAG" ;; esac
DEST="$RELEASES/$TAG"

job_info() {  # "pid state" of a launchd job: "- unloaded" if it is not loaded
  { launchctl print "gui/$(id -u)/$1" 2>/dev/null || true; } |
    awk -F' = ' '$1 == "\tstate" { s = $2 } $1 == "\tpid" { p = $2 } END { print (p == "" ? "-" : p), (s == "" ? "unloaded" : s) }'
}

wrapper_entry() { awk '$1 == "exec" && $2 == "node" { print $3; exit }' "$WRAPPER"; }

agents_follow_current() {  # some agent links into current, so moving current changes the prompts
  local link
  for link in "$AGENTS_DIR"/*.md; do
    case "$(readlink "$link" 2>/dev/null || true)" in "$CURRENT"/*) return 0 ;; esac
  done
  return 1
}

prompts_changed() {  # also true when there is no previous release to compare with
  if [ -z "$prev" ] || [ ! -d "$REPO/$prev/config/agents" ]; then return 0; fi
  ! diff -rq "$REPO/$prev/config/agents" "$DEST/config/agents" >/dev/null 2>&1
}

reload_agents() {  # a subshell keeps the env file's values out of this script
  (
    set -a
    if [ -f "$ENV_FILE" ]; then . "$ENV_FILE"; fi
    set +a
    opencode reload --server "${OPENCODE_URL:-http://127.0.0.1:4096}"
  )
}

point_current() {  # renaming over the old link is atomic: current never goes missing
  ln -s "$1" "$REPO/.current.$$"
  mv -fh "$REPO/.current.$$" "$CURRENT"
}

old_pid=-
restart_bot() {
  read -r old_pid old_state <<<"$(job_info "$BOT_LABEL")"
  launchctl kickstart -k "gui/$(id -u)/$BOT_LABEL"
}

wait_healthy() {  # a new pid within 30s, the same pid STABLE_SECONDS later, then a passing health check
  local pid=- state now i=0
  while [ $i -lt 30 ]; do
    read -r pid state <<<"$(job_info "$BOT_LABEL")"
    if [ "$state" = running ] && [ "$pid" != "$old_pid" ]; then break; fi
    pid=-
    i=$((i + 1))
    sleep 1
  done
  if [ "$pid" = - ]; then
    echo "deploy: the bot did not start within 30s" >&2
    return 1
  fi
  sleep "$STABLE_SECONDS"
  read -r now state <<<"$(job_info "$BOT_LABEL")"
  if [ "$state" != running ] || [ "$now" != "$pid" ]; then
    echo "deploy: the bot did not stay up: pid $pid, then $now ($state)" >&2
    return 1
  fi
  "$REPO/scripts/healthcheck.sh"
}

migrated=0
reloaded=0
restarted=0
wrapper_backup=

rollback() {  # undo what this run changed; the installed release and the backups stay
  echo "deploy: $1; rolling back" >&2
  if [ -n "$prev" ]; then
    point_current "$prev" || echo "deploy: could not point current back at $prev" >&2
  else
    rm -f "$CURRENT"
  fi
  rm -f "$WRAPPER.new"
  if [ $migrated = 1 ]; then
    cp -p "$wrapper_backup" "$WRAPPER" || echo "deploy: restore run-bot.sh from $wrapper_backup by hand" >&2
  fi
  if [ $reloaded = 1 ]; then
    reload_agents || echo "deploy: the agent reload failed; reload by hand (docs/DEPLOY.md#agents)" >&2
  fi
  if [ $restarted = 1 ]; then
    if restart_bot && wait_healthy; then
      echo "deploy: rolled back; the bot is healthy on ${prev:-its previous build}" >&2
    else
      echo "deploy: the bot is unhealthy after the rollback too; see $DATA_DIR/logs" >&2
    fi
  fi
  exit 1
}
migration_note() {
  echo "note: run-bot.sh starts ${entry:-something else}, not $ENTRY, so the bot keeps running that build."
  echo "      Switch it once (docs/DEPLOY.md#one-time-migration), then commit run-bot.sh:"
  echo "        scripts/deploy.sh --apply --migrate-wrapper $TAG"
}

# ── what is there now ───────────────────────────────────────────────────

if [ -e "$CURRENT" ] && [ ! -L "$CURRENT" ]; then die "$CURRENT is not a symlink; move it away first"; fi
prev=$(readlink "$CURRENT" 2>/dev/null || true)
entry=$(wrapper_entry)
if [ $migrate = 1 ] && [ -z "$entry" ]; then die "run-bot.sh has no 'exec node <entry>' line to switch"; fi
restart=0
if [ "$entry" = "$ENTRY" ] || [ $migrate = 1 ]; then restart=1; fi
if [ $restart = 1 ] && [ "$(job_info "$BOT_LABEL" | cut -d ' ' -f 2-)" = unloaded ]; then
  die "launchd has no $BOT_LABEL job to restart; load it first (docs/DEPLOY.md#launchd)"
fi

if [ -d "$DEST" ]; then
  echo "release   $TAG, installed in releases/$TAG"
elif [ -f "$TARBALL" ]; then
  if [ ! -f "$TARBALL.sha256" ]; then die "$TARBALL.sha256 is missing"; fi
  if ! (cd "$(dirname "$TARBALL")" && shasum -a 256 -c "$(basename "$TARBALL").sha256" >/dev/null); then
    die "$TARBALL does not match its checksum"
  fi
  echo "release   $TAG, $TARBALL (checksum ok)"
else
  die "no release $TAG; build it with scripts/release.sh $TAG"
fi
release_info() { if [ -d "$DEST" ]; then cat "$DEST/RELEASE"; else tar -xOzf "$TARBALL" RELEASE; fi; }
echo "commit    $(release_info 2>/dev/null | sed -n 's/^commit=//p')"
echo "current   ${prev:-(none)}"
echo "wrapper   run-bot.sh starts ${entry:-(no exec node line)}"
if agents_follow_current; then
  echo "agents    linked through current"
else
  echo "agents    not linked through current; scripts/install-agents.sh links them"
fi

n=0
step() {
  n=$((n + 1))
  echo "  $n. $*"
}
echo "plan:"
if [ -d "$DEST" ]; then step "use the installed releases/$TAG"; else step "install releases/$TAG: extract, npm ci --omit=dev"; fi
if [ -f "$DB" ]; then step "back up state.db to $BACKUP_DIR/state.db.pre-$TAG-$TS"; fi
step "point current at releases/$TAG"
if [ $migrate = 1 ]; then
  if [ "$entry" = "$ENTRY" ]; then
    step "leave run-bot.sh alone: it already starts $ENTRY"
  else
    step "switch run-bot.sh from $entry to $ENTRY, with a backup in $BACKUP_DIR"
  fi
fi
if [ $restart = 1 ]; then
  if agents_follow_current; then step "reload the OpenCode agents if this release changes a prompt"; fi
  step "restart the bot, run scripts/healthcheck.sh after ${STABLE_SECONDS}s, roll all of it back on failure"
  echo "  The restart interrupts a running task, whose user gets a ⏹ notice: check /status first."
else
  migration_note
fi
if [ $apply = 0 ]; then
  echo "dry run; rerun with --apply"
  exit 0
fi

# ── apply ────────────────────────────────────────────────────────────────

STAGE=
trap 'if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi' EXIT
if [ ! -d "$DEST" ]; then
  STAGE="$RELEASES/.staging-$TAG-$$"
  mkdir -p "$STAGE"
  tar -xzf "$TARBALL" -C "$STAGE"
  if [ ! -f "$STAGE/dist/main.js" ]; then die "$TARBALL has no dist/main.js"; fi
  (cd "$STAGE" && npm ci --omit=dev --no-audit --no-fund)
  mv "$STAGE" "$DEST"
  STAGE=
  echo "installed releases/$TAG"
fi

if [ -f "$DB" ]; then
  mkdir -p "$BACKUP_DIR"
  db_backup="$BACKUP_DIR/state.db.pre-$TAG-$TS"
  (umask 077 && sqlite3 -cmd '.timeout 5000' "$DB" ".backup '$db_backup'")
  echo "backed up state.db to $db_backup"
fi

point_current "releases/$TAG"
echo "current -> releases/$TAG (was ${prev:-none})"
if [ $restart = 0 ]; then
  migration_note
  echo "deployed $TAG without restarting the bot"
  exit 0
fi

# From here on, a failure undoes what this run changed.
if [ $migrate = 1 ] && [ "$entry" != "$ENTRY" ]; then
  mkdir -p "$BACKUP_DIR"
  wrapper_backup="$BACKUP_DIR/run-bot.sh.pre-$TAG-$TS"
  cp -p "$WRAPPER" "$wrapper_backup" || rollback "could not back up run-bot.sh"
  # The copy keeps the wrapper's mode; sed then replaces its content.
  { cp -p "$WRAPPER" "$WRAPPER.new" &&
    sed -E "s#^exec node [^ ]+#exec node $ENTRY#" "$wrapper_backup" > "$WRAPPER.new" &&
    mv -f "$WRAPPER.new" "$WRAPPER"; } || rollback "could not rewrite run-bot.sh"
  migrated=1
  if [ "$(wrapper_entry)" != "$ENTRY" ]; then rollback "run-bot.sh does not start $ENTRY after the rewrite"; fi
  echo "run-bot.sh now starts $ENTRY (backup: $wrapper_backup)"
fi

if agents_follow_current && prompts_changed; then
  reload_agents || rollback "the OpenCode agent reload failed"
  reloaded=1
  echo "reloaded the OpenCode agents"
fi

restart_bot || rollback "launchctl kickstart failed"
restarted=1
echo "restarted $BOT_LABEL (was pid $old_pid); checking its health"
wait_healthy || rollback "the bot is not healthy on $TAG"
echo "deployed $TAG: the bot runs releases/$TAG and is healthy"
