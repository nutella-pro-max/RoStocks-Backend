    const express = require("express");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

app.get("/", (req, res) => {
    res.send("RoAPI unified backend is online!");
});
const STOCKS = {};

// =========================================================
// HELPERS
// =========================================================

// check if numeric ID
const isId = (value) => /^\d+$/.test(value);

// friend/follower counts
async function getUserCounts(userId) {

    const [friends, followers, following] = await Promise.all([

        axios.get(
            `https://friends.roblox.com/v1/users/${userId}/friends/count`
        ),

        axios.get(
            `https://friends.roblox.com/v1/users/${userId}/followers/count`
        ),

        axios.get(
            `https://friends.roblox.com/v1/users/${userId}/followings/count`
        )

    ]);

    return {
        friends: friends.data.count,
        followers: followers.data.count,
        following: following.data.count
    };
}

// get ALL collectibles
async function getAllCollectibles(userId) {

    let cursor = null;
    let collectibles = [];

    while (true) {

        const res = await axios.get(
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

        if (!res.data.nextPageCursor) break;

        cursor = res.data.nextPageCursor;
    }

    return collectibles;
}

// calculate total account value
async function getAccountValue(userId) {

    try {

        // get collectibles
        const collectibles = await getAllCollectibles(userId);

        // Rolimons values
        const rolimonsRes = await axios.get(
            "https://www.rolimons.com/itemapi/itemdetails"
        );

        const itemData = rolimonsRes.data.items;

        let totalRAP = 0;
        let totalValue = 0;

        for (const item of collectibles) {

            const details = itemData[item.assetId];

            if (!details) continue;

            // Rolimons format:
            // [name, acronym, rap, value, ...]

            const rap = details[2] || 0;
            const value = details[3] || rap;

            totalRAP += rap;
            totalValue += value;
        }

        return {
            collectibleCount: collectibles.length,
            totalRAP,
            totalValue
        };

    } catch (err) {

        return {
            collectibleCount: 0,
            totalRAP: 0,
            totalValue: 0,
            error: "Inventory may be private"
        };
    }
}

// calculate new stock price
function calculateNewPrice(oldPrice, shares, type, followers, accountValue, accountAgeDays) {
    /*
    =========================================================
    REPUTATION SCORE
    =========================================================
    */

    const followerScore =
        Math.log10(followers + 1) * 1.5;

    const valueScore =
        Math.log10(accountValue + 1) * 2;

    const ageScore =
        Math.log10(accountAgeDays + 1) * 1.2;

    /*
    =========================================================
    BASE VALUE
    =========================================================
    */

    const reputationValue =
        10 +
        followerScore +
        valueScore +
        ageScore;

    /*
    =========================================================
    MARKET MOVEMENT
    =========================================================
    */

    const marketForce = shares * 0.02;

    let newPrice = oldPrice;

    if (type === "BUY") {
        newPrice += marketForce;
    }

    if (type === "SELL") {
        newPrice -= marketForce;
    }

    /*
    =========================================================
    BLEND MARKET + REPUTATION
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

async function cleanupOldHistory() {

    const oneMonthAgo =
        Date.now() - (7 * 24 * 60 * 60 * 1000);

    const { error } = await supabase
        .from("stock_history")
        .delete()
        .lt("timestamp", oneMonthAgo);

    if (error) {

        console.error(
            "Cleanup failed:",
            error.message
        );

    } else {

        console.log(
            "Old stock history deleted"
        );
    }
}

// =========================================================
// MAIN ROUTE
// =========================================================
app.get("/history/:stock", async (req, res) => {

    try {

        const stock = req.params.stock;

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

        if (!STOCKS[stock]) {

            return res.json({
                success: false,
                error: "Stock not found"
            });
        }

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

app.post("/trade", async (req, res) => {

    try {

        const {
            stock,
            shares,
            type,
            followers,
            accountValue,
            accountAgeDays
        } = req.body;

        /*
        =========================================================
        VALIDATION
        =========================================================
        */

        if (!stock || typeof stock !== "string") {

            return res.json({
                success: false,
                error: "Invalid stock"
            });
        }

        if (
            typeof shares !== "number" ||
            shares <= 0
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
                error: "Invalid type"
            });
        }

        /*
        =========================================================
        CREATE STOCK
        =========================================================
        */

        if (!STOCKS[stock]) {

            STOCKS[stock] = {
                price: 10,
                lastSaved: 0
            };
        }

        /*
        =========================================================
        CALCULATE PRICE
        =========================================================
        */

        const oldPrice = STOCKS[stock].price;

        const newPrice = calculateNewPrice(
            oldPrice,
            shares,
            type,
            followers || 0,
            accountValue || 0,
            accountAgeDays || 0
        );

        STOCKS[stock].price = newPrice;

        /*
        =========================================================
        SAVE SNAPSHOT EVERY 10 MINUTES
        =========================================================
        */

        const now = Date.now();

        const TEN_MINUTES = 10 * 60 * 1000;

        if (
            now - STOCKS[stock].lastSaved >= TEN_MINUTES
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
        RESPONSE
        =========================================================
        */

        return res.json({
            success: true,
            stock,
            oldPrice,
            newPrice
        });

    } catch (err) {

        return res.json({
            success: false,
            error: err.message
        });
    }
});

