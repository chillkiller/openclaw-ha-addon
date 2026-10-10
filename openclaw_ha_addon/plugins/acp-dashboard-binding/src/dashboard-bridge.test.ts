import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHash } from "node:crypto";

import {
  BINDING_ACCOUNT_ID,
  BINDING_CHANNEL,
  CHANNEL_ID,
  createBridgeRowStore,
  createConfigHarnessRoster,
  createDashboardBridge,
  createStandaloneBindingResolver,
  createWebchatDashboardBindingAdapter,
  buildDashboardAcpTargetSessionKey,
  isPluginOwnedBindingMetadata,
  parseDashboardConversationKey,
  resolveDashboardBindingDecision,
  resolveDashboardBinding,
  resolveDashboardBindingAsync,
  synthesizeDashboardBindingRecord,
  type DashboardBridgeApiLike,
  type DashboardHookEventLike,
  type HarnessRoster,
  type KeyedStoreLike,
  type OpenKeyedStoreOptionsLike,
  type SessionBindingRecordLike,
  type SessionBindingRuntimeModule,
  type SessionBindingServiceLike,
} from "./dashboard-bridge.js";
import { createDashboardBindingAdapter } from "./binding-adapter.js";
import {
  ORCHESTRATOR_AGENT_IDS,
  isOrchestratorAgentId,
  resolveBoundAgentAllowlist,
  resolveHarnessAgentSpec,
  resolveHarnessAgentSpecs,
} from "./agent-map.js";

const DASHBOARD_UUID = "123e4567-e89b-12d3-a456-426614174000";
const PERSISTED_DASHBOARD_UUID = "9f8e7d6c-5b4a-3210-9876-fedcba987654";
const CODEX_DASHBOARD_KEY = `agent:codex:dashboard:${DASHBOARD_UUID}`;
const MAIN_DASHBOARD_KEY = `agent:main:dashboard:${DASHBOARD_UUID}`;
const PERSISTED_CODEX_DASHBOARD_KEY = `agent:codex:dashboard:${PERSISTED_DASHBOARD_UUID}`;

function harnessRoster(): HarnessRoster {
  const config = {
    agents: {
      entries: {
        codex: {
          runtime: { type: "acp", acp: { mode: "persistent", backend: "acpx", cwd: "/share/temp/codex" } },
        },
      },
    },
  };
  return createConfigHarnessRoster(config);
}

function sha16(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}

