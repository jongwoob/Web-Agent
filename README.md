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

아래 명령은 일반 Chrome 또는 Edge를 열고, Google·Naver·일반 사이트의 홈을 먼저 방문한 뒤 목적 URL을 엽니다. 기존 사용자 프로필을 복제하지 않고 `--user-data-dir`도 지정하지 않습니다.

```powershell
npm run workflow:open-user-browser -- --url "https://forms.google.com" --browser chrome
npm run workflow:open-user-browser -- --url "https://www.naver.com" --browser edge
```

일반 사용자 프로필이 이미 실행 중이면 Playwright가 안전하게 연결해 DOM을 조작할 수 없습니다. 이 경우 전용 제어 세션으로 조용히 전환하지 않고, 사용자의 직접 진행 또는 별도 제어 세션 허용 여부를 먼저 확인합니다.

## 자동화 워크플로

```powershell
npm run agent -- --url "https://example.com" --task "메인 제목을 찾아줘" --headful
npm run workflow:web-extract -- --url "https://example.com" --browser chrome --headful
npm run workflow:gmail-search-read -- --query "from:person@example.com newer_than:30d" --browser chrome --headful
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

- 모든 Chromium 실행은 `chromiumSandbox: true`를 사용한다. `--no-sandbox`와 `chromiumSandbox: false`는 사용하지 않는다.
- 비밀번호, OTP, 복구 코드, cookie, token은 채팅·터미널·문서·로그에 남기지 않는다.
- `.browser-profiles/`, `.agent-runs/`, `work/`, `.env`는 공개 저장소에서 제외한다.
- 신규 Naver 자동화는 운영 지침 검토 전까지 비활성 또는 검토 필요 상태로 유지한다.

## 레시피

재사용 가능한 명령과 승인 조건은 `recipes/`에서 확인합니다. 활성 레시피는 `npm run recipes:check`로 검사할 수 있습니다.
