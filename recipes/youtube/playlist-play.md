---
id: youtube.playlist.play
provider: youtube
status: active
automationLevel: controlled
risk: low
profile: controlled-session
command: npm run workflow:youtube-playlist-play -- --playlist-url <youtube-playlist-url> --browser chrome --status-file work/youtube-playlist-play-status.json
approvalGates:
  - 전용 제어 세션에서의 재생 조작은 사용자가 명시적으로 허용한 경우에만 실행한다
outputs:
  - work/youtube-playlist-play-status.json
  - work/youtube-playlist-play-screenshot.png
---

# YouTube 재생목록 재생

YouTube 재생목록의 `모두 재생`을 눌러 첫 곡부터 재생할 때 사용한다.

## 흐름

1. 같은 YouTube 전용 제어 세션과 유휴 탭이 있으면 우선 재사용한다.
2. YouTube 홈을 먼저 연 뒤 재생목록을 연다.
3. `모두 재생`을 누르고 광고가 표시되면 종료를 기다리거나 `광고 건너뛰기`를 처리한다.
4. 실제 재생목록 곡의 재생 중 상태, 음소거 해제, 볼륨, 재생 시간 진행을 확인한다.
5. 제어 세션과 재생 탭은 닫지 않고 다음 작업을 위해 유지한다.

## 확인 범위

- 상태 파일은 브라우저의 영상 재생 상태를 확인한다.
- 운영체제 스피커, 외부 장치, 시스템별 앱 볼륨은 브라우저 DOM으로 직접 확인할 수 없다.
