/**
 * 20 (claim-reply transcript mirror) unit tests: claim-reply transcript mirror (see claim-reply-mirror.ts
 * for the live-DB evidence the behavior rests on). The live module is
 * dependency-injected (`appendAssistantMirror`) so vitest never touches the
 * host loader; index.ts wires the real dynamic import.
 */
import { describe, expect, it } from "vitest";

import {
  claimReplyMirrorIdempotencyKey,
  mirrorClaimReplyToOriginTranscript,
  type AssistantMirrorAppendFn,
} from "./claim-reply-mirror.js";

const ORIGIN_KEY = "agent:codex:dashboard:123e4567-e89b-12d3-a456-426614174000";

function stubAppend(
  behavior: (params: Parameters<AssistantMirrorAppendFn>[0]) => ReturnType<AssistantMirrorAppendFn>,
): { append: AssistantMirrorAppendFn; calls: Array<Parameters<AssistantMirrorAppendFn>[0]> } {
  const calls: Array<Parameters<AssistantMirrorAppendFn>[0]> = [];
  return {
    append: async (params) => {
      calls.push(params);
      return await behavior(params);
    },
    calls,
  };
}

function sessionStoreWith(sessionId: string) {
  return {
    getSessionEntry: ({ sessionKey }: { sessionKey: string }) =>
      sessionKey === ORIGIN_KEY ? { sessionId } : undefined,
  };
}

describe("the 20 design (claim-reply transcript mirror) — mirrorClaimReplyToOriginTranscript", () => {
  it("appends the reply with the claim idempotency key + delivery mirror marker", async () => {
    const { append, calls } = stubAppend(async () => ({ ok: true, messageId: "m1" }));
    const done = await mirrorClaimReplyToOriginTranscript({
      config: { agents: {} } as never,
      originSessionKey: ORIGIN_KEY,
      claimRunId: "run-1",
      replyText: "the answer",
      agentId: "codex",
      sessionStore: sessionStoreWith("sess-1") as never,
      appendAssistantMirror: append,
    });
    expect(done).toBe(true);
    const key = claimReplyMirrorIdempotencyKey("run-1");
    expect(key).toBe("acp-claim-final:run-1");
    expect(calls).toEqual([
      {
        agentId: "codex",
        config: { agents: {} },
        idempotencyKey: key,
        deliveryMirror: { kind: "channel-final", sourceMessageId: key },
        sessionId: "sess-1",
        sessionKey: ORIGIN_KEY,
        text: "the answer",
      },
    ]);
  });

  it("is a no-op without an injectable append (index wiring owns the live import)", async () => {
    const done = await mirrorClaimReplyToOriginTranscript({
      config: undefined,
      originSessionKey: ORIGIN_KEY,
      claimRunId: "run-1",
      replyText: "text",
      agentId: "codex",
      appendAssistantMirror: null,
    });
    expect(done).toBe(false);
  });

  it("skips when the origin carrys no active sessionId (mirror append guard)", async () => {
    const { append, calls } = stubAppend(async () => ({ ok: true }));
    const done = await mirrorClaimReplyToOriginTranscript({
      config: undefined,
      originSessionKey: ORIGIN_KEY,
      claimRunId: "run-1",
      replyText: "text",
      agentId: "codex",
      sessionStore: { getSessionEntry: () => ({}) } as never,
      appendAssistantMirror: append,
    });
    expect(done).toBe(false);
    expect(calls).toEqual([]);
  });

  it("does not mirror empty reply text", async () => {
    const { append, calls } = stubAppend(async () => ({ ok: true }));
    const done = await mirrorClaimReplyToOriginTranscript({
      config: undefined,
      originSessionKey: ORIGIN_KEY,
      claimRunId: "run-1",
      replyText: "   ",
      appendAssistantMirror: append,
    });
    expect(done).toBe(false);
    expect(calls).toEqual([]);
  });

  it("reports not-ok as skipped (debug), session-rebound still counts as done", async () => {
    const { append } = stubAppend(async () => ({ ok: false, reason: "blocked" }));
    const skipped = await mirrorClaimReplyToOriginTranscript({
      config: undefined,
      originSessionKey: ORIGIN_KEY,
      claimRunId: "run-1",
      replyText: "text",
      agentId: "codex",
      sessionStore: sessionStoreWith("sess-1") as never,
      appendAssistantMirror: append,
      logger: { debug: (message) => debugLog.push(message) },
    });
    expect(skipped).toBe(false);
    expect(debugLog.join("\n")).toContain("claim-reply mirror skipped");

    const rebound = stubAppend(async () => ({ ok: false, code: "session-rebound" }));
    const persisted = await mirrorClaimReplyToOriginTranscript({
      config: undefined,
      originSessionKey: ORIGIN_KEY,
      claimRunId: "run-1",
      replyText: "text",
      agentId: "codex",
      sessionStore: sessionStoreWith("sess-1") as never,
      appendAssistantMirror: rebound.append,
      logger: { debug: (message) => debugLog.push(message) },
    });
    expect(persisted).toBe(true);
  });

  it("never throws — an append failure degrades to false + warn", async () => {
    const warnLog: string[] = [];
    const done = await mirrorClaimReplyToOriginTranscript({
      config: undefined,
      originSessionKey: ORIGIN_KEY,
      claimRunId: "run-1",
      replyText: "text",
      agentId: "codex",
      sessionStore: sessionStoreWith("sess-1") as never,
      appendAssistantMirror: (async () => {
        throw new Error("host transcript writer exploded");
      }) as never,
      logger: { warn: (message) => warnLog.push(message) },
    });
    expect(done).toBe(false);
    expect(warnLog.join("\n")).toContain("host transcript writer exploded");
  });
});

const debugLog: string[] = [];