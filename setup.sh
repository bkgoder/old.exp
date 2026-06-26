#!/bin/bash
# Zero-Token TTS — Fresh System Setup Script
# Installiert Dependencies, baut Extension, startet Docker,
# trägt MCP-Server ein und deployt Skills zu allen Agents.

set -e

NODE_REQUIRED_MAJOR=18
NODE_INSTALL_MAJOR=22
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEVCONTAINER_MODE=0

for ARG in "$@"; do
    case "$ARG" in
        --devcontainer)
            DEVCONTAINER_MODE=1
            ;;
    esac
done

load_nvm() {
    if [ -s "$NVM_DIR/nvm.sh" ]; then
        # shellcheck disable=SC1090
        . "$NVM_DIR/nvm.sh"
        return 0
    fi

    if ! command -v curl &> /dev/null; then
        echo "❌ curl ist nicht installiert."
        echo "   Bitte curl installieren oder nvm manuell einrichten."
        exit 1
    fi

    echo "⬇️  Installiere nvm..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        echo "❌ nvm konnte nicht installiert werden."
        exit 1
    fi

    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
}

ensure_node() {
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge "$NODE_REQUIRED_MAJOR" ]; then
            echo "✅ Node.js $(node -v) gefunden"
            return 0
        fi

        echo "⚠️  Node.js $(node -v) ist zu alt. Installiere Node.js ${NODE_INSTALL_MAJOR} via nvm..."
    else
        echo "⚠️  Node.js ist nicht installiert. Installiere Node.js ${NODE_INSTALL_MAJOR} via nvm..."
    fi

    load_nvm
    nvm install "$NODE_INSTALL_MAJOR"
    nvm use "$NODE_INSTALL_MAJOR"
    nvm alias default "$NODE_INSTALL_MAJOR" >/dev/null
    echo "✅ Node.js $(node -v) via nvm aktiviert"
}

ensure_docker() {
    if command -v docker &> /dev/null; then
        echo "✅ Docker $(docker --version | cut -d' ' -f3 | tr -d ',') gefunden"
        return 0
    fi

    echo "🐳 Docker nicht gefunden — installiere Docker..."

    # Detect OS
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS_ID="${ID:-linux}"
    else
        OS_ID="linux"
    fi

    case "$OS_ID" in
        ubuntu|debian)
            echo "   📦 Installiere Docker für $OS_ID..."
            sudo apt-get update -qq
            sudo apt-get install -y -qq ca-certificates curl gnupg lsb-release

            # Add Docker's official GPG key
            sudo install -m 0755 -d /etc/apt/keyrings
            curl -fsSL https://download.docker.com/linux/$OS_ID/gpg | sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
            sudo chmod a+r /etc/apt/keyrings/docker.gpg

            # Add Docker repository
            echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$OS_ID $(lsb_release -cs) stable" | \
                sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

            sudo apt-get update -qq
            sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

            # Add user to docker group (no sudo required in future)
            sudo usermod -aG docker "$USER" 2>/dev/null || true

            # Start Docker daemon
            sudo systemctl enable docker 2>/dev/null || true
            sudo systemctl start docker 2>/dev/null || true

            # Fallback: use newgrp or sg to apply group
            if ! docker ps &>/dev/null; then
                echo "   ℹ️  Docker-Gruppe gesetzt — verwende 'newgrp docker' oder neu einloggen."
                # Run with sudo for this session
                DOCKER_CMD="sudo docker"
            fi

            echo "✅ Docker installiert"
            ;;

        fedora|rhel|centos)
            echo "   📦 Installiere Docker für $OS_ID..."
            sudo dnf -y install dnf-plugins-core
            sudo dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
            sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            sudo systemctl enable docker && sudo systemctl start docker
            sudo usermod -aG docker "$USER" 2>/dev/null || true
            echo "✅ Docker installiert"
            ;;

        arch|manjaro)
            echo "   📦 Installiere Docker für $OS_ID..."
            sudo pacman -Sy --noconfirm docker docker-compose
            sudo systemctl enable docker && sudo systemctl start docker
            sudo usermod -aG docker "$USER" 2>/dev/null || true
            echo "✅ Docker installiert"
            ;;

        darwin)
            echo "   ⚠️  macOS erkannt. Bitte installiere Docker Desktop:"
            echo "   https://docs.docker.com/desktop/mac/"
            echo "   Danach 'bash setup.sh' erneut ausführen."
            exit 1
            ;;

        *)
            echo "   ⚠️  Unbekanntes OS: $OS_ID"
            echo "   Bitte Docker manuell installieren: https://docs.docker.com/get-docker/"
            exit 1
            ;;
    esac
}

