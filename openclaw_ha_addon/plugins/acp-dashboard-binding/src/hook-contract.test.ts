import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getDashboardBindingDispatchMode,
  resetDashboardBindingDispatchModeForTest,
} from "./agent-map.js";

/**
 * §9.2 register-crash forensics 2026-10-13 (agents/coding-review/findings/
 * 2026-10-13-register-crash-forensics.md): the OpenClaw 2026.10.2 registry
 * THROWS "hook registration missing name" for every api.registerHook
 * registration without opts.name (registry-854ZO8XT.mjs:2937-2941), and the
 * plugin-api wrapper forwards opts verbatim (:781). The pre-existing test
 * mocks silently accepted anything (the forensics §7a gap) — which is how
 * the nameless boot-sweep and bridge calls shipped through a green suite.
 * These tests exercise registerFull against the FAITHFUL host contract.
 */

vi.mock("openclaw/plugin-sdk/session-store-runtime", () => ({
  getSessionEntry: vi.fn(() => undefined),
  patchSessionEntry: vi.fn(() => undefined),
  listSessionEntries: vi.fn(() => []),
}));

type RegisteredHook = { events: string[]; name: string | undefined };

/**
 * Verbatim 2026.10.2 registry contract (names/semantics of
 * registry-854ZO8XT.mjs:2937-2941, minus the entry-push bookkeeping the
 * plugin never observes): unknown event names pass, opts?.name?.trim() is
 * the only name source at this api level, duplicate names error.
 */
function createHostContractRegisterHook(registry: RegisteredHook[]) {
  return (events: string | string[], handler: unknown, opts?: unknown): void => {
    void handler;
    const normalized = Array.isArray(events) ? events : [events];
    const name = (opts as { name?: string } | undefined)?.name?.trim();
    if (!name) throw new Error("hook registration missing name");
    if (registry.some((hook) => hook.name === name)) {
      throw new Error(`hook already registered: ${name}`);
    }
    registry.push({ events: normalized, name });
  };
}

function createHookContractApi() {
  const registry: RegisteredHook[] = [];
  const typedHooks: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const api = {
    rootDir: "/tmp/hook-contract-root",
    id: "acp-dashboard-binding",
    config: { agents: { entries: {} } },
    logger: {
      debug: (_m: string) => undefined,
      info: (_m: string) => undefined,
      warn: (_m: string) => undefined,
      error: (m: string) => {
        throw new Error(`unexpected plugin error log at register time: ${m}`);
      },
    },
    registerHook: createHostContractRegisterHook(registry),
    on: (event: string, _handler: unknown) => {
      typedHooks.push(event);
    },
    lifecycle: {
      registerRuntimeLifecycle: (_reg: unknown) => undefined,
    },
    // registerHarnessReplyClaimHook resolves these at register time (the
    // real api always carries them; the contract test only needs the shape).
    runtime: {
      subagent: {},
      gateway: { isAvailable: () => false },
    },
  };
  return {
    api,
    registry,
    typedHooks,
    unhandled,
    offUnhandled: () => process.off("unhandledRejection", onUnhandled),
  };
}

describe("registerFull vs host hook-name contract (§9.2, register-crash forensics)", () => {
  it("registers bridge inbound hook NAMED + sweep/claim via typed hook runner", async () => {
    const { api, registry, typedHooks, unhandled, offUnhandled } = createHookContractApi();
    try {
      const entry = (await import("../index.js")).default;
      expect(typeof entry.registerFull).toBe("function");
      entry.registerFull(api);
      // registerFull launches the bridge un-awaited; let its async body reach
      // its own registerHook so the contract sees the complete inventory.
      await new Promise((resolve) => setTimeout(resolve, 100));
      // The boot sweep rides the typed hook runner (LIVE 0.7.13.23 boot
      // evidence: "hook event gateway_start is dispatched by the typed hook
      // runner only; api.registerHook registrations for it are not invoked")
      // — the only registerHook registration left is the bridge inbound one.
      expect(
        registry.map((hook) => `${hook.name}`,
        ),
      ).toEqual(["acp-dashboard-binding:inbound"]);
      expect(registry[0].events).toEqual(["message_received", "before_dispatch"]);
      expect(typedHooks).toEqual(["inbound_claim", "gateway_start"]);
      expect(unhandled).toEqual([]);
    } finally {
      offUnhandled();
    }
  });
});

