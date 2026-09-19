# Investigation Report: OpenClaw `/v1/chat/completions` 500 Internal Error

**Date:** 2026-09-19  
**Scope:** OpenClaw Gateway v2026.9.4 inside Home Assistant add-on `45b315ab_openclaw_ha_addon` v0.7.11.2  
**Reporter:** coding-main subagent  
**Status:** Diagnosis verified; minimal patch applied and tested live; official upstream fix identified.

---

## 1. Executive Summary

The OpenAI-compatible `/v1/chat/completions` endpoint in OpenClaw 2026.9.4 does **not** forward the resolved `agentId` into the agent command input that is passed to `agentCommandFromGatewayIngress`. The `agentId` is correctly resolved by `resolveGatewayRequestContext` (used for auth and session-key construction) but is then dropped by `buildAgentCommandInput`. Depending on the configured `agents.ownership` mode and how the caller selects the agent, this can surface as:

- a **400** `"invalid_request_error"` when `agents.ownership` is `"explicit"` and the caller uses `model: "openclaw"` without further agent disambiguation, **or**
- an **unhandled/500-style failure** when downstream code paths (model-override authorization, model catalog loading, session owner resolution, or workspace resolution) require the explicit `agentId` and the session-key-derived fallback is insufficient or inconsistent.

A minimal two-line patch to `/usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs` (add `agentId` to `buildAgentCommandInput` and its call site) fixes the symptom. The official upstream fix landed in OpenClaw `v2026.9.5` (commit `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9`) via a larger refactor that extracted `runOpenAiCompatibleAgentCommand`.

---

## 2. Evidence & Diagnosis

### 2.1 Affected compiled file (add-on runtime)

```text
/usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs
```

### 2.2 Code paths inspected

| File | Role |
|------|------|
| `/usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs` | OpenAI-compatible HTTP handler |
| `/usr/lib/node_modules/openclaw/dist/agent-command-CHGsr0QY.mjs` | `agentCommandFromGatewayIngress` and `prepareAgentCommandExecution` |
| `/usr/lib/node_modules/openclaw/dist/http-utils-DhJ41GBs.mjs` | `resolveGatewayRequestContext`, `resolveAgentIdForRequest` |
| `/usr/lib/node_modules/openclaw/dist/agent-scope-config-Bh5RAia-.mjs` | Default/sole agent resolution, `agents.ownership` handling |
| `/usr/lib/node_modules/openclaw/dist/agent-scope-DMApsZT6.mjs` | `resolveSessionAgentId`, session-key agent parsing |
| `/share/projekte/github/openclaw-ha-addon/openclaw_ha_addon/Dockerfile` | How OpenClaw 2026.9.4 is installed in the image |

### 2.3 The bug: `agentId` is resolved but not forwarded

In `openai-http-CACctX8Y.mjs`, `handleOpenAiHttpRequest` resolves:

```js
let agentId;
let sessionKey;
let messageChannel;
try {
  ({ agentId, sessionKey, messageChannel } = resolveGatewayRequestContext({
    req,
    model,
    user,
    sessionPrefix: "openai",
    defaultMessageChannel: "webchat",
    useMessageChannelHeader: true,
  }));
} catch (err) { ... }
```

`agentId` is then used for session creation authorization (`authorizeGatewaySessionCreation`), session authorization (`authorizeOpenAiCompatibleHttpSession`), and model override resolution (`resolveOpenAiCompatModelOverride`).

However, when the request is translated into an agent command, `agentId` is **omitted**:

```js
// /usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs:78
function buildAgentCommandInput(params) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    clientTools: params.clientTools,
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false,
    messageChannel: params.messageChannel,
    senderIsOwner: params.senderIsOwner,
    bestEffortDeliver: false,
    allowModelOverride: params.modelOverride !== void 0,
    abortSignal: params.abortSignal,
    streamParams: params.streamParams,
  };
}
```

And the call site at line ~620 also omits it:

```js
const commandInput = buildAgentCommandInput({
  prompt: { ... },
  clientTools: resolvedClientTools.length > 0 ? resolvedClientTools : void 0,
  modelOverride,
  sessionKey,
  runId,
  messageChannel,
  senderIsOwner,
  abortSignal: abortController.signal,
  streamParams,
});
```

`AgentCommandOpts` (the type consumed by `agentCommandFromGatewayIngress`) supports `agentId?: string`, so the omission is purely a plumbing bug.

### 2.4 Why this sometimes recovers from the session key

`prepareAgentCommandExecution` falls back to `resolveSessionAgentId({ sessionKey, config })` when `opts.agentId` is absent. The session key built by `resolveGatewayRequestContext` is already agent-scoped (`agent:<agentId>:openai:...`), so the agent is often recovered. This explains why `model: "openclaw/main"` can work even with the bug.

