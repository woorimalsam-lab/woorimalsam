// ============================================================
//  Firebase 설정값을 여기에 붙여넣으세요.
//  (README.md의 "3단계"에서 복사한 값)
//  이 값을 채우기 전에는 자동으로 "로컬 저장 모드"로 동작합니다.
// ============================================================

export const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

// 설정값이 실제로 채워졌는지 검사 (비어 있으면 로컬 모드)
export const isConfigured =
  firebaseConfig.apiKey && firebaseConfig.projectId ? true : false;
