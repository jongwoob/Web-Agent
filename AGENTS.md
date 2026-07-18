# Web Agent 작업 지침

- 웹 또는 브라우저 작업에는 `web-agent`의 등록 workflow와 `recipes/`를 우선 사용한다.
- 사용자에게 보이는 페이지 열기는 일반 Chrome을 기본으로 하고, 사용자가 지정하면 일반 Edge를 사용한다. Google은 Google 홈, Naver는 Naver 홈, 일반 사이트는 origin 홈을 먼저 연다.
- 일반 사용자 browser를 열 때 `--user-data-dir`를 지정하거나 cookie, password, OTP, recovery code를 복사하지 않는다. 이미 실행 중인 browser를 닫거나 profile을 복제하지 않는다.
- 일반 사용자 browser는 새 창을 강제하지 않는다. 이미 열린 browser가 있으면 홈과 목적 URL을 같은 browser 인스턴스에 전달한다. 실행 중인 일반 사용자 탭은 검사·클릭·교체하지 않는다.
- 이미 실행 중인 일반 사용자 profile은 Playwright가 안전하게 제어할 수 없다. DOM 자동 조작이 필요하면 전용 제어 session 사용 여부를 사용자에게 명확히 알리고 허용을 받는다.
- 전용 제어 session은 사이트별로 유지하며, 같은 origin의 유휴 탭과 빈 탭을 우선 재사용한다. 다른 작업이 진행 중인 탭은 점유하지 않고, 재사용 가능한 session이 있을 때 새 browser를 열지 않는다.
- 로그인과 다중 인증은 사용자가 보이는 browser 창에서 직접 처리한다.
- 제공자 홈에 로그인 버튼이 보여도 자동 로그인이나 로그인 대기를 시작하지 않는다. 목적 페이지를 익명으로 먼저 열고, 실제 로그인 화면으로 전환된 경우에만 로그인 절차를 진행한다.
- 전송, 제출, 공유, 구매, 삭제, 계정 변경, 게시, 민감 정보 입력은 최종 화면이나 내용을 준비한 뒤 명시적인 승인을 받는다.
- Playwright로 실행하는 Chromium은 `chromiumSandbox: true`를 사용한다. 일반·전용 Chrome 또는 Edge 실행은 기본 샌드박스를 유지하고 `--no-sandbox`를 사용하지 않는다.
- 전용 제어 session의 원격 디버깅 포트는 `127.0.0.1`에만 바인딩하고, 오디오를 강제로 음소거하지 않는다.
- 새로 작성하거나 수정하는 Markdown 본문은 한국어로 작성한다. 코드, 명령어, 경로, API·제품·UI 고유 명칭은 예외로 한다.
