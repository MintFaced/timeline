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
const ALLIUM_BASE_URL = "https://api.allium.so/api/v1/developer";
const MAX_CONTRACT_ACTIVITY_PAGES = 40;
const CONTRACT_ACTIVITY_PAGE_SIZE = 100;
const MAX_WALLET_TX_PAGES = 20;
const WALLET_TX_PAGE_SIZE = 1000;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RECENT_WINDOW_DAYS = 30;
const PROVENANCE_LOOKBACK_DAYS = 365;
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

function isHexAddress(value) {
  return /^0x[a-f0-9]{40}$/.test(String(value || "").toLowerCase());
}

function normalizeAddress(value) {
  if (!value) return null;
  const lowered = String(value).trim().toLowerCase();
  return isHexAddress(lowered) ? lowered : null;
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
    firstPresent(event, ["activity_type", "type", "event_type", "transaction_type", "operation"]) || ""
  ).toLowerCase();

  if (type.includes("sale")) return true;
  if (type.includes("trade")) return true;
  if (type.includes("listing")) return false;
  if (type.includes("mint")) return false;
  return usdValue(event) != null;
}

function isMint(event) {
  const type = String(
    firstPresent(event, ["activity_type", "type", "event_type", "transaction_type", "operation"]) || ""
  ).toLowerCase();

  if (!type.includes("mint")) return false;
  const tokenId = firstPresent(event, ["token_id", "tokenId", "nft_id"]) || event?.asset?.token_id;
  return tokenId != null || type.includes("nft");
}

function tokenLabel(event) {
  const tokenId =
    firstPresent(event, ["token_id", "tokenId", "nft_id"]) || event?.asset?.token_id || null;
  const collection =
    firstPresent(event, ["collection_name", "contract_name", "name"]) || event?.asset?.name || null;
  if (collection && tokenId != null) return `${collection} #${tokenId}`;
  if (tokenId != null) return `Token #${tokenId}`;
  if (collection) return String(collection);
  return "Artwork";
}

function contractAddressFromEvent(event) {
  return normalizeAddress(
    firstPresent(event, ["contract_address", "token_address", "collection_address", "nft_address"]) ||
      event?.asset?.token_address
  );
}

function tokenIdFromEvent(event) {
  const id = firstPresent(event, ["token_id", "tokenId", "nft_id"]) || event?.asset?.token_id;
  if (id == null) return null;
  return String(id);
}

function tokenKeyFromEvent(event) {
  const contract = contractAddressFromEvent(event);
  const tokenId = tokenIdFromEvent(event);
  if (!contract || tokenId == null) return null;
  return `${contract}:${tokenId}`;
}

function addressFromEvent(event, keys) {
  return normalizeAddress(
    firstPresent(event, keys) ||
      event?.asset?.from_address ||
      event?.asset?.to_address ||
      event?.sender ||
      event?.recipient
  );
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function appendQueryParam(url, key, value) {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      url.searchParams.append(key, String(item));
    }
    return;
  }
  url.searchParams.set(key, String(value));
}

