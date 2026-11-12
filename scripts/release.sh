#!/usr/bin/env bash
# Package releases/wechat-bot-<tag>.tgz (and its .sha256) from the committed HEAD and the dist/ that CI built from it.
# Nothing is compiled or tested here, and no tarball is written unless the CI artifact's BUILD_COMMIT is HEAD.
# It never creates a git tag and never pushes. Install the result with scripts/deploy.sh.
set -euo pipefail

usage() {
  echo "Usage: scripts/release.sh <vX.Y.Z> <artifact-dir>"
  echo "<artifact-dir> holds CI's wechat-opencode-bot-build-<commit> artifact of HEAD: dist/ and BUILD_COMMIT."
  echo "Download it outside the repo, so that the working tree stays clean:"
  echo "  gh run download <run-id> -n wechat-opencode-bot-build-<commit> -D <artifact-dir>"
}
die() { echo "release: $*" >&2; exit 1; }

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT="$REPO/releases"

case "${1:-}" in -h | --help) usage; exit 0 ;; esac
if [ $# != 2 ]; then usage >&2; exit 2; fi
TAG=$1
# Absolute, so that no command reads the path as an option.
case "$2" in /*) ARTIFACT=$2 ;; *) ARTIFACT=$PWD/$2 ;; esac
case "$TAG" in
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

# dist/ must be CI's build of HEAD. CI writes BUILD_COMMIT with git rev-parse HEAD: the hash and a newline.
bad_artifact() { die "$1; pass the CI artifact wechat-opencode-bot-build-$COMMIT"; }
if [ ! -d "$ARTIFACT" ]; then bad_artifact "$ARTIFACT is not a directory"; fi
if [ ! -f "$ARTIFACT/BUILD_COMMIT" ]; then bad_artifact "$ARTIFACT has no BUILD_COMMIT"; fi
if ! { printf '%s\n' "$COMMIT" | cmp -s - "$ARTIFACT/BUILD_COMMIT" ||
  printf '%s' "$COMMIT" | cmp -s - "$ARTIFACT/BUILD_COMMIT"; }; then
  bad_artifact "$ARTIFACT/BUILD_COMMIT must hold exactly HEAD's hash $COMMIT, but starts with '$(head -c 64 "$ARTIFACT/BUILD_COMMIT" | head -n 1 | cat -v)'"
fi
if [ ! -f "$ARTIFACT/dist/main.js" ]; then bad_artifact "$ARTIFACT has no dist/main.js"; fi
# cp and tar would keep a link as a link, pointing out of the release.
odd=$(find "$ARTIFACT/dist" ! -type d ! -type f -print -quit)
if [ -n "$odd" ]; then bad_artifact "$odd is not a plain file or directory"; fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/wechat-bot-release.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/src"
STAGE="$WORK/stage"
mkdir "$SRC" "$STAGE"

# A fresh export: nothing untracked or left over in the repo's dist/ and node_modules/ gets in.
echo "packaging $TAG from $COMMIT with the dist/ in $ARTIFACT"
git -C "$REPO" archive HEAD | tar -x -C "$SRC"

# Of the artifact, only dist/ goes in.
cp -pR "$ARTIFACT/dist" "$STAGE/dist"
for file in package.json package-lock.json run-bot.sh run-server.sh; do cp -p "$SRC/$file" "$STAGE/"; done
mkdir "$STAGE/config" "$STAGE/scripts"
cp -pR "$SRC/config/agents" "$STAGE/config/agents"
cp -p "$SRC/scripts/healthcheck.sh" "$STAGE/scripts/"
printf 'tag=%s\ncommit=%s\npackaged=%s\n' "$TAG" "$COMMIT" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE/RELEASE"

mkdir -p "$OUT"
# COPYFILE_DISABLE keeps macOS tar from adding ._* metadata files.
(cd "$STAGE" && COPYFILE_DISABLE=1 tar -czf "$WORK/release.tgz" RELEASE dist package.json package-lock.json run-bot.sh run-server.sh config scripts)
mv "$WORK/release.tgz" "$TARBALL"
(cd "$OUT" && shasum -a 256 "wechat-bot-$TAG.tgz" > "wechat-bot-$TAG.tgz.sha256")

echo "release: $TARBALL"
echo "sha256:  $(cut -d ' ' -f 1 "$TARBALL.sha256")"
echo "next:    scripts/deploy.sh $TAG   # dry run"
