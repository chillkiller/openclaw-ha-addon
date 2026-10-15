/**
 * §25 — Dual-Reset stateful binding target driver (GaRoN 2026-10-16 "wir
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
 *   writes transcript mirrors by it). The reset runs through the OFFICIAL
 *   plugin gateway surface — `api.runtime.gateway.request("sessions.reset",
 *   …, { scopes: ["operator.admin"] })` (RuntimeGatewayRequestOptions,
 *   "Honored only for bundled or trusted official plugins"; our plugin is
 *   bundled-root deployed since v0.7.13.18, gateway-chat client uses the same
 *   RPC) → sessions-mutations handler → `performGatewaySessionReset` on the
 *   CONVERSATION key. Plugin-ownership does not block it: host-created
 *   conversation entries carry no `pluginOwnerId`
 *   (resolvePluginSessionOwnershipError allows rows the caller did not create
 *   when no owner is stamped).
 * - LEG 2 is BEST-EFFORT and existence-guarded: the leg only fires when the
 *   conversation entry currently exists (a reset RPC on a key without an
 *   entry would `authorizeGatewaySessionCreation` and materialize a STRAY
 *   session row instead of resetting anything). Any leg-2 failure is logged
 *   and never degrades the overall result — worst case the plugin degrades to
 *   exactly today's behavior (work-session reset only).
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
   * §25 extension: the connector conversation session-key text taken from the
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
  hasSessionEntry: (sessionKey: string) => Promise<boolean>;
  gatewayRequest: <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { scopes?: string[]; timeoutMs?: number },
  ) => Promise<T>;
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
      // LEG 2 — connector conversation (§25, GaRoN). Best-effort: every
      // failure path below keeps the work result (never a ⚠️ for a leg the
      // status quo never performed).
      const conversationKey = params.bindingTarget?.conversationSessionKey;
      if (!conversationKey) return work;
      try {
        const exists = await services.hasSessionEntry(conversationKey);
        if (!exists) {
          services.logger.debug?.(
            `[acp-dashboard-binding] dual reset: origin conversation reset skipped (no session entry for ${conversationKey})`,
          );
          return work;
        }
        const conversationAgentId = agentIdFromSessionKey(conversationKey);
        const result = (await services.gatewayRequest(
          "sessions.reset",
          {
            key: conversationKey,
            ...(conversationAgentId ? { agentId: conversationAgentId } : {}),
            ...(params.reason === "new" ? { reason: "new" } : { reason: "reset" }),
          },
          // §25: operator.admin is the scope the sessions.reset policy row
          // demands; honored only for bundled/trusted plugins (ours is bundled-
          // root deployed) — see RuntimeGatewayRequestOptions docs.
          { scopes: ["operator.admin"] },
        )) as { ok?: boolean; entry?: { sessionId?: string } } | undefined;
        if (result?.ok) {
          services.logger.info(
            `[acp-dashboard-binding] dual reset: origin conversation ${conversationKey} reset committed (session ${result.entry?.sessionId ?? "?"}) — /reset now clears work session AND connector conversation`,
          );
        } else {
          services.logger.warn(
            `[acp-dashboard-binding] dual reset: origin conversation ${conversationKey} reset did not commit (gateway did not confirm ok)`,
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
 * Registers the §25 driver into the host's stateful-target registry. Called
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
  try {
    options?.lifecycle?.registerRuntimeLifecycle?.({
      id: DUAL_RESET_DRIVER_LIFECYCLE_ID,
      description:
        "Unregisters the acp-dashboard-binding dual-reset driver on plugin dispose.",
      dispose() {
        if (map.get(DUAL_RESET_DRIVER_ID) === driver) map.delete(DUAL_RESET_DRIVER_ID);
      },
    });
  } catch (error) {
    // Registration itself already happened — never throw past registerFull
    // for a lifecycle nicety (other seams log identically).
    services.logger.warn(
      `[acp-dashboard-binding] failed to register dual reset lifecycle — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  services.logger.debug?.(
    `[acp-dashboard-binding] dual reset driver registered (${DUAL_RESET_DRIVER_ID}, ordering ${builtin ? "after-existing-builtin" : "builtin-pending"})`,
  );
  return { registered: true };
}

/**
 * Real wiring: the plugin-api projection used by registerFull. The sdk seams
 * stay behind dynamic imports so the module's static import graph (and every
 * unit test of it) never pulls the pinned dist SDK.
 */
export function createDualResetDriverServicesFromApi(api: {
  config: unknown;
  logger: DriverLogger;
  /** The full plugin runtime arrives untyped — the gateway.request seam is
   * the only field consumed here (cast inside keeps this boundary SDK-free). */
  runtime?: unknown;
}): DualResetDriverServices {
  const gatewayRequest =
    (
      (api.runtime as { gateway?: { request?: unknown } } | undefined)?.gateway
        ?.request as unknown as DualResetDriverServices["gatewayRequest"] | undefined
    ) ??
    ((..._args: unknown[]) =>
      Promise.reject(new Error("plugin gateway runtime unavailable")));
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
    hasSessionEntry: async (sessionKey) => {
      try {
        const sdk = (await import("openclaw/plugin-sdk/session-store-runtime")) as {
          getSessionEntry?: (ref: unknown) => unknown;
        };
        if (typeof sdk?.getSessionEntry !== "function") return false;
        const agentId = agentIdFromSessionKey(sessionKey) ?? undefined;
        const entry = sdk.getSessionEntry({
          sessionKey,
          ...(agentId ? { agentId } : {}),
        });
        return entry != null;
      } catch {
        return false;
      }
    },
    gatewayRequest,
    logger: api.logger,
  };
}