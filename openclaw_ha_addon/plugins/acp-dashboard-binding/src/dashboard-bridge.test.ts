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
  type SessionBindingRuntimeModule,
  type SessionBindingServiceLike,
} from "./dashboard-bridge.js";
import { createDashboardBindingAdapter } from "./binding-adapter.js";

const DASHBOARD_UUID = "123e4567-e89b-12d3-a456-426614174000";
const CODEX_DASHBOARD_KEY = `agent:codex:dashboard:${DASHBOARD_UUID}`;
const MAIN_DASHBOARD_KEY = `agent:main:dashboard:${DASHBOARD_UUID}`;

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
  it("accepts harness ids and configured harness agents, rejects main/unknown", () => {
    const roster = harnessRoster();
    expect(roster.isHarnessAgent("codex")).toBe(true);
    expect(roster.isHarnessAgent("opencode")).toBe(true);
    expect(roster.isHarnessAgent("main")).toBe(false);
    expect(roster.isHarnessAgent("unknown-agent")).toBe(false);
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
  it("synthesizes the bridge record deterministically without an active bridge", async () => {
    const a = await resolveDashboardBindingAsync({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    const b = await resolveDashboardBinding({
      channel: "webchat",
      accountId: "default",
      conversationId: CODEX_DASHBOARD_KEY,
    });
    expect(a).toEqual(b);
    expect(a?.boundAt).toBe(0);
    expect(a?.targetSessionKey).toBe(buildDashboardAcpTargetSessionKey({
      agentId: "codex",
      conversationId: CODEX_DASHBOARD_KEY,
    }));
    expect(a?.metadata?.pluginBindingOwner).toBeUndefined();
    expect(a?.targetKind).toBe("session");
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
    // After dispose the bridge is detached from the delegation resolvers: the
    // (empty) fallback synthesis answers again, boundAt back at the stable 0.
    const detached = await resolveDashboardBindingAsync(conversation);
    expect(detached?.boundAt).toBe(0);
    expect(detached?.targetSessionKey).toBe(
      buildDashboardAcpTargetSessionKey({ agentId: "codex", conversationId: CODEX_DASHBOARD_KEY }),
    );
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
    const adapter = createDashboardBindingAdapter({ getConfig: () => undefined });
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