#!/usr/bin/env node
/*
 * Copyright (C) 2026 MysticFox / Pranav Karande
 *
 * Licensed under the GNU Affero General Public License v3.0.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 *
 * generate_progression_config.cjs — build game-data/progression_config.json from a locally
 * captured/exported source.
 *
 * SOURCE (place under game-data/raw/, or set PARADOX_GAME_DATA_RAW_DIR):
 *   progression_config.source.json
 *
 * This is the hunt-pass / progression track payload for your target build. It is produced from
 * YOUR OWN game installation — either captured from the live progression response, or assembled
 * from CatalogExporter EXPORT_PROGRESSION output. It is NOT shipped in this repository.
 * See docs/GENERATING_GAME_DATA.md.
 *
 * The backend consumes exactly this shape (verified in src/controllers/progression.ts and
 * src/routes/system.ts):
 *   { "code": <any>, "message": <string>, "payload": { "paths": [ { free_rewards: [...] }, ... ] } }
 *
 * USAGE
 *   node scripts/generate_progression_config.cjs            # dry run: validates, writes nothing
 *   node scripts/generate_progression_config.cjs --apply    # writes game-data/progression_config.json
 */

const fs = require("node:fs");
const path = require("node:path");

const APPLY = process.argv.includes("--apply");

const RawDir = process.env.PARADOX_GAME_DATA_RAW_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_RAW_DIR)
    : path.resolve(__dirname, "../game-data/raw");
const OutDir = process.env.PARADOX_GAME_DATA_DIR
    ? path.resolve(process.env.PARADOX_GAME_DATA_DIR)
    : path.resolve(__dirname, "../game-data");

const SourcePath = path.join(RawDir, "progression_config.source.json");
const TargetPath = path.join(OutDir, "progression_config.json");

function Fail(Message){
    console.error(`ERROR: ${Message}`);
    process.exit(1);
}

if(!fs.existsSync(SourcePath)){
    Fail(`source not found at ${SourcePath}\n` +
        `Provide the progression payload from your own installation (see docs/GENERATING_GAME_DATA.md).`);
}

let Source;
try {
    Source = JSON.parse(fs.readFileSync(SourcePath, "utf8").replace(/^\uFEFF/, ""));
} catch (err) {
    Fail(`source is not valid JSON: ${String(err)}`);
}


const Paths = Source?.payload?.paths;
if(!Array.isArray(Paths)) Fail("source has no payload.paths[] array — refusing to write a shape the backend cannot read.");

// Slayer Link tracks (1.14.7). No capture has them, but the game server's prize pool generator refuses to run
// without the config track Linked_Slayer_Slot_1 ("Unable to get progression configuration track",
// ULinkedSlayerComponent::GeneratePrizePoolInternal 0x19ff90e) and the client reads Linked_Slayer_Slot_<slot>.
// Added only when the source lacks them. One rank per chest; the circle the client draws is
// (rank + rank progress / next rank's XP) / ranks (USlayerLinkViewModel::UpdateProgress 0x21ca6df), so the 4 chests
// sit at quarter turns. XP per chest from the wiki (5/400/800/1600, 2,805 total), = LINK_CHEST_XP in src/slayerLinks.ts.
const LINK_CHEST_XP = [5, 400, 800, 1600];
for (const Slot of [1, 2, 3]) {
    const Id = `Linked_Slayer_Slot_${Slot}`;
    if (Paths.some((P) => P?.progression_id === Id)) continue;
    const Ranks = Array.from({ length: LINK_CHEST_XP.length + 1 }, (_, Rank) => Rank);
    Paths.push({
        progression_id: Id,
        start_date: "2020-01-01T00:00:00+00:00",
        end_date: "2099-12-31T00:00:00+00:00",
        requirements: Ranks.map((Rank) => ({ rank_id: Rank, xp_required: Rank === 0 ? 0 : LINK_CHEST_XP[Rank - 1] })),
        free_rewards: Ranks.map((Rank) => ({ rank_id: Rank, entitlements: [], instanced_items: [], stacked_items: [] })),
    });
    console.log(`added ${Id} (chests at ${LINK_CHEST_XP.join("/")} XP)`);
}

// Hunt pass rotation slots (src/huntPassRotation.ts): season43..50, 100 levels x 100 XP. The curve must be in the file
// (rank-confirm and XP grants validate against it); rewards and windows are filled at serve time from hunt_passes.json.
for (let N = 43; N <= 50; N++) {
    const Id = "season" + N;
    const Path = {
        progression_id: Id,
        start_date: "2099-01-02T00:00:00+00:00",
        end_date: "2099-12-31T00:00:00+00:00",
        requirements: Array.from({ length: 101 }, (_, Rank) => ({ rank_id: Rank, xp_required: Rank === 0 ? 0 : 100 })),
        free_rewards: [],
    };
    const At = Paths.findIndex((P) => P?.progression_id === Id);
    if (At >= 0) Paths[At] = Path; else Paths.push(Path);
}

// Mastery: curve and rewards come from the client's own mastery_track_table (CatalogExporter
// EXPORT_PROGRESSION -> Items_Analysis/progression_1_14_7/mastery-tracks.jsonl). The client draws levels and
// reward lists from that table, so any other curve here puts the level and the unlocks out of step. The game
// server grants free_rewards when it confirms a rank, so empty rewards here mean no mastery rewards at all.
const MasteryExport = path.resolve(__dirname, "../../Items_Analysis/progression_1_14_7/mastery-tracks.jsonl");
if (!fs.existsSync(MasteryExport)) Fail(`mastery export not found at ${MasteryExport} (CatalogExporter EXPORT_PROGRESSION=1)`);
for (const Line of fs.readFileSync(MasteryExport, "utf8").split("\n").filter(Boolean)) {
    const Row = JSON.parse(Line).base;
    const P = Paths.find((X) => X?.progression_id === Row.progressionTrack);
    if (!P) continue;
    P.requirements = [{ rank_id: 0, xp_required: 0 }, ...Row.requirements.map((R) => ({ rank_id: R.rankId, xp_required: R.requiredXP }))];
    P.free_rewards = Row.freeRewards.map((R) => ({
        rank_id: R.rankId,
        entitlements: [],
        instanced_items: [],
        stacked_items: R.stackedItems.map((S) => ({ catalog_id: S.catalogId, hidden: false, priority: S.priority, quantity: S.quantity })),
    }));
    console.log(`mastery ${P.progression_id}: ${Row.requirements.length} ranks, ${P.free_rewards.length} reward levels (client table)`);
}

const Output = {
    code: Source.code ?? null,
    message: typeof Source.message === "string" ? Source.message : "OK",
    payload: { ...Source.payload, paths: Paths },
};

const TotalRewards = Paths.reduce((Acc, P) => Acc + ((P?.free_rewards?.length ?? 0)), 0);
console.log(`source paths      : ${Paths.length}`);
console.log(`free_rewards tiers : ${TotalRewards}`);
console.log(`mode              : ${APPLY ? "APPLY" : "DRY RUN (pass --apply to write)"}`);

if(!APPLY){
    console.log(`\nDry run complete. Nothing written.`);
    process.exit(0);
}

fs.mkdirSync(OutDir, { recursive: true });
if(fs.existsSync(TargetPath)){
    const Stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(TargetPath, `${TargetPath}.${Stamp}.bak`);
}
fs.writeFileSync(TargetPath, JSON.stringify(Output, null, 2), "utf8");
console.log(`\nWrote ${path.basename(TargetPath)} (${Paths.length} paths)`);
