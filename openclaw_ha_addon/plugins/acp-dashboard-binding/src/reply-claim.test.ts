/**
 * Phase 2.20 (F4 reply-delivery gap) proof tests.
 *
 * Two host contracts the fix leans on, each verified here:
 *  1. Ownership: the synthesized binding records carry
 *     `pluginBindingOwner/pluginId/pluginRoot` exactly in the shape of the
 *     host's `isPluginOwnedBindingMetadata`
 *     (dist/conversation-binding-metadata-CFOhDjMh.mjs) — the predicate that
 *     makes dispatch-from-config skip retargeting (line 191) and claim through
 *     our inbound_claim hook instead.
 *  2. Reply: a claimed conversation receives its reply from the harness by the
 *     allowed agent-based spawn seam (Phase 3.1 Weg A) — `api.runtime.subagent`
 *     is NOT trust-gated (gateway.request IS; Phase 2.20's seam failed LIVE):
 *     run({sessionKey, message}) → {runId} starts the agent turn in the target
 *     session, waitForRun({runId}) returns the canonical wait result incl.
 *     terminalReply {disposition:"visible", text} → `{handled: true, reply}`.
 *     Before-start failures return `{handled: false}` (host falls through with
 *     its notice); after-start problems return handled:true with a notice so
 *     the origin dispatch cannot process the turn twice.
 *
 * Legacy-row upgrade: persisted pre-F4 rows (informative metadata only) are
 * upgraded at hydrate so a restart does not flip them back to the
 * reply-loss retarget path.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHANNEL_ID,
  buildAcpBindingSessionKey,
  getDashboardBindingPluginRoot,
  resetDashboardBindingPluginRootForTest,
  resetDashboardBindingProvisionerForTest,
  resetOriginWorkspaceReaderForTest,
  setDashboardBindingPluginRoot,
  setDashboardBindingProvisioner,
  setOriginWorkspaceReader,
} from "./agent-map.js";
import { createDashboardBindingAdapter, deriveDashboardBindingRecord } from "./binding-adapter.js";
import {
  createBridgeRowStore,
  createConfigHarnessRoster,
  resolveDashboardBinding,
  resolveDashboardBindingDecision,
  synthesizeDashboardBindingRecord,
  type KeyedStoreLike,
  type SessionBindingRecordLike,
} from "./dashboard-bridge.js";
import {
  createHarnessReplyClaimHandler,
  type HarnessSubagentApi,
  type InboundClaimContextLike,
  type InboundClaimEventLike,
} from "./reply-claim.js";

const DASHBOARD_UUID = "123e4567-e89b-12d3-a456-426614174000";
const CODEX_DASHBOARD_KEY = `agent:codex:dashboard:${DASHBOARD_UUID}`;
const PLUGIN_ROOT = "/config/.openclaw/plugins/acp-dashboard-binding";

function codexConfig() {
  return {
    agents: {
      entries: {
        codex: {
          runtime: { type: "acp", acp: { mode: "persistent", backend: "acpx", cwd: "/share/temp/codex" } },
        },
      },
    },
    plugins: {
      entries: {
        [CHANNEL_ID]: {
          config: { harnessSessions: { codex: "agent:codex:acp:26b6335a" } },
        },
      },
    },
  };
}

/** Mirrors the host predicate (conversation-binding-metadata-CFOhDjMh.mjs) 1:1. */
function isPluginOwnedSessionBindingRecordLike(record: SessionBindingRecordLike | null): boolean {
  if (!record) return false;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  return (
    !!metadata &&
    metadata.pluginBindingOwner === "plugin" &&
    typeof metadata.pluginId === "string" &&
    typeof metadata.pluginRoot === "string"
  );
}

const CODEX_REF = { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY };

/**
 * Phase 2.24 (Klon-Modus): der provisionierte Target-Key ist der Klon der
 * ORIGIN-Dashboard-Konversation (Host-Grammatik) — der cwd fließt NICHT in den
 * Key, nur in den Ensure-Spec.
 */
