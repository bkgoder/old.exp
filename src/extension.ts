// ══════════════════════════════════════════════════════════════════════════════
// Zero-Token TTS — VS Code Extension
// Local TTS + Voice Studio Sidebar + History + model/server management
// ══════════════════════════════════════════════════════════════════════════════
import * as vscode from "vscode";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { speak } from "./tts-engine";
import {
  initDatabase,
  closeDatabase,
  persistDatabase,
  addTtsHistory,
  getTtsHistoryCount,
  clearTtsHistory,
} from "./database";
import { TtsTreeProvider, setConnectedAgent } from "./tts-tree";
import { setOnAgentChange, getActiveAgent } from "./mcp-server";
import { TtsSidebarProvider } from "./tts-sidebar";
import { OnboardingPanel } from "./onboarding-panel";
import { getServerManager } from "./tts-bootstrap";

let ttsServer: http.Server | null = null;
let serverPort = 18766;
let statusBarItem: vscode.StatusBarItem | null = null;
let audioPanel: vscode.WebviewPanel | null = null;
let audioPanelDisposed = false;
let outputChannel: vscode.OutputChannel;
let treeProvider: TtsTreeProvider;
let sidebarProvider: TtsSidebarProvider;

export async function activate(context: vscode.ExtensionContext) {
  fs.mkdirSync(context.globalStoragePath, { recursive: true });

  const firstRunMarker = path.join(context.globalStoragePath, "firstRun.txt");
  if (!fs.existsSync(firstRunMarker)) {
    fs.writeFileSync(firstRunMarker, "true");
    OnboardingPanel.createOrShow(context.extensionUri);
  }

  outputChannel = vscode.window.createOutputChannel("Zero-Token TTS");
  outputChannel.appendLine("[TTS] Aktiviert");

  try {
    await initDatabase(context.globalStoragePath);
    outputChannel.appendLine("[DB] SQLite bereit");
  } catch (error) {
    outputChannel.appendLine(`[DB] Fehler: ${error}`);
  }

  try {
    prepareBundledServer(context);
  } catch (error: any) {
    outputChannel.appendLine(`[Bootstrap] Binary-Vorbereitung fehlgeschlagen: ${error?.message ?? error}`);
  }

  const config = vscode.workspace.getConfiguration("zero-token-tts");
  serverPort = config.get<number>("serverPort", 18766);
  const serverEnabled = config.get<boolean>("serverEnabled", true);
  const autoBootstrap = config.get<boolean>("autoBootstrap", true);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = "zero-token-tts.openDashboard";
  statusBarItem.text = "$(megaphone) TTS";
  statusBarItem.tooltip = "Zero-Token TTS Voice Studio öffnen";
  context.subscriptions.push(statusBarItem);

  treeProvider = new TtsTreeProvider();
  sidebarProvider = new TtsSidebarProvider(
    context.extensionUri,
    outputChannel,
    treeProvider,
    speakToPanel,
  );
  context.subscriptions.push(
    sidebarProvider,
    vscode.window.registerWebviewViewProvider(
      TtsSidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  try {
    await vscode.commands.executeCommand(
      "setContext",
      "zeroTokenTts:historyCount",
      getTtsHistoryCount(),
    );
  } catch {
    // Database may still be warming up; the first dashboard refresh updates it.
  }

  setOnAgentChange((agent) => {
    setConnectedAgent(agent);
    treeProvider.refresh();
    void sidebarProvider.refresh();
  });

  if (serverEnabled) {
    audioPanel = createAudioPanel();
    startTtsServer(serverPort);
  }

  const serverManager = getServerManager(outputChannel);
  context.subscriptions.push(
    serverManager.onStatusChange((status) => {
      outputChannel.appendLine(`[Bootstrap] ${status.state}`);
      void sidebarProvider.refresh();
    }),
  );

  if (serverEnabled && autoBootstrap) {
    const apiPort = config.get<number>("ttsApiPort", 18765);
    serverManager.checkHealth(apiPort).then(async (healthy) => {
      if (healthy) return;

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: "Zero-Token TTS wird vorbereitet",
            cancellable: false,
          },
          async (progress) => {
            const ready = await serverManager.downloadAll(progress);
            if (!ready) {
              outputChannel.appendLine("[Bootstrap] TTS-Komponenten konnten nicht eingerichtet werden");
              return;
            }
            const started = await serverManager.start(apiPort);
            if (!started) {
              outputChannel.appendLine("[Bootstrap] TTS-Server konnte nicht gestartet werden");
            }
          },
        );
      } catch (error: any) {
        outputChannel.appendLine(`[Bootstrap] Automatische Einrichtung fehlgeschlagen: ${error?.message ?? error}`);
      }
    });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("zero-token-tts.openDashboard", () =>
      sidebarProvider.focus("speak"),
    ),

    vscode.commands.registerCommand("zero-token-tts.readClipboard", async () => {
      const text = await vscode.env.clipboard.readText();
      if (!text.trim()) {
        vscode.window.showInformationMessage("Zwischenablage leer");
        return;
      }
      await speakToPanel(text, "clipboard");
    }),

    vscode.commands.registerCommand("zero-token-tts.readSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const text = editor.document.getText(editor.selection);
      if (!text.trim()) {
        vscode.window.showInformationMessage("Nichts ausgewählt");
        return;
      }
      await speakToPanel(text, "selection");
    }),

    vscode.commands.registerCommand("zero-token-tts.showStatus", async () => {
      const apiPort = vscode.workspace
        .getConfiguration("zero-token-tts")
        .get<number>("ttsApiPort", 18765);
      const healthy = await serverManager.checkHealth(apiPort);
      vscode.window.showInformationMessage(
        healthy ? `TTS-Engine ist auf Port ${apiPort} bereit` : "TTS-Engine läuft nicht",
      );
    }),

    vscode.commands.registerCommand("zero-token-tts.openAudioPanel", () => {
      ensureAudioPanel();
    }),

    vscode.commands.registerCommand("zero-token-tts.stopServer", () => {
      stopTtsServer();
      serverManager.stop();
      void sidebarProvider.refresh();
      vscode.window.showInformationMessage("TTS-Server gestoppt");
    }),

    vscode.commands.registerCommand("zero-token-tts.startServer", async () => {
      startTtsServer(serverPort);
      const apiPort = vscode.workspace
        .getConfiguration("zero-token-tts")
        .get<number>("ttsApiPort", 18765);
      await serverManager.start(apiPort);
      await sidebarProvider.refresh();
      vscode.window.showInformationMessage(`TTS-Server auf Port ${apiPort}`);
    }),

    vscode.commands.registerCommand("zero-token-tts.openModelDashboard", () =>
      sidebarProvider.focus("voices"),
    ),

    vscode.commands.registerCommand("zero-token-tts.openHistory", () =>
      sidebarProvider.focus("history"),
    ),

    vscode.commands.registerCommand("zero-token-tts.historyReplay", () =>
      sidebarProvider.replayLatest(),
    ),

    vscode.commands.registerCommand("zero-token-tts.historyClear", async () => {
      const confirm = await vscode.window.showQuickPick(
        ["Ja, löschen", "Abbrechen"],
        { placeHolder: "Gesamte TTS-History löschen?", ignoreFocusOut: true },
      );
      if (confirm !== "Ja, löschen") return;
      clearTtsHistory();
      persistDatabase();
      treeProvider.refresh();
      await vscode.commands.executeCommand("setContext", "zeroTokenTts:historyCount", 0);
      await sidebarProvider.refresh();
      vscode.window.showInformationMessage("TTS-History gelöscht");
    }),

    vscode.commands.registerCommand("zero-token-tts.toggleAutoPlay", async () => {
      const newValue = !treeProvider.autoPlay;
      treeProvider.setAutoPlay(newValue);
      await sidebarProvider.refresh();
      vscode.window.showInformationMessage(newValue ? "Autoplay EIN" : "Autoplay AUS");
    }),

    vscode.commands.registerCommand("zero-token-tts.openSkill", async () => {
      const skillPath = findSkillFile();
      if (skillPath && fs.existsSync(skillPath)) {
        const document = await vscode.workspace.openTextDocument(skillPath);
        await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: true,
        });
      }

      const agent = getActiveAgent();
      if (agent) {
        vscode.window.showInformationMessage(
          `TTS-Skill aktiv – ${agent.name} liest alle Antworten vor`,
        );
      } else {
        vscode.window.showInformationMessage(
          "MCP-Server läuft auf Port 18764, aber kein Agent ist verbunden.",
        );
      }
    }),

    vscode.commands.registerCommand("zero-token-tts.showMcpConfig", async () => {
      const mcpConfig = JSON.stringify(
        {
          mcpServers: {
            "tts-skill": { url: "http://localhost:18764/sse" },
          },
        },
        null,
        2,
      );
      await vscode.env.clipboard.writeText(mcpConfig);
      vscode.window.showInformationMessage("MCP-Konfiguration kopiert");
    }),

    vscode.commands.registerCommand(
      "zero-token-tts.speakAudioData",
      (base64: string) => {
        const panel = ensureAudioPanel();
        void panel.webview.postMessage({ type: "speakAudio", audioBase64: base64 });
      },
    ),
  );

  statusBarItem.show();
  outputChannel.appendLine("[TTS] Voice Studio bereit");
}

