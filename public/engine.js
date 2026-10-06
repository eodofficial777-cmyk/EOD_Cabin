/* =========================================================
   荒中小屋　遊戲引擎 v2（前端和 Cloud Functions 共用）
   只放規則、資料和純函式，不碰畫面也不碰資料庫。
   改這個檔案之後重新部署，firebase.json 的 predeploy 會自動複製一份到 functions/。

   流程：看身份 → 白天輪流行動 → 每兩輪一次雷雨 → … → 三道封印解開 → 中庭決戰
   ========================================================= */
(function (root) {
'use strict';

// ---------- 規則數值（平衡都改這裡） ----------
const RULES = {
  minPlayers: 3,         // 無身份合作模式的最少人數
  minPlayersRoles: 5,    // 有身份模式最少 5 人：4 人時拿燭台的人太少，怪物偷兩次就贏
  maxPlayers: 8,
  apPerTurn: 2,          // 每回合行動點
  stormEvery: 2,         // 每幾輪來一次雷雨
  // 這麼多次雷雨過後封印還沒解完，怪物獲勝。人少行動點少，所以給比較多次。
  maxStormsFor: (n, mode) => mode === 'coop' ? ({ 3:7, 4:6, 5:4, 6:4, 7:4, 8:4 }[n] || 4) : ({ 5:9, 6:6, 7:5, 8:9 }[n] || 7),
  sealNeed: 2,           // 每道封印需要幾間同類房間亮著（不含封印房本身）
  sealPity: 8,           // 連續探索這麼多次都沒遇到封印房，下一次保證是封印房
  wetCost: 2,            // 被怪物熄掉的房間，燈芯受潮，重點要花的行動點
  revealSec: 45,         // 看身份卡的時間
  monsterSanity: 3,      // 怪物的理智上限；雷雨時沒作祟就 -1，歸零身份公開
  hauntFall: 11,         // 作祟巫師時擲 1D20，達到這個數字巫師墮落成魔人
  beastDC: 12,           // 遭遇災獸：1D20 + 命中加成 ≥ 這個數字就擊退
  baseHp: 20,
  baseSan: 50,
  recoveryStep: 5,       // 同時點亮的房間每多這麼多間，恢復等級 +1（最多 3）
  bossHp: 50,            // 原版設定：HP 50
  bossDefBase: 8,        // 原版設定：DEF 1D10 + 護甲 8
  bossHpPerCandle: 5,    // 怪物每偷走一個燭台，頭目 HP +5
  bossHpPerExtra: 27,    // 人類每多於 3 人，頭目 HP +27
  bossBite: 3,           // 撕咬傷害：幾顆 D6
  fireBonus: 0,          // 燭火傷害 2D6 + 這個數字
  bossTail: 1,          // 怪物每回合額外的甩尾攻擊次數（隨機目標，1D6）
  sweepBonus: 2,         // 橫掃傷害 1D6 + 這個數字
  sweepCooldown: 2,
  whisperCooldown: 2,
  chatMax: 200,
  plurkLimit: 300,
  monstersFor: n => n >= 8 ? 2 : 1,   // 7 人兩隻怪物時人類勝率掉到三成以下，所以 8 人才兩隻
  minPlayersFor: mode => mode === 'coop' ? 3 : 5,
};

// 房主可選的速度檔位（秒）
const SPEEDS = {
  fast:     { label:'快速',      turnSec:45,  stormSec:20, battleSec:25 },
  standard: { label:'標準',      turnSec:60,  stormSec:30, battleSec:40 },
  slow:     { label:'RP 慢慢來', turnSec:120, stormSec:60, battleSec:90 },
};

const DIRS = { N:[0,-1], E:[1,0], S:[0,1], W:[-1,0] };
const DICE = '⚀⚁⚂⚃⚄⚅';

// 一般房間（探索擲到 6–18 從這裡抽）
const CARDS = {
  start:          { name:'醒來的房間',   tag:null,   table:'common' },
  filler:         { name:'無名的房間',   tag:null,   table:'common' },
  pumpkin_cellar: { name:'南瓜地窖',     tag:'作物', table:'crop' },
  scarecrow_barn: { name:'稻草人穀倉',   tag:'作物', table:'crop' },
  candy_kitchen:  { name:'糖果廚房',     tag:'作物', table:'crop' },
  apple_room:     { name:'咬蘋果水盆間', tag:'作物', table:'crop' },
  nameless_tomb:  { name:'無名墓室',     tag:'墓園', table:'grave' },
  coffin_hall:    { name:'棺木長廊',     tag:'墓園', table:'grave' },
  keeper_hut:     { name:'守墓人小屋',   tag:'墓園', table:'grave' },
  clock_room:     { name:'停擺的鐘房',   tag:'墓園', table:'grave' },
  bone_stair:     { name:'白骨樓梯',     tag:'墓園', table:'grave' },
  moon_balcony:   { name:'月光天井',     tag:'月光', table:'moon' },
  skylight_attic: { name:'天窗小室',     tag:'月光', table:'moon' },
  mirror_gallery: { name:'鏡子迴廊',     tag:'月光', table:'moon' },
  owl_study:      { name:'貓頭鷹書房',   tag:'月光', table:'moon' },
  web_stair:      { name:'蛛網樓梯',     tag:null,   table:'common' },
  mask_closet:    { name:'面具衣帽間',   tag:null,   table:'common' },
  black_cat:      { name:'黑貓走道',     tag:null,   table:'common' },
  candle_store:   { name:'燭台儲藏室',   tag:null,   table:'common' },
  piano_room:     { name:'落灰琴房',     tag:null,   table:'common' },
  soup_kitchen:   { name:'熬湯灶間',     tag:null,   table:'common' },
  // 封印房（探索擲到 19 以上）
  altar_pumpkin:  { name:'南瓜祭壇',     tag:'作物', table:'crop',  seal:'pumpkin' },
  bell_tower:     { name:'骨鐘塔',       tag:'墓園', table:'grave', seal:'bell' },
  eclipse_glass:  { name:'月蝕溫室',     tag:'月光', table:'moon',  seal:'moon' },
};

const SEALS = [
  { id:'pumpkin', name:'南瓜封印', icon:'🎃', room:'altar_pumpkin', tag:'作物' },
  { id:'bell',    name:'骨鐘封印', icon:'🔔', room:'bell_tower',    tag:'墓園' },
  { id:'moon',    name:'月蝕封印', icon:'🌘', room:'eclipse_glass', tag:'月光' },
];

// 裝備：探索和搜索時找到，數值會帶進中庭決戰
const GEAR = {
  weapon: { name:'順手的武器',     atk:1, dmg:1, armor:0, san:0 },
  armor:  { name:'厚實的護具',     atk:0, dmg:0, armor:1, san:0 },
  charm:  { name:'熟悉的飾品',     atk:0, dmg:0, armor:0, san:10 },
  own:    { name:'屬於自己的裝備', atk:1, dmg:2, armor:1, san:5 },
};

// 災獸：探索擲到 1–2
const BEASTS = {
  common: '老鼠大小的錐齒獸',
  crop:   '南瓜頭野狗',
  grave:  '啃骨的錐齒獸',
  moon:   '月下的大蝙蝠',
};

// 特殊事件：探索擲到 3–5，再擲 1D6 查表
// fx：none / ap 多一點行動 / chill 隨機一間房暗掉 / lightNear 相鄰的暗房亮起 / warp 傳送 / stop 回合結束 / sanDown 理智 -1D6 / heal 回復 1D6 HP
const EVENTS = {
  common: [
    { t:'一陣冷風穿過走廊。', fx:'chill' },
    { t:'地板嘎吱作響，什麼也沒發生。', fx:'none' },
    { t:'牆上的肖像好像在看你。', fx:'sanDown' },
    { t:'角落的南瓜燈自己亮了。', fx:'lightNear' },
    { t:'你找到一壺乾淨的水，喝了舒服多了。', fx:'heal' },
    { t:'書櫃後面有一道暗門。', fx:'warp' },
  ],
  crop: [
    { t:'稻草人轉過頭來，你嚇得愣在原地。', fx:'stop' },
    { t:'空氣裡是甜膩的烤南瓜味。', fx:'none' },
    { t:'你吃了一顆糖，精神好多了。', fx:'ap' },
    { t:'南瓜藤一路長到隔壁，那裡的燈亮了。', fx:'lightNear' },
    { t:'窗縫灌進冷風。', fx:'chill' },
    { t:'籃子裡的蘋果全都在流血。', fx:'sanDown' },
  ],
  grave: [
    { t:'墓土翻動了一下，你不敢再往前。', fx:'stop' },
    { t:'遠處傳來鐘聲，某處的燈晃了晃。', fx:'chill' },
    { t:'墓碑上的照片，長得跟你一模一樣。', fx:'sanDown' },
    { t:'供桌上的甜粿還能吃。', fx:'heal' },
    { t:'棺蓋下的通道把你帶到別處。', fx:'warp' },
    { t:'只聽得到自己的腳步聲。', fx:'none' },
  ],
  moon: [
    { t:'雲遮住月亮，屋裡一下子暗了。', fx:'chill' },
    { t:'月光很亮，一切都很安靜。', fx:'none' },
    { t:'鏡子裡的你往別的方向走去，你跟了上去。', fx:'warp' },
    { t:'月光落在隔壁的燭芯上，它亮了。', fx:'lightNear' },
    { t:'貓頭鷹叼來一根火柴，你覺得腳步輕快起來。', fx:'ap' },
    { t:'窗外有張臉貼在玻璃上。', fx:'sanDown' },
  ],
};

// 搜索表：在亮著的房間花 1 點行動搜索，擲 1D6。每次雷雨之間，每間房只能被搜一次。
// 房間被怪物熄燈時，待在裡面的人擲 1D6
const DARK_EVENTS = [
  { t:'黑暗中有東西絆倒了你。', fx:'trip' },
  { t:'有什麼冰冷的東西擦過你的臉。', fx:'sanDown' },
  { t:'你嚇得縮成一團。', fx:'skipNext' },
  { t:'慌亂中，你在地上摸到一根火柴。', fx:'match' },
  { t:'你屏住呼吸，什麼事也沒發生。', fx:'none' },
  { t:'閃電亮起的瞬間，你瞥見了熄燈者的身影。', fx:'glimpse' },
];

const SEARCH = {
  common: [
    { t:'抽屜裡有一個舊燭台，還能用。', fx:'candle' },
    { t:'衣櫃裡掛著一件厚實的外套。', fx:'armor' },
    { t:'一盒乾燥的火柴。', fx:'match' },
    { t:'只有灰塵和蜘蛛網。', fx:'none' },
    { t:'鏡子裡的倒影對你笑，你一直覺得背後發毛。', fx:'sanDown' },
    { t:'抽屜裡的舊照片突然動了一下，你嚇得腿軟。', fx:'skipNext' },
  ],
  crop: [
    { t:'南瓜裡的種子在低語，你聽得頭昏。', fx:'apDown' },
    { t:'一包還沒拆的糖果，吃了精神好。', fx:'heal' },
    { t:'稻草人的口袋裡有火柴。', fx:'match' },
    { t:'一把生鏽的鐮刀，握起來還算順手。', fx:'weapon' },
    { t:'你咬到一顆會說話的糖，被詛咒了。', fx:'curse' },
    { t:'南瓜燈裡插著一個燭台。', fx:'candle' },
  ],
  grave: [
    { t:'墓碑上刻著你的名字，你嚇得動彈不得。', fx:'skipNext' },
    { t:'守墓人的油燈旁留著一個燭台。', fx:'candle' },
    { t:'一隻冰冷的手抓住你的腳踝，你被詛咒了。', fx:'curse' },
    { t:'一條陌生又熟悉的項鍊，戴上後心情平靜許多。', fx:'charm' },
    { t:'只是一堆枯葉。', fx:'none' },
    { t:'守墓人的鏟子，比想像中好用。', fx:'weapon' },
  ],
  moon: [
    { t:'月光照出牆上的祕密通道。', fx:'warp' },
    { t:'月光讓你精神一振。', fx:'apUp' },
    { t:'貓頭鷹一直盯著你，你不太敢動。', fx:'apDown' },
    { t:'窗台上有人留下火柴。', fx:'match' },
    { t:'雲遮住月亮，你的影子不見了。你被詛咒了。', fx:'curse' },
    { t:'鏡框後面藏著一面小圓盾。', fx:'armor' },
  ],
};

// 身份卡：勝負條件和能做的事（畫面上用條列呈現，隨時可以翻看）
const ROLE_CARDS = {
  human: {
    win:  ['三道封印全部解開，並在中庭決戰打倒怪物'],
    lose: ['人類陣營所有人都失去燭台', `第 {storms} 次雷雨過後封印還沒解完`, '中庭決戰時所有人倒下或陷入瘋狂'],
    can:  [
      '點燈：用燭台點亮所在房間或相鄰的一格（1 點；被熄過的房間 2 點）',
      '探索：走進點亮的黑暗，擲 1D20 決定遇到什麼（1 點）',
      '搜索：亮著的房間可以翻找，每次雷雨之間每間房只能搜一次（1 點）',
      '鑰匙：每次雷雨之間可以鎖一間房（不能鎖自己所在的那間），鎖上後到雷雨結束前誰都不能進出（不花行動點）',
      '把可疑的人鎖在房間裡，他在雷雨時就只能對同房間出手',
      '落單時燭台可能被偷，跟隊友待在同一間比較安全',
    ],
  },
  witch: {
    win:  ['三道封印全部解開，並在中庭決戰打倒怪物'],
    lose: ['人類陣營所有人都失去燭台', `第 {storms} 次雷雨過後封印還沒解完`, '中庭決戰時所有人倒下或陷入瘋狂'],
    can:  [
      '和普通人一樣可以點燈、探索、搜索、上鎖',
      '雷雨時用燭火看見一個人的真實（整局一次，用完燭台燃盡，之後要再找燭台才能點燈）',
      '看到的結果只有你知道，要不要說、跟誰說由你決定',
      `被怪物作祟時擲 1D20，${RULES.hauntFall} 以上會墮落成魔人，改站怪物那邊`,
    ],
  },
  monster: {
    win:  ['人類陣營所有人都失去燭台', `撐過第 {storms} 次雷雨`, '中庭決戰打倒所有人'],
    lose: ['中庭決戰時深淵的怪物被打倒'],
    can:  [
      '你沒有燭台，但可以假裝點燈；假燈在下次雷雨時會熄滅',
      '在黑暗的房間裡行走不需要燭台',
      '雷雨時三選一作祟：熄燈、偷走落單者的燭台、作祟某人',
      '作祟普通人會嚇得他下回合不能行動；作祟巫師有機會讓她墮落成魔人',
      `雷雨時沒作祟，理智 -1；理智歸零身份公開（上限 ${RULES.monsterSanity}）`,
      '被鎖在房間裡時，雷雨只能熄同一間的燈、作祟同一間的人',
      '封印解開後，在中庭決戰親自操控深淵的怪物',
    ],
  },
  fallen: {
    win:  ['人類陣營所有人都失去燭台', `撐過第 {storms} 次雷雨`, '中庭決戰打倒所有人'],
    lose: ['中庭決戰時深淵的怪物被打倒'],
    can:  ['雷雨時熄掉一盞燈', '可以用狼人頻道和怪物商量', '中庭決戰時當怪物的爪牙：抓傷或詛咒一人'],
  },
  coop: {
    win:  ['三道封印全部解開，並在中庭決戰打倒怪物'],
    lose: [`第 {storms} 次雷雨過後封印還沒解完`, '中庭決戰時所有人倒下或陷入瘋狂'],
    can:  [
      '點燈：用燭台點亮所在房間或相鄰的一格（1 點；受潮的房間 2 點）',
      '探索：走進點亮的黑暗，擲 1D20 決定遇到什麼（1 點）',
      '搜索：亮著的房間每次雷雨之間可以搜一次（1 點）',
      '鑰匙：鎖上的房間雷雨時不會被熄燈，但雷雨結束前誰都不能進出',
      '雷雨會隨機熄掉兩盞燈',
    ],
  },
};

// 結局文字（遊戲結束時寫進紀錄，也會匯出成噗文）。想換成自己的文字直接改這裡。
const ENDINGS = {
  escape: {
    title: '離開宅邸',
    lines: [
      '怪物的身體崩散成黑色的灰，中庭裡只剩下燭火劈啪作響。',
      '中庭盡頭出現一道通往地面的石階。你們扶著彼此往上走，推開沉重的大門，外面是萬聖夜將盡的天色。',
      '你們離開了這座宅邸。',
    ],
  },
  wiped: {
    title: '中庭的寂靜',
    lines: [
      '中庭裡再也沒有人站著。',
      '燭火一盞一盞熄滅，深淵的怪物慢慢爬回地底。宅邸又安靜下來，等著下一批迷路的人。',
    ],
  },
  candles: {
    title: '最後的燭火',
    lines: [
      '最後一個燭台熄滅了。',
      '黑暗從四面八方湧上來，再也分不清哪裡是來時的路。宅邸的門在身後闔上，沒有人走出來。',
    ],
  },
  storms: {
    title: '雷雨不停',
    lines: [
      '雷雨一次比一次猛烈，封印卻始終沒有解開。',
      '天亮之前，宅邸把你們留了下來。',
    ],
  },
};

const ROLE_INFO = {
  human:   { name:'普通人', cls:'role-human',   desc:'要相信巫師，對所有人存疑。用燭台點亮房間、解開三道封印。鑰匙每次雷雨之間可以鎖一間房，怪物進不去。' },
  witch:   { name:'巫師',   cls:'role-witch',   desc:'與普通人一起揪出潛伏在人群中的怪物。雷雨時可以用燭台的火光看見一個人的真實，但用完會失去燭台。如果被怪物作祟，可能墮落成魔人。' },
  monster: { name:'怪物',   cls:'role-monster', desc:`你沒有燭台，但可以假裝點燈（假的燈在下次雷雨時熄滅）。雷雨時可以在黑暗中自由移動作祟：熄燈、偷走落單者的燭台，或作祟某人。太久沒作祟會失去理智、身份曝光。所有人都失去燭台，或撐過第 {storms} 次雷雨，你就贏了。封印解開後，你將親自操控中庭的怪物。` },
  fallen:  { name:'魔人',   cls:'role-monster', desc:'你被怪物作祟，墮落成魔人，現在站在怪物那一邊。雷雨時可以熄燈，中庭決戰時與怪物並肩作戰。' },
};

// ---------- 亂數 ----------
function rnd(s){
  s.rng = (s.rng + 0x6D2B79F5) | 0;
  let t = s.rng;
  t = Math.imul(t ^ t >>> 15, 1 | t);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
function d(s, sides){ return 1 + Math.floor(rnd(s) * sides); }
function dn(s, n, sides){ let t = 0; for (let i = 0; i < n; i++) t += d(s, sides); return t; }
function pick(s, arr){ return arr[Math.floor(rnd(s) * arr.length)]; }
function shuffle(s, arr){
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--){ const j = Math.floor(rnd(s) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- 小工具 ----------
function step(key, dir){ const [x,y] = key.split(',').map(Number); const [dx,dy] = DIRS[dir]; return (x+dx) + ',' + (y+dy); }
function adj(key){ return Object.keys(DIRS).map(dir => step(key, dir)); }
function isAdj(a, b){ return adj(a).includes(b); }
function cur(st){ return st.turnOrder[st.turnIdx]; }
function nameOf(st, id){ const p = st.seats.find(x => x.id === id); return p ? p.name : '?'; }
function roomName(st, key){ const c = st.map[key]; return c && c.explored ? CARDS[c.card].name : '一片黑暗'; }
function log(s, text, kind = ''){ s.log.push({ text, kind, ts: s.now || Date.now() }); }
function note(s, id, text){ if (s.priv[id]) s.priv[id].notes.push({ round:s.round, text }); }
function setDeadline(s, sec){ s.deadline = (s.now || Date.now()) + sec * 1000; }
function roleOf(s, id){ return s.fallen && s.fallen[id] ? 'fallen' : s.roles[id]; }
function isMonsterSide(s, id){ const r = roleOf(s, id); return r === 'monster' || r === 'fallen'; }
function isHumanSide(s, id){ return !isMonsterSide(s, id); }
function sealLocked(st, key){ const c = st.map[key]; return !!(c && c.explored && CARDS[c.card].seal && st.seals[CARDS[c.card].seal]); }
function litCount(st){ return Object.values(st.map).filter(c => c.explored && c.lit).length; }
function darkRoomCount(st){ return Object.values(st.map).filter(c => c.explored && !c.lit).length; }
function gearTotal(st, id){
  const t = { atk:0, dmg:0, armor:0, san:0 };
  (st.stats[id].gear || []).forEach(g => { const G = GEAR[g]; t.atk += G.atk; t.dmg += G.dmg; t.armor += G.armor; t.san += G.san; });
  return t;
}
function recovery(st){ return Math.min(3, Math.floor((st.maxLit || 0) / RULES.recoveryStep)); }

function sealStatus(st, se){
  const key = Object.keys(st.map).find(k => st.map[k].explored && st.map[k].card === se.room);
  const tagLit = Object.keys(st.map).filter(k => k !== key && st.map[k].explored && st.map[k].lit && CARDS[st.map[k].card].tag === se.tag).length;
  const lit = !!(key && st.map[key].lit);
  return { found:!!key, lit, tagLit, need:RULES.sealNeed, ready: lit && tagLit >= RULES.sealNeed };
}

// 怪物雷雨時能熄的燈：亮著、沒上鎖、不是已解開的封印房、不是起點
function snuffTargets(st){
  return Object.keys(st.map).filter(k => st.map[k].lit && !st.locks[k] && !sealLocked(st, k) && k !== '0,0');
}

// ---------- 開局 ----------
function createGame({ seats, seed, speed = 'standard', mode = 'roles', now }){
  const s = {
    gameId: String(seed) + ':' + (now || Date.now()), ending:null,
    now: now || Date.now(), rev:0, speed: SPEEDS[speed] ? speed : 'standard',
    settings: SPEEDS[speed] || SPEEDS.standard, mode: mode === 'coop' ? 'coop' : 'roles',
    deadline:null, seed, rng: seed | 0,
    phase:'reveal', round:1, storms:0, maxStorms:0,
    seats: seats.map(x => ({ id:x.id, name:x.name })),
    roles:{}, fallen:{}, priv:{}, ready:{}, monster:{}, revealed:{},
    deck:[], map:{}, fakes:{}, pos:{}, stats:{}, status:{}, locks:{}, searched:{}, sealSearched:{},
    seals:{}, sinceSeal:0, maxLit:0,
    turnOrder:[], turnIdx:0, ap:0, stormActs:{}, lastStorm:null, battle:null,
    log:[], winner:null,
  };
  s.maxStorms = RULES.maxStormsFor(s.seats.length, s.mode);
  const ids = shuffle(s, s.seats.map(x => x.id));
  const m = s.mode === 'coop' ? 0 : RULES.monstersFor(ids.length);
  ids.forEach((id, i) => {
    s.roles[id] = s.mode === 'coop' ? 'human' : i < m ? 'monster' : i === m ? 'witch' : 'human';
    s.priv[id] = { candle: s.roles[id] !== 'monster', checks:[], eyeUsed:false, notes:[] };
    if (s.roles[id] === 'monster') s.monster[id] = { sanity:RULES.monsterSanity, stolen:0 };
  });
  s.deck = shuffle(s, Object.keys(CARDS).filter(k => k !== 'start' && k !== 'filler' && !CARDS[k].seal));
  SEALS.forEach(se => { s.seals[se.id] = false; });
  s.map['0,0'] = { card:'start', lit:true, explored:true };
  s.seats.forEach(p => {
    s.pos[p.id] = '0,0';
    s.stats[p.id] = { hp:RULES.baseHp, maxHp:RULES.baseHp, san:RULES.baseSan, maxSan:RULES.baseSan, gear:[] };
    s.status[p.id] = { skip:false, apMod:0, cursed:false, matches:0, lockUsed:false };
  });
  s.maxLit = 1;
  log(s, '你們在漆黑的地下室醒來，通訊設備和武器都不見了，口袋裡只剩一副鑰匙和一張紙卡。');
  setDeadline(s, RULES.revealSec);
  return s;
}

// ---------- 白天 ----------
function startRound(s){
  s.phase = 'day';
  const ids = s.seats.map(x => x.id);
  const off = (s.round - 1) % ids.length;
  s.turnOrder = ids.slice(off).concat(ids.slice(0, off));
  s.turnIdx = 0;
  log(s, `第 ${s.round} 輪開始。`);
  if (s.round % RULES.stormEvery === 0) log(s, '遠方傳來雷聲。這一輪結束後，雷雨就會來。', 'warn');
  beginTurn(s);
}

function beginTurn(s){
  while (s.turnIdx < s.turnOrder.length){
    const id = cur(s), st = s.status[id], nm = nameOf(s, id);
    if (st.skip){ st.skip = false; log(s, `${nm} 還沒回過神來，跳過這回合。`); s.turnIdx++; continue; }
    s.ap = Math.max(0, RULES.apPerTurn + st.apMod);
    if (st.apMod > 0) log(s, `${nm} 這回合多 ${st.apMod} 點行動點。`);
    if (st.apMod < 0) log(s, `${nm} 這回合少 ${-st.apMod} 點行動點。`);
    st.apMod = 0;
    if (s.ap === 0){ log(s, `${nm} 沒有力氣行動。`); s.turnIdx++; continue; }
    log(s, `輪到 ${nm}。`, 'turn');
    setDeadline(s, s.settings.turnSec);
    return;
  }
  if (s.round % RULES.stormEvery === 0) startStorm(s);
  else { s.round++; startRound(s); }
}
function endTurn(s){ s.turnIdx++; beginTurn(s); }
function afterAp(s){ if (s.phase === 'day' && s.ap <= 0) endTurn(s); }
function dayCheck(s, a, cost = 1){
  if (s.phase !== 'day') return '現在不能這樣做';
  if (a.seat !== cur(s)) return '還沒輪到你';
  if (s.ap < cost) return '行動點不夠';
  return null;
}
// 點亮的房間越多，身上不屬於自己的特徵越少（原版設定）。恢復等級上升時寫進紀錄，頭像也會跟著換。
const RECOVERY_TEXT = [
  '',
  '點亮的房間越來越多，大家身上不屬於自己的特徵開始消退。',
  '光亮驅散了大部分的異樣，大家慢慢變回原本的樣子。',
  '整座地下室亮了起來，力量也恢復得差不多了。',
];
function updateMaxLit(s){
  const before = recovery(s);
  s.maxLit = Math.max(s.maxLit || 0, litCount(s));
  const after = recovery(s);
  for (let lv = before + 1; lv <= after; lv++) if (RECOVERY_TEXT[lv]) log(s, RECOVERY_TEXT[lv], 'seal-break');
}

function hurt(s, id, dmg){
  const st = s.stats[id];
  st.hp -= dmg;
  if (st.hp <= 0){
    st.hp = 1;
    s.status[id].skip = true;
    log(s, `${nameOf(s,id)} 受了重傷昏過去，下回合不能行動。`);
  }
}
function loseSan(s, id, n){ const st = s.stats[id]; st.san = Math.max(1, st.san - n); }
function gainGear(s, id, g){ s.stats[id].gear.push(g); log(s, `${nameOf(s,id)} 得到了「${GEAR[g].name}」。`); }

function applyFx(s, seat, fx){
  const nm = nameOf(s, seat), st = s.status[seat];
  switch (fx){
    case 'ap': s.ap++; log(s, `${nm} 多了一點行動點。`); break;
    case 'apUp': st.apMod += 1; log(s, `${nm} 下回合行動點 +1。`); break;
    case 'apDown': st.apMod -= 1; log(s, `${nm} 下回合行動點 -1。`); break;
    case 'stop': s.ap = 0; log(s, `${nm} 這回合不能再行動。`); break;
    case 'skipNext': st.skip = true; log(s, `${nm} 下回合不能行動。`); break;
    case 'curse': st.cursed = true; log(s, `${nm} 被詛咒了，下次雷雨時不能使用能力。`); break;
    case 'match': st.matches++; log(s, `${nm} 拿到一根火柴，沒有燭台也能點一次燈。`); break;
    case 'candle':
      // 有沒有燭台是祕密，公開紀錄只寫「找到東西」
      log(s, `${nm} 找到一點能點火的東西。`);
      if (s.priv[seat].candle || roleOf(s, seat) === 'monster'){ st.matches++; note(s, seat, '你已經有燭台了（或用不了燭台），這個就當作一根火柴收著。'); }
      else { s.priv[seat].candle = true; note(s, seat, '你找到了一個燭台！'); }
      break;
    case 'weapon': case 'armor': case 'charm': gainGear(s, seat, fx); break;
    case 'heal': { const h = d(s, 6); const S = s.stats[seat]; S.hp = Math.min(S.maxHp, S.hp + h); log(s, `${nm} 回復了 ${h} 點 HP。`); break; }
    case 'sanDown': { const n = d(s, 6); loseSan(s, seat, n); log(s, `${nm} 理智 -${n}。`); break; }
    case 'chill': {
      const keys = Object.keys(s.map).filter(k => s.map[k].explored && s.map[k].lit && !sealLocked(s, k) && k !== '0,0');
      if (keys.length){ const k = pick(s, keys); s.map[k].lit = false; delete s.fakes[k]; log(s, `「${roomName(s,k)}」暗了下來。`); }
      break;
    }
    case 'lightNear': {
      const near = adj(s.pos[seat]).filter(k => s.map[k] && s.map[k].explored && !s.map[k].lit);
      if (near.length){ const k = pick(s, near); s.map[k].lit = true; s.map[k].wet = false; delete s.fakes[k]; updateMaxLit(s); log(s, `「${roomName(s,k)}」亮了起來。`); }
      break;
    }
    case 'warp': {
      if (s.locks[s.pos[seat]]){ log(s, '可是門被鎖住了，哪裡也去不了。'); break; }
      const keys = Object.keys(s.map).filter(k => s.map[k].explored && s.map[k].lit && k !== s.pos[seat] && !s.locks[k]);
      if (keys.length){ const k = pick(s, keys); s.pos[seat] = k; log(s, `${nm} 被帶到了「${roomName(s,k)}」。`); }
      break;
    }
  }
}

// 探索：走進點亮但還沒探索的一格，擲 1D20 決定是什麼
// 1–2 災獸、3–5 特殊事件、6–18 一般房間、19–20 封印房間（原版：小於 6 災獸或特殊事件）
function explore(s, seat, key){
  const nm = nameOf(s, seat);
  const r = d(s, 20);
  const remaining = SEALS.filter(se => !Object.values(s.map).some(c => c.explored && c.card === se.room));
  const pity = r < 19 && remaining.length && s.sinceSeal >= RULES.sealPity;
  let card, kind;
  if ((r >= 19 || pity) && remaining.length){ card = pick(s, remaining).room; kind = 'seal'; s.sinceSeal = 0; }
  else {
    card = s.deck.length ? s.deck.shift() : 'filler';
    kind = r <= 2 ? 'beast' : r <= 5 ? 'event' : 'room';
    if (remaining.length) s.sinceSeal++;
  }
  const c = s.map[key];
  c.card = card; c.explored = true;
  s.pos[seat] = key;
  const C = CARDS[card];
  log(s, `${nm} 走進黑暗，擲出 1D20＝${r}${pity ? '（保底）' : ''}，發現了「${C.name}」。`);
  if (kind === 'seal') log(s, `這裡有一座封印裝置。${SEALS.find(x => x.room === card).icon}`, 'seal-break');
  if (kind === 'beast'){
    const beast = BEASTS[C.table];
    const bonus = gearTotal(s, seat).atk + recovery(s);
    const roll = d(s, 20), total = roll + bonus;
    const rollTxt = `${roll}${bonus ? `+${bonus}＝${total}` : ''}`;
    if (total >= RULES.beastDC){
      log(s, `一隻${beast}撲了上來！${nm} 擲出 ${rollTxt}，把牠趕走了。`);
    } else {
      const dmg = Math.max(1, d(s, 6) - gearTotal(s, seat).armor);
      log(s, `一隻${beast}撲了上來！${nm} 擲出 ${rollTxt}，沒能擋住，受到 ${dmg} 點傷害。`);
      hurt(s, seat, dmg);
      if (d(s, 20) <= 5 && s.priv[seat].candle){
        s.priv[seat].candle = false;
        log(s, `混亂中，${nm} 手上的東西掉進了黑暗裡。`);
        note(s, seat, '你的燭台在和災獸纏鬥時掉了。');
      }
    }
  } else if (kind === 'event'){
    const ev = EVENTS[C.table][d(s, 6) - 1];
    log(s, `特殊事件：${ev.t}`);
    applyFx(s, seat, ev.fx);
  }
}

// ---------- 雷雨 ----------
function startStorm(s){
  s.phase = 'storm';
  s.stormActs = {};
  setDeadline(s, s.settings.stormSec);
  log(s, `雷雨來了。（第 ${s.storms + 1} 次）`, 'night');
}

function resolveStorm(s){
  const acts = s.stormActs;
  const dark = [];
  const broken = [];
  const revealedNow = [];

  // 1. 巫師看見真實
  for (const [id, a] of Object.entries(acts)){
    if (roleOf(s, id) !== 'witch' || a.kind !== 'eye' || !a.target) continue;
    const pv = s.priv[id];
    if (!pv.candle || pv.eyeUsed) continue;
    pv.candle = false; pv.eyeUsed = true;
    const r = roleOf(s, a.target);
    pv.checks.push({ storm:s.storms + 1, target:a.target, role:r });
    note(s, id, `燭火映出了真實：${nameOf(s, a.target)} 是${ROLE_INFO[r].name}。你的燭台燃盡了。`);
  }

  // 2. 怪物與魔人作祟（鎖上的房間進不去；被鎖在房裡的只能對同一間出手）
  for (const [id, a] of Object.entries(acts)){
    if (!isMonsterSide(s, id)) continue;
    const isMonster = roleOf(s, id) === 'monster';
    const myRoom = s.pos[id];
    const trapped = !!s.locks[myRoom];
    let acted = false;
    if (a.kind === 'snuff' && a.target && s.map[a.target]){
      const c = s.map[a.target];
      const reachable = trapped ? a.target === myRoom : !s.locks[a.target];
      if (c.lit && reachable && !sealLocked(s, a.target)){
        c.lit = false; c.wet = true; delete s.fakes[a.target];
        dark.push(a.target); acted = true;
        darkEvents(s, a.target, id);
      } else note(s, id, trapped ? '你被鎖在房間裡，碰不到那盞燈。' : `「${roomName(s, a.target)}」被鎖上了，或已經暗了，你沒能得手。`);
    }
    if (isMonster && a.kind === 'steal' && a.target && s.priv[a.target]){
      acted = true;
      const where = s.pos[a.target];
      const alone = s.seats.filter(p => p.id !== a.target && s.pos[p.id] === where).length === 0;
      if (trapped){ note(s, id, '你被鎖在房間裡，出不去。'); acted = false; }
      else if (s.locks[where]) note(s, id, `${nameOf(s,a.target)} 所在的房間上了鎖，你進不去。`);
      else if (!alone) note(s, id, `${nameOf(s,a.target)} 身邊有人，你沒辦法下手。`);
      else if (!s.priv[a.target].candle) note(s, id, `${nameOf(s,a.target)} 身上沒有燭台。`);
      else {
        s.priv[a.target].candle = false;
        s.monster[id].stolen++;
        note(s, id, `你偷走了 ${nameOf(s,a.target)} 的燭台。`);
        note(s, a.target, '雷聲過後，你發現燭台不見了。');
      }
    }
    if (isMonster && a.kind === 'haunt' && a.target && s.roles[a.target] && trapped && s.pos[a.target] !== myRoom){
      note(s, id, `你被鎖在房間裡，碰不到 ${nameOf(s, a.target)}。`);
    } else if (isMonster && a.kind === 'haunt' && a.target && s.roles[a.target]){
      acted = true;
      if (roleOf(s, a.target) === 'witch'){
        const r = d(s, 20);
        if (r >= RULES.hauntFall){
          s.fallen[a.target] = true;
          note(s, a.target, `怪物的低語鑽進你的腦袋（1D20＝${r}）。你墮落成了魔人，現在站在怪物那一邊。`);
          Object.keys(s.monster).forEach(mid => note(s, mid, `${nameOf(s,a.target)} 是巫師，已經墮落成魔人，成為你的同夥。`));
        } else {
          note(s, a.target, `你感覺到怪物的低語，但撐住了（1D20＝${r}）。`);
          note(s, id, `你作祟了 ${nameOf(s,a.target)}，對方撐住了。`);
        }
      } else {
        s.status[a.target].skip = true;
        note(s, id, `你作祟了 ${nameOf(s,a.target)}，對方嚇得下回合不能行動。`);
        log(s, `${nameOf(s,a.target)} 在雷雨中被什麼東西嚇壞了。`);
      }
    }
    // 理智：作祟就恢復，沒作祟就流失
    if (isMonster){
      const m = s.monster[id];
      m.sanity = acted ? Math.min(RULES.monsterSanity, m.sanity + 1) : m.sanity - 1;
      if (!acted) note(s, id, `你太久沒有作祟，理智剩下 ${Math.max(0, m.sanity)}。`);
      if (m.sanity <= 0 && !s.revealed[id]){ s.revealed[id] = true; revealedNow.push(id); }
    }
  }

  // 3. 雷雨的風吹熄一盞真的燈；無身份模式再多熄一盞（代替怪物）
  const blowable = () => Object.keys(s.map).filter(k => s.map[k].lit && !s.fakes[k] && !s.locks[k] && !sealLocked(s, k) && k !== '0,0');
  let b = blowable();
  if (b.length){ const k = pick(s, b); s.map[k].lit = false; dark.push(k); }
  if (s.mode === 'coop'){ b = blowable(); if (b.length){ const k = pick(s, b); s.map[k].lit = false; s.map[k].wet = true; dark.push(k); } }

  // 4. 怪物的假燈消失
  Object.keys(s.fakes).forEach(k => { if (s.map[k] && s.map[k].lit){ s.map[k].lit = false; dark.push(k); } });
  s.fakes = {};

  // 5. 檢查封印
  SEALS.forEach(se => { if (!s.seals[se.id] && sealStatus(s, se).ready){ s.seals[se.id] = true; broken.push(se.id); } });

  s.storms++;
  const uniq = [...new Set(dark)];
  const darkNames = uniq.filter(k => s.map[k].explored).map(k => roomName(s, k));
  const darkCells = uniq.filter(k => !s.map[k].explored).length;
  if (darkCells) darkNames.push(`${darkCells} 格還沒探索的光`);
  s.lastStorm = { n:s.storms, dark:darkNames, broken, revealed:revealedNow.map(id => nameOf(s, id)) };
  s.stormActs = {};
  s.locks = {};
  s.searched = {};
  s.seats.forEach(p => { s.status[p.id].cursed = false; s.status[p.id].lockUsed = false; });

  log(s, darkNames.length ? `第 ${s.storms} 次雷雨過去。${darkNames.map(n => `「${n}」`).join('、')}暗了下來。` : `第 ${s.storms} 次雷雨過去，所有的燈都還亮著。`, 'night');
  revealedNow.forEach(id => log(s, `${nameOf(s,id)} 失去了理智，露出了怪物的真面目！`, 'reveal'));
  broken.forEach(id => { const se = SEALS.find(x => x.id === id); log(s, `${se.icon} ${se.name}解開了。`, 'seal-break'); });

  if (SEALS.every(se => s.seals[se.id])) return startBattle(s);
  if (s.mode === 'roles'){
    const holders = s.seats.filter(p => isHumanSide(s, p.id) && s.priv[p.id].candle);
    if (!holders.length) return endGame(s, 'monsters', '最後一個燭台也熄滅了。黑暗吞沒了整座地下室，怪物獲勝。');
  }
  if (s.storms >= s.maxStorms) return endGame(s, 'monsters', `第 ${s.storms} 次雷雨過去，封印還在。沒有人逃出去。`);
  s.round++;
  startRound(s);
}

// 怪物熄燈時，房間裡的人會遇到事件
function darkEvents(s, key, actor){
  const inside = s.seats.filter(p => s.pos[p.id] === key && p.id !== actor).map(p => p.id);
  inside.forEach(id => {
    const nm = nameOf(s, id), r = d(s, 6), ev = DARK_EVENTS[r - 1];
    log(s, `「${roomName(s, key)}」的燈被熄滅時，${nm} 就在裡面。擲出 ${DICE[r-1]}：${ev.t}`, 'search');
    if (ev.fx === 'trip'){ const n = d(s, 4); hurt(s, id, n); log(s, `${nm} 受到 ${n} 點傷害。`); }
    else if (ev.fx === 'glimpse'){
      const others = s.seats.map(p => p.id).filter(x => x !== id && x !== actor);
      const decoy = others.length ? pick(s, others) : null;
      const pair = shuffle(s, [actor, decoy].filter(Boolean)).map(x => nameOf(s, x));
      note(s, id, pair.length > 1 ? `你瞥見的身影，是 ${pair[0]} 或 ${pair[1]} 其中一人。` : `你瞥見的身影是 ${pair[0]}。`);
    }
    else applyFx(s, id, ev.fx);
  });
}

// ---------- 中庭決戰 ----------
function startBattle(s){
  s.phase = 'battle';
  const rec = recovery(s);
  const humans = s.seats.filter(p => isHumanSide(s, p.id)).map(p => p.id);
  const sideIds = s.seats.filter(p => isMonsterSide(s, p.id)).map(p => p.id);
  const lead = s.mode === 'roles' ? (s.seats.map(p => p.id).find(id => roleOf(s, id) === 'monster') || null) : null;
  const stolen = Object.values(s.monster).reduce((a, m) => a + m.stolen, 0);
  const hp = RULES.bossHp + stolen * RULES.bossHpPerCandle + Math.max(0, humans.length - 3) * RULES.bossHpPerExtra;
  s.battle = {
    round:1, bossHp:hp, bossMax:hp, cd:{ sweep:0, whisper:0 }, acts:{}, rec,
    controller: lead, humans, minions: sideIds.filter(id => id !== lead), down:{}, mad:{}, lastDef:null, stolen,
  };
  humans.forEach(id => {
    const st = s.stats[id], g = gearTotal(s, id);
    st.maxHp = RULES.baseHp + rec * 2;
    st.hp = Math.min(st.maxHp, st.hp + rec * 2);
    st.maxSan = RULES.baseSan + g.san;
    st.san = Math.min(st.maxSan, st.san + g.san);
  });
  log(s, '三道封印全部解開。地面震動，有什麼東西從深淵爬了上來，出現在中庭。', 'seal-break');
  log(s, `封印在深淵、沒有理智的怪物現身了。HP ${hp}${stolen ? `（被偷走的 ${stolen} 個燭台讓牠更強了）` : ''}。`, 'reveal');
  log(s, '身份揭曉：' + s.seats.map(p => `${p.name}是${ROLE_INFO[roleOf(s, p.id)].name}`).join('、') + '。', 'reveal');
  if (lead) log(s, `${nameOf(s, lead)} 操控著怪物。`);
  if (rec) log(s, `點亮的房間讓大家恢復了力量（恢復等級 ${rec}）：HP 上限 +${rec * 2}，命中 +${rec}。`);
  // 見到怪物的理智檢定：原版 SAN 1D3/1D20
  humans.forEach(id => {
    const st = s.stats[id], r = d(s, 100), ok = r <= st.san;
    const loss = ok ? d(s, 3) : d(s, 20);
    st.san = Math.max(0, st.san - loss);
    log(s, `${nameOf(s,id)} 理智檢定 1D100＝${r}（${ok ? '成功' : '失敗'}），理智 -${loss}。`);
    if (st.san <= 0){ s.battle.mad[id] = true; log(s, `${nameOf(s,id)} 陷入瘋狂！`); }
  });
  setDeadline(s, s.settings.battleSec);
  checkBattleEnd(s);
}

function battleActors(s){
  const b = s.battle;
  const list = b.humans.filter(id => !b.down[id] && !b.mad[id]);
  if (b.controller) list.push(b.controller);
  b.minions.forEach(id => list.push(id));
  return list;
}
function livingHumans(s){ const b = s.battle; return b.humans.filter(id => !b.down[id]); }

function resolveBattle(s){
  const b = s.battle;
  const rec = b.rec;
  const def = d(s, 10) + RULES.bossDefBase;
  b.lastDef = def;
  log(s, `── 第 ${b.round} 回合，怪物的防禦 1D10+${RULES.bossDefBase}＝${def} ──`, 'battle');

  // 守護：被守護的人受到攻擊時改由守護者承受，守護者護甲 +2
  const guardOf = {};
  for (const id of b.humans){
    const a = b.acts[id];
    if (!b.down[id] && !b.mad[id] && a && a.act === 'guard' && a.target && a.target !== id && !b.down[a.target]) guardOf[a.target] = id;
  }
  const armorOf = id => gearTotal(s, id).armor;
  const damageHuman = (target, dmg, src) => {
    let who = target, bonus = 0;
    if (guardOf[target]){ who = guardOf[target]; bonus = 2; }
    const real = Math.max(0, dmg - armorOf(who) - bonus);
    s.stats[who].hp -= real;
    log(s, `${src}${who !== target ? `，${nameOf(s,who)} 擋在 ${nameOf(s,target)} 前面` : ''}，${nameOf(s,who)} 受到 ${real} 點傷害。`, 'battle');
  };

  // 人類行動
  for (const id of b.humans){
    if (b.down[id]) continue;
    const g = gearTotal(s, id), nm = nameOf(s, id);
    if (b.mad[id]){
      const others = livingHumans(s).filter(x => x !== id);
      const t = others.length && d(s, 2) === 1 ? pick(s, others) : 'boss';
      const dmg = d(s, 6);
      if (t === 'boss'){ b.bossHp -= dmg; log(s, `${nm} 瘋狂地撲向怪物，造成 ${dmg} 點傷害。`, 'battle'); }
      else { s.stats[t].hp -= dmg; log(s, `${nm} 瘋狂地攻擊了 ${nameOf(s,t)}，造成 ${dmg} 點傷害！`, 'battle'); }
      continue;
    }
    const a = b.acts[id] || { act:'attack' };
    if (a.act === 'attack'){
      const r = d(s, 20), bonus = g.atk + rec, total = r + bonus;
      const rollTxt = `1D20＝${r}${bonus ? `+${bonus}＝${total}` : ''}`;
      if (r === 20 || total >= def){
        const dmg = d(s, 6) + g.dmg + (r === 20 ? d(s, 6) : 0);
        b.bossHp -= dmg;
        log(s, `${nm} 攻擊：${rollTxt}，${r === 20 ? '大成功！' : '命中，'}造成 ${dmg} 點傷害。`, 'battle');
      } else log(s, `${nm} 攻擊：${rollTxt}，沒有命中。`, 'battle');
    } else if (a.act === 'fire'){
      if (s.priv[id].candle){
        s.priv[id].candle = false;
        const dmg = dn(s, 2, 6) + RULES.fireBonus;
        b.bossHp -= dmg;
        log(s, `${nm} 把燭台擲向怪物，火光炸開！2D6${RULES.fireBonus ? '+' + RULES.fireBonus : ''}＝${dmg} 點傷害。`, 'battle');
      } else log(s, `${nm} 想用燭火，卻發現手上沒有燭台。`, 'battle');
    } else if (a.act === 'calm'){
      const n = d(s, 10), st = s.stats[id];
      st.san = Math.min(st.maxSan, st.san + n);
      log(s, `${nm} 深呼吸穩住心神，理智 +${n}。`, 'battle');
    } else if (a.act === 'guard'){
      log(s, `${nm} 守在 ${nameOf(s, a.target)} 身邊。`, 'battle');
    }
  }

  // 怪物行動（操控的玩家沒選，或選了冷卻中的招式，就交給程式）
  if (b.bossHp > 0){
    const targets = livingHumans(s);
    let a = b.controller ? b.acts[b.controller] : null;
    if (!a || (a.act === 'sweep' && b.cd.sweep) || (a.act === 'whisper' && b.cd.whisper)) a = aiBoss(s);
    if (a.act === 'bite' && (!a.target || b.down[a.target])) a = { act:'bite', target: pick(s, targets) };
    if (a.act === 'bite' && targets.length){
      const t = a.target, r = d(s, 20) + 4, need = 10 + armorOf(guardOf[t] || t);
      if (r >= need) damageHuman(t, dn(s, RULES.bossBite, 6), `怪物撕咬 ${nameOf(s,t)}（1D20+4＝${r}）`);
      else log(s, `怪物撲向 ${nameOf(s,t)}（1D20+4＝${r}），被躲開了。`, 'battle');
    } else if (a.act === 'sweep'){
      log(s, '怪物橫掃整個中庭！', 'battle');
      targets.forEach(t => {
        const dmg = Math.max(0, d(s, 6) + RULES.sweepBonus - armorOf(t));
        s.stats[t].hp -= dmg;
        log(s, `${nameOf(s,t)} 受到 ${dmg} 點傷害。`, 'battle');
      });
      b.cd.sweep = RULES.sweepCooldown + 1;
    } else if (a.act === 'whisper'){
      log(s, '怪物發出低語，聲音直接鑽進每個人的腦袋。', 'battle');
      targets.forEach(t => {
        const st = s.stats[t], r = d(s, 100), ok = r <= st.san;
        const loss = ok ? d(s, 3) : d(s, 10);
        st.san = Math.max(0, st.san - loss);
        log(s, `${nameOf(s,t)} 理智檢定 1D100＝${r}（${ok ? '成功' : '失敗'}），理智 -${loss}。`, 'battle');
      });
      b.cd.whisper = RULES.whisperCooldown + 1;
    }
  }

  // 甩尾：不管選了什麼招式，怪物每回合都會隨機甩尾
  for (let i = 0; i < RULES.bossTail && b.bossHp > 0; i++){
    const targets = livingHumans(s); if (!targets.length) break;
    const t = pick(s, targets), r = d(s, 20) + 2;
    if (r >= 10 + armorOf(guardOf[t] || t)) damageHuman(t, d(s, 6), `怪物甩尾掃向 ${nameOf(s,t)}（1D20+2＝${r}）`);
    else log(s, `怪物甩尾掃向 ${nameOf(s,t)}，被躲開了。`, 'battle');
  }

  // 爪牙（第二隻怪物、魔人）
  for (const id of b.minions){
    const targets = livingHumans(s); if (!targets.length) break;
    const a = b.acts[id] || { act:'claw' };
    const t = a.target && !b.down[a.target] ? a.target : pick(s, targets);
    if (a.act === 'hex'){
      const n = d(s, 6); s.stats[t].san = Math.max(0, s.stats[t].san - n);
      log(s, `${nameOf(s,id)} 對 ${nameOf(s,t)} 低聲詛咒，理智 -${n}。`, 'battle');
    } else {
      const r = d(s, 20) + 2;
      if (r >= 10 + armorOf(guardOf[t] || t)) damageHuman(t, d(s, 4), `${nameOf(s,id)} 抓傷 ${nameOf(s,t)}（1D20+2＝${r}）`);
      else log(s, `${nameOf(s,id)} 撲向 ${nameOf(s,t)}，沒抓到。`, 'battle');
    }
  }

  // 結算倒下和瘋狂
  b.humans.forEach(id => {
    if (b.down[id]) return;
    if (s.stats[id].hp <= 0){ s.stats[id].hp = 0; b.down[id] = true; log(s, `${nameOf(s,id)} 倒下了。`, 'battle'); }
    else if (s.stats[id].san <= 0 && !b.mad[id]){ b.mad[id] = true; log(s, `${nameOf(s,id)} 陷入瘋狂！`, 'battle'); }
  });
  b.cd.sweep = Math.max(0, b.cd.sweep - 1);
  b.cd.whisper = Math.max(0, b.cd.whisper - 1);
  b.acts = {};
  if (checkBattleEnd(s)) return;
  b.round++;
  setDeadline(s, s.settings.battleSec);
}

function aiBoss(s){
  const b = s.battle, targets = livingHumans(s);
  const r = rnd(s);
  if (!b.cd.sweep && targets.length >= 3 && r < 0.35) return { act:'sweep' };
  if (!b.cd.whisper && r < 0.55) return { act:'whisper' };
  return { act:'bite', target: pick(s, targets) };
}

function checkBattleEnd(s){
  const b = s.battle;
  if (b.bossHp <= 0){
    b.bossHp = 0;
    endGame(s, 'humans', '怪物發出最後一聲嘶吼，倒在中庭裡。大家終於找到了出口。人類陣營獲勝。', 'seal-break');
    return true;
  }
  if (!b.humans.some(id => !b.down[id] && !b.mad[id])){
    endGame(s, 'monsters', '中庭裡再也沒有人站著。怪物獲勝。');
    return true;
  }
  return false;
}

function endGame(s, winner, text, kind = ''){
  s.winner = winner; s.phase = 'over'; s.deadline = null;
  log(s, text, kind);
  if (!s.battle) log(s, '身份揭曉：' + s.seats.map(p => `${p.name}是${ROLE_INFO[roleOf(s, p.id)].name}`).join('、') + '。', 'reveal');
  // 結局
  let cause;
  if (s.battle) cause = winner === 'humans' ? 'escape' : 'wiped';
  else cause = s.seats.some(p => isHumanSide(s, p.id) && s.priv[p.id].candle) ? 'storms' : 'candles';
  const E = ENDINGS[cause];
  const epilogue = s.seats.map(p => {
    const id = p.id, r = roleOf(s, id), b = s.battle;
    if (cause !== 'escape') return null;
    if (r === 'monster') return `${p.name} 的身影沉回了深淵。`;
    if (r === 'fallen') return `${p.name} 留在了黑暗裡，沒有跟上來。`;
    if (b && b.down[id]) return `${p.name} 被同伴背著，離開了宅邸。`;
    if (b && b.mad[id]) return `${p.name} 一路喃喃自語，被大家拉著走出大門。`;
    const gear = s.stats[id].gear.map(g => GEAR[g].name);
    return `${p.name} 走出了宅邸${gear.length ? `，身上帶著${gear.join('、')}` : ''}。`;
  }).filter(Boolean);
  const stolen = Object.values(s.monster).reduce((a, m) => a + m.stolen, 0);
  const stats = [
    `經過 ${s.round} 輪、${s.storms} 次雷雨`,
    `最多同時點亮 ${s.maxLit} 間房`,
    `解開 ${SEALS.filter(se => s.seals[se.id]).length} 道封印`,
    s.mode === 'roles' ? `怪物偷走 ${stolen} 個燭台` : null,
  ].filter(Boolean);
  s.ending = { cause, title:E.title, lines:E.lines.slice(), epilogue, stats };
  log(s, `【結局：${E.title}】`, 'ending');
  E.lines.forEach(t => log(s, t, 'ending'));
  epilogue.forEach(t => log(s, t, 'ending'));
}

// 讀檔用：把存檔裡的舊座位 id 換成現在房間裡的新 id（依名字對應）
function remapSeats(state, map){
  let json = JSON.stringify(state);
  Object.entries(map).forEach(([oldId, newId]) => { if (oldId !== newId) json = json.split(JSON.stringify(oldId).slice(1, -1)).join(newId); });
  return JSON.parse(json);
}

// ---------- 動作 ----------
function reduce(s, a){
  const seated = !!s.roles[a.seat];
  switch (a.type){
    case 'ready': {
      if (s.phase !== 'reveal') return '現在不是確認身份的時間';
      if (!seated) return '找不到這個座位';
      s.ready[a.seat] = true;
      if (s.seats.every(p => s.ready[p.id])) startRound(s);
      return null;
    }
    case 'move': {
      const e = dayCheck(s, a); if (e) return e;
      const c = s.map[a.to];
      if (!c || !isAdj(s.pos[a.seat], a.to)) return '只能走到相鄰的房間';
      if (!c.explored) return '那裡還沒探索過，用「探索」走進去';
      if (s.locks[s.pos[a.seat]]) return '這間房被鎖上了，雷雨結束前出不去';
      if (s.locks[a.to]) return '那間房被鎖上了，雷雨結束前進不去';
      if (!c.lit && !s.priv[a.seat].candle && roleOf(s, a.seat) !== 'monster') return '那裡一片漆黑，沒有燭台進不去';
      s.pos[a.seat] = a.to; s.ap--;
      log(s, `${nameOf(s,a.seat)} 走進「${roomName(s,a.to)}」。`);
      afterAp(s);
      return null;
    }
    case 'light': {
      const here = s.pos[a.seat];
      if (!a.target || !(a.target === here || isAdj(here, a.target))) return '只能點亮所在房間或相鄰的一格';
      const c = s.map[a.target];
      if (c && c.lit) return '那裡已經亮著了';
      const cost = c && c.wet ? RULES.wetCost : 1;
      const e = dayCheck(s, a, cost); if (e) return e;
      const st = s.status[a.seat];
      let source;
      if (roleOf(s, a.seat) === 'monster') source = 'fake';
      else if (s.priv[a.seat].candle) source = 'candle';
      else if (st.matches > 0) source = 'match';
      else return '你沒有燭台，也沒有火柴';
      if (source === 'match') st.matches--;
      if (!c) s.map[a.target] = { card:null, lit:true, explored:false };
      else { c.lit = true; c.wet = false; }
      if (source === 'fake') s.fakes[a.target] = true; else delete s.fakes[a.target];
      s.ap -= cost;
      updateMaxLit(s);
      log(s, `${nameOf(s,a.seat)} ${source === 'match' ? '劃了一根火柴，' : ''}點亮了${c && c.explored ? `「${roomName(s,a.target)}」` : '一格黑暗'}。`);
      afterAp(s);
      return null;
    }
    case 'explore': {
      const e = dayCheck(s, a); if (e) return e;
      const c = s.map[a.to];
      if (!c || !isAdj(s.pos[a.seat], a.to)) return '只能探索相鄰的一格';
      if (c.explored) return '那裡已經探索過了';
      if (!c.lit) return '要先點亮才能探索';
      if (s.locks[s.pos[a.seat]]) return '這間房被鎖上了，雷雨結束前出不去';
      s.ap--;
      explore(s, a.seat, a.to);
      updateMaxLit(s);
      afterAp(s);
      return null;
    }
    case 'search': {
      const e = dayCheck(s, a); if (e) return e;
      const k = s.pos[a.seat], c = s.map[k];
      if (!c.lit) return '這裡太暗了，點亮之後才能搜索';
      if (s.searched[k]) return '這個房間這段時間已經有人搜過了';
      s.searched[k] = true; s.ap--;
      const C = CARDS[c.card];
      if (C.seal && !s.sealSearched[k]){
        s.sealSearched[k] = true;
        log(s, `${nameOf(s,a.seat)} 搜索封印裝置，在底座找到了被奪走的東西。`, 'search');
        gainGear(s, a.seat, 'own');
      } else if (c.card === 'candle_store'){
        log(s, `${nameOf(s,a.seat)} 搜索「${C.name}」，架子上還剩下能用的東西。`, 'search');
        applyFx(s, a.seat, 'candle');
      } else {
        const r = d(s, 6), ev = SEARCH[C.table][r - 1];
        log(s, `${nameOf(s,a.seat)} 搜索「${C.name}」。擲出 ${DICE[r-1]}：${ev.t}`, 'search');
        applyFx(s, a.seat, ev.fx);
      }
      afterAp(s);
      return null;
    }
    case 'lock': {
      const e = dayCheck(s, a, 0); if (e) return e;
      const st = s.status[a.seat];
      if (st.lockUsed) return '這段時間你已經用過鑰匙了';
      const c = s.map[a.target];
      if (!c || !c.explored) return '只能鎖已經探索過的房間';
      if (s.locks[a.target]) return '這間已經上鎖了';
      if (a.target === s.pos[a.seat]) return '不能鎖自己所在的房間';
      s.locks[a.target] = a.seat; st.lockUsed = true;
      const inside = s.seats.filter(p => s.pos[p.id] === a.target).map(p => p.name);
      log(s, `${nameOf(s,a.seat)} 用鑰匙鎖上了「${roomName(s,a.target)}」。${inside.length ? `${inside.join('、')} 在下次雷雨結束前都出不來。` : '下次雷雨結束前誰都進不去。'}`);
      return null;
    }
    case 'endTurn': {
      const e = dayCheck(s, a, 0); if (e) return e;
      endTurn(s);
      return null;
    }
    case 'stormAction': {
      if (s.phase !== 'storm') return '現在不是雷雨';
      if (!seated) return '找不到這個座位';
      if (s.stormActs[a.seat]) return '你這次雷雨已經行動過了';
      const r = roleOf(s, a.seat);
      let kind = a.kind || 'none';
      if (s.status[a.seat].cursed || r === 'human') kind = 'none';
      if (r === 'witch' && kind !== 'none'){
        if (kind !== 'eye') return '巫師只能看見真實';
        if (!s.priv[a.seat].candle) return '你沒有燭台，看不見真實';
        if (s.priv[a.seat].eyeUsed) return '你已經用過這個能力了';
        if (!a.target || a.target === a.seat || !s.roles[a.target]) return '請選一位其他玩家';
      }
      if (r === 'fallen' && !['none','snuff'].includes(kind)) return '魔人只能熄燈';
      if (r === 'monster' && !['none','snuff','steal','haunt'].includes(kind)) return '不支援這個作祟';
      if (kind === 'snuff'){
        const here = s.pos[a.seat];
        const ok = s.locks[here] ? (a.target === here && s.map[here].lit && !sealLocked(s, here) && here !== '0,0') : snuffTargets(s).includes(a.target);
        if (!ok) return s.locks[here] ? '你被鎖在房間裡，只能熄這一間的燈' : '那盞燈熄不了（沒亮、上了鎖，或是封印房）';
      }
      if ((kind === 'steal' || kind === 'haunt') && (!a.target || a.target === a.seat || !s.roles[a.target])) return '請選一位其他玩家';
      s.stormActs[a.seat] = { kind, target: kind === 'none' ? null : a.target };
      if (s.seats.every(p => s.stormActs[p.id])) resolveStorm(s);
      return null;
    }
    case 'battleAction': {
      if (s.phase !== 'battle') return '現在不是決戰';
      const b = s.battle;
      if (!battleActors(s).includes(a.seat)) return '你現在不能行動';
      if (b.acts[a.seat]) return '這回合你已經行動過了';
      const act = a.act;
      if (b.humans.includes(a.seat)){
        if (!['attack','guard','fire','calm'].includes(act)) return '不支援這個行動';
        if (act === 'fire' && !s.priv[a.seat].candle) return '你沒有燭台';
        if (act === 'guard' && (!a.target || a.target === a.seat || !b.humans.includes(a.target) || b.down[a.target])) return '請選一位還站著的隊友';
      } else if (a.seat === b.controller){
        if (!['bite','sweep','whisper'].includes(act)) return '不支援這個行動';
        if (act === 'sweep' && b.cd.sweep) return '橫掃還在冷卻';
        if (act === 'whisper' && b.cd.whisper) return '低語還在冷卻';
        if (act === 'bite' && (!a.target || !b.humans.includes(a.target) || b.down[a.target])) return '請選一位還站著的人';
      } else {
        if (!['claw','hex'].includes(act)) return '不支援這個行動';
        if (!a.target || !b.humans.includes(a.target) || b.down[a.target]) return '請選一位還站著的人';
      }
      b.acts[a.seat] = { act, target: a.target || null };
      if (battleActors(s).every(id => b.acts[id])) resolveBattle(s);
      return null;
    }
    case 'timeout': {
      // 任何人都能送，但只有伺服器時間真的過了期限才會生效
      if (!seated) return '找不到這個座位';
      if (!s.deadline || s.now < s.deadline) return '還沒到時間';
      if (s.phase === 'reveal'){ s.seats.forEach(p => { s.ready[p.id] = true; }); startRound(s); return null; }
      if (s.phase === 'day'){ log(s, `${nameOf(s, cur(s))} 的時間到了。`); endTurn(s); return null; }
      if (s.phase === 'storm'){
        s.seats.forEach(p => { if (!s.stormActs[p.id]) s.stormActs[p.id] = { kind:'none', target:null }; });
        resolveStorm(s);
        return null;
      }
      if (s.phase === 'battle'){ resolveBattle(s); return null; }   // 沒選的人：人類自動攻擊，怪物交給程式
      return '現在沒有倒數';
    }
  }
  return '未知的動作';
}

// now：線上版由伺服器傳入，前端的時間一律不採信
function applyAction(state, action, now){
  if (state.phase === 'over') return { error:'遊戲已經結束' };
  const s = JSON.parse(JSON.stringify(state));
  s.now = now || Date.now();
  s.rev = (s.rev || 0) + 1;
  const error = reduce(s, action);
  return error ? { error } : { state: s };
}

// 給某位玩家看的畫面資料：拿掉牌庫、別人的身份與燭台、假燈、亂數
function viewFor(s, viewer){
  const v = JSON.parse(JSON.stringify(s));
  ['deck','roles','fallen','priv','rng','stormActs','monster','fakes'].forEach(k => delete v[k]);
  v.deckCount = s.deck.length;
  v.stormSubmitted = Object.keys(s.stormActs || {});
  v.recovery = recovery(s);
  if (v.battle){ v.battleSubmitted = Object.keys(s.battle.acts || {}); delete v.battle.acts; }
  const open = s.phase === 'battle' || s.phase === 'over';
  v.revealed = {};
  Object.keys(s.revealed || {}).forEach(id => { v.revealed[id] = 'monster'; });
  if (open){ v.roles = {}; s.seats.forEach(p => { v.roles[p.id] = roleOf(s, p.id); }); }
  if (s.phase !== 'over') delete v.seed;
  v.me = null;
  if (viewer && s.roles[viewer]){
    const role = roleOf(s, viewer), pv = s.priv[viewer];
    const side = isMonsterSide(s, viewer);
    v.me = {
      id: viewer, role, candle: pv.candle, eyeUsed: pv.eyeUsed,
      checks: pv.checks.slice(), notes: pv.notes.slice(),
      allies: side ? s.seats.map(p => p.id).filter(id => id !== viewer && isMonsterSide(s, id)) : [],
      monster: s.monster[viewer] ? { ...s.monster[viewer] } : null,
      fakes: role === 'monster' ? Object.keys(s.fakes) : [],
      trapped: !!s.locks[s.pos[viewer]],
      snuffTargets: side && s.phase === 'storm'
        ? (s.locks[s.pos[viewer]] ? (s.map[s.pos[viewer]].lit && !sealLocked(s, s.pos[viewer]) && s.pos[viewer] !== '0,0' ? [s.pos[viewer]] : []) : snuffTargets(s))
        : [],
    };
  }
  return v;
}

// 把劇情切成適合發噗的段落，每則不超過 RULES.plurkLimit 字
function toPlurkChunks(lines, title, limit = RULES.plurkLimit){
  const budget = limit - title.length - 10;
  const bodies = []; let curr = '';
  for (let line of lines){
    while (line.length > budget){
      if (curr){ bodies.push(curr); curr = ''; }
      bodies.push(line.slice(0, budget)); line = line.slice(budget);
    }
    const next = curr ? curr + '\n' + line : line;
    if (next.length > budget){ bodies.push(curr); curr = line; } else curr = next;
  }
  if (curr) bodies.push(curr);
  return bodies.map((b, i) => `${title}（${i + 1}/${bodies.length}）\n${b}`);
}

const LampEngine = {
  RULES, SPEEDS, DIRS, CARDS, SEALS, GEAR, ROLE_INFO, ROLE_CARDS,
  createGame, applyAction, viewFor, remapSeats, ENDINGS, RECOVERY_TEXT,
  adj, isAdj, step, cur, nameOf, roomName, sealStatus, litCount, darkRoomCount, gearTotal, recovery, snuffTargets,
  toPlurkChunks,
};
if (typeof module !== 'undefined' && module.exports) module.exports = LampEngine;
else root.LampEngine = LampEngine;
})(typeof window !== 'undefined' ? window : globalThis);
