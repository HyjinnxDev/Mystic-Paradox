// Staff console. Every rule here is enforced again server-side (src/security/staffRoles.ts);
// the page only hides buttons a role can't use. All player text goes through textContent.
"use strict";

const RANK = { moderator: 1, admin: 2, owner: 3 };
const rank = (roles) => Math.max(0, ...roles.map((r) => RANK[r] || 0));
const MOD_MAX_HOURS = 168;
const BAN_LENGTHS = [[1, "1 hour"], [24, "1 day"], [72, "3 days"], [168, "7 days"], [720, "30 days"], [0, "Permanent"]];

let csrf = "";
let me = null;
let myRank = 0;
const names = new Map(); // userId -> displayName, filled from every list we load

// ---------- tiny DOM helpers ----------
const $ = (id) => document.getElementById(id);
function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
        if (v == null || v === false) continue;
        if (k === "class") e.className = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat(Infinity)) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
}
function svg(tag, attrs) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    return e;
}
const btn = (text, onclick, cls = "btn", extra = {}) => h("button", { class: cls, onclick, ...extra }, text);

// ---------- formatting ----------
const GB = 1024 ** 3;
const bytes = (n) => n == null ? "—" : n >= 1024 * GB ? `${(n / 1024 / GB).toFixed(2)} TB` : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
function dur(sec) {
    if (sec == null || !isFinite(sec)) return "—";
    sec = Math.max(0, Math.floor(sec));
    const d = Math.floor(sec / 86400), hr = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d ? `${d}d ${hr}h` : hr ? `${hr}h ${m}m` : m ? `${m}m` : `${sec}s`;
}
const since = (iso) => iso ? dur((Date.now() - Date.parse(iso)) / 1000) : "—";
const ago = (iso) => iso ? `${since(iso)} ago` : "never";
const when = (iso) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
const clock = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
function prettyAsset(p) {
    if (!p) return "";
    const last = p.split("/").pop().split(".")[0];
    return titleCase(last.replace(/^(BP|Hunt|Behemoth)_/i, "").replace(/_(C|persistent|01)$/i, "").replace(/_(persistent)$/i, "").replace(/_/g, " "));
}
function serverName(s) {
    if (s.kind === "ramsgate") return "Ramsgate";
    if (s.kind === "dojo") return "Training Dojo";
    return prettyAsset(s.behemoth) || prettyAsset(s.map) || s.matchmakerHuntId || "Hunt";
}
const currencyName = (id) => titleCase(id.replace(/^CURRENCY_/, "").replace(/_/g, " "));

// ---------- API ----------
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
function clearErr() { $("err").textContent = ""; }

// ---------- confirm dialog ----------
function confirmAction({ title, body, ok, typeText }) {
    const d = $("confirm");
    $("c-title").textContent = title;
    $("c-body").textContent = body;
    $("c-ok").textContent = ok;
    $("c-reason").value = "";
    $("c-err").textContent = "";
    $("c-type").classList.toggle("hidden", !typeText);
    $("c-type").value = "";
    $("c-type").placeholder = typeText ? `Type ${typeText} to confirm` : "";
    d.showModal();
    return new Promise((resolve) => {
        const done = (v) => { d.close(); $("c-ok").onclick = $("c-cancel").onclick = d.oncancel = null; resolve(v); };
        $("c-cancel").onclick = () => done(null);
        d.oncancel = () => done(null);
        $("c-ok").onclick = () => {
            const reason = $("c-reason").value.trim();
            if (reason.length < 3) { $("c-err").textContent = "Give a reason of at least 3 characters."; return; }
            if (typeText && $("c-type").value !== typeText) { $("c-err").textContent = `Type ${typeText} exactly.`; return; }
            done(reason);
        };
    });
}

// ---------- sign-in ----------
function showLogin(msg) {
    stopPolling();
    $("app").classList.add("hidden");
    $("login").classList.remove("hidden");
    $("l-err").textContent = msg || "";
}
function enter(data) {
    csrf = data.csrfToken;
    me = data.account;
    myRank = rank(me.roles);
    $("login").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("me-name").textContent = me.displayName;
    $("me-role").textContent = ["", "Moderator", "Admin", "Owner"][myRank];
    buildNav();
    go(location.hash.slice(1) || "overview");
}
$("l-go").addEventListener("click", async () => {
    try {
        enter(await api("POST", "/auth/login", {
            email: $("l-user").value, password: $("l-pass").value, totp: $("l-totp").value || undefined
        }));
    } catch (e) { $("l-err").textContent = e.message; }
});
for (const id of ["l-pass", "l-totp"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") $("l-go").click(); });
$("logout").addEventListener("click", async () => { await api("POST", "/auth/logout").catch(() => {}); showLogin(); });

// ---------- navigation + polling ----------
const PAGES = [
    { id: "overview", label: "Overview", min: 1, render: renderOverview },
    { id: "servers", label: "Servers", min: 1, render: renderServers },
    { id: "players", label: "Players", min: 1, render: renderPlayers },
    { id: "online", label: "Online now", min: 1, render: renderOnline },
    { id: "audit", label: "Audit log", min: 1, render: renderAudit },
    { id: "logs", label: "Logs", min: 2, render: renderLogs },
    { id: "launcher", label: "Launcher card", min: 3, render: renderLauncherCard }
];
let timers = [];
function stopPolling() { timers.forEach(clearInterval); timers = []; }
function poll(fn, ms) {
    fn();
    timers.push(setInterval(() => { if (document.visibilityState === "visible") fn(); }, ms));
}
function buildNav() {
    $("nav").replaceChildren(...PAGES.filter((p) => myRank >= p.min).map((p) =>
        h("button", { "data-page": p.id, onclick: () => go(p.id) }, h("span", null, p.label), h("span", { class: "count", id: `count-${p.id}` }))));
}
function go(id) {
    const page = PAGES.find((p) => p.id === id && myRank >= p.min) || PAGES[0];
    history.replaceState(null, "", `#${page.id}`);
    document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.page === page.id));
    stopPolling();
    window.onresize = null;
    clearErr();
    closeDrawer();
    $("page").replaceChildren();
    page.render($("page"));
}
const head = (title, ...right) => h("div", { class: "page-head" }, h("h1", null, title), h("div", { class: "grow" }), ...right);

