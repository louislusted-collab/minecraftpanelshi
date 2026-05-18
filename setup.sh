#!/bin/bash
set -e
echo "=== Minecraft Panel Setup ==="

echo "[1/5] Installing system packages..."
sudo pacman -S --noconfirm nodejs npm jdk21-openjdk git curl unzip

echo "[2/5] Downloading PaperMC..."
mkdir -p minecraft
curl -L -o minecraft/paper-26.1.2-64.jar \
  "https://fill-data.papermc.io/v1/objects/830d4eb5c15cbd802a9ec9f2f54eaaaeb9511958339aec983fd0c88bad21d940/paper-26.1.2-64.jar"

echo "[3/5] Accepting EULA..."
echo "eula=true" > minecraft/eula.txt

echo "[4/5] Copying run.sh..."
cp run.sh minecraft/run.sh
chmod +x minecraft/run.sh

echo "[5/5] Installing Node.js panel dependencies..."
npm install

echo ""
echo "=== Setup complete ==="
echo "Your server local IP:"
ip addr show | grep "inet " | grep -v 127.0.0.1 | awk '{print $2}' | cut -d/ -f1
echo ""
echo "Start the panel: node server.js"
echo "Panel address: http://<your-ip>:3000"
