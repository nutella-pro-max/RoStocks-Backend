const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("RoAPI unified backend is online!");
});

// helper: check if value is numeric ID
const isId = (value) => /^\d+$/.test(value);

app.get("/:type/:value", async (req, res) => {
    try {
        const { type, value } = req.params;

        let response;

        // 👤 USER (ID or USERNAME)
        if (type === "user" || type === "player") {

            if (isId(value)) {
                // user by ID
                response = await axios.get(
                    `https://users.roblox.com/v1/users/${value}`
                );
            } else {
                // username → userId lookup
                const lookup = await axios.post(
                    `https://users.roblox.com/v1/usernames/users`,
                    {
                        usernames: [value],
                        excludeBannedUsers: false
                    }
                );

                const userId = lookup.data?.data?.[0]?.id;

                if (!userId) {
                    return res.json({
                        success: false,
                        error: "User not found"
                    });
                }

                response = await axios.get(
                    `https://users.roblox.com/v1/users/${userId}`
                );
            }
        }

        // 📦 ASSET (ID or NAME)
        else if (type === "asset") {

            if (isId(value)) {
                response = await axios.get(
                    `https://economy.roblox.com/v2/assets/${value}/details`
                );
            } else {
                // search asset by name (catalog search)
                response = await axios.get(
                    `https://catalog.roblox.com/v1/search/items/details?Category=All&Keyword=${encodeURIComponent(value)}`
                );
            }
        }

        // 🎮 GAME / EXPERIENCE (ID or NAME)
        else if (type === "experience" || type === "game") {

            if (isId(value)) {

                // treat as placeId/universeId
                let universeId = null;

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

        // 👥 GROUP (ID or NAME)
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

        else {
            return res.json({
                success: false,
                error: "Unsupported type",
                supportedTypes: ["user", "asset", "experience", "game", "group"]
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

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
