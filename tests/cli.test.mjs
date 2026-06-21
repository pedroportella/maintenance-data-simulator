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

test("generate command can scale a scenario with unique synthetic source ids", () => {
  const result = runCli(["generate", "--scenario", "baseline-week", "--repeat", "3"]);

  assert.equal(result.status, 0, result.stderr);
  const scenarioPack = JSON.parse(result.stdout);

  assertScenarioPack(scenarioPack);
  assert.equal(scenarioPack.scenarioId, "baseline-week");
  assert.equal(scenarioPack.events.length, 27);
  assert.equal(scenarioPack.expectedOutcomes.counts.readyWorkOrders, 3);
  assert.equal(scenarioPack.expectedOutcomes.counts.blockedWorkOrders, 3);
  assert.equal(scenarioPack.expectedOutcomes.counts.rejectedEvents, 3);
  assert.deepEqual(scenarioPack.expectedOutcomes.readyWorkOrderSourceIds, [
    "WO-2000-R0001",
    "WO-2000-R0002",
    "WO-2000-R0003"
  ]);

  const duplicateEvents = scenarioPack.events.filter((event) => (
    event.expectation.importDisposition === "ignored-duplicate"
  ));

  assert.equal(duplicateEvents.length, 3);
  assert.equal(duplicateEvents[0].idempotencyKey, scenarioPack.events[0].idempotencyKey);
  assert.equal(duplicateEvents[1].idempotencyKey, scenarioPack.events[9].idempotencyKey);
  assert.equal(new Set(scenarioPack.events.map((event) => event.sourceRecordId)).size > 6, true);
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

test("publish-aws refuses to publish without explicit confirmation", () => {
  const result = runCli([
    "publish-aws",
    "--scenario",
    "baseline-week",
    "--event-bus-name",
    "review-events",
    "--aws-region",
    "ap-southeast-2"
  ]);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /publish-aws requires --confirm-aws-publish/);
});

test("publish-aws refuses to publish without EventBridge config", async () => {
  const io = createMockIo(undefined, {
    env: {
      SIMULATOR_AWS_REGION: "ap-southeast-2",
      AWS_ACCESS_KEY_ID: "fake-access-key",
      AWS_SECRET_ACCESS_KEY: "fake-secret-key"
    },
    eventBridgeClient: createMockEventBridgeClient()
  });

  await assert.rejects(
    () => runSimulatorCli([
      "publish-aws",
      "--scenario",
      "baseline-week",
      "--confirm-aws-publish"
    ], io),
    /publish-aws requires --event-bus-name or SIMULATOR_EVENT_BUS_NAME/
  );
});

test("publish-aws sends EventBridge entries without simulator-only expectations or credentials in logs", async () => {
  const commands = [];
  const eventBridgeClient = createMockEventBridgeClient((command) => {
    commands.push(command);

    return {
      FailedEntryCount: 0,
      Entries: command.input.Entries.map((entry, index) => ({
        EventId: `${entry.DetailType}-${commands.length}-${index}`
      }))
    };
  });
  const io = createMockIo(undefined, {
    env: {
      SIMULATOR_EVENT_BUS_NAME: "review-events",
      SIMULATOR_AWS_REGION: "ap-southeast-2",
      AWS_ACCESS_KEY_ID: "fake-access-key",
      AWS_SECRET_ACCESS_KEY: "fake-secret-key"
    },
    eventBridgeClient
  });

  const status = await runSimulatorCli([
    "publish-aws",
    "--scenario",
    "baseline-week",
    "--aws-profile",
    "review-profile",
    "--batch-size",
    "4",
    "--confirm-aws-publish"
  ], io);

  assert.equal(status, 0);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.map((command) => command.input.Entries.length), [4, 4, 1]);

  const firstEntry = commands[0].input.Entries[0];
  const firstDetail = JSON.parse(firstEntry.Detail);

  assert.equal(firstEntry.EventBusName, "review-events");
  assert.equal(firstEntry.Source, "maintenance-data-simulator");
  assert.equal(firstEntry.DetailType, "MaintenanceEvent");
  assert.equal(firstDetail.eventType, "WorkOrderCreated");
  assert.equal(Object.hasOwn(firstDetail, "expectation"), false);

  const stdout = io.stdoutText();

  assert.equal(stdout.includes("fake-secret-key"), false);
  assert.equal(stdout.includes("fake-access-key"), false);
  assert.equal(stdout.includes("review-profile"), false);

  const logs = parseJsonLines(stdout);

  assert.deepEqual(logs.map((entry) => entry.message), [
    "aws-publish-started",
    "aws-publish-batch-completed",
    "aws-publish-batch-completed",
    "aws-publish-batch-completed",
    "aws-publish-completed"
  ]);
  assert.equal(logs[0].profileConfigured, true);
  assert.equal(logs.at(-1).summary.publishedCount, 9);
  assert.equal(logs.at(-1).summary.failedCount, 0);
});

