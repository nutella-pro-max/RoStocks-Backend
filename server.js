const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("RoAPI unified backend is online!");
});

// helper: check if string is numeric ID
const isId = (value) => /^\d+$/.test(value);

// helper: get friend/follower counts
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

            response = {
                data: {
                    ...userRes.data,

                    counts,

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

                // try placeId → universeId
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
