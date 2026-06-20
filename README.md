# maintenance-data-simulator

Neutral source-system simulator for the maintenance-planning API prototype.

## What This Is

This repository will generate deterministic synthetic maintenance data:

- source-system-shaped work-order events;
- asset and functional-location context;
- major event windows;
- parts availability and crew capacity changes;
- scenario packs for local and deployed smoke checks.

It supports local HTTP feed mode first, then AWS EventBridge publish mode.

## Boundary

This is a simulator for review and learning. It does not connect to any employer, client or production source system. It does not own persistence, planning recommendations, API authorization or production data.

## Showcase Repos

This simulator is one part of a three-repo synthetic maintenance-planning showcase:

- [maintenance-planning-api](https://github.com/pedroportella/maintenance-planning-api) owns persistence, planning recommendations, operations posture, worker ingestion, replay and outbound events.
- [maintenance-data-simulator](https://github.com/pedroportella/maintenance-data-simulator) produces deterministic synthetic source-system-shaped data for local HTTP feed checks and explicit AWS EventBridge publish checks.
- [maintenance-planning-web](https://github.com/pedroportella/maintenance-planning-web) provides the React planner workbench over typed service adapters, using mock mode by default and backend mode only when pointed at the API server-side.

Use this repo to create repeatable input evidence. The API remains the source of recommendation and audit truth, while the web repo presents the planner workflow after data has been seeded or published.

For a whole-system local Docker recipe, see the [local Docker system runbook](https://github.com/pedroportella/maintenance-planning-api/blob/main/docs/local-docker-system.md).

## Start Here

- [Reviewer runbook](docs/reviewer-runbook.md)
- [Scenarios](docs/scenarios.md)
- [Event contracts](docs/event-contracts.md)
- [Containerisation](docs/containerisation.md)
- [HTTP feed mode](docs/http-feed-mode.md)
- [AWS publish mode](docs/aws-publish-mode.md)
- [Production-next](docs/production-next.md)

## Current State

The repository contains deterministic scenario generation, three checked-in scenario packs and event contracts:

- `schemas/scenario-pack.schema.json`
- `schemas/maintenance-event-envelope.schema.json`
- `schemas/payloads/work-order-event-payload.schema.json`
- `schemas/payloads/major-event-window-payload.schema.json`
- `schemas/payloads/parts-availability-payload.schema.json`
- `schemas/payloads/crew-capacity-payload.schema.json`
- `src/contracts/scenario-contract.mjs`
- `src/scenarios/scenario-generator.mjs`
- `scripts/simulator.mjs`
- `scripts/container-smoke.mjs`
- `Dockerfile`
- `scripts/generate-scenario.mjs`
- `scenarios/baseline-week.scenario.json`
- `scenarios/event-window-conflict.scenario.json`
- `scenarios/parts-delay-replan.scenario.json`

The scenario packs are generated from explicit seeds and include expected outcome counts for ready, blocked, rejected and deferred work. The container runner can generate scenarios, run HTTP feed dry-runs, post deterministic synthetic batches to a local API with an optional synthetic bearer token, publish deterministic synthetic events to EventBridge with explicit confirmation and run a scenario/API smoke that checks import idempotency, planning recommendations, a package decision and operations posture. A live deployed EventBridge/SQS/worker smoke still needs review infrastructure.

## Generate Scenarios

```bash
npm run generate:scenarios
node scripts/generate-scenario.mjs --list
node scripts/generate-scenario.mjs baseline-week
```

## Container Runner

```bash
npm run container:build
npm run container:run:generate
npm run container:run:feed:dry-run
npm run container:run:feed
npm run container:run:api-smoke
node scripts/container-smoke.mjs --image maintenance-data-simulator:local
```

The live container feed and API smoke commands expect the local API to be reachable from the container. They post to the maintenance-event import endpoint using scenario batch idempotency keys and an HTTP correlation id.

## API Scenario Smoke

```bash
cp .env.local.example .env.local
pnpm api:smoke --scenario baseline-week
node scripts/api-scenario-smoke.mjs --scenario baseline-week
simulator api-smoke --scenario baseline-week
```

The smoke reads `SIMULATOR_API_URL` from `.env.local` or the process environment when `--api-url` is omitted. It reads `SIMULATOR_API_TOKEN` or `--api-token` when the local API protects `/api/v1` routes. It checks local API readiness, feeds `baseline-week`, replays the same feed to prove import idempotency, starts a planning run, verifies recommendations include the imported ready work order, records a synthetic package decision and checks operations posture.

## AWS Publish Mode

```bash
simulator publish-aws --scenario baseline-week --event-bus-name maintenance-planning-review-events --aws-region ap-southeast-2 --confirm-aws-publish
simulator publish-aws --scenario baseline-week --event-bus-name maintenance-planning-review-events --aws-region ap-southeast-2 --aws-profile review --confirm-aws-publish
```

The command publishes one EventBridge entry per deterministic synthetic scenario event using the `maintenance-data-simulator` source and `MaintenanceEvent` detail type. It refuses live publishing without `--confirm-aws-publish`, an event bus name, a region and an explicit credential source hint. Credentials and profile names are not written to structured logs.

## Checks

```bash
node --test
node scripts/quality-guards.mjs all
node scripts/scenario-smoke.mjs
node scripts/api-scenario-smoke.mjs
node scripts/container-smoke.mjs --image maintenance-data-simulator:local
```
