// ══════════════════════════════════════════════════════════════════════════════
// MCP-Server für Zero-Token TTS
// Exponiert den TTS-Skill als Resource – der Agent verbindet sich,
// liest den Skill und spricht dann jede Antwort automatisch vor.
// Port: 18764
// ══════════════════════════════════════════════════════════════════════════════
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────

const MCP_PORT = 18764;

// Pfad zur SKILL.md (relativ zu dist/ oder src/)
function findSkillPath(): string {
  const candidates = [
    path.join(__dirname, "..", "skills", "tts-de", "SKILL.md"),
    path.join(__dirname, "..", "..", "skills", "tts-de", "SKILL.md"),
    path.join(__dirname, "..", "..", "..", "skills", "tts-de", "SKILL.md"),
    "/workspaces/Zero-Token-Explotion/skills/tts-de/SKILL.md",
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback: Workspace-Pfad
  return "/workspaces/Zero-Token-Explotion/skills/tts-de/SKILL.md";
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpSession {
  id: string;
  res: http.ServerResponse;
  clientName?: string;
  clientVersion?: string;
  connectedAt: Date;
  lastSeen: Date;
}

interface ActiveAgent {
  name: string;
  version?: string;
  connectedAt: Date;
  lastSeen: Date;
}

// ─── State ───────────────────────────────────────────────────────────────────

const sessions = new Map<string, McpSession>();
let serverInstance: http.Server | null = null;
let activeAgent: ActiveAgent | null = null;

// API Key Management
const apiKeys = new Map<string, { createdAt: Date; lastUsed?: Date; name?: string }>();
let masterApiKey: string | null = null;

// Callback: wird aufgerufen, wenn sich der Agent-Status ändert
let onAgentChange: ((agent: ActiveAgent | null) => void) | null = null;

export function setOnAgentChange(cb: (agent: ActiveAgent | null) => void) {
  onAgentChange = cb;
}

/** Gibt den aktuell verbundenen Agenten zurück */
export function getActiveAgent(): ActiveAgent | null {
  return activeAgent;
}

// ─── API Key Management ──────────────────────────────────────────────────────

function generateApiKey(): string {
  const bytes = crypto.randomBytes(32);
  return `tts_${bytes.toString('hex')}`;
}

export function createApiKey(name?: string): string {
  const key = generateApiKey();
  apiKeys.set(key, {
    createdAt: new Date(),
    name: name || 'default',
  });
  return key;
}

export function validateApiKey(key: string): boolean {
  return apiKeys.has(key);
}

export function getMasterApiKey(): string | null {
  return masterApiKey;
}

export function setMasterApiKey(key: string): void {
  masterApiKey = key;
}

export function listApiKeys(): Array<{ key: string; createdAt: Date; lastUsed?: Date; name?: string }> {
  return Array.from(apiKeys.entries()).map(([key, data]) => ({
    key: key.substring(0, 8) + '...',
    fullKey: key,
    ...data,
  }));
}

export function revokeApiKey(key: string): boolean {
  return apiKeys.delete(key);
}

// ─── Server ──────────────────────────────────────────────────────────────────

export function startMcpServer(port = MCP_PORT): http.Server {
  if (serverInstance) return serverInstance;

  const skillPath = findSkillPath();
  console.log(`[MCP] Skill-Pfad: ${skillPath}`);

  serverInstance = http.createServer((req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      // SSE Stream – Agent verbindet sich hier
      if (req.method === "GET" && url.pathname === "/sse") {
        return handleSse(req, res);
      }

      // JSON-RPC Messages via POST
      if (req.method === "POST" && url.pathname === "/messages") {
        return handleMessage(req, res, url);
      }

      // Status-Endpunkt (für TreeView / Dashboard)
      if (req.method === "GET" && url.pathname === "/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          connected: activeAgent !== null,
          agent: activeAgent,
          sessions: sessions.size,
        }));
        return;
      }

      // Health-Check
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, port, connected: activeAgent !== null }));
        return;
      }

      // Direct TTS API (for agents with API key)
      if (req.method === "POST" && url.pathname === "/api/tts") {
        return handleTtsApi(req, res);
      }

      // API Key management
      if (req.method === "POST" && url.pathname === "/api/keys") {
        return handleApiKeys(req, res);
      }

      res.writeHead(404); res.end(JSON.stringify({ error: "not found" }));
    } catch (e: any) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
  });

  serverInstance.listen(port, "0.0.0.0", () => {
    console.log(`[MCP] Server on port ${port}`);
  });

  serverInstance.on("error", (e: any) => {
    console.error(`[MCP] Error: ${e.message}`);
  });

  return serverInstance;
}

