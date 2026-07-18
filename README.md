# Web Agent

Playwright와 TypeScript로 만든 로컬 웹 작업 도구입니다. 일반 사용자의 Chrome 또는 Edge를 먼저 열어 서비스 홈을 방문한 뒤 목적 페이지로 이동하는 흐름과, 승인된 제어 세션을 이용한 자동화 워크플로를 함께 제공합니다.

## 설치와 검증

```powershell
npm install
npm run build
npm test
npm run recipes:check
```

## 일반 사용자 브라우저 열기

아래 명령은 일반 Chrome 또는 Edge의 기존 인스턴스를 우선 재사용하고, Google·Naver·일반 사이트의 홈을 먼저 방문한 뒤 목적 URL을 엽니다. 기존 사용자 프로필을 복제하지 않고 `--user-data-dir`도 지정하지 않습니다.

```powershell
npm run workflow:open-user-browser -- --url "https://forms.google.com" --browser chrome
npm run workflow:open-user-browser -- --url "https://www.naver.com" --browser edge
```

이 명령은 `--new-window`를 강제하지 않습니다. 이미 열린 일반 Chrome 또는 Edge가 있으면 같은 브라우저 인스턴스에 홈과 목적 URL을 전달해 탭으로 엽니다. 실행 중인 일반 사용자 프로필에는 Playwright가 안전하게 연결해 DOM을 조작할 수 없으므로, 기존 탭을 검사·클릭·교체하지 않습니다. 이 경우 사용자의 직접 진행 또는 일반 사용자 브라우저 연결 확장을 사용하는 승인된 레시피를 선택합니다.

## 일반 사용자 브라우저 자동 조작

일반 Chrome 또는 Edge의 실제 탭을 자동 조작해야 할 때는 `extensions/user-browser-bridge` 확장을 사용합니다. 확장은 기본적으로 어떤 인터넷 사이트도 읽지 못하며, 사용자가 YouTube 또는 현재 사이트 권한을 직접 허용한 origin에서만 레시피별 작업을 수행합니다.

```powershell
npm run workflow:user-browser-bridge-setup -- --browser chrome
npm run workflow:youtube-playlist-play -- --playlist-url "https://www.youtube.com/playlist?list=<playlist-id>" --browser chrome
```

최초 설정, 탭 재사용 원칙, 연결 키 보관 방법은 [일반 Chrome과 Edge 연결](docs/일반-브라우저-연결.md)에서 확인합니다. 범용 agent나 아직 연결 확장을 지원하지 않는 workflow는 기존 전용 제어 세션을 계속 사용합니다.

## 제어 세션 재사용

DOM 자동 조작을 명시적으로 허용받은 작업은 사이트별 전용 제어 세션을 사용합니다. 전용 세션은 로컬 `127.0.0.1`에만 연결되며, 다음 작업에서는 같은 브라우저와 같은 origin의 유휴 탭을 먼저 재사용합니다. 같은 origin 탭이 없으면 빈 탭을 사용하고, 재생·업로드처럼 진행 중인 탭은 예약해 교체하지 않습니다.

전용 세션이 이미 열려 있으면 새 브라우저를 열지 않습니다. 새 전용 브라우저는 재사용 가능한 세션이 없고 사용자 허용이 있는 경우에만 만들며, 작업 뒤에도 열린 상태로 남겨 다음 작업에 사용합니다.

`npm run agent -- --headful`도 사용자가 전용 제어를 허용한 경우 이 재사용 경로를 적용합니다. headless 범용 작업은 기존의 격리 profile 방식을 유지합니다.

## 로그인 처리

제공자 홈 방문은 사전 진입 절차일 뿐, 홈에 로그인 버튼이 보인다는 이유만으로 로그인 화면을 열거나 대기하지 않습니다. 목적 페이지를 먼저 익명으로 열고, 검색 결과·공개 문서·공개 다운로드처럼 로그인 없이 접근 가능한 작업은 그대로 완료합니다.

목적 페이지가 실제 로그인 화면으로 전환되거나 인증된 기능이 필요할 때만 headful browser에서 사용자의 직접 로그인을 기다립니다. headless 실행은 이 시점에만 중단하고 `--headful` 재실행을 안내합니다.

## 자동화 워크플로

```powershell
npm run agent -- --url "https://example.com" --task "메인 제목을 찾아줘" --headful
npm run workflow:web-extract -- --url "https://example.com" --browser chrome --headful
npm run workflow:gmail-search-read -- --query "from:person@example.com newer_than:30d" --browser chrome --headful
npm run workflow:youtube-playlist-play -- --playlist-url "https://www.youtube.com/playlist?list=<playlist-id>" --browser chrome
```

변경 작업은 최종 확인 전까지 전송, 제출, 공유, 구매, 삭제, 게시, 계정 변경을 실행하지 않아야 합니다.

## 환경 변수

`.env.example`을 참고해 OpenAI 호환 API 설정을 준비할 수 있습니다. 실제 `.env`, API key, OAuth secret, cookie, browser profile, 작업 로그와 다운로드 결과는 저장소에 올리지 않습니다.

```powershell
$env:OPENAI_API_KEY="..."
$env:OPENAI_BASE_URL="https://api.openai.com/v1"
$env:OPENAI_MODEL="gpt-4.1-mini"
```

간단한 로컬 확인에는 외부 모델 없이 `--model heuristic`을 사용할 수 있습니다.

## 보안 원칙

- Playwright로 실행하는 Chromium은 `chromiumSandbox: true`를 사용한다. 일반·전용 Chrome 또는 Edge 실행은 기본 샌드박스를 유지하고 `--no-sandbox`를 사용하지 않는다.
- 전용 제어 세션의 원격 디버깅 포트는 `127.0.0.1`에만 바인딩하며, `--no-sandbox` 또는 오디오 음소거 옵션을 추가하지 않는다.
- 일반 사용자 브라우저 연결은 `127.0.0.1`과 브라우저별 연결 키로만 인증하며, 처음 연결한 확장 ID와 다른 확장은 거절한다. 사이트 권한은 확장 팝업에서 사용자가 개별로 허용한다.
- 일반 사용자 브라우저 연결 확장은 저장소에 포함된 레시피별 명령만 처리하며, 외부 코드나 모델이 만든 임의 JavaScript를 실행하지 않는다.
- 비밀번호, OTP, 복구 코드, cookie, token은 채팅·터미널·문서·로그에 남기지 않는다.
- `.browser-profiles/`, `.agent-runs/`, `work/`, `.env`는 공개 저장소에서 제외한다.
- 신규 Naver 자동화는 운영 지침 검토 전까지 비활성 또는 검토 필요 상태로 유지한다.

## 레시피

재사용 가능한 명령과 승인 조건은 `recipes/`에서 확인합니다. 활성 레시피는 `npm run recipes:check`로 검사할 수 있습니다.
