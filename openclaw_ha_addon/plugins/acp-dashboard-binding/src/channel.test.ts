import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  BINDING_CHANNEL,
  CHANNEL_ID,
  DEFAULT_CWD_PREFIX,
  buildAcpBindingSessionKey,
  buildHarnessProvisionedSessionKey,
  ensureDashboardHarnessProvisioning,
  isHarnessProvisionedSessionKey,
  parseAgentIdFromConversationId,
  pendingDashboardHarnessProvisioning,
  resetDashboardBindingProvisionerForTest,
  resolveAutoProvisionEnabled,
  resolveHarnessAgentSpec,
  resolveHarnessAgentSpecs,
  resolveHarnessSessionTargetKey,
  setDashboardBindingProvisioner,
  type DashboardHarnessProvisioner
} from "./agent-map.js";
import { createDashboardBindingAdapter } from "./binding-adapter.js";
import {
  createDashboardBridge,
  type DashboardBridgeApiLike,
  type SessionBindingRuntimeModule,
} from "./dashboard-bridge.js";

const DASHBOARD_KEY = "agent:codex:dashboard:3f0d9e1c-8b2a-4c4e-9f8a-1d2e3f4a5b6c";
const DASHBOARD_REF = {
  channel: BINDING_CHANNEL,
  accountId: "default",
  conversationId: DASHBOARD_KEY
} as const;

/**
 * Phase 2.7 dynamic-roster fixture: codex/claude dispatch through the ACP
 * harness purely because their entries carry runtime.type==='acp' — NOT
 * because of any fixed id list; "root" (native) and unlisted ids do not.
 */
const HARNESS_CFG = {
  agents: {
    entries: {
      codex: {
        runtime: {
          type: "acp",
          acp: { agent: "codex-harness", mode: "oneshot", cwd: "/share/temp/acpx-workspace/codex", backend: "bridge" }
        }
      },
      claude: {
        cwd: "/share/temp/claude-ws",
        runtime: { type: "acp", acp: { backend: "acpx" } }
      },
      root: { runtime: { type: "native" } }
    }
  }
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

describe("resolveHarnessAgentSpecs (Phase 2.7 dynamic roster)", () => {
  it("rosters exactly the runtime.type==='acp' entries from the config", () => {
    const specs = resolveHarnessAgentSpecs(HARNESS_CFG);
    expect(specs.map((spec) => spec.agentId).sort()).toEqual(["claude", "codex"]);
  });

  it("projects harness/mode/cwd/backend per entry", () => {
    expect(resolveHarnessAgentSpec(HARNESS_CFG, "codex")).toEqual({
      agentId: "codex",
      mode: "oneshot",
      cwd: "/share/temp/acpx-workspace/codex",
      backend: "bridge",
      harness: "codex-harness"
    });
    // claude has no acp.cwd — the entry-level cwd applies; no acp.agent.
    expect(resolveHarnessAgentSpec(HARNESS_CFG, "claude")).toEqual({
      agentId: "claude",
      mode: "persistent",
      cwd: "/share/temp/claude-ws",
      backend: "acpx"
    });
  });

  it("falls back to persistent mode and the DEFAULT_CWD_PREFIX workspace", () => {
    const cfg = { agents: { entries: { codex: { runtime: { type: "acp" } } } } };
    const spec = resolveHarnessAgentSpec(cfg, "codex");
    expect(spec?.mode).toBe("persistent");
    expect(spec?.cwd).toBe(`${DEFAULT_CWD_PREFIX}codex`);
  });

  it("yields an EMPTY roster at undefined/empty config (safe default)", () => {
    expect(resolveHarnessAgentSpecs(undefined)).toEqual([]);
    expect(resolveHarnessAgentSpecs({})).toEqual([]);
    expect(resolveHarnessAgentSpec(undefined, "codex")).toBeNull();
    expect(resolveHarnessAgentSpec({}, "claude")).toBeNull();
  });

  it("never rosters main — even when its entry carries runtime.acp", () => {
    const cfg = {
      agents: {
        entries: {
          main: { runtime: { type: "acp", acp: { agent: "main-harness", mode: "oneshot" } } },
          codex: { runtime: { type: "acp" } }
        }
      }
    };
    expect(resolveHarnessAgentSpecs(cfg).map((spec) => spec.agentId)).toEqual(["codex"]);
    expect(resolveHarnessAgentSpec(cfg, "main")).toBeNull();
  });

  it("keeps non-acp runtimes and unknown agents outside the roster", () => {
    expect(resolveHarnessAgentSpec(HARNESS_CFG, "root")).toBeNull();
    expect(resolveHarnessAgentSpec(HARNESS_CFG, "opencode")).toBeNull();
    // Canonicalized lookup: "Codex" resolves like "codex" (sanitizeAgentId).
    expect(resolveHarnessAgentSpec(HARNESS_CFG, "Codex")?.agentId).toBe("codex");
  });
});

describe("dashboard binding adapter (acceptance #2)", () => {
  it("resolves an ACP target for a codex dashboard conversation", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
    const record = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(record).not.toBeNull();
    expect(record?.targetSessionKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
    );
    expect(record?.targetKind).toBe("session");
    expect(record?.status).toBe("active");
    expect(record?.metadata?.agentId).toBe("codex");
    expect(record?.metadata?.acpAgentId).toBe("codex-harness"); // runtime.acp.agent
    expect(record?.metadata?.mode).toBe("oneshot");
    // Not plugin-owned: the get-reply retarget must still apply.
    expect(record?.metadata?.pluginBindingOwner).toBeUndefined();
  });

  it("derives nothing when getConfig is undefined/empty (safe default)", async () => {
    expect(await createDashboardBindingAdapter().resolveByConversationAsync!(DASHBOARD_REF)).toBeNull();
    expect(await createDashboardBindingAdapter({ getConfig: () => undefined }).resolveByConversationAsync!(DASHBOARD_REF)).toBeNull();
  });

  it("derives nothing for main — even when the config gives main runtime.acp", async () => {
    const cfg = { agents: { entries: { main: { runtime: { type: "acp", acp: { mode: "oneshot" } } } } } };
    const adapter = createDashboardBindingAdapter({ getConfig: () => cfg });
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "agent:main:dashboard:abc" })).toBeNull();
  });

  it("resolves nothing for main and for unknown conversation shapes", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "agent:main:dashboard:abc" })).toBeNull();
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "agent:root:dashboard:abc" })).toBeNull();
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "webchat:default:room:1" })).toBeNull();
    expect(await adapter.resolveByConversationAsync!({ ...DASHBOARD_REF, conversationId: "" })).toBeNull();
  });

  it("is deterministic across resolves (host re-resolve stability check)", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
    const first = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    const second = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(second?.bindingId).toBe(first?.bindingId);
    expect(second?.boundAt).toBe(first?.boundAt); // derived records use boundAt 0
    expect(second?.targetSessionKey).toBe(first?.targetSessionKey);
  });

  it("explicit binds override the derived record and unbind removes them", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
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
    const adapter = createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
    const viaSync = adapter.resolveByConversation(DASHBOARD_REF);
    const viaAsync = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(viaSync).toEqual(viaAsync);
  });
});

