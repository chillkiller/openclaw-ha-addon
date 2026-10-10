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
 * Orchestrator agent ids that are NEVER rostered as harness agents even when
 * their config entry carries `runtime.type: "acp"` (Phase 2.15, codex-R1):
 * these are the host's own coordinating agents. A dashboard conversation for
 * one of them always keeps its built-in (main-style) dispatch — nothing must
 * be able to route them through the ACP binding, regardless of config.
 */
export const ORCHESTRATOR_AGENT_IDS: readonly string[] = [
  RESERVED_HARNESS_AGENT_ID,
  "coding-main",
  "coding-review",
];

const ORCHESTRATOR_AGENT_ID_SET = new Set<string>(ORCHESTRATOR_AGENT_IDS);

/** True when `agentId` canonicalizes to an orchestrator id (never rostered). */
export function isOrchestratorAgentId(agentId: unknown): boolean {
  return ORCHESTRATOR_AGENT_ID_SET.has(sanitizeAgentId(agentId));
}

/** Default binding mode when the agent entry does not configure one. */
export const BINDING_MODE = "persistent";

/** Workspace root for the auto-detected ACP cwd fallback. */
export const DEFAULT_CWD_PREFIX = "/share/temp/acpx-workspace/";

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
  };
};

/**
 * Explicit positive list of harness agent ids read from
 * `plugins.entries['<CHANNEL_ID>'].config.boundAgents` (Phase 2.15, codex-R1
 * dynamic part — nothing hardcoded, everything addon-config steerable).
 *
 * Returns null when the option is NOT set (no allowlist: every runtime.acp
 * entry matches). When set (Array — including an explicitly EMPTY array),
 * only the listed canonical ids match. Orchestrator ids inside the list
 * still never match (exclusion wins). Invalid strings are canonicalized like
 * agent ids (sanitizeAgentId); non-strings are ignored.
 */
export function resolveBoundAgentAllowlist(cfg: unknown): string[] | null {
  const pluginEntries = (cfg as { plugins?: { entries?: Record<string, PluginEntryLike | undefined> } } | undefined)?.plugins?.entries;
  if (!pluginEntries) return null;
  const bound = pluginEntries[CHANNEL_ID]?.config?.boundAgents;
  if (!Array.isArray(bound)) return null;
  const ids = new Set<string>();
  for (const raw of bound) {
    if (typeof raw !== "string") continue;
    ids.add(sanitizeAgentId(raw));
  }
  return [...ids];
}

/** Exclusion + positive-list filter shared by both resolvers (codex-R1). */
function passesRosterGates(cfg: unknown, agentId: string, spec: HarnessAgentSpec | null): HarnessAgentSpec | null {
  if (!spec) return null;
  if (ORCHESTRATOR_AGENT_ID_SET.has(agentId)) return null;
  const allowlist = resolveBoundAgentAllowlist(cfg);
  if (allowlist !== null && !allowlist.includes(agentId)) return null;
  return spec;
}

/**
 * Dynamic harness roster (Phase 2.7, GaRoN: the project must work
 * user-independently): the OpenClaw config is the single source of truth —
 * every `agents.entries.<id>` whose `runtime.type === "acp"` is a harness
 * agent, with `runtime.acp.agent` as its harness id. There is NO fixed id
 * list anymore. Orchestrator ids (Phase 2.15: main/coding-main/coding-review)
 * are ALWAYS excluded even with runtime.acp, and when
 * `plugins.entries.<CHANNEL_ID>.config.boundAgents` is set it is the ONLY
 * positive list. An absent/empty config yields an EMPTY roster (safe
 * default: no match, no derive).
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
 * within the adapter generation without any cache. Returns null for
 * orchestrator/unknown/non-acp agents (and for ids outside an explicitly set
 * `boundAgents` positive list) — those keep their untouched dispatch
 * (acceptance criterion #4).
 */
export function resolveHarnessAgentSpec(cfg: unknown, agentId: unknown): HarnessAgentSpec | null {
  const normalized = sanitizeAgentId(agentId);
  if (ORCHESTRATOR_AGENT_ID_SET.has(normalized)) return null;

  const entries = (cfg as { agents?: { entries?: Record<string, AgentEntryLike | undefined> } } | undefined)?.agents?.entries;
  if (!entries?.[normalized]) return null;
  return passesRosterGates(cfg, normalized, specFromEntry(normalized, entries[normalized]));
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