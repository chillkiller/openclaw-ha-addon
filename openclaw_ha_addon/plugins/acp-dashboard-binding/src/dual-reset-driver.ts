/**
 * 25 (dual-reset driver: work reset + conversation reset legs) — Dual-Reset stateful binding target driver (GaRoN 2026-10-16 "wir
 * kriegen es also noch hin, dass in zukunft Befehle auch in der
 * verbindungs-Session, nicht nur in der acp-Session greifen").
 *
 * User-visible problem (reset-noop forensics 2026-10-16, DB-proven): `/reset`
 * in a BOUND dashboard conversation routes to `resetConfiguredBindingTargetInPlace`
 * (dist commands.runtime) and resets ONLY the acp work session — then returns
 * early, so the CONNECTOR conversation session never resets and the visible
 * chat history survives (the origin story: "stiller No-Op"). The bound path
 * never reaches `emitResetCommandHooks`, so the command-hook seam is dark here
 * BY DESIGN; the single plugin-visible seam is the host's stateful-binding-
 * target driver registry.
 *
 * Registry mechanics (dist-verified, 2026.10.2):
 * - `resolveGlobalMap(Symbol.for("openclaw.statefulBindingTargetDrivers"),
 *   "plugin-registry")` stores the Map DIRECTLY on globalThis at that symbol
 *   (global-singleton-0m-JziJW.mjs) — reachable from plugin code without
 *   importing hashed internals. Registered with lifecycle "plugin-registry",
 *   so a plugin reload DRAINS the map (full re-registration on reload).
 * - `resolveStatefulBindingTargetBySessionKey` iterates the map in INSERTION
 *   order and the FIRST driver returning a bindingTarget wins. The builtin
 *   "acp" driver claims every `agent:<id>:acp:binding:…` key via its key-shape
 *   fallback (acp-stateful-target-driver: isAcpSessionKey → stateful target),
 *   i.e. it NEVER returns null for our binding keys. To add the conversation
 *   leg for OUR keys we must therefore sit BEFORE the builtin in insertion
 *   order — registration below re-appends the builtin after ours (identity-
 *   preserving, same driver object) whenever it is already present.
 * - On a clean boot our plugin registers before the builtin's lazy
 *   `ensureStatefulTargetBuiltinsRegistered` (first binding-ensure call), so
 *   natural order is already ours-first; the re-append only covers a hot
 *   registration racing a first ensure.
 *
 * Reset semantics (delegate, don't replicate):
 * - LEG 1 (work session): the builtin's own `resetInPlace`, called verbatim —
 *   admission gate, incognito refusal, `performGatewaySessionReset` with
 *   `armSessionDiffBaselineCapture: true` and system operator actor. Zero
 *   divergence from today's ✅ behavior.
 * - LEG 2 (connector conversation): the binding record's `conversation.
 *   conversationId` IS the origin session-key text (the claim path already
 *   writes transcript mirrors by it). The reset delegates to the BUILTIN
 *   "acp" driver's `resetInPlace` with the CONVERSATION key — that runs
 *   `performGatewaySessionReset` host-side at system-actor level, i.e. the
 *   exact primitive the host's own /reset flow uses for unbound conversation
 *   sessions. The plugin gateway RPC surface ("sessions.reset" with
 *   operator.admin) was tried first and is NOT usable here: the trusted-plugin
 *   dispatch stamps `authorizedPluginId`, and the plugin-ownership gate
 *   (session-plugin-ownership) only passes rows whose `pluginOwnerId` EQUALS
 *   the caller — owner-less host-created conversation rows are rejected with
 *   "did not create it" (LIVE-verified 2026-10-16, .32).
 * - LEG 2 is BEST-EFFORT and existence-guarded: the leg only fires when the
 *   conversation entry currently exists (a reset on a key without an entry
 *   would authorizeGatewaySessionCreation and materialize a STRAY session row
 *   instead of resetting anything). Any leg-2 failure is logged and never
 *   degrades the overall result — worst case the plugin degrades to exactly
 *   today's behavior (work-session reset only).
 */

const BUILTIN_ACP_DRIVER_ID = "acp";

export const DUAL_RESET_DRIVER_ID = "acp-dashboard-binding.dual-reset";

export const STATEFUL_TARGET_DRIVERS_SYMBOL = Symbol.for(
  "openclaw.statefulBindingTargetDrivers"
);

const DUAL_RESET_DRIVER_LIFECYCLE_ID =
  "acp-dashboard-binding.dual-reset-driver";

