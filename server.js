const express = require("express");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/*
=========================================================
RATE LIMITING
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
CONSTANTS
=========================================================
*/

const STOCKS = {};

const MARKET_TICK_MINUTES = 5;
const VOLATILITY = 0.5;

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;
const ONE_WEEK = 7 * ONE_DAY;
const ONE_MONTH = 30 * ONE_DAY;

const MAX_SHARES_PER_TRADE = 1000;
const MAX_STOCK_NAME_LENGTH = 32;

const REQUEST_TIMEOUT = 15000;

/*
=========================================================
CACHES
=========================================================
*/

const ACCOUNT_VALUE_CACHE = {};
let ROLIMONS_CACHE = null;
let ROLIMONS_LAST_FETCH = 0;

/*
=========================================================
AXIOS CLIENT
=========================================================
*/

const http = axios.create({
    timeout: REQUEST_TIMEOUT,
    headers: {
        "User-Agent": "RoAPI/1.0"
    }
});

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
HELPERS
=========================================================
*/

const isId = (value) => /^\d+$/.test(value);

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

/*
=========================================================
ROBLOX HELPERS
=========================================================
*/

async function getUserCounts(userId) {

    const [friends, followers, following] = await Promise.all([
        http.get(
            `https://friends.roblox.com/v1/users/${userId}/friends/count`
        ),

        http.get(
            `https://friends.roblox.com/v1/users/${userId}/followers/count`
        ),

        http.get(
            `https://friends.roblox.com/v1/users/${userId}/followings/count`
        )
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
    let pageCount = 0;

    while (true) {

        if (pageCount >= maxPages) {
            break;
        }

        const res = await http.get(
            `https://inventory.roblox.com/v1/users/${userId}/assets/collectibles`,
            {
                params: {
                    limit: 100,
                    sortOrder: "Asc",
                    cursor
                }
            }
        );

        collectibles.push(...(res.data.data || []));

        if (!res.data.nextPageCursor) {
            break;
        }

        cursor = res.data.nextPageCursor;
        pageCount++;
    }

    return collectibles;
}

async function getRolimonsData() {

    const TEN_MINUTES = 10 * 60 * 1000;

    if (
        ROLIMONS_CACHE &&
        Date.now() - ROLIMONS_LAST_FETCH < TEN_MINUTES
    ) {
        return ROLIMONS_CACHE;
    }

    const res = await http.get(
        "https://www.rolimons.com/itemapi/itemdetails"
    );

    ROLIMONS_CACHE = res.data.items || {};
    ROLIMONS_LAST_FETCH = Date.now();

    return ROLIMONS_CACHE;
}

async function getAccountValue(userId) {

    const cache = ACCOUNT_VALUE_CACHE[userId];

    if (cache && cache.expires > Date.now()) {
        return cache.data;
    }

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
            expires: Date.now() + (5 * 60 * 1000)
        };

        return result;

    } catch (err) {

        return {
            collectibleCount: 0,
            totalRAP: 0,
            totalValue: 0,
            error: "Inventory may be private"
        };
    }
}

/*
=========================================================
MARKET
=========================================================
*/

function calculateNewPrice(
    oldPrice,
    shares,
    type,
    followers,
    accountValue,
    accountAgeDays
) {

    /*
    =========================================================
    REPUTATION
    =========================================================
    */

    const followerScore =
        Math.log10(followers + 1) * 1.5;

    const valueScore =
        Math.log10(accountValue + 1) * 2;

    const ageScore =
        Math.log10(accountAgeDays + 1) * 1.2;

    const reputationValue =
        10 +
        followerScore +
        valueScore +
        ageScore;

    /*
    =========================================================
    MARKET FORCE
    =========================================================
    */

    const marketForce =
        Math.log10(shares + 1) * 0.8;

    let newPrice = oldPrice;

    if (type === "BUY") {
        newPrice += marketForce;
    }

    if (type === "SELL") {
        newPrice -= marketForce;
    }

    /*
    =========================================================
    BLEND
    =========================================================
    */

    newPrice =
        (newPrice * 0.8) +
        (reputationValue * 0.2);

    /*
    =========================================================
    SAFETY
    =========================================================
    */

    newPrice = Math.max(1, newPrice);

    return Number(newPrice.toFixed(2));
}

