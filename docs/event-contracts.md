# Event Contracts

Checked-in schemas:

- `../schemas/maintenance-event-envelope.schema.json`
- `../schemas/payloads/work-order-event-payload.schema.json`
- `../schemas/payloads/major-event-window-payload.schema.json`
- `../schemas/payloads/parts-availability-payload.schema.json`
- `../schemas/payloads/crew-capacity-payload.schema.json`

Event envelope fields:

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

Payloads include `sourceSystem`, `sourceId`, `sourceUpdatedAtUtc`, `sourceDataReadiness` and optional `validationIssues` where that source context is meaningful. Readiness values are `Ready`, `NeedsReview` and `Blocked`.

Scenario events also carry an `expectation` block for deterministic review. The supported import dispositions are `accepted`, `accepted-blocked`, `rejected`, `ignored-duplicate` and `ignored-stale`.

The local HTTP feed path is `/api/v1/imports/maintenance-events`. The simulator does not claim live source-system connectivity; all events are synthetic.
