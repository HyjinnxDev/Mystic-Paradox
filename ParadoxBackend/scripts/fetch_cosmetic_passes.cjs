#!/usr/bin/env node
/*
 * fetch_cosmetic_passes.cjs - build game-data/hunt_passes_cosmetic.json from the Dauntless wiki's Hunt Pass Season,
 * Cosmetic Hunt Pass and Event Hunt Pass pages. Reward names are matched to 1.14.7 catalog ids through the
 * catalog's displayName (Items_Analysis/catalog_1_14_7.jsonl); anything that does not match is dropped and listed.
 * Needs network.
 *
 *   node scripts/fetch_cosmetic_passes.cjs                 # dry run: match report only
 *   node scripts/fetch_cosmetic_passes.cjs --apply         # writes game-data/hunt_passes_cosmetic.json
 *   node scripts/fetch_cosmetic_passes.cjs --check <wiki page> <truth config json> <progression_id>
 *       # validates the matcher against a known-good path (Revived's season09b = Rogue Elements)
 */
const fs = require("node:fs");
const path = require("node:path");

const CATALOG_FILE = path.resolve(__dirname, "../../Items_Analysis/catalog_1_14_7.jsonl");
const API = "https://dauntless.fandom.com/api.php?action=parse&prop=wikitext&format=json&page=";

// Currency-like wiki names -> catalog ids. Anything else is looked up in the catalog by display name.
const CURRENCY = {
    "rams": "CURRENCY_NOTES",
    "combat merits": "CURRENCY_PJM_WEAPON",
    "bounty tokens": "TOKEN_BOUNTY_DRAFT",
    "patrol keys": "TOKEN_DAILY_PATROL_BONUS_PURCHASED",
    "patrol chest": "TOKEN_DAILY_PATROL_BONUS_PURCHASED",
    "platinum": "CURRENCY_PLATINUM_UNIV", // promotional bucket: spent first, see platinumWallet.ts
    "aetherdust": "CURRENCY_CELLDUST",
    "transmog stone": "CURRENCY_TOKEN_TRANSMOG",
    "aethersparks": "CURRENCY_PJM_ALCHEMY",
    "patrol chests": "TOKEN_DAILY_PATROL_BONUS_PURCHASED",
    "premium bounty token": "TOKEN_BOUNTY_DRAFT_PREMIUM",
    "premium bounty tokens": "TOKEN_BOUNTY_DRAFT_PREMIUM",
    "fragments of times past": "CURRENCY_SEASON_13_PAST",
    "fragments of future times": "CURRENCY_SEASON_13_FUTURE",
    // ponytail: Exploration Merits -> airship merits is a guess; the Ostian/Orrery/Shady/Ancient seasonal coins are
    // not mapped (which CURRENCY_Sxx_COIN is which is unknown), so those rewards are dropped.
    "exploration merits": "CURRENCY_PJM_AIRSHIP",
    "steel marks": "CURRENCY_MARKS_STEEL",
    "ace chips": "CURRENCY_TOKEN_EXCHANGE_SPEED_UP",
    // display names missing from the 1.14.7 string table, so no catalog name to match
    "bronze slayer core": "Container_Core_Slayer_Bronze",
    "silver slayer core": "Container_Core_Slayer_Silver",
    "gold slayer core": "Container_Core_Slayer_Gold",
};

// wiki "(Type)" hint -> a catalog tag that must be present on the match
const HINT_TAG = { emoji: "EMOJI", emote: "EMOTE", "arrival emote": "EMOTE", title: "TITLE", dye: "DYE", fabric: "BANNERFABRIC", sigil: "BANNERSIGIL", flare: "QUICKITEM" };

const Norm = (S) => S.toLowerCase().replace(/&amp;/g, "&").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();

function LoadCatalog() {
    const Rows = fs.readFileSync(CATALOG_FILE, "utf8").split("\n").filter(Boolean).map((L) => JSON.parse(L));
    const ByName = new Map();
    ByName.tagsById = new Map(Rows.map((R) => [R.itemId, (R.tags || []).map((T) => String(T).toUpperCase())]));
    for (const R of Rows) {
        const N = Norm(R.displayName || "");
        if (!N) continue;
        if (!ByName.has(N)) ByName.set(N, []);
        ByName.get(N).push({ id: R.itemId, tags: (R.tags || []).map((T) => String(T).toUpperCase()), stackable: !!R.isStackable });
    }
    return ByName;
}

const Tokens = (Id) => Id.split("_").filter((T) => T.length > 2 && !/^\d+$/.test(T));

