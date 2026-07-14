---
id: naver.operating-guidelines
provider: naver
status: policy-review-required
automationLevel: doc-only
risk: medium
profile: .browser-profiles/naver-chrome
command: n/a
approvalGates:
  - review Naver-specific operating rules before enabling new automation
outputs:
  - work/naver-*-status.json
---

# 네이버 운영 지침

새 네이버 자동화를 추가하거나 실행하기 전에 이 지침을 확인한다.

## 기본 규칙

1. 임시 스크립트보다 기존 workflow를 우선 사용한다.
2. 구매, 후기, 댓글, 게시, 계정 변경, 대량 작업은 별도 정책 검토와 명시적 승인 없이는 자동화하지 않는다.
3. 고빈도 수집이나 반복 접근을 피한다.
4. 로그인은 사용자가 직접 하거나 전용 browser profile을 사용한다. 비밀번호, OTP, 복구 코드를 채팅으로 요청하지 않는다.
5. status, screenshot, 추출 결과는 `work/` 아래에 저장한다.

## 활성화 기준

새 네이버 레시피는 해당 workflow를 검토하고 테스트하기 전까지 `policy-review-required` 또는 `draft` 상태로 둔다.

## 메일 검색과 목록 확인 검토

1. 목록 필터링과 받은편지함 목록 확인은 메일 행을 클릭하거나 사서함 상태를 바꾸지 않는다.
2. 메일을 열기 전에는 읽음 상태가 바뀔 수 있음을 알리고 명시적 승인을 받는다.
3. 추출한 본문은 로컬 output JSON에만 저장하고 status나 terminal 로그에 복사하지 않는다.
4. 검색과 목록 확인 중 링크 열기, 첨부파일 다운로드, 답장, 전달, 폴더 이동, 스팸 처리, 삭제를 수행하지 않는다.
5. 키워드 검색, 받은편지함 목록, 행 파싱, 읽음 상태 표기, 승인 후 본문 일괄 추출, 검색 결과 없음 처리는 2026-07-11 기준 headful 전용 Chrome profile에서 검토됐다. `naver.mail.search-read`는 기존 승인 게이트를 지키는 저빈도 읽기 전용 사용에 한해 활성화한다.

## 검색과 쇼핑 검토

1. `naver.search-shopping.extract`는 2026-07-11에 headful 공개 profile 추출을 통과했으며, 저빈도 읽기 전용으로만 활성화한다.
2. headless 접근은 네이버의 자동 접근 제한 화면을 받을 수 있다. headful을 우선하고 반복 재시도하지 않는다.
3. 구매, 장바구니, 후기, 댓글, 게시, 계정 변경, 대량 수집은 별도 검토 workflow와 명시적 승인 없이는 금지한다.