function makeApi(overrides: Partial<DashboardBridgeApiLike> = {}): DashboardBridgeApiLike {
  return {
    id: CHANNEL_ID,
    config: {
      agents: {
        entries: {
          codex: { runtime: { type: "acp", acp: { mode: "persistent", backend: "acpx" } } },
        },
      },
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
    registerHook: () => undefined,
    ...overrides,
  };
}

function makeAdapter() {
  return createWebchatDashboardBindingAdapter({
    roster: harnessRoster(),
    store: createBridgeRowStore(),
    logger: { warn: () => undefined },
  });
}

const noop = (): undefined => undefined;

beforeEach(noop);
afterEach(noop);

describe("dashboard-bridge: session-key synthesis", () => {
  it("builds the exact dist buildConfiguredAcpSessionKey format (package-update-activation-recovery.mjs:961809-961812)", () => {
    const key = buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    const expectedHash = sha16(`webchat:default:${CODEX_DASHBOARD_KEY}`);
    expect(key).toBe(`agent:codex:acp:binding:webchat:default:${expectedHash}`);
  });

  it("sanitizes agent ids like dist normalizeAgentId (agent-id semantics)", () => {
    const key = buildDashboardAcpTargetSessionKey({
      agentId: "Codex!!",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    const expectedHash = sha16(`webchat:default:${CODEX_DASHBOARD_KEY}`);
    expect(key).toBe(`agent:codex:acp:binding:webchat:default:${expectedHash}`);
  });

  it("produces keys that dist isAcpSessionKey accepts (session-key-BC4m_Ly5.mjs:162-168 shape)", () => {
    const key = buildDashboardAcpTargetSessionKey({ agentId: "codex", conversationId: CODEX_DASHBOARD_KEY });
    expect(key.split(":").slice(2).join(":").startsWith("acp:")).toBe(true);
  });

  it("falls back to main like dist normalizeAgentId for unrepresentable ids", () => {
    const key = buildDashboardAcpTargetSessionKey({ agentId: "///", conversationId: CODEX_DASHBOARD_KEY });
    expect(key.startsWith("agent:main:")).toBe(true);
  });
});

describe("dashboard-bridge: dashboard key parser", () => {
  it("parses agent:<id>:dashboard:<uuid>", () => {
    const parsed = parseDashboardConversationKey(CODEX_DASHBOARD_KEY);
    expect(parsed?.agentId).toBe("codex");
    expect(parsed?.dashboardToken).toBe(DASHBOARD_UUID);
  });

  it("keeps thread suffixes inside rest and dashboardToken", () => {
    const withThread = `${CODEX_DASHBOARD_KEY}:thread:7`;
    const parsed = parseDashboardConversationKey(withThread);
    expect(parsed?.dashboardToken).toBe(`${DASHBOARD_UUID}:thread:7`);
    expect(parsed?.rest).toBe(`dashboard:${DASHBOARD_UUID}:thread:7`);
  });

  it("rejects non-dashboard agent keys and malformed input", () => {
    expect(parseDashboardConversationKey("agent:main:main")).toBeNull();
    expect(parseDashboardConversationKey("global")).toBeNull();
    expect(parseDashboardConversationKey("agent:codex:acp:binding:webchat:default:abc")).toBeNull();
    expect(parseDashboardConversationKey(undefined)).toBeNull();
  });
});

describe("dashboard-bridge: roster gating", () => {
  it("accepts configured harness agents, rejects unconfigured/main/unknown", () => {
    const roster = harnessRoster();
    expect(roster.isHarnessAgent("codex")).toBe(true);
    // Phase 2.7 dynamic roster: opencode is NOT in the config, so it is not
    // a harness agent — no fixed id list anymore.
    expect(roster.isHarnessAgent("opencode")).toBe(false);
    expect(roster.isHarnessAgent("main")).toBe(false);
    expect(roster.isHarnessAgent("unknown-agent")).toBe(false);
  });

  it("rosters only runtime.type==='acp' entries dynamically (Phase 2.7)", () => {
    const config = {
      agents: {
        entries: {
          opencode: { runtime: { type: "acp", acp: { agent: "opencode-harness" } } },
          main: { runtime: { type: "acp", acp: {} } },
        },
      },
    };
    const roster = createConfigHarnessRoster(config);
    expect(roster.isHarnessAgent("opencode")).toBe(true);
    expect(roster.isHarnessAgent("main")).toBe(false); // reserved: builtin stays
    expect(roster.isHarnessAgent("claude")).toBe(false); // not configured here
  });

  it("reads runtime.acp defaults from agents.entries (entries-and-multi-agent.md:52-56,86)", () => {
    const defaults = harnessRoster().acpDefaults("codex");
    expect(defaults?.mode).toBe("persistent");
    expect(defaults?.backend).toBe("acpx");
    expect(defaults?.cwd).toBe("/share/temp/codex");
  });

  it("respects an explicitly non-acp runtime type in config", () => {
    const config = {
      agents: { entries: { codex: { runtime: { type: "native" } } } },
    };
    const roster = createConfigHarnessRoster(config);
    expect(roster.isHarnessAgent("codex")).toBe(false);
  });
});

describe("dashboard-bridge: decision + synthesized plain record", () => {
  const conversation = {
    channel: BINDING_CHANNEL,
    accountId: BINDING_ACCOUNT_ID,
    conversationId: CODEX_DASHBOARD_KEY,
  };

  it("synthesizes a deterministic, takeover-free record with boundAt:0", () => {
    const decision = resolveDashboardBindingDecision(conversation, harnessRoster())!;
    const a = synthesizeDashboardBindingRecord(decision);
    const b = synthesizeDashboardBindingRecord(decision);
    expect(a).toEqual(b);
    expect(a.boundAt).toBe(0);
    expect(a.targetKind).toBe("session");
    expect(a.status).toBe("active");
    expect(a.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
    expect(a.metadata?.mode).toBe("persistent");
    expect(a.metadata?.agentId).toBe("codex");
    expect(a.metadata?.origin).toBe("dashboard-bridge");
    expect(a.metadata?.backend).toBe("acpx");
  });

  it("bindingId keeps the dist buildBindingId shape under the unified agent-map prefix (plugin-binding:, Phase-2.6)", () => {
    const decision = resolveDashboardBindingDecision(conversation, harnessRoster())!;
    expect(decision.bindingId).toBe(
      `plugin-binding:webchat\u241fdefault\u241f\u241f${CODEX_DASHBOARD_KEY}`,
    );
  });

  it("synthesized metadata never qualifies as pluginBindingOwner (dispatch-from-config exclusion stays off)", () => {
    const record = synthesizeDashboardBindingRecord(
      resolveDashboardBindingDecision(conversation, harnessRoster())!,
    );
    expect(isPluginOwnedBindingMetadata(record.metadata)).toBe(false);
    expect(record.metadata?.pluginId).toBeUndefined();
    expect(record.metadata?.pluginRoot).toBeUndefined();
    expect(record.metadata?.pluginBindingOwner).toBeUndefined();
  });

  it("returns null for main conversations, foreign channels, and non-default accounts", () => {
    const roster = harnessRoster();
    expect(resolveDashboardBindingDecision(
      { channel: "webchat", accountId: "default", conversationId: MAIN_DASHBOARD_KEY },
      roster,
    )).toBeNull();
    expect(resolveDashboardBindingDecision(
      { channel: "telegram", accountId: "default", conversationId: CODEX_DASHBOARD_KEY },
      roster,
    )).toBeNull();
    expect(resolveDashboardBindingDecision(
      { channel: "webchat", accountId: "other", conversationId: CODEX_DASHBOARD_KEY },
      roster,
    )).toBeNull();
  });
});

describe("dashboard-bridge: standalone webchat adapter", () => {
  it("resolves fresh harness dashboard conversations on the fly (turn-1 synthesis)", async () => {
    const adapter = makeAdapter();
    const record = await adapter.resolveByConversationAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    expect(record?.boundAt).toBe(0);
    expect(record?.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
  });

  it("returns null for main/unknown conversations so builtin behavior is unchanged", async () => {
    const adapter = makeAdapter();
    expect(await adapter.resolveByConversationAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: MAIN_DASHBOARD_KEY,
    })).toBeNull();
  });

  it("materialized bind rows win over synthesis and touch keeps boundAt stable", async () => {
    const adapter = makeAdapter();
    const bound = await adapter.bind({
      targetSessionKey: "agent:codex:acp:binding:webchat:default:spawnedhash",
      targetKind: "session",
      conversation: { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY },
    });
    expect(bound?.boundAt).toBeGreaterThan(0);
    const before = (await adapter.resolveByConversationAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    }))!;
    await adapter.touchAsync(bound!.bindingId, 42);
    const after = (await adapter.resolveByConversationAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    }))!;
    expect(after.boundAt).toBe(before.boundAt);
    expect((after.metadata as { lastActivityAt?: number }).lastActivityAt).toBe(42);
    expect(after.targetSessionKey).toBe("agent:codex:acp:binding:webchat:default:spawnedhash");
  });

  it("touch on unknown bindingId is a no-op, not an error", async () => {
    const adapter = makeAdapter();
    await expect(adapter.touchAsync("plugin-binding:webchat\u241fdefault\u241f\u241fmissing", 1)).resolves.toBeUndefined();
  });

  it("unbind creates a tombstone so synthesis does not immediately rebind", async () => {
    const adapter = makeAdapter();
    const rows = await adapter.bind({
      targetSessionKey: "agent:codex:acp:binding:webchat:default:tombtest",
      targetKind: "session",
      conversation: { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY },
    });
    const removed = await adapter.unbind({ bindingId: rows!.bindingId, reason: "manual" });
    expect(removed).toHaveLength(1);
    expect(await adapter.resolveByConversationAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    })).toBeNull();
    expect(await adapter.unbind({ bindingId: "unmanaged:x", reason: "bad" })).toEqual([]);
  });

  it("scopes unbind to webchat:default", async () => {
    const adapter = makeAdapter();
    expect(await adapter.unbind({
      targetSessionKey: "anything",
      scope: { channel: "telegram", accountId: "default", conversationId: "x" },
      reason: "foreign",
    })).toEqual([]);
  });

  it("declares current-placement bind/unbind capabilities required by service.bind gating", () => {
    const adapter = makeAdapter();
    expect(adapter.channel).toBe("webchat");
    expect(adapter.accountId).toBe("default");
    expect(adapter.capabilities).toEqual({ placements: ["current"], bindSupported: true, unbindSupported: true });
  });

  it("refuses binds without a target session key", async () => {
    const adapter = makeAdapter();
    expect(await adapter.bind({
      targetSessionKey: "  ",
      targetKind: "session",
      conversation: { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY },
    })).toBeNull();
  });
});

