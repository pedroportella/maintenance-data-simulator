#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { assertScenarioPack } from "../src/contracts/scenario-contract.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const image = args.image ?? "maintenance-data-simulator:local";

  if (args.build) {
    run("docker", ["build", "-t", image, "."]);
  }

  inspectImage(image);
  smokeGenerate(image);
  smokeFeedDryRun(image);
  smokeRestrictedDryRun(image);
  inspectRuntimeFiles(image);

  console.log(`Container smoke passed for ${image}.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

function inspectImage(imageName) {
  const inspectResult = run("docker", ["image", "inspect", imageName]);
  const [imageConfig] = JSON.parse(inspectResult.stdout);
  const labels = imageConfig.Config.Labels ?? {};

  assert.equal(imageConfig.Config.User, "10001:10001", "image must run as the simulator user");
  assert.equal(labels["org.opencontainers.image.title"], "maintenance-data-simulator");
  assert.ok(labels["org.opencontainers.image.revision"], "image must carry a revision label");
}

function smokeGenerate(imageName) {
  const result = run("docker", [
    "run",
    "--rm",
    imageName,
    "generate",
    "--scenario",
    "baseline-week"
  ]);
  const scenarioPack = JSON.parse(result.stdout);

  assertScenarioPack(scenarioPack);
  assert.equal(scenarioPack.scenarioId, "baseline-week");
}

function smokeFeedDryRun(imageName) {
  const result = run("docker", [
    "run",
    "--rm",
    imageName,
    "feed",
    "--scenario",
    "baseline-week",
    "--api-url",
    "http://host.docker.internal:5000",
    "--dry-run"
  ]);
  const logs = parseJsonLines(result.stdout);

  assert.equal(logs.at(-1).message, "dry-run-completed");
  assert.equal(logs.at(-1).summary.scenarioId, "baseline-week");
}

function smokeRestrictedDryRun(imageName) {
  const result = run("docker", [
    "run",
    "--rm",
    "--read-only",
    "--cap-drop=ALL",
    "--memory=256m",
    "--cpus=0.25",
    imageName,
    "feed",
    "--scenario",
    "baseline-week",
    "--api-url",
    "http://user:password@host.docker.internal:5000/import?token=redacted#fragment",
    "--dry-run"
  ]);

  assert.equal(result.stdout.includes("password"), false);
  assert.equal(result.stdout.includes("redacted"), false);

  const logs = parseJsonLines(result.stdout);

  assert.equal(logs.at(-1).message, "dry-run-completed");
  assert.equal(logs.at(-1).apiTarget, "http://host.docker.internal:5000/import");
}

function inspectRuntimeFiles(imageName) {
  const inspector = [
    "const fs = require('node:fs');",
    "const forbidden = [",
    "'.git','.github','docs','tests','scenarios','.aws','coverage','test-results','playwright-report','generated','out'",
    "];",
    "const existing = forbidden.filter((entry) => fs.existsSync(`/app/${entry}`));",
    "process.stdout.write(JSON.stringify({ existing }));",
    "process.exit(existing.length === 0 ? 0 : 1);"
  ].join("");
  const result = run("docker", [
    "run",
    "--rm",
    "--entrypoint",
    "node",
    imageName,
    "-e",
    inspector
  ]);
  const inspection = JSON.parse(result.stdout);

  assert.deepEqual(inspection.existing, []);
}

function parseJsonLines(stdout) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error([
      `${command} ${commandArgs.join(" ")} failed with status ${result.status}.`,
      result.stdout.trim(),
      result.stderr.trim()
    ].filter(Boolean).join("\n"));
  }

  return result;
}

function parseArgs(argv) {
  const parsed = {
    build: false,
    image: undefined
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--build") {
      parsed.build = true;
      continue;
    }

    if (arg === "--image") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--image requires a value");
      }
      parsed.image = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}
