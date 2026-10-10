import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  BINDING_CHANNEL,
  CHANNEL_ID,
  DEFAULT_CWD_PREFIX,
  buildAcpBindingSessionKey,
  parseAgentIdFromConversationId,
  resolveHarnessAgentSpec
} from "./agent-map.js";
import { createDashboardBindingAdapter } from "./binding-adapter.js";

const DASHBOARD_KEY = "agent:codex:dashboard:3f0d9e1c-8b2a-4c4e-9f8a-1d2e3f4a5b6c";
const DASHBOARD_REF = {
  channel: BINDING_CHANNEL,
  accountId: "default",
  conversationId: DASHBOARD_KEY
} as const;

/** Host equivalence: sha256HexPrefixCore(`${channel}:${accountId}:${conversationId}`, 16). */
function expectedHostHash(channel: string, accountId: string, conversationId: string, length = 16): string {
  return createHash("sha256").update(`${channel}:${accountId}:${conversationId}`, "utf8").digest("hex").slice(0, length);
}

describe("agent-map roster", () => {
  it("recognizes codex/claude/opencode as harness agents", () => {
    expect(parseAgentIdFromConversationId(DASHBOARD_KEY)).toBe("codex");
    expect(parseAgentIdFromConversationId("agent:claude:dashboard:xyz")).toBe("claude");
    expect(parseAgentIdFromConversationId("agent:opencode:dashboard:xyz")).toBe("opencode");
  });

  it("does not match main or non-agent keys", () => {
    expect(parseAgentIdFromConversationId("agent:main:dashboard:xyz")).toBe("main");
    expect(parseAgentIdFromConversationId("someOtherKey")).toBeNull();
    expect(parseAgentIdFromConversationId("")).toBeNull();
  });
});

describe("acp target key equivalence", () => {
  it("matches the host buildConfiguredAcpSessionKey format", () => {
    const key = buildAcpBindingSessionKey({
      channel: "webchat",
      accountId: "default",
      conversationId: DASHBOARD_KEY,
      agentId: "codex"
    });
    expect(key).toBe(`agent:codex:acp:binding:webchat:default:${expectedHostHash("webchat", "default", DASHBOARD_KEY)}`);
    // ACP-shaped: rest starts with "acp:" so host isAcpSessionKey -> true.
    expect(key.startsWith("agent:codex:acp:binding:webchat:default:")).toBe(true);
    expect(key.split(":").slice(2).join(":").startsWith("acp:")).toBe(true);
  });
});

describe("resolveHarnessAgentSpec (agents.entries.<id>.runtime.acp)", () => {
  it("reads cwd/mode/backend from runtime.acp", () => {
    const cfg = {
      agents: {
        entries: {
          codex: {
            runtime: { type: "acp", acp: { mode: "oneshot", cwd: "/share/temp/acpx-workspace/codex", backend: "bridge" } }
          }
        }
      }
    };
    const spec = resolveHarnessAgentSpec(cfg, "codex");
    expect(spec).toMatchObject({ agentId: "codex", mode: "oneshot", cwd: "/share/temp/acpx-workspace/codex", backend: "bridge" });
  });

  it("falls back to persistent mode and the DEFAULT_CWD_PREFIX workspace", () => {
    const spec = resolveHarnessAgentSpec({}, "claude");
    expect(spec?.mode).toBe("persistent");
    expect(spec?.cwd).toBe(`${DEFAULT_CWD_PREFIX}claude`);
  });

  it("returns nothing outside the harness roster (main/unknown)", () => {
    expect(resolveHarnessAgentSpec({}, "main")).toBeNull();
    expect(resolveHarnessAgentSpec({}, "root")).toBeNull();
  });
});

