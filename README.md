# OTDS · One Time Download Service

Windows PC에서 파일을 업로드하고 일회성 링크를 공유하는 서비스입니다. Flask, Waitress, SQLite를 사용하며 Cloudflare 임시 터널로 공개 HTTPS 주소를 제공합니다.

[한국어 소개 및 설치 가이드](https://movenb3at.github.io/OneTimeDownloadService/#guide) · [English introduction & setup guide](https://movenb3at.github.io/OneTimeDownloadService/?lang=en#guide) · [main ZIP 다운로드](https://github.com/movenb3at/OneTimeDownloadService/archive/refs/heads/main.zip)

소개 페이지는 GitHub Pages에서 제공하는 정적 사이트입니다. 실제 파일 공유·다운로드와 관리자 화면은 사용자의 Windows PC에서 실행됩니다. Node.js는 소개 페이지 개발에만 필요하며 서비스를 사용하기 위해 설치할 필요는 없습니다.

Self-hosted, one-time file sharing for Windows. Each link can be claimed by one browser, with a fixed 10-minute retry window from the first start. Files are checked with SHA-256 before the browser confirms reception. Run `start.cmd`, set an administrator password of at least 12 characters, open the public administrator URL shown in the console, and upload a file up to 90MiB. See the [English setup guide](https://movenb3at.github.io/OneTimeDownloadService/?lang=en#guide) for all six steps. GitHub Pages hosts the introduction only; the service runs on your PC through a Cloudflare temporary tunnel.

## 시작하기

1. Windows 64비트와 [Python 3.11 이상](https://www.python.org/downloads/windows/)이 설치되어 있어야 합니다. Python 설치 시 PATH 추가를 선택해 주세요.
2. ZIP을 받았다면 폴더 전체를 쓰기 가능한 위치에 압축 해제하고 **start.cmd**를 실행합니다. 최초 실행에는 패키지와 Cloudflare 공식 실행 파일을 다운로드하므로 인터넷 연결이 필요합니다.
3. 콘솔에서 관리자 비밀번호를 설정합니다. 12자 이상을 입력하고 확인 입력을 완료해 주세요. 입력한 비밀번호는 화면에 표시되지 않습니다.
4. 콘솔에 표시되는 **공개 관리자 주소**를 열어 비밀번호로 로그인합니다.
5. 파일을 업로드한 뒤 발급된 공유 링크를 상대방에게 전달합니다.

설치 프로그램은 프로젝트 안에 .venv와 bin 폴더만 생성합니다. 전역 Python 패키지, Windows 서비스와 방화벽 설정은 변경하지 않습니다. cloudflared는 공식 릴리스의 SHA-256 체크섬을 확인한 뒤 설치합니다.

서버를 종료하려면 실행 창에서 Ctrl+C를 눌러 주세요. 이 실행에서 시작한 서버와 터널을 함께 종료합니다. start.cmd를 다시 실행하면 새로운 공개 주소가 발급됩니다.

## 화면별 역할

| 화면 | 역할 |
|---|---|
| index.html | 공유 링크의 진입 화면입니다. 파일 정보를 보고 링크를 복사하거나 다운로드 화면으로 이동합니다. |
| download.html | 파일 수신, 진행률, 취소, 재시도, SHA-256 검증과 파일 저장을 제공합니다. 이 화면으로 직접 접속할 수도 있습니다. |
| admin.html | 로그인, 업로드, 링크 발급·무효화, 파일 삭제, 전체 기록 초기화와 전체·파일별·기기별 통계를 제공합니다. |

공유 주소에는 #token= 뒤에 64자리 토큰이 포함됩니다. 이 부분까지 포함한 전체 주소를 공유해 주세요. 토큰 없는 기본 화면에는 공개 파일 목록을 표시하지 않습니다.

## 다운로드와 10분 재시도

- 페이지 조회, 새로고침과 링크 미리보기는 권한을 사용하지 않습니다.
- 다운로드 시작 버튼을 누르면 링크가 해당 브라우저에 예약됩니다. 다른 브라우저는 받을 수 없습니다.
- 재시도는 **최초 시작 시각부터 10분** 동안만 허용합니다. 다시 시도해도 만료 시각은 연장되지 않으며, 파일 처음부터 다시 받습니다.
- 연결 중단, 취소 또는 해시 불일치 후 같은 브라우저에서 재시도할 수 있습니다.
- 브라우저가 파일 전체를 받고 SHA-256 검증을 마친 뒤 서버에 완료를 알리면 링크가 사용 완료됩니다.
- 서버의 완료 응답만 유실되면 받은 파일을 메모리에 유지하고 완료 요청을 재시도합니다. 완료 횟수는 중복 증가하지 않습니다.
- 완료 또는 10분 만료 후에는 관리자 화면에서 같은 파일의 새 링크를 발급해 주세요.

최대 파일 크기는 **90MiB = 94,371,840바이트**입니다. 검증을 위해 다운로드할 파일 전체를 브라우저 메모리에 잠시 보관합니다. 수신 완료는 브라우저의 전체 수신·해시 검증 기준이며 운영체제의 저장 완료를 뜻하지 않습니다. 저장 대화상자를 취소해도 이미 완료된 권한은 복구되지 않습니다. 같은 페이지의 파일 저장 버튼으로 받은 파일을 다시 저장할 수 있습니다.

사용 전 링크에는 자동 만료가 없으며 관리자가 무효화할 수 있습니다. 업로드한 파일은 자동 삭제하지 않습니다. 새 링크를 발급해도 이전 링크와 통계는 보존합니다.

## 관리자 통계와 기기 식별

관리자 화면은 5초마다 갱신하며 다음 정보를 표시합니다.

- 수신 완료: 브라우저 검증과 완료 확인을 마친 링크 수
- 전송 시도: 실제 파일 전송 API가 시작된 횟수
- 재시도: 같은 링크에서 두 번째 이후로 시작된 파일 전송 횟수
- 예약 중: 최초 예약 후 10분 안에 있는 링크 수
- 파일별 완료·시도·링크 수
- 익명 브라우저 ID, PC·모바일·태블릿 구분, OS, 브라우저, 첫·마지막 방문과 다운로드 기록
- 최근 200건의 전송 상태와 서버에서 처리한 바이트 수

관리자 화면의 공유 링크 표에는 **남은 시간**도 표시합니다. 예약 중인 링크는 최초 다운로드 시작부터 10분의 남은 시간을 `09:42`처럼 매초 갱신하며, 서버 기준 시각을 사용합니다. 다운로드 시작 전에는 `시작 전 · 제한 없음`, 종료된 링크는 `수신 완료`, `시간 만료`, `무효화`로 표시합니다. 카운트다운이 0초가 되면 화면의 상태도 시간 만료로 바뀝니다.

서버의 전체 전송 처리가 끝나도 완료 확인을 받지 못했다면 **수신 확인 대기**로 표시합니다. 서버 처리량은 브라우저가 실제 저장한 양을 의미하지 않습니다.

브라우저 정보는 쿠키와 User-Agent에서 추정합니다. 실제 하드웨어 식별 기능은 없습니다. 쿠키 삭제, 다른 브라우저, 시크릿 모드, 새 터널 주소에서는 같은 기기가 다른 브라우저로 표시될 수 있습니다. 재시도하려면 동일한 터널 주소와 브라우저 쿠키를 유지해야 합니다.

접속 IP와 원본 User-Agent는 통계 데이터베이스에 저장하지 않습니다. 로그인 속도 제한에는 접속 주소의 HMAC 해시를 최대 15분간 메모리에서만 사용합니다.

## 전체 기록 초기화와 파일 삭제

관리자 화면의 **전체 기록 삭제** 버튼을 누르고 확인하면 누적 수신 완료·전송 시도·재시도 통계와 기기별 접속·다운로드 기록을 초기화합니다. 최근 초기화 시각도 표시합니다. 삭제한 기록은 복구할 수 없습니다.

파일 목록과 발급된 링크는 유지됩니다. 이미 완료·만료·무효화된 링크는 다시 사용할 수 없으며, 예약한 브라우저와 최초 시작 후 10분의 제한도 유지됩니다. **예약 중**은 현재 상태를 나타내므로 진행 중인 예약이 있으면 0으로 바뀌지 않습니다. 기존 전송이 초기화 후 완료되면 새 기간의 수신 완료 통계에 집계하며, 초기화 이전에 시작한 전송 시도는 다시 집계하지 않습니다. 예약 검증에 필요한 쿠키 식별 정보와 전송 상태는 통계 기록과 별도로 유지합니다.

**파일별 현황 → 파일 삭제**에서는 다운로드된 적이 없는 파일도 개별 삭제할 수 있습니다. 다운로드 여부나 완료 횟수에 관계없이 삭제할 수 있으며, 동일 파일에 아직 10분 이내의 다운로드 예약 또는 파일 전송이 있으면 삭제 버튼이 비활성화됩니다.

삭제를 확인하면 서버의 원본 파일을 제거하고 파일 및 공유 링크 목록에서 숨깁니다. 해당 파일의 모든 공유 링크로 새 다운로드를 시작할 수 없습니다. 기존 통계와 다운로드 기록을 유지하기 위해 파일명과 링크 상태 등 최소 메타데이터는 보존하며, 누적 통계를 지우려면 전체 기록 삭제를 사용해 주세요. 이미 수신한 사람의 PC에 저장된 파일은 영향을 받지 않습니다.

기존 데이터베이스는 다음 서버 시작 시 자동으로 필요한 열을 추가합니다. 기존 파일·링크·기록을 별도로 삭제하거나 데이터 폴더를 초기화할 필요는 없습니다.

## 로컬 실행과 설정

PowerShell에서 터널 없이 실행하려면 다음 명령을 사용합니다.

    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start.ps1 -Local

기본 로컬 관리자 주소는 http://127.0.0.1:8080/admin.html 입니다. 다른 포트는 실행 스크립트에 -Port 8081처럼 지정할 수 있습니다.

관리자 비밀번호를 변경하거나 잊으셨다면 서비스를 종료한 뒤 다음 명령을 실행합니다.

    .\.venv\Scripts\python.exe runtime.py --reset-password

비밀번호를 변경하면 기존 관리자 세션이 모두 해제됩니다. 관리자 세션의 유효기간은 로그인 후 8시간입니다. 같은 접속 주소에서 로그인에 5번 실패하면 15분 동안 추가 시도를 제한합니다.

자동 초기 설정이 필요한 환경에서는 최초 실행에 OTD_SETUP_PASSWORD 환경변수를 전달할 수 있습니다. 일반 실행은 콘솔 입력을 사용합니다. 환경변수 값은 설정 후 자식 터널 프로세스에 전달하지 않습니다.

## 데이터와 보안

- data/settings.json에는 서비스 비밀키와 관리자 비밀번호의 scrypt 해시가 있습니다. 평문 비밀번호는 저장하지 않습니다.
- data/service.sqlite3에는 파일 정보, 링크, 예약, 브라우저와 다운로드 기록이 있습니다.
- data/files에는 난수 ID로 이름 붙인 원본 파일이 있습니다. 원래 파일명으로 서버 경로를 만들지 않습니다.
- 데이터 파일은 공개 정적 영역 밖에 두고 인증된 다운로드 API로만 파일을 제공합니다.
- 토큰은 안전한 32바이트 난수에 SHA-256을 적용해 만듭니다. SHA-256은 링크를 암호화하는 기능이 아니므로 링크를 받은 사람이 다운로드 권한을 갖습니다.
- URL fragment의 토큰은 필요한 API 요청 본문으로만 전달합니다. URL 요청 로그에 토큰을 넣지 않습니다.
- CSRF 보호, HttpOnly 및 SameSite 쿠키, 공개 HTTPS의 Secure 쿠키, CSP, Referrer Policy와 캐시 방지를 적용합니다.

data, bin, .venv, 검증 산출물, website/node_modules와 website/dist는 Git에서 제외합니다. 백업할 때는 서비스를 종료한 뒤 data 폴더 전체를 복사해 주세요. 설정 파일의 비밀키를 바꾸거나 삭제하면 기존 브라우저 요청 인증 정보가 달라집니다.

## Cloudflare 임시 터널

cloudflared가 로컬 서버에 연결하고 임시 trycloudflare.com 주소를 발급합니다. Cloudflare 계정과 도메인은 필요하지 않습니다. 공개 주소는 터널을 새로 만들 때 바뀌며 프로세스가 종료되면 사용할 수 없습니다. 이전 공유 링크는 관리자 화면에서 새 주소로 다시 복사해 주세요.

임시 터널에는 가동 시간 보장이 없으며 최대 200개의 동시 처리 요청을 지원합니다. SSE를 지원하지 않아 관리자 통계는 주기적 조회로 갱신합니다. 자세한 내용은 [Cloudflare 공식 문서](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)를 참고해 주세요.

기존 사용자 프로필의 .cloudflared 설정이 임시 터널과 충돌할 수 있습니다. 실행에 실패하면 공식 문서를 확인해 해당 설정을 별도로 관리해 주세요. 이 서비스는 기존 Cloudflare 설정을 수정하지 않습니다.

## 검증

서버 자동화 테스트:

    .\.venv\Scripts\python.exe -m unittest discover -s tests -v

브라우저 검증에는 Node.js, Playwright 패키지와 Microsoft Edge가 필요합니다. Playwright를 별도로 설치한 경우 PLAYWRIGHT_PATH에 해당 패키지 경로를 지정할 수 있습니다.

    node tests/browser.mjs
    node tests/browser.mjs --tunnel

브라우저 검증은 별도 임시 데이터와 임의 비밀번호를 사용하고 종료 시 검증 서버와 터널을 정리합니다. 실제 운영 데이터는 사용하지 않습니다. 기본 검증 포트는 8091이며 OTD_TEST_PORT 환경변수로 바꿀 수 있습니다.

검증 보고서와 데스크톱·모바일 스크린샷은 .test-artifacts/browser에 저장합니다.

## 소개 페이지 개발 / Website development

`website/`는 Vite, Anime.js 4와 Three.js를 사용하는 별도 정적 사이트입니다. 코드로 생성한 OTDS 파일 전송 코어가 기본 스크롤에 반응합니다. 모션 감소 설정 또는 WebGL 실패 시 정적 SVG로 전환합니다. 한국어가 기본이며 선택한 언어는 브라우저에 저장됩니다. `?lang=en`은 영어, `#guide`는 펼쳐진 설치 가이드로 직접 연결합니다.

모바일과 폭 700px 이하 화면에서는 3D 코어와 정적 대체 그림을 모두 숨기고 본문·가이드를 표시합니다. 터치 기기의 가로 화면에서도 같은 정책을 적용하며, 처음부터 모바일로 접속하면 3D 모듈을 불러오지 않습니다.

Node.js 24와 npm을 사용합니다. 프로젝트 루트에서:

```powershell
cd website
npm ci
npm run dev
```

개발 주소는 콘솔에 표시되며 기본 경로는 `/OneTimeDownloadService/`입니다. 실제 배포 형태를 로컬에서 확인하려면:

```powershell
npm run build
npm run preview
```

브라우저 검증과 배포물 검사는 다음 명령으로 실행합니다. Windows에서는 Microsoft Edge, 다른 환경에서는 Playwright Chromium을 사용합니다.

```powershell
npx playwright install chromium
npm test
node scripts/check-public.mjs
```

테스트는 별도 로컬 미리보기 서버를 시작했다가 종료하며 `.test-artifacts/website/`에 보고서와 화면을 저장합니다. CI는 Windows에서 서버 테스트, Ubuntu에서 소개 페이지 빌드·브라우저 검증을 수행합니다. 승인된 `main` 푸시 또는 수동 실행에서 두 작업이 통과하면 GitHub Actions가 **website/dist만** Pages에 배포합니다. Pull request는 검증만 수행합니다. Pages 설정의 Source는 **GitHub Actions**를 사용합니다.

The website is independent of the Flask application. Build with `npm ci` and `npm run build` in `website/`. The Pages base path is `/OneTimeDownloadService/`. `npm test` checks the production build, language switching, guide history, scrolling, mobile layouts and static fallbacks. Only `website/dist/` is deployed, never the service data directory.

## 라이선스 / License

MIT License, Copyright (c) 2026 movenb3at. 자세한 내용은 [LICENSE](LICENSE)를 확인해 주세요. 사이트에 포함된 Anime.js와 Three.js의 MIT 고지는 `website/public/THIRD_PARTY_NOTICES.txt`에 있으며 빌드에도 포함합니다. 파비콘과 파일 전송 코어는 OTDS를 위해 제작했습니다.
