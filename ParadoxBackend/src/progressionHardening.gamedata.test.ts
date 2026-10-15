import assert from "node:assert/strict";
import test from "node:test";
import { MongoPlayerJourneyRepository } from "./persistence/mongo/repositories/MongoPlayerJourneyRepository";
import { MongoProgressionGrantRepository } from "./persistence/mongo/repositories/MongoProgressionGrantRepository";
import {
    APPROVED_XP_PROGRESSION_TRACK_IDS,
    BuildProgressionGrantRequestHash,
    GrantProgressionXp,
    IsApprovedXpProgressionTrack,
    IsValidProgressionGrantId,
    MergePlayerJourneyNodes,
    IsAuthorizedProgressionReader,
    IsAuthorizedProgressionReporter,
    IsCharacterOwnedByUser
} from "./controllers/progression";
import { CaptureProgressionObjectiveEvent, ConfirmPublicProgressionRank, MasteryTrackForObjective } from "./controllers/progression";
import { HuntPassMaxXp, HuntPassStorageId } from "./huntPassRotation";

const Track = {
    userId: "user-1",
    progressionId: "ExperienceTrack_PlayerLevel",
    progress: 125,
    confirmedFremiumRank: 0,
    confirmedPremiumRank: 0,
    updateVersion: 1,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z"
};

test("progression grant request hashes are canonical and bind every mutation field", () => {
    const First = BuildProgressionGrantRequestHash("user-1", "ExperienceTrack_PlayerLevel", 125);
    assert.equal(First, BuildProgressionGrantRequestHash("user-1", "ExperienceTrack_PlayerLevel", 125));
    assert.notEqual(First, BuildProgressionGrantRequestHash("user-1", "ExperienceTrack_PlayerLevel", 126));
    assert.notEqual(First, BuildProgressionGrantRequestHash("user-2", "ExperienceTrack_PlayerLevel", 125));
    assert.equal(IsValidProgressionGrantId("hunt-2026-08-30:0001"), true);
    assert.equal(IsValidProgressionGrantId(""), false);
    assert.equal(IsValidProgressionGrantId("has spaces"), false);
});

test("XP mutation allowlist excludes config-only historical/test tracks", () => {
    assert.equal(IsApprovedXpProgressionTrack("ExperienceTrack_PlayerLevel"), true);
    assert.equal(IsApprovedXpProgressionTrack("single_track"), false);
    assert.equal(IsApprovedXpProgressionTrack("test_minipass01"), false);
    assert.equal(APPROVED_XP_PROGRESSION_TRACK_IDS.includes("MasteryTrack_Behemoth"), true);
});

test("progression route authority cannot be widened by player-host identity", () => {
    assert.equal(IsAuthorizedProgressionReporter({ userId: "user-1" }, "user-1"), true);
    assert.equal(IsAuthorizedProgressionReporter({ userId: "user-1" }, "user-2"), false);
    assert.equal(IsAuthorizedProgressionReporter({ IsPlayerHostRuntime: true, userId: "user-1" }, "user-1"), false);
    assert.equal(IsAuthorizedProgressionReporter({ IsGameserver: true }, "user-2"), true);
    assert.equal(IsAuthorizedProgressionReader({ IsPlayerHostRuntime: true, userId: "user-1" }, "user-1"), true);
});

test("character-scoped progression state requires an existing account-owned character", async () => {
    const Lookups: Array<[string, string]> = [];
    const Repositories: any = {
        characters: {
            findByCharacterIdAndUserId: async (characterId: string, userId: string) => {
                Lookups.push([characterId, userId]);
                return characterId === "char-owned" && userId === "user-1" ? { characterId, userId } : undefined;
            }
        }
    };

    assert.equal(await IsCharacterOwnedByUser("user-1", "char-owned", Repositories), true);
    assert.equal(await IsCharacterOwnedByUser("user-1", "char-other", Repositories), false);
    assert.equal(await IsCharacterOwnedByUser("user-2", "char-owned", Repositories), false);
    assert.equal(await IsCharacterOwnedByUser("user-1", "INVALID", Repositories), false);
    assert.deepEqual(Lookups, [["char-owned", "user-1"], ["char-other", "user-1"], ["char-owned", "user-2"]]);
});

