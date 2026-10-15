import assert from "node:assert/strict";
import test from "node:test";
import { StatusName } from "./statusWatch";

test("status channel name", () => {
    assert.equal(StatusName(null), "🔴 Offline");
    assert.equal(StatusName(1), "🟢 Online · 1 slayer");
    assert.equal(StatusName(12), "🟢 Online · 12 slayers");
});
