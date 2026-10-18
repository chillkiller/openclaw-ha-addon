# Changelog — OpenClaw Assistant (Home Assistant App)

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For detailed engineering notes, see [openclaw_ha_addon/CHANGELOG.md](openclaw_ha_addon/CHANGELOG.md).

---

## [0.7.13.35] — 2026-10-18

### Fixed

- **Helper never creates an empty `plugins.allow` list:** the plugin registration helper called `setdefault("allow", [])` on every boot. Once created, an allow-list acts as an exclusive gate and silently blocks every other plugin — including all provider plugins activated before onboarding. Fix: absence of `plugins.allow` now means nothing is blocked; the helper never creates the key. Union-into-existing only. 3 regression tests added.
- **harness-config-writer small-model fallback:** `ANTHROPIC_SMALL_FAST_MODEL` now falls back to `model` when `smallModel` is absent (no dangling reference). Copilot `WIRE_API="responses"` documented. BRIDGE.md §15.2 claude row completed with operator hint to pick a small non-thinking model. Stale dispatcher docstring corrected.

### Changed

- **Container shutdown escalation (joint round with QEMU repair):** shutdown sequence improved: SIGTERM → 3 s poll → SIGKILL → re-check, so run.sh exits before Docker's stop budget with cleanup complete. `oc-gateway stop` and `oc-gateway doctor` now use port-owner aware SIGTERM/SIGKILL with orphan sweep.

---

## [0.7.13.34] — 2026-10-17

### Fixed

- **harness-config-writer hardening (audit-fix batch):**
  - Match key no longer contains the URL scheme (http↔https catalog providers now match — multi-model auto-match was silently dead for http-Ollama vs https-catalog entries).
  - `smallModel` is always included in the opencode `provider.models` map when it differs from `model` (no dangling `small_model` reference without a models list).
  - Per-harness fail-soft: one bad config file no longer collapses the entire deployment.
  - Bare-filename `OPENCLAW_CONFIG_PATH` resolves to `.` instead of falling through to XDG/HOME.
- **Augment/merge semantics for foreign operator configs:** codex `config.toml` — a foreign file without a writer signature gets a marker-framed provider section appended (operator content byte-preserved; operator edits after the END marker survive). Header collisions skip with a warning, never guess. opencode `opencode.jsonc` — foreign plain-JSON files are merged (operator keys preserved, only the provider block is inserted); shorthand `provider: "string"` and commented JSONC are left intact with a NOTE. Legacy `config.toml` with real operator content is no longer clobbered. New deploy action `augmented`.
- **Marker lifecycle hardened:** markers match only full lines (a marker inside an operator comment no longer truncates the file); BEGIN without END is treated as foreign content; empty refresh strips the dead marked section (converges); bare vs quoted TOML headers alias correctly; writer-owned detection is structure-based (positive) instead of key-subset — operator files like `{"model": …}` are never silently replaced.
- **Cursor harness stays unsupported:** standalone Ollama works via an undocumented package, but the `acp` subcommand does not wire the local-provider runtime in this build — re-evaluate when Cursor ships official ACP support.

### Added

- **copilot BYOK/Ollama support:** new environment variables — `COPILOT_PROVIDER_BASE_URL`, `COPILOT_PROVIDER_API_KEY`, `COPILOT_PROVIDER_WIRE_API="responses"` (only when baseUrl is set), `COPILOT_MODEL`. Verified via Ollama integration docs and the `@github/copilot` 1.0.98 binary help text.

---

## [0.7.13.33] — 2026-10-16

### Fixed

- **Reset command in bound ACP sessions:** the second reset path (resetting the dashboard conversation, not just the work session) was using a plugin-RPC call that the gateway ownership gate blocks for conversations. Replaced with a direct call to the built-in ACP driver — host-side, without plugin identity, the same primitive as a normal `/reset` on unbound conversations. Codex-audited; 254 binding tests pass.

### Known issues

