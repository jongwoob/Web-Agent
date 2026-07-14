---
id: google.gmail.draft
provider: google
status: draft
automationLevel: doc-only
risk: high
profile: .browser-profiles/google-gmail-chrome
command: npm run agent -- --url https://mail.google.com/ --task "prepare Gmail draft only; do not send" --model heuristic --headful
approvalGates:
  - approve recipient, subject, and body before preparing the draft
  - stop before Send and ask for explicit approval
outputs:
  - .agent-runs/*/steps.json
---

# Gmail Draft

Use this when the user asks to prepare a Gmail draft.

## Flow

1. Confirm recipient, subject, and body in chat.
2. Open Gmail with the dedicated profile.
3. Fill the draft only.
4. Stop before Send and report the final recipient, subject, body, and visible page state.

## Notes

- This is intentionally doc-only until a dedicated Gmail workflow is implemented.
- Never send, schedule-send, or add sensitive content without explicit approval.
