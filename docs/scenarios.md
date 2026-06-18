# Scenarios

Checked-in scenario pack schema:

- `../schemas/scenario-pack.schema.json`

Checked-in scenario fixture:

- `../scenarios/baseline-week.scenario.json`

Planned scenario packs:

- `baseline-week`;
- `event-window-conflict`;
- `parts-delay-replan`.

Each scenario should be deterministic for a fixed seed and include expected outcome hints for the API planning run.

The `baseline-week` fixture uses seed `baseline-week:2026-01-15:contract-1` and covers:

- accepted work-order events;
- accepted-but-blocked work orders;
- a rejected record with missing source context;
- a stale update;
- a duplicate idempotency key;
- major event windows, parts availability and crew capacity events.

Scenario packs include an `apiImport` block with the planned endpoint, import kind and batch idempotency key. This keeps the contract aligned with the future local HTTP feed without claiming real source-system access.
