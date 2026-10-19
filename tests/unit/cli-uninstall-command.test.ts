import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";

/**
 * `omniroute uninstall [--full]` — CLI wrapper over scripts/build/uninstall.mjs.
 * Guards: registration + --full flag, delegation (args + exit-code propagation),
 * stop-failure tolerance, missing-script failure, script presence in the repo
 * (the tarball ships it via package.json "files").
 */

test("uninstall registers with --full and an interpolated i18n description", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-uninstall-"));
  const prev = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  try {
    const { registerUninstall } = await import("../../bin/cli/commands/uninstall.mjs");
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerUninstall(program);
    const cmd = program.commands.find((c) => c.name() === "uninstall");
    assert.ok(cmd, "uninstall command registered");
    assert.ok(
      !cmd.description().includes("{"),
      `unresolved i18n placeholder: ${cmd.description()}`
    );
    const flags = cmd.options.map((o) => o.long);
    assert.ok(
      flags.includes("--full"),
      `uninstall must expose --full; got ${JSON.stringify(flags)}`
    );
    assert.equal(cmd.getOptionValue("full"), false, "--full defaults to false");
  } finally {
    if (prev === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = prev;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("runUninstallCommand delegates to the package uninstall script (no --full)", async () => {
  const { runUninstallCommand, UNINSTALL_SCRIPT } =
    await import("../../bin/cli/commands/uninstall.mjs");
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const code = await runUninstallCommand(
    {},
    {
      stop: async () => 0,
      runChild: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return 0;
      },
      exists: () => true,
    }
  );
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.ok(
    UNINSTALL_SCRIPT.endsWith(path.join("scripts", "build", "uninstall.mjs")),
    `script path resolves under package root: ${UNINSTALL_SCRIPT}`
  );
  assert.ok(calls[0].args[0].endsWith("uninstall.mjs"));
  assert.ok(
    !calls[0].args.includes("--full"),
    `--full must not be passed by default; got ${JSON.stringify(calls[0].args)}`
  );
});

test("runUninstallCommand forwards --full as a script argument", async () => {
  const { runUninstallCommand } = await import("../../bin/cli/commands/uninstall.mjs");
  const calls: string[][] = [];
  await runUninstallCommand(
    { full: true },
    {
      stop: async () => 0,
      runChild: (_cmd: string, args: string[]) => {
        calls.push(args);
        return 0;
      },
      exists: () => true,
    }
  );
  assert.deepEqual(calls[0].slice(1), ["--full"]);
});

test("runUninstallCommand propagates the child script's non-zero exit code", async () => {
  const { runUninstallCommand } = await import("../../bin/cli/commands/uninstall.mjs");
  const code = await runUninstallCommand(
    {},
    { stop: async () => 0, runChild: () => 5, exists: () => true }
  );
  assert.equal(code, 5);
});

test("a failed server stop does not abort the uninstall (best-effort)", async () => {
  const { runUninstallCommand } = await import("../../bin/cli/commands/uninstall.mjs");
  let childRan = false;
  const logs: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const code = await runUninstallCommand(
      {},
      {
        stop: async () => 3,
        runChild: () => ((childRan = true), 0),
        exists: () => true,
      }
    );
    assert.equal(code, 0, "child success still wins");
    assert.ok(childRan, "the uninstall script must still run after a stop failure");
    assert.equal(logs.length, 1, "the stop failure is reported exactly once");
  } finally {
    console.error = origError;
  }
});

test("missing uninstall script fails loudly with exit code 1 and no spawn", async () => {
  const { runUninstallCommand } = await import("../../bin/cli/commands/uninstall.mjs");
  let childRan = false;
  const logs: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const code = await runUninstallCommand(
      {},
      {
        stop: async () => 0,
        runChild: () => {
          childRan = true;
          return 1;
        },
        exists: () => false,
      }
    );
    assert.equal(code, 1);
    assert.ok(!childRan, "nothing is spawned when the script is missing");
    assert.ok(logs.some((l) => l.includes("uninstall script not found")));
  } finally {
    console.error = origError;
  }
});

test("the wrapped uninstall script exists in the repo (tarball ships it via files)", async () => {
  const { UNINSTALL_SCRIPT } = await import("../../bin/cli/commands/uninstall.mjs");
  assert.ok(fs.existsSync(UNINSTALL_SCRIPT), `expected at ${UNINSTALL_SCRIPT}`);
});
