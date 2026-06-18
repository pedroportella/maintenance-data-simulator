import { createHash } from "node:crypto";

import { CONTRACT_SCHEMA_VERSION, assertScenarioPack } from "../contracts/scenario-contract.mjs";

const SOURCE_SYSTEM = "synthetic-source";
const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;

const SCENARIO_DEFINITIONS = Object.freeze({
  "baseline-week": Object.freeze({
    scenarioId: "baseline-week",
    name: "Baseline weekly planning",
    description: "Synthetic source-system-shaped maintenance events for a small weekly planning review.",
    seed: "baseline-week:2026-01-15:scenario-2",
    referenceTimeUtc: "2026-01-15T00:00:00Z",
    planningHorizon: {
      startUtc: "2026-01-16T00:00:00Z",
      endUtc: "2026-01-30T00:00:00Z"
    },
    expectedWorkOrders: {
      ready: ["WO-2000"],
      blocked: ["WO-2001"],
      deferred: []
    },
    notes: [
      "The scenario intentionally includes one rejected event, one duplicate idempotency key and one stale update.",
      "The blocked work order should be imported for review but excluded from package recommendations."
    ],
    buildEvents: buildBaselineWeekEvents
  }),
  "event-window-conflict": Object.freeze({
    scenarioId: "event-window-conflict",
    name: "Event window conflict",
    description: "Synthetic planning events with overlapping access windows and a deferred work order.",
    seed: "event-window-conflict:2026-02-02:scenario-2",
    referenceTimeUtc: "2026-02-02T00:00:00Z",
    planningHorizon: {
      startUtc: "2026-02-03T00:00:00Z",
      endUtc: "2026-02-17T00:00:00Z"
    },
    expectedWorkOrders: {
      ready: ["WO-2100"],
      blocked: [],
      deferred: ["WO-2101"]
    },
    notes: [
      "The overlapping windows should make one work order a defer candidate for later planning tests.",
      "The stale update and duplicate window event are included to keep import processing deterministic."
    ],
    buildEvents: buildEventWindowConflictEvents
  }),
  "parts-delay-replan": Object.freeze({
    scenarioId: "parts-delay-replan",
    name: "Parts delay replan",
    description: "Synthetic parts and planning-context changes that force a deferred package review.",
    seed: "parts-delay-replan:2026-03-10:scenario-2",
    referenceTimeUtc: "2026-03-10T00:00:00Z",
    planningHorizon: {
      startUtc: "2026-03-11T00:00:00Z",
      endUtc: "2026-03-25T00:00:00Z"
    },
    expectedWorkOrders: {
      ready: [],
      blocked: ["WO-2201", "WO-2202"],
      deferred: ["WO-2200"]
    },
    notes: [
      "The unavailable parts event should block immediate packaging and the status change marks the work order as deferred.",
      "The scenario includes missing equipment, priority and work-center context without using real source data."
    ],
    buildEvents: buildPartsDelayReplanEvents
  })
});

export const SCENARIO_IDS = Object.freeze(Object.keys(SCENARIO_DEFINITIONS));

export function listScenarioIds() {
  return [...SCENARIO_IDS];
}

export function generateScenarioPack(scenarioId, options = {}) {
  const definition = SCENARIO_DEFINITIONS[scenarioId];

  if (!definition) {
    throw new Error(`Unknown scenario: ${scenarioId}`);
  }

  const seed = options.seed ?? definition.seed;
  const context = {
    scenarioId,
    seed,
    seedTag: shortHash(seed),
    sourceSystem: SOURCE_SYSTEM,
    referenceTimeUtc: definition.referenceTimeUtc
  };
  const eventSpecs = definition.buildEvents(context);
  const events = [];

  eventSpecs.forEach((spec, index) => {
    events.push(buildEvent(context, spec, index + 1, events));
  });

  const expectedOutcomes = buildExpectedOutcomes(definition, events);
  const scenarioPack = {
    scenarioId,
    name: definition.name,
    description: definition.description,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    seed,
    referenceTimeUtc: definition.referenceTimeUtc,
    sourceSystem: SOURCE_SYSTEM,
    apiImport: {
      endpoint: "/api/v1/imports/maintenance-events",
      importKind: "maintenance-events",
      batchIdempotencyKey: `${scenarioId}-${context.seedTag}`
    },
    planningHorizon: definition.planningHorizon,
    events,
    expectedOutcomes
  };

  return assertScenarioPack(scenarioPack);
}

