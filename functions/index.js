/* =========================================================
   荒中小屋　Cloud Functions
   玩家只能把「我想做什麼」寫進 rooms/{代碼}/intents。
   這支 Function 收到後跑引擎結算，再把結果寫回：

     game/{代碼}/core/state      完整狀態（含身份），玩家讀不到
     game/{代碼}/core/side       給安全規則判斷狼人頻道用，玩家讀不到
     game/{代碼}/core/public     公開畫面（不含紀錄）
     game/{代碼}/core/views/{uid} 每個人自己的私人資料（只有本人讀得到）
     game/{代碼}/log/{序號}       紀錄，一筆一筆往後加，玩家只會下載新增的部分
     rooms/{代碼}/save           加密存檔，玩家可以下載備份，但打不開

   為了省流量：紀錄不會每次整包重送，私人畫面也只送「自己的那一份」。
   ========================================================= */
const { onValueCreated } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const crypto = require('crypto');
const E = require('./engine.js');

// ⚠ 這裡要填你的 Realtime Database 所在的區域（建立資料庫時選的位置）
const REGION = 'asia-southeast1';

// 存檔加密用的密鑰。第一次部署前執行：firebase functions:secrets:set SAVE_KEY
// （輸入一長串隨便打的英數字就好，之後不要改，改了舊存檔就讀不回來）
const SAVE_KEY = defineSecret('SAVE_KEY');

initializeApp();
setGlobalOptions({ region: REGION, maxInstances: 10 });

// 前端能送的遊戲動作（白名單）
const ALLOWED = new Set(['ready', 'move', 'explore', 'light', 'search', 'lock', 'endTurn', 'stormAction', 'battleAction', 'timeout']);

exports.onIntent = onValueCreated({ ref: '/rooms/{code}/intents/{id}', region: REGION, secrets: [SAVE_KEY] }, async (event) => {
  const { code } = event.params;
  const intent = event.data.val();
  await event.data.ref.remove();                  // 讀完就刪，intents 不會越積越多
  if (!intent || typeof intent.uid !== 'string' || !intent.action) return;

  const uid = intent.uid;
  const type = String(intent.action.type || '');
  try {
    if (type === 'start' || type === 'again') return await startGame(code, uid, type);
    if (type === 'load') return await loadGame(code, uid, String(intent.action.blob || ''));
    if (!ALLOWED.has(type)) return await reportError(code, uid, '不支援這個動作');
    await applyIntent(code, uid, sanitize(intent.action));
  } catch (err) {
    console.error('intent failed', code, type, err);
    await reportError(code, uid, '伺服器出了點問題，請再試一次');
  }
});

// 只留引擎需要的欄位；seat 一律由伺服器填成發送者本人
function sanitize(a) {
  const out = { type: String(a.type) };
  for (const k of ['to', 'target', 'kind', 'act']) {
    if (typeof a[k] === 'string') out[k] = a[k].slice(0, 64);
  }
  return out;
}

function sideMap(s) {
  const out = {};
  for (const p of s.seats) out[p.id] = (s.roles[p.id] === 'monster' || (s.fallen && s.fallen[p.id])) ? 'monster' : 'human';
  return out;
}

// 把狀態拆成：要存的 core、新增的紀錄
function pack(s) {
  const fresh = s.log;                  // 這次動作新增的紀錄
  const base = s.logCount || 0;
  s.logCount = base + fresh.length;
  s.log = [];                           // 存起來的狀態不帶紀錄，紀錄另外放
  const pub = E.viewFor(s, null);
  delete pub.log;
  const views = {};
  for (const p of s.seats) views[p.id] = JSON.stringify({ me: E.viewFor(s, p.id).me });
  const core = {
    state: JSON.stringify(s),
    side: sideMap(s),
    phase: s.phase,
    rev: s.rev || 0,
    public: JSON.stringify(pub),
    views,
  };
  const logs = {};
  fresh.forEach((l, i) => { logs[String(base + i).padStart(6, '0')] = l; });
  return { core, logs };
}

async function writeLogs(code, logs) {
  if (!Object.keys(logs).length) return;
  await getDatabase().ref(`game/${code}/log`).update(logs);
}

async function applyIntent(code, uid, action) {
  action.seat = uid;
  let error = null, out = null;
  const coreRef = getDatabase().ref(`game/${code}/core`);
  const result = await coreRef.transaction((cur) => {
    error = null; out = null;
    if (cur === null) { error = '遊戲還沒開始'; return null; } // 第一次可能拿到空值，SDK 會用真正的資料重跑
    if (!cur.state) { error = '遊戲還沒開始'; return; }
    const s = JSON.parse(cur.state);
    s.log = [];
    const r = E.applyAction(s, action, Date.now());
    if (r.error) { error = r.error; return; }          // 回傳 undefined = 放棄這次交易
    out = pack(r.state);
    return out.core;
  });
  if (error) {
    if (action.type !== 'timeout') await reportError(code, uid, error); // 超時被拒很正常，不用吵
    return;
  }
  if (!result.committed || !out) return;
  await writeLogs(code, out.logs);
  await afterCommit(code, out.core);
}