const CODEX_CLONE_KEY = buildAcpBindingSessionKey({
  channel: "webchat",
  accountId: "default",
  conversationId: CODEX_DASHBOARD_KEY,
  agentId: "codex",
});
/** The harnessSessions-override target codexConfig() dispatches to (tests). */
const CODEX_TEST_TARGET_KEY = "agent:codex:acp:26b6335a";

const claimContextCodex = (pluginRoot: string): InboundClaimContextLike => ({
  pluginBinding: {
    bindingId: `plugin-binding:derived:webchat:default:<hash>`,
    pluginId: CHANNEL_ID,
    pluginRoot,
    channel: "webchat",
    accountId: "default",
    conversationId: CODEX_DASHBOARD_KEY,
  },
});

const event: InboundClaimEventLike = { body: "Fix the login bug", content: "/fix-the-login-bug" };

describe("F4 reply-delivery fix — binding ownership", () => {
  afterEach(() => {
    resetDashboardBindingPluginRootForTest();
  });

  it("synthesized derived records satisfy the host plugin-owned metadata predicate", () => {
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
    expect(getDashboardBindingPluginRoot()).toBe(PLUGIN_ROOT);
    const record = deriveDashboardBindingRecord(CODEX_REF, codexConfig());
    expect(record).not.toBeNull();
    expect(isPluginOwnedSessionBindingRecordLike(record)).toBe(true);
    const metadata = record?.metadata as Record<string, unknown>;
    expect(metadata.pluginBindingOwner).toBe("plugin");
    expect(metadata.pluginId).toBe(CHANNEL_ID);
    expect(metadata.pluginRoot).toBe(PLUGIN_ROOT);
    // Informative fields survive alongside the ownership markers.
    expect(metadata.source).toBe("plugin:acp-dashboard-binding");
    expect(metadata.agentId).toBe("codex");
    expect(metadata.mode).toBe("persistent");
    expect(metadata.backend).toBe("acpx");
  });

  it("adapter records target the validated harnessSessions key and carry ownership", () => {
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
    const adapter = createDashboardBindingAdapter({
      channel: "webchat",
      accountId: "default",
      getConfig: () => codexConfig(),
    });
    const record = adapter.resolveByConversation(CODEX_REF);
    expect(record).not.toBeNull();
    expect(isPluginOwnedSessionBindingRecordLike(record)).toBe(true);
    // F3 Weg A target: the REAL spawned session (harnessSessions map).
    expect(record?.targetSessionKey).toBe("agent:codex:acp:26b6335a");
  });

  it("bridge Turn-1 synthesis carries ownership markers too", () => {
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
    const decision = resolveDashboardBindingDecision(CODEX_REF, createConfigHarnessRoster(codexConfig()));
    expect(decision).not.toBeNull();
    const record = synthesizeDashboardBindingRecord(decision!);
    expect(isPluginOwnedSessionBindingRecordLike(record)).toBe(true);
  });

  it("unset plugin root keeps records WITHOUT ownership markers (legacy retarget mode)", () => {
    resetDashboardBindingPluginRootForTest();
    expect(getDashboardBindingPluginRoot()).toBeNull();
    const record = deriveDashboardBindingRecord(CODEX_REF, codexConfig());
    expect(isPluginOwnedSessionBindingRecordLike(record)).toBe(false);
    // Target derivation itself is unchanged by the ownership fix (F3 Weg A).
    expect(record?.targetSessionKey).toBe("agent:codex:acp:26b6335a");
  });

  it("bridge row hydration upgrades pre-F4 rows to plugin-owned metadata", async () => {
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
    // A row persisted by an older plugin build: informative metadata only.
    const decision = resolveDashboardBindingDecision(CODEX_REF, createConfigHarnessRoster(codexConfig()));
    const legacyRecord = synthesizeDashboardBindingRecord(decision!);
    const legacyMetadata = { ...(legacyRecord.metadata as Record<string, unknown>) };
    delete legacyMetadata.pluginBindingOwner;
    delete legacyMetadata.pluginId;
    delete legacyMetadata.pluginRoot;
    const persistedRows: KeyedStoreLike<{ record: SessionBindingRecordLike }> = {
      registerIfAbsent: async () => false,
      lookup: async () => undefined,
      delete: async () => true,
      entries: async () => [
        { key: `row:${legacyRecord.bindingId}`, value: { record: { ...legacyRecord, metadata: legacyMetadata } } },
      ],
    };
    const store = createBridgeRowStore(persistedRows);
    await store.hydrate();
    const row = store.row(legacyRecord.bindingId);
    expect(row).not.toBeNull();
    expect(isPluginOwnedSessionBindingRecordLike(row)).toBe(true);
    expect(row?.metadata?.pluginId).toBe(CHANNEL_ID);
    expect(row?.metadata?.pluginRoot).toBe(PLUGIN_ROOT);
    // The shared resolver sees the upgraded row (host stability check parity).
    const shared = await resolveDashboardBinding(CODEX_REF, { roster: createConfigHarnessRoster(codexConfig()), store });
    expect(isPluginOwnedSessionBindingRecordLike(shared)).toBe(true);
  });
});

