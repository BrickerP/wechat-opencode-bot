#!/usr/bin/env bash
# Read-only health report on the launchd jobs of the bot and its OpenCode server; exits 1 if anything fails.
# It finds the bot through launchd, so it works from the repo and from a release alike.
# The server password reaches curl on stdin: it never shows up in argv or in the output.
set -euo pipefail

DATA_DIR="${OWB_DATA_DIR:-$HOME/.wechat-opencode-bot}"
ENV_FILE="$DATA_DIR/env"
SERVER_LABEL=com.yupeng.opencode-wechat-server
BOT_LABEL=com.yupeng.opencode-wechat-bot

failed=0
ok() { echo "  ok    $*"; }
fail() {
  echo "  FAIL  $*"
  failed=1
}
indent() { sed 's/^/          /'; }

job_info() {  # "pid state" of a launchd job: "- unloaded" if it is not loaded, "- <state>" if it has no process
  { launchctl print "gui/$(id -u)/$1" 2>/dev/null || true; } |
    awk -F' = ' '$1 == "\tstate" { s = $2 } $1 == "\tpid" { p = $2 } END { print (p == "" ? "-" : p), (s == "" ? "unloaded" : s) }'
}

lsof_name() {  # the first file lsof lists for a pid and fd kind (txt: the executable, cwd: the working directory)
  lsof -a -p "$1" -d "$2" -Fn 2>/dev/null | awk '/^n/ && !found { print substr($0, 2); found = 1 }'
}

read -r server_pid server_state <<<"$(job_info "$SERVER_LABEL")"
if [ "$server_state" = running ]; then ok "$SERVER_LABEL running, pid $server_pid"; else fail "$SERVER_LABEL is $server_state"; fi

code=$(
  set -a
  if [ -f "$ENV_FILE" ]; then . "$ENV_FILE"; fi
  set +a
  url=${OPENCODE_URL:-http://127.0.0.1:4096}
  printf 'Authorization: Basic %s\n' "$(printf 'opencode:%s' "${OPENCODE_SERVER_PASSWORD:-}" | base64 | tr -d '\n')" |
    curl -sS -m 5 -o /dev/null -w '%{http_code}' -H @- "${url%/}/api/info"
) || true
if [ "$code" = 200 ]; then ok "OpenCode /api/info answered 200"; else fail "OpenCode /api/info answered ${code:-nothing}"; fi

read -r bot_pid bot_state <<<"$(job_info "$BOT_LABEL")"
if [ "$bot_state" = running ]; then
  ok "$BOT_LABEL running, pid $bot_pid"
  command=$(ps -o command= -p "$bot_pid" || true)
  cwd=$(lsof_name "$bot_pid" cwd || true)
  echo "        runs: $command"
  echo "        cwd:  $cwd"
  if [ -L "$cwd/current" ]; then
    echo "        current -> $(readlink "$cwd/current")"
  else
    echo "        no current symlink in $cwd"
  fi

  lock_pid=$(sed -n 's/^pid=//p' "$DATA_DIR/daemon.lock" 2>/dev/null || true)
  if [ "$lock_pid" = "$bot_pid" ]; then ok "daemon.lock matches"; else fail "daemon.lock names ${lock_pid:-no pid}, launchd runs $bot_pid"; fi

  # The bot's own node and entry, so the report comes from the code that is running.
  node_bin=$(lsof_name "$bot_pid" txt || true)
  entry=$(printf '%s\n' "$command" | awk '{ print $2 }')
  case "$entry" in /*) main=$entry ;; *) main=$cwd/$entry ;; esac
  if status=$(cd "$cwd" && "${node_bin:-node}" "$main" --status 2>&1); then
    ok "$entry --status"
    printf '%s\n' "$status" | indent
  else
    fail "$entry --status exited non-zero"
    printf '%s\n' "$status" | indent
  fi
else
  fail "$BOT_LABEL is $bot_state"
fi

if [ $failed = 1 ]; then
  echo "unhealthy"
  exit 1
fi
echo "healthy"