// 每次結算後：更新房間狀態、寫一份加密存檔
async function afterCommit(code, core) {
  const updates = {};
  updates[`rooms/${code}/meta/status`] = core.phase === 'over' ? 'over' : 'playing';
  updates[`rooms/${code}/save`] = encrypt({ v: 1, code, savedAt: Date.now(), state: core.state });
  await getDatabase().ref().update(updates);
}

async function readSeats(code) {
  const seatsObj = (await getDatabase().ref(`rooms/${code}/seats`).get()).val() || {};
  return Object.entries(seatsObj)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([id, v]) => ({ id, name: String(v.name || '玩家').slice(0, 12), ready: !!v.ready }));
}

async function startGame(code, uid, type) {
  const db = getDatabase();
  const meta = (await db.ref(`rooms/${code}/meta`).get()).val();
  if (!meta) return;
  if (meta.host !== uid) return reportError(code, uid, '只有房主可以開始遊戲');
  if (type === 'start' && meta.status !== 'lobby') return reportError(code, uid, '遊戲已經開始了');
  if (type === 'again' && meta.status !== 'over') return reportError(code, uid, '這局還沒結束');

  const seats = await readSeats(code);
  const mode = meta.mode === 'coop' ? 'coop' : 'roles';
  const minP = E.RULES.minPlayersFor(mode);
  if (seats.length < minP) return reportError(code, uid, `這個模式至少要 ${minP} 人才能開始`);
  if (seats.length > E.RULES.maxPlayers) return reportError(code, uid, `最多 ${E.RULES.maxPlayers} 人`);
  if (type === 'start' && seats.some(p => p.id !== meta.host && !p.ready)) return reportError(code, uid, '還有人沒按準備');

  const speed = E.SPEEDS[meta.preset] ? meta.preset : 'standard';
  const seed = Math.floor(Math.random() * 2147483647);
  const s = E.createGame({ seats, seed, speed, mode, now: Date.now() });
  await installGame(code, uid, s, type === 'again');
}

// 把一局新遊戲（或讀回來的存檔）放進房間
async function installGame(code, uid, s, clearChat) {
  const db = getDatabase();
  let out = null, ok = false;
  await db.ref(`game/${code}/core`).transaction((cur) => {
    ok = false;
    if (cur && cur.phase && cur.phase !== 'over') return;   // 避免重複開局
    ok = true;
    s.logCount = 0;
    out = pack(JSON.parse(JSON.stringify(s)));
    return out.core;
  });
  if (!ok) return reportError(code, uid, '遊戲已經開始了');
  const updates = {};
  updates[`game/${code}/log`] = null;
  updates[`rooms/${code}/wolf`] = null;
  if (clearChat) updates[`rooms/${code}/chat`] = null;
  await db.ref().update(updates);
  await writeLogs(code, out.logs);
  await afterCommit(code, out.core);
}

// 讀檔：只有房主、只能在大廳。存檔裡的玩家名字要跟現在房間裡的玩家一一對上。
async function loadGame(code, uid, blob) {
  const db = getDatabase();
  const meta = (await db.ref(`rooms/${code}/meta`).get()).val();
  if (!meta) return;
  if (meta.host !== uid) return reportError(code, uid, '只有房主可以讀取存檔');
  if (meta.status !== 'lobby') return reportError(code, uid, '要在大廳才能讀取存檔');
  let save;
  try { save = decrypt(blob); } catch { return reportError(code, uid, '這個存檔打不開，可能檔案壞了，或不是這個網站的存檔'); }
  const s = JSON.parse(save.state);
  const seats = await readSeats(code);
  const byName = {};
  seats.forEach(p => { byName[p.name] = p.id; });
  const missing = s.seats.filter(p => !byName[p.name]).map(p => p.name);
  if (missing.length) return reportError(code, uid, `房間裡少了存檔中的玩家：${missing.join('、')}（名字要一模一樣）`);
  if (seats.length !== s.seats.length) return reportError(code, uid, `存檔是 ${s.seats.length} 人局，現在房間有 ${seats.length} 人`);
  const map = {};
  s.seats.forEach(p => { map[p.id] = byName[p.name]; });
  const restored = E.remapSeats(s, map);
  const now = Date.now();
  restored.now = now;
  restored.log = [{ text:`（從存檔讀取：第 ${restored.round} 輪，雷雨 ${restored.storms} 次。）`, kind:'', ts:now }];
  if (restored.deadline) restored.deadline = now + 60 * 1000;   // 讀檔後給大家一分鐘回神
  await installGame(code, uid, restored, true);
}

// ---------- 存檔加密（AES-256-GCM） ----------
function keyBytes() { return crypto.createHash('sha256').update(SAVE_KEY.value()).digest(); }
function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyBytes(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'LHSAVE1:' + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}
function decrypt(blob) {
  if (!blob.startsWith('LHSAVE1:')) throw new Error('bad header');
  const raw = Buffer.from(blob.slice(8), 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', keyBytes(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

async function reportError(code, uid, msg) {
  await getDatabase().ref(`rooms/${code}/errors/${uid}`).set({ msg, ts: Date.now() });
}
