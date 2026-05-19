#!/bin/bash
set -e
G='\033[0;32m' Y='\033[1;33m' R='\033[0;31m' W='\033[1;37m' N='\033[0m'
ok()   { echo -e "${G}[✓]${N} $1"; }
info() { echo -e "${Y}[i]${N} $1"; }
fail() { echo -e "${R}[✗]${N} $1"; exit 1; }

MC_DIR="$HOME/mc-panel/minecraft"
PANEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${W}=== MC Panel Fresh Setup ===${N}"
echo ""

# ─── STOP SERVERS ────────────────────────────────────────────────────────────
info "Stopping any running servers..."
pkill -f "node server.js" 2>/dev/null || true
pkill -f "java" 2>/dev/null || true
sleep 1
ok "Stopped"

# ─── INSTALL JAVA IF MISSING ─────────────────────────────────────────────────
if ! command -v java &>/dev/null; then
  info "Java not found — installing..."
  sudo pacman -S --noconfirm jdk21-openjdk
  ok "Java installed"
else
  ok "Java found: $(java -version 2>&1 | head -1)"
fi

# ─── INSTALL NODE DEPS ───────────────────────────────────────────────────────
info "Installing panel dependencies..."
cd "$PANEL_DIR"
npm install --silent
ok "Dependencies installed"

# ─── CREATE MC DIR ───────────────────────────────────────────────────────────
info "Creating server directory at $MC_DIR ..."
mkdir -p "$MC_DIR"
ok "Directory ready"

# ─── DOWNLOAD PAPER 1.21.1 ───────────────────────────────────────────────────
info "Fetching latest Paper 1.21.1 build..."
BUILD=$(curl -s "https://api.papermc.io/v2/projects/paper/versions/1.21.1" | grep -oP '"builds":\[.*?\]' | grep -oP '\d+' | tail -1)
[ -z "$BUILD" ] && fail "Could not fetch Paper build info"
JAR="paper-1.21.1-$BUILD.jar"
JAR_PATH="$MC_DIR/$JAR"

if [ -f "$JAR_PATH" ]; then
  ok "Paper 1.21.1 build $BUILD already downloaded"
else
  info "Downloading Paper 1.21.1 build $BUILD..."
  curl -L --progress-bar -o "$JAR_PATH" "https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/$BUILD/downloads/$JAR"
  ok "Downloaded $JAR"
fi

# ─── EULA ────────────────────────────────────────────────────────────────────
echo "eula=true" > "$MC_DIR/eula.txt"
ok "EULA accepted"

# ─── UPDATE PANEL JAR NAME ───────────────────────────────────────────────────
sed -i "s|const MC_JAR = '.*';|const MC_JAR = '$JAR';|" "$PANEL_DIR/server.js"
ok "Panel updated to use $JAR"

echo ""
echo -e "${G}=== Done! ===${N}"
echo ""
echo -e "${W}Start the panel:${N} node server.js"
echo -e "${W}Then hit Start in the panel at http://localhost:3000${N}"
echo ""

read -rp "Start the panel now? [Y/n] " START
if [[ ! "$START" =~ ^[Nn]$ ]]; then
  cd "$PANEL_DIR"
  node server.js
fi
