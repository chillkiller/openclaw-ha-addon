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


/**
 * GaRoN design gate: only real dashboard-class conversations are eligible
 * for binding/linking. Writing into the MAIN session of a harness agent
 * (agent:<id>:main), an acp-class key, telegram-class key, etc. must always
 * dispatch through the untouched built-in path and synthesize a NEW builtin
 * session — never bind. Eligible are either:
 *
 *   (a) a real dashboard conversation id: `agent:<id>:dashboard:<uuid>`
 *       (or with extra trailing thread segments) where the kind segment is
 *       literally "dashboard" and at least one token follows; or
 *   (b) an explicit binding record (handled by the findExplicit path before
 *       this gate is consulted, so this predicate covers the derive path).
 *
 * This function is intentionally defensive (accepts `unknown`) and is reused
 * by both `binding-adapter.ts` and `dashboard-bridge.ts`.
 */
export function isBindEligibleConversationId(conversationId: unknown): boolean {
  if (typeof conversationId !== "string") return false;
  const raw = conversationId.trim();
  if (!raw) return false;
  const parts = raw.split(":");
  if (parts.length < 4) return false;
  const namespace = parts[0] ?? "";
  const kindSegment = parts[2] ?? "";
  const restParts = parts.slice(3);
  if (namespace.toLowerCase() !== "agent") return false;
  if (kindSegment.toLowerCase() !== "dashboard") return false;
  if (restParts.length === 0) return false;
  return true;
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
// Phase 2.22 — origin-workspace cwd derivation (GaRoN Phase B, 18:46 GO)
//
// Defect closed (GaRoN UI-Test 18:46): binding/delivery/mirroring all WORKED,
// but the bound harness session had been spawned with a stale cwd
// (/share/temp/acp-rebuild — proof-run debris). Persistent ACP sessions keep
// their SPAWN cwd (runtime.acp.cwd only matters at first spawn), so the only
// way to honor the ORIGIN conversation's workspace is to bake the origin cwd
// into the ensured session — with a session key that differs per cwd-scope.
//
// Verified data path (live-checked, 2026-10-10):
//   1. the origin dashboard conversation id IS a session_nodes row of the
//      AGENT-DB `<stateDir>/agents/<agentId>/agent/openclaw-agent.sqlite`
//      (e.g. `agent:claude:dashboard:27eddc7c-…` → project_id
//      `openclaw-ha-addon`, entry_json.sessionRoot = the concrete repo dir);
//   2. `<stateDir>/state/openclaw.sqlite` projects: id → repo_root (fallback
//      when entry_json carries no sessionRoot).
// The plugin has NO official read surface for these DBs (openKeyedStore is
// plugin-scoped; the binding ref carries no projectId — session-conversation-
// binding-ClcCbPHd.mjs:31-35), so the read lives behind an INJECTED SYNC
// reader seam (setOriginWorkspaceReader — index.ts wires a node:sqlite
// implementation; unit tests inject fakes). The seam is deliberately narrow:
// one lookup per (agentId, dashboard-conversationId), pure data out.
//
// Fallback contract (GaRoN rules): `workspaces` config map (explicit, highest
// precedence below the immutable harnessSessions override) > origin
// derivation > the untouched agent-default cwd ladder (runtime.acp.cwd >
// entry.cwd > entry.workspace > DEFAULT_CWD_PREFIX). Nothing here touches
// `agent:<id>:main`/acp-class conversations (isBindEligibleConversationId in
// binding-adapter.ts stays the gate).
// ---------------------------------------------------------------------------

/** What the injected reader may report about an origin conversation. */
export type OriginWorkspaceInfo = {
  projectId?: string;
  sessionRoot?: string;
  repoRoot?: string;
};

/**
 * Sync read seam for origin-conversation workspace facts. `agentId` locates
 * the agent DB, `conversationId` the session_nodes row. Null = "nothing
 * found" (row absent, DB unreadable, …) — the caller falls back per ladder.
 * Synchronization contract: resolve/ensure paths are sync and must stay
 * deterministic, so the reader MUST be sync and cheap (one indexed lookup).
 */
export type OriginWorkspaceReader = (agentId: string, conversationId: string) => OriginWorkspaceInfo | null | undefined;

export const ORIGIN_WORKSPACE_MISS_TTL_MS = 30_000;

let originWorkspaceReader: OriginWorkspaceReader | null = null;
/**
 * Memoization so the sync derives stay deterministic AND cheap:
 * - non-null results are cached PERMANENTLY (a dashboard session's
 *   sessionRoot/project don't change under its key);
 * - null results are cached with a TTL (transient unreadable-DB races can
 *   heal on a later turn instead of pinning the wrong cwd forever).
 * Both cache legs guarantee the resolve → touch → re-resolve stability
 * window (one dispatch, milliseconds apart) always sees the SAME value.
 */
const originWorkspaceCache = new Map<string, { info: OriginWorkspaceInfo | null; at: number; resolved: boolean }>();

/** Registers (or clears with null) the origin-workspace reader. Clears the memo cache. */
export function setOriginWorkspaceReader(reader: OriginWorkspaceReader | null): void {
  originWorkspaceReader = reader;
  originWorkspaceCache.clear();
}

/** Test reset for the reader + cache (vitest module isolation). */
export function resetOriginWorkspaceReaderForTest(): void {
  originWorkspaceReader = null;
  originWorkspaceCache.clear();
}

/** Cache key: sanitized agent + EXACT conversation id (dashboard uuid included). */
function originWorkspaceCacheKey(agentId: string, conversationId: string): string {
  return `${agentId}␟${conversationId}`;
}

/**
 * Memoized single lookup of one origin conversation's workspace facts.
 * Never throws (reader errors count as miss). Returns null without a
 * registered reader.
 */
export function queryOriginWorkspace(agentId: unknown, conversationId: unknown, now: () => number = Date.now): OriginWorkspaceInfo | null {
  const convId = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!convId) return null;
  const key = originWorkspaceCacheKey(sanitizeAgentId(agentId), convId);
  const cached = originWorkspaceCache.get(key);
  const at = now();
  if (cached && (cached.resolved || at - cached.at < ORIGIN_WORKSPACE_MISS_TTL_MS)) return cached.info;
  let info: OriginWorkspaceInfo | null = null;
  if (originWorkspaceReader) {
    try {
      info = originWorkspaceReader(sanitizeAgentId(agentId), convId) ?? null;
    } catch {
      info = null;
    }
  }
  originWorkspaceCache.set(key, { info, at, resolved: info !== null });
  return info;
}

