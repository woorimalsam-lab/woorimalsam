// ============================================================
//  Firebase 설정값 (Firebase 콘솔 > 프로젝트 설정 > 내 앱)
//  이 값들은 웹앱에 공개돼도 되는 값입니다(비밀번호 아님).
//  보안은 Firestore 규칙 + 승인된 도메인으로 처리합니다.
// ============================================================

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY_HERE",
  authDomain: "woorimalsam-7f454.firebaseapp.com",
  projectId: "woorimalsam-7f454",
  storageBucket: "woorimalsam-7f454.firebasestorage.app",
  messagingSenderId: "488196268358",
  appId: "1:488196268358:web:fc8446a9c8c09c62e8c547",
  measurementId: "G-RN0PNKFEBC",
};

// 설정값이 실제로 채워졌는지 검사 (비어 있으면 로컬 모드)
export const isConfigured =
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.apiKey !== "YOUR_API_KEY_HERE" ? true : false;
