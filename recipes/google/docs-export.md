---
id: google.docs.export
provider: google
status: active
automationLevel: workflow
risk: low
profile: .browser-profiles/google-docs-chrome
command: npm run workflow:google-docs-export -- --url <google-doc-url> --format docx --browser chrome --status-file work/google-docs-export-status.json --headful
approvalGates:
  - confirm the source document and output format when ambiguous
outputs:
  - work/google-docs-export-status.json
  - work/google-docs-export-screenshot.png
  - work/downloads/*.docx
---

# Google Docs Export

Use this when the user asks to download a native Google Doc.

## Flow

1. Use the exact Google Docs URL.
2. Choose `docx`, `pdf`, `odt`, `rtf`, `txt`, or `epub`.
3. Run the workflow and let the user log in directly if required.
4. Inspect the status file and downloaded output.

## Notes

- The default format is `docx`.
- Downloads are saved under `work/downloads/` unless `--output-file` is supplied.
