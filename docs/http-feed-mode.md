# HTTP Feed Mode

Dry-run command:

```bash
simulator feed --scenario baseline-week --api-url http://localhost:5000 --dry-run
docker run --rm maintenance-data-simulator:local feed --scenario baseline-week --api-url http://host.docker.internal:5000 --dry-run
```

Dry-run mode validates and summarises deterministic synthetic scenario batches without posting to an API.

Local feed command:

```bash
simulator feed --scenario baseline-week --api-url http://localhost:5000
docker run --rm maintenance-data-simulator:local feed --scenario baseline-week --api-url http://host.docker.internal:5000
```

Live mode posts deterministic scenario batches to the local API maintenance-event import endpoint:

```text
POST /api/v1/imports/maintenance-events
```

The request body uses the scenario `sourceSystem`, `schemaVersion`, `batchIdempotencyKey` and maintenance `events`. Simulator-only `expectation` hints are removed before posting. Event envelopes keep the checked field names:

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

Scenario packs already include event idempotency keys and an `apiImport.batchIdempotencyKey`. Single-batch feeds use that batch key unchanged. Multi-batch feeds append a deterministic batch suffix so retries and replays stay idempotent per posted request.

The feed command sends an `X-Correlation-ID` header for the simulator run. Use `--correlation-id` to make it explicit in a local smoke; otherwise the CLI generates one for the run. The correlation header is not added to the deterministic event body.

Useful options:

```bash
simulator feed --scenario baseline-week --api-url http://localhost:5000 --batch-size 50
simulator feed --scenario baseline-week --api-url http://localhost:5000 --max-retries 3 --retry-delay-ms 250
simulator feed --scenario baseline-week --api-url http://localhost:5000 --timeout-ms 10000 --correlation-id local-review-001
```

Retry behavior is intentionally narrow: network failures and retryable HTTP statuses such as `408`, `429` and `5xx` responses are retried with exponential backoff. Contract failures such as `409` or `422` are summarized once and return a non-zero exit code.

Structured logs include the sanitized API target, scenario id, event count, batch count, batch idempotency key, HTTP status and import result counts. Credentials, query strings and fragments in the API URL are not written to logs.

This mode is for local integration feedback with synthetic data. It does not connect to real source systems and does not replace the planned AWS publish path.

## API Scenario Smoke

The API scenario smoke builds on live HTTP feed mode and verifies the next local planning boundary:

```bash
node scripts/api-scenario-smoke.mjs --scenario baseline-week --api-url http://localhost:5000
simulator api-smoke --scenario baseline-week --api-url http://localhost:5000
docker run --rm maintenance-data-simulator:local api-smoke --scenario baseline-week --api-url http://host.docker.internal:5000
```

The command waits for `/health/ready`, posts the scenario to `POST /api/v1/imports/maintenance-events`, posts the same scenario again to check idempotent replay, creates a planning run, fetches recommendations, records a package decision and reads operations posture.

Failure messages call out the boundary that failed: API availability, validation failure, idempotency drift or missing recommendations. The command only uses deterministic synthetic scenario data.
