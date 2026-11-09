#!/usr/bin/env bash
# Build releases/wechat-bot-<tag>.tgz (and its .sha256) from the committed HEAD, after typecheck, build and test.
# It never creates a git tag and never pushes. Install the result with scripts/deploy.sh.
set -euo pipefail

usage() { echo "Usage: scripts/release.sh <vX.Y.Z>"; }
die() { echo "release: $*" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT="$REPO/releases"

if [ $# != 1 ]; then usage >&2; exit 2; fi
TAG=$1
case "$TAG" in
  -h | --help) usage; exit 0 ;;
  v[0-9]*) ;;
  *) die "a tag looks like v1.2.3, got: $TAG" ;;
esac
case "$TAG" in *[!0-9A-Za-z._-]*) die "a tag may only use letters, digits, '.', '_' and '-'" ;; esac

if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  die "the working tree has uncommitted changes; a release is built from HEAD, so commit them first"
fi
TARBALL="$OUT/wechat-bot-$TAG.tgz"
if [ -e "$TARBALL" ]; then die "$TARBALL already exists; pick a new tag"; fi
COMMIT=$(git -C "$REPO" rev-parse HEAD)

WORK=$(mktemp -d "${TMPDIR:-/tmp}/wechat-bot-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/src"
STAGE="$WORK/stage"
mkdir "$SRC" "$STAGE"

# A fresh export: nothing untracked or left over in the repo's dist/ and node_modules/ gets in.
echo "building $TAG from $COMMIT"
git -C "$REPO" archive HEAD | tar -x -C "$SRC"
(
  cd "$SRC"
  npm ci --no-audit --no-fund
  npm run typecheck
  npm run build
  npm test
)

cp -pR "$SRC/dist" "$STAGE/dist"
for file in package.json package-lock.json run-bot.sh run-server.sh; do cp -p "$SRC/$file" "$STAGE/"; done
mkdir "$STAGE/config" "$STAGE/scripts"
cp -pR "$SRC/config/agents" "$STAGE/config/agents"
cp -p "$SRC/scripts/healthcheck.sh" "$STAGE/scripts/"
printf 'tag=%s\ncommit=%s\nbuilt=%s\n' "$TAG" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/RELEASE"

mkdir -p "$OUT"
# COPYFILE_DISABLE keeps macOS tar from adding ._* metadata files.
(cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$WORK/release.tgz" RELEASE dist package.json package-lock.json run-bot.sh run-server.sh config scripts)
mv "$WORK/release.tgz" "$TARBALL"
(cd "$OUT" && shasum -a 256 "wechat-bot-$TAG.tgz" > "wechat-bot-$TAG.tgz.sha256")

echo "release: $TARBALL"
echo "sha256:  $(cut -d ' ' -f 1 "$TARBALL.sha256")"
echo "next:    scripts/deploy.sh $TAG   # dry run"
