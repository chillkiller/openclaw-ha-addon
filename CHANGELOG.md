# Changelog — OpenClaw Assistant (Home Assistant App)

All notable changes to this project are documented here. Newest release first.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/2.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry summarizes user-visible changes. Full engineering notes:
[openclaw_ha_addon/CHANGELOG.md](openclaw_ha_addon/CHANGELOG.md).

## [0.7.13.43] - 2026-11-27

The app now installs the Node.js release that OpenClaw actually requires, the command line and the gateway run on the same Node.js runtime, and stopping the app shuts the gateway down cleanly instead of killing it during its drain.

### Added

- The image derives its Node.js line from the OpenClaw release it ships and installs the newest release of that line, so the app always runs a supported and patched Node.js version. The minimum patch level the runtime requires is enforced at build time and read from the runtime itself, so a new Node.js line is covered without touching the app.
- The command line, the maintenance doctor and the backup tool run on the same Node.js runtime as the gateway instead of on a separate copy from Homebrew.

### Fixed

- Stopping the app now shuts the gateway down inside the stop budget, folds the write-ahead logs of the session databases back into the databases, and lets the container exit cleanly. Previously the gateway was killed during its drain and the databases had to recover their logs on the next start.
- A harness command in the Home Assistant configuration that points at a file that no longer exists no longer keeps the Codex harness from starting. The obsolete entry is removed during startup, after a backup of the configuration has been written.
- The Qwen harness receives the Anthropic base URL without a duplicated `/v1` segment. The previous value made the client request `/v1/v1/messages`.
- Setting a Gemini base URL reports that the Gemini CLI expects a Gemini endpoint and cannot be used with an OpenAI-compatible backend.

### Changed

- OpenClaw and the ACPX integration are updated to 2026.11.10.
- The Copilot, Qwen, Gemini and Droid command line tools, the local model runtime and pnpm move to current releases.
- The retired Codex harness wrapper of the bundled configuration writer is removed.

## [0.7.13.42] - 2026-11-22

Existing installations upgrade cleanly to OpenClaw 2026.11.6 with automatic retired-configuration migration, safer gateway repair, and independent official-OAuth and community/static Home Assistant MCP paths.

### Added

- **Three clearly separated Home Assistant connection ways share one configuration group.** Way 1 stores an optional long-lived token for the HA API/Assist/scripts, way 2 configures the official MCP server with OAuth 2.0/PKCE, and way 3 configures community or custom MCP servers by their connect URLs. Each way has its own switch, one consistently labelled and secret-free startup status; every empty way is a silent no-op and no way supplies credentials to another.
- **The official Home Assistant MCP server is supported through OpenClaw OAuth.** Switch way 2 on with `ha_official_mcp_enabled` and set `ha_official_mcp_url` to `/api/mcp` or `/api/mcp/<api_id>`; an empty URL uses the default Home Assistant URL. The app writes OpenClaw's `ha-official` definition with Streamable HTTP and its own OAuth client identity on the gateway's HTTPS origin, so Home Assistant accepts the redirect. Complete the one-time consent in the Control UI under Settings → MCP; credentials stay in OpenClaw's SQLite state.
- **Community and custom MCP servers can be configured as a list of connect URLs.** Set `mcp_urls` to one or more comma-separated connect URLs; the secret is part of each URL. Every URL that answers the MCP initialize request with a valid result becomes its own native server entry named after its host, and several servers can run at the same time.

### Fixed

- **Existing heartbeat configuration no longer prevents a normal upgrade from starting.** The app snapshots `openclaw.json` and removes only the retired `agents.defaults.heartbeat` key before startup. A successful migration needs no manual doctor run, all other configuration stays intact, and subsequent starts do not create duplicate snapshots. If the snapshot or atomic write fails, startup deliberately stops before the gateway or automatic repair, with the original configuration preserved. Remove only `agents.defaults.heartbeat` and restart the app, or schedule that one-key removal for a maintenance window. Custom heartbeat workflows can be recreated as editable automations.
- **Automatic repair no longer races gateway restarts or removes an operator hold.** It atomically creates the maintenance latch only when absent, keeps the gateway down throughout offline database maintenance, and releases only the latch it created. If an operator hold already exists, automatic repair is skipped and that hold and its contents are preserved. Lease rows left by a dead repair or gateway process are removed individually; live owners are preserved.
- **Failed MCP probes cannot damage existing configuration.** A community-path URL that does not answer with a valid initialize result registers nothing and leaves every existing MCP entry untouched. OpenClaw registration is atomic and idempotent, changes only the app's own `ha-mcp-<host>` and `ha-official` values, and preserves foreign entries byte-for-byte.

### Changed

