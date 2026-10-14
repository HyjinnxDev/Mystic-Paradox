// Staff dashboard. Every rule here is enforced again server-side (src/security/staffRoles.ts);
// the page only hides buttons a role can't use. All player text goes through textContent.
"use strict";

const RANK = { moderator: 1, admin: 2, owner: 3 };
const rank = (roles) => Math.max(0, ...roles.map((r) => RANK[r] || 0));
const MOD_MAX_HOURS = 168;
const BAN_LENGTHS = [[1, "1 hour"], [24, "1 day"], [72, "3 days"], [168, "7 days"], [720, "30 days"], [0, "Permanent"]];

let csrf = "";
let me = null;
let playerPage = 1;
let auditPage = 1;
const names = new Map(); // userId -> displayName, filled from every list we load

const $ = (id) => document.getElementById(id);
function el(tag, text, cls) {
    const e = document.createElement(tag);
    if (text != undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
}
function btn(text, onClick, cls = "btn") {
    const b = el("button", text, cls);
    b.addEventListener("click", onClick);
    return b;
}
const when = (iso) => (iso ? iso.replace("T", " ").slice(0, 16) : "—");

async function api(method, path, body) {
    const res = await fetch(`/admin/v1${path}`, {
        method,
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "X-CSRF-Token": csrf }) },
        body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { showLogin(); throw new Error("Signed out."); }
    if (!res.ok) throw new Error(data.error?.message || `Request failed (${res.status}).`);
    return data;
}
function fail(e) { $("err").textContent = e.message; }

// ---- sign-in ----
function showLogin(msg) {
    $("app").classList.add("hidden");
    $("login").classList.remove("hidden");
    $("l-err").textContent = msg || "";
}
function enter(data) {
    csrf = data.csrfToken;
    me = data.account;
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    const role = ["", "moderator", "admin", "owner"][rank(me.roles)];
    $("me").textContent = `${me.displayName} · ${role}`;
    loadPlayers();
}
$("l-go").addEventListener("click", async () => {
    try {
        enter(await api("POST", "/auth/login", {
            email: $("l-user").value, password: $("l-pass").value, totp: $("l-totp").value || undefined
        }));
    } catch (e) { $("l-err").textContent = e.message; }
});
$("l-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") $("l-go").click(); });
$("logout").addEventListener("click", async () => { await api("POST", "/auth/logout").catch(() => {}); showLogin(); });

// ---- tabs ----
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
    for (const t of ["players", "online", "audit"]) $(`tab-${t}`).classList.toggle("hidden", t !== b.dataset.tab);
    $("actions").classList.add("hidden");
    $("err").textContent = "";
    ({ players: loadPlayers, online: loadOnline, audit: loadAudit })[b.dataset.tab]();
}));

// ---- players ----
function statusTags(a) {
    const out = [];
    if (a.status === "banned" && a.banActive) out.push(el("span", a.bannedUntil ? `banned until ${when(a.bannedUntil)}` : "banned", "tag bad"));
    else if (a.status === "banned") out.push(el("span", "ban expired", "tag"));
    else if (a.status === "disabled") out.push(el("span", "disabled", "tag bad"));
    else out.push(el("span", "active", "tag ok"));
    if (a.approvalStatus !== "approved") out.push(el("span", a.approvalStatus, "tag warn"));
    return out;
}
async function loadPlayers() {
    try {
        const q = new URLSearchParams({ page: String(playerPage), limit: "50" });
        if ($("p-search").value.trim()) q.set("search", $("p-search").value.trim());
        if ($("p-status").value) q.set("status", $("p-status").value);
        if ($("p-approval").value) q.set("approvalStatus", $("p-approval").value);
        const data = await api("GET", `/players?${q}`);
        const rows = $("p-rows");
        rows.replaceChildren();
        for (const a of data.accounts) {
            names.set(a.userId, a.displayName);
            const tr = el("tr", null, "pick");
            tr.append(el("td", a.displayName));
            const st = el("td"); st.append(...statusTags(a)); tr.append(st);
            const ro = el("td"); for (const r of a.roles.filter((r) => r !== "player")) ro.append(el("span", r, "tag")); tr.append(ro);
            tr.append(el("td", when(a.lastLoginAt), "hide-sm dim"));
            tr.addEventListener("click", () => openPlayer(a));
            rows.append(tr);
        }
        $("p-count").textContent = `${data.total} players · page ${data.page}`;
        $("p-prev").disabled = playerPage <= 1;
        $("p-next").disabled = playerPage * data.limit >= data.total;
    } catch (e) { fail(e); }
}
$("p-go").addEventListener("click", () => { playerPage = 1; loadPlayers(); });
$("p-search").addEventListener("keydown", (e) => { if (e.key === "Enter") $("p-go").click(); });
$("p-prev").addEventListener("click", () => { playerPage--; loadPlayers(); });
$("p-next").addEventListener("click", () => { playerPage++; loadPlayers(); });