function updateAllStocksAlive(volatilityPercent = 0.5) {

    for (const stock in STOCKS) {

        const current = STOCKS[stock].price;

        const momentum =
            (Math.random() - 0.5) * 0.2;

        const changePercent =
            randomBetween(
                -volatilityPercent,
                volatilityPercent
            ) + momentum;

        const change =
            current * (changePercent / 100);

        let newPrice = current + change;

        newPrice = Math.max(1, newPrice);
        newPrice = Number(newPrice.toFixed(2));

        STOCKS[stock].price = newPrice;
    }
}

/*
=========================================================
DATABASE
=========================================================
*/

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

            STOCKS[stock] = {
                price: 10,
                lastSaved: 0
            };

            await supabase
                .from("stocks")
                .insert({
                    stock,
                    price: 10,
                    last_saved: Date.now()
                });

            await supabase
                .from("stock_history")
                .insert({
                    stock,
                    price: 10,
                    timestamp: Date.now()
                });
        }
    }
}

async function saveStock(stock) {

    await supabase
        .from("stocks")
        .upsert({
            stock,
            price: STOCKS[stock].price,
            last_saved: STOCKS[stock].lastSaved,
            updated_at: new Date().toISOString()
        });
}

/*
=========================================================
HISTORY COMPRESSION
=========================================================
*/

async function compressStockHistory() {

    try {

        const now = Date.now();

        const { data, error } = await supabase
            .from("stock_history")
            .select("*")
            .order("timestamp", {
                ascending: true
            });

        if (error) {
            console.error(error);
            return;
        }

        const grouped = {};

        for (const row of data) {

            if (!grouped[row.stock]) {
                grouped[row.stock] = [];
            }

            grouped[row.stock].push(row);
        }

        for (const stock in grouped) {

            const snapshots = grouped[stock];

            let lastHourSnapshot = 0;
            let last12HourSnapshot = 0;
            let last2DaySnapshot = 0;

            const idsToDelete = [];

            for (const snapshot of snapshots) {

                const age =
                    now - snapshot.timestamp;

                /*
                =========================================================
                DELETE MONTH+
                =========================================================
                */

                if (age > ONE_MONTH) {

                    idsToDelete.push(snapshot.id);
                    continue;
                }

                /*
                =========================================================
                KEEP EVERYTHING LAST 3 HOURS
                =========================================================
                */

                if (age <= 3 * ONE_HOUR) {
                    continue;
                }

                /*
                =========================================================
                KEEP 1 HOUR APART LAST DAY
                =========================================================
                */

                if (age <= ONE_DAY) {

                    if (
                        snapshot.timestamp -
                        lastHourSnapshot <
                        ONE_HOUR
                    ) {

                        idsToDelete.push(snapshot.id);

                    } else {

                        lastHourSnapshot =
                            snapshot.timestamp;
                    }

                    continue;
                }

                /*
                =========================================================
                KEEP 12 HOURS APART LAST WEEK
                =========================================================
                */

                if (age <= ONE_WEEK) {

                    if (
                        snapshot.timestamp -
                        last12HourSnapshot <
                        12 * ONE_HOUR
                    ) {

                        idsToDelete.push(snapshot.id);

                    } else {

                        last12HourSnapshot =
                            snapshot.timestamp;
                    }

                    continue;
                }

                /*
                =========================================================
                KEEP 2 DAYS APART LAST MONTH
                =========================================================
                */

                if (
                    snapshot.timestamp -
                    last2DaySnapshot <
                    2 * ONE_DAY
                ) {

                    idsToDelete.push(snapshot.id);

                } else {

                    last2DaySnapshot =
                        snapshot.timestamp;
                }
            }

            if (idsToDelete.length > 0) {

                await supabase
                    .from("stock_history")
                    .delete()
                    .in("id", idsToDelete);

                console.log(
                    `Compressed ${stock}: removed ${idsToDelete.length}`
                );
            }
        }

    } catch (err) {

        console.error(
            "Compression failed:",
            err
        );
    }
}

