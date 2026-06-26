#!/usr/bin/env node

// ══════════════════════════════════════════════════════════════════════════════
// Standalone TTS + MCP Server — Single Binary via pkg
// ══════════════════════════════════════════════════════════════════════════════

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { spawn, ChildProcess } = require("child_process");
const crypto = require("crypto");

// ─── Config ──────────────────────────────────────────────────────────────────

const MCP_PORT = process.env.MCP_PORT || 18764;
const TTS_PORT = process.env.TTS_PORT || 18765;
const ASSETS_DIR = process.env.TTS_ASSETS_DIR || (process.pkg ? path.join(path.dirname(process.execPath), "tts-server") : path.join(__dirname, "..", "tts-server"));
const STARTED_AT = Date.now();
const APP_VERSION = (() => {
  try {
    return require("./package.json").version || "unknown";
  } catch {
    return "unknown";
  }
})();

// ─── API Key Management ──────────────────────────────────────────────────────

const apiKeys = new Map();
let masterApiKey = null;

function generateApiKey() {
  const bytes = crypto.randomBytes(32);
  return `tts_${bytes.toString("hex")}`;
}

function createApiKey(name) {
  const key = generateApiKey();
  apiKeys.set(key, { createdAt: new Date(), name: name || "default" });
  return key;
}

function validateApiKey(key) {
  return apiKeys.has(key);
}

function getMasterApiKey() {
  return masterApiKey;
}

function setMasterApiKey(key) {
  masterApiKey = key;
}

function listApiKeys() {
  return Array.from(apiKeys.entries()).map(([key, data]) => ({
    key: key.substring(0, 8) + "...",
    fullKey: key,
    ...data,
  }));
}

function revokeApiKey(key) {
  return apiKeys.delete(key);
}

// ─── Piper TTS Engine ─────────────────────────────────────────────────────────

class PiperEngine {
  constructor() {
    this.binDir = this.getBinDir();
    this.modelPath = path.join(this.binDir, "de_DE-eva_k-x_low.onnx");
    this.configPath = path.join(this.binDir, "de_DE-eva_k-x_low.onnx.json");
    this.espeakDir = path.join(this.binDir, "espeak-ng-data");
    this.piperPath = path.join(this.binDir, "piper");
    this.process = null;
  }

  getBinDir() {
    // In pkg, __dirname points to the extracted assets
    if (process.pkg && process.pkg.entrypoint) {
      return ASSETS_DIR;
    }
    // Development: use relative path
    return path.join(__dirname, "..", "tts-server");
  }

  ensureExecutable() {
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(this.piperPath, 0o755);
      } catch (e) {
        // Ignore if already executable
      }
    }
  }

  async synthesize(text) {
    this.ensureExecutable();

    if (!fs.existsSync(this.piperPath)) {
      throw new Error(`Piper binary not found at ${this.piperPath}`);
    }
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Model not found at ${this.modelPath}`);
    }

    return new Promise((resolve, reject) => {
      const args = [
        "--model", this.modelPath,
        "--config", this.configPath,
        "--output-raw",
        "--espeak-ng-dir", this.espeakDir,
      ];

      const piper = spawn(this.piperPath, args, {
        cwd: this.binDir,
        env: {
          ...process.env,
          LD_LIBRARY_PATH: this.binDir + (process.platform === "win32" ? ";" : ":") + (process.env.LD_LIBRARY_PATH || ""),
        },
      });

      let stdout = [];
      let stderr = [];

      piper.stdout.on("data", (d) => stdout.push(d));
      piper.stderr.on("data", (d) => stderr.push(d));

      piper.on("error", (err) => {
        reject(new Error(`Piper error: ${err.message}`));
      });

      piper.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Piper exited with code ${code}: ${Buffer.concat(stderr).toString()}`));
          return;
        }

        // Piper outputs raw PCM, convert to WAV
        const pcm = Buffer.concat(stdout);
        const wav = this.pcmToWav(pcm, 22050, 1, 16);
        resolve(wav);
      });

      // Send text to Piper's stdin
      piper.stdin.write(text);
      piper.stdin.end();
    });
  }

  pcmToWav(pcm, sampleRate, channels, bitsPerSample) {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataSize = pcm.length;
    const buffer = Buffer.alloc(44 + dataSize);

    // WAV header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16); // chunk size
    buffer.writeUInt16LE(1, 20); // PCM format
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);

    pcm.copy(buffer, 44);
    return buffer;
  }
}

const piperEngine = new PiperEngine();

function getStatusPayload(extra = {}) {
  return {
    status: "running",
    version: APP_VERSION,
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    startedAt: new Date(STARTED_AT).toISOString(),
    ...extra,
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function synthesizeAndRespond(req, res, inputKey) {
  try {
    const params = await readJsonBody(req);
    const text = String(params[inputKey] || "").trim();
    if (!text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "text is required" }));
      return;
    }

    const audio = await piperEngine.synthesize(text);
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(audio);
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── TTS HTTP Server ──────────────────────────────────────────────────────────

function startTtsServer(port = TTS_PORT) {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/speech") {
      void synthesizeAndRespond(req, res, "input");
      return;
    }

    if (req.method === "POST" && req.url === "/api/tts") {
      void synthesizeAndRespond(req, res, "text");
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatusPayload({ port, transport: "tts-http" })));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, () => {
    console.log(`TTS server running on port ${port}`);
  });

  return server;
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

