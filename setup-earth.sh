#!/bin/bash
set -e
G='\033[0;32m' Y='\033[1;33m' R='\033[0;31m' W='\033[1;37m' N='\033[0m'

ok()   { echo -e "${G}[✓]${N} $1"; }
info() { echo -e "${Y}[i]${N} $1"; }
fail() { echo -e "${R}[✗]${N} $1"; exit 1; }

MC_DIR="$HOME/mc-panel/minecraft"
SETUP_URL="https://files.catbox.moe/0apud1.zip"
TMP="/tmp/earth-setup"

echo -e "${W}=== Earth SMP Setup ===${N}"
echo ""

# ─── STOP SERVERS ────────────────────────────────────────────────────────────
info "Stopping any running servers..."
pkill -f "node server.js" 2>/dev/null || true
pkill -f "java" 2>/dev/null || true
sleep 2
ok "Stopped"

# ─── DOWNLOAD SETUP ZIP ──────────────────────────────────────────────────────
info "Downloading Earth SMP setup..."
rm -rf "$TMP" && mkdir -p "$TMP"
curl -L --progress-bar -o "$TMP/setup.zip" "$SETUP_URL"
ok "Downloaded"

# ─── EXTRACT ─────────────────────────────────────────────────────────────────
info "Extracting..."
unzip -q "$TMP/setup.zip" -d "$TMP/extracted"
ok "Extracted"

# Find the server folder inside the zip
SERVER_DIR=$(find "$TMP/extracted" -name "server.properties" | head -1 | xargs dirname)
if [ -z "$SERVER_DIR" ]; then
  fail "Could not find server folder in zip"
fi
info "Found server folder: $SERVER_DIR"

# ─── WIPE OLD DATA ───────────────────────────────────────────────────────────
info "Wiping old world and plugins..."
rm -rf "$MC_DIR/plugins"
rm -rf "$MC_DIR/world" "$MC_DIR/world_nether" "$MC_DIR/world_the_end"
rm -rf "$MC_DIR/spawn" "$MC_DIR/playworld_nether" "$MC_DIR/playworld_the_end" "$MC_DIR/mining"
ok "Wiped"

# ─── COPY SETUP FILES ────────────────────────────────────────────────────────
info "Copying plugins..."
[ -d "$SERVER_DIR/plugins" ] && cp -r "$SERVER_DIR/plugins" "$MC_DIR/"
ok "Plugins copied"

info "Copying worlds..."
for world in spawn playworld_nether playworld_the_end mining world world_nether world_the_end; do
  [ -d "$SERVER_DIR/$world" ] && cp -r "$SERVER_DIR/$world" "$MC_DIR/" && info "  Copied: $world"
done
ok "Worlds copied"

info "Copying config files..."
for f in server.properties bukkit.yml spigot.yml paper.yml; do
  [ -f "$SERVER_DIR/$f" ] && cp "$SERVER_DIR/$f" "$MC_DIR/" && info "  Copied: $f"
done
ok "Config copied"

# Copy server icon if exists
[ -f "$SERVER_DIR/server-icon.png" ] && cp "$SERVER_DIR/server-icon.png" "$MC_DIR/"

# ─── PAPER 1.21.1 JAR ────────────────────────────────────────────────────────
info "Fetching latest Paper 1.21.1 build..."
BUILD=$(curl -s "https://api.papermc.io/v2/projects/paper/versions/1.21.1" | grep -oP '"builds":\[.*?\]' | grep -oP '\d+' | tail -1)
if [ -z "$BUILD" ]; then fail "Could not fetch Paper build info"; fi
JAR="paper-1.21.1-$BUILD.jar"
JAR_PATH="$MC_DIR/$JAR"

if [ -f "$JAR_PATH" ]; then
  ok "Paper 1.21.1 already downloaded"
else
  info "Downloading Paper 1.21.1 build $BUILD..."
  curl -L --progress-bar -o "$JAR_PATH" "https://api.papermc.io/v2/projects/paper/versions/1.21.1/builds/$BUILD/downloads/$JAR"
  ok "Downloaded $JAR"
fi

# ─── UPDATE PANEL CONFIG ─────────────────────────────────────────────────────
info "Updating panel jar name..."
PANEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sed -i "s|const MC_JAR = '.*';|const MC_JAR = '$JAR';|" "$PANEL_DIR/server.js"
ok "Panel updated"

# ─── EULA ────────────────────────────────────────────────────────────────────
echo "eula=true" > "$MC_DIR/eula.txt"
ok "EULA accepted"

# ─── CLEANUP ─────────────────────────────────────────────────────────────────
rm -rf "$TMP"
ok "Cleaned up temp files"

echo ""
echo -e "${G}=== Done! ===${N}"
echo ""
echo -e "${W}Start the panel:${N} node server.js"
echo -e "${W}Then hit Start in the panel.${N}"
echo ""

# ─── START PANEL ─────────────────────────────────────────────────────────────
read -rp "Start the panel now? [Y/n] " START
if [[ ! "$START" =~ ^[Nn]$ ]]; then
  cd "$PANEL_DIR"
  node server.js
fi
