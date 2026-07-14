---
id: google.slides.export
provider: google
status: active
automationLevel: workflow
risk: low
profile: .browser-profiles/google-slides-chrome
command: npm run workflow:google-slides-export -- --url <google-slides-url> --format pptx --browser chrome --status-file work/google-slides-export-status.json --headful
approvalGates:
  - confirm the source presentation and output format when ambiguous
outputs:
  - work/google-slides-export-status.json
  - work/google-slides-export-screenshot.png
  - work/downloads/*.pptx
---

# Google Slides Export

Use this when the user asks to download a native Google Slides presentation.

## Flow

1. Use the exact Google Slides URL.
2. Choose `pptx` or `pdf`.
3. Run the workflow and let the user log in directly if required.
4. Inspect the status file and downloaded output.

## Notes

- The default format is `pptx`.
- This workflow does not edit or share the source presentation.