// ---------- charts ----------
function lineChart(samples, key, { label, fmt, max }) {
    const box = h("div", { class: "chart" });
    const last = samples.at(-1);
    box.append(h("div", { class: "cap" }, h("b", null, label), h("span", { class: "dim" }, last ? fmt(last[key]) : "")));
    if (samples.length < 2) {
        box.append(h("div", { class: "empty" }, "Collecting data. The first points show up within a minute of a backend start."));
        return box;
    }
    const plot = h("div", { style: "position:relative" });
    box.append(plot);
    // Drawn at the element's real pixel width (no viewBox stretching, so the axis text stays crisp).
    box.draw = () => {
    const W = Math.max(200, plot.clientWidth), H = 150, L = 34, B = 18, T = 6;
    const top = max ?? Math.max(4, Math.ceil(Math.max(...samples.map((s) => s[key])) * 1.2));
    const t0 = samples[0].t, t1 = samples.at(-1).t;
    const x = (t) => L + (W - L) * (t - t0) / Math.max(1, t1 - t0);
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const s = svg("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${label} over time` });
    for (const f of [0, .5, 1]) {
        s.append(svg("line", { class: "gl", x1: L, x2: W, y1: y(top * f), y2: y(top * f) }));
        const t = svg("text", { class: "ax", x: L - 6, y: y(top * f) + 4, "text-anchor": "end" });
        t.textContent = max === 100 ? `${Math.round(top * f)}%` : Math.round(top * f);
        s.append(t);
    }
    for (const [t, anchor] of [[t0, "start"], [t1, "end"]]) {
        const tx = svg("text", { class: "ax", x: x(t), y: H - 2, "text-anchor": anchor });
        tx.textContent = clock(t);
        s.append(tx);
    }
    const pts = samples.map((p) => `${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`);
    s.append(svg("path", { class: "area", d: `M${x(t0)},${y(0)} L${pts.join(" L")} L${x(t1)},${y(0)} Z` }));
    s.append(svg("path", { class: "ln", d: `M${pts.join(" L")}`, "vector-effect": "non-scaling-stroke" }));
    const cross = svg("line", { class: "cross", y1: T, y2: H - B, "vector-effect": "non-scaling-stroke", visibility: "hidden" });
    s.append(cross);
    const tip = h("div", { class: "tip hidden" });
    s.addEventListener("pointermove", (e) => {
        const r = s.getBoundingClientRect();
        const vx = e.clientX - r.left;
        const t = t0 + (vx - L) / (W - L) * (t1 - t0);
        let best = samples[0];
        for (const p of samples) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
        cross.setAttribute("x1", x(best.t)); cross.setAttribute("x2", x(best.t)); cross.setAttribute("visibility", "visible");
        tip.replaceChildren(h("span", { class: "dim" }, `${clock(best.t)}  `), fmt(best[key]));
        tip.style.left = `${x(best.t)}px`;
        tip.classList.remove("hidden");
    });
    s.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.classList.add("hidden"); });
    plot.replaceChildren(s, tip);
    };
    return box;
}

