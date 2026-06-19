import assert from "node:assert/strict";
import test from "node:test";

import {
  runApiScenarioSmoke
} from "../src/api/api-scenario-smoke.mjs";

const runId = "11111111-1111-1111-1111-111111111111";
const packageId = "22222222-2222-2222-2222-222222222222";

test("api-smoke feeds a scenario, replays idempotently, plans, recommends and records a decision", async () => {
  const calls = [];
  const io = createMockIo(async (url, options) => {
    const call = recordCall(calls, url, options);

    if (call.method === "GET" && call.pathname === "/health/ready") {
      return jsonResponse({ status: "Healthy" });
    }

    if (call.method === "POST" && call.pathname === "/api/v1/imports/maintenance-events") {
      return jsonResponse(importResult({
        duplicateRequest: calls.filter((item) => item.pathname === call.pathname).length > 1
      }));
    }

    if (call.method === "POST" && call.pathname === "/api/v1/planning-runs") {
      assert.equal(call.body.requestedBy, "smoke-test");
      assert.equal(call.body.horizonStartUtc, "2026-01-16T00:00:00Z");
      return jsonResponse(planningRun(), {
        status: 202,
        statusText: "Accepted",
        headers: {
          location: `/api/v1/planning-runs/${runId}`
        }
      });
    }

    if (call.method === "GET" && call.pathname === `/api/v1/planning-runs/${runId}`) {
      return jsonResponse(planningRun());
    }

    if (call.method === "GET" && call.pathname === `/api/v1/planning-runs/${runId}/recommendations`) {
      const decisionRecorded = calls.some((item) => item.pathname === `/api/v1/packages/${packageId}/decisions`);
      return jsonResponse(recommendations({
        status: decisionRecorded ? "Deferred" : "Recommended",
        decisions: decisionRecorded ? [decision()] : []
      }));
    }

    if (call.method === "POST" && call.pathname === `/api/v1/packages/${packageId}/decisions`) {
      assert.equal(call.body.decision, "Deferred");
      assert.equal(call.body.reasonCode, "simulator-api-smoke");
      assert.equal(call.body.decidedBy, "smoke-test");
      return jsonResponse({
        packageId,
        packageNumber: "PKG-2000",
        packageStatus: "Deferred",
        decisions: [decision()]
      });
    }

    if (call.method === "GET" && call.pathname === "/api/v1/operations/posture") {
      const importCall = calls.find((item) => item.pathname === "/api/v1/imports/maintenance-events");
      return jsonResponse({
        databaseConfigured: true,
        status: "healthy",
        latestImport: {
          importKind: "maintenance-events",
          idempotencyKey: importCall.body.batchIdempotencyKey
        }
      });
    }

    throw new Error(`Unexpected request: ${call.method} ${call.pathname}`);
  });

  const status = await runApiScenarioSmoke([
    "--api-url",
    "http://user:secret@localhost:5000?token=hidden#fragment",
    "--correlation-id",
    "api-smoke-test",
    "--requested-by",
    "smoke-test",
    "--readiness-timeout-ms",
    "1",
    "--api-token",
    "local-reviewer-token"
  ], io);

  assert.equal(status, 0);
  assert.equal(calls.every((call) => call.headers["x-correlation-id"] === "api-smoke-test"), true);
  assert.equal(calls.every((call) => call.headers.authorization === "Bearer local-reviewer-token"), true);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.pathname}`), [
    "GET /health/ready",
    "POST /api/v1/imports/maintenance-events",
    "POST /api/v1/imports/maintenance-events",
    "POST /api/v1/planning-runs",
    `GET /api/v1/planning-runs/${runId}`,
    `GET /api/v1/planning-runs/${runId}/recommendations`,
    `POST /api/v1/packages/${packageId}/decisions`,
    `GET /api/v1/planning-runs/${runId}/recommendations`,
    "GET /api/v1/operations/posture"
  ]);

  const stdout = io.stdoutText();
  assert.equal(stdout.includes("secret"), false);
  assert.equal(stdout.includes("hidden"), false);
  assert.equal(stdout.includes("local-reviewer-token"), false);

  const logs = parseJsonLines(stdout);
  assert.equal(logs[0].authorizationConfigured, true);
  assert.equal(logs.at(-1).message, "api-smoke-completed");
  assert.equal(logs.at(-1).replaySummary.duplicateRequestCount, 1);
});

test("api-smoke reports unavailable API readiness with a useful boundary message", async () => {
  const io = createMockIo(async () => jsonResponse({
    code: "database-not-ready",
    title: "Database is not ready."
  }, {
    ok: false,
    status: 503,
    statusText: "Service Unavailable"
  }));

  await assert.rejects(
    () => runApiScenarioSmoke([
      "--api-url",
      "http://localhost:5000",
      "--correlation-id",
      "api-smoke-unavailable",
      "--readiness-timeout-ms",
      "1"
    ], io),
    /API unavailable or not ready/
  );
});

test("api-smoke reports idempotency drift when the API rejects a replay", async () => {
  let importCallCount = 0;
  const io = createMockIo(async (url, options) => {
    const call = recordCall([], url, options);

    if (call.method === "GET" && call.pathname === "/health/ready") {
      return jsonResponse({ status: "Healthy" });
    }

    if (call.method === "POST" && call.pathname === "/api/v1/imports/maintenance-events") {
      importCallCount += 1;

      if (importCallCount === 1) {
        return jsonResponse(importResult({ duplicateRequest: false }));
      }

      return jsonResponse({
        code: "idempotency-conflict",
        title: "Import idempotency conflict."
      }, {
        ok: false,
        status: 409,
        statusText: "Conflict"
      });
    }

    throw new Error(`Unexpected request: ${call.method} ${call.pathname}`);
  });

  await assert.rejects(
    () => runApiScenarioSmoke([
      "--api-url",
      "http://localhost:5000",
      "--correlation-id",
      "api-smoke-idempotency"
    ], io),
    /idempotency drift/
  );
});

test("api-smoke fails when recommendations do not include the imported ready work order", async () => {
  let importCallCount = 0;
  const io = createMockIo(async (url, options) => {
    const call = recordCall([], url, options);

    if (call.method === "GET" && call.pathname === "/health/ready") {
      return jsonResponse({ status: "Healthy" });
    }

    if (call.method === "POST" && call.pathname === "/api/v1/imports/maintenance-events") {
      importCallCount += 1;
      return jsonResponse(importResult({ duplicateRequest: importCallCount > 1 }));
    }

    if (call.method === "POST" && call.pathname === "/api/v1/planning-runs") {
      return jsonResponse(planningRun(), {
        status: 202,
        statusText: "Accepted",
        headers: {
          location: `/api/v1/planning-runs/${runId}`
        }
      });
    }

    if (call.method === "GET" && call.pathname === `/api/v1/planning-runs/${runId}`) {
      return jsonResponse(planningRun());
    }

    if (call.method === "GET" && call.pathname === `/api/v1/planning-runs/${runId}/recommendations`) {
      return jsonResponse(recommendations({
        workOrderSourceId: "WO-OTHER"
      }));
    }

    throw new Error(`Unexpected request: ${call.method} ${call.pathname}`);
  });

  await assert.rejects(
    () => runApiScenarioSmoke([
      "--api-url",
      "http://localhost:5000",
      "--correlation-id",
      "api-smoke-missing-recommendations"
    ], io),
    /Missing recommendations/
  );
});

function createMockIo(fetch) {
  let stdout = "";

  return {
    stdout: {
      write(chunk) {
        stdout += chunk;
      }
    },
    stderr: {
      write() {}
    },
    env: {},
    fetch,
    sleep: async () => {},
    stdoutText() {
      return stdout;
    }
  };
}

function recordCall(calls, url, options) {
  const parsed = new URL(url);
  const call = {
    url,
    pathname: parsed.pathname,
    method: options.method,
    headers: options.headers,
    body: options.body ? JSON.parse(options.body) : undefined
  };

  calls.push(call);
  return call;
}

function importResult({ duplicateRequest }) {
  return {
    importKind: "maintenance-events",
    idempotencyKey: "baseline-week-fdf63e4f",
    receivedCount: 9,
    acceptedCount: 6,
    rejectedCount: 1,
    ignoredDuplicateCount: 1,
    ignoredStaleCount: 1,
    duplicateRequest,
    events: []
  };
}

function planningRun() {
  return {
    id: runId,
    runNumber: "PLAN-2000",
    status: "Completed",
    horizon: "two-week",
    horizonStartUtc: "2026-01-16T00:00:00Z",
    horizonEndUtc: "2026-01-30T00:00:00Z",
    requestedBy: "smoke-test",
    recommendationCount: 1,
    readyRecommendationCount: 1,
    blockedRecommendationCount: 0
  };
}

function recommendations(options = {}) {
  return {
    planningRunId: runId,
    runNumber: "PLAN-2000",
    status: "Completed",
    recommendations: [
      {
        packageId,
        packageNumber: "PKG-2000",
        title: "Replace pump seals",
        status: options.status ?? "Recommended",
        score: 85,
        actionability: "blocked",
        estimatedHours: 8.5,
        explanation: "Synthetic recommendation.",
        sourceDataReadiness: {
          overallStatus: "Ready",
          readyCount: 1,
          needsReviewCount: 0,
          blockedCount: 0,
          summary: "1 ready, 0 need review, 0 blocked."
        },
        blockers: [],
        workOrders: [
          {
            id: "33333333-3333-3333-3333-333333333333",
            sourceSystem: "synthetic-source",
            sourceId: options.workOrderSourceId ?? "WO-2000",
            workOrderNumber: options.workOrderSourceId ?? "WO-2000",
            title: "Replace pump seals",
            workType: "corrective",
            priority: "high",
            status: "ReadyForPlanning",
            readiness: "Ready"
          }
        ],
        decisions: options.decisions ?? []
      }
    ]
  };
}

function decision() {
  return {
    id: "44444444-4444-4444-4444-444444444444",
    packageId,
    decision: "Deferred",
    reasonCode: "simulator-api-smoke",
    decidedBy: "smoke-test",
    decidedAtUtc: "2026-01-15T00:00:00Z"
  };
}

function jsonResponse(body, options = {}) {
  const status = options.status ?? 200;

  return {
    ok: options.ok ?? (status >= 200 && status < 300),
    status,
    statusText: options.statusText ?? "OK",
    headers: options.headers ?? {},
    text: async () => JSON.stringify(body)
  };
}

function parseJsonLines(stdout) {
  return stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
