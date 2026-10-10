/**
 * Shared constants + harness-agent roster lookup for the acp-dashboard-binding plugin.
 *
 * This module is the single source of truth for the constants that BOTH plugin
 * halves import (per CONTRACT.md): the plugin skeleton here and the dashboard
 * key bridge from the opencode harness. Keep it free of any SDK value imports
 * (type-only imports are fine) so tests and the bridge can load it standalone.
 */

import { createHash } from "node:crypto";

/**
 * Reserved agent id that is NEVER rostered as a harness agent: `main` is the
 * host's built-in main agent and keeps its built-in dashboard session even
 * when its config entry carries runtime.acp (Phase 2.7 dynamic-roster rule).
 * Superseded by ORCHESTRATOR_AGENT_IDS (Phase 2.15) — kept as an export for
 * API compatibility; it is the first entry of the orchestrator list.
 */
export const RESERVED_HARNESS_AGENT_ID = "main";

/**
 * Safe-default exclusion list (Phase 2.15 codex-R1 → Phase 2.17 GaRoN
 * "Bound-Auswahl-Philosophie"): these are the host's own coordinating agents.
 * They are excluded from the harness roster ONLY when no explicit plugin
 * config says otherwise — `boundAgents` (positive list) and `excludedAgents`
 * (default-exclusion replacement) are both escape hatches that override this
 * default. A dashboard conversation excluded by the default keeps its
 * built-in (main-style) dispatch.
 */
export const ORCHESTRATOR_AGENT_IDS: readonly string[] = [
  RESERVED_HARNESS_AGENT_ID,
  "coding-main",
  "coding-review",
];

const ORCHESTRATOR_AGENT_ID_SET = new Set<string>(ORCHESTRATOR_AGENT_IDS);

/** True when `agentId` canonicalizes to an id on the safe-default exclusion list. */
export function isOrchestratorAgentId(agentId: unknown): boolean {
  return ORCHESTRATOR_AGENT_ID_SET.has(sanitizeAgentId(agentId));
}

/** Default binding mode when the agent entry does not configure one. */
export const BINDING_MODE = "persistent";

/**
 * Workspace root for the auto-detected ACP cwd fallback (Phase 2.21 workspace
 * convention): persistent harness workspaces live on the agent convention
 * `/config/clawd/agents/<agentId>/` — NOT the `/share/temp/acpx-workspace/`
 * scratch world (which is reserved for pipeline-run scratch sessions only and
 * holds legacy GaRoN-turn debris; its files are operator-cleanup territory,
 * the plugin never read-writes them as a workspace root anymore). Real
 * workspace paths come from `agents.entries` cfg anyway (cwd precedence in
 * specFromEntry); this prefix is only the fallback when an entry carries no
 * cwd/workspace at all.
 */
export const DEFAULT_CWD_PREFIX = "/config/clawd/agents/";

/** Plugin id (package + manifest + channel plugin object). */
export const CHANNEL_ID = "acp-dashboard-binding";

/**
 * Binding channel target. Dashboard/webchat conversations arrive with
 * `ctx.OriginatingChannel === "webchat"` (internal message channel), so the
 * SessionBindingAdapter is registered under this channel id; the host consults
 * `getSessionBindingService().resolveByConversationAsync({ channel: "webchat", ... })`
 * with `conversationId` = the agent-qualified session key
 * (`agent:<id>:dashboard:<uuid>`).
 */
export const BINDING_CHANNEL = "webchat";

/** Account id used for the internal webchat channel (no plugin account exists). */
export const BINDING_ACCOUNT_ID = "default";

/** Prefix reserved by this plugin for its deterministic binding ids. */
export const BINDING_ID_PREFIX = "plugin-binding:";

/** Label stored in binding record metadata; never use the reserved source "config". */
export const BINDING_SOURCE_LABEL = "plugin:acp-dashboard-binding";

