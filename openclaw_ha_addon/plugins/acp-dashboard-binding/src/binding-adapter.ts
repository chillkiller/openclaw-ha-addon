/**
 * SessionBindingAdapter for dashboard/webchat conversations (CONTRACT.md).
 *
 * Adapter semantics (verified against dist/session-binding-service-zDsYoGUk.d.ts):
 * - `resolveByConversationAsync(ref)` is the current Contract (sync variants are
 *   deprecated); we implement BOTH async and the required sync mirror because the
 *   structural `SessionBindingAdapter` type requires `resolveByConversation`
 *   and `listBySession` non-optional.
 * - The host dispatch path (`dispatch-from-config-BG9rT_X3.mjs: resolveBoundAcpDispatchSessionKey`)
 *   resolves, touches (`service.touchAsync(bindingId, undefined, scope)`),
 *   RE-RESOLVES, and then strict-compares `bindingId`, `boundAt`,
 *   `targetSessionKey`, `targetKind`, and conversation identity across both
 *   reads. Therefore the resolved record MUST be deterministic per
 *   conversation: our derived records use a fixed `boundAt: 0` (same trick the
 *   host uses for configured bindings) so the stability check always passes.
 * - `get-reply` retargets the session only when the record is NOT
 *   plugin-owned (`isPluginOwnedSessionBindingRecord` requires
 *   `metadata.pluginBindingOwner === "plugin"` with pluginId + pluginRoot).
 *   We deliberately do NOT set that metadata, so both dispatch paths accept
 *   our ACP target and retarget away from the built-in dashboard session.
 * - This module stays import-free of SDK VALUES (types only, erased at
 *   runtime) so channel.test.ts can run without the host runtime present.
 *   Registering the adapter with the host happens in src/channel.ts; the one
 *   value import below (dashboard-bridge.js) is plugin-local and stays SDK
 *   value-free at static import time too (its SDK import is dynamic/catched).
 *
 * Phase 2.18b (F3, Weg A): synthetic binding keys can never be initialized
 * host-side (manager.utils resolveStoredAcpSession → kind:"stale" +
 * ACP_SESSION_INIT_FAILED without an acp_sessions row;
 * upsertAcpSessionMetaRow writes rows only on a real harness spawn), so the
 * derive consults config.harnessSessions first and targets the REAL spawned
 * session key when one is configured; unset/invalid falls back to the
 * synthetic key (documented: synthetic targets need a host-side
 * /acp-spawn-initialization that does not exist — Weg B/upstream issue).
 * The bridge's §4.2 row-miss path shares this derivation through the roster
 * (dashboard-bridge resolveDashboardBindingDecision), so both halves agree
 * on one target per conversation.
 *
 * KNOWN LIMITATION (Phase 2.10, GaRoN-K6): while this adapter is registered
 * for webchat:default it SHADOWS the host's generic current-conversation
 * binding store completely (read+write). Legacy Weg-1 bindings created via
 * `/acp spawn --bind here` ("generic:" records in the persisted store) are
 * therefore invisible to dispatch while the plugin is loaded, and our own
 * explicit bind() map is in-memory — so explicit binds (old generic ones and
 * new plugin ones) die at restart; only the derived records survive. A
 * legacy-fallthrough import was evaluated and REJECTED as non-trivial:
 * `openclaw/plugin-sdk/conversation-binding-inspection-runtime` only exports
 * inspectSessionBindingByConversation, which routes BACK through the
 * registered adapter (self-recursion), and the actual generic-store reader
 * (inspectGenericCurrentConversationBinding) is dist-internal under a
 * hash-filename module path — importing it would break on every OpenClaw
 * upgrade. Revisit when a plugin-sdk export for the generic store appears.
 */

