#!/bin/bash
# Zero-Token TTS — Fresh System Setup Script
# Dieses Script installiert alle Abhängigkeiten und baut die Extension

set -e

NODE_REQUIRED_MAJOR=18
NODE_INSTALL_MAJOR=22
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

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

# 4. VS Code prüfen
if ! command -v code &> /dev/null; then
    echo "⚠️  VS Code CLI 'code' nicht gefunden."
    echo "   Bitte installieren Sie VS Code von https://code.visualstudio.com/"
    echo "   und aktivieren Sie die CLI mit 'Shell Command: Install code in PATH'"
fi

# 5. Dependencies installieren
echo ""
echo "📦 Installiere Dependencies..."
npm install

# 6. Extension bauen
echo ""
echo "🔨 Baue Extension..."
npm run build

# 7. VSIX paketieren
echo ""
echo "📦 Paketiere Extension..."
npm run package

# 8. Fertig
echo ""
echo "========================================"
echo "✅ Setup abgeschlossen!"
echo ""
echo "Nächste Schritte:"
echo "1. Extension installieren:"
echo "   code --install-extension zero-token-tts-*.vsix"
echo ""
echo "2. Oder in VS Code:"
echo "   Extensions (⇧⌘X) → '...' → 'Install from VSIX...'"
echo ""
echo "3. Nach der Installation:"
echo "   - Klicken Sie auf $(megaphone) TTS in der Statusleiste"
echo "   - Folgen Sie dem Onboarding-Dialog"
echo "   - Laden Sie WasmEdge + Eva-Modell herunter"
echo ""
echo "📋 VSIX-Datei: $(ls zero-token-tts-*.vsix | tail -1)"
