const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

function readPositiveIntegerEnv(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);

  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }

  return value;
}

const app = express();
const PORT = readPositiveIntegerEnv("PORT", 3000, 65535);

app.disable("x-powered-by");

if (process.env.TRUST_PROXY) {
  app.set("trust proxy", process.env.TRUST_PROXY);
}

app.use(express.json({ limit: "32kb" }));

/* =========================================================
RATE LIMIT
========================================================= */
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: readPositiveIntegerEnv("RATE_LIMIT_PER_MINUTE", 120),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many requests" }
  })
);

/* =========================================================
SUPABASE
========================================================= */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_KEY"),
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

/* =========================================================
STATE
========================================================= */
const STOCKS = Object.create(null);
const QUEUES = Object.create(null);
const STOCK_LOADS = Object.create(null);
const ACCOUNT_CACHE = Object.create(null);
const ACCOUNT_AGE_CACHE = Object.create(null);
const STOCK_MOMENTUM = Object.create(null);

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;
const ONE_MONTH = 30 * ONE_DAY;

const VOLATILITY = 8;
const MOMENTUM = 0.75;

const MARKET_TICK_MINUTES = 2;
const HISTORY_SAVE_INTERVAL_MINUTES = 10;

const COMPRESSION_RUN_INTERVAL_HOURS = 1;

const COMPRESSION_FIRST_CHECK_AGE = ONE_HOUR;
const COMPRESSION_FIRST_CHECK_INTERVAL = 15 * 60 * 1000;

const COMPRESSION_SECOND_CHECK_AGE = ONE_DAY;
const COMPRESSION_SECOND_CHECK_INTERVAL = 4 * ONE_HOUR;

const COMPRESSION_THIRD_CHECK_AGE = ONE_WEEK;
const COMPRESSION_THIRD_CHECK_INTERVAL = ONE_DAY;

const COMPRESSION_FOURTH_CHECK_AGE = ONE_MONTH;
const COMPRESSION_FOURTH_CHECK_INTERVAL = 5 * ONE_DAY;

const MAX_HISTORY_SIZE = 30;

const MAX_SHARES_PER_TRADE = 1000 * 1000;
const MAX_STOCK_NAME_LENGTH = 64;
const MAX_HISTORY_DELETE_BATCH = 1000;
const MAX_COLLECTIBLE_PAGES = 10;
const ACCOUNT_CACHE_TTL = 5 * 60 * 1000;
const ACCOUNT_CACHE_MAX_ITEMS = 1000;
const ACCOUNT_AGE_CACHE_TTL = ONE_DAY;
const PASSIVE_RANDOMNESS_MIN = 0.25;

let server;
let tickTimer;
let compressTimer;

/* =========================================================
HTTP
========================================================= */
const http = axios.create({
  timeout: 15000,
  headers: { "User-Agent": "RoAPI/1.0" }
});

/* =========================================================
ERRORS
========================================================= */
class AppError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function normalizeExternalError(error) {
  if (error instanceof AppError) return error;

  if (error.response) {
    const status = error.response.status;

    if (status === 404) {
      return new AppError(404, "Resource not found");
    }

    if (status === 429) {
      return new AppError(429, "Upstream rate limit reached");
    }

    return new AppError(
      status >= 500 ? 502 : status,
      "Upstream request failed",
      {
        upstreamStatus: status,
        upstreamData: error.response.data
      }
    );
  }

  if (error.code === "ECONNABORTED") {
    return new AppError(504, "Upstream request timed out");
  }

  return error;
}

function asyncRoute(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(normalizeExternalError(error));
    }
  };
}

function handleSupabase(result, action) {
  if (result.error) {
    throw new AppError(502, `Database ${action} failed`, result.error);
  }

  return result.data;
}

/* =========================================================
UTILS
========================================================= */
const isId = (value) => /^\d+$/.test(String(value || "").trim());

function normalizeStockName(stock) {
  return String(stock || "").trim();
}

