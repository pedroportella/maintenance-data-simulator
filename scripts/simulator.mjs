#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import {
  summarizeScenarioPack
} from "../src/contracts/scenario-contract.mjs";
import {
  runApiScenarioSmoke
} from "../src/api/api-scenario-smoke.mjs";
import { loadLocalEnv } from "./env-loader.mjs";
import {
  generateScenarioPack,
  listScenarioIds,
  stringifyScenarioPack
} from "../src/scenarios/scenario-generator.mjs";

const DEFAULT_SCENARIO_ID = "baseline-week";
const DEFAULT_FEED_BATCH_SIZE = 100;
const DEFAULT_FEED_MAX_RETRIES = 2;
const DEFAULT_FEED_RETRY_DELAY_MS = 250;
const DEFAULT_FEED_TIMEOUT_MS = 10_000;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

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

  if (command === "api-smoke") {
    return runApiScenarioSmoke(commandArgs, io);
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
    stringOptions: new Set([
      "scenario",
      "seed",
      "api-url",
      "batch-size",
      "max-retries",
      "retry-delay-ms",
      "timeout-ms",
      "correlation-id",
      "api-token"
    ])
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
  const feedOptions = {
    batchSize: parseIntegerOption(args.options["batch-size"], "--batch-size", {
      defaultValue: DEFAULT_FEED_BATCH_SIZE,
      min: 1
    }),
    maxRetries: parseIntegerOption(args.options["max-retries"], "--max-retries", {
      defaultValue: DEFAULT_FEED_MAX_RETRIES,
      min: 0
    }),
    retryDelayMs: parseIntegerOption(args.options["retry-delay-ms"], "--retry-delay-ms", {
      defaultValue: DEFAULT_FEED_RETRY_DELAY_MS,
      min: 0
    }),
    timeoutMs: parseIntegerOption(args.options["timeout-ms"], "--timeout-ms", {
      defaultValue: DEFAULT_FEED_TIMEOUT_MS,
      min: 1
    }),
    correlationId: args.options["correlation-id"] ?? createRunCorrelationId(scenarioPack),
    apiToken: getApiToken(args, io)
  };
  validateCorrelationId(feedOptions.correlationId);
  const batches = createMaintenanceEventFeedBatches(scenarioPack, {
    batchSize: feedOptions.batchSize
  });

  writeLog(io.stdout, {
    level: "info",
    command: "feed",
    message: args.options["dry-run"] ? "dry-run-started" : "feed-started",
    scenarioId,
    mode: args.options["dry-run"] ? "dry-run" : "http",
    apiTarget: args.options["dry-run"]
      ? sanitizedApiTarget
      : sanitizeUrlForLog(resolveImportUrl(apiUrl, scenarioPack.apiImport.endpoint)),
    correlationId: feedOptions.correlationId,
    authorizationConfigured: Boolean(feedOptions.apiToken),
    eventCount: summary.eventCount,
    batchCount: batches.length,
    batchSize: feedOptions.batchSize
  });

  if (!args.options["dry-run"]) {
    const importUrl = resolveImportUrl(apiUrl, scenarioPack.apiImport.endpoint);
    const importSummary = await postMaintenanceEventFeed({
      batches,
      fetch: io.fetch ?? fetch,
      sleep: io.sleep ?? sleep,
      stdout: io.stdout,
      scenarioId,
      apiTarget: sanitizeUrlForLog(importUrl),
      importUrl,
      correlationId: feedOptions.correlationId,
      apiToken: feedOptions.apiToken,
      maxRetries: feedOptions.maxRetries,
      retryDelayMs: feedOptions.retryDelayMs,
      timeoutMs: feedOptions.timeoutMs
    });

    writeLog(io.stdout, {
      level: "info",
      command: "feed",
      message: "feed-completed",
      scenarioId,
      mode: "http",
      apiTarget: sanitizeUrlForLog(importUrl),
      correlationId: feedOptions.correlationId,
      summary,
      importSummary
    });

    return 0;
  }

  writeLog(io.stdout, {
    level: "info",
    command: "feed",
    message: "dry-run-completed",
    scenarioId,
    mode: "dry-run",
    apiTarget: sanitizedApiTarget,
    correlationId: feedOptions.correlationId,
    batchCount: batches.length,
    summary
  });

  return 0;
}

export function createMaintenanceEventFeedBatches(scenarioPack, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_FEED_BATCH_SIZE;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer");
  }

  if (!scenarioPack?.apiImport?.endpoint) {
    throw new Error("scenario pack is missing apiImport.endpoint");
  }

  if (!scenarioPack?.apiImport?.batchIdempotencyKey) {
    throw new Error("scenario pack is missing apiImport.batchIdempotencyKey");
  }

  const events = scenarioPack.events.map(toApiMaintenanceEvent);
  const batchCount = Math.ceil(events.length / batchSize);
  const batches = [];

  for (let index = 0; index < batchCount; index += 1) {
    const batchNumber = index + 1;
    const batchEvents = events.slice(index * batchSize, (index + 1) * batchSize);
    const batchIdempotencyKey = buildBatchIdempotencyKey(
      scenarioPack.apiImport.batchIdempotencyKey,
      batchNumber,
      batchCount
    );

    batches.push({
      batchNumber,
      batchCount,
      eventCount: batchEvents.length,
      batchIdempotencyKey,
      request: {
        sourceSystem: scenarioPack.sourceSystem,
        schemaVersion: scenarioPack.schemaVersion,
        batchIdempotencyKey,
        events: batchEvents
      }
    });
  }

  return batches;
}

