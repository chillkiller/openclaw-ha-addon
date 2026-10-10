import { createHash } from "node:crypto";

// Shared plugin constants live in agent-map (BRIDGE.md §4.3 / Phase-2.6 fix):
// one source for bridge + adapter, so binding-id prefixes and roster ids cannot
// drift apart. agent-map keeps the prefix (plugin-binding:) — it is now used
// for ALL bindingIds of this plugin (bridge rows AND adapter records).
import {
  BINDING_ACCOUNT_ID,
  BINDING_CHANNEL,
  BINDING_ID_PREFIX,
  BINDING_MODE,
  CHANNEL_ID,
  isRosterEligibleAgentId,
  resolveBoundAgentAllowlist,
  resolveExcludedAgentIds,
  resolveHarnessAgentSpec,
  resolveHarnessSessionTargetKey,
} from "./agent-map.js";

// Bridge public surface keeps exporting the shared constants (tests/plugins
// previously imported them from here). HARNESS_AGENT_IDS was removed in
// Phase 2.7 — the harness roster is dynamic (config-derived, agent-map).
export {
  BINDING_ACCOUNT_ID,
  BINDING_CHANNEL,
  BINDING_ID_PREFIX,
  BINDING_MODE,
  CHANNEL_ID,
  DEFAULT_CWD_PREFIX,
  ORCHESTRATOR_AGENT_IDS,
  isOrchestratorAgentId,
  isRosterEligibleAgentId,
  resolveBoundAgentAllowlist,
  resolveExcludedAgentIds,
  resolveHarnessSessionTargetKey,
} from "./agent-map.js";

const WEBCHAT_ADAPTER_KEY = `${BINDING_CHANNEL}:${BINDING_ACCOUNT_ID}`;
// Phase 2.12 F1: keyed-store contracts for the bridge's own rows/tombstones.
const ROWS_STORE_NAMESPACE = "webchat.dashboard-bridge.rows";
const TOMBSTONES_STORE_NAMESPACE = "webchat.dashboard-bridge.tombstones";
const ROW_STORE_MAX_ENTRIES = 1000;
const CONVERSATION_KEY_SEPARATOR = "\u241f";
const DEFAULT_AGENT_ID = "main";

export interface ConversationRefLike {
  readonly channel: string;
  readonly accountId: string;
  readonly conversationId: string;
  readonly parentConversationId?: string;
}

export interface SessionBindingRecordLike {
  bindingId: string;
  targetSessionKey: string;
  targetKind: string;
  conversation: ConversationRefLike;
  status: string;
  boundAt: number;
  expiresAt?: number;
  metadata?: Record<string, unknown>;
}

export interface HarnessAgentDefaults {
  readonly mode: string;
  readonly backend?: string;
  readonly cwd?: string;
  readonly label?: string;
}

export interface HarnessRoster {
  isHarnessAgent(agentId: string): boolean;
  acpDefaults(agentId: string): HarnessAgentDefaults | null;
  /**
   * Phase 2.18b (F3 Weg A): the validated `config.harnessSessions` target for
   * the agent (real spawned session key), or null when unset/invalid → the
   * caller derives the synthetic ACP target as before. Optional so custom
   * rosters opt in; the config-backed roster shares agent-map's resolver,
   * keeping bridge and binding-adapter on one target derivation.
   */
  harnessSessionTargetKey?(agentId: string): string | null;
}

export interface DashboardConversationKey {
  readonly agentId: string;
  readonly rawKey: string;
  readonly dashboardToken: string;
  readonly rest: string;
}

export interface DashboardBindingDecision {
  readonly conversation: ConversationRefLike;
  readonly dashboardKey: DashboardConversationKey;
  readonly bindingId: string;
  readonly targetSessionKey: string;
  readonly defaults: HarnessAgentDefaults;
}

const AGENT_ID_VALID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const AGENT_ID_INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
const AGENT_ID_LEADING_DASH_RE = /^-+/;
const AGENT_ID_TRAILING_DASH_RE = /-+$/;

export function normalizeAgentId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  const lowercased = trimmed.toLowerCase();
  if (AGENT_ID_VALID_RE.test(trimmed)) return lowercased.length > 0 ? lowercased : DEFAULT_AGENT_ID;
  const sanitized = lowercased
    .replace(AGENT_ID_INVALID_CHARS_RE, "-")
    .replace(AGENT_ID_LEADING_DASH_RE, "")
    .replace(AGENT_ID_TRAILING_DASH_RE, "")
    .slice(0, 64);
  return sanitized.length > 0 ? sanitized : DEFAULT_AGENT_ID;
}

export function sanitizeAgentId(value: string | undefined | null): string {
  return normalizeAgentId(value);
}