/**
 * `plugins.entries['<CHANNEL_ID>'].config.workspaces` — explicit cwd override
 * map. Keys are EITHER exact dashboard conversation ids (`agent:<id>:dashboard:<uuid>`)
 * OR project ids (as recorded in the origin agent DB / dashboard window, e.g.
 * `openclaw-ha-addon`); values are ABSOLUTE cwd paths. Conversation-id keys win
 * over project-id keys; anything invalid (non-object, non-string/empty/non-
 * absolute values) is ignored — returns null then (no overrides).
 */
export function resolveWorkspaceOverrides(cfg: unknown): Record<string, string> | null {
  const map = resolvePluginEntryConfig(cfg)?.workspaces;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
    const trimmedKey = typeof key === "string" ? key.trim() : "";
    const cwd = typeof value === "string" ? value.trim() : "";
    if (!trimmedKey || !resolvedAbsoluteCwd(cwd)) continue;
    resolved[trimmedKey] = cwd;
  }
  return Object.keys(resolved).length > 0 ? resolved : null;
}

/** Strict cwd validation: trim happens in the resolvers; here: absolute path only. */
function resolvedAbsoluteCwd(value: string): boolean {
  return typeof value === "string" && value.startsWith("/") && value.length > 1;
}

/**
 * Mirrors the host's state-dir resolution (`config-utils-DioOBKyj.mjs
 * resolveStateDir`): OPENCLAW_STATE_DIR override, else derived from the
 * effective home. This mirror covers the documented fallback arms the addon
 * environment sets (OPENCLAW_CONFIG_DIR / OPENCLAW_CONFIG_PATH /
 * XDG_CONFIG_HOME / HOME); returns null when no arm yields a value.
 */