/*
=========================================================
ROUTES
=========================================================
*/

app.get("/history/:stock", async (req, res) => {

    try {

        const stock = req.params.stock;

        if (!validateStockName(stock)) {

            return res.json({
                success: false,
                error: "Invalid stock name"
            });
        }

        await ensureStockExists(stock);

        const { data, error } = await supabase
            .from("stock_history")
            .select("*")
            .eq("stock", stock)
            .order("timestamp", {
                ascending: true
            });

        if (error) {

            return res.json({
                success: false,
                error: error.message
            });
        }

        return res.json({
            success: true,
            history: data
        });

    } catch (err) {

        return res.json({
            success: false,
            error: err.message
        });
    }
});

app.get("/stock/:stock", async (req, res) => {

    try {

        const stock = req.params.stock;

        if (!validateStockName(stock)) {

            return res.json({
                success: false,
                error: "Invalid stock name"
            });
        }

        await ensureStockExists(stock);

        return res.json({
            success: true,
            stock,
            price: STOCKS[stock].price
        });

    } catch (err) {

        return res.json({
            success: false,
            error: err.message
        });
    }
});

/*
=========================================================
TRADE
=========================================================
*/

app.post("/trade", async (req, res) => {

    try {

        const {
            stock,
            shares,
            type
        } = req.body;

        /*
        =========================================================
        VALIDATION
        =========================================================
        */

        if (!validateStockName(stock)) {

            return res.json({
                success: false,
                error: "Invalid stock"
            });
        }

        if (
            typeof shares !== "number" ||
            shares <= 0 ||
            shares > MAX_SHARES_PER_TRADE
        ) {

            return res.json({
                success: false,
                error: "Invalid shares"
            });
        }

        if (
            type !== "BUY" &&
            type !== "SELL"
        ) {

            return res.json({
                success: false,
                error: "Invalid trade type"
            });
        }

        /*
        =========================================================
        FETCH ROBLOX USER DATA
        =========================================================
        */

        let userId = stock;

        if (!isId(stock)) {

            const lookup = await http.post(
                "https://users.roblox.com/v1/usernames/users",
                {
                    usernames: [stock],
                    excludeBannedUsers: false
                }
            );

            userId =
                lookup.data?.data?.[0]?.id;

            if (!userId) {

                return res.json({
                    success: false,
                    error: "Roblox user not found"
                });
            }
        }

        /*
        =========================================================
        USER INFO
        =========================================================
        */

        const userRes = await http.get(
            `https://users.roblox.com/v1/users/${userId}`
        );

        const userData = userRes.data;

        const counts =
            await getUserCounts(userId);

        const accountValue =
            await getAccountValue(userId);

        const createdDate =
            new Date(userData.created);

        const ageMs =
            Date.now() - createdDate.getTime();

        const accountAgeDays =
            Math.floor(
                ageMs / ONE_DAY
            );

        /*
        =========================================================
        CREATE STOCK
        =========================================================
        */

        await ensureStockExists(stock);

        /*
        =========================================================
        CALCULATE
        =========================================================
        */

        const oldPrice =
            STOCKS[stock].price;

        const newPrice =
            calculateNewPrice(
                oldPrice,
                shares,
                type,
                counts.followers,
                accountValue.totalValue,
                accountAgeDays
            );

        STOCKS[stock].price = newPrice;

        /*
        =========================================================
        SAVE HISTORY
        =========================================================
        */

        const now = Date.now();

        const TEN_MINUTES =
            10 * 60 * 1000;

        if (
            now -
            STOCKS[stock].lastSaved >=
            TEN_MINUTES
        ) {

            STOCKS[stock].lastSaved = now;

            await supabase
                .from("stock_history")
                .insert({
                    stock,
                    price: newPrice,
                    timestamp: now
                });
        }

        /*
        =========================================================
        SAVE LIVE STOCK
        =========================================================
        */

        await saveStock(stock);

        /*
        =========================================================
        RESPONSE
        =========================================================
        */

        return res.json({
            success: true,
            stock,
            oldPrice,
            newPrice,
            followers: counts.followers,
            accountValue:
                accountValue.totalValue,
            accountAgeDays
        });

    } catch (err) {

        return res.json({
            success: false,
            error: err.message
        });
    }
});