// ---------- overview ----------
let historyMinutes = 60;
function svcCard(name, state, stateText, meta) {
    return h("div", { class: `svc ${state}` }, h("div", { class: "name" }, name),
        h("div", { class: "state" }, h("span", { class: "dot" }), stateText), h("div", { class: "meta" }, meta || ""));
}
function hubCard(name, servers, kind) {
    const s = servers.find((x) => x.kind === kind);
    if (!s) return svcCard(name, "down", "Not running", "The Director restarts it automatically");
    if (s.state === "ready") return svcCard(name, "up", "Running", `Up ${since(s.readyTime || s.startTime)}`);
    return svcCard(name, "warn", s.state === "starting" ? "Starting" : "Failed", `Port ${s.port}`);
}
function stat(label, value, sub, meterPct) {
    const m = meterPct == null ? null : h("div", { class: "meter" },
        h("i", { class: meterPct > 90 ? "bad" : meterPct > 75 ? "warn" : "", style: `width:${Math.min(100, meterPct)}%` }));
    return h("div", { class: "panel stat" }, h("div", { class: "l" }, label), h("div", { class: "v" }, value), m, sub ? h("div", { class: "s" }, sub) : null);
}
function servicesStrip(o) {
    const mongo = o.processes.find((p) => p.role === "mongodb");
    return h("div", { class: "strip" },
        svcCard("Backend", "up", "Running", `Up ${dur(o.backend.uptime)}, ${bytes(o.backend.memory)}`),
        o.director.reachable ? svcCard("Director", "up", "Running", `Up ${since(o.director.startedAt)}`) : svcCard("Director", "down", "Unreachable", "Matchmaking and game servers are down"),
        svcCard("Database", "up", "Running", mongo ? `${bytes(mongo.memory)} in use` : "Responding"),
        hubCard("Ramsgate", o.gameservers, "ramsgate"),
        hubCard("Training Dojo", o.gameservers, "dojo"));
}
function renderOverview(root) {
    const strip = h("div"), stats = h("div", { class: "grid g4" }), host = h("div", { class: "grid g4" }), charts = h("div", { class: "grid g3" });
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Chart range" });
    for (const [m, l] of [[60, "1 hour"], [360, "6 hours"], [1440, "24 hours"]])
        seg.append(h("button", { class: m === historyMinutes ? "on" : "", onclick: (e) => { historyMinutes = m; [...seg.children].forEach((b) => b.classList.toggle("on", b === e.target)); loadHistory(); } }, l));
    root.append(head("Overview"), h("div", { class: "stack" }, strip, stats, host,
        h("div", { class: "panel" }, h("div", { class: "page-head", style: "margin-bottom:12px" }, h("h2", null, "Trends"), h("div", { class: "grow" }), seg), charts),
        h("p", { class: "faint" }, "Trend history lives in backend memory, so it starts over when the backend restarts.")));

    const drawCharts = () => [...charts.children].forEach((c) => c.draw?.());
    window.onresize = drawCharts;
    async function loadHistory() {
        try {
            const { samples } = await api("GET", `/servers/history?minutes=${historyMinutes}`);
            charts.replaceChildren(
                lineChart(samples, "players", { label: "Players online", fmt: (v) => `${v} online` }),
                lineChart(samples, "cpu", { label: "Host CPU", fmt: (v) => `${Math.round(v)}%`, max: 100 }),
                lineChart(samples, "mem", { label: "Host memory", fmt: (v) => `${Math.round(v)}%`, max: 100 }));
            drawCharts();
        } catch (e) { fail(e); }
    }
    poll(async () => {
        try {
            const o = await api("GET", "/servers/overview");
            clearErr();
            const hunts = o.gameservers.filter((s) => s.kind === "hunt").length;
            strip.replaceChildren(servicesStrip(o));
            stats.replaceChildren(
                stat("Players online", o.players.online, `${o.players.accounts} accounts in total`),
                stat("Hunts running", `${hunts} / ${o.director.huntCap ?? "?"}`, "Dedicated hunt servers in use", o.director.huntCap ? 100 * hunts / o.director.huntCap : null),
                stat("New accounts", o.players.new24h, "In the last 24 hours"),
                stat("Needs attention", o.players.pending, `${o.players.pending === 1 ? "sign-up" : "sign-ups"} waiting, ${o.players.banned} active ${o.players.banned === 1 ? "ban" : "bans"}`));
            const memUsed = o.host.memTotal - o.host.memFree;
            const disk = o.host.disk;
            host.replaceChildren(
                stat("CPU", `${o.host.cpu}%`, `${o.host.cores} threads, ${o.host.cpuModel || ""}`.trim(), o.host.cpu),
                stat("Memory", bytes(memUsed), `of ${bytes(o.host.memTotal)}`, 100 * memUsed / o.host.memTotal),
                disk ? stat(`Disk ${disk.path}`, bytes(disk.total - disk.free), `${bytes(disk.free)} free of ${bytes(disk.total)}`, 100 * (1 - disk.free / disk.total)) : stat("Disk", "—"),
                stat("Host uptime", dur(o.host.uptime), o.host.hostname));
            const c = $("count-online"); if (c) c.textContent = o.players.online || "";
        } catch (e) { fail(e); }
    }, 5000);
    loadHistory();
    timers.push(setInterval(() => { if (document.visibilityState === "visible") loadHistory(); }, 30000));
}

