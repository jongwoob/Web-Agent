---
id: google.sheets.export-file
provider: google
status: active
automationLevel: workflow
risk: low
profile: .browser-profiles/google-sheets-chrome
command: npm run workflow:google-sheets-export-file -- --url <google-sheet-url> --format xlsx --browser chrome --status-file work/google-sheets-export-file-status.json --headful
approvalGates:
  - confirm the source spreadsheet and output format when ambiguous
outputs:
  - work/google-sheets-export-file-status.json
  - work/google-sheets-export-file-screenshot.png
  - work/downloads/*.xlsx
---

# Google Sheets File Export

Use this when the user asks to download an entire native Google Sheet workbook.

## Flow

1. Use the exact Google Sheets URL.
2. Choose `xlsx`, `pdf`, or `ods`.
3. Run the workflow and let the user log in directly if required.
4. Inspect the status file and downloaded output.

## Notes

- Use `sheets-export-csv.md` when only one tab is needed as CSV.
- The default format is `xlsx`.
