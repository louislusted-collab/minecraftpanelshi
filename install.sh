#!/bin/bash
set -e

# Colors
R='\033[0;31m' G='\033[0;32m' Y='\033[1;33m' B='\033[0;34m' C='\033[0;36m' W='\033[1;37m' N='\033[0m'

echo -e "${C}"
echo "  ███╗   ███╗ ██████╗    ██████╗  █████╗ ███╗   ██╗███████╗██╗"
echo "  ████╗ ████║██╔════╝    ██╔══██╗██╔══██╗████╗  ██║██╔════╝██║"
echo "  ██╔████╔██║██║         ██████╔╝███████║██╔██╗ ██║█████╗  ██║"
echo "  ██║╚██╔╝██║██║         ██╔═══╝ ██╔══██║██║╚██╗██║██╔══╝  ██║"
echo "  ██║ ╚═╝ ██║╚██████╗    ██║     ██║  ██║██║ ╚████║███████╗███████╗"
echo "  ╚═╝     ╚═╝ ╚═════╝    ╚═╝     ╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚══════╝"
echo -e "${N}"
echo -e "${W}  Minecraft Server Panel — Installer${N}"
echo ""

# ─── SUDO ────────────────────────────────────────────────────────────────────
echo -e "${Y}[?]${N} This script needs sudo for installing packages."
sudo -v
# Keep sudo alive in background
while true; do sudo -n true; sleep 50; done 2>/dev/null &
SUDO_KEEP=$!
trap "kill $SUDO_KEEP 2>/dev/null; exit" EXIT INT TERM

ok()   { echo -e "${G}[✓]${N} $1"; }
info() { echo -e "${B}[i]${N} $1"; }
warn() { echo -e "${Y}[!]${N} $1"; }
fail() { echo -e "${R}[✗]${N} $1"; exit 1; }
step() { echo ""; echo -e "${W}══ $1 ══${N}"; }

# ─── DETECT DISTRO ───────────────────────────────────────────────────────────
if command -v pacman &>/dev/null; then
  DISTRO="arch"
elif command -v apt-get &>/dev/null; then
  DISTRO="debian"
elif command -v dnf &>/dev/null; then
  DISTRO="fedora"
else
  warn "Unknown distro — will try to continue but package install may fail."
  DISTRO="unknown"
fi
info "Detected distro: $DISTRO"

install_pkg() {
  case $DISTRO in
    arch)   sudo pacman -S --noconfirm --needed "$@" ;;
    debian) sudo apt-get install -y "$@" ;;
    fedora) sudo dnf install -y "$@" ;;
    *)      warn "Can't auto-install $* — please install manually." ;;
  esac
}

# ─── CHECK & INSTALL: NODE.JS ─────────────────────────────────────────────────
step "Node.js"
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  ok "Node.js already installed: $NODE_VER"
else
  warn "Node.js not found — installing..."
  case $DISTRO in
    arch)   install_pkg nodejs npm ;;
    debian) install_pkg nodejs npm ;;
    fedora) install_pkg nodejs npm ;;
  esac
  ok "Node.js installed: $(node -v)"
fi

# ─── CHECK & INSTALL: JAVA 25 ────────────────────────────────────────────────
step "Java"

install_java21_sdkman() {
  info "Installing Java 21 via SDKMAN..."
  if [ ! -d "$HOME/.sdkman" ]; then
    curl -s "https://get.sdkman.io" | bash
  fi
  source "$HOME/.sdkman/bin/sdkman-init.sh"
  sdk install java 21-open </dev/null
  source "$HOME/.sdkman/bin/sdkman-init.sh"
}

java_version() { java -version 2>&1 | grep -oP '(?<=version ")[^"]+' | cut -d. -f1; }

if command -v java &>/dev/null; then
  JVER=$(java_version)
  if [ "${JVER:-0}" -ge 21 ] 2>/dev/null; then
    ok "Java $JVER already installed — meets requirement (21+)"
  else
    warn "Java $JVER found but Paper 1.20.4 requires Java 21+. Upgrading..."
    case $DISTRO in
      arch)
        if pacman -Si jdk21-openjdk &>/dev/null; then
          install_pkg jdk21-openjdk
          sudo archlinux-java set java-21-openjdk 2>/dev/null || true
        else
          install_java21_sdkman
        fi
        ;;
      debian) install_java21_sdkman ;;
      fedora) install_java21_sdkman ;;
      *)      install_java21_sdkman ;;
    esac
    ok "Java upgraded: $(java -version 2>&1 | head -1)"
  fi
else
  warn "Java not found — installing Java 21..."
  case $DISTRO in
    arch)
      if pacman -Si jdk21-openjdk &>/dev/null; then
        install_pkg jdk21-openjdk
        sudo archlinux-java set java-21-openjdk 2>/dev/null || true
      else
        install_java21_sdkman
      fi
      ;;
    debian) install_java21_sdkman ;;
    fedora) install_java21_sdkman ;;
    *)      install_java21_sdkman ;;
  esac
  ok "Java installed: $(java -version 2>&1 | head -1)"
fi

# Make sure java is on PATH if installed via sdkman
[ -f "$HOME/.sdkman/bin/sdkman-init.sh" ] && source "$HOME/.sdkman/bin/sdkman-init.sh"