ensure_docker_compose() {
    # docker compose (plugin, v2) — preferred
    if docker compose version &>/dev/null 2>&1; then
        echo "✅ Docker Compose v2 (Plugin) gefunden"
        return 0
    fi

    # docker-compose (standalone, v1 fallback)
    if command -v docker-compose &>/dev/null; then
        echo "✅ Docker Compose v1 gefunden"
        # Alias so rest of script works
        docker() { if [ "$1" = "compose" ]; then shift; command docker-compose "$@"; else command docker "$@"; fi; }
        export -f docker 2>/dev/null || true
        return 0
    fi

    echo "⬇️  Installiere Docker Compose Plugin..."
    if command -v apt-get &>/dev/null; then
        sudo apt-get install -y -qq docker-compose-plugin 2>/dev/null || \
            sudo apt-get install -y -qq docker-compose 2>/dev/null || true
    elif command -v dnf &>/dev/null; then
        sudo dnf -y install docker-compose-plugin 2>/dev/null || true
    fi

    if docker compose version &>/dev/null 2>&1; then
        echo "✅ Docker Compose Plugin installiert"
    else
        # Manual install as last resort
        COMPOSE_VERSION="v2.27.1"
        COMPOSE_ARCH="$(uname -m)"
        [ "$COMPOSE_ARCH" = "x86_64" ] && COMPOSE_ARCH="x86_64"
        [ "$COMPOSE_ARCH" = "aarch64" ] && COMPOSE_ARCH="aarch64"
        COMPOSE_URL="https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}"
        echo "   ⬇️  Lade Docker Compose ${COMPOSE_VERSION} herunter..."
        sudo curl -fsSL "$COMPOSE_URL" -o /usr/local/lib/docker/cli-plugins/docker-compose 2>/dev/null || \
            sudo curl -fsSL "$COMPOSE_URL" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/lib/docker/cli-plugins/docker-compose 2>/dev/null || \
            sudo chmod +x /usr/local/bin/docker-compose
        echo "✅ Docker Compose manuell installiert"
    fi
}

echo "🚀 Zero-Token TTS — Fresh System Setup"
echo "========================================"
echo ""

# 1. Node.js prüfen
ensure_node

# 2. npm prüfen
if ! command -v npm &> /dev/null; then
    echo "❌ npm ist nicht installiert."
    exit 1
fi
echo "✅ npm $(npm -v) gefunden"

# 3. Git prüfen
if ! command -v git &> /dev/null; then
    echo "❌ Git ist nicht installiert."
    echo "   Installiere Git..."
    sudo apt-get update && sudo apt-get install -y git
fi
echo "✅ Git $(git --version | cut -d' ' -f3) gefunden"

# 4. Docker installieren (falls nicht vorhanden)
echo ""
if [ "$DEVCONTAINER_MODE" -eq 1 ]; then
    echo "🐳 Dev-Container erkannt — Docker-Schritt wird übersprungen"
else
    echo "🐳 Prüfe Docker..."
    ensure_docker
    ensure_docker_compose
fi

# 5. VS Code prüfen
if ! command -v code &> /dev/null; then
    echo "⚠️  VS Code CLI 'code' nicht gefunden."
    echo "   Bitte installieren Sie VS Code von https://code.visualstudio.com/"
    echo "   und aktivieren Sie die CLI mit 'Shell Command: Install code in PATH'"
fi

# 6. Dependencies installieren
echo ""
echo "📦 Installiere Dependencies..."
npm install

# 7. Extension bauen
echo ""
echo "🔨 Baue Extension..."
npm run build

# 8. VSIX paketieren
echo ""
echo "📦 Paketiere Extension..."
npm run package

# 9. Docker-Container starten
echo ""
if [ "$DEVCONTAINER_MODE" -eq 1 ]; then
    echo "🐳 Dev-Container-Modus — Docker-Start wird übersprungen"
else
    echo "🐳 Starte Docker-Container..."
    cd "$SCRIPT_DIR"
    if docker compose ps 2>/dev/null | grep -q "zero-token-tts"; then
        echo "✅ Docker-Container läuft bereits"
    else
        echo "⬆️  Starte zero-token-tts Container..."
        docker compose up -d --build
        echo -n "⏳ Warte auf Health-Check"
        for i in $(seq 1 30); do
            sleep 2
            STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:18765/health 2>/dev/null || echo "0")
            if [ "$STATUS" = "200" ]; then
                echo ""
                echo "✅ Docker-Container ist bereit (Port 18765)"
                break
            fi
            echo -n "."
            if [ "$i" = "30" ]; then
                echo ""
                echo "⚠️  Container startet noch — bitte warten und erneut prüfen:"
                echo "   docker logs zero-token-tts"
            fi
        done
    fi
