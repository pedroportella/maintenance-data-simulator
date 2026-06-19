import { randomUUID } from "node:crypto";

import { summarizeScenarioPack } from "../contracts/scenario-contract.mjs";
import {
  generateScenarioPack,
  listScenarioIds
} from "../scenarios/scenario-generator.mjs";
import { loadLocalEnv } from "../../scripts/env-loader.mjs";

const DEFAULT_SCENARIO_ID = "baseline-week";
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_READINESS_TIMEOUT_MS = 30_000;

export async function runApiScenarioSmoke(argv, io = defaultIo()) {
  const args = parseOptions(argv, {
    booleanOptions: new Set(["help", "list"]),
    stringOptions: new Set([
      "scenario",
      "seed",
      "api-url",
      "batch-size",
      "timeout-ms",
      "readiness-timeout-ms",
      "correlation-id",
      "requested-by",
      "api-token"
    ])
  });

  if (args.options.help) {
    printApiSmokeUsage(io.stdout);
    return 0;
  }

  if (args.options.list) {
    io.stdout.write(`${listScenarioIds().join("\n")}\n`);
    return 0;
  }

  const scenarioId = getScenarioId(args);
  const apiUrl = args.options["api-url"] ?? io.env.SIMULATOR_API_URL;

  if (!apiUrl) {
    throw new ApiScenarioSmokeError("api-smoke requires --api-url or SIMULATOR_API_URL");
  }

  const scenarioPack = generateScenarioPack(scenarioId, { seed: args.options.seed });
  const smokeOptions = {
    apiUrl,
    batchSize: parseIntegerOption(args.options["batch-size"], "--batch-size", {
      defaultValue: DEFAULT_BATCH_SIZE,
      min: 1
    }),
    timeoutMs: parseIntegerOption(args.options["timeout-ms"], "--timeout-ms", {
      defaultValue: DEFAULT_TIMEOUT_MS,
      min: 1
    }),
    readinessTimeoutMs: parseIntegerOption(
      args.options["readiness-timeout-ms"],
      "--readiness-timeout-ms",
      {
        defaultValue: DEFAULT_READINESS_TIMEOUT_MS,
        min: 1
      }
    ),
    correlationId: args.options["correlation-id"] ?? createRunCorrelationId(scenarioPack),
    requestedBy: args.options["requested-by"] ?? "simulator-api-smoke",
    apiToken: getApiToken(args, io)
  };
  validateCorrelationId(smokeOptions.correlationId);

  await executeApiScenarioSmoke(scenarioPack, smokeOptions, io);
  return 0;
}