# ─── CHECK & INSTALL: CURL, UNZIP ────────────────────────────────────────────
step "Utilities"
for tool in curl unzip; do
  if command -v $tool &>/dev/null; then
    ok "$tool already installed"
  else
    warn "$tool not found — installing..."
    install_pkg $tool
    ok "$tool installed"
  fi
done

# ─── PANEL DIRECTORY ─────────────────────────────────────────────────────────
step "Panel directory"
PANEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
info "Panel dir: $PANEL_DIR"

# ─── MINECRAFT DIRECTORY ─────────────────────────────────────────────────────
step "Minecraft server directory"
DEFAULT_MC="$HOME/mc-panel/minecraft"

echo -e "${Y}[?]${N} Where should the Minecraft server live?"
echo -e "    Default: ${W}$DEFAULT_MC${N}"
read -rp "    Press Enter to use default, or type a path: " MC_INPUT
MC_DIR="${MC_INPUT:-$DEFAULT_MC}"
mkdir -p "$MC_DIR"
ok "Minecraft dir: $MC_DIR"

# ─── PAPERMC JAR ─────────────────────────────────────────────────────────────
step "PaperMC"
MC_VERSION="1.21.1"
info "Fetching latest Paper build for $MC_VERSION..."
LATEST_BUILD=$(curl -s "https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION" | grep -oP '"builds":\[.*?\]' | grep -oP '\d+' | tail -1)
if [ -z "$LATEST_BUILD" ]; then fail "Could not fetch Paper build info. Check your internet connection."; fi
JAR_NAME="paper-$MC_VERSION-$LATEST_BUILD.jar"
JAR_PATH="$MC_DIR/$JAR_NAME"
JAR_URL="https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION/builds/$LATEST_BUILD/downloads/$JAR_NAME"
info "Latest build: $LATEST_BUILD"

if [ -f "$JAR_PATH" ]; then
  ok "PaperMC already downloaded: $JAR_PATH"
else
  info "Downloading $JAR_NAME..."
  curl -L --progress-bar -o "$JAR_PATH" "$JAR_URL"
  ok "Downloaded: $JAR_PATH"
fi

# ─── EULA ────────────────────────────────────────────────────────────────────
step "Minecraft EULA"
EULA="$MC_DIR/eula.txt"
if [ -f "$EULA" ] && grep -q "eula=true" "$EULA"; then
  ok "EULA already accepted"
else
  echo ""
  echo -e "${Y}  By running a Minecraft server you agree to Mojang's EULA:${N}"
  echo -e "  ${B}https://aka.ms/MinecraftEULA${N}"
  echo ""
  read -rp "  Do you accept the EULA? [y/N] " EULA_ACCEPT
  if [[ "$EULA_ACCEPT" =~ ^[Yy]$ ]]; then
    echo "eula=true" > "$EULA"
    ok "EULA accepted"
  else
    fail "EULA not accepted — cannot continue."
  fi
fi

# ─── RUN.SH ──────────────────────────────────────────────────────────────────
step "Server run script"
cp "$PANEL_DIR/run.sh" "$MC_DIR/run.sh"
chmod +x "$MC_DIR/run.sh"
ok "run.sh copied to $MC_DIR"

# ─── NPM DEPS ────────────────────────────────────────────────────────────────
step "Node.js panel dependencies"
cd "$PANEL_DIR"
if [ -d node_modules ]; then
  ok "node_modules already exists — skipping"
else
  npm install
  ok "Dependencies installed"
fi

# ─── UPDATE server.js CONFIG ─────────────────────────────────────────────────
step "Configuring panel"
ESCAPED=$(printf '%s\n' "$MC_DIR" | sed 's/[\/&]/\\&/g')
sed -i "s|const MC_DIR = '.*';|const MC_DIR = '$ESCAPED';|" "$PANEL_DIR/server.js"
sed -i "s|const MC_JAR = '.*';|const MC_JAR = '$JAR_NAME';|" "$PANEL_DIR/server.js"
ok "MC_DIR set to: $MC_DIR"
ok "MC_JAR set to: $JAR_NAME"

# ─── SUMMARY ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${G}╔════════════════════════════════════════╗${N}"
echo -e "${G}║        Setup complete! 🎉               ║${N}"
echo -e "${G}╚════════════════════════════════════════╝${N}"
echo ""
echo -e "${W}  Minecraft dir:${N} $MC_DIR"
echo -e "${W}  Panel dir:${N}     $PANEL_DIR"
echo ""
echo -e "${W}  Your local IPs:${N}"
ip addr show | grep "inet " | grep -v 127.0.0.1 | awk '{print "    " $2}' | cut -d/ -f1
echo ""
echo -e "${Y}  ──────────────────────────────────────${N}"
echo -e "${W}  To start everything:${N}"
echo ""
echo -e "    ${C}cd $PANEL_DIR && node server.js${N}"
echo ""
echo -e "${W}  Then open:${N} ${B}http://localhost:3000${N}"
echo -e "${Y}  ──────────────────────────────────────${N}"
echo ""

# ─── OPTIONAL: START NOW ─────────────────────────────────────────────────────
read -rp "  Start the panel now? [Y/n] " START_NOW
if [[ ! "$START_NOW" =~ ^[Nn]$ ]]; then
  echo ""
  echo -e "${G}  Starting panel...${N}"
  cd "$PANEL_DIR"
  node server.js
fi
