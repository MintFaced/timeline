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
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const CALENDLY_URL = process.env.CALENDLY_URL || "https://calendly.com";
const PRICE_AMOUNT = Number(process.env.PRICE_AMOUNT || 29900); // $299.00
const PRICE_CURRENCY = process.env.PRICE_CURRENCY || "usd";

// ---------------------------------------------------------------------------
// Stripe (lazy-loaded)
// ---------------------------------------------------------------------------
let stripe = null;
async function getStripe() {
  if (stripe) return stripe;
  if (!STRIPE_SECRET_KEY) return null;
  const Stripe = (await import("stripe")).default;
  stripe = new Stripe(STRIPE_SECRET_KEY);
  return stripe;
}

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
      stripePublishableKey: STRIPE_PUBLISHABLE_KEY || null,
      calendlyUrl: CALENDLY_URL,
      priceAmount: PRICE_AMOUNT,
      priceCurrency: PRICE_CURRENCY,
    });
    return;
  }

  // Create Stripe Checkout session
  if (req.method === "POST" && pathname === "/api/checkout") {
    const stripeClient = await getStripe();
    if (!stripeClient) {
      json(res, 500, { error: "Stripe is not configured" });
      return;
    }

    try {
      const body = await readBody(req);
      const data = JSON.parse(body.toString() || "{}");
      const customerEmail = data.email || undefined;

      const origin = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;

      const session = await stripeClient.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: customerEmail,
        line_items: [
          {
            price_data: {
              currency: PRICE_CURRENCY,
              product_data: {
                name: "Stories We Keep — Recording Session",
                description:
                  "A one-hour in-person recording session to capture your loved one's stories, memories, and wisdom. Delivered as a private audio keepsake.",
              },
              unit_amount: PRICE_AMOUNT,
            },
            quantity: 1,
          },
        ],
        success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/#pricing`,
      });

      json(res, 200, { url: session.url });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // Stripe webhook
  if (req.method === "POST" && pathname === "/api/webhook") {
    const stripeClient = await getStripe();
    if (!stripeClient) {
      json(res, 500, { error: "Stripe is not configured" });
      return;
    }

    try {
      const rawBody = await readBody(req);
      const sig = req.headers["stripe-signature"];

      let event;
      if (STRIPE_WEBHOOK_SECRET && sig) {
        event = stripeClient.webhooks.constructEvent(
          rawBody,
          sig,
          STRIPE_WEBHOOK_SECRET
        );
      } else {
        event = JSON.parse(rawBody.toString());
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        console.log(
          `Payment received from ${session.customer_email || "unknown"} — ${session.amount_total / 100} ${session.currency}`
        );
      }

      json(res, 200, { received: true });
    } catch (err) {
      console.error("Webhook error:", err.message);
      json(res, 400, { error: err.message });
    }
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
