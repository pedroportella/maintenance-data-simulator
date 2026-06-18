import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertScenarioPack } from "../src/contracts/scenario-contract.mjs";
import { generateScenarioPack } from "../src/scenarios/scenario-generator.mjs";
import {
  createMaintenanceEventFeedBatches,
  runSimulatorCli
} from "../scripts/simulator.mjs";

const cliPath = fileURLToPath(new URL("../scripts/simulator.mjs", import.meta.url));

test("generate command writes a deterministic scenario pack to stdout", () => {
  const result = runCli(["generate", "--scenario", "baseline-week"]);

  assert.equal(result.status, 0, result.stderr);
  const scenarioPack = JSON.parse(result.stdout);

  assertScenarioPack(scenarioPack);
  assert.equal(scenarioPack.scenarioId, "baseline-week");
  assert.equal(scenarioPack.events[0].eventId.startsWith("evt-baseline-week-"), true);
});

test("feed dry-run emits structured logs without raw credential-like URL parts", () => {
  const result = runCli([
    "feed",
    "--scenario",
    "baseline-week",
    "--api-url",
    "http://user:secret@host.docker.internal:5000/import?token=do-not-log#fragment",
    "--dry-run"
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("secret"), false);
  assert.equal(result.stdout.includes("do-not-log"), false);

  const logs = result.stdout.trim().split("\n").map((line) => JSON.parse(line));

  assert.deepEqual(logs.map((entry) => entry.message), [
    "dry-run-started",
    "dry-run-completed"
  ]);
  assert.equal(logs[0].command, "feed");
  assert.equal(logs[0].mode, "dry-run");
  assert.equal(logs[0].apiTarget, "http://host.docker.internal:5000/import");
  assert.equal(logs[1].summary.scenarioId, "baseline-week");
});

test("feed batching builds API import requests without simulator-only expectations", () => {
  const scenarioPack = generateScenarioPack("baseline-week");
  const batches = createMaintenanceEventFeedBatches(scenarioPack, {
    batchSize: 4
  });

  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.eventCount), [4, 4, 1]);
  assert.equal(
    batches[0].batchIdempotencyKey,
    `${scenarioPack.apiImport.batchIdempotencyKey}:batch-1-of-3`
  );
  assert.equal(
    batches[2].batchIdempotencyKey,
    `${scenarioPack.apiImport.batchIdempotencyKey}:batch-3-of-3`
  );
  assert.equal(batches[0].request.sourceSystem, "synthetic-source");
  assert.equal(batches[0].request.schemaVersion, "1.0");
  assert.equal(Object.hasOwn(batches[0].request.events[0], "expectation"), false);
  assert.equal(batches[0].request.events[0].eventType, "WorkOrderCreated");
  assert.equal(batches[0].request.events[0].payload.sourceDataReadiness.status, "Ready");
});

test("feed posts maintenance event batches with idempotency and a run correlation header", async () => {
  const requests = [];
  const scenarioPack = generateScenarioPack("baseline-week");
  const io = createMockIo(async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({
      url,
      method: options.method,
      headers: options.headers,
      body
    });

    return jsonResponse({
      importKind: "maintenance-events",
      idempotencyKey: body.batchIdempotencyKey,
      receivedCount: body.events.length,
      acceptedCount: body.events.length,
      rejectedCount: 0,
      ignoredDuplicateCount: 0,
      ignoredStaleCount: 0,
      duplicateRequest: false,
      events: []
    });
  });

  const status = await runSimulatorCli([
    "feed",
    "--scenario",
    "baseline-week",
    "--api-url",
    "http://localhost:5000",
    "--batch-size",
    "4",
    "--max-retries",
    "0",
    "--retry-delay-ms",
    "0",
    "--correlation-id",
    "feed-test-correlation"
  ], io);

  assert.equal(status, 0);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.body.events.length), [4, 4, 1]);
  assert.equal(requests[0].url, "http://localhost:5000/api/v1/imports/maintenance-events");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.equal(requests[0].headers["x-correlation-id"], "feed-test-correlation");
  assert.equal(
    requests[0].body.batchIdempotencyKey,
    `${scenarioPack.apiImport.batchIdempotencyKey}:batch-1-of-3`
  );
  assert.equal(Object.hasOwn(requests[0].body.events[0], "expectation"), false);

  const logs = parseJsonLines(io.stdoutText());

  assert.deepEqual(logs.map((entry) => entry.message), [
    "feed-started",
    "feed-batch-completed",
    "feed-batch-completed",
    "feed-batch-completed",
    "feed-completed"
  ]);
  assert.equal(logs.at(-1).importSummary.batchCount, 3);
  assert.equal(logs.at(-1).importSummary.receivedCount, 9);
});

