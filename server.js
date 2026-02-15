import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const envPath = path.join(__dirname, ".env");

// ---------------------------------------------------------------------------
// Load .env
// ---------------------------------------------------------------------------
if (fsSync.existsSync(envPath)) {
  const rawEnv = fsSync.readFileSync(envPath, "utf8");
  for (const line of rawEnv.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

const PORT = Number(process.env.PORT || 3000);
const CALENDLY_URL = process.env.CALENDLY_URL || "https://calendly.com";
const STRIPE_PAYMENT_LINK = process.env.STRIPE_PAYMENT_LINK || "";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webp": "image/webp",
};

async function serveStatic(urlPath, res) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = path.normalize(cleanPath).replace(/^\.+/, "");
  const fullPath = path.join(publicDir, safePath);

  if (!fullPath.startsWith(publicDir)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = parsedUrl;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  // Health check
  if (req.method === "GET" && pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  // Config endpoint — gives the frontend what it needs
  if (req.method === "GET" && pathname === "/api/config") {
    json(res, 200, {
      calendlyUrl: CALENDLY_URL,
      stripePaymentLink: STRIPE_PAYMENT_LINK || null,
    });
    return;
  }

  // Static files
  if (req.method === "GET") {
    await serveStatic(pathname, res);
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Stories We Keep running at http://localhost:${PORT}`);
});
