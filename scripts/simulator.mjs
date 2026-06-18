#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  summarizeScenarioPack
} from "../src/contracts/scenario-contract.mjs";
import {
  generateScenarioPack,
  listScenarioIds,
  stringifyScenarioPack
} from "../src/scenarios/scenario-generator.mjs";

const DEFAULT_SCENARIO_ID = "baseline-week";

export async function runSimulatorCli(argv, io = defaultIo()) {
  const [command, ...commandArgs] = argv;

  if (!command || command === "--help" || command === "-h") {
    printUsage(io.stdout);
    return 0;
  }

  if (command === "--list") {
    io.stdout.write(`${listScenarioIds().join("\n")}\n`);
    return 0;
  }

  if (command === "generate") {
    return runGenerate(commandArgs, io);
  }

  if (command === "feed") {
    return runFeed(commandArgs, io);
  }

  throw new CliError(`Unknown command: ${command}`);
}

async function runGenerate(argv, io) {
  const args = parseOptions(argv, {
    booleanOptions: new Set(["help", "list"]),
    stringOptions: new Set(["scenario", "seed", "out"])
  });

  if (args.options.help) {
    printGenerateUsage(io.stdout);
    return 0;
  }

  if (args.options.list) {
    io.stdout.write(`${listScenarioIds().join("\n")}\n`);
    return 0;
  }

  const scenarioId = getScenarioId(args);
  const scenarioPack = generateScenarioPack(scenarioId, { seed: args.options.seed });

  if (!args.options.out) {
    io.stdout.write(stringifyScenarioPack(scenarioPack));
    return 0;
  }

  await mkdir(dirname(args.options.out), { recursive: true });
  await writeFile(args.options.out, stringifyScenarioPack(scenarioPack), "utf8");

  writeLog(io.stdout, {
    level: "info",
    command: "generate",
    message: "scenario-written",
    scenarioId,
    outputPath: args.options.out,
    summary: summarizeScenarioPack(scenarioPack)
  });

  return 0;
}

async function runFeed(argv, io) {
  const args = parseOptions(argv, {
    booleanOptions: new Set(["help", "dry-run"]),
    stringOptions: new Set(["scenario", "seed", "api-url"])
  });

  if (args.options.help) {
    printFeedUsage(io.stdout);
    return 0;
  }

  const scenarioId = getScenarioId(args);
  const apiUrl = args.options["api-url"] ?? io.env.SIMULATOR_API_URL;

  if (!apiUrl) {
    throw new CliError("feed requires --api-url or SIMULATOR_API_URL");
  }

  const sanitizedApiTarget = sanitizeUrlForLog(apiUrl);
  const scenarioPack = generateScenarioPack(scenarioId, { seed: args.options.seed });
  const summary = summarizeScenarioPack(scenarioPack);

  if (!args.options["dry-run"]) {
    writeLog(io.stdout, {
      level: "error",
      command: "feed",
      message: "http-feed-not-implemented",
      scenarioId,
      mode: "http",
      apiTarget: sanitizedApiTarget
    });
    throw new CliError("HTTP feed execution is planned for a later stage. Re-run with --dry-run.");
  }

  writeLog(io.stdout, {
    level: "info",
    command: "feed",
    message: "dry-run-started",
    scenarioId,
    mode: "dry-run",
    apiTarget: sanitizedApiTarget,
    eventCount: summary.eventCount
  });
  writeLog(io.stdout, {
    level: "info",
    command: "feed",
    message: "dry-run-completed",
    scenarioId,
    mode: "dry-run",
    apiTarget: sanitizedApiTarget,
    summary
  });

  return 0;
}

function getScenarioId(args) {
  if (args.positionals.length > 1) {
    throw new CliError(`Unexpected extra argument: ${args.positionals[1]}`);
  }

  return args.options.scenario ?? args.positionals[0] ?? DEFAULT_SCENARIO_ID;
}

function parseOptions(argv, spec) {
  const parsed = {
    options: {},
    positionals: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("-")) {
      parsed.positionals.push(arg);
      continue;
    }

    if (arg === "-h") {
      parsed.options.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new CliError(`Unknown option: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    const rawName = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const name = rawName.trim();

    if (spec.booleanOptions.has(name)) {
      if (inlineValue !== undefined) {
        throw new CliError(`--${name} does not accept a value`);
      }
      parsed.options[name] = true;
      continue;
    }

    if (spec.stringOptions.has(name)) {
      const value = inlineValue ?? argv[index + 1];

      if (!value || value.startsWith("-")) {
        throw new CliError(`--${name} requires a value`);
      }

      parsed.options[name] = value;

      if (inlineValue === undefined) {
        index += 1;
      }

      continue;
    }

    throw new CliError(`Unknown option: --${name}`);
  }

  return parsed;
}

function sanitizeUrlForLog(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new CliError("api-url must be an absolute URL");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";

  return parsed.toString();
}

function writeLog(stream, entry) {
  stream.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry
  })}\n`);
}

function printUsage(stream) {
  stream.write(`Usage:
  simulator generate --scenario baseline-week
  simulator feed --scenario baseline-week --api-url http://localhost:5000 --dry-run
  simulator --list
  simulator --help

Commands:
  generate  Write a deterministic synthetic scenario pack.
  feed      Validate and preview a scenario feed. Only --dry-run is active.
`);
}

function printGenerateUsage(stream) {
  stream.write(`Usage:
  simulator generate --scenario baseline-week [--seed value] [--out path]
  simulator generate --list
`);
}

function printFeedUsage(stream) {
  stream.write(`Usage:
  simulator feed --scenario baseline-week --api-url http://localhost:5000 --dry-run

Environment:
  SIMULATOR_API_URL may provide the API URL when --api-url is omitted.
`);
}

function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env
  };
}

class CliError extends Error {
  constructor(message) {
    super(message);
    this.name = "CliError";
    this.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await runSimulatorCli(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode ?? 1;
  }
}