fi

# 9. MCP-Server in VS Code eintragen
deploy_mcp() {
  local TARGET="$1"
  local MCP_JSON
    MCP_JSON='{"mcpServers":{"tts-skill":{"type":"sse","url":"http://localhost:18764/sse"}},"servers":{"tts-skill":{"type":"sse","url":"http://localhost:18764/sse"}}}'

  mkdir -p "$(dirname "$TARGET")"
  if [ -f "$TARGET" ]; then
    # Merge: füge tts-Server hinzu ohne bestehende Einträge zu löschen
    python3 - "$TARGET" "$MCP_JSON" <<'PYEOF'
import sys, json
target, new_entry = sys.argv[1], json.loads(sys.argv[2])
try:
    with open(target) as f:
        data = json.load(f)
except Exception:
    data = {}
data.setdefault("servers", {}).update(new_entry["servers"])
data.setdefault("mcpServers", {}).update(new_entry["mcpServers"])
with open(target, "w") as f:
    json.dump(data, f, indent=2)
print(f"  ✅ MCP aktualisiert: {target}")
PYEOF
  else
    echo "$MCP_JSON" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin),indent=2))" > "$TARGET"
    echo "  ✅ MCP erstellt: $TARGET"
  fi
}

echo ""
echo "🔌 Trage MCP-Server ein..."

# Workspace .vscode/mcp.json
deploy_mcp "$SCRIPT_DIR/.vscode/mcp.json"

# Globale VS Code User-Settings
VSCODE_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/Code/User"
[ ! -d "$VSCODE_USER_DIR" ] && VSCODE_USER_DIR="$HOME/.vscode-remote/data/User"
if [ -d "$VSCODE_USER_DIR" ]; then
  deploy_mcp "$VSCODE_USER_DIR/mcp.json"
fi

# 10. TTS-Skill zu Agents deployen
deploy_skill() {
  local DEST="$1"
  mkdir -p "$(dirname "$DEST")"
  cp "$SCRIPT_DIR/skills/tts-de/SKILL.md" "$DEST"
  echo "  ✅ Skill deployed: $DEST"
}

echo ""
echo "🤖 Deploye TTS-Skill zu Agents..."

# Standarderkennbarer Skill-Pfad für VS Code/Copilot
deploy_skill "$SCRIPT_DIR/.github/skills/tts-de/SKILL.md"

# Workspace Copilot Instructions
deploy_skill "$SCRIPT_DIR/.github/copilot-instructions.md"

# VS Code .instructions.md
deploy_skill "$SCRIPT_DIR/.vscode/tts-de.instructions.md"

# 11. Extension installieren (falls code CLI verfügbar)
echo ""
VSIX_FILE=$(ls "$SCRIPT_DIR"/zero-token-explotion-*.vsix "$SCRIPT_DIR"/zero-token-tts-*.vsix 2>/dev/null | tail -1)
if [ -n "$VSIX_FILE" ] && command -v code &> /dev/null; then
  echo "📥 Installiere Extension..."
  code --install-extension "$VSIX_FILE" --force
  echo "✅ Extension installiert: $(basename "$VSIX_FILE")"
else
  echo "📋 Extension manuell installieren:"
  echo "   code --install-extension $(ls "$SCRIPT_DIR"/*.vsix 2>/dev/null | tail -1 | xargs basename 2>/dev/null || echo 'zero-token-tts-*.vsix')"
fi

# 12. Fertig
echo ""
echo "========================================"
echo "✅ Setup abgeschlossen!"
echo ""
echo "Was wurde eingerichtet:"
echo "  🐳 Docker-Container: docker compose up -d"
echo "  🔌 MCP-Server:       .vscode/mcp.json + User/mcp.json"
echo "  🤖 TTS-Skill:        .github/copilot-instructions.md"
echo "  📦 Extension:        $(ls "$SCRIPT_DIR"/*.vsix 2>/dev/null | tail -1 | xargs basename 2>/dev/null || echo 'nicht gefunden')"
echo ""
echo "VS Code neu laden (Ctrl+Shift+P → 'Developer: Reload Window')"