// --- Phase 2.18b: config.harnessSessions (F3 Weg A, RE-bestaetigt) ----------
//
// BEFUND (RE, dist-verifiziert): manager.utils resolveStoredAcpSession()
// antwortet kind:"stale" + ACP_SESSION_INIT_FAILED, wenn isAcpSessionKey(key)
// gilt ABER keine acp_sessions-Row mit stored.acp existiert;
// upsertAcpSessionMetaRow schreibt solche Rows NUR beim echten Harness-Spawn.
// => synthetische binding-keys koennen NIE initialisiert werden. Weg A
// traegt die real gespawnten persistenten Session-Keys in
// plugins.entries['acp-dashboard-binding'].config.harnessSessions ein und
// laesst das derive den REAL key als Target liefern; die Gate-Ladder
// (boundAgents > excludedAgents > safe-default) bleibt unangetastet.

/** Key from a one-time `/acp spawn codex` (real acp_sessions row behind it). */
const REAL_CODEX_SESSION_KEY = "agent:codex:acp:session:2c1a5fa9-9d31-4b3e-a7d1-4f9d0d1f2b7e";

function withHarnessSessions(harnessSessions: unknown): Record<string, unknown> {
  return {
    agents: HARNESS_CFG.agents,
    plugins: {
      entries: {
        [CHANNEL_ID]: { config: { harnessSessions } },
      },
    },
  };
}

const CODEX_SPEC = (cfg: unknown) => resolveHarnessAgentSpec(cfg, "codex")!;

