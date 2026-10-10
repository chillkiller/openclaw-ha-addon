# acp-dashboard-binding

OpenClaw channel plugin: binds webchat/dashboard conversations to ACP harness session
targets (codex / claude / opencode, any `agents.entries.<id>` with `runtime.type === "acp"`)
via a SessionBindingAdapter — one persistent harness session per agent, replies delivered
back into the dashboard conversation. Details + dist evidence: `BRIDGE.md`.

## Configuration (`plugins.entries['acp-dashboard-binding'].config`)

| Option | Default | Meaning |
| --- | --- | --- |
| `autoProvision` | `true` | The plugin provisions ONE persistent ACP session per harness agent itself (official `ensureConfiguredAcpBindingReady` spawn contract, plugin-sdk `acp-binding-runtime`). Explicit boolean `false` opts out → synthetic per-conversation targets (need manual initialization). |
| `harnessSessions` | unset | Manual override map `{codex: "<session-key>", …}` — wins over auto-provisioning when set + valid; no longer REQUIRED. |
| `boundAgents` / `excludedAgents` | unset | Roster gate ladder (positive list > exclusion replacement > safe-default orchestrator exclusion). |
| `harnessReplyWaitMs` | `120000` | Max wait for the harness turn in the reply claim (1 s–15 min clamp). |

## Workspace convention

Persistent harness workspaces live at **`/config/clawd/agents/<agentId>/`**
(`DEFAULT_CWD_PREFIX`). Real paths are read from `agents.entries` cfg (precedence
`runtime.acp.cwd` > `entry.cwd` > `entry.workspace` > the convention prefix).
`/share/temp/acpx-workspace/` is for pipeline-run scratch sessions only.

> Legacy note: the old `/share/temp/acpx-workspace/{codex,claude,opencode}` dirs carry
> seeded identity files + GaRoN-turn memory debris from the pre-2.21 workflow (AGENTS /
> SOUL / IDENTITY / USER, avatars, BOOTSTRAP.md, `memory/`). The new workflow never
> reads or writes them; cleanup is an operator task. See BRIDGE.md §11.3.

## Development

```sh
npm run test        # vitest (needs no host runtime; SDK imports are skipped/catched)
npx tsc -p tsconfig.scratch.json
```