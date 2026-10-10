/**
 * Plugin entry for acp-dashboard-binding (docs/plugins/sdk-channel-plugins.md
 * Step 3). `defineChannelPluginEntry` registers the channel capability itself
 * (`api.registerChannel({ plugin })`); `registerFull` attaches the runtime
 * seam: the SessionBindingAdapter for the internal webchat scope plus the
 * dashboard bridge (BRIDGE.md §4.1).
 */

import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

import { CHANNEL_ID } from "./src/agent-map.js";
import { acpDashboardBindingPlugin, registerDashboardBindingRuntime } from "./src/channel.js";
import {
  createDashboardBridge,
  type DashboardBridgeApiLike,
  type DashboardBridgeHandle,
} from "./src/dashboard-bridge.js";

const BRIDGE_LIFECYCLE_ID = "acp-dashboard-binding.dashboard-bridge";

/** Single-line error text for the message-only host logger. */
function errorBrief(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    registerDashboardBindingRuntime(api);
    // BRIDGE.md §4.1: the bridge after registerChannel. It registers its own
    // webchat adapter only while "webchat:default" is still free — channel.ts
    // just registered ours, so the bridge lands in hooks-only mode (it never
    // double-registers; the adapter keeps Turn-1 synthesis via §4.2
    // row-miss delegation). Creation stays un-awaited because the host calls
    // registerFull synchronously (core-*.mjs: registerFull?.(api)).
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