// ---- player actions ----
function reasonBox(placeholder) {
    const t = el("textarea");
    t.placeholder = placeholder;
    return t;
}
async function openPlayer(a) {
    const box = $("actions");
    box.replaceChildren();
    box.classList.remove("hidden");
    const myRank = rank(me.roles);
    const canAct = a.userId !== me.userId && myRank > rank(a.roles);

    box.append(el("h2", a.displayName));
    const info = el("div", null, "row"); info.append(...statusTags(a));
    info.append(el("span", `joined ${when(a.createdAt)} · last login ${when(a.lastLoginAt)}`, "dim"));
    box.append(info);
    if (a.approvalReason) box.append(el("div", `Last access note: ${a.approvalReason}`, "dim"));
    box.append(btn("Close", () => box.classList.add("hidden")));

    const done = async (p) => {
        try { await p; await loadPlayers(); box.classList.add("hidden"); $("err").textContent = ""; }
        catch (e) { fail(e); }
    };

    if (!canAct) {
        box.append(el("p", a.userId === me.userId ? "This is you." : "Staff at or above your role can only be changed by someone higher.", "dim"));
    } else {
        // Ban
        box.append(el("h3", "Ban"));
        const len = el("select");
        for (const [h, label] of BAN_LENGTHS) {
            if (myRank < 2 && (h === 0 || h > MOD_MAX_HOURS)) continue;
            const o = el("option", label); o.value = String(h); len.append(o);
        }
        const why = reasonBox("Reason (required, shown in the audit log)");
        box.append(why);
        const row = el("div", null, "row");
        row.append(len, btn("Ban", () => {
            const h = Number(len.value);
            done(api("PATCH", `/players/${a.userId}/access`,
                { status: "banned", reason: why.value, ...(h ? { durationHours: h } : {}) }));
        }, "btn danger"));
        box.append(row);
        box.append(el("div", "Kicks them from chat and voice now. They stay in their current map until they travel, then can't get back in.", "dim"));

        if (myRank >= 2) {
            box.append(el("h3", "Access (admin)"));
            const why2 = reasonBox("Reason (required)");
            box.append(why2);
            const r2 = el("div", null, "row");
            const access = (body) => () => done(api("PATCH", `/players/${a.userId}/access`, { ...body, reason: why2.value }));
            if (a.status !== "active" || a.banActive) r2.append(btn("Unban / re-enable", access({ status: "active" })));
            if (a.status !== "disabled") r2.append(btn("Disable", access({ status: "disabled" }), "btn danger"));
            if (a.approvalStatus !== "approved") r2.append(btn("Approve sign-up", access({ approvalStatus: "approved" })));
            if (a.approvalStatus === "pending") r2.append(btn("Reject sign-up", access({ approvalStatus: "rejected" }), "btn danger"));
            box.append(r2);
        }

        if (myRank >= 3) {
            box.append(el("h3", "Roles (owner)"));
            const r3 = el("div", null, "row");
            const checks = {};
            for (const role of ["moderator", "admin", "tester"]) {
                const lab = el("label");
                const c = el("input"); c.type = "checkbox"; c.checked = a.roles.includes(role);
                checks[role] = c;
                lab.append(c, document.createTextNode(` ${role} `));
                r3.append(lab);
            }
            r3.append(btn("Save roles", () => done(api("PATCH", `/players/${a.userId}/roles`, {
                roles: Object.keys(checks).filter((r) => checks[r].checked), reason: "set from dashboard"
            }))));
            box.append(r3);

            box.append(el("h3", "Delete account (owner)"));
            const conf = el("input"); conf.placeholder = `Type: DELETE ${a.displayName}`;
            const why3 = el("input"); why3.placeholder = "Reason";
            const r4 = el("div", null, "row");
            r4.append(conf, why3, btn("Delete permanently", () => done(api("DELETE", `/players/${a.userId}`,
                { confirmation: conf.value, reason: why3.value })), "btn danger"));
            box.append(r4);
        }
    }

    // Recent history for this player
    box.append(el("h3", "History"));
    try {
        const h = await api("GET", `/audit?targetUserId=${encodeURIComponent(a.userId)}&limit=10`);
        if (h.records.length === 0) box.append(el("div", "No staff actions yet.", "dim"));
        for (const r of h.records) box.append(el("div", `${when(r.createdAt)} · ${names.get(r.actorUserId) || r.actorUserId} · ${describe(r)}${r.reason ? ` — ${r.reason}` : ""}`));
    } catch (e) { box.append(el("div", e.message, "err")); }
    box.scrollIntoView({ behavior: "smooth" });
}