/**
 * Phase 2.20 (F4 reply-delivery gap): plugin-owned binding ownership markers
 * matching the host predicate `isPluginOwnedBindingMetadata`
 * (dist/conversation-binding-metadata-CFOhDjMh.mjs): metadata is plugin-owned
 * iff `pluginBindingOwner === "plugin" && typeof pluginId === "string" &&
 * typeof pluginRoot === "string"`. Records carrying this metadata dispatch
 * through the host's plugin-bound claim path — the dispatch stays in the ORIGIN
 * webchat conversation (no retarget, dispatch-from-config:191), the host calls
 * our `inbound_claim` hook, and a `{handled: true, reply}` result is delivered
 * back into the dashboard conversation by the host itself
 * (dispatch-from-config ~3493-3530 → deliverBindingPayload → chat-send
 * finalization + live broadcast).
 */
export const PLUGIN_BINDING_OWNER = "plugin";

/** Human plugin name stored in binding metadata (info field of the host's own buildBindingMetadata). */
export const PLUGIN_NAME = "ACP Dashboard Binding";

/**
 * Plugin root (package dir) used in binding metadata. A string with `typeof
 * === "string"` is REQUIRED by the host predicate — resolve once at plugin
 * registration from `api.rootDir` (OpenClawPluginApi.rootDir, the record's
 * rootDir). Registered in index.ts before any binding is synthesized.
 */
let pluginRootValue: string | undefined;

/** Registers the plugin root used for plugin-owned binding metadata (idempotent; first call wins). */
export function setDashboardBindingPluginRoot(value: unknown): void {
  if (pluginRootValue !== undefined) return;
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed) pluginRootValue = trimmed;
}

/** The registered plugin root, or null while unset (records stay non-plugin-owned). */
export function getDashboardBindingPluginRoot(): string | null {
  return pluginRootValue ?? null;
}

/** Test reset for the module-scoped plugin root (vitest module isolation). */
export function resetDashboardBindingPluginRootForTest(): void {
  pluginRootValue = undefined;
}

/**
 * Metadata fragment marking a binding record as plugin-owned. Returns only the
 * ownership fields; callers merge their informative fields underneath. Returns
 * null while no plugin root is registered — callers then emit records WITHOUT
 * ownership metadata (legacy dispatch behavior).
 */
export function buildPluginOwnedBindingMetadata(): Record<string, unknown> | null {
  const pluginRoot = getDashboardBindingPluginRoot();
  if (!pluginRoot) return null;
  return {
    pluginName: PLUGIN_NAME,
    pluginBindingOwner: PLUGIN_BINDING_OWNER,
    pluginId: CHANNEL_ID,
    pluginRoot
  };
}

/** Canonical agent-id shape (mirrors host normalizeAgentId input validation). */
const VALID_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_AGENT_CHARS_RE = /[^a-z0-9_-]+/g;

/** Mirrors the host `normalizeAgentId`: canonical, else "main" fallback. */
export function sanitizeAgentId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (VALID_AGENT_ID_RE.test(trimmed)) return trimmed.toLowerCase();
  const degraded = trimmed
    .toLowerCase()
    .replace(INVALID_AGENT_CHARS_RE, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return degraded || "main";
}

/** Mirrors the host `normalizeAccountId`: trimmed+canonical id, else "default". */
export function normalizeAccountId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "default";
  if (VALID_AGENT_ID_RE.test(raw)) return raw.toLowerCase();
  const degraded = raw
    .toLowerCase()
    .replace(INVALID_AGENT_CHARS_RE, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 64);
  return degraded || "default";
}

/** Mirrors the host lowercase channel normalization. */
export function normalizeChannelId(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Extracts the agent id from an agent-qualified conversation key
 * (`agent:<agentId>:<rest>`) or a bare agent id. Returns null for anything
 * that does not carry an agent id ("webchat:...", empty strings, nested ids).
 */
export function parseAgentIdFromConversationId(conversationId: unknown): string | null {
  if (typeof conversationId !== "string") return null;
  const raw = conversationId.trim();
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length >= 2 && parts[0] === "agent") {
    const agentId = sanitizeAgentId(parts[1] ?? "");
    return agentId || null;
  }
  return null;
}

