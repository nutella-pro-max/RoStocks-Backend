const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/*
=========================================================
RATE LIMIT
=========================================================
*/

app.use(
    rateLimit({
        windowMs: 60 * 1000,
        max: 120,
        standardHeaders: true,
        legacyHeaders: false
    })
);

/*
=========================================================
SUPABASE
=========================================================
*/

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

/*
=========================================================
CONFIG
=========================================================
*/

const STOCKS = {}; // STOCKS[userId]

const MARKET_TICK_MINUTES = 3;
const HISTORY_INTERVAL = 10 * 60 * 1000;

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;
const ONE_MONTH = 30 * ONE_DAY;

const VOLATILITY = 25;

/*
=========================================================
HTTP CLIENT
=========================================================
*/

const http = axios.create({
    timeout: 15000,
    headers: {
        "User-Agent": "RoAPI/1.0"
    }
});

/*
=========================================================
UTILS
=========================================================
*/

const isId = (v) => /^\d+$/.test(v);

function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
}

/*
=========================================================
STOCK INIT (USERID ONLY)
=========================================================
*/

async function ensureStockExists(userId) {
    if (STOCKS[userId]) return;

    const { data } = await supabase
        .from("stocks")
        .select("*")
        .eq("stock", userId)
        .single();

    if (data) {
        STOCKS[userId] = {
            price: data.price,
            lastHistorySave: data.last_history_save || 0
        };
        return;
    }

    STOCKS[userId] = {
        price: 10,
        lastHistorySave: 0
    };

    await supabase.from("stocks").insert({
        stock: userId,
        price: 10,
        last_history_save: 0
    });
}

/*
=========================================================
SAVE STOCK (RACE SAFE UPSERT)
=========================================================
*/

async function saveStock(userId) {
    const s = STOCKS[userId];
    if (!s) return;

    await supabase.from("stocks").upsert({
        stock: userId,
        price: s.price,
        last_history_save: s.lastHistorySave,
        updated_at: new Date().toISOString()
    });
}

/*
=========================================================
MARKET UPDATE (PRICE ONLY)
=========================================================
*/

function updateAllStocks() {
    for (const userId in STOCKS) {
        const current = STOCKS[userId].price;

        const changePercent =
            (Math.random() - 0.5) * VOLATILITY;

        const newPrice =
            Math.max(
                1,
                Number((current + current * changePercent / 100).toFixed(2))
            );

        STOCKS[userId].price = newPrice;
    }
}

/*
=========================================================
HISTORY ENGINE (EVERY 10 MINUTES)
=========================================================
*/

async function saveHistoryTick() {
    const now = Date.now();

    for (const userId in STOCKS) {
        const stock = STOCKS[userId];

        if (now - stock.lastHistorySave < HISTORY_INTERVAL) continue;

        stock.lastHistorySave = now;

        await supabase.from("stock_history").insert({
            stock: userId,
            price: stock.price,
            timestamp: now
        });
    }
}

/*
=========================================================
COMPRESSION ENGINE
=========================================================
*/

async function compressStockHistory() {
    const now = Date.now();

    const { data } = await supabase
        .from("stock_history")
        .select("*")
        .order("timestamp", { ascending: true });

    if (!data) return;

    const grouped = {};

    for (const row of data) {
        if (!grouped[row.stock]) grouped[row.stock] = [];
        grouped[row.stock].push(row);
    }

    for (const stock in grouped) {
        const rows = grouped[stock];

        let lastHour = 0;
        let lastDay = 0;
        let lastWeek = 0;

        const deleteIds = [];

        for (const r of rows) {
            const age = now - r.timestamp;

            // delete > 1 month
            if (age > ONE_MONTH) {
                deleteIds.push(r.id);
                continue;
            }

            // last 1 hour keep all
            if (age <= ONE_HOUR) continue;

            // 1 hour → 24h: keep 1h interval
            if (age <= ONE_DAY) {
                if (r.timestamp - lastHour < ONE_HOUR) {
                    deleteIds.push(r.id);
                } else {
                    lastHour = r.timestamp;
                }
                continue;
            }

            // 24h → 1 week: keep every 4 hours
            if (age <= ONE_WEEK) {
                if (r.timestamp - lastDay < 4 * ONE_HOUR) {
                    deleteIds.push(r.id);
                } else {
                    lastDay = r.timestamp;
                }
                continue;
            }

            // 1 week → 1 month: keep every 4 days
            if (age <= ONE_MONTH) {
                if (r.timestamp - lastWeek < 4 * 24 * ONE_HOUR) {
                    deleteIds.push(r.id);
                } else {
                    lastWeek = r.timestamp;
                }
            }
        }

        if (deleteIds.length) {
            await supabase
                .from("stock_history")
                .delete()
                .in("id", deleteIds);
        }
    }
}

/*
=========================================================
MARKET LOOP
=========================================================
*/

setInterval(async () => {
    updateAllStocks();

    for (const userId in STOCKS) {
        await saveStock(userId);
    }
}, MARKET_TICK_MINUTES * 60 * 1000);

/*
=========================================================
HISTORY LOOP (FIXED CORE FEATURE)
=========================================================
*/

