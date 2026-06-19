# AWS Publish Mode

Publish a deterministic synthetic scenario to EventBridge:

```bash
simulator publish-aws \
  --scenario baseline-week \
  --event-bus-name maintenance-planning-review-events \
  --aws-region ap-southeast-2 \
  --confirm-aws-publish
```

Named profile runs are explicit:

```bash
simulator publish-aws \
  --scenario baseline-week \
  --event-bus-name maintenance-planning-review-events \
  --aws-region ap-southeast-2 \
  --aws-profile review \
  --confirm-aws-publish
```

Container review tasks can provide the same values through environment:

```bash
SIMULATOR_EVENT_BUS_NAME=maintenance-planning-review-events
SIMULATOR_AWS_REGION=ap-southeast-2
simulator publish-aws --scenario baseline-week --confirm-aws-publish
```

The command refuses to run unless `--confirm-aws-publish` is present. It also requires an EventBridge bus name, an AWS region and an explicit credential source hint such as a named AWS profile, environment credentials, web identity or task-role credentials.

Each scenario event is sent as one EventBridge entry:

- `Source`: `maintenance-data-simulator`
- `DetailType`: `MaintenanceEvent`
- `Detail`: the maintenance event envelope without simulator-only expectation hints

The API worker consumes the EventBridge-delivered queue message and imports the envelope from `detail`. Scenario event ids and idempotency keys stay unchanged, so replayed deliveries can be audited without creating duplicate projections.

Structured logs include scenario id, event count, batch count, event bus name, region and publish result counts. They do not log credential values, profile names, raw SDK error messages, account ids or ARNs.

The command is ready for deployed review smoke, but this repository state does not prove a live EventBridge/SQS/worker/database path until it is run against review infrastructure.
