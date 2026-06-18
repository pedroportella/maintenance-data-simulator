export const CONTRACT_SCHEMA_VERSION = "1.0";

export const EVENT_TYPES = Object.freeze([
  "WorkOrderCreated",
  "WorkOrderUpdated",
  "WorkOrderStatusChanged",
  "MajorEventWindowPublished",
  "PartsAvailabilityChanged",
  "CrewCapacityChanged"
]);

export const WORK_ORDER_EVENT_TYPES = Object.freeze([
  "WorkOrderCreated",
  "WorkOrderUpdated",
  "WorkOrderStatusChanged"
]);

export const SOURCE_DATA_READINESS = Object.freeze([
  "Ready",
  "NeedsReview",
  "Blocked"
]);

export const WORK_ORDER_LIFECYCLE_STATUSES = Object.freeze([
  "Imported",
  "ReadyForPlanning",
  "Packaged",
  "DecisionRecorded",
  "Deferred",
  "Closed"
]);

export const IMPORT_DISPOSITIONS = Object.freeze([
  "accepted",
  "accepted-blocked",
  "rejected",
  "ignored-duplicate",
  "ignored-stale"
]);

export const EVENT_PAYLOAD_SCHEMA_BY_TYPE = Object.freeze({
  WorkOrderCreated: "schemas/payloads/work-order-event-payload.schema.json",
  WorkOrderUpdated: "schemas/payloads/work-order-event-payload.schema.json",
  WorkOrderStatusChanged: "schemas/payloads/work-order-event-payload.schema.json",
  MajorEventWindowPublished: "schemas/payloads/major-event-window-payload.schema.json",
  PartsAvailabilityChanged: "schemas/payloads/parts-availability-payload.schema.json",
  CrewCapacityChanged: "schemas/payloads/crew-capacity-payload.schema.json"
});

const SCENARIO_KEYS = new Set([
  "scenarioId",
  "name",
  "description",
  "schemaVersion",
  "seed",
  "referenceTimeUtc",
  "sourceSystem",
  "apiImport",
  "planningHorizon",
  "events",
  "expectedOutcomes"
]);

const EVENT_KEYS = new Set([
  "eventId",
  "eventType",
  "schemaVersion",
  "sourceSystem",
  "sourceRecordId",
  "correlationId",
  "occurredAt",
  "publishedAt",
  "idempotencyKey",
  "payload",
  "expectation"
]);

const EXPECTATION_KEYS = new Set([
  "importDisposition",
  "readiness",
  "validationIssues",
  "reason"
]);

const READINESS_KEYS = new Set([
  "status",
  "issueCode",
  "issueDetail",
  "validationIssues"
]);

const VALIDATION_ISSUE_KEYS = new Set([
  "code",
  "severity",
  "sourceField",
  "detail"
]);

const WORK_ORDER_PAYLOAD_KEYS = new Set([
  "sourceSystem",
  "sourceId",
  "workOrderNumber",
  "title",
  "workType",
  "priority",
  "lifecycleStatus",
  "assetSourceId",
  "functionalLocationSourceId",
  "requiredStartUtc",
  "dueAtUtc",
  "scheduledStartUtc",
  "estimatedHours",
  "sourceUpdatedAtUtc",
  "sourceDataReadiness",
  "validationIssues"
]);

const MAJOR_EVENT_PAYLOAD_KEYS = new Set([
  "sourceSystem",
  "sourceId",
  "eventType",
  "title",
  "severity",
  "assetSourceId",
  "functionalLocationSourceId",
  "startsAtUtc",
  "endsAtUtc",
  "sourceUpdatedAtUtc",
  "sourceDataReadiness",
  "validationIssues"
]);

const PARTS_PAYLOAD_KEYS = new Set([
  "sourceSystem",
  "sourceId",
  "workOrderSourceId",
  "partNumber",
  "partName",
  "availabilityStatus",
  "requiredQuantity",
  "availableQuantity",
  "neededByUtc",
  "sourceUpdatedAtUtc",
  "sourceDataReadiness",
  "validationIssues"
]);

