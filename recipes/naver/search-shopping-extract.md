---
id: naver.search-shopping.extract
provider: naver
status: active
automationLevel: workflow
risk: medium
profile: .browser-profiles/naver-public-chrome
command: npm run workflow:naver-search-shopping-extract -- --url <naver-search-or-shopping-url> --selector main --browser chrome --headful
approvalGates:
  - review Naver operating guidelines before use
outputs:
  - work/naver-search-shopping-*.json
  - work/naver-search-shopping-*.png
---

# Naver Search And Shopping Extract

Use this only after the Naver operating guidelines are reviewed for the specific task.

## Flow

1. Confirm the query and extraction goal.
2. Check whether login, purchase, reviews, comments, or account changes are involved.
3. If it is read-only and low frequency, run a safe extraction flow and save JSON plus screenshot.

## Notes

- This recipe is active only for low-frequency, read-only extraction in headful mode.
- Do not use it for purchase, cart, review, comment, posting, or bulk collection flows without a dedicated reviewed workflow.
- A headless smoke test on 2026-07-11 reached Naver Shopping's automated-access restriction page; a single headful recovery run returned the actual product results. Prefer headful and never retry repeatedly when the restriction page appears.
