/*
 * One-time wallet migration (2026-10-16): Ace Chips (CURRENCY_TOKEN_EXCHANGE_SPEED_UP) were removed from the game,
 * so every balance becomes Aetherdust (CURRENCY_CELLDUST) at RATE dust per chip. Same atomic pattern as
 * migrate_reward_cache_currency.ts: the filter pins the balance read, so a concurrent change is a reported conflict.
 * Re-running is a no-op once wallets hold 0 chips.
 *   tsx --env-file=.env scripts/migrate_ace_chips.ts                    (dry-run)
 *   tsx --env-file=.env scripts/migrate_ace_chips.ts --apply --confirm=APPLY_ACE_CHIP_MIGRATION
 */

import { GetMongoDb } from "../src/persistence/mongo/client";
import { Collections } from "../src/persistence/mongo/collections";

const APPLY_CONFIRMATION = "APPLY_ACE_CHIP_MIGRATION";
const FROM = "CURRENCY_TOKEN_EXCHANGE_SPEED_UP";
const TO = "CURRENCY_CELLDUST";
const RATE = 3;

const Apply = process.argv.includes("--apply");
if (Apply && !process.argv.includes(`--confirm=${APPLY_CONFIRMATION}`)) {
    throw new Error(`Refusing write: --apply requires --confirm=${APPLY_CONFIRMATION}`);
}

async function Main(): Promise<void> {
    const Db = await GetMongoDb();
    const Wallets = Db.collection(Collections.Wallets);
    const Summary = { mode: Apply ? "apply" : "dry-run", wallets: 0, migrated: 0, conflicts: 0, chips: 0, dust: 0 };
    for await (const Doc of Wallets.find({ [`balances.${FROM}`]: { $gt: 0 } }, { projection: { userId: 1, balances: 1 } })) {
        const Chips = Number(Doc.balances[FROM]);
        if (!Number.isSafeInteger(Chips)) continue;
        Summary.wallets++;
        let Status = "dry-run";
        if (Apply) {
            const Result = await Wallets.updateOne({ _id: Doc._id, [`balances.${FROM}`]: Chips }, { $inc: { [`balances.${FROM}`]: -Chips, [`balances.${TO}`]: Chips * RATE } });
            Status = Result.modifiedCount === 1 ? "migrated" : "conflict";
            if (Status === "migrated") { Summary.migrated++; Summary.chips += Chips; Summary.dust += Chips * RATE; } else Summary.conflicts++;
        }
        console.log(`${Doc.userId ?? Doc._id}: ${Chips} chips -> ${Chips * RATE} dust (${Number(Doc.balances[TO] ?? 0)} before) ${Status}`);
    }
    console.log(JSON.stringify(Summary));
}

Main().then(() => process.exit(0), (Err) => { console.error(Err); process.exit(1); });
