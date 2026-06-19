#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const mode = process.argv[2] ?? "all";
const root = process.cwd();

const allowedEnvFiles = new Set([".env.example", ".env.local.example"]);
const ignoredDirectories = new Set([".git", "node_modules"]);

const generatedPathRules = [
  { label: "build output", pattern: /(^|\/)(dist|build|generated|out)(\/|$)/ },
  { label: "coverage output", pattern: /(^|\/)(coverage|test-results|playwright-report)(\/|$)/ },
  { label: "aws local config", pattern: /(^|\/)\.aws(\/|$)/ }
];

const publicDocForbiddenPatterns = [
  { label: "private ai-notes path", pattern: /ai-notes\//i },
  { label: "private stage label", pattern: /\b[A-Z]\d{1,3}\b/ },
  { label: "company branding", pattern: /\bBHP\b/i },
  { label: "industry-specific wording", pattern: /\bmining\b/i },
  { label: "vendor-specific source-system wording", pattern: /\bSAP\b|\bsap-work-orders\b/i },
  { label: "old web app name", pattern: /\breviewer-console\b/i },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "AWS account ARN", pattern: /arn:aws:iam::\d{12}:/ },
  { label: "local env file path", pattern: /(^|[`'\s])\.env(?!\.example\b|\.local(?:\.example)?\b)\b/ },
  { label: "merge conflict marker", pattern: /^(<<<<<<<|=======|>>>>>>>)$/m }
];

const secretPatterns = [
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "token secret", pattern: /(token|client)[_-]?secret\s*[:=]/i }
];

function listFiles(directory) {
  const files = [];

  for (const entry of readdirSync(directory)) {
    if (ignoredDirectories.has(entry)) continue;

    const fullPath = join(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      files.push(...listFiles(fullPath));
      continue;
    }

    if (stats.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function relativePath(filePath) {
  return relative(root, filePath).replaceAll("\\", "/");
}

function readText(filePath) {
  return readFileSync(filePath, "utf8");
}

function checkArtifacts() {
  const failures = [];

  for (const filePath of listFiles(root)) {
    const rel = relativePath(filePath);
    const fileName = rel.split("/").at(-1);

    if (fileName?.startsWith(".env") && !allowedEnvFiles.has(fileName)) {
      failures.push(`${rel} (local environment file)`);
      continue;
    }

    for (const rule of generatedPathRules) {
      if (rule.pattern.test(rel)) {
        failures.push(`${rel} (${rule.label})`);
      }
    }
  }

  report("Artefact guard", failures);
}

function checkPublicDocs() {
  const publicDocs = listFiles(root).filter((filePath) => {
    const rel = relativePath(filePath);
    return rel === "README.md" || rel === "AGENTS.md" || (rel.startsWith("docs/") && rel.endsWith(".md"));
  });
  const failures = [];

  for (const filePath of publicDocs) {
    const rel = relativePath(filePath);
    const contents = readText(filePath);

    for (const forbidden of publicDocForbiddenPatterns) {
      if (rel === "AGENTS.md" && forbidden.label === "private ai-notes path") {
        continue;
      }

      if (forbidden.pattern.test(contents)) {
        failures.push(`${rel} contains ${forbidden.label}`);
      }
    }
  }

  report("Public doc leakage guard", failures);
}

function checkSecrets() {
  const failures = [];

  for (const filePath of listFiles(root)) {
    let contents;
    try {
      contents = readText(filePath);
    } catch {
      continue;
    }

    for (const secret of secretPatterns) {
      if (secret.pattern.test(contents)) {
        failures.push(`${relativePath(filePath)} contains ${secret.label}`);
      }
    }
  }

  report("Secret guard", failures);
}

function report(label, failures) {
  if (failures.length === 0) {
    console.log(`${label} passed.`);
    return;
  }

  console.error(`${label} failed:`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
}

const checks = {
  artifacts: checkArtifacts,
  "public-docs": checkPublicDocs,
  secrets: checkSecrets,
  all: () => {
    checkArtifacts();
    if (process.exitCode) return;
    checkPublicDocs();
    if (process.exitCode) return;
    checkSecrets();
  }
};

if (!checks[mode]) {
  console.error(`Unknown quality guard mode: ${mode}`);
  console.error(`Expected one of: ${Object.keys(checks).join(", ")}`);
  process.exit(1);
}

checks[mode]();
