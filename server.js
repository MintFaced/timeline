import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const envPath = path.join(__dirname, ".env");

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
const ALLIUM_API_KEY = process.env.ALLIUM_API_KEY;
const ALLIUM_BASE_URL = "https://api.allium.so/api/v1/explorer";
const MAX_ACTIVITY_PAGES = 40;
const PAGE_SIZE = 100;
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function parseAddressList(input) {
  if (!input) return [];
  return input
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => /^0x[a-f0-9]{40}$/.test(item));
}

function parseDate(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function firstPresent(obj, keys) {
  for (const key of keys) {
    if (obj?.[key] != null) return obj[key];
  }
  return null;
}

function eventTimestamp(event) {
  return parseDate(
    firstPresent(event, [
      "block_timestamp",
      "timestamp",
      "created_at",
      "activity_timestamp",
      "event_timestamp"
    ])
  );
}

function usdValue(event) {
  const raw = firstPresent(event, [
    "usd_value",
    "amount_usd",
    "usd_amount",
    "price_usd",
    "sale_usd",
    "total_usd"
  ]);

  const asNum = Number(raw);
  if (Number.isFinite(asNum)) return asNum;

  const maybeNested = Number(event?.currency_price?.usd || event?.price?.usd || event?.value?.usd);
  return Number.isFinite(maybeNested) ? maybeNested : null;
}

function isSale(event) {
  const type = String(
    firstPresent(event, ["activity_type", "type", "event_type", "transaction_type"]) || ""
  ).toLowerCase();

  if (type.includes("sale")) return true;
  if (type.includes("mint")) return false;
  return usdValue(event) != null;
}

function isMint(event) {
  const type = String(
    firstPresent(event, ["activity_type", "type", "event_type", "transaction_type"]) || ""
  ).toLowerCase();

  return type.includes("mint");
}

function tokenLabel(event) {
  const tokenId = firstPresent(event, ["token_id", "tokenId", "nft_id"]);
  const collection = firstPresent(event, ["collection_name", "contract_name", "name"]);
  if (collection && tokenId != null) return `${collection} #${tokenId}`;
  if (tokenId != null) return `Token #${tokenId}`;
  if (collection) return String(collection);
  return "Artwork";
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

async function alliumPost(endpoint, payload) {
  const response = await fetch(`${ALLIUM_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ALLIUM_API_KEY
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Allium ${response.status}: ${message.slice(0, 280)}`);
  }

  const data = await response.json();
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

async function fetchActivities({ chain, contracts, activityType }) {
  const rows = [];

  for (let page = 0; page < MAX_ACTIVITY_PAGES; page += 1) {
    const payload = {
      blockchain: chain,
      contract_addresses: contracts,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort_by: "block_timestamp",
      order: "asc"
    };

    if (activityType) payload.activity_types = [activityType];

    const pageRows = await alliumPost("/nfts/activities/contract", payload);
    rows.push(...pageRows);
    if (pageRows.length < PAGE_SIZE) break;
  }

  return rows;
}

async function fetchContractRows({ chain, contracts }) {
  try {
    return await alliumPost("/nfts/contracts", {
      blockchain: chain,
      contract_addresses: contracts,
      limit: contracts.length
    });
  } catch {
    return [];
  }
}

function creationDate(contractRow) {
  return parseDate(
    firstPresent(contractRow, [
      "created_at",
      "contract_created_at",
      "creation_timestamp",
      "deployed_at",
      "first_mint_at",
      "first_seen_at"
    ])
  );
}

function buildThreeMonthPeak(sales) {
  if (!sales.length) return null;

  const sorted = sales
    .map((sale) => ({ ...sale, _ts: eventTimestamp(sale) }))
    .filter((sale) => sale._ts)
    .sort((a, b) => a._ts - b._ts);

  let left = 0;
  let best = { count: 0, start: null, end: null };

  for (let right = 0; right < sorted.length; right += 1) {
    while (sorted[right]._ts - sorted[left]._ts > THREE_MONTHS_MS) {
      left += 1;
    }

    const count = right - left + 1;
    if (count > best.count) {
      best = {
        count,
        start: sorted[left]._ts,
        end: sorted[right]._ts
      };
    }
  }

  return best.count ? best : null;
}

async function buildMilestones({ chain, contracts, artist }) {
  const [mintRows, saleRows, contractRows] = await Promise.all([
    fetchActivities({ chain, contracts, activityType: "mint" }),
    fetchActivities({ chain, contracts, activityType: "sale" }),
    fetchContractRows({ chain, contracts })
  ]);

  const mintEvents = mintRows.filter(isMint);
  const saleEvents = saleRows.filter(isSale);

  const milestoneItems = [];

  const genesisMint = mintEvents
    .map((event) => ({ event, ts: eventTimestamp(event) }))
    .filter((item) => item.ts)
    .sort((a, b) => a.ts - b.ts)[0];

  if (genesisMint) {
    milestoneItems.push({
      id: "genesis-mint",
      date: genesisMint.ts.toISOString(),
      title: "Genesis Mint",
      detail: `${tokenLabel(genesisMint.event)} minted`,
      kind: "mint"
    });
  }

  for (const contract of contracts) {
    const row = contractRows.find((item) => {
      const rowAddress = String(firstPresent(item, ["contract_address", "address"]) || "").toLowerCase();
      return rowAddress === contract;
    });

    const timestamp = creationDate(row);
    if (!timestamp) continue;

    const label = String(firstPresent(row, ["collection_name", "name", "contract_name"]) || contract);

    milestoneItems.push({
      id: `contract-${contract}`,
      date: timestamp.toISOString(),
      title: "Smart Contract Created",
      detail: label,
      kind: "contract"
    });
  }

  const salesWithDate = saleEvents
    .map((event) => ({ event, ts: eventTimestamp(event), usd: usdValue(event) }))
    .filter((item) => item.ts)
    .sort((a, b) => a.ts - b.ts);

  if (salesWithDate.length) {
    const firstSale = salesWithDate[0];

    milestoneItems.push({
      id: "first-sale",
      date: firstSale.ts.toISOString(),
      title: "First Sale",
      detail: `${tokenLabel(firstSale.event)} sold for ${formatUsd(firstSale.usd)}`,
      kind: "sale"
    });

    const biggestSale = [...salesWithDate]
      .filter((item) => Number.isFinite(item.usd))
      .sort((a, b) => b.usd - a.usd)[0];

    if (biggestSale) {
      milestoneItems.push({
        id: "biggest-sale",
        date: biggestSale.ts.toISOString(),
        title: "Biggest Sale",
        detail: `${tokenLabel(biggestSale.event)} sold for ${formatUsd(biggestSale.usd)}`,
        kind: "sale"
      });
    }

    const mostRecentSale = salesWithDate[salesWithDate.length - 1];
    milestoneItems.push({
      id: "recent-sale",
      date: mostRecentSale.ts.toISOString(),
      title: "Most Recent Sale",
      detail: `${tokenLabel(mostRecentSale.event)} sold for ${formatUsd(mostRecentSale.usd)}`,
      kind: "sale"
    });

    const peak = buildThreeMonthPeak(salesWithDate.map((item) => item.event));
    if (peak) {
      milestoneItems.push({
        id: "peak-quarter",
        date: peak.start.toISOString(),
        title: "Most Art Sold (3-Month Peak)",
        detail: `${peak.count} pieces sold between ${peak.start.toLocaleDateString("en-US")} and ${peak.end.toLocaleDateString("en-US")}`,
        kind: "volume"
      });
    }
  }

  const ordered = milestoneItems
    .filter((item) => item.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    artist,
    chain,
    contracts,
    totals: {
      mintCount: mintEvents.length,
      saleCount: saleEvents.length
    },
    milestones: ordered
  };
}

async function readPublicFile(urlPath) {
  const cleanPath = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = path.normalize(cleanPath).replace(/^\.+/, "");
  const fullPath = path.join(publicDir, safePath);

  if (!fullPath.startsWith(publicDir)) {
    return { status: 403, contentType: "text/plain", body: "Forbidden" };
  }

  const ext = path.extname(fullPath);
  const contentTypeByExt = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json"
  };

  try {
    const body = await fs.readFile(fullPath);
    return {
      status: 200,
      contentType: contentTypeByExt[ext] || "application/octet-stream",
      body
    };
  } catch {
    return { status: 404, contentType: "text/plain", body: "Not found" };
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && parsedUrl.pathname === "/api/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && parsedUrl.pathname === "/api/timeline") {
    if (!ALLIUM_API_KEY) {
      json(res, 500, { error: "Missing ALLIUM_API_KEY environment variable" });
      return;
    }

    const contracts = parseAddressList(parsedUrl.searchParams.get("contracts"));
    const chain = parsedUrl.searchParams.get("chain") || "ethereum";
    const artist = parsedUrl.searchParams.get("artist") || "Artist";

    if (!contracts.length) {
      json(res, 400, { error: "Provide one or more valid contract addresses" });
      return;
    }

    try {
      const payload = await buildMilestones({ chain, contracts, artist });
      json(res, 200, payload);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
    return;
  }

  if (req.method === "GET") {
    const file = await readPublicFile(parsedUrl.pathname);
    res.writeHead(file.status, { "Content-Type": file.contentType });
    res.end(file.body);
    return;
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Artist timeline app running at http://localhost:${PORT}`);
});
