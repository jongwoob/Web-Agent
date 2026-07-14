---
id: google.drive.download
provider: google
status: active
automationLevel: workflow
risk: low
profile: .browser-profiles/google-drive-chrome
command: npm run workflow:google-drive-download -- --file-url <google-drive-file-url> --browser chrome --status-file work/google-drive-download-status.json --headful
approvalGates:
  - confirm the target Drive file when the request is ambiguous
outputs:
  - work/google-drive-download-status.json
  - work/google-drive-download-screenshot.png
  - work/downloads/*
---

# Google Drive Download

Use this when the user asks to download a file from Google Drive.

## Flow

1. Use the exact Drive file URL when available.
2. Run the workflow with `--file-url`.
3. If Google login appears, let the user log in directly in the browser.
4. Inspect the status file and downloaded file path.

## Notes

- This recipe is for downloadable Drive files. Native Google Docs, Sheets, and Slides may require a later export-specific recipe.
- The workflow handles direct Drive download links and common confirmation screens.