export function resolveOpenClawStateDir(env?: Record<string, string | undefined>): string | null {
  const e = env ?? (typeof process !== "undefined" ? process.env : undefined) ?? {};
  const stateDir = typeof e.OPENCLAW_STATE_DIR === "string" ? e.OPENCLAW_STATE_DIR.trim() : "";
  if (stateDir) return stateDir;
  const configDir = typeof e.OPENCLAW_CONFIG_DIR === "string" ? e.OPENCLAW_CONFIG_DIR.trim() : "";
  if (configDir) return configDir;
  const configPath = typeof e.OPENCLAW_CONFIG_PATH === "string" ? e.OPENCLAW_CONFIG_PATH.trim() : "";
  if (configPath) {
    const dir = configPath.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (dir) return dir;
  }
  const xdg = typeof e.XDG_CONFIG_HOME === "string" ? e.XDG_CONFIG_HOME.trim() : "";
  if (xdg) return `${xdg.replace(/\/+$/, "")}/.openclaw`;
  const home = typeof e.HOME === "string" ? e.HOME.trim() : "";
  if (home) return `${home.replace(/\/+$/, "")}/.openclaw`;
  return null;
}

/** Verified host DB layout (agent-database-path-discovery-B_nrhsNg.mjs:16 + state). */
export function buildOriginWorkspaceDatabasePaths(
  stateDir: string,
  agentId: unknown,
): { agentDb: string; projectsDb: string } | null {
  const dir = typeof stateDir === "string" ? stateDir.replace(/\/+$/, "") : "";
  const aid = sanitizeAgentId(agentId);
  if (!dir || !aid) return null;
  return {
    agentDb: `${dir}/agents/${aid}/agent/openclaw-agent.sqlite`,
    projectsDb: `${dir}/state/openclaw.sqlite`
  };
}

/**
 * Picks the workspace facts out of a session_nodes.entry_json row (verified
 * live: dashboard sessions carry `sessionRoot` and `projectId`; main/acp rows
 * carry neither). Accepts an already-parsed object or a JSON string; returns
 * null on garbage.
 */
export function parseOriginWorkspaceEntryJson(entryJson: unknown): { sessionRoot?: string; projectId?: string } | null {
  let value: unknown = entryJson;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sessionRoot = typeof record.sessionRoot === "string" && record.sessionRoot.trim() ? record.sessionRoot.trim() : undefined;
  const projectId = typeof record.projectId === "string" && record.projectId.trim() ? record.projectId.trim() : undefined;
  return sessionRoot || projectId ? { ...(sessionRoot ? { sessionRoot } : {}), ...(projectId ? { projectId } : {}) } : null;
}

/**
 * Session-key fallback for threaded dashboard conversations: the binding ref
 * may carry extra trailing segments (`agent:<id>:dashboard:<uuid>:thread`),
 * while session_nodes keys the BASE conversation (`agent:<id>:dashboard:<uuid>`).
 * Tries the base shape by trimming to the first four colon segments.
 */
export function trimOriginConversationKey(conversationId: string): string | null {
  const raw = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length <= 4) return raw;
  const base = parts.slice(0, 4).join(":");
  return base || null;
}

/**
 * `deriveOriginWorkspace` (default TRUE): explicit `false` turns the origin
 * derivation legs OFF (config `workspaces` map stays active; the agent-default
 * cwd ladder applies as before). Kept as an escape hatch since it widens the
 * plugin's read surface to the host agent DBs.
 */