test("feed retries retryable HTTP responses before completing", async () => {
  let callCount = 0;
  const io = createMockIo(async (url, options) => {
    callCount += 1;

    if (callCount === 1) {
      return jsonResponse({
        code: "import-persistence-not-configured",
        title: "Import persistence is not configured."
      }, {
        ok: false,
        status: 503,
        statusText: "Service Unavailable"
      });
    }

    const body = JSON.parse(options.body);

    return jsonResponse({
      importKind: "maintenance-events",
      receivedCount: body.events.length,
      acceptedCount: body.events.length,
      rejectedCount: 0,
      ignoredDuplicateCount: 0,
      ignoredStaleCount: 0,
      duplicateRequest: true,
      events: []
    });
  });

  const status = await runSimulatorCli([
    "feed",
    "--scenario",
    "baseline-week",
    "--api-url",
    "http://localhost:5000",
    "--batch-size",
    "9",
    "--max-retries",
    "1",
    "--retry-delay-ms",
    "0",
    "--correlation-id",
    "feed-retry-correlation"
  ], io);

  assert.equal(status, 0);
  assert.equal(callCount, 2);

  const logs = parseJsonLines(io.stdoutText());

  assert.deepEqual(logs.map((entry) => entry.message), [
    "feed-started",
    "feed-batch-retrying",
    "feed-batch-completed",
    "feed-completed"
  ]);
  assert.equal(logs[1].httpStatus, 503);
  assert.equal(logs[1].problem.code, "import-persistence-not-configured");
  assert.equal(logs[2].duplicateRequest, true);
});

test("feed summarizes failed API responses without logging credential-like URL parts", async () => {
  const io = createMockIo(async () => jsonResponse({
    code: "import-validation-failed",
    title: "Import validation failed.",
    detail: "One or more synthetic events did not match the import contract."
  }, {
    ok: false,
    status: 422,
    statusText: "Unprocessable Entity"
  }));

  await assert.rejects(
    () => runSimulatorCli([
      "feed",
      "--scenario",
      "baseline-week",
      "--api-url",
      "http://user:secret@localhost:5000?token=do-not-log#fragment",
      "--max-retries",
      "0",
      "--retry-delay-ms",
      "0",
      "--correlation-id",
      "feed-failure-correlation"
    ], io),
    /422 Unprocessable Entity \(import-validation-failed\)/
  );

  const stdout = io.stdoutText();

  assert.equal(stdout.includes("secret"), false);
  assert.equal(stdout.includes("do-not-log"), false);

  const logs = parseJsonLines(stdout);

  assert.equal(logs.at(-1).message, "feed-batch-failed");
  assert.equal(logs.at(-1).httpStatus, 422);
  assert.equal(logs.at(-1).problem.code, "import-validation-failed");
});

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
}

function createMockIo(fetch) {
  let stdout = "";
  const io = {
    stdout: {
      write(chunk) {
        stdout += chunk;
      }
    },
    stderr: {
      write() {}
    },
    env: {},
    sleep: async () => {},
    stdoutText() {
      return stdout;
    }
  };

  if (fetch) {
    io.fetch = fetch;
  }

  return io;
}

function jsonResponse(body, options = {}) {
  const status = options.status ?? 200;

  return {
    ok: options.ok ?? (status >= 200 && status < 300),
    status,
    statusText: options.statusText ?? "OK",
    text: async () => JSON.stringify(body)
  };
}

function parseJsonLines(stdout) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
