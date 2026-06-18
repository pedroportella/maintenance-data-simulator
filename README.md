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
- [HTTP feed mode](docs/http-feed-mode.md)
- [AWS publish mode](docs/aws-publish-mode.md)
- [Production-next](docs/production-next.md)

## Current State

Foundation guardrails only. Scenario generation will be added in later stages.

## Checks

```bash
node scripts/quality-guards.mjs all
node scripts/scenario-smoke.mjs
```
