---
id: google.forms.create
provider: google
status: active
automationLevel: workflow
risk: medium
profile: .browser-profiles/google-forms-chrome
command: npm run workflow:google-forms-create -- --form-file work/approved-google-form.json --browser chrome --status-file work/google-forms-create-status.json --headful
approvalGates:
  - approve exact form title, description, questions, types, and options before creation
  - stop before publish, send, share, or respondent-link distribution
outputs:
  - work/google-forms-create-status.json
  - work/google-forms-create-inspect.json
  - work/google-forms-create-verified.png
---

# Google Forms Create

Use this when the user asks to create or update a Google Form.

## Flow

1. Draft the full form content in chat first.
2. Ask for explicit approval of the exact content.
3. Save the approved form JSON under `work/`.
4. Run the command in the front matter.
5. Verify the editor state from status, inspect JSON, and screenshot.

## Notes

- This workflow creates or edits content in the user's Google account, so approved content is required before opening Forms.
- Do not publish, send, share, or copy respondent links without a separate approval.
