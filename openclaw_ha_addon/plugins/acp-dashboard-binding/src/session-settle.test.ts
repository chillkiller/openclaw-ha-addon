/**
 * BRIDGE §19 tests: claim-path settlements (origin/clone session-node terminal
 * patches), the V39 spawnedBy stamp, and the boot sweep. The store is a fake
 * plugin-sdk session-store-runtime (same public/patch semantics the live
 * module projects: update callback runs against the CURRENT entry, returning
 * null = no write).
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildClaimSettlePatch,
  settleClaimedTurnSessions,
  stampSubagentProvenance,
  sweepOwnedStuckSessions,
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
  it("stamps spawnedBy = <origin key> on the clone entry (ControlUI excludeSubagents leg)", async () => {
    const store = createFakeStore({ entries: { [TARGET]: { status: "running" } } });
    const stamped = await stampSubagentProvenance({
      sessionStore: store,
      targetSessionKey: TARGET,
      originSessionKey: ORIGIN,
    });
    expect(stamped).toBe(true);
    expect((store.entries[TARGET] as SettleSessionEntryLike).spawnedBy).toBe(ORIGIN);
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

describe("BRIDGE §19c: sweepOwnedStuckSessions", () => {
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
    expect((store.entries[ORIGIN] as SettleSessionEntryLike).status).toBe("done");
    expect((store.entries[ORIGIN] as SettleSessionEntryLike).restartRecoveryDeliveryRunId).toBeUndefined();
    expect((store.entries[foreigner] as SettleSessionEntryLike).status).toBe("running");
    expect((store.entries[foreign] as SettleSessionEntryLike).status).toBe("running");
    expect((store.entries["agent:claude:dashboard:ff"] as SettleSessionEntryLike).status).toBe("running");
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