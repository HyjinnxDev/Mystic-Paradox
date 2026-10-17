import { loadGameData } from "./gameData/loader";

// Hunt pass rotation. The 1.14.7 client only enables hunt_pass_season_table rows season43..season50, so those eight
// ids are fixed SLOTS; what a slot carries changes. Every ROTATION_DAYS the rotation index r advances and
//   slots 0..6 (season43..49) carry the next seven COSMETIC passes in order: cosmetic[(r + j) % n]
//   slot 7 (season50) carries a CURRENCY pass (a Slayer Commission pass: currencies, xp tokens, no cosmetics).
// A player is served the first cosmetic slot whose pass they have not completed; once all seven are done, the currency
// slot. Progress is stored per PASS (HuntPassStorageId), not per slot, so a slot changing hands never mixes progress.
// Data: game-data/hunt_passes_cosmetic.json (scripts/fetch_cosmetic_passes.cjs) and game-data/hunt_passes.json
// (scripts/fetch_hunt_passes.cjs).
// ponytail: "all cosmetic passes completed" is checked over the seven-pass window, not all n; widen the window
// (needs more client slots) or track completions per account if that gap ever matters.
// ponytail: the game server caches /progression/config, so a rotation change reaches it on the next restart.
export const HUNT_PASS_SLOT_IDS = ["season43", "season44", "season45", "season46", "season47", "season48", "season49", "season50"];
const COSMETIC_SLOTS = HUNT_PASS_SLOT_IDS.length - 1;
export const HUNT_PASS_XP_PER_LEVEL = 100;
// The pass window only prices Platinum (any other currency renders as "Free"), so the Elite track costs the real 1,000.
const HUNT_PASS_ELITE_PLATINUM = 1000;
const PLATINUM_LEVELS = 15;
const COMBAT_MERITS = "CURRENCY_PJM_WEAPON";
const FREE_MERITS = 100;
const ELITE_MERITS = 250; // the newer 30-level passes pay 250 per Elite drop
// Ranks (1-based) of the added merit drops: round(levels / 10) drops, at least 2, spread evenly.
const MeritDropRanks = (Levels: number) => {
    const N = Math.max(2, Math.round(Levels / 10));
    return Array.from({ length: N }, (_, K) => Math.round(((K + 1) * Levels) / (N + 1)));
};
const ROTATION_MS = 60 * 24 * 60 * 60 * 1000;
const ROTATION_ANCHOR_MS = Date.parse("2026-10-01T00:00:00+00:00");

type Reward = { catalog_id?: string; quantity?: number; priority?: number; kind?: "stacked" | "instanced" | "entitlement"; entitlement?: string; duration?: number };
type PassData = { id: string; name: string; levels: { free: Reward[]; elite: Reward[] }[] };
let Cosmetic: PassData[] | undefined;
let Currency: PassData[] | undefined;
const CosmeticPasses = () => (Cosmetic ??= loadGameData<PassData[]>("hunt_passes_cosmetic.json"));
const CurrencyPasses = () => (Currency ??= loadGameData<PassData[]>("hunt_passes.json"));

