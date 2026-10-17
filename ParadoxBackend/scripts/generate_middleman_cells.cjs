// Writes game-data/middleman_cells.json: the cell families the Middleman's weekly offers rotate through
// (controllers/store.ts WeeklyCellSkus). The Middleman sells +1 cells only (wiki: The Middleman), so a family
// qualifies when the 1.14.7 catalog has its +1 (_UC) cell, tagged as a normal drop-table cell, with a real name.
//   node scripts/generate_middleman_cells.cjs
const fs = require("node:fs");
const path = require("node:path");

const Catalog = path.resolve(__dirname, "../../Items_Analysis/catalog_1_14_7.jsonl");
const Families = [];
for (const Line of fs.readFileSync(Catalog, "utf8").split("\n")) {
    if (!Line.trim()) continue;
    const Item = JSON.parse(Line);
    const Family = /^CELL_(.+)_UC$/.exec(Item.itemId)?.[1];
    if (Family && JSON.stringify(Item.tags) === '["Cell","CELL"]' && /^\+1 /.test(Item.displayName)) Families.push({ id: Family, name: Item.displayName });
}
Families.sort((A, B) => A.id.localeCompare(B.id));
fs.writeFileSync(path.resolve(__dirname, "../game-data/middleman_cells.json"), JSON.stringify({ families: Families }, null, 2) + "\n");
console.log(`${Families.length} families`);
