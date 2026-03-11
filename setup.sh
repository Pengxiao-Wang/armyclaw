#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# ArmyClaw — One-click Setup Script
# ═══════════════════════════════════════════════════════════

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}   $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }

echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════╗"
echo "  ║        ArmyClaw Setup             ║"
echo "  ║   Deploy your AI army with        ║"
echo "  ║         one click                 ║"
echo "  ╚═══════════════════════════════════╝"
echo -e "${NC}"

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
    warn "Xcode CLT not found. better-sqlite3 needs C++ compilation."
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

# ─── 4. Set up .env ───────────────────────────────────────

if [ ! -f .env ]; then
  info "No .env file found. Creating from template..."

  if [ -f .env.example ]; then
    cp .env.example .env
  else
    echo "ANTHROPIC_API_KEY=" > .env
  fi

  # Interactive prompt for API key
  echo ""
  echo -e "${YELLOW}An Anthropic API key is required.${NC}"
  echo "Get one at: https://console.anthropic.com"
  echo ""
  read -sp "Enter your ANTHROPIC_API_KEY (input hidden): " api_key
  echo ""

  if [ -n "$api_key" ]; then
    # Use sed to replace the key in .env
    if [[ "$(uname)" == "Darwin" ]]; then
      sed -i '' "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${api_key}|" .env
    else
      sed -i "s|^ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${api_key}|" .env
    fi
    ok "API key saved to .env"
  else
    warn "No API key provided. Edit .env manually before running."
  fi
else
  ok ".env already exists"
fi

# ─── 5. Create data directory ─────────────────────────────

mkdir -p data
ok "data/ directory ready"

# ─── 6. Type check ────────────────────────────────────────

info "Running TypeScript type check..."
if npx tsc --noEmit; then
  ok "Type check passed (0 errors)"
else
  fail "TypeScript errors found. Fix them before running."
fi

# ─── 7. Run tests ─────────────────────────────────────────

info "Running tests..."
if npm test; then
  ok "All tests passed"
else
  fail "Some tests failed. Check output above."
fi

# ─── 8. Done ──────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}Setup complete!${NC}"
echo ""
echo "Start ArmyClaw:"
echo ""
echo -e "  ${CYAN}# Terminal 1: HQ (Orchestrator)${NC}"
echo "  npm run dev"
echo ""
echo -e "  ${CYAN}# Terminal 2: War Room (Sand Table)${NC}"
echo "  npm run dev:war-room"
echo ""
echo -e "  ${CYAN}# Open Sand Table dashboard${NC}"
echo "  open http://localhost:3939"
echo ""
