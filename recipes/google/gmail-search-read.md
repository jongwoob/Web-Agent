---
id: google.gmail.search-read
provider: google
status: active
automationLevel: workflow
risk: high
profile: .browser-profiles/google-gmail-chrome
command: npm run workflow:gmail-search-read -- --query <gmail-search-query> --browser chrome --output-file work/mail/gmail-search-results.json --status-file work/gmail-search-read-status.json --headful
approvalGates:
  - confirm the mailbox and filter when the request is ambiguous
  - extract a full body only when the user explicitly asks to inspect message content
  - opening an unread result requires approval because it may mark the message as read
  - stop before reply, forward, attachment download, link opening, label changes, archive, spam, or delete
outputs:
  - work/gmail-search-read-status.json
  - work/mail/gmail-search-results.json
  - work/gmail-read-confirm.txt
---

# Gmail Search And Read

Use this when the user asks to filter Gmail messages or inspect the content of a matching message.

## List Flow

1. Translate the request into a Gmail search query or filter JSON.
2. Run the command in the front matter without `--read-first`.
3. Return sender, subject, date, unread state, and snippet from up to 20 results by default.
4. Do not open messages, links, or attachments during list-only filtering.

## Content Flow

Add `--read-first --confirm-read-file work/gmail-read-confirm.txt` only when the user asks for the first matching message body. If the message appears unread, the workflow writes the list output, reports `waiting_for_unread_open_confirmation`, and waits for `yes` or `no`.

## Filter JSON

```json
{
  "query": "project update",
  "from": "person@example.com",
  "subject": "weekly report",
  "after": "2026-07-01",
  "before": "2026-08-01",
  "unread": true,
  "hasAttachment": true,
  "labels": ["inbox"]
}
```

Use the JSON with `--filter-file <file>` when shell quoting would be awkward.

## Privacy

- Full message bodies are written only to the explicit output JSON and never printed to the terminal or status message.
- Screenshots are disabled by default because inbox and message views can contain sensitive information.
- This workflow never replies, forwards, downloads attachments, opens message links, changes labels, archives, marks spam, or deletes mail.

## User-Facing Summary

Lead with the requested results in a short list or compact table. Summarize body content into the few fields relevant to the request, omit unrelated personal data and raw message text, and keep workflow status, elapsed time, and output path to one final line.
