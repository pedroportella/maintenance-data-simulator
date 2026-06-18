# Event Contracts

Planned event envelope:

- `eventId`
- `eventType`
- `schemaVersion`
- `sourceSystem`
- `sourceRecordId`
- `correlationId`
- `occurredAt`
- `publishedAt`
- `idempotencyKey`
- `payload`

Initial event types:

- `WorkOrderCreated`
- `WorkOrderUpdated`
- `WorkOrderStatusChanged`
- `MajorEventWindowPublished`
- `PartsAvailabilityChanged`
- `CrewCapacityChanged`
