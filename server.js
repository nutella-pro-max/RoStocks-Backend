const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("RoAPI unified backend is online!");
});

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

// =========================================================
// MAIN ROUTE
// =========================================================

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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