app.get("/:type/:value", async (req, res) => {

    try {

        const { type, value } = req.params;

        let response;

        // =========================================================
        // 👤 USER / PLAYER
        // =========================================================

        if (type === "user" || type === "player") {

            let userId = value;

            // username → userid
            if (!isId(value)) {

                const lookup = await axios.post(
                    `https://users.roblox.com/v1/usernames/users`,
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

            // user info
            const userRes = await axios.get(
                `https://users.roblox.com/v1/users/${userId}`
            );

            // counts
            const counts = await getUserCounts(userId);

            // avatar thumbnail
            const thumbnailRes = await axios.get(
                `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`
            );

            // account value
            const accountValue = await getAccountValue(userId);

            response = {
                data: {
                    ...userRes.data,

                    counts,

                    accountValue,

                    thumbnail:
                        thumbnailRes.data?.data?.[0]?.imageUrl || null
                }
            };
        }

        // =========================================================
        // 📦 ASSET
        // =========================================================

        else if (type === "asset") {

            if (isId(value)) {

                response = await axios.get(
                    `https://economy.roblox.com/v2/assets/${value}/details`
                );

            } else {

                response = await axios.get(
                    `https://catalog.roblox.com/v1/search/items/details?Category=All&Keyword=${encodeURIComponent(value)}`
                );
            }
        }

        // =========================================================
        // 🎮 GAME / EXPERIENCE
        // =========================================================

        else if (type === "game" || type === "experience") {

            if (isId(value)) {

                let universeId = null;

                // placeId → universeId
                try {

                    const universeRes = await axios.get(
                        `https://apis.roblox.com/universes/v1/places/${value}/universe`
                    );

                    universeId = universeRes.data?.universeId;

                } catch (e) {}

                const finalUniverseId = universeId || value;

                response = await axios.get(
                    `https://games.roblox.com/v1/games?universeIds=${finalUniverseId}`
                );

            } else {

                // game name search
                response = await axios.get(
                    `https://games.roblox.com/v1/games/list?keyword=${encodeURIComponent(value)}`
                );
            }
        }

        // =========================================================
        // 👥 GROUP
        // =========================================================

        else if (type === "group") {

            if (isId(value)) {

                response = await axios.get(
                    `https://groups.roblox.com/v1/groups/${value}`
                );

            } else {

                response = await axios.get(
                    `https://groups.roblox.com/v1/groups/search?keyword=${encodeURIComponent(value)}`
                );
            }
        }

        // =========================================================
        // ❌ INVALID TYPE
        // =========================================================

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

        // =========================================================
        // ✅ SUCCESS RESPONSE
        // =========================================================

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

async function compressStockHistory() {

    try {

        const now = Date.now();

        const THREE_HOURS =
            3 * 60 * 60 * 1000;

        const ONE_DAY =
            24 * 60 * 60 * 1000;

        const ONE_WEEK =
            7 * 24 * 60 * 60 * 1000;

        const ONE_MONTH =
            30 * 24 * 60 * 60 * 1000;

        /*
        =========================================================
        GET ALL HISTORY
        =========================================================
        */

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

        /*
        =========================================================
        GROUP BY STOCK
        =========================================================
        */

        const grouped = {};

        for (const row of data) {

            if (!grouped[row.stock]) {
                grouped[row.stock] = [];
            }

            grouped[row.stock].push(row);
        }

        /*
        =========================================================
        PROCESS EACH STOCK
        =========================================================
        */

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
                OLDER THAN MONTH -> DELETE
                =========================================================
                */

                if (age > ONE_MONTH) {

                    idsToDelete.push(snapshot.id);

                    continue;
                }

                /*
                =========================================================
                LAST 3 HOURS
                KEEP EVERYTHING
                =========================================================
                */

                if (age <= THREE_HOURS) {
                    continue;
                }

                /*
                =========================================================
                LAST DAY
                KEEP 1 HOUR APART
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
                LAST WEEK
                KEEP 12 HOURS APART
                =========================================================
                */

                if (age <= ONE_WEEK) {

                    if (
                        snapshot.timestamp -
                        last12HourSnapshot <
                        12 * 60 * 60 * 1000
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
                LAST MONTH
                KEEP 2 DAYS APART
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

            /*
            =========================================================
            DELETE COMPRESSED SNAPSHOTS
            =========================================================
            */

            if (idsToDelete.length > 0) {

                await supabase
                    .from("stock_history")
                    .delete()
                    .in("id", idsToDelete);

                console.log(
                    `Compressed ${stock}: removed ${idsToDelete.length} snapshots`
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

setInterval(cleanupOldHistory, 24 * 60 * 60 * 1000);
setInterval(compressStockHistory, 24 * 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