export function normalizeAccountId(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return BINDING_ACCOUNT_ID;
  const lowercased = trimmed.toLowerCase();
  if (AGENT_ID_VALID_RE.test(trimmed)) return lowercased;
  const sanitized = lowercased
    .replace(AGENT_ID_INVALID_CHARS_RE, "-")
    .replace(AGENT_ID_LEADING_DASH_RE, "")
    .replace(AGENT_ID_TRAILING_DASH_RE, "")
    .slice(0, 64);
  return sanitized.length > 0 ? sanitized : BINDING_ACCOUNT_ID;
}

function sha256HexPrefix(input: string, length: number): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, length);
}

export function buildChannelAccountKey(params: { channel: string; accountId: string }): string {
  return `${params.channel.trim().toLowerCase()}:${normalizeAccountId(params.accountId)}`;
}

export function buildBindingId(conversation: ConversationRefLike): string {
  return `${BINDING_ID_PREFIX}${[
    conversation.channel,
    conversation.accountId,
    conversation.parentConversationId ?? "",
    conversation.conversationId,
  ].join(CONVERSATION_KEY_SEPARATOR)}`;
}

export function parseDashboardConversationKey(
  conversationId: string | undefined | null,
): DashboardConversationKey | null {
  const rawKey = (conversationId ?? "").trim();
  if (!rawKey) return null;
  const parts = rawKey.split(":");
  if (parts.length < 4) return null;
  const namespace = parts[0] ?? "";
  const agentSegment = parts[1] ?? "";
  const kindSegment = parts[2] ?? "";
  const restParts = parts.slice(3);
  if (namespace.toLowerCase() !== "agent") return null;
  if (kindSegment.toLowerCase() !== "dashboard") return null;
  if (!agentSegment || restParts.length === 0) return null;
  return {
    agentId: sanitizeAgentId(agentSegment),
    rawKey,
    dashboardToken: restParts.join(":"),
    rest: [kindSegment, ...restParts].join(":"),
  };
}

export function buildDashboardAcpTargetSessionKey(params: {
  agentId: string;
  channel?: string;
  accountId?: string;
  conversationId: string;
}): string {
  const channel = (params.channel ?? BINDING_CHANNEL).trim().toLowerCase();
  const accountId = normalizeAccountId(params.accountId);
  const hash = sha256HexPrefix(`${channel}:${accountId}:${params.conversationId}`, 16);
  return `agent:${sanitizeAgentId(params.agentId)}:acp:binding:${channel}:${accountId}:${hash}`;
}

export function isPluginOwnedBindingMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return (
    metadata?.pluginBindingOwner === "plugin" &&
    typeof metadata?.pluginId === "string" &&
    typeof metadata?.pluginRoot === "string"
  );
}

type AgentConfigEntryLike = {
  runtime?: {
    type?: string;
    acp?: {
      mode?: string;
      backend?: string;
      cwd?: string;
      label?: string;
    };
  };
};

type ConfigLike = {
  agents?: {
    entries?: Record<string, AgentConfigEntryLike | undefined>;
  };
};

export function createConfigHarnessRoster(config: unknown): HarnessRoster {
  const agentsConfig = (config as ConfigLike | undefined)?.agents;
  return {
    isHarnessAgent(agentId: string): boolean {
      // Phase 2.7: the roster is fully config-derived — an entry is a harness
      // agent iff runtime.type === "acp" (no fixed id list). Eligibility is
      // the Phase 2.17 precedence ladder shared with agent-map
      // (isRosterEligibleAgentId): boundAgents positive list (highest
      // priority, may even bind orchestrator ids) > excludedAgents (replaces
      // the default exclusion) > safe-default exclusion
      // (main/coding-main/coding-review) that applies only without both.
      const canonical = normalizeAgentId(agentId);
      if (!isRosterEligibleAgentId(config, canonical)) return false;
      const entry = agentsConfig?.entries?.[canonical] ?? agentsConfig?.entries?.[agentId];
      if (entry?.runtime?.type !== "acp") return false;
      return true;
    },
    acpDefaults(agentId: string): HarnessAgentDefaults | null {
      if (!this.isHarnessAgent(agentId)) return null;
      const entry =
        agentsConfig?.entries?.[normalizeAgentId(agentId)] ?? agentsConfig?.entries?.[agentId];
      const acp = entry?.runtime?.type === "acp" ? entry.runtime.acp : undefined;
      return {
        mode: typeof acp?.mode === "string" && acp.mode.trim() ? acp.mode : BINDING_MODE,
        ...(typeof acp?.backend === "string" && acp.backend.trim() ? { backend: acp.backend } : {}),
        ...(typeof acp?.cwd === "string" && acp.cwd.trim() ? { cwd: acp.cwd } : {}),
        ...(typeof acp?.label === "string" && acp.label.trim() ? { label: acp.label } : {}),
      };
    },
    // Phase 2.18b (F3 Weg A): resolves the real spawned-session target from
    // plugins.entries['acp-dashboard-binding'].config.harnessSessions through
    // the SAME validated agent-map resolver the binding-adapter uses — the
    // §4.2 row-miss delegation therefore answers with the real key too, not
    // only the adapter's own Turn-1 synthesis.
    harnessSessionTargetKey(agentId: string): string | null {
      const spec = resolveHarnessAgentSpec(config, agentId);
      if (!spec) return null;
      return resolveHarnessSessionTargetKey(config, spec);
    },
  };
}