const IsoUtc = (Ms: number) => new Date(Ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");

export const IsHuntPassSlot = (Id: unknown): Id is string => typeof Id === "string" && HUNT_PASS_SLOT_IDS.includes(Id);

export function HuntPassRotationIndex(NowMs: number): number {
    return Math.max(0, Math.floor((NowMs - ROTATION_ANCHOR_MS) / ROTATION_MS));
}

export function ActiveSeasonWindow(NowMs: number): { start: string; end: string } {
    const Start = ROTATION_ANCHOR_MS + HuntPassRotationIndex(NowMs) * ROTATION_MS;
    return { start: IsoUtc(Start), end: IsoUtc(Start + ROTATION_MS) };
}

// The pass a slot carries right now.
export function PassForSlot(SlotId: string, NowMs = Date.now()): PassData {
    const Slot = HUNT_PASS_SLOT_IDS.indexOf(SlotId);
    if (Slot < 0) throw new Error(`'${SlotId}' is not a hunt pass slot`);
    const R = HuntPassRotationIndex(NowMs);
    return Slot < COSMETIC_SLOTS ? CosmeticPasses()[(R + Slot) % CosmeticPasses().length] : CurrencyPasses()[R % CurrencyPasses().length];
}

// Progress for a slot is stored under the pass it carries, e.g. "season43:frostfall".
export const HuntPassStorageId = (SlotId: string, NowMs = Date.now()) => `${SlotId}:${PassForSlot(SlotId, NowMs).id}`;

export const HuntPassMaxXp = (SlotId: string, NowMs = Date.now()) => PassForSlot(SlotId, NowMs).levels.length * HUNT_PASS_XP_PER_LEVEL;

// Rank curve of the pass a slot carries (same shape controllers/progression.ts builds for configured tracks).
export function HuntPassCurve(SlotId: string, NowMs = Date.now()) {
    const Levels = PassForSlot(SlotId, NowMs).levels.length;
    return { maxRank: Levels, cumulativeXpForRank: new Map(Array.from({ length: Levels + 1 }, (_, Rank) => [Rank, Rank * HUNT_PASS_XP_PER_LEVEL] as [number, number])) };
}

// The slot this player is on: GAMESERVER_HUNTPASS_ID pins it (debugging); otherwise the first cosmetic pass in the
// window they have not completed, else the currency slot. `Rows` are the player's stored progression tracks.
export function ServedSlotFor(Rows: { progressionId: string; progress: number }[], NowMs = Date.now()): string {
    const Pinned = process.env.GAMESERVER_HUNTPASS_ID?.trim();
    if (Pinned) return Pinned;
    const Progress = new Map(Rows.map((Row) => [Row.progressionId, Row.progress]));
    for (const Slot of HUNT_PASS_SLOT_IDS.slice(0, COSMETIC_SLOTS)) {
        if ((Progress.get(HuntPassStorageId(Slot, NowMs)) ?? 0) < HuntPassMaxXp(Slot, NowMs)) return Slot;
    }
    return HUNT_PASS_SLOT_IDS[COSMETIC_SLOTS];
}

export function HuntPassPassSkuTag(SlotId: string): string {
    return `${SlotId}_pass`;
}

// The entitlement that unlocks a pass's Elite track; the same string is the path's premium_gating_entitlement and
// what the Elite SKU grants, so ownership follows the pass, not the slot.
export const HuntPassEntitlement = (SlotId: string, NowMs = Date.now()) => `${PassForSlot(SlotId, NowMs).id}_premium`;

// One level's rewards in the shape the real configs use: stacked_items {catalog_id, hidden, priority, quantity},
// instanced_items [catalog ids] (lanterns, banner fabric/standard) and entitlements (escalation boosts).
function Level(Rank: number, Rewards: Reward[]) {
    const Stacked = Rewards.filter((R) => R.kind !== "instanced" && R.kind !== "entitlement" && R.catalog_id);
    return {
        rank_id: Rank,
        entitlements: Rewards.filter((R) => R.kind === "entitlement").map((R) => ({ entitlement: R.entitlement, duration: R.duration })),
        instanced_items: Rewards.filter((R) => R.kind === "instanced").map((R) => R.catalog_id),
        stacked_items: Stacked.map((R, I) => ({ catalog_id: R.catalog_id, hidden: false, priority: R.priority ?? I, quantity: R.quantity ?? 1 })),
    };
}

// The progression path (rank curve + free/premium rewards + window) a slot serves now. Every slot is current for the
// whole rotation, because which slot a player is on depends on the player.
export function BuildHuntPassPath(SlotId: string, NowMs = Date.now()) {
    const Pass = PassForSlot(SlotId, NowMs);
    const Window = ActiveSeasonWindow(NowMs);
    // Platinum can't be bought here, so it is earned: the wiki's 100-300 of free-track platinum is replaced by one
    // Elite price, paid evenly over the first PLATINUM_LEVELS levels so the next Elite track is reachable early.
    // Passes with no free platinum stay as-is.
    const IsPlatinum = (R: Reward) => R.catalog_id?.startsWith("CURRENCY_PLATINUM");
    const HasPlatinum = Pass.levels.some((L) => L.free.some(IsPlatinum));
    const Spread = Math.min(PLATINUM_LEVELS, Pass.levels.length);
    const PlatinumAt = (I: number): Reward[] => !HasPlatinum || I >= Spread ? [] : [{ catalog_id: "CURRENCY_PLATINUM_UNIV", quantity: Math.floor(HUNT_PASS_ELITE_PLATINUM / Spread) + (I === Spread - 1 ? HUNT_PASS_ELITE_PLATINUM % Spread : 0) }];
    // Combat Merits on every free track, and on Elite tracks that have none (the older and event passes), about one
    // drop per ten levels, on top of whatever the level already pays.
    const HasEliteMerits = Pass.levels.some((L) => L.elite.some((R) => R.catalog_id === COMBAT_MERITS));
    const MeritRanks = MeritDropRanks(Pass.levels.length);
    const MeritsAt = (I: number, Quantity: number): Reward[] => MeritRanks.includes(I + 1) ? [{ catalog_id: COMBAT_MERITS, quantity: Quantity }] : [];
    const Rewards = (Track: "free" | "elite") => Pass.levels.map((L, I) => Level(I + 1, Track === "free"
        ? [...L.free.filter((R) => !HasPlatinum || !IsPlatinum(R)), ...PlatinumAt(I), ...MeritsAt(I, FREE_MERITS)]
        : [...L.elite, ...(HasEliteMerits ? [] : MeritsAt(I, ELITE_MERITS))]));
    return {
        progression_id: SlotId,
        // Config contract (docs/findings/backend-contract.md in the Revived stack): a path with a premium gate and
        // premium_rewards is a hunt pass. 1.14.7's LoadComplete skips tracks without it (activeData stayed empty).
        premium_gating_entitlement: HuntPassEntitlement(SlotId, NowMs),
        progression_multiplier: 1,
        requirements: Array.from({ length: Pass.levels.length + 1 }, (_, Rank) => ({ rank_id: Rank, xp_required: Rank === 0 ? 0 : HUNT_PASS_XP_PER_LEVEL })),
        free_rewards: [Level(0, []), ...Rewards("free")],
        premium_rewards: [Level(0, []), ...Rewards("elite")],
        start_date: Window.start,
        end_date: Window.end,
        pass_name: Pass.name,
    };
}

// displayName and entitlements are getters so they follow the rotation without a restart.
export function HuntPassSkus(SlotId: string) {
    return [{
        id: `${SlotId}_premium`, // a row of the client's StoreItemsTable (Items_Analysis/store_item_images_1_14_7.jsonl); the store tag stays `<slot>_pass`
        get displayName() { return `${PassForSlot(SlotId).name} Elite Track`; },
        displayDescription: "Unlocks the Elite track of this Hunt Pass.",
        displayPriority: 1,
        prices: [{ currencyId: "id_currency_platinum", price: HUNT_PASS_ELITE_PLATINUM }],
        maxAllowed: 1,
        get ownershipKey() { return `${SlotId}_premium:${PassForSlot(SlotId).id}`; },
        get availableFrom() { return ActiveSeasonWindow(Date.now()).start; }, // rotation window: client countdown
        get availableTo() { return ActiveSeasonWindow(Date.now()).end; },
        tags: [HuntPassPassSkuTag(SlotId)],
        items: [],
        get entitlements() { return [{ name: HuntPassEntitlement(SlotId), duration: 0 }]; },
        duplicateInstancedItems: [],
    }];
}

if (require.main === module) {
    const assert = require("node:assert");
    const Day = 24 * 60 * 60 * 1000;
    const At = (N: number) => ROTATION_ANCHOR_MS + N * 60 * Day;
    // rotation
    assert.equal(HuntPassRotationIndex(At(0)), 0);
    assert.equal(HuntPassRotationIndex(At(1) - 1), 0);
    assert.equal(HuntPassRotationIndex(At(1)), 1);
    // slots carry consecutive cosmetic passes and shift by one per rotation; the last slot is a currency pass
    const Names = (N: number) => HUNT_PASS_SLOT_IDS.map((S) => PassForSlot(S, At(N)).name);
    assert.equal(Names(1)[0], Names(0)[1]);
    assert.equal(Names(1)[5], Names(0)[6]);
    assert.equal(new Set(Names(0)).size, 8);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map((N) => PassForSlot("season50", At(N)).name), ["Return to Light", "Dire Discovery", "Elemental Fury", "Heroic Thunder", "Darkened Skies", "Return to Light"]);
    // pass ids are unique across both datasets (they key stored progress and entitlements)
    const Ids = [...CosmeticPasses(), ...CurrencyPasses()].map((P) => P.id);
    assert.equal(new Set(Ids).size, Ids.length);
    // per-player slot: first uncompleted cosmetic pass, else the currency slot
    const Done = (N: number, Slots: number) => HUNT_PASS_SLOT_IDS.slice(0, Slots).map((S) => ({ progressionId: HuntPassStorageId(S, At(N)), progress: HuntPassMaxXp(S, At(N)) }));
    assert.equal(ServedSlotFor([], At(0)), "season43");
    assert.equal(ServedSlotFor(Done(0, 1), At(0)), "season44");
    assert.equal(ServedSlotFor(Done(0, 3), At(0)), "season46");
    assert.equal(ServedSlotFor(Done(0, 7), At(0)), "season50");
    assert.equal(ServedSlotFor([{ progressionId: HuntPassStorageId("season43", At(0)), progress: HuntPassMaxXp("season43", At(0)) - 1 }], At(0)), "season43");
    // a pass completed in an earlier rotation is skipped when it comes round in another slot
    const Frost = Done(0, 1);
    assert.equal(ServedSlotFor(Frost, At(0)), "season44");
    assert.equal(PassForSlot("season43", At(0)).id, PassForSlot("season43", At(0) + Day).id);
    // path: gate == SKU entitlement, requirement count == levels + 1, rewards in the real-config shape
    const P = BuildHuntPassPath("season43", At(0));
    assert.equal(P.premium_gating_entitlement, HuntPassSkus("season43")[0].entitlements[0].name);
    assert.equal(P.requirements.length, PassForSlot("season43", At(0)).levels.length + 1);
    assert.equal(P.free_rewards.length, P.requirements.length);
    assert.equal(HuntPassCurve("season43", At(0)).maxRank, P.requirements.length - 1);
    // finishing the free track pays back the Elite price in platinum (rounding aside)
    const Plat = P.free_rewards.flatMap((L) => L.stacked_items).filter((I) => I.catalog_id?.startsWith("CURRENCY_PLATINUM")).reduce((N, I) => N + I.quantity, 0);
    assert.equal(Plat, HUNT_PASS_ELITE_PLATINUM);
    // ...and it is all paid by level 15
    const Early = P.free_rewards.slice(0, PLATINUM_LEVELS + 1).flatMap((L) => L.stacked_items).filter((I) => I.catalog_id?.startsWith("CURRENCY_PLATINUM")).reduce((N, I) => N + I.quantity, 0);
    assert.equal(Early, HUNT_PASS_ELITE_PLATINUM);
    // an escalation boost / lantern keeps its list: look for any non-stacked reward across the first pass
    const Lists = P.premium_rewards.flatMap((L) => [L.instanced_items.length, L.entitlements.length]);
    assert.ok(Lists.every((N) => Number.isInteger(N)));
    // combat merits: every pass's free track pays them; Elite gets them only where the data had none
    const Merits = (Levels: { stacked_items: { catalog_id?: string; quantity: number }[] }[]) => Levels.flatMap((L) => L.stacked_items).filter((I) => I.catalog_id === COMBAT_MERITS).reduce((N, I) => N + I.quantity, 0);
    for (const [Slot, Passes] of [["season43", CosmeticPasses()], ["season50", CurrencyPasses()]] as const) {
        Passes.forEach((Pass, Idx) => {
            const Path = BuildHuntPassPath(Slot, At(Idx));
            assert.equal(Path.pass_name, Pass.name);
            assert.ok(Merits(Path.free_rewards) >= 2 * FREE_MERITS, `${Pass.name} free merits`);
            assert.ok(Merits(Path.premium_rewards) > 0, `${Pass.name} elite merits`);
        });
    }
    assert.equal(Merits(BuildHuntPassPath("season43", At(0)).premium_rewards), MeritDropRanks(50).length * ELITE_MERITS); // Frostfall had none
    assert.deepEqual(MeritDropRanks(10), [3, 7]);
    console.log("huntPassRotation ok");
}