- **Home Assistant documentation now uses one way-1/way-2/way-3 vocabulary.** A prominent comparison explains each option, credential, startup action, operator step and verification command while retaining the no-silent-fallback and official-endpoint HTTP 401 guidance.
- **The automatic repair timeout now defaults to 7200 seconds per invocation and has a hard bound.** This funds integrity checks and schema migrations for a full set of large agent databases. A process that ignores SIGTERM is killed after an additional 30-second grace period, and the logged measured duration includes that grace. If the option cannot be read, startup logs a warning and uses 7200 seconds instead of aborting; `gateway_doctor_repair_timeout` remains available as an operator override.
- **MCP automation now uses OpenClaw's native `mcp.servers` registry instead of the mcporter registry.** No native route is derived implicitly and neither Home Assistant nor Supervisor tokens become MCP credentials. The explicit official URL uses interactive OAuth 2.0/PKCE; the community URL retains its secret-path model. A missing official authorization never falls back to the community server, LLMAT, or another credential.
- **Each empty MCP URL is an independent no-op.** With both URLs empty, no probe, registration, or MCP log message occurs. Secret connect URLs, bearer values, and raw OpenClaw status/probe output are not printed in startup messages; only result classes and the exact OAuth login command are shown.
- **The startup status for the MCP ways now comes from the online status instead of the offline probe.** The probe command requires exclusive offline state ownership and therefore can never succeed while the Gateway is running, so it reported a failure for healthy servers. Startup now classifies each server from the online status and reports `connected` or `authorization-required` together with the exact login command.

### Removed

- **The Home Assistant mcporter registry entry and startup repair route are removed.** The app no longer writes the home-scoped `HA` entry, checks its ownership, or installs/repairs mcporter during startup. The pinned `mcporter` binary remains in the image for OpenClaw's ad-hoc `mcporter` skill.
- **Three obsolete Codex wrapper artifacts are cleaned up automatically.** Only the old wrapper-specific home, wrapper script and adapter-path file are removed when present. The ACP-owned Codex home and all unrelated files remain untouched.

---

## [0.7.13.41] — 2026-11-22

The bundled OpenClaw runtime and ACP harness are updated to 2026.11.6, release checks now prevent stale runtime pins, and the separate native Codex plugin is retired.

### Changed

- **The bundled runtime moved from OpenClaw 2026.11.3 to 2026.11.6.** The update improves compaction continuity, credential handling and memory use.
- **The ACP harness moved from 2026.7.1 to 2026.11.6.** All other harness CLI pins are unchanged. The Codex CLI used by the ACP harness comes from the harness dependency tree and follows its version instead of a separate add-on pin.
- **The bundled tools moved to current releases.** The MCP client is now `mcporter` 0.17.1 and the package manager is `pnpm` 12.21.0; `node-llama-cpp` remains at 3.22.3.
- **Release checks now compare all 13 bundled npm pins with the registry's latest stable release.** This covers OpenClaw, ACPX, every managed harness CLI, and the image tools `node-llama-cpp`, `mcporter` and `pnpm`. OpenClaw/ACPX runtime drift blocks tagging, while harness CLI and image-tool drift is a warning unless the strict check is requested. The check runs only at release time, never during an image build or application startup.

### Fixed

- **Long conversations retain more context through compaction.** Loaded chat history stays visible, history is preserved when a summary reaches its output limit, OpenAI sessions recover from compaction item conflicts, and the summary character cap is configurable upstream.
- **Large stores and transcript repairs use less memory.** Large transcript trimming and indexing are bounded, large transcript-index repairs avoid worker out-of-memory failures, session rewinds no longer exhaust the shared database worker, and backup inspection avoids copying the live database.
- **Credentials are exposed less often.** Inline environment credentials are redacted from configuration reads, stored secret references are preserved instead of being replaced with plaintext, and plaintext catalog credentials are no longer imported alongside stored secret references.

### Removed

- **The separate native Codex plugin is no longer installed.** Unconditional upgrade maintenance removes its old managed dependency and payload whether ACPX is on or off. The Codex agent keeps running through the ACP harness. Other packages, plugin entries and allowlist identifiers are preserved.
- **The add-on-owned native Codex files now have a single writer layer, and the separate Codex wrapper is gone.** The Codex client reads the configuration the harness-config-writer writes: provider endpoint, credentials, model catalog and the Codex native compaction threshold; the model line stays the client default, while an ACP session runs the model selected in the picker. The Gateway agent entry supplies the model label of an ACP session and its fallback chain; ACPX starts the adapter and owns ACP session compaction.

---

## [0.7.13.40] — 2026-11-22

The standard Home Assistant MCP connection now uses the token entered in the app configuration and is registered only after Home Assistant successfully authenticates it.

### Fixed

- **The standard Home Assistant MCP route authenticates with the configured Home Assistant token.** A bounded initialization check runs before registration for both the configured token and the Supervisor-token fallback. Failed or unreachable authentication is logged and skipped instead of creating a broken entry. When the app's ownership marker proves that it wrote the existing `HA` entry, the failed probe also removes exactly that stale home-scoped entry and its marker; an unmarked `HA` entry and all other entries remain untouched.
- **The MCP client stays available at the pinned version.** While MCP auto-configuration is enabled, a missing or outdated `mcporter` 0.17.0 installation is repaired with the image's Node.js runtime. Installation, version and registry operations have hard timeouts, and a repair failure does not stop the app from starting.

### Changed

- **Further MCP servers and tools stay with the user.** The app registers only the standard Home Assistant route; additional servers and tools are configured in the OpenClaw Control UI.

---

## [0.7.13.39] — 2026-11-22

The agent harnesses now receive their complete native configuration from the add-on, and the add-on itself cleans up the parts that made upgrades and restarts unreliable.

### Changed