// Pick one catalog id for a wiki name. `Votes` is a Map of itemId tokens seen on this pass's unambiguous matches.
function Resolve(ByName, Name, Hint, Votes) {
    let Key = Norm(Name);
    let H = Hint ? Norm(Hint) : "";
    const Inner = Key.match(/^(.*?)\s*\(([^)]+)\)$/); // "Return of the Andari (Flare)"
    if (Inner && !ByName.has(Key)) { Key = Inner[1]; H = H || Norm(Inner[2]); }
    let C = ByName.get(Key) || [];
    if (H && HINT_TAG[H]) {
        const T = HINT_TAG[H];
        const F = C.filter((X) => X.tags.some((Y) => Y.includes(T)));
        if (F.length) C = F;
    } else if (!H) {
        // no hint: gear (armour, weapon, lantern, ...), so drop emotes/emojis/tokens/banner bits when others exist
        const F = C.filter((X) => !X.tags.some((Y) => /EMOJI|EMOTE|TOKEN|BANNER|TITLE|QUICKITEM/.test(Y)));
        if (F.length) C = F;
    }
    if (C.length <= 1) return { id: C[0]?.id ?? null, ambiguous: false };
    const Score = (X) => Tokens(X.id).reduce((S, T) => S + (Votes.get(T) || 0), 0);
    const Best = [...C].sort((A, B) => Score(B) - Score(A));
    return { id: Best[0].id, ambiguous: Score(Best[0]) === Score(Best[1]), candidates: C.map((X) => X.id) };
}

// One wiki cell -> [{ name, hint, qty }]
function ParseCell(Cell) {
    const Out = [];
    for (let Seg of Cell.split(/<br\s*\/?>/i)) {
        Seg = Seg.replace(/\[\[File:[^\]]*\]\]/gi, "").trim();
        if (!Seg) continue;
        const Qty = Seg.match(/\(x\s*([\d,]+)\)/i);
        const Q = Qty ? Number(Qty[1].replace(/,/g, "")) : 1;
        let M;
        if ((M = Seg.match(/\{\{IconText\|([^}|]+)(?:\|[^}]*)?\}\}\s*(?:\(([^)x][^)]*)\))?/))) Out.push({ name: M[1].trim(), hint: M[2]?.trim(), qty: Q });
        else if ((M = Seg.match(/\{\{([^}|]+?)-?\}\}/))) Out.push({ name: M[1].trim(), hint: "", qty: Q });
        else if ((M = Seg.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*(?:\(([^)x][^)]*)\))?/))) Out.push({ name: (M[2] || M[1]).trim(), hint: M[3]?.trim(), qty: Q });
        else Out.push({ name: Seg.replace(/\(x[\d,]+\)/i, "").trim(), hint: "", qty: Q, raw: true });
    }
    return Out;
}

// How the real configs hand an item out: lanterns and banner fabric/standard pieces as instanced_items (plain ids),
// everything else (armour, weapons, emotes, titles, currencies) as stacked_items.
const KindOf = (ByName, Id) => (ByName.tagsById.get(Id) || []).some((T) => T === "LANTERN" || T.includes("BANNERFABRIC") || T.includes("BANNERSTANDARD")) ? "instanced" : "stacked";

// "Escalation Boost (1d)" / "(2h)" -> the real configs' escalation_xp_boost_entitlement, duration in hours
function BoostEntitlement(Name) {
    const M = Name.match(/^escalation boost\s*\((\d+)\s*([dh])\)$/i);
    return M ? { entitlement: "escalation_xp_boost_entitlement", duration: Number(M[1]) * (M[2].toLowerCase() === "d" ? 24 : 1) } : null;
}

async function Wiki(Page) {
    const R = await fetch(API + encodeURIComponent(Page), { headers: { "User-Agent": "Mozilla/5.0" } });
    const J = await R.json();
    if (!J.parse) throw new Error(`${Page}: ${JSON.stringify(J).slice(0, 120)}`);
    return J.parse.wikitext["*"];
}

function BuildPass(Text, ByName, Report) {
    const Cells = [...Text.matchAll(/\|Lvl(\d+)(Free|Elite)=(.*)/g)].map(([, L, T, C]) => ({ level: Number(L), track: T.toLowerCase(), items: ParseCell(C) }));
    if (!Cells.length) return null;
    // pass 1: unambiguous matches vote for itemId tokens (the pass's own code, e.g. HP09B / COMMANDO)
    const Votes = new Map();
    for (const C of Cells) for (const I of C.items) {
        if (CURRENCY[Norm(I.name)]) continue;
        const C1 = ByName.get(Norm(I.name)) || [];
        if (C1.length === 1) for (const T of Tokens(C1[0].id)) Votes.set(T, (Votes.get(T) || 0) + 1);
    }
    const Levels = Array.from({ length: Math.max(...Cells.map((C) => C.level)) }, () => ({ free: [], elite: [] }));
    for (const C of Cells) {
        C.items.forEach((I, Priority) => {
            const Boost = BoostEntitlement(I.name);
            if (Boost) { Levels[C.level - 1][C.track].push({ ...Boost, kind: "entitlement" }); return; }
            let Id = CURRENCY[Norm(I.name)];
            if (!Id) {
                const R = Resolve(ByName, I.name, I.hint, Votes);
                Id = R.id;
                if (R.ambiguous) Report.ambiguous.push(`${I.name} -> ${R.candidates.join(" | ")}`);
            }
            if (!Id) { Report.unmatched.push(`${I.name}${I.hint ? ` (${I.hint})` : ""}`); return; }
            Levels[C.level - 1][C.track].push({ catalog_id: Id, quantity: I.qty, priority: Priority, kind: KindOf(ByName, Id) });
        });
    }
    return Levels;
}

