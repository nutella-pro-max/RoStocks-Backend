const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("RoAPI unified backend is online!");
});

app.get("/roblox/:type/:id", async (req, res) => {
    try {
        const { type, id } = req.params;

        let response;

        // 👤 USER
        if (type === "user" || type === "player") {
            response = await axios.get(
                `https://users.roblox.com/v1/users/${id}`
            );
        }

        // 📦 ASSET
        else if (type === "asset") {
            response = await axios.get(
                `https://economy.roblox.com/v2/assets/${id}/details`
            );
        }

        // 🎮 EXPERIENCE (SMART HANDLING)
        else if (type === "experience" || type === "game") {

            // STEP 1: assume ID is a placeId
            const placeId = id;

            let universeId = null;

            try {
                const universeRes = await axios.get(
                    `https://apis.roblox.com/universes/v1/places/${placeId}/universe`
                );
                universeId = universeRes.data?.universeId;
            } catch (e) {
                // ignore, might already be universeId
            }

            // STEP 2: fallback → treat as universeId if place lookup fails
            const finalUniverseId = universeId || id;

            response = await axios.get(
                `https://games.roblox.com/v1/games?universeIds=${finalUniverseId}`
            );
        }

        // 👥 GROUP (optional but useful)
        else if (type === "group") {
            response = await axios.get(
                `https://groups.roblox.com/v1/groups/${id}`
            );
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
            id,
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