// --- Weg B: dispatchMode resolution at registerFull (BRIDGE.md §21) ----------
//
// The mode is resolved from live config BEFORE any record producer runs; a
// flip applies on the next boot because registerFull re-registers. The hook
// INVENTORY is identical in both modes (inbound_claim is registered
// unconditionally — in native mode the handler stands down per-record, the
// registration itself must never flip: rollback = config flip, not re-plugin).

describe("registerFull resolves dispatchMode without changing the hook inventory (Weg B)", () => {
  afterEach(() => {
    resetDashboardBindingDispatchModeForTest();
  });

  it("mode = native with the config flip; same registerHook/typed-hook inventory", async () => {
    const { api, registry, typedHooks, unhandled, offUnhandled } = createHookContractApi();
    try {
      (api.config as Record<string, unknown>) = {
        plugins: { entries: { "acp-dashboard-binding": { config: { dispatchMode: "native" } } } },
      };
      const entry = (await import("../index.js")).default;
      entry.registerFull(api);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(getDashboardBindingDispatchMode()).toBe("native");
      expect(registry.map((hook) => hook.name)).toEqual(["acp-dashboard-binding:inbound"]);
      expect(registry[0].events).toEqual(["message_received", "before_dispatch"]);
      expect(typedHooks).toEqual(["inbound_claim", "gateway_start"]);
      expect(unhandled).toEqual([]);
    } finally {
      offUnhandled();
    }
  });

  it("mode stays claim on a garbage value (rollback direction is never accidental)", async () => {
    const { api, offUnhandled } = createHookContractApi();
    try {
      (api.config as Record<string, unknown>) = {
        plugins: { entries: { "acp-dashboard-binding": { config: { dispatchMode: "NATIVE" } } } },
      };
      const entry = (await import("../index.js")).default;
      entry.registerFull(api);
      expect(getDashboardBindingDispatchMode()).toBe("claim");
    } finally {
      offUnhandled();
    }
  });
});

describe("registerHook call-site inventory (§9.2a static tripwire)", () => {
  const FILES = ["../index.ts", "dashboard-bridge.ts", "channel.ts"];

  /** Counts top-level arguments between the call's surrounding parens. */
  function argumentCount(source: string, openIndex: number): { count: number; args: string[] } {
    let depth = 0;
    let current = "";
    const args: string[] = [];
    for (let i = openIndex; i < source.length; i += 1) {
      const char = source[i];
      if (char === "(") {
        depth += 1;
        if (depth === 1) continue;
      }
      if (char === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      if (char === "," && depth === 1) {
        args.push(current);
        current = "";
        continue;
      }
      current += char;
    }
    args.push(current);
    return { count: args.length, args };
  }

  /** Strips comments and string bodies so call sites scan reliably. */
  function stripNoise(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, " ")
      .replace(/(["'`])(?:\\.|(?!\1)[\s\S])*\1/g, '""');
  }

  it("every api.registerHook call site passes non-undefined hook opts", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const violations: string[] = [];
    const found: string[] = [];
    for (const file of FILES) {
      const source = stripNoise(readFileSync(path.join(import.meta.dirname, file), "utf8"));
      const pattern = /registerHook\s*\(/g;
      for (const match of source.matchAll(pattern)) {
        const open = match.index + match[0].length - 1;
        const { count, args } = argumentCount(source, open);
        found.push(`${file}:call@${match.index} (arity ${count})`);
        const last = args[count - 1] ?? "";
        // arity 2 or a trailing `undefined` opts = the .22 register-crash shape.
        if (count < 3 || last.trim() === "undefined") {
          violations.push(`${file}: registerHook call with arity ${count}, last arg "${last.slice(0, 60)}"`);
        }
      }
    }
    // Guard the scanner itself: it must see the two remaining real call sites
    // (bridge inbound + projection forward) — the boot sweep moved to api.on
    // (typed hook runner) per the live 0.7.13.23 boot evidence, otherwise
    // this test proves nothing.
    expect(found.length, JSON.stringify({ found, violations })).toBeGreaterThanOrEqual(2);
    expect(violations).toEqual([]);
  });
});