import {
  BINDING_ACCOUNT_ID,
  BINDING_CHANNEL,
  BINDING_ID_PREFIX,
  BINDING_SOURCE_LABEL,
  buildAcpBindingSessionKey,
  buildBindingId,
  buildChannelAccountKey,
  parseAgentIdFromConversationId,
  resolveHarnessAgentSpec,
  resolveHarnessSessionTargetKey,
  type HarnessAgentSpec,
  isAcpShapedSessionKey,
  normalizeAccountId,
  normalizeChannelId,
  optionalTrim,
} from "./agent-map.js";

// BRIDGE.md §4.2: row-miss delegation to the bridge's write-free resolvers.
// resolveDashboardBindingAsync (sync mirror resolveDashboardBinding) consults
// the ACTIVE bridge's row store/tombstones and otherwise answers with the
// bridge's Turn-1 synthesis — deterministic, without any write access.
import {
  resolveDashboardBinding,
  resolveDashboardBindingAsync as bridgeResolveDashboardBindingAsync,
} from "./dashboard-bridge.js";

/** Structural replica of the host ConversationRef (session-binding.types). */
export type BindingConversationRef = {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
};

type BindingTargetKindValue = "subagent" | "session";
type BindingStatusValue = "active" | "ending" | "ended";

/** Structural replica of the host SessionBindingRecord. */
export type DashboardBindingRecord = {
  bindingId: string;
  targetSessionKey: string;
  targetKind: BindingTargetKindValue;
  conversation: BindingConversationRef;
  status: BindingStatusValue;
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
};

/** Structural replica of the host SessionBindingBindInput. */
export type DashboardBindInput = {
  targetSessionKey: string;
  targetKind: BindingTargetKindValue;
  conversation: BindingConversationRef;
  placement?: "current" | "child";
  metadata?: Record<string, unknown>;
  ttlMs?: number;
  assertCurrent?: () => void;
};

/** Structural replica of the host SessionBindingUnbindInput. */
export type DashboardUnbindInput = {
  bindingId?: string;
  targetSessionKey?: string;
  scope?: { channel: string; accountId: string };
  reason: string;
};

/**
 * Structural replica of the host SessionBindingAdapter contract
 * (session-binding-service-zDsYoGUk.d.ts). Only the async variants plus the
 * required sync mirrors are implemented; the sync `resolveByConversation`/
 * `listBySession` satisfy the required fields of that type.
 */
export type DashboardBindingAdapter = {
  channel: string;
  accountId: string;
  capabilities?: {
    placements?: Array<"current" | "child">;
    bindSupported?: boolean;
    unbindSupported?: boolean;
  };
  bind?: (input: DashboardBindInput) => Promise<DashboardBindingRecord | null>;
  listBySession: (targetSessionKey: string) => DashboardBindingRecord[];
  resolveByConversation: (ref: BindingConversationRef) => DashboardBindingRecord | null;
  inspectByConversation?: (ref: BindingConversationRef) => DashboardBindingRecord | null;
  inspectByConversationAsync?: (ref: BindingConversationRef) => Promise<DashboardBindingRecord | null>;
  resolveByConversationAsync?: (ref: BindingConversationRef) => Promise<DashboardBindingRecord | null>;
  touch?: (bindingId: string, at?: number) => void;
  touchAsync?: (bindingId: string, at?: number) => Promise<void>;
  unbind?: (input: DashboardUnbindInput) => Promise<DashboardBindingRecord[]>;
};

/** Injected config reader so the adapter can refine cwd/mode/backend per agent. */
export type DashboardBindingAdapterOptions = {
  /**
   * Scope the adapter is REGISTERED under. IMPORTANT: the host keys the adapter
   * registry by the adapter object's own `channel`/`accountId` fields
   * (buildChannelAccountKey(normalizeConversationRef(...))) — registering "for"
   * a channel by loop-variable without setting the adapter's channel field
   * silently lands everything under webchat:default. Each scope needs its own
   * adapter instance with the matching channel. Defaults to webchat/default.
   */
  channel?: string;
  accountId?: string;
  /**
   * Latest live OpenClaw config (agents.entries.<id>.runtime.acp); may be
   * absent. Read on EVERY resolve (Phase 2.7 dynamic roster: entries with
   * runtime.type==='acp' are the harness agents); undefined/empty config
   * yields an empty roster — no match, no derive.
   */
  getConfig?: () => unknown;
  /** Testability hook for explicit-bind timestamps. */
  now?: () => number;
};