setInterval(async () => {
    await saveHistoryTick();
}, HISTORY_INTERVAL);

/*
=========================================================
COMPRESSION LOOP
=========================================================
*/

setInterval(async () => {
    await compressStockHistory();
}, ONE_HOUR);

/*
=========================================================
ROOT
=========================================================
*/

app.get("/", (req, res) => {
    res.send("RoAPI unified backend is online!");
});

/*
=========================================================
GET STOCK
=========================================================
*/

app.get("/stock/:stock", async (req, res) => {
    try {
        const userId = req.params.stock;

        if (!isId(userId)) {
            return res.json({ success: false, error: "Use userId only" });
        }

        await ensureStockExists(userId);

        res.json({
            success: true,
            userId,
            price: STOCKS[userId].price
        });

    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

/*
=========================================================
TRADE (PRICE IMPACT ONLY)
=========================================================
*/

app.post("/trade", async (req, res) => {
    try {
        const { userId, shares, type } = req.body;

        if (!isId(userId)) {
            return res.json({ success: false, error: "userId required" });
        }

        if (typeof shares !== "number" || shares <= 0) {
            return res.json({ success: false, error: "Invalid shares" });
        }

        if (type !== "BUY" && type !== "SELL") {
            return res.json({ success: false, error: "Invalid type" });
        }

        await ensureStockExists(userId);

        const oldPrice = STOCKS[userId].price;

        const impact = Math.log10(shares + 1) * 2;

        let newPrice =
            type === "BUY"
                ? oldPrice + impact
                : oldPrice - impact;

        newPrice = Math.max(1, Number(newPrice.toFixed(2)));

        STOCKS[userId].price = newPrice;

        await saveStock(userId);

        res.json({
            success: true,
            userId,
            oldPrice,
            newPrice
        });

    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

/*
=========================================================
ROBLOX API
=========================================================
*/

app.get("/:type/:value", async (req, res) => {
    try {
        const { type, value } = req.params;

        let response;

        /*
        =========================
        USER / PLAYER
        =========================
        */
        if (type === "user" || type === "player") {

            let userId = value;

            if (!isId(value)) {
                const lookup = await http.post(
                    "https://users.roblox.com/v1/usernames/users",
                    {
                        usernames: [value],
                        excludeBannedUsers: false
                    }
                );

                userId = lookup.data?.data?.[0]?.id;

                if (!userId) {
                    return res.json({
                        success: false,
                        error: "User not found"
                    });
                }
            }

            const userRes = await http.get(
                `https://users.roblox.com/v1/users/${userId}`
            );

            const counts = await getUserCounts(userId);

            const thumb = await http.get(
                `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`
            );

            const accountValue = await getAccountValue(userId);

            response = {
                data: {
                    ...userRes.data,
                    counts,
                    accountValue,
                    thumbnail: thumb.data?.data?.[0]?.imageUrl || null
                }
            };
        }

        /*
        =========================
        ASSET
        =========================
        */
        else if (type === "asset") {

            if (isId(value)) {
                response = await http.get(
                    `https://economy.roblox.com/v2/assets/${value}/details`
                );
            } else {
                response = await http.get(
                    `https://catalog.roblox.com/v1/search/items/details?Category=All&Keyword=${encodeURIComponent(value)}`
                );
            }
        }

        /*
        =========================
        GAME / EXPERIENCE
        =========================
        */
        else if (type === "game" || type === "experience") {

            if (isId(value)) {

                let universeId = null;

                try {
                    const uni = await http.get(
                        `https://apis.roblox.com/universes/v1/places/${value}/universe`
                    );

                    universeId = uni.data?.universeId;
                } catch {}

                const finalId = universeId || value;

                response = await http.get(
                    `https://games.roblox.com/v1/games?universeIds=${finalId}`
                );

            } else {
                response = await http.get(
                    `https://games.roblox.com/v1/games/list?keyword=${encodeURIComponent(value)}`
                );
            }
        }

        /*
        =========================
        GROUP
        =========================
        */
        else if (type === "group") {

            if (isId(value)) {
                response = await http.get(
                    `https://groups.roblox.com/v1/groups/${value}`
                );
            } else {
                response = await http.get(
                    `https://groups.roblox.com/v1/groups/search?keyword=${encodeURIComponent(value)}`
                );
            }
        }

        /*
        =========================
        INVALID TYPE
        =========================
        */
        else {
            return res.json({
                success: false,
                error: "Unsupported type",
                supportedTypes: ["user", "player", "asset", "game", "experience", "group"]
            });
        }

        return res.json({
            success: true,
            type,
            value,
            data: response.data
        });

    } catch (err) {
        return res.json({
            success: false,
            error: "Failed to fetch Roblox data",
            details: err.response?.data || err.message
        });
    }
});

/*
=========================================================
START
=========================================================
*/

async function loadStocks() {
    const { data } = await supabase.from("stocks").select("*");

    for (const row of data || []) {
        STOCKS[row.stock] = {
            price: row.price,
            lastHistorySave: row.last_history_save || 0
        };
    }
}

app.listen(PORT, async () => {
    await loadStocks();
    console.log("Server running on port", PORT);
});
