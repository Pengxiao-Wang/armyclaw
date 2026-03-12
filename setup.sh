#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# ArmyClaw — Pre-flight + Setup Wizard Bootstrap
# Phase 1: Bash pre-flight (Node.js, Xcode CLT, npm install)
# Phase 2: exec to TypeScript wizard for interactive config
# ═══════════════════════════════════════════════════════════

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

# ─── 1. Check Node.js ≥ 20 ────────────────────────────────

info "Checking Node.js..."
if ! command -v node &> /dev/null; then
  fail "Node.js not found. Install it via:
  brew install node     (Homebrew)
  nvm install 20        (nvm)
  https://nodejs.org    (official installer)"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  fail "Node.js ≥ 20 required (found v$(node -v)).
  Update via: brew upgrade node / nvm install 20"
fi
ok "Node.js $(node -v)"

# ─── 2. Check Xcode CLT (macOS) ───────────────────────────

if [[ "$(uname)" == "Darwin" ]]; then
  info "Checking Xcode Command Line Tools..."
  if ! xcode-select -p &> /dev/null; then
    echo -e "${YELLOW}[WARN]${NC} Xcode CLT not found. better-sqlite3 needs C++ compilation."
    echo "  Run: xcode-select --install"
    echo "  Then re-run this script."
    exit 1
  fi
  ok "Xcode CLT installed"
fi

# ─── 3. Install dependencies ──────────────────────────────

info "Installing npm dependencies..."
npm install
ok "Dependencies installed"

# ─── 4. Ensure data directory ─────────────────────────────

mkdir -p data

# ─── 5. Hand off to TypeScript wizard ─────────────────────

exec npx tsx src/setup/wizard.ts "$@"