describe("F4 reply-delivery fix — inbound_claim dispatch (Weg A: subagent surface)", () => {
  /** Subagent turn recorder standing in for `api.runtime.subagent`. */
  function stubSubagent(
    runBehavior: (params: { sessionKey: string; message: string }) => Promise<{ runId?: string }>,
    waitBehavior: (params: { runId: string }) => Promise<Record<string, unknown>>,
  ): { subagent: HarnessSubagentApi; runCalls: Array<{ sessionKey: string; message: string }>; waitCalls: Array<{ runId: string; timeoutMs?: number }> } {
    const runCalls: Array<{ sessionKey: string; message: string }> = [];
    const waitCalls: Array<{ runId: string; timeoutMs?: number }> = [];
    const subagent: HarnessSubagentApi = {
      run: async (params) => {
        runCalls.push(params);
        return await runBehavior(params);
      },
      waitForRun: async (params) => {
        waitCalls.push(params);
        return (await waitBehavior(params)) as never;
      },
    };
    return { subagent, runCalls, waitCalls };
  }

  /**
   * §19 test seam: in-memory session store with the settle/stamp read+patch
   * surface, pre-seeded with the running origin/clone entries a claimed turn
   * leaves in evidence (99d8daf5/4fbefeb9 live-DB shapes).
   */
  function fakeClaimStore(): {
    store: {
      getSessionEntry: (params: { sessionKey: string }) => unknown;
      patchSessionEntry: (params: {
        sessionKey: string;
        update: (entry: unknown) => unknown;
      }) => Promise<unknown>;
    };
    patches: Array<{ sessionKey: string; patch: Record<string, unknown> }>;
  } {
    const entries: Record<string, Record<string, unknown>> = {
      [CODEX_DASHBOARD_KEY]: { status: "running", startedAt: 1000 },
      [CODEX_TEST_TARGET_KEY]: { status: "running" },
    };
    const patches: Array<{ sessionKey: string; patch: Record<string, unknown> }> = [];
    return {
      patches,
      store: {
        getSessionEntry: ({ sessionKey }) => entries[sessionKey],
        patchSessionEntry: async ({ sessionKey, update }) => {
          const patch = update(entries[sessionKey] ?? {});
          if (patch) {
            patches.push({ sessionKey, patch: patch as Record<string, unknown> });
            Object.assign(entries[sessionKey] ?? {}, patch);
          }
          return entries[sessionKey] ?? null;
        },
      },
    };
  }

  beforeEach(() => {
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
  });
  afterEach(() => {
    resetDashboardBindingPluginRootForTest();
  });

  it("claim via the allowed subagent API starts the turn and delivers the harness reply", async () => {
    const { subagent, runCalls, waitCalls } = stubSubagent(
      async (params) => {
        expect(params).toEqual({ sessionKey: "agent:codex:acp:26b6335a", message: "Fix the login bug" });
        return { runId: "run-1", sessionKey: "agent:codex:acp:26b6335a" };
      },
      async (params) => {
        expect(params).toEqual({ runId: "run-1", timeoutMs: 120_000 });
        return { status: "ok", terminalReply: { disposition: "visible", text: "Fixed the login bug." } };
      },
    );
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      subagent,
      isGatewayAvailable: async () => true,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    // Terminal reply delivered through the claim RESULT (host deliverBindingPayload).
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("Fixed the login bug.");
    expect(runCalls.map((c) => c.sessionKey)).toEqual(["agent:codex:acp:26b6335a"]);
    expect(waitCalls.map((c) => c.runId)).toEqual(["run-1"]);
  });

  it("run error surfaces as handled:true error reply (no double processing)", async () => {
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stubSubagent(
        async () => ({ runId: "run-2" }),
        async () => ({ status: "error", error: "provider exploded" }),
      ).subagent,
      isGatewayAvailable: async () => true,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(result.handled).toBe(true);
    expect(result.reply?.isError).toBe(true);
    expect(result.reply?.text).toContain("failed in `agent:codex:acp:26b6335a`");
    expect(result.reply?.text).toContain("provider exploded");
  });

  it("wait timeout and pending return handled:true with the still-running notice", async () => {
    for (const status of ["timeout", "pending"]) {
      const handler = createHarnessReplyClaimHandler({
        getConfig: () => codexConfig(),
        subagent: stubSubagent(async () => ({ runId: "run-3" }), async () => ({ status })).subagent,
        isGatewayAvailable: async () => true,
      });
      const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
      expect(result.handled).toBe(true);
      expect(result.reply?.isError).toBeUndefined();
      expect(result.reply?.text).toContain("still running");
    }
  });

  it("turn-start failure (e.g. trust/scope error) falls back handled:false", async () => {
    // The pre-fix LIVE trust error — any run-start rejection must keep the
    // host fallback (notice + normal origin processing), never claim blindly.
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stubSubagent(async () => {
        throw new Error(
          'Gateway requests are only available to bundled or trusted official plugins. Plugin "acp-dashboard-binding"',
        );
      }, async () => {
        throw new Error("must not be called");
      }).subagent,
      isGatewayAvailable: async () => true,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(result).toEqual({ handled: false });
  });

  it("gateway binding unavailable returns handled:false (preflight, un-gated isAvailable)", async () => {
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stubSubagent(async () => {
        throw new Error("must not be called");
      }, async () => ({})).subagent,
      isGatewayAvailable: async () => false,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(result).toEqual({ handled: false });
  });

  it("missing ack runId returns handled:false (no turn started)", async () => {
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stubSubagent(async () => ({}), async () => ({})).subagent,
      isGatewayAvailable: async () => true,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(result).toEqual({ handled: false });
  });

  it("missing subagent surface returns handled:false", async () => {
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      isGatewayAvailable: async () => true,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(result).toEqual({ handled: false });
  });

  it("foreign plugin binding and missing claims never claim", async () => {
    const { subagent, runCalls } = stubSubagent(async () => ({ runId: "run-x" }), async () => ({}));
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent,
      isGatewayAvailable: async () => true,
    });
    const foreign = await handler(event, {
      pluginBinding: {
        pluginId: "some-other-plugin",
        pluginRoot: PLUGIN_ROOT,
        channel: "webchat",
        accountId: "default",
        conversationId: CODEX_DASHBOARD_KEY,
      },
    });
    expect(foreign).toEqual({ handled: false });
    const noBinding = await handler(event, {});
    expect(noBinding).toEqual({ handled: false });
    expect(runCalls).toEqual([]);
  });

  it("de-rostered conversation falls back without dispatching", async () => {
    const { subagent, runCalls } = stubSubagent(async () => ({ runId: "run-y" }), async () => ({}));
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent,
      isGatewayAvailable: async () => true,
    });
    // main is an orchestrator id (safe-default exclusion — never rostered).
    const claimContextRosteredOut: InboundClaimContextLike = {
      pluginBinding: {
        pluginId: CHANNEL_ID,
        pluginRoot: PLUGIN_ROOT,
        channel: "webchat",
        accountId: "default",
        conversationId: `agent:main:dashboard:${DASHBOARD_UUID}`,
      },
    };
    const result = await handler(event, claimContextRosteredOut);
    expect(result).toEqual({ handled: false });
    expect(runCalls).toEqual([]);
  });

  it("waitForRun throwing is reported as handled:true wait-failure notice", async () => {
    // §19a: even on the wait-failure edge the fallback reply terminates the
    // ORIGIN dispatch — the origin node must settle (nonterminal: clone not).
    const store = fakeClaimStore();
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stubSubagent(async () => ({ runId: "run-4" }), async () => {
        throw new Error("gateway timeout");
      }).subagent,
      isGatewayAvailable: async () => true,
      // Collapsed backoff — exhausts retries fast; the notice still wins.
      waitRetryDelaysMs: [0, 0, 0, 0],
      sessionStore: store.store,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toContain("waiting for its reply failed");
    expect(result.reply?.text).toContain("gateway timeout");
    const originSettle = store.patches.filter((p) => p.sessionKey === CODEX_DASHBOARD_KEY);
    expect(originSettle).toHaveLength(1);
    // The wait was cut short (never terminal) → interrupted, host
    // mark_interrupted parity: abortedLastRun goes true.
    expect(originSettle[0]!.patch.status).toBe("interrupted");
    expect(originSettle[0]!.patch.abortedLastRun).toBe(true);
    // V39 stamp on the TARGET fired (this test config dispatches to the
    // harnessSessions key, not the derived clone key), but the target itself
    // was NOT settled (the wait never went terminal — the run may still go).
    const targetPatches = store.patches.filter(
      (p) => p.sessionKey === CODEX_TEST_TARGET_KEY,
    );
    expect(targetPatches).toHaveLength(1);
    expect(targetPatches[0]!.patch.spawnedBy).toBe(CODEX_DASHBOARD_KEY);
    expect(targetPatches.some((p) => p.patch.status === "done")).toBe(false);
  });

  // --- Phase 3.5: ack-precedes-registration race (observed live, ~200 ms) ----
  describe("waitForRun registration-lag retry (Phase 3.5)", () => {
    it("retries a FAST wait failure until the run is registered → real answer delivered", async () => {
      let waitCalls = 0;
      const { subagent, runCalls } = stubSubagent(
        async () => ({ runId: "run-race" }),
        async () => {
          waitCalls += 1;
          if (waitCalls <= 2) throw new Error("run not found (not yet registered)");
          return { status: "ok", terminalReply: { disposition: "visible", text: "the real harness answer" } };
        },
      );
      const handler = createHarnessReplyClaimHandler({
        getConfig: () => codexConfig(),
        subagent,
        isGatewayAvailable: async () => true,
        waitRetryDelaysMs: [1, 1, 1, 1],
      });
      const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
      expect(result.handled).toBe(true);
      expect(result.reply?.text).toBe("the real harness answer");
      expect(waitCalls).toBe(3);
      expect(runCalls).toHaveLength(1); // never re-dispatched (no dup turn)
    });

    it("does NOT retry a SLOW wait failure (genuine API failure → notice)", async () => {
      const waitCalls: number[] = [];
      const { subagent } = stubSubagent(
        async () => ({ runId: "run-slow" }),
        async (params) => {
          waitCalls.push(params.runId ? waitCalls.length : -1);
          // Simulate a call that hung ~its whole wait budget before throwing.
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw new Error("agent.wait stream aborted");
        },
      );
      const handler = createHarnessReplyClaimHandler({
        getConfig: () => codexConfig(),
        subagent,
        isGatewayAvailable: async () => true,
        waitRetryDelaysMs: [1, 1, 1, 1],
        // Small call budget so the 30 ms "slow" call clears it deterministically.
        waitRetryCallBudgetMs: 10,
      });
      const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
      expect(result.handled).toBe(true);
      expect(result.reply?.text).toContain("waiting for its reply failed");
      // Exactly ONE failed call — no registration-lag retries for slow throws.
      expect(waitCalls).toHaveLength(1);
    });
  });
});
// --- Phase 2.21: auto-provisioning barrier (GaRoN 12:30) --------------------
describe("inbound_claim: auto-provisioning barrier (Phase 2.21)", () => {
  const autoProvisionConfig = () => ({
    agents: {
      entries: {
        codex: {
          runtime: { type: "acp", acp: { mode: "persistent", backend: "acpx", cwd: "/config/clawd/agents/codex" } },
        },
      },
    },
  });

  afterEach(() => {
    resetDashboardBindingProvisionerForTest();
  });

  function stubRunRecording(sessionKeys: string[]): HarnessSubagentApi {
    const subagent: HarnessSubagentApi = {
      run: async (params) => {
        sessionKeys.push(params.sessionKey);
        return { runId: "run-p", sessionKey: params.sessionKey };
      },
      waitForRun: async () => ({ status: "ok", terminalReply: { disposition: "visible", text: "harness ready" } }) as never,
    };
    return subagent;
  }

  it("Barrier: in-flight Provisioning wird VOR dem Turn abgewartet (deterministischer target, run erst nach Ensure)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    setDashboardBindingProvisioner(async (params) => {
      events.push(`ensure-start:${params.targetSessionKey}`);
      await gate;
      events.push("ensure-done");
    });
    const runKeys: string[] = [];
    const subagent = stubRunRecording(runKeys);
    // Run-Recorder loggt ebenfalls, damit die Reihenfolge beweisbar ist.
    subagent.run = async (params) => {
      events.push(`run:${params.sessionKey}`);
      runKeys.push(params.sessionKey);
      return { runId: "run-p", sessionKey: params.sessionKey };
    };
    const handler = createHarnessReplyClaimHandler({
      getConfig: autoProvisionConfig,
      subagent,
      isGatewayAvailable: async () => true,
    });
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
    const claimed = handler(event, claimContextCodex(PLUGIN_ROOT));
    let settled = false;
    void claimed.then(() => { settled = true; });
    // Ensure hängt am Gate; der Claim wartet (kann nicht abschließen, BEVOR der
    // Ensure fertig ist — genau die Barrier-Semantik).
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Phase 2.24: der Target ist der Klon-Key der origin Dashboard-Konversation.
    const provKey = CODEX_CLONE_KEY;
    expect(events).toEqual([`ensure-start:${provKey}`]);
    expect(settled).toBe(false);
    release();
    const result = await claimed;
    expect(events).toEqual([
      `ensure-start:${provKey}`,
      "ensure-done",
      `run:${provKey}`,
    ]);
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("harness ready");
  });

  it("Fehlgeschlagene Provisionierung blockiert den Claim NICHT (Run startet, Host-Fehler wird sichtbar)", async () => {
    setDashboardBindingProvisioner(async () => {
      throw new Error("acp backend not configured");
    });
    const runKeys: string[] = [];
    const subagent = stubRunRecording(runKeys);
    const handler = createHarnessReplyClaimHandler({
      getConfig: autoProvisionConfig,
      subagent,
      isGatewayAvailable: async () => true,
    });
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(runKeys).toEqual([CODEX_CLONE_KEY]);
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("harness ready");
  });

  it("autoProvision:false → Barrier/Provision-Seam unangetastet, Target bleibt synthetisch", async () => {
    let ensureKicks = 0;
    setDashboardBindingProvisioner(async () => {
      ensureKicks += 1;
    });
    const runKeys: string[] = [];
    const subagent = stubRunRecording(runKeys);
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => ({
        ...autoProvisionConfig(),
        plugins: { entries: { [CHANNEL_ID]: { config: { autoProvision: false } } } },
      }),
      subagent,
      isGatewayAvailable: async () => true,
    });
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(runKeys).toHaveLength(1);
    // Phase 2.24: ohne Provisionierung synthetisiert die Kaskade denselben
    // Klon-Key-Grammatik-Key (nur OHNE den Host-Ensure/metadata.provisioned) —
    // der Barrier/ensure-Seam bleibt vollständig unangetastet.
    expect(runKeys[0]).toBe(CODEX_CLONE_KEY);
    expect(ensureKicks).toBe(0);
    expect(result.handled).toBe(true);
  });

  // --- Phase 2.22/2.24: origin-workspace cwd → cwd im Ensure-Spec, NICHT im Key ---
  it("Barrier mit Origin-cwd: Ensure wartet am Claim-Gate, Turn startet im Klon-Key (cwd nur im Ensure-Spec)", async () => {
    const ORIGIN_CWD = "/share/projekte/github/openclaw-ha-addon";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    setDashboardBindingProvisioner(async (params) => {
      events.push(`ensure-start:${params.targetSessionKey}:${params.spec.cwd}`);
      await gate;
      events.push("ensure-done");
    });
    setOriginWorkspaceReader(() => ({ projectId: "openclaw-ha-addon", sessionRoot: ORIGIN_CWD }));
    try {
      const runKeys: string[] = [];
      const subagent = stubRunRecording(runKeys);
      subagent.run = async (params) => {
        events.push(`run:${params.sessionKey}`);
        runKeys.push(params.sessionKey);
        return { runId: "run-p", sessionKey: params.sessionKey };
      };
      const handler = createHarnessReplyClaimHandler({
        getConfig: autoProvisionConfig,
        subagent,
        isGatewayAvailable: async () => true,
      });
      setDashboardBindingPluginRoot(PLUGIN_ROOT);
      const claimed = handler(event, claimContextCodex(PLUGIN_ROOT));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // Der Ensure läuft am Klon-Key mit dem ORIGIN-cwd im Spec — und der Claim
      // wartet (Barrier keyed auf den target key, nicht agentId). Der Key bleibt
      // exakt der Klon der origin Konversation: der cwd fließt NICHT in den Key.
      expect(events).toEqual([`ensure-start:${CODEX_CLONE_KEY}:${ORIGIN_CWD}`]);
      release();
      const result = await claimed;
      expect(events).toEqual([
        `ensure-start:${CODEX_CLONE_KEY}:${ORIGIN_CWD}`,
        "ensure-done",
        `run:${CODEX_CLONE_KEY}`,
      ]);
      expect(runKeys).toEqual([CODEX_CLONE_KEY]);
      expect(result.handled).toBe(true);
    } finally {
      resetOriginWorkspaceReaderForTest();
    }
  });
});