// ---- online ----
async function loadOnline() {
    try {
        const data = await api("GET", "/online-players");
        $("o-count").textContent = `${data.count} online (chat connections)`;
        const rows = $("o-rows");
        rows.replaceChildren();
        for (const p of data.players) {
            names.set(p.userId, p.displayName);
            const tr = el("tr", null, "pick");
            tr.append(el("td", p.displayName));
            tr.addEventListener("click", async () => {
                // online list only has id + name; fetch the full record to open actions
                const found = await api("GET", `/players?search=${encodeURIComponent(p.displayName)}&limit=100`).catch(fail);
                const a = found?.accounts.find((x) => x.userId === p.userId);
                if (a) openPlayer(a);
            });
            rows.append(tr);
        }
    } catch (e) { fail(e); }
}
$("o-go").addEventListener("click", loadOnline);

// ---- audit ----
function describe(r) {
    const o = r.oldState || {}, n = r.newState || {};
    switch (r.action) {
        case "player.access.update": {
            const parts = [];
            if (o.status !== n.status || o.bannedUntil !== n.bannedUntil)
                parts.push(n.status === "banned" ? (n.bannedUntil ? `banned until ${when(n.bannedUntil)}` : "banned permanently") : `status → ${n.status}`);
            if (o.approvalStatus !== n.approvalStatus) parts.push(`approval → ${n.approvalStatus}`);
            return parts.join(", ") || "access unchanged";
        }
        case "player.roles.update": return `roles → ${(n.roles || []).join(", ")}`;
        case "player.account.delete": return "deleted account";
        default: return r.action;
    }
}
async function loadAudit() {
    try {
        const data = await api("GET", `/audit?page=${auditPage}&limit=50`);
        const rows = $("a-rows");
        rows.replaceChildren();
        for (const r of data.records) {
            const tr = el("tr");
            tr.append(el("td", when(r.createdAt), "dim"),
                el("td", names.get(r.actorUserId) || r.actorUserId),
                el("td", names.get(r.targetUserId) || r.targetUserId || "—"),
                el("td", describe(r)),
                el("td", r.reason || ""));
            rows.append(tr);
        }
        $("a-prev").disabled = auditPage <= 1;
        $("a-next").disabled = auditPage * data.limit >= data.total;
    } catch (e) { fail(e); }
}
$("a-go").addEventListener("click", loadAudit);
$("a-prev").addEventListener("click", () => { auditPage--; loadAudit(); });
$("a-next").addEventListener("click", () => { auditPage++; loadAudit(); });

// ---- boot ----
const discordError = new URLSearchParams(location.search).get("error");
api("GET", "/me").then(enter).catch(() => showLogin(discordError ? `Discord sign-in failed: ${discordError}` : ""));
