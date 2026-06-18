import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CONTRACT_SCHEMA_VERSION,
  EVENT_PAYLOAD_SCHEMA_BY_TYPE,
  EVENT_TYPES,
  IMPORT_DISPOSITIONS,
  SOURCE_DATA_READINESS,
  assertScenarioPack,
  summarizeScenarioPack,
  validateMaintenanceEventEnvelope,
  validateScenarioPack
} from "../src/contracts/scenario-contract.mjs";

const schemaPaths = [
  "schemas/common.schema.json",
  "schemas/scenario-pack.schema.json",
  "schemas/maintenance-event-envelope.schema.json",
  "schemas/payloads/work-order-event-payload.schema.json",
  "schemas/payloads/major-event-window-payload.schema.json",
  "schemas/payloads/parts-availability-payload.schema.json",
  "schemas/payloads/crew-capacity-payload.schema.json"
];

test("contract schemas are checked in and parse as draft schemas", async () => {
  const schemas = await Promise.all(schemaPaths.map(readJson));

  for (const schema of schemas) {
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(schema.$id, /^https:\/\/maintenance-data-simulator\.local\/schemas\//);
    assert.equal(typeof schema.title, "string");
  }
});

test("event envelope fields match the API-facing contract names", async () => {
  const envelopeSchema = await readJson("schemas/maintenance-event-envelope.schema.json");

  assert.deepEqual(envelopeSchema.required, [
    "eventId",
    "eventType",
    "schemaVersion",
    "sourceSystem",
    "sourceRecordId",
    "correlationId",
    "occurredAt",
    "publishedAt",
    "idempotencyKey",
    "payload"
  ]);
  assert.deepEqual(envelopeSchema.properties.eventType.enum, EVENT_TYPES);
  assert.equal(envelopeSchema.properties.schemaVersion.const, CONTRACT_SCHEMA_VERSION);
});

test("payload schemas cover every initial event type", () => {
  assert.deepEqual(Object.keys(EVENT_PAYLOAD_SCHEMA_BY_TYPE).sort(), [...EVENT_TYPES].sort());
});

test("baseline scenario validates against the runtime contract", async () => {
  const scenario = await readJson("scenarios/baseline-week.scenario.json");
  const result = validateScenarioPack(scenario);

  assert.deepEqual(result.issues, []);
  assert.equal(result.ok, true);
  assert.equal(assertScenarioPack(scenario), scenario);
});

test("baseline scenario validates against the checked-in scenario schema", async () => {
  const registry = await loadSchemaRegistry();
  const scenario = await readJson("scenarios/baseline-week.scenario.json");
  const { schema, context } = registry.byPath.get("schemas/scenario-pack.schema.json");
  const issues = validateJsonSchema(scenario, schema, context, registry);

  assert.deepEqual(issues, []);
});

test("baseline scenario exercises deterministic contract outcomes", async () => {
  const scenario = await readJson("scenarios/baseline-week.scenario.json");
  const summary = summarizeScenarioPack(scenario);

  assert.equal(summary.scenarioId, "baseline-week");
  assert.equal(summary.schemaVersion, CONTRACT_SCHEMA_VERSION);
  assert.equal(summary.seed, "baseline-week:2026-01-15:contract-1");
  assert.equal(summary.eventCount, 9);
  assert.equal(summary.dispositionCounts.accepted, 4);
  assert.equal(summary.dispositionCounts["accepted-blocked"], 2);
  assert.equal(summary.dispositionCounts.rejected, 1);
  assert.equal(summary.dispositionCounts["ignored-duplicate"], 1);
  assert.equal(summary.dispositionCounts["ignored-stale"], 1);

  for (const disposition of IMPORT_DISPOSITIONS) {
    assert.ok(summary.dispositionCounts[disposition] > 0, `${disposition} should be represented`);
  }

  for (const readiness of SOURCE_DATA_READINESS) {
    const event = scenario.events.find((item) => item.payload.sourceDataReadiness.status === readiness);
    assert.ok(event, `${readiness} readiness should be represented`);
  }
});

test("baseline event envelopes validate individually", async () => {
  const scenario = await readJson("scenarios/baseline-week.scenario.json");

  for (const event of scenario.events) {
    const result = validateMaintenanceEventEnvelope(event);
    assert.deepEqual(result.issues, [], event.eventId);
    assert.equal(result.ok, true);
  }
});

test("runtime contract rejects mismatched duplicate and readiness expectations", async () => {
  const scenario = await readJson("scenarios/baseline-week.scenario.json");
  const duplicateScenario = structuredClone(scenario);
  duplicateScenario.events[4].idempotencyKey = "unexpected-new-key";
  const duplicateResult = validateScenarioPack(duplicateScenario);

  assert.equal(duplicateResult.ok, false);
  assert.ok(
    duplicateResult.issues.some((issue) => issue.path === "$.events[4].idempotencyKey"),
    "duplicate expectations should require a repeated idempotency key"
  );

  const readinessScenario = structuredClone(scenario);
  readinessScenario.events[1].payload.sourceDataReadiness.status = "NeedsReview";
  const readinessResult = validateScenarioPack(readinessScenario);

  assert.equal(readinessResult.ok, false);
  assert.ok(
    readinessResult.issues.some((issue) => issue.path === "$.events[1].payload.sourceDataReadiness.status"),
    "accepted-blocked expectations should require blocked readiness"
  );
});

async function readJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

async function loadSchemaRegistry() {
  const registry = {
    byPath: new Map(),
    byUrl: new Map()
  };

  for (const schemaPath of schemaPaths) {
    const url = new URL(`../${schemaPath}`, import.meta.url);
    const schema = JSON.parse(await readFile(url, "utf8"));
    const context = { path: schemaPath, url };
    registry.byPath.set(schemaPath, { schema, context });
    registry.byUrl.set(url.href, { schema, context });
    registry.byUrl.set(schema.$id, { schema, context });
  }

  return registry;
}

function validateJsonSchema(value, schema, context, registry, path = "$") {
  const issues = [];
  visitJsonSchema(value, schema, context, registry, path, issues);
  return issues;
}

function visitJsonSchema(value, schema, context, registry, path, issues) {
  if (!schema || typeof schema !== "object") return;

  if (schema.$ref) {
    const target = resolveSchemaRef(schema.$ref, context, registry);
    visitJsonSchema(value, target.schema, target.context, registry, path, issues);
    return;
  }

  if (schema.if) {
    const conditionIssues = [];
    visitJsonSchema(value, schema.if, context, registry, path, conditionIssues);
    if (conditionIssues.length === 0 && schema.then) {
      visitJsonSchema(value, schema.then, context, registry, path, issues);
    }
    if (conditionIssues.length > 0 && schema.else) {
      visitJsonSchema(value, schema.else, context, registry, path, issues);
    }
    return;
  }

  if (schema.allOf) {
    for (const item of schema.allOf) {
      visitJsonSchema(value, item, context, registry, path, issues);
    }
  }

  if (schema.anyOf) {
    const hasMatchingBranch = schema.anyOf.some((item) => {
      const branchIssues = [];
      visitJsonSchema(value, item, context, registry, path, branchIssues);
      return branchIssues.length === 0;
    });

    if (!hasMatchingBranch) {
      issues.push(`${path} must match at least one allowed schema`);
    }
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    issues.push(`${path} must be ${schema.const}`);
  }

  if (schema.enum && !schema.enum.includes(value)) {
    issues.push(`${path} must be one of ${schema.enum.join(", ")}`);
  }

  if (schema.type && !matchesJsonType(value, schema.type)) {
    issues.push(`${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`);
    return;
  }

  if (schema.type === "string" || (Array.isArray(schema.type) && typeof value === "string")) {
    validateStringSchema(value, schema, path, issues);
  }

  if (schema.type === "number" || (Array.isArray(schema.type) && typeof value === "number")) {
    validateNumberSchema(value, schema, path, issues);
  }

  if (schema.minItems !== undefined && Array.isArray(value) && value.length < schema.minItems) {
    issues.push(`${path} must contain at least ${schema.minItems} item(s)`);
  }

  if (schema.required && isPlainObject(value)) {
    for (const requiredProperty of schema.required) {
      if (!(requiredProperty in value)) {
        issues.push(`${path}.${requiredProperty} is required`);
      }
    }
  }

  if (schema.properties && isPlainObject(value)) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      if (propertyName in value) {
        visitJsonSchema(
          value[propertyName],
          propertySchema,
          context,
          registry,
          `${path}.${propertyName}`,
          issues
        );
      }
    }
  }

  if (schema.additionalProperties === false && schema.properties && isPlainObject(value)) {
    for (const propertyName of Object.keys(value)) {
      if (!(propertyName in schema.properties)) {
        issues.push(`${path}.${propertyName} is not allowed`);
      }
    }
  }

  if (schema.items && Array.isArray(value)) {
    value.forEach((item, index) => {
      visitJsonSchema(item, schema.items, context, registry, `${path}[${index}]`, issues);
    });
  }
}

