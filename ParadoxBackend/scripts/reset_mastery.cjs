#!/usr/bin/env node
/*
 * reset_mastery.cjs - wipe every account's mastery back to zero: all MasteryTrack_* progress rows and all
 * MasteryObjective_* objective rows. Objectives go too, otherwise the game server would see them as already
 * completed and never pay their points again. Raw reports in progressionObjectiveEvents are kept (diagnostics).
 * Mastery rewards are not stored items (they follow rank), so nothing else needs revoking.
 *
 * Run with every player offline (a connected game server holds objective state in memory).
 *   node --env-file=.env scripts/reset_mastery.cjs           # dry run, prints counts
 *   node --env-file=.env scripts/reset_mastery.cjs --apply   # deletes
 */
const { MongoClient } = require("mongodb");

const APPLY = process.argv.includes("--apply");

(async () => {
    const Client = await MongoClient.connect(process.env.MONGODB_URI);
    const Db = Client.db(process.env.MONGODB_DB);
    const Targets = [
        [Db.collection("progressionTracks"), { progressionId: /^MasteryTrack_/ }],
        [Db.collection("progressionObjectives"), { objectiveId: /^MasteryObjective_/ }],
    ];
    for(const [Col, Filter] of Targets){
        const Count = await Col.countDocuments(Filter);
        if(APPLY) await Col.deleteMany(Filter);
        console.log(`${Col.collectionName}: ${Count} mastery row(s) ${APPLY ? "deleted" : "would be deleted"}`);
    }
    if(!APPLY) console.log("dry run - re-run with --apply to delete");
    await Client.close();
})().catch((Err) => { console.error(Err); process.exit(1); });
