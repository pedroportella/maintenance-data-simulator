# Reviewer Runbook

Use this runbook to inspect the simulator as the synthetic source-system-shaped data producer for the maintenance-planning showcase.

## Cross-Repo Fit

- [maintenance-planning-api](https://github.com/pedroportella/maintenance-planning-api) stores imported data, creates planning recommendations, reports operations posture and runs the worker path.
- [maintenance-data-simulator](https://github.com/pedroportella/maintenance-data-simulator) generates deterministic synthetic events, feeds the local API over HTTP and can publish the same events to EventBridge for a review stack.
- [maintenance-planning-web](https://github.com/pedroportella/maintenance-planning-web) shows the planner journey after the API has either been seeded locally or populated through the deployed event path.

## Local Review

```bash
pnpm install
pnpm verify
pnpm simulator generate --scenario baseline-week
pnpm simulator feed --scenario baseline-week --dry-run
```

When the sibling API is running with local SQL Server and a synthetic bearer token, seed it with:

```bash
cp .env.local.example .env.local
pnpm api:smoke --scenario baseline-week
```

The API smoke checks readiness, posts the deterministic scenario, retries the feed for idempotency, starts a planning run, records a synthetic package decision and checks operations posture.

## Container Review

```bash
pnpm container:build
pnpm container:smoke
pnpm container:run:feed:dry-run
```

The live container feed and API smoke commands expect the sibling API to be reachable from the container runtime. Keep local tokens in `.env.local` or process environment variables; do not place credentials in docs, images or committed files.

## Live AWS Publish Smoke

Run this only after the API review stack has been planned, applied and released with digest-pinned images and populated runtime secrets.

1. Confirm the API, worker, queues, EventBridge rule and database are healthy from the API runbook.
2. Publish `baseline-week` to the review event bus with `--confirm-aws-publish`.
3. Confirm EventBridge accepted the entries without logging credentials or account identifiers.
4. Confirm the worker consumed queue messages and persisted synthetic work-order projections.
5. Confirm operations posture reports freshness, queue depth and dead-letter state.
6. Use the web backend smoke after the scenario is visible through the API.

This repository state has not yet been used for a live AWS publish, SQS delivery, worker consumption or SQL projection smoke.