/*
=========================================================
ROBLOX LOOKUP ROUTE
=========================================================
*/

app.get("/:type/:value", async (req, res) => {

    try {

        const { type, value } = req.params;

        let response;

        /*
        =========================================================
        USER
        =========================================================
        */

        if (
            type === "user" ||
            type === "player"
        ) {

            let userId = value;

            if (!isId(value)) {

                const lookup =
                    await http.post(
                        "https://users.roblox.com/v1/usernames/users",
                        {
                            usernames: [value],
                            excludeBannedUsers: false
                        }
                    );

                userId =
                    lookup.data?.data?.[0]?.id;

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

            const counts =
                await getUserCounts(userId);

            const thumbnailRes =
                await http.get(
                    `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`
                );

            const accountValue =
                await getAccountValue(userId);

            response = {
                data: {
                    ...userRes.data,
                    counts,
                    accountValue,
                    thumbnail:
                        thumbnailRes.data
                            ?.data?.[0]
                            ?.imageUrl || null
                }
            };
        }

        /*
        =========================================================
        ASSET
        =========================================================
        */

        else if (type === "asset") {

            if (isId(value)) {

                response =
                    await http.get(
                        `https://economy.roblox.com/v2/assets/${value}/details`
                    );

            } else {

                response =
                    await http.get(
                        `https://catalog.roblox.com/v1/search/items/details?Category=All&Keyword=${encodeURIComponent(value)}`
                    );
            }
        }

        /*
        =========================================================
        GAME
        =========================================================
        */

        else if (
            type === "game" ||
            type === "experience"
        ) {

            if (isId(value)) {

                let universeId = null;

                try {

                    const universeRes =
                        await http.get(
                            `https://apis.roblox.com/universes/v1/places/${value}/universe`
                        );

                    universeId =
                        universeRes.data
                            ?.universeId;

                } catch {}

                const finalUniverseId =
                    universeId || value;

                response =
                    await http.get(
                        `https://games.roblox.com/v1/games?universeIds=${finalUniverseId}`
                    );

            } else {

                response =
                    await http.get(
                        `https://games.roblox.com/v1/games/list?keyword=${encodeURIComponent(value)}`
                    );
            }
        }

        /*
        =========================================================
        GROUP
        =========================================================
        */

        else if (type === "group") {

            if (isId(value)) {

                response =
                    await http.get(
                        `https://groups.roblox.com/v1/groups/${value}`
                    );

            } else {

                response =
                    await http.get(
                        `https://groups.roblox.com/v1/groups/search?keyword=${encodeURIComponent(value)}`
                    );
            }
        }

        /*
        =========================================================
        INVALID
        =========================================================
        */

        else {

            return res.json({
                success: false,
                error: "Unsupported type",
                supportedTypes: [
                    "user",
                    "player",
                    "asset",
                    "game",
                    "experience",
                    "group"
                ]
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
            details:
                err.response?.data ||
                err.message
        });
    }
});

/*
=========================================================
MARKET TICK
=========================================================
*/

setInterval(async () => {

    updateAllStocksAlive(VOLATILITY);

    for (const stock in STOCKS) {
        await saveStock(stock);
    }

    console.log(
        "Market tick: stocks updated"
    );

}, MARKET_TICK_MINUTES * 60 * 1000);

/*
=========================================================
COMPRESSION
=========================================================
*/

setInterval(
    compressStockHistory,
    6 * ONE_HOUR
);

/*
=========================================================
START
=========================================================
*/

app.listen(PORT, () => {

    console.log(
        `Server running on port ${PORT}`
    );
});
