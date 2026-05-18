const express = require("express");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.send("RoStocks backend is online!");
});

app.get("/game/:placeId", async (req, res) => {
    try {
        const placeId = req.params.placeId;

        // STEP 1: placeId → universeId (CORRECT ENDPOINT)
        const universeResponse = await axios.get(
            `https://apis.roblox.com/universes/v1/places/${placeId}/universe`
        );

        const universeId = universeResponse.data?.universeId;

        if (!universeId) {
            return res.json({
                success: false,
                error: "UniverseId not found for this placeId"
            });
        }

        // STEP 2: universeId → game data
        const gameResponse = await axios.get(
            `https://games.roblox.com/v1/games?universeIds=${universeId}`
        );

        const game = gameResponse.data?.data?.[0];

        if (!game) {
            return res.json({
                success: false,
                error: "Game data not found"
            });
        }

        res.json({
            success: true,
            game: {
                id: game.id,
                placeId: game.rootPlaceId,
                name: game.name,

                creatorIsGroup: game.creator.type == "Group",
                creatorId: game.creator.id,
                creatorName: game.creator.name,

                playing: game.playing,
                visits: game.visits,
                created: game.created,
                updated: game.updated,
                favorites: game.favoritedCount
            }
        });

    } catch (err) {
        console.error("ERROR:", err.response?.data || err.message);

        res.json({
            success: false,
            error: "Failed to fetch Roblox data",
            details: err.response?.data || err.message
        });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});