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
- 일반 사용자 Chrome 또는 Edge를 열 때 profile 경로, cookie, password, OTP, recovery code를 복사하거나 전달하지 않는다. `--new-window`를 강제하지 않고 이미 열린 일반 browser 인스턴스에 홈과 목적 URL을 전달한다.
- 일반 사용자 profile이 실행 중이면 Playwright가 안전하게 연결할 수 없으므로 전용 제어 profile로 조용히 전환하지 않는다. 일반 사용자 browser 자동 조작은 사용자가 설치하고 사이트 권한을 직접 허용한 `extensions/user-browser-bridge`의 레시피별 명령으로만 수행한다. 확장이 없거나 지원하지 않는 작업은 사용자의 직접 진행 또는 별도 제어 session 허용 여부를 먼저 확인한다.
- 제공자 홈에 로그인 버튼이 있어도 로그인부터 시도하지 않는다. 목적 페이지를 익명으로 먼저 열고, 실제 로그인 화면으로 전환된 경우에만 사용자의 직접 로그인을 기다린다.

## 브라우저와 탭 재사용

- 일반 사용자 browser의 기존 탭은 Playwright로 검사하거나 교체하지 않는다. 현재 작업에 같은 일반 browser를 사용할 수 있으면 홈과 목적 URL을 같은 browser 인스턴스에 전달하고, 사용자가 직접 이어서 작업한다.
- 일반 사용자 browser 연결 확장을 사용하는 레시피는 같은 목적 탭 또는 빈 탭만 재사용하고, 진행 중인 재생·업로드·입력 탭을 교체하지 않는다. 재사용할 탭이 없을 때만 이미 열린 일반 browser에 새 탭을 추가한다.
- DOM 자동 조작을 명시적으로 허용받은 전용 제어 session은 사이트별로 유지한다. 같은 origin의 유휴 탭을 먼저 재사용하고, 없으면 빈 탭을 사용한다.
- 다른 작업이 진행 중인 탭은 점유하거나 이동시키지 않는다. 재생·업로드처럼 계속 동작하는 탭은 예약해 교체하지 않는다. 재사용 가능한 전용 session이 있을 때는 새 browser를 열지 않는다.
- 새 전용 제어 browser는 재사용 가능한 session이 없고 사용자 허용이 있을 때만 만들며, 제어 session의 원격 디버깅 포트는 `127.0.0.1`에만 바인딩한다.
- `npm run agent -- --headful`은 명시적 제어 허용이 있을 때 이 재사용 경로를 사용한다. headless 범용 작업은 기존 격리 profile 방식을 유지한다.

## 레시피 입력

- 사용자가 `레시피 입력 시작`이라고 말하면 `npm run recipes:input:start`로 입력 상태를 시작한다. 이름과 설명이 아직 없어도 시작할 수 있다.
- 입력 중 사용자가 제공하는 이름, 설명, 호출 문구, URL, 페이지에서 수행한 행동, 검증 결과를 `npm run recipes:input:add`의 메타데이터·단계·메모·테스트 기록으로 누적한다. 사용자가 직접 browser를 조작하는 동안에는 이를 자동 조작으로 오인하지 않는다.
- 사용자가 `레시피 입력 종료`이라고 말하면 `npm run recipes:input:finish`로 기본 `recipes/local/`에 저장하고 생성된 경로와 `active` 또는 `draft` 상태를 알린다. `recipes/local/`은 Git에서 제외한다.
- 사용자가 공개 저장을 명시적으로 요청한 경우에만 `--publish`로 `recipes/<provider>/`에 저장한다. 이 명령은 Git add, commit, push를 자동 수행하지 않는다.
- 비밀번호, OTP, cookie, 연결 키, 결제 정보, 개인 식별 정보는 레시피 입력에 기록하지 않는다. YouTube 재생목록 URL처럼 등록된 workflow와 명확히 연결되는 경우만 자동 실행 레시피로 만들고, 그 밖에는 `draft`로 저장한다.

## 안전 규칙

- Playwright로 실행하는 Chromium은 `chromiumSandbox: true`를 사용한다. 일반·전용 Chrome 또는 Edge 실행은 기본 샌드박스를 유지하고 `--no-sandbox`를 사용하지 않는다.
- 전용 제어 browser에도 `--no-sandbox`와 오디오 음소거 옵션을 전달하지 않는다.
- 일반 사용자 browser 연결은 `127.0.0.1`과 브라우저별 연결 키를 함께 확인하고, 처음 연결한 확장 ID만 허용한다. 확장은 기본 설치 시 사이트 접근 권한이 없고 사용자가 허용한 origin의 저장소 내 레시피별 명령만 처리한다.
- 전송, 제출, 공유, 구매, 삭제, 계정 변경, 게시, 민감 정보 입력은 최종 화면과 내용을 준비한 뒤 사용자에게 명시적으로 승인받는다.
- 로그인·다중 인증은 목적 페이지가 실제로 요구할 때만 사용자가 browser 창에서 직접 완료한다.
- 다운로드와 실행 산출물은 `work/`에 저장하고, 민감 데이터가 포함될 수 있는 `work/`, `.agent-runs/`, `.browser-profiles/`, `.env`는 Git에 올리지 않는다.

## 검증

```powershell
npm run build
npm test
npm run recipes:check
```