async function alliumGet(endpoint, query = {}) {
  const url = new URL(`${ALLIUM_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    appendQueryParam(url, key, value);
  }

  let response = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": ALLIUM_API_KEY
      }
    });

    if (response.ok) break;
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 3) {
      const message = await response.text();
      throw new Error(`Allium ${response.status}: ${message.slice(0, 280)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
  }

  return response.json();
}

async function alliumPost(endpoint, body, query = {}) {
  const url = new URL(`${ALLIUM_BASE_URL}${endpoint}`);
  for (const [key, value] of Object.entries(query)) {
    appendQueryParam(url, key, value);
  }

  let response = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": ALLIUM_API_KEY
      },
      body: JSON.stringify(body)
    });

    if (response.ok) break;
    if (!RETRYABLE_STATUSES.has(response.status) || attempt === 3) {
      const message = await response.text();
      throw new Error(`Allium ${response.status}: ${message.slice(0, 280)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
  }

  return response.json();
}

function alliumItems(payload) {
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload)) return payload;
  return [];
}

async function fetchActivitiesForContract({ chain, contract, activityType }) {
  const rows = [];
  let cursor = null;

  for (let page = 0; page < MAX_CONTRACT_ACTIVITY_PAGES; page += 1) {
    const payload = await alliumGet(`/nfts/activities/${chain}/${contract}`, {
      limit: CONTRACT_ACTIVITY_PAGE_SIZE,
      activity_types: activityType ? [activityType] : undefined,
      cursor: cursor || undefined
    });

    const pageRows = alliumItems(payload);
    rows.push(...pageRows.map((row) => ({ ...row, contract_address: row.contract_address || contract })));
    cursor = payload?.cursor || null;
    if (!cursor || pageRows.length < CONTRACT_ACTIVITY_PAGE_SIZE) break;
  }

  return rows;
}

async function fetchActivities({ chain, contracts, activityType }) {
  const batches = await Promise.all(
    contracts.map((contract) => fetchActivitiesForContract({ chain, contract, activityType }))
  );
  return batches.flat();
}

async function fetchWalletActivities({ chain, wallet }) {
  const rows = [];
  let cursor = null;
  const recentCutoffMs = Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const provenanceCutoffMs = Date.now() - PROVENANCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

  for (let page = 0; page < MAX_WALLET_TX_PAGES; page += 1) {
    const payload = await alliumPost(
      "/wallet/transactions",
      [{ chain, address: wallet }],
      { limit: WALLET_TX_PAGE_SIZE, cursor: cursor || undefined }
    );

    const txRows = alliumItems(payload);
    let oldestSeenOnPage = Number.POSITIVE_INFINITY;

    for (const tx of txRows) {
      const txTimestamp = tx?.block_timestamp || tx?.timestamp;
      const txDate = parseDate(txTimestamp);
      if (txDate) {
        oldestSeenOnPage = Math.min(oldestSeenOnPage, txDate.getTime());
      }
      const txHash = tx?.hash || tx?.transaction_hash;
      const txActivityTypes = Array.isArray(tx?.activities)
        ? tx.activities
            .map((item) =>
              String(firstPresent(item, ["activity_type", "type", "event_type", "operation"]) || "").toLowerCase()
            )
            .filter(Boolean)
        : [];

      const transfers = Array.isArray(tx?.asset_transfers) ? tx.asset_transfers : [];
      for (const transfer of transfers) {
        const merged = {
          ...transfer,
          block_timestamp: transfer?.block_timestamp || txTimestamp,
          transaction_hash: transfer?.transaction_hash || txHash,
          _tx_activity_types: txActivityTypes
        };
        rows.push(merged);
      }

      const activities = Array.isArray(tx?.activities) ? tx.activities : [];
      for (const activity of activities) {
        const merged = {
          ...activity,
          block_timestamp: activity?.block_timestamp || txTimestamp,
          transaction_hash: activity?.transaction_hash || txHash,
          _tx_activity_types: txActivityTypes
        };
        rows.push(merged);
      }
    }

    cursor = payload?.cursor || null;
    if (!cursor || txRows.length < WALLET_TX_PAGE_SIZE) break;
    if (oldestSeenOnPage <= provenanceCutoffMs) break;
    if (oldestSeenOnPage <= recentCutoffMs && page >= 3) break;
  }

  return rows;
}

async function fetchContractRows({ chain, contracts }) {
  const rows = await Promise.all(
    contracts.map(async (contract) => {
      try {
        const payload = await alliumGet(`/nfts/contracts/${chain}/${contract}`);
        return payload?.data || payload;
      } catch {
        return null;
      }
    })
  );

  return rows.filter(Boolean);
}

async function resolveEnsName(name) {
  const clean = String(name || "").trim().toLowerCase();
  if (!clean.endsWith(".eth")) return null;

  const endpoints = [
    `https://api.ensideas.com/ens/resolve/${encodeURIComponent(clean)}`,
    `https://api.ensdata.net/${encodeURIComponent(clean)}`
  ];

  for (const url of endpoints) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const data = await response.json();
      const addr = normalizeAddress(data?.address || data?.addr || data?.resolver_address);
      if (addr) return addr;
    } catch {
      // Try next resolver.
    }
  }

  return null;
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

  const soldCreatedCount = salesWithDate.filter((sale) => mintedTokenKeys.has(tokenKeyFromEvent(sale.event))).length;
  const soldBoughtCount = salesWithDate.length - soldCreatedCount;

  return {
    artist,
    chain,
    contracts,
    totals: {
      mintCount: mintEvents.length,
      saleCount: saleEvents.length,
      soldCreatedCount,
      soldBoughtCount
    },
    milestones: ordered
  };
}

