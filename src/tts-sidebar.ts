import * as vscode from "vscode";
import { clearTtsHistory, getTtsHistory, getTtsHistoryCount, persistDatabase, type TtsHistoryRow } from "./database";
import { getServerManager, type PiperModel, type ServerStatus } from "./tts-bootstrap";
import { type TtsTreeProvider } from "./tts-tree";

type DashboardTab = "speak" | "voices" | "clone" | "history" | "admin";
type SpeakHandler = (text: string, source?: string) => Promise<void>;

interface ModelSnapshot extends PiperModel {
  downloaded: boolean;
  active: boolean;
}

interface VoiceProfile {
  id: string;
  name: string;
  createdAt: string;
  baseModel: string;
}

interface ApiKeyEntry {
  key: string;
  preview: string;
  name: string;
  createdAt: string;
}

interface DashboardSnapshot {
  status: ServerStatus;
  healthy: boolean;
  models: ModelSnapshot[];
  catalogModels: ModelSnapshot[];
  history: TtsHistoryRow[];
  historyCount: number;
  autoPlay: boolean;
  activeModel: string;
  voice: string;
  language: string;
  proxyPort: number;
  apiPort: number;
  masterKey: string;
  masterKeyClaimed: boolean;
  apiKeys: ApiKeyEntry[];
  voiceProfiles: VoiceProfile[];
}