/** Normalized ACP runtime settings read from `agents.entries.<id>.runtime.acp`. */
export type HarnessAgentSpec = {
  agentId: string;
  mode: "persistent" | "oneshot";
  cwd?: string;
  backend?: string;
  /** ACP agent id (`runtime.acp.agent`), projected as metadata.acpAgentId. */
  harness?: string;
};

/** Minimal structural view of `agents.entries.<id>` (AgentEntryConfig). */
type AgentEntryLike = {
  cwd?: string;
  workspace?: string;
  runtime?: {
    type?: string;
    acp?: {
      agent?: string;
      backend?: string;
      mode?: string;
      cwd?: string;
    };
  };
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Trimmed string or undefined (host normalizeOptionalString equivalent). */
export function optionalTrim(value: unknown): string | undefined {
  return optionalString(value);
}

function specFromEntry(agentId: string, entry: AgentEntryLike | undefined): HarnessAgentSpec | null {
  // Phase 2.7: an entry dispatches through the ACP harness backend exactly
  // when its config carries `runtime.type === "acp"`.
  if (entry?.runtime?.type !== "acp") return null;
  const acp = entry.runtime.acp ?? {};
  let mode: HarnessAgentSpec["mode"] = BINDING_MODE;
  if (acp.mode === "oneshot") mode = "oneshot";
  // cwd precedence: runtime.acp.cwd > entry.cwd > entry.workspace > MVP default.
  const cwd =
    optionalString(acp.cwd) ??
    optionalString(entry.cwd) ??
    optionalString(entry.workspace) ??
    `${DEFAULT_CWD_PREFIX}${agentId}`;
  const backend = optionalString(acp.backend);
  const harness = optionalString(acp.agent);
  return {
    agentId,
    mode,
    cwd,
    ...backend ? { backend } : {},
    ...harness ? { harness } : {}
  };
}

type PluginEntryLike = {
  config?: {
    boundAgents?: unknown;
    excludedAgents?: unknown;
  };
};

function resolvePluginEntryConfig(cfg: unknown): Record<string, unknown> | null {
  const entry = (cfg as { plugins?: { entries?: Record<string, PluginEntryLike | undefined> } } | undefined)?.plugins?.entries?.[CHANNEL_ID];
  return entry?.config && typeof entry.config === "object" ? (entry.config as Record<string, unknown>) : null;
}

function sanitizedIdList(values: readonly unknown[]): string[] {
  const ids = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") continue;
    if (!raw.trim()) continue;
    ids.add(sanitizeAgentId(raw));
  }
  return [...ids];
}

/**
 * Explicit positive list of harness agent ids read from
 * `plugins.entries['<CHANNEL_ID>'].config.boundAgents` (Phase 2.15, codex-R1
 * dynamic part — nothing hardcoded, everything addon-config steerable).
 *
 * Phase 2.17 precedence (GaRoN "Der Kunde bekommt, was er will"): the
 * positive list is the HIGHEST-priority lever — it wins over the orchestrator
 * exclusion (and over `excludedAgents`), so explicitly listing
 * main/coding-main/coding-review binds them (documented escape hatch).
 *
 * Returns null when the option is NOT set (no allowlist: the exclusion gates
 * decide alone). When set (Array — including an explicitly EMPTY array),
 * ONLY the listed canonical ids match; `[]` is the documented "bind nothing"
 * semantics. Invalid strings are canonicalized like agent ids
 * (sanitizeAgentId); non-strings are ignored.
 */
export function resolveBoundAgentAllowlist(cfg: unknown): string[] | null {
  const config = resolvePluginEntryConfig(cfg);
  if (!config) return null;
  const bound = config.boundAgents;
  if (!Array.isArray(bound)) return null;
  return sanitizedIdList(bound);
}

