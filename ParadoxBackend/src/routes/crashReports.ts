/*
 * Copyright (C) 2026 MysticFox / Pranav Karande (pranav158/Mystic-Paradox)
 * Licensed under the GNU Affero General Public License v3.0.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7 apply. See ADDITIONAL_TERMS.md.
 */

import express, { Router, Request, Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";
import { IsRateLimited } from "../security/rateLimit";

// Crash reports from the injected runtime (ParadoxRuntime/CrashReporter.cpp), replacing Unreal's
// CrashReportClient upload. The crashing process has no account token, so this is unauthenticated and
// bounded instead: fixed file names, size caps, per-address rate limit, and a cap on stored reports.
// Each report lands in <root>/<id>/ with report.json, summary.txt (readable), minidump.dmp and
// context.xml (Unreal's own crash context: full call stacks, module list, system info).
export const CRASH_STORAGE_ROOT = path.resolve(process.env.CRASH_REPORT_STORAGE_DIR ?? path.join(process.cwd(), "..", "MysticCrashReports"));

const ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_FILE_BYTES: Record<string, number> = {
    "report.json": 512 * 1024,
    "minidump.dmp": 32 * 1024 * 1024,
    "context.xml": 2 * 1024 * 1024,
};
const MAX_REPORTS = 2000;

const text = (value: unknown, max = 200): string => String(value ?? "?").replace(/[\r\n]+/g, " ").slice(0, max);

export function formatCrashSummary(r: Record<string, any>): string {
    const e = r.exception ?? {};
    const lines = [
        `${text(e.name)} (${text(e.code)}) ${text(e.detail)}`,
        `where:   ${text(e.where)}${e.ghidra ? `  ghidra ${text(e.ghidra)}` : ""}`,
        `when:    ${text(r.time)}  role=${text(r.role)} port=${text(r.port)} pid=${text(r.pid)} runtime=${text(r.runtime)} uptime=${text(r.uptimeSec)}s`,
        `thread:  crash=${text(r.crashThread)} exceptionThread=${text(r.exceptionThread)} exceptionAgeMs=${text(r.exceptionAgeMs)}`,
        `memory:  ${text(JSON.stringify(r.memory ?? {}))}`,
        `regs:    ${text(r.regs, 600)}`,
        "",
        "stack:",
        ...(Array.isArray(r.stack) ? r.stack.slice(0, 64).map((f: unknown) => `  ${text(f, 300)}`) : []),
        "",
        "last log lines:",
        String(r.logTail ?? "").slice(-60000),
    ];
    return lines.join("\n");
}

// ---- GitHub issues -------------------------------------------------------------------------------
// Optional: GITHUB_CRASH_REPO=owner/name (private!) and GITHUB_CRASH_TOKEN (fine-grained PAT, Issues
// read/write on that repo only). One issue per distinct crash; repeats comment on it, and a repeat of a
// closed issue reopens it with the "regression" label. Files on disk stay the source of truth: a GitHub
// failure only logs. The minidump never leaves this host.
const MAX_NEW_ISSUES_PER_HOUR = 50;
const MAX_COMMENTS_PER_HOUR = 200;
const ISSUE_INDEX = path.join(CRASH_STORAGE_ROOT, "issues.json");
const FENCE = "`".repeat(3);

// Same crash = same exception and same function (not the exact address, which shifts with the call site).
export function crashSignature(r: Record<string, any>): string {
    const e = r.exception ?? {};
    const where = String(e.where ?? "");
    const ghidraFn = /fn_ghidra=(0x[0-9A-Fa-f]+)/.exec(where)?.[1];
    const moduleFn = /^(.*?)\+0x[0-9A-Fa-f]+ fn=\+(0x[0-9A-Fa-f]+)/.exec(where);
    const fn = ghidraFn ?? (moduleFn ? `${moduleFn[1]}${moduleFn[2]}` : where);
    return crypto.createHash("sha1").update(`${e.name}|${fn}`).digest("hex").slice(0, 12);
}

export function crashIssueTitle(r: Record<string, any>): string {
    const e = r.exception ?? {};
    return `${text(e.name, 60)} at ${text(e.where, 120)}`.slice(0, 200);
}

const issueChains = new Map<string, Promise<void>>();

async function github(method: string, route: string, body?: unknown): Promise<any> {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_CRASH_REPO}${route}`, {
        method,
        headers: {
            authorization: `Bearer ${process.env.GITHUB_CRASH_TOKEN}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "paradox-crash-reporter",
            ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${route} -> ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.json();
}