- **`plugins reload` does not reload plugin module code:** the require cache is process-wide and keyed by file path; new bundle bytes are only picked up on the next gateway process start. The fix ships in the image.

---

## [0.7.13.32] — 2026-10-16

### Fixed

- **Reset command missing for derived bindings:** the dual-reset driver from 0.7.13.31 only matched explicitly stored bindings. Derived/bridged bindings (computed on-the-fly, not stored) were not found by the reverse lookup, so the second reset path was skipped. Added a bounded reverse-lookup cache (512 entries) that records every resolved binding — derived or explicit — so the reset driver finds both. Binding suite 251/251.

---

## [0.7.13.31] — 2026-10-16

### Fixed

- **mDNS self-conflict rename storm:** the bundled ciao library keyed its IPv6 address records using raw OS interface strings, but decoded inbound DNS answers using RFC-compressed form. The two never matched, so the library treated its own address as a foreign conflict and renamed itself on every echo — generating ~1 rename per second. Fixed with a build-time patch that normalizes the map keys to the decoded form. Live verification: 0 conflicts after patch.
- **Boot heal timing on large stores:** the single-shot boot sweep ran before agents were fully admitted, so stuck sessions on large stores were not healed. Replaced with a bounded retry driver (0/15/30/60/120/240 s delays) that runs detached from the hook runner.

### Added

- **Dual-reset driver:** `/reset` in an ACP-bound session now resets both the work session and the dashboard conversation. Implemented as a stateful binding target driver registered alongside the built-in ACP driver. Best-effort: if the conversation reset fails, it logs a warning but never degrades the work result. Docs: BRIDGE.md §25.
- **OpenClaw 2026.10.4** (stability patch over 2026.10.3; relevant fixes: gateway shutdown/restart no longer hangs on transcript workers, no more writer-claim errors on plugin-launched turns, gateway stays responsive during long reply streams).

---

## [0.7.13.30] — 2026-10-14

### Fixed