describe("Phase 2.18b harnessSessions (F3 Weg A)", () => {
  it("harnessSessions gesetzt: resolve liefert den ECHTEN spawned session key", async () => {
    const cfg = withHarnessSessions({ codex: REAL_CODEX_SESSION_KEY });
    const adapter = createDashboardBindingAdapter({ getConfig: () => cfg });
    const record = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(record?.targetSessionKey).toBe(REAL_CODEX_SESSION_KEY);
    expect(record?.targetKind).toBe("session");
    expect(record?.boundAt).toBe(0); // deterministisch wie bisher
    // Metadata bleibt informativ (mode/cwd/agentId), nicht plugin-owned.
    expect(record?.metadata?.agentId).toBe("codex");
    expect(record?.metadata?.mode).toBe("oneshot");
    expect(record?.metadata?.acpAgentId).toBe("codex-harness");
    expect(record?.metadata?.pluginBindingOwner).toBeUndefined();
  });

  it("harnessSessions NICHT gesetzt: synthetisches Target wie bisher", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
    const record = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(record?.targetSessionKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
    );
    expect(resolveHarnessSessionTargetKey(HARNESS_CFG, CODEX_SPEC(HARNESS_CFG))).toBeNull();
  });

  it("orchestrator-target wird ABGELEHNT (kein agent:main:acp:... als Target)", async () => {
    const cfg = withHarnessSessions({ codex: "agent:main:acp:session:deadbeef-0000-0000-0000-000000000000" });
    expect(resolveHarnessSessionTargetKey(cfg, CODEX_SPEC(cfg))).toBeNull();
    const adapter = createDashboardBindingAdapter({ getConfig: () => cfg });
    const record = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    // Abgelehnt heißt: Eintrag ignoriert -> synthetisches Target, NICHT main.
    expect(record?.targetSessionKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
    );
  });

  it("nicht-ACP-geformter Wert (host isAcpSessionKey) wird abgelehnt", async () => {
    for (const bad of ["agent:codex:main:xyz", "agent:codex", "acx:codex:session:1", "  ", 42]) {
      const cfg = withHarnessSessions({ codex: bad });
      expect(resolveHarnessSessionTargetKey(cfg, CODEX_SPEC(cfg))).toBeNull();
      const adapter = createDashboardBindingAdapter({ getConfig: () => cfg });
      const record = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
      expect(record?.targetSessionKey).toBe(
        buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
      );
    }
  });

  it("bare acp:-geformte Keys sind gueltig; Agent-Anteil ohne Orchestrator bleibt ok", async () => {
    const cfg = withHarnessSessions({ codex: "acp:codex:07f3c2b1-8b2a-4c4e-9f8a-1d2e3f4a5b6c" });
    expect(resolveHarnessSessionTargetKey(cfg, CODEX_SPEC(cfg))).toBe(
      "acp:codex:07f3c2b1-8b2a-4c4e-9f8a-1d2e3f4a5b6c"
    );
  });

  it("Lookup via runtime.acp.agent (harness-id key); harness-id gewinnt bei Kollision", async () => {
    // Keyed by the harness id (runtime.acp.agent "codex-harness").
    const byHarnessId = withHarnessSessions({ "codex-harness": REAL_CODEX_SESSION_KEY });
    expect(resolveHarnessSessionTargetKey(byHarnessId, CODEX_SPEC(byHarnessId))).toBe(REAL_CODEX_SESSION_KEY);
    // claude has NO acp.agent — keyed by its agent id.
    const byAgentId = withHarnessSessions({ claude: "agent:claude:acp:session:aaaa-bbbb" });
    expect(resolveHarnessSessionTargetKey(byAgentId, resolveHarnessAgentSpec(byAgentId, "claude")!)).toBe(
      "agent:claude:acp:session:aaaa-bbbb"
    );
    // Both present: the harness-id entry wins.
    const both = withHarnessSessions({
      "codex-harness": REAL_CODEX_SESSION_KEY,
      codex: "agent:codex:acp:session:cccc-dddd",
    });
    expect(resolveHarnessSessionTargetKey(both, CODEX_SPEC(both))).toBe(REAL_CODEX_SESSION_KEY);
  });

  it("Array-/Nicht-Objekt-Formen und unbekannte harness-ids sind wie NICHT gesetzt", () => {
    for (const harnessSessions of [[], [{ codex: REAL_CODEX_SESSION_KEY }], 42, null]) {
      expect(resolveHarnessSessionTargetKey(withHarnessSessions(harnessSessions), CODEX_SPEC(withHarnessSessions(harnessSessions)))).toBeNull();
    }
    expect(resolveHarnessSessionTargetKey(withHarnessSessions({ opencode: REAL_CODEX_SESSION_KEY }), CODEX_SPEC(withHarnessSessions({})))).toBeNull();
    // Unbekannter harness-id-Entry bleibt ohne Wirkung für codex.
  });

  it("bleibt deterministisch und liest die Option live (kein Cache)", async () => {
    let cfg: unknown = withHarnessSessions({ codex: REAL_CODEX_SESSION_KEY });
    const adapter = createDashboardBindingAdapter({ getConfig: () => cfg });
    const first = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    const second = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(second?.targetSessionKey).toBe(first?.targetSessionKey);
    expect(first?.targetSessionKey).toBe(REAL_CODEX_SESSION_KEY);
    // Config update: harnessSessions entfernt -> sofort wieder synthetisch.
    cfg = HARNESS_CFG;
    expect((await adapter.resolveByConversationAsync!(DASHBOARD_REF))?.targetSessionKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
    );
  });
});