// --- Phase 2.24b: MAIN-Klon (GaRoN 06:26 'B GO') — die MAIN-Konversation des
// Roster-agents kommt durch denselben Claim-Pfad wie die Dashboard-Klone.
describe("inbound_claim: MAIN-Klon barrier (Phase 2.24b)", () => {
  const MAIN_KEY = "agent:claude:main";
  // Der "Nachtklassiker" (live-verifiziert): sha16("webchat:default:agent:claude:main").
  const CLAUDE_MAIN_CLONE_KEY = buildAcpBindingSessionKey({
    channel: "webchat",
    accountId: "default",
    conversationId: MAIN_KEY,
    agentId: "claude",
  });

  const claudeConfig = () => ({
    agents: {
      entries: {
        claude: {
          runtime: { type: "acp", acp: { mode: "persistent", backend: "acpx", cwd: "/config/clawd/agents/claude" } },
        },
      },
    },
  });

  const claimContextClaude = (): InboundClaimContextLike => ({
    pluginBinding: {
      bindingId: "plugin-binding:derived:webchat:default:<hash>",
      pluginId: CHANNEL_ID,
      pluginRoot: PLUGIN_ROOT,
      channel: "webchat",
      accountId: "default",
      conversationId: MAIN_KEY,
    },
  });

  afterEach(() => {
    resetDashboardBindingProvisionerForTest();
    resetOriginWorkspaceReaderForTest();
  });

  it("MAIN-Klon: Barrier keyed auf den Klon-Key (raw-key-Pfad unverändert), Turn startet im Ziel", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: string[] = [];
    setDashboardBindingProvisioner(async (params) => {
      events.push(`ensure-start:${params.targetSessionKey}`);
      await gate;
      events.push("ensure-done");
    });
    const subagent: HarnessSubagentApi = {
      run: async (params) => {
        events.push(`run:${params.sessionKey}`);
        return { runId: "run-main", sessionKey: params.sessionKey };
      },
      waitForRun: async () =>
        ({ status: "ok", terminalReply: { disposition: "visible", text: "main ready" } }) as never,
    };
    const handler = createHarnessReplyClaimHandler({
      getConfig: claudeConfig,
      subagent,
      isGatewayAvailable: async () => true,
    });
    // Kein Plugin-Root-Set nötig: der Claim liest die conversation aus
    // ctx.pluginBinding — ownership-Marker im Record sind hier orthogonal.
    const claimed = handler(event, claimContextClaude());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // Der Ensure hängt am Gate: der Claim wartet (Barrier), kein run-Start.
    expect(events).toEqual([`ensure-start:${CLAUDE_MAIN_CLONE_KEY}`]);
    release();
    const result = await claimed;
    expect(events).toEqual([
      `ensure-start:${CLAUDE_MAIN_CLONE_KEY}`,
      "ensure-done",
      `run:${CLAUDE_MAIN_CLONE_KEY}`,
    ]);
    // Der Nachtklassiker LITERALLY: `agent:claude:acp:binding:webchat:default:60bac3d65e697154`.
    expect(CLAUDE_MAIN_CLONE_KEY).toBe("agent:claude:acp:binding:webchat:default:60bac3d65e697154");
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("main ready");
  });

  it("MAIN-Klon mit bindMainSessions:false → Claim nicht übernommen (handled:false), kein Ensure, kein Run", async () => {
    const eventsNoBind: string[] = [];
    setDashboardBindingProvisioner(async (params) => {
      eventsNoBind.push(`ensure-start:${params.targetSessionKey}`);
    });
    const subagent: HarnessSubagentApi = {
      run: async () => {
        eventsNoBind.push("run");
        return { runId: "run-should-not-happen" };
      },
      waitForRun: async () => ({ status: "error" }) as never,
    };
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => ({
        ...claudeConfig(),
        plugins: { entries: { [CHANNEL_ID]: { config: { bindMainSessions: false } } } },
      }),
      subagent,
      isGatewayAvailable: async () => true,
    });
    const result = await handler(event, claimContextClaude());
    expect(eventsNoBind).toEqual([]);
    expect(result.handled).toBe(false);
  });
});