export async function executeApiScenarioSmoke(scenarioPack, options, io = defaultIo()) {
  const fetchImpl = options.fetch ?? io.fetch ?? fetch;
  const sleepImpl = options.sleep ?? io.sleep ?? sleep;
  const summary = summarizeScenarioPack(scenarioPack);
  const batches = createMaintenanceEventFeedBatches(scenarioPack, {
    batchSize: options.batchSize ?? DEFAULT_BATCH_SIZE
  });
  const requestOptions = {
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    correlationId: options.correlationId,
    apiToken: options.apiToken
  };
  const apiTarget = sanitizeUrlForLog(options.apiUrl);

  writeLog(io.stdout, {
    level: "info",
    command: "api-smoke",
    message: "api-smoke-started",
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    correlationId: options.correlationId,
    authorizationConfigured: Boolean(options.apiToken),
    eventCount: summary.eventCount,
    batchCount: batches.length
  });

  await waitForReadiness(options.apiUrl, {
    ...requestOptions,
    sleep: sleepImpl,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  });

  const expectedImportCounts = getExpectedImportCounts(scenarioPack);
  const firstFeed = await postMaintenanceEventBatches(scenarioPack, batches, options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    phase: "initial-feed"
  });
  assertImportCounts("Initial feed", firstFeed, expectedImportCounts);

  const replayFeed = await postMaintenanceEventBatches(scenarioPack, batches, options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    phase: "idempotency-replay"
  });
  assertImportCounts("Idempotency replay", replayFeed, expectedImportCounts);
  if (replayFeed.duplicateRequestCount !== replayFeed.batchCount) {
    throw new ApiScenarioSmokeError(
      `Idempotency replay drift: expected ${replayFeed.batchCount} duplicate request(s), received ${replayFeed.duplicateRequestCount}.`
    );
  }

  const planningRun = await createPlanningRun(scenarioPack, options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    requestedBy: options.requestedBy ?? "simulator-api-smoke"
  });

  const fetchedRun = await getPlanningRun(planningRun.location, options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget
  });
  assertPlanningRun(fetchedRun.body, scenarioPack);

  const recommendations = await getRecommendations(planningRun.body.id, options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget
  });
  const selectedRecommendation = findImportedRecommendation(recommendations.body, scenarioPack);

  const decision = await recordPackageDecision(selectedRecommendation, options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    requestedBy: options.requestedBy ?? "simulator-api-smoke"
  });
  assertDecision(
    decision.body,
    selectedRecommendation.packageId,
    selectedRecommendation.decision,
    options.requestedBy ?? "simulator-api-smoke"
  );

  const updatedRecommendations = await getRecommendations(planningRun.body.id, options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    phase: "decision-check"
  });
  assertUpdatedRecommendation(
    updatedRecommendations.body,
    selectedRecommendation.packageId,
    selectedRecommendation.expectedStatus
  );

  const posture = await getOperationsPosture(options.apiUrl, {
    ...requestOptions,
    stdout: io.stdout,
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    expectedImportKeys: batches.map((batch) => batch.batchIdempotencyKey),
    currentImportWasReplay: firstFeed.duplicateRequestCount === firstFeed.batchCount
  });

  writeLog(io.stdout, {
    level: "info",
    command: "api-smoke",
    message: "api-smoke-completed",
    scenarioId: scenarioPack.scenarioId,
    apiTarget,
    correlationId: options.correlationId,
    planningRunId: planningRun.body.id,
    selectedPackageId: selectedRecommendation.packageId,
    recommendationCount: recommendations.body.recommendations.length,
    operationsStatus: posture.body.status,
    importSummary: firstFeed,
    replaySummary: replayFeed
  });
}

