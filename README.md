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

## Start Here

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

The scenario packs are generated from explicit seeds and include expected outcome counts for ready, blocked, rejected and deferred work. The container runner can generate scenarios, run HTTP feed dry-runs, post deterministic synthetic batches to a local API and run a scenario/API smoke that checks import idempotency, planning recommendations, a package decision and operations posture. AWS publish commands remain planned execution modes.

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
npm run api:smoke -- --api-url http://localhost:5000
node scripts/api-scenario-smoke.mjs --scenario baseline-week --api-url http://localhost:5000
simulator api-smoke --scenario baseline-week --api-url http://localhost:5000
```

The smoke checks local API readiness, feeds `baseline-week`, replays the same feed to prove import idempotency, starts a planning run, verifies recommendations include the imported ready work order, records a synthetic package decision and checks operations posture.

## Checks

```bash
node --test
node scripts/quality-guards.mjs all
node scripts/scenario-smoke.mjs
node scripts/api-scenario-smoke.mjs --api-url http://localhost:5000
node scripts/container-smoke.mjs --image maintenance-data-simulator:local
```