describe("Punkt 1 (BRIDGE §17) — post-settle yield before terminal reply", () => {
  beforeEach(() => {
    setDashboardBindingPluginRoot(PLUGIN_ROOT);
  });
  afterEach(() => {
    resetDashboardBindingPluginRootForTest();
  });

  /** Minimal run/wait recorder (local copy; stubSubagent lives in the F4 describe). */
  function stub(behavior: () => Promise<Record<string, unknown>> | Promise<never>): HarnessSubagentApi {
    return {
      run: async () => ({ runId: "run-yield" }),
      waitForRun: async () => (await behavior()) as never,
    };
  }
  const okReply = (text: string) => ({ status: "ok", terminalReply: { disposition: "visible", text } });

  it("terminal ok reply yields the configured window before returning", async () => {
    const started = Date.now();
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stub(async () => okReply("fertig")),
      isGatewayAvailable: async () => true,
      postSettleYieldMs: 100,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("fertig");
  });

  it("nonterminal wait (pending) skips the yield — no terminal write is scheduled", async () => {
    const started = Date.now();
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stub(async () => ({ status: "pending" })),
      isGatewayAvailable: async () => true,
      postSettleYieldMs: 100,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toContain("still running after the wait window");
  });

  it("timeout wait skips the yield", async () => {
    const started = Date.now();
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stub(async () => ({ status: "timeout" })),
      isGatewayAvailable: async () => true,
      postSettleYieldMs: 100,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.reply?.text).toContain("still running after the wait window");
  });

  it("waitForRun failure (no terminal wait result) skips the yield", async () => {
    const started = Date.now();
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stub(async () => {
        throw new Error("wait API gone");
      }),
      isGatewayAvailable: async () => true,
      waitRetryDelaysMs: [1, 1, 1, 1],
      postSettleYieldMs: 100,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toContain("waiting for its reply failed");
  });

  it("non-finite/negative yield disables the window", async () => {
    const started = Date.now();
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stub(async () => okReply("fix")),
      isGatewayAvailable: async () => true,
      postSettleYieldMs: -1,
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(Date.now() - started).toBeLessThan(100);
    expect(result.reply?.text).toBe("fix");
  });
});