// ---------- servers ----------
const ROLE_LABEL = { backend: "Backend", director: "Director", mongodb: "MongoDB", gameserver: "Game server" };
function renderServers(root) {
    const canControl = myRank >= 2;
    const control = h("div"), procs = h("div", { class: "panel flush" }), games = h("div", { class: "panel flush" });
    root.append(head("Servers"), h("div", { class: "stack" }, control, h("h2", null, "Game servers"), games, h("h2", null, "Processes"), procs));

    let lastControl;
    poll(async () => {
        try {
            const o = await api("GET", "/servers/overview");
            clearErr();
            const byId = new Map(o.gameservers.map((s) => [s.id, s]));
            if (canControl && JSON.stringify(o.control) !== lastControl) {
                lastControl = JSON.stringify(o.control);
                control.replaceChildren(h("div", { class: "panel" },
                    h("h2", null, "Restart"),
                    h("div", { class: "grid g2" },
                        h("div", null, btn("Restart Director", () => restart("director"), "btn danger", { disabled: !o.control.restart }),
                            h("p", { class: "dim" }, "Stops every game server and starts the Director again. Everyone in Ramsgate or a hunt disconnects; chat and the launcher stay up. Takes about a minute.")),
                        h("div", null, btn("Restart everything", () => restart("stack"), "btn danger", { disabled: !o.control.restart }),
                            h("p", { class: "dim" }, "Restarts the backend, the Director and every game server, picking up new code and .env changes. This page goes offline for up to a few minutes."))),
                    o.control.restartWhyNot ? h("p", { class: "err" }, o.control.restartWhyNot) : null));
            }
            games.replaceChildren(table(["Server", "State", "Port", "Players", "Up for", "CPU", "Memory", canControl ? "" : null],
                o.gameservers.map((s) => {
                    const p = o.processes.find((x) => x.gameserverId === s.id);
                    const hub = s.kind !== "hunt";
                    return [
                        h("div", null, h("div", null, serverName(s)), s.kind === "hunt" ? h("div", { class: "faint" }, prettyAsset(s.map)) : null),
                        h("span", { class: `tag ${s.state === "ready" ? "ok" : s.state === "starting" ? "warn" : "bad"}` }, s.state === "ready" ? "Running" : titleCase(s.state)),
                        s.port, hub ? "—" : s.expectedPlayers.length, since(s.readyTime || s.startTime),
                        p?.cpu != null ? `${p.cpu}%` : "—", bytes(p?.memory),
                        canControl ? h("div", { class: "row", style: "justify-content:flex-end;margin:0" },
                            btn("Log", () => openServerLog(byId.get(s.id)), "btn small"),
                            btn(hub ? "Restart" : "Stop", () => stopServer(s), "btn small danger")) : null
                    ];
                }), o.director.reachable ? "No game servers running." : "The Director isn't answering, so there are no game servers to show."));
            procs.replaceChildren(table(["Process", "PID", "CPU", "Memory", "Up for"],
                o.processes.map((p) => [
                    p.role === "gameserver" ? `Game server (${serverName(byId.get(p.gameserverId) || {})})` : p.label || ROLE_LABEL[p.role],
                    p.pid, p.cpu != null ? `${p.cpu}%` : "measuring…", bytes(p.memory), since(p.startedAt)
                ]), "Process details are only available on a Windows host."));
        } catch (e) { fail(e); }
    }, 5000);

    async function restart(target) {
        const what = target === "stack" ? "everything" : "the Director";
        const reason = await confirmAction({
            title: `Restart ${what}?`,
            body: target === "stack" ? "Every player disconnects and this console goes offline until the backend is back." : "Every player in Ramsgate or a hunt disconnects.",
            ok: `Restart ${what}`, typeText: "RESTART"
        });
        if (!reason) return;
        try { await api("POST", "/servers/restart", { target, reason }); $("err").textContent = target === "stack" ? "Restart started. This page reconnects once the backend is back." : "Director restart started."; }
        catch (e) { fail(e); }
    }
    async function stopServer(s) {
        const hub = s.kind !== "hunt";
        const reason = await confirmAction({
            title: hub ? `Restart ${serverName(s)}?` : `Stop the ${serverName(s)} hunt?`,
            body: hub ? "Everyone on it disconnects. The Director starts a fresh one right away." : `The ${s.expectedPlayers.length} player(s) in this hunt lose it and go back to Ramsgate.`,
            ok: hub ? "Restart" : "Stop hunt"
        });
        if (!reason) return;
        try { await api("POST", `/servers/gameservers/${encodeURIComponent(s.id)}/stop`, { reason }); }
        catch (e) { fail(e); }
    }
}
function table(cols, rows, emptyText) {
    if (rows.length === 0) return h("div", { class: "empty" }, emptyText);
    const keep = cols.map((c) => c !== null);
    return h("div", { class: "table-wrap" }, h("table", null,
        h("thead", null, h("tr", null, cols.filter((c, i) => keep[i]).map((c) => h("th", null, c)))),
        h("tbody", null, rows.map((r) => h("tr", null, r.filter((c, i) => keep[i]).map((c) => h("td", null, c)))))));
}
async function openServerLog(s) {
    const pre = h("pre", { class: "log" }, "Loading…");
    openDrawer(h("h1", null, `${serverName(s)} log`), h("p", { class: "dim" }, `Port ${s.port}, last 256 KB`), pre);
    try { fillLog(pre, (await api("GET", `/servers/gameservers/${encodeURIComponent(s.id)}/log`)).text, ""); pre.scrollTop = pre.scrollHeight; }
    catch (e) { pre.textContent = e.message; }
}
function fillLog(pre, text, filter) {
    const lines = text.split("\n").filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase())).slice(-3000);
    pre.replaceChildren(...lines.map((l) => h("span", { class: /error|fatal|exception|crash/i.test(l) ? "e" : /warn/i.test(l) ? "w" : null }, l + "\n")));
}

// ---------- players ----------
function statusTags(a) {
    const out = [];
    if (a.status === "banned" && a.banActive) out.push(h("span", { class: "tag bad" }, a.bannedUntil ? `Banned until ${when(a.bannedUntil)}` : "Banned"));
    else if (a.status === "banned") out.push(h("span", { class: "tag" }, "Ban expired"));
    else if (a.status === "disabled") out.push(h("span", { class: "tag bad" }, "Disabled"));
    else out.push(h("span", { class: "tag ok" }, "Active"));
    if (a.approvalStatus !== "approved") out.push(h("span", { class: "tag warn" }, titleCase(a.approvalStatus)));
    return out;
}
const roleTags = (roles) => roles.filter((r) => r !== "player" && !(r === "admin" && roles.includes("owner")))
    .map((r) => h("span", { class: `tag ${r}` }, titleCase(r)));

