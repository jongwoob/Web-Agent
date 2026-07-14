---
id: google.search.extract
provider: google
status: active
automationLevel: workflow
risk: low
profile: .browser-profiles/google-search-chrome
command: npm run workflow:web-extract -- --url <url> --browser chrome --status-file work/web-extract-status.json --headful
approvalGates:
  - avoid credential, payment, and private account pages unless explicitly requested and safe
outputs:
  - work/web-extract-status.json
  - work/web-extract-output.json
  - work/web-extract-screenshot.png
---

# Google Search And Page Extract

Use this for safe page reading, search-result inspection, and general extraction.

## Flow

1. Navigate directly to the target URL or search URL.
2. Run `workflow:web-extract`.
3. Review the JSON output and screenshot.

## Notes

- Use `--selector main` or another stable selector to narrow extraction.
- This recipe reads page content only. It does not submit forms or change account state.
