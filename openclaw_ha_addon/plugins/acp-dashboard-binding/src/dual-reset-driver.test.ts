/**
 * §25 dual-reset driver tests (GaRoN 2026-10-16, "Befehle in der
 * Verbindungs-Session"). The driver must (a) claim ONLY plugin-owned binding
 * keys while the builtin acp reset leg exists, (b) delegate the work-session
 * reset verbatim to the builtin, and (c) add the origin-conversation reset as
 * a SECOND builtin delegation with the conversation key (the plugin gateway
 * RPC path is blocked by the plugin-ownership gate for owner-less host-created
 * rows — LIVE-verified) — best-effort, never degrading the work result.
 * Registry mechanics (insertion-order precedence over the builtin's
 * key-shape fallback) are covered by the registration ordering test.
 */
import { describe, expect, it, vi } from "vitest";

import {
  createDualResetDriver,
  DUAL_RESET_DRIVER_ID,
  registerDualResetDriver,
  type DualResetDriverServices,
  type DriverRegistryMap,
  type StatefulBindingTargetDriverLike,
} from "./dual-reset-driver.js";
import { STATEFUL_TARGET_DRIVERS_SYMBOL } from "./dual-reset-driver.js";
import { buildAcpBindingSessionKey } from "./agent-map.js";
import { createDashboardBindingAdapter } from "./binding-adapter.js";

const WORK_KEY = "agent:claude:acp:binding:webchat:default:9c48a2456423b29b";
const CONVERSATION_KEY = "agent:claude:dashboard:df380d1f-3109-424e-8ec7-6474c0f4e40b";

function builtinDriver(overrides?: Partial<StatefulBindingTargetDriverLike>): StatefulBindingTargetDriverLike {
  return {
    id: "acp",
    resolveTargetBySessionKey: async () => ({
      kind: "stateful",
      driverId: "acp",
      sessionKey: WORK_KEY,
      agentId: "claude",
    }),
    resetInPlace: vi.fn(async () => ({
      ok: true,
      sessionKey: WORK_KEY,
      sessionId: "f45463c4-new",
      storePath: "/tmp/store",
    })),
    ...overrides,
  };
}

function adapterFor(targetKey: string, conversationId: string | null) {
  return {
    listBySession: (key: string) =>
      key === targetKey && conversationId
        ? [
            {
              targetSessionKey: key,
              targetKind: "session",
              conversation: { conversationId },
            },
          ]
        : [],
  };
}

