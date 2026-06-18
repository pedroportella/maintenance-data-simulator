# HTTP Feed Mode

Current dry-run command:

```bash
simulator feed --scenario baseline-week --api-url http://localhost:5000 --dry-run
docker run --rm maintenance-data-simulator:local feed --scenario baseline-week --api-url http://host.docker.internal:5000 --dry-run
```

Dry-run mode validates and summarises deterministic synthetic scenario batches without posting to an API.

Planned local feed command:

```bash
simulator feed --scenario baseline-week --api-url http://localhost:5000
```

The planned live mode will post deterministic scenario batches to the API import endpoints. It should be the first integration path because it is easy to debug before AWS eventing exists.
