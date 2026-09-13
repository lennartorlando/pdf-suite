#!/usr/bin/env node
import { runCompressCommand, usage as compressUsage } from "./commands/compress.js";
import { runInspectCommand, inspectUsage } from "./commands/inspect.js";
import { runAssembleCommand, assembleUsage } from "./commands/assemble.js";
import { runOcrCommand, ocrUsage } from "./commands/ocr.js";
import { runCapabilitiesCommand, capabilitiesUsage } from "./commands/capabilities.js";
import { runFormsCommand, formsUsage } from "./commands/forms.js";
import { fileURLToPath } from "node:url";
import type { NativeRunner } from "@pdf-compressor/core";
import { exitCodes, type CliResult, usageErrorResult } from "./output.js";

export interface MainDeps {
  run?: NativeRunner;
}

export function usage(): string {
  return [compressUsage(), inspectUsage(), assembleUsage(), ocrUsage(), capabilitiesUsage(), formsUsage()].join("");
}

function writeResult(result: CliResult): number {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode;
}

export async function main(
  argv = process.argv.slice(2),
  deps: MainDeps = {}
): Promise<number> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);

  const [command, ...args] = argv;
  try {
    if (command === "compress") {
      return writeResult(await runCompressCommand(args, { signal: controller.signal }));
    }
    if (command === "inspect") {
      return writeResult(await runInspectCommand(args, { run: deps.run, signal: controller.signal }));
    }
    if (command === "assemble") {
      return writeResult(await runAssembleCommand(args, { run: deps.run, signal: controller.signal }));
    }
    if (command === "ocr") {
      return writeResult(await runOcrCommand(args, { run: deps.run, signal: controller.signal }));
    }
    if (command === "capabilities") {
      return writeResult(await runCapabilitiesCommand(args, { run: deps.run, signal: controller.signal }));
    }
    if (command === "forms") {
      return writeResult(await runFormsCommand(args, { run: deps.run, signal: controller.signal }));
    }

    if (argv.includes("--json")) {
      return writeResult(
        usageErrorResult(new Error(command ? `Unknown command: ${command}` : "Missing command."))
      );
    }

    process.stderr.write(usage());
    return exitCodes.usage;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => {
    process.exitCode = code;
  });
}