let playerPage = 1;
function renderPlayers(root) {
    const search = h("input", { placeholder: "Search name or email", type: "search" });
    const status = h("select", null, h("option", { value: "" }, "Any status"), ["active", "banned", "disabled"].map((s) => h("option", { value: s }, titleCase(s))));
    const approval = h("select", null, h("option", { value: "" }, "Any approval"), ["pending", "approved", "rejected"].map((s) => h("option", { value: s }, titleCase(s))));
    const count = h("span", { class: "dim" });
    const list = h("div", { class: "panel flush" });
    const prev = btn("Previous", () => { playerPage--; load(); }), next = btn("Next", () => { playerPage++; load(); });
    const reset = () => { playerPage = 1; load(); };
    search.addEventListener("keydown", (e) => { if (e.key === "Enter") reset(); });
    status.addEventListener("change", reset); approval.addEventListener("change", reset);
    root.append(head("Players"), h("div", { class: "row" }, search, status, approval, btn("Search", reset, "btn primary"), count), list, h("div", { class: "row" }, prev, next));

    async function load() {
        try {
            const q = new URLSearchParams({ page: String(playerPage), limit: "50" });
            if (search.value.trim()) q.set("search", search.value.trim());
            if (status.value) q.set("status", status.value);
            if (approval.value) q.set("approvalStatus", approval.value);
            const data = await api("GET", `/players?${q}`);
            list.replaceChildren(data.accounts.length === 0 ? h("div", { class: "empty" }, "No players match these filters.") :
                h("div", { class: "table-wrap" }, h("table", null,
                    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Status"), h("th", null, "Roles"), h("th", { class: "hide-sm" }, "Joined"), h("th", { class: "hide-sm" }, "Last seen"))),
                    h("tbody", null, data.accounts.map((a) => {
                        names.set(a.userId, a.displayName);
                        return h("tr", { class: "pick", tabindex: 0, onclick: () => openPlayer(a), onkeydown: (e) => { if (e.key === "Enter") openPlayer(a); } },
                            h("td", null, a.displayName), h("td", null, statusTags(a)), h("td", null, roleTags(a.roles)),
                            h("td", { class: "hide-sm dim" }, when(a.createdAt)), h("td", { class: "hide-sm dim" }, ago(a.lastSeenAt || a.lastLoginAt)));
                    })))));
            count.textContent = `${data.total} ${data.total === 1 ? "player" : "players"}, page ${data.page}`;
            prev.disabled = playerPage <= 1;
            next.disabled = playerPage * data.limit >= data.total;
        } catch (e) { fail(e); }
    }
    load();
}

async function openPlayerById(userId, displayName) {
    try {
        const found = await api("GET", `/players?search=${encodeURIComponent(displayName)}&limit=100`);
        const a = found.accounts.find((x) => x.userId === userId);
        if (a) openPlayer(a); else fail(new Error("Couldn't load that player."));
    } catch (e) { fail(e); }
}

// ---------- drawer ----------
function openDrawer(...content) {
    closeDrawer();
    const close = btn("Close", closeDrawer, "btn small close");
    const d = h("div", { class: "drawer", role: "dialog", "aria-modal": "true", id: "drawer" }, close, ...content);
    document.body.append(h("div", { class: "scrim", id: "scrim", onclick: closeDrawer }), d);
    close.focus();
    return d;
}
function closeDrawer() { $("drawer")?.remove(); $("scrim")?.remove(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("confirm").open) closeDrawer(); });