function validateStockName(stock) {
  const normalized = normalizeStockName(stock);

  return (
    normalized.length > 0 &&
    normalized.length <= MAX_STOCK_NAME_LENGTH &&
    /^[a-zA-Z0-9_\- ]+$/.test(normalized)
  );
}

function parseShares(value) {
  const shares = Number(value);

  if (!Number.isInteger(shares) || shares < 1) {
    throw new AppError(400, "shares must be a positive integer");
  }

  if (shares > MAX_SHARES_PER_TRADE) {
    throw new AppError(
      400,
      `shares cannot exceed ${MAX_SHARES_PER_TRADE} per trade`
    );
  }

  return shares;
}

function normalizeTradeType(value) {
  const type = String(value || "").trim().toUpperCase();

  if (type !== "BUY" && type !== "SELL") {
    throw new AppError(400, "type must be BUY or SELL");
  }

  return type;
}

function clampPrice(price) {
  return Math.max(1, Number(Number(price).toFixed(2)));
}

function getRetentionInterval(age) {
  if (age <= COMPRESSION_FIRST_CHECK_AGE) {
    return COMPRESSION_FIRST_CHECK_INTERVAL;
  }

  if (age <= COMPRESSION_SECOND_CHECK_AGE) {
    return COMPRESSION_SECOND_CHECK_INTERVAL;
  }

  if (age <= COMPRESSION_THIRD_CHECK_AGE) {
    return COMPRESSION_THIRD_CHECK_INTERVAL;
  }

  if (age <= COMPRESSION_FOURTH_CHECK_AGE) {
    return COMPRESSION_FOURTH_CHECK_INTERVAL;
  }

  return null;
}

function chunk(list, size) {
  const chunks = [];

  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }

  return chunks;
}

function getAccountAgeDaysFromCreated(created) {
  const createdAt = new Date(created).getTime();

  if (!Number.isFinite(createdAt)) return 0;

  return Math.max(0, Math.floor((Date.now() - createdAt) / ONE_DAY));
}

function getPassiveRandomnessMultiplier(ageDays) {
  const ageYears = Math.max(Number(ageDays) || 0, 0) / 365;

  return Math.max(PASSIVE_RANDOMNESS_MIN, 1 / Math.sqrt(ageYears + 1));
}

/* =========================================================
QUEUE (RACE SAFE DB WRITES)
========================================================= */
function enqueue(stock, fn) {
  const key = normalizeStockName(stock);
  const previous = QUEUES[key] || Promise.resolve();

  const current = previous.catch(() => undefined).then(fn);
  const stored = current
    .catch((error) => {
      console.error(`queue failed for ${key}:`, error);
    })
    .finally(() => {
      if (QUEUES[key] === stored) {
        delete QUEUES[key];
      }
    });

  QUEUES[key] = stored;
  return current;
}

/* =========================================================
ROBLOX HELPERS
========================================================= */
async function getRobloxUserById(userId) {
  if (!isId(userId)) {
    throw new AppError(400, "userId must be numeric");
  }

  const user = await http.get(
    `https://users.roblox.com/v1/users/${encodeURIComponent(userId)}`
  );

  return user.data;
}

async function resolveUserId(value) {
  const normalized = String(value || "").trim();

  if (!normalized) {
    throw new AppError(400, "user value is required");
  }

  if (isId(normalized)) {
    return normalized;
  }

  const response = await http.post(
    "https://users.roblox.com/v1/usernames/users",
    {
      usernames: [normalized],
      excludeBannedUsers: false
    }
  );

  const userId = response.data?.data?.[0]?.id;

  if (!userId) {
    throw new AppError(404, "Roblox user not found");
  }

  return String(userId);
}

async function getCount(path) {
  try {
    const response = await http.get(path);
    return Number(response.data?.count || 0);
  } catch (error) {
    if (error.response?.status === 404) throw error;
    console.warn(`count request failed: ${path}`, error.message);
    return 0;
  }
}

