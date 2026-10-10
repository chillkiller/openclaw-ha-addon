/**
 * Shared constants + harness-agent roster lookup for the acp-dashboard-binding plugin.
 *
 * This module is the single source of truth for the constants that BOTH plugin
 * halves import (per CONTRACT.md): the plugin skeleton here and the dashboard
 * key bridge from the opencode harness. Keep it free of any SDK value imports
 * (type-only imports are fine) so tests and the bridge can load it standalone.
 */

import { createHash } from "node:crypto";

/** Agents that are dispatched through the ACP harness backends. */
export const HARNESS_AGENT_IDS = ["codex", "claude", "opencode"] as const;

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
  acpAgentId?: string;
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

/**
 * Roster lookup: is `agentId` a harness agent, and what are its ACP runtime
 * settings from `agents.entries.<id>.runtime.acp`?
 *
 * Returns null for anything outside HARNESS_AGENT_IDS (main/unknown agents
 * must stay untouched — acceptance criterion #4).
 */
export function resolveHarnessAgentSpec(cfg: unknown, agentId: unknown): HarnessAgentSpec | null {
  const normalized = sanitizeAgentId(agentId);
  if (!(HARNESS_AGENT_IDS as readonly string[]).includes(normalized)) return null;

  const agents = cfg as { agents?: { entries?: Record<string, AgentEntryLike> } } | undefined;
  const entry = agents?.agents?.entries?.[normalized];
  let mode: HarnessAgentSpec["mode"] = BINDING_MODE;
  let cwd = optionalString(entry?.cwd) ?? optionalString(entry?.workspace);
  let backend: string | undefined;
  let acpAgentId: string | undefined;

  if (entry?.runtime?.type === "acp") {
    const acp = entry.runtime.acp ?? {};
    if (acp.mode === "oneshot") mode = "oneshot";
    cwd = optionalString(acp.cwd) ?? cwd;
    backend = optionalString(acp.backend);
    acpAgentId = optionalString(acp.agent);
  }

  // MVP default: keep each harness agent under the shared workspace prefix.
  if (!cwd) cwd = `${DEFAULT_CWD_PREFIX}${normalized}`;

  return {
    agentId: normalized,
    mode,
    cwd,
    backend,
    ...acpAgentId ? { acpAgentId } : {}
  };
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