/**
 * Derives a deterministic binding record for the conversation.
 *
 * Returns null when the conversation does not map to a harness agent —
 * main/unknown agents keep their untouched dispatch (acceptance #4).
 */
function deriveBindingRecord(ref: BindingConversationRef, options: DashboardBindingAdapterOptions): DashboardBindingRecord | null {
  const channel = normalizeChannelId(ref.channel) || BINDING_CHANNEL;
  const accountId = normalizeAccountId(ref.accountId) || BINDING_ACCOUNT_ID;
  const conversationId = typeof ref.conversationId === "string" ? ref.conversationId.trim() : "";
  if (!conversationId) return null;

  const agentId = parseAgentIdFromConversationId(conversationId);
  if (!agentId) return null;

  const spec: HarnessAgentSpec | null = resolveHarnessAgentSpec(options.getConfig?.(), agentId);
  if (!spec) return null;

  // Phase 2.18b (F3 Weg A): the gate-ladder above decides WHO binds and is
  // untouched — only the TARGET changes here. A validated
  // `config.harnessSessions` entry (a real, explicitly spawned persistent ACP
  // session key, ACP-shaped, not an orchestrator target) replaces the
  // synthetic key; unset/invalid entries keep the previous synthetic target.
  // Metadata below stays informative either way.
  const configuredTargetKey: string | null = resolveHarnessSessionTargetKey(options.getConfig?.(), spec);

  const conversation: BindingConversationRef = {
    channel,
    accountId,
    conversationId,
    ...ref.parentConversationId && ref.parentConversationId.trim() && ref.parentConversationId.trim() !== conversationId
      ? { parentConversationId: ref.parentConversationId.trim() }
      : {}
  };

  const metadata: Record<string, unknown> = {
    source: BINDING_SOURCE_LABEL,
    mode: spec.mode,
    agentId: spec.agentId
  };
  if (spec.harness) metadata.acpAgentId = spec.harness;
  if (spec.cwd) metadata.cwd = spec.cwd;
  if (spec.backend) metadata.backend = spec.backend;

  return {
    bindingId: buildBindingId({ channel, accountId, conversationId, kind: "derived" }),
    // buildConfiguredAcpSessionKey-equivalent target; `agent:codex:acp:...`
    // makes host isAcpSessionKey true -> resolveSessionDispatchKind === "acp".
    // With a validated harnessSessions entry the target is the REAL spawned
    // session key instead (which actually carries an acp_sessions row — F3).
    targetSessionKey: configuredTargetKey ?? derivedTargetSessionKey(conversation, spec.agentId),
    targetKind: "session",
    conversation,
    status: "active",
    // Fixed boundAt keeps the host's resolve -> touch -> re-resolve stability
    // comparison deterministic (mirror of configured binding records).
    boundAt: 0,
    metadata
  };
}

/** Ref projection for the §4.2 delegation into dashboard-bridge. */
function toBridgeRef(ref: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  return {
    channel: ref.channel,
    accountId: ref.accountId,
    conversationId: ref.conversationId,
    ...(ref.parentConversationId ? { parentConversationId: ref.parentConversationId } : {}),
  };
}

/**
 * §4.2 row-miss consult of the bridge (sync mirror): returns the bridge's
 * row/tombstone/synthesis answer — or null (which falls through to our own
 * Turn-1 synthesis so the record exists in bridge-less setups, too).
 */