async function getUserCounts(userId) {
  const safeUserId = encodeURIComponent(userId);

  const [friends, followers, following] = await Promise.all([
    getCount(`https://friends.roblox.com/v1/users/${safeUserId}/friends/count`),
    getCount(
      `https://friends.roblox.com/v1/users/${safeUserId}/followers/count`
    ),
    getCount(
      `https://friends.roblox.com/v1/users/${safeUserId}/followings/count`
    )
  ]);

  return { friends, followers, following };
}

function pruneCache(cache, maxItems) {
  const entries = Object.entries(cache);
  const now = Date.now();

  for (const [key, cached] of entries) {
    if (!cached || cached.expires <= now) {
      delete cache[key];
    }
  }

  const remaining = Object.entries(cache);
  if (remaining.length <= maxItems) return;

  remaining
    .sort((a, b) => a[1].expires - b[1].expires)
    .slice(0, remaining.length - maxItems)
    .forEach(([key]) => delete cache[key]);
}

function pruneAccountCache() {
  pruneCache(ACCOUNT_CACHE, ACCOUNT_CACHE_MAX_ITEMS);
}

function pruneAccountAgeCache() {
  pruneCache(ACCOUNT_AGE_CACHE, ACCOUNT_CACHE_MAX_ITEMS);
}

function collectibleValue(item) {
  const candidates = [
    item.recentAveragePrice,
    item.originalPrice,
    item.price,
    item.lowestPrice
  ];

  const value = candidates.find((candidate) => Number(candidate) > 0);
  return Number(value || 10);
}

async function getAccountAgeDays(userId) {
  if (!isId(userId)) return 0;

  const cached = ACCOUNT_AGE_CACHE[userId];

  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  try {
    const user = await getRobloxUserById(userId);
    const ageDays = getAccountAgeDaysFromCreated(user.created);

    ACCOUNT_AGE_CACHE[userId] = {
      data: ageDays,
      expires: Date.now() + ACCOUNT_AGE_CACHE_TTL
    };

    pruneAccountAgeCache();
    return ageDays;
  } catch (error) {
    console.warn(`account age unavailable for ${userId}:`, error.message);
    return 0;
  }
}

async function getAccountValue(userId) {
  const cached = ACCOUNT_CACHE[userId];

  if (cached && cached.expires > Date.now()) {
    return cached.data;
  }

  try {
    const collectibles = [];
    let cursor;

    for (let page = 0; page < MAX_COLLECTIBLE_PAGES; page += 1) {
      const response = await http.get(
        `https://inventory.roblox.com/v1/users/${encodeURIComponent(
          userId
        )}/assets/collectibles`,
        {
          params: {
            limit: 100,
            cursor
          }
        }
      );

      collectibles.push(...(response.data?.data || []));
      cursor = response.data?.nextPageCursor;

      if (!cursor) break;
    }

    const result = {
      collectibleCount: collectibles.length,
      totalValue: collectibles.reduce(
        (total, item) => total + collectibleValue(item),
        0
      )
    };

    ACCOUNT_CACHE[userId] = {
      data: result,
      expires: Date.now() + ACCOUNT_CACHE_TTL
    };

    pruneAccountCache();
    return result;
  } catch (error) {
    if (error.response?.status !== 403) {
      console.warn(`account value unavailable for ${userId}:`, error.message);
    }

    const result = { collectibleCount: 0, totalValue: 0 };

    ACCOUNT_CACHE[userId] = {
      data: result,
      expires: Date.now() + ACCOUNT_CACHE_TTL
    };

    pruneAccountCache();
    return result;
  }
}

