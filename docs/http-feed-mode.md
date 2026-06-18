# HTTP Feed Mode

Planned local command:

```bash
simulator feed --scenario baseline-week --api-url http://localhost:5000
```

This mode will post deterministic scenario batches to the API import endpoints. It should be the first integration path because it is easy to debug before AWS eventing exists.
