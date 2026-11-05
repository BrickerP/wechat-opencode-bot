#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a
source "$HOME/.wechat-opencode-bot/env"
set +a
cd "${HOME}/code/work"
exec opencode serve --hostname 127.0.0.1 --port "${OPENCODE_PORT:-4096}"