export function resolveDashboardBindingDecision(
  ref: {
    channel: string;
    accountId?: string | null;
    conversationId: string;
    parentConversationId?: string | null;
  },
  roster: HarnessRoster,
): DashboardBindingDecision | null {
  const channel = (ref.channel ?? "").trim().toLowerCase();
  if (channel !== BINDING_CHANNEL) return null;
  const conversationId = (ref.conversationId ?? "").trim();
  if (!conversationId) return null;
  const dashboardKey = parseDashboardConversationKey(conversationId);
  if (!dashboardKey) return null;
  if (!roster.isHarnessAgent(dashboardKey.agentId)) return null;
  if (buildChannelAccountKey({ channel, accountId: normalizeAccountId(ref.accountId) }) !== WEBCHAT_ADAPTER_KEY) {
    return null;
  }
  const conversation: ConversationRefLike = {
    channel,
    accountId: normalizeAccountId(ref.accountId),
    conversationId,
    ...(ref.parentConversationId ? { parentConversationId: ref.parentConversationId.trim() } : {}),
  };
  const defaults = roster.acpDefaults(dashboardKey.agentId) ?? { mode: BINDING_MODE };
  // Phase 2.18b (F3 Weg A): a validated harnessSessions entry REPLACES the
  // synthetic ACP target with the real spawned session key; unset/invalid
  // keeps the §1.4 synthetic derivation. The roster gate is upstream of this
  // point and unchanged.
  const configuredTargetKey = roster.harnessSessionTargetKey?.(dashboardKey.agentId) ?? null;
  return {
    conversation,
    dashboardKey,
    bindingId: buildBindingId(conversation),
    targetSessionKey: configuredTargetKey ?? buildDashboardAcpTargetSessionKey({
      agentId: dashboardKey.agentId,
      channel: conversation.channel,
      accountId: conversation.accountId,
      conversationId,
    }),
    defaults,
  };
}

export function synthesizeDashboardBindingRecord(
  decision: DashboardBindingDecision,
): SessionBindingRecordLike {
  return {
    bindingId: decision.bindingId,
    targetSessionKey: decision.targetSessionKey,
    targetKind: "session",
    conversation: decision.conversation,
    status: "active",
    boundAt: 0,
    metadata: {
      source: "plugin",
      plugin: CHANNEL_ID,
      origin: "dashboard-bridge",
      mode: decision.defaults.mode,
      agentId: decision.dashboardKey.agentId,
      ...(decision.defaults.backend ? { backend: decision.defaults.backend } : {}),
      ...(decision.defaults.cwd ? { cwd: decision.defaults.cwd } : {}),
      ...(decision.defaults.label ? { label: decision.defaults.label } : {}),
    },
  };
}

export function createStandaloneBindingResolver(roster: HarnessRoster): (
  ref: {
    channel: string;
    accountId?: string | null;
    conversationId: string;
    parentConversationId?: string | null;
  },
) => SessionBindingRecordLike | null {
  return (ref) => {
    const decision = resolveDashboardBindingDecision(ref, roster);
    if (!decision) return null;
    return synthesizeDashboardBindingRecord(decision);
  };
}

// --- BRIDGE.md §4.2: write-free delegation target for binding-adapter.ts ----

/** Conversation ref accepted by the write-free dashboard binding resolvers. */
export type DashboardBindingRefLike = {
  channel: string;
  accountId?: string | null;
  conversationId: string;
  parentConversationId?: string | null;
};

interface ActiveBridgeResolution {
  readonly roster: HarnessRoster;
  readonly store: BridgeRowStoreLike;
}

// Exposed by the LIVE bridge instance so the exported resolvers below consult
// its row store/tombstones without a hard reference to that instance. The
// pointer follows the most recently created bridge; dispose clears it.
let activeBridgeResolution: ActiveBridgeResolution | null = null;