const CREW_PAYLOAD_KEYS = new Set([
  "sourceSystem",
  "sourceId",
  "crewId",
  "crewName",
  "discipline",
  "capacityDate",
  "availableHours",
  "reservedHours",
  "sourceUpdatedAtUtc",
  "sourceDataReadiness",
  "validationIssues"
]);

export function assertScenarioPack(scenarioPack) {
  const result = validateScenarioPack(scenarioPack);

  if (!result.ok) {
    const details = result.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n");
    throw new Error(`Scenario pack contract validation failed:\n${details}`);
  }

  return scenarioPack;
}

export function validateScenarioPack(scenarioPack) {
  const issues = [];

  if (!isPlainObject(scenarioPack)) {
    addIssue(issues, "$", "must be an object");
    return toResult(issues);
  }

  rejectUnknownKeys(issues, "$", scenarioPack, SCENARIO_KEYS);
  requireString(issues, "$.scenarioId", scenarioPack.scenarioId, { maxLength: 120 });
  requireString(issues, "$.name", scenarioPack.name, { maxLength: 160 });
  optionalString(issues, "$.description", scenarioPack.description, { maxLength: 500 });
  requireConst(issues, "$.schemaVersion", scenarioPack.schemaVersion, CONTRACT_SCHEMA_VERSION);
  requireString(issues, "$.seed", scenarioPack.seed, { maxLength: 160 });
  requireIsoDateTime(issues, "$.referenceTimeUtc", scenarioPack.referenceTimeUtc);
  requireString(issues, "$.sourceSystem", scenarioPack.sourceSystem, { maxLength: 80 });
  validateApiImport(issues, "$.apiImport", scenarioPack.apiImport);
  validatePlanningHorizon(issues, "$.planningHorizon", scenarioPack.planningHorizon);
  validateExpectedOutcomes(issues, "$.expectedOutcomes", scenarioPack.expectedOutcomes);

  if (!Array.isArray(scenarioPack.events) || scenarioPack.events.length === 0) {
    addIssue(issues, "$.events", "must contain at least one event");
    return toResult(issues);
  }

  const eventIds = new Set();
  const idempotencyKeys = new Set();
  const sourceUpdatedAtByRecord = new Map();

  scenarioPack.events.forEach((event, index) => {
    const path = `$.events[${index}]`;
    validateScenarioEvent(issues, path, event, {
      scenarioSourceSystem: scenarioPack.sourceSystem,
      eventIds,
      idempotencyKeys,
      sourceUpdatedAtByRecord
    });
  });

  validateExpectedOutcomeReferences(issues, scenarioPack);

  return toResult(issues);
}

export function validateMaintenanceEventEnvelope(event, options = {}) {
  const issues = [];
  validateEnvelopeFields(issues, "$", event, options);
  return toResult(issues);
}

export function summarizeScenarioPack(scenarioPack) {
  const events = Array.isArray(scenarioPack?.events) ? scenarioPack.events : [];
  const eventCounts = {};
  const dispositionCounts = {};

  for (const event of events) {
    eventCounts[event.eventType] = (eventCounts[event.eventType] ?? 0) + 1;
    const disposition = event.expectation?.importDisposition ?? "unspecified";
    dispositionCounts[disposition] = (dispositionCounts[disposition] ?? 0) + 1;
  }

  return {
    scenarioId: scenarioPack?.scenarioId,
    schemaVersion: scenarioPack?.schemaVersion,
    seed: scenarioPack?.seed,
    eventCount: events.length,
    eventCounts,
    dispositionCounts
  };
}

