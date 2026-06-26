const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPOSITORY = "bkgoder/Zero-Token-Explotion";
const MANIFEST_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/manifest/runtime-v1.json`;
const WASMEDGE_VERSION = "0.14.1";
const WASMEDGE_INSTALLER = `https://raw.githubusercontent.com/WasmEdge/WasmEdge/${WASMEDGE_VERSION}/utils/install_v2.sh`;

async function installRuntime(context, backendId, progress, outputChannel, force = false) {
  const manifest = await loadManifest();
  const backend = manifest.backends && manifest.backends[backendId];
  if (!backend) throw new Error(`Backend nicht im Runtime-Manifest: ${backendId}`);
  if (backend.status !== "stable") throw new Error(`Backend ist nicht stabil freigegeben: ${backendId}`);

  const platform = process.platform === "win32" ? "windows" : process.platform;
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const targetId = `${platform}-${architecture}`;
  const target = backend.targets && backend.targets[targetId];
  if (!target) throw new Error(`Kein freigegebenes Runtime-Paket für ${targetId}`);

  const installDir = path.join(context.globalStoragePath, "tts-server");
  const statePath = path.join(installDir, "runtime-state.json");
  if (!force && isInstalledStateCurrent(statePath, backendId, backend.releaseTag, target.asset)) {
    outputChannel.appendLine(`[Runtime] Bereits installiert: ${backend.releaseTag}/${target.asset}`);
    return { manifest, backend, targetId, installDir };
  }

  fs.mkdirSync(installDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "zero-token-tts-"));
  const archivePath = path.join(tempDir, target.asset);
  const checksumsPath = path.join(tempDir, target.checksumAsset);
  const releaseBase = `https://github.com/${manifest.repository}/releases/download/${backend.releaseTag}`;

  try {
    progress.report({ message: `Lade Runtime ${targetId} aus ${manifest.repository} …`, increment: 10 });
    await downloadFile(`${releaseBase}/${target.asset}`, archivePath);
    await downloadFile(`${releaseBase}/${target.checksumAsset}`, checksumsPath);

    progress.report({ message: "Prüfe SHA-256 …", increment: 15 });
    const expected = readExpectedChecksum(checksumsPath, target.asset);
    const actual = sha256(archivePath);
    if (expected !== actual) throw new Error(`SHA-256-Prüfung fehlgeschlagen: erwartet ${expected}, erhalten ${actual}`);

    progress.report({ message: "Entpacke Runtime in den VS-Code-Speicher …", increment: 20 });
    if (force) clearInstallDirectory(installDir);
    const extraction = spawnSync("tar", ["-xzf", archivePath, "-C", installDir], {
      encoding: "utf8",
      timeout: 180000,
    });
    if (extraction.status !== 0) throw new Error(extraction.stderr || "Runtime konnte nicht entpackt werden");

    const genericServer = path.join(installDir, "zero-token-tts-server");
    const expectedServer = path.join(installDir, process.platform === "win32" ? "zero-token-tts-server.exe" : `zero-token-tts-server-${architecture}`);
    if (fs.existsSync(genericServer) && !fs.existsSync(expectedServer)) fs.renameSync(genericServer, expectedServer);
    for (const executable of [expectedServer, path.join(installDir, "piper")]) {
      if (process.platform !== "win32" && fs.existsSync(executable)) fs.chmodSync(executable, 0o755);
    }

    const required = [
      expectedServer,
      path.join(installDir, process.platform === "win32" ? "piper.exe" : "piper"),
      path.join(installDir, backend.defaultModel + ".onnx"),
      path.join(installDir, backend.defaultModel + ".onnx.json"),
      path.join(installDir, "espeak-ng-data"),
    ];
    const missing = required.filter((entry) => !fs.existsSync(entry));
    if (missing.length) throw new Error(`Runtime unvollständig: ${missing.join(", ")}`);

    const state = {
      repository: manifest.repository,
      manifestVersion: manifest.manifestVersion,
      backend: backendId,
      target: targetId,
      releaseTag: backend.releaseTag,
      asset: target.asset,
      sha256: actual,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    outputChannel.appendLine(`[Runtime] Installiert: ${JSON.stringify(state)}`);
    progress.report({ message: "Runtime vollständig installiert", increment: 35 });
    return { manifest, backend, targetId, installDir };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function installWasmEdgeLocal(context, progress, outputChannel, force = false) {
  if (process.platform !== "linux") throw new Error("Die automatische WasmEdge-Installation unterstützt derzeit Linux");
  const localHome = path.join(context.globalStoragePath, "wasmedge-home");
  const executable = path.join(localHome, ".wasmedge", "bin", "wasmedge");
  if (!force && fs.existsSync(executable)) return executable;

  fs.mkdirSync(localHome, { recursive: true });
  const installer = path.join(localHome, "install-wasmedge.sh");
  progress.report({ message: `Lade WasmEdge ${WASMEDGE_VERSION} …`, increment: 5 });
  await downloadFile(WASMEDGE_INSTALLER, installer);
  fs.chmodSync(installer, 0o755);

  const result = spawnSync("bash", [installer, "-v", WASMEDGE_VERSION], {
    cwd: localHome,
    env: { ...process.env, HOME: localHome },
    encoding: "utf8",
    timeout: 300000,
  });
  if (result.status !== 0 || !fs.existsSync(executable)) {
    outputChannel.appendLine(`[WasmEdge] ${result.stderr || result.stdout || "Installation fehlgeschlagen"}`);
    throw new Error("WasmEdge konnte nicht lokal installiert werden");
  }
  outputChannel.appendLine(`[WasmEdge] Lokal installiert: ${executable}`);
  return executable;
}

async function loadManifest() {
  const body = await downloadText(MANIFEST_URL);
  const manifest = JSON.parse(body);
  if (manifest.schemaVersion !== 1 || manifest.repository !== REPOSITORY || !manifest.backends) {
    throw new Error("Ungültiges oder unerwartetes Runtime-Manifest");
  }
  return manifest;
}

function isInstalledStateCurrent(file, backend, releaseTag, asset) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state.repository === REPOSITORY && state.backend === backend && state.releaseTag === releaseTag && state.asset === asset;
  } catch {
    return false;
  }
}