async function buildWalletMilestones({ chain, wallet, artist }) {
  const walletLc = wallet.toLowerCase();
  const activityRows = await fetchWalletActivities({ chain, wallet: walletLc });
  const windowStart = new Date(Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const saleEvents = activityRows.filter((event) => {
    const ts = eventTimestamp(event);
    if (!ts || ts < windowStart) return false;
    const from = addressFromEvent(event, ["from_address", "seller_address", "maker"]);
    if (from !== walletLc) return false;

    const hasTradeSignal =
      String(firstPresent(event, ["activity_type", "type", "event_type", "transaction_type", "operation"]) || "")
        .toLowerCase()
        .includes("trade") ||
      String(firstPresent(event, ["activity_type", "type", "event_type", "transaction_type", "operation"]) || "")
        .toLowerCase()
        .includes("sale") ||
      (Array.isArray(event?._tx_activity_types) && event._tx_activity_types.includes("nft_trade"));

    const tokenKey = tokenKeyFromEvent(event);
    return hasTradeSignal && Boolean(tokenKey);
  });

  const mintEvents = activityRows.filter((event) => {
    const ts = eventTimestamp(event);
    return Boolean(ts && ts >= windowStart && isMint(event));
  });

  const derivedContracts = [
    ...new Set(
      activityRows
        .filter((event) => {
          const ts = eventTimestamp(event);
          return Boolean(ts && ts >= windowStart);
        })
        .map(contractAddressFromEvent)
        .filter(Boolean)
    )
  ];

  const contractRows = derivedContracts.length
    ? await fetchContractRows({ chain, contracts: derivedContracts })
    : [];

  const milestoneItems = [];
  const mintedTokenKeys = new Set(
    activityRows
      .filter(isMint)
      .map((event) => tokenKeyFromEvent(event))
      .filter(Boolean)
  );

  for (const contract of derivedContracts) {
    const row = contractRows.find((item) => {
      const rowAddress = normalizeAddress(firstPresent(item, ["contract_address", "address"]));
      return rowAddress === contract;
    });

    const timestamp = creationDate(row);
    if (!timestamp || timestamp < windowStart) continue;

    const label = String(firstPresent(row, ["collection_name", "name", "contract_name"]) || contract);
    milestoneItems.push({
      id: `contract-${contract}`,
      date: timestamp.toISOString(),
      title: "New Smart Contract Launched",
      detail: label,
      kind: "contract"
    });
  }

  const salesWithDate = saleEvents
    .map((event) => ({
      event,
      ts: eventTimestamp(event),
      transactionHash: firstPresent(event, ["transaction_hash", "tx_hash", "hash"]),
      usd: usdValue(event),
      from: addressFromEvent(event, ["from_address", "seller_address", "maker"]),
      to: addressFromEvent(event, ["to_address", "buyer_address", "taker"])
    }))
    .filter((item) => item.ts)
    .sort((a, b) => a.ts - b.ts);

  const salesByDay = new Map();
  for (const sale of salesWithDate) {
    const day = sale.ts.toISOString().slice(0, 10);
    const prev = salesByDay.get(day) || { count: 0, usd: 0 };
    prev.count += 1;
    if (Number.isFinite(sale.usd)) prev.usd += sale.usd;
    salesByDay.set(day, prev);
  }

  const biggestSaleDay = [...salesByDay.entries()].sort((a, b) => {
    if (b[1].usd !== a[1].usd) return b[1].usd - a[1].usd;
    return b[1].count - a[1].count;
  })[0];

  if (biggestSaleDay) {
    const [day, stats] = biggestSaleDay;
    milestoneItems.push({
      id: `biggest-sale-day-${day}`,
      date: new Date(`${day}T00:00:00.000Z`).toISOString(),
      title: "Biggest Sale Day",
      detail: `${stats.count} sales totaling ${formatUsd(stats.usd)} on ${new Date(`${day}T00:00:00.000Z`).toLocaleDateString("en-US")}`,
      kind: "sale"
    });
  }

  if (salesWithDate.length) {
    for (const sale of salesWithDate) {
      const tokenKey = tokenKeyFromEvent(sale.event);
      const categoryTitle = mintedTokenKeys.has(tokenKey)
        ? "Token Sold (Created by Wallet)"
        : "Token Sold (Previously Bought)";

      milestoneItems.push({
        id: `${sale.transactionHash || sale.ts.toISOString()}-${tokenKey || "sale"}`,
        date: sale.ts.toISOString(),
        title: categoryTitle,
        detail: `${tokenLabel(sale.event)} sold for ${formatUsd(sale.usd)}`,
        kind: "sale"
      });
    }
  }

  const ordered = milestoneItems
    .filter((item) => item.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    artist,
    chain,
    wallet: walletLc,
    contracts: derivedContracts,
    window: {
      days: RECENT_WINDOW_DAYS,
      start: windowStart.toISOString()
    },
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
    const walletInput = (parsedUrl.searchParams.get("wallet") || "").trim().toLowerCase();
    const chain = parsedUrl.searchParams.get("chain") || "ethereum";
    const artist = parsedUrl.searchParams.get("artist") || "Artist";
    const ens = walletInput.endsWith(".eth") ? walletInput : null;
    const wallet = normalizeAddress(walletInput) || (ens ? await resolveEnsName(ens) : null);

    if (!wallet && !contracts.length) {
      json(res, 400, {
        error: "Provide a wallet address (.eth supported) or one or more contract addresses"
      });
      return;
    }

    try {
      const payload = wallet
        ? await buildWalletMilestones({ chain, wallet, artist })
        : await buildMilestones({ chain, contracts, artist });
      if (ens) payload.walletName = ens;
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