describe("dashboard binding adapter (acceptance #2)", () => {
  it("resolves an ACP target for a codex dashboard conversation", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => ({}) });
    const record = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(record).not.toBeNull();
    expect(record?.targetSessionKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
    );
    expect(record?.targetKind).toBe("session");
    expect(record?.status).toBe("active");
    expect(record?.metadata?.agentId).toBe("codex");
    // Not plugin-owned: the get-reply retarget must still apply.
    expect(record?.metadata?.pluginBindingOwner).toBeUndefined();
  });

  it("resolves nothing for main and for unknown conversation shapes", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => ({}) });
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "agent:main:dashboard:abc" })).toBeNull();
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "agent:root:dashboard:abc" })).toBeNull();
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "webchat:default:room:1" })).toBeNull();
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "" })).toBeNull();
  });

  it("is deterministic across resolves (host re-resolve stability check)", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => ({}) });
    const first = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    const second = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(second?.bindingId).toBe(first?.bindingId);
    expect(second?.boundAt).toBe(first?.boundAt); // derived records use boundAt 0
    expect(second?.targetSessionKey).toBe(first?.targetSessionKey);
  });

  it("explicit binds override the derived record and unbind removes them", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => ({}) });
    const derived = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    const bound = await adapter.bind?.({
      targetSessionKey: buildAcpBindingSessionKey({
        channel: "webchat",
        accountId: "default",
        conversationId: DASHBOARD_KEY,
        agentId: "codex"
      }),
      targetKind: "session",
      conversation: { ...DASHBOARD_REF },
      placement: "current"
    });
    expect(bound).not.toBeNull();
    const resolved = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(resolved?.bindingId).toBe(bound?.bindingId);
    await adapter.unbind?.({
      targetSessionKey: derived?.targetSessionKey,
      scope: { channel: BINDING_CHANNEL, accountId: "default" },
      reason: "test"
    });
    const after = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(after?.bindingId).toBe(derived?.bindingId);
  });

  it("advertises adapter capabilities (bindingStore: adapter contract)", () => {
    const adapter = createDashboardBindingAdapter();
    expect(adapter.channel).toBe(BINDING_CHANNEL);
    expect(adapter.accountId).toBe("default");
    expect(adapter.capabilities).toMatchObject({ bindSupported: true, unbindSupported: true, placements: ["current"] });
    // Contract-required sync mirrors exist alongside the async variants.
    expect(typeof adapter.resolveByConversation).toBe("function");
    expect(typeof adapter.listBySession).toBe("function");
    expect(adapter.resolveByConversationAsync).toBeTypeOf("function");
    expect(adapter.inspectByConversationAsync).toBeTypeOf("function");
    expect(adapter.touchAsync).toBeTypeOf("function");
  });

  it("sync resolveByConversation agrees with the async view", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => ({}) });
    const viaSync = adapter.resolveByConversation(DASHBOARD_REF);
    const viaAsync = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(viaSync).toEqual(viaAsync);
  });
});

// channel.ts imports SDK runtime values; skip cleanly when the host package
// is not resolvable (e.g. isolated test checkout). Phase 3 runs where it is.
// Hoisted to module top level so the await is inside ESM, not the describe cb.
const CHANNEL_MODULE = await (async () => {
  try {
    return await import("./channel.js");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
})();

describe("channel plugin object (only when the openclaw SDK resolves)", () => {

  if (!("acpDashboardBindingPlugin" in CHANNEL_MODULE)) {
    it.skip(`channel plugin loaded — SDK import unavailable (${("error" in CHANNEL_MODULE && CHANNEL_MODULE.error) || "?"})`, () => {});
    return;
  }

  it("exposes the channel plugin id and adapter binding store", () => {
    const { acpDashboardBindingPlugin } = CHANNEL_MODULE as { acpDashboardBindingPlugin: Record<string, unknown> };
    expect(acpDashboardBindingPlugin.id).toBe(CHANNEL_ID);
    const bindings = acpDashboardBindingPlugin.conversationBindings as Record<string, unknown> | undefined;
    expect(bindings?.supportsCurrentConversationBinding).toBe(true);
    expect(bindings?.bindingStore).toBe("adapter");
  });
});