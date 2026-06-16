#!/usr/bin/env bun

import { stat } from "node:fs/promises";
import { ACK_FLAG, evaluateCli } from "./cli";
import { setWorkflowFilePath } from "./workflow";
import { startSymphonyRuntime } from "./runtime";
import { ok } from "./result";

let runtime: Awaited<ReturnType<typeof startSymphonyRuntime>> | null = null;

const result = await evaluateCli(Bun.argv.slice(2), {
  fileRegular: async (path) => {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  },
  setWorkflowFilePath,
  setLogsRoot: () => {
    // Log redirection is intentionally left to the shell for this Bun entrypoint.
  },
  setServerPortOverride: () => {
    // Use `server.port` in WORKFLOW.md for the runtime dashboard.
  },
  ensureAllStarted: async () => {
    const started = await startSymphonyRuntime({
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    if (!started.ok) return started;
    runtime = started;
    console.log("Symphony GitHub runtime started. Press Ctrl-C to stop.");
    return ok(["runtime"]);
  },
});

if (!result.ok) {
  console.error(result.error);
  if (!result.error.includes(ACK_FLAG)) process.exitCode = 1;
} else {
  setInterval(() => {
    // Keep the Bun process alive while timers, app-server runs, and the dashboard operate.
  }, 2_147_483_647);
}
