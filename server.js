const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================================================
RATE LIMITING
========================================================= */
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false
  })
);

/* =========================================================
SUPABASE
========================================================= */
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

/* =========================================================
CONSTANTS
========================================================= */
const STOCKS = {};
const STOCK_QUEUES = {}; // ✅ race-safe per-stock queue

const MARKET_TICK_MINUTES = 5;
const VOLATILITY = 25;

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;
const ONE_MONTH = 30 * ONE_DAY;

const MAX_SHARES_PER_TRADE = 5000;
const MAX_STOCK_NAME_LENGTH = 32;
const REQUEST_TIMEOUT = 15000;

/* =========================================================
CACHE
========================================================= */
const ACCOUNT_VALUE_CACHE = {};
let ROLIMONS_CACHE = null;
let ROLIMONS_LAST_FETCH = 0;

/* =========================================================
HTTP
========================================================= */
const http = axios.create({
  timeout: REQUEST_TIMEOUT,
  headers: { "User-Agent": "RoAPI/1.0" }
});

/* =========================================================
UTILS
========================================================= */
const isId = (v) => /^\d+$/.test(v);

function validateStockName(stock) {
  return (
    typeof stock === "string" &&
    stock.length > 0 &&
    stock.length <= MAX_STOCK_NAME_LENGTH &&
    /^[a-zA-Z0-9_\- ]+$/.test(stock)
  );
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

/* =========================================================
RACE SAFE QUEUE
========================================================= */
function enqueue(stock, fn) {
  if (!STOCK_QUEUES[stock]) STOCK_QUEUES[stock] = Promise.resolve();

  STOCK_QUEUES[stock] = STOCK_QUEUES[stock]
    .then(fn)
    .catch((err) => console.error("Queue error:", err));

  return STOCK_QUEUES[stock];
}

/* =========================================================
ROBLOX HELPERS
========================================================= */
async function getUserCounts(userId) {
  const [friends, followers, following] = await Promise.all([
    http.get(`https://friends.roblox.com/v1/users/${userId}/friends/count`),
    http.get(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
    http.get(`https://friends.roblox.com/v1/users/${userId}/followings/count`)
  ]);

  return {
    friends: friends.data.count,
    followers: followers.data.count,
    following: following.data.count
  };
}

async function getAllCollectibles(userId, maxPages = 20) {
  let cursor = null;
  let collectibles = [];

  for (let i = 0; i < maxPages; i++) {
    const res = await http.get(
      `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`,
      { params: { limit: 100, sortOrder: "Asc", cursor } }
    );

    collectibles.push(...(res.data.data || []));
    if (!res.data.nextPageCursor) break;

    cursor = res.data.nextPageCursor;
  }

  return collectibles;
}

async function getRolimonsData() {
  const TEN_MIN = 10 * 60 * 1000;

  if (ROLIMONS_CACHE && Date.now() - ROLIMONS_LAST_FETCH < TEN_MIN) {
    return ROLIMONS_CACHE;
  }

  const res = await http.get("https://www.rolimons.com/itemapi/itemdetails");
  ROLIMONS_CACHE = res.data.items || {};
  ROLIMONS_LAST_FETCH = Date.now();
  return ROLIMONS_CACHE;
}

async function getAccountValue(userId) {
  const cache = ACCOUNT_VALUE_CACHE[userId];
  if (cache && cache.expires > Date.now()) return cache.data;

  try {
    const collectibles = await getAllCollectibles(userId);
    const itemData = await getRolimonsData();

    let totalRAP = 0;
    let totalValue = 0;

    for (const item of collectibles) {
      const details = itemData[item.assetId];
      if (!details) continue;

      const rap = details[2] || 0;
      const value = details[3] || rap;

      totalRAP += rap;
      totalValue += value;
    }

    const result = {
      collectibleCount: collectibles.length,
      totalRAP,
      totalValue
    };

    ACCOUNT_VALUE_CACHE[userId] = {
      data: result,
      expires: Date.now() + 5 * 60 * 1000
    };

    return result;
  } catch {
    return {
      collectibleCount: 0,
      totalRAP: 0,
      totalValue: 0,
      error: "Inventory may be private"
    };
  }
}

/* =========================================================
MARKET
========================================================= */
function calculateNewPrice(oldPrice, shares, type, followers, accountValue, accountAgeDays) {
  const followerScore = Math.log10(followers + 1) * 1.5;
  const valueScore = Math.log10(accountValue + 1) * 2;
  const ageScore = Math.log10(accountAgeDays + 1) * 1.2;

  const reputationValue = 10 + followerScore + valueScore + ageScore;

  const marketForce = Math.log10(shares + 1) * 0.8;

  let newPrice = oldPrice;

  if (type === "BUY") newPrice += marketForce;
  if (type === "SELL") newPrice -= marketForce;

  newPrice = newPrice * 0.8 + reputationValue * 0.2;

  return Number(Math.max(1, newPrice).toFixed(2));
}

/* =========================================================
STOCK UPDATE
========================================================= */
function updateAllStocksAlive(volatilityPercent = 25) {
  for (const stock in STOCKS) {
    const current = STOCKS[stock].price;

    const changePercent =
      randomBetween(-volatilityPercent, volatilityPercent) +
      (Math.random() - 0.5) * 0.2;

    let newPrice = current + current * (changePercent / 100);
    newPrice = Math.max(1, newPrice);

    STOCKS[stock].price = Number(newPrice.toFixed(2));
  }
}

/* =========================================================
STOCK INIT
========================================================= */
async function ensureStockExists(stock) {
  if (!STOCKS[stock]) {
    const { data } = await supabase
      .from("stocks")
      .select("*")
      .eq("stock", stock)
      .single();

    if (data) {
      STOCKS[stock] = {
        price: data.price,
        lastSaved: data.last_saved || 0
      };
    } else {
      STOCKS[stock] = { price: 10, lastSaved: 0 };

      await supabase.from("stocks").insert({
        stock,
        price: 10,
        last_saved: 0
      });

      await supabase.from("stock_history").insert({
        stock,
        price: 10,
        timestamp: Date.now()
      });
    }
  }
}

/* =========================================================
SAVE STOCK (RACE SAFE)
========================================================= */
function saveStock(stock) {
  return enqueue(stock, async () => {
    await supabase.from("stocks").upsert({
      stock,
      price: STOCKS[stock].price,
      last_saved: STOCKS[stock].lastSaved,
      updated_at: new Date().toISOString()
    });
  });
}

/* =========================================================
HISTORY SAVE (FIXED: ALWAYS 10 MIN INTERVAL RELIABLY)
========================================================= */
async function saveHistory(stock, price) {
  return enqueue(stock, async () => {
    const now = Date.now();

    if (now - STOCKS[stock].lastSaved < 10 * 60 * 1000) return;

    STOCKS[stock].lastSaved = now;

    await supabase.from("stock_history").insert({
      stock,
      price,
      timestamp: now
    });
  });
}

/* =========================================================
COMPRESSION (UPDATED RULES)
========================================================= */
async function compressStockHistory() {
  try {
    const now = Date.now();

    const { data } = await supabase
      .from("stock_history")
      .select("*")
      .order("timestamp", { ascending: true });

    const grouped = {};
    for (const row of data || []) {
      grouped[row.stock] ??= [];
      grouped[row.stock].push(row);
    }

    for (const stock in grouped) {
      const snapshots = grouped[stock];

      let last1h = 0;
      let last4h = 0;
      let lastDay = 0;
      let last4Day = 0;

      const deleteIds = [];

      for (const s of snapshots) {
        const age = now - s.timestamp;

        if (age > ONE_MONTH) {
          deleteIds.push(s.id);
          continue;
        }

        if (age <= 3 * ONE_HOUR) continue;

        if (age <= ONE_DAY) {
          if (s.timestamp - last1h < ONE_HOUR) deleteIds.push(s.id);
          else last1h = s.timestamp;
          continue;
        }

        if (age <= ONE_WEEK) {
          if (s.timestamp - last4h < 4 * ONE_HOUR) deleteIds.push(s.id);
          else last4h = s.timestamp;
          continue;
        }

        if (age <= ONE_MONTH) {
          if (s.timestamp - lastDay < ONE_DAY) deleteIds.push(s.id);
          else lastDay = s.timestamp;
        }

        if (age <= ONE_MONTH) {
          if (s.timestamp - last4Day < 4 * ONE_DAY) deleteIds.push(s.id);
          else last4Day = s.timestamp;
        }
      }

      if (deleteIds.length) {
        await supabase.from("stock_history").delete().in("id", deleteIds);
        console.log(`Compressed ${stock}: removed ${deleteIds.length}`);
      }
    }
  } catch (err) {
    console.error("Compression failed:", err);
  }
}

/* =========================================================
TRADE ROUTE (USERID ONLY)
========================================================= */
app.post("/trade", async (req, res) => {
  try {
    const { stock, shares, type } = req.body;

    if (!isId(stock)) {
      return res.json({ success: false, error: "Stock must be userId" });
    }

    if (typeof shares !== "number" || shares <= 0 || shares > MAX_SHARES_PER_TRADE) {
      return res.json({ success: false, error: "Invalid shares" });
    }

    if (type !== "BUY" && type !== "SELL") {
      return res.json({ success: false, error: "Invalid trade type" });
    }

    const userId = stock;

    const userRes = await http.get(
      `https://users.roblox.com/v1/users/${userId}`
    );

    const counts = await getUserCounts(userId);
    const accountValue = await getAccountValue(userId);

    const created = new Date(userRes.data.created);
    const accountAgeDays = Math.floor((Date.now() - created) / ONE_DAY);

    await ensureStockExists(userId);

    const oldPrice = STOCKS[userId].price;

    const newPrice = calculateNewPrice(
      oldPrice,
      shares,
      type,
      counts.followers,
      accountValue.totalValue,
      accountAgeDays
    );

    STOCKS[userId].price = newPrice;

    await saveHistory(userId, newPrice);
    await saveStock(userId);

    return res.json({
      success: true,
      stock: userId,
      oldPrice,
      newPrice
    });

  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

/* =========================================================
MARKET TICK
========================================================= */
setInterval(async () => {
  updateAllStocksAlive(VOLATILITY);

  for (const stock in STOCKS) {
    await saveStock(stock);
  }

  console.log("Market tick updated");
}, MARKET_TICK_MINUTES * 60 * 1000);

/* =========================================================
COMPRESSION
========================================================= */
setInterval(compressStockHistory, 6 * ONE_HOUR);

/* =========================================================
START
========================================================= */
async function loadStocksFromDB() {
  const { data } = await supabase.from("stocks").select("*");

  for (const row of data || []) {
    STOCKS[row.stock] = {
      price: row.price,
      lastSaved: row.last_saved || 0
    };
  }
}

app.listen(PORT, async () => {
  await loadStocksFromDB();
  console.log(`Server running on port ${PORT}`);
});