export function resolveOriginWorkspaceDerivationEnabled(cfg: unknown): boolean {
  return resolvePluginEntryConfig(cfg)?.deriveOriginWorkspace !== false;
}

export type OriginWorkspaceCwdSource =
  | "config-conversation"
  | "config-project"
  | "origin-session-root"
  | "origin-project-db";

export type ResolvedOriginWorkspaceCwd = {
  cwd: string;
  source: OriginWorkspaceCwdSource;
  projectId?: string;
};

/**
 * Origin-cwd ladder for ONE dashboard conversation (sync, memoized through
 * queryOriginWorkspace). Precedence BELOW the immutable harnessSessions
 * override (which resolves the target key first in resolveHarnessTargetOrigin):
 *
 *   1. config `workspaces[<conversationId>]`   (explicit, no DB read needed)
 *   2. config `workspaces[<projectId>]`        (explicit, projectId via reader)
 *   3. origin sessionRoot                      (verbatim cwd of the ORIGIN session)
 *   4. origin projects.repo_root               (project id → repo root)
 *   5. null → caller falls back to the agent-default cwd ladder
 *
 * Only ABSOLUTE paths count (relative values are ignored like unset). Returns
 * null when nothing applies — the caller then keeps the documented defaults.
 */
export function resolveOriginWorkspaceCwd(
  cfg: unknown,
  spec: Pick<HarnessAgentSpec, "agentId">,
  conversation: { conversationId: unknown },
): ResolvedOriginWorkspaceCwd | null {
  const conversationId = typeof conversation?.conversationId === "string" ? conversation.conversationId.trim() : "";
  if (!conversationId) return null;
  const overrides = resolveWorkspaceOverrides(cfg);
  const derivationEnabled = resolveOriginWorkspaceDerivationEnabled(cfg);
  if (!overrides && !derivationEnabled) return null;
  // One reader pass (memoized) feeds legs 2-4. Skipped when derivation is
  // disabled (only the conversation-keyed config leg works without it) and
  // for non-dashboard-class ids — provisioning pseudo ids (`harness:<agent>`,
  // `harness:<agent>:ws:<hash>`) and main/acp-class keys must NEVER reach the
  // reader (no session node exists for them; the legacy per-agent cascade leg
  // answers the agent-default cwd instead).
  const info = derivationEnabled && isBindEligibleConversationId(conversationId)
    ? queryOriginWorkspace(spec.agentId, conversationId)
    : null;
  if (overrides?.[conversationId]) {
    return { cwd: overrides[conversationId], source: "config-conversation" };
  }
  if (info?.projectId && overrides?.[info.projectId]) {
    return { cwd: overrides[info.projectId], source: "config-project", projectId: info.projectId };
  }
  if (derivationEnabled && info?.sessionRoot && resolvedAbsoluteCwd(info.sessionRoot.trim())) {
    return {
      cwd: info.sessionRoot.trim(),
      source: "origin-session-root",
      ...(info.projectId ? { projectId: info.projectId } : {})
    };
  }
  if (derivationEnabled && info?.repoRoot && resolvedAbsoluteCwd(info.repoRoot.trim())) {
    return {
      cwd: info.repoRoot.trim(),
      source: "origin-project-db",
      ...(info.projectId ? { projectId: info.projectId } : {})
    };
  }
  return null;
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
 *
 * Phase 2.23 (key harmonization, GaRoN test 03:22): an optional cwdScope
 * appends `:ws:<sha16(cwd)[0..12]>` — MUST stay bit-identical with the
 * expression inside buildHarnessProvisionedSessionKey — so the host ensure
 * contract mints the acp_sessions row on the SAME key the resolve answers.
 * The legacy no-scope call keeps the pre-2.22 grammar untouched.
 *
 * @deprecated Phase 2.24 (Klon-Modus, GaRoN 05:09): the target cascade does NOT
 * derive dashboard provisioning keys from this pseudo id anymore — the
 * provisioned target is now the deterministic clone of the ORIGIN dashboard
 * conversation key (resolveHarnessTargetOrigin). Kept exported unchanged for
 * legacy keys minted by installs ≤ 0.7.13.13 and for the legacy-key tests.
 */
export function buildHarnessProvisionedConversationId(agentId: unknown, cwdScope?: string): string {
  const base = `harness:${sanitizeAgentId(agentId)}`;
  const scope = typeof cwdScope === "string" ? cwdScope.trim() : "";
  return scope
    ? `${base}:ws:${createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 12)}`
    : base;
}

/**
 * Deterministic session key of the auto-provisioned per-agent harness session:
 * `agent:<agentId>:acp:binding:webchat:default:<sha16("webchat:default:harness:<agentId>")>`
 * — exact buildConfiguredAcpSessionKey grammar (same builder the host's
 * ensure contract derives the key from), so host `isAcpSessionKey` is true and
 * `parseConfiguredAcpSessionKey` reads it as a webchat:default configured
 * binding. Deterministic per agent; regenerate-safe.
 *
 * Phase 2.22 (origin-workspace): when an origin cwd is known
 * (`cwdScope`), the pseudo conversation id becomes
 * `harness:<agentId>:ws:<sha16(cwd).slice(0,12)>` — the key differs per
 * cwd-scope. Persistent ACP sessions keep their spawn cwd, so different origin
 * workspaces MUST get different sessions; sharing one per-agent key across
 * workspaces would make them close/reopen-fight over a single cwd.
 *
 * @deprecated Phase 2.24 (Klon-Modus, GaRoN 05:09): LEGACY grammar only — the
 * ladder (resolveHarnessTargetOrigin) does NOT use this helper for dashboard
 * conversations anymore (the clone of the origin dashboard key took over, which
 * carries the cwd in the ensure spec, NOT in the key). Kept exported for
 * legacy keys minted by installs ≤ 0.7.13.13 and backward-compat tests
 * (notably the bridge roster's single-arg harnessProvisionedTargetKey leg).
 */
export function buildHarnessProvisionedSessionKey(
  spec: Pick<HarnessAgentSpec, "agentId">,
  cwdScope?: string,
): string {
  const scope = typeof cwdScope === "string" ? cwdScope.trim() : "";
  const conversationId = buildHarnessProvisionedConversationId(spec.agentId, scope);
  return buildAcpBindingSessionKey({
    channel: BINDING_CHANNEL,
    accountId: BINDING_ACCOUNT_ID,
    conversationId,
    agentId: spec.agentId
  });
}

/**
 * True when `sessionKey` is the auto-provisioned per-agent key of `agentId`.
 *
 * @deprecated Phase 2.24 (Klon-Modus): only matches the LEGACY per-agent /
 * `:ws:`-scoped grammar the ladder no longer mints for dashboard conversations.
 * Still used downstream (reply-claim barrier) to recognize legacy keys of
 * installs ≤ 0.7.13.13; clone keys are recognized via the record's
 * `metadata.provisioned` flag instead.
 */
export function isHarnessProvisionedSessionKey(agentId: unknown, sessionKey: unknown, cwdScope?: string): boolean {
  if (!agentId || typeof sessionKey !== "string") return false;
  return sessionKey === buildHarnessProvisionedSessionKey({ agentId: sanitizeAgentId(agentId) }, cwdScope);
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
 * for the target session key). Registered in index.ts at registerFull with the
 * plugin-api-backed implementation; null clears it (dispose).
 *
 * Phase 2.24 (Klon-Modus, GaRoN 05:09): single object param — ONE new field
 * beats another positional slot, and the ensure implementation can destructure
 * only what it uses. The object carries everything the host ensure contract
 * needs in one place: the spec (with the EFFECTIVE spawn cwd already merged
 * in), the ORIGIN conversation (its conversationId is the ensure-spec
 * conversationId under the clone design — `buildConfiguredAcpSessionKey(spec)`
 * is bit-identical with `targetSessionKey`), the target key itself, and the
 * effective origin cwd (informational; duplicates spec.cwd when set).
 */
export type DashboardHarnessProvisionerParams = {
  /** Ensure spec — carries the EFFECTIVE cwd (origin workspace when one resolved). */
  spec: HarnessAgentSpec;
  /** The ORIGIN dashboard conversation the provisioning consult came from. */
  conversation: { channel: string; accountId: string; conversationId: string };
  /** The target session key the resolve answers with (the origin-key clone). */
  targetSessionKey: string;
  /** Effective origin cwd (undefined = the spec's agent-default cwd applies). */
  cwd?: string;
};

export type DashboardHarnessProvisioner = (params: DashboardHarnessProvisionerParams) => Promise<unknown>;

let harnessProvisioner: DashboardHarnessProvisioner | null = null;
/**
 * In-flight ensure promises per TARGET SESSION KEY (Phase 2.22: keys differ
 * per cwd-scope, so the dedupe key must be the full key — a per-agentId map
 * would mix cwd scopes of the same agent).
 */
const provisioningInFlight = new Map<string, Promise<boolean>>();
/** Spec signature of the LAST SUCCESSFUL ensure per target session key (skip re-ensure). */
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
 * Kicks (or joins) the ensure for ONE persistent session. Fire-and-forget by
 * design — resolves answer with the deterministic key immediately.
 *
 * Phase 2.24 (Klon-Modus, GaRoN 05:09): the TARGET key is passed in by the
 * cascade (`targetSessionKey` — the clone of the origin dashboard key) instead
 * of being derived here from agent id / cwd scope; the cwd does NOT partake in
 * the key identity anymore, it only rides along into the ensure spec (spawn
 * cwd) via `cwd`. Dedupe stays per target session key (signatures/spec cache
 * unchanged) — the same conversation therefore always maps to the same ensure.
 */
export function ensureDashboardHarnessProvisioning(
  cfg: unknown,
  spec: HarnessAgentSpec,
  conversation: { channel: string; accountId: string; conversationId: string },
  targetSessionKey: string,
  cwd?: string,
): Promise<boolean> | null {
  if (!resolveAutoProvisionEnabled(cfg) || !harnessProvisioner) return null;
  const targetKey = targetSessionKey.trim();
  if (!targetKey || !isAcpShapedSessionKey(targetKey)) return null;
  const ensureSpec: HarnessAgentSpec = cwd ? { ...spec, cwd } : spec;
  const signature = harnessSpecSignature(ensureSpec);
  const existing = provisioningInFlight.get(targetKey);
  if (existing) return existing;
  // Last success with the same spec: nothing to (re)ensure.
  if (provisionedSignatures.get(targetKey) === signature) return null;
  const provisioner = harnessProvisioner;
  // Dedupe note: a second ensure while one is in flight ALWAYS joins the
  // existing run (same targetSessionKey), so at most one run per target exists
  // at a time and the unconditional finally-delete cannot clobber a newer run.
  const run = (async () => {
    try {
      await provisioner({
        spec: ensureSpec,
        conversation,
        targetSessionKey: targetKey,
        ...(cwd ? { cwd } : {})
      });
      provisionedSignatures.set(targetKey, signature);
      return true;
    } catch (ensureError) {
      // No signature — the next consult retries; the deterministic target meanwhile
      // surfaces the host's ACP init error to the conversation (handled there).
      // Phase 2.23 diagnostics (GaRoN night session 04:0x): the ensure error was
      // previously swallowed silently — surface it verbatim so the failed leg
      // is debuggable from the log alone.
      console.warn?.(`[acp-dashboard-binding] harness ensure failed for ${targetKey}: ${ensureError instanceof Error ? `${ensureError.name}: ${ensureError.message}` : String(ensureError)}`);
      return false;
    } finally {
      provisioningInFlight.delete(targetKey);
    }
  })();
  provisioningInFlight.set(targetKey, run);
  return run;
}

/**
 * The pending provision for one target (null when none in flight). The reply-
 * claim barrier awaits this BEFORE starting the harness turn, so the first
 * dashboard message does not race the session initialization. Accepts the
 * exact target session key (Phase 2.24: the raw clone key — works unchanged
 * because the in-flight map is keyed by the full target key regardless of
 * which grammar minted it), or, for backward compatibility, a bare agent id
 * (→ the legacy per-agent key).
 */
export function pendingDashboardHarnessProvisioning(targetOrAgentId: unknown): Promise<boolean> | null {
  const raw = typeof targetOrAgentId === "string" ? targetOrAgentId.trim() : "";
  if (!raw) return null;
  if (isAcpShapedSessionKey(raw)) return provisioningInFlight.get(raw) ?? null;
  return provisioningInFlight.get(buildHarnessProvisionedSessionKey({ agentId: sanitizeAgentId(raw) })) ?? null;
}

export type HarnessTargetOrigin = "configured" | "provisioned" | "synthetic";

/**
 * Target cascade for harness agent conversations (Phase 2.21 → 2.24) — ONE
 * derivation shared by the binding-adapter derive and the dashboard-bridge
 * synthesis so both halves hand out the same session key:
 *
 *   1. `harnessSessions` (manual override, highest priority — unchanged 2.18b)
 *   2. auto-provisioned session (fire-and-forget ensure + the deterministic
 *      TARGET key; skipped when `autoProvision: false` or no provisioner
 *      registered). Phase 2.24 (Klon-Modus, GaRoN 05:09): EVERY dashboard
 *      conversation gets ITS OWN persistent ACP session — the target key is a
 *      deterministic CLONE of the origin dashboard conversation's own
 *      conversation key (`buildAcpBindingSessionKey` over the conversation
 *      itself; host `buildConfiguredAcpSessionKey` grammar as always). A new
 *      UI session ⇒ a new conversation id ⇒ a new ACP session key ⇒ a NEW
 *      ACP session (persistent up to the host's default retention); an
 *      existing conversation keeps its key/session. The cwd does NOT partake
 *      in the key identity — it flows into the ensure spec (spawn cwd) via
 *      the resolveOriginWorkspaceCwd ladder, which stays unchanged as the cwd
 *      provider.
 *   3. synthetic per-conversation key (pre-2.21 fallback, never initialized
 *      host-side — documented Phase 2.18b limitation)
 *
 * NOTE: under the clone design the provisioned leg answers the SAME key the
 * synthetic leg derives — the difference is the host-side ensure (the row IS
 * minted on it), the metadata cwd/provisioned markers, and the reply-claim
 * barrier. The synthetic leg remains for autoProvision:false / no-provisioner
 * configs only.
 */
export function resolveHarnessTargetOrigin(
  cfg: unknown,
  spec: HarnessAgentSpec,
  conversation: { channel: string; accountId: string; conversationId: string }
): { targetKey: string; origin: HarnessTargetOrigin; cwd?: string; cwdSource?: OriginWorkspaceCwdSource } {
  const configured = resolveHarnessSessionTargetKey(cfg, spec);
  if (configured) return { targetKey: configured, origin: "configured" };
  if (resolveAutoProvisionEnabled(cfg) && harnessProvisioner) {
    // Fire-and-forget: the resolve answer is deterministic regardless of when
    // (or whether) the ensure completes — see the module comment above. The
    // cwd resolution is sync + memoized, so the answered key never flips
    // within one dispatch (resolve → touch → re-resolve stability).
    const ws = resolveOriginWorkspaceCwd(cfg, spec, conversation);
    const targetKey = buildAcpBindingSessionKey({
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId: conversation.conversationId,
      agentId: sanitizeAgentId(spec.agentId)
    });
    ensureDashboardHarnessProvisioning(cfg, spec, conversation, targetKey, ws?.cwd);
    return {
      targetKey,
      origin: "provisioned",
      ...(ws ? { cwd: ws.cwd, cwdSource: ws.source } : {})
    };
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