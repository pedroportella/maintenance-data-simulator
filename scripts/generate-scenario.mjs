#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  generateScenarioPack,
  listScenarioIds,
  stringifyScenarioPack
} from "../src/scenarios/scenario-generator.mjs";
import {
  DEFAULT_SCENARIO_ID,
  DEFAULT_SCENARIO_REPEAT,
  MAX_SCENARIO_REPEAT
} from "../src/utils/constants.mjs";

const args = parseArgs(process.argv.slice(2));

try {
  if (args.help) {
    printUsage();
  } else if (args.list) {
    process.stdout.write(`${listScenarioIds().join("\n")}\n`);
  } else if (args.all) {
    await writeAllScenarios(args);
  } else {
    await writeOneScenario(args);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

async function writeOneScenario(args) {
  const scenarioId = args.scenarioId ?? DEFAULT_SCENARIO_ID;
  const scenarioPack = generateScenarioPack(scenarioId, {
    seed: args.seed,
    repeat: args.repeat
  });
  const contents = stringifyScenarioPack(scenarioPack);

  if (!args.out) {
    process.stdout.write(contents);
    return;
  }

  await mkdir(dirname(args.out), { recursive: true });
  await writeFile(args.out, contents, "utf8");
  console.log(`Wrote ${args.out}`);
}

async function writeAllScenarios(args) {
  const outDir = args.outDir ?? "scenarios";

  await mkdir(outDir, { recursive: true });

  for (const scenarioId of listScenarioIds()) {
    const scenarioPack = generateScenarioPack(scenarioId);
    const outPath = join(outDir, `${scenarioId}.scenario.json`);
    await writeFile(outPath, stringifyScenarioPack(scenarioPack), "utf8");
    console.log(`Wrote ${outPath}`);
  }
}

function parseArgs(argv) {
  const parsed = {
    scenarioId: undefined,
    seed: undefined,
    repeat: DEFAULT_SCENARIO_REPEAT,
    out: undefined,
    outDir: undefined,
    all: false,
    list: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === "--all") {
      parsed.all = true;
      continue;
    }

    if (arg === "--seed") {
      parsed.seed = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--repeat") {
      parsed.repeat = readIntegerOption(argv, index, arg, {
        min: 1,
        max: MAX_SCENARIO_REPEAT
      });
      index += 1;
      continue;
    }

    if (arg === "--out") {
      parsed.out = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg === "--out-dir") {
      parsed.outDir = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }

    if (parsed.scenarioId) {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }

    parsed.scenarioId = arg;
  }

  if (parsed.seed && parsed.all) {
    throw new Error("--seed can only be used when generating one scenario");
  }

  if (parsed.out && parsed.all) {
    throw new Error("--out can only be used when generating one scenario");
  }

  if (parsed.repeat !== DEFAULT_SCENARIO_REPEAT && parsed.all) {
    throw new Error("--repeat can only be used when generating one scenario");
  }

  return parsed;
}

function readOptionValue(argv, index, optionName) {
  const value = argv[index + 1];

  if (!value || value.startsWith("-")) {
    throw new Error(`${optionName} requires a value`);
  }

  return value;
}

function readIntegerOption(argv, index, optionName, { min, max }) {
  const value = readOptionValue(argv, index, optionName);

  if (!/^\d+$/.test(value)) {
    throw new Error(`${optionName} must be an integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(`${optionName} must be greater than or equal to ${min}`);
  }

  if (max !== undefined && parsed > max) {
    throw new Error(`${optionName} must be less than or equal to ${max}`);
  }

  return parsed;
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/generate-scenario.mjs --list
  node scripts/generate-scenario.mjs [scenario-id] [--seed value] [--repeat value] [--out path]
  node scripts/generate-scenario.mjs --all [--out-dir scenarios]

Options:
  --repeat value  Number of deterministic synthetic copies to include. Default: ${DEFAULT_SCENARIO_REPEAT}. Max: ${MAX_SCENARIO_REPEAT}.

Scenario ids:
  ${listScenarioIds().join("\n  ")}
`);
}
