---
id: common.open.user.browser
provider: generic
status: active
automationLevel: handoff
risk: low
profile: regular-user-browser
command: npm run workflow:open-user-browser -- --url <url> --browser chrome --status-file work/open-user-browser-status.json
approvalGates:
  - 로그인 정보와 다중 인증은 사용자가 브라우저에서 직접 처리한다
outputs:
  - work/open-user-browser-status.json
---

# 일반 사용자 브라우저 열기

일반 사용자가 쓰는 Chrome 또는 Edge에서 목적 페이지를 열 때 사용한다.

## 흐름

1. Google은 Google 홈, Naver는 Naver 홈, 그 밖의 사이트는 해당 origin 홈을 먼저 연다.
2. 같은 일반 사용자 브라우저에서 목적 URL을 연다.
3. 로그인이 필요하면 사용자가 브라우저 화면에서 직접 완료한다.

## 주의 사항

- 이 명령은 `--user-data-dir`를 지정하지 않으므로 기존 일반 사용자 프로필을 복제하거나 쿠키를 복사하지 않는다.
- Chrome 또는 Edge가 여러 프로필을 사용 중이면 현재 활성 또는 마지막으로 선택한 프로필에서 열릴 수 있다.
- 이미 실행 중인 일반 사용자 프로필에는 Playwright가 안전하게 연결할 수 없다. DOM 자동 조작이 필요하면 전용 제어 세션을 사용할지 사용자의 지시를 먼저 받는다.
