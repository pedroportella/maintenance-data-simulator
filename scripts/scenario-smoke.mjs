#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { assertScenarioPack } from "../src/contracts/scenario-contract.mjs";

const requiredFiles = [
  "README.md",
  "AGENTS.md",
  ".cursorrules",
  ".dockerignore",
  "Dockerfile",
  "docs/scenarios.md",
  "docs/event-contracts.md",
  "docs/containerisation.md",
  "docs/http-feed-mode.md",
  "docs/aws-publish-mode.md",
  "docs/production-next.md",
  "schemas/scenario-pack.schema.json",
  "schemas/maintenance-event-envelope.schema.json",
  "schemas/payloads/work-order-event-payload.schema.json",
  "schemas/payloads/major-event-window-payload.schema.json",
  "schemas/payloads/parts-availability-payload.schema.json",
  "schemas/payloads/crew-capacity-payload.schema.json",
  "src/contracts/scenario-contract.mjs",
  "src/scenarios/scenario-generator.mjs",
  "scripts/generate-scenario.mjs",
  "scripts/simulator.mjs",
  "scripts/api-scenario-smoke.mjs",
  "scripts/container-smoke.mjs",
  "scenarios/baseline-week.scenario.json",
  "scenarios/event-window-conflict.scenario.json",
  "scenarios/parts-delay-replan.scenario.json"
];

const requiredReadmeText = [
  "docs/scenarios.md",
  "docs/event-contracts.md",
  "docs/containerisation.md",
  "docs/http-feed-mode.md",
  "docs/aws-publish-mode.md",
  "docs/production-next.md",
  "schemas/scenario-pack.schema.json",
  "scenarios/baseline-week.scenario.json",
  "scripts/generate-scenario.mjs",
  "scripts/simulator.mjs",
  "scripts/api-scenario-smoke.mjs",
  "Dockerfile",
  "synthetic"
];

const failures = [];

for (const filePath of requiredFiles) {
  if (!existsSync(filePath)) {
    failures.push(`required file is missing: ${filePath}`);
  }
}

if (existsSync("README.md")) {
  const readme = readFileSync("README.md", "utf8");
  for (const expected of requiredReadmeText) {
    if (!readme.includes(expected)) {
      failures.push(`README.md is missing expected simulator evidence: ${expected}`);
    }
  }
}

const scenarioFiles = existsSync("scenarios")
  ? readdirSync("scenarios")
    .filter((entry) => entry.endsWith(".scenario.json"))
    .map((entry) => `scenarios/${entry}`)
    .sort()
  : [];

for (const scenarioFile of scenarioFiles) {
  try {
    assertScenarioPack(JSON.parse(readFileSync(scenarioFile, "utf8")));
  } catch (error) {
    failures.push(`${scenarioFile} contract is invalid: ${error.message}`);
  }
}

for (const filePath of requiredFiles.filter((path) => path.endsWith(".md") && existsSync(path))) {
  const contents = readFileSync(filePath, "utf8");
  for (const target of extractMarkdownLinkTargets(contents)) {
    checkMarkdownLink(filePath, target);
  }
}

if (failures.length > 0) {
  console.error("Scenario smoke failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Scenario smoke passed.");
}

function extractMarkdownLinkTargets(contents) {
  const targets = [];
  const markdownLinkPattern = /!?\[[^\]]*]\(([^)]+)\)/g;
  let match;

  while ((match = markdownLinkPattern.exec(contents)) !== null) {
    const rawTarget = match[1].trim().split(/\s+/)[0];
    targets.push(stripAngleBrackets(rawTarget));
  }

  return targets;
}

function stripAngleBrackets(value) {
  if (value.startsWith("<") && value.endsWith(">")) {
    return value.slice(1, -1);
  }

  return value;
}

function checkMarkdownLink(sourceFilePath, rawTarget) {
  if (rawTarget === "" || rawTarget.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
    return;
  }

  const [pathWithoutAnchor] = rawTarget.split("#");
  if (pathWithoutAnchor === "") return;

  let decodedPath = pathWithoutAnchor;
  try {
    decodedPath = decodeURIComponent(pathWithoutAnchor);
  } catch {
    failures.push(`${sourceFilePath} has an invalid encoded Markdown link: ${rawTarget}`);
    return;
  }

  const resolvedPath = normalize(join(dirname(sourceFilePath), decodedPath));

  if (!existsSync(resolvedPath)) {
    failures.push(`${sourceFilePath} links to missing local target: ${rawTarget}`);
    return;
  }

  const stats = statSync(resolvedPath);
  if (!stats.isFile() && !stats.isDirectory()) {
    failures.push(`${sourceFilePath} links to unsupported local target: ${rawTarget}`);
  }
}