async function fileIssue(id: string, report: Record<string, any>, summary: string): Promise<void> {
    const sig = crashSignature(report);
    const index: Record<string, { number: number; count: number }> = fs.existsSync(ISSUE_INDEX)
        ? JSON.parse(fs.readFileSync(ISSUE_INDEX, "utf8")) : {};
    const line = `report \`${id}\` · ${text(report.role, 16)} · ${text(report.runtime, 40)} · ${text(report.time, 30)} · uptime ${text(report.uptimeSec, 12)}s`;
    const known = index[sig];

    if (!known) {
        if (IsRateLimited("crash-issue-new", MAX_NEW_ISSUES_PER_HOUR, 60 * 60 * 1000)) {
            logger.warn(`[CRASH] issue cap (${MAX_NEW_ISSUES_PER_HOUR}/h) reached; ${id} (sig ${sig}) saved on disk only`);
            return;
        }
        const body = `${line}\nsignature \`${sig}\`\n\n${FENCE}\n${summary.replaceAll(FENCE, "'''").slice(0, 60000)}\n${FENCE}\n\n`
            + `Minidump: \`${path.join(CRASH_STORAGE_ROOT, id)}\` on the host.`;
        const issue = await github("POST", "/issues", { title: crashIssueTitle(report), body, labels: ["crash"] });
        index[sig] = { number: issue.number, count: 1 };
        logger.warn(`[CRASH] opened GitHub issue #${issue.number} for ${id}`);
    } else {
        if (IsRateLimited("crash-issue-comment", MAX_COMMENTS_PER_HOUR, 60 * 60 * 1000)) return;
        known.count += 1;
        const issue = await github("GET", `/issues/${known.number}`);
        if (issue.state === "closed") {
            await github("PATCH", `/issues/${known.number}`, { state: "open" });
            await github("POST", `/issues/${known.number}/labels`, { labels: ["regression"] });
        }
        await github("POST", `/issues/${known.number}/comments`, { body: `Seen again (#${known.count}): ${line}` });
    }
    fs.writeFileSync(ISSUE_INDEX, JSON.stringify(index, null, 1));
}

function queueIssue(id: string, report: Record<string, any>, summary: string): void {
    if (!process.env.GITHUB_CRASH_REPO || !process.env.GITHUB_CRASH_TOKEN) return;
    const sig = crashSignature(report);   // one at a time per crash type, so two first reports make one issue
    const next = (issueChains.get(sig) ?? Promise.resolve())
        .then(() => fileIssue(id, report, summary))
        .catch((error) => logger.error(`[CRASH] GitHub issue for ${id} failed: ${error instanceof Error ? error.message : error}`));
    issueChains.set(sig, next);
    void next.finally(() => { if (issueChains.get(sig) === next) issueChains.delete(sig); });
}

export const crashReportsRouter = Router();

crashReportsRouter.put(
    "/crash/v1/reports/:id/:fileName",
    express.raw({ type: "application/octet-stream", limit: "32mb" }),
    (req: Request, res: Response) => {
        const id = String(req.params.id ?? "");
        const fileName = String(req.params.fileName ?? "");
        const maxBytes = MAX_FILE_BYTES[fileName];
        if (!ID_PATTERN.test(id) || maxBytes === undefined) {
            res.status(400).json({ error: "invalid_report_path" });
            return;
        }
        if (IsRateLimited(`crash-upload:${req.ip ?? "unknown"}`, 90, 60 * 60 * 1000)) {
            res.status(429).json({ error: "rate_limited" });
            return;
        }
        if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0 || req.body.byteLength > maxBytes) {
            res.status(400).json({ error: "invalid_body" });
            return;
        }

        const dir = path.join(CRASH_STORAGE_ROOT, id);
        if (!fs.existsSync(dir)) {
            if (fs.existsSync(CRASH_STORAGE_ROOT) && fs.readdirSync(CRASH_STORAGE_ROOT).length >= MAX_REPORTS) {
                res.status(507).json({ error: "crash_storage_full" });
                return;
            }
            fs.mkdirSync(dir, { recursive: true });
        }

        if (fileName === "report.json") {
            let report: Record<string, any>;
            try {
                report = JSON.parse(req.body.toString("utf8"));
                if (report === null || typeof report !== "object" || Array.isArray(report)) throw new Error("not an object");
            } catch {
                res.status(400).json({ error: "invalid_json" });
                return;
            }
            const summary = formatCrashSummary(report);
            fs.writeFileSync(path.join(dir, "summary.txt"), summary);
            queueIssue(id, report, summary);
            const e = report.exception ?? {};
            logger.warn(`[CRASH] id=${id} role=${text(report.role, 16)} ${text(e.name, 60)} at ${text(e.where, 120)} (${text(e.detail, 80)}) runtime=${text(report.runtime, 20)}`);
        }
        fs.writeFileSync(path.join(dir, fileName), req.body as Buffer);
        res.status(201).json({ id });
    }
);