export function stopMcpServer() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
  sessions.clear();
  activeAgent = null;
}

// ─── Direct TTS API ──────────────────────────────────────────────────────────

async function handleTtsApi(req: http.IncomingMessage, res: http.ServerResponse) {
  // Check API key
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey || !validateApiKey(apiKey)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid or missing API key" }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const params = JSON.parse(body);
      const text = params.text || "";
      if (!text.trim()) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "text is required" }));
        return;
      }

      // Update last used
      const keyData = apiKeys.get(apiKey);
      if (keyData) {
        keyData.lastUsed = new Date();
      }

      // Generate TTS audio (placeholder - would integrate with actual TTS engine)
      const audioData = await generateTtsAudio(text);
      
      res.writeHead(200, { "Content-Type": "audio/wav" });
      res.end(audioData);
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

async function generateTtsAudio(text: string): Promise<Buffer> {
  // Placeholder - integrate with actual TTS engine
  // This would call the TTS engine to generate audio
  return Buffer.from("TTS audio placeholder");
}

// ─── API Key Management ──────────────────────────────────────────────────────

async function handleApiKeys(req: http.IncomingMessage, res: http.ServerResponse) {
  const apiKey = req.headers['x-api-key'] as string;
  
  // Only master key can manage keys
  if (!masterApiKey || apiKey !== masterApiKey) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Master API key required" }));
    return;
  }

  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const params = JSON.parse(body);
      const action = params.action || "list";

      switch (action) {
        case "create": {
          const newKey = createApiKey(params.name);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ key: newKey, name: params.name || 'default' }));
          break;
        }
        case "list": {
          const keys = listApiKeys();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ keys }));
          break;
        }
        case "revoke": {
          const revoked = revokeApiKey(params.key);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ revoked }));
          break;
        }
        default:
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid action" }));
      }
    } catch (e: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ─── SSE Handler ─────────────────────────────────────────────────────────────

function handleSse(req: http.IncomingMessage, res: http.ServerResponse) {
  const sessionId = generateId();
  const session: McpSession = {
    id: sessionId,
    res,
    connectedAt: new Date(),
    lastSeen: new Date(),
  };
  sessions.set(sessionId, session);

  // SSE-Header
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Session-Endpunkt mitteilen
  sseSend(res, "endpoint", `/messages?sessionId=${sessionId}`);

  // Keepalive alle 15s
  const keepAlive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { clearInterval(keepAlive); }
  }, 15000);

  // Client trennt
  req.on("close", () => {
    clearInterval(keepAlive);
    sessions.delete(sessionId);
    // Wenn das die aktive Agent-Session war, zurücksetzen
    if (activeAgent && sessions.size === 0) {
      activeAgent = null;
      onAgentChange?.(null);
    }
  });
}

// ─── Message Handler (JSON-RPC) ─────────────────────────────────────────────