function validateStringSchema(value, schema, path, issues) {
  if (typeof value !== "string") return;

  if (schema.minLength !== undefined && value.length < schema.minLength) {
    issues.push(`${path} must be at least ${schema.minLength} character(s)`);
  }

  if (schema.maxLength !== undefined && value.length > schema.maxLength) {
    issues.push(`${path} must be ${schema.maxLength} character(s) or fewer`);
  }

  if (schema.format === "date-time" && !isIsoDateTime(value)) {
    issues.push(`${path} must be a date-time string`);
  }

  if (schema.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    issues.push(`${path} must be a date string`);
  }
}

function validateNumberSchema(value, schema, path, issues) {
  if (typeof value !== "number") return;

  if (schema.minimum !== undefined && value < schema.minimum) {
    issues.push(`${path} must be at least ${schema.minimum}`);
  }
}

function resolveSchemaRef(ref, context, registry) {
  const [rawTarget, fragment = ""] = ref.split("#");
  const targetUrl = rawTarget ? new URL(rawTarget, context.url).href : context.url.href;
  const entry = registry.byUrl.get(targetUrl);

  if (!entry) {
    throw new Error(`Unknown schema ref: ${ref} from ${context.path}`);
  }

  return {
    schema: resolveJsonPointer(entry.schema, fragment),
    context: entry.context
  };
}

function resolveJsonPointer(schema, fragment) {
  if (fragment === "") return schema;

  return fragment
    .replace(/^\//, "")
    .split("/")
    .filter(Boolean)
    .reduce((current, segment) => current[segment.replaceAll("~1", "/").replaceAll("~0", "~")], schema);
}

function matchesJsonType(value, type) {
  const types = Array.isArray(type) ? type : [type];

  return types.some((candidate) => {
    if (candidate === "null") return value === null;
    if (candidate === "array") return Array.isArray(value);
    if (candidate === "object") return isPlainObject(value);
    if (candidate === "number") return typeof value === "number" && Number.isFinite(value);
    if (candidate === "string") return typeof value === "string";
    if (candidate === "boolean") return typeof value === "boolean";
    return false;
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIsoDateTime(value) {
  if (typeof value !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}