(async () => {
    const ByName = LoadCatalog();
    if (process.argv[2] === "--check") {
        const [, , , Page, Truth, Id] = process.argv;
        const Levels = BuildPass(await Wiki(Page), ByName, { ambiguous: [], unmatched: [] });
        const J = JSON.parse(fs.readFileSync(Truth, "utf8"));
        const P = ((J.payload && J.payload.paths) || J.paths || J).find((X) => X.progression_id === Id);
        let Same = 0, Diff = 0;
        for (const [Track, Key] of [["free", "free_rewards"], ["elite", "premium_rewards"]]) {
            for (const R of P[Key]) {
                const Want = [...(R.stacked_items || []).map((S) => `${S.catalog_id}x${S.quantity}`), ...(R.instanced_items || []).map((I) => `${I}x1`),
                    ...(R.entitlements || []).filter((E) => E.entitlement === "escalation_xp_boost_entitlement").map((E) => `boost${E.duration}`)].sort().join(",");
                const Got = ((Levels[R.rank_id - 1] || {})[Track] || []).map((S) => S.kind === "entitlement" ? `boost${S.duration}` : `${S.catalog_id}x${S.quantity}`).sort().join(",");
                if (R.rank_id === 0) continue;
                if (Want === Got) Same++; else { Diff++; console.log(`  ${Track} L${R.rank_id}: want ${Want || "-"}  got ${Got || "-"}`); }
            }
        }
        console.log(`check ${Id}: ${Same} levels equal, ${Diff} differ`);
        return;
    }

    const Index = await Wiki("Hunt_Pass");
    const Listed = [];
    // the dated "List of ..." tables, in order (seasons, cosmetic passes, then events), are the rotation order
    for (const [, Kind, Title] of Index.slice(Index.indexOf("List of Hunt Passes")).matchAll(/\[\[((?:Hunt Pass Season|Cosmetic Hunt Pass|Event Hunt Pass)): ([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
        const Page = `${Kind}: ${Title}`;
        if (!Listed.some((L) => L.page === Page)) Listed.push({ page: Page, kind: Kind, title: Title.trim() });
    }
    console.log(`${Listed.length} cosmetic-family passes listed`);
    const Out = [];
    const Total = { unmatched: 0, ambiguous: 0, rewards: 0 };
    for (const L of Listed) {
        const Report = { unmatched: [], ambiguous: [] };
        let Levels;
        try { Levels = BuildPass(await Wiki(L.page.replace(/ /g, "_")), ByName, Report); } catch (E) { console.log(`  SKIP ${L.page}: ${E.message}`); continue; }
        if (!Levels) { console.log(`  SKIP ${L.page}: no reward table`); continue; }
        const N = Levels.reduce((S, X) => S + X.free.length + X.elite.length, 0);
        Total.rewards += N; Total.unmatched += Report.unmatched.length; Total.ambiguous += Report.ambiguous.length;
        console.log(`${L.page}: ${Levels.length} levels, ${N} rewards, ${Report.unmatched.length} unmatched, ${Report.ambiguous.length} ambiguous`);
        for (const U of Report.unmatched) console.log(`    - unmatched: ${U}`);
        for (const A of Report.ambiguous) console.log(`    - ambiguous: ${A}`);
        Out.push({ id: L.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), name: L.title, kind: L.kind, levels: Levels });
    }
    console.log(`TOTAL ${Out.length} passes, ${Total.rewards} rewards matched, ${Total.unmatched} unmatched, ${Total.ambiguous} ambiguous`);
    if (process.argv.includes("--apply")) {
        const Target = path.resolve(__dirname, "../game-data/hunt_passes_cosmetic.json");
        fs.writeFileSync(Target, JSON.stringify(Out));
        console.log(`wrote ${Target}`);
    } else console.log("dry run (pass --apply to write)");
})().catch((E) => { console.error(E); process.exit(1); });
