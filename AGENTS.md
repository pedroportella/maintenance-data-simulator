# Maintenance Data Simulator Agent Guide

Durable repo guidance for the maintenance-data-simulator prototype.

## Where Context Belongs

- Keep stable engineering rules here.
- Keep private research, stage notes and caveats in the parent workspace `ai-notes/`.
- Keep public README/docs short and neutral.
- Do not copy private planning history into public docs, generated scenarios or commit subjects.

## Project Boundary

- This is a neutral source-system simulator for maintenance-planning workflows.
- Use synthetic data only.
- Do not use company branding, industry-specific language, real client data, real source-system access or production-infrastructure claims.
- This repo does not own persistence, planning recommendations or API authorization.

## Simulator Rules

- Generate deterministic scenario data from explicit seeds.
- Keep event envelopes versioned and schema-validated.
- Include correlation ids and idempotency keys in emitted events.
- Prefer clear scenario names and expected outcome hints over large random data dumps.
- Keep local HTTP feed mode easy to run before AWS publish mode exists.

## AWS Rules

- AWS publish mode must be explicit and confirmation-gated.
- Do not commit credentials, profiles, account ids, ARNs, generated secrets or sensitive outputs.
- Log event ids and counts, not credentials or sensitive config.

## Tests And Checks

- Add schema and deterministic-output tests when scenario behaviour changes.
- Keep scenario smoke fast and useful.
- Run guards after public docs, generated examples or AWS publish changes.

## Documentation

- README should answer: what this is, how to generate scenarios, how to feed the API and what is synthetic.
- Public docs are evidence notes, not implementation diaries.
- Scenario examples should be small enough to review.
