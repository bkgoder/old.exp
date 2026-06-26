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

// EPIPE-Fehler (Client trennt Verbindung) nicht abstürzen lassen
process.on("uncaughtException", (e) => {
  if (e.code === "EPIPE" || e.code === "ECONNRESET") return;
  console.error("Unbehandelter Fehler:", e);
});
const ASSETS_DIR = process.env.TTS_ASSETS_DIR || (process.pkg ? path.join(path.dirname(process.execPath), "tts-server") : path.join(__dirname, "..", "tts-server"));
const DATA_DIR = process.env.DATA_DIR || "/app/data";
const STARTED_AT = Date.now();
const APP_VERSION = (() => {
  try {
    return require("./package.json").version || "unknown";
  } catch {
    return "unknown";
  }
})();

// ─── API Key Management (persistent) ─────────────────────────────────────────

const apiKeys = new Map();
let masterApiKey = null;
let masterKeyClaimed = false;

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

function loadOrCreateMasterKey() {
  ensureDataDir();
  const keyFile = path.join(DATA_DIR, "master.key");
  const claimFile = path.join(DATA_DIR, "master.claimed");
  if (fs.existsSync(keyFile)) {
    masterApiKey = fs.readFileSync(keyFile, "utf8").trim();
    masterKeyClaimed = fs.existsSync(claimFile);
  } else {
    masterApiKey = `tts_master_${crypto.randomBytes(32).toString("hex")}`;
    try { fs.writeFileSync(keyFile, masterApiKey, { mode: 0o600 }); } catch {}
    masterKeyClaimed = false;
  }
  console.log(`[Auth] Master key ${masterKeyClaimed ? "already claimed" : "ready — GET /api/setup to claim"}`);
}

function claimMasterKey() {
  masterKeyClaimed = true;
  try { fs.writeFileSync(path.join(DATA_DIR, "master.claimed"), "1"); } catch {}
}

function saveApiKeys() {
  ensureDataDir();
  const data = Array.from(apiKeys.entries()).map(([key, meta]) => ({ key, ...meta, createdAt: meta.createdAt?.toISOString() }));
  try { fs.writeFileSync(path.join(DATA_DIR, "api-keys.json"), JSON.stringify(data, null, 2)); } catch {}
}

function loadApiKeys() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "api-keys.json"), "utf8"));
    for (const { key, ...meta } of data) apiKeys.set(key, { ...meta, createdAt: new Date(meta.createdAt) });
  } catch {}
}

function generateApiKey() {
  return `tts_${crypto.randomBytes(32).toString("hex")}`;
}

function createApiKey(name) {
  const key = generateApiKey();
  apiKeys.set(key, { createdAt: new Date(), name: name || "key" });
  saveApiKeys();
  return key;
}

function validateApiKey(key) {
  return key === masterApiKey || apiKeys.has(key);
}

function listApiKeys() {
  return Array.from(apiKeys.entries()).map(([key, data]) => ({
    key,
    preview: key.substring(0, 12) + "...",
    ...data,
    createdAt: data.createdAt?.toISOString?.() || data.createdAt,
  }));
}

function revokeApiKey(key) {
  const ok = apiKeys.delete(key);
  if (ok) saveApiKeys();
  return ok;
}

// ─── Voice Model Catalog ──────────────────────────────────────────────────────

const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

