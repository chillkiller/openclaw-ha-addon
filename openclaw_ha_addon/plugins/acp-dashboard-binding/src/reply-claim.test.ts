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
  buildHarnessProvisionedSessionKey,
  getDashboardBindingPluginRoot,
  resetDashboardBindingPluginRootForTest,
  resetDashboardBindingProvisionerForTest,
  setDashboardBindingPluginRoot,
  setDashboardBindingProvisioner,
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
    const handler = createHarnessReplyClaimHandler({
      getConfig: () => codexConfig(),
      subagent: stubSubagent(async () => ({ runId: "run-4" }), async () => {
        throw new Error("gateway timeout");
      }).subagent,
      isGatewayAvailable: async () => true,
      // Collapsed backoff — exhausts retries fast; the notice still wins.
      waitRetryDelaysMs: [0, 0, 0, 0],
    });
    const result = await handler(event, claimContextCodex(PLUGIN_ROOT));
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toContain("waiting for its reply failed");
    expect(result.reply?.text).toContain("gateway timeout");
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
    setDashboardBindingProvisioner(async (spec, targetSessionKey) => {
      events.push(`ensure-start:${targetSessionKey}`);
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
    const provKey = buildHarnessProvisionedSessionKey({ agentId: "codex" });
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
    expect(runKeys).toEqual([buildHarnessProvisionedSessionKey({ agentId: "codex" })]);
    expect(result.handled).toBe(true);
    expect(result.reply?.text).toBe("harness ready");
  });

  it("autoProvision:false → Barrier/Provision-Seam unangetastet, Target bleibt synthetisch", async () => {
    setDashboardBindingProvisioner(async () => {});
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
    expect(runKeys[0]).not.toBe(buildHarnessProvisionedSessionKey({ agentId: "codex" }));
    expect(result.handled).toBe(true);
  });
});
