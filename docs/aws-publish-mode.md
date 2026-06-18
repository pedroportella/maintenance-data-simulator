# AWS Publish Mode

Planned deployed-review command:

```bash
simulator publish-aws --scenario baseline-week --event-bus-name maintenance-planning-review --confirm-aws-publish
```

AWS publish mode must require explicit confirmation and valid review-environment configuration. Do not commit credentials, account ids, ARNs or generated sensitive outputs.