async function openPlayer(a) {
    const body = h("div", null, h("p", { class: "dim" }, "Loading…"));
    openDrawer(h("h1", null, a.displayName), h("div", { class: "row" }, statusTags(a), roleTags(a.roles)), body);
    let d;
    try { d = await api("GET", `/players/${encodeURIComponent(a.userId)}/detail`); } catch (e) { body.replaceChildren(h("p", { class: "err" }, e.message)); return; }

    const where = d.online ? (d.server ? `In a hunt: ${serverName({ kind: "hunt", ...d.server })}` : "Ramsgate or travelling") : null;
    const facts = [
        ["Status", d.online ? h("span", null, h("span", { class: "dot up" }), ` Online for ${since(d.lastSeenAt)}`) : `Offline, last seen ${ago(d.lastSeenAt)}`],
        where && ["Where", where],
        ["Joined", when(a.createdAt)],
        ["Launcher sign-in", a.lastLoginAt ? when(a.lastLoginAt) : "—"],
        a.email && ["Email", a.email],
        d.lastSeenIp && ["Last IP", d.lastSeenIp],
        ["Guild", d.guild ? `${d.guild.name}${d.guild.tag ? ` [${d.guild.tag}]` : ""}, ${d.guild.rank}` : "None"],
        ["Friends", d.friends],
        ["User ID", h("span", { class: "faint" }, a.userId)]
    ].filter(Boolean);
    const sections = [h("dl", { class: "facts" }, facts.map(([k, v]) => [h("dt", null, k), h("dd", null, v)]))];

    sections.push(h("h3", null, "Characters"), d.characters.length ? h("div", { class: "kv" }, d.characters.map((c) =>
        h("div", { title: c.characterId }, h("b", null, c.name || "Unnamed"), h("span", null, `edited ${c.modified || "—"}`)))) : h("p", { class: "dim" }, "No characters yet."));

    const wallet = Object.entries(d.wallet).filter(([, v]) => v).sort((x, y) => y[1] - x[1]);
    if (wallet.length) sections.push(h("h3", null, "Currencies"), h("div", { class: "kv" }, wallet.map(([k, v]) => h("div", { title: k }, h("span", null, currencyName(k)), h("b", null, v.toLocaleString())))));
    if (d.progression.length) sections.push(h("h3", null, "Progression tracks"), h("div", { class: "kv" }, d.progression.map((p) =>
        h("div", { title: `progress ${p.progress}` }, h("span", null, p.id), h("b", null, `Rank ${p.rank ?? 0}${p.premiumRank ? `, elite ${p.premiumRank}` : ""}`)))));
    if (d.entitlements.length) sections.push(h("h3", null, "Entitlements"), h("div", { class: "row" }, d.entitlements.map((n) => h("span", { class: "tag" }, n))));
    if (myRank >= 2) {
        sections.push(h("h3", null, "Other accounts seen on this IP"), d.sameIp.length
            ? h("div", { class: "row" }, d.sameIp.map((o) => btn(o.displayName, () => openPlayerById(o.userId, o.displayName), "btn small")))
            : h("p", { class: "dim" }, d.lastSeenIp ? "None." : "No IP recorded yet. It's saved when they next connect to chat."));
        sections.push(h("h3", null, "Launcher devices"), d.devices.length ? table(["Device", "Signed in", "State"], d.devices.map((s) => [
            s.name || "Unknown", when(s.createdAt),
            s.revokedAt ? h("span", { class: "tag" }, "Signed out") : Date.parse(s.expiresAt) < Date.now() ? h("span", { class: "tag" }, "Expired") : h("span", { class: "tag ok" }, "Active")
        ])) : h("p", { class: "dim" }, "No launcher sessions."));
    }
    sections.push(...moderation(a));
    const hist = h("div", { class: "history" }, h("p", { class: "dim" }, "Loading…"));
    sections.push(h("h3", null, "Staff history"), hist);
    body.replaceChildren(...sections);

    try {
        const r = await api("GET", `/audit?targetUserId=${encodeURIComponent(a.userId)}&limit=20`);
        hist.replaceChildren(...(r.records.length ? r.records.map((x) => h("div", null, h("span", { class: "dim" }, `${when(x.createdAt)}  ${names.get(x.actorUserId) || "staff"}: `), describe(x), x.reason ? h("span", { class: "dim" }, ` (${x.reason})`) : null))
            : [h("p", { class: "dim" }, "No staff actions yet.")]));
    } catch (e) { hist.replaceChildren(h("p", { class: "err" }, e.message)); }
}

function moderation(a) {
    const canAct = a.userId !== me.userId && myRank > rank(a.roles);
    if (!canAct) return [h("h3", null, "Moderation"), h("p", { class: "dim" }, a.userId === me.userId ? "This is your account." : "Only someone ranked above this staff member can change their account.")];
    const err = h("div", { class: "err", role: "alert" });
    const done = async (p) => {
        try { await p; closeDrawer(); clearErr(); go(location.hash.slice(1)); }
        catch (e) { err.textContent = e.message; }
    };
    const out = [h("h3", null, "Moderation"), err];

    const len = h("select", { "aria-label": "Ban length" }, BAN_LENGTHS.filter(([hr]) => myRank >= 2 || (hr && hr <= MOD_MAX_HOURS)).map(([hr, l]) => h("option", { value: hr }, l)));
    const why = h("textarea", { placeholder: "Reason (required, shown in the audit log)" });
    out.push(h("div", { class: "zone danger" }, h("h2", null, "Ban"),
        h("p", { class: "dim", style: "margin:0 0 8px" }, "Drops them from chat and voice now. They stay in their current map until they travel, then can't get back in."),
        why, h("div", { class: "row" }, len, btn("Ban player", () => {
            const hr = Number(len.value);
            done(api("PATCH", `/players/${a.userId}/access`, { status: "banned", reason: why.value, ...(hr ? { durationHours: hr } : {}) }));
        }, "btn danger"))));

    if (myRank >= 2) {
        const why2 = h("textarea", { placeholder: "Reason (required)" });
        const access = (b) => () => done(api("PATCH", `/players/${a.userId}/access`, { ...b, reason: why2.value }));
        out.push(h("div", { class: "zone" }, h("h2", null, "Account access"), why2, h("div", { class: "row" },
            (a.status !== "active" || a.banActive) && btn("Unban and re-enable", access({ status: "active" })),
            a.approvalStatus !== "approved" && btn("Approve sign-up", access({ approvalStatus: "approved" })),
            a.approvalStatus === "pending" && btn("Reject sign-up", access({ approvalStatus: "rejected" }), "btn danger"),
            a.status !== "disabled" && btn("Disable account", access({ status: "disabled" }), "btn danger"))));
    }
    if (myRank >= 3) {
        const checks = ["moderator", "admin", "tester"].map((r) => {
            const c = h("input", { type: "checkbox", checked: a.roles.includes(r) });
            return [r, c, h("label", null, c, ` ${titleCase(r)}`)];
        });
        out.push(h("div", { class: "zone" }, h("h2", null, "Roles"), h("div", { class: "row" }, checks.map((x) => x[2]),
            btn("Save roles", () => done(api("PATCH", `/players/${a.userId}/roles`, { roles: checks.filter((x) => x[1].checked).map((x) => x[0]), reason: "set from dashboard" }))))));
        out.push(h("div", { class: "zone danger" }, h("h2", null, "Delete account"),
            h("p", { class: "dim", style: "margin:0 0 8px" }, "Permanently removes the account, characters and inventory. This can't be undone."),
            btn("Delete account…", async () => {
                const reason = await confirmAction({ title: `Delete ${a.displayName}?`, body: "Everything on this account is removed for good.", ok: "Delete permanently", typeText: `DELETE ${a.displayName}` });
                if (reason) done(api("DELETE", `/players/${a.userId}`, { confirmation: `DELETE ${a.displayName}`, reason }));
            }, "btn danger")));
    }
    return out;
}

