/**
 * Plugin entry for acp-dashboard-binding (docs/plugins/sdk-channel-plugins.md
 * Step 3). `register` (via src/entry.ts) registers the channel capability
 * itself (`api.registerChannel({ plugin })`); `registerFull` attaches the
 * runtime seam: the SessionBindingAdapter for the internal webchat scope plus
 * the dashboard bridge (BRIDGE.md §4.1) and — Phase 2.20 (F4) — the
 * `inbound_claim` claim hook for plugin-owned binding records (BRIDGE.md §10,
 * src/reply-claim.ts).
 *
 * Bundle shape (Forensik 2026-10-12, backlog-binding): the deployed record must
 * be a bundled-channel-entry contract record (src/entry.ts) — the
 * channel-core `defineChannelPluginEntry` shape fails the host's
 * resolveBundledChannelModuleEntry check at the bundled root and the gateway
 * skips the plugin entirely (registerFull never ran live since v0.7.13.18).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import {
  getSessionEntry,
  listSessionEntries,
  patchSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";

import {
  BINDING_ACCOUNT_ID,
  BINDING_CHANNEL,
  CHANNEL_ID,
  clearDashboardHarnessProvisions,
  isNativeDispatchModeEnabled,
  resolvePluginDispatchMode,
  setDashboardBindingDispatchMode,
  setDashboardBindingPluginRoot,
  setDashboardBindingProvisioner,
  setOriginWorkspaceReader,
  type DashboardHarnessProvisioner,
} from "./src/agent-map.js";
import {
  isOriginWorkspaceStateDirResolvable,
  readOriginWorkspaceRow,
} from "./src/origin-workspace.js";
import { mirrorClaimReplyToOriginTranscript } from "./src/claim-reply-mirror.js";
import { defineBundledChannelCompatibleEntry } from "./src/entry.js";
import { acpDashboardBindingPlugin, registerDashboardBindingRuntime } from "./src/channel.js";
import {
  createConfigHarnessRoster,
  createDashboardBridge,
  type DashboardBridgeApiLike,
  type DashboardBridgeHandle,
} from "./src/dashboard-bridge.js";
import {
  createHarnessReplyClaimHandler,
  type InboundClaimContextLike,
  type InboundClaimEventLike,
  type InboundClaimResultLike,
} from "./src/reply-claim.js";
import {
  CLONE_ARCHIVE_IDLE_GRACE_MS,
  sweepOwnedStuckSessions,
  type SessionStoreApi,
  type SweepSessionStoreApi,
  type SettleSessionEntryLike,
} from "./src/session-settle.js";

const BRIDGE_LIFECYCLE_ID = "acp-dashboard-binding.dashboard-bridge";

/** Single-line error text for the message-only host logger. */
function errorBrief(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const AUTO_PROVISION_LIFECYCLE_ID = "acp-dashboard-binding.auto-provision";
/** SDK module the ensure contract lives in (official plugin-sdk export, un-gated). */
const ACP_BINDING_RUNTIME_SPECIFIER = "openclaw/plugin-sdk/acp-binding-runtime";

type AcpBindingRuntimeModule = {
  ensureConfiguredAcpBindingReady?: (params: {
    cfg: unknown;
    configuredBinding: { spec: Record<string, unknown> } | null;
  }) => Promise<{ ok: boolean; error?: string }>;
};

/**
 * Maps a HarnessAgentSpec + the origin conversation onto the host ensure
 * contract's ConfiguredAcpBindingSpec.
 *
 * Phase 2.24 (Klon-Modus, GaRoN 05:09): the spec's conversationId is the
 * ORIGIN dashboard conversation key itself — the provisioner passes the origin
 * conversation straight through from the cascade, so a NEW dashboard session
 * (new conversation id) means a NEW ensure-spec conversationId, and
 * `buildConfiguredAcpSessionKey(spec)` (dist persistent-bindings.lifecycle) is
 * bit-for-bit `sha16("webchat:default:<conversationId>")` over the binding
 * grammar → ensure-key ≡ resolve-key (one persistent ACP session per
 * dashboard conversation, up to the host's default retention). The Phase-2.23
 * `:ws:`-reverse-parse of the target key is GONE — no key text is parsed here
 * anymore; the cwd continues to ride in `spec.cwd` (origin workspace when one
 * resolved). The legacy `harness:<agent>` id only reaches this function via
 * the deprecated bridge roster leg, where the conversation IS the pseudo id —
 * consistent there too.
 *
 * Phase 2.24b (Klon-Modus MAIN, GaRoN 06:26 'B GO'): main conversations flow
 * through UNVERÄNDERT — the cascade passes the main conversation
 * (`agent:<id>:main`) as the origin conversation, so the ensure spec's
 * conversationId IS the origin session-key text (Klon-Regel 1:1) and
 * `buildConfiguredAcpSessionKey(spec)` mints the acp_sessions row on the SAME
 * key the adapter's main-clone record answers (for claude:
 * `agent:claude:acp:binding:webchat:default:60bac3d65e697154`). Dist-verified
 * (persistent-bindings.lifecycle-DU_YBswY.mjs): the ensure contract puts NO
 * shape/gate on `spec.conversationId` — the key is built from
 * channel/accountId/conversationId and passed to initializeSession as-is.
 */
function configuredBindingSpecFromHarnessSpec(
  spec: {
    agentId: string;
    harness?: string;
    mode: string;
    cwd?: string;
    backend?: string;
    thinking?: string;
  },
  conversation: { channel: string; accountId: string; conversationId: string },
): Record<string, unknown> {
  return {
    channel: BINDING_CHANNEL,
    accountId: BINDING_ACCOUNT_ID,
    conversationId: conversation.conversationId,
    agentId: spec.agentId,
    acpAgentId: spec.harness ?? spec.agentId,
    mode: spec.mode,
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    ...(spec.backend ? { backend: spec.backend } : {}),
    // Antwort-Geschwindigkeit (v0.7.13.22-Paket d): passt in die Host-
    // runtimeOptions des Ensure-Laufs (persistent-bindings.lifecycle:27-29) —
    // z. B. thinking "off"/"low" für flinke Replik-Turns.
    ...(spec.thinking ? { thinking: spec.thinking } : {}),
  };
}

/**
 * Phase 2.21 (auto-provisioning): registers the SDK-backed provisioner behind
 * agent-map's cascade. Each ensure runs the host's OFFICIAL configured-binding
 * spawn contract — `ensureConfiguredAcpBindingReady` (plugin-sdk
 * `acp-binding-runtime`, NOT trust-gated unlike api.runtime.gateway.request,
 * whose trusted-official check failed live in Phase 3.1) → acpManager
 * initializeSession → real backend `ensureSession` + session-meta write. The
 * provisioned session key is deterministic (agent-map
 * buildHarnessProvisionedSessionKey), so resolves never wait for this.
 *
 * Lifecycle: the plugin owns the session's process lifetime; idle-timeout and
 * runtime retirement follow the host's normal ACP session policy (see
 * BRIDGE.md §11). `harnessSessions` stays the manual override (higher cascade
 * priority) and is no longer required.
 */
function registerHarnessAutoProvision(api: OpenClawPluginApi): void {
  // Phase 2.24 (Klon-Modus, GaRoN 05:09): the provisioner receives the origin
  // conversation + target session key from the cascade and passes the origin
  // conversationId STRAIGHT THROUGH into the host ensure spec —
  // `buildConfiguredAcpSessionKey(spec)` mints the acp_sessions row on the
  // SAME key the resolve answers (ensure-key ≡ resolve-key), one persistent
  // ACP session per dashboard conversation. The cwd rides in the spec too
  // (origin workspace when one resolved); no key-text parsing here anymore
  // (the Phase-2.23 `:ws:`-reverse-parse section was removed).
  const provisioner: DashboardHarnessProvisioner = async (params) => {
    // Variable specifier: the module ships without .d.ts (excluded from the
    // npm package) — a non-literal import stays untyped and resolves at runtime.
    const sdk = (await import(ACP_BINDING_RUNTIME_SPECIFIER).catch(() => undefined)) as
      | AcpBindingRuntimeModule
      | undefined;
    const ensure = sdk?.ensureConfiguredAcpBindingReady;
    if (typeof ensure !== "function") {
      throw new Error(`${ACP_BINDING_RUNTIME_SPECIFIER} unavailable (no ensure contract)`);
    }
    const result = await ensure({
      cfg: api.config,
      configuredBinding: {
        spec: configuredBindingSpecFromHarnessSpec(params.spec, params.conversation),
      },
    });
    if (!result?.ok) {
      throw new Error(result?.error ?? "harness session provisioning failed");
    }
  };
  setDashboardBindingProvisioner(provisioner);
  try {
    api.lifecycle?.registerRuntimeLifecycle?.({
      id: AUTO_PROVISION_LIFECYCLE_ID,
      description: "Clears the acp-dashboard-binding auto-provisioner on plugin dispose.",
      dispose() {
        clearDashboardHarnessProvisions();
      }
    });
  } catch (error) {
    api.logger?.error?.(
      `[${CHANNEL_ID}] failed to register auto-provision lifecycle — ${errorBrief(error)}`
    );
  }
}

/**
 * BRIDGE §19 (v0.7.13.22-Paket a/c): the plugin-sdk session-store surface
 * wired into the claim handler's settlement + the boot sweep. getSessionEntry/
 * patchSessionEntry/listSessionEntries are official plugin-sdk
 * session-store-runtime exports (not trust-gated; the plugin is bundled-root
 * deployed since v0.7.13.18).
 */
function createSessionStoreApi(
  api: OpenClawPluginApi,
): SessionStoreApi & SweepSessionStoreApi {
  return {
    getSessionEntry: (ref) => getSessionEntry(ref as never) as SettleSessionEntryLike | undefined,
    patchSessionEntry: (params) => patchSessionEntry(params as never) as never,
    listSessionEntries: (params) =>
      listSessionEntries(params as never) as Array<{
        sessionKey: string;
        entry: SettleSessionEntryLike;
      }>,
  };
}

/**
 * BRIDGE §20 (v0.7.13.22, "Flüchtigkeit"-Root): the host delivers a claim's
 * terminal reply to the origin conversation but NEVER transcribes it there —
 * the only final-transcript mirror write lives in the agent-run finalization
 * (dispatch-from-config:800/848); `finishPluginBindingDispatch` bookkeeps only
 * (live-DB proof: origin 048d96d7… kept the user message (seq=1) and no
 * assistant record at all, so re-renders lost every claim answer). The host's
 * own channel precedent (Telegram → appendAssistantMirrorMessageByIdentity)
 * names the plugin-visible primitive: `openclaw/plugin-sdk/
 * session-transcript-runtime`. This wires that append (types-less host export
 * — dynamic import; ambient shapes in src/host-transcript.d.ts) into the claim
 * handler. Best-effort: a failed mirror never fails the reply.
 */
const TRANSCRIPT_RUNTIME_SPECIFIER = "openclaw/plugin-sdk/session-transcript-runtime";

type SessionTranscriptRuntimeModule = {
  appendAssistantMirrorMessageByIdentity?: import("./src/claim-reply-mirror.js").AssistantMirrorAppendFn;
};

function createClaimReplyMirror(
  api: OpenClawPluginApi,
  sessionStore: SessionStoreApi,
): NonNullable<
  import("./src/reply-claim.js").HarnessReplyClaimOptions["mirrorClaimReply"]
> {
  return async (params) => {
    try {
      const mod = (await import(/* webpackIgnore: true */ TRANSCRIPT_RUNTIME_SPECIFIER)) as SessionTranscriptRuntimeModule;
      const append = mod.appendAssistantMirrorMessageByIdentity;
      if (typeof append !== "function") {
        api.logger.debug?.(
          `[${CHANNEL_ID}] claim-reply mirror unavailable: host transcript-runtime export missing appendAssistantMirrorMessageByIdentity`,
        );
        return;
      }
      const done = await mirrorClaimReplyToOriginTranscript({
        config: api.config,
        originSessionKey: params.originSessionKey,
        claimRunId: params.claimRunId,
        replyText: params.replyText,
        agentId: params.agentId,
        sessionStore: sessionStore,
        appendAssistantMirror: append,
        logger: {
          debug: (message) => api.logger.debug?.(message),
          warn: (message) => api.logger.warn(message),
        },
      });
      if (!done) {
        api.logger.debug?.(
          `[${CHANNEL_ID}] claim-reply mirror not persisted for ${params.originSessionKey} (run ${params.claimRunId})`,
        );
      }
    } catch (error) {
      api.logger?.warn?.(
        `[${CHANNEL_ID}] claim-reply mirror failed — ${errorBrief(error)}`,
      );
    }
  };
}

/**
 * BRIDGE §19c (v0.7.13.22-Paket c): settles the pre-boot stuck entries the
 * host's own main-session recovery leaves marked with an unsatisfiable
 * restart-recovery delivery for our claimed conversations (99d8daf5… live-DB
 * proof: the Denken-Spinner survives every boot otherwise). Runs at
 * gateway_start — at that point no in-process run can predate the process, so
 * any still-`running` entry of OUR key grammars (dashboard conversations +
 * harness clone targets) among roster harness agents is an orphan.
 */
function registerStuckSessionSweep(api: OpenClawPluginApi, sessionStore: SessionStoreApi): void {
  // LIVE evidence 2026-10-13 (v0.7.13.23 boot log): "hook event gateway_start
  // is dispatched by the typed hook runner only; api.registerHook
  // registrations for it are not invoked. Use api.on(gateway_start, ...)
  // instead." A registry-named registerHook call is contract-legal but INERT
  // for this event. (registerHook here was also the nameless-opts sync-throw
  // shape that dropped the whole plugin on every 0.7.13.22 boot — forensics
  // §9.) api.on fixes the dispatch AND needs no registry name (typed-hook
  // runner contract, same surface as the inbound_claim claim hook below).
  if (typeof (api as { on?: unknown }).on !== "function") {
    api.logger?.warn?.(
      `[${CHANNEL_ID}] plugin api has no typed hook registration (api.on); boot sweep disabled`,
    );
    return;
  }
  (api.on as (
    hookName: string,
    handler: (event: unknown, ctx: unknown) => Promise<void>,
  ) => void)("gateway_start", async () => {
    try {
      const cfg = api.config as { agents?: { entries?: Record<string, unknown> } } | undefined;
      const agentIds = Object.keys(cfg?.agents?.entries ?? {}).filter((agentId) =>
        createConfigHarnessRoster(api.config).isHarnessAgent(agentId),
      );
      if (agentIds.length === 0) return;
      // γ archival leg (PUSHBUG fixes, 2026-10-13): OFF in native dispatch —
      // native has no un-archive leg, so a boot-archived native target is
      // unreachable forever (audit GO-blocker C7). OFF for anything touched
      // within the idle grace — the live "Sekunden-Fenster" miss archived the
      // ACTIVE chat binding seconds after the .26 boot (14:12).
      const sweep = sweepOwnedStuckSessions({
        sessionStore: sessionStore as SweepSessionStoreApi,
        agentIds,
        archiveIdleClones: !isNativeDispatchModeEnabled(),
        archiveIdleAfterMs: CLONE_ARCHIVE_IDLE_GRACE_MS,
        logger: {
          debug: (message) => api.logger.debug?.(message),
          warn: (message) => api.logger.warn(message),
        },
      });
      const result = await sweep;
      if (result.settled.length > 0) {
        api.logger.info(
          `[${CHANNEL_ID}] boot sweep settled ${result.settled.length} stuck session(s): ${result.settled.join(", ")}`,
        );
      }
      if (result.archived.length > 0) {
        api.logger.info(
          `[${CHANNEL_ID}] boot sweep archived ${result.archived.length} harness clone(s) (γ hidden from standard listings, idle ≥ ${CLONE_ARCHIVE_IDLE_GRACE_MS} ms): ${result.archived.join(", ")}`,
        );
      }
    } catch (error) {
      api.logger?.warn?.(`[${CHANNEL_ID}] boot sweep failed — ${errorBrief(error)}`);
    }
  });
}

/**
 * Phase 2.20 (F4): registers the `inbound_claim` typed hook — the claim path
 * plugin-bound binding records dispatch through (see src/reply-claim.ts). Uses
 * `api.on` (typed hook runner registration); `api.registerHook` event names are
 * NOT typed-hook dispatched, and `on` only exists in full registration mode.
 */
function registerHarnessReplyClaimHook(api: OpenClawPluginApi): void {
  if (typeof (api as { on?: unknown }).on !== "function") {
    api.logger?.warn?.(
      `[${CHANNEL_ID}] plugin api has no typed hook registration (api.on); reply delivery claims disabled`,
    );
    return;
  }
  // Phase 3.1 (F4-fix 2.0, Weg A): the harness turn starts through
  // `api.runtime.subagent` (run + waitForRun) — the agent-based spawn surface
  // that is NOT trust-gated (unlike api.runtime.gateway.request, LIVE-failed:
  // "Gateway requests are only available to bundled or trusted official
  // plugins"). gateway.isAvailable stays as the un-gated binding preflight.
  const handler = createHarnessReplyClaimHandler({
    getConfig: () => api.config,
    logger: {
      debug: (message) => api.logger.debug?.(message),
      info: (message) => api.logger.info(message),
      warn: (message) => api.logger.warn(message),
      error: (message) => api.logger.error(message),
    },
    subagent: api.runtime.subagent,
    isGatewayAvailable: () => api.runtime.gateway.isAvailable(),
    sessionStore: createSessionStoreApi(api),
    mirrorClaimReply: createClaimReplyMirror(api, createSessionStoreApi(api)),
  });
  (api.on as (
    hookName: string,
    handler: (
      event: InboundClaimEventLike,
      ctx: InboundClaimContextLike,
    ) => Promise<InboundClaimResultLike>,
  ) => void)("inbound_claim", handler);
}

/**
 * Phase 2.22 (origin-workspace cwd): wires the node:sqlite-backed reader
 * (src/origin-workspace.ts) into agent-map's sync `setOriginWorkspaceReader`
 * seam. Registration happens BEFORE the runtime/bridge so even the earliest
 * Turn-1 resolve sees origin workspaces; a missing state dir logs the
 * degraded mode (the agent-default cwd ladder applies untouched).
 */
function registerOriginWorkspaceReader(api: OpenClawPluginApi): void {
  if (!isOriginWorkspaceStateDirResolvable()) {
    api.logger?.warn?.(
      `[${CHANNEL_ID}] origin-workspace derivation disabled: no OpenClaw state dir resolvable from env`
    );
    return;
  }
  setOriginWorkspaceReader(readOriginWorkspaceRow);
}

// Phase 3 → Repo-Split A2 (2026-10-11): die generalisierte Harness-Config-
// Generierung lebt jetzt im EIGENSTÄNDIGEN Feature-Plugin
// `harness-config-writer` (plugins/harness-config-writer/, Eigene BRIDGE.md).
// Der Config-Key ist plugins.entries['harness-config-writer'].config.harnesses;
// der alte Key plugins.entries['acp-dashboard-binding'].config.harnesses wird
// vom Add-on-Deployment-Helper (oc_acpx_helper.py) einmalig migriert. Dieses
// Channel-Plugin ist damit reiner Dashboard-Key-Brücken-/Claim-Code.

/** Narrow plugin-api projection for the bridge (DashboardBridgeApiLike shape). */
function dashboardBridgeApi(api: OpenClawPluginApi): DashboardBridgeApiLike {
  return {
    id: api.id,
    config: api.config,
    logger: {
      debug: (message: string) => api.logger.debug?.(message),
      info: (message: string) => api.logger.info(message),
      warn: (message: string) => api.logger.warn(message),
      error: (message: string) => api.logger.error(message),
    },
    // Hook events are the loose host shape; hook opts must be FORWARDED —
    // v0.7.13.24: the 2026.10.2 registry contract requires a hook name
    // (opts.name), and a projection that silently dropped the third argument
    // made the bridge's named call nameless again at the host boundary.
    // handler(event, undefined): the bridge never uses the typed-hook ctx.
    registerHook: (events, handler, opts) => {
      api.registerHook(events, (event) => handler(event, undefined) as Promise<void> | void, opts);
    },
    runtime: {
      state: {
        // Phase 2.12 F1: dist contract is {namespace, maxEntries}
        // (OpenKeyedStoreOptions, agent-harness-runtime-R8dTs5zl.d.ts).
        openKeyedStore: <T,>(options: { namespace: string; maxEntries: number }) =>
          api.runtime.state.openKeyedStore<T>(options as never),
      },
    },
  };
}

export default defineBundledChannelCompatibleEntry({
  id: CHANNEL_ID,
  name: "ACP Dashboard Binding",
  description:
    "Resolves webchat/dashboard conversations to ACP harness session targets (codex/claude/opencode) through a SessionBindingAdapter.",
  plugin: acpDashboardBindingPlugin,
  registerFull(api: OpenClawPluginApi) {
    // F4: the plugin root must be known BEFORE the first binding record is
    // synthesized (adapter registration + bridge below) — the host's
    // isPluginOwnedBindingMetadata predicate reads metadata.pluginRoot.
    setDashboardBindingPluginRoot(api.rootDir);
    // Weg B (BRIDGE.md §21): resolve the dispatch mode from live config BEFORE
    // any record producer runs — "native" makes every record path generic and
    // stands the claim hook down; "claim" (default) keeps the Weg-A status quo.
    // A restart re-registers and re-reads config, so a mode flip applies on the
    // next boot (deliberately NOT hot-mid-flight).
    {
      const mode = resolvePluginDispatchMode(api.config);
      setDashboardBindingDispatchMode(mode);
      if (mode === "native") {
        api.logger?.info?.(
          `[${CHANNEL_ID}] dispatch mode = native (Weg B): records answer generic, host dispatch runs turns in the target ACP session`,
        );
      }
    }
    // Phase 2.22: BEFORE the runtime/bridge so even the earliest Turn-1
    // resolve sees origin workspaces; a missing reader degrades to the
    // documented agent-default cwd ladder.
    registerOriginWorkspaceReader(api);
    registerDashboardBindingRuntime(api);
    registerHarnessReplyClaimHook(api);
    // BRIDGE §19: settlement infra — sweep hooks gateway_start; the claim
    // handler receives the same store surface for per-turn settlement + the
    // V39 spawnedBy stamp.
    registerStuckSessionSweep(api, createSessionStoreApi(api));
    // Phase 3/Repo-Split A2: harness config deployment now lives in the
    // standalone `harness-config-writer` feature plugin (registered by the
    // add-on helper, see its own BRIDGE.md / plugins/harness-config-writer/).
    // Phase 2.21: persistent per-agent harness sessions are provisioned by the
    // plugin itself (config option plugins.entries['acp-dashboard-binding']
    // .config.autoProvision, default true; harnessSessions = manual override).
    registerHarnessAutoProvision(api);
    // BRIDGE.md §4.1: the bridge after registerChannel. It registers its own
    // webchat adapter only while "webchat:default" is still free — channel.ts
    // just registered ours, so the bridge lands in hooks-only mode (it never
    // double-registers; the adapter keeps Turn-1 synthesis via §4.2
    // row-miss delegation). Creation stays un-awaited because the host calls
    // registerFull synchronously (core-*.mjs: registerFull?.(api)).
    // Phase 2.19 (BRIDGE.md §4.2a): the bridge-not-yet-active window is SAFE —
    // the adapter's §4.2 delegation passes a config-driven roster, so Turn-1
    // resolves answer from the live config (harnessSessions included); the
    // roster/hydration flip to the active bridge cannot change the record.
    let bridge: DashboardBridgeHandle | undefined;
    let disposed = false;
    try {
      api.lifecycle?.registerRuntimeLifecycle?.({
        id: BRIDGE_LIFECYCLE_ID,
        description: "Disposes the acp-dashboard-binding dashboard bridge on plugin dispose.",
        dispose() {
          disposed = true;
          bridge?.dispose();
          bridge = undefined;
        }
      });
    } catch (error) {
      api.logger?.error?.(
        `[${CHANNEL_ID}] failed to register dashboard bridge lifecycle — ${errorBrief(error)}`
      );
    }
    void createDashboardBridge({ api: dashboardBridgeApi(api) })
      .then((handle) => {
        // Race guard: plugin already disposed while the bridge loaded.
        if (disposed) {
          handle.dispose();
          return;
        }
        bridge = handle;
      })
      .catch((error) => {
        api.logger?.error?.(
          `[${CHANNEL_ID}] dashboard bridge startup failed — ${errorBrief(error)}`
        );
      });
  }
});

// No setup-entry.ts (optional per CONTRACT.md): without it the full entry loads
// in every registration mode, so the binding adapter is never gated on the
// channel being "configured" (it has no configuration of its own).