function clearInstallDirectory(dir) {
  for (const entry of fs.readdirSync(dir)) {
    if (entry === "runtime-state.json") continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

function readExpectedChecksum(file, asset) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const line = lines.find((entry) => entry.trim().endsWith(`  ${asset}`) || entry.trim().endsWith(` *${asset}`));
  if (!line) throw new Error(`Keine SHA-256-Prüfsumme für ${asset}`);
  return line.trim().split(/\s+/)[0].toLowerCase();
}

function sha256(file) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function downloadText(url) {
  return new Promise((resolve, reject) => {
    requestUrl(url, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }, reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const partial = destination + ".part";
    const file = fs.createWriteStream(partial);
    requestUrl(url, (response) => {
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        fs.renameSync(partial, destination);
        resolve();
      });
    }, (error) => {
      file.close();
      try { fs.unlinkSync(partial); } catch {}
      reject(error);
    });
  });
}

function requestUrl(url, onResponse, onError) {
  const client = url.startsWith("https:") ? https : http;
  const request = client.get(url, {
    headers: { "User-Agent": "Zero-Token-TTS-Extension" },
    timeout: 60000,
  }, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      requestUrl(new URL(response.headers.location, url).toString(), onResponse, onError);
      return;
    }
    if (response.statusCode !== 200) {
      response.resume();
      onError(new Error(`Download fehlgeschlagen: HTTP ${response.statusCode} ${url}`));
      return;
    }
    onResponse(response);
  });
  request.on("timeout", () => request.destroy(new Error(`Download-Zeitüberschreitung: ${url}`)));
  request.on("error", onError);
}

module.exports = { installRuntime, installWasmEdgeLocal, loadManifest };