export class TtsSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "zeroTokenTtsDashboard";

  private view?: vscode.WebviewView;
  private pendingTab: DashboardTab = "speak";
  private refreshTimer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly treeProvider: TtsTreeProvider,
    private readonly speakHandler: SpeakHandler,
    private readonly context: vscode.ExtensionContext,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "resources")],
    };

    const logoUri = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "resources", "tts-logo.svg"),
    );
    view.webview.html = this.getHtml(view.webview, logoUri);

    this.disposables.push(
      view.webview.onDidReceiveMessage((message) => this.handleMessage(message)),
      view.onDidChangeVisibility(() => {
        if (view.visible) void this.refresh();
      }),
      view.onDidDispose(() => {
        this.view = undefined;
      }),
    );

    this.startPolling();
    void this.refresh();
    this.post({ type: "selectTab", tab: this.pendingTab });
  }

  async focus(tab: DashboardTab = "speak"): Promise<void> {
    this.pendingTab = tab;
    await vscode.commands.executeCommand("workbench.view.extension.zeroTokenTts");
    await vscode.commands.executeCommand(`${TtsSidebarProvider.viewType}.focus`);
    this.post({ type: "selectTab", tab });
    await this.refresh();
  }

  async replayLatest(): Promise<void> {
    const entry = getTtsHistory(1)[0];
    if (!entry) {
      vscode.window.showInformationMessage("Noch keine TTS-Ausgabe im Verlauf");
      return;
    }
    await this.treeProvider.replayEntry(entry);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.view) return;
    try {
      const snapshot = await this.createSnapshot();
      this.post({ type: "snapshot", payload: snapshot });
    } catch (error: any) {
      this.outputChannel.appendLine(`[Dashboard] Aktualisierung fehlgeschlagen: ${error?.message ?? error}`);
      this.post({ type: "dashboardError", message: error?.message ?? String(error) });
    }
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }

  private startPolling(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      if (this.view?.visible) void this.refresh();
    }, 5000);
  }

  private async createSnapshot(): Promise<DashboardSnapshot> {
    const config = vscode.workspace.getConfiguration("zero-token-tts");
    const apiPort = config.get<number>("ttsApiPort", 18765);
    const proxyPort = config.get<number>("serverPort", 18766);
    const activeModel = config.get<string>("activeModel", "de_DE-eva_k-x_low");
    const serverManager = getServerManager(this.outputChannel);
    const healthy = await serverManager.checkHealth(apiPort);
    const status = healthy ? { state: "running", port: apiPort } as ServerStatus : serverManager.status;
    const models = serverManager.getAvailableModels().map((model) => ({
      ...model,
      downloaded: serverManager.isModelDownloaded(model),
      active: model.id === activeModel,
    }));

    // Fetch catalog + admin data from Docker if healthy
    let catalogModels: ModelSnapshot[] = models;
    let masterKey = this.context.globalState.get<string>("masterApiKey", "");
    let masterKeyClaimed = this.context.globalState.get<boolean>("masterKeyClaimed", false);
    let apiKeys: ApiKeyEntry[] = [];
    let voiceProfiles: VoiceProfile[] = [];

    if (healthy) {
      try {
        const catalogData = await fetchJson(`http://localhost:${apiPort}/api/models/catalog`);
        if (catalogData?.models) {
          catalogModels = catalogData.models;
        }
      } catch { /* Docker API not accessible */ }

      if (masterKey) {
        try {
          const keysData = await fetchJson(`http://localhost:${apiPort}/api/admin/keys`, { "x-master-key": masterKey });
          if (keysData?.keys) apiKeys = keysData.keys;
        } catch { /* ignore */ }
        try {
          const profilesData = await fetchJson(`http://localhost:${apiPort}/api/voice-clone/profiles`);
          if (profilesData?.profiles) voiceProfiles = profilesData.profiles;
        } catch { /* ignore */ }
      }
    }

    return {
      status,
      healthy,
      models,
      catalogModels,
      history: getTtsHistory(60),
      historyCount: getTtsHistoryCount(),
      autoPlay: this.treeProvider.autoPlay,
      activeModel,
      voice: config.get<string>("voice", "eva"),
      language: config.get<string>("language", "de"),
      proxyPort,
      apiPort,
      masterKey,
      masterKeyClaimed,
      apiKeys,
      voiceProfiles,
    };
  }

  private async handleMessage(message: any): Promise<void> {
    const command = message?.command;
    const config = vscode.workspace.getConfiguration("zero-token-tts");
    const serverManager = getServerManager(this.outputChannel);
    const apiPort = config.get<number>("ttsApiPort", 18765);

    try {
      switch (command) {
        case "ready":
        case "refresh":
          await this.refresh();
          return;

        case "speakText": {
          const text = String(message.text ?? "").trim();
          if (!text) {
            vscode.window.showInformationMessage("Bitte zuerst Text eingeben");
            return;
          }
          this.post({ type: "busy", value: true, label: "Sprache wird erzeugt…" });
          await this.speakHandler(text, "dashboard");
          this.post({ type: "busy", value: false });
          await this.refresh();
          return;
        }

        case "speakClipboard": {
          const text = (await vscode.env.clipboard.readText()).trim();
          if (!text) {
            vscode.window.showInformationMessage("Zwischenablage ist leer");
            return;
          }
          await this.speakHandler(text, "clipboard");
          await this.refresh();
          return;
        }

        case "speakSelection": {
          const editor = vscode.window.activeTextEditor;
          const text = editor?.document.getText(editor.selection).trim() ?? "";
          if (!text) {
            vscode.window.showInformationMessage("Kein Text im Editor ausgewählt");
            return;
          }
          await this.speakHandler(text, "selection");
          await this.refresh();
          return;
        }

        case "replayHistory": {
          const id = Number(message.id);
          const entry = getTtsHistory(500).find((item) => item.id === id);
          if (!entry) {
            vscode.window.showWarningMessage("Verlaufseintrag wurde nicht gefunden");
            return;
          }
          await this.treeProvider.replayEntry(entry);
          await this.refresh();
          return;
        }

        case "clearHistory": {
          const choice = await vscode.window.showWarningMessage(
            "Gesamten TTS-Verlauf löschen?",
            { modal: true },
            "Löschen",
          );
          if (choice !== "Löschen") return;
          clearTtsHistory();
          persistDatabase();
          this.treeProvider.refresh();
          await vscode.commands.executeCommand("setContext", "zeroTokenTts:historyCount", 0);
          await this.refresh();
          return;
        }

        case "toggleAutoPlay":
          this.treeProvider.setAutoPlay(Boolean(message.value));
          await this.refresh();
          return;

        case "selectModel": {
          const modelId = String(message.modelId ?? "");
          const model = serverManager.getAvailableModels().find((item) => item.id === modelId);
          if (!model) return;
          await config.update("activeModel", model.id, vscode.ConfigurationTarget.Global);
          await config.update("voice", model.voice, vscode.ConfigurationTarget.Global);
          await config.update("language", model.lang, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`${model.label} ist jetzt aktiv`);
          await this.refresh();
          return;
        }

        case "downloadModel": {
          const modelId = String(message.modelId ?? "");
          const model = serverManager.getAvailableModels().find((item) => item.id === modelId);
          if (!model) return;
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `${model.label} wird installiert`,
              cancellable: false,
            },
            async (progress) => {
              const ok = await serverManager.downloadModel(model, progress);
              if (!ok) throw new Error(`Download fehlgeschlagen: ${model.label}`);
            },
          );
          vscode.window.showInformationMessage(`${model.label} wurde installiert`);
          await this.refresh();
          return;
        }

        case "bootstrap":
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Zero-Token TTS wird eingerichtet",
              cancellable: false,
            },
            async (progress) => {
              const ok = await serverManager.downloadAll(progress);
              if (!ok) throw new Error("TTS-Einrichtung fehlgeschlagen");
              await serverManager.start(apiPort);
            },
          );
          await this.refresh();
          return;

        case "startServer":
          await serverManager.start(apiPort);
          await this.refresh();
          return;

        case "stopServer":
          serverManager.stop();
          await this.refresh();
          return;

        case "restartServer":
          await serverManager.restart(apiPort);
          await this.refresh();
          return;

        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:forgefabrik.zero-token-tts");
          return;

        case "openModelDashboard":
          await vscode.commands.executeCommand("zero-token-tts.openModelDashboard");
          return;

        case "openOutput":
          this.outputChannel.show(true);
          return;

        // ── Admin: API Key Management ─────────────────────────────────────────
        case "claimMasterKey": {
          try {
            const res = await fetchJson(`http://localhost:${apiPort}/api/setup`);
            if (res?.masterKey) {
              await this.context.globalState.update("masterApiKey", res.masterKey);
              await this.context.globalState.update("masterKeyClaimed", true);
              this.post({ type: "masterKeyRevealed", key: res.masterKey });
              vscode.window.showInformationMessage("Master-Key erfolgreich gespeichert!");
            } else {
              vscode.window.showWarningMessage(res?.error || "Master-Key konnte nicht abgerufen werden.");
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(`Fehler beim Claimen: ${e.message}`);
          }
          await this.refresh();
          return;
        }

        case "copyMasterKey": {
          const key = this.context.globalState.get<string>("masterApiKey", "");
          if (key) {
            await vscode.env.clipboard.writeText(key);
            vscode.window.showInformationMessage("Master-Key in Zwischenablage kopiert");
          }
          return;
        }

        case "createApiKey": {
          const name = await vscode.window.showInputBox({ prompt: "Name für den neuen API-Key", placeHolder: "z.B. mein-agent" });
          if (!name) return;
          const masterKey = this.context.globalState.get<string>("masterApiKey", "");
          const res = await fetch(`http://localhost:${apiPort}/api/admin/keys`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-master-key": masterKey },
            body: JSON.stringify({ name }),
          });
          const data = await res.json() as any;
          if (data?.key) {
            await vscode.env.clipboard.writeText(data.key);
            vscode.window.showInformationMessage(`Key "${name}" erstellt & in Zwischenablage kopiert`);
          }
          await this.refresh();
          return;
        }

        case "revokeApiKey": {
          const keyToRevoke = String(message.key ?? "");
          const keyName = String(message.name ?? keyToRevoke.substring(0, 12));
          const confirm = await vscode.window.showWarningMessage(`Key "${keyName}" wirklich widerrufen?`, { modal: true }, "Widerrufen");
          if (confirm !== "Widerrufen") return;
          const masterKey = this.context.globalState.get<string>("masterApiKey", "");
          await fetch(`http://localhost:${apiPort}/api/admin/keys`, {
            method: "DELETE",
            headers: { "Content-Type": "application/json", "x-master-key": masterKey },
            body: JSON.stringify({ key: keyToRevoke }),
          });
          vscode.window.showInformationMessage("Key widerrufen");
          await this.refresh();
          return;
        }

        // ── Model Catalog ─────────────────────────────────────────────────────
        case "downloadModelFromCatalog": {
          const modelId = String(message.modelId ?? "");
          this.post({ type: "downloadStarted", modelId });
          try {
            const res = await fetch(`http://localhost:${apiPort}/api/models/download`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ modelId }),
            });
            const data = await res.json() as any;
            if (data.status === "started" || data.status === "already downloading") {
              vscode.window.showInformationMessage(`Download gestartet: ${modelId}`);
              // Poll until done
              void this.pollModelDownload(modelId, apiPort);
            }
          } catch (e: any) {
            this.post({ type: "downloadError", modelId, error: e.message });
          }
          return;
        }

        case "activateModel": {
          const modelId = String(message.modelId ?? "");
          await fetch(`http://localhost:${apiPort}/api/models/activate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelId }),
          });
          await config.update("activeModel", modelId, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Stimme aktiviert: ${modelId}`);
          await this.refresh();
          return;
        }

        // ── Voice Clone ───────────────────────────────────────────────────────
        case "uploadVoiceSample": {
          const voiceName = String(message.name ?? "Meine Stimme");
          const audioBase64 = String(message.audioBase64 ?? "");
          if (!audioBase64) { vscode.window.showWarningMessage("Kein Audio empfangen"); return; }
          const buf = Buffer.from(audioBase64.replace(/\s/g, ""), "base64");
          try {
            const res = await fetch(`http://localhost:${apiPort}/api/voice-clone/upload`, {
              method: "POST",
              headers: { "Content-Type": "audio/wav", "x-voice-name": voiceName },
              body: buf,
            });
            const data = await res.json() as any;
            if (data.success) {
              vscode.window.showInformationMessage(`Stimmprofil "${voiceName}" gespeichert!`);
            } else {
              vscode.window.showErrorMessage(`Upload fehlgeschlagen: ${data.error}`);
            }
          } catch (e: any) {
            vscode.window.showErrorMessage(`Upload-Fehler: ${e.message}`);
          }
          await this.refresh();
          return;
        }

        case "deleteVoiceProfile": {
          const profileId = String(message.profileId ?? "");
          const confirm = await vscode.window.showWarningMessage("Stimmprofil löschen?", { modal: true }, "Löschen");
          if (confirm !== "Löschen") return;
          await fetch(`http://localhost:${apiPort}/api/voice-clone/profiles/${encodeURIComponent(profileId)}`, { method: "DELETE" });
          await this.refresh();
          return;
        }
      }
    } catch (error: any) {
      this.post({ type: "busy", value: false });
      this.outputChannel.appendLine(`[Dashboard] ${command}: ${error?.stack ?? error}`);
      vscode.window.showErrorMessage(error?.message ?? String(error));
      await this.refresh();
    }
  }

  public postMessage(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private async pollModelDownload(modelId: string, apiPort: number): Promise<void> {
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const prog = await fetchJson(`http://localhost:${apiPort}/api/models/progress/${encodeURIComponent(modelId)}`);
        this.post({ type: "downloadProgress", modelId, ...prog });
        if (prog?.status === "done" || prog?.status === "error") {
          if (prog.status === "done") vscode.window.showInformationMessage(`✅ Modell heruntergeladen: ${modelId}`);
          await this.refresh();
          return;
        }
      } catch { break; }
    }
  }

  private getHtml(webview: vscode.Webview, logoUri: vscode.Uri): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      "font-src data:",
      "media-src blob:",
    ].join("; ");

    return `<!doctype html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Zero-Token TTS</title>
  <style>
    :root { color-scheme: light dark; }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; min-width: 210px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: 12px/1.5 var(--vscode-font-family);
    }
    button, textarea, input, select { font: inherit; }
    button:focus-visible, textarea:focus-visible, input:focus-visible {
      outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
    }
    /* ── Hero ── */
    .hero {
      padding: 14px 14px 10px;
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
      background: linear-gradient(135deg,
        color-mix(in srgb, var(--vscode-sideBar-background) 88%, #6e40c9 12%),
        color-mix(in srgb, var(--vscode-sideBar-background) 96%, #3b82f6 4%));
    }
    .brand { display: flex; gap: 10px; align-items: center; }
    .logo-wrap {
      width: 40px; height: 40px; flex: 0 0 40px;
      display: grid; place-items: center; border-radius: 12px;
      background: color-mix(in srgb, var(--vscode-editor-background) 75%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 40%, transparent);
    }
    .logo { width: 30px; height: 30px; }
    h1 { margin: 0; font-size: 14px; font-weight: 700; line-height: 1.2; }
    .subtitle { margin-top: 2px; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .hero-bottom { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 3px 8px; border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-badge-background) 50%, transparent);
      color: var(--vscode-badge-foreground); font-size: 10px; font-weight: 600;
    }
    .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: 0 0 6px; }
    .dot.running { background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,.2); }
    .dot.starting { background: #eab308; animation: blink 1s infinite; }
    .dot.error { background: #ef4444; }
    @keyframes blink { 50% { opacity: .3; } }
    /* ── Tabs ── */
    .tabs {
      position: sticky; top: 0; z-index: 10;
      display: grid; grid-template-columns: repeat(5, 1fr);
      gap: 2px; padding: 6px 5px 5px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, transparent);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
    }
    .tab {
      min-width: 0; padding: 6px 2px; border: 0; border-radius: 6px;
      color: var(--vscode-descriptionForeground);
      background: transparent; cursor: pointer; font-size: 9.5px; line-height: 1.3;
      transition: background .1s, color .1s;
    }
    .tab:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); font-weight: 600; }
    .tab-icon { display: block; font-size: 13px; margin-bottom: 2px; }
    /* ── Layout ── */
    main { padding: 8px; }
    .panel { display: none; }
    .panel.active { display: block; animation: fadeIn .12s ease-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(2px); } }
    .card {
      margin-bottom: 8px; padding: 10px 11px;
      border: 1px solid var(--vscode-widget-border); border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-editor-background) 82%, transparent);
    }
    .card-title { margin: 0 0 8px; font-size: 11.5px; font-weight: 700; }
    .card-subtitle { margin: -4px 0 8px; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .muted { color: var(--vscode-descriptionForeground); }
    .small { font-size: 10px; }
    .very-small { font-size: 9px; }
    textarea {
      width: 100%; min-height: 100px; resize: vertical;
      padding: 8px; border-radius: 6px;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    input[type=text], input[type=password] {
      width: 100%; padding: 6px 8px; border-radius: 5px;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    input[type=range] { width: 100%; accent-color: var(--vscode-focusBorder); }
    .counter { margin: 4px 0 0; text-align: right; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .row { display: flex; align-items: center; gap: 6px; }
    .row.wrap { flex-wrap: wrap; }
    .row.between { justify-content: space-between; }
    .stack { display: grid; gap: 6px; }
    .g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    /* ── Buttons ── */
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 4px;
      min-height: 28px; padding: 4px 10px; border: 1px solid transparent; border-radius: 5px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
      cursor: pointer; font-weight: 600; font-size: 11.5px; white-space: nowrap;
      transition: background .12s;
    }
    .btn:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    .btn.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
    .btn.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.ghost { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-widget-border); }
    .btn.ghost:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
    .btn.danger { color: var(--vscode-errorForeground); background: transparent; border-color: color-mix(in srgb, var(--vscode-errorForeground) 40%, transparent); }
    .btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent); }
    .btn.wide { width: 100%; }
    .btn.xs { min-height: 22px; padding: 2px 7px; font-size: 10px; }
    .btn:disabled { opacity: .4; cursor: default; }
    .btn-icon { min-height: 26px; min-width: 26px; padding: 3px; }
    /* ── Metrics ── */
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
    .metric { padding: 8px 9px; border-radius: 7px; background: var(--vscode-textBlockQuote-background); }
    .metric .label { font-size: 9.5px; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
    .metric strong { display: block; font-size: 14px; font-weight: 700; }
    /* ── Speed Slider ── */
    .speed-row { display: flex; align-items: center; gap: 8px; }
    .speed-val { min-width: 30px; text-align: right; font-size: 10px; font-weight: 600; color: var(--vscode-textLink-foreground); }
    /* ── Voice Cards ── */
    .voice-card {
      padding: 9px 10px; border: 1px solid var(--vscode-widget-border);
      border-radius: 7px; background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--vscode-editor-background));
      transition: border-color .15s;
    }
    .voice-card.active { border-color: var(--vscode-focusBorder); box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
    .voice-card.downloading { border-color: #eab308; }
    .voice-name { font-weight: 650; font-size: 12px; }
    .chips { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 5px; }
    .chip {
      padding: 1px 5px; border-radius: 999px;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      font-size: 9px; font-weight: 600; letter-spacing: .3px;
    }
    .chip.green { background: color-mix(in srgb, #22c55e 20%, transparent); color: #22c55e; }
    .chip.blue { background: color-mix(in srgb, #3b82f6 20%, transparent); color: #3b82f6; }
    .chip.yellow { background: color-mix(in srgb, #eab308 20%, transparent); color: #eab308; }
    .chip.red { background: color-mix(in srgb, #ef4444 20%, transparent); color: #ef4444; }
    .progress-bar { height: 3px; background: var(--vscode-widget-border); border-radius: 2px; margin-top: 5px; overflow: hidden; }
    .progress-fill { height: 100%; background: var(--vscode-focusBorder); border-radius: 2px; transition: width .3s; animation: shimmer 1.5s infinite linear; background-size: 200% 100%; background-image: linear-gradient(90deg, var(--vscode-focusBorder) 0%, color-mix(in srgb, var(--vscode-focusBorder) 60%, white) 50%, var(--vscode-focusBorder) 100%); }
    @keyframes shimmer { from { background-position: -200% 0; } to { background-position: 200% 0; } }
    /* ── Lang Filter ── */
    .lang-filter { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
    .lang-btn { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--vscode-widget-border); background: transparent; color: var(--vscode-foreground); font-size: 10px; cursor: pointer; }
    .lang-btn.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); border-color: transparent; }
    /* ── History ── */
    .history-item {
      padding: 8px 9px; border: 1px solid var(--vscode-widget-border);
      border-radius: 7px; background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--vscode-editor-background));
    }
    .history-text { margin: 5px 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.4; }
    .history-meta { font-size: 9px; color: var(--vscode-descriptionForeground); }
    .empty { padding: 20px 10px; text-align: center; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.6; }
    /* ── Clone Tab ── */
    .clone-zone {
      border: 2px dashed var(--vscode-widget-border); border-radius: 8px;
      padding: 18px; text-align: center; cursor: pointer;
      transition: border-color .15s, background .15s;
    }
    .clone-zone:hover, .clone-zone.dragover { border-color: var(--vscode-focusBorder); background: color-mix(in srgb, var(--vscode-focusBorder) 6%, transparent); }
    .clone-zone-icon { font-size: 28px; line-height: 1; margin-bottom: 8px; }
    .clone-zone p { margin: 0; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .profile-card {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 9px; border: 1px solid var(--vscode-widget-border);
      border-radius: 7px; background: color-mix(in srgb, var(--vscode-sideBar-background) 85%, var(--vscode-editor-background));
    }
    .profile-avatar { width: 32px; height: 32px; border-radius: 50%; background: linear-gradient(135deg, #6e40c9, #3b82f6); display: grid; place-items: center; font-size: 14px; flex: 0 0 32px; }
    /* ── Admin ── */
    .key-row {
      display: grid; grid-template-columns: 1fr auto auto; gap: 5px; align-items: center;
      padding: 6px 8px; border-radius: 6px;
      background: color-mix(in srgb, var(--vscode-textBlockQuote-background) 80%, transparent);
      border: 1px solid var(--vscode-widget-border);
    }
    .key-name { font-size: 11px; font-weight: 600; }
    .key-preview { font-family: monospace; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .master-key-box {
      font-family: monospace; font-size: 10px; word-break: break-all;
      padding: 8px; border-radius: 5px; background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      color: var(--vscode-input-foreground); user-select: text;
    }
    .master-key-box.hidden { filter: blur(5px); cursor: pointer; user-select: none; }
    /* ── Toggle ── */
    .switch { position: relative; width: 32px; height: 17px; flex: 0 0 32px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; border-radius: 999px; background: var(--vscode-input-background); border: 1px solid var(--vscode-widget-border); cursor: pointer; transition: background .15s; }
    .slider:before { content: ""; position: absolute; width: 11px; height: 11px; left: 2px; top: 2px; border-radius: 50%; background: var(--vscode-descriptionForeground); transition: transform .15s; }
    input:checked + .slider { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
    input:checked + .slider:before { transform: translateX(15px); background: var(--vscode-button-foreground); }
    /* ── Busy overlay ── */
    .busy { display: none; position: fixed; inset: 0; z-index: 20; place-items: center; background: color-mix(in srgb, var(--vscode-sideBar-background) 75%, transparent); backdrop-filter: blur(4px); }
    .busy.show { display: grid; }
    .busy-card { padding: 14px 18px; border-radius: 9px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); box-shadow: 0 12px 35px rgba(0,0,0,.3); }
    .spinner { display: inline-block; width: 12px; height: 12px; margin-right: 6px; border: 2px solid var(--vscode-widget-border); border-top-color: var(--vscode-focusBorder); border-radius: 50%; animation: spin .7s linear infinite; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* ── Separator ── */
    hr { border: none; border-top: 1px solid var(--vscode-widget-border); margin: 8px 0; }
  </style>
</head>
<body>
<div class="shell">
  <header class="hero">
    <div class="brand">
      <div class="logo-wrap"><img class="logo" src="${logoUri}" alt="ZT"></div>
      <div>
        <h1>Zero-Token TTS</h1>
        <div class="subtitle">Local Voice Studio · Docker Edition</div>
      </div>
    </div>
    <div class="hero-bottom">
      <div class="status-pill"><span id="statusDot" class="dot"></span><span id="statusText">wird geprüft…</span></div>
      <div class="row" style="gap:4px">
        <button class="btn ghost xs" id="refresh" title="Aktualisieren">↻</button>
        <button class="btn ghost xs" id="openSettings" title="Einstellungen">⚙</button>
      </div>
    </div>
  </header>

  <nav class="tabs">
    <button class="tab active" data-tab="speak"><span class="tab-icon">🎙</span>Sprechen</button>
    <button class="tab" data-tab="voices"><span class="tab-icon">🎭</span>Stimmen</button>
    <button class="tab" data-tab="clone"><span class="tab-icon">🧬</span>Klonen</button>
    <button class="tab" data-tab="history"><span class="tab-icon">📜</span>Verlauf</button>
    <button class="tab" data-tab="admin"><span class="tab-icon">🔑</span>Admin</button>
  </nav>

  <main>
    <!-- ── SPEAK ── -->
    <section id="panel-speak" class="panel active">
      <div class="card">
        <h2 class="card-title">Text vorlesen</h2>
        <textarea id="speechText" maxlength="12000" placeholder="Text eingeben… (Strg+Enter zum Sprechen)"></textarea>
        <div id="charCount" class="counter">0 / 12.000</div>
        <div style="margin-top:8px">
          <div class="small muted" style="margin-bottom:3px">Geschwindigkeit</div>
          <div class="speed-row">
            <span class="muted small">0.5×</span>
            <input type="range" id="speedSlider" min="50" max="200" value="100" step="5">
            <span class="muted small">2×</span>
            <span class="speed-val" id="speedVal">1.0×</span>
          </div>
        </div>
        <div class="stack" style="margin-top:10px">
          <button id="speakButton" class="btn wide">▶ Jetzt sprechen</button>
          <div class="g2">
            <button id="clipboardButton" class="btn secondary">📋 Zwischenablage</button>
            <button id="selectionButton" class="btn secondary">✂ Auswahl</button>
          </div>
        </div>
      </div>
      <div class="metric-grid">
        <div class="metric"><div class="label">Aktive Stimme</div><strong id="activeVoice">–</strong></div>
        <div class="metric"><div class="label">Ausgaben</div><strong id="historyCount">0</strong></div>
        <div class="metric"><div class="label">TTS Port</div><strong id="apiPort">18765</strong></div>
        <div class="metric"><div class="label">Proxy Port</div><strong id="proxyPort">18766</strong></div>
      </div>
      <div class="card" style="margin-top:8px">
        <div class="row between">
          <span class="small">Autoplay (Agent-Modus)</span>
          <label class="switch"><input id="autoPlay" type="checkbox"><span class="slider"></span></label>
        </div>
      </div>
    </section>

    <!-- ── VOICES ── -->
    <section id="panel-voices" class="panel">
      <div class="card">
        <h2 class="card-title">Stimmenbibliothek</h2>
        <div class="card-subtitle" id="catalogSubtitle">Lade Katalog…</div>
        <div class="lang-filter" id="langFilter"></div>
      </div>
      <div id="catalogList" class="stack"></div>
    </section>

    <!-- ── CLONE ── -->
    <section id="panel-clone" class="panel">
      <div class="card">
        <h2 class="card-title">🧬 Voice Cloning</h2>
        <div class="card-subtitle">Lade eine Sprachprobe hoch (10–60 Sek WAV/MP3)</div>
        <div class="clone-zone" id="cloneZone">
          <div class="clone-zone-icon">🎤</div>
          <p><strong>WAV oder MP3 hier ablegen</strong></p>
          <p style="margin-top:4px">oder</p>
          <button class="btn secondary" style="margin-top:8px" id="cloneUploadBtn">Datei auswählen</button>
          <input type="file" id="cloneFileInput" accept=".wav,.mp3,audio/*" style="display:none">
        </div>
        <div id="cloneFileName" class="small muted" style="margin-top:6px;text-align:center"></div>
        <div id="cloneNameRow" style="margin-top:10px;display:none" class="stack">
          <input type="text" id="cloneVoiceName" placeholder="Name für diese Stimme (z.B. Max)" maxlength="40">
          <button class="btn wide" id="cloneSubmitBtn">🧬 Stimmprofil erstellen</button>
        </div>
      </div>
      <div class="card">
        <div class="row between" style="margin-bottom:8px">
          <h2 class="card-title" style="margin:0">Meine Stimmen</h2>
        </div>
        <div id="profileList" class="stack">
          <div class="empty">Noch keine Stimmen geklont.<br>Lade eine Aufnahme hoch.</div>
        </div>
      </div>
      <div class="card" style="border-color: color-mix(in srgb, #eab308 40%, transparent)">
        <div class="small" style="color: #eab308; font-weight:600; margin-bottom:4px">ℹ️ Hinweis</div>
        <div class="small muted">Voice Cloning verwendet die hochgeladene Stimme als Referenz und erzeugt Sprache mit dem Basisprofil + angepassten Parametern. Für tiefes neuronales Klonen kann Coqui XTTS als separater Service aktiviert werden.</div>
      </div>
    </section>

    <!-- ── HISTORY ── -->
    <section id="panel-history" class="panel">
      <div class="card row between">
        <div>
          <h2 class="card-title" style="margin:0">Verlauf</h2>
          <div id="historyCaption" class="small muted">Keine Einträge</div>
        </div>
        <button id="clearHistory" class="btn danger xs">🗑 Löschen</button>
      </div>
      <div id="historyList" class="stack"></div>
    </section>

    <!-- ── ADMIN ── -->
    <section id="panel-admin" class="panel">
      <!-- Master Key -->
      <div class="card">
        <h2 class="card-title">🔑 Master-Key</h2>
        <div class="card-subtitle">Einmal-Passwort für den Admin-Zugriff</div>
        <div id="masterKeyBox" class="master-key-box hidden" title="Klicken zum Anzeigen">••••••••••••••••••••••••••••••••</div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:5px">
          <button class="btn secondary xs" id="toggleKeyVisible">👁 Anzeigen</button>
          <button class="btn ghost xs" id="copyMasterKey">📋 Kopieren</button>
          <button class="btn ghost xs" id="claimMasterKeyBtn" id="claimMasterKeyBtn">🔓 Key claimen</button>
        </div>
        <div id="masterKeyHint" class="small muted" style="margin-top:6px"></div>
      </div>

      <!-- API Keys -->
      <div class="card">
        <div class="row between" style="margin-bottom:8px">
          <div>
            <h2 class="card-title" style="margin:0">API-Keys</h2>
            <div class="card-subtitle" style="margin:0">Für externen Zugriff auf TTS</div>
          </div>
          <button class="btn xs" id="createApiKeyBtn">+ Neu</button>
        </div>
        <div id="apiKeyList" class="stack">
          <div class="empty small">Keine API-Keys erstellt.</div>
        </div>
      </div>

      <!-- Server Control -->
      <div class="card">
        <h2 class="card-title">Serversteuerung</h2>
        <div class="row wrap">
          <button id="startServer" class="btn xs">▶ Starten</button>
          <button id="restartServer" class="btn secondary xs">↺ Neu starten</button>
          <button id="stopServer" class="btn danger xs">■ Stoppen</button>
        </div>
        <button id="bootstrap" class="btn ghost wide" style="margin-top:8px">🔧 Einrichtung ausführen</button>
        <button id="openOutput" class="btn ghost wide" style="margin-top:5px">🔍 Diagnose-Log öffnen</button>
      </div>
    </section>
  </main>
</div>
<div id="busy" class="busy">
  <div class="busy-card"><span class="spinner"></span><span id="busyLabel">Bitte warten…</span></div>
</div>

<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { tab: 'speak', draft: '', speed: 100, langFilter: 'all' };
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const cmd = (command, payload = {}) => vscode.postMessage({ command, ...payload });
  const fmtDate = v => { const d = new Date(String(v||'').replace(' ','T')+'Z'); return isNaN(d) ? '' : new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short'}).format(d); };

  let snapshot = null;
  let masterKeyVisible = false;
  let cloneFile = null;
  let downloadStates = {};

  // ── Tab Navigation ──────────────────────────────────────────────────────────
  function selectTab(tab) {
    const allowed = ['speak','voices','clone','history','admin'];
    if (!allowed.includes(tab)) tab = 'speak';
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + tab));
    state.tab = tab; vscode.setState(state);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function renderStatus(data) {
    const state2 = data.healthy ? 'running' : (data.status?.state || 'stopped');
    $('statusDot').className = 'dot ' + state2;
    $('statusText').textContent = state2 === 'running' ? 'Docker bereit' : state2 === 'starting' ? 'startet…' : state2 === 'error' ? 'Fehler' : 'gestoppt';
  }

  function renderCatalog(models) {
    const langFilter = state.langFilter || 'all';
    $('catalogSubtitle').textContent = models.length + ' Modelle verfügbar';

    // Build lang buttons
    const langs = ['all', ...new Set(models.map(m => m.lang))];
    $('langFilter').innerHTML = langs.map(l => \`<button class="lang-btn \${l === langFilter ? 'active' : ''}" data-lang="\${esc(l)}">\${l === 'all' ? '🌍 Alle' : l.toUpperCase()}</button>\`).join('');

    const filtered = langFilter === 'all' ? models : models.filter(m => m.lang === langFilter);

    $('catalogList').innerHTML = filtered.map(m => {
      const dl = downloadStates[m.id];
      const isDownloading = dl?.status === 'downloading';
      const isDone = m.downloaded || dl?.status === 'done';
      const isError = dl?.status === 'error';
      const qualityColor = m.quality === 'high' ? 'green' : m.quality === 'medium' ? 'blue' : '';

      let actions = '';
      if (isDone) {
        actions = m.active
          ? \`<span class="chip green">✓ AKTIV</span>\`
          : \`<button class="btn xs" data-activate="\${esc(m.id)}">Verwenden</button>\`;
      } else if (isDownloading) {
        actions = \`<span class="chip yellow"><span class="spinner" style="width:8px;height:8px;margin-right:3px"></span>Download…</span>\`;
      } else if (isError) {
        actions = \`<button class="btn danger xs" data-catalog-dl="\${esc(m.id)}">↺ Erneut</button>\`;
      } else {
        actions = \`<button class="btn xs" data-catalog-dl="\${esc(m.id)}">⬇ Laden (\${esc(m.size)})</button>\`;
      }

      return \`<article class="voice-card \${m.active ? 'active' : ''} \${isDownloading ? 'downloading' : ''}">
        <div class="row between">
          <div><div class="voice-name">\${esc(m.label)}</div><div class="very-small muted">\${esc(m.id)}</div></div>
          <div class="row" style="gap:4px">\${actions}</div>
        </div>
        <div class="chips">
          <span class="chip">\${esc(m.lang.toUpperCase())}</span>
          <span class="chip \${qualityColor}">\${esc(m.quality)}</span>
          <span class="chip">\${esc(m.size)}</span>
        </div>
        \${isDownloading ? '<div class="progress-bar"><div class="progress-fill" style="width:100%"></div></div>' : ''}
        \${isError ? '<div class="very-small" style="color:#ef4444;margin-top:4px">Fehler: ' + esc(dl.error||'unbekannt') + '</div>' : ''}
      </article>\`;
    }).join('') || '<div class="empty">Keine Modelle für diese Sprache.</div>';
  }

  function renderHistory(items, count) {
    $('historyCaption').textContent = count === 1 ? '1 Ausgabe' : count + ' Ausgaben';
    $('historyList').innerHTML = items.map(item =>
      \`<article class="history-item">
        <div class="row between"><span class="chip">\${esc(item.source||'manual')}</span><span class="history-meta">\${esc(fmtDate(item.played_at))}</span></div>
        <div class="history-text">\${esc(item.text_preview||item.text||'')}</div>
        <div class="row between"><span class="history-meta">\${esc(item.voice)} · \${Number(item.played_count||1)}×</span><button class="btn secondary xs" data-replay="\${Number(item.id)}">▶ Nochmal</button></div>
      </article>\`
    ).join('') || '<div class="empty">Noch keine Ausgaben.<br>Sprich deinen ersten Text!</div>';
  }

  function renderProfiles(profiles) {
    $('profileList').innerHTML = (profiles||[]).map(p =>
      \`<div class="profile-card">
        <div class="profile-avatar">🎤</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:650;font-size:12px">\${esc(p.name)}</div>
          <div class="very-small muted">\${esc(fmtDate(p.createdAt))} · \${esc(p.baseModel||'')}</div>
        </div>
        <button class="btn danger xs" data-del-profile="\${esc(p.id)}">🗑</button>
      </div>\`
    ).join('') || '<div class="empty">Keine Stimmen geklont.</div>';
  }

  function renderAdmin(data) {
    // Master key
    const mk = data.masterKey || '';
    $('masterKeyBox').textContent = masterKeyVisible ? (mk || '(nicht gesetzt)') : (mk ? '••••••••••••••••••••••••••••••••' : '⚠ Noch nicht geclaimed');
    $('masterKeyBox').classList.toggle('hidden', !masterKeyVisible);
    $('masterKeyHint').textContent = data.masterKeyClaimed
      ? '✓ Key ist aktiv und gespeichert'
      : mk ? '⚠ Key noch nicht geclaimed (Docker muss laufen)' : '⚠ Docker starten, dann "Key claimen"';

    // API Keys
    const keys = data.apiKeys || [];
    $('apiKeyList').innerHTML = keys.length ? keys.map(k =>
      \`<div class="key-row">
        <div><div class="key-name">\${esc(k.name||'unnamed')}</div><div class="key-preview">\${esc(k.preview||k.key?.substring(0,14)+'...')}</div></div>
        <button class="btn ghost xs" data-copy-key="\${esc(k.key)}">📋</button>
        <button class="btn danger xs" data-revoke-key="\${esc(k.key)}" data-revoke-name="\${esc(k.name)}">×</button>
      </div>\`
    ).join('') : '<div class="small muted">Keine API-Keys. Erstelle einen mit "+ Neu".</div>';
  }

  function render(data) {
    snapshot = data;
    renderStatus(data);
    renderCatalog(data.catalogModels || data.models || []);
    renderHistory(data.history || [], Number(data.historyCount || 0));
    renderProfiles(data.voiceProfiles || []);
    renderAdmin(data);
    $('activeVoice').textContent = data.voice || '–';
    $('historyCount').textContent = String(data.historyCount || 0);
    $('autoPlay').checked = Boolean(data.autoPlay);
    $('apiPort').textContent = String(data.apiPort || 18765);
    $('proxyPort').textContent = String(data.proxyPort || 18766);
  }

  // ── Event Listeners ─────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));

  $('speechText').value = state.draft || '';
  $('speechText').addEventListener('input', e => {
    state.draft = e.target.value;
    $('charCount').textContent = e.target.value.length.toLocaleString('de-DE') + ' / 12.000';
    vscode.setState(state);
  });
  $('speechText').dispatchEvent(new Event('input'));
  $('speechText').addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') cmd('speakText', { text: $('speechText').value, speed: getSpeed() });
  });

  const speedSlider = $('speedSlider');
  speedSlider.value = state.speed || 100;
  function getSpeed() { return (Number(speedSlider.value) / 100).toFixed(1); }
  $('speedVal').textContent = getSpeed() + '×';
  speedSlider.addEventListener('input', () => {
    state.speed = Number(speedSlider.value);
    $('speedVal').textContent = getSpeed() + '×';
    vscode.setState(state);
  });

  $('speakButton').addEventListener('click', () => cmd('speakText', { text: $('speechText').value, speed: getSpeed() }));
  $('clipboardButton').addEventListener('click', () => cmd('speakClipboard'));
  $('selectionButton').addEventListener('click', () => cmd('speakSelection'));
  $('clearHistory').addEventListener('click', () => cmd('clearHistory'));
  $('autoPlay').addEventListener('change', e => cmd('toggleAutoPlay', { value: e.target.checked }));
  $('startServer').addEventListener('click', () => cmd('startServer'));
  $('stopServer').addEventListener('click', () => cmd('stopServer'));
  $('restartServer').addEventListener('click', () => cmd('restartServer'));
  $('bootstrap').addEventListener('click', () => cmd('bootstrap'));
  $('openSettings').addEventListener('click', () => cmd('openSettings'));
  $('openOutput').addEventListener('click', () => cmd('openOutput'));
  $('refresh').addEventListener('click', () => cmd('refresh'));

  // Admin
  $('toggleKeyVisible').addEventListener('click', () => {
    masterKeyVisible = !masterKeyVisible;
    $('toggleKeyVisible').textContent = masterKeyVisible ? '🙈 Verbergen' : '👁 Anzeigen';
    if (snapshot) renderAdmin(snapshot);
  });
  $('copyMasterKey').addEventListener('click', () => cmd('copyMasterKey'));
  $('claimMasterKeyBtn').addEventListener('click', () => cmd('claimMasterKey'));
  $('createApiKeyBtn').addEventListener('click', () => cmd('createApiKey'));

  // Lang filter
  $('langFilter').addEventListener('click', e => {
    const btn = e.target.closest('[data-lang]');
    if (!btn) return;
    state.langFilter = btn.dataset.lang;
    vscode.setState(state);
    if (snapshot) renderCatalog(snapshot.catalogModels || snapshot.models || []);
  });

  // Voice clone
  $('cloneUploadBtn').addEventListener('click', () => $('cloneFileInput').click());
  $('cloneFileInput').addEventListener('change', e => {
    cloneFile = e.target.files?.[0];
    if (cloneFile) {
      $('cloneFileName').textContent = cloneFile.name + ' (' + (cloneFile.size / 1024).toFixed(1) + ' KB)';
      $('cloneNameRow').style.display = 'grid';
      $('cloneVoiceName').value = cloneFile.name.replace(/\\.(wav|mp3)$/i,'');
    }
  });
  const cloneZone = $('cloneZone');
  cloneZone.addEventListener('dragover', e => { e.preventDefault(); cloneZone.classList.add('dragover'); });
  cloneZone.addEventListener('dragleave', () => cloneZone.classList.remove('dragover'));
  cloneZone.addEventListener('drop', e => {
    e.preventDefault(); cloneZone.classList.remove('dragover');
    cloneFile = e.dataTransfer.files?.[0];
    if (cloneFile) {
      $('cloneFileName').textContent = cloneFile.name;
      $('cloneNameRow').style.display = 'grid';
      $('cloneVoiceName').value = cloneFile.name.replace(/\\.(wav|mp3)$/i,'');
    }
  });
  $('cloneSubmitBtn').addEventListener('click', () => {
    if (!cloneFile) return;
    const reader = new FileReader();
    reader.onload = e2 => {
      const b64 = btoa(String.fromCharCode(...new Uint8Array(e2.target.result)));
      cmd('uploadVoiceSample', { name: $('cloneVoiceName').value || cloneFile.name, audioBase64: b64 });
    };
    reader.readAsArrayBuffer(cloneFile);
  });

  // Delegated clicks
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-activate],[data-catalog-dl],[data-replay],[data-copy-key],[data-revoke-key],[data-del-profile],[data-lang]');
    if (!t) return;
    if (t.dataset.activate) cmd('activateModel', { modelId: t.dataset.activate });
    if (t.dataset.catalogDl) cmd('downloadModelFromCatalog', { modelId: t.dataset.catalogDl });
    if (t.dataset.replay) cmd('replayHistory', { id: Number(t.dataset.replay) });
    if (t.dataset.copyKey) { navigator.clipboard?.writeText(t.dataset.copyKey); }
    if (t.dataset.revokeKey) cmd('revokeApiKey', { key: t.dataset.revokeKey, name: t.dataset.revokeName });
    if (t.dataset.delProfile) cmd('deleteVoiceProfile', { profileId: t.dataset.delProfile });
  });

  // Messages from extension
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'snapshot') render(msg.payload);
    if (msg.type === 'selectTab') selectTab(msg.tab);
    if (msg.type === 'busy') {
      $('busy').classList.toggle('show', Boolean(msg.value));
      $('busyLabel').textContent = msg.label || 'Bitte warten…';
    }
    if (msg.type === 'masterKeyRevealed') {
      masterKeyVisible = true;
      if (snapshot) { snapshot.masterKey = msg.key; snapshot.masterKeyClaimed = true; renderAdmin(snapshot); }
    }
    if (msg.type === 'downloadStarted') {
      downloadStates[msg.modelId] = { status: 'downloading' };
      if (snapshot) renderCatalog(snapshot.catalogModels || snapshot.models || []);
    }
    if (msg.type === 'downloadProgress') {
      downloadStates[msg.modelId] = { status: msg.status, error: msg.error };
      if (snapshot) renderCatalog(snapshot.catalogModels || snapshot.models || []);
    }
    if (msg.type === 'speakAudio' && msg.audioBase64) {
      try {
        const b64 = String(msg.audioBase64).replace(/\\s/g, '');
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play().catch(err => console.error('TTS play()', err));
      } catch(err) { console.error('TTS speakAudio', err); }
    }
  });

  selectTab(state.tab || 'speak');
  cmd('ready');
})();
</script>
</body>
</html>`;
  }
}
    button, textarea, input { font: inherit; }
    button:focus-visible, textarea:focus-visible, input:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .shell { min-height: 100vh; }
    .hero {
      position: relative;
      overflow: hidden;
      padding: 16px 14px 12px;
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
      background:
        radial-gradient(circle at 88% -10%, color-mix(in srgb, var(--vscode-textLink-foreground) 30%, transparent), transparent 48%),
        linear-gradient(145deg, color-mix(in srgb, var(--vscode-sideBar-background) 90%, #7c5cff 10%), var(--vscode-sideBar-background));
    }
    .brand { display: flex; gap: 10px; align-items: center; }
    .logo-wrap {
      width: 44px; height: 44px; flex: 0 0 44px;
      display: grid; place-items: center;
      border-radius: 13px;
      background: color-mix(in srgb, var(--vscode-editor-background) 80%, transparent);
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent);
      box-shadow: 0 8px 28px rgba(0,0,0,.2);
    }
    .logo { width: 34px; height: 34px; }
    h1 { margin: 0; font-size: 15px; line-height: 1.2; letter-spacing: .1px; }
    .subtitle { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .status-pill {
      display: inline-flex; align-items: center; gap: 6px;
      margin-top: 10px; padding: 4px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--vscode-badge-background) 55%, transparent);
      color: var(--vscode-badge-foreground);
      font-size: 10px; font-weight: 600;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .dot.running { background: #38d996; box-shadow: 0 0 0 3px rgba(56,217,150,.15); }
    .dot.starting { background: #ffca5c; animation: pulse 1s infinite; }
    .dot.error { background: #ff6b6b; }
    @keyframes pulse { 50% { opacity: .35; } }

    .tabs {
      position: sticky; top: 0; z-index: 5;
      display: grid; grid-template-columns: repeat(4, 1fr);
      gap: 3px; padding: 7px 6px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 94%, transparent);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--vscode-sideBar-border, var(--vscode-widget-border));
    }
    .tab {
      min-width: 0; padding: 7px 3px;
      border: 0; border-radius: 6px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      cursor: pointer; font-size: 10px;
    }
    .tab:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .tab.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .tab-icon { display: block; font-size: 14px; line-height: 1; margin-bottom: 3px; }

    main { padding: 10px; }
    .panel { display: none; }
    .panel.active { display: block; animation: enter .14s ease-out; }
    @keyframes enter { from { opacity: 0; transform: translateY(3px); } }
    .card {
      margin-bottom: 9px; padding: 11px;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 9px;
      background: color-mix(in srgb, var(--vscode-editor-background) 84%, transparent);
    }
    .card-title { margin: 0 0 8px; font-size: 12px; font-weight: 650; }
    .muted { color: var(--vscode-descriptionForeground); }
    .small { font-size: 10px; }
    textarea {
      width: 100%; min-height: 116px; resize: vertical;
      padding: 9px; border-radius: 7px;
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    .counter { margin: 5px 1px 0; text-align: right; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .row { display: flex; align-items: center; gap: 7px; }
    .row.wrap { flex-wrap: wrap; }
    .row.between { justify-content: space-between; }
    .stack { display: grid; gap: 7px; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      min-height: 29px; padding: 5px 10px;
      border: 1px solid transparent; border-radius: 6px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer; font-weight: 600;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .btn.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    .btn.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn.ghost { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-widget-border); }
    .btn.danger { color: var(--vscode-errorForeground); background: transparent; border-color: color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent); }
    .btn.wide { width: 100%; }
    .btn:disabled { opacity: .45; cursor: default; }

    .quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .metric { padding: 8px; border-radius: 7px; background: var(--vscode-textBlockQuote-background); }
    .metric strong { display: block; font-size: 13px; }

    .model, .history-item {
      padding: 9px; border: 1px solid var(--vscode-widget-border);
      border-radius: 8px; background: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-editor-background));
    }
    .model.active { border-color: var(--vscode-focusBorder); box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
    .model-name { font-weight: 650; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .chip { padding: 2px 6px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 9px; }
    .history-text { margin: 5px 0 7px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .history-meta { color: var(--vscode-descriptionForeground); font-size: 9px; }
    .empty { padding: 22px 10px; text-align: center; color: var(--vscode-descriptionForeground); }
    .switch { position: relative; width: 34px; height: 18px; }
    .switch input { opacity: 0; width: 0; height: 0; }
    .slider { position: absolute; inset: 0; border-radius: 999px; background: var(--vscode-input-background); border: 1px solid var(--vscode-widget-border); cursor: pointer; }
    .slider:before { content: ""; position: absolute; width: 12px; height: 12px; left: 2px; top: 2px; border-radius: 50%; background: var(--vscode-descriptionForeground); transition: .15s; }
    input:checked + .slider { background: var(--vscode-button-background); }
    input:checked + .slider:before { transform: translateX(16px); background: var(--vscode-button-foreground); }
    .busy {
      display: none; position: fixed; inset: 0; z-index: 20;
      place-items: center; background: color-mix(in srgb, var(--vscode-sideBar-background) 80%, transparent);
      backdrop-filter: blur(4px);
    }
    .busy.show { display: grid; }
    .busy-card { padding: 14px 16px; border-radius: 9px; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editor-background); box-shadow: 0 12px 35px rgba(0,0,0,.35); }
    .spinner { display: inline-block; width: 12px; height: 12px; margin-right: 7px; border: 2px solid var(--vscode-descriptionForeground); border-top-color: var(--vscode-focusBorder); border-radius: 50%; animation: spin .75s linear infinite; vertical-align: -2px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
<div class="shell">
  <header class="hero">
    <div class="brand">
      <div class="logo-wrap"><img class="logo" src="${logoUri}" alt="Zero-Token TTS Logo"></div>
      <div>
        <h1>Zero-Token TTS</h1>
        <div class="subtitle">Local Voice Studio</div>
      </div>
    </div>
    <div class="status-pill"><span id="statusDot" class="dot"></span><span id="statusText">Status wird geprüft…</span></div>
  </header>

  <nav class="tabs" aria-label="Dashboard-Bereiche">
    <button class="tab active" data-tab="speak"><span class="tab-icon">◉</span>Sprechen</button>
    <button class="tab" data-tab="voices"><span class="tab-icon">≋</span>Stimmen</button>
    <button class="tab" data-tab="history"><span class="tab-icon">↻</span>Verlauf</button>
    <button class="tab" data-tab="system"><span class="tab-icon">⚙</span>System</button>
  </nav>

  <main>
    <section id="panel-speak" class="panel active">
      <div class="card">
        <h2 class="card-title">Text vorlesen</h2>
        <textarea id="speechText" maxlength="12000" placeholder="Text eingeben, den Zero-Token vorlesen soll …"></textarea>
        <div id="charCount" class="counter">0 / 12.000</div>
        <div class="stack" style="margin-top:8px">
          <button id="speakButton" class="btn wide">▶ Jetzt sprechen</button>
          <div class="quick-grid">
            <button id="clipboardButton" class="btn secondary">Zwischenablage</button>
            <button id="selectionButton" class="btn secondary">Editor-Auswahl</button>
          </div>
        </div>
      </div>
      <div class="metric-grid">
        <div class="metric"><span class="small muted">Aktive Stimme</span><strong id="activeVoice">–</strong></div>
        <div class="metric"><span class="small muted">Ausgaben</span><strong id="historyCount">0</strong></div>
      </div>
    </section>

    <section id="panel-voices" class="panel">
      <div class="card">
        <div class="row between">
          <div><h2 class="card-title" style="margin:0">Stimmenbibliothek</h2><div class="small muted">Lokal installierte Piper-Modelle</div></div>
          <button id="openModelDashboard" class="btn ghost" title="Großes Model Dashboard öffnen">↗</button>
        </div>
      </div>
      <div id="modelList" class="stack"></div>
    </section>

    <section id="panel-history" class="panel">
      <div class="card row between">
        <div><h2 class="card-title" style="margin:0">Verlauf</h2><div id="historyCaption" class="small muted">Keine Einträge</div></div>
        <button id="clearHistory" class="btn danger">Löschen</button>
      </div>
      <div id="historyList" class="stack"></div>
    </section>

    <section id="panel-system" class="panel">
      <div class="card stack">
        <div class="row between"><span>Autoplay</span><label class="switch"><input id="autoPlay" type="checkbox"><span class="slider"></span></label></div>
        <div class="row between"><span>TTS API</span><code id="apiPort">:18765</code></div>
        <div class="row between"><span>Extension Proxy</span><code id="proxyPort">:18766</code></div>
      </div>
      <div class="card">
        <h2 class="card-title">Serversteuerung</h2>
        <div class="row wrap">
          <button id="startServer" class="btn">Starten</button>
          <button id="restartServer" class="btn secondary">Neu starten</button>
          <button id="stopServer" class="btn danger">Stoppen</button>
        </div>
        <button id="bootstrap" class="btn secondary wide" style="margin-top:7px">Modelle und Server einrichten</button>
      </div>
      <div class="card stack">
        <button id="openSettings" class="btn ghost wide">Extension-Einstellungen</button>
        <button id="openOutput" class="btn ghost wide">Diagnose-Ausgabe</button>
        <button id="refresh" class="btn ghost wide">Status aktualisieren</button>
      </div>
    </section>
  </main>
</div>
<div id="busy" class="busy"><div class="busy-card"><span class="spinner"></span><span id="busyLabel">Bitte warten…</span></div></div>

<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || { tab: 'speak', draft: '' };
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  let snapshot = null;

  function selectTab(tab) {
    const allowed = ['speak', 'voices', 'history', 'system'];
    if (!allowed.includes(tab)) tab = 'speak';
    document.querySelectorAll('.tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('active', panel.id === 'panel-' + tab));
    state.tab = tab;
    vscode.setState(state);
  }

  function command(command, payload = {}) { vscode.postMessage({ command, ...payload }); }
  function formatDate(value) {
    const date = new Date(String(value || '').replace(' ', 'T') + 'Z');
    return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(date);
  }

  function renderStatus(data) {
    const status = data.status || { state: 'stopped' };
    const stateName = data.healthy ? 'running' : status.state;
    $('statusDot').className = 'dot ' + stateName;
    $('statusText').textContent = stateName === 'running' ? 'Server bereit' : stateName === 'starting' ? 'Server startet…' : stateName === 'error' ? 'Serverfehler' : 'Server gestoppt';
  }

  function renderModels(models) {
    $('modelList').innerHTML = models.map((model) => {
      const action = model.downloaded
        ? '<button class="btn ' + (model.active ? 'secondary' : '') + '" data-model-select="' + escapeHtml(model.id) + '" ' + (model.active ? 'disabled' : '') + '>' + (model.active ? 'Ausgewählt' : 'Verwenden') + '</button>'
        : '<button class="btn" data-model-download="' + escapeHtml(model.id) + '">Installieren</button>';
      return '<article class="model ' + (model.active ? 'active' : '') + '">' +
        '<div class="row between">' +
          '<div><div class="model-name">' + escapeHtml(model.label) + '</div><div class="small muted">' + escapeHtml(model.id) + '</div></div>' +
          (model.active ? '<span class="chip">AKTIV</span>' : '') +
        '</div>' +
        '<div class="chips"><span class="chip">' + escapeHtml(model.lang.toUpperCase()) + '</span><span class="chip">' + escapeHtml(model.quality) + '</span><span class="chip">' + escapeHtml(model.size) + '</span></div>' +
        '<div class="row wrap" style="margin-top:8px">' + action + '</div>' +
      '</article>';
    }).join('') || '<div class="empty">Keine Stimmen verfügbar</div>';
  }

  function renderHistory(items, count) {
    $('historyCaption').textContent = count === 1 ? '1 Ausgabe' : count + ' Ausgaben';
    $('historyList').innerHTML = items.map((item) =>
      '<article class="history-item">' +
        '<div class="row between"><span class="chip">' + escapeHtml(item.source || 'manual') + '</span><span class="history-meta">' + escapeHtml(formatDate(item.played_at)) + '</span></div>' +
        '<div class="history-text">' + escapeHtml(item.text_preview || item.text || '') + '</div>' +
        '<div class="row between"><span class="history-meta">' + escapeHtml(item.voice) + ' · ' + Number(item.played_count || 1) + '×</span><button class="btn secondary" data-history-replay="' + Number(item.id) + '">▶ Nochmal</button></div>' +
      '</article>'
    ).join('') || '<div class="empty">Noch nichts vorgelesen.<br>Der Verlauf erscheint nach der ersten Ausgabe.</div>';
  }

  function render(data) {
    snapshot = data;
    renderStatus(data);
    renderModels(data.models || []);
    renderHistory(data.history || [], Number(data.historyCount || 0));
    $('activeVoice').textContent = data.voice || '–';
    $('historyCount').textContent = String(data.historyCount || 0);
    $('autoPlay').checked = Boolean(data.autoPlay);
    $('apiPort').textContent = ':' + data.apiPort;
    $('proxyPort').textContent = ':' + data.proxyPort;
  }

  document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => selectTab(button.dataset.tab)));
  $('speechText').value = state.draft || '';
  $('speechText').addEventListener('input', (event) => {
    state.draft = event.target.value;
    $('charCount').textContent = event.target.value.length.toLocaleString('de-DE') + ' / 12.000';
    vscode.setState(state);
  });
  $('speechText').dispatchEvent(new Event('input'));
  $('speakButton').addEventListener('click', () => command('speakText', { text: $('speechText').value }));
  $('clipboardButton').addEventListener('click', () => command('speakClipboard'));
  $('selectionButton').addEventListener('click', () => command('speakSelection'));
  $('clearHistory').addEventListener('click', () => command('clearHistory'));
  $('autoPlay').addEventListener('change', (event) => command('toggleAutoPlay', { value: event.target.checked }));
  $('startServer').addEventListener('click', () => command('startServer'));
  $('stopServer').addEventListener('click', () => command('stopServer'));
  $('restartServer').addEventListener('click', () => command('restartServer'));
  $('bootstrap').addEventListener('click', () => command('bootstrap'));
  $('openSettings').addEventListener('click', () => command('openSettings'));
  $('openOutput').addEventListener('click', () => command('openOutput'));
  $('refresh').addEventListener('click', () => command('refresh'));
  $('openModelDashboard').addEventListener('click', () => command('openModelDashboard'));
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-model-select],[data-model-download],[data-history-replay]');
    if (!target) return;
    if (target.dataset.modelSelect) command('selectModel', { modelId: target.dataset.modelSelect });
    if (target.dataset.modelDownload) command('downloadModel', { modelId: target.dataset.modelDownload });
    if (target.dataset.historyReplay) command('replayHistory', { id: Number(target.dataset.historyReplay) });
  });
  $('speechText').addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') command('speakText', { text: $('speechText').value });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'snapshot') render(message.payload);
    if (message.type === 'selectTab') selectTab(message.tab);
    if (message.type === 'busy') {
      $('busy').classList.toggle('show', Boolean(message.value));
      $('busyLabel').textContent = message.label || 'Bitte warten…';
    }
    if (message.type === 'dashboardError') $('statusText').textContent = message.message || 'Dashboard-Fehler';
    if (message.type === 'speakAudio' && message.audioBase64) {
      try {
        const b64 = String(message.audioBase64).replace(/\s/g, '');
        const binary = atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.onerror = (e) => { console.error('TTS Audio Fehler', e); URL.revokeObjectURL(url); };
        audio.play().catch((e) => console.error('TTS play() Fehler', e));
      } catch (e) { console.error('TTS speakAudio Fehler', e); }
    }
  });

  selectTab(state.tab || 'speak');
  command('ready');
})();
</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const http = require("http") as typeof import("http");
    const urlObj = new URL(url);
    const req = http.request({ hostname: urlObj.hostname, port: Number(urlObj.port), path: urlObj.pathname + urlObj.search, method: "GET", headers: { "Content-Type": "application/json", ...headers } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}
