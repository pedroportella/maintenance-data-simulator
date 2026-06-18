# Scenarios

Checked-in scenario pack schema:

- `../schemas/scenario-pack.schema.json`

Checked-in scenario fixtures:

- `../scenarios/baseline-week.scenario.json`
- `../scenarios/event-window-conflict.scenario.json`
- `../scenarios/parts-delay-replan.scenario.json`

Each scenario should be deterministic for a fixed seed and include expected outcome hints for the API planning run.

Generate or refresh the fixtures with:

```bash
npm run generate:scenarios
node scripts/generate-scenario.mjs --list
node scripts/generate-scenario.mjs baseline-week
```

The `baseline-week` fixture covers:

- accepted work-order events;
- accepted-but-blocked work orders;
- a rejected record with missing source context;
- a stale update;
- a duplicate idempotency key;
- major event windows, parts availability and crew capacity events.

The `event-window-conflict` fixture covers overlapping event windows, capacity review, a status-change event that marks a work order as deferred, a stale update and a retried event.

The `parts-delay-replan` fixture covers unavailable and later available parts, accepted-but-blocked planning context, missing equipment, priority and work-center context, a rejected record, a stale update and a retried event.

Each generated pack includes `expectedOutcomes.counts` for ready, blocked, rejected and deferred planner-facing results.

Scenario packs include an `apiImport` block with the planned endpoint, import kind and batch idempotency key. This keeps the contract aligned with the future local HTTP feed without claiming real source-system access.
