#!/usr/bin/env node
// OpenClaw HA Add-on — ACPX wrapper for Claude Code (Agent Client Protocol)
// This launcher is copied to /config/.openclaw/acpx/ by run.sh on startup.
// It resolves the installed claude-agent-acp binary at runtime so updates survive.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveProviderEnv } from "./oc_provider_env.mjs";

const env = resolveProviderEnv(process.env);
const stderrLogFileNamePrefix = undefined;
const stderrLogMaxChars = 256 * 1024;

const openClawWrapperArgs = new Set([
  "--openclaw-acpx-lease-id",
  "--openclaw-gateway-instance-id",
]);

function readOpenClawWrapperArg(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeDiagnosticFilePart(value) {
  const sanitized = String(value || "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .slice(0, 120);
  return sanitized || "pid-" + process.pid;
}

function resolveStderrLogPath(args) {
  if (!stderrLogFileNamePrefix) return undefined;
  const leaseId =
    process.env["OPENCLAW_ACPX_LEASE_ID"] ||
    readOpenClawWrapperArg(args, "--openclaw-acpx-lease-id") ||
    "pid-" + process.pid;
  const fileName =
    stderrLogFileNamePrefix + "." + safeDiagnosticFilePart(leaseId) + ".log";
  return fileURLToPath(new URL("./" + fileName, import.meta.url));
}

const diagnosticRedactionRules = [
  { source: "(authorization\\s*[:=]\\s*bearer\\s+)[^\\s'\"<>]+", flags: "gi", replacement: "$1[REDACTED]" },
  { source: "((?:api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|credential)\\s*[:=]\\s*)[^\\s'\"<>]+", flags: "gi", replacement: "$1[REDACTED]" },
  { source: "(\"(?:apiKey|token|secret|password|passwd|accessToken|refreshToken)\"\\s*:\\s*\")[^\"]+", flags: "g", replacement: "$1[REDACTED]" },
  { source: "([\"']?(?:api[-_]?key|apiKey|access[-_]?token|accessToken|refresh[-_]?token|refreshToken|id[-_]?token|idToken|auth[-_]?token|authToken|client[-_]?secret|clientSecret|app[-_]?secret|appSecret|token|secret|password|passwd|credential)[\"']?\\s*[:=]\\s*[\"']?)[^\"',}\\s<>]+", flags: "gi", replacement: "$1[REDACTED]" },
  { source: "([?&](?:access[-_]?token|auth[-_]?token|refresh[-_]?token|api[-_]?key|client[-_]?secret|token|key|secret|password|pass|passwd|auth|signature)=)[^&\\s'\"<>]+", flags: "gi", replacement: "$1[REDACTED]" },
  { source: "(--(?:api[-_]?key|token|secret|password|passwd)\\s+)[^\\s'\"]+", flags: "gi", replacement: "$1[REDACTED]" },
  { source: "-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]+?-----END [A-Z ]*PRIVATE KEY-----", flags: "g", replacement: "[REDACTED_PRIVATE_KEY]" },
  { source: "\\b(sk-[A-Za-z0-9_-]{8,})\\b", flags: "g", replacement: "[REDACTED_OPENAI_KEY]" },
  { source: "\\b(gh[pousr]_[A-Za-z0-9_]{20,})\\b", flags: "g", replacement: "[REDACTED_GITHUB_TOKEN]" },
  { source: "\\b(github_pat_[A-Za-z0-9_]{20,})\\b", flags: "g", replacement: "[REDACTED_GITHUB_TOKEN]" },
  { source: "\\b(xox[baprs]-[A-Za-z0-9-]{10,})\\b", flags: "g", replacement: "[REDACTED_SLACK_TOKEN]" },
  { source: "\\b(gsk_[A-Za-z0-9_-]{10,})\\b", flags: "g", replacement: "[REDACTED_API_KEY]" },
  { source: "\\b(AIza[0-9A-Za-z\\-_]{20,})\\b", flags: "g", replacement: "[REDACTED_GOOGLE_KEY]" },
  { source: "\\b(ya29\\.[0-9A-Za-z_\\-./+=]{10,})\\b", flags: "g", replacement: "[REDACTED_GOOGLE_TOKEN]" },
  { source: "\\b(eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})\\b", flags: "g", replacement: "[REDACTED_JWT]" },
  { source: "\\b(pplx-[A-Za-z0-9_-]{10,})\\b", flags: "g", replacement: "[REDACTED_API_KEY]" },
  { source: "\\b(npm_[A-Za-z0-9]{10,})\\b", flags: "g", replacement: "[REDACTED_NPM_TOKEN]" },
  { source: "\\b(LTAI[A-Za-z0-9]{10,})\\b", flags: "g", replacement: "[REDACTED_ACCESS_KEY]" },
  { source: "\\b(hf_[A-Za-z0-9]{10,})\\b", flags: "g", replacement: "[REDACTED_API_KEY]" },
  { source: "\\bbot(\\d{6,}:[A-Za-z0-9_-]{20,})\\b", flags: "g", replacement: "bot[REDACTED_TELEGRAM_TOKEN]" },
  { source: "\\b(\\d{6,}:[A-Za-z0-9_-]{20,})\\b", flags: "g", replacement: "[REDACTED_TELEGRAM_TOKEN]" },
].map((rule) => [new RegExp(rule.source, rule.flags), rule.replacement]);

function redactDiagnosticText(text) {
  let redacted = text;
  for (const [pattern, replacement] of diagnosticRedactionRules) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

let pendingStderrLogText = "";
const stderrPrivateKeyEndPattern = /-----END [A-Z ]*PRIVATE KEY-----/;

function hasUnclosedPrivateKeyBlock(text) {
  let lastBeginIndex = -1;
  for (const match of text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)) {
    lastBeginIndex = match.index ?? lastBeginIndex;
  }
  if (lastBeginIndex === -1) return -1;
  return stderrPrivateKeyEndPattern.test(text.slice(lastBeginIndex)) ? -1 : lastBeginIndex;
}

function writeRedactedStderrLog(text) {
  if (!stderrLogPath || !text) return;
  try {
    appendFileSync(stderrLogPath, redactDiagnosticText(text), "utf8");
    const current = readFileSync(stderrLogPath, "utf8");
    if (current.length > stderrLogMaxChars) {
      writeFileSync(stderrLogPath, current.slice(-stderrLogMaxChars), "utf8");
    }
  } catch {
    // Stderr capture is diagnostic-only; never break the ACP adapter.
  }
}

function redactIncompletePrivateKeyTail(text) {
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(text);
  if (unclosedPrivateKeyStart === -1) return text;
  return text.slice(0, unclosedPrivateKeyStart) + "[REDACTED_PRIVATE_KEY]";
}

function flushFinalizedStderrLogText() {
  const lastLineBreak = pendingStderrLogText.lastIndexOf("\n");
  if (lastLineBreak === -1) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = pendingStderrLogText.slice(-stderrLogMaxChars);
    }
    return;
  }
  let flushEnd = lastLineBreak + 1;
  const unclosedPrivateKeyStart = hasUnclosedPrivateKeyBlock(
    pendingStderrLogText.slice(0, flushEnd),
  );
  if (unclosedPrivateKeyStart !== -1) flushEnd = unclosedPrivateKeyStart;
  if (flushEnd <= 0) {
    if (pendingStderrLogText.length > stderrLogMaxChars) {
      pendingStderrLogText = pendingStderrLogText.slice(-stderrLogMaxChars);
    }
    return;
  }
  const finalizedText = pendingStderrLogText.slice(0, flushEnd);
  pendingStderrLogText = pendingStderrLogText.slice(flushEnd);
  writeRedactedStderrLog(finalizedText);
}

