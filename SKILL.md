---
name: web-agent
description: 일반 사용자의 Chrome 또는 Edge를 먼저 열고, 필요 시 승인된 Playwright workflow로 웹사이트 이동, 검색, 클릭, 입력, 다운로드, 정보 추출을 수행하는 로컬 웹 작업 에이전트. Google Workspace, Naver Mail, 일반 웹 작업과 최종 승인 절차가 필요한 작업에 사용한다.
---

# Web Agent

이 저장소 루트에서 명령을 실행한다. Codex skill로 설치할 때는 이 저장소를 작업 경로로 지정하거나 `WEB_AGENT_HOME` 환경 변수에 저장소 경로를 설정한다.

## 일반 사용자 브라우저 우선

```powershell
npm run workflow:open-user-browser -- --url <url> --browser chrome
npm run workflow:open-user-browser -- --url <url> --browser edge
```

- Google은 Google 홈, Naver는 Naver 홈, 그 밖의 사이트는 해당 origin 홈을 먼저 연다.
- 일반 사용자 Chrome 또는 Edge를 열 때 profile 경로, cookie, password, OTP, recovery code를 복사하거나 전달하지 않는다.
- 일반 사용자 profile이 실행 중이면 Playwright가 안전하게 연결할 수 없으므로 전용 제어 profile로 조용히 전환하지 않는다. 자동 조작이 필요하면 사용자의 직접 진행 또는 별도 제어 session 허용 여부를 먼저 확인한다.

## 안전 규칙

- 모든 Chromium 실행은 `chromiumSandbox: true`를 사용한다. `--no-sandbox`와 `chromiumSandbox: false`는 사용하지 않는다.
- 전송, 제출, 공유, 구매, 삭제, 계정 변경, 게시, 민감 정보 입력은 최종 화면과 내용을 준비한 뒤 사용자에게 명시적으로 승인받는다.
- 로그인·다중 인증은 사용자가 browser 창에서 직접 완료한다.
- 다운로드와 실행 산출물은 `work/`에 저장하고, 민감 데이터가 포함될 수 있는 `work/`, `.agent-runs/`, `.browser-profiles/`, `.env`는 Git에 올리지 않는다.

## 검증

```powershell
npm run build
npm test
npm run recipes:check
```