export function deactivate() {
  stopTtsServer();
  if (audioPanel) audioPanel.dispose();
  persistDatabase();
  closeDatabase();
  outputChannel?.dispose();
}

function prepareBundledServer(context: vscode.ExtensionContext): void {
  const storageDir = path.join(context.globalStoragePath, "tts-server");
  fs.mkdirSync(storageDir, { recursive: true });

  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const extension = process.platform === "win32" ? ".exe" : "";
  const platformName = process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "macos"
      : "linux";
  const targetName = process.platform === "win32"
    ? "zero-token-tts-server.exe"
    : `zero-token-tts-server-${architecture}`;

  const candidates = [
    path.join(context.extensionPath, "bin", `zero-token-tts-server-${platformName}-${architecture}${extension}`),
    path.join(context.extensionPath, "bin", `zero-token-tts-server-${architecture}${extension}`),
    path.join(context.extensionPath, "bin", `zero-token-tts-server${extension}`),
    path.join(context.extensionPath, `zero-token-tts-server${extension}`),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));

  if (!source) {
    outputChannel.appendLine(
      `[Bootstrap] Keine passende Server-Binary für ${process.platform}/${process.arch} im VSIX gefunden`,
    );
    return;
  }

  const target = path.join(storageDir, targetName);
  const sourceStat = fs.statSync(source);
  const targetStat = fs.existsSync(target) ? fs.statSync(target) : undefined;
  if (!targetStat || targetStat.size !== sourceStat.size) {
    fs.copyFileSync(source, target);
    outputChannel.appendLine(`[Bootstrap] Server-Binary installiert: ${targetName}`);
  }

  if (process.platform !== "win32") {
    fs.chmodSync(target, 0o755);
  }
}

