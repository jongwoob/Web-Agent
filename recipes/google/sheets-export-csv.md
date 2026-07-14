---
id: google.sheets.export-csv
provider: google
status: active
automationLevel: workflow
risk: low
profile: .browser-profiles/google-sheets-chrome
command: npm run workflow:google-sheets-export-csv -- --sheet-url <google-sheet-url> --browser chrome --status-file work/google-sheets-export-csv-status.json --headful
approvalGates:
  - confirm the target sheet URL when the request is ambiguous
outputs:
  - work/google-sheets-export-csv-status.json
  - work/google-sheets-export-csv-screenshot.png
  - work/downloads/*.csv
---

# Google Sheets CSV Export

Use this when the user asks to download a Google Sheet tab as CSV.

## Flow

1. Use the exact Google Sheets URL when available.
2. Run the workflow with `--sheet-url`.
3. If Google login appears, let the user log in directly in the browser.
4. Inspect the status file and downloaded CSV path.

## Notes

- The workflow uses `gid` from the URL when present.
- Downloads are saved under `work/downloads/` unless `--output-file` is provided.
