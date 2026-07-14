---
id: google.calendar.share-request
provider: google
status: active
automationLevel: workflow
risk: high
profile: .browser-profiles/google-calendar-chrome
command: npm run workflow:google-calendar-share-request -- --share-link-source-file <naver-web-extract-json> --requester-name <name> --browser chrome --status-file work/google-calendar-share-request-status.json --headful
approvalGates:
  - 공유 대상과 선택된 권한을 최종 화면에서 검증한다.
  - 공유, 보내기, 저장처럼 외부 권한을 변경하는 최종 버튼은 별도의 확인 파일 승인 뒤에만 누른다.
  - 공유 링크의 query 값과 수신자 이메일은 status, inspect, terminal에 기록하지 않는다.
outputs:
  - work/google-calendar-share-request-status.json
  - work/google-calendar-share-request-inspect.json
  - work/google-calendar-share-request-confirm.txt
---

# Google Calendar 공유 요청

네이버 메일 등에서 확인한 Google Calendar 공유 요청을 안전하게 준비하고 처리한다.

## 동작 순서

1. 로컬 web extract JSON에서 `calendar.google.com/calendar/render`의 검증된 공유 링크 하나만 찾는다.
2. Google 홈 사전 진입과 로그인 확인 후 Calendar 전용 profile로 공유 화면을 연다.
3. 요청 수신자, 선택된 권한, 최종 `공유`, `보내기`, `저장`, `완료` 버튼이 하나인지 확인한다.
4. 기본 실행은 `prepared` 상태에서 멈추며 공유 버튼을 누르지 않는다.
5. 실제 공유는 `--share-after-confirm`와 확인 파일의 `yes`가 모두 있을 때만 수행한다.

준비 예시:

```powershell
npm run workflow:google-calendar-share-request -- --share-link-source-file work/naver-calendar-share-link-inspect.json --requester-name Jongwoo --browser chrome --status-file work/google-calendar-share-request-status.json --headful
```

공유 실행 예시:

```powershell
npm run workflow:google-calendar-share-request -- --share-link-source-file work/naver-calendar-share-link-inspect.json --requester-name Jongwoo --share-after-confirm --confirm-file work/google-calendar-share-request-confirm.txt --browser chrome --status-file work/google-calendar-share-request-status.json --headful
```

## 제한 사항

- 공유 링크의 query 값, 수신자 이메일, token은 status, inspect, terminal에 기록하지 않는다.
- 로그인은 사용자가 headful browser에서 직접 수행한다. 비밀번호, OTP, 복구 코드를 채팅에 입력하지 않는다.
- 권한이 화면에서 확인되지 않거나 최종 공유 버튼이 하나로 식별되지 않으면 중단한다.
- 다른 수신자 추가, 권한 변경, 링크 공유, 이메일 전송은 별도 승인 없이는 수행하지 않는다.
