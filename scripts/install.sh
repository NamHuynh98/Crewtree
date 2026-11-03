#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Crewtree installer for macOS (PLAN.md 16.1). POSIX sh, no sudo, never touches ~/.claude.
#
#   curl -fsSL https://github.com/NamHuynh98/Crewtree/releases/latest/download/install.sh | sh
#
# Environment:
#   CREWTREE_VERSION       release tag to install (default: latest)
#   CREWTREE_INSTALL_DIR   versions folder (default: ~/.crewtree/app)
#   CREWTREE_MODIFY_PATH=1 add ~/.local/bin to your shell profile
#   CREWTREE_ARCHIVE       install from a local archive (with SHA256SUMS next to it) instead of downloading
#   NO_COLOR               plain output
set -eu

REPO="NamHuynh98/Crewtree"
CREWTREE_DIR="${CREWTREE_DIR:-$HOME/.crewtree}"
INSTALL_DIR="${CREWTREE_INSTALL_DIR:-$CREWTREE_DIR/app}"
BIN_DIR="$HOME/.local/bin"
STARTED=$(date +%s)

mkdir -p "$CREWTREE_DIR/logs"
LOG="$CREWTREE_DIR/logs/install-$(date +%Y%m%d-%H%M%S).log"
: >"$LOG"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  GREEN=$(printf '\033[32m'); RED=$(printf '\033[31m'); DIM=$(printf '\033[2m'); BOLD=$(printf '\033[1m'); RESET=$(printf '\033[0m')
else
  GREEN=""; RED=""; DIM=""; BOLD=""; RESET=""
fi

say() { printf '%s\n' "$*" | tee -a "$LOG"; }
ok() { printf '      %s✓%s %s\n' "$GREEN" "$RESET" "$*"; printf '  ok: %s\n' "$*" >>"$LOG"; }
die() {
  printf '      %s✕%s %s\n' "$RED" "$RESET" "$1" >&2
  [ -n "${2:-}" ] && printf '        %s\n' "$2" >&2
  printf 'error: %s %s\n' "$1" "${2:-}" >>"$LOG"
  printf '\n  Log: %s\n' "$LOG" >&2
  exit 1
}
step() { printf '\n  %s[%s/4]%s %s\n' "$BOLD" "$1" "$RESET" "$2"; printf '[%s/4] %s\n' "$1" "$2" >>"$LOG"; }

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else sha256sum "$1" | cut -d' ' -f1
  fi
}

say "${BOLD}Crewtree installer${RESET}"

# ------------------------------------------------------------------ 1. environment
step 1 "Checking environment"
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
  Darwin) OS=darwin ;;
  Linux) die "Linux and WSL are not supported yet" "Follow https://github.com/$REPO for Linux builds (planned)." ;;
  *) die "Unsupported system: $OS" "On Windows use install.ps1 in PowerShell." ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) die "Unsupported CPU: $ARCH" ;;
esac
ok "$OS-$ARCH"

command -v node >/dev/null 2>&1 || die "Node.js is not installed" "Install Node 22 LTS from https://nodejs.org and run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) is too old: Crewtree needs Node 22 or newer" "Install Node 22 LTS from https://nodejs.org"
ok "Node $(node -v)"
command -v npm >/dev/null 2>&1 || die "npm is missing" "It comes with Node.js; reinstall Node 22."

if command -v claude >/dev/null 2>&1; then
  ok "Claude Code $(claude --version 2>/dev/null | head -n1)"
elif [ -n "${CREWTREE_SKIP_CLAUDE_CHECK:-}" ]; then
  say "      ! Claude Code not found (check skipped)"
else
  die "Claude Code is not installed" "Install it (https://docs.claude.com/claude-code), run \`claude\` once to log in, then run this again."
fi

# ------------------------------------------------------------------ 2. download
step 2 "Downloading"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM
if [ -n "${CREWTREE_ARCHIVE:-}" ]; then
  [ -f "$CREWTREE_ARCHIVE" ] || die "Archive not found: $CREWTREE_ARCHIVE"
  NAME=$(basename "$CREWTREE_ARCHIVE")
  cp "$CREWTREE_ARCHIVE" "$TMP/$NAME"
  SUMS_SRC="$(dirname "$CREWTREE_ARCHIVE")/SHA256SUMS"
  [ -f "$SUMS_SRC" ] || die "SHA256SUMS not found next to the archive"
  cp "$SUMS_SRC" "$TMP/SHA256SUMS"
  VERSION=$(printf '%s' "$NAME" | sed -n 's/^crewtree-\(v[^-]*\(-[0-9A-Za-z.]*\)\{0,1\}\)-'"$OS-$ARCH"'\.tar\.gz$/\1/p')
  [ -n "$VERSION" ] || die "Unexpected archive name: $NAME"
  ok "local archive $NAME"