/**
 * Replacement for the safe-default exclusion list, read from
 * `plugins.entries['<CHANNEL_ID>'].config.excludedAgents` (Phase 2.17, GaRoN
 * escape hatch #2 — keine Verbote ohne Override).
 *
 * Accepted shapes: an Array of agent-id strings, or a single CSV string
 * (`"main,coding-main"`). Both are validated/canonicalized like agent ids
 * (sanitizeAgentId); non-strings, empty entries and empty CSV fragments are
 * ignored. An explicitly EMPTY value (`[]` or `""`) means "nothing is
 * excluded by default" — that is the documented semantics, not a fallback.
 *
 * Returns null when the option is NOT set (the safe-default exclusion list
 * `ORCHESTRATOR_AGENT_IDS` applies).
 */
export function resolveExcludedAgentIds(cfg: unknown): string[] | null {
  const config = resolvePluginEntryConfig(cfg);
  if (!config) return null;
  const excluded = config.excludedAgents;
  if (typeof excluded === "string") return sanitizedIdList(excluded.split(","));
  if (Array.isArray(excluded)) return sanitizedIdList(excluded);
  return null;
}

/**
 * Roster gate shared by all resolvers (Phase 2.17 precedence ladder):
 *
 *   1. `boundAgents` set  → positive list wins over ANY exclusion
 *      (highest priority; includes orchestrator ids — the "customer gets
 *      what they want" escape hatch; `[]` binds nothing).
 *   2. otherwise `excludedAgents` set → it REPLACES the safe-default
 *      exclusion list entirely.
 *   3. otherwise → safe-default exclusion (ORCHESTRATOR_AGENT_IDS) applies:
 *      main/coding-main/coding-review never roster without explicit config,
 *      preventing the 08:14 self-shot scenario out of the box.
 */
export function isRosterEligibleAgentId(cfg: unknown, agentId: string): boolean {
  const allowlist = resolveBoundAgentAllowlist(cfg);
  if (allowlist !== null) return allowlist.includes(agentId);
  const excluded = resolveExcludedAgentIds(cfg);
  if (excluded !== null) return !excluded.includes(agentId);
  return !ORCHESTRATOR_AGENT_ID_SET.has(agentId);
}

/** Exclusion + positive-list filter shared by both resolvers (codex-R1). */
function passesRosterGates(cfg: unknown, agentId: string, spec: HarnessAgentSpec | null): HarnessAgentSpec | null {
  if (!spec) return null;
  return isRosterEligibleAgentId(cfg, agentId) ? spec : null;
}

/**
 * Dynamic harness roster (Phase 2.7, GaRoN: the project must work
 * user-independently): the OpenClaw config is the single source of truth —
 * every `agents.entries.<id>` whose `runtime.type === "acp"` is a harness
 * agent, with `runtime.acp.agent` as its harness id. There is NO fixed id
 * list anymore. The roster gate is the Phase 2.17 precedence ladder:
 * `boundAgents` (positive list, highest priority — may even bind
 * orchestrator ids) > `excludedAgents` (replaces the default exclusion) >
 * safe-default exclusion (main/coding-main/coding-review). An absent/empty
 * config yields an EMPTY roster (safe default: no match, no derive).
 */