/** The bindingTarget object the registry resolution hands into resetInPlace. */
type StatefulTargetLike = {
  kind?: unknown;
  driverId?: unknown;
  sessionKey?: unknown;
  agentId?: unknown;
  /**
   * 25 (dual-reset driver: work reset + conversation reset legs) extension: the connector conversation session-key text taken from the
   * owning binding record. Only our driver's targets carry it.
   */
  conversationSessionKey?: string;
};

/** Structural replica of the host stateful binding target driver contract. */
type StatefulBindingTargetDriverLike = {
  id: string;
  resolveTargetBySessionKey?: (params: {
    cfg: unknown;
    sessionKey: string;
    agentId?: string;
  }) => Promise<StatefulTargetLike | null> | StatefulTargetLike | null;
  ensureReady?: (params: {
    cfg: unknown;
    bindingResolution: unknown;
    assertActive?: () => void;
  }) => Promise<{ ok: boolean; error?: string }>;
  resetInPlace?: (params: {
    cfg: unknown;
    sessionKey: string;
    agentId?: string;
    reason?: string;
    commandSource?: string;
    bindingTarget: StatefulTargetLike;
  }) => Promise<{
    ok: boolean;
    skipped?: boolean;
    error?: string;
    sessionKey?: string;
    sessionId?: string;
    storePath?: string;
  }>;
};

type DriverRegistryMap = Map<string, StatefulBindingTargetDriverLike>;

/** Structural slice of the plugin's SessionBindingAdapter the driver needs. */
type DashboardBindingAdapterLike = {
  listBySession: (targetSessionKey: string) => Array<{
    targetSessionKey?: string;
    targetKind?: unknown;
    conversation?: { conversationId?: unknown };
  }>;
};

/** Minimal logger projection (message-only, like the other src/ seams). */
type DriverLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
};

type DualResetDriverServices = {
  /** Defaults to the host globalThis-symbol Map (module-level singleton). */
  resolveDriverRegistry?: () => DriverRegistryMap;
  // Async: the real wiring resolves the adapter through a lazy SDK import.
  getAdapter: () =>
    Promise<DashboardBindingAdapterLike | undefined> | DashboardBindingAdapterLike | undefined;
  /** True when the conversation session entry currently exists (stray-guard). */
  hasSessionEntry: (sessionKey: string, agentId?: string) => Promise<boolean>;
  logger: DriverLogger;
};

/**
 * Resolves the host's driver-registry Map singleton. `Symbol.for` + the
 * global-singleton contract make a local creation SAFE: when the host module
 * loads after us, `resolveGlobalMap` finds this exact Map on globalThis and
 * adopts it (same object identity, one registry).
 */
function defaultResolveDriverRegistry(): DriverRegistryMap {
  const store = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = store[STATEFUL_TARGET_DRIVERS_SYMBOL];
  if (existing instanceof Map) return existing as DriverRegistryMap;
  const created = new Map<string, StatefulBindingTargetDriverLike>();
  store[STATEFUL_TARGET_DRIVERS_SYMBOL] = created;
  return created;
}

/** Agent id from an `agent:<agentId>:…` session key (mirrors agent-map's private helper). */
function agentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return null;
  const id = (parts[1] ?? "").trim();
  return id || null;
}