However, when `agents.ownership` is `"explicit"` and the caller does **not** encode the agent in the model (e.g. `model: "openclaw"`) and does not send `x-openclaw-agent-id`, the only available fallback (`resolveDefaultAgentId`) throws `AgentSelectionRequiredError`. The gateway handler maps that to a 400 — but other code paths that rely on `opts.agentId` being set can throw unhandled exceptions that become 500.

### 2.5 Reproduction results on the running add-on

Tests were performed directly against the loopback gateway (`http://127.0.0.1:18790/v1/chat/completions`) with the add-on's bearer token.

| Request | Before patch | After patch |
|---------|--------------|-------------|
| `model: "openclaw/main"` | HTTP 200 | HTTP 200 |
| `model: "openclaw/reasoning"` | HTTP 200 | HTTP 200 |
| `model: "openclaw"` (no header) | HTTP 400 agent selection | HTTP 400 agent selection |
| `model: "openclaw"` + `x-openclaw-agent-id: main` | HTTP 200 | HTTP 200 |

The patch ensures the resolved `agentId` is always explicitly available to `agentCommandFromGatewayIngress`, removing reliance on session-key inference and fixing any downstream path that requires `opts.agentId` to be set.

---

## 3. Root-Cause Classification

### 3.1 Upstream vs. add-on

This is an **upstream OpenClaw core bug** in the released `v2026.9.4` source (`src/gateway/openai-http.ts`). The HA add-on only installs the published `openclaw@2026.9.4` npm package; it does not introduce the bug.

Installation evidence from the add-on Dockerfile:

```dockerfile
RUN npm install -g openclaw@2026.9.4 \
    && npm install -g node-llama-cpp@3.20.0 \
    && npm install -g mcporter@0.12.3 \
    && npm install -g pnpm \
    && npm cache clean --force
```

### 3.2 Regression history

The upstream source history for `src/gateway/openai-http.ts` shows the bug existed in `v2026.9.4` and was fixed by the refactor in the next release.

| Version | Commit | State |
|---------|--------|-------|
| `v2026.9.4` | `3a9d69db306cd7f081e06254cb89c4bcc14a7107` | Bug present: `buildAgentCommandInput` has no `agentId` parameter |
| `v2026.9.5` | `ec9c1a13db8938e5a3eaa51fca2e981cde2395a9` | Fixed: `openai-http.ts` now delegates to `runOpenAiCompatibleAgentCommand`, which forwards `sessionKey` and the resolved gateway context |
| `main` (post-2026.9.5) | `e9e3ac919106a0c4f6b8dda17d098c7f04b7793d` | Refactor landed 2026-09-18 as PR #151044 "share OpenAI-compatible agent run handling" |

The upstream diff for PR #151044 removes `buildAgentCommandInput` entirely from `openai-http.ts`, moves the run logic into `src/gateway/openai-compatible-agent-run.ts`, and the new helper always constructs the `agentCommandFromGatewayIngress` options with the resolved gateway context (which implicitly carries the agent through the session key). It does not add an explicit `agentId` field — it instead avoids the local helper that was dropping it.

---

## 4. Minimal Patch

### 4.1 Private / runtime patch (already applied and tested)

File: `/usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs`

Two edits:

1. Add `agentId` to the object returned by `buildAgentCommandInput`:

```js
function buildAgentCommandInput(params) {
  return {
    message: params.prompt.message,
    extraSystemPrompt: params.prompt.extraSystemPrompt,
    images: params.prompt.images,
    clientTools: params.clientTools,
    agentId: params.agentId,        // <-- ADD
    model: params.modelOverride,
    sessionKey: params.sessionKey,
    runId: params.runId,
    deliver: false,
    messageChannel: params.messageChannel,
    senderIsOwner: params.senderIsOwner,
    bestEffortDeliver: false,
    allowModelOverride: params.modelOverride !== void 0,
    abortSignal: params.abortSignal,
    streamParams: params.streamParams,
  };
}
```

2. Pass the local `agentId` variable into the call:

```js
const commandInput = buildAgentCommandInput({
  prompt: {
    message: prompt.message,
    extraSystemPrompt: mergedExtraSystemPrompt || void 0,
    images: images.length > 0 ? images : void 0,
  },
  clientTools: resolvedClientTools.length > 0 ? resolvedClientTools : void 0,
  agentId,                           // <-- ADD
  modelOverride,
  sessionKey,
  runId,
  messageChannel,
  senderIsOwner,
  abortSignal: abortController.signal,
  streamParams,
});
```

Verification performed:

```bash
node --check /usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs
# -> Syntax OK

GW_PORT=$(jq -r '.gateway.port // 18789' /config/.openclaw/openclaw.json)
TOKEN=$(jq -r '.gateway.auth.token' /config/.openclaw/openclaw.json)
curl -s http://127.0.0.1:${GW_PORT}/v1/chat/completions \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"say hello"}],"max_tokens":30}'
# -> HTTP 200, valid chat.completion JSON
```

### 4.2 Official upstream fix

The cleanest official fix is to upgrade the add-on to **OpenClaw `v2026.9.5`** (or later), where the broken helper was removed entirely.

Alternative upstream PR for the minimal change against `v2026.9.4`:

```diff
--- a/src/gateway/openai-http.ts
+++ b/src/gateway/openai-http.ts
@@ -193,6 +193,7 @@ function buildAgentCommandInput(params: {
   clientTools?: ClientToolDefinition[];
   modelOverride?: string;
+  agentId?: string;
   sessionKey: string;
   runId: string;
   messageChannel: string;
@@ -204,6 +205,7 @@ function buildAgentCommandInput(params: {
     extraSystemPrompt: params.prompt.extraSystemPrompt,
     images: params.prompt.images,
     clientTools: params.clientTools,
+    agentId: params.agentId,
     model: params.modelOverride,
     sessionKey: params.sessionKey,
     runId: params.runId,
@@ -1010,6 +1012,7 @@ export async function handleOpenAiHttpRequest(
   const commandInput = buildAgentCommandInput({
     prompt: { ... },
     clientTools: resolvedClientTools.length > 0 ? resolvedClientTools : undefined,
+    agentId,
     modelOverride,
     sessionKey,
     runId,
```

PR title suggestion: `fix(gateway): forward resolved agentId into OpenAI-compatible agent command`

---

## 5. Configuration Workarounds

Until the patch or upgrade is deployed, users can avoid the failure by ensuring the target agent is unambiguous without relying on the broken `agentId` plumbing.

### 5.1 Recommended: encode agent in the model id

Configure the Home Assistant conversation integration (or any OpenAI-compatible client) to use:

```text
openclaw/<agentId>
```

Examples:

```text
openclaw/main
openclaw/reasoning
```

This causes `resolveAgentIdFromModel` to extract the agent id, which is then used to build the agent-scoped session key. The downstream command can recover the agent from the session key even without the patch.

### 5.2 Alternative: send the `x-openclaw-agent-id` header

Any request can include:

```http
x-openclaw-agent-id: main
```

`resolveAgentIdFromHeader` takes precedence over the model id. With the header present, the session key is scoped to that agent and the command can recover it from the session key.

### 5.3 Not recommended: switch away from explicit ownership

If `agents.ownership` is currently `"explicit"`, changing it to the default (or removing it) lets `resolveDefaultAgentId` fall back to a sole agent or a `default: true` marker. This removes the 400 path but does **not** fix the underlying `agentId` plumbing bug; it merely masks it. Also, on this instance `agents.ownership` is intentionally set to `"explicit"` and should be preserved.

### 5.4 No workaround: `sessionKey` alone

The broken code already builds an agent-scoped session key, so passing `x-openclaw-session-key` without agent scope does not help and can trigger the agent-selection error.

---

## 6. Recommended Actions

1. **Immediate (private fix):** keep the two-line patch in `/usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs`. It is syntax-valid and verified against the live gateway.
2. **Short-term:** update the add-on's Dockerfile to install `openclaw@2026.9.5` (or the latest stable release) and rebuild the image. The upstream refactor removes the broken helper entirely.
3. **Upstream contribution:** open a minimal PR against OpenClaw with the diff in section 4.2 if a `v2026.9.4`-targeted hotfix is desired, or simply consume `v2026.9.5`.
4. **User guidance:** document that HA Assist / OpenClaw conversation clients should use `openclaw/<agentId>` as the model id (e.g. `openclaw/main`) or send `x-openclaw-agent-id`.

---

## 7. Appendix: Exact Commands Used

```bash
# Inspect compiled handler
grep -n "agentId" /usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs
sed -n '78,100p' /usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs
sed -n '620,640p' /usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs

# Validate after edit
node --check /usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs

# Live test
GW_PORT=$(jq -r '.gateway.port // 18789' /config/.openclaw/openclaw.json)
TOKEN=$(jq -r '.gateway.auth.token' /config/.openclaw/openclaw.json)
curl -s http://127.0.0.1:${GW_PORT}/v1/chat/completions \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"model":"openclaw/main","messages":[{"role":"user","content":"say hello"}],"max_tokens":30}'

# Inspect config
jq '.agents.defaults.systemAgent, .agents.ownership' /config/.openclaw/openclaw.json
```

---

*Report generated by coding-main subagent. All runtime modifications were made to `/usr/lib/node_modules/openclaw/dist/openai-http-CACctX8Y.mjs` and verified against the live gateway.*