- **Every supported coding agent is configured natively, without its own setup wizard.** Codex, Claude Code, OpenCode, Pi, Kilo Code, Qwen Code, Gemini, Copilot CLI, Droid, Kimi, Kiro and iFlow receive their model, their role models (review, subagent, memory), tool and agent settings and compaction thresholds directly from the add-on; context and output limits and other model metadata are propagated whenever the gateway catalog provides them. Provider selection now follows the configured gateway provider instead of the machine address, so a route change no longer leaves stale entries behind.
- **The add-on now asks Home Assistant for the Supervisor manager role.** The agent can list installed add-ons and store entries, read their status and perform owner-approved lifecycle operations. This grants no host file system or Docker access by itself; those remain separate decisions.
- **The Node.js runtime is pinned and verified on every start.** The version that actually serves the gateway is now the one built into the image (24.22.3) and is checked against the runtime's supported range. Previously a persisted runtime copy could silently drift and block an upgrade.
- **The add-on manages the default ACP allowlist for four coding agents** (Codex, Claude Code, OpenCode, Pi). Existing allowlist entries are preserved, and an existing coordinator entry is extended without being replaced; the add-on does not create the coordinator or worker agent entries.

### Fixed

- **Interrupted upgrade archives are cleaned up automatically and kept out of backups.** A hard power cut during an upgrade could leave archive fragments behind indefinitely; they are now removed on the next start and are excluded from Home Assistant backups.
- **The outbound proxy helper is only loaded when a proxy is configured.** Previously every installation loaded an additional code path that was not needed.
- **The supervisor can no longer mistake an unrelated long-running process for the gateway.** The gateway process is matched exactly and confirmed by the listening port before it is supervised.
- **Two Home Assistant options are no longer silently ignored.** The repair timeout and the number of retained repair snapshots now reach the code that uses them, also when they are set through the sectioned options layout.
- **Images built from a working copy are reproducible.** A local dependency tree of a removed integration no longer ends up in the image, and the build context is smaller.
- **The smoke check matches the current add-on** and verifies that the removed integration is really gone instead of expecting it to be present.

### Removed

- **The dashboard binding integration was removed.** Only its harness configuration map is migrated, once, into the harness configuration writer. Its dashboard session bindings, bound and excluded agent selections, dispatch mode, workspace mappings, session provisioning, reply mirroring, and binding lifecycle are not migrated and have no replacement in this release. Existing dashboard conversations that relied on this integration lose that routing and fall back to the host's generic dispatch. The Home Assistant Assist and OpenAI-compatible API integration is unaffected.

### Upgrade notes

- This release needs an add-on image rebuild, like every release that changes the image.
- The Supervisor manager role applies after the first start with the new image.
- Existing harness configuration is migrated once; operator edits are preserved.

---

## [0.7.13.38] — 2026-11-14

The add-on now ships the current OpenClaw runtime, and the agent harnesses use the model that is actually configured instead of a built-in fallback.

### Changed

- **The bundled runtime was updated to OpenClaw 2026.11.3.** This release includes upstream security fixes: certificate verification for worker transfers with blank fingerprints, sandbox image previews kept inside their allowed folders, and reduced credential exposure. It also contains upstream fixes for a stale gateway lock that was not recovered after a process-ID reuse, for backup and update discovery runs that failed on large agent databases, and for memory pressure during transcript search index repairs.
- **The bundled tools were updated.** The local embedding runtime moved to 3.22.3, the Model Context Protocol client to 0.17.0, and the package manager is now pinned to a fixed version so that repeated image builds stay reproducible. The image build also fails immediately when the Node.js version no longer satisfies the runtime's engine requirement, instead of failing later at runtime.
- **Harness models follow the configured model order.** Every agent harness receives the model that is configured for it. A harness without its own model uses the shared model setting; if that setting is empty as well, the gateway's default model is used. A fixed fallback model was written before, even when nothing was configured, and the effective model was not visible in the harness configuration.
- **The first configured model of a harness list is used as its default.** The harness previously took a separately configured default that could differ from the model list it was given.

### Fixed

- **The bundled skills survived inside the container, but the copy mechanism behind it broke runtime updates.** Startup copied every bundled skill into the persistent configuration directory and replaced the package directory with a symlink. Such a symlink aborts the package-swap rollback scan of an OpenClaw runtime update, and a copied skill would shadow every future bundled update. Bundled skills now stay package-local, user-created skills in the persistent skills directory keep working and keep precedence, and existing copies there are left untouched.
- **A configured provider key is now inherited by the agent harnesses.** The key of the matching gateway provider is used instead of one derived from the provider address. The derived key broke whenever an address or port changed and left the old key behind as a leftover.
- **The Codex command line of the integration is no longer rewritten on every write.** That write triggered a configuration reload of the running gateway during plugin startup, which could end in a reload loop with the integration being retired while calls were still running.

---

## [0.7.13.37] — 2026-11-06

The web terminal stays up while it is healthy, the add-on reports its real health status, and a gateway that cannot start is repaired once instead of being restarted in a loop.

### Fixed