export function createMaintenanceEventFeedBatches(scenarioPack, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

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

async function waitForReadiness(apiUrl, options) {
  const readinessUrl = resolveApiUrl(apiUrl, "/health/ready");
  const deadline = Date.now() + options.readinessTimeoutMs;
  let lastFailure = "timed out";

  while (Date.now() < deadline) {
    const response = await requestJson("GET", readinessUrl, undefined, {
      ...options,
      allowNonOk: true
    });

    if (response.ok) {
      writeLog(options.stdout, {
        level: "info",
        command: "api-smoke",
        message: "api-readiness-passed",
        scenarioId: options.scenarioId,
        apiTarget: options.apiTarget,
        correlationId: options.correlationId,
        httpStatus: response.status
      });
      return;
    }

    lastFailure = describeHttpResponse(response);
    await options.sleep(500);
  }

  throw new ApiScenarioSmokeError(
    `API unavailable or not ready: GET ${sanitizeUrlForLog(readinessUrl)} failed before timeout (${lastFailure}).`
  );
}

async function postMaintenanceEventBatches(scenarioPack, batches, apiUrl, options) {
  const importUrl = resolveApiUrl(apiUrl, scenarioPack.apiImport.endpoint);
  const aggregate = {
    batchCount: batches.length,
    receivedCount: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    ignoredDuplicateCount: 0,
    ignoredStaleCount: 0,
    duplicateRequestCount: 0
  };

  for (const batch of batches) {
    const response = await requestJson("POST", importUrl, batch.request, {
      ...options,
      allowNonOk: true
    });

    if (!response.ok) {
      writeLog(options.stdout, {
        level: "error",
        command: "api-smoke",
        message: "api-smoke-import-failed",
        scenarioId: options.scenarioId,
        phase: options.phase,
        apiTarget: options.apiTarget,
        correlationId: options.correlationId,
        batchNumber: batch.batchNumber,
        batchCount: batch.batchCount,
        batchIdempotencyKey: batch.batchIdempotencyKey,
        httpStatus: response.status,
        problem: summarizeProblem(response.body)
      });
      throw new ApiScenarioSmokeError(buildBoundaryFailure("Maintenance event import", response));
    }

    const result = response.body ?? {};

    aggregate.receivedCount += numberOrZero(result.receivedCount);
    aggregate.acceptedCount += numberOrZero(result.acceptedCount);
    aggregate.rejectedCount += numberOrZero(result.rejectedCount);
    aggregate.ignoredDuplicateCount += numberOrZero(result.ignoredDuplicateCount);
    aggregate.ignoredStaleCount += numberOrZero(result.ignoredStaleCount);
    aggregate.duplicateRequestCount += result.duplicateRequest ? 1 : 0;

    writeLog(options.stdout, {
      level: "info",
      command: "api-smoke",
      message: "api-smoke-import-batch-completed",
      scenarioId: options.scenarioId,
      phase: options.phase,
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
  }

  return aggregate;
}

async function createPlanningRun(scenarioPack, apiUrl, options) {
  const response = await requestJson(
    "POST",
    resolveApiUrl(apiUrl, "/api/v1/planning-runs"),
    {
      horizon: "two-week",
      horizonStartUtc: scenarioPack.planningHorizon.startUtc,
      horizonEndUtc: scenarioPack.planningHorizon.endUtc,
      requestedBy: options.requestedBy
    },
    {
      ...options,
      allowNonOk: true
    }
  );

  if (!response.ok || response.status !== 202) {
    throw new ApiScenarioSmokeError(buildBoundaryFailure("Planning run creation", response));
  }

  const location = getHeader(response.headers, "location");
  if (!location) {
    throw new ApiScenarioSmokeError("Planning run creation failed contract check: 202 response did not include Location.");
  }

  assertPlanningRun(response.body, scenarioPack);

  writeLog(options.stdout, {
    level: "info",
    command: "api-smoke",
    message: "api-smoke-planning-run-created",
    scenarioId: options.scenarioId,
    apiTarget: options.apiTarget,
    correlationId: options.correlationId,
    planningRunId: response.body.id,
    location,
    recommendationCount: response.body.recommendationCount,
    readyRecommendationCount: response.body.readyRecommendationCount,
    blockedRecommendationCount: response.body.blockedRecommendationCount
  });

  return {
    body: response.body,
    location
  };
}

async function getPlanningRun(location, apiUrl, options) {
  const response = await requestJson("GET", resolveApiLocation(apiUrl, location), undefined, {
    ...options,
    allowNonOk: true
  });

  if (!response.ok) {
    throw new ApiScenarioSmokeError(buildBoundaryFailure("Planning run fetch", response));
  }

  writeLog(options.stdout, {
    level: "info",
    command: "api-smoke",
    message: "api-smoke-planning-run-fetched",
    scenarioId: options.scenarioId,
    apiTarget: options.apiTarget,
    correlationId: options.correlationId,
    planningRunId: response.body?.id,
    status: response.body?.status
  });

  return response;
}

async function getRecommendations(planningRunId, apiUrl, options) {
  const response = await requestJson(
    "GET",
    resolveApiUrl(apiUrl, `/api/v1/planning-runs/${planningRunId}/recommendations`),
    undefined,
    {
      ...options,
      allowNonOk: true
    }
  );

  if (!response.ok) {
    throw new ApiScenarioSmokeError(buildBoundaryFailure("Planning recommendations fetch", response));
  }

  assertRecommendationsShape(response.body);

  writeLog(options.stdout, {
    level: "info",
    command: "api-smoke",
    message: options.phase === "decision-check"
      ? "api-smoke-recommendations-refetched"
      : "api-smoke-recommendations-fetched",
    scenarioId: options.scenarioId,
    apiTarget: options.apiTarget,
    correlationId: options.correlationId,
    planningRunId,
    recommendationCount: response.body.recommendations.length
  });

  return response;
}

async function recordPackageDecision(recommendation, apiUrl, options) {
  const response = await requestJson(
    "POST",
    resolveApiUrl(apiUrl, `/api/v1/packages/${recommendation.packageId}/decisions`),
    {
      decision: recommendation.decision,
      reasonCode: "simulator-api-smoke",
      notes: "Synthetic planner decision for local review.",
      decidedBy: options.requestedBy
    },
    {
      ...options,
      allowNonOk: true
    }
  );

  if (!response.ok) {
    throw new ApiScenarioSmokeError(buildBoundaryFailure("Package decision", response));
  }

  writeLog(options.stdout, {
    level: "info",
    command: "api-smoke",
    message: "api-smoke-package-decision-recorded",
    scenarioId: options.scenarioId,
    apiTarget: options.apiTarget,
    correlationId: options.correlationId,
    packageId: recommendation.packageId,
    decision: recommendation.decision,
    packageStatus: response.body?.packageStatus
  });

  return response;
}

async function getOperationsPosture(apiUrl, options) {
  const response = await requestJson(
    "GET",
    resolveApiUrl(apiUrl, "/api/v1/operations/posture"),
    undefined,
    {
      ...options,
      allowNonOk: true
    }
  );

  if (!response.ok) {
    throw new ApiScenarioSmokeError(buildBoundaryFailure("Operations posture fetch", response));
  }

  assertOperationsPosture(response.body, options.expectedImportKeys, options.currentImportWasReplay);

  writeLog(options.stdout, {
    level: "info",
    command: "api-smoke",
    message: "api-smoke-operations-posture-fetched",
    scenarioId: options.scenarioId,
    apiTarget: options.apiTarget,
    correlationId: options.correlationId,
    status: response.body.status,
    latestImportKind: response.body.latestImport?.importKind
  });

  return response;
}

async function requestJson(method, url, body, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-correlation-id": options.correlationId,
        ...authorizationHeader(options.apiToken)
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal
    });
    const rawText = await response.text();
    const parsed = parseJsonOrText(rawText);

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: parsed
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiScenarioSmokeError(`API request timed out: ${method} ${sanitizeUrlForLog(url)}`);
    }

    throw new ApiScenarioSmokeError(`API request failed: ${method} ${sanitizeUrlForLog(url)} (${cleanOptionalString(error?.message, 180) ?? "network failure"}).`);
  } finally {
    clearTimeout(timeout);
  }
}

