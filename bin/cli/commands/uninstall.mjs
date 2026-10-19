/**
 * `omniroute uninstall [--full]` — user-facing uninstall entry point.
 *
 * Thin, testable wrapper over the package-root script
 * `scripts/build/uninstall.mjs`, which:
 *   1. stops background PM2 processes,
 *   2. (only with `--full`) erases the DATA_DIR database and encrypted files,
 *   3. runs `npm uninstall -g omniroute`,
 *   4. keeps (or wipes) the data dir accordingly.
 *
 * The script ships in the published tarball (package.json "files"), so this
 * command works for both `omniroute-from-registry` and prebuilt-tarball
 * installs. Stopping the local server first mirrors `omniroute stop` so the
 * data directory is not in use while the (optionally destructive) wipe runs.
 *
 * Note: the npm `uninstall` lifecycle hook runs this same script automatically
 * on `npm uninstall -g omniroute` — one source of truth, two entry points.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "../i18n.mjs";
import { runStopCommand } from "./stop.mjs";

// This file lives at <pkgRoot>/bin/cli/commands/uninstall.mjs — resolve package
// paths relative to the script, NOT process.cwd(): on a global npm install the
// user's cwd is not the package root, so cwd-relative lookups break (#3295).
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
export const UNINSTALL_SCRIPT = path.join(PKG_ROOT, "scripts", "build", "uninstall.mjs");

export function registerUninstall(program) {
  program
    .command("uninstall")
    .description(t("uninstall.description"))
    .option("--full", t("uninstall.fullFlag"), false)
    .action(async (opts) => {
      const exitCode = await runUninstallCommand(opts);
      if (exitCode !== 0) process.exit(exitCode);
    });
}

function defaultRunChild(cmd, args) {
  // Module state may already be loaded from the package dir when npm deletes
  // it; spawnSync (blocking) completes before we return, like the hook script's
  // execSync, so a mid-run package removal cannot tear the flow apart.
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  return res.status === null || res.status === undefined ? 1 : res.status;
}

/**
 * @param {object} [opts] CLI options (`full`).
 * @param {object} [deps] Injectable for tests: `stop`, `runChild`, `exists`
 *   override the default server-stop, child spawn and script-existence checks.
 * @returns {Promise<number>} process exit code (0 success; propagates the child
 *   script's status; 1 when the uninstall script is missing or spawn failed).
 */
export async function runUninstallCommand(opts = {}, deps = {}) {
  const stop = deps.stop || runStopCommand;
  const runChild = deps.runChild || defaultRunChild;
  const exists = deps.exists || existsSync;

  // Best-effort: a failure to stop the server should not abort the uninstall
  // (the script still removes PM2 processes), but it should be visible.
  const stopExit = await stop({});
  if (stopExit !== 0) {
    console.error(t("uninstall.stopFailed", { code: stopExit }));
  }

  if (!exists(UNINSTALL_SCRIPT)) {
    console.error(
      t("common.error", {
        message: `uninstall script not found: ${UNINSTALL_SCRIPT}`,
      })
    );
    return 1;
  }

  const args = opts.full ? ["--full"] : [];
  try {
    return runChild(process.execPath, [UNINSTALL_SCRIPT, ...args]);
  } catch (err) {
    console.error(
      t("common.error", {
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return 1;
  }
}