function createAudioPanel(): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel(
    "zeroTokenAudio",
    "TTS Audio",
    { viewColumn: vscode.ViewColumn.Nine, preserveFocus: true },
    { enableScripts: true, retainContextWhenHidden: true },
  );
  panel.webview.html = getAudioPanelHtml();
  panel.onDidDispose(() => {
    audioPanel = null;
    audioPanelDisposed = true;
  });
  return panel;
}

function ensureAudioPanel(): vscode.WebviewPanel {
  if (!audioPanel || audioPanelDisposed) {
    audioPanelDisposed = false;
    audioPanel = createAudioPanel();
  }
  return audioPanel;
}

async function speakToPanel(text: string, source = "manual"): Promise<void> {
  try {
    const cleanText = text.trim();
    if (!cleanText) return;

    const config = vscode.workspace.getConfiguration("zero-token-tts");
    const voice = config.get<string>("voice", "eva");
    const audioData = await speak(cleanText);
    const textHash = createHash("sha256").update(cleanText).digest("hex").slice(0, 16);

    addTtsHistory(source, cleanText, "llamaedge", voice, textHash);
    persistDatabase();
    treeProvider.refresh();
    await vscode.commands.executeCommand(
      "setContext",
      "zeroTokenTts:historyCount",
      getTtsHistoryCount(),
    );
    await sidebarProvider.refresh();

    const panel = ensureAudioPanel();
    await panel.webview.postMessage({
      type: "speakAudio",
      audioBase64: audioData.toString("base64"),
    });

    outputChannel.appendLine(`[TTS] ${source}: "${cleanText.slice(0, 80)}..."`);
  } catch (error: any) {
    outputChannel.appendLine(`[TTS] Fehler: ${error?.stack ?? error}`);
    vscode.window.showErrorMessage(`TTS-Fehler: ${error?.message ?? error}`);
  }
}

