import {
  DEFAULT_EVENTBRIDGE_DETAIL_TYPE,
  DEFAULT_EVENTBRIDGE_SOURCE,
  EVENTBRIDGE_MAX_ENTRIES_PER_REQUEST
} from "../utils/constants.mjs";

export {
  DEFAULT_EVENTBRIDGE_DETAIL_TYPE,
  DEFAULT_EVENTBRIDGE_SOURCE,
  EVENTBRIDGE_MAX_ENTRIES_PER_REQUEST
} from "../utils/constants.mjs";

export async function createEventBridgeClient({ region, profile }) {
  const [
    { EventBridgeClient, PutEventsCommand },
    { fromIni }
  ] = await Promise.all([
    import("@aws-sdk/client-eventbridge"),
    import("@aws-sdk/credential-providers")
  ]);
  const client = new EventBridgeClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {})
  });

  return {
    send(command) {
      return client.send(new PutEventsCommand(command.input));
    }
  };
}

export async function publishScenarioPackToEventBridge({
  client,
  scenarioPack,
  eventBusName,
  source = DEFAULT_EVENTBRIDGE_SOURCE,
  detailType = DEFAULT_EVENTBRIDGE_DETAIL_TYPE,
  batchSize = EVENTBRIDGE_MAX_ENTRIES_PER_REQUEST,
  onBatchResult
}) {
  if (!client || typeof client.send !== "function") {
    throw new Error("EventBridge client must provide send(command)");
  }

  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > EVENTBRIDGE_MAX_ENTRIES_PER_REQUEST) {
    throw new Error(`batchSize must be between 1 and ${EVENTBRIDGE_MAX_ENTRIES_PER_REQUEST}`);
  }

  const events = scenarioPack.events.map(toEventBridgeEntry);
  const batchCount = Math.ceil(events.length / batchSize);
  const summary = {
    scenarioId: scenarioPack.scenarioId,
    eventBusName,
    source,
    detailType,
    eventCount: events.length,
    batchCount,
    publishedCount: 0,
    failedCount: 0,
    eventIds: events.map((event) => event.eventId)
  };

  for (let index = 0; index < batchCount; index += 1) {
    const batchNumber = index + 1;
    const batchEvents = events.slice(index * batchSize, (index + 1) * batchSize);
    const command = createPutEventsCommand({
      Entries: batchEvents.map((event) => ({
        EventBusName: eventBusName,
        Source: source,
        DetailType: detailType,
        Time: event.time,
        Detail: event.detail
      }))
    });
    const response = await client.send(command);
    const batchSummary = summarizeBatchResponse({
      batchNumber,
      batchCount,
      batchEvents,
      response
    });

    summary.publishedCount += batchSummary.publishedCount;
    summary.failedCount += batchSummary.failedCount;
    onBatchResult?.(batchSummary);

    if (batchSummary.failedCount > 0) {
      throw new EventBridgePublishError(summary, batchSummary);
    }
  }

  return summary;
}

export class EventBridgePublishError extends Error {
  constructor(summary, batchSummary) {
    super(`EventBridge publish failed for batch ${batchSummary.batchNumber}/${batchSummary.batchCount}`);
    this.name = "EventBridgePublishError";
    this.summary = summary;
    this.batchSummary = batchSummary;
  }
}

function createPutEventsCommand(input) {
  return { input };
}

function toEventBridgeEntry(event) {
  const { expectation, ...envelope } = event;

  return {
    eventId: event.eventId,
    eventType: event.eventType,
    time: new Date(event.publishedAt ?? event.occurredAt),
    detail: JSON.stringify(envelope)
  };
}

function summarizeBatchResponse({ batchNumber, batchCount, batchEvents, response }) {
  const responseEntries = response?.Entries ?? [];
  const failedEntries = [];

  responseEntries.forEach((entry, index) => {
    if (!entry?.ErrorCode) return;

    failedEntries.push({
      eventId: batchEvents[index]?.eventId,
      eventType: batchEvents[index]?.eventType,
      errorCode: entry.ErrorCode
    });
  });

  const failedCount = response?.FailedEntryCount ?? failedEntries.length;
  const publishedCount = batchEvents.length - failedCount;

  return {
    batchNumber,
    batchCount,
    eventCount: batchEvents.length,
    publishedCount,
    failedCount,
    eventIds: batchEvents.map((event) => event.eventId),
    failedEntries
  };
}
