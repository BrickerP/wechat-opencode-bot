#!/usr/bin/env bash
# The bot's watchdog: launchd runs it at login and every 5 minutes. It restarts a bot that fails scripts/healthcheck.sh
# or stopped rewriting its heartbeat, and once a day sends one task through --simulate as a smoke test.
# A stuck bot cannot write to WeChat, so the watchdog reports with macOS notifications and logs/watchdog.log.
# A healthy run writes nothing. It logs the healthcheck's check lines, never its --status report or the env file.
set -euo pipefail

usage() { echo "Usage: scripts/watchdog.sh [--smoke]"; }

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
DATA_DIR="${OWB_DATA_DIR:-$HOME/.wechat-opencode-bot}"
LOG="$DATA_DIR/logs/watchdog.log"
HEARTBEAT="$DATA_DIR/heartbeat"
BOT_LABEL=com.yupeng.opencode-wechat-bot
# Touched when a restart did not help: the next restart waits RETRY_SECONDS, and the next passing check reports it.
FAILED_STAMP="$DATA_DIR/logs/.watchdog-failed"
SMOKE_STAMP="$DATA_DIR/logs/.smoke-stamp"

STALE_SECONDS=300       # the daemon rewrites the heartbeat every 30 s
CONFIRM_SECONDS=60      # after a wake from sleep, or during a deploy's restart, one check can fail
RESTART_WAIT_SECONDS=30
RETRY_SECONDS=1800
SMOKE_EVERY_SECONDS=86400
SMOKE_TIMEOUT_SECONDS=180

smoke=0
case "${1:-}" in
  --smoke) smoke=1 ;;
  '') ;;
  -h | --help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