/**
 * BRIDGE.md §4.2 row-miss resolver for claude's binding-adapter.ts:
 * deterministic and write-free — a row in the active bridge's store wins, a
 * tombstone there suppresses the binding, otherwise the Turn-1 synthesis
 * (boundAt: 0) answers. Without an active bridge an unbacked fallback roster
 * feeds the same synthesis, so the adapter delegation is behavior-stable in
 * every composition (bridge-first, hooks-only, or isolated plugin load).
 */
export function resolveDashboardBinding(
  ref: DashboardBindingRefLike,
  context?: { roster?: HarnessRoster; store?: BridgeRowStoreLike | null },
): SessionBindingRecordLike | null {
  const roster = context?.roster ?? activeBridgeResolution?.roster ?? createConfigHarnessRoster(undefined);
  const store =
    context?.store !== undefined ? context.store ?? null : activeBridgeResolution?.store ?? null;
  const decision = resolveDashboardBindingDecision(ref, roster);
  if (!decision) return null;
  const row = store?.row(decision.bindingId) ?? null;
  if (row) return row;
  if (store?.hasTombstone(decision.bindingId)) return null;
  return synthesizeDashboardBindingRecord(decision);
}

/**
 * Async mirror of {@link resolveDashboardBinding} — the exported §4.2
 * delegation target that binding-adapter.ts calls on row-miss. Identical
 * results, so the host's resolve → re-resolve stability comparison stays
 * byte-stable whether it went through the sync mirror or this path.
 */
export async function resolveDashboardBindingAsync(
  ref: DashboardBindingRefLike,
): Promise<SessionBindingRecordLike | null> {
  // Phase 2.12 F2: wait out the active bridge's startup hydration so the async
  // mirror never diverges from the (post-hydrate) sync core.
  await activeBridgeResolution?.store.whenReady();
  return resolveDashboardBinding(ref);
}

export interface KeyedStoreLike<T> {
  registerIfAbsent(key: string, value: T): Promise<boolean>;
  lookup(key: string): Promise<T | undefined>;
  delete(key: string): Promise<boolean>;
  /** Live-entry read (host PluginStateKeyedStore.entries); optional so test fakes stay minimal. */
  entries?: () => Promise<Array<{ key: string; value: T }>>;
}

/** Dist contract for openKeyedStore (OpenKeyedStoreOptions, agent-harness-runtime-R8dTs5zl.d.ts:27590). */
export interface OpenKeyedStoreOptionsLike {
  namespace: string;
  maxEntries: number;
}

export interface SessionBindingServiceLike {
  bind?: (input: {
    targetSessionKey: string;
    targetKind: string;
    conversation: ConversationRefLike;
    placement?: string;
    metadata?: Record<string, unknown>;
  }) => Promise<SessionBindingRecordLike>;
  resolveByConversationAsync?: (ref: ConversationRefLike) => Promise<SessionBindingRecordLike | null>;
  inspectByConversationAsync?: (ref: ConversationRefLike) => Promise<SessionBindingRecordLike | null>;
  touchAsync?: (bindingId: string, at?: number, scope?: ConversationRefLike) => Promise<void>;
  unbind?: (input: {
    bindingId?: string;
    targetSessionKey?: string;
    scope?: ConversationRefLike;
    reason: string;
  }) => Promise<SessionBindingRecordLike[]>;
}

export interface SessionBindingAdapterLike {
  channel: string;
  accountId: string;
  capabilities?: { placements?: string[]; bindSupported?: boolean; unbindSupported?: boolean };
  resolveByConversation(ref: ConversationRefLike): SessionBindingRecordLike | null;
  resolveByConversationAsync(ref: ConversationRefLike): Promise<SessionBindingRecordLike | null>;
  inspectByConversationAsync?(ref: ConversationRefLike): Promise<SessionBindingRecordLike | null>;
  touchAsync(bindingId: string, at?: number, scope?: ConversationRefLike): Promise<void>;
  bind(input: {
    targetSessionKey: string;
    targetKind: string;
    conversation: ConversationRefLike;
    placement?: string;
    metadata?: Record<string, unknown>;
  }): Promise<SessionBindingRecordLike | null>;
  unbind(input: {
    bindingId?: string;
    targetSessionKey?: string;
    scope?: ConversationRefLike;
    reason: string;
  }): Promise<SessionBindingRecordLike[]>;
  listBySession(targetSessionKey: string): SessionBindingRecordLike[];
}

export interface DashboardBridgeLogger {
  info?: (message: string, ...args: unknown[]) => void;
  debug?: (message: string, ...args: unknown[]) => void;
  warn?: (message: string, ...args: unknown[]) => void;
  error?: (message: string, ...args: unknown[]) => void;
}