// --- Phase 2.19: Turn-1-Race (Bridge noch nicht aktiv) ----------------------
//
// ROOT CAUSE (codex-Diagnose 7e9298af): createDashboardBridge startet async
// hinter registerFull (der Host awaitet nichts — Phase-2.6-Befund), während
// der Adapter SOFORT registriert ist. In der Lücke antwortete die §4.2-
// Delegation (resolveDashboardBinding[-Async]) mit dem UNBEGRÜNDETEN
// Fallback-Roster (createConfigHarnessRoster(undefined)) → null → der Adapter
// fiel in seine eigene deriveBindingRecord-Synthese, deren Record (bindingId-
// Format, Metadata) von der Bridge-Synthese abweicht — mit harnessSessions
// lief der Fallback am ECHTEN Target vorbei. Fix: beide Delegation-Calls
// übergeben einen config-getriebenen Roster; die aktive Brücke behält
// Vorrang (§4.2), der Fallback synthesize aus der Live-Config.

function makeBridgeApi(config: unknown): DashboardBridgeApiLike {
  return {
    id: CHANNEL_ID,
    config,
    logger: {},
    registerHook: () => undefined,
  } as DashboardBridgeApiLike;
}

/** Statt des dynamischen SDK-Imports: stub (Bridge bleibt hooks-only). */
const STUB_RUNTIME: SessionBindingRuntimeModule = {
  getRegisteredAdapterKeys: () => ["webchat:default"],
  getSessionBindingService: () => ({}),
};

describe("Phase 2.19 Turn-1-Race (Bridge noch nicht aktiv)", () => {
  it("§4.2-Fallback mit config-getriebenem Roster: harnessSessions-Target statt Derivations-Synthese", async () => {
    const cfg = withHarnessSessions({ codex: REAL_CODEX_SESSION_KEY });
    const adapter = createDashboardBindingAdapter({ getConfig: () => cfg });
    // Host-Pfade: async Delegation (diff) UND der Sync-Spiegel (deprecated
    // Pfad) müssen in der Bridge-Lücke beide den echten Key liefern.
    const viaAsync = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    const viaSync = adapter.resolveByConversation(DASHBOARD_REF);
    expect(viaAsync?.targetSessionKey).toBe(REAL_CODEX_SESSION_KEY);
    expect(viaSync?.targetSessionKey).toBe(REAL_CODEX_SESSION_KEY);
    expect(viaSync).toEqual(viaAsync);
    // Antwort STAMMT aus der Delegation (Bridge-Synthese), nicht aus der
    // Adapter-Derivation — Metadata-Herkunft als Beweis.
    expect(viaAsync?.metadata?.origin).toBe("dashboard-bridge");
    expect(viaAsync?.metadata?.acpAgentId).toBe("codex-harness");
  });

  it("auch ohne harnessSessions bleibt die Fallback-Antwort die synthetische (Verhalten stabil)", async () => {
    const adapter = createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
    const record = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(record?.targetSessionKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
    );
  });

  it("Der Record bleibt über den Hydration-Flip hinweg identisch (Lücke → Brücke aktiv → Dispose)", async () => {
    const cfg = withHarnessSessions({ codex: REAL_CODEX_SESSION_KEY });
    const adapter = createDashboardBindingAdapter({ getConfig: () => cfg });
    const inGap = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    const handle = await createDashboardBridge({ api: makeBridgeApi(cfg), sessionBindingRuntime: STUB_RUNTIME });
    try {
      const withBridge = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
      expect(handle.ownsWebchatAdapter).toBe(false);
      expect(withBridge).toEqual(inGap); // deterministisch: resolve→touch→re-resolve sieht EIN Record
    } finally {
      handle.dispose(); // Pointer immer freigeben — keine Testübergreifende Leckage
    }
    const afterDispose = await adapter.resolveByConversationAsync!(DASHBOARD_REF);
    expect(afterDispose).toEqual(inGap);
  });

  it("mit undefined-Config bleibt die Lücke null (Safe-Default unverändert)", async () => {
    expect(await createDashboardBindingAdapter({ getConfig: () => undefined }).resolveByConversationAsync!(DASHBOARD_REF)).toBeNull();
  });
});