- **The web terminal is no longer restarted while it is healthy.** The watchdog that keeps the terminal alive acted on a single failed port check and terminated the terminal process, which also ended every command running in that terminal. It now waits for three consecutive failed checks, never terminates a running terminal process, and pauses after a restart before checking again.
- **Terminal port detection no longer produces false results.** The check read the process column of a socket listing, which is not available in every environment. It now reads the kernel's socket table directly.
- **The add-on shuts down within the supervisor's stop budget.** The shutdown waited for the gateway indefinitely and was then killed by the supervisor (exit code 137). It now stops the services with a bounded budget and polls the gateway process instead of waiting for it.
- **The add-on no longer reports itself as unhealthy while it is running.** The health probe asked the gateway for an endpoint that no longer exists and sent the request without a host header, so every probe failed and the add-on was marked unhealthy and restarted by the supervisor while it was serving normally. The probe now uses the gateway's health endpoint with an explicit host header.
- **The automatic repair is no longer cut off before it finishes.** The repair was given 300 seconds. On a system with several agent databases the inspection pass needs longer, so the repair was terminated mid-way on every attempt and never changed anything. The budget is now 1800 seconds and can be configured.
- **A failed automatic repair is retried as a full repair.** The non-interactive repair only performs safe migrations, so a blocked agent database lease survived it and the gateway kept failing to start. The add-on now retries once as a full repair, which is the form that releases the lease.
- **The add-on no longer fills its own storage with repair snapshots.** Every automatic repair wrote a snapshot of the complete agent database set (1–6 GB per run) and nothing ever removed them, so the configuration directory grew by tens of gigabytes while the copies pulled gigabytes through memory on every attempt. Only the two most recent snapshots are now kept.

### Changed

- **OpenClaw updated to 2026.11.1** (was 2026.10.10). The new patch release fixes Doctor reporting success when an inspection is blocked, lets an update restart a service that Doctor stopped, and reduces how often unchanged databases are re-read.
- **The number of retained repair snapshots is configurable** (`gateway_doctor_capture_keep`, 1 to 10, default 2).

## [0.7.13.36] — 2026-11-05

OpenClaw 2026.10.10 with working harness configuration for Codex, Claude Code, pi and OpenCode, plus a license notice for the bundled Codex prompt.

### Added

- **Harness configuration for Codex, Claude Code and pi:** when a harness is enabled, the add-on now writes the configuration these tools actually read — a Codex adapter wrapper with its own Codex home (including a usable model catalog with the Codex base instructions), a Claude Code `settings.json`, and a pi agent configuration. The OpenCode configuration path is resolved from the running process environment, so the generated file is read instead of ignored.
- **License notice for the bundled Codex prompt:** the bundled Codex base instructions are a modified excerpt of the OpenAI Codex CLI (Apache-2.0). The add-on ships a notices file with upstream project, upstream file, license and the applied modifications, and the prompt file carries the same notice in its header. The notice never reaches the model.

### Fixed

- **The Codex catalog carries the base prompt for every model again:** the prompt template is part of the bundled plugin now, so it is no longer lost during deployment.
- **Disabling the harness writer now removes everything it wrote:** the Codex wrapper, its Codex home (including the file that holds the API key), the Claude Code settings and the pi agent configuration are part of the managed file set and are rolled back with the rest.
- **The Codex ACP adapter no longer downloads a package at runtime:** the add-on publishes the adapter paths that exist in the container, the wrapper reads them first and prefers the newest plugin capture. It logs which adapter it starts and where it came from.

### Changed

- **OpenClaw updated to 2026.10.10** (was 2026.10.4). The control interface ships with the new layout and is served from the packaged version.

---

## [0.7.13.35] — 2026-10-18

### Fixed

- **Helper never creates an empty `plugins.allow` list:** the plugin registration helper called `setdefault("allow", [])` on every boot. Once created, an allow-list acts as an exclusive gate and silently blocked every other plugin — including all provider plugins activated before onboarding. Fix: absence of `plugins.allow` now means nothing is blocked; the helper never creates the key. Union-into-existing only. 3 regression tests added.
- **harness-config-writer small-model fallback:** `ANTHROPIC_SMALL_FAST_MODEL` now falls back to `model` when `smallModel` is absent (no dangling reference). Copilot `WIRE_API="responses"` documented. Claude harness documentation completed with an operator hint to pick a small non-thinking model. Stale dispatcher docstring corrected.

### Changed

- **Container shutdown escalation:** shutdown sequence improved: SIGTERM → 3 s poll → SIGKILL → re-check, so run.sh exits before Docker's stop budget with cleanup complete. `oc-gateway stop` and `oc-gateway doctor` now use port-owner aware SIGTERM/SIGKILL with orphan sweep.

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

- **Dual-reset driver:** `/reset` in an ACP-bound session now resets both the work session and the dashboard conversation. Implemented as a stateful binding target driver registered alongside the built-in ACP driver. Best-effort: if the conversation reset fails, it logs a warning but never degrades the work result.
- **OpenClaw 2026.10.4** (stability patch over 2026.10.3; relevant fixes: gateway shutdown/restart no longer hangs on transcript workers, no more writer-claim errors on plugin-launched turns, gateway stays responsive during long reply streams).

---

## [0.7.13.30] — 2026-10-15

### Fixed

