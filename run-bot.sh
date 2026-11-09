#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a
source "$HOME/.wechat-opencode-bot/env"
set +a
cd "$HOME/code/personal/wechat-opencode-bot"
exec node current/dist/main.js --daemon
