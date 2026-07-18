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

일반 사용자가 쓰는 Chrome 또는 Edge의 기존 인스턴스를 우선 재사용해 목적 페이지를 열 때 사용한다.

## 흐름

1. Google은 Google 홈, Naver는 Naver 홈, 그 밖의 사이트는 해당 origin 홈을 먼저 연다.
2. `--new-window` 없이 같은 일반 사용자 브라우저 인스턴스에 목적 URL을 전달한다.
3. 목적 URL이 익명 접근 가능하면 로그인 없이 진행한다. 실제 로그인 화면으로 전환될 때만 사용자가 브라우저 화면에서 직접 완료한다.

## 주의 사항

- 이 명령은 `--user-data-dir`를 지정하지 않으므로 기존 일반 사용자 프로필을 복제하거나 쿠키를 복사하지 않는다.
- Chrome 또는 Edge가 여러 프로필을 사용 중이면 현재 활성 또는 마지막으로 선택한 프로필에서 열릴 수 있다.
- 이미 실행 중인 일반 사용자 프로필에는 Playwright가 안전하게 연결할 수 없다. DOM 자동 조작이 필요하면 전용 제어 세션을 사용할지 사용자의 지시를 먼저 받는다.
- 일반 사용자 탭은 자동으로 검사·클릭·교체하지 않는다. 사용자가 이미 열어 둔 탭에서 이어서 처리할 수 있는 작업은 사용자가 직접 진행한다.