/* =========================================================
STOCK INIT
========================================================= */
async function ensureStock(stock) {
  const key = normalizeStockName(stock);

  if (!validateStockName(key)) {
    throw new AppError(400, "Invalid stock");
  }

  if (STOCKS[key]) return STOCKS[key];

  if (!STOCK_LOADS[key]) {
    STOCK_LOADS[key] = enqueue(key, async () => {
      if (STOCKS[key]) return STOCKS[key];

      const rows = handleSupabase(
        await supabase
          .from("stocks")
          .select("*")
          .eq("stock", key)
          .limit(1),
        "read"
      );
      const data = rows?.[0];

      if (data) {
        STOCKS[key] = {
          price: clampPrice(data.price),
          lastSaved: Number(data.last_saved || 0)
        };

        return STOCKS[key];
      }

      STOCKS[key] = { price: 10, lastSaved: 0 };

      handleSupabase(
        await supabase.from("stocks").upsert(
          {
            stock: key,
            price: STOCKS[key].price,
            last_saved: STOCKS[key].lastSaved
          },
          { onConflict: "stock" }
        ),
        "insert"
      );

      handleSupabase(
        await supabase.from("stock_history").insert({
          stock: key,
          price: STOCKS[key].price,
          timestamp: Date.now()
        }),
        "insert history"
      );

      return STOCKS[key];
    }).finally(() => {
      delete STOCK_LOADS[key];
    });
  }

  return STOCK_LOADS[key];
}

/* =========================================================
SAVE HISTORY
========================================================= */
async function saveHistory(stock, price) {
  const key = normalizeStockName(stock);

  await ensureStock(key);

  return enqueue(key, async () => {
    const now = Date.now();

    if (now - STOCKS[key].lastSaved < HISTORY_SAVE_INTERVAL_MINUTES * 60000) {
      return false;
    }

    handleSupabase(
      await supabase.from("stock_history").insert({
        stock: key,
        price: clampPrice(price),
        timestamp: now
      }),
      "insert history"
    );

    STOCKS[key].lastSaved = now;
    return true;
  });
}

/* =========================================================
SAVE STOCK
========================================================= */
async function saveStock(stock) {
  const key = normalizeStockName(stock);

  await ensureStock(key);

  return enqueue(key, async () => {
    handleSupabase(
      await supabase.from("stocks").upsert(
        {
          stock: key,
          price: clampPrice(STOCKS[key].price),
          last_saved: Number(STOCKS[key].lastSaved || 0)
        },
        { onConflict: "stock" }
      ),
      "save stock"
    );
  });
}

/* =========================================================
PRICE CALC
========================================================= */
function calculatePrice(oldPrice, shares, type, followers, value, age) {
  const safeOldPrice = clampPrice(oldPrice);
  const safeShares = Math.min(
    Math.max(Number(shares) || 1, 1),
    MAX_SHARES_PER_TRADE
  );
  const safeFollowers = Math.max(Number(followers) || 0, 0);
  const safeValue = Math.max(Number(value) || 0, 0);
  const safeAge = Math.max(Number(age) || 0, 0);

  const rep =
    Math.log10(safeFollowers + 1) +
    Math.log10(safeValue + 1) +
    Math.log10(safeAge + 1);

  const force = Math.log10(safeShares + 1);

  let price = safeOldPrice;

  if (type === "BUY") price += force;
  if (type === "SELL") price -= force;

  price = price * 0.8 + rep * 2;

  return clampPrice(price);
}

function calculatePassiveMovement(stock, ageDays) {
  const randomness = getPassiveRandomnessMultiplier(ageDays);
  const randomMovement =
    (Math.random() - 0.5) * 2 * (VOLATILITY / 25) * randomness;

  const previousMovement = STOCK_MOMENTUM[stock] || 0;
  const movement =
    previousMovement * MOMENTUM + randomMovement * (1 - MOMENTUM);

  STOCK_MOMENTUM[stock] = movement;

  return movement;
}

/* =========================================================
MARKET TICK
========================================================= */
async function tick() {
  const updates = Object.keys(STOCKS).map(async (stock) => {
    const ageDays = await getAccountAgeDays(stock);
    const movement = calculatePassiveMovement(stock, ageDays);

    STOCKS[stock].price = clampPrice(STOCKS[stock].price + movement);

    await saveHistory(stock, STOCKS[stock].price);
    await saveStock(stock);
  });

  await Promise.allSettled(updates);
}

