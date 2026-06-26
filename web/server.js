#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

const WEB_PORT = parseInt(process.env.WEB_PORT || "3000", 10);
const TTS_BACKEND = process.env.TTS_BACKEND || "http://localhost:18765";
const MCP_BACKEND = process.env.MCP_BACKEND || "http://localhost:18764";
const WEB_ROOT = __dirname;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
};

function proxyRequest(req, res, targetBase) {
  const targetUrl = new URL(req.url || "/", targetBase);
  const headers = { ...req.headers, host: targetUrl.host };

  const proxyReq = http.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ error: "proxy_error", message: error.message }));
  });

  req.on("aborted", () => proxyReq.destroy());
  req.pipe(proxyReq);
}

function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(WEB_ROOT, relativePath);

  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Content-Length": stats.size,
    });

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    });
    stream.pipe(res);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;

  if (pathname.startsWith("/api/") || pathname === "/health" || pathname.startsWith("/v1/")) {
    return proxyRequest(req, res, TTS_BACKEND);
  }

  if (pathname === "/status" || pathname === "/mcp" || pathname === "/sse" || pathname.startsWith("/mcp/")) {
    return proxyRequest(req, res, MCP_BACKEND);
  }

  return serveStatic(req, res, pathname);
});

server.listen(WEB_PORT, "0.0.0.0", () => {
  console.log(`Web UI server running on http://0.0.0.0:${WEB_PORT}`);
});