else
  if [ -n "${CREWTREE_VERSION:-}" ]; then
    VERSION=$(printf '%s' "$CREWTREE_VERSION" | sed 's/^v*/v/')
    BASE="https://github.com/$REPO/releases/download/$VERSION"
  else
    VERSION=$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest" 2>>"$LOG" \
      | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
    [ -n "$VERSION" ] || die "Could not find the latest release" "Check your connection, or set CREWTREE_VERSION=v0.1.0"
    BASE="https://github.com/$REPO/releases/download/$VERSION"
  fi
  NAME="crewtree-$VERSION-$OS-$ARCH.tar.gz"
  say "      $NAME"
  curl -fL --progress-bar -o "$TMP/$NAME" "$BASE/$NAME" || die "Download failed: $BASE/$NAME"
  curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" 2>>"$LOG" || die "SHA256SUMS is missing in the release" "Refusing to install an unverified download."
  ok "downloaded $VERSION"
fi

# ------------------------------------------------------------------ 3. verify & extract
step 3 "Verifying & extracting"
EXPECTED=$(grep " $NAME\$" "$TMP/SHA256SUMS" | cut -d' ' -f1 | head -n1)
[ -n "$EXPECTED" ] || die "$NAME is not listed in SHA256SUMS"
ACTUAL=$(sha256_of "$TMP/$NAME")
if [ "$EXPECTED" != "$ACTUAL" ]; then
  rm -f "$TMP/$NAME"
  die "Checksum mismatch: the download was deleted" "expected $EXPECTED, got $ACTUAL"
fi
ok "SHA256 OK"

TARGET="$INSTALL_DIR/$VERSION"
mkdir -p "$INSTALL_DIR"
tar -xzf "$TMP/$NAME" -C "$TMP" >>"$LOG" 2>&1 || die "Extracting failed"
EXTRACTED="$TMP/crewtree-$VERSION-$OS-$ARCH"
[ -f "$EXTRACTED/VERSION" ] || die "The archive is not a Crewtree bundle"
rm -rf "$TARGET.tmp"
mv "$EXTRACTED" "$TARGET.tmp"
# The Claude Agent SDK is not redistributed: npm installs the pinned version from the registry (see NOTICE)
say "      installing the Claude Agent SDK from npm…"
(cd "$TARGET.tmp" && npm install --omit=dev --no-audit --no-fund --loglevel=error) >>"$LOG" 2>&1 \
  || die "npm install of the Claude Agent SDK failed" "See the log; check your connection to registry.npmjs.org."
rm -rf "$TARGET"
mv "$TARGET.tmp" "$TARGET"
PREVIOUS=""
if [ -L "$INSTALL_DIR/current" ]; then PREVIOUS=$(basename "$(readlink "$INSTALL_DIR/current")"); fi
ln -sfn "$TARGET" "$INSTALL_DIR/current"
if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$VERSION" ]; then
  printf '{\n  "current": "%s",\n  "previous": "%s"\n}\n' "$VERSION" "$PREVIOUS" >"$INSTALL_DIR/versions.json"
else
  printf '{\n  "current": "%s"\n}\n' "$VERSION" >"$INSTALL_DIR/versions.json"
fi
ok "$TARGET"

# ------------------------------------------------------------------ 4. set up
step 4 "Setting up"
mkdir -p "$BIN_DIR"
ln -sfn "$INSTALL_DIR/current/bin/crewtree" "$BIN_DIR/crewtree"
ok "crewtree → $BIN_DIR/crewtree"

case ":$PATH:" in
  *":$BIN_DIR:"*) ok "$BIN_DIR is on PATH" ;;
  *)
    LINE='export PATH="$HOME/.local/bin:$PATH"'
    PROFILE="$HOME/.zshrc"
    case "${SHELL:-}" in */bash) PROFILE="$HOME/.bashrc" ;; esac
    if [ "${CREWTREE_MODIFY_PATH:-}" = "1" ]; then
      printf '\n# Crewtree\n%s\n' "$LINE" >>"$PROFILE"
      ok "added $BIN_DIR to PATH in $PROFILE (open a new terminal)"
    else
      say "      ${BOLD}Add this line to $PROFILE${RESET}, then open a new terminal:"
      say "        $LINE"
    fi
    ;;
esac

ELAPSED=$(( $(date +%s) - STARTED ))
say ""
say "  ${GREEN}✔ Crewtree $VERSION installed in ${ELAPSED}s${RESET}"
say "    Start it in a project folder:  ${BOLD}crewtree${RESET}"
say "    ${DIM}Log: $LOG${RESET}"
