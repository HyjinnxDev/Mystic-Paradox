#!/usr/bin/env node
/*
 * fetch_hunt_passes.cjs - build game-data/hunt_passes.json from the Dauntless wiki's Slayer Commission
 * Hunt Pass pages (the 100-level passes 1.10.0-1.14.x ran; the 1.14.7 build is from 2024-04-01, so all
 * five are in scope). Needs network. Wiki reward names map to 1.14.7 catalog ids below.
 *
 *   node scripts/fetch_hunt_passes.cjs            # dry run
 *   node scripts/fetch_hunt_passes.cjs --apply    # writes game-data/hunt_passes.json
 */
const fs = require("node:fs");
const path = require("node:path");

const PASSES = [
    { id: "return_to_light", name: "Return to Light", page: "Return_to_Light_(Slayer_Commission)" },
    { id: "dire_discovery", name: "Dire Discovery", page: "Dire_Discovery_(Slayer_Commission)" },
    { id: "elemental_fury", name: "Elemental Fury", page: "Elemental_Fury_(Slayer_Commission)" },
    { id: "heroic_thunder", name: "Heroic Thunder", page: "Heroic_Thunder_(Slayer_Commission)" },
    { id: "darkened_skies", name: "Darkened Skies", page: "Darkened_Skies_(Slayer_Commission)" },
];

// ponytail: Aetherdust/Aethersparks -> catalog ids are best guesses (display names are missing from the
// string table); fix here and re-run if a hunt shows the wrong currency.
const CATALOG_ID = {
    "Rams": "CURRENCY_NOTES",
    "Combat Merits": "CURRENCY_PJM_WEAPON",
    "Bounty Tokens": "TOKEN_BOUNTY_DRAFT",
    "Patrol Keys": "TOKEN_DAILY_PATROL_BONUS_PURCHASED",
    "Platinum": "CURRENCY_PLATINUM_UNIV", // promotional bucket: spent first, see platinumWallet.ts
    "Aetherdust": "CURRENCY_CELLDUST",
    "Transmog Stone": "CURRENCY_TOKEN_TRANSMOG",
    "Aethersparks": "CURRENCY_PJM_ALCHEMY",
};

function ParseReward(Cell) {
    const Value = Cell.trim();
    if (!Value) return [];
    const Match = Value.match(/^\{\{([^}]*?)-?\}\}\s*\(x([\d,]+)\)$/);
    const CatalogId = Match && CATALOG_ID[Match[1].trim()];
    if (!CatalogId) throw new Error(`unmapped reward cell: ${Value}`);
    return [{ catalog_id: CatalogId, quantity: Number(Match[2].replace(/,/g, "")) }];
}

(async () => {
    const Out = [];
    for (const Pass of PASSES) {
        const Url = `https://dauntless.fandom.com/api.php?action=parse&page=${Pass.page}&prop=wikitext&format=json`;
        const Text = (await (await fetch(Url, { headers: { "User-Agent": "Mozilla/5.0" } })).json()).parse.wikitext["*"];
        const Levels = Array.from({ length: 100 }, () => ({ free: [], elite: [] }));
        let Count = 0;
        for (const [, Lvl, Track, Cell] of Text.matchAll(/\|Lvl(\d+)(Free|Elite)=(.*)/g)) {
            Levels[Number(Lvl) - 1][Track.toLowerCase()] = ParseReward(Cell);
            Count++;
        }
        if (Count !== 200) throw new Error(`${Pass.name}: expected 200 reward cells, got ${Count}`);
        Out.push({ id: Pass.id, name: Pass.name, levels: Levels });
        console.log(`${Pass.name}: ok`);
    }
    if (process.argv.includes("--apply")) {
        const Target = path.resolve(__dirname, "../game-data/hunt_passes.json");
        fs.writeFileSync(Target, JSON.stringify(Out));
        console.log(`wrote ${Target}`);
    } else console.log("dry run (pass --apply to write)");
})().catch((E) => { console.error(E); process.exit(1); });
