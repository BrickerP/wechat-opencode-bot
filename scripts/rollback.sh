#!/usr/bin/env bash
# Point current back at an installed release and restart the bot on it; scripts/deploy.sh does the work.
# Dry run by default. state.db is not restored: docs/DEPLOY.md#roll-back says when and how.
set -euo pipefail

usage() { echo "Usage: scripts/rollback.sh [--apply] <tag>"; }

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"

apply=0
tag=
for arg in "$@"; do
  case "$arg" in
    --apply) apply=1 ;;
    -h | --help) usage; exit 0 ;;
    -*) usage >&2; exit 2 ;;
    *)
      if [ -n "$tag" ]; then usage >&2; exit 2; fi
      tag=$arg
      ;;
  esac
done
if [ -z "$tag" ]; then usage >&2; exit 2; fi

case "$tag" in v[0-9]*) ;; *) echo "rollback: not a release tag: $tag" >&2; exit 2 ;; esac
case "$tag" in *[!0-9A-Za-z._-]*) echo "rollback: not a release tag: $tag" >&2; exit 2 ;; esac
# Only an installed release: deploy.sh would install a tarball instead, which is not a rollback.
if [ ! -d "$REPO/releases/$tag" ]; then
  echo "rollback: releases/$tag is not installed. Installed releases:" >&2
  for dir in "$REPO"/releases/v*/; do
    if [ -d "$dir" ]; then echo "  $(basename "$dir")" >&2; fi
  done
  exit 1
fi

if [ $apply = 1 ]; then exec "$REPO/scripts/deploy.sh" --apply "$tag"; fi
exec "$REPO/scripts/deploy.sh" "$tag"
