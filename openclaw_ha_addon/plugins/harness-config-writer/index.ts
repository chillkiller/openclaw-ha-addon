/**
 * harness-config-writer — eigenständiges OpenClaw-Feature-Plugin (Repo-Split A2).
 *
 * Phase 3 (generalisierte Harness-Config, GaRoN 10:37): die Harness-Konfig-
 * Generierung für Local-Provider (Ollama/vLLM/LocalAI/llama.cpp) lebt hier
 * unabhängig vom acp-dashboard-binding Channel-Plugin — GaRoNs Split-Idee
 * (Tagesnotiz / BRIDGE.md §15): "config-writer als eigenes Feature-Plugin".
 *
 * Surface: plugins.entries['harness-config-writer'].config.harnesses
 * (Legacy-Key plugins.entries['acp-dashboard-binding'].config.harnesses wird
 * vom Add-on-Deployment-Helper EINMALIG migriert — oc_acpx_helper.py).
 *
 * Trigger: Plugin-Load (register) — alle Writer sind idempotent
 * (install-if-missing bzw. bytes-sync). Ein verifizierter config-change-Hook
 * existiert nicht → Harness-Config-Änderungen gelten beim NÄCHSTEN BOOT.
 * Fail-soft: ein Deploy-Fehler darf das Plugin-Load niemals crashen.
 *
 * ENV-Gate (Audit B2, 2026-10-11): der Helper-Restore bei OFF-Option muss
 * Gateway-Boots überleben — ohne Plugin-Gate würde der onStartup-Deploy die
 * soeben restaurierten Surfaces sofort wieder beschreiben (die 4 Discovery-
 * Gates payload/entries/load.paths/allow bleiben absichtlich aktiv, damit
 * ein Re-Enable ohne Rebuild reicht). Gate-Semantik = Helper-Spiegel
 * (_env_flag + "unset folgt dem Channel-Flag"): beim Load inaktiv →
 * INFO-Log, kein Write. Manual-Deploy ohne beide ENVs (außerhalb des
 * Add-on-Boots) bleibt also inaktiv — der Writer braucht den Add-on-Boot.
 */
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  deployHarnessConfigs,
  resolveHarnessWriterPaths,
  type HarnessWriterLogger,
} from "./src/harness-config-writer.js";

const PLUGIN_ID = "harness-config-writer";

/** Helper _env_flag-Spiegel: nur exakte Truthy-Tokens zählen (case-insensitiv). */
function truthyFlag(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? "").trim());
}

/**
 * ENV-Gate (Audit B2): HARNESS_CONFIG_WRITER_ENABLED gesetzt → dieser Wert
 * gewinnt; LEER/UNSET → folgt ACP_DASHBOARD_BINDING_ENABLED (identisch zum
 * Helper deploy_plugins: "" = unset = follow). Inaktiv heißt: KEIN Write,
 * der Helper-Restore bleibt dauerhaft wirksam.
 */
export function resolveWriterGate(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const writer = (env.HARNESS_CONFIG_WRITER_ENABLED ?? "").trim();
  if (writer !== "") {
    return truthyFlag(writer);
  }
  return truthyFlag(env.ACP_DASHBOARD_BINDING_ENABLED);
}

/** Single-line error text for the message-only host logger. */
function errorBrief(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Idempotent Harness-Config-Deployment aus der eigenen Plugin-Entry-Config. */
export function registerHarnessConfigDeployment(api: OpenClawPluginApi): void {
  try {
    if (!resolveWriterGate()) {
      // Audit B2: inaktiv = kein Write — die helper-Restore-Semantik (Option
      // OFF → Originale) bleibt so Gateway-Boot-stabil. Absichtliches INFO,
      // damit "kein Write trotz harnesses config" sichtbar ist statt still.
      const writerEnv = (process.env.HARNESS_CONFIG_WRITER_ENABLED ?? "").trim();
      const gateSource =
        writerEnv !== ""
          ? `HARNESS_CONFIG_WRITER_ENABLED=${writerEnv}`
          : `unset → follows ACP_DASHBOARD_BINDING_ENABLED (off)`;
      api.logger?.info?.(
        `[${PLUGIN_ID}] inactive by env gate (${gateSource}) — no write, helper restore stays effective`,
      );
      return;
    }
    const harnesses = (api.config as { harnesses?: unknown } | undefined)?.harnesses;
    if (harnesses === null || typeof harnesses !== "object" ||
        Object.keys(harnesses as Record<string, unknown>).length === 0) {
      // Absence = no-op (kein Log-Noise im Default-Fall, ADDITIV-GARANTIE:
      // bundled acpx-Default mit Vendor-Auth läuft unverändert weiter).
      return;
    }
    const paths = resolveHarnessWriterPaths();
    if (paths === null) {
      api.logger?.warn?.(
        `[${PLUGIN_ID}] harness config deployment skipped: no OpenClaw state dir resolvable from env`,
      );
      return;
    }
    const logger: HarnessWriterLogger = {
      debug: (message) => api.logger.debug?.(message),
      info: (message) => api.logger.info(message),
      warn: (message) => api.logger.warn(message),
    };
    const report = deployHarnessConfigs(api.config, paths, logger);
    for (const result of report.results) {
      for (const warning of result.warnings) {
        api.logger?.warn?.(`[${PLUGIN_ID}] harness ${result.harnessId}: ${warning}`);
      }
    }
    api.logger?.info?.(
      `[${PLUGIN_ID}] harness config deployment: ${report.results
        .map((r) => `${r.harnessId}=${r.mechanism}`)
        .join(", ")} (harnesses config surface, BRIDGE.md §15)`,
    );
  } catch (error) {
    api.logger?.error?.(
      `[${PLUGIN_ID}] harness config deployment failed (fail-soft) — ${errorBrief(error)}`,
    );
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Harness Config Writer",
  description:
    "Deploys harness-native file/env config for configured local-provider harnesses (codex/opencode/claude/gemini/...) on plugin load — see BRIDGE.md §15.",
  register: registerHarnessConfigDeployment,
});