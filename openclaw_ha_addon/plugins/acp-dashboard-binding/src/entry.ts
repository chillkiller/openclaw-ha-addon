/**
 * Bundled-channel entry contract shim (Forensik 2026-10-12).
 *
 * Since the bundled-root deploy (v0.7.13.18, Kammerjäger #2) the plugin ships
 * at `dist/extensions/acp-dashboard-binding/` and the host loads it as a
 * bundled channel. That pipeline (dist/bundled-CMChYPbG.mjs
 * `resolveBundledChannelModuleEntry`, called via `loadGeneratedBundledChannelEntry`
 * → `bundledChannelArtifactLoaders.plugin`) requires the default export to be a
 * record with:
 *   kind === "bundled-channel-entry", string id/name/description,
 *   function register, function loadChannelPlugin.
 *
 * The plugin-sdk channel-core `defineChannelPluginEntry` record (the shape we
 * shipped in v0.7.13.18/.19) has NO `kind` and NO `loadChannelPlugin` — the
 * contract check fails and the host logs
 * `[channels] bundled channel entry acp-dashboard-binding missing
 *  bundled-channel-entry contract; skipping` and never instantiates the plugin:
 * `registerFull` (adapters, claim hook, bridge) never runs in the gateway,
 * every dispatch consult resolves null, and ALL binding falls back to embedded
 * dispatch. (The WARN was invisible to the old smoke check — see backlog 6b.)
 *
 * This shim emits the contract-conformant record while mirroring
 * `defineChannelPluginEntry.register` semantics exactly (same registration-mode
 * branches, same registerChannel-before-registerFull ordering as
 * dist/channel-entry-contract-4VRRlxPz.mjs `defineBundledChannelEntry`), so the
 * record passes BOTH the bundled contract check and the external/plugin-path
 * loader.
 */

/** Loose registration-mode api projection (the host api is structurally wider). */
export type BundledChannelEntryApi = {
  registrationMode?: string;
  registerChannel: (channel: { plugin: unknown }) => void;
};

export type BundledChannelCompatibleEntry<C, F> = {
  /** Host contract marker — resolveBundledChannelModuleEntry gates on it. */
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  /** Full-register flow, same branches as defineChannelPluginEntry. */
  register: (api: BundledChannelEntryApi) => void;
  /** Host contract: lazy channel-plugin access (bundledChannelArtifactLoaders.plugin). */
  loadChannelPlugin: () => C;
  /** Compatibility surface for external-path loaders / in-process probes. */
  channelPlugin: C;
  /** Exposed for probes/tests that call the runtime seam directly. */
  registerFull?: F;
};

export function defineBundledChannelCompatibleEntry<C, F extends (api: never) => void>(params: {
  id: string;
  name: string;
  description: string;
  plugin: C;
  registerFull?: F;
  registerCliMetadata?: (api: BundledChannelEntryApi) => void;
  registerCapabilities?: (api: BundledChannelEntryApi) => void;
}): BundledChannelCompatibleEntry<C, F> {
  const { id, name, description, plugin, registerFull, registerCliMetadata, registerCapabilities } =
    params;
  return {
    kind: "bundled-channel-entry",
    id,
    name,
    description,
    register(api: BundledChannelEntryApi) {
      if (api.registrationMode === "cli-metadata") {
        registerCliMetadata?.(api);
        return;
      }
      if (api.registrationMode === "tool-discovery") {
        // The register-time api is the FULL host api in every mode that reaches
        // registerFull (full / tool-discovery); BundledChannelEntryApi only
        // narrows what registerChannel needs.
        registerFull?.(api as never);
        registerCapabilities?.(api);
        return;
      }
      api.registerChannel({ plugin });
      if (api.registrationMode === "discovery") {
        registerCliMetadata?.(api);
        registerCapabilities?.(api);
        return;
      }
      if (api.registrationMode !== "full") return;
      registerCliMetadata?.(api);
      registerFull?.(api as never);
      registerCapabilities?.(api);
    },
    loadChannelPlugin: () => plugin,
    channelPlugin: plugin,
    registerFull,
  };
}