async function postMaintenanceEventFeed(options) {
  const aggregate = {
    receivedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    ignoredDuplicateCount: 0,
    ignoredStaleCount: 0,
    duplicateRequestCount: 0
  };

  for (const batch of options.batches) {
    const result = await postBatchWithRetry(batch, options);

    aggregate.receivedCount += result.receivedCount ?? batch.eventCount;
    aggregate.acceptedCount += result.acceptedCount ?? 0;
    aggregate.rejectedCount += result.rejectedCount ?? 0;
    aggregate.ignoredDuplicateCount += result.ignoredDuplicateCount ?? 0;
    aggregate.ignoredStaleCount += result.ignoredStaleCount ?? 0;
    aggregate.duplicateRequestCount += result.duplicateRequest ? 1 : 0;
  }

  return {
    batchCount: options.batches.length,
    ...aggregate
  };
}

async function postBatchWithRetry(batch, options) {
  const maxAttempts = options.maxRetries + 1;
  let lastNetworkError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await postJson(options.importUrl, batch.request, {
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
        correlationId: options.correlationId,
        apiToken: options.apiToken
      });
      const responseSummary = await summarizeResponse(response);

      if (response.ok) {
        const result = responseSummary.body ?? {};

        writeLog(options.stdout, {
          level: "info",
          command: "feed",
          message: "feed-batch-completed",
          scenarioId: options.scenarioId,
          mode: "http",
          apiTarget: options.apiTarget,
          correlationId: options.correlationId,
          batchNumber: batch.batchNumber,
          batchCount: batch.batchCount,
          eventCount: batch.eventCount,
          batchIdempotencyKey: batch.batchIdempotencyKey,
          httpStatus: response.status,
          duplicateRequest: Boolean(result.duplicateRequest),
          receivedCount: result.receivedCount,
          acceptedCount: result.acceptedCount,
          rejectedCount: result.rejectedCount,
          ignoredDuplicateCount: result.ignoredDuplicateCount,
          ignoredStaleCount: result.ignoredStaleCount
        });

        return result;
      }

      if (!shouldRetryStatus(response.status) || attempt === maxAttempts) {
        writeFailedBatchLog(options, batch, {
          attempt,
          httpStatus: response.status,
          statusText: response.statusText,
          problem: responseSummary.problem
        });
        throw new CliError(buildHttpFailureMessage(batch, response, responseSummary.problem));
      }

      writeRetryLog(options, batch, {
        attempt,
        nextAttempt: attempt + 1,
        httpStatus: response.status,
        statusText: response.statusText,
        problem: responseSummary.problem
      });
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }

      lastNetworkError = error;

      if (attempt === maxAttempts) {
        writeFailedBatchLog(options, batch, {
          attempt,
          error: summarizeNetworkError(error)
        });
        throw new CliError(buildNetworkFailureMessage(batch, error));
      }

      writeRetryLog(options, batch, {
        attempt,
        nextAttempt: attempt + 1,
        error: summarizeNetworkError(error)
      });
    }

    await options.sleep(backoffMs(options.retryDelayMs, attempt));
  }

  throw new CliError(buildNetworkFailureMessage(batch, lastNetworkError));
}

