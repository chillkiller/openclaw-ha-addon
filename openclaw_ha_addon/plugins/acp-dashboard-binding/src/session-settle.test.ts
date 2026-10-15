/**
 * BRIDGE §19 tests: claim-path settlements (origin/clone session-node terminal
 * patches), the V39→γ clone stamps (spawnedBy provenance + archivedAt hide),
 * and the boot sweep incl. its γ archival leg. The store is a fake
 * plugin-sdk session-store-runtime (same public/patch semantics the live
 * module projects: update callback runs against the CURRENT entry, returning
 * null = no write).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetDashboardBindingCloneAutoArchiveForTest,
  resetDashboardBindingDispatchModeForTest,
  setDashboardBindingCloneAutoArchive,
  setDashboardBindingDispatchMode,
} from "./agent-map.js";
import {
  buildClaimSettlePatch,
  buildCloneHiddenPatch,
  isOursCloneArchive,
  runBootHealWithRetries,
  settleClaimedTurnSessions,
  stampCloneHidden,
  stampSubagentProvenance,
  sweepOwnedStuckSessions,
  unarchiveHiddenClone,
  unarchiveOwnedLegacyStamps,
  unhideOverstampedCloneSessions,
  type SessionStoreApi,
  type SettleSessionEntryLike,
  type SweepSessionStoreApi,
} from "./session-settle.js";

type FakeStoreOptions = {
  entries?: Record<string, SettleSessionEntryLike>;
};

function createFakeStore({ entries = {} }: FakeStoreOptions = {}): SessionStoreApi & SweepSessionStoreApi & {
  patches: Array<{ sessionKey: string; patch: Record<string, unknown> }>;
} {
  const patches: Array<{ sessionKey: string; patch: Record<string, unknown> }> = [];
  const clone = (entry: SettleSessionEntryLike): SettleSessionEntryLike => ({
    ...entry,
  });
  return {
    patches,
    entries,
    getSessionEntry: ({ sessionKey }) => {
      const entry = entries[sessionKey.trim()];
      return entry ? clone(entry) : undefined;
    },
    async patchSessionEntry({ sessionKey, update }) {
      const key = sessionKey.trim();
      const entry = entries[key];
      if (!entry) return null;
      const patch = update(clone(entry));
      if (!patch) return null;
      const next: SettleSessionEntryLike = { ...entry };
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) delete next[field];
        else next[field] = value;
      }
      entries[key] = next;
      patches.push({ sessionKey: key, patch });
      return clone(next);
    },
    listSessionEntries: ({ agentId }) =>
      Object.entries(entries)
        .filter(([sessionKey]) => sessionKey.startsWith(`agent:${agentId}:`))
        .map(([sessionKey, entry]) => ({ sessionKey, entry: clone(entry) })),
  };
}

const RUN_ID = "9b4a2cf5-db1a-4780-aabe-1c7db67c1e84";
const ORIGIN = "agent:claude:dashboard:99d8daf5-ae9c-4e35-8295-d1172e1b5051";
const TARGET = "agent:claude:acp:binding:webchat:default:4fbefeb91c0aed3d";

describe("BRIDGE §19: buildClaimSettlePatch", () => {
  it("returns null unless the entry is still running (idempotence vs the host's own settle)", () => {
    expect(buildClaimSettlePatch({ status: "done" }, RUN_ID, Date.now())).toBeNull();
    expect(buildClaimSettlePatch(undefined, RUN_ID, Date.now())).toBeNull();
  });

  it("writes the host-parity terminal shape incl. runtimeMs from startedAt", () => {
    const endedAt = 123_456;
    const patch = buildClaimSettlePatch(
      { status: "running", startedAt: endedAt - 5_000 },
      RUN_ID,
      endedAt,
    );
    expect(patch).toEqual({
      status: "done",
      endedAt,
      runtimeMs: 5_000,
      abortedLastRun: false,
    });
  });

  it("clears the restart-recovery claim fields only for the matching delivery run", () => {
    const entry = {
      status: "running",
      startedAt: 1,
      restartRecoveryDeliveryRunId: RUN_ID,
      restartRecoveryDeliverySourceRunId: RUN_ID,
      restartRecoverySourceIngress: "control-ui",
    };
    const matching = buildClaimSettlePatch(entry, RUN_ID, 100)!;
    expect(matching.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(matching.restartRecoveryDeliverySourceRunId).toBeUndefined();
    expect(matching.restartRecoverySourceIngress).toBeUndefined();

    const foreign = buildClaimSettlePatch(
      { ...entry, restartRecoveryDeliveryRunId: "another-run" },
      RUN_ID,
      100,
    )!;
    expect(foreign.restartRecoveryDeliveryRunId).toBeUndefined(); // untouched
    expect(Object.hasOwn(foreign, "restartRecoveryDeliveryRunId")).toBe(false);
  });

  it("clears the FULL host parity field set (buildRestartRecoveryClaimCleanupPatch mirror)", () => {
    // Audit must-fix 1 (2026-10-12): the cleared set must be the host's FULL
    // claim-cleanup field list (restart-recovery-state-puFilrVu.mjs:239) —
    // enumerated here 1:1 so a host-side field change fails this test loudly.
    const HOST_CLAIM_CLEANUP_FIELDS = [
      "restartRecoveryBeforeAgentReplyState",
      "restartRecoveryDeliveryReceiptState",
      "restartRecoveryDeliveryToolCallId",
      "restartRecoveryDeliveryContext",
      "restartRecoveryDeliveryMediaUrls",
      "restartRecoveryDisableMessageTool",
      "restartRecoverySuppressTextDelivery",
      "restartRecoveryDeliveryRequestFingerprint",
      "restartRecoveryDeliveryRunId",
      "restartRecoveryDeliverySourceRunId",
      "restartRecoveryHarnessCompletion",
      "restartRecoveryRequesterAccountId",
      "restartRecoveryRequesterSenderId",
      "restartRecoverySameChannelThreadRequired",
      "restartRecoverySourceIngress",
      "restartRecoverySourceReplyDeliveryMode",
      "restartRecoveryForceSafeTools",
    ];
    const entry: SettleSessionEntryLike = { status: "running" };
    for (const field of HOST_CLAIM_CLEANUP_FIELDS) entry[field] = "stale";
    const patch = buildClaimSettlePatch(entry, RUN_ID, 100)!;
    for (const field of HOST_CLAIM_CLEANUP_FIELDS) {
      expect(patch[field]).toBeUndefined();
    }
    // Terminal-evidence merges stay untouched (record-side, not claim fields).
    expect(Object.hasOwn(patch, "restartRecoveryTerminalRunIds")).toBe(false);
    expect(Object.hasOwn(patch, "restartRecoveryTerminalDeliveryEvidence")).toBe(false);
  });

  it("maps the wait disposition honestly: error→failed, timeout→timeout (audit must-fix 2)", () => {
    const base = { status: "running", startedAt: 10 };
    const failed = buildClaimSettlePatch(base, RUN_ID, 110, "failed")!;
    expect(failed.status).toBe("failed");
    expect(failed.abortedLastRun).toBe(false);
    const timedOut = buildClaimSettlePatch(base, RUN_ID, 110, "timeout")!;
    expect(timedOut.status).toBe("timeout");
    expect(timedOut.abortedLastRun).toBe(false);
    // Boot-sweep shape = host mark_interrupted parity: interrupted + abort flag.
    const interrupted = buildClaimSettlePatch(base, RUN_ID, 110, "interrupted")!;
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.abortedLastRun).toBe(true);
    // Default stays the success shape.
    const success = buildClaimSettlePatch(base, RUN_ID, 110)!;
    expect(success.status).toBe("done");
    expect(success.abortedLastRun).toBe(false);
  });
});

describe("BRIDGE §19a: settleClaimedTurnSessions", () => {
  it("settles the ORIGIN node always and the TARGET only after a terminal wait", async () => {
    const store = createFakeStore({
      entries: {
        [ORIGIN]: { status: "running", startedAt: 1000 },
        [TARGET]: { status: "running", startedAt: 1000, lifecycleRunId: RUN_ID },
      },
    });
    await settleClaimedTurnSessions({
      sessionStore: store,
      originSessionKey: ORIGIN,
      targetSessionKey: TARGET,
      claimRunId: RUN_ID,
      waitStatus: "nonterminal",
    });
    expect(store.patches.map((patch) => patch.sessionKey)).toEqual([ORIGIN]);

    const terminal = createFakeStore({
      entries: {
        [ORIGIN]: { status: "running", startedAt: 1000 },
        [TARGET]: { status: "running", startedAt: 1000, lifecycleRunId: RUN_ID },
      },
    });
    await settleClaimedTurnSessions({
      sessionStore: terminal,
      originSessionKey: ORIGIN,
      targetSessionKey: TARGET,
      claimRunId: RUN_ID,
      waitStatus: "terminal",
    });
    expect(terminal.patches.map((patch) => patch.sessionKey)).toEqual([ORIGIN, TARGET]);
    expect(
      terminal.entries[TARGET] && (terminal.entries[TARGET] as SettleSessionEntryLike).status,
    ).toBe("done");
  });

  it("no-ops when the host's §17 terminal commit already settled the entry", async () => {
    const store = createFakeStore({
      entries: { [ORIGIN]: { status: "done", endedAt: 42 } },
    });
    await settleClaimedTurnSessions({
      sessionStore: store,
      originSessionKey: ORIGIN,
      targetSessionKey: TARGET,
      claimRunId: RUN_ID,
      waitStatus: "terminal",
    });
    expect(store.patches).toEqual([]);
  });
});

describe("BRIDGE §19 / V39: stampSubagentProvenance", () => {
  it("stamps spawnedBy = <origin key> on the clone entry (provenance leg)", async () => {
    const store = createFakeStore({ entries: { [TARGET]: { status: "running" } } });
    const stamped = await stampSubagentProvenance({
      sessionStore: store,
      targetSessionKey: TARGET,
      originSessionKey: ORIGIN,
    });
    expect(stamped).toBe(true);
    expect((store.entries[TARGET] as SettleSessionEntryLike).spawnedBy).toBe(ORIGIN);
    expect((store.entries[TARGET] as SettleSessionEntryLike).archivedAt).toBeUndefined();
  });

  it("is idempotent and never overrides foreign provenance or categorized entries", async () => {
    const stampedStore = createFakeStore({ entries: { [TARGET]: { status: "done", spawnedBy: ORIGIN } } });
    expect(
      await stampSubagentProvenance({
        sessionStore: stampedStore,
        targetSessionKey: TARGET,
        originSessionKey: ORIGIN,
      }),
    ).toBe(false);

    const foreignStore = createFakeStore({ entries: { [TARGET]: { status: "running", spawnedBy: "agent:other:dashboard:x" } } });
    expect(
      await stampSubagentProvenance({
        sessionStore: foreignStore,
        targetSessionKey: TARGET,
        originSessionKey: ORIGIN,
      }),
    ).toBe(false);
    expect((foreignStore.entries[TARGET] as SettleSessionEntryLike).spawnedBy).toBe(
      "agent:other:dashboard:x",
    );

    const categorizedStore = createFakeStore({ entries: { [TARGET]: { status: "running", category: "work" } } });
    expect(
      await stampSubagentProvenance({
        sessionStore: categorizedStore,
        targetSessionKey: TARGET,
        originSessionKey: ORIGIN,
      }),
    ).toBe(false);
  });
});

describe("BRIDGE γ (legacy mode, cloneAutoArchive:true): buildCloneHiddenPatch / stampCloneHidden / unarchiveHiddenClone", () => {
  beforeEach(() => setDashboardBindingCloneAutoArchive(true));
  afterEach(() => resetDashboardBindingCloneAutoArchiveForTest());

  it("buildCloneHiddenPatch archives uncategorized, unarchived entries only (archivedBy marker)", () => {
    expect(buildCloneHiddenPatch({ status: "done" })).toEqual({
      archivedAt: expect.any(Number),
      archivedBy: { type: "system", id: "acp-dashboard-binding" },
    });
    // Already archived — ours or foreign — stays (never re-stamped here).
    expect(buildCloneHiddenPatch({ status: "done", archivedAt: 7 })).toBeNull();
    expect(buildCloneHiddenPatch({ status: "done", archivedAt: 7, archiveReason: "stale-dashboard" })).toBeNull();
    // User-curated rows are never ours to hide.
    expect(buildCloneHiddenPatch({ status: "done", category: "work" })).toBeNull();
    expect(buildCloneHiddenPatch(undefined)).toBeNull();
  });

  it("isOursCloneArchive matches ONLY our archivedBy-id marker", () => {
    // Our shape: archivedAt set, NO archiveReason, our archivedBy id.
    expect(isOursCloneArchive({ archivedAt: 1, archivedBy: { type: "system", id: "acp-dashboard-binding" } })).toBe(true);
    // Host maintenance shape (archiveReason set, archivedBy deleted).
    expect(isOursCloneArchive({ archivedAt: 1, archiveReason: "age-retention" })).toBe(false);
    // Manual user archive (archivedBy is a human actor).
    expect(isOursCloneArchive({ archivedAt: 1, archivedBy: { type: "human" }, archiveReason: "manual" })).toBe(false);
    // Unannotated-but-not-ours (foreign plugin stamp shape) → not ours.
    expect(isOursCloneArchive({ archivedAt: 1 })).toBe(false);
    expect(isOursCloneArchive({ archivedAt: 1, archivedBy: { type: "system", id: "other-plugin" } })).toBe(false);
    // Not archived at all.
    expect(isOursCloneArchive({})).toBe(false);
    expect(isOursCloneArchive(undefined)).toBe(false);
  });

  it("stampCloneHidden archives the idle clone and is idempotent", async () => {
    const store = createFakeStore({ entries: { [TARGET]: { status: "done", endedAt: 5 } } });
    expect(await stampCloneHidden({ sessionStore: store, targetSessionKey: TARGET })).toBe(true);
    const entry = store.entries[TARGET] as SettleSessionEntryLike;
    expect(typeof entry.archivedAt).toBe("number");
    expect(entry.archivedBy).toEqual({ type: "system", id: "acp-dashboard-binding" });
    expect(entry.archiveReason).toBeUndefined();
    expect(await stampCloneHidden({ sessionStore: store, targetSessionKey: TARGET })).toBe(false);
    expect(store.patches).toHaveLength(1);
  });

  it("unarchiveHiddenClone clears ONLY our marker and never a foreign archive", async () => {
    // Our marker → cleared (explicit-undefined patch; the fake store deletes
    // undefined-valued fields like the host's mergeSessionEntry spread).
    const ours = createFakeStore({
      entries: {
        [TARGET]: {
          status: "done",
          archivedAt: 100,
          archivedBy: { type: "system", id: "acp-dashboard-binding" },
          spawnedBy: ORIGIN,
        },
      },
    });
    expect(await unarchiveHiddenClone({ sessionStore: ours, targetSessionKey: TARGET })).toBe(true);
    const cleared = ours.entries[TARGET] as SettleSessionEntryLike;
    expect(Object.hasOwn(cleared, "archivedAt")).toBe(false);
    expect(Object.hasOwn(cleared, "archivedBy")).toBe(false);
    expect(cleared.spawnedBy).toBe(ORIGIN);

    // Foreign archive reason → untouched (host/user lifecycle owns it).
    const foreign = createFakeStore({
      entries: { [TARGET]: { status: "done", archivedAt: 50, archiveReason: "stale-dashboard" } },
    });
    expect(await unarchiveHiddenClone({ sessionStore: foreign, targetSessionKey: TARGET })).toBe(false);
    expect((foreign.entries[TARGET] as SettleSessionEntryLike).archivedAt).toBe(50);
    expect((foreign.entries[TARGET] as SettleSessionEntryLike).archiveReason).toBe("stale-dashboard");

    // Archived by the UI (manual + human actor) → untouched.
    const manual = createFakeStore({
      entries: { [TARGET]: { status: "done", archivedAt: 60, archivedBy: { type: "human" }, archiveReason: "manual" } },
    });
    expect(await unarchiveHiddenClone({ sessionStore: manual, targetSessionKey: TARGET })).toBe(false);
    expect((manual.entries[TARGET] as SettleSessionEntryLike).archivedAt).toBe(60);

    // Never-archived clone → no-op.
    const fresh = createFakeStore({ entries: { [TARGET]: { status: "done" } } });
    expect(await unarchiveHiddenClone({ sessionStore: fresh, targetSessionKey: TARGET })).toBe(false);
    expect(fresh.patches).toEqual([]);
  });
});

describe("BRIDGE γ OFF (default, GaRoN directive 2026-10-14): no auto-archiving", () => {
  it("buildCloneHiddenPatch is a no-op even for the ideal archival candidate", () => {
    expect(buildCloneHiddenPatch({ status: "done", endedAt: 5 })).toBeNull();
    expect(buildCloneHiddenPatch({ status: "running" })).toBeNull();
  });

  it("stampCloneHidden writes nothing", async () => {
    const store = createFakeStore({ entries: { [TARGET]: { status: "done", endedAt: 5 } } });
    expect(await stampCloneHidden({ sessionStore: store, targetSessionKey: TARGET })).toBe(false);
    expect(store.patches).toEqual([]);
    expect((store.entries[TARGET] as SettleSessionEntryLike).archivedAt).toBeUndefined();
  });

  it("sweep: settles interrupted orphans but archives NOTHING (γ leg no-op)", async () => {
    const doneClone = "agent:claude:acp:binding:telegram:default:0123abcdeadbeef0";
    const store = createFakeStore({
      entries: {
        [doneClone]: { status: "done", endedAt: 5 },
        [TARGET]: { status: "running", updatedAt: 1, lifecycleRunId: RUN_ID },
      },
    });
    const result = await sweepOwnedStuckSessions({
      sessionStore: store,
      agentIds: ["claude"],
      cutoffMs: Date.now() - 1_000,
    });
    // Settle bookkeeping still runs (boot interrupted the orphan run)...
    expect(result.settled).toEqual([TARGET]);
    expect((store.entries[TARGET] as SettleSessionEntryLike).status).toBe("interrupted");
    // ...but no archive stamps: the transcript stays readable everywhere.
    expect(result.archived).toEqual([]);
    expect((store.entries[TARGET] as SettleSessionEntryLike).archivedAt).toBeUndefined();
    expect((store.entries[doneClone] as SettleSessionEntryLike).archivedAt).toBeUndefined();
    expect(store.patches.every((p) => !Object.hasOwn(p.patch, "archivedAt"))).toBe(true);
  });
});

describe("BRIDGE §19c: sweepOwnedStuckSessions", () => {
  afterEach(() => resetDashboardBindingCloneAutoArchiveForTest());

  it("settles stuck owned entries (clone + dashboard grammar) and nothing else", async () => {
    const foreigner = "agent:claude:subagent:abc:123";
    const foreign = "agent:other:dashboard:123";
    const store = createFakeStore({
      entries: {
        [TARGET]: { status: "running", updatedAt: 1, lifecycleRunId: RUN_ID },
        [ORIGIN]: { status: "running", updatedAt: 1, restartRecoveryDeliveryRunId: RUN_ID },
        // A live post-boot run must NOT be swept: updatedAt after cutoff.
        "agent:claude:dashboard:ff" : { status: "running", updatedAt: Date.now(), lifecycleRunId: "live" },
        [foreigner]: { status: "running", updatedAt: 1 },
        [foreign]: { status: "running", updatedAt: 1 },
      },
    });
    const result = await sweepOwnedStuckSessions({
      sessionStore: store,
      agentIds: ["claude"],
      cutoffMs: Date.now() - 1_000,
    });
    expect(result.settled.sort()).toEqual([ORIGIN, TARGET].sort());
    // Restart-orphan settle is honest about the outcome: the run predated the
    // boot → interrupted + abortedLastRun:true (host mark_interrupted parity).
    expect((store.entries[ORIGIN] as SettleSessionEntryLike).status).toBe("interrupted");
    expect((store.entries[ORIGIN] as SettleSessionEntryLike).abortedLastRun).toBe(true);
    expect((store.entries[ORIGIN] as SettleSessionEntryLike).restartRecoveryDeliveryRunId).toBeUndefined();
    expect((store.entries[foreigner] as SettleSessionEntryLike).status).toBe("running");
    expect((store.entries[foreign] as SettleSessionEntryLike).status).toBe("running");
    expect((store.entries["agent:claude:dashboard:ff"] as SettleSessionEntryLike).status).toBe("running");
  });

  it("γ archival leg (legacy mode): stamps archivedAt on settled/running pre-cutoff clones, never on live entries, categorized rows, or foreign keys", async () => {
    setDashboardBindingCloneAutoArchive(true);
    const foreigner = "agent:claude:subagent:abc:123";
    const categorizedClone = "agent:claude:acp:binding:webchat:default:cafebabedeadbeef";
    const liveClone = "agent:claude:acp:binding:webchat:default:feedface0011aa11";
    const doneClone = "agent:claude:acp:binding:telegram:default:0123abcd04ef5678";
    const store = createFakeStore({
      entries: {
        // Settled clone from a pre-γ boot → archived (no spawnedBy needed —
        // the key grammar is ownership proof enough).
        [doneClone]: { status: "done", endedAt: 5 },
        // Running orphan clone → archival + orphan settle.
        [TARGET]: { status: "running", updatedAt: 1 },
        // User-categorized clone → never archived.
        [categorizedClone]: { status: "done", category: "work" },
        // Live in-process run → untouched.
        [liveClone]: { status: "running", updatedAt: Date.now() },
        // Foreign key grammar → untouched.
        [foreigner]: { status: "done", endedAt: 5 },
        // Already archived → untouched (never un-archived / re-stamped).
        "agent:claude:acp:binding:webchat:default:aaaa0000bbbb1111": {
          status: "done",
          archivedAt: 7,
          archiveReason: "age-retention",
        },
      },
    });
    const result = await sweepOwnedStuckSessions({
      sessionStore: store,
      agentIds: ["claude"],
      cutoffMs: Date.now() - 1_000,
    });
    expect(result.archived.sort()).toEqual([doneClone, TARGET].sort());
    const doneEntry = store.entries[doneClone] as SettleSessionEntryLike;
    const targetEntry = store.entries[TARGET] as SettleSessionEntryLike;
    expect(typeof doneEntry.archivedAt).toBe("number");
    expect(doneEntry.archivedBy).toEqual({ type: "system", id: "acp-dashboard-binding" });
    expect(typeof targetEntry.archivedAt).toBe("number");
    expect(targetEntry.archivedBy).toEqual({ type: "system", id: "acp-dashboard-binding" });
    // Running orphan was ALSO settled (interrupted — boot interrupted it).
    expect(targetEntry.status).toBe("interrupted");
    expect((store.entries[categorizedClone] as SettleSessionEntryLike).archivedAt).toBeUndefined();
    expect((store.entries[liveClone] as SettleSessionEntryLike).archivedAt).toBeUndefined();
    expect((store.entries[foreigner] as SettleSessionEntryLike).archivedAt).toBeUndefined();
    expect((store.entries["agent:claude:acp:binding:webchat:default:aaaa0000bbbb1111"] as SettleSessionEntryLike).archivedAt).toBe(7);
    // Dashboard-origin conversations are NOT archival candidates.
    expect(
      store.patches.filter((p) => p.sessionKey === ORIGIN).every((p) => p.patch.archivedAt === undefined),
    ).toBe(true);
  });

  it("skips agents whose store listing fails and entries already settled", async () => {
    const store = createFakeStore({
      entries: {
        [ORIGIN]: { status: "done", endedAt: 5 },
      },
    });
    const result = await sweepOwnedStuckSessions({
      sessionStore: store,
      agentIds: ["claude", "codex"],
      cutoffMs: 0,
    });
    expect(result.settled).toEqual([]);
    expect(store.patches).toEqual([]);
  });
});
describe("BRIDGE §23 (native dispatch mode, reset-bug): no stamps in + boot un-archive heal", () => {
  beforeEach(() => setDashboardBindingDispatchMode("native"));
  afterEach(() => {
    resetDashboardBindingDispatchModeForTest();
    resetDashboardBindingCloneAutoArchiveForTest();
  });

  it("buildCloneHiddenPatch refuses NATIVE mode even with cloneAutoArchive:true (archived targets refuse dispatch)", () => {
    setDashboardBindingCloneAutoArchive(true);
    expect(buildCloneHiddenPatch({ status: "done", endedAt: 5 })).toBeNull();
  });

  it("sweep γ leg no-ops in native mode even with cloneAutoArchive:true", async () => {
    setDashboardBindingCloneAutoArchive(true);
    const store = createFakeStore({ entries: { [TARGET]: { status: "done", endedAt: 5 } } });
    const result = await sweepOwnedStuckSessions({
      sessionStore: store,
      agentIds: ["claude"],
      cutoffMs: Date.now() - 1_000,
    });
    expect(result.archived).toEqual([]);
    expect(store.patches).toEqual([]);
  });

  it("unarchiveOwnedLegacyStamps clears OUR stamps on clone and dashboard shapes", async () => {
    const stashClone = "agent:claude:acp:binding:webchat:default:60bac3d65e697154";
    const dashboard = "agent:claude:dashboard:3afa8a32-1111-2222-3333-444455556666";
    const store = createFakeStore({
      entries: {
        [stashClone]: {
          status: "done",
          archivedAt: 100,
          archivedBy: { type: "system", id: "acp-dashboard-binding" },
        },
        [dashboard]: {
          status: "done",
          archivedAt: 101,
          archivedBy: { type: "system", id: "acp-dashboard-binding" },
        },
      },
    });
    const result = await unarchiveOwnedLegacyStamps({
      sessionStore: store,
      agentIds: ["claude"],
    });
    expect(result.restored.sort()).toEqual([stashClone, dashboard].sort());
    for (const key of [stashClone, dashboard]) {
      const cleared = store.entries[key] as SettleSessionEntryLike;
      expect(Object.hasOwn(cleared, "archivedAt")).toBe(false);
      expect(Object.hasOwn(cleared, "archivedBy")).toBe(false);
    }
  });

  it("unarchiveOwnedLegacyStamps never touches foreign/manual archives or non-owned keys", async () => {
    const stashClone = "agent:claude:acp:binding:webchat:default:60bac3d65e697154";
    const foreign = `${stashClone.slice(0, -8)}aaaa0000`;
    const outside = "agent:claude:subagent:abc:123";
    const store = createFakeStore({
      entries: {
        [stashClone]: { status: "done", archivedAt: 50, archiveReason: "stale-dashboard" },
        [foreign]: { status: "done", archivedAt: 60, archivedBy: { type: "human" }, archiveReason: "manual" },
        [outside]: {
          status: "done",
          archivedAt: 70,
          archivedBy: { type: "system", id: "acp-dashboard-binding" },
        },
      },
    });
    const result = await unarchiveOwnedLegacyStamps({
      sessionStore: store,
      agentIds: ["claude"],
    });
    expect(result.restored).toEqual([]);
    expect(store.patches).toEqual([]);
    expect((store.entries[stashClone] as SettleSessionEntryLike).archivedAt).toBe(50);
    expect((store.entries[foreign] as SettleSessionEntryLike).archivedAt).toBe(60);
    expect((store.entries[outside] as SettleSessionEntryLike).archivedAt).toBe(70);
  });

  it("claim mode: the boot heal stands down (γ semantics unchanged there)", async () => {
    resetDashboardBindingDispatchModeForTest();
    const stashClone = "agent:claude:acp:binding:webchat:default:60bac3d65e697154";
    const store = createFakeStore({
      entries: {
        [stashClone]: {
          status: "done",
          archivedAt: 100,
          archivedBy: { type: "system", id: "acp-dashboard-binding" },
        },
      },
    });
    const result = await unarchiveOwnedLegacyStamps({
      sessionStore: store,
      agentIds: ["claude"],
    });
    expect(result.restored).toEqual([]);
    expect(store.patches).toEqual([]);
    expect((store.entries[stashClone] as SettleSessionEntryLike).archivedAt).toBe(100);
  });
});

describe("BRIDGE §23.2/V39 (native dispatch mode): unhideOverstampedCloneSessions", () => {
  beforeEach(() => setDashboardBindingDispatchMode("native"));
  afterEach(() => {
    resetDashboardBindingDispatchModeForTest();
    resetDashboardBindingCloneAutoArchiveForTest();
  });

  it("clears spawnedBy provenance stamps on clone grammar (real 5/5 stamp values are parent keys)", async () => {
    const stamped = "agent:claude:acp:binding:webchat:default:60bac3d65e697154";
    const store = createFakeStore({
      entries: {
        [stamped]: { status: "done", spawnedBy: "agent:claude:main" },
      },
    });
    const result = await unhideOverstampedCloneSessions({ sessionStore: store, agentIds: ["claude"] });
    expect(result.unhidden).toEqual([stamped]);
    const cleared = store.entries[stamped] as SettleSessionEntryLike;
    expect(cleared.spawnedBy).toBeUndefined();
  });

  it("leaves unstamped clones, dashboard rows, and non-clone grammar untouched", async () => {
    const stampedClone = "agent:claude:acp:binding:webchat:default:5b4952f61b67a9d1";
    const dashboard = "agent:claude:dashboard:21fac764-1420-4093-a37b-2db0d0a39d85";
    const subagent = "agent:claude:subagent:abc:123";
    const store = createFakeStore({
      entries: {
        [stampedClone]: { status: "done" },
        [dashboard]: { status: "done", spawnedBy: "agent:claude" },
        [subagent]: { status: "done", spawnedBy: "agent:claude" },
      },
    });
    const result = await unhideOverstampedCloneSessions({ sessionStore: store, agentIds: ["claude"] });
    expect(result.unhidden).toEqual([]);
    expect(store.patches).toEqual([]);
    // dashboard rows are predicate-hidden anyway (rest starts with dashboard:)
    // and subagent rows are real subagents — never our heal's business.
  });

  it("claim mode: the heal stands down (γ + provenance semantics unchanged there)", async () => {
    resetDashboardBindingDispatchModeForTest();
    const stamped = "agent:claude:acp:binding:webchat:default:60bac3d65e697154";
    const store = createFakeStore({ entries: { [stamped]: { status: "done", spawnedBy: "agent:claude:main" } } });
    const result = await unhideOverstampedCloneSessions({ sessionStore: store, agentIds: ["claude"] });
    expect(result.unhidden).toEqual([]);
    expect(store.patches).toEqual([]);
    expect((store.entries[stamped] as SettleSessionEntryLike).spawnedBy).toBe("agent:claude:main");
  });
});

describe("runBootHealWithRetries ([§23.3/.31] boot-heal retry driver)", () => {
  it("runs once and returns when the attempt completes without warns", async () => {
    const warns: string[] = [];
    const runs: string[][] = [];
    await runBootHealWithRetries({
      runOnce: async (logger) => {
        runs.push(["ok"]);
        logger.debug?.("fine");
      },
      logger: { warn: (m) => warns.push(m) },
      delaysMs: [0],
    });
    expect(runs).toEqual([["ok"]]);
    expect(warns).toEqual([]);
  });

  it("re-runs until an attempt is warn-free (agent stores unavailable at gateway_start, LIVE 2026-10-15)", async () => {
    const warns: string[] = [];
    let attempt = 0;
    const store = createFakeStore({
      entries: {
        "agent:claude:acp:binding:webchat:default:4b5b8fbd9d36116f": { status: "running", updatedAt: 1 },
      },
    });
    await runBootHealWithRetries({
      runOnce: async (logger) => {
        attempt += 1;
        if (attempt < 3) {
          logger.warn?.("[acp-dashboard-binding] settle of sweep session agent:claude:… failed — Agent claude has not completed startup inspection and preparation.");
          return;
        }
        await sweepOwnedStuckSessions({ sessionStore: store, agentIds: ["claude"], logger, cutoffMs: 100 });
      },
      logger: { warn: (m) => warns.push(m) },
      delaysMs: [0, 1, 1, 1],
    });
    expect(attempt).toBe(3);
    expect(store.patches).toEqual([expect.objectContaining({ sessionKey: "agent:claude:acp:binding:webchat:default:4b5b8fbd9d36116f" })]);
    // one incomplete-attempt warn per failed attempt (bounded retries)
    expect(warns.filter((m) => m.includes("boot heal incomplete"))).toEqual([
      "[acp-dashboard-binding] boot heal incomplete (attempt 1, 1 failed leg(s)) — retrying in 0s",
      "[acp-dashboard-binding] boot heal incomplete (attempt 2, 1 failed leg(s)) — retrying in 0s",
    ]);
  });

  it("catches thrown runOnce attempts like store failures and stops after the schedule is exhausted", async () => {
    const warns: string[] = [];
    let attempts = 0;
    await runBootHealWithRetries({
      runOnce: async () => {
        attempts += 1;
        throw new Error("Agent claude has not completed startup inspection and preparation.");
      },
      logger: { warn: (m) => warns.push(m) },
      delaysMs: [0, 1, 1],
    });
    expect(attempts).toBe(3);
    expect(warns.filter((m) => m.includes("boot heal attempt failed")).length).toBe(3);
    expect(warns.some((m) => m.includes("giving up"))).toBe(true);
  });
});
// (runBootHealWithRetries is imported with the other session-settle exports
// below — see the import block addition.)
