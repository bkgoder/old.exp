# Zero-Token TTS — VS Code Voice Studio

Lokale Sprachausgabe für VS Code mit Piper-Modellen, Verlauf und Agent-Integration.

> **Runtime-Repository:** Die TTS-Server-Binaries werden als GitHub Releases dieses Repository
> bereitgestellt und beim ersten Start automatisch heruntergeladen. Siehe `manifest/runtime-v1.json`.

## Voice Studio

Nach der Installation erscheint links in der VS-Code-Activity-Bar das neue Sprachwellen-Logo. Ein Klick öffnet das komplette Dashboard direkt in der Sidebar.

Das Dashboard besitzt vier Tabs:

- **Sprechen** — Text eingeben, Zwischenablage oder aktuelle Editor-Auswahl vorlesen.
- **Stimmen** — Piper-Stimmen anzeigen, herunterladen und als aktive Stimme auswählen.
- **Verlauf** — frühere Ausgaben durchsuchen und erneut abspielen.
- **System** — Autoplay, Ports, Serverstart, Neustart, Einrichtung, Einstellungen und Diagnose.

## Features

- **Lokale TTS** — keine Cloud-API für die Spracherzeugung erforderlich.
- **VS-Code-native Sidebar** — responsive Webview mit Theme-Farben und Tastaturfokus.
- **Mehrere Stimmen** — Deutsch und Englisch über lokale Piper-Modelle.
- **History** — SQLite-basierter Verlauf mit Replay und Autoplay.
- **AI-Agent-Integration** — MCP/SSE-Anbindung für OpenCode und kompatible Agenten.
- **HTTP-Proxy** — lokale `/health`- und `/speak`-Endpunkte für Werkzeuge.
- **Manifest-basierter Runtime-Download** — TTS-Server-Binaries werden aus GitHub Releases geladen, nicht im VSIX gebündelt.

## Installation

### Voraussetzungen

- Node.js 22 für den Entwicklungs-Build
- VS Code 1.85 oder neuer
- npm

### Aus dem Repository bauen

```bash
git clone https://github.com/bkgoder/Zero-Toke--TTS-Runtime.git
cd Zero-Toke--TTS-Runtime
npm ci
npm run build
npx @vscode/vsce package --no-dependencies
code --install-extension zero-token-tts-1.5.2.vsix
```

## Docker + Caddy Deployment (tts.eysho.info)

### Voraussetzungen auf dem Server

- Docker + Docker Compose
- Caddy (als Reverse-Proxy mit automatischem TLS)

### Schnellstart

```bash
git clone https://github.com/bkgoder/Zero-Toke-TTS-Runtime.git
cd Zero-Toke-TTS-Runtime

# Container bauen und starten
docker compose up -d --build

# Caddy starten
caddy run --config Caddyfile
```

### URLs nach dem Deployment

| Dienst | URL |
|---|---|
| 🍬 Web UI | https://tts.eysho.info |
| TTS API | https://tts.eysho.info/api/tts |
| Health | https://tts.eysho.info/health |
| MCP/SSE | https://tts.eysho.info/sse |

> **Hinweis:** Caddy übernimmt automatisch TLS via Let's Encrypt.  
> Alle API-Calls der Web UI laufen über relative Pfade — kein Port-Hardcoding.

### Logs

```bash
docker compose logs -f
```

## Runtime-Manifest

Beim ersten Start lädt die Extension das Manifest unter:

```
https://raw.githubusercontent.com/bkgoder/Zero-Toke--TTS-Runtime/main/manifest/runtime-v1.json
```

Das Manifest beschreibt, welche Backends und Targets für welche Plattformen verfügbar sind.
Die TTS-Server-Binaries werden aus den GitHub Releases dieses Repository heruntergeladen.

## Bedienung

1. In der Activity-Bar auf das Zero-Token-TTS-Logo klicken.
2. Im Tab **Sprechen** Text einfügen und **Jetzt sprechen** wählen.
3. Im Tab **Stimmen** ein Modell installieren und aktivieren.
4. Im Tab **System** den lokalen Server starten oder die automatische Einrichtung ausführen.

Zusätzliche Befehle sind über die VS-Code-Befehlspalette erreichbar:

- `TTS: Voice Studio öffnen`
- `TTS: Zwischenablage vorlesen`
- `TTS: Auswahl vorlesen`
- `TTS: Stimmen-Tab öffnen`
- `TTS: Voice Studio im Verlauf öffnen`
- `TTS: TTS-Server starten`
- `TTS: TTS-Server stoppen`
- `TTS: Frisches System vollständig einrichten`

Tastenkürzel:

- `Ctrl+Shift+R` / `Cmd+Shift+R`: Zwischenablage vorlesen
- `Ctrl+Shift+T` / `Cmd+Shift+T`: Editor-Auswahl vorlesen

## MCP-Konfiguration

```json
{
  "mcpServers": {
    "tts-skill": {
      "url": "http://localhost:18764/sse"
    }
  }
}
```

## Entwicklung

```bash
npm ci
npm run build
npm run watch
```

## Projektstruktur

```text
Zero-Toke--TTS-Runtime/
├── manifest/
│   └── runtime-v1.json        # Runtime-Manifest für den Bootstrap-Installer
├── resources/
│   ├── icon.png               # Extension-Icon
│   ├── tts-logo.svg           # farbiges Voice-Studio-Logo
│   └── tts-sidebar.svg        # Activity-Bar-Icon
├── runtime/
│   ├── entry.js               # resilientes Einsprung-Skript (main)
│   ├── runtime-installer.js   # lädt TTS-Runtime aus GitHub Releases
│   └── setup-wizard.js        # geführter Setup-Assistent
├── src/
│   ├── extension.ts           # Aktivierung, Befehle und Audio-Proxy
│   ├── tts-sidebar.ts         # mehrteiliges Sidebar-Dashboard
│   ├── tts-engine.ts          # Piper TTS-Client
│   ├── tts-bootstrap.ts       # Server- und Modellverwaltung
│   ├── tts-tree.ts            # History-/Replay-Logik
│   ├── database.ts            # SQLite-History
│   ├── mcp-server.ts          # Agent-/MCP-Anbindung
│   └── onboarding-panel.ts    # Ersteinrichtung
├── skills/tts-de/SKILL.md
├── package.json
└── tsconfig.json
```

## Ports

- **18764** — MCP/SSE und Agent-Anbindung
- **18765** — lokale TTS-API
- **18766** — Extension-HTTP-Proxy

## Lizenz

MIT