function appendStderrLog(chunk) {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (!text) return;
  pendingStderrLogText += text;
  flushFinalizedStderrLogText();
}

function finishStderrLog() {
  const text = redactIncompletePrivateKeyTail(pendingStderrLogText);
  pendingStderrLogText = "";
  writeRedactedStderrLog(text);
}

function stripOpenClawWrapperArgs(args) {
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (openClawWrapperArgs.has(value)) {
      index += 1;
      continue;
    }
    stripped.push(value);
  }
  return stripped;
}

const rawConfiguredArgs = process.argv.slice(2);
const stderrLogPath = resolveStderrLogPath(rawConfiguredArgs);

try {
  if (stderrLogPath) writeFileSync(stderrLogPath, "", "utf8");
} catch {
  // ignore
}

const configuredArgs = stripOpenClawWrapperArgs(rawConfiguredArgs);

function resolveNpmCliPath() {
  const candidate = path.resolve(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(candidate) ? candidate : undefined;
}

function findInstalledClaudeAcpBin() {
  // Prefer the add-on managed project.
  const addonManaged = "/config/.openclaw/acpx/.node_project/node_modules";
  const managedBin = path.join(
    addonManaged,
    "@openclaw",
    "acpx",
    "node_modules",
    "@agentclientprotocol",
    "claude-agent-acp",
    "dist",
    "index.js",
  );
  if (existsSync(managedBin)) return managedBin;

  // Try the OpenClaw-managed @openclaw/acpx package.
  const openclawAcpxPaths = [
    "/config/.openclaw/npm/projects",
    "/usr/lib/node_modules/@openclaw/acpx",
  ];
  for (const base of openclawAcpxPaths) {
    if (!existsSync(base)) continue;
    if (base.includes("/npm/projects")) {
      // Find any openclaw-acpx-* project
      try {
        const entries = readdirSync(base, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const bin = path.join(
            base,
            entry.name,
            "node_modules",
            "@openclaw",
            "acpx",
            "node_modules",
            "@agentclientprotocol",
            "claude-agent-acp",
            "dist",
            "index.js",
          );
          if (existsSync(bin)) return bin;
        }
      } catch {
        // fall through
      }
    } else {
      const bin = path.join(
        base,
        "node_modules",
        "@agentclientprotocol",
        "claude-agent-acp",
        "dist",
        "index.js",
      );
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

const npmCliPath = resolveNpmCliPath();
const installedBinPath = findInstalledClaudeAcpBin();
const packageVersion = process.env.OPENCLAW_CLAUDE_ACP_VERSION || "0.55.0";
let defaultCommand;
let defaultArgs;
if (installedBinPath) {
  defaultCommand = process.execPath;
  defaultArgs = [installedBinPath];
} else if (npmCliPath) {
  defaultCommand = process.execPath;
  defaultArgs = [
    npmCliPath,
    "exec",
    "--yes",
    "--package",
    `@agentclientprotocol/claude-agent-acp@${packageVersion}`,
    "--",
    "claude-agent-acp",
  ];
} else {
  defaultCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  defaultArgs = [
    "--yes",
    "--package",
    `@agentclientprotocol/claude-agent-acp@${packageVersion}`,
    "--",
    "claude-agent-acp",
  ];
}

const command =
  configuredArgs[0] === "--openclaw-run-configured" ? configuredArgs[1] : defaultCommand;
const args =
  configuredArgs[0] === "--openclaw-run-configured"
    ? configuredArgs.slice(2)
    : [...defaultArgs, ...configuredArgs];

if (!command) {
  console.error("[openclaw] missing configured Claude ACP command");
  process.exit(1);
}

const child = spawn(command, args, {
  detached: process.platform !== "win32",
  env,
  stdio: ["inherit", "inherit", "pipe"],
  windowsHide: true,
});

child.stderr?.on("data", (chunk) => {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  appendStderrLog(chunk);
  process.stderr.write(redactDiagnosticText(text));
});

let forceKillTimer;
let orphanCleanupStarted = false;
let childExitCode = 1;

function killChildTree(signal, options = {}) {
  if (!child.pid || (!options.force && child.killed)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // fallback
    }
  }
  child.kill(signal);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => killChildTree(signal));
}

const originalParentPid = process.ppid;
const parentWatcher =
  process.platform === "win32"
    ? undefined
    : setInterval(() => {
        if (process.ppid === originalParentPid) return;
        if (orphanCleanupStarted) return;
        orphanCleanupStarted = true;
        if (parentWatcher) clearInterval(parentWatcher);
        killChildTree("SIGTERM");
        forceKillTimer = setTimeout(() => {
          killChildTree("SIGKILL", { force: true });
          childExitCode = 1;
        }, 1_500);
      }, 1_000);
parentWatcher?.unref?.();

child.on("error", (error) => {
  console.error(`[openclaw] failed to launch Claude ACP wrapper: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (parentWatcher) clearInterval(parentWatcher);
  if (orphanCleanupStarted) return;
  if (forceKillTimer) clearTimeout(forceKillTimer);
  if (code !== null) {
    childExitCode = code;
    return;
  }
  childExitCode = signal ? 1 : 0;
});

child.on("close", () => {
  finishStderrLog();
  process.exit(childExitCode);
});