// ---------- online ----------
function renderOnline(root) {
    const count = h("span", { class: "dim" });
    const list = h("div", { class: "panel flush" });
    root.append(head("Online now", count), list);
    poll(async () => {
        try {
            const data = await api("GET", "/online-players");
            count.textContent = `${data.count} connected to chat, refreshes every 10 seconds`;
            const c = $("count-online"); if (c) c.textContent = data.count || "";
            list.replaceChildren(data.players.length === 0 ? h("div", { class: "empty" }, "Nobody is online right now.") :
                h("div", { class: "table-wrap" }, h("table", null,
                    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Online for"), h("th", null, "Where"), myRank >= 2 ? h("th", { class: "hide-sm" }, "IP") : null)),
                    h("tbody", null, data.players.map((p) => {
                        names.set(p.userId, p.displayName);
                        return h("tr", { class: "pick", tabindex: 0, onclick: () => openPlayerById(p.userId, p.displayName) },
                            h("td", null, h("span", { class: "dot up" }), `  ${p.displayName} `, roleTags(p.roles)),
                            h("td", null, since(p.onlineSince)),
                            h("td", null, p.server ? `Hunt: ${serverName({ kind: "hunt", ...p.server })}` : h("span", { class: "dim" }, "Ramsgate or travelling")),
                            myRank >= 2 ? h("td", { class: "hide-sm dim" }, p.ip || "—") : null);
                    })))));
        } catch (e) { fail(e); }
    }, 10000);
}

// ---------- audit ----------
function describe(r) {
    const o = r.oldState || {}, n = r.newState || {};
    switch (r.action) {
        case "player.access.update": {
            const parts = [];
            if (o.status !== n.status || o.bannedUntil !== n.bannedUntil)
                parts.push(n.status === "banned" ? (n.bannedUntil ? `banned until ${when(n.bannedUntil)}` : "banned permanently") : `status set to ${n.status}`);
            if (o.approvalStatus !== n.approvalStatus) parts.push(`sign-up ${n.approvalStatus}`);
            return parts.join(", ") || "access unchanged";
        }
        case "player.roles.update": return `roles set to ${(n.roles || []).filter((x) => x !== "player").join(", ") || "player"}`;
        case "player.account.delete": return "deleted the account";
        case "server.gameserver.stop": return `${n.kind === "hunt" ? "stopped" : "restarted"} ${serverName(n)} (port ${n.port})`;
        case "server.restart.director": return "restarted the Director";
        case "server.restart.stack": return "restarted everything";
        case "operations.policy.update": return "changed the operations policy";
        default: return r.action;
    }
}
let auditPage = 1;
function renderAudit(root) {
    const list = h("div", { class: "panel flush" });
    const prev = btn("Previous", () => { auditPage--; load(); }), next = btn("Next", () => { auditPage++; load(); });
    root.append(head("Audit log", btn("Refresh", () => load())), list, h("div", { class: "row" }, prev, next));
    async function load() {
        try {
            const data = await api("GET", `/audit?page=${auditPage}&limit=50`);
            list.replaceChildren(table(["When", "Staff", "Player", "Action", "Reason"], data.records.map((r) => [
                h("span", { class: "dim" }, when(r.createdAt)), names.get(r.actorUserId) || r.actorUserId,
                r.targetUserId ? names.get(r.targetUserId) || r.targetUserId : h("span", { class: "faint" }, "—"),
                describe(r), r.reason || ""
            ]), "No staff actions recorded yet."));
            prev.disabled = auditPage <= 1;
            next.disabled = auditPage * data.limit >= data.total;
        } catch (e) { fail(e); }
    }
    // Resolve staff names the list doesn't have yet (audit rows only carry ids).
    api("GET", "/players?limit=100").then((d) => { d.accounts.forEach((a) => names.set(a.userId, a.displayName)); load(); }).catch(load);
}