export function stringifyScenarioPack(scenarioPack) {
  return `${JSON.stringify(scenarioPack, null, 2)}\n`;
}

function buildExpectedOutcomes(definition, events) {
  const rejectedEventIds = events
    .filter((event) => event.expectation.importDisposition === "rejected")
    .map((event) => event.eventId);
  const duplicateEventIds = events
    .filter((event) => event.expectation.importDisposition === "ignored-duplicate")
    .map((event) => event.eventId);
  const staleEventIds = events
    .filter((event) => event.expectation.importDisposition === "ignored-stale")
    .map((event) => event.eventId);
  const readyWorkOrderSourceIds = definition.expectedWorkOrders.ready;
  const blockedWorkOrderSourceIds = definition.expectedWorkOrders.blocked;
  const deferredWorkOrderSourceIds = definition.expectedWorkOrders.deferred;

  return {
    readyWorkOrderSourceIds,
    blockedWorkOrderSourceIds,
    deferredWorkOrderSourceIds,
    rejectedEventIds,
    duplicateEventIds,
    staleEventIds,
    counts: {
      readyWorkOrders: readyWorkOrderSourceIds.length,
      blockedWorkOrders: blockedWorkOrderSourceIds.length,
      rejectedEvents: rejectedEventIds.length,
      deferredWorkOrders: deferredWorkOrderSourceIds.length
    },
    notes: definition.notes
  };
}

function buildEvent(context, spec, ordinal, priorEvents) {
  const sourceRecordId = spec.payload.sourceId;
  const occurredAt = spec.occurredAt;
  const publishedAt = spec.publishedAt ?? addSeconds(occurredAt, spec.publishDelaySeconds ?? publishDelay(context, ordinal));
  const duplicateEvent = spec.duplicateOfOrdinal
    ? priorEvents.at(spec.duplicateOfOrdinal - 1)
    : undefined;

  if (spec.duplicateOfOrdinal && !duplicateEvent) {
    throw new Error(`Scenario ${context.scenarioId} has a duplicate event before its source event`);
  }

  return {
    eventId: `evt-${context.scenarioId}-${context.seedTag}-${pad(ordinal)}`,
    eventType: spec.eventType,
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    sourceSystem: context.sourceSystem,
    sourceRecordId,
    correlationId: `corr-${context.scenarioId}-${context.seedTag}-${pad(ordinal)}`,
    occurredAt,
    publishedAt,
    idempotencyKey:
      duplicateEvent?.idempotencyKey
      ?? `${context.scenarioId}:${context.seedTag}:${sourceRecordId}:${spec.idempotencyAction}:${occurredAt}`,
    payload: spec.payload,
    expectation: spec.expectation
  };
}