- **mDNS advertisement inactive:** the native OpenClaw Bonjour plugin was silently disabled because the container-detection logic in OpenClaw was not recognizing the Home Assistant environment. Fixed by exporting `OPENCLAW_DISABLE_BONJOUR` from run.sh matching the `mdns_mode` option.
- **harness-config-writer was a silent no-op:** the plugin was reading from `api.config.harnesses` (always undefined — that's the full OpenClaw config, not the plugin config) instead of `api.pluginConfig`. Fixed. Legacy key under `acp-dashboard-binding` now logs a visible warning instead of failing silently.
- **Review-fix batch (5 fixes):** catalog key only written when a catalog is actually built (no dangling file reference); secret file modes written atomically before rename (no exposure window); `maxTokens` collection removed (no consuming surface); "SKIP → picker loss" documented; double-warning on invalid `models` fixed; `modelsSource:"optout"` correctly distinguished from an empty operator `models: []`.
- **Audit round 2 fixes:** target file mode is applied even when content is byte-identical (heals wrong modes on every boot); chmod failures surface in warning logs; catalog skip log now distinguishes "no models" from "no contextWindow metadata."

### Added

- **Multi-model support:** all models from the `openclaw.json` provider list are now distributed across all harness surfaces (codex profiles, opencode models map, claude `CLAUDE_MODEL_CONFIG`, environment variable comment lists). The add-on model remains the default. Generated configs are refreshable by signature.
- **codex model catalog:** `contextWindow` metadata from `openclaw.json` is written to `/config/.codex/model-catalog.json` so the codex CLI can resolve model metadata for direct users.

---

## [0.7.13.29] — 2026-10-14

### Changed

- **Auto-archive disabled by default:** new option `cloneAutoArchive` (default `false`). When off, the binding plugin never writes archive stamps — archived sessions heal on next dispatch or stay archived. When on, the pre-0.7.13.29 behavior is restored. The re-archive race condition is structurally impossible in the default state.

---

## [0.7.13.28] — 2026-10-14

### Changed

- **Rollback to v0.7.13.25 code:** all code reverted to the 0.7.13.25 state. Reason: stability regressions in login, Ingress, and add-on reliability since 0.7.13.26. Slow-boot issue tracked separately.

---

## [0.7.13.27] — 2026-10-13

### Fixed

- **Reply loss on clone archive:** the archive step now runs five minutes after a turn completes, outside the commit window, with re-checks at fire time. Replies are no longer lost to `Terminal write owner changed before commit`.
- **Real sessions incorrectly hidden:** the provenance stamp now refuses any session outside the clone key grammar. Eighteen real harness sessions that had been hidden as subagents were restored and can no longer be re-stamped.
- **Boot sweep gating and idle grace:** the archive step is disabled in native dispatch mode (prevents permanently archived binding targets after a mode flip) and waits for 15 minutes of inactivity, so recently active clones are no longer archived at boot.

### Verification

- 220 binding tests pass, strict TypeScript build clean.

---

## [0.7.13.26] — 2026-10-13

### Fixed

- **Benign wait cancellation:** a cancelled wait observation during a UI reload or reconnect is now handled as a normal client disconnect — info-level log and a "still running" notice instead of an error. The harness run itself is never cancelled by the wait; the settle and mirror paths are unchanged.

### Verification

- 215 binding tests pass (new case for the cancelled observation), strict TypeScript build clean.

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

## [0.7.13.11] — 2026-10-10

### Fixed

- **Turn-1 binding race:** the async bridge start left the config roster null on the first turn, so `harnessSessions` was ignored and chat send died with `ACP_TURN_FAILED`. Fix: both delegation calls now pass the config roster directly, race-free by construction.

---

## [0.7.13.10] — 2026-10-10

### Added

- **`harnessSessions` config option:** dashboard conversations bind to a real, explicitly spawned persistent ACP session per harness instead of synthetic binding keys that die with `ACP_SESSION_INIT_FAILED`. The manifest `configSchema` now declares `boundAgents`, `excludedAgents`, `harnessSessions`.

---

## [0.7.13.9] — 2026-10-10

### Changed

- **Binding selection priority:** replaced the hard orchestrator block with a prioritized gate — `boundAgents` (explicit allowlist) > `excludedAgents` (replacement for the default exclusion) > safe-default exclusion. No ban without an escape hatch.

---

## [0.7.13.8] — 2026-10-10

### Fixed

- **Plugin always re-enabled on boot:** the ACPX helper was overwriting an operator's explicit `enabled: false` with `true` on every boot. Now respects explicit opt-out; the flag is never flipped back and plugin registration is skipped while disabled.

---

## [0.7.13.7] — 2026-10-10

### Fixed

- **Plugin discovery path:** `deploy_plugin()` now also ensures `plugins.load.paths` contains the user-plugins root. Without this, the plugin was deployed and registered but never appeared in the gateway's boot list.

---

## [0.7.13.6] — 2026-10-10

### Fixed

- **Plugin never deployed:** the Dockerfile had no `COPY plugins` step — `deploy_plugin()` early-returned and the plugin was absent at boot. Fixed.

---

## [0.7.13.5] — 2026-10-10

### Added

- **Custom ACP harness support:** new options `ollama_acp_codex_model` / `ollama_acp_opencode_model` and `acp_additional_allowed_agents`. New bundled plugin `acp-dashboard-binding`: a webchat `SessionBindingAdapter` that routes Control UI dashboard sessions at configured ACP harness agents automatically.

---

## [0.7.13.4] — 2026-10-10

### Security

- **Removed shell injection in `gateway_remote_url`:** the remote-URL parser used `eval`'d shell code; shell metacharacters in user-controlled URLs executed as root at boot. Replaced with plain-data hand-off and character-validated hostnames.
- **Removed hardcoded gateway token:** the ACPX helper bootstrapped a missing `openclaw.json` with a known placeholder token. The duplicate bootstrap was removed; run.sh generates a random per-install token instead.
- **Corrupt `openclaw.json` is quarantined, never overwritten:** parse failures previously fell back to an empty config, so a later write-back could destroy the entire configuration. Corrupt files are now renamed to `openclaw.json.corrupt` and the boot fails closed. All JSON writes are atomic.
- **`gateway_env_vars` validation hardened:** may no longer override app-validated runtime variables. Port validation tightened.
- **Helper failures exit honestly:** the ACPX helper now propagates real failures in its exit code.

---

## [0.7.13.3] — 2026-10-09

### Fixed

- **Boot crash on unset API key:** ACP ambient-env routing read `$ANTHROPIC_API_KEY` guarded by `[ -z ... ]` which triggers an unbound-variable error under `set -u` when the key is not configured (the default case). Fixed with POSIX-safe `${ANTHROPIC_API_KEY:-}` expansion.

---

## [0.7.13.2] — 2026-10-09

### Changed

- **ACP harness modernization:** removed all custom ACP wrappers — acpx passthrough wrappers with ambient env routing instead. Claude Code, Codex and OpenCode reach the local Ollama backend with zero wrapper files.

---

## [0.7.13.1] — 2026-10-09

### Fixed

- **Boot exit-3 on safety-net options:** option reads used `|number` which is not a jq builtin, causing compilation failure on every start. Fixed with `tonumber` and explicit null guard.

---

## [0.7.13] — 2026-10-09

### Changed

- **OpenClaw 2026.9.9** (from 2026.9.8): upstream stability improvements for restart recovery, Docker upgrade-loop fix, doctor session-archive repairs, quarantined-database respect, memory-checkpoint timeout fix.

### Added

- **Pre-upgrade state backup gate:** on any detected version change, the app archives `openclaw.json` + `state/` + `agents/` to `/config/.openclaw/upgrade-backups/` before the gateway starts. Configurable via `abort_on_upgrade_backup_failure` (default true) and `upgrade_backup_keep` (default 3).
- **Automatic doctor repair:** after 2 consecutive failed starts, runs `openclaw doctor --fix --non-interactive --yes` automatically. Budget controlled via `gateway_doctor_repair_max` (default 3).
- **Exponential restart backoff:** replaces the flat 2-second restart loop with a doubling backoff (2s → 60s cap).

### Security

- **Both 0.7.12.7 security controls re-verified** against the 2026.9.9 dist. The undefined-rejection shim remains required (upstream has not shipped an equivalent).

---

## [0.7.12.7] — 2026-10-09

### Security

- **OWASP LLM01 Control #5 — invisible unicode stripping:** OpenClaw 2026.9.8's naive character-class strip broke valid ZWJ emoji and left variation selectors untouched. Fixed with a build-time patch (`unicode-guard/`) that applies context-sensitive stripping at every external-content ingest boundary.

### Fixed

- **Healthcheck kill on clean Pi boot:** HEALTHCHECK start-period extended from 120s to 420s, retries from 3 to 4. Homebrew sync and skill copy can take >4 minutes on the Pi; the old window expired before the gateway answered `/startupz`.
- **External WebUI button URL:** now uses a same-origin relative URL instead of a statically rendered LAN IP, so it works from both local and external access.

### Added

- **`sshpass` baked into the image:** previously a runtime install only, now part of the base image.

---

## [0.7.12.6] — 2026-10-09

### Fixed

- **Dangling Chromium symlinks on arm64:** Playwright installs arm64 Chromium in a different directory layout than x64. The symlink resolver is now layout-agnostic. Build self-heal added for every boot.
- **crawl4ai browser-revision drift:** both Playwright and Patchright Chromium revisions are now synced on every build.

---

## [0.7.12.4] — 2026-10-09

### Performance

- **RAM-adaptive Node.js heap:** the heap is now sized from host RAM at boot (≥24 GB → 8192 MB, ≥12 GB → 6144 MB, ≥8 GB → 4096 MB, below → 2048 MB). Fixes `sessions.list` stalling for 5+ seconds on high-RAM hosts.

### Fixed

- **Server TLS certificate generation restored:** the v0.7.10.0 refactor accidentally dropped server-cert generation. Fresh `lan_https` installs had no server certificate. Restored and hardened with X.509v3 extensions.
- **Boolean option reads:** explicit `false` options were silently reverted to defaults by jq's `//` operator. All boolean reads now use `if has(...)`.
- **502 during startup:** the landing page now intercepts 502 errors and shows a loading page with a terminal hint.

---

## [0.7.12.3] — 2026-10-09

### Changed

- **Terminology: Add-ons → Apps:** all user-facing strings updated to match Home Assistant 2026.2's official rename.

---

## [0.7.12.2] — 2026-10-09

### Performance

- **Ingress asset compression restored:** static ControlUI assets now serve brotli/gzip (measured: 468 KB → 138 KB for the largest bundle, 3.4× less transfer per cold load).

### Fixed

- **CSP synced with upstream 2026.9.6:** added `frame-src`, `img-src https:`, `connect-src data:`; replaced over-broad `script-src 'unsafe-eval'` with `'wasm-unsafe-eval'` (bundle-verified: zero eval across all ControlUI bundles).

---

## [0.7.12.1] — 2026-10-09

### Security

- **Ingress lockdown:** nginx now only accepts loopback and the HA Supervisor network. Direct LAN access to the terminal and landing page is rejected with 403.
- **nginx.conf permissions:** rendered config is written with `0600` instead of `0644`.

### Changed

- **Boot order inverted:** nginx and terminal start before the gateway. The Ingress panel is reachable during slow gateway startup.
- **TUI removed:** the `openclaw tui` iframe tab is gone — bash Terminal is the only fallback surface.

---

## [0.7.12.0] — 2026-10-09

### Changed

- **OpenClaw 2026.9.6:** restart recovery for unfinished conversations, slow-startup detection (exit 2 = starting, not failed), `openclaw doctor --session-sqlite recover`, lossless history/storage compaction, WebChat reconnect resilience.

---

## [0.7.11.15.3] — 2026-10-09

### Fixed

- **Nabu Casa reconnect failure:** WebSocket clients never follow HTTP redirects, so after idle disconnects the Control UI tried to reconnect to a redirect URL and died. Fixed by proxying `/webui` directly without redirect.

---

## [0.7.11.15.2] — 2026-10-09

### Fixed

- **Ingress ControlUI asset 404s:** HA Supervisor sends `X-Ingress-Path` without the `/webui` suffix, causing asset URLs to resolve incorrectly. Fixed with a normalization map.
- **Stale gateway URL in localStorage:** cleanup script now removes any stored URL that does not match the current ingress base path, forcing re-derivation.

---

## [0.7.11.15.1] — 2026-10-09

### Fixed

- **Ingress WebSocket through HA/Nabu Casa:** added unauthenticated nginx locations for static assets and forced loopback `Host` header so OpenClaw treats HA Ingress traffic as local.

---

## [0.7.11.11] — 2026-10-09

### Changed

- **Rollback to v0.7.11.3:** the nginx/Ingress changes from v0.7.11.4–v0.7.11.10 broke the ControlUI WebSocket through Nabu Casa. Reverted to the last working state.

---

## [0.7.11.3] — 2026-10-09

### Fixed

- **OpenAI-compatible endpoint for HA Assist pipeline:** the `/v1/chat/completions` endpoint was returning `500` because `buildAgentCommandInput` did not pass the resolved `agentId`. Patched at build time.

---

## [0.7.11.2] — 2026-10-09

### Fixed

- **Docs/Info tab showing placeholders:** version, gateway status, and ingress status were unrendered in the landing page. Fixed.

---

## [0.7.10.31]

### Fixed

- **Ingress base-path fallback for Companion App iframe:** when HA Supervisor does not pass `X-Ingress-Path`, the ControlUI now reads the base path from the browser URL instead of falling back to `127.0.0.1:18789`.

---

## [0.7.10.30]

### Fixed

- **Ingress base-path injection for OpenClaw 2026.9.4:** nginx now explicitly injects `data-openclaw-control-ui-base-path` on the `<html>` tag when missing. Fixes "Gateway not reachable" in the HA Ingress iframe.

---

## [0.7.10.29]

### Changed

- **OpenClaw 2026.9.4.**

---

## [0.7.10.28]

### Changed

- **OpenClaw 2026.9.3** and Node 24.20.0.

---

## [0.7.10.27]

### Fixed

- **Dockerfile alignment**: Actually install `openclaw@2026.9.2` (the 0.7.10.26 release only updated `config.yaml` version metadata). Bumped add-on version to 0.7.10.27 so Home Assistant rebuilds the image.

---

## [0.7.10.26]

### Changed

- **OpenClaw**: Intended update to `2026.9.2`.

### Notes

- This release did not update the Dockerfile install line, so the built image still contained OpenClaw 2026.9.1. Superseded by 0.7.10.27 and 0.7.10.28.
- Compatibility note: preserves active settings, enabled skills, and default-agent ownership across Gateway restarts triggered by HA add-on updates.

---

## [0.7.10.25]

- No changes; placeholder release.

---

## [0.7.10.17]

### Fixed

- **Ingress WebUI assets with OpenClaw 2026.8.2:** `<base href="/">` caused assets to resolve against the HA origin instead of the Ingress path. nginx now rewrites it to the Ingress base path.

---

## [0.7.10.2] — 2026-10-09

### Fixed

- **Ingress WebUI with HTTPS gateway:** nginx now proxies `/webui/` to `https://127.0.0.1:18789/` when the gateway runs in `lan_https` mode.
- **TUI startup:** `openclaw tui` now starts with `--session agent:coding-main:main` for OpenClaw 2026.8.2 multi-agent requirement.

---

## [0.7.10.1] — 2026-10-09

### Fixed

- **TUI startup:** `openclaw tui` now starts with `--session agent:coding-main:main` to satisfy OpenClaw 2026.8.2 multi-agent requirement.
- **Ingress base-path injection:** nginx `sub_filter` now injects the HA Ingress base path for both terminal enabled states.

---

## [0.7.9.28] — 2026-10-09

### Fixed

- **Homebrew installation on Node 24:** the installer path is robust against the Homebrew layout used by OpenClaw 2026.8.2.

---

## [0.7.9.27]

### Changed

- **OpenClaw**: Update to `2026.8.2`.
- **Node.js**: Update from NodeSource `node_22.x` to `node_24.x`.
- **mcporter**: Add global install `mcporter@0.12.3` for MCP server auto-configuration.
- **node-llama-cpp**: Keep at `3.20.0` as requested.

### Notes

- This release follows the upstream 2026.8.x line. The 2026.8.x OpenClaw release migrates sessions/transcripts to SQLite; a full `/config` backup is required before first start after update.

---

## [0.7.9.26]

### Changed

- **Landing page titlebar redesign**: Home Assistant Material Design 3 styling with corrected colors; the tab structure stays.
- **UX**: removed the HTTPS/secure-context warning banner inside the ingress.

### Fixed

- **Tab visibility**: tabs are shown/hidden correctly based on app configuration and iframe context.

---

## [0.7.9.24]

### Changed

- **Landing page redesign**: Home Assistant Material Design 3 style with cards, chips and tile navigation.
- **Security**: `__GATEWAY_TOKEN__` is escaped with `html.escape()` in `render_nginx.py`.
- **Features restored**: CA cert download (only `lan_https`) and disk usage display in the footer.

---

## [0.7.9.23]

### Fixed

- **Ingress Gateway Health Sensor (HA iframe path)**: Changed health fetch from absolute `/api/health` to relative `./api/health` in landing page, TUI and docs, so requests resolve correctly inside the HA Ingress iframe context.

---

## [0.7.9.22]

### Fixed

- **Ingress Gateway Health Sensor**: `/api/health` now proxies to the actual OpenClaw Gateway `/health` endpoint instead of returning a static nginx 200 OK.
- landing, TUI and docs pages parse JSON response and check `data.ok`.

---

## [0.7.9.21]

### Fixed

- **Codex ACP Wrapper auth race**: `resolveProviderEnv()` is now called before checking/writing `auth.json`, ensuring the Ollama fallback key is correctly visible to the wrapper.

---

## [0.7.9.20]

### Fixed

- **Plugin API version compatibility**: `run.sh` now exports a plain semver string for `OPENCLAW_VERSION` so the plugin API compatibility check (`>=2026.7.1`) passes and ACPX loads.

---

## [0.7.9.19]

### Fixed

- Quote ACPX_ENABLED jq selector in run.sh.

---

## [0.7.9.18]

### Fixed

- Line-ending normalization in `run.sh` so HA picks up the file correctly.

---

## [0.7.9.11] — 2026-10-09

### Added

- **ACPX harness auto-initialization** for Claude Code, Codex and OpenCode.

---

## [0.7.9.4] — 2026-10-09

### Added

- **Dedicated TUI terminal** via ttyd running `openclaw tui`.

---

## [0.7.9.3] — 2026-10-09

### Added

- **Ingress iframe auto-login**, terminal fixes and a CSP override for the embedded Control UI.

---

## [0.7.9.2] — 2026-10-09

### Changed

- **OpenClaw 2026.7.1-2** and `node-llama-cpp` 3.20.0.

---

## [0.7.9.1] — 2026-10-09

### Fixed

- **Ingress UI refactor:** tab-based Ingress UI, health-check URL and nginx stream handling corrected.

---

## [0.7.7.7] — 2026-10-09

### Fixed

- **D-Bus and Avahi startup:** system paths are pinned, stale PIDs are cleaned and the daemon starts in the background.

---

## [0.7.7.6] — 2026-10-09

### Changed

- **OpenClaw 2026.6.11** and `node-llama-cpp` 3.19.0.

### Fixed

- **D-Bus/Avahi after Homebrew installs:** system paths pinned and stale PIDs cleaned.

---

## [0.7.7.1] — 2026-10-09

### Fixed

- **Audit findings:** ten required changes applied; the builder stage was removed and `build-essential` purged from the runtime image.

---

## [0.7.7.0] — 2026-10-08

### Changed

- **OpenClaw 2026.6.8**, CUPS/Scanner support, `crawl4ai` integration, Go 1.24.1 toolchain and the D-Bus/Avahi stack.

### Fixed

- **Browser and memory bootstrap**, Node.js heap limit (4096 MB) and the base image moved from Debian Trixie to Bookworm.

---

## [0.7.5.3] — 2026-10-08

### Fixed

- **D-Bus production configuration** and the Avahi service patch for reliable mDNS discovery.

---

## [0.7.5.2] — 2026-10-08

### Added

- **Exclusive mDNS mode selection** (`off`, `minimal`, `full`, `avahi`) and the `trace_log_to_console` / `gateway_log_level` options.

### Fixed

- **D-Bus startup on Debian Trixie**, missing `dbus` package for Avahi, the mDNS host name default and the missing `avahi` entry in all six translations. Obsolete `build.yaml` removed.

---

## [0.7.5.1] — 2026-10-08

### Added

- **First production release:** professional project structure, complete documentation and the Home Assistant app metadata.

---
