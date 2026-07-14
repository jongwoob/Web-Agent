---
id: google.calendar.event-create
provider: google
status: active
automationLevel: workflow
risk: high
profile: .browser-profiles/google-calendar-chrome
command: npm run workflow:google-calendar-event-create -- --event-file work/google-calendar-event.json --browser chrome --create-after-confirm --confirm-file work/google-calendar-confirm.txt --status-file work/google-calendar-event-status.json --headful
approvalGates:
  - review the exact title, start, end, time zone, location, details, and guests
  - stop on the prepared event screen and require explicit approval before Save
outputs:
  - work/google-calendar-event-status.json
  - work/google-calendar-event-screenshot.png
  - work/google-calendar-confirm.txt
---

# Google Calendar Event Create

Use this when the user asks to prepare or create a Google Calendar event.

## Event JSON

```json
{
  "title": "Project review",
  "start": "2026-07-13T10:00:00+09:00",
  "end": "2026-07-13T11:00:00+09:00",
  "timeZone": "Asia/Seoul",
  "location": "Meeting room A",
  "details": "Review the release checklist.",
  "guests": ["person@example.com"]
}
```

For an all-day event, set `allDay` to `true` and use `YYYY-MM-DD`. The end date is exclusive; when omitted, it defaults to the next day.

## Flow

1. Save the proposed event JSON under `work/`.
2. Start the workflow with a unique status and confirmation file.
3. Let the user log in directly if Google requests authentication.
4. Wait for `waiting_for_creation_confirmation` and report the exact event fields.
5. Write `yes` only after explicit approval, or `no` to cancel.
6. Verify the final status and screenshot.

## Notes

- Timed events require ISO date-times with `Z` or an explicit UTC offset.
- Adding guests can send invitations when the event is saved, so Save is always approval-gated.
