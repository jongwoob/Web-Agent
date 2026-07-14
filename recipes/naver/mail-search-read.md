---
id: naver.mail.search-read
provider: naver
status: active
automationLevel: workflow
risk: high
profile: .browser-profiles/naver-chrome
command: npm run workflow:naver-mail-search-read -- --query <keyword> --browser chrome --output-file work/mail/naver-search-results.json --status-file work/naver-mail-search-read-status.json --headful
approvalGates:
  - 목록 필터링은 읽기 전용, 저빈도 실행으로 제한한다.
  - 메일 열기는 읽음 상태를 바꿀 수 있으므로 명시적 승인 후에만 수행한다.
  - 답장, 전달, 첨부파일 다운로드, 링크 열기, 폴더 이동, 스팸 처리, 삭제 전에 중단한다.
outputs:
  - work/naver-mail-search-read-status.json
  - work/mail/naver-search-results.json
  - work/naver-mail-read-confirm.txt
---

# 네이버 메일 검색과 목록 확인

이 레시피는 네이버 메일을 키워드로 검색하거나 받은편지함 목록을 읽기 전용으로 확인한다.

## 사용 범위

1. 네이버 메일 검색창에서 일반 키워드로 검색한다.
2. 발신자, 제목, 수신 시각, 읽음 추정 상태, 미리보기만 추출한다.
3. `--inbox`로 받은편지함의 현재 목록을 열지 않고 추출할 수 있다.
4. `--inbox --today`는 한국 표준시 기준 오늘 수신한 행만 목록에 남긴다.
5. 첫 번째 메일을 열어 본문을 확인하려면 명시적 승인이 필요하다.

오늘 받은 메일 목록 예시:

```powershell
npm run workflow:naver-mail-search-read -- --inbox --today --max-results 100 --browser chrome --output-file work/mail/naver-today-inbox.json --status-file work/naver-today-inbox-status.json --headful
```

목록을 확인한 뒤 선택한 여러 메일의 본문을 읽으려면 승인된 목록 JSON과 함께 아래 workflow를 사용한다. 링크와 첨부파일은 열지 않는다.

```powershell
npm run workflow:naver-mail-read-batch -- --list-file <list-json> --count <1-10> --confirm-file <confirm-file> --output-file <body-json> --status-file <status-json> --browser chrome --headful
```

결제 내역처럼 본문 넓은 검색 결과를 줄여야 할 때는 `--visible-match-only`와 `--naver-mailbox "청구·결제"`를 함께 사용한다.

## 활성화 검토

목록 검색, 행 파싱, 읽음 상태 표기, 승인 후 본문 일괄 추출은 전용 Chrome profile에서 2026-07-10에 headful로 검증했다. 검색 결과 없음 처리도 2026-07-11에 검증했다. 받은편지함 목록과 오늘 날짜 필터는 동일한 읽기 전용 행 파싱 경로를 사용하며, 메일 행을 클릭하지 않는다.

## 개인정보와 제한

- 본문은 output JSON에만 저장하고 status나 terminal에는 출력하지 않는다.
- screenshot은 기본적으로 만들지 않는다.
- 답장, 전달, 첨부파일 접근, 링크 열기, 폴더 변경, 스팸 처리, 삭제는 범위 밖이다.

## 사용자 보고 방식

기본 보고는 짧고 결과 중심으로 작성한다. 결제 내역은 날짜, 항목 또는 가맹점, 금액, 결제 수단을 작은 표로 보이고 총액과 결제 수단별 합계를 함께 제공한다. 주문번호, 주소, 전화번호, 수령인, 원문 본문은 사용자가 명시적으로 요청하지 않으면 보여주지 않는다. 기술 실행 정보는 마지막 상태 한 줄로 제한한다.
