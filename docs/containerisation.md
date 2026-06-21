# Containerisation

The simulator image packages the same deterministic synthetic scenario runner used by local checks and review smoke paths. It is a short-lived CLI container: it writes output, logs structured JSON for feed runs and exits with a clear status code.

For the cross-repo local Docker recipe, including API, simulator and web commands, see the [local Docker system runbook](https://github.com/pedroportella/maintenance-planning-api/blob/main/docs/local-docker-system.md).

## Build

```bash
docker build -t maintenance-data-simulator:local .
npm run container:build
```

The Dockerfile uses a maintained Node.js long-term-support base, installs with the checked-in lockfile, runs the contract tests during the build and copies only runtime files into the final image. The runtime container uses a non-root user.

## Generate

```bash
docker run --rm maintenance-data-simulator:local generate --scenario baseline-week
docker run --rm maintenance-data-simulator:local generate --scenario baseline-week --repeat 25
npm run container:run:generate
npm run container:run:generate:bulk
```

The output is a deterministic synthetic scenario pack. It preserves the event envelope field names and readiness values used by the checked-in contracts.

## Feed Dry-Run

```bash
docker run --rm maintenance-data-simulator:local feed --scenario baseline-week --api-url http://host.docker.internal:5000 --dry-run
npm run container:run:feed:dry-run
```

Dry-run mode validates and summarises the scenario without posting to an API.

## Local HTTP Feed

```bash
docker run --rm maintenance-data-simulator:local feed --scenario baseline-week --api-url http://host.docker.internal:5000 --api-token local-reviewer-token
docker run --rm maintenance-data-simulator:local feed --scenario baseline-week --repeat 25 --batch-size 50 --api-url http://host.docker.internal:5000 --api-token local-reviewer-token
npm run container:run:feed
npm run container:run:feed:bulk
```

Live feed mode posts deterministic synthetic maintenance-event batches to the local API import endpoint. It uses scenario batch idempotency keys, an HTTP correlation id and retry/backoff for network failures or retryable HTTP responses. The command exits non-zero when the API returns a contract, idempotency or persistence error.

Use `--repeat` for a larger deterministic synthetic pack when testing API import volume or Planner Workbench backend mode with more records. Re-running the same repeat value replays the same larger pack idempotently.

For local host access, Docker Desktop usually supports `host.docker.internal`. Linux setups may need an explicit host gateway or a compose network. The dry-run command does not need the target API to be running.

## AWS Publish Mode

```bash
docker run --rm \
  -e SIMULATOR_EVENT_BUS_NAME=maintenance-planning-review-events \
  -e SIMULATOR_AWS_REGION=ap-southeast-2 \
  -e AWS_PROFILE=review \
  -v "$HOME/.aws:/app/.aws:ro" \
  maintenance-data-simulator:local \
  publish-aws --scenario baseline-week --repeat 25 --aws-profile review --confirm-aws-publish
```

Review tasks should provide credentials through the task role or a local named profile mounted outside the image for manual checks. The command publishes deterministic synthetic maintenance events to EventBridge and exits non-zero if EventBridge reports failed entries.

## API Scenario Smoke

```bash
docker run --rm maintenance-data-simulator:local api-smoke --scenario baseline-week --api-url http://host.docker.internal:5000 --api-token local-reviewer-token
docker run --rm maintenance-data-simulator:local api-smoke --scenario baseline-week --repeat 25 --api-url http://host.docker.internal:5000 --api-token local-reviewer-token
npm run container:run:api-smoke
```

The smoke uses the same runtime image and checks the local API boundary end to end: readiness, scenario import, idempotent replay, planning-run creation, recommendations, a synthetic package decision and operations posture.

## Restricted Smoke

```bash
docker run --rm --read-only --cap-drop=ALL --memory=256m --cpus=0.25 maintenance-data-simulator:local feed --scenario baseline-week --api-url http://host.docker.internal:5000 --dry-run
node scripts/container-smoke.mjs --image maintenance-data-simulator:local
```

The smoke helper checks the image metadata, deterministic generation, dry-run logs, restricted execution and absence of review-only files such as docs, tests, checked-in fixtures, Git metadata and generated outputs from the runtime filesystem.

## Image Identity

Local development uses explicit local tags such as `maintenance-data-simulator:local`. Review pipelines should tag images with the source revision and set the matching OCI revision label. Review deployment should resolve and run the image digest rather than relying on a mutable tag, and registries should keep tag immutability and image scanning enabled where supported.

Do not use an implicit `latest` tag as deployment identity.

## Secrets And Supply Chain Notes

The build currently needs no private package feed or credentials. If a future build needs private package access, use BuildKit secret or SSH mounts and keep credentials out of Dockerfile build arguments, image environment variables, logs and checked-in files.

SBOM generation, provenance attestations and image signing are production-next controls for a later publish path.