function assertImportCounts(label, actual, expected) {
  const mismatches = [];

  for (const key of [
    "receivedCount",
    "acceptedCount",
    "rejectedCount",
    "ignoredDuplicateCount",
    "ignoredStaleCount"
  ]) {
    if (actual[key] !== expected[key]) {
      mismatches.push(`${key} expected ${expected[key]}, received ${actual[key]}`);
    }
  }

  if (mismatches.length > 0) {
    throw new ApiScenarioSmokeError(`${label} count mismatch: ${mismatches.join("; ")}.`);
  }
}

function assertPlanningRun(run, scenarioPack) {
  const failures = [];

  if (!isPlainObject(run)) failures.push("body must be an object");
  if (typeof run?.id !== "string" || run.id.length === 0) failures.push("id is missing");
  if (run?.status !== "Completed") failures.push(`status expected Completed, received ${run?.status ?? "missing"}`);
  if (!sameInstant(run?.horizonStartUtc, scenarioPack.planningHorizon.startUtc)) {
    failures.push("horizonStartUtc does not match the scenario horizon");
  }
  if (!sameInstant(run?.horizonEndUtc, scenarioPack.planningHorizon.endUtc)) {
    failures.push("horizonEndUtc does not match the scenario horizon");
  }
  if (!Number.isInteger(run?.recommendationCount) || run.recommendationCount < 1) {
    failures.push("recommendationCount must be at least 1");
  }

  if (failures.length > 0) {
    throw new ApiScenarioSmokeError(`Planning run contract check failed: ${failures.join("; ")}.`);
  }
}

function assertRecommendationsShape(body) {
  if (!isPlainObject(body) || !Array.isArray(body.recommendations)) {
    throw new ApiScenarioSmokeError("Planning recommendations contract check failed: recommendations[] is missing.");
  }

  if (body.recommendations.length === 0) {
    throw new ApiScenarioSmokeError("Missing recommendations: the planning run returned no package recommendations.");
  }
}

function findImportedRecommendation(body, scenarioPack) {
  assertRecommendationsShape(body);

  const readySourceIds = new Set(scenarioPack.expectedOutcomes.readyWorkOrderSourceIds ?? []);
  const recommendation = body.recommendations.find((item) =>
    Array.isArray(item.workOrders)
    && item.workOrders.some((workOrder) => readySourceIds.has(workOrder.sourceId))
  );

  if (!recommendation) {
    throw new ApiScenarioSmokeError(
      `Missing recommendations: no package included imported work order(s) ${[...readySourceIds].join(", ")}.`
    );
  }

  if (!Array.isArray(recommendation.blockers) || !isPlainObject(recommendation.sourceDataReadiness)) {
    throw new ApiScenarioSmokeError("Planning recommendations contract check failed: blocker or readiness details are missing.");
  }

  if (typeof recommendation.packageId !== "string" || recommendation.packageId.length === 0) {
    throw new ApiScenarioSmokeError("Planning recommendations contract check failed: packageId is missing.");
  }

  const decision = recommendation.actionability === "ready-now" ? "Accepted" : "Deferred";

  return {
    ...recommendation,
    decision,
    expectedStatus: decision
  };
}