test("absolute player progression reports are retained as diagnostics but never mutate canonical state", async () => {
    let Appended = 0;
    const Diagnostics = {
        appendObjectiveEvent: async () => { Appended++; }
    };
    await CaptureProgressionObjectiveEvent("user-1", {
        progress_tracks: [{ progression_id: "ExperienceTrack_PlayerLevel", progress: 1_000_000_000 }],
        objectives: [{ objective_id: "Objective_1", value: 1_000_000_000, completed_count: 1_000_000 }]
    }, Diagnostics);
    assert.equal(Appended, 1);
});

test("journey merge preserves concurrent unlocks and stale stored values", () => {
    const Stored = { A: { node_status: 1 }, Conflict: { node_status: 1 } };
    const Incoming = { B: { node_status: 1 }, Conflict: { node_status: 0 } };
    const Merged = MergePlayerJourneyNodes(Stored, Incoming, 3, 3);
    assert.deepEqual(Merged.nodes, {
        A: { node_status: 1 },
        B: { node_status: 1 },
        Conflict: { node_status: 1 }
    });
    assert.equal(Merged.version, 3);
});

test("Mongo journey repository applies an expected-version CAS predicate", async () => {
    let SeenFilter: any;
    const Collection = {
        updateOne: async (Filter: any) => {
            SeenFilter = Filter;
            return { matchedCount: 1 };
        }
    };
    const Db = { collection: () => Collection } as any;
    const Repository = new MongoPlayerJourneyRepository(async () => Db);
    assert.equal(await Repository.updateIfRevision("user-1", "{\"A\":1}", 4, 3), true);
    assert.deepEqual(SeenFilter, { _id: "user-1", revision: 3 });
});

test("Mongo progression grant repository uses the authoritative grant id as unique ledger key", async () => {
    let Inserted: any;
    const Collection = {
        findOne: async () => undefined,
        insertOne: async (Document: any) => { Inserted = Document; }
    };
    const Db = { collection: () => Collection } as any;
    const Repository = new MongoProgressionGrantRepository(async () => Db);
    const Record = {
        grantId: "hunt-1",
        userId: Track.userId,
        progressionId: Track.progressionId,
        amount: 125,
        requestHash: BuildProgressionGrantRequestHash(Track.userId, Track.progressionId, 125),
        status: "applied" as const,
        result: Track,
        createdAt: Track.createdAt
    };
    await Repository.insertApplied(Record, {} as any);
    assert.equal(Inserted._id, "hunt-1");
    assert.equal(Inserted.requestHash, Record.requestHash);
    assert.deepEqual(Inserted.result, Track);
});

test("same authoritative grant replays its recorded result and never increments twice", async () => {
    let Progress = 0;
    let IncrementCount = 0;
    const Session = { transaction: true };
    const Sessions: any[] = [];
    const Ledger = new Map<string, any>();
    const Repositories: any = {
        progressionGrants: {
            findByGrantId: async (GrantId: string, CurrentSession: any) => { Sessions.push(CurrentSession); return Ledger.get(GrantId); },
            insertApplied: async (Record: any, CurrentSession: any) => { Sessions.push(CurrentSession); Ledger.set(Record.grantId, Record); }
        },
        progressionTracks: {
            get: async (_UserId: string, _TrackId: string, CurrentSession: any) => { Sessions.push(CurrentSession); return Progress === 0 ? undefined : { ...Track, progress: Progress }; },
            increment: async (_UserId: string, _TrackId: string, Amount: number, CurrentSession: any) => {
                Sessions.push(CurrentSession);
                IncrementCount++;
                Progress += Amount;
                return { ...Track, progress: Progress };
            }
        }
    };
    const UnitOfWork: any = { withTransaction: async (Action: any) => Action(Repositories, Session) };

    const First = await GrantProgressionXp("user-1", "ExperienceTrack_PlayerLevel", 125, "grant-1", UnitOfWork);
    const Replay = await GrantProgressionXp("user-1", "ExperienceTrack_PlayerLevel", 125, "grant-1", UnitOfWork);
    assert.equal(First.replayed, false);
    assert.equal(Replay.replayed, true);
    assert.equal(Replay.record.progress, 125);
    assert.equal(IncrementCount, 1);
    assert.equal(Sessions.length, 5);
    assert.equal(Sessions.every((CurrentSession) => CurrentSession === Session), true);
});