// ---------- logs ----------
let logName = "backend";
function renderLogs(root) {
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Log file" });
    const filter = h("input", { type: "search", placeholder: "Filter lines" });
    const follow = h("input", { type: "checkbox", checked: true });
    const pre = h("pre", { class: "log" }, "Loading…");
    let text = "";
    for (const [n, l] of [["backend", "Backend"], ["director", "Director"], ["restart", "Restarts"], ["director-build", "Director build"]])
        seg.append(h("button", { class: n === logName ? "on" : "", onclick: (e) => { logName = n; [...seg.children].forEach((b) => b.classList.toggle("on", b === e.target)); load(true); } }, l));
    filter.addEventListener("input", () => draw(true));
    root.append(head("Logs", seg), h("div", { class: "row" }, filter, h("label", { class: "dim" }, follow, " Follow new lines")), pre);

    function draw(toBottom) {
        const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
        fillLog(pre, text, filter.value);
        if (toBottom || (follow.checked && atBottom)) pre.scrollTop = pre.scrollHeight;
    }
    async function load(toBottom) {
        try { text = (await api("GET", `/servers/logs/${logName}`)).text; draw(toBottom); } catch (e) { pre.textContent = e.message; }
    }
    load(true);
    timers.push(setInterval(() => { if (follow.checked && document.visibilityState === "visible") load(false); }, 4000));
}

// ---------- launcher card (owner) ----------
function renderLauncherCard(root) {
    const title = h("input", { style: "width:100%", placeholder: "Server name in the launcher" });
    const motd = h("textarea", { placeholder: "Message of the day: what's on, rules, when hunts run" });
    const count = h("span", { class: "faint" });
    const logo = h("img", { alt: "", style: "width:96px;height:96px;object-fit:contain;border-radius:12px;background:var(--bg);border:1px solid var(--line)" });
    const noLogo = h("span", { class: "faint" }, "No logo yet: the launcher shows the first letter of the name.");
    const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "hidden" });
    const host = h("input", { value: location.hostname, placeholder: "100.108.36.34 or play.example.com" });
    const port = h("input", { value: location.port || "443", style: "width:80px", inputmode: "numeric" });
    const link = h("input", { readonly: true, style: "width:100%", placeholder: "Make a link to see it here" });
    let limits = { title: 48, motd: 300 };
    const showCount = () => { count.textContent = `${[...motd.value].length} / ${limits.motd}`; };
    motd.addEventListener("input", showCount);
    function show(card) {
        title.value = card.title; motd.value = card.motd; showCount();
        logo.classList.toggle("hidden", !card.logo); noLogo.classList.toggle("hidden", !!card.logo);
        if (card.logo) logo.src = card.logo;
    }
    async function save() {
        try { clearErr(); show(await api("PUT", "/launcher-card", { title: title.value, motd: motd.value })); saved.textContent = "Saved. Launchers pick it up within 30 seconds."; }
        catch (e) { fail(e); }
    }
    file.addEventListener("change", async () => {
        const f = file.files[0]; file.value = "";
        if (!f) return;
        try {
            clearErr();
            const res = await fetch("/admin/v1/launcher-card/logo", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/octet-stream", "X-CSRF-Token": csrf }, body: f });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error?.message || (res.status === 413 ? "That image is over 512 KB." : `Upload failed (${res.status}).`));
            show(data);
        } catch (e) { fail(e); }
    });
    async function makeLink() {
        try { clearErr(); const r = await api("GET", `/launcher-card/invite?host=${encodeURIComponent(host.value)}&port=${encodeURIComponent(port.value)}`); link.value = r.link; link.dataset.invite = r.invite; }
        catch (e) { fail(e); }
    }
    const copy = (text) => navigator.clipboard.writeText(text).then(() => { copied.textContent = "Copied."; }, () => { link.select(); });
    const saved = h("span", { class: "dim" });
    const copied = h("span", { class: "dim" });
    root.append(head("Launcher card"), h("div", { class: "stack" },
        h("div", { class: "panel" }, h("h2", null, "What players see"),
            h("p", { class: "dim" }, "Shown on this server's card in every player's launcher, in the Servers tab and the server switcher."),
            h("label", { class: "dim" }, "Title"), title,
            h("div", { class: "row" }, h("label", { class: "dim" }, "Message of the day"), h("div", { style: "flex:1" }), count), motd,
            h("div", { class: "row" }, btn("Save", save, "btn primary"), saved)),
        h("div", { class: "panel" }, h("h2", null, "Logo"),
            h("div", { class: "row" }, logo, noLogo),
            h("div", { class: "row" }, btn("Upload image…", () => file.click()), btn("Remove", async () => { try { show(await api("DELETE", "/launcher-card/logo")); } catch (e) { fail(e); } }, "btn danger"), file),
            h("p", { class: "faint" }, "Square PNG, JPEG or WebP, up to 512 KB. 256×256 looks sharp.")),
        h("div", { class: "panel" }, h("h2", null, "Invite link"),
            h("p", { class: "dim" }, "A link players can click (in Discord too) to add this server to their launcher. It holds the server's invite code, so share it only with people you want on the server."),
            h("div", { class: "row" }, h("label", { class: "dim" }, "Address players use"), host, h("label", { class: "dim" }, "Port"), port, btn("Make link", makeLink)),
            link,
            h("div", { class: "row" }, btn("Copy link", () => link.value && copy(link.value)), btn("Copy raw invite", () => link.dataset.invite && copy(link.dataset.invite)), copied))));
    api("GET", "/launcher-card").then((c) => { limits = c.limits; title.maxLength = limits.title; show(c); }).catch(fail);
}

// ---------- boot ----------
const discordError = new URLSearchParams(location.search).get("error");
api("GET", "/me").then(enter).catch(() => showLogin(discordError ? `Discord sign-in failed: ${discordError}` : ""));