function getAudioPanelHtml(): string {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' http://localhost:*;";
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family:-apple-system,sans-serif;
    background:var(--vscode-editor-background);
    color:var(--vscode-editor-foreground);
    display:flex; align-items:center; justify-content:center;
    height:100vh; padding:1rem; text-align:center;
  }
  button { padding:1rem 2rem; font-size:1.2rem; cursor:pointer; }
  .status { font-size:0.9rem; margin-top:1rem; opacity:0.7; }
  .hidden { display:none; }
</style>
</head>
<body>
<div>
  <button id="activate">Audio aktivieren</button>
  <div class="status" id="status">Bereit</div>
</div>
<script>
(function(){
  const button=document.getElementById('activate');
  const status=document.getElementById('status');
  let active=false;
  let context=null;
  function log(message){status.textContent=message;}
  async function unlock(){
    if(active)return true;
    try{
      if(!context)context=new (window.AudioContext||window.webkitAudioContext)();
      if(context.state==='suspended')await context.resume();
      active=true;
      button.classList.add('hidden');
      log('Audio aktiviert');
      return true;
    }catch(error){log('Fehler: '+error.message);return false;}
  }
  button.onclick=unlock;
  document.addEventListener('keydown',()=>{if(!active)unlock();});
  setTimeout(unlock,300);
  window.addEventListener('message',async(event)=>{
    const message=event.data;
    if(message.type!=='speakAudio'||!message.audioBase64)return;
    if(!active&&!(await unlock())){log('Bitte Audio aktivieren');return;}
    try{
      const data=Uint8Array.from(atob(message.audioBase64),character=>character.charCodeAt(0));
      const audioBuffer=await context.decodeAudioData(data.buffer);
      const source=context.createBufferSource();
      source.buffer=audioBuffer;
      source.connect(context.destination);
      source.start(0);
      log('Wiedergabe…');
      source.onended=()=>log('Fertig');
    }catch(error){log('Fehler: '+error.message);}
  });
})();
</script>
</body>
</html>`;
}

function startTtsServer(port: number) {
  stopTtsServer();
  ttsServer = http.createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
    response.setHeader("Access-Control-Allow-Headers", "*");

    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", port }));
      return;
    }

    if (request.method === "POST" && request.url === "/speak") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", async () => {
        try {
          const params = JSON.parse(body);
          const text = params.text || "";
          if (!text.trim()) {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: "text required" }));
            return;
          }
          await speakToPanel(text, params.source || "http");
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
        } catch (error: any) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: error.message }));
        }
      });
      return;
    }

    response.writeHead(404);
    response.end("not found");
  });

  ttsServer.listen(port, "0.0.0.0", () => {
    outputChannel.appendLine(`[TTS] Extension-Proxy auf Port ${port}`);
    updateStatusBar(true);
  });
  ttsServer.on("error", (error: any) => {
    outputChannel.appendLine(`[TTS] Server-Fehler: ${error.message}`);
    updateStatusBar(false);
  });
}

function stopTtsServer() {
  if (ttsServer) {
    ttsServer.close();
    ttsServer = null;
  }
  updateStatusBar(false);
}

function updateStatusBar(running: boolean) {
  if (!statusBarItem) return;
  statusBarItem.text = running ? "$(megaphone) TTS" : "$(megaphone) TTS (off)";
  statusBarItem.tooltip = running
    ? `Zero-Token TTS Proxy auf Port ${serverPort}`
    : "Zero-Token TTS ist gestoppt";
}

function findSkillFile(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "skills", "tts-de", "SKILL.md"),
    path.join(__dirname, "..", "..", "skills", "tts-de", "SKILL.md"),
    path.join(
      __dirname,
      "..",
      "..",
      "skills",
      "tts-de",
      "SKILL.md",
    ),
    "/workspaces/Zero-Token-Explotion/skills/tts-de/SKILL.md",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}