function startMcpServer(port = MCP_PORT) {
  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatusPayload({
        ttsPort: TTS_PORT,
        mcpPort: MCP_PORT,
        apiKeys: apiKeys.size,
        transport: "mcp-http",
      })));
      return;
    }

    if (req.method === "GET" && req.url === "/sse") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });
      res.write(`event: endpoint\ndata: /mcp\n\n`);
      res.write(`event: ready\ndata: ${JSON.stringify(getStatusPayload({ transport: "mcp-sse" }))}\n\n`);

      const keepAlive = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        res.end();
      });
      return;
    }

    // Direct TTS API
    if (req.method === "POST" && req.url === "/api/tts") {
      const apiKey = req.headers["x-api-key"];
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

          const keyData = apiKeys.get(apiKey);
          if (keyData) keyData.lastUsed = new Date();

          const audio = await piperEngine.synthesize(text);
          res.writeHead(200, { "Content-Type": "audio/wav" });
          res.end(audio);
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // API Key management
    if (req.method === "POST" && req.url === "/api/keys") {
      const apiKey = req.headers["x-api-key"];
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
              res.end(JSON.stringify({ key: newKey, name: params.name || "default" }));
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
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // MCP JSON-RPC
    if (req.method === "POST" && req.url === "/mcp") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const rpc = JSON.parse(body);
          const id = rpc.id;
          const method = rpc.method;
          const params = rpc.params;

          if (method === "initialize") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "zero-token-tts", version: "1.0.0" },
              },
            }));
            return;
          }

          if (method === "tools/list") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              id,
              result: {
                tools: [
                  {
                    name: "tts-speak",
                    description: "Synthesizes text to speech (requires API key)",
                    inputSchema: {
                      type: "object",
                      properties: {
                        text: { type: "string", description: "Text to synthesize" },
                        apiKey: { type: "string", description: "API key for authentication" },
                      },
                      required: ["text", "apiKey"],
                    },
                  },
                  {
                    name: "tts-create-api-key",
                    description: "Creates a new API key for direct TTS access (master key only)",
                    inputSchema: {
                      type: "object",
                      properties: {
                        name: { type: "string", description: "Name for the API key" },
                        masterKey: { type: "string", description: "Master API key for authorization" },
                      },
                      required: ["masterKey"],
                    },
                  },
                  {
                    name: "tts-list-api-keys",
                    description: "Lists all API keys (master key only)",
                    inputSchema: {
                      type: "object",
                      properties: {
                        masterKey: { type: "string", description: "Master API key for authorization" },
                      },
                      required: ["masterKey"],
                    },
                  },
                  {
                    name: "tts-revoke-api-key",
                    description: "Revokes an API key (master key only)",
                    inputSchema: {
                      type: "object",
                      properties: {
                        key: { type: "string", description: "API key to revoke" },
                        masterKey: { type: "string", description: "Master API key for authorization" },
                      },
                      required: ["key", "masterKey"],
                    },
                  },
                ],
              },
            }));
            return;
          }

          if (method === "tools/call") {
            const toolName = params?.name || "";

            if (toolName === "tts-speak") {
              const { text, apiKey } = params || {};
              if (!text || !apiKey) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32602, message: "text and apiKey are required" },
                }));
                return;
              }
              if (!validateApiKey(apiKey)) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: "Invalid API key" },
                }));
                return;
              }

              const keyData = apiKeys.get(apiKey);
              if (keyData) keyData.lastUsed = new Date();

              try {
                const audio = await piperEngine.synthesize(text);
                const base64 = audio.toString("base64");
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: `TTS generated (${text.length} chars)\n\nAudio: ${base64.length} chars base64` }],
                    audio: { mimeType: "audio/wav", data: base64 },
                  },
                }));
              } catch (e) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32603, message: `TTS error: ${e.message}` },
                }));
              }
              return;
            }

            if (toolName === "tts-create-api-key") {
              const { masterKey, name } = params || {};
              if (!masterKey || masterKey !== masterApiKey) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: "Invalid master key" },
                }));
                return;
              }
              const newKey = createApiKey(name);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: `New API key:\n\`\`\`\n${newKey}\n\`\`\`` }],
                },
              }));
              return;
            }

            if (toolName === "tts-list-api-keys") {
              const { masterKey } = params || {};
              if (!masterKey || masterKey !== masterApiKey) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: "Invalid master key" },
                }));
                return;
              }
              const keys = listApiKeys();
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{
                    type: "text",
                    text: `API Keys (${keys.length}):\n${keys.map(k => `- ${k.name || "unnamed"} (created: ${k.createdAt.toISOString()}, last used: ${k.lastUsed?.toISOString() || "never"})`).join("\n")}`,
                  }],
                },
              }));
              return;
            }

            if (toolName === "tts-revoke-api-key") {
              const { key, masterKey } = params || {};
              if (!masterKey || masterKey !== masterApiKey) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32601, message: "Invalid master key" },
                }));
                return;
              }
              if (!key) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32602, message: "key is required" },
                }));
                return;
              }
              const revoked = revokeApiKey(key);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({
                jsonrpc: "2.0",
                id,
                result: {
                  content: [{ type: "text", text: revoked ? "API key revoked" : "API key not found" }],
                },
              }));
              return;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Tool not found: ${toolName}` },
            }));
            return;
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: "Method not found" },
          }));
        } catch (e) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: -32700, message: `Parse error: ${e.message}` },
          }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.listen(port, () => {
    console.log(`MCP server running on port ${port}`);
  });

  return server;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Starting Zero-Token TTS Server...");

  // Create assets directory if it doesn't exist (for pkg)
  if (process.pkg && !fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }

  // Start servers
  const ttsServer = startTtsServer(TTS_PORT);
  const mcpServer = startMcpServer(MCP_PORT);

  console.log(`TTS Server: http://localhost:${TTS_PORT}`);
  console.log(`MCP Server: http://localhost:${MCP_PORT}`);
  console.log("Press Ctrl+C to stop");

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    ttsServer.close();
    mcpServer.close();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
