# OTDS introduction website

한국어·영어 정적 소개 페이지입니다. 서비스 본체나 운영 데이터에 접근하지 않습니다.

- `index.html`: 기본 한국어 본문과 JavaScript 없이도 펼칠 수 있는 설치 가이드
- `src/main.js`: 가이드 주소·뒤로 가기·클립보드·모션 설정 연결
- `src/i18n.js`: 전체 영어 문구, 언어 저장과 `?lang=en`
- `src/core.js`: 절차적으로 생성한 Three.js 모델과 Anime.js 스크롤 타임라인
- `src/style.css`, `src/layout.css`: 기본 화면과 반응형 배치
- `public/`: OTDS 파비콘, 정적 코어 SVG, 외부 라이브러리 라이선스 고지
- `tests/browser.mjs`: 빌드 결과를 사용하는 실제 브라우저 검증
- `scripts/check-public.mjs`: Pages 경로와 공개 산출물 검사

Node.js 24에서 `npm ci`, `npm run build`, `npm run preview`로 확인합니다. 개발은 `npm run dev`를 사용합니다. 기본 경로는 `/OneTimeDownloadService/`입니다. `npm test` 전에 빌드하고 Playwright Chromium을 설치해 주세요. Windows는 설치된 Edge를 사용합니다.

The site bundles pinned Anime.js and Three.js versions without CDN requests. WebGL is loaded separately, and skipped when reduced motion is requested. Rendering occurs when the scene or pointer changes, stops in hidden tabs, and pauses outside the story. Mobile rendering is capped at a 1.2 pixel ratio. The static SVG remains available if WebGL cannot start.

The guide can be opened with `#guide`; back/forward navigation restores the open state. `?lang=en` overrides the saved language. Storage and clipboard failures do not prevent reading the guide.
