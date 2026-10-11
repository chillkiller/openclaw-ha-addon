/**
 * Plugin entry for acp-dashboard-binding (docs/plugins/sdk-channel-plugins.md
 * Step 3). `defineChannelPluginEntry` registers the channel capability itself
 * (`api.registerChannel({ plugin })`); `registerFull` attaches the runtime
 * seam: the SessionBindingAdapter for the internal webchat scope plus the
 * dashboard bridge (BRIDGE.md §4.1) and — Phase 2.20 (F4) — the
 * `inbound_claim` claim hook for plugin-owned binding records (BRIDGE.md §10,
 * src/reply-claim.ts).
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import {
  BINDING_ACCOUNT_ID,
  BINDING_CHANNEL,
  CHANNEL_ID,
  clearDashboardHarnessProvisions,
  setDashboardBindingPluginRoot,
  setDashboardBindingProvisioner,
  setOriginWorkspaceReader,
  type DashboardHarnessProvisioner,
} from "./src/agent-map.js";
import {
  isOriginWorkspaceStateDirResolvable,
  readOriginWorkspaceRow,
} from "./src/origin-workspace.js";
import { acpDashboardBindingPlugin, registerDashboardBindingRuntime } from "./src/channel.js";
import {
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
  deployHarnessConfigs,
  resolveHarnessWriterPaths,
  type HarnessWriterLogger,
} from "./src/harness-config-writer.js";

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

/**
 * Phase 3 (generalisierte Harness-Config, GaRoN 10:37 / Owner-Design 10:37):
 * deployt je nach Mechanismus die natives Harness-Config-Surface aus
 * plugins.entries['acp-dashboard-binding'].config.harnesses (src/
 * harness-config-writer.ts, BRIDGE.md §15). ADDITIV-GARANTIE: fehlt die
 * Section bzw. ein Harness → NICHTS geschrieben, der bundled acpx-Default
 * (eigene Vendor-Auth) greift unverändert (native Claude Pro / ChatGPT Plus /
 * Copilot-OAuth laufen identisch zum Default).
 *
 * Trigger: Plugin-Load (registerFull) — alle Writer sind idempotent
 * (install-if-missing bzw. bytes-sync, Helper-Semantik). Ein verifizierter
 * config-change-Hook existiert nicht → Harness-Config-Änderungen gelten beim
 * NÄCHSTEN BOOT (BRIDGE.md §15.4). Fail-soft: ein Deploy-Fehler darf das
 * Plugin-Load niemals crashen (Warnung, binding bleibt unberührt).
 */
function registerHarnessConfigDeployment(api: OpenClawPluginApi): void {
  try {
    const harnesses = (api.config as { harnesses?: unknown } | undefined)?.harnesses;
    if (harnesses === null || typeof harnesses !== "object" ||
        Object.keys(harnesses as Record<string, unknown>).length === 0) {
      // Absence = no-op (still — kein Log-Noise im Default-Fall).
      return;
    }
    const paths = resolveHarnessWriterPaths();
    if (paths === null) {
      api.logger?.warn?.(
        `[${CHANNEL_ID}] harness config deployment skipped: no OpenClaw state dir resolvable from env`,
      );
      return;
    }
    const logger: HarnessWriterLogger = {
      debug: (message) => api.logger.debug?.(message),
      info: (message) => api.logger.info(message),
      warn: (message) => api.logger.warn(message),
    };
    const report = deployHarnessConfigs(api.config, paths, logger);
    for (const result of report.results) {
      for (const warning of result.warnings) {
        api.logger?.warn?.(`[${CHANNEL_ID}] harness ${result.harnessId}: ${warning}`);
      }
    }
    api.logger?.info?.(
      `[${CHANNEL_ID}] harness config deployment: ${report.results
        .map((r) => `${r.harnessId}=${r.mechanism}`)
        .join(", ")} (harnesses config surface, BRIDGE.md §15)`,
    );
  } catch (error) {
    api.logger?.error?.(
      `[${CHANNEL_ID}] harness config deployment failed (fail-soft, binding unaffected) — ${errorBrief(error)}`,
    );
  }
}

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
    // The bridge never passes hook opts; hook events are the loose host shape.
    registerHook: (events, handler) => {
      api.registerHook(events, (event) => handler(event, undefined) as Promise<void> | void, undefined);
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

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: "ACP Dashboard Binding",
  description:
    "Resolves webchat/dashboard conversations to ACP harness session targets (codex/claude/opencode) through a SessionBindingAdapter.",
  plugin: acpDashboardBindingPlugin,
  registerFull(api) {
    // F4: the plugin root must be known BEFORE the first binding record is
    // synthesized (adapter registration + bridge below) — the host's
    // isPluginOwnedBindingMetadata predicate reads metadata.pluginRoot.
    setDashboardBindingPluginRoot(api.rootDir);
    // Phase 2.22: BEFORE the runtime/bridge so even the earliest Turn-1
    // resolve sees origin workspaces; a missing reader degrades to the
    // documented agent-default cwd ladder.
    registerOriginWorkspaceReader(api);
    registerDashboardBindingRuntime(api);
    registerHarnessReplyClaimHook(api);
    // Phase 3: generalized harness config deployment (additive to acpx,
    // idempotent, config changes apply on next boot — see BRIDGE.md §15).
    registerHarnessConfigDeployment(api);
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