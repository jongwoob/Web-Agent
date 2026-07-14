---
id: naver.mail.draft-send
provider: naver
status: active
automationLevel: workflow
risk: high
profile: .browser-profiles/naver-chrome
command: npm run workflow:naver-mail -- --draft-file work/naver-mail-draft.json --browser chrome --send-after-confirm --confirm-file work/naver-mail-confirm.txt --status-file work/naver-mail-status.json --headful
approvalGates:
  - approve recipient, subject, and body before sending
  - write yes to the confirm file only after explicit user approval
outputs:
  - work/naver-mail-status.json
  - .agent-runs/naver-mail-*/draft.png
---

# Naver Mail Draft And Send

Use this when the user asks to prepare or send Naver Mail.

## Flow

1. Create a UTF-8 draft JSON with `to`, `subject`, and `body`.
2. Run the workflow with `--send-after-confirm`.
3. Wait for `waiting_for_send_confirmation`.
4. Report recipient, subject, body, screenshot/status path, and page state to the user.
5. Write `yes` to the confirm file only after explicit approval.

## Notes

- Without explicit approval, leave the draft open and do not send.
- Login is handled in the browser profile or by manual login in the opened browser.
- For non-mutating health checks, run `workflow:naver-mail` with `--smoke-only`; it verifies login and compose availability without clicking Compose or creating a draft.