/* =========================================================
COMPRESSION (UPDATED RULES)
========================================================= */
async function compress() {
  const now = Date.now();

  const history = handleSupabase(
    await supabase
      .from("stock_history")
      .select("id, stock, price, timestamp")
      .order("stock", { ascending: true })
      .order("timestamp", { ascending: true }),
    "read history"
  );

  const grouped = Object.create(null);

  for (const row of history || []) {
    if (!grouped[row.stock]) grouped[row.stock] = [];
    grouped[row.stock].push(row);
  }

  const deletions = [];

  for (const stock in grouped) {
    const lastKeptByInterval = Object.create(null);

    for (const row of grouped[stock]) {
      const timestamp = Number(row.timestamp);
      const age = now - timestamp;
      const interval = getRetentionInterval(age);

      if (interval === null) {
        deletions.push(row.id);
        continue;
      }

      if (interval === 0) continue;

      const bucket = interval;
      const lastKept = lastKeptByInterval[bucket] || 0;

      if (timestamp - lastKept < interval) {
        deletions.push(row.id);
      } else {
        lastKeptByInterval[bucket] = timestamp;
      }
    }
  }

  for (const ids of chunk(deletions, MAX_HISTORY_DELETE_BATCH)) {
    handleSupabase(
      await supabase.from("stock_history").delete().in("id", ids),
      "delete compressed history"
    );
  }

  return { deleted: deletions.length };
}

/* =========================================================
ROUTES (RESTORED)
========================================================= */

// HEALTH
app.get("/health", (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    trackedStocks: Object.keys(STOCKS).length
  });
});

// STOCK
app.get(
  "/stock/:stock",
  asyncRoute(async (req, res) => {
    const stock = normalizeStockName(req.params.stock);

    await ensureStock(stock);
    res.json({ success: true, stock, price: STOCKS[stock].price });
  })
);

// HISTORY
app.get(
  "/history/:stock",
  asyncRoute(async (req, res) => {
    const stock = normalizeStockName(req.params.stock);

    await ensureStock(stock);

    const history = handleSupabase(
      await supabase
        .from("stock_history")
        .select("*")
        .eq("stock", stock)
        .order("timestamp", { ascending: true }),
      "read history"
    );

    const livePoint = {
      stock,
      price: STOCKS[stock].price,
      timestamp: Date.now(),
      live: true
    };
    
    res.json({
      success: true,
      stock,
      history: [...history, livePoint]
    });
  })
);

// USER / PLAYER
app.get(
  ["/user/:value", "/player/:value"],
  asyncRoute(async (req, res) => {
    const userId = await resolveUserId(req.params.value);
    const [user, counts, account] = await Promise.all([
      getRobloxUserById(userId),
      getUserCounts(userId),
      getAccountValue(userId)
    ]);

    res.json({ success: true, user, counts, account });
  })
);

// GAME / EXPERIENCE
app.get(
  ["/game/:value", "/experience/:value"],
  asyncRoute(async (req, res) => {
    const value = String(req.params.value || "").trim();

    if (!value) {
      throw new AppError(400, "game value is required");
    }

    const response = isId(value)
      ? await http.get("https://games.roblox.com/v1/games", {
          params: { universeIds: value }
        })
      : await http.get("https://games.roblox.com/v1/games/list", {
          params: { keyword: value }
        });

    res.json({ success: true, data: response.data });
  })
);

// GROUP
app.get(
  "/group/:value",
  asyncRoute(async (req, res) => {
    const value = String(req.params.value || "").trim();

    if (!value) {
      throw new AppError(400, "group value is required");
    }

    const response = isId(value)
      ? await http.get(
          `https://groups.roblox.com/v1/groups/${encodeURIComponent(value)}`
        )
      : await http.get("https://groups.roblox.com/v1/groups/search", {
          params: { keyword: value }
        });

    res.json({ success: true, data: response.data });
  })
);

