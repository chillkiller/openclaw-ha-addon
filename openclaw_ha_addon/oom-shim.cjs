"use strict";

/**
 * OOM-Shim for OpenClaw HA-Addon v4.22
 * Prevents the Linux OOM-Killer from arbitrarily terminating the gateway process.
 * Sets oom_score_adj to 0 (neutral) so the kernel doesn't prefer this process for killing.
 */
(function applyOomShim() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { spawn } = require("node:child_process");

  const pid = process.pid;
  const oomScoreFile = path.join("/proc", pid.toString(), "oom_score_adj");

  try {
    if (fs.existsSync(oomScoreFile)) {
      fs.writeFileSync(oomScoreFile, "0", "utf8");
      console.log("[OOM-Shim] oom_score_adj set to 0 for PID", pid);
    }
  } catch (err) {
    console.log("[OOM-Shim] Could not set oom_score_adj:", err.message);
  }

  const scoreAdjValue = process.env.OOM_SCORE_ADJ;
  if (scoreAdjValue !== undefined && scoreAdjValue !== "0") {
    console.log("[OOM-Shim] OOM_SCORE_ADJ from environment:", scoreAdjValue);
  }
})();