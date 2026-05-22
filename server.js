const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================================================
RATE LIMIT
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
STATE
========================================================= */
const STOCKS = {};
const QUEUES = {};

const MARKET_TICK_MINUTES = 5;
const VOLATILITY = 25;

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;
const ONE_MONTH = 30 * ONE_DAY;

const MAX_SHARES_PER_TRADE = 5000;
const MAX_STOCK_NAME_LENGTH = 32;

const ACCOUNT_CACHE = {};

/* =========================================================
HTTP
========================================================= */
const http = axios.create({
  timeout: 15000,
  headers: { "User-Agent": "RoAPI/1.0" }
});

/* =========================================================
UTILS
========================================================= */
const isId = (v) => /^\d+$/.test(v);

function validateStockName(stock) {
  return (
    typeof stock === "string" &&
    stock.length <= MAX_STOCK_NAME_LENGTH &&
    /^[a-zA-Z0-9_\- ]+$/.test(stock)
  );
}

/* =========================================================
QUEUE (RACE SAFE DB WRITES)
========================================================= */
function enqueue(stock, fn) {
  if (!QUEUES[stock]) QUEUES[stock] = Promise.resolve();
  QUEUES[stock] = QUEUES[stock].then(fn).catch(console.error);
  return QUEUES[stock];
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

async function getAccountValue(userId) {
  if (ACCOUNT_CACHE[userId] && ACCOUNT_CACHE[userId].expires > Date.now()) {
    return ACCOUNT_CACHE[userId].data;
  }

  try {
    const res = await http.get(
      `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles?limit=100`
    );

    const collectibles = res.data.data || [];

    const result = {
      collectibleCount: collectibles.length,
      totalValue: collectibles.length * 10
    };

    ACCOUNT_CACHE[userId] = {
      data: result,
      expires: Date.now() + 5 * 60 * 1000
    };

    return result;
  } catch {
    return { collectibleCount: 0, totalValue: 0 };
  }
}

/* =========================================================
STOCK INIT
========================================================= */
async function ensureStock(stock) {
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
SAVE HISTORY (EVERY 10 MIN)
========================================================= */
function saveHistory(stock, price) {
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
SAVE STOCK
========================================================= */
function saveStock(stock) {
  return enqueue(stock, async () => {
    await supabase.from("stocks").upsert({
      stock,
      price: STOCKS[stock].price,
      last_saved: STOCKS[stock].lastSaved
    });
  });
}

/* =========================================================
PRICE CALC
========================================================= */
function calculatePrice(oldPrice, shares, type, followers, value, age) {
  const rep =
    Math.log10(followers + 1) +
    Math.log10(value + 1) +
    Math.log10(age + 1);

  const force = Math.log10(shares + 1);

  let price = oldPrice;

  if (type === "BUY") price += force;
  if (type === "SELL") price -= force;

  price = price * 0.8 + rep * 2;

  return Math.max(1, Number(price.toFixed(2)));
}

/* =========================================================
MARKET TICK
========================================================= */
function tick() {
  for (const s in STOCKS) {
    STOCKS[s].price += (Math.random() - 0.5) * 2;
    STOCKS[s].price = Math.max(1, STOCKS[s].price);
  }
}

/* =========================================================
COMPRESSION (UPDATED RULES)
========================================================= */
async function compress() {
  const now = Date.now();

  const { data } = await supabase.from("stock_history").select("*");

  const grouped = {};
  for (const r of data || []) {
    grouped[r.stock] ??= [];
    grouped[r.stock].push(r);
  }

  for (const stock in grouped) {
    const list = grouped[stock];

    let last1h = 0;
    let last4h = 0;
    let lastDay = 0;
    let last4Day = 0;

    const del = [];

    for (const r of list) {
      const age = now - r.timestamp;

      if (age > ONE_MONTH) {
        del.push(r.id);
        continue;
      }

      if (age <= ONE_HOUR) continue;

      if (age <= ONE_DAY) {
        if (r.timestamp - last1h < ONE_HOUR) del.push(r.id);
        else last1h = r.timestamp;
        continue;
      }

      if (age <= ONE_WEEK) {
        if (r.timestamp - last4h < 4 * ONE_HOUR) del.push(r.id);
        else last4h = r.timestamp;
        continue;
      }

      if (age <= ONE_MONTH) {
        if (r.timestamp - lastDay < ONE_DAY) del.push(r.id);
        else lastDay = r.timestamp;
      }

      if (r.timestamp - last4Day < 4 * ONE_DAY) del.push(r.id);
      else last4Day = r.timestamp;
    }

    if (del.length) {
      await supabase.from("stock_history").delete().in("id", del);
    }
  }
}

/* =========================================================
ROUTES (RESTORED)
========================================================= */

// STOCK
app.get("/stock/:stock", async (req, res) => {
  const stock = req.params.stock;
  if (!validateStockName(stock))
    return res.json({ success: false, error: "Invalid stock" });

  await ensureStock(stock);
  res.json({ success: true, stock, price: STOCKS[stock].price });
});

// HISTORY
app.get("/history/:stock", async (req, res) => {
  const stock = req.params.stock;
  await ensureStock(stock);

  const { data } = await supabase
    .from("stock_history")
    .select("*")
    .eq("stock", stock)
    .order("timestamp");

  res.json({ success: true, history: data });
});

// USER / PLAYER
app.get(["/user/:value", "/player/:value"], async (req, res) => {
  const value = req.params.value;

  let userId = value;

  if (!isId(value)) {
    const r = await http.post(
      "https://users.roblox.com/v1/usernames/users",
      { usernames: [value] }
    );
    userId = r.data?.data?.[0]?.id;
  }

  const user = await http.get(
    `https://users.roblox.com/v1/users/${userId}`
  );

  const counts = await getUserCounts(userId);
  const account = await getAccountValue(userId);

  res.json({ success: true, user: user.data, counts, account });
});

// GAME / EXPERIENCE
app.get(["/game/:value", "/experience/:value"], async (req, res) => {
  const v = req.params.value;

  const r = isId(v)
    ? await http.get(`https://games.roblox.com/v1/games?universeIds=${v}`)
    : await http.get(`https://games.roblox.com/v1/games/list?keyword=${v}`);

  res.json({ success: true, data: r.data });
});

// GROUP
app.get("/group/:value", async (req, res) => {
  const v = req.params.value;

  const r = isId(v)
    ? await http.get(`https://groups.roblox.com/v1/groups/${v}`)
    : await http.get(`https://groups.roblox.com/v1/groups/search?keyword=${v}`);

  res.json({ success: true, data: r.data });
});

// ASSET
app.get("/asset/:value", async (req, res) => {
  const v = req.params.value;

  const r = isId(v)
    ? await http.get(`https://economy.roblox.com/v2/assets/${v}/details`)
    : await http.get(
        `https://catalog.roblox.com/v1/search/items/details?Keyword=${v}`
      );

  res.json({ success: true, data: r.data });
});

/* =========================================================
TRADE
========================================================= */
app.post("/trade", async (req, res) => {
  const { stock, shares, type } = req.body;

  if (!isId(stock))
    return res.json({ success: false, error: "stock must be userId" });

  await ensureStock(stock);

  const user = await http.get(
    `https://users.roblox.com/v1/users/${stock}`
  );

  const counts = await getUserCounts(stock);
  const account = await getAccountValue(stock);

  const age = Math.floor(
    (Date.now() - new Date(user.data.created)) / ONE_DAY
  );

  const old = STOCKS[stock].price;

  const newPrice = calculatePrice(
    old,
    shares,
    type,
    counts.followers,
    account.totalValue,
    age
  );

  STOCKS[stock].price = newPrice;

  await saveHistory(stock, newPrice);
  await saveStock(stock);

  res.json({ success: true, old, newPrice });
});

/* =========================================================
START
========================================================= */
async function load() {
  const { data } = await supabase.from("stocks").select("*");

  for (const r of data || []) {
    STOCKS[r.stock] = {
      price: r.price,
      lastSaved: r.last_saved || 0
    };
  }
}

setInterval(tick, MARKET_TICK_MINUTES * 60000);
setInterval(compress, 6 * ONE_HOUR);

app.listen(PORT, async () => {
  await load();
  console.log("server running");
});