// ASSET
app.get(
  "/asset/:value",
  asyncRoute(async (req, res) => {
    const value = String(req.params.value || "").trim();

    if (!value) {
      throw new AppError(400, "asset value is required");
    }

    const response = isId(value)
      ? await http.get(
          `https://economy.roblox.com/v2/assets/${encodeURIComponent(
            value
          )}/details`
        )
      : await http.get("https://catalog.roblox.com/v1/search/items/details", {
          params: { Keyword: value }
        });

    res.json({ success: true, data: response.data });
  })
);

/* =========================================================
TRADE
========================================================= */

app.post("/admin/compress", asyncRoute(async (req, res) => {
  const result = await compress();
  res.json({ success: true, ...result });
}));

app.post(
  "/trade",
  asyncRoute(async (req, res) => {
    const stock = normalizeStockName(req.body.stock);
    const shares = parseShares(req.body.shares);
    const type = normalizeTradeType(req.body.type);

    if (!isId(stock)) {
      throw new AppError(400, "stock must be userId");
    }

    await ensureStock(stock);

    const [user, counts, account] = await Promise.all([
      getRobloxUserById(stock),
      getUserCounts(stock),
      getAccountValue(stock)
    ]);

    const age = getAccountAgeDaysFromCreated(user.created);

    ACCOUNT_AGE_CACHE[stock] = {
      data: age,
      expires: Date.now() + ACCOUNT_AGE_CACHE_TTL
    };
    pruneAccountAgeCache();

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

    res.json({
      success: true,
      stock,
      type,
      shares,
      old,
      newPrice,
      user,
      counts,
      account
    });
  })
);

/* =========================================================
ERROR HANDLING
========================================================= */
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Route not found" });
});

app.use((error, req, res, next) => {
  const status = Number(error.status || 500);

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    success: false,
    error: error.message || "Internal server error",
    ...(process.env.NODE_ENV !== "production" && error.details
      ? { details: error.details }
      : {})
  });
});

/* =========================================================
START
========================================================= */
async function load() {
  const data = handleSupabase(
    await supabase.from("stocks").select("*"),
    "load stocks"
  );

  for (const row of data || []) {
    const stock = normalizeStockName(row.stock);

    if (!validateStockName(stock)) continue;

    STOCKS[stock] = {
      price: clampPrice(row.price),
      lastSaved: Number(row.last_saved || 0)
    };
  }

  return Object.keys(STOCKS).length;
}

function scheduleTask(name, intervalMs, task) {
  let running = false;

  return setInterval(async () => {
    if (running) return;

    running = true;

    try {
      await task();
    } catch (error) {
      console.error(`${name} failed:`, error);
    } finally {
      running = false;
    }
  }, intervalMs);
}

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);

  if (tickTimer) clearInterval(tickTimer);
  if (compressTimer) clearInterval(compressTimer);

  if (server) {
    server.close(() => {
      process.exit(0);
    });

    setTimeout(() => process.exit(1), 10000).unref();
  } else {
    process.exit(0);
  }
}

async function start() {
  const loaded = await load();

  tickTimer = scheduleTask("market tick", MARKET_TICK_MINUTES * 60000, tick);
  compressTimer = scheduleTask(
    "history compression",
    COMPRESSION_RUN_INTERVAL_HOURS * ONE_HOUR,
    compress
  );

  server = app.listen(PORT, () => {
    console.log(`server running on port ${PORT} (${loaded} stocks loaded)`);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => {
  console.error("unhandled rejection:", error);
});

if (require.main === module) {
  start().catch((error) => {
    console.error("startup failed:", error);
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
  load,
  tick,
  compress,
  calculatePrice,
  calculatePassiveMovement,
  getPassiveRandomnessMultiplier,
  validateStockName
};
