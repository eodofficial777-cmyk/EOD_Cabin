// 到 Firebase 主控台 → 專案設定 → 一般 → 你的應用程式（網頁），把設定貼進來。
// 這些值本來就會公開在前端，不是密碼；真正的保護靠 database.rules.json。
export const firebaseConfig = {
  apiKey: 'AIzaSyBANPcdkQjrA_aLztzafbv2P3oryKbH9CE',
  authDomain: 'eodcabin.firebaseapp.com',
  databaseURL: 'https://eodcabin-default-rtdb.asia-southeast1.firebasedatabase.app',      // 一定要填，例如 https://你的專案-default-rtdb.asia-southeast1.firebasedatabase.app
  projectId: 'eodcabin',
  appId: '1:1076917933514:web:a521fec9745e537056eb33',
};