// --- Phase 2.21: Workspace-Konvention + Auto-Provisioning (GaRoN 11:59/12:30)
describe("Phase 2.21: Workspace-Konvention + Auto-Provisioning", () => {
  // Module-scoped provisioner state — never leak between suites/tests.
  afterEach(() => {
    resetDashboardBindingProvisionerForTest();
  });

  it("DEFAULT_CWD_PREFIX liegt auf der Agent-Konvention /config/clawd/agents/", () => {
    expect(DEFAULT_CWD_PREFIX).toBe("/config/clawd/agents/");
    const cfg = { agents: { entries: { codex: { runtime: { type: "acp" } } } } };
    expect(resolveHarnessAgentSpec(cfg, "codex")?.cwd).toBe("/config/clawd/agents/codex");
    // entry-cfg cwd winzt weiterhin (Plugin liest echte Pfade aus agents.entries).
    expect(resolveHarnessAgentSpec(HARNESS_CFG, "claude")?.cwd).toBe("/share/temp/claude-ws");
  });

  it("autoProvision: default true; nur explizites boolean false deaktiviert", () => {
    expect(resolveAutoProvisionEnabled(undefined)).toBe(true);
    expect(resolveAutoProvisionEnabled({})).toBe(true);
    for (const autoProvision of [true, "false", 0, null]) {
      expect(resolveAutoProvisionEnabled({ plugins: { entries: { [CHANNEL_ID]: { config: { autoProvision } } } } })).toBe(true);
    }
    expect(resolveAutoProvisionEnabled({ plugins: { entries: { [CHANNEL_ID]: { config: { autoProvision: false } } } } })).toBe(false);
  });

  it("provisionierter Key ist deterministisch pro Agent und host-grammar-gültig", () => {
    const key = buildHarnessProvisionedSessionKey({ agentId: "codex" });
    const expected = buildAcpBindingSessionKey({
      channel: "webchat",
      accountId: "default",
      conversationId: "harness:codex",
      agentId: "codex"
    });
    expect(key).toBe(expected);
    expect(key).toBe(`agent:codex:acp:binding:webchat:default:${expectedHostHash("webchat", "default", "harness:codex")}`);
    expect(key.startsWith("agent:codex:acp:binding:webchat:default:")).toBe(true);
    expect(isHarnessProvisionedSessionKey("codex", key)).toBe(true);
    expect(isHarnessProvisionedSessionKey("codex", buildHarnessProvisionedSessionKey({ agentId: "claude" }))).toBe(false);
    expect(buildHarnessProvisionedSessionKey({ agentId: "codex" })).toBe(key); // deterministisch
  });

  function provisionAdapter() {
    return createDashboardBindingAdapter({ getConfig: () => HARNESS_CFG });
  }

  it("Target-Kaskade: harnessSessions > provisioniert > synthetisch", async () => {
    // 1. Kein Provisioner registriert → synthetisch (Verhalten 2.18b unverändert).
    const synth = await provisionAdapter().resolveByConversationAsync!(DASHBOARD_REF);
    expect(synth?.targetSessionKey).toBe(
      buildAcpBindingSessionKey({ channel: "webchat", accountId: "default", conversationId: DASHBOARD_KEY, agentId: "codex" })
    );
    expect(synth?.metadata?.provisioned).toBeUndefined();

    // 2. Provisioner registriert, kein harnessSessions → provisionierter Key.
    const kicks: Array<[string, string]> = [];
    const provisioner: DashboardHarnessProvisioner = async (spec, targetSessionKey) => {
      kicks.push([spec.agentId, targetSessionKey]);
    };
    setDashboardBindingProvisioner(provisioner);
    const provisioned = await provisionAdapter().resolveByConversationAsync!(DASHBOARD_REF);
    const provKey = buildHarnessProvisionedSessionKey({ agentId: "codex" });
    expect(provisioned?.targetSessionKey).toBe(provKey);
    expect(provisioned?.metadata?.provisioned).toBe(true);
    // Dedupe: wiederholte Resolves starten keinen zweiten Ensure
    // (Signature-Cache nach Erfolg bzw. In-flight-Join).
    expect(await provisionAdapter().resolveByConversationAsync!(DASHBOARD_REF)).toEqual(provisioned);
    expect(kicks).toHaveLength(1);

    // 3. harnessSessions (manueller Override) gewinnt ÜBER den Provisioner.
    const cfgConfigured = withHarnessSessions({ codex: REAL_CODEX_SESSION_KEY });
    const configured = await createDashboardBindingAdapter({ getConfig: () => cfgConfigured })
      .resolveByConversationAsync!(DASHBOARD_REF);
    expect(configured?.targetSessionKey).toBe(REAL_CODEX_SESSION_KEY);
    expect(configured?.metadata?.provisioned).toBeUndefined();

    // 4. autoProvision:false → wieder synthetisch, kein Kick.
    resetDashboardBindingProvisionerForTest();
    setDashboardBindingProvisioner(provisioner);
    const off = await createDashboardBindingAdapter({
      getConfig: () => ({ ...HARNESS_CFG, plugins: { entries: { [CHANNEL_ID]: { config: { autoProvision: false } } } } })
    }).resolveByConversationAsync!(DASHBOARD_REF);
    expect(off?.targetSessionKey).toBe(synth?.targetSessionKey);
    expect(off?.metadata?.provisioned).toBeUndefined();
    expect(kicks).toHaveLength(1);
  });

  it("Ensure-Dedupe: Erfolg mit gleichem Spec wird übersprungen, Spec-Änderung re-ensured, Fehler retried", async () => {
    const ensureCalls: string[] = [];
    let fail = true;
    setDashboardBindingProvisioner(async (spec) => {
      ensureCalls.push(`${spec.agentId}:${spec.cwd ?? "-"}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 0)); // bleibt in-flight
      if (fail) throw new Error("backend down");
    });
    const spec = resolveHarnessAgentSpec(HARNESS_CFG, "codex")!;
    // Fehler: kein Signature-Cache → nächster Consult retried.
    await (ensureDashboardHarnessProvisioning(HARNESS_CFG, spec) ?? Promise.resolve(false));
    await (ensureDashboardHarnessProvisioning(HARNESS_CFG, spec) ?? Promise.resolve(false));
    expect(ensureCalls).toHaveLength(2);

    fail = false;
    await (ensureDashboardHarnessProvisioning(HARNESS_CFG, spec) ?? Promise.resolve(false));
    expect(ensureCalls).toHaveLength(3);
    // Erfolg mit identischem Spec → Skip (null), KEIN vierter Ensure.
    expect(ensureDashboardHarnessProvisioning(HARNESS_CFG, spec)).toBeNull();
    // Anderer Spec (cwd) → Re-Ensure (In-flight-Schutz: pro Agent läuft max. EINS).
    const changed = { ...spec, cwd: "/config/clawd/agents/codex" };
    await (ensureDashboardHarnessProvisioning(HARNESS_CFG, changed) ?? Promise.resolve(false));
    expect(ensureCalls).toHaveLength(4);
    // In-flight wird gejoint, nicht verdoppelt.
    const pending = ensureDashboardHarnessProvisioning(HARNESS_CFG, { ...spec, cwd: "/other/ws" });
    expect(pending).not.toBeNull();
    expect(ensureDashboardHarnessProvisioning(HARNESS_CFG, { ...spec, cwd: "/other/ws" })).toBe(pending);
    expect(ensureCalls).toHaveLength(5);
    await pending ?? 0;
  });

  it("pendingDashboardHarnessProvisioning zeigt den laufenden Ensure (Reply-Claim-Barrier-Seam)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setDashboardBindingProvisioner(async () => {
      await gate;
    });
    const spec = resolveHarnessAgentSpec(HARNESS_CFG, "codex")!;
    const run = ensureDashboardHarnessProvisioning(HARNESS_CFG, spec);
    expect(pendingDashboardHarnessProvisioning("codex")).toBe(run);
    expect(pendingDashboardHarnessProvisioning("claude")).toBeNull();
    release();
    await run;
    expect(pendingDashboardHarnessProvisioning("codex")).toBeNull();
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