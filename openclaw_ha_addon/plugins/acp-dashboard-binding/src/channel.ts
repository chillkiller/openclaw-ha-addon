/**
 * Channel plugin object + host registration for acp-dashboard-binding.
 *
 * Structure (docs/plugins/sdk-channel-plugins.md):
 * - channel plugin object via `createChatChannelPlugin` + `createChannelPluginBase`
 *   with `conversationBindings.bindingStore: "adapter"` — this channel owns its
 *   bindings through a registered SessionBindingAdapter (core then fails closed
 *   for unresolved bindings of THIS channel id).
 * - the SessionBindingAdapter itself is registered imperatively in
 *   `registerDashboardBindingRuntime(api)` (called from `registerFull`),
 *   keyed to the INTERNAL webchat channel scope (webchat:default) — the scope
 *   the gateway consults for dashboard conversations — plus the plugin's own
 *   channel id so its own namespace stays adapter-owned as it declares.
 */

import { createChatChannelPlugin, createChannelPluginBase } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { registerSessionBindingAdapter, unregisterSessionBindingAdapter } from "openclaw/plugin-sdk/conversation-runtime";

import { BINDING_ACCOUNT_ID, BINDING_CHANNEL, CHANNEL_ID, buildChannelAccountKey } from "./agent-map.js";
import { createDashboardBindingAdapter, type DashboardBindingAdapter } from "./binding-adapter.js";

type BindingAccount = {
  accountId: string | null;
  enabled: boolean;
};

const ADAPTER_LIFECYCLE_ID = "acp-dashboard-binding.session-binding-adapter";

/** Live config holder: refreshed at full runtime registration. */
let configProvider: () => unknown = () => undefined;
const boundAdapters = new Map<string, DashboardBindingAdapter>();

/** The adapter instance bound to the latest config provider (for tests/diagnostics). */
export function getDashboardBindingAdapter(scope = { channel: "webchat", accountId: BINDING_ACCOUNT_ID }): DashboardBindingAdapter | undefined {
  return boundAdapters.get(buildChannelAccountKey(scope));
}

/**
 * Registers the SessionBindingAdapter with the host for the webchat scope and
 * the plugin's own channel id, and wires disposal via plugin lifecycle.
 * Called from `registerFull(api)` in index.ts.
 */
export function registerDashboardBindingRuntime(api: OpenClawPluginApi): void {
  configProvider = () => api.config;
  registerHarnessBindingAdapter();

  api.lifecycle?.registerRuntimeLifecycle?.({
    id: ADAPTER_LIFECYCLE_ID,
    description: "Unregisters the acp-dashboard-binding SessionBindingAdapter on plugin dispose.",
    dispose() {
      for (const [scopeKey, adapter] of [...boundAdapters]) {
        const scope = REGISTERED_SCOPES.find((candidate) => buildChannelAccountKey(candidate) === scopeKey);
        if (scope) {
          unregisterSessionBindingAdapter({ channel: scope.channel, accountId: scope.accountId, adapter });
        }
        boundAdapters.delete(scopeKey);
      }
      configProvider = () => undefined;
    }
  });
}

/** Conversation scopes this plugin owns bindings for. */
const REGISTERED_SCOPES = [
  { channel: BINDING_CHANNEL, accountId: BINDING_ACCOUNT_ID },
  { channel: CHANNEL_ID, accountId: BINDING_ACCOUNT_ID }
] as const;

function registerHarnessBindingAdapter(): void {
  // One adapter instance PER SCOPE with the matching channel field — the host
  // keys the adapter registry by the adapter object's own channel/accountId
  // (see DashboardBindingAdapterOptions note).
  for (const scope of REGISTERED_SCOPES) {
    const scopeKey = buildChannelAccountKey(scope);
    const adapter = createDashboardBindingAdapter({
      channel: scope.channel,
      accountId: scope.accountId,
      getConfig: () => configProvider()
    });
    boundAdapters.set(scopeKey, adapter);
    registerSessionBindingAdapter(adapter);
  }
}

/**
 * Channel plugin object. Minimal surface: this channel transports nothing of
 * its own (no webhook, no monitor) — its job is the binding capability.
 */
const baseCore = createChannelPluginBase<BindingAccount>({
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "ACP Dashboard Binding",
    selectionLabel: "ACP Dashboard Binding",
    docsPath: "/plugins/sdk-channel-plugins",
    blurb: "Binds dashboard conversations to ACP harness sessions (codex/claude/opencode)."
  },
  capabilities: {
    chatTypes: ["direct"]
  },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: (): BindingAccount => ({ accountId: "default", enabled: true }),
    inspectAccount: () => ({
      enabled: true,
      configured: true,
      bindingStatus: "adapter"
    }),
    defaultAccountId: () => "default",
    isConfigured: () => true
  },
  setup: {
    applyAccountConfig: ({ cfg }: { cfg: OpenClawConfig }) => cfg,
    validateInput: () => null
  }
});

export const acpDashboardBindingPlugin = createChatChannelPlugin<BindingAccount>({
  base: {
    ...baseCore,
    conversationBindings: {
      supportsCurrentConversationBinding: true,
      bindingStore: "adapter",
      defaultTopLevelPlacement: "current"
    },
    // The builder's Partial view widens these to optional; re-seat them as the
    // required ChannelPlugin fields they really are (both provided above).
    config: baseCore.config!,
    setup: baseCore.setup!
  }
});