function validateScenarioEvent(issues, path, event, context) {
  if (!isPlainObject(event)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  rejectUnknownKeys(issues, path, event, EVENT_KEYS);
  validateEnvelopeFields(issues, path, event);

  if (event.sourceSystem !== context.scenarioSourceSystem) {
    addIssue(issues, `${path}.sourceSystem`, "must match the scenario sourceSystem");
  }

  if (context.eventIds.has(event.eventId)) {
    addIssue(issues, `${path}.eventId`, "must be unique within a scenario pack");
  }
  context.eventIds.add(event.eventId);

  validatePayloadForEventType(issues, `${path}.payload`, event);
  validateExpectation(issues, `${path}.expectation`, event.expectation);
  validateEnvelopePayloadAlignment(issues, path, event);
  validateDispositionSemantics(issues, path, event, context);
}

function validateEnvelopeFields(issues, path, event) {
  if (!isPlainObject(event)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  requireString(issues, `${path}.eventId`, event.eventId, { maxLength: 160 });
  requireEnum(issues, `${path}.eventType`, event.eventType, EVENT_TYPES);
  requireConst(issues, `${path}.schemaVersion`, event.schemaVersion, CONTRACT_SCHEMA_VERSION);
  requireString(issues, `${path}.sourceSystem`, event.sourceSystem, { maxLength: 80 });
  requireString(issues, `${path}.sourceRecordId`, event.sourceRecordId, { maxLength: 120 });
  requireString(issues, `${path}.correlationId`, event.correlationId, { maxLength: 160 });
  requireIsoDateTime(issues, `${path}.occurredAt`, event.occurredAt);
  requireIsoDateTime(issues, `${path}.publishedAt`, event.publishedAt);
  requireString(issues, `${path}.idempotencyKey`, event.idempotencyKey, { maxLength: 160 });

  if (!isPlainObject(event.payload)) {
    addIssue(issues, `${path}.payload`, "must be an object");
  }

  if (isIsoDateTime(event.occurredAt) && isIsoDateTime(event.publishedAt)) {
    if (Date.parse(event.publishedAt) < Date.parse(event.occurredAt)) {
      addIssue(issues, `${path}.publishedAt`, "must not be earlier than occurredAt");
    }
  }
}

function validatePayloadForEventType(issues, path, event) {
  if (!isPlainObject(event.payload)) return;

  if (WORK_ORDER_EVENT_TYPES.includes(event.eventType)) {
    validateWorkOrderPayload(issues, path, event.payload);
    return;
  }

  if (event.eventType === "MajorEventWindowPublished") {
    validateMajorEventPayload(issues, path, event.payload);
    return;
  }

  if (event.eventType === "PartsAvailabilityChanged") {
    validatePartsPayload(issues, path, event.payload);
    return;
  }

  if (event.eventType === "CrewCapacityChanged") {
    validateCrewPayload(issues, path, event.payload);
  }
}

function validateWorkOrderPayload(issues, path, payload) {
  rejectUnknownKeys(issues, path, payload, WORK_ORDER_PAYLOAD_KEYS);
  requireString(issues, `${path}.sourceSystem`, payload.sourceSystem, { maxLength: 80 });
  requireString(issues, `${path}.sourceId`, payload.sourceId, { maxLength: 120 });
  requireString(issues, `${path}.workOrderNumber`, payload.workOrderNumber, { maxLength: 120 });
  requireString(issues, `${path}.title`, payload.title, { maxLength: 240 });
  requireString(issues, `${path}.workType`, payload.workType, { maxLength: 80 });
  requireString(issues, `${path}.priority`, payload.priority, { maxLength: 40 });
  requireEnum(issues, `${path}.lifecycleStatus`, payload.lifecycleStatus, WORK_ORDER_LIFECYCLE_STATUSES);
  optionalStringOrNull(issues, `${path}.assetSourceId`, payload.assetSourceId, { maxLength: 120 });
  optionalStringOrNull(issues, `${path}.functionalLocationSourceId`, payload.functionalLocationSourceId, { maxLength: 120 });
  optionalIsoDateTimeOrNull(issues, `${path}.requiredStartUtc`, payload.requiredStartUtc);
  optionalIsoDateTimeOrNull(issues, `${path}.dueAtUtc`, payload.dueAtUtc);
  optionalIsoDateTimeOrNull(issues, `${path}.scheduledStartUtc`, payload.scheduledStartUtc);
  optionalNonNegativeNumberOrNull(issues, `${path}.estimatedHours`, payload.estimatedHours);
  requireIsoDateTime(issues, `${path}.sourceUpdatedAtUtc`, payload.sourceUpdatedAtUtc);
  validateSourceDataReadiness(issues, `${path}.sourceDataReadiness`, payload.sourceDataReadiness);
  validateValidationIssues(issues, `${path}.validationIssues`, payload.validationIssues, { optional: true });
}

function validateMajorEventPayload(issues, path, payload) {
  rejectUnknownKeys(issues, path, payload, MAJOR_EVENT_PAYLOAD_KEYS);
  requireString(issues, `${path}.sourceSystem`, payload.sourceSystem, { maxLength: 80 });
  requireString(issues, `${path}.sourceId`, payload.sourceId, { maxLength: 120 });
  requireString(issues, `${path}.eventType`, payload.eventType, { maxLength: 80 });
  requireString(issues, `${path}.title`, payload.title, { maxLength: 240 });
  requireString(issues, `${path}.severity`, payload.severity, { maxLength: 40 });
  optionalStringOrNull(issues, `${path}.assetSourceId`, payload.assetSourceId, { maxLength: 120 });
  optionalStringOrNull(issues, `${path}.functionalLocationSourceId`, payload.functionalLocationSourceId, { maxLength: 120 });
  requireIsoDateTime(issues, `${path}.startsAtUtc`, payload.startsAtUtc);
  optionalIsoDateTimeOrNull(issues, `${path}.endsAtUtc`, payload.endsAtUtc);
  requireIsoDateTime(issues, `${path}.sourceUpdatedAtUtc`, payload.sourceUpdatedAtUtc);
  validateSourceDataReadiness(issues, `${path}.sourceDataReadiness`, payload.sourceDataReadiness);
  validateValidationIssues(issues, `${path}.validationIssues`, payload.validationIssues, { optional: true });

  if (isIsoDateTime(payload.startsAtUtc) && isIsoDateTime(payload.endsAtUtc)) {
    if (Date.parse(payload.endsAtUtc) <= Date.parse(payload.startsAtUtc)) {
      addIssue(issues, `${path}.endsAtUtc`, "must be later than startsAtUtc");
    }
  }
}

function validatePartsPayload(issues, path, payload) {
  rejectUnknownKeys(issues, path, payload, PARTS_PAYLOAD_KEYS);
  requireString(issues, `${path}.sourceSystem`, payload.sourceSystem, { maxLength: 80 });
  requireString(issues, `${path}.sourceId`, payload.sourceId, { maxLength: 120 });
  requireString(issues, `${path}.workOrderSourceId`, payload.workOrderSourceId, { maxLength: 120 });
  requireString(issues, `${path}.partNumber`, payload.partNumber, { maxLength: 120 });
  requireString(issues, `${path}.partName`, payload.partName, { maxLength: 200 });
  requireEnum(issues, `${path}.availabilityStatus`, payload.availabilityStatus, [
    "Available",
    "Constrained",
    "Unavailable"
  ]);
  requireNonNegativeNumber(issues, `${path}.requiredQuantity`, payload.requiredQuantity);
  requireNonNegativeNumber(issues, `${path}.availableQuantity`, payload.availableQuantity);
  requireIsoDateTime(issues, `${path}.neededByUtc`, payload.neededByUtc);
  requireIsoDateTime(issues, `${path}.sourceUpdatedAtUtc`, payload.sourceUpdatedAtUtc);
  validateSourceDataReadiness(issues, `${path}.sourceDataReadiness`, payload.sourceDataReadiness);
  validateValidationIssues(issues, `${path}.validationIssues`, payload.validationIssues, { optional: true });
}

function validateCrewPayload(issues, path, payload) {
  rejectUnknownKeys(issues, path, payload, CREW_PAYLOAD_KEYS);
  requireString(issues, `${path}.sourceSystem`, payload.sourceSystem, { maxLength: 80 });
  requireString(issues, `${path}.sourceId`, payload.sourceId, { maxLength: 120 });
  requireString(issues, `${path}.crewId`, payload.crewId, { maxLength: 120 });
  requireString(issues, `${path}.crewName`, payload.crewName, { maxLength: 200 });
  requireString(issues, `${path}.discipline`, payload.discipline, { maxLength: 80 });
  requireDate(issues, `${path}.capacityDate`, payload.capacityDate);
  requireNonNegativeNumber(issues, `${path}.availableHours`, payload.availableHours);
  requireNonNegativeNumber(issues, `${path}.reservedHours`, payload.reservedHours);
  requireIsoDateTime(issues, `${path}.sourceUpdatedAtUtc`, payload.sourceUpdatedAtUtc);
  validateSourceDataReadiness(issues, `${path}.sourceDataReadiness`, payload.sourceDataReadiness);
  validateValidationIssues(issues, `${path}.validationIssues`, payload.validationIssues, { optional: true });
}

function validateExpectation(issues, path, expectation) {
  if (!isPlainObject(expectation)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  rejectUnknownKeys(issues, path, expectation, EXPECTATION_KEYS);
  requireEnum(issues, `${path}.importDisposition`, expectation.importDisposition, IMPORT_DISPOSITIONS);
  optionalEnum(issues, `${path}.readiness`, expectation.readiness, SOURCE_DATA_READINESS);
  optionalStringOrNull(issues, `${path}.reason`, expectation.reason, { maxLength: 500 });
  validateValidationIssues(issues, `${path}.validationIssues`, expectation.validationIssues, { optional: true });

  if (expectation.importDisposition === "rejected") {
    if (!Array.isArray(expectation.validationIssues) || expectation.validationIssues.length === 0) {
      addIssue(issues, `${path}.validationIssues`, "must describe why a rejected event is rejected");
    }
  }
}

function validateSourceDataReadiness(issues, path, readiness) {
  if (!isPlainObject(readiness)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  rejectUnknownKeys(issues, path, readiness, READINESS_KEYS);
  requireEnum(issues, `${path}.status`, readiness.status, SOURCE_DATA_READINESS);
  optionalStringOrNull(issues, `${path}.issueCode`, readiness.issueCode, { maxLength: 80 });
  optionalStringOrNull(issues, `${path}.issueDetail`, readiness.issueDetail, { maxLength: 500 });
  validateValidationIssues(issues, `${path}.validationIssues`, readiness.validationIssues, { optional: true });

  if (readiness.status !== "Ready" && !readiness.issueCode) {
    addIssue(issues, `${path}.issueCode`, "must be present when readiness is not Ready");
  }
}

function validateValidationIssues(issues, path, validationIssues, options = {}) {
  if (validationIssues === undefined && options.optional) return;

  if (!Array.isArray(validationIssues)) {
    addIssue(issues, path, "must be an array");
    return;
  }

  validationIssues.forEach((issue, index) => {
    const issuePath = `${path}[${index}]`;
    if (!isPlainObject(issue)) {
      addIssue(issues, issuePath, "must be an object");
      return;
    }

    rejectUnknownKeys(issues, issuePath, issue, VALIDATION_ISSUE_KEYS);
    requireString(issues, `${issuePath}.code`, issue.code, { maxLength: 80 });
    requireEnum(issues, `${issuePath}.severity`, issue.severity, ["info", "warning", "error"]);
    optionalStringOrNull(issues, `${issuePath}.sourceField`, issue.sourceField, { maxLength: 120 });
    optionalStringOrNull(issues, `${issuePath}.detail`, issue.detail, { maxLength: 500 });
  });
}

function validateApiImport(issues, path, apiImport) {
  if (!isPlainObject(apiImport)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  const allowedKeys = new Set(["endpoint", "importKind", "batchIdempotencyKey"]);
  rejectUnknownKeys(issues, path, apiImport, allowedKeys);
  requireEnum(issues, `${path}.endpoint`, apiImport.endpoint, [
    "/api/v1/imports/maintenance-events",
    "/api/v1/imports/source-work-orders"
  ]);
  requireEnum(issues, `${path}.importKind`, apiImport.importKind, [
    "maintenance-events",
    "source-work-orders"
  ]);
  requireString(issues, `${path}.batchIdempotencyKey`, apiImport.batchIdempotencyKey, {
    maxLength: 160
  });
}

function validatePlanningHorizon(issues, path, planningHorizon) {
  if (!isPlainObject(planningHorizon)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  const allowedKeys = new Set(["startUtc", "endUtc"]);
  rejectUnknownKeys(issues, path, planningHorizon, allowedKeys);
  requireIsoDateTime(issues, `${path}.startUtc`, planningHorizon.startUtc);
  requireIsoDateTime(issues, `${path}.endUtc`, planningHorizon.endUtc);

  if (isIsoDateTime(planningHorizon.startUtc) && isIsoDateTime(planningHorizon.endUtc)) {
    if (Date.parse(planningHorizon.endUtc) <= Date.parse(planningHorizon.startUtc)) {
      addIssue(issues, `${path}.endUtc`, "must be later than startUtc");
    }
  }
}

function validateExpectedOutcomes(issues, path, expectedOutcomes) {
  if (!isPlainObject(expectedOutcomes)) {
    addIssue(issues, path, "must be an object");
    return;
  }

  const allowedKeys = new Set([
    "readyWorkOrderSourceIds",
    "blockedWorkOrderSourceIds",
    "rejectedEventIds",
    "duplicateEventIds",
    "staleEventIds",
    "notes"
  ]);
  rejectUnknownKeys(issues, path, expectedOutcomes, allowedKeys);
  requireStringArray(issues, `${path}.readyWorkOrderSourceIds`, expectedOutcomes.readyWorkOrderSourceIds);
  requireStringArray(issues, `${path}.blockedWorkOrderSourceIds`, expectedOutcomes.blockedWorkOrderSourceIds);
  requireStringArray(issues, `${path}.rejectedEventIds`, expectedOutcomes.rejectedEventIds);
  requireStringArray(issues, `${path}.duplicateEventIds`, expectedOutcomes.duplicateEventIds);
  requireStringArray(issues, `${path}.staleEventIds`, expectedOutcomes.staleEventIds);

  if (expectedOutcomes.notes !== undefined) {
    requireStringArray(issues, `${path}.notes`, expectedOutcomes.notes);
  }
}

function validateExpectedOutcomeReferences(issues, scenarioPack) {
  const eventIds = new Set(scenarioPack.events.map((event) => event.eventId));

  for (const key of ["rejectedEventIds", "duplicateEventIds", "staleEventIds"]) {
    for (const eventId of scenarioPack.expectedOutcomes?.[key] ?? []) {
      if (!eventIds.has(eventId)) {
        addIssue(issues, `$.expectedOutcomes.${key}`, `references unknown eventId ${eventId}`);
      }
    }
  }
}

function validateEnvelopePayloadAlignment(issues, path, event) {
  if (!isPlainObject(event.payload)) return;

  if (event.payload.sourceSystem && event.payload.sourceSystem !== event.sourceSystem) {
    addIssue(issues, `${path}.payload.sourceSystem`, "must match envelope sourceSystem");
  }

  if (event.payload.sourceId && event.payload.sourceId !== event.sourceRecordId) {
    addIssue(issues, `${path}.payload.sourceId`, "must match envelope sourceRecordId");
  }
}

function validateDispositionSemantics(issues, path, event, context) {
  const disposition = event.expectation?.importDisposition;
  const sourceKey = `${event.sourceSystem}:${event.sourceRecordId}`;
  const sourceUpdatedAt = event.payload?.sourceUpdatedAtUtc;

  if (disposition === "ignored-duplicate" && !context.idempotencyKeys.has(event.idempotencyKey)) {
    addIssue(issues, `${path}.idempotencyKey`, "must repeat a prior idempotencyKey for duplicate expectations");
  }

  if (disposition === "ignored-stale") {
    const previousTimestamp = context.sourceUpdatedAtByRecord.get(sourceKey);
    if (!previousTimestamp) {
      addIssue(issues, `${path}.payload.sourceUpdatedAtUtc`, "must have a prior event for stale expectations");
    } else if (isIsoDateTime(sourceUpdatedAt) && Date.parse(sourceUpdatedAt) > Date.parse(previousTimestamp)) {
      addIssue(issues, `${path}.payload.sourceUpdatedAtUtc`, "must not be newer than the prior source update");
    }
  }

  if (disposition === "accepted-blocked") {
    const readinessStatus = event.payload?.sourceDataReadiness?.status;
    if (readinessStatus !== "Blocked") {
      addIssue(issues, `${path}.payload.sourceDataReadiness.status`, "must be Blocked for accepted-blocked expectations");
    }
  }

  if (event.expectation?.readiness && event.payload?.sourceDataReadiness?.status) {
    if (event.expectation.readiness !== event.payload.sourceDataReadiness.status) {
      addIssue(issues, `${path}.expectation.readiness`, "must match payload sourceDataReadiness.status");
    }
  }

  context.idempotencyKeys.add(event.idempotencyKey);

  if (isIsoDateTime(sourceUpdatedAt) && disposition !== "ignored-stale" && disposition !== "ignored-duplicate") {
    const previousTimestamp = context.sourceUpdatedAtByRecord.get(sourceKey);
    if (!previousTimestamp || Date.parse(sourceUpdatedAt) > Date.parse(previousTimestamp)) {
      context.sourceUpdatedAtByRecord.set(sourceKey, sourceUpdatedAt);
    }
  }
}

function rejectUnknownKeys(issues, path, value, allowedKeys) {
  if (!isPlainObject(value)) return;

  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      addIssue(issues, `${path}.${key}`, "is not part of the contract");
    }
  }
}

function requireConst(issues, path, value, expected) {
  if (value !== expected) {
    addIssue(issues, path, `must be ${expected}`);
  }
}

function requireEnum(issues, path, value, allowedValues) {
  if (!allowedValues.includes(value)) {
    addIssue(issues, path, `must be one of: ${allowedValues.join(", ")}`);
  }
}

function optionalEnum(issues, path, value, allowedValues) {
  if (value === undefined) return;
  requireEnum(issues, path, value, allowedValues);
}

function requireString(issues, path, value, options = {}) {
  if (!isNonEmptyString(value)) {
    addIssue(issues, path, "must be a non-empty string");
    return;
  }

  if (options.maxLength && value.length > options.maxLength) {
    addIssue(issues, path, `must be ${options.maxLength} characters or fewer`);
  }
}

function optionalString(issues, path, value, options = {}) {
  if (value === undefined) return;
  requireString(issues, path, value, options);
}

function optionalStringOrNull(issues, path, value, options = {}) {
  if (value === undefined || value === null) return;
  requireString(issues, path, value, options);
}

function requireStringArray(issues, path, value) {
  if (!Array.isArray(value)) {
    addIssue(issues, path, "must be an array");
    return;
  }

  value.forEach((item, index) => {
    requireString(issues, `${path}[${index}]`, item);
  });
}

function requireIsoDateTime(issues, path, value) {
  if (!isIsoDateTime(value)) {
    addIssue(issues, path, "must be an ISO 8601 UTC date-time string");
  }
}

function optionalIsoDateTimeOrNull(issues, path, value) {
  if (value === undefined || value === null) return;
  requireIsoDateTime(issues, path, value);
}

function requireDate(issues, path, value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    addIssue(issues, path, "must be an ISO 8601 date string");
  }
}

function requireNonNegativeNumber(issues, path, value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    addIssue(issues, path, "must be a non-negative number");
  }
}

function optionalNonNegativeNumberOrNull(issues, path, value) {
  if (value === undefined || value === null) return;
  requireNonNegativeNumber(issues, path, value);
}

function addIssue(issues, path, message) {
  issues.push({ path, message });
}

function toResult(issues) {
  return {
    ok: issues.length === 0,
    issues
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDateTime(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}