function makeServices(overrides?: Partial<DualResetDriverServices>): DualResetDriverServices {
  const registry: DriverRegistryMap = new Map([
    ["acp", builtinDriver()],
  ]);
  return {
    resolveDriverRegistry: () => registry,
    getAdapter: () => adapterFor(WORK_KEY, CONVERSATION_KEY),
    hasSessionEntry: vi.fn(async () => true),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe("§25 dual-reset driver — resolveTargetBySessionKey", () => {
  it("claims a plugin-owned binding key and carries the origin conversation key", async () => {
    const driver = createDualResetDriver(makeServices());
    const target = await driver.resolveTargetBySessionKey!({
      cfg: {},
      sessionKey: WORK_KEY,
    });
    expect(target).not.toBeNull();
    expect(target?.driverId).toBe(DUAL_RESET_DRIVER_ID);
    expect(target?.sessionKey).toBe(WORK_KEY);
    expect(target?.agentId).toBe("claude");
    expect(target?.conversationSessionKey).toBe(CONVERSATION_KEY);
  });

  it("defers to the builtin when no adapter record matches (foreign/unknown key)", async () => {
    const driver = createDualResetDriver(makeServices());
    const target = await driver.resolveTargetBySessionKey!({
      cfg: {},
      // acp-shaped key the plugin does not own
      sessionKey: "agent:claude:acp:binding:webchat:default:deadbeefdeadbeef",
    });
    expect(target).toBeNull();
  });

  it("defers when the builtin reset leg is absent (delegate-only design)", async () => {
    const registry: DriverRegistryMap = new Map(); // no builtin yet (lazy registration)
    const driver = createDualResetDriver(
      makeServices({ resolveDriverRegistry: () => registry }),
    );
    const target = await driver.resolveTargetBySessionKey!({
      cfg: {},
      sessionKey: WORK_KEY,
    });
    expect(target).toBeNull();
  });

  it("defers for non-acp-shaped keys", async () => {
    const driver = createDualResetDriver(makeServices());
    expect(
      await driver.resolveTargetBySessionKey!({
        cfg: {},
        sessionKey: "agent:claude:dashboard:whatever",
      }),
    ).toBeNull();
    expect(
      await driver.resolveTargetBySessionKey!({ cfg: {}, sessionKey: "" }),
    ).toBeNull();
  });

  it("defers on an agent-mismatched conversation key (Codex F6 cross-session guard)", async () => {
    const driver = createDualResetDriver(
      makeServices({
        getAdapter: () => adapterFor(WORK_KEY, "agent:codex:dashboard:df380d1f-3109-424e-8ec7-6474c0f4e40b"),
      }),
    );
    expect(
      await driver.resolveTargetBySessionKey!({ cfg: {}, sessionKey: WORK_KEY }),
    ).toBeNull();
  });

  it("defers on a degenerate self-target (conversation key equals work key)", async () => {
    const driver = createDualResetDriver(
      makeServices({ getAdapter: () => adapterFor(WORK_KEY, WORK_KEY) }),
    );
    expect(
      await driver.resolveTargetBySessionKey!({ cfg: {}, sessionKey: WORK_KEY }),
    ).toBeNull();
  });
});

describe("§25 dual-reset driver — resetInPlace", () => {
  it("delegates BOTH legs to the builtin: work verbatim + conversation with its own key", async () => {
    // Leg 2 must be a host-side builtin delegation, NOT a plugin gateway RPC:
    // the trusted-plugin dispatch stamps authorizedPluginId and the
    // plugin-ownership gate rejects owner-less host-created conversation
    // rows ("did not create it") — LIVE-verified 2026-10-16.
    const builtinReset = vi.fn(async (call: { sessionKey?: string }) => ({
      ok: true,
      sessionKey: call.sessionKey,
      sessionId: call.sessionKey === CONVERSATION_KEY ? "con-new" : "work-new",
    }));
    const registry: DriverRegistryMap = new Map([
      ["acp", builtinDriver({ resetInPlace: builtinReset })],
    ]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const driver = createDualResetDriver(services);
    const result = await driver.resetInPlace!({
      cfg: {},
      sessionKey: WORK_KEY,
      agentId: "claude",
      reason: "reset",
      commandSource: "test:surface",
      bindingTarget: {
        kind: "stateful",
        driverId: DUAL_RESET_DRIVER_ID,
        sessionKey: WORK_KEY,
        agentId: "claude",
        conversationSessionKey: CONVERSATION_KEY,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe("work-new"); // leg-1 result stands
    expect(services.hasSessionEntry).toHaveBeenCalledWith(CONVERSATION_KEY, "claude");
    expect(builtinReset).toHaveBeenCalledTimes(2);
    expect(builtinReset).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionKey: WORK_KEY, reason: "reset" }),
    );
    expect(builtinReset).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionKey: CONVERSATION_KEY,
        agentId: "claude",
        reason: "reset",
        commandSource: "test:surface:conversation-leg",
        bindingTarget: expect.objectContaining({
          sessionKey: CONVERSATION_KEY,
          driverId: "acp",
          agentId: "claude",
        }),
      }),
    );
  });

  it("maps the /new command to the conversation leg as well", async () => {
    const builtinReset = vi.fn(async (call: { sessionKey?: string }) => ({ ok: true, sessionKey: call.sessionKey }));
    const registry: DriverRegistryMap = new Map([
      ["acp", builtinDriver({ resetInPlace: builtinReset })],
    ]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const driver = createDualResetDriver(services);
    await driver.resetInPlace!({
      cfg: {},
      sessionKey: WORK_KEY,
      reason: "new",
      bindingTarget: { sessionKey: WORK_KEY, conversationSessionKey: CONVERSATION_KEY },
    });
    expect(builtinReset).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionKey: CONVERSATION_KEY, reason: "new" }),
    );
  });

  it("skips the conversation leg when the origin entry does not exist (stray-guard)", async () => {
    const builtinReset = vi.fn(async () => ({ ok: true, sessionKey: WORK_KEY, sessionId: "work-new" }));
    const registry: DriverRegistryMap = new Map([
      ["acp", builtinDriver({ resetInPlace: builtinReset })],
    ]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    services.hasSessionEntry = vi.fn(async () => false);
    const driver = createDualResetDriver(services);
    const result = await driver.resetInPlace!({
      cfg: {},
      sessionKey: WORK_KEY,
      bindingTarget: {
        sessionKey: WORK_KEY,
        agentId: "claude",
        conversationSessionKey: CONVERSATION_KEY,
      },
    });
    expect(result.ok).toBe(true);
    expect(services.hasSessionEntry).toHaveBeenCalled();
    expect(builtinReset).toHaveBeenCalledTimes(1);
  });

  it("keeps the work result when the conversation-leg builtin call throws", async () => {
    const builtinReset = vi.fn(async (call: { sessionKey?: string }) => {
      if (call.sessionKey === CONVERSATION_KEY) throw new Error("worker died");
      return { ok: true, sessionKey: call.sessionKey, sessionId: "work-new" };
    });
    const registry: DriverRegistryMap = new Map([
      ["acp", builtinDriver({ resetInPlace: builtinReset })],
    ]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const driver = createDualResetDriver(services);
    const result = await driver.resetInPlace!({
      cfg: {},
      sessionKey: WORK_KEY,
      bindingTarget: {
        sessionKey: WORK_KEY,
        agentId: "claude",
        conversationSessionKey: CONVERSATION_KEY,
      },
    });
    expect(result.ok).toBe(true);
    expect(services.logger.warn).toHaveBeenCalledWith(expect.stringContaining("origin conversation reset failed"));
  });

  it("logs the builtin's refusal of the conversation leg as a warn and keeps the work result", async () => {
    const builtinReset = vi.fn(async (call: { sessionKey?: string }) => {
      if (call.sessionKey === CONVERSATION_KEY) return { ok: false, error: "refused" };
      return { ok: true, sessionKey: call.sessionKey, sessionId: "work-new" };
    });
    const registry: DriverRegistryMap = new Map([
      ["acp", builtinDriver({ resetInPlace: builtinReset })],
    ]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const driver = createDualResetDriver(services);
    const result = await driver.resetInPlace!({
      cfg: {},
      sessionKey: WORK_KEY,
      bindingTarget: {
        sessionKey: WORK_KEY,
        conversationSessionKey: CONVERSATION_KEY,
      },
    });
    expect(result.ok).toBe(true);
    expect(services.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("did not commit (builtin refused: refused)"),
    );
  });

  it("passes a builtin failure straight through and never runs the conversation leg", async () => {
    const builtinReset = vi.fn(async () => ({
      ok: false,
      error: "store not ready",
    }));
    const registry: DriverRegistryMap = new Map([
      ["acp", builtinDriver({ resetInPlace: builtinReset })],
    ]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const driver = createDualResetDriver(services);
    const result = await driver.resetInPlace!({
      cfg: {},
      sessionKey: WORK_KEY,
      bindingTarget: { sessionKey: WORK_KEY, conversationSessionKey: CONVERSATION_KEY },
    });
    expect(result).toEqual({ ok: false, error: "store not ready" });
    expect(services.logger.warn).not.toHaveBeenCalled();
  });

  it("skips the conversation leg when the binding target carries no conversation key", async () => {
    const builtinReset = vi.fn(async () => ({ ok: true, sessionKey: WORK_KEY, sessionId: "work-new" }));
    const registry: DriverRegistryMap = new Map([
      ["acp", builtinDriver({ resetInPlace: builtinReset })],
    ]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const driver = createDualResetDriver(services);
    const result = await driver.resetInPlace!({
      cfg: {},
      sessionKey: WORK_KEY,
      bindingTarget: { sessionKey: WORK_KEY },
    });
    expect(result.ok).toBe(true);
    expect(services.hasSessionEntry).not.toHaveBeenCalled();
    expect(builtinReset).toHaveBeenCalledTimes(1);
  });
});

describe("§25 dual-reset driver — registration ordering", () => {
  it("registers into the globalThis symbol map and re-appends a pre-existing builtin after ours", () => {
    const registry: DriverRegistryMap = new Map([["acp", builtinDriver()]]);
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const result = registerDualResetDriver(services);
    expect(result.registered).toBe(true);
    expect(registry.get(DUAL_RESET_DRIVER_ID)).toBeDefined();
    // Insertion order: ours BEFORE the re-appended builtin — the builtin's
    // key-shape fallback claims our keys unconditionally, so without this our
    // driver could never win resolution for plugin-owned keys.
    expect([...registry.keys()]).toEqual([DUAL_RESET_DRIVER_ID, "acp"]);
    // Identity preserved for the builtin (same object, same id).
    expect(registry.get("acp")?.id).toBe("acp");
    expect(
      (
        registry.get("acp") as unknown as { resetInPlace: { mock: unknown } }
      ).resetInPlace.mock,
    ).toBeDefined();
  });

  it("registers into the globalThis symbol map when the host module has not loaded yet (default resolver)", () => {
    const globalRegistry = new Map<string, StatefulBindingTargetDriverLike>();
    const store = globalThis as unknown as Record<PropertyKey, unknown>;
    store[STATEFUL_TARGET_DRIVERS_SYMBOL as symbol] = globalRegistry;
    try {
      const services = makeServices();
      delete (services as { resolveDriverRegistry?: unknown }).resolveDriverRegistry;
      const result = registerDualResetDriver(services);
      // The default resolver adopts the existing globalThis map (one registry).
      expect(globalRegistry.get(DUAL_RESET_DRIVER_ID)).toBeDefined();
      expect(result.registered).toBe(true);
    } finally {
      delete store[STATEFUL_TARGET_DRIVERS_SYMBOL as symbol];
    }
  });

  it("uninstalls the driver when lifecycle registration throws (Codex F13)", () => {
    const registry: DriverRegistryMap = new Map();
    const services = makeServices({
      resolveDriverRegistry: () => registry,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      } as never,
    });
    (services.logger.warn as ReturnType<typeof vi.fn>).mockImplementation(() => {});
    const result = registerDualResetDriver(services, {
      lifecycle: {
        registerRuntimeLifecycle: () => {
          throw new Error("lifecycle registry closed");
        },
      },
    });
    expect(result.registered).toBe(false);
    expect(result.reason).toBe("lifecycle-registration-failed");
    expect(registry.has(DUAL_RESET_DRIVER_ID)).toBe(false);
    expect(services.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("uninstalled after failed lifecycle registration"),
    );
  });

  it("lifecycle dispose removes exactly our driver entry", () => {
    const registry: DriverRegistryMap = new Map([["acp", builtinDriver()]]);
    let disposed = false;
    const disposables: Array<() => void> = [];
    const services = makeServices({ resolveDriverRegistry: () => registry });
    const result = registerDualResetDriver(services, {
      lifecycle: { registerRuntimeLifecycle: (r) => disposables.push(r.dispose) },
    });
    expect(result.registered).toBe(true);
    expect(disposables).toHaveLength(1);
    disposables[0]();
    expect(registry.has(DUAL_RESET_DRIVER_ID)).toBe(false);
    expect(registry.has("acp")).toBe(true);
    void disposed;
  });
});

describe("§25 integration — driver claims through the REAL binding adapter", () => {
  // The 2026-10-16 live /reset test failure lived exactly in this seam: the
  // derived dashboard record was never stored, so the adapter's listBySession
  // reversed nothing and the driver deferred to the builtin (work-session-only
  // reset). This test pins the full chain — derive → note → listBySession →
  // claim — without any host code.
  const DASHBOARD_KEY = "agent:claude:dashboard:ca7fde5b-9654-4450-8dc5-4792d9773b9b";
  const DASHBOARD_REF = {
    channel: "webchat" as const,
    accountId: "default",
    conversationId: DASHBOARD_KEY,
  };
  const CFG = {
    agents: {
      entries: {
        claude: {
          cwd: "/share/temp/claude-ws",
          runtime: { type: "acp", acp: { backend: "acpx" } },
        },
      },
    },
  };

  it("derives → notes → claims the plugin-owned key and carries the conversation key", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => CFG });
    const workKey = buildAcpBindingSessionKey({
      channel: "webchat",
      accountId: "default",
      conversationId: DASHBOARD_KEY,
      agentId: "claude",
    });
    // The derived-leg resolve warms the reverse-lookup cache (this is the
    // host's own /reset flow: conversation resolve → registry resolve).
    const derived = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(derived?.targetSessionKey).toBe(workKey);
    const driver = createDualResetDriver({
      resolveDriverRegistry: () => new Map([["acp", builtinDriver()]]),
      getAdapter: () => adapter,
      hasSessionEntry: async () => true,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    const target = await driver.resolveTargetBySessionKey!({ cfg: CFG, sessionKey: workKey });
    expect(target).not.toBeNull();
    expect(target?.conversationSessionKey).toBe(DASHBOARD_KEY);
    expect(target?.sessionKey).toBe(workKey);
  });

  it("defers when NO resolve preceded (empty cache → status quo, self-healing)", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => CFG });
    const workKey = buildAcpBindingSessionKey({
      channel: "webchat",
      accountId: "default",
      conversationId: DASHBOARD_KEY,
      agentId: "claude",
    });
    const driver = createDualResetDriver({
      resolveDriverRegistry: () => new Map([["acp", builtinDriver()]]),
      getAdapter: () => adapter,
      hasSessionEntry: async () => true,
      logger: { debug: () => {}, info: () => {}, warn: () => {} },
    });
    expect(await driver.resolveTargetBySessionKey!({ cfg: CFG, sessionKey: workKey })).toBeNull();
  });
});