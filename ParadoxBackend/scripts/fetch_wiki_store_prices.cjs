#!/usr/bin/env node
/*
 * fetch_wiki_store_prices.cjs - build game-data/wiki_store_prices.json: the items the Dauntless wiki says were sold
 * on their own in the Platinum store, with that price. Read from every page using {{Platinum}}: the item infobox's
 * `ObtainedFrom` ("The [[Store]] for {{Platinum}}150"). "Previously ..." prices and bundle-only sales ("(Turtle
 * Bundle)", "(Catastrophic Style Kit)") are skipped. Page titles are matched to 1.14.7 catalog ids by displayName; a "(Flare)"-style suffix
 * picks the item type. generate_platinum_store.ts sells exactly these items at these prices. Needs network.
 *
 *   node scripts/fetch_wiki_store_prices.cjs            # dry run: match report only
 *   node scripts/fetch_wiki_store_prices.cjs --apply    # writes game-data/wiki_store_prices.json
 */
const fs = require("node:fs");
const path = require("node:path");

const CATALOG_FILE = path.resolve(__dirname, "../../Items_Analysis/catalog_1_14_7.jsonl");
const OUT_FILE = path.resolve(__dirname, "../game-data/wiki_store_prices.json");
const API = "https://dauntless.fandom.com/api.php";
// Wiki title suffix -> catalog id prefix of that item type.
const SUFFIX_PREFIX = {
    "flare": "QI_FLARE", "sigil": "BNC_SIGIL", "armour skin": "AR_", "dye": "DYE_", "emote": "EM_",
    "hunt arrival": "EM_INTRO", "arrival": "EM_INTRO", "glider": "GD_", "lantern": "LT_", "lantern skin": "LT_",
    "fabric": "BNC_FABRIC", "banner fabric": "BNC_FABRIC", "standard": "BNC_STANDARD", "banner standard": "BNC_STANDARD",
    "plant animation": "BNC_ANIMATION", "emoji": "EJ_", "title": "TITLE_",
};

async function Api(Params) {
    const Url = `${API}?${new URLSearchParams({ ...Params, format: "json" })}`;
    for (let Attempt = 0; ; Attempt++) {
        try {
            const R = await fetch(Url, { headers: { "User-Agent": "Mozilla/5.0" } });
            if (R.ok) return await R.json();
            throw new Error(`HTTP ${R.status}`);
        } catch (Err) {
            if (Attempt === 3) throw Err;
            await new Promise((Resolve) => setTimeout(Resolve, 2000));
        }
    }
}

async function Main() {
    const ByName = new Map();
    for (const Line of fs.readFileSync(CATALOG_FILE, "utf8").split("\n")) {
        if (!Line.trim()) continue;
        const Item = JSON.parse(Line);
        const Key = Item.displayName.toLowerCase();
        ByName.set(Key, [...(ByName.get(Key) ?? []), Item.itemId]);
    }

    const Titles = [];
    for (let Continue = {}; ;) {
        const D = await Api({ action: "query", list: "embeddedin", eititle: "Template:Platinum", eilimit: "500", ...Continue });
        Titles.push(...D.query.embeddedin.map((Page) => Page.title));
        if (!D.continue) break;
        Continue = { eicontinue: D.continue.eicontinue };
    }

    const Prices = {};
    const Unmatched = [];
    const Ambiguous = [];
    for (let I = 0; I < Titles.length; I += 50) {
        const D = await Api({ action: "query", prop: "revisions", rvprop: "content", rvslots: "main", titles: Titles.slice(I, I + 50).join("|") });
        for (const Page of Object.values(D.query.pages)) {
            const Text = Page.revisions?.[0]?.slots?.main?.["*"] ?? "";
            const Obtained = /\|\s*ObtainedFrom\s*=(.*)/.exec(Text)?.[1];
            if (!Obtained) continue;
            const Current = Obtained.split(/<br\s*\/?>\s*previously|previously/i)[0];
            const Sale = /\[\[Store\]\][^{]*\{\{Platinum-?\}\}\s*([\d,]+)([^<]*)/.exec(Current);
            if (!Sale || /\([^)]*\b(kit|bundle|pack)\)/i.test(Sale[2])) continue; // not sold now, or only inside a bundle
            const Price = Number(Sale[1].replace(/,/g, ""));

            const Suffixed = /^(.*?)\s*\(([^)]*)\)$/.exec(Page.title);
            const Base = Suffixed ? Suffixed[1] : Page.title;
            const Prefix = Suffixed ? SUFFIX_PREFIX[Suffixed[2].toLowerCase()] : undefined;
            const Names = [Page.title, Base, `${Base} Dye`, ...(Suffixed ? [`${Base} ${Suffixed[2]}`] : [])];
            let Ids = [...new Set(Names.flatMap((Name) => ByName.get(Name.toLowerCase()) ?? []))];
            if (Prefix) Ids = Ids.filter((Id) => Id.startsWith(Prefix));
            if (Ids.length === 0) { Unmatched.push(Page.title); continue; }
            if (Ids.length > 1 && new Set(Ids.map((Id) => Id.split("_")[0])).size > 1) { Ambiguous.push(`${Page.title}: ${Ids.join(", ")}`); continue; }
            for (const Id of Ids) Prices[Id] = { price: Price, page: Page.title };
        }
    }

    console.log(`${Titles.length} pages, ${Object.keys(Prices).length} catalog ids priced, ${Unmatched.length} not in the 1.14.7 catalog, ${Ambiguous.length} ambiguous`);
    if (Ambiguous.length) console.log(`ambiguous (skipped):\n  ${Ambiguous.join("\n  ")}`);
    if (process.argv.includes("--verbose")) console.log(`not in catalog:\n  ${Unmatched.join("\n  ")}`);
    if (process.argv.includes("--apply")) {
        const Sorted = Object.fromEntries(Object.keys(Prices).sort().map((Id) => [Id, Prices[Id]]));
        fs.writeFileSync(OUT_FILE, JSON.stringify(Sorted, null, 2) + "\n");
        console.log(`wrote ${OUT_FILE}`);
    }
}

Main().catch((Err) => { console.error(Err); process.exit(1); });
