# Containerisation

The simulator image packages the same deterministic synthetic scenario runner used by local checks and review smoke paths. It is a short-lived CLI container: it writes output, logs structured JSON for feed dry-runs and exits with a clear status code.

## Build

```bash
docker build -t maintenance-data-simulator:local .
npm run container:build
```

The Dockerfile uses a maintained Node.js long-term-support base, installs with the checked-in lockfile, runs the contract tests during the build and copies only runtime files into the final image. The runtime container uses a non-root user.

## Generate

```bash
docker run --rm maintenance-data-simulator:local generate --scenario baseline-week
npm run container:run:generate
```

The output is a deterministic synthetic scenario pack. It preserves the event envelope field names and readiness values used by the checked-in contracts.

## Feed Dry-Run

```bash
docker run --rm maintenance-data-simulator:local feed --scenario baseline-week --api-url http://host.docker.internal:5000 --dry-run
npm run container:run:feed:dry-run
```

Dry-run mode validates and summarises the scenario without posting to an API. Non-dry-run HTTP feed execution is intentionally left for the later local feed implementation.

For local host access, Docker Desktop usually supports `host.docker.internal`. Linux setups may need an explicit host gateway or a compose network. The dry-run command does not need the target API to be running.

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