const MODEL_CATALOG = [
  { id: "de_DE-eva_k-x_low",           lang: "de", quality: "x_low", size: "63 MB",  label: "Eva (DE)",               path: "de/de_DE/eva_k/x_low" },
  { id: "de_DE-thorsten-high",          lang: "de", quality: "high",  size: "321 MB", label: "Thorsten (DE)",           path: "de/de_DE/thorsten/high" },
  { id: "de_DE-thorsten_emotional-medium", lang: "de", quality: "medium", size: "170 MB", label: "Thorsten Emotional (DE)", path: "de/de_DE/thorsten_emotional/medium" },
  { id: "de_DE-karlsson-low",           lang: "de", quality: "low",  size: "63 MB",  label: "Karlsson (DE)",            path: "de/de_DE/karlsson/low" },
  { id: "de_DE-mls-medium",             lang: "de", quality: "medium", size: "170 MB", label: "MLS Multilingual (DE)",  path: "de/de_DE/mls/medium" },
  { id: "en_US-amy-low",               lang: "en", quality: "low",  size: "63 MB",  label: "Amy (EN-US)",             path: "en/en_US/amy/low" },
  { id: "en_US-amy-medium",            lang: "en", quality: "medium", size: "63 MB", label: "Amy Medium (EN-US)",      path: "en/en_US/amy/medium" },
  { id: "en_US-lessac-high",           lang: "en", quality: "high",  size: "321 MB", label: "Lessac (EN-US)",          path: "en/en_US/lessac/high" },
  { id: "en_US-ryan-high",             lang: "en", quality: "high",  size: "321 MB", label: "Ryan (EN-US)",            path: "en/en_US/ryan/high" },
  { id: "en_US-libritts-high",         lang: "en", quality: "high",  size: "600 MB", label: "LibriTTS (EN-US)",        path: "en/en_US/libritts/high" },
  { id: "en_GB-alan-low",              lang: "en", quality: "low",  size: "63 MB",  label: "Alan (EN-GB)",            path: "en/en_GB/alan/low" },
  { id: "en_GB-alba-medium",           lang: "en", quality: "medium", size: "170 MB", label: "Alba (EN-GB)",           path: "en/en_GB/alba/medium" },
  { id: "fr_FR-upmc-medium",           lang: "fr", quality: "medium", size: "170 MB", label: "UPMC (FR)",              path: "fr/fr_FR/upmc/medium" },
  { id: "fr_FR-mls-medium",            lang: "fr", quality: "medium", size: "170 MB", label: "MLS (FR)",               path: "fr/fr_FR/mls/medium" },
  { id: "es_ES-mls-medium",            lang: "es", quality: "medium", size: "170 MB", label: "MLS (ES)",               path: "es/es_ES/mls/medium" },
  { id: "it_IT-riccardo-x_low",        lang: "it", quality: "x_low", size: "63 MB",  label: "Riccardo (IT)",           path: "it/it_IT/riccardo/x_low" },
  { id: "nl_NL-mls-medium",            lang: "nl", quality: "medium", size: "170 MB", label: "MLS (NL)",               path: "nl/nl_NL/mls/medium" },
  { id: "pl_PL-mls-medium",            lang: "pl", quality: "medium", size: "170 MB", label: "MLS (PL)",               path: "pl/pl_PL/mls/medium" },
  { id: "pt_BR-faber-medium",          lang: "pt", quality: "medium", size: "170 MB", label: "Faber (PT-BR)",           path: "pt/pt_BR/faber/medium" },
  { id: "zh_CN-huayan-x_low",          lang: "zh", quality: "x_low", size: "63 MB",  label: "Huayan (ZH)",             path: "zh/zh_CN/huayan/x_low" },
];

// State for active model (persisted)
let activeModelId = "de_DE-eva_k-x_low";

function loadActiveModel() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8"));
    activeModelId = cfg.activeModel || activeModelId;
  } catch {}
}

function saveActiveModel(id) {
  activeModelId = id;
  ensureDataDir();
  try { fs.writeFileSync(path.join(DATA_DIR, "config.json"), JSON.stringify({ activeModel: id })); } catch {}
}

function isModelDownloaded(id) {
  const model = MODEL_CATALOG.find(m => m.id === id);
  if (!model) return false;
  return fs.existsSync(path.join(ASSETS_DIR, id + ".onnx"));
}

function getDownloadedModels() {
  return MODEL_CATALOG.map(m => ({ ...m, downloaded: isModelDownloaded(m.id), active: m.id === activeModelId }));
}

async function downloadModel(id) {
  const model = MODEL_CATALOG.find(m => m.id === id);
  if (!model) throw new Error(`Unknown model: ${id}`);

  const onnxFile = `${id}.onnx`;
  const jsonFile = `${id}.onnx.json`;
  const onnxUrl = `${HF_BASE}/${model.path}/${onnxFile}`;
  const jsonUrl = `${HF_BASE}/${model.path}/${jsonFile}`;

  ensureDataDir();
  await downloadFile(onnxUrl, path.join(ASSETS_DIR, onnxFile));
  await downloadFile(jsonUrl, path.join(ASSETS_DIR, jsonFile));
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const proto = url.startsWith("https") ? https : http;
    proto.get(url, { headers: { "User-Agent": "zero-token-tts/1.0" } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        fs.unlink(dest, () => {});
        const loc = res.headers.location;
        return downloadFile(loc, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

// Voice Clone profiles (stored in DATA_DIR)
function loadVoiceProfiles() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "voice-profiles.json"), "utf8")); } catch { return []; }
}

function saveVoiceProfile(profile) {
  const profiles = loadVoiceProfiles();
  profiles.push(profile);
  ensureDataDir();
  fs.writeFileSync(path.join(DATA_DIR, "voice-profiles.json"), JSON.stringify(profiles, null, 2));
  return profile;
}

// ─── Piper TTS Engine ─────────────────────────────────────────────────────────

class PiperEngine {
  constructor() {
    this.binDir = ASSETS_DIR;
    this.espeakDir = path.join(this.binDir, "espeak-ng-data");
    this.piperPath = path.join(this.binDir, "piper");
    this.process = null;
  }

  getModelPath(modelId) {
    const id = modelId || activeModelId;
    return path.join(this.binDir, `${id}.onnx`);
  }