function assertDecision(body, packageId, decision, requestedBy) {
  const decisions = Array.isArray(body?.decisions) ? body.decisions : [];
  const matchingDecision = decisions.find((item) =>
    item.packageId === packageId
    && item.decision === decision
    && item.reasonCode === "simulator-api-smoke"
    && item.decidedBy === requestedBy
  );

  if (body?.packageStatus !== decision || !matchingDecision) {
    throw new ApiScenarioSmokeError(`Package decision contract check failed: ${decision} decision audit row was not returned.`);
  }
}

function assertUpdatedRecommendation(body, packageId, expectedStatus) {
  const updated = body.recommendations.find((item) => item.packageId === packageId);

  if (!updated || updated.status !== expectedStatus) {
    throw new ApiScenarioSmokeError(`Package decision verification failed: recommendation status did not update to ${expectedStatus}.`);
  }

  if (!Array.isArray(updated.decisions) || !updated.decisions.some((item) => item.decision === expectedStatus)) {
    throw new ApiScenarioSmokeError("Package decision verification failed: recommendation decision audit row is missing.");
  }
}

function assertOperationsPosture(body, expectedImportKeys, currentImportWasReplay) {
  if (
    !isPlainObject(body)
    || body.databaseConfigured !== true
    || !["healthy", "ready"].includes(body.status)
  ) {
    throw new ApiScenarioSmokeError("Operations posture check failed: databaseConfigured=true and status=healthy were expected.");
  }

  if (!isPlainObject(body.latestImport) || body.latestImport.importKind !== "maintenance-events") {
    throw new ApiScenarioSmokeError("Operations posture check failed: latest maintenance event import was not reported.");
  }

  if (!currentImportWasReplay && !expectedImportKeys.includes(body.latestImport.idempotencyKey)) {
    throw new ApiScenarioSmokeError("Operations posture check failed: latest import does not match the scenario feed.");
  }
}

function getExpectedImportCounts(scenarioPack) {
  const counts = {
    receivedCount: scenarioPack.events.length,
    acceptedCount: 0,
    rejectedCount: 0,
    ignoredDuplicateCount: 0,
    ignoredStaleCount: 0
  };

  for (const event of scenarioPack.events) {
    const disposition = event.expectation?.importDisposition;

    if (disposition === "accepted" || disposition === "accepted-blocked") {
      counts.acceptedCount += 1;
    } else if (disposition === "rejected") {
      counts.rejectedCount += 1;
    } else if (disposition === "ignored-duplicate") {
      counts.ignoredDuplicateCount += 1;
    } else if (disposition === "ignored-stale") {
      counts.ignoredStaleCount += 1;
    }
  }

  return counts;
}

function buildBoundaryFailure(label, response) {
  const description = describeHttpResponse(response);

  if (response.status === 422) {
    return `${label} validation failure: ${description}`;
  }

  if (response.status === 409) {
    return `${label} idempotency drift: ${description}`;
  }

  if (response.status === 503) {
    return `${label} API unavailable: ${description}`;
  }

  return `${label} API boundary failed: ${description}`;
}

function describeHttpResponse(response) {
  const statusText = response.statusText ? ` ${response.statusText}` : "";
  const problem = summarizeProblem(response.body);
  const problemParts = [
    problem.code ? `code=${problem.code}` : undefined,
    problem.title ? `title=${problem.title}` : undefined,
    problem.detail ? `detail=${problem.detail}` : undefined
  ].filter(Boolean);

  return `${response.status}${statusText}${problemParts.length > 0 ? ` (${problemParts.join("; ")})` : ""}`;
}

function summarizeProblem(body) {
  if (!isPlainObject(body)) return {};

  return {
    code: cleanOptionalString(body.code ?? body.extensions?.code, 120),
    title: cleanOptionalString(body.title, 160),
    detail: cleanOptionalString(body.detail, 240)
  };
}