export interface DashboardBridgeApiLike {
  id?: string;
  config?: unknown;
  logger?: DashboardBridgeLogger;
  registerHook?: (
    events: string | string[],
    handler: (event: DashboardHookEventLike, ctx: unknown) => unknown,
    opts?: Record<string, unknown>,
  ) => void;
  runtime?: {
    state?: {
      openKeyedStore?: <T>(options: OpenKeyedStoreOptionsLike) => KeyedStoreLike<T>;
    };
  };
}

export interface DashboardHookEventLike {
  channel?: string;
  channelId?: string;
  accountId?: string | null;
  conversationId?: string | null;
  sessionKey?: string | null;
  parentConversationId?: string | null;
}

const SESSION_BINDING_RUNTIME_SUBPATH: string = "openclaw/plugin-sdk/session-binding-runtime";

export interface SessionBindingRuntimeModule {
  getSessionBindingService?: () => SessionBindingServiceLike;
  registerSessionBindingAdapter?: (adapter: SessionBindingAdapterLike) => void;
  testing?: { getRegisteredAdapterKeys: () => string[] };
}

interface BridgeRow {
  record: SessionBindingRecordLike;
}

export interface BridgeRowStoreLike {
  row(bindingId: string): SessionBindingRecordLike | null;
  hasTombstone(bindingId: string): boolean;
  upsertRow(record: SessionBindingRecordLike): void;
  removeRow(bindingId: string): SessionBindingRecordLike | null;
  listBySession(targetSessionKey: string): SessionBindingRecordLike[];
  /** Phase 2.12 F2: loads persisted rows/tombstones once; first call wins, never rejects. */
  hydrate(): Promise<void>;
  /** Resolves once startup hydration (F2) finished — always resolves, never rejects. */
  whenReady(): Promise<void>;
}

export interface BridgeRowStoreOptions {
  /** Called when hydrating a persisted store failed — memory-only rows continue. */
  onHydrateError?: (error: unknown) => void;
}

export function createBridgeRowStore(
  persistedRows?: KeyedStoreLike<BridgeRow> | null,
  persistedTombstones?: KeyedStoreLike<true> | null,
  options?: BridgeRowStoreOptions,
): BridgeRowStoreLike {
  return new BridgeRowStore(persistedRows, persistedTombstones, options);
}

const ROW_KEY_PREFIX = "row:";
const TOMBSTONE_KEY_PREFIX = "tombstone:";

function isBridgeRowValue(value: unknown): value is BridgeRow {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as BridgeRow).record?.bindingId === "string"
  );
}

class BridgeRowStore implements BridgeRowStoreLike {
  private readonly rows = new Map<string, BridgeRow>();
  private readonly tombstones = new Set<string>();
  private hydratePromise: Promise<void> | null = null;

  constructor(
    private readonly persistedRows?: KeyedStoreLike<BridgeRow> | null,
    private readonly persistedTombstones?: KeyedStoreLike<true> | null,
    private readonly options?: BridgeRowStoreOptions,
  ) {}

  /**
   * Phase 2.12 F2 boot hydration: loads persisted rows + tombstones from the
   * host keyed store into the memory maps so a fresh process resolves
   * materialized binds and unbind tombstones from before the restart.
   * Idempotent (first call wins); never rejects — per-store failures are
   * swallowed after reporting, execution continues memory-only. In-memory
   * writes that happened during hydrate always win over persisted entries.
   */
  async hydrate(): Promise<void> {
    if (!this.hydratePromise) {
      this.hydratePromise = this.hydrateOnce().catch((error) => {
        this.options?.onHydrateError?.(error);
      });
    }
    return await this.hydratePromise;
  }

  whenReady(): Promise<void> {
    return this.hydratePromise ?? Promise.resolve();
  }

  private async hydrateOnce(): Promise<void> {
    try {
      await this.hydrateRows();
    } finally {
      try {
        await this.hydrateTombstones();
      } catch (error) {
        this.options?.onHydrateError?.(error);
      }
    }
  }

  private async hydrateRows(): Promise<void> {
    const persisted = this.persistedRows;
    if (!persisted?.entries) return;
    const entries = await persisted.entries();
    for (const entry of entries) {
      const bindingId = typeof entry?.key === "string" && entry.key.startsWith(ROW_KEY_PREFIX)
        ? entry.key.slice(ROW_KEY_PREFIX.length)
        : "";
      if (!bindingId) continue;
      const row = entry.value;
      if (!isBridgeRowValue(row)) continue;
      // Guards: in-memory rows already written (e.g. a bind during hydrate)
      // win, and a tombstone seen so far suppresses a stale persisted row.
      if (this.rows.has(bindingId) || this.tombstones.has(bindingId)) continue;
      this.rows.set(bindingId, row);
    }
  }