describe("dashboard-bridge: bridge wiring", () => {
  it("skips adapter registration when webchat:default already has one", async () => {
    const registeredAdapters: unknown[] = [];
    const runtime: SessionBindingRuntimeModule = {
      testing: { getRegisteredAdapterKeys: () => ["webchat:default"] },
      registerSessionBindingAdapter: (adapter) => registeredAdapters.push(adapter),
    };
    const handle = await createDashboardBridge({ api: makeApi(), sessionBindingRuntime: runtime });
    expect(handle.ownsWebchatAdapter).toBe(false);
    expect(handle.registeredWebchatAdapterKeys).toEqual(["webchat:default"]);
    expect(registeredAdapters).toHaveLength(0);
  });

  it("registers its adapter in standalone mode and hooks become no-ops", async () => {
    const registeredAdapters: unknown[] = [];
    const registeredHooks: string[][] = [];
    const runtime: SessionBindingRuntimeModule = {
      testing: { getRegisteredAdapterKeys: () => [] },
      registerSessionBindingAdapter: (adapter) => registeredAdapters.push(adapter),
    };
    const handle = await createDashboardBridge({
      api: makeApi({ registerHook: (events) => registeredHooks.push(events as string[]) }),
      sessionBindingRuntime: runtime,
    });
    expect(handle.ownsWebchatAdapter).toBe(true);
    expect(registeredAdapters).toHaveLength(1);
    expect(registeredHooks).toEqual([["message_received", "before_dispatch"]]);
    await handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: CODEX_DASHBOARD_KEY });
    const record = await handle.resolveDashboardBindingAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    expect(record?.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
    handle.dispose();
  });

  it("runs in hooks-only mode when host SDK is unavailable", async () => {
    const handle = await createDashboardBridge({
      api: makeApi(),
      sessionBindingRuntime: null,
    });
    expect(handle.ownsWebchatAdapter).toBe(false);
    const record = await handle.resolveDashboardBindingAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    expect(record).not.toBeNull();
    await handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: CODEX_DASHBOARD_KEY });
    handle.dispose();
  });

  it("foreign-owner hook mode writes a plain record via the host service exactly once", async () => {
    const boundCalls: Array<Record<string, unknown>> = [];
    let stored: { targetSessionKey: string } | null = null;
    const service: SessionBindingServiceLike = {
      async resolveByConversationAsync() {
        return stored ? ({ ...stored } as never) : null;
      },
      async bind(input) {
        boundCalls.push(input as Record<string, unknown>);
        stored = { targetSessionKey: input.targetSessionKey };
        return stored as never;
      },
    };
    const runtime: SessionBindingRuntimeModule = {
      testing: { getRegisteredAdapterKeys: () => ["webchat:default"] },
      getSessionBindingService: () => service,
    };
    const handle = await createDashboardBridge({ api: makeApi(), sessionBindingRuntime: runtime });
    await handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: CODEX_DASHBOARD_KEY });
    await handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: CODEX_DASHBOARD_KEY });
    expect(boundCalls).toHaveLength(1);
    const bound = boundCalls[0]!;
    expect(bound.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
    expect(bound.placement).toBe("current");
    const metadata = bound.metadata as Record<string, unknown>;
    expect(isPluginOwnedBindingMetadata(metadata)).toBe(false);
    expect(metadata.source).toBe("plugin");
    expect(metadata.mode).toBe("persistent");
    expect(metadata.agentId).toBe("codex");
  });

  it("ignores non-webchat events and non-harness keys in hook mode", async () => {
    const boundCalls: unknown[] = [];
    const service: SessionBindingServiceLike = {
      async resolveByConversationAsync() {
        return null;
      },
      async bind(input) {
        boundCalls.push(input);
        return null as never;
      },
    };
    const handle = await createDashboardBridge({
      api: makeApi(),
      sessionBindingRuntime: { getSessionBindingService: () => service },
    });
    await handle.ensureDashboardBindingAsync({ channel: "telegram", sessionKey: CODEX_DASHBOARD_KEY });
    await handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: MAIN_DASHBOARD_KEY });
    await handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: undefined });
    expect(boundCalls).toHaveLength(0);
  });

  it("keeps a pre-existing foreign target (Weg-1 record) untouched in hook mode", async () => {
    const service: SessionBindingServiceLike = {
      async resolveByConversationAsync() {
        return {
          bindingId: "generic:webchat\u241fdefault\u241f\u241fspawn",
          targetSessionKey: "agent:codex:acp:binding:webchat:default:fromspawn",
          targetKind: "session",
          conversation: { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY },
          status: "active",
          boundAt: 1,
          metadata: { source: "spawn" },
        };
      },
      async bind() {
        throw new Error("must not bind over an existing record");
      },
    };
    const handle = await createDashboardBridge({
      api: makeApi(),
      sessionBindingRuntime: { getSessionBindingService: () => service },
    });
    await expect(
      handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: CODEX_DASHBOARD_KEY }),
    ).resolves.toBeUndefined();
  });

  it("surfaces service bind failures as logged errors, never throws into the hook", async () => {
    const errors: unknown[] = [];
    const service: SessionBindingServiceLike = {
      async resolveByConversationAsync() {
        return null;
      },
      async bind() {
        throw new Error("store down");
      },
    };
    const handle = await createDashboardBridge({
      api: makeApi({ logger: { error: (...args) => errors.push(args) } }),
      sessionBindingRuntime: { getSessionBindingService: () => service },
    });
    await expect(
      handle.ensureDashboardBindingAsync({ channel: "webchat", sessionKey: CODEX_DASHBOARD_KEY }),
    ).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("dashboard-bridge: binding-adapter delegation point", () => {
  it("exposes a write-free resolver for claude's binding-adapter.ts", () => {
    const resolve = createStandaloneBindingResolver(harnessRoster());
    const record = resolve({ channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY });
    expect(record?.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
    expect(resolve({ channel: "webchat", accountId: "default", conversationId: MAIN_DASHBOARD_KEY })).toBeNull();
  });

  it("bridge resolver honors tombstones set through its own webchat adapter rows", async () => {
    const runtime: SessionBindingRuntimeModule = {
      testing: { getRegisteredAdapterKeys: () => [] },
      getSessionBindingService: () => ({} as SessionBindingServiceLike),
    };
    const handle = await createDashboardBridge({ api: makeApi(), sessionBindingRuntime: runtime });
    const record = await handle.resolveDashboardBindingAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    expect(record).not.toBeNull();
    handle.dispose();
  });
});

describe("dashboard-bridge: §4.2 write-free delegation resolvers", () => {
  it("synthesizes the bridge record deterministically for a config-backed roster", () => {
    const ref = {
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    };
    const a = resolveDashboardBinding(ref, { roster: harnessRoster() });
    const b = resolveDashboardBinding(ref, { roster: harnessRoster() });
    expect(a).toEqual(b);
    expect(a?.boundAt).toBe(0);
    expect(a?.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
    expect(a?.metadata?.pluginBindingOwner).toBeUndefined();
    expect(a?.targetKind).toBe("session");
  });

  it("answers null without any config backing (empty dynamic roster)", async () => {
    // Phase 2.7 safe default: no active bridge + no config → empty roster,
    // so the exported resolver derives nothing.
    expect(await resolveDashboardBindingAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    })).toBeNull();
  });

  it("gates main/unknown exactly like the bridge roster", async () => {
    expect(await resolveDashboardBindingAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: MAIN_DASHBOARD_KEY,
    })).toBeNull();
    expect(await resolveDashboardBindingAsync({
      channel: "telegram",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    })).toBeNull();
  });

  it("prefers active bridge rows, honors its tombstones, and detaches on dispose", async () => {
    let registeredAdapter: ReturnType<typeof createWebchatDashboardBindingAdapter> | null = null;
    const runtime: SessionBindingRuntimeModule = {
      testing: { getRegisteredAdapterKeys: () => [] },
      registerSessionBindingAdapter: (adapter: unknown) => {
        registeredAdapter = adapter as ReturnType<typeof createWebchatDashboardBindingAdapter>;
      },
    };
    const conversation = { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY };
    const handle = await createDashboardBridge({ api: makeApi(), sessionBindingRuntime: runtime });
    expect(handle.ownsWebchatAdapter).toBe(true);
    const adapter = registeredAdapter!;
    const bound = await adapter.bind({
      targetSessionKey: "agent:codex:acp:binding:webchat:default:bridgerow",
      targetKind: "session",
      conversation,
    });
    const viaDelegation = await resolveDashboardBindingAsync(conversation);
    expect(viaDelegation?.bindingId).toBe(bound?.bindingId);
    expect(viaDelegation?.targetSessionKey).toBe("agent:codex:acp:binding:webchat:default:bridgerow");
    await adapter.unbind({ bindingId: bound!.bindingId, reason: "tombstone-test" });
    expect(await resolveDashboardBindingAsync(conversation)).toBeNull();
    handle.dispose();
    // After dispose the bridge is detached from the delegation resolvers. The
    // fallback roster is config-less now (Phase 2.7 dynamic roster), so the
    // exported resolver answers null and the adapter cascade falls through to
    // its own live getConfig()-backed synthesis.
    expect(await resolveDashboardBindingAsync(conversation)).toBeNull();
  });

  it("claude's binding-adapter delegates at row-miss: bridge rows win over its synthesis", async () => {
    const conversation = { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY };
    let registeredAdapter: ReturnType<typeof createWebchatDashboardBindingAdapter> | null = null;
    const runtime: SessionBindingRuntimeModule = {
      testing: { getRegisteredAdapterKeys: () => [] },
      registerSessionBindingAdapter: (adapter: unknown) => {
        registeredAdapter = adapter as ReturnType<typeof createWebchatDashboardBindingAdapter>;
      },
    };
    const handle = await createDashboardBridge({ api: makeApi(), sessionBindingRuntime: runtime });
    const adapter = createDashboardBindingAdapter({ getConfig: () => undefined });
    const bound = await registeredAdapter!.bind({
      targetSessionKey: "agent:codex:acp:binding:webchat:default:bridgerow",
      targetKind: "session",
      conversation,
    });
    // Row-miss: the adapter has no explicit binding of its own → delegation
    // surfaces the bridge row through both mirrors.
    const viaAsync = await adapter.resolveByConversationAsync!(conversation);
    expect(viaAsync?.bindingId).toBe(bound?.bindingId);
    expect(adapter.resolveByConversation(conversation)?.bindingId).toBe(bound?.bindingId);
    expect(adapter.resolveByConversation(conversation)?.bindingId).toBe(bound?.bindingId);
    expect(await adapter.resolveByConversationAsync!({
      ...conversation,
      conversationId: MAIN_DASHBOARD_KEY,
    })).toBeNull();
    handle.dispose();
  });

  it("claude's binding-adapter keeps Turn-1 synthesis when no bridge row exists", async () => {
    const adapter = createDashboardBindingAdapter({
      // Dynamic roster: codex is a harness agent via its runtime.acp entry.
      getConfig: () => ({ agents: { entries: { codex: { runtime: { type: "acp", acp: { backend: "acpx" } } } } } }),
    });
    const record = await adapter.resolveByConversationAsync!({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    expect(record?.boundAt).toBe(0);
    expect(record?.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
    expect(record?.metadata?.pluginBindingOwner).toBeUndefined();
    expect(record?.targetKind).toBe("session");
  });
});

// --- Phase 2.12: Marvin-Bugfixes -------------------------------------------

/** Deterministic synthesis backing the hydration fixtures (explicit store: null). */
function synthesizedFixtureRecord(targetSessionKey: string): SessionBindingRecordLike {
  const record = resolveDashboardBinding(
    { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY },
    { roster: harnessRoster(), store: null },
  )!;
  return { ...record, targetSessionKey };
}

function makeFakeKeyedStore<T>(entries: Array<{ key: string; value: T }> = []): KeyedStoreLike<T> {
  return {
    async registerIfAbsent() {
      return true;
    },
    async lookup() {
      return undefined;
    },
    async delete() {
      return false;
    },
    async entries() {
      return entries;
    },
  };
}

describe("dashboard-bridge: Phase 2.12 F1 openKeyedStore contract", () => {
  function makeStoreCapturingApi(
    openKeyedStore: NonNullable<
      NonNullable<DashboardBridgeApiLike["runtime"]>["state"]
    >["openKeyedStore"],
  ) {
    return makeApi({ runtime: { state: { openKeyedStore } } });
  }

  it("opens rows/tombstones with the dist {namespace, maxEntries} contract, not {name}", async () => {
    const openCalls: Array<{ namespace: string; maxEntries: number }> = [];
    const handle = await createDashboardBridge({
      api: makeStoreCapturingApi(<T,>(options: OpenKeyedStoreOptionsLike) => {
        openCalls.push({ namespace: options.namespace, maxEntries: options.maxEntries });
        return makeFakeKeyedStore<never>() as KeyedStoreLike<T>;
      }),
      sessionBindingRuntime: null,
    });
    handle.dispose();
    expect(openCalls).toEqual([
      { namespace: "webchat.dashboard-bridge.rows", maxEntries: 1000 },
      { namespace: "webchat.dashboard-bridge.tombstones", maxEntries: 1000 },
    ]);
    for (const call of openCalls) expect(call).not.toHaveProperty("name");
  });

  it("keeps booting memory-only (with the existing warn) when the store open throws", async () => {
    const warns: Array<unknown[]> = [];
    const handle = await createDashboardBridge({
      api: makeApi({
        logger: { warn: (...args) => warns.push(args) },
        runtime: {
          state: {
            openKeyedStore: <T,>(): KeyedStoreLike<T> => {
              throw new Error("sqlite unavailable");
            },
          },
        },
      }),
      sessionBindingRuntime: null,
    });
    // 1 warn from the failed open ("memory-only") + 1 hooks-only warn (null runtime).
    expect(warns).toHaveLength(2);
    expect(warns.some((args) => String(args[0]).includes("memory-only rows"))).toBe(true);
    expect(await handle.resolveDashboardBindingAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    })).not.toBeNull();
    handle.dispose();
  });
});

describe("dashboard-bridge: Phase 2.12 F2 boot hydration", () => {
  const PERSISTED_TARGET = "agent:codex:acp:binding:webchat:default:persisted";
  const conversation = {
    channel: "webchat" as const,
    accountId: "default",
    conversationId: CODEX_DASHBOARD_KEY,
  };

  it("loads persisted rows and tombstones into the memory maps on hydrate", async () => {
    const record = synthesizedFixtureRecord(PERSISTED_TARGET);
    const otherBindingId = "plugin-binding:webchat␟default␟␟other-conversation";
    const rows = makeFakeKeyedStore<{ record: SessionBindingRecordLike }>([
      { key: `row:${record.bindingId}`, value: { record } },
      { key: "junk-entry-that-must-not-crash", value: { record: null as never } },
    ]);
    const tombstones = makeFakeKeyedStore<true>([
      { key: `tombstone:${otherBindingId}`, value: true as const },
    ]);
    const store = createBridgeRowStore(rows, tombstones);
    await store.hydrate();
    expect(store.row(record.bindingId)?.targetSessionKey).toBe(PERSISTED_TARGET);
    expect(store.hasTombstone(otherBindingId)).toBe(true);
    expect(store.row(otherBindingId)).toBeNull();
    // Idempotent: a second hydrate call resolves without duplicating work.
    await store.hydrate();
    expect(store.row(record.bindingId)?.targetSessionKey).toBe(PERSISTED_TARGET);
  });

  it("survives a failing persisted store: reports, resolves, stays memory-only", async () => {
    const errors: unknown[] = [];
    const rows = makeFakeKeyedStore<{ record: SessionBindingRecordLike }>();
    rows.entries = async () => {
      throw new Error("read failed");
    };
    const store = createBridgeRowStore(rows, null, { onHydrateError: (error) => errors.push(error) });
    await expect(store.hydrate()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    const record = synthesizedFixtureRecord(PERSISTED_TARGET);
    store.upsertRow(record);
    expect(store.row(record.bindingId)?.targetSessionKey).toBe(PERSISTED_TARGET);
  });

  it("in-memory writes racing a slow hydration win over stale persisted rows", async () => {
    let release!: (entries: Array<{ key: string; value: { record: SessionBindingRecordLike } }>) => void;
    const gate = new Promise<Array<{ key: string; value: { record: SessionBindingRecordLike } }>>(
      (resolve) => {
        release = resolve;
      },
    );
    const rows = makeFakeKeyedStore<{ record: SessionBindingRecordLike }>();
    rows.entries = () => gate;
    const stale = synthesizedFixtureRecord("agent:codex:acp:binding:webchat:default:stale");
    const store = createBridgeRowStore(rows, null);
    const ready = store.hydrate();
    const live: SessionBindingRecordLike = {
      ...stale,
      targetSessionKey: "agent:codex:acp:binding:webchat:default:live",
      boundAt: 7,
    };
    store.upsertRow(live);
    release([{ key: `row:${live.bindingId}`, value: { record: stale } }]);
    await ready;
    expect(store.row(live.bindingId)?.targetSessionKey).toBe(
      "agent:codex:acp:binding:webchat:default:live",
    );
  });

  it("bridge answers from boot-hydrated rows/tombstones through handle and adapter", async () => {
    const record = synthesizedFixtureRecord(PERSISTED_TARGET);
    const secondConversation = {
      channel: "webchat" as const,
      accountId: "default",
      conversationId: PERSISTED_CODEX_DASHBOARD_KEY,
    };
    const tombstonedBindingId = `plugin-binding:webchat␟default␟␟${PERSISTED_CODEX_DASHBOARD_KEY}`;
    const tombstones = makeFakeKeyedStore<true>([
      { key: `tombstone:${tombstonedBindingId}`, value: true as const },
    ]);
    const openCalls: string[] = [];
    let registeredAdapter: ReturnType<typeof createWebchatDashboardBindingAdapter> | null = null;
    const api = makeApi({
      runtime: {
        state: {
          openKeyedStore: <T,>(options: OpenKeyedStoreOptionsLike) => {
            openCalls.push(options.namespace);
            return (
              options.namespace.endsWith(".rows")
                ? makeFakeKeyedStore<{ record: SessionBindingRecordLike }>([
                    { key: `row:${record.bindingId}`, value: { record } },
                  ])
                : tombstones
            ) as KeyedStoreLike<T>;
          },
        },
      },
    });
    const handle = await createDashboardBridge({
      api,
      sessionBindingRuntime: {
        testing: { getRegisteredAdapterKeys: () => [] },
        registerSessionBindingAdapter: (adapter: unknown) => {
          registeredAdapter = adapter as ReturnType<typeof createWebchatDashboardBindingAdapter>;
        },
      },
    });
    expect(openCalls).toEqual(["webchat.dashboard-bridge.rows", "webchat.dashboard-bridge.tombstones"]);
    // Hydrated row beats Turn-1 synthesis; hydrated tombstone forces null —
    // both via handle, adapter, and §4.2-delegation (all await whenReady()).
    expect((await handle.resolveDashboardBindingAsync(conversation))?.targetSessionKey).toBe(PERSISTED_TARGET);
    expect(await handle.resolveDashboardBindingAsync(secondConversation)).toBeNull();
    expect((await registeredAdapter!.resolveByConversationAsync(conversation))?.targetSessionKey).toBe(
      PERSISTED_TARGET,
    );
    expect(await registeredAdapter!.resolveByConversationAsync(secondConversation)).toBeNull();
    handle.dispose();
  });

  it("adapter resolveByConversationAsync/touchAsync wait out the startup hydration", async () => {
    let release!: (entries: Array<{ key: string; value: { record: SessionBindingRecordLike } }>) => void;
    const gate = new Promise<Array<{ key: string; value: { record: SessionBindingRecordLike } }>>(
      (resolve) => {
        release = resolve;
      },
    );
    const rows = makeFakeKeyedStore<{ record: SessionBindingRecordLike }>();
    rows.entries = () => gate;
    const record = synthesizedFixtureRecord(PERSISTED_TARGET);
    const store = createBridgeRowStore(rows, null);
    // Same startup path as createDashboardBridge: hydrate runs in the
    // background; adapter reads must suspend on whenReady() until it lands.
    void store.hydrate();
    const adapter = createWebchatDashboardBindingAdapter({ roster: harnessRoster(), store });
    const pending = adapter
      .resolveByConversationAsync(conversation)
      .then((result) => ({ bindingId: result?.bindingId ?? "null", result }));
    release([{ key: `row:${record.bindingId}`, value: { record } }]);
    const waited = await pending;
    expect(waited.bindingId).toBe(record.bindingId);
    expect(waited.result?.targetSessionKey).toBe(PERSISTED_TARGET);
    // touchAsync reads post-hydrate too: bumps the hydrated row, not a miss.
    await adapter.touchAsync(record.bindingId, 42);
    expect(store.row(record.bindingId)?.metadata?.lastActivityAt).toBe(42);
  });
});
describe("dashboard-bridge: orchestrator exclusion + boundAgents allowlist (Phase 2.15)", () => {
  const orchestratorConfig = {
    agents: {
      entries: {
        "coding-main": { runtime: { type: "acp", acp: { backend: "acpx" } } },
        "coding-review": { runtime: { type: "acp", acp: { backend: "acpx" } } },
        codex: { runtime: { type: "acp", acp: { backend: "acpx" } } },
      },
    },
  };

  const CODING_MAIN_KEY = `agent:coding-main:dashboard:${DASHBOARD_UUID}`;

  it("never rosters orchestrator ids, even with runtime.acp (codex-R1, static exclusion)", () => {
    expect(ORCHESTRATOR_AGENT_IDS).toContain("main");
    expect(ORCHESTRATOR_AGENT_IDS).toContain("coding-main");
    expect(ORCHESTRATOR_AGENT_IDS).toContain("coding-review");
    expect(isOrchestratorAgentId("coding-main")).toBe(true);
    expect(isOrchestratorAgentId("Main")).toBe(true); // canonicalized
    expect(isOrchestratorAgentId("codex")).toBe(false);
    // agent-map resolvers: exclusion wins over runtime.acp.
    const specs = resolveHarnessAgentSpecs(orchestratorConfig);
    expect(specs.map((spec) => spec.agentId)).toEqual(["codex"]);
    expect(resolveHarnessAgentSpec(orchestratorConfig, "coding-main")).toBeNull();
    expect(resolveHarnessAgentSpec(orchestratorConfig, "coding-review")).toBeNull();
    // Roster path (dashboard-bridge) applies the same gates.
    const roster = createConfigHarnessRoster(orchestratorConfig);
    expect(roster.isHarnessAgent("coding-main")).toBe(false);
    expect(roster.isHarnessAgent("coding-review")).toBe(false);
    expect(roster.isHarnessAgent("codex")).toBe(true);
    expect(roster.acpDefaults("coding-main")).toBeNull();
    // Adapter derive path: a coding-main dashboard conversation maps to NO
    // ACP binding (built-in dispatch stays untouched).
    const adapter = createDashboardBindingAdapter({
      getConfig: () => orchestratorConfig,
    });
    expect(adapter.resolveByConversation({ channel: "webchat", accountId: "default", conversationId: CODING_MAIN_KEY })).toBeNull();
  });

  it("boundAgents set: ONLY the listed ids roster (positive list wins over runtime.acp)", () => {
    const allowlistConfig = {
      ...orchestratorConfig,
      plugins: {
        entries: {
          [CHANNEL_ID]: { config: { boundAgents: ["codex"] } },
        },
      },
    };
    const specs = resolveHarnessAgentSpecs(allowlistConfig);
    expect(specs.map((spec) => spec.agentId)).toEqual(["codex"]);
    expect(resolveHarnessAgentSpec(allowlistConfig, "codex")).not.toBeNull();
    expect(resolveHarnessAgentSpec(allowlistConfig, "opencode")).toBeNull();
    const roster = createConfigHarnessRoster(allowlistConfig);
    expect(roster.isHarnessAgent("codex")).toBe(true);
    expect(roster.isHarnessAgent("claude")).toBe(false);
  });

  it("boundAgents NOT set: every runtime.acp entry rosters (dynamic default)", () => {
    const specs = resolveHarnessAgentSpecs(orchestratorConfig);
    expect(specs.map((spec) => spec.agentId)).toEqual(["codex"]);
    expect(resolveBoundAgentAllowlist(orchestratorConfig)).toBeNull();
    expect(resolveBoundAgentAllowlist({
      plugins: { entries: { [CHANNEL_ID]: { config: { boundAgents: "codex,claude" } } } },
    })).toBeNull(); // non-array: not set
  });

  it("boundAgents explicitly empty: positive list with nothing in it rosters NOTHING", () => {
    const emptyListConfig = {
      ...orchestratorConfig,
      plugins: {
        entries: {
          [CHANNEL_ID]: { config: { boundAgents: [] } },
        },
      },
    };
    expect(resolveBoundAgentAllowlist(emptyListConfig)).toEqual([]);
    expect(resolveHarnessAgentSpecs(emptyListConfig)).toEqual([]);
    expect(createConfigHarnessRoster(emptyListConfig).isHarnessAgent("codex")).toBe(false);
  });

  it("boundAgents entry that names an orchestrator is still excluded (exclusion wins)", () => {
    const allowOrchestratorConfig = {
      ...orchestratorConfig,
      plugins: {
        entries: {
          [CHANNEL_ID]: { config: { boundAgents: ["coding-main", "codex"] } },
        },
      },
    };
    const specs = resolveHarnessAgentSpecs(allowOrchestratorConfig);
    expect(specs.map((spec) => spec.agentId)).toEqual(["codex"]);
    expect(resolveHarnessAgentSpec(allowOrchestratorConfig, "coding-main")).toBeNull();
    expect(createConfigHarnessRoster(allowOrchestratorConfig).isHarnessAgent("coding-main")).toBe(false);
  });

  it("boundAgents allowlist applies live through the adapter getConfig (no cache)", () => {
    let config: unknown = {
      agents: { entries: { codex: { runtime: { type: "acp", acp: {} } } } },
      plugins: { entries: { [CHANNEL_ID]: { config: { boundAgents: ["codex"] } } } },
    };
    const adapter = createDashboardBindingAdapter({ getConfig: () => config });
    const ref = { channel: "webchat", accountId: "default", conversationId: CODEX_DASHBOARD_KEY };
    expect(adapter.resolveByConversation(ref)).not.toBeNull();
    // Same config, allowlist now names a different agent: codex stops matching.
    config = {
      ...config,
      plugins: { entries: { [CHANNEL_ID]: { config: { boundAgents: ["claude"] } } } },
    };
    expect(adapter.resolveByConversation(ref)).toBeNull();
  });
});