export function resolveHarnessAgentSpecs(cfg: unknown): HarnessAgentSpec[] {
  const entries = (cfg as { agents?: { entries?: Record<string, AgentEntryLike | undefined> } } | undefined)?.agents?.entries;
  if (!entries) return [];
  const specs: HarnessAgentSpec[] = [];
  for (const [rawId, entry] of Object.entries(entries)) {
    if (entry === undefined || entry === null) continue;
    const agentId = sanitizeAgentId(rawId);
    const spec = passesRosterGates(cfg, agentId, specFromEntry(agentId, entry));
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * Roster lookup: is `agentId` a harness agent per `cfg`, and what are its ACP
 * runtime settings? The caller passes its LIVE config on every resolve
 * (binding-adapter: `options.getConfig?.()`), so config changes are visible
 * within the adapter generation without any cache. Returns null for ids that
 * fail the Phase 2.17 roster gate (`isRosterEligibleAgentId` — precedence
 * ladder `boundAgents` > `excludedAgents` > safe-default exclusion) and for
 * unknown/non-acp agents — those keep their untouched dispatch
 * (acceptance criterion #4).
 */
export function resolveHarnessAgentSpec(cfg: unknown, agentId: unknown): HarnessAgentSpec | null {
  const normalized = sanitizeAgentId(agentId);
  const entries = (cfg as { agents?: { entries?: Record<string, AgentEntryLike | undefined> } } | undefined)?.agents?.entries;
  if (!entries?.[normalized]) return null;
  return passesRosterGates(cfg, normalized, specFromEntry(normalized, entries[normalized]));
}

/**
 * Extracts the agent id embedded in an `agent:<agentId>:<rest>` session key
 * (same grammar `isAcpShapedSessionKey` mirrors); null for bare `acp:…` keys
 * and anything else without an agent segment.
 */
function agentIdFromSessionKey(sessionKey: string): string | null {
  const parts = sessionKey.split(":");
  if (parts[0] !== "agent" || parts.length < 3) return null;
  return sanitizeAgentId(parts[1] ?? "") || null;
}

/**
 * `plugins.entries['<CHANNEL_ID>'].config.harnessSessions` — Phase 2.18b F3
 * fix (RE-confirmed, "Weg A, plugin-side"). Maps a harness id to the REAL,
 * explicitly spawned persistent ACP session key of that harness
 * (`{codex: "<session-key>", claude: "…", opencode: "…"}`); the user pastes
 * the keys after a one-time `/acp spawn <harness>`, because only the real
 * spawn creates the `acp_sessions` row the host's `resolveStoredAcpSession`
 * needs (synthetic binding keys can NEVER be initialized host-side).
 *
 * The roster gate-ladder is UNTOUCHED (boundAgents > excludedAgents >
 * safe-default decides WHO binds); this option only changes the TARGET:
 * when set + valid, the derived binding record targets the real key instead
 * of the synthetic `agent:<id>:acp:binding:webchat:default:<hash>` one.
 *
 * Validation per value: must be an ACP-shaped session key (the host
 * `isAcpSessionKey` shape, mirrored by `isAcpShapedSessionKey`) and its
 * embedded agent id must NOT be an orchestrator id (no self-shot through a
 * target like `agent:main:acp:…`). Invalid entries are IGNORED (fall back to
 * the previous synthetic target — same behavior as an unset option) instead
 * of rejecting the whole binding, so a typo degrades to the documented
 * synthetic mode rather than silently binding to a wrong target. Returns
 * null when the option is absent or no validated entry matches the spec.
 *
 * Lookup order per spec: `runtime.acp.agent` (the harness id) first, then
 * the canonical agent id — both keys are accepted so the user may key the
 * map either way; the harness-id entry wins when both are present.
 */
export function resolveHarnessSessionTargetKey(cfg: unknown, spec: HarnessAgentSpec): string | null {
  const config = resolvePluginEntryConfig(cfg);
  const map = config?.harnessSessions;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const harnessIds = [...new Set([spec.harness, spec.agentId].filter((id) => !!id))];
  for (const harnessId of harnessIds) {
    const raw = (map as Record<string, unknown>)[harnessId as string];
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) continue;
    if (!isAcpShapedSessionKey(key)) continue;
    const targetAgent = agentIdFromSessionKey(key);
    if (targetAgent && isOrchestratorAgentId(targetAgent)) continue;
    return key;
  }
  return null;
}

/** First `length` hex chars of sha256(host normalization of `channel:accountId:conversationId`). */
export function acpBindingHash(channel: unknown, accountId: unknown, conversationId: unknown, length = 16): string {
  // Mirrors host `sha256HexPrefixCore(`${spec.channel}:${spec.accountId}:${spec.conversationId}`, 16)`
  return createHash("sha256")
    .update(
      `${normalizeChannelId(channel)}:${normalizeAccountId(accountId)}:${typeof conversationId === "string" ? conversationId.trim() : ""}`,
      "utf8"
    )
    .digest("hex")
    .slice(0, length);
}

/**
 * Build the ACP binding session key — bit-for-bit equivalent to the host's
 * `buildConfiguredAcpSessionKey` (verified against
 * dist/persistent-bindings.types-DWbrbd8R.mjs):
 *
 *   agent:<agentId>:acp:binding:<channel>:<accountId>:<sha256-16hex>
 *
 * The resulting rest starts with "acp:", so host `isAcpSessionKey` returns true
 * and `resolveSessionDispatchKind` resolves to "acp".
 */
export function buildAcpBindingSessionKey(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  agentId: string;
}): string {
  const hash = acpBindingHash(params.channel, params.accountId, params.conversationId, 16);
  return `agent:${sanitizeAgentId(params.agentId)}:acp:binding:${normalizeChannelId(params.channel)}:${normalizeAccountId(params.accountId)}:${hash}`;
}

/** Deterministic binding id for a conversation under this plugin's adapter. */
export function buildBindingId(params: { channel: string; accountId: string; conversationId: string; kind?: "derived" | "explicit" }): string {
  const hash = acpBindingHash(params.channel, params.accountId, params.conversationId, 16);
  const kind = params.kind ?? "derived";
  return `${BINDING_ID_PREFIX}${kind}:${normalizeChannelId(params.channel)}:${normalizeAccountId(params.accountId)}:${hash}`;
}

/** Registry key the host uses to find a binding adapter (channel:accountId). */
export function buildChannelAccountKey(params: { channel: unknown; accountId: unknown }): string {
  return `${normalizeChannelId(params.channel)}:${normalizeAccountId(params.accountId)}`;
}

/**
 * True when the given session key is ACP-dispatch-shaped the same way the host
 * decides: rest of `agent:<agentId>:<rest>` starts with "acp:" (or the whole
 * key does). Mirrors `isAcpSessionKey` (session-key-BC4m_Ly5.mjs).
 */
export function isAcpShapedSessionKey(sessionKey: unknown): boolean {
  if (typeof sessionKey !== "string") return false;
  const raw = sessionKey.trim();
  if (!raw) return false;
  if (raw.toLowerCase().startsWith("acp:")) return true;
  const parts = raw.split(":");
  if (parts[0] !== "agent") return false;
  return parts.slice(2).join(":").toLowerCase().startsWith("acp:");
}

// ---------------------------------------------------------------------------
// Phase 2.21 — auto-provisioning (GaRoN 11:59/12:30)
//
// harnessSessions (Phase 2.18b) stays as the manual override, but is no longer
// REQUIRED: when no validated session is configured for a harness agent, the
// plugin provisions ONE persistent ACP session per agent itself, through the
// host's official configured-binding ensure contract —
// `ensureConfiguredAcpBindingReady` (official plugin-sdk export
// `openclaw/plugin-sdk/acp-binding-runtime`; no trust-gate, unlike
// api.runtime.gateway.request) → `ensureConfiguredAcpBindingSession`
// (dist/persistent-bindings.lifecycle-DU_YBswY.mjs) →
// `acpManager.initializeSession` → `runtime.ensureSession` (real backend
// spawn) + session-meta write (manager.utils: afterwards resolveStoredAcpSession
// returns kind:"ready", so the synthetic-key ACP_SESSION_INIT_FAILED gap from
// Phase 2.18b never happens for provisioned keys).
//
// Determinism: the provisioned key is DERIVED per agent (not minted randomly),
// so the sync derives stay byte-stable across resolve → touch → re-resolve
// (stability check) and regenerate identically after a restart.
//
// The SDK ensure call itself lives in index.ts (it needs api.config + the
// dynamic SDK import); this module keeps the SDK-free plumbing: provisioner
// registration, dedupe, spec-signature caching, and the target cascade.
// ---------------------------------------------------------------------------

/**
 * conversationId under the webchat:default scope that names the persistent
 * per-agent harness session (`harness:<agentId>`). Deliberately NOT a real
 * dashboard conversation; only used to derive the stable session key.
 */
export function buildHarnessProvisionedConversationId(agentId: unknown): string {
  return `harness:${sanitizeAgentId(agentId)}`;
}

/**
 * Deterministic session key of the auto-provisioned per-agent harness session:
 * `agent:<agentId>:acp:binding:webchat:default:<sha16("webchat:default:harness:<agentId>")>`
 * — exact buildConfiguredAcpSessionKey grammar (same builder the host's
 * ensure contract derives the key from), so host `isAcpSessionKey` is true and
 * `parseConfiguredAcpSessionKey` reads it as a webchat:default configured
 * binding. Deterministic per agent; regenerate-safe.
 */
export function buildHarnessProvisionedSessionKey(spec: Pick<HarnessAgentSpec, "agentId">): string {
  return buildAcpBindingSessionKey({
    channel: BINDING_CHANNEL,
    accountId: BINDING_ACCOUNT_ID,
    conversationId: buildHarnessProvisionedConversationId(spec.agentId),
    agentId: spec.agentId
  });
}

/** True when `sessionKey` is the auto-provisioned per-agent key of `agentId`. */
export function isHarnessProvisionedSessionKey(agentId: unknown, sessionKey: unknown): boolean {
  if (!agentId || typeof sessionKey !== "string") return false;
  return sessionKey === buildHarnessProvisionedSessionKey({ agentId: sanitizeAgentId(agentId) });
}

/**
 * `plugins.entries['<CHANNEL_ID>'].config.autoProvision` — Phase 2.21. Default
 * is `true` (the plugin provisions persistent harness sessions itself); only
 * an explicit boolean `false` opts out (then the cascade falls back to the
 * synthetic per-conversation target, exactly the pre-2.21 behavior).
 */
export function resolveAutoProvisionEnabled(cfg: unknown): boolean {
  const value = resolvePluginEntryConfig(cfg)?.autoProvision;
  return value !== false;
}

/**
 * The provisioning seam: async ensure callback (runs the SDK ensure contract
 * for the agent's derived session key). Registered in index.ts at registerFull
 * with the plugin-api-backed implementation; null clears it (dispose).
 */
export type DashboardHarnessProvisioner = (spec: HarnessAgentSpec, targetSessionKey: string) => Promise<unknown>;

let harnessProvisioner: DashboardHarnessProvisioner | null = null;
/** In-flight ensure promises per canonical agentId (dedupe of concurrent resolves). */
const provisioningInFlight = new Map<string, Promise<boolean>>();
/** Spec signature of the LAST SUCCESSFUL ensure per agentId (skip re-ensure). */
const provisionedSignatures = new Map<string, string>();

function harnessSpecSignature(spec: HarnessAgentSpec): string {
  return JSON.stringify({
    agentId: spec.agentId,
    harness: spec.harness ?? null,
    mode: spec.mode,
    cwd: spec.cwd ?? null,
    backend: spec.backend ?? null
  });
}

/** Registers (or clears with null) the SDK-backed provisioner. Idempotent per call. */
export function setDashboardBindingProvisioner(provisioner: DashboardHarnessProvisioner | null): void {
  harnessProvisioner = provisioner;
}

/** Test reset for the whole provisioning state (vitest module isolation). */
export function resetDashboardBindingProvisionerForTest(): void {
  harnessProvisioner = null;
  provisioningInFlight.clear();
  provisionedSignatures.clear();
}

/** The registered provisioner, or null while unset (cascade stays synthetic). */
export function getDashboardBindingProvisioner(): DashboardHarnessProvisioner | null {
  return harnessProvisioner;
}

/**
 * Kicks (or joins) the ensure for ONE agent's persistent session. Fire-and-
 * forget by design — resolves answer with the deterministic key immediately.
 * Returns the in-flight/settled status promise, or null when autoProvision is
 * disabled, no provisioner is registered, or the agent was already ensured
 * with the identical spec signature (skip).
 */
export function ensureDashboardHarnessProvisioning(cfg: unknown, spec: HarnessAgentSpec): Promise<boolean> | null {
  if (!resolveAutoProvisionEnabled(cfg) || !harnessProvisioner) return null;
  const agentId = sanitizeAgentId(spec.agentId);
  const signature = harnessSpecSignature(spec);
  const existing = provisioningInFlight.get(agentId);
  if (existing) return existing;
  // Last success with the same spec: nothing to (re)ensure.
  if (provisionedSignatures.get(agentId) === signature) return null;
  const provisioner = harnessProvisioner;
  // Dedupe note: a second ensure while one is in flight ALWAYS joins the
  // existing run (same agentId key), so at most one run per agentId exists at
  // a time and the unconditional finally-delete cannot clobber a newer run.
  const run = (async () => {
    try {
      await provisioner(spec, buildHarnessProvisionedSessionKey({ agentId }));
      provisionedSignatures.set(agentId, signature);
      return true;
    } catch {
      // No signature — the next consult retries; the deterministic target meanwhile
      // surfaces the host's ACP init error to the conversation (handled there).
      return false;
    } finally {
      provisioningInFlight.delete(agentId);
    }
  })();
  provisioningInFlight.set(agentId, run);
  return run;
}

/**
 * The pending provision for `agentId` (null when none in flight). The reply-
 * claim barrier awaits this BEFORE starting the harness turn, so the first
 * dashboard message does not race the session initialization.
 */
export function pendingDashboardHarnessProvisioning(agentId: unknown): Promise<boolean> | null {
  return provisioningInFlight.get(sanitizeAgentId(agentId)) ?? null;
}

export type HarnessTargetOrigin = "configured" | "provisioned" | "synthetic";

/**
 * Target cascade for harness agent conversations (Phase 2.21) — ONE derivation
 * shared by the binding-adapter derive and the dashboard-bridge synthesis so
 * both halves hand out the same session key:
 *
 *   1. `harnessSessions` (manual override, highest priority — unchanged 2.18b)
 *   2. auto-provisioned per-agent session (fire-and-forget ensure + deterministic
 *      key; skipped when `autoProvision: false` or no provisioner registered)
 *   3. synthetic per-conversation key (pre-2.21 fallback, never initialized
 *      host-side — documented Phase 2.18b limitation)
 *
 * The synthetic leg needs the conversation; the provisioned leg does not (the
 * key is per agent on purpose: ONE persistent harness session per ACP agent).
 */
export function resolveHarnessTargetOrigin(
  cfg: unknown,
  spec: HarnessAgentSpec,
  conversation: { channel: string; accountId: string; conversationId: string }
): { targetKey: string; origin: HarnessTargetOrigin } {
  const configured = resolveHarnessSessionTargetKey(cfg, spec);
  if (configured) return { targetKey: configured, origin: "configured" };
  if (resolveAutoProvisionEnabled(cfg) && harnessProvisioner) {
    // Fire-and-forget: the resolve answer is deterministic regardless of when
    // (or whether) the ensure completes — see the module comment above.
    ensureDashboardHarnessProvisioning(cfg, spec);
    return { targetKey: buildHarnessProvisionedSessionKey({ agentId: spec.agentId }), origin: "provisioned" };
  }
  return {
    targetKey: buildAcpBindingSessionKey({
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      agentId: spec.agentId
    }),
    origin: "synthetic"
  };
}

/** Disposes the whole provisioning seam (plugin dispose / tests). */
export function clearDashboardHarnessProvisions(): void {
  setDashboardBindingProvisioner(null);
  provisioningInFlight.clear();
  provisionedSignatures.clear();
}