export function createDualResetDriver(
  services: DualResetDriverServices,
): StatefulBindingTargetDriverLike {
  const resolveRegistry =
    services.resolveDriverRegistry ?? defaultResolveDriverRegistry;
  return {
    id: DUAL_RESET_DRIVER_ID,
    // ensureReady intentionally ABSENT: binding ensures resolve their target by
    // the binding spec's driverId ("acp" builtin), never by our id — nothing
    // should be waiting on us before traffic.
    async resolveTargetBySessionKey(params) {
      // Delegate-only design: claim NOTHING while the builtin reset leg is
      // absent — resolution would otherwise fall through the loop to nothing.
      const registry = resolveRegistry();
      const builtin = registry.get(BUILTIN_ACP_DRIVER_ID);
      if (!builtin?.resetInPlace) return null;
      const sessionKey = (params.sessionKey ?? "").trim();
      if (!sessionKey) return null;
      const adapter = await services.getAdapter();
      const record = (adapter?.listBySession?.(sessionKey) ?? []).find(
        (candidate) =>
          (candidate?.targetSessionKey ?? "").trim() === sessionKey &&
          candidate?.targetKind === "session" &&
          typeof candidate?.conversation?.conversationId === "string" &&
          candidate.conversation.conversationId.trim().length > 0,
      );
      if (!record) return null; // foreign key → defer to the builtin (status quo)
      const conversationSessionKey = (
        record.conversation?.conversationId as string
      ).trim();
      // Degenerate self-target guard: never "reset the conversation" with the
      // conversation key that IS the work key under resolution.
      if (conversationSessionKey === sessionKey) return null;
      // Cross-session guard (Codex audit F6): the conversation key must speak
      // for the SAME agent as the work key — derived records guarantee this
      // structurally, but an explicit bind could map a work key to a foreign
      // agent's conversation. A mismatch defers to the builtin (status quo).
      if (agentIdFromSessionKey(conversationSessionKey) !== agentIdFromSessionKey(sessionKey)) {
        services.logger.warn(
          `[acp-dashboard-binding] dual reset: agent mismatch between binding ${sessionKey} and conversation ${conversationSessionKey} — deferring`,
        );
        return null;
      }
      const agentId = agentIdFromSessionKey(sessionKey);
      return {
        kind: "stateful",
        driverId: DUAL_RESET_DRIVER_ID,
        sessionKey,
        ...(agentId ? { agentId } : {}),
        conversationSessionKey,
      };
    },
    async resetInPlace(params) {
      const registry = resolveRegistry();
      const builtin = registry.get(BUILTIN_ACP_DRIVER_ID);
      if (!builtin?.resetInPlace) {
        // Resolve-gating makes this unreachable in practice; fail LOUD anyway
        // (the ⚠️ reply beats a silent half-reset).
        services.logger.warn(
          "[acp-dashboard-binding] dual reset skipped: builtin acp driver vanished from the registry",
        );
        return { ok: false, error: "builtin acp reset driver unavailable" };
      }
      // LEG 1 — work session, the builtin's own reset semantics verbatim.
      const work = await builtin.resetInPlace({
        ...params,
        bindingTarget: params.bindingTarget,
      });
      if (!work?.ok) return work;
      // LEG 2 — connector conversation (25 (dual-reset driver: work reset + conversation reset legs), GaRoN). Delegated to the SAME
      // builtin driver with the conversation key: host-side reset primitive,
      // no plugin-ownership gate (the RPC path is gated; see file header).
      // Best-effort: every failure path below keeps the work result (never a
      // ⚠️ for a leg the status quo never performed).
      const conversationKey = params.bindingTarget?.conversationSessionKey;
      if (!conversationKey) return work;
      try {
        const exists = await services.hasSessionEntry(
          conversationKey,
          // Codex-audit F11: agentId from the WORK key as fallback for keys
          // that don't carry one in their shape.
          agentIdFromSessionKey(params.sessionKey) ?? undefined,
        );
        if (!exists) {
          services.logger.debug?.(
            `[acp-dashboard-binding] dual reset: origin conversation reset skipped (no session entry for ${conversationKey})`,
          );
          return work;
        }
        const conversationAgentId =
          agentIdFromSessionKey(conversationKey) ??
          (typeof params.bindingTarget?.agentId === "string"
            ? params.bindingTarget.agentId
            : undefined);
        const conversation = await builtin.resetInPlace({
          ...params,
          sessionKey: conversationKey,
          agentId: conversationAgentId,
          // Codex-audit F5: pass unknown reasons through verbatim (the host
          // schema today carries only "new" | "reset" — don't collapse future
          // reasons into "reset").
          reason: params.reason === "new" ? "new" : params.reason?.trim() || "reset",
          // Codex-audit F4: mark the conversation leg for host-log forensics.
          commandSource: `${params.commandSource ?? "stateful-target:acp-reset-in-place"}:conversation-leg`,
          // The conversation-leg call belongs to the builtin driver: its id
          // must own the bindingTarget the host would attribute this reset to
          // (Codex-audit F14).
          bindingTarget: {
            kind: "stateful",
            driverId: BUILTIN_ACP_DRIVER_ID,
            sessionKey: conversationKey,
            agentId: conversationAgentId,
          },
        });
        if (conversation?.ok) {
          services.logger.info(
            `[acp-dashboard-binding] dual reset: origin conversation ${conversationKey} reset committed (session ${conversation.sessionId ?? "?"}) — /reset now clears work session AND connector conversation`,
          );
        } else {
          services.logger.warn(
            `[acp-dashboard-binding] dual reset: origin conversation ${conversationKey} reset did not commit (builtin refused: ${conversation?.error ?? "unknown"})`,
          );
        }
      } catch (error) {
        services.logger.warn(
          `[acp-dashboard-binding] dual reset: origin conversation reset failed (work session still reset) — ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      return work;
    },
  };
}

/**
 * Registers the 25 (dual-reset driver: work reset + conversation reset legs) driver into the host's stateful-target registry. Called
 * from registerFull AFTER the binding runtime (the adapter lookup must be
 * live). Registration guarantees ours sits BEFORE the builtin in the map's
 * insertion order — the builtin's key-shape fallback claims our binding keys
 * unconditionally, so without the precedence move our driver could never win
 * resolution for them. Re-registration is idempotent per lifecycle (the host
 * drains the map on plugin reload; dispose deletes our own entry).
 */
export function registerDualResetDriver(
  services: DualResetDriverServices,
  options?: {
    lifecycle?: {
      registerRuntimeLifecycle?: (registration: {
        id: string;
        description: string;
        dispose: () => void;
      }) => void;
    };
  },
): { registered: boolean; reason?: string } {
  const registry = services.resolveDriverRegistry ?? defaultResolveDriverRegistry;
  let map: DriverRegistryMap;
  try {
    map = registry();
  } catch (error) {
    services.logger.warn(
      `[acp-dashboard-binding] dual reset driver not registered — registry resolution failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { registered: false, reason: "registry-resolution-failed" };
  }
  const driver = createDualResetDriver(services);
  // Precedence move (identity-preserving): re-append the builtin AFTER ours.
  // getStatefulBindingTargetDriver(id) lookups and the resolve-loop's same-
  // object guard are unaffected — only insertion order (resolve precedence)
  // changes, and only for keys where our resolve claims first.
  const builtin = map.get(BUILTIN_ACP_DRIVER_ID);
  map.set(DUAL_RESET_DRIVER_ID, driver);
  if (builtin && builtin.id === BUILTIN_ACP_DRIVER_ID) {
    map.delete(BUILTIN_ACP_DRIVER_ID);
    map.set(BUILTIN_ACP_DRIVER_ID, builtin);
  }
  let lifecycleRegistered = false;
  try {
    options?.lifecycle?.registerRuntimeLifecycle?.({
      id: DUAL_RESET_DRIVER_LIFECYCLE_ID,
      description:
        "Unregisters the acp-dashboard-binding dual-reset driver on plugin dispose.",
      dispose() {
        if (map.get(DUAL_RESET_DRIVER_ID) === driver) map.delete(DUAL_RESET_DRIVER_ID);
      },
    });
    lifecycleRegistered = true;
  } catch (error) {
    // Codex-audit F13: a driver without a lifecycle handle would LEAK in the
    // host registry across disposals — uninstall instead of staying
    // registered under a half-registered state.
    map.delete(DUAL_RESET_DRIVER_ID);
    services.logger.warn(
      `[acp-dashboard-binding] dual reset driver uninstalled after failed lifecycle registration — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  services.logger.debug?.(
    `[acp-dashboard-binding] dual reset driver registered (${DUAL_RESET_DRIVER_ID}, ordering ${builtin ? "after-existing-builtin" : "builtin-pending"}, lifecycle ${lifecycleRegistered ? "ok" : "FAILED-driver-uninstalled"})`,
  );
  return { registered: lifecycleRegistered, ...(lifecycleRegistered ? {} : { reason: "lifecycle-registration-failed" }) };
}

/**
 * Real wiring: the plugin-api projection used by registerFull. The sdk seam
 * (session-store entry check) stays behind a dynamic import so the module's
 * static import graph (and every unit test of it) never pulls the pinned
 * dist SDK.
 */
export function createDualResetDriverServicesFromApi(api: {
  config: unknown;
  logger: DriverLogger;
}): DualResetDriverServices {
  return {
    resolveDriverRegistry: defaultResolveDriverRegistry,
    getAdapter: () => {
      // Dynamic: channel.js statically imports openclaw/plugin-sdk/
      // conversation-runtime (host adapter registry); lazily loaded exactly
      // like the other lazy SDK seams in index.ts.
      return import("./channel.js")
        .then(
          (mod) =>
            mod.getDashboardBindingAdapter() as unknown as
              | DashboardBindingAdapterLike
              | undefined,
        )
        .catch(() => undefined);
    },
    hasSessionEntry: async (sessionKey, agentIdFallback) => {
      try {
        const sdk = (await import("openclaw/plugin-sdk/session-store-runtime")) as {
          getSessionEntry?: (ref: unknown) => unknown;
        };
        if (typeof sdk?.getSessionEntry !== "function") return false;
        const agentId = agentIdFromSessionKey(sessionKey) ?? agentIdFallback;
        const entry = sdk.getSessionEntry({
          sessionKey,
          ...(agentId ? { agentId } : {}),
        });
        return entry != null;
      } catch {
        return false;
      }
    },
    logger: api.logger,
  };
}