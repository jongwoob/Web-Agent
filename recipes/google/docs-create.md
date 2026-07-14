---
id: google.docs.create
provider: google
status: draft
automationLevel: doc-only
risk: medium
profile: .browser-profiles/google-docs-chrome
command: n/a
approvalGates:
  - approve the exact title and document body before creating a Drive file
  - stop before share, publish, comment notifications, or permission changes
outputs:
  - work/approved-google-doc.json
---

# Google Docs Create

This recipe records the safety and content contract for future Google Docs creation automation.

## Flow

1. Draft the exact title and body locally.
2. Ask for explicit approval before opening `docs.new`, because opening it creates a Drive file.
3. Create and verify only the approved content.
4. Stop before sharing, publishing, commenting, or changing permissions.

## Notes

- This recipe remains `draft` because the Google Docs editor surface is not yet covered by a dedicated verified workflow.
- Use `docs-export.md` for the active read-only Docs workflow.