- **mDNS advertisement inactive:** the native OpenClaw Bonjour plugin was silently disabled because the container-detection logic in OpenClaw was not recognizing the Home Assistant environment. Fixed by exporting `OPENCLAW_DISABLE_BONJOUR` from run.sh matching the `mdns_mode` option.
- **harness-config-writer was a silent no-op:** the plugin was reading from `api.config.harnesses` (always undefined — that's the full OpenClaw config, not the plugin config) instead of `api.pluginConfig`. Fixed. Legacy key under `acp-dashboard-binding` now logs a visible warning instead of failing silently.
- **Review-fix batch (5 fixes):** catalog key only written when a catalog is actually built (no dangling file reference); secret file modes written atomically before rename (no exposure window); `maxTokens` collection removed (no consuming surface); "SKIP → picker loss (REPLACE-ALL)" documented; double-warning on invalid `models` fixed; `modelsSource:"optout"` correctly distinguished from an empty operator `models: []`.
- **Audit round 2 fixes:** target file mode is applied even when content is byte-identical (heals wrong modes on every boot); chmod failures surface in warning logs; catalog skip log now distinguishes "no models" from "no contextWindow metadata."

### Added

- **Multi-model support:** all models from the `openclaw.json` provider list are now distributed across all harness surfaces (codex profiles, opencode models map, claude `CLAUDE_MODEL_CONFIG`, environment variable comment lists). The add-on model remains the default. Generated configs are refreshable by signature.
- **codex model catalog:** `contextWindow` metadata from `openclaw.json` is written to `/config/.codex/model-catalog.json` so the codex CLI can resolve model metadata for direct users.
- **Binding pack merged:** native dispatch mode (archive stamps never written in native mode); boot heal clears `spawnedBy` over-hiding stamps on clone sessions (5 sessions were incorrectly hidden as subagents); init race bounded with a 10 s join on all async ingress boundaries.
- **Options UI restructured:** collapsible sections; `ha_integration` group moved first; `acpx_enabled` and `harness_config_writer_enabled` are now top-level standalone switches above the `harness` group. Provider keys are harness-scoped, not Ollama-scoped. `enable_terminal` retired — the web terminal is always on via Ingress; only `terminal_port` is configurable.

### Changed

- **`acpx_enabled` is the master gate:** with it off, no writer or binding deploy or config transfer happens, whatever their individual switches say. With it on, writer and binding act independently of each other.
- **Option renames:** `ollama_base_url` → `harness_base_url`, `ollama_acp_*_model` → `harness_*_model`, `acp_additional_allowed_agents` → `additional_agents`. Migration tool rebuilt.

---

## [0.7.13.29] — 2026-10-14

### Changed

- **Auto-archive disabled by default:** new option `cloneAutoArchive` (default `false`). When off, the binding plugin never writes archive stamps — archived sessions heal on next dispatch or stay archived. When on, the pre-0.7.13.29 behavior is restored. The re-archive race condition is structurally impossible in the default state.

---

## [0.7.13.28] — 2026-10-14

### Changed

- **Rollback to v0.7.13.25 code:** all code reverted to the 0.7.13.25 state. Reason: stability regressions in login, Ingress, and add-on reliability since 0.7.13.26. Slow-boot issue tracked separately.

---

## [0.7.13.25] — 2026-10-13

### Fixed

- **Clone invisibility:** idle harness clone sessions no longer appear in the user-visible session list. Archived state keeps the dispatch path clean.

### Added

- **Native dispatch mode:** new plugin option `dispatchMode: "claim" | "native"` (default `"claim"` — unchanged behavior until flipped). In `"native"` mode, binding records are emitted without ownership metadata so the host routes the webchat conversation directly into the ACP session — no clone, no mirror, no claim. Rollback is a config flip.
- **Gateway lifecycle operators:** new `oc-gateway` helper (installed to `/usr/local/bin`): `status`, `health`, `stop`, `resume`, `maintenance-status`, `restart`. Maintenance latch file `/config/.openclaw/.gateway-maintenance` survives addon restarts.
- **Terminal supervisor:** ttyd is revived within 30 s if it stops listening (port-based liveness check).
- **Terminal-first boot gate:** gateway start waits up to 30 s for the terminal to be listening before starting. Does not hard-fail on permanent timeout — nginx and Ingress remain available as escape hatches.

---

## [0.7.13.24] — 2026-10-13

### Fixed

- **Boot sweep hook now fires:** the session-settlement sweep that clears stuck sessions was registered via the wrong API and never dispatched. Moved to the typed hook runner (`api.on("gateway_start", …)`), which is the only surface that actually fires that event.

---

## [0.7.13.23] — 2026-10-13

### Fixed

- **Hook registration crash:** the gateway registry throws for every `api.registerHook` call without a name. The boot-sweep hook was nameless and crashed the gateway on every boot. All hooks are now named. Also fixed: the bridge projection was dropping the third argument when forwarding hook options, so bridge hook names never reached the host.
- **New contract test:** `src/hook-contract.test.ts` runs `registerFull` against the verbatim host contract and statically ensures every `registerHook` call passes named options.

---

## [0.7.13.22] — 2026-10-13

### Fixed

- **Claim-path conversation never settled:** the host never writes run-terminal entries for claimed turns, so the origin conversation node stayed `running` indefinitely. The plugin now writes the correct settle record after every claim return and clears the restart-recovery field set.
- **Claim replies not persisted:** the plugin delivered claim replies to the origin conversation but never wrote them to the transcript — re-renders lost every answer. The plugin now mirrors every delivered claim reply into the origin transcript via the official append API.
- **Stuck `running` clone nodes:** terminal-write races on the direct dispatch path no longer leave clone nodes stuck forever. Boot sweep at `gateway_start` clears orphaned `running` nodes of the binding key grammars.

### Added

- **Hidden harness sub-sessions:** harness clone sessions get a `spawnedBy` provenance stamp so the Control UI excludes them from subagent counts.
- **`utility_model` option:** sets `agents.defaults.utilityModel` (the model behind internal gateway utility callouts, e.g. the session observer). Fixes "session observer returned invalid JSON twice" events. Unset = no write (operator owns the value).

---

## [0.7.13.21] — 2026-10-12

### Changed

- **OpenClaw 2026.10.2** with dist verification. Startup gate unchanged.
- **Dashboard binding default changed to `true`:** the binding is now on out of the box. Explicit `false` is a real opt-out that disables the plugin entry and strips the channel block.
- **Activation manifest updated:** `openclaw.plugin.json` adds `activation:{"onStartup":true}` so the host considers the plugin for gateway startup.

---

## [0.7.13.20] — 2026-10-12

### Fixed

- **Plugin never instantiated after bundled-root deploy:** the plugin was deployed to `dist/extensions/` with a channel manifest, which made the gateway treat it as a bundled channel and enforce a contract (`kind`, `loadChannelPlugin` export) it didn't have. The host logged `missing bundled-channel-entry contract; skipping` 11 times per boot and the plugin never loaded. Fixed by switching to a contract-compliant entry shape. Boot proof: `loadedPluginCount=15`, `channels.acp-dashboard-binding.*` steps present.

---

## [0.7.13.19] — 2026-10-12

### Fixed

- **Terminal-write owner race on claimed turns:** the claimed reply turn completed but the session-entry patch threw `Terminal write owner changed before commit` — mirror/delivery writes rebind the owner between capture and commit in the same tick. Failed commits left `session_nodes` rows stuck `status:"running"` with a dangling `lifecycleRunId`. Fix: 500 ms yield after terminal `waitForRun` result before returning the claim reply (configurable via `postSettleYieldMs`).

---

## [0.7.13.18] — 2026-10-11

### Fixed

- **Plugin trust refusal on restart:** plugins deployed to `dist/extensions/` ran untrusted — the gateway grants keyed store access only to `origin: "bundled"` plugins. The binding plugin's persisted store threw `PluginTrustRefusalError` on every restart. Fixed by compiling both plugins into the gateway's own `dist/extensions` root (origin "bundled") and removing stale external copies.
- **Helper deploy switched to bundled root:** compiles with esbuild, writes to the bundled extensions directory, removes stale external copies, falls back to legacy external deploy on failure.

### Added

- **`gateway_startup_trace` option:** exports `OPENCLAW_GATEWAY_STARTUP_TRACE` for per-phase/per-plugin boot timing diagnostics.
- **`acp_smoke_check.sh`:** read-only post-restart smoke test (gateway alive, bundled payload valid, no stale external shadowing, ACP roster, stuck sessions, boot errors, harness env wiring). Zero writes.

---

## [0.7.13.17] — 2026-10-11

### Added

- **Standalone harness-config-writer:** split from the binding plugin into its own feature plugin. The two fail independently.
- **Add-on-level harness defaults:** new options — `harness_base_url` (activator, empty = nothing generated), `harness_model`, `harness_api_key`, `harness_excluded_agents`. Operator hand-entries in `openclaw.json` are never touched; stale generated entries are removed only when byte-identical to the generated value.
- **Backup rewrite:** first writer-enabled boot snapshots pre-writer state of all managed files; disabling restores originals and consumes the snapshot; re-enabling takes a fresh snapshot. Quarantined manifests block re-snapshots until resolved.

---

## [0.7.13.16] — 2026-10-11

### Added

- **Generalized harness config:** the plugin now configures all acpx harnesses (not just the three flagship ones). Three config mechanisms cover the full harness catalog: FILE (codex, opencode), ENV (claude, gemini, droid, qwen, kimi, kiro, iflow), NONE (copilot, cursor). Absent harness entry = plugin writes nothing; bundled acpx defaults run unchanged.

---

## [0.7.13.15] — 2026-10-11

### Fixed

- **`bindMainSessions` flag was ignored:** the flag controls whether `agent:<harnessId>:main` sessions bind to ACP sessions. With explicit `false`, binding was still attempted. Now enforced before the shape match.

### Added

- **Main clone binding completed:** `agent:<harnessId>:main` sessions now bind to their own clone key deterministically, with `bindMainSessions` (default `true`) declared in the manifest configSchema.

---

## [0.7.13.14] — 2026-10-11

### Added

- **Per-conversation ACP sessions:** every dashboard conversation gets its own persistent ACP session. The ACP key is a deterministic clone of the origin session key's conversation identity. New UI session → new ACP session; existing session → existing key.

---

## [0.7.13.13] — 2026-10-11

### Fixed

- **Per-workspace binding keys now get real sessions:** the provisioner was passing a legacy `harness:<agent>` conversation id to the ensure contract instead of the actual target session key. This caused ACP session rows to land on the wrong key while resolves answered the correct one — turns perished with `ACP_SESSION_INIT_FAILED`. Fixed by passing the target key to the ensure contract.

---

## [0.7.13.12] — 2026-10-11

### Added

- **Harness sessions inherit origin workspace:** dashboard-bound harness sessions now use the origin session's working directory (derived from `session_nodes.entry_json.sessionRoot` → `projects.repo_root`). Agents work inside the project folder they were opened from.
- **Per-workspace session keys:** `harness:<agent>:ws:<sha16(cwd)[0..12]>` — one persistent ACP session per agent × workspace.

---

## [0.7.13.4] — 2026-10-09

### Security

- **Removed shell injection in `gateway_remote_url`:** the remote-URL parser used `eval`'d shell code; shell metacharacters in user-controlled URLs executed as root at boot. Replaced with plain-data hand-off and character-validated hostnames.
- **Removed hardcoded gateway token:** the ACPX helper bootstrapped a missing `openclaw.json` with a known placeholder token, which the nginx proxy then injected as bearer auth pre-onboarding. The duplicate bootstrap was removed; run.sh generates a random per-install token instead.

### Fixed

- **Corrupt `openclaw.json` is quarantined, never overwritten:** parse failures previously fell back to an empty config, so a later write-back could destroy the entire configuration. Corrupt files are now renamed to `openclaw.json.corrupt` and the boot fails closed. All JSON writes are atomic.
- **Watchdog restart loop in tailnet modes:** healthcheck failed against the HTTPS-terminating gateway; probe now honors `gateway.tls.enabled`.
- **`gateway_env_vars` validation hardened:** may no longer override app-validated runtime variables. Port validation tightened (ASCII digits only).
- **Helper failures exit honestly:** the ACPX helper now propagates real failures in its exit code.

---

## [0.7.13.3] — 2026-10-09

### Fixed

- **Boot crash on unset API key:** ACP ambient-env routing read `$ANTHROPIC_API_KEY` guarded by `[ -z ... ]` which triggers an unbound-variable error under `set -u` when the key is not configured (the default case). Fixed with POSIX-safe `${ANTHROPIC_API_KEY:-}` expansion.

---

## [0.7.13.8] — 2026-10-10

### Fixed

- **Plugin always re-enabled on boot:** the ACPX helper was overwriting an operator's explicit `enabled: false` with `true` on every boot. Now respects explicit opt-out; the flag is never flipped back and plugin registration is skipped while disabled.

---

## [0.7.13.2]

- **ACP harness modernization:** removed all custom ACP wrappers — acpx passthrough wrappers with ambient env routing instead. Claude Code, Codex and OpenCode reach the local Ollama backend with zero wrapper files.

---

## [0.7.13.1]

- **Boot exit 3 on safety-net options:** option reads used `|number` which is not a jq builtin, causing compilation failure on every start. Fixed with `tonumber` and explicit null guard.
