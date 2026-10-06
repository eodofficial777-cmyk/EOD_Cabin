// 到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式（網頁），把設定貼進來。
// 這些值本來就會公開在前端，不是密碼；真正的保護靠 database.rules.json。
export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  databaseURL: '',      // 一定要填，例如 https://你的專案-default-rtdb.asia-southeast1.firebasedatabase.app
  projectId: '',
  appId: '',
};
