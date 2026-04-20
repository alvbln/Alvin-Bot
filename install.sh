#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Alvin Bot — One-Line Installer
# Usage: curl -fsSL https://install.alvin-bot.dev | bash
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m' # No Color

INSTALL_DIR="$HOME/.alvin-bot"
REPO_URL="https://github.com/alvbln/alvin-bot.git"
BIN_LINK="/usr/local/bin/alvin-bot"
MIN_NODE_VERSION=18

# ─── Helpers ────────────────────────────────────────────────

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✔${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✘${NC}  $*"; exit 1; }

# ─── OS Detection ──────────────────────────────────────────

detect_os() {
  case "$(uname -s)" in
    Darwin*)  OS="macOS" ;;
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        OS="WSL"
      else
        OS="Linux"
      fi
      ;;
    *)        fail "Unsupported OS: $(uname -s). Use macOS, Linux, or WSL." ;;
  esac
  ok "Detected OS: ${BOLD}$OS${NC}"
}

# ─── Dependency Checks ─────────────────────────────────────

check_git() {
  if ! command -v git &>/dev/null; then
    fail "Git is not installed. Please install git first:
    macOS:  xcode-select --install
    Linux:  sudo apt install git  (or yum/pacman equivalent)
    WSL:    sudo apt install git"
  fi
  ok "Git found: $(git --version)"
}

check_node() {
  if ! command -v node &>/dev/null; then
    fail "Node.js is not installed (>= $MIN_NODE_VERSION required).
    Install via: https://nodejs.org or
    macOS:  brew install node@22
    Linux:  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
  fi

  local node_ver
  node_ver=$(node -v | sed 's/^v//' | cut -d. -f1)
  if [ "$node_ver" -lt "$MIN_NODE_VERSION" ]; then
    fail "Node.js >= $MIN_NODE_VERSION required, but found v$(node -v). Please upgrade."
  fi
  ok "Node.js found: $(node -v)"
}

check_npm() {
  if ! command -v npm &>/dev/null; then
    fail "npm is not installed. It should come with Node.js — please reinstall Node."
  fi
  ok "npm found: $(npm -v)"
}

# ─── Installation ──────────────────────────────────────────

install_bot() {
  if [ -d "$INSTALL_DIR" ]; then
    warn "Existing installation found at $INSTALL_DIR"
    info "Updating..."
    cd "$INSTALL_DIR"
    git pull --ff-only || fail "Git pull failed. Resolve conflicts manually in $INSTALL_DIR"
  else
    info "Cloning alvin-bot to $INSTALL_DIR..."
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" || fail "Git clone failed. Check your network."
    cd "$INSTALL_DIR"
  fi

  info "Installing production dependencies..."
  npm install --omit=dev || fail "npm install failed."

  info "Building TypeScript..."
  npm run build || fail "Build failed."

  ok "Installation complete!"
}

create_symlink() {
  local bin_dir
  bin_dir=$(dirname "$BIN_LINK")

  # Make CLI executable
  chmod +x "$INSTALL_DIR/bin/cli.js"

  # Try /usr/local/bin first, fall back to ~/.local/bin
  if [ -w "$bin_dir" ] || [ -w "$BIN_LINK" ] 2>/dev/null; then
    ln -sf "$INSTALL_DIR/bin/cli.js" "$BIN_LINK"
    ok "Symlinked: alvin-bot → $BIN_LINK"
  elif command -v sudo &>/dev/null; then
    info "Creating symlink (requires sudo)..."
    sudo ln -sf "$INSTALL_DIR/bin/cli.js" "$BIN_LINK"
    ok "Symlinked: alvin-bot → $BIN_LINK"
  else
    # Fallback: ~/.local/bin
    local fallback="$HOME/.local/bin"
    mkdir -p "$fallback"
    ln -sf "$INSTALL_DIR/bin/cli.js" "$fallback/alvin-bot"
    warn "Symlinked to $fallback/alvin-bot (add to PATH if not already)"
    warn "  export PATH=\"$fallback:\$PATH\""
    BIN_LINK="$fallback/alvin-bot"
  fi
}

# ─── Main ──────────────────────────────────────────────────

main() {
  echo ""
  echo -e "${BOLD}🦊 Alvin Bot Installer${NC}"
  echo -e "─────────────────────────────────────"
  echo ""

  detect_os
  check_git
  check_node
  check_npm

  echo ""
  install_bot
  create_symlink

  echo ""
  echo -e "─────────────────────────────────────"
  echo -e "${GREEN}${BOLD}🎉 Alvin Bot installed successfully!${NC}"
  echo ""
  echo -e "  Next steps:"
  echo -e "    ${BOLD}alvin-bot setup${NC}    — Configure your bot (interactive)"
  echo -e "    ${BOLD}alvin-bot start${NC}    — Start the bot"
  echo -e "    ${BOLD}alvin-bot --help${NC}   — Show all commands"
  echo ""
  echo -e "  Installed to: ${BLUE}$INSTALL_DIR${NC}"
  echo -e "  Command:      ${BLUE}$BIN_LINK${NC}"
  echo ""

  # Run interactive setup
  info "Starting setup wizard..."
  echo ""
  alvin-bot setup || warn "Setup skipped. Run 'alvin-bot setup' later to configure."
}

main "$@"