test("hunt pass XP is stored per pass, and Slayer Link XP feeds the pass the player is on", async () => {
    const Stored = new Map<string, number>();
    const Row = (Id: string) => ({ ...Track, progressionId: Id, progress: Stored.get(Id) ?? 0 });
    const Repositories: any = {
        progressionGrants: { findByGrantId: async () => undefined, insertApplied: async () => undefined },
        progressionTracks: {
            get: async (_U: string, Id: string) => Stored.has(Id) ? Row(Id) : undefined,
            increment: async (_U: string, Id: string, Amount: number) => { Stored.set(Id, (Stored.get(Id) ?? 0) + Amount); return Row(Id); },
            getAllForUser: async () => [...Stored.keys()].map(Row)
        }
    };
    const UnitOfWork: any = { withTransaction: async (Action: any) => Action(Repositories, {}) };
    const Frost = HuntPassStorageId("season43");
    assert.match(Frost, /^season43:/);

    await GrantProgressionXp("user-1", "season43", 300, "hp-1", UnitOfWork);
    assert.equal(Stored.get(Frost), 300);
    assert.equal(Stored.has("season43"), false);                       // never under the bare slot id

    await GrantProgressionXp("user-1", "Linked_Slayer_Slot_1", 500, "link-1", UnitOfWork);
    assert.equal(Stored.get(Frost), 350);                              // a tenth of 500 reached the pass

    Stored.set(Frost, HuntPassMaxXp("season43"));                      // season43's pass completed ...
    await GrantProgressionXp("user-1", "Linked_Slayer_Slot_1", 500, "link-2", UnitOfWork);
    assert.equal(Stored.get(HuntPassStorageId("season44")), 50);       // ... so the link feeds the next one
    assert.equal(Stored.get(Frost), HuntPassMaxXp("season43"));
});

test("grant request mismatch is rejected before a second mutation", async () => {
    const Ledger = new Map<string, any>();
    let IncrementCount = 0;
    const Repositories: any = {
        progressionGrants: {
            findByGrantId: async (GrantId: string) => Ledger.get(GrantId),
            insertApplied: async (Record: any) => { Ledger.set(Record.grantId, Record); }
        },
        progressionTracks: {
            get: async () => undefined,
            increment: async () => { IncrementCount++; return Track; }
        }
    };
    const UnitOfWork: any = { withTransaction: async (Action: any) => Action(Repositories, {}) };
    await GrantProgressionXp("user-1", "ExperienceTrack_PlayerLevel", 125, "grant-2", UnitOfWork);
    await assert.rejects(
        GrantProgressionXp("user-1", "ExperienceTrack_PlayerLevel", 126, "grant-2", UnitOfWork),
        /already used with a different request/
    );
    assert.equal(IncrementCount, 1);
});

test("a duplicate-key transaction race retries outside the aborted session", async () => {
    const Ledger = new Map<string, any>();
    let Attempts = 0;
    let Increments = 0;
    const Repositories: any = {
        progressionGrants: {
            findByGrantId: async (GrantId: string) => Ledger.get(GrantId),
            insertApplied: async (Record: any) => {
                if(Attempts === 1){
                    // Model the competing transaction committing the durable row while this
                    // transaction receives its duplicate-key abort.
                    Ledger.set(Record.grantId, Record);
                    const ErrorValue: any = new Error("duplicate");
                    ErrorValue.code = 11000;
                    throw ErrorValue;
                }
                Ledger.set(Record.grantId, Record);
            }
        },
        progressionTracks: {
            get: async () => undefined,
            increment: async () => { Increments++; return { ...Track, progress: 125 }; }
        }
    };
    const UnitOfWork: any = {
        withTransaction: async (Action: any) => {
            Attempts++;
            return Action(Repositories, {});
        }
    };
    const Result = await GrantProgressionXp("user-1", "ExperienceTrack_PlayerLevel", 125, "grant-race", UnitOfWork);
    assert.equal(Attempts, 2);
    assert.equal(Increments, 1);
    assert.equal(Result.replayed, true);
});

test("mastery objectives map to their category track", () => {
    assert.equal(MasteryTrackForObjective("MasteryObjective_Behemoth_Embermane_Kill"), "MasteryTrack_Behemoth");
    assert.equal(MasteryTrackForObjective("MasteryObjective_Weapon_DP_Quillshot_Craft"), "MasteryTrack_Weapon_Repeaters");
    assert.equal(MasteryTrackForObjective("MasteryObjective_Weapon_Pike_Generic_Kills1"), "MasteryTrack_Weapon_Spear");
    assert.equal(MasteryTrackForObjective("AchievementObjective_Discover_Collectables"), undefined);
});

test("Elite (premium) rank confirm is only for hunt passes", async () => {
    assert.deepEqual(await ConfirmPublicProgressionRank("user-1", "ExperienceTrack_PlayerLevel", 1, true), { ok: false, reason: "not_entitled" });
});
