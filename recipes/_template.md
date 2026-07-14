# Recipe Template

```yaml
---
id: provider.task
provider: google
status: draft
automationLevel: doc-only
risk: low
profile: .browser-profiles/google-example-chrome
command: npm run workflow:example -- --url <url> --browser chrome --headful
approvalGates:
  - stop before external submission or account changes
outputs:
  - work/example-status.json
---
```

## Use When

Describe the request shape this recipe handles.

## Flow

1. Confirm inputs.
2. Run the command.
3. Inspect status and outputs.

## Recovery

Describe common blocked states and the next safe step.