  private async hydrateTombstones(): Promise<void> {
    const persisted = this.persistedTombstones;
    if (!persisted?.entries) return;
    const entries = await persisted.entries();
    for (const entry of entries) {
      const bindingId = typeof entry?.key === "string" && entry.key.startsWith(TOMBSTONE_KEY_PREFIX)
        ? entry.key.slice(TOMBSTONE_KEY_PREFIX.length)
        : "";
      if (!bindingId) continue;
      // A live in-memory row revived the binding — the row must win.
      if (!this.rows.has(bindingId)) this.tombstones.add(bindingId);
    }
  }

  row(bindingId: string): SessionBindingRecordLike | null {
    if (this.tombstones.has(bindingId)) return null;
    return this.rows.get(bindingId)?.record ?? null;
  }

  hasTombstone(bindingId: string): boolean {
    return this.tombstones.has(bindingId);
  }

  upsertRow(record: SessionBindingRecordLike): void {
    this.tombstones.delete(record.bindingId);
    const row: BridgeRow = { record };
    this.rows.set(record.bindingId, row);
    void this.persistedRows?.registerIfAbsent(`${ROW_KEY_PREFIX}${record.bindingId}`, row).catch(() => undefined);
  }

  removeRow(bindingId: string): SessionBindingRecordLike | null {
    const row = this.rows.get(bindingId);
    if (!row) return null;
    this.rows.delete(bindingId);
    this.tombstones.add(bindingId);
    void this.persistedRows?.delete(`${ROW_KEY_PREFIX}${bindingId}`).catch(() => undefined);
    void this.persistedTombstones?.registerIfAbsent(`${TOMBSTONE_KEY_PREFIX}${bindingId}`, true).catch(() => undefined);
    return row.record;
  }

  listBySession(targetSessionKey: string): SessionBindingRecordLike[] {
    const results: SessionBindingRecordLike[] = [];
    for (const row of this.rows.values()) {
      if (row.record.targetSessionKey === targetSessionKey) results.push(row.record);
    }
    return results;
  }
}

export function createWebchatDashboardBindingAdapter(args: {
  roster: HarnessRoster;
  store: BridgeRowStoreLike;
  logger?: DashboardBridgeLogger;
}): SessionBindingAdapterLike {
  const resolveSync = (ref: ConversationRefLike): SessionBindingRecordLike | null => {
    const decision = resolveDashboardBindingDecision(ref, args.roster);
    if (!decision) return null;
    const row = args.store.row(decision.bindingId);
    if (row) return row;
    if (args.store.hasTombstone(decision.bindingId)) return null;
    return synthesizeDashboardBindingRecord(decision);
  };

  const normalizeBindConversation = (input: ConversationRefLike): ConversationRefLike => ({
    channel: input.channel.trim().toLowerCase(),
    accountId: normalizeAccountId(input.accountId),
    conversationId: (input.conversationId ?? "").trim(),
    ...(input.parentConversationId ? { parentConversationId: input.parentConversationId.trim() } : {}),
  });

  return {
    channel: BINDING_CHANNEL,
    accountId: BINDING_ACCOUNT_ID,
    capabilities: { placements: ["current"], bindSupported: true, unbindSupported: true },
    resolveByConversation(ref: ConversationRefLike): SessionBindingRecordLike | null {
      return resolveSync(ref);
    },
    async resolveByConversationAsync(ref: ConversationRefLike): Promise<SessionBindingRecordLike | null> {
      // Phase 2.12 F2: never answer from a half-hydrated store.
      await args.store.whenReady();
      return resolveSync(ref);
    },
    async inspectByConversationAsync(ref: ConversationRefLike): Promise<SessionBindingRecordLike | null> {
      await args.store.whenReady();
      return resolveSync(ref);
    },
    async touchAsync(bindingId: string, at?: number): Promise<void> {
      await args.store.whenReady();
      const row = args.store.row(bindingId);
      if (!row) return;
      args.store.upsertRow({
        ...row,
        metadata: { ...row.metadata, lastActivityAt: at ?? Date.now() },
      });
    },
    async bind(input): Promise<SessionBindingRecordLike | null> {
      const conversation = normalizeBindConversation(input.conversation);
      if (buildChannelAccountKey(conversation) !== WEBCHAT_ADAPTER_KEY) return null;
      const targetSessionKey = (input.targetSessionKey ?? "").trim();
      if (!targetSessionKey) return null;
      const bindingId = buildBindingId(conversation);
      const previous = args.store.row(bindingId);
      const previousMatches =
        previous &&
        previous.targetSessionKey === targetSessionKey &&
        previous.targetKind === input.targetKind;
      const nowMs = Date.now();
      const record: SessionBindingRecordLike = {
        bindingId,
        targetSessionKey,
        targetKind: input.targetKind,
        conversation,
        status: "active",
        boundAt: nowMs,
        metadata: {
          ...(previousMatches ? previous?.metadata ?? {} : {}),
          ...(input.metadata ?? {}),
          plugin: CHANNEL_ID,
          origin: "dashboard-bridge",
          lastActivityAt: nowMs,
        },
      };
      args.store.upsertRow(record);
      return record;
    },
    async unbind(input): Promise<SessionBindingRecordLike[]> {
      if (input.scope && buildChannelAccountKey(input.scope) !== WEBCHAT_ADAPTER_KEY) return [];
      const targetBindingId = (input.bindingId ?? "").trim();
      if (targetBindingId) {
        if (!targetBindingId.startsWith(BINDING_ID_PREFIX)) return [];
        const removed = args.store.removeRow(targetBindingId);
        return removed ? [removed] : [];
      }
      const targetSessionKey = (input.targetSessionKey ?? "").trim();
      if (!targetSessionKey) return [];
      const removed: SessionBindingRecordLike[] = [];
      for (const record of args.store.listBySession(targetSessionKey)) {
        const single = args.store.removeRow(record.bindingId);
        if (single) removed.push(single);
      }
      return removed;
    },
    listBySession(targetSessionKey: string): SessionBindingRecordLike[] {
      return args.store.listBySession((targetSessionKey ?? "").trim());
    },
  };
}