test("publish-aws supports scaled synthetic packs for queue volume checks", async () => {
  const commands = [];
  const eventBridgeClient = createMockEventBridgeClient((command) => {
    commands.push(command);

    return {
      FailedEntryCount: 0,
      Entries: command.input.Entries.map(() => ({}))
    };
  });
  const io = createMockIo(undefined, {
    env: {
      SIMULATOR_EVENT_BUS_NAME: "review-events",
      SIMULATOR_AWS_REGION: "ap-southeast-2",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/fake"
    },
    eventBridgeClient
  });

  const status = await runSimulatorCli([
    "publish-aws",
    "--scenario",
    "baseline-week",
    "--repeat",
    "3",
    "--batch-size",
    "10",
    "--confirm-aws-publish"
  ], io);

  assert.equal(status, 0);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands.map((command) => command.input.Entries.length), [10, 10, 7]);

  const firstDetail = JSON.parse(commands[0].input.Entries[0].Detail);
  const lastDetail = JSON.parse(commands[2].input.Entries.at(-1).Detail);

  assert.equal(firstDetail.sourceRecordId, "WO-2000-R0001");
  assert.equal(lastDetail.sourceRecordId, "CREW-MECH-2026-01-20-R0003");
  assert.equal(Object.hasOwn(firstDetail, "expectation"), false);

  const logs = parseJsonLines(io.stdoutText());

  assert.equal(logs[0].eventCount, 27);
  assert.equal(logs.at(-1).summary.publishedCount, 27);
});

test("publish-aws summarizes partial EventBridge failures without raw provider messages", async () => {
  const eventBridgeClient = createMockEventBridgeClient((command) => ({
    FailedEntryCount: 1,
    Entries: [
      {
        ErrorCode: "InternalFailure",
        ErrorMessage: "provider message that should not be logged"
      },
      ...command.input.Entries.slice(1).map(() => ({}))
    ]
  }));
  const io = createMockIo(undefined, {
    env: {
      SIMULATOR_EVENT_BUS_NAME: "review-events",
      SIMULATOR_AWS_REGION: "ap-southeast-2",
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/fake"
    },
    eventBridgeClient
  });

  await assert.rejects(
    () => runSimulatorCli([
      "publish-aws",
      "--scenario",
      "baseline-week",
      "--confirm-aws-publish"
    ], io),
    /AWS publish failed for batch 1\/1/
  );

  const stdout = io.stdoutText();

  assert.equal(stdout.includes("provider message that should not be logged"), false);

  const logs = parseJsonLines(stdout);

  assert.deepEqual(logs.map((entry) => entry.message), [
    "aws-publish-started",
    "aws-publish-batch-failed",
    "aws-publish-failed"
  ]);
  assert.equal(logs[1].failedCount, 1);
  assert.equal(logs[1].failedEntries[0].errorCode, "InternalFailure");
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

test("feed batching supports scaled deterministic synthetic packs", () => {
  const scenarioPack = generateScenarioPack("baseline-week", {
    repeat: 3
  });
  const batches = createMaintenanceEventFeedBatches(scenarioPack, {
    batchSize: 10
  });

  assert.equal(scenarioPack.events.length, 27);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.eventCount), [10, 10, 7]);
  assert.equal(
    batches[0].batchIdempotencyKey,
    `${scenarioPack.apiImport.batchIdempotencyKey}:batch-1-of-3`
  );
  assert.equal(batches[0].request.events[0].sourceRecordId, "WO-2000-R0001");
  assert.equal(batches[1].request.events[0].sourceRecordId, "WO-2001-R0002");
  assert.equal(Object.hasOwn(batches[0].request.events[0], "expectation"), false);
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
    "feed-test-correlation",
    "--api-token",
    "local-import-token"
  ], io);

  assert.equal(status, 0);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map((request) => request.body.events.length), [4, 4, 1]);
  assert.equal(requests[0].url, "http://localhost:5000/api/v1/imports/maintenance-events");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].headers["content-type"], "application/json");
  assert.equal(requests[0].headers["x-correlation-id"], "feed-test-correlation");
  assert.equal(requests[0].headers.authorization, "Bearer local-import-token");
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
  assert.equal(logs[0].authorizationConfigured, true);
  assert.equal(io.stdoutText().includes("local-import-token"), false);
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

function createMockIo(fetch, options = {}) {
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
    env: options.env ?? {},
    sleep: async () => {},
    stdoutText() {
      return stdout;
    }
  };

  if (fetch) {
    io.fetch = fetch;
  }

  if (options.eventBridgeClient) {
    io.eventBridgeClient = options.eventBridgeClient;
  }

  return io;
}

function createMockEventBridgeClient(send = (command) => ({
  FailedEntryCount: 0,
  Entries: command.input.Entries.map(() => ({}))
})) {
  return {
    send: async (command) => send(command)
  };
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