async function postJson(url, body, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    return await options.fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-correlation-id": options.correlationId,
        ...authorizationHeader(options.apiToken)
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeResponse(response) {
  const rawText = await response.text();
  const summary = {
    body: undefined,
    problem: undefined
  };

  if (!rawText) {
    return summary;
  }

  try {
    const parsed = JSON.parse(rawText);
    summary.body = parsed;

    if (!response.ok && parsed && typeof parsed === "object") {
      summary.problem = {
        code: cleanOptionalString(parsed.code ?? parsed.extensions?.code, 120),
        title: cleanOptionalString(parsed.title, 160),
        detail: cleanOptionalString(parsed.detail, 240)
      };
    }
  } catch {
    if (!response.ok) {
      summary.problem = {
        title: "HTTP response was not JSON",
        detail: cleanOptionalString(rawText, 240)
      };
    }
  }

  return summary;
}

function writeRetryLog(options, batch, details) {
  writeLog(options.stdout, {
    level: "warn",
    command: "feed",
    message: "feed-batch-retrying",
    scenarioId: options.scenarioId,
    mode: "http",
    apiTarget: options.apiTarget,
    correlationId: options.correlationId,
    batchNumber: batch.batchNumber,
    batchCount: batch.batchCount,
    eventCount: batch.eventCount,
    batchIdempotencyKey: batch.batchIdempotencyKey,
    retryDelayMs: backoffMs(options.retryDelayMs, details.attempt),
    ...details
  });
}

function writeFailedBatchLog(options, batch, details) {
  writeLog(options.stdout, {
    level: "error",
    command: "feed",
    message: "feed-batch-failed",
    scenarioId: options.scenarioId,
    mode: "http",
    apiTarget: options.apiTarget,
    correlationId: options.correlationId,
    batchNumber: batch.batchNumber,
    batchCount: batch.batchCount,
    eventCount: batch.eventCount,
    batchIdempotencyKey: batch.batchIdempotencyKey,
    ...details
  });
}

function buildHttpFailureMessage(batch, response, problem) {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const problemCode = problem?.code ? ` (${problem.code})` : "";

  return `HTTP feed failed for batch ${batch.batchNumber}/${batch.batchCount}: ${response.status}${statusText}${problemCode}`;
}

function buildNetworkFailureMessage(batch, error) {
  const reason = error?.name === "AbortError" ? "request timed out" : "network request failed";

  return `HTTP feed failed for batch ${batch.batchNumber}/${batch.batchCount}: ${reason}`;
}

function summarizeNetworkError(error) {
  return {
    name: cleanOptionalString(error?.name ?? "Error", 80),
    message: error?.name === "AbortError"
      ? "request timed out"
      : cleanOptionalString(error?.message ?? "network request failed", 160)
  };
}

function shouldRetryStatus(status) {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

function backoffMs(baseDelayMs, attempt) {
  if (baseDelayMs === 0) return 0;

  return baseDelayMs * (2 ** (attempt - 1));
}

function buildBatchIdempotencyKey(baseKey, batchNumber, batchCount) {
  if (batchCount === 1) {
    return baseKey;
  }

  return `${baseKey}:batch-${batchNumber}-of-${batchCount}`;
}

function toApiMaintenanceEvent(event) {
  const { expectation, ...apiEvent } = event;

  return apiEvent;
}

function resolveImportUrl(apiUrl, endpoint) {
  let parsed;

  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new CliError("api-url must be an absolute URL");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";

  const endpointPath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const currentPath = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;

  if (currentPath.endsWith(endpointPath)) {
    parsed.pathname = currentPath;
  } else {
    parsed.pathname = `${currentPath === "" ? "" : currentPath}${endpointPath}`;
  }

  return parsed.toString();
}

function getScenarioId(args) {
  if (args.positionals.length > 1) {
    throw new CliError(`Unexpected extra argument: ${args.positionals[1]}`);
  }

  return args.options.scenario ?? args.positionals[0] ?? DEFAULT_SCENARIO_ID;
}

function getApiToken(args, io) {
  return cleanOptionalString(args.options["api-token"] ?? io.env.SIMULATOR_API_TOKEN, 4096);
}

function authorizationHeader(apiToken) {
  return apiToken ? { authorization: `Bearer ${apiToken}` } : {};
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

function parseIntegerOption(rawValue, optionName, { defaultValue, min }) {
  if (rawValue === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new CliError(`${optionName} must be an integer`);
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < min) {
    throw new CliError(`${optionName} must be greater than or equal to ${min}`);
  }

  return value;
}

function validateCorrelationId(correlationId) {
  if (typeof correlationId !== "string" || correlationId.trim().length === 0) {
    throw new CliError("--correlation-id must not be blank");
  }

  if (correlationId.length > 160) {
    throw new CliError("--correlation-id must be 160 characters or fewer");
  }
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

function createRunCorrelationId(scenarioPack) {
  return `feed-${scenarioPack.scenarioId}-${randomUUID().slice(0, 8)}`;
}

function cleanOptionalString(value, maxLength) {
  if (typeof value !== "string") {
    return undefined;
  }

  const cleaned = value.replace(/\s+/g, " ").trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, maxLength - 3)}...`;
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
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
  simulator feed --scenario baseline-week --api-url http://localhost:5000
  simulator api-smoke --scenario baseline-week --api-url http://localhost:5000
  simulator --list
  simulator --help

Commands:
  generate   Write a deterministic synthetic scenario pack.
  feed       Validate, preview or post a deterministic synthetic scenario feed.
  api-smoke  Feed a scenario to the local API and verify planning recommendations.
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
  simulator feed --scenario baseline-week --api-url http://localhost:5000 [--batch-size 100]

Environment:
  SIMULATOR_API_URL may provide the API URL when --api-url is omitted.
  SIMULATOR_API_TOKEN may provide a bearer token for protected local API routes.

Options:
  --batch-size value      Number of events per HTTP batch. Default: ${DEFAULT_FEED_BATCH_SIZE}.
  --max-retries value     Retry count for retryable responses. Default: ${DEFAULT_FEED_MAX_RETRIES}.
  --retry-delay-ms value  Initial retry delay. Default: ${DEFAULT_FEED_RETRY_DELAY_MS}.
  --timeout-ms value      Per-request timeout. Default: ${DEFAULT_FEED_TIMEOUT_MS}.
  --correlation-id value  HTTP correlation id for this simulator run.
  --api-token value       Bearer token for protected local API routes.
`);
}

function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: loadLocalEnv()
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