if [ $# -gt 1 ]; then usage >&2; exit 2; fi

# launchd's PATH has no node. Appended, so a PATH set by the caller still comes first.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
mkdir -p "$DATA_DIR/logs"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/wechat-bot-watchdog.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

say() { if [ -t 1 ]; then printf '%s\n' "$*"; fi; }  # for a run in a terminal
log() {
  local line
  line="$(date '+%Y-%m-%dT%H:%M:%S%z') $*"
  printf '%s\n' "$line" >>"$LOG"
  say "$line"
}
log_lines() {  # logs stdin, one entry per line
  local line
  while IFS= read -r line; do log "  $line"; done
}
notify() {  # best effort; macOS shows it as a Script Editor notification
  osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "wechat-opencode-bot"' -e 'end run' "$1" \
    >/dev/null 2>&1 || true
}
age() {  # seconds since the file was last written; a missing file is very old
  local mtime
  # BSD stat by path: GNU stat, first on some PATHs, reads -f as --file-system.
  mtime=$(/usr/bin/stat -f %m "$1" 2>/dev/null) || { echo 999999999; return; }
  echo $(($(date +%s) - mtime))
}

problem=  # what the last check found wrong
check() {  # healthcheck.sh passes, and the bot that holds daemon.lock rewrote the heartbeat within STALE_SECONDS
  local beat_pid lock_pid beat_age
  if ! "$REPO/scripts/healthcheck.sh" >"$WORK/health" 2>&1; then
    problem=$(awk '/^  FAIL  / { sub(/^  FAIL  /, ""); print; exit }' "$WORK/health")
    problem="healthcheck: ${problem:-exited non-zero}"
    return 1
  fi
  beat_pid=$(sed -n 's/^pid=//p' "$HEARTBEAT" 2>/dev/null || true)
  lock_pid=$(sed -n 's/^pid=//p' "$DATA_DIR/daemon.lock" 2>/dev/null || true)
  beat_age=$(age "$HEARTBEAT")
  problem=
  if [ -z "$beat_pid" ]; then
    problem="no heartbeat in $HEARTBEAT"
  elif [ "$beat_pid" != "$lock_pid" ]; then
    problem="the heartbeat names pid $beat_pid, daemon.lock names ${lock_pid:-no pid}"
  elif [ "$beat_age" -ge $STALE_SECONDS ]; then
    problem="the heartbeat is $beat_age s old"
  fi
  [ -z "$problem" ]
}
# The last check's verdict per check. The --status report under it stays out: it quotes running tasks.
log_checks() { grep -E '^  (ok|FAIL) ' "$WORK/health" | log_lines || true; }

wait_healthy() {  # a check every 5 s, for up to RESTART_WAIT_SECONDS
  local waited=0
  while [ $waited -lt $RESTART_WAIT_SECONDS ]; do
    sleep 5
    waited=$((waited + 5))
    if check; then return 0; fi
  done
  return 1
}

run_with_timeout() {  # run_with_timeout <seconds> <command...>: its exit status, or 124 when it had to be stopped
  local limit=$1 pid waited=0
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ $waited -ge "$limit" ]; then
      # On SIGTERM --simulate marks its task interrupted, which frees the simulate account for the next test.
      kill -TERM "$pid" 2>/dev/null || true
      sleep 10
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

# A job that is not loaded was stopped on purpose (launchctl bootout). Bootstrapping it brings the checks back.
if ! launchctl print "gui/$(id -u)/$BOT_LABEL" >/dev/null 2>&1; then
  say "$BOT_LABEL is not loaded; nothing to check"
  exit 0
fi

healthy=1
if ! check; then
  say "$problem; checking again in $CONFIRM_SECONDS s"
  sleep $CONFIRM_SECONDS
  check || healthy=0
fi

if [ $healthy = 1 ]; then
  if [ -e "$FAILED_STAMP" ]; then
    rm -f "$FAILED_STAMP"
    log "healthy again"
    notify "The bot is healthy again."
  fi
else
  retry_in=0
  if [ -e "$FAILED_STAMP" ]; then retry_in=$((RETRY_SECONDS - $(age "$FAILED_STAMP"))); fi
  if [ $retry_in -gt 0 ]; then
    log "still unhealthy: $problem; the last restart did not help, next try in $retry_in s"
    exit 1
  fi
  log "unhealthy twice, $CONFIRM_SECONDS s apart: $problem"
  log_checks
  reason=$problem
  if out=$(launchctl kickstart -k "gui/$(id -u)/$BOT_LABEL" 2>&1); then
    log "restarted $BOT_LABEL"
  else
    log "launchctl kickstart failed: $out"
  fi
  if wait_healthy; then
    rm -f "$FAILED_STAMP"
    log "healthy after the restart"
    notify "Restarted the bot ($reason). It is healthy again."
  else
    touch "$FAILED_STAMP"
    log "still unhealthy after the restart: $problem"
    log_checks
    notify "Restarted the bot, but it is still unhealthy: $problem"
    exit 1
  fi
fi

if [ $smoke = 1 ] || [ "$(age "$SMOKE_STAMP")" -ge $SMOKE_EVERY_SECONDS ]; then
  # One task through the real OpenCode server and model, under the simulate account rather than the chat's.
  main=$REPO/dist/main.js
  if [ -e "$REPO/current" ] || [ -L "$REPO/current" ]; then main=$REPO/current/dist/main.js; fi
  touch "$SMOKE_STAMP"  # before the run, so a failing test also waits a day
  started=$(date +%s)
  status=0
  cd "$REPO"
  run_with_timeout $SMOKE_TIMEOUT_SECONDS node "$main" --simulate "只回复 ok" >"$WORK/smoke" 2>&1 || status=$?
  if [ $status != 0 ]; then
    if [ $status = 124 ]; then reason="no result in $SMOKE_TIMEOUT_SECONDS s"; else reason="exit $status"; fi
    log "smoke test failed: $reason"
    tail -n 20 "$WORK/smoke" | log_lines
    notify "Smoke test failed: $reason. See logs/watchdog.log."
    exit 1
  fi
  log "smoke test passed in $(($(date +%s) - started)) s"
fi
say healthy
