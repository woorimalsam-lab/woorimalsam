# 내 일정 · 메모 웹앱

일정은 **구글 캘린더**와 연동되고, 메모는 **어느 기기에서든 같은 구글 계정으로 동기화**되는 개인용 웹앱입니다.
공개 URL로 배포하면 휴대폰·학교 PC·집 PC 어디서나 접속할 수 있습니다.

## 주요 기능
- **일정 분류**: 등록하는 일정을 <span>🔵 업무</span> / <span>🟢 교과</span>로 나눠 색깔로 구분합니다. 상단 칩(업무/교과/학사)으로 원하는 종류만 골라 볼 수 있습니다.
- **학사일정 자동 표시**: 학교 학사일정 구글시트를 반영해 🟠 학사(시험·행사)와 🔴 휴일을 달력에 미리 채워 둡니다. (읽기 전용 — 수정은 시트에서)
- **구글 캘린더 연동**: 로그인하면 내가 등록한 업무·교과 일정이 실제 구글 캘린더에 저장됩니다(업무=파랑, 교과=초록으로 구글에서도 색 구분).
- **메모 동기화**: 같은 구글 계정으로 로그인한 모든 기기에서 메모가 실시간으로 공유됩니다.

> **학사일정을 갱신하려면**: 학교 시트가 바뀌었을 때 `academic-calendar.js` 파일만 새로 만들면 됩니다. 저에게 "학사일정 시트 다시 반영해줘"라고 말씀하시면 최신 시트를 읽어 자동으로 갱신해 드립니다.

---

## 지금 바로 써보기 (로컬 저장 모드)

설정 없이도 바로 동작합니다. 이 상태에서는 **접속한 브라우저에만** 데이터가 저장됩니다(동기화 X).

- 앱 폴더에서 아래 명령을 실행한 뒤, 브라우저에서 `http://localhost:5555` 접속
  ```
  python -m http.server 5555
  ```

기능을 확인해 본 다음, 아래 순서대로 설정하면 **구글 연동 + 공개 URL**이 켜집니다.

---

## 전체 설정 순서 (약 15분)

> 준비물: 구글 계정 1개 (평소 쓰시는 계정이면 됩니다)

### 1단계 — Firebase 프로젝트 만들기
1. https://console.firebase.google.com 접속 → **프로젝트 추가**
2. 프로젝트 이름(예: `my-planner`) 입력 → 나머지는 기본값으로 **만들기**

### 2단계 — 웹 앱 등록하고 설정값 복사
1. 프로젝트 대시보드에서 **`</>` (웹) 아이콘** 클릭
2. 앱 닉네임 입력(예: `planner-web`) → **앱 등록**
3. 화면에 나오는 `firebaseConfig = { ... }` 값을 복사
4. 이 폴더의 **`config.js`** 파일을 열어, 복사한 값을 그대로 붙여넣기
   ```js
   export const firebaseConfig = {
     apiKey: "AIza...",
     authDomain: "my-planner.firebaseapp.com",
     projectId: "my-planner",
     storageBucket: "my-planner.appspot.com",
     messagingSenderId: "123456789",
     appId: "1:123...:web:abc...",
   };
   ```
   → 값을 채우면 앱이 자동으로 **동기화 모드**로 바뀝니다.

### 3단계 — 구글 로그인 켜기
1. Firebase 콘솔 왼쪽 메뉴 → **빌드 > Authentication** → **시작하기**
2. **Sign-in method** 탭 → **Google** 선택 → **사용 설정** → 저장

### 4단계 — 메모 저장소(Firestore) 만들기
1. 왼쪽 메뉴 → **빌드 > Firestore Database** → **데이터베이스 만들기**
2. 위치는 `asia-northeast3 (서울)` 권장 → **프로덕션 모드**로 시작
3. 만들어지면 **규칙(Rules)** 탭에서 아래 내용으로 교체 후 **게시**
   (본인만 자기 메모를 읽고 쓸 수 있게 하는 규칙)
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```

### 5단계 — 구글 캘린더 연동 켜기
1. https://console.cloud.google.com 접속 (Firebase와 같은 계정)
2. 상단에서 방금 만든 프로젝트(`my-planner`)가 선택돼 있는지 확인
3. **API 및 서비스 > 라이브러리** → `Google Calendar API` 검색 → **사용 설정**
4. **API 및 서비스 > OAuth 동의 화면**
   - User Type: **외부** 선택 → 만들기
   - 앱 이름, 지원 이메일 등 필수 항목만 입력 → 저장
   - **테스트 사용자(Test users)** 단계에서 **본인 구글 이메일 추가**
   > (개인용이므로 "게시/검증"은 하지 않아도 됩니다. 테스트 사용자로 등록된 본인 계정은 그대로 사용 가능.)

이제 앱에서 **구글 로그인** 버튼을 누르면 캘린더 접근 권한을 물어보고,
허용하면 일정이 **본인 구글 캘린더**에 실제로 등록/수정/삭제됩니다.

---

## 6단계 — 공개 URL로 배포하기

두 가지 방법 중 편한 것을 고르세요.

### 방법 A — Firebase Hosting (추천, 무료 주소 제공)
1. Node.js 설치 (https://nodejs.org)
2. 이 폴더에서 아래 명령 실행
   ```
   npm install -g firebase-tools
   firebase login
   firebase init hosting
   ```
   - "Use an existing project" → 앞서 만든 프로젝트 선택
   - public 폴더: **`.` (현재 폴더)** 입력
   - single-page app: **No**
   - 기존 파일 덮어쓰기: **No**
3. 배포
   ```
   firebase deploy
   ```
   → `https://my-planner.web.app` 형태의 **공개 주소**가 나옵니다.

### 방법 B — Netlify (드래그 앤 드롭, 명령어 없이)
1. https://app.netlify.com 가입/로그인
2. **Add new site > Deploy manually**
3. 이 폴더(`일정메모웹`) 전체를 드래그 앤 드롭
   → `https://랜덤이름.netlify.app` 주소가 즉시 생성됩니다.

### 배포 후 마무리 (중요)
로그인이 되려면 배포된 주소를 **허용 목록**에 추가해야 합니다.
1. **Firebase 콘솔 > Authentication > Settings > 승인된 도메인**에
   배포 주소(예: `my-planner.web.app` 또는 `랜덤이름.netlify.app`) 추가
2. Netlify를 쓴 경우, 구글 로그인이 안 되면
   **Cloud Console > 사용자 인증 정보 > OAuth 클라이언트**의
   "승인된 자바스크립트 원본"에도 같은 주소를 추가

---

## 자주 묻는 것

- **로그인해도 "로컬 저장 모드"로 나와요** → `config.js` 값이 비어 있거나 오타입니다. 2단계를 다시 확인하세요.
- **일정 저장 시 "인증 만료" 메시지** → 구글 캘린더 토큰은 약 1시간 후 만료됩니다. **로그아웃 후 다시 로그인**하면 됩니다.
- **로그인 창에 "확인되지 않은 앱" 경고** → 개인용 앱이라 정상입니다. "고급 > 이동"으로 진행하면 됩니다(5단계에서 본인을 테스트 사용자로 등록했기 때문).
- **메모는 되는데 일정이 안 보여요** → 5단계(Calendar API 사용 설정 + 캘린더 권한 허용)를 확인하세요.

---

## 파일 구성
| 파일 | 역할 |
|------|------|
| `index.html` | 화면 구조 |
| `style.css` | 디자인 |
| `app.js` | 기능(캘린더·메모·로그인·동기화) 로직 |
| `config.js` | **여기에 Firebase 설정값 입력** |
