---
id: youtube.playlist.play
provider: youtube
status: active
automationLevel: user-browser-bridge
risk: low
profile: regular-user
command: npm run workflow:youtube-playlist-play -- --playlist-url <youtube-playlist-url> --browser chrome --session regular --status-file work/youtube-playlist-play-status.json
approvalGates:
  - 일반 Chrome 또는 Edge에 사용자 브라우저 연결 확장을 설치하고 YouTube 권한을 허용한 경우에만 실행한다
outputs:
  - work/youtube-playlist-play-status.json
  - work/youtube-playlist-play-screenshot.png
---

# YouTube 재생목록 재생

YouTube 재생목록의 `모두 재생`을 눌러 첫 곡부터 재생할 때 사용한다.

## 흐름

1. 일반 사용자 Chrome 또는 Edge에서 같은 재생목록 탭이 있으면 우선 재사용하고, 없으면 빈 탭을 사용한다.
2. 재사용 가능한 탭이 없을 때만 같은 일반 브라우저에 새 탭을 연다. 재생 중인 동영상 탭은 교체하지 않는다.
3. YouTube 홈을 먼저 연 뒤 재생목록을 연다.
4. `모두 재생`을 누르고 광고가 표시되면 종료를 기다리거나 `광고 건너뛰기`를 처리한다.
5. 실제 재생목록 곡의 재생 중 상태, 음소거 해제, 탭 음소거 해제, 볼륨, 재생 시간 진행을 확인한다.
6. 작업이 끝난 뒤에도 일반 사용자 브라우저와 재생 탭은 닫지 않는다.

## 확인 범위

- 상태 파일은 브라우저의 영상 재생 상태를 확인한다.
- 운영체제 스피커, 외부 장치, 시스템별 앱 볼륨은 브라우저 DOM으로 직접 확인할 수 없다.
- 연결 확장을 아직 설치하지 않았다면 `npm run workflow:user-browser-bridge-setup -- --browser chrome`으로 최초 설정을 준비한다.