function bridgedRecord(ref: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): DashboardBindingRecord | null {
  const bridged = resolveDashboardBinding(toBridgeRef(ref));
  return bridged ? (bridged as unknown as DashboardBindingRecord) : null;
}

function derivedTargetSessionKey(conversation: BindingConversationRef, agentId: string): string {
  // buildConfiguredAcpSessionKey-equivalent construction (host dist
  // persistent-bindings.types-DWbrbd8R.mjs); one consistent builder in agent-map.
  return buildAcpBindingSessionKey({
    channel: conversation.channel,
    accountId: conversation.accountId,
    conversationId: conversation.conversationId,
    agentId
  });
}

function sameConversation(a: BindingConversationRef, b: BindingConversationRef): boolean {
  return (
    buildChannelAccountKey({ channel: a.channel, accountId: a.accountId }) ===
      buildChannelAccountKey({ channel: b.channel, accountId: b.accountId }) &&
    a.conversationId === b.conversationId
  );
}

/**
 * Creates the adapter. Pure by itself; channel.ts registers it with
 * registerSessionBindingAdapter(...) under the webchat scope (and the plugin's
 * own channel id so its own namespace never fails closed).
 */
export function createDashboardBindingAdapter(options: DashboardBindingAdapterOptions = {}): DashboardBindingAdapter {
  // Explicit bindings: host-side bind()/unbind() storage for this conversation
  // scope (in-memory MVP; derived defaults survive restarts, explicit binds do not).
  const explicit = new Map<string, DashboardBindingRecord>();
  const ownChannel = normalizeChannelId(options.channel) || BINDING_CHANNEL;
  const ownAccountId = normalizeAccountId(options.accountId) || BINDING_ACCOUNT_ID;

  /** Explicit rows only — shared by the sync mirror and the async resolver. */
  const findExplicit = (channel: string, accountId: string, conversationId: string): DashboardBindingRecord | null => {
    for (const record of explicit.values()) {
      if (sameConversation(record.conversation, { channel, accountId, conversationId })) return record;
    }
    return null;
  };

  const resolve = (ref: BindingConversationRef): DashboardBindingRecord | null => {
    const conversationId = optionalTrim(ref.conversationId);
    if (!conversationId) return null;
    const channel = normalizeChannelId(ref.channel);
    const accountId = normalizeAccountId(ref.accountId);
    // 1. Prefer an explicit bound record host-side (/acp spawn --bind here …).
    const bound = findExplicit(channel, accountId, conversationId);
    if (bound) return bound;
    // 2. BRIDGE.md §4.2 row-miss delegation: consult the bridge's write-free,
    //    deterministic resolver (its rows/tombstones, else its Turn-1
    //    synthesis) so both halves agree on one record per conversation.
    const bridged = bridgedRecord({
      channel,
      accountId,
      conversationId,
      ...(ref.parentConversationId ? { parentConversationId: ref.parentConversationId } : {}),
    });
    if (bridged) return bridged;
    // 3. Otherwise derive the ACP target for harness agent conversations
    //    (own Turn-1 synthesis — answers when no bridge is active).
    return deriveBindingRecord({ channel, accountId, conversationId, ...ref.parentConversationId ? { parentConversationId: ref.parentConversationId } : {} }, options);
  };

  return {
    channel: ownChannel,
    accountId: ownAccountId,
    capabilities: {
      placements: ["current"],
      bindSupported: true,
      unbindSupported: true
    },

    async bind(input: DashboardBindInput): Promise<DashboardBindingRecord | null> {
      const conversationId = optionalTrim(input.conversation?.conversationId);
      const channel = normalizeChannelId(input.conversation?.channel) || BINDING_CHANNEL;
      const accountId = normalizeAccountId(input.conversation?.accountId) || BINDING_ACCOUNT_ID;
      if (!conversationId) return null;
      if (input.placement === "child") return null; // MVP keeps current-placement only.
      // Explicit binds must stay ACP-dispatchable; a plain `agent:...` target
      // would silently fall back to the built-in dashboard session.
      if (input.targetKind !== "session" || !isAcpShapedSessionKey(input.targetSessionKey)) return null;
      const conversation: BindingConversationRef = { channel, accountId, conversationId };
      const record: DashboardBindingRecord = {
        bindingId: buildBindingId({ channel, accountId, conversationId, kind: "explicit" }),
        targetSessionKey: input.targetSessionKey,
        targetKind: input.targetKind,
        conversation,
        status: "active",
        boundAt: (options.now ?? Date.now)(),
        metadata: {
          ...input.metadata ?? {},
          boundBy: "plugin"
        }
      };
      explicit.set(record.bindingId, record);
      return record;
    },

    async unbind(input: DashboardUnbindInput): Promise<DashboardBindingRecord[]> {
      const removed: DashboardBindingRecord[] = [];
      const scopeKey = input.scope ? buildChannelAccountKey(input.scope) : null;
      for (const record of [...explicit.values()]) {
        if (input.bindingId && record.bindingId !== input.bindingId) continue;
        if (input.targetSessionKey && record.targetSessionKey !== input.targetSessionKey) continue;
        if (scopeKey && buildChannelAccountKey(record.conversation) !== scopeKey) continue;
        explicit.delete(record.bindingId);
        removed.push(record);
      }
      return removed;
    },

    listBySession(targetSessionKey: string): DashboardBindingRecord[] {
      const key = optionalTrim(targetSessionKey);
      if (!key) return [];
      return [...explicit.values()].filter((record) => record.targetSessionKey === key);
    },

    // Pure, deterministic — safe to expose synchronously. The host's
    // resolveByConversationAsync prefers the async variant. Both mirrors share
    // one cascade (explicit row → §4.2 bridge consult → Turn-1 synthesis), so
    // the host's resolve → touchAsync → re-resolve stability check sees the
    // identical record through either path.
    resolveByConversation: resolve,
    inspectByConversation: resolve,

    async resolveByConversationAsync(ref: BindingConversationRef): Promise<DashboardBindingRecord | null> {
      const conversationId = optionalTrim(ref.conversationId);
      if (!conversationId) return null;
      const channel = normalizeChannelId(ref.channel);
      const accountId = normalizeAccountId(ref.accountId);
      const bound = findExplicit(channel, accountId, conversationId);
      if (bound) return bound;
      // §4.2: the mid-cascade row-miss delegation hop goes through the
      // bridge's EXPORTED async resolver (same deterministic core as
      // resolveDashboardBinding, mirrored by the sync variant above).
      const bridged = await bridgeResolveDashboardBindingAsync(toBridgeRef({
        channel,
        accountId,
        conversationId,
        ...(ref.parentConversationId ? { parentConversationId: ref.parentConversationId } : {}),
      }));
      if (bridged) return bridged as unknown as DashboardBindingRecord;
      return deriveBindingRecord({ channel, accountId, conversationId, ...ref.parentConversationId ? { parentConversationId: ref.parentConversationId } : {} }, options);
    },
    // "Inspects committed ownership without creating storage or pruning rows."
    async inspectByConversationAsync(ref: BindingConversationRef): Promise<DashboardBindingRecord | null> {
      return resolve(ref);
    },

    // Derived records need no activity bookkeeping; explicit MVP bindings do
    // not track idle expiry. Required so the host's touchAsync join completes.
    touch: (_bindingId: string, _at?: number) => {},
    async touchAsync(_bindingId: string, _at?: number): Promise<void> {}
  };
}

/** The conversation identity tuple this plugin owns (webchat:default). */
export function dashboardBindingScope() {
  return { channel: BINDING_CHANNEL, accountId: BINDING_ACCOUNT_ID };
}

/** Marker used by channel.ts cleanup — prefix kept for grep. */
export const BINDING_PREFIX_MARKER = BINDING_ID_PREFIX;