function buildBaselineWeekEvents(context) {
  const missingEstimateIssue = issue(
    "missing-estimate",
    "warning",
    "estimatedHours",
    "Estimated effort is not present in the source event."
  );
  const missingFunctionalLocationIssue = issue(
    "missing-functional-location",
    "error",
    "functionalLocationSourceId",
    "Functional location source id is not present."
  );
  const constrainedPartsIssue = issue(
    "constrained-parts",
    "warning",
    "availabilityStatus",
    "Planner review is useful before package recommendation."
  );

  return [
    workOrderEvent(context, "WorkOrderCreated", 1, "create", {
      sourceId: "WO-2000",
      title: "Replace pump seals",
      workType: "corrective",
      priority: "high",
      lifecycleStatus: "ReadyForPlanning",
      assetSourceId: "ASSET-2000",
      functionalLocationSourceId: "FL-2000",
      requiredStartUtc: "2026-01-20T00:00:00Z",
      dueAtUtc: "2026-01-24T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 8.5,
      sourceUpdatedAtUtc: at(context, 0),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    workOrderEvent(context, "WorkOrderCreated", 2, "create", {
      sourceId: "WO-2001",
      title: "Inspect standby valve",
      workType: "preventive",
      priority: "medium",
      lifecycleStatus: "Imported",
      assetSourceId: "ASSET-2001",
      functionalLocationSourceId: "FL-2000",
      requiredStartUtc: "2026-01-22T00:00:00Z",
      dueAtUtc: "2026-01-29T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: null,
      sourceUpdatedAtUtc: at(context, 1),
      sourceDataReadiness: blocked(
        "missing-estimate",
        "Estimated effort is required before packaging.",
        [missingEstimateIssue]
      ),
      validationIssues: [missingEstimateIssue]
    }, expectation("accepted-blocked", "Blocked", {
      validationIssues: [
        issue(
          "missing-estimate",
          "warning",
          "estimatedHours",
          "Accepted for review, but blocked from packaging."
        )
      ]
    })),
    workOrderEvent(context, "WorkOrderCreated", 3, "create", {
      sourceId: "WO-2002",
      title: "Check auxiliary drive",
      workType: "inspection",
      priority: "medium",
      lifecycleStatus: "Imported",
      assetSourceId: "ASSET-2002",
      functionalLocationSourceId: null,
      requiredStartUtc: "2026-01-23T00:00:00Z",
      dueAtUtc: "2026-01-28T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 4,
      sourceUpdatedAtUtc: at(context, 2),
      sourceDataReadiness: blocked(
        "missing-functional-location",
        "Functional location is required before the event can be accepted.",
        [missingFunctionalLocationIssue]
      ),
      validationIssues: [missingFunctionalLocationIssue]
    }, expectation("rejected", "Blocked", {
      validationIssues: [
        issue(
          "missing-functional-location",
          "error",
          "functionalLocationSourceId",
          "Rejected before import because a required source field is missing."
        )
      ]
    })),
    workOrderEvent(context, "WorkOrderUpdated", 4, "update-stale", {
      sourceId: "WO-2000",
      title: "Replace pump seals",
      workType: "corrective",
      priority: "medium",
      lifecycleStatus: "ReadyForPlanning",
      assetSourceId: "ASSET-2000",
      functionalLocationSourceId: "FL-2000",
      requiredStartUtc: "2026-01-20T00:00:00Z",
      dueAtUtc: "2026-01-25T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 8.5,
      sourceUpdatedAtUtc: "2026-01-14T23:50:00Z",
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("ignored-stale", "Ready", {
      reason: "Older source update should not replace the accepted work order state."
    })),
    {
      ...workOrderEvent(context, "WorkOrderCreated", 5, "create", {
        sourceId: "WO-2000",
        title: "Replace pump seals",
        workType: "corrective",
        priority: "high",
        lifecycleStatus: "ReadyForPlanning",
        assetSourceId: "ASSET-2000",
        functionalLocationSourceId: "FL-2000",
        requiredStartUtc: "2026-01-20T00:00:00Z",
        dueAtUtc: "2026-01-24T00:00:00Z",
        scheduledStartUtc: null,
        estimatedHours: 8.5,
        sourceUpdatedAtUtc: at(context, 0),
        sourceDataReadiness: ready(),
        validationIssues: []
      }, expectation("ignored-duplicate", "Ready", {
        reason: "Repeated idempotency key should be ignored by import processing."
      })),
      duplicateOfOrdinal: 1
    },
    workOrderEvent(context, "WorkOrderStatusChanged", 6, "status", {
      sourceId: "WO-2001",
      title: "Inspect standby valve",
      workType: "preventive",
      priority: "medium",
      lifecycleStatus: "Imported",
      assetSourceId: "ASSET-2001",
      functionalLocationSourceId: "FL-2000",
      requiredStartUtc: "2026-01-22T00:00:00Z",
      dueAtUtc: "2026-01-29T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: null,
      sourceUpdatedAtUtc: at(context, 6),
      sourceDataReadiness: blocked(
        "missing-estimate",
        "Estimated effort is required before packaging.",
        [missingEstimateIssue]
      ),
      validationIssues: [missingEstimateIssue]
    }, expectation("accepted-blocked", "Blocked", {
      reason: "Status changes can be accepted while the work remains blocked from packaging."
    })),
    majorEventWindow(context, 7, "EVT-2000", "window", {
      eventType: "access-window",
      title: "Shared access window",
      severity: "medium",
      assetSourceId: "ASSET-2000",
      functionalLocationSourceId: "FL-2000",
      startsAtUtc: "2026-01-20T00:00:00Z",
      endsAtUtc: "2026-01-21T00:00:00Z",
      sourceUpdatedAtUtc: at(context, 7),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    partsAvailability(context, 8, "PART-2000-WO-2000", "parts", {
      workOrderSourceId: "WO-2000",
      partNumber: "KIT-2000",
      partName: "Seal kit",
      availabilityStatus: "Constrained",
      requiredQuantity: 1,
      availableQuantity: 1,
      neededByUtc: "2026-01-20T00:00:00Z",
      sourceUpdatedAtUtc: at(context, 8),
      sourceDataReadiness: review(
        "constrained-parts",
        "Parts are available but constrained for the planning horizon.",
        [constrainedPartsIssue]
      ),
      validationIssues: [constrainedPartsIssue]
    }, expectation("accepted", "NeedsReview")),
    crewCapacity(context, 9, "CREW-MECH-2026-01-20", "crew", {
      crewId: "CREW-MECH",
      crewName: "Mechanical day crew",
      discipline: "mechanical",
      capacityDate: "2026-01-20",
      availableHours: 16,
      reservedHours: 8,
      sourceUpdatedAtUtc: at(context, 9),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready"))
  ];
}

function buildEventWindowConflictEvents(context) {
  const capacityIssue = issue(
    "window-capacity-conflict",
    "warning",
    "reservedHours",
    "Reserved work exceeds the preferred capacity for the overlapping window."
  );

  return [
    workOrderEvent(context, "WorkOrderCreated", 1, "create", {
      sourceId: "WO-2100",
      title: "Align conveyor drive",
      workType: "corrective",
      priority: "high",
      lifecycleStatus: "ReadyForPlanning",
      assetSourceId: "ASSET-2100",
      functionalLocationSourceId: "FL-2100",
      requiredStartUtc: "2026-02-06T00:00:00Z",
      dueAtUtc: "2026-02-08T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 10,
      sourceUpdatedAtUtc: at(context, 1),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    workOrderEvent(context, "WorkOrderCreated", 2, "create", {
      sourceId: "WO-2101",
      title: "Inspect heat exchanger bundle",
      workType: "inspection",
      priority: "medium",
      lifecycleStatus: "ReadyForPlanning",
      assetSourceId: "ASSET-2101",
      functionalLocationSourceId: "FL-2100",
      requiredStartUtc: "2026-02-06T12:00:00Z",
      dueAtUtc: "2026-02-10T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 12,
      sourceUpdatedAtUtc: at(context, 2),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    majorEventWindow(context, 3, "EVT-2100", "window", {
      eventType: "access-window",
      title: "Access window alpha",
      severity: "high",
      assetSourceId: "ASSET-2100",
      functionalLocationSourceId: "FL-2100",
      startsAtUtc: "2026-02-06T00:00:00Z",
      endsAtUtc: "2026-02-07T00:00:00Z",
      sourceUpdatedAtUtc: at(context, 3),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    majorEventWindow(context, 4, "EVT-2101", "window", {
      eventType: "access-window",
      title: "Overlapping access window",
      severity: "high",
      assetSourceId: "ASSET-2101",
      functionalLocationSourceId: "FL-2100",
      startsAtUtc: "2026-02-06T12:00:00Z",
      endsAtUtc: "2026-02-08T00:00:00Z",
      sourceUpdatedAtUtc: at(context, 4),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    crewCapacity(context, 5, "CREW-MECH-2026-02-06", "crew", {
      crewId: "CREW-MECH",
      crewName: "Mechanical day crew",
      discipline: "mechanical",
      capacityDate: "2026-02-06",
      availableHours: 16,
      reservedHours: 20,
      sourceUpdatedAtUtc: at(context, 5),
      sourceDataReadiness: review(
        "window-capacity-conflict",
        "Crew capacity needs review before both windowed jobs can be packaged.",
        [capacityIssue]
      ),
      validationIssues: [capacityIssue]
    }, expectation("accepted", "NeedsReview")),
    workOrderEvent(context, "WorkOrderStatusChanged", 6, "status", {
      sourceId: "WO-2101",
      title: "Inspect heat exchanger bundle",
      workType: "inspection",
      priority: "medium",
      lifecycleStatus: "Deferred",
      assetSourceId: "ASSET-2101",
      functionalLocationSourceId: "FL-2100",
      requiredStartUtc: "2026-02-06T12:00:00Z",
      dueAtUtc: "2026-02-14T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 12,
      sourceUpdatedAtUtc: at(context, 6),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready", {
      reason: "Planner should defer conflicting work until a non-overlapping window is available."
    })),
    workOrderEvent(context, "WorkOrderUpdated", 7, "update-stale", {
      sourceId: "WO-2100",
      title: "Align conveyor drive stale priority",
      workType: "corrective",
      priority: "medium",
      lifecycleStatus: "ReadyForPlanning",
      assetSourceId: "ASSET-2100",
      functionalLocationSourceId: "FL-2100",
      requiredStartUtc: "2026-02-06T00:00:00Z",
      dueAtUtc: "2026-02-09T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 10,
      sourceUpdatedAtUtc: "2026-02-01T23:50:00Z",
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("ignored-stale", "Ready", {
      reason: "Older source update should not override the ready work order."
    })),
    {
      ...majorEventWindow(context, 8, "EVT-2101", "window", {
        eventType: "access-window",
        title: "Overlapping access window",
        severity: "high",
        assetSourceId: "ASSET-2101",
        functionalLocationSourceId: "FL-2100",
        startsAtUtc: "2026-02-06T12:00:00Z",
        endsAtUtc: "2026-02-08T00:00:00Z",
        sourceUpdatedAtUtc: at(context, 4),
        sourceDataReadiness: ready(),
        validationIssues: []
      }, expectation("ignored-duplicate", "Ready", {
        reason: "Repeated idempotency key should be ignored by import processing."
      })),
      duplicateOfOrdinal: 4
    }
  ];
}

function buildPartsDelayReplanEvents(context) {
  const unavailablePartsIssue = issue(
    "parts-unavailable",
    "error",
    "availabilityStatus",
    "Required parts are not available for the planned start."
  );
  const missingEquipmentIssue = issue(
    "missing-equipment",
    "warning",
    "assetSourceId",
    "Equipment source id is not present in the event."
  );
  const missingPriorityIssue = issue(
    "missing-priority",
    "warning",
    "priority",
    "Priority was not populated in the source extract."
  );
  const missingWorkCenterIssue = issue(
    "missing-work-center",
    "warning",
    "workCenterSourceId",
    "Work-center context is not present in the source extract."
  );
  const missingFunctionalLocationIssue = issue(
    "missing-functional-location",
    "error",
    "functionalLocationSourceId",
    "Functional location source id is not present."
  );

  return [
    workOrderEvent(context, "WorkOrderCreated", 1, "create", {
      sourceId: "WO-2200",
      title: "Replace gearbox coupling",
      workType: "corrective",
      priority: "high",
      lifecycleStatus: "ReadyForPlanning",
      assetSourceId: "ASSET-2200",
      functionalLocationSourceId: "FL-2200",
      requiredStartUtc: "2026-03-14T00:00:00Z",
      dueAtUtc: "2026-03-16T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 9,
      sourceUpdatedAtUtc: at(context, 1),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    partsAvailability(context, 2, "PART-2200-WO-2200", "parts-unavailable", {
      workOrderSourceId: "WO-2200",
      partNumber: "KIT-2200",
      partName: "Coupling kit",
      availabilityStatus: "Unavailable",
      requiredQuantity: 2,
      availableQuantity: 0,
      neededByUtc: "2026-03-14T00:00:00Z",
      sourceUpdatedAtUtc: at(context, 2),
      sourceDataReadiness: blocked(
        "parts-unavailable",
        "Parts are not available for the planned start.",
        [unavailablePartsIssue]
      ),
      validationIssues: [unavailablePartsIssue]
    }, expectation("accepted-blocked", "Blocked", {
      validationIssues: [unavailablePartsIssue],
      reason: "The work order can be imported, but packaging should wait for available parts."
    })),
    workOrderEvent(context, "WorkOrderStatusChanged", 3, "status", {
      sourceId: "WO-2200",
      title: "Replace gearbox coupling",
      workType: "corrective",
      priority: "high",
      lifecycleStatus: "Deferred",
      assetSourceId: "ASSET-2200",
      functionalLocationSourceId: "FL-2200",
      requiredStartUtc: "2026-03-14T00:00:00Z",
      dueAtUtc: "2026-03-21T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 9,
      sourceUpdatedAtUtc: at(context, 3),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready", {
      reason: "Planner decision should defer the work until the parts delay is resolved."
    })),
    workOrderEvent(context, "WorkOrderCreated", 4, "create", {
      sourceId: "WO-2201",
      title: "Inspect auxiliary pump",
      workType: "inspection",
      priority: "medium",
      lifecycleStatus: "Imported",
      assetSourceId: null,
      functionalLocationSourceId: "FL-2201",
      requiredStartUtc: "2026-03-15T00:00:00Z",
      dueAtUtc: "2026-03-19T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 5,
      sourceUpdatedAtUtc: at(context, 4),
      sourceDataReadiness: blocked(
        "missing-equipment",
        "Equipment context is required before packaging.",
        [missingEquipmentIssue]
      ),
      validationIssues: [missingEquipmentIssue]
    }, expectation("accepted-blocked", "Blocked", {
      validationIssues: [missingEquipmentIssue]
    })),
    workOrderEvent(context, "WorkOrderCreated", 5, "create", {
      sourceId: "WO-2202",
      title: "Service standby compressor",
      workType: "preventive",
      priority: "unassigned",
      lifecycleStatus: "Imported",
      assetSourceId: "ASSET-2202",
      functionalLocationSourceId: "FL-2202",
      requiredStartUtc: "2026-03-18T00:00:00Z",
      dueAtUtc: "2026-03-24T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 6,
      sourceUpdatedAtUtc: at(context, 5),
      sourceDataReadiness: blocked(
        "missing-planning-context",
        "Priority and work-center context are required before packaging.",
        [missingPriorityIssue, missingWorkCenterIssue]
      ),
      validationIssues: [missingPriorityIssue, missingWorkCenterIssue]
    }, expectation("accepted-blocked", "Blocked", {
      validationIssues: [missingPriorityIssue, missingWorkCenterIssue]
    })),
    workOrderEvent(context, "WorkOrderCreated", 6, "create", {
      sourceId: "WO-2203",
      title: "Check cooling fan",
      workType: "inspection",
      priority: "medium",
      lifecycleStatus: "Imported",
      assetSourceId: "ASSET-2203",
      functionalLocationSourceId: null,
      requiredStartUtc: "2026-03-17T00:00:00Z",
      dueAtUtc: "2026-03-20T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 3,
      sourceUpdatedAtUtc: at(context, 6),
      sourceDataReadiness: blocked(
        "missing-functional-location",
        "Functional location is required before the event can be accepted.",
        [missingFunctionalLocationIssue]
      ),
      validationIssues: [missingFunctionalLocationIssue]
    }, expectation("rejected", "Blocked", {
      validationIssues: [missingFunctionalLocationIssue]
    })),
    partsAvailability(context, 7, "PART-2200-WO-2200", "parts-available", {
      workOrderSourceId: "WO-2200",
      partNumber: "KIT-2200",
      partName: "Coupling kit",
      availabilityStatus: "Available",
      requiredQuantity: 2,
      availableQuantity: 2,
      neededByUtc: "2026-03-20T00:00:00Z",
      sourceUpdatedAtUtc: at(context, 7),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    crewCapacity(context, 8, "CREW-MECH-2026-03-20", "crew", {
      crewId: "CREW-MECH",
      crewName: "Mechanical day crew",
      discipline: "mechanical",
      capacityDate: "2026-03-20",
      availableHours: 18,
      reservedHours: 10,
      sourceUpdatedAtUtc: at(context, 8),
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("accepted", "Ready")),
    workOrderEvent(context, "WorkOrderUpdated", 9, "update-stale", {
      sourceId: "WO-2200",
      title: "Replace gearbox coupling stale due date",
      workType: "corrective",
      priority: "high",
      lifecycleStatus: "ReadyForPlanning",
      assetSourceId: "ASSET-2200",
      functionalLocationSourceId: "FL-2200",
      requiredStartUtc: "2026-03-14T00:00:00Z",
      dueAtUtc: "2026-03-15T00:00:00Z",
      scheduledStartUtc: null,
      estimatedHours: 9,
      sourceUpdatedAtUtc: "2026-03-09T23:50:00Z",
      sourceDataReadiness: ready(),
      validationIssues: []
    }, expectation("ignored-stale", "Ready", {
      reason: "Out-of-order source update should not override the deferred work order state."
    })),
    {
      ...partsAvailability(context, 10, "PART-2200-WO-2200", "parts-available", {
        workOrderSourceId: "WO-2200",
        partNumber: "KIT-2200",
        partName: "Coupling kit",
        availabilityStatus: "Available",
        requiredQuantity: 2,
        availableQuantity: 2,
        neededByUtc: "2026-03-20T00:00:00Z",
        sourceUpdatedAtUtc: at(context, 7),
        sourceDataReadiness: ready(),
        validationIssues: []
      }, expectation("ignored-duplicate", "Ready", {
        reason: "Repeated parts update should be ignored by idempotent import processing."
      })),
      duplicateOfOrdinal: 7
    }
  ];
}

function workOrderEvent(context, eventType, minute, idempotencyAction, payload, expectationValue) {
  return {
    eventType,
    occurredAt: at(context, minute),
    idempotencyAction,
    payload: workOrderPayload(context, payload),
    expectation: expectationValue
  };
}

function majorEventWindow(context, minute, sourceId, idempotencyAction, payload, expectationValue) {
  return {
    eventType: "MajorEventWindowPublished",
    occurredAt: at(context, minute),
    idempotencyAction,
    payload: {
      sourceSystem: context.sourceSystem,
      sourceId,
      ...payload
    },
    expectation: expectationValue
  };
}

function partsAvailability(context, minute, sourceId, idempotencyAction, payload, expectationValue) {
  return {
    eventType: "PartsAvailabilityChanged",
    occurredAt: at(context, minute),
    idempotencyAction,
    payload: {
      sourceSystem: context.sourceSystem,
      sourceId,
      ...payload
    },
    expectation: expectationValue
  };
}

function crewCapacity(context, minute, sourceId, idempotencyAction, payload, expectationValue) {
  return {
    eventType: "CrewCapacityChanged",
    occurredAt: at(context, minute),
    idempotencyAction,
    payload: {
      sourceSystem: context.sourceSystem,
      sourceId,
      ...payload
    },
    expectation: expectationValue
  };
}

function workOrderPayload(context, payload) {
  return {
    sourceSystem: context.sourceSystem,
    sourceId: payload.sourceId,
    workOrderNumber: payload.workOrderNumber ?? payload.sourceId,
    title: payload.title,
    workType: payload.workType,
    priority: payload.priority,
    lifecycleStatus: payload.lifecycleStatus,
    assetSourceId: payload.assetSourceId,
    functionalLocationSourceId: payload.functionalLocationSourceId,
    requiredStartUtc: payload.requiredStartUtc,
    dueAtUtc: payload.dueAtUtc,
    scheduledStartUtc: payload.scheduledStartUtc,
    estimatedHours: payload.estimatedHours,
    sourceUpdatedAtUtc: payload.sourceUpdatedAtUtc,
    sourceDataReadiness: payload.sourceDataReadiness,
    validationIssues: payload.validationIssues
  };
}

function expectation(importDisposition, readiness, options = {}) {
  return {
    importDisposition,
    readiness,
    ...(options.validationIssues ? { validationIssues: options.validationIssues } : {}),
    ...(options.reason ? { reason: options.reason } : {})
  };
}

function ready() {
  return {
    status: "Ready",
    validationIssues: []
  };
}

function review(issueCode, issueDetail, validationIssues) {
  return {
    status: "NeedsReview",
    issueCode,
    issueDetail,
    validationIssues
  };
}

function blocked(issueCode, issueDetail, validationIssues) {
  return {
    status: "Blocked",
    issueCode,
    issueDetail,
    validationIssues
  };
}

function issue(code, severity, sourceField, detail) {
  return {
    code,
    severity,
    sourceField,
    detail
  };
}

function at(context, minutes) {
  return toIso(new Date(Date.parse(context.referenceTimeUtc) + minutes * MINUTE_MS));
}

function addSeconds(isoDateTime, seconds) {
  return toIso(new Date(Date.parse(isoDateTime) + seconds * SECOND_MS));
}

function toIso(date) {
  return date.toISOString().replace(".000Z", "Z");
}

function publishDelay(context, ordinal) {
  return 8 + (Number.parseInt(shortHash(`${context.seed}:publish:${ordinal}`).slice(0, 2), 16) % 8);
}

function shortHash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function pad(value) {
  return String(value).padStart(4, "0");
}