export async function loadSessionBindingRuntimeModule(): Promise<SessionBindingRuntimeModule | null> {
  try {
    return (await import(SESSION_BINDING_RUNTIME_SUBPATH)) as unknown as SessionBindingRuntimeModule;
  } catch {
    return null;
  }
}

export interface DashboardBridgeArgs {
  api: DashboardBridgeApiLike;
  roster?: HarnessRoster;
  sessionBindingRuntime?: SessionBindingRuntimeModule | null;
  registeredWebchatAdapterKeys?: string[];
  registeredWebchatAdapterKeysProvider?: () => string[];
  registerAdapter?: boolean | null;
}

export interface DashboardBridgeHandle {
  readonly ownsWebchatAdapter: boolean;
  readonly registeredWebchatAdapterKeys: string[];
  resolveDashboardBindingAsync(ref: {
    channel: string;
    accountId?: string | null;
    conversationId: string;
    parentConversationId?: string | null;
  }): Promise<SessionBindingRecordLike | null>;
  ensureDashboardBindingAsync(event: DashboardHookEventLike): Promise<void>;
  dispose(): void;
}

export async function createDashboardBridge(args: DashboardBridgeArgs): Promise<DashboardBridgeHandle> {
  const api = args.api;
  const logger: DashboardBridgeLogger = api.logger ?? {};
  const roster = args.roster ?? createConfigHarnessRoster(api.config);
  let hooksActive = true;

  let runtimeModule: SessionBindingRuntimeModule | null = args.sessionBindingRuntime ?? null;
  if (args.sessionBindingRuntime === undefined) {
    runtimeModule = await loadSessionBindingRuntimeModule();
  }
  const service: SessionBindingServiceLike | null = runtimeModule?.getSessionBindingService?.() ?? null;

  let openPersistedRows: KeyedStoreLike<BridgeRow> | null = null;
  let openPersistedTombstones: KeyedStoreLike<true> | null = null;
  try {
    if (api.runtime?.state?.openKeyedStore) {
      // Phase 2.12 F1: the dist contract (OpenKeyedStoreOptions,
      // agent-harness-runtime-R8dTs5zl.d.ts:27590-27597; usage evidence
      // bot-native-command-menu-hfLaQk2g.mjs:307) is {namespace, maxEntries} —
      // the previous {name: …} shape was silently dropped by the host.
      openPersistedRows = api.runtime.state.openKeyedStore<BridgeRow>({
        namespace: ROWS_STORE_NAMESPACE,
        maxEntries: ROW_STORE_MAX_ENTRIES,
      });
      openPersistedTombstones = api.runtime.state.openKeyedStore<true>({
        namespace: TOMBSTONES_STORE_NAMESPACE,
        maxEntries: ROW_STORE_MAX_ENTRIES,
      });
    }
  } catch (error) {
    openPersistedRows = null;
    openPersistedTombstones = null;
    logger.warn?.(`[${CHANNEL_ID}] persisted bridge state unavailable; memory-only rows`, error);
  }
  const store = new BridgeRowStore(openPersistedRows, openPersistedTombstones, {
    onHydrateError: (error) => {
      logger.warn?.(`[${CHANNEL_ID}] bridge store hydration failed; starting from memory-only rows`, error);
    },
  });
  // Phase 2.12 F2: hydrate persisted rows/tombstones in the background; every
  // async store consumer awaits store.ready below, so no read races the load.
  void store.hydrate();

  // Publish this bridge's resolution state to the §4.2 delegation resolvers
  // while the bridge is alive (cleared in dispose).
  const resolution: ActiveBridgeResolution = { roster, store };
  activeBridgeResolution = resolution;

  const registeredAdapterKeys =
    args.registeredWebchatAdapterKeysProvider?.() ?? args.registeredWebchatAdapterKeys ??
    runtimeModule?.testing?.getRegisteredAdapterKeys?.() ?? [];

  const shouldRegisterAdapter =
    args.registerAdapter !== false &&
    !registeredAdapterKeys.map((key) => key.toLowerCase()).includes(WEBCHAT_ADAPTER_KEY.toLowerCase());

  let ownsWebchatAdapter = false;
  if (shouldRegisterAdapter) {
    if (runtimeModule?.registerSessionBindingAdapter) {
      try {
        runtimeModule.registerSessionBindingAdapter(
          createWebchatDashboardBindingAdapter({ roster, store, logger }) as never,
        );
        ownsWebchatAdapter = true;
      } catch (error) {
        logger.error?.(`[${CHANNEL_ID}] failed to register webchat binding adapter`, error);
      }
    } else {
      logger.warn?.(
        `[${CHANNEL_ID}] session-binding runtime unavailable; running hooks-only mode`,
      );
    }
  }

  const ensureRecordForForeignOwner = async (event: DashboardHookEventLike): Promise<void> => {
    if (ownsWebchatAdapter) return;
    if (!service?.bind || !service.resolveByConversationAsync) {
      logger.debug?.(`[${CHANNEL_ID}] no session binding service; cannot ensure binding record`);
      return;
    }
    const channel = (event.channel ?? event.channelId ?? "").trim().toLowerCase();
    if (channel !== BINDING_CHANNEL) return;
    const conversationId = (event.sessionKey ?? event.conversationId ?? "").trim();
    const decision = resolveDashboardBindingDecision(
      {
        channel,
        accountId: event.accountId,
        conversationId,
        parentConversationId: event.parentConversationId,
      },
      roster,
    );
    if (!decision) return;
    try {
      const existing = await service.resolveByConversationAsync(decision.conversation);
      if (existing) {
        if (existing.targetSessionKey !== decision.targetSessionKey) {
          logger.info?.(
            `[${CHANNEL_ID}] conversation already bound to another target; keeping existing record`,
            existing.bindingId,
          );
        }
        return;
      }
      await service.bind({
        targetSessionKey: decision.targetSessionKey,
        targetKind: "session",
        conversation: decision.conversation,
        placement: "current",
        metadata: { ...(synthesizeDashboardBindingRecord(decision).metadata ?? {}) },
      });
      logger.info?.(
        `[${CHANNEL_ID}] bound dashboard conversation to ACP target`,
        decision.conversation.conversationId,
        decision.targetSessionKey,
      );
    } catch (error) {
      logger.error?.(`[${CHANNEL_ID}] failed to ensure dashboard binding record`, error);
    }
  };

  const onInboundHook = (event: DashboardHookEventLike): void | Promise<void> => {
    if (!hooksActive) return undefined;
    if (ownsWebchatAdapter) return undefined;
    return ensureRecordForForeignOwner(event);
  };

  if (api.registerHook) {
    api.registerHook(["message_received", "before_dispatch"], onInboundHook);
  } else {
    logger.warn?.(`[${CHANNEL_ID}] api.registerHook unavailable; bridge hooks not installed`);
  }

  return {
    ownsWebchatAdapter,
    registeredWebchatAdapterKeys: registeredAdapterKeys,
    async resolveDashboardBindingAsync(ref) {
      // Shares the §4.2 core (rows → tombstones → Turn-1 synthesis) so this
      // handle and the exported delegation resolvers always agree. Awaiting
      // the store keeps the F2 boot hydration from being read half-loaded.
      await store.whenReady();
      return resolveDashboardBinding(ref, { roster, store });
    },
    async ensureDashboardBindingAsync(event) {
      return await ensureRecordForForeignOwner(event);
    },
    dispose(): void {
      hooksActive = false;
      // Detach this bridge from the §4.2 delegation resolvers (only if it is
      // the one still published — a later-created instance owns the pointer).
      if (activeBridgeResolution === resolution) activeBridgeResolution = null;
    },
  };
}