async function handleMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
) {
  const sessionId = url.searchParams.get("sessionId");
  const session = sessionId ? sessions.get(sessionId) : undefined;

  // Body lesen
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const msg = JSON.parse(body);
      const response = await processRpc(msg, session);

      // POST antwortet immer 202 Accepted (Response geht über SSE)
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));

      // Wenn es eine Response gibt, via SSE zurücksenden
      if (response && session) {
        sseSend(session.res, "message", JSON.stringify(response));
      }
    } catch (e: any) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Parse error: ${e.message}` }));
    }
  });
}

// ─── JSON-RPC Processing ────────────────────────────────────────────────────

async function processRpc(
  msg: any,
  session?: McpSession
): Promise<any> {
  const { id, method, params } = msg;

  // Notification (kein id → keine Response nötig)
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      // ── Initialize ──────────────────────────────────────────────────────
      case "initialize": {
        if (session && params?.clientInfo) {
          session.clientName = params.clientInfo.name;
          session.clientVersion = params.clientInfo.version;
          session.lastSeen = new Date();
          activeAgent = {
            name: params.clientInfo.name,
            version: params.clientInfo.version,
            connectedAt: session.connectedAt,
            lastSeen: new Date(),
          };
          onAgentChange?.(activeAgent);
        }
        return makeResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            resources: {
              listChanged: false,
              subscribe: false,
            },
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "zero-token-tts-mcp",
            version: "1.3.0",
          },
        });
      }

      // ── Initialized Notification ────────────────────────────────────────
      case "notifications/initialized": {
        if (isNotification) return undefined;
        return makeResult(id, { ok: true });
      }

      // ── Resources List ──────────────────────────────────────────────────
      case "resources/list": {
        return makeResult(id, {
          resources: [
            {
              uri: "tts://skill",
              name: "TTS-Skill für Deutsch (Automatische Sprachausgabe)",
              description: "Skill-Definition für TTS – der Agent muss diesen Skill nutzen, um jede Antwort automatisch vorzulesen",
              mimeType: "text/markdown",
            },
            {
              uri: "tts://status",
              name: "TTS-Verbindungsstatus",
              description: "Zeigt ob der Agent mit dem TTS-MCP-Server verbunden ist",
              mimeType: "application/json",
            },
          ],
        });
      }

      // ── Resources Read ──────────────────────────────────────────────────
      case "resources/read": {
        const uri = params?.uri || "";
        if (uri === "tts://skill") {
          const content = readSkillFile();
          return makeResult(id, {
            contents: [
              {
                uri: "tts://skill",
                mimeType: "text/markdown",
                text: content,
              },
            ],
          });
        }
        if (uri === "tts://status") {
          return makeResult(id, {
            contents: [
              {
                uri: "tts://status",
                mimeType: "application/json",
                text: JSON.stringify({
                  connected: activeAgent !== null,
                  agent: activeAgent,
                  timestamp: new Date().toISOString(),
                }),
              },
            ],
          });
        }
        return makeError(id, -32602, `Resource not found: ${uri}`);
      }

      // ── Tools List ──────────────────────────────────────────────────────
      case "tools/list": {
        return makeResult(id, {
          tools: [
            {
              name: "load-skill",
              description: "Lädt den TTS-Skill – ab dann liest der Agent alle Antworten automatisch vor",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
            {
              name: "check-connection",
              description: "Prüft ob der Agent mit dem TTS-Server verbunden ist",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
            {
              name: "tts-speak",
              description: "Synthesisiert Text zu Sprache (benötigt API-Key)",
              inputSchema: {
                type: "object",
                properties: {
                  text: { type: "string", description: "Der zu synthetisierende Text" },
                  apiKey: { type: "string", description: "API-Key für die Authentifizierung" },
                },
                required: ["text", "apiKey"],
              },
            },
            {
              name: "tts-create-api-key",
              description: "Erstellt einen neuen API-Key für den direkten TTS-Zugriff (nur Master-Key)",
              inputSchema: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Name für den API-Key" },
                  masterKey: { type: "string", description: "Master-API-Key zur Autorisierung" },
                },
                required: ["masterKey"],
              },
            },
            {
              name: "tts-list-api-keys",
              description: "Listet alle API-Keys auf (nur Master-Key)",
              inputSchema: {
                type: "object",
                properties: {
                  masterKey: { type: "string", description: "Master-API-Key zur Autorisierung" },
                },
                required: ["masterKey"],
              },
            },
            {
              name: "tts-revoke-api-key",
              description: "Widerruft einen API-Key (nur Master-Key)",
              inputSchema: {
                type: "object",
                properties: {
                  key: { type: "string", description: "Der zu widerrufende API-Key" },
                  masterKey: { type: "string", description: "Master-API-Key zur Autorisierung" },
                },
                required: ["key", "masterKey"],
              },
            },
          ],
        });
      }

      // ── Tools Call ──────────────────────────────────────────────────────
      case "tools/call": {
        const toolName = params?.name || "";
        
        if (toolName === "load-skill") {
          const content = readSkillFile();
          return makeResult(id, {
            content: [
              {
                type: "text",
                text: `# TTS-Skill geladen ✅\n\nDer Agent ist mit dem TTS-MCP-Server verbunden und nutzt ab sofort den folgenden Skill für ALLE Antworten:\n\n${content}`,
              },
            ],
          });
        }
        
        if (toolName === "check-connection") {
          return makeResult(id, {
            content: [
              {
                type: "text",
                text: activeAgent
                  ? `✅ Verbunden mit ${activeAgent.name}${activeAgent.version ? ` v${activeAgent.version}` : ""} (seit ${activeAgent.connectedAt.toISOString()})`
                  : "❌ Kein Agent verbunden",
              },
            ],
          });
        }

        if (toolName === "tts-speak") {
          const { text, apiKey } = params || {};
          if (!text || !apiKey) {
            return makeError(id, -32602, "text and apiKey are required");
          }
          if (!validateApiKey(apiKey)) {
            return makeError(id, -32601, "Invalid API key");
          }

          // Update last used
          const keyData = apiKeys.get(apiKey);
          if (keyData) {
            keyData.lastUsed = new Date();
          }

          // Generate TTS audio
          try {
            const audioData = await generateTtsAudio(text);
            const base64 = audioData.toString('base64');
            return makeResult(id, {
              content: [
                {
                  type: "text",
                  text: `🔊 TTS generiert (${text.length} Zeichen)\n\nAudio als Base64 verfügbar (${base64.length} Zeichen).`,
                },
              ],
              audio: {
                mimeType: "audio/wav",
                data: base64,
              },
            });
          } catch (e: any) {
            return makeError(id, -32603, `TTS error: ${e.message}`);
          }
        }

        if (toolName === "tts-create-api-key") {
          const { masterKey, name } = params || {};
          if (!masterKey || masterKey !== masterApiKey) {
            return makeError(id, -32601, "Invalid master key");
          }
          const newKey = createApiKey(name);
          return makeResult(id, {
            content: [
              {
                type: "text",
                text: `✅ Neuer API-Key erstellt:\n\`\`\`\n${newKey}\n\`\`\`\n\nBitte sicher aufbewahren! Dieser Key wird nur einmal angezeigt.`,
              },
            ],
          });
        }

        if (toolName === "tts-list-api-keys") {
          const { masterKey } = params || {};
          if (!masterKey || masterKey !== masterApiKey) {
            return makeError(id, -32601, "Invalid master key");
          }
          const keys = listApiKeys();
          return makeResult(id, {
            content: [
              {
                type: "text",
                text: `📋 API-Keys (${keys.length}):\n\n${keys.map(k => 
                  `• ${k.name || 'unnamed'} (erstellt: ${k.createdAt.toISOString()}, zuletzt verwendet: ${k.lastUsed?.toISOString() || 'nie'})`
                ).join('\n')}`,
              },
            ],
          });
        }

        if (toolName === "tts-revoke-api-key") {
          const { key, masterKey } = params || {};
          if (!masterKey || masterKey !== masterApiKey) {
            return makeError(id, -32601, "Invalid master key");
          }
          if (!key) {
            return makeError(id, -32602, "key is required");
          }
          const revoked = revokeApiKey(key);
          return makeResult(id, {
            content: [
              {
                type: "text",
                text: revoked ? `✅ API-Key widerrufen` : `❌ API-Key nicht gefunden`,
              },
            ],
          });
        }

        return makeError(id, -32602, `Tool not found: ${toolName}`);
      }

      // ── Ping / Unbekannt ────────────────────────────────────────────────
      case "ping": {
        if (session) session.lastSeen = new Date();
        return makeResult(id, {});
      }

      default:
        return makeError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return makeError(id, -32603, `Internal error: ${e.message}`);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readSkillFile(): string {
  try {
    return fs.readFileSync(findSkillPath(), "utf-8");
  } catch {
    return "# TTS-Skill\n\nDer Skill konnte nicht geladen werden. Bitte Pfad prüfen:\n/workspaces/Zero-Token-Explotion/skills/tts-de/SKILL.md";
  }
}

function sseSend(res: http.ServerResponse, event: string, data: string) {
  try {
    res.write(`event: ${event}\ndata: ${data}\n\n`);
  } catch {}
}

function makeResult(id: any, result: any) {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

let _idCounter = 0;
function generateId(): string {
  return `sess_${Date.now()}_${++_idCounter}`;
}