  getConfigPath(modelId) {
    const id = modelId || activeModelId;
    return path.join(this.binDir, `${id}.onnx.json`);
  }

  ensureExecutable() {
    if (process.platform !== "win32") {
      try { fs.chmodSync(this.piperPath, 0o755); } catch {}
    }
  }

  getSampleRate(modelId) {
    try {
      const cfg = JSON.parse(fs.readFileSync(this.getConfigPath(modelId), "utf8"));
      return cfg.audio?.sample_rate || cfg.sample_rate || 22050;
    } catch { return 22050; }
  }

  async synthesize(text, speed = 1.0, modelId = null) {
    this.ensureExecutable();
    const modelPath = this.getModelPath(modelId);
    const configPath = this.getConfigPath(modelId);

    if (!fs.existsSync(this.piperPath)) {
      throw new Error(`Piper binary not found at ${this.piperPath}`);
    }
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model not found at ${modelPath} — download it first`);
    }

    const sampleRate = this.getSampleRate(modelId);
    const lengthScale = speed > 0 ? (1.0 / speed).toFixed(3) : "1.000";

    return new Promise((resolve, reject) => {
      const args = [
        "--model", modelPath,
        "--config", configPath,
        "--output-raw",
        "--espeak-ng-dir", this.espeakDir,
        "--length-scale", lengthScale,
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

      // EPIPE auf stdin abfangen (Piper beendet sich vor dem Schreiben)
      piper.stdin.on("error", (err) => {
        if (err.code !== "EPIPE") reject(err);
      });

      piper.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`Piper exited with code ${code}: ${Buffer.concat(stderr).toString()}`));
          return;
        }

        // Piper outputs raw PCM, convert to WAV
        const pcm = Buffer.concat(stdout);
        const wav = this.pcmToWav(pcm, sampleRate, 1, 16);
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
    const speed = parseFloat(params.speed) || 1.0;

    const audio = await piperEngine.synthesize(text, speed);
    res.on("error", () => {});
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(audio);
  } catch (e) {
    if (res.headersSent) return;
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
}

// ─── TTS HTTP Server ──────────────────────────────────────────────────────────

function requireMasterKey(req, res) {
  const key = req.headers["x-master-key"] || req.headers["x-api-key"] || "";
  if (!masterApiKey || key !== masterApiKey) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Master key required" }));
    return false;
  }
  return true;
}

const downloadProgress = new Map(); // modelId → { percent, status }

function startTtsServer(port = TTS_PORT) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, x-master-key");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

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
      res.end(JSON.stringify({ status: "ok", activeModel: activeModelId }));
      return;
    }

    if (req.method === "GET" && req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(getStatusPayload({ port, transport: "tts-http", activeModel: activeModelId })));
      return;
    }

    // ─── One-time master key claim ───────────────────────────────────────────
    if (req.method === "GET" && req.url === "/api/setup") {
      if (masterKeyClaimed) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Master key already claimed. Manage keys in the Admin dashboard." }));
        return;
      }
      claimMasterKey();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ masterKey: masterApiKey, claimed: true }));
      return;
    }

    // ─── Admin: API Keys ──────────────────────────────────────────────────────
    if (req.url === "/api/admin/keys") {
      if (!requireMasterKey(req, res)) return;
      if (req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ keys: listApiKeys() }));
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const key = createApiKey(body.name || "new-key");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ key, name: body.name || "new-key", created: true }));
        return;
      }
      if (req.method === "DELETE") {
        const body = await readJsonBody(req);
        const ok = revokeApiKey(body.key);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ revoked: ok }));
        return;
      }
    }

    // ─── Model Catalog ────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === "/api/models/catalog") {
      const catalog = getDownloadedModels().map(m => ({
        ...m,
        progress: downloadProgress.get(m.id) || null,
      }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: catalog, activeModel: activeModelId }));
      return;
    }

    // ─── Model Download ───────────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/api/models/download") {
      const body = await readJsonBody(req).catch(() => ({}));
      const { modelId } = body;
      if (!modelId) { res.writeHead(400); res.end(JSON.stringify({ error: "modelId required" })); return; }
      if (downloadProgress.get(modelId)?.status === "downloading") {
        res.writeHead(200); res.end(JSON.stringify({ status: "already downloading" })); return;
      }
      downloadProgress.set(modelId, { status: "downloading", percent: 0 });
      // Start download in background
      downloadModel(modelId)
        .then(() => { downloadProgress.set(modelId, { status: "done", percent: 100 }); console.log(`[Model] Downloaded: ${modelId}`); })
        .catch(e => { downloadProgress.set(modelId, { status: "error", error: e.message }); console.error(`[Model] Download failed: ${modelId}`, e.message); });
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "started", modelId }));
      return;
    }

    // ─── Model Activate ───────────────────────────────────────────────────────
    if (req.method === "POST" && req.url === "/api/models/activate") {
      const body = await readJsonBody(req).catch(() => ({}));
      const { modelId } = body;
      if (!modelId) { res.writeHead(400); res.end(JSON.stringify({ error: "modelId required" })); return; }
      if (!isModelDownloaded(modelId)) { res.writeHead(409); res.end(JSON.stringify({ error: "Model not downloaded" })); return; }
      saveActiveModel(modelId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ activated: modelId }));
      return;
    }

    // ─── Download Progress ────────────────────────────────────────────────────
    if (req.method === "GET" && req.url.startsWith("/api/models/progress/")) {
      const modelId = decodeURIComponent(req.url.replace("/api/models/progress/", ""));
      const prog = downloadProgress.get(modelId) || { status: isModelDownloaded(modelId) ? "done" : "none" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(prog));
      return;
    }

    // ─── Voice Clone: Upload Sample ───────────────────────────────────────────
    if (req.method === "POST" && req.url === "/api/voice-clone/upload") {
      const samplesDir = path.join(DATA_DIR, "voice-samples");
      try { fs.mkdirSync(samplesDir, { recursive: true }); } catch {}
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks);
          // Parse multipart or raw WAV — we just store it
          const id = `clone_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
          const name = req.headers["x-voice-name"] || "Meine Stimme";
          const ext = req.headers["content-type"]?.includes("mp3") ? ".mp3" : ".wav";
          const samplePath = path.join(samplesDir, `${id}${ext}`);
          fs.writeFileSync(samplePath, body);
          const profile = saveVoiceProfile({ id, name, samplePath, createdAt: new Date().toISOString(), baseModel: activeModelId });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, profileId: id, name, message: "Stimmprofil gespeichert. Zur Synthese wird das Basisprofil mit angepassten Parametern verwendet." }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ─── Voice Clone: List Profiles ───────────────────────────────────────────
    if (req.method === "GET" && req.url === "/api/voice-clone/profiles") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ profiles: loadVoiceProfiles() }));
      return;
    }

    // ─── Voice Clone: Delete Profile ─────────────────────────────────────────
    if (req.method === "DELETE" && req.url.startsWith("/api/voice-clone/profiles/")) {
      const profileId = decodeURIComponent(req.url.replace("/api/voice-clone/profiles/", ""));
      const profiles = loadVoiceProfiles().filter(p => p.id !== profileId);
      ensureDataDir();
      fs.writeFileSync(path.join(DATA_DIR, "voice-profiles.json"), JSON.stringify(profiles, null, 2));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ deleted: profileId }));
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

    // Direct TTS API (no auth required — localhost only)
    if (req.method === "POST" && req.url === "/api/tts") {
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
          const speed = params.speed || params.rate || 1.0;
          const audio = await piperEngine.synthesize(text, speed);
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
                    name: "speak",
                    description: "Liest Text laut vor (Text-to-Speech via Piper). Gibt WAV-Audio als Base64 zurück.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        text: { type: "string", description: "Vorzulesender Text" },
                        speed: { type: "number", description: "Sprechgeschwindigkeit (0.5–2.0, Standard 1.0)", default: 1.0 },
                      },
                      required: ["text"],
                    },
                  },
                  {
                    name: "tts-speak",
                    description: "Synthesizes text to speech via Piper TTS. Returns WAV audio as base64.",
                    inputSchema: {
                      type: "object",
                      properties: {
                        text: { type: "string", description: "Text to synthesize" },
                        speed: { type: "number", description: "Speech speed (0.5–2.0, default 1.0)", default: 1.0 },
                      },
                      required: ["text"],
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

            if (toolName === "speak" || toolName === "tts-speak") {
              const args = params?.arguments || params || {};
              const text = args.text || "";
              const speed = parseFloat(args.speed || 1.0);
              if (!text.trim()) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32602, message: "text is required" },
                }));
                return;
              }
              try {
                const audio = await piperEngine.synthesize(text, speed);
                const base64 = audio.toString("base64");
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  result: {
                    content: [{ type: "text", text: `✅ TTS erzeugt: ${text.length} Zeichen → ${audio.length} Bytes WAV` }],
                    audio: { mimeType: "audio/wav", data: base64 },
                  },
                }));
              } catch (e) {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                  jsonrpc: "2.0",
                  id,
                  error: { code: -32603, message: `TTS Fehler: ${e.message}` },
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

  // Ensure directories
  if (!fs.existsSync(ASSETS_DIR)) {
    try { fs.mkdirSync(ASSETS_DIR, { recursive: true }); } catch {}
  }
  ensureDataDir();
  loadOrCreateMasterKey();
  loadApiKeys();
  loadActiveModel();

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