function parseJsonOrText(rawText) {
  if (!rawText) return undefined;

  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function getHeader(headers, name) {
  if (!headers) return undefined;

  if (typeof headers.get === "function") {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? undefined;
  }

  return headers[name] ?? headers[name.toLowerCase()];
}

function createRunCorrelationId(scenarioPack) {
  return `api-smoke-${scenarioPack.scenarioId}-${randomUUID().slice(0, 8)}`;
}

function resolveApiLocation(apiUrl, location) {
  if (/^https?:\/\//i.test(location)) {
    return sanitizeUrlForRequest(location);
  }

  return resolveApiUrl(apiUrl, location);
}

function resolveApiUrl(apiUrl, endpoint) {
  const parsed = parseApiUrl(apiUrl);
  const endpointPath = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const currentPath = parsed.pathname.endsWith("/")
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;

  parsed.pathname = `${currentPath === "" ? "" : currentPath}${endpointPath}`;

  return parsed.toString();
}

function sanitizeUrlForRequest(rawUrl) {
  return parseApiUrl(rawUrl).toString();
}

function sanitizeUrlForLog(rawUrl) {
  try {
    return parseApiUrl(rawUrl).toString();
  } catch {
    return "invalid-url";
  }
}

function parseApiUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ApiScenarioSmokeError("api-url must be an absolute URL");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.search = "";
  parsed.hash = "";

  return parsed;
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

function getScenarioId(args) {
  if (args.positionals.length > 1) {
    throw new ApiScenarioSmokeError(`Unexpected extra argument: ${args.positionals[1]}`);
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
      throw new ApiScenarioSmokeError(`Unknown option: ${arg}`);
    }

    const equalsIndex = arg.indexOf("=");
    const rawName = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : arg.slice(equalsIndex + 1);
    const name = rawName.trim();

    if (spec.booleanOptions.has(name)) {
      if (inlineValue !== undefined) {
        throw new ApiScenarioSmokeError(`--${name} does not accept a value`);
      }
      parsed.options[name] = true;
      continue;
    }

    if (spec.stringOptions.has(name)) {
      const value = inlineValue ?? argv[index + 1];

      if (!value || value.startsWith("-")) {
        throw new ApiScenarioSmokeError(`--${name} requires a value`);
      }

      parsed.options[name] = value;

      if (inlineValue === undefined) {
        index += 1;
      }

      continue;
    }

    throw new ApiScenarioSmokeError(`Unknown option: --${name}`);
  }

  return parsed;
}

function parseIntegerOption(rawValue, optionName, { defaultValue, min }) {
  if (rawValue === undefined) {
    return defaultValue;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw new ApiScenarioSmokeError(`${optionName} must be an integer`);
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < min) {
    throw new ApiScenarioSmokeError(`${optionName} must be greater than or equal to ${min}`);
  }

  return value;
}

function validateCorrelationId(correlationId) {
  if (typeof correlationId !== "string" || correlationId.trim().length === 0) {
    throw new ApiScenarioSmokeError("--correlation-id must not be blank");
  }

  if (correlationId.length > 160) {
    throw new ApiScenarioSmokeError("--correlation-id must be 160 characters or fewer");
  }
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
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

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameInstant(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }

  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);

  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
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

function printApiSmokeUsage(stream) {
  stream.write(`Usage:
  simulator api-smoke --scenario baseline-week --api-url http://localhost:5000
  node scripts/api-scenario-smoke.mjs --scenario baseline-week --api-url http://localhost:5000

Environment:
  SIMULATOR_API_URL may provide the API URL when --api-url is omitted.
  SIMULATOR_API_TOKEN may provide a bearer token for protected local API routes.

Options:
  --batch-size value             Number of events per HTTP batch. Default: ${DEFAULT_BATCH_SIZE}.
  --timeout-ms value             Per-request timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --readiness-timeout-ms value   Total readiness wait. Default: ${DEFAULT_READINESS_TIMEOUT_MS}.
  --correlation-id value         HTTP correlation id for this simulator smoke.
  --requested-by value           Planner audit actor for the synthetic decision.
  --api-token value              Bearer token for protected local API routes.
`);
}

function defaultIo() {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    env: loadLocalEnv()
  };
}

export class ApiScenarioSmokeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApiScenarioSmokeError";
    this.exitCode = 2;
  }
}
