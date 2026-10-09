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
  maxStormsFor: (n, mode) => mode === 'coop' ? ({ 3:6, 4:5, 5:4, 6:4, 7:4, 8:4 }[n] || 4) : ({ 5:7, 6:6, 7:5, 8:9 }[n] || 7),
  sealNeed: 2,           // 每道封印需要幾間同類房間亮著（不含封印房本身）
  // 人少時改成 1 間：模擬顯示人少輸掉的局，幾乎都是三間封印房都找到了、卻撐不住同類房間的燈
  sealNeedFor: n => n <= 5 ? 1 : 2,
  // 探索擲 1D20 達到這個數字就是封印房。人少時探索次數少，所以門檻低一點：
  // 5 人以下 17（20%）、6 人 18（15%）、7 人以上 19（10%，原版）
  sealRollFor: n => n <= 5 ? 17 : n === 6 ? 18 : 19,
  // 連續這麼多次沒遇到封印房，下一次保證是封印房（人少時保底更快到）
  sealPityFor: n => n <= 5 ? 5 : n === 6 ? 6 : 8,
  // 被怪物熄掉的房間燈芯受潮：要點兩次才會亮（第一次只是把燈芯烘乾），每次 1 點行動點
  revealSec: 45,         // 看身份卡的時間
  monsterSanity: 3,      // 怪物的理智上限；雷雨時沒作祟就 -1，歸零身份公開
  hauntFall: 11,         // 作祟巫師時擲 1D20，達到這個數字巫師墮落成魔人
  searchLimit: 2,        // 每間房整局最多能搜幾次（每次雷雨之間只能搜一次），搜完就「翻遍了」，逼大家往外探索
  wardUses: 2, 
  sealWardUses: 1,       // 巫師的封印結界：整局可以守護封印房一次，那次雷雨它不會熄滅
            // 巫師的守護結界整局可以用幾次（不消耗燭台）
  hauntFallFrenzy: 8,    // 理智崩潰（狂暴）的怪物作祟巫師時，門檻降到這個數字
  bashDC: 15,            // 被鎖住的怪物雷雨時撞門：1D20 ≥ 這個數字就撞開
  bashDCFrenzy: 11,      // 狂暴的怪物撞門門檻
  // 燭光經驗（全隊共用）：整局大家一共點亮過幾盞燈。點越多，搜索時越容易在燭光下多看到一件裝備
  lightBonusStep: 10,    // 全隊每點亮這麼多盞，搜索時額外找到裝備的機會 +1/6
  lightBonusMax: 2,      // 最多 +2/6
  attackDC: 12,          // 白天攻擊曝光的怪物：1D20 + 命中加成 ≥ 這個數字就命中
  stunAt: 10,            // 怪物在屋內累積受到這麼多傷害，就會被壓制（下次雷雨不能作祟、下回合不能行動）
  beastDropAt: 2,        // 被災獸打傷時再擲 1D20，小於等於這個數字才會弄掉燭台（原本 5，約 25%；現在 10%）
  beastDC: 12,           // 遭遇災獸：1D20 + 命中加成 ≥ 這個數字就擊退
  baseHp: 20,
  baseSan: 35,
  recoveryStep: 5,       // 同時點亮的房間每多這麼多間，恢復等級 +1（最多 3）
  bossHp: 50,            // 原版設定：HP 50
  bossDefBase: 8,        // 原版設定：DEF 1D10 + 護甲 8
  bossHpPerCandle: 5,    // 怪物每偷走一個燭台，頭目 HP +5
  bossHpPerExtra: 32,    // 人類每多於 3 人，頭目 HP +32
  bossHpPerGear: 6,      // 怪物陣營每件裝備：頭目 HP +6（武器另外 +1 傷害、護具另外 +1 防禦）
  bossHpPerMatch: 3,     // 怪物陣營每根火柴：頭目 HP +3
  minionEvery: 1,        // 爪牙每幾回合出手一次（1＝每回合）
  fallenBossHpCut: 12,   // 每個魔人讓頭目 HP 另外 -12（平衡用：魔人會讓人類少一個戰力、多一個敵人）
  bossHpExtraCap: 65,    // 怪物陣營有爪牙時（第二隻怪物或魔人），人數加成最多加到這麼多（8 人局的平衡點）
  bossBite: 3,           // 撕咬傷害：幾顆 D6
  fireBonus: 0,          // 燭火傷害 2D6 + 這個數字
  bossTail: 1,          // 怪物每回合額外的甩尾攻擊次數（隨機目標，1D6）
  sweepBonus: 2,         // 橫掃傷害 1D6 + 這個數字
  sweepCooldown: 2,
  whisperCooldown: 2,
  potionDie: 10,         // 找到裝備時擲 1D(這個數字)，擲出 1 就變成恢復藥水（跟裝備同一個池子，機率很低）
  potionHeal: 5,         // 恢復藥水回復的 HP
  sanDownDie: 10,        // 探索時嚇到：理智 -1D(這個數字)
  whisperFail: 20,       // 怪物低語檢定失敗：理智 -1D(這個數字)
  chatMax: 200,
  plurkLimit: 300,
  monstersFor: n => n >= 8 ? 2 : 1,
  // 主角色（非副角色）至少要這麼多人，才抽得出怪物和巫師
  mainNeeded: n => (n >= 8 ? 2 : 1) + 1 + 1,   // 7 人兩隻怪物時人類勝率掉到三成以下，所以 8 人才兩隻
  minPlayersFor: mode => mode === 'coop' ? 3 : 5,
};

// 房主可選的速度檔位（秒）
const SPEEDS = {
  untimed:  { label:'不限時',    turnSec:0,   stormSec:0,  battleSec:0, untimed:true },
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
  // 擴充房間：比例和原本一樣（作物 : 墓園 : 月光 : 一般 ≈ 4 : 5 : 4 : 6），人多時比較不會翻到重複的「無名的房間」
  corn_maze:      { name:'玉米迷宮',     tag:'作物', table:'crop' },
  cider_cellar:   { name:'蘋果酒窖',     tag:'作物', table:'crop' },
  hay_loft:       { name:'乾草閣樓',     tag:'作物', table:'crop' },
  caramel_oven:   { name:'焦糖烤爐間',   tag:'作物', table:'crop' },
  gourd_trellis:  { name:'葫蘆藤架',     tag:'作物', table:'crop' },
  ossuary:        { name:'地下納骨堂',   tag:'墓園', table:'grave' },
  hearse_house:   { name:'送葬馬車房',   tag:'墓園', table:'grave' },
  stone_shop:     { name:'墓碑工坊',     tag:'墓園', table:'grave' },
  wake_hall:      { name:'守靈廳',       tag:'墓園', table:'grave' },
  dead_tree_path: { name:'枯樹墓道',     tag:'墓園', table:'grave' },
  crow_chapel:    { name:'烏鴉禮拜堂',   tag:'墓園', table:'grave' },
  star_deck:      { name:'觀星台',       tag:'月光', table:'moon' },
  howl_terrace:   { name:'狼嚎露台',     tag:'月光', table:'moon' },
  mercury_bath:   { name:'水銀浴室',     tag:'月光', table:'moon' },
  bird_cage_room: { name:'夜鶯鳥籠間',   tag:'月光', table:'moon' },
  moon_corridor:  { name:'望月走廊',     tag:'月光', table:'moon' },
  toy_room:       { name:'舊玩具房',     tag:null,   table:'common' },
  laundry:        { name:'洗衣間',       tag:null,   table:'common' },
  portrait_hall:  { name:'肖像畫廊',     tag:null,   table:'common' },
  sewing_room:    { name:'縫紉間',       tag:null,   table:'common' },
  servant_room:   { name:'傭人房',       tag:null,   table:'common' },
  coal_room:      { name:'煤炭間',       tag:null,   table:'common' },
  billiard_room:  { name:'撞球間',       tag:null,   table:'common' },
  specimen_room:  { name:'標本室',       tag:null,   table:'common' },
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
  weapon: { name:'收割者的鐮刀',   atk:1, dmg:1, armor:0, san:0 },
  armor:  { name:'稻草人的厚斗篷', atk:0, dmg:0, armor:1, san:0 },
  charm:  { name:'黑貓骨墜',       atk:0, dmg:0, armor:0, san:10 },
  own:    { name:'屬於自己的裝備', atk:1, dmg:2, armor:1, san:5 },
  potion: { name:'恢復藥水',       atk:0, dmg:0, armor:0, san:0 },
};

// 裝備在中庭決戰提供的技能：每件裝備給對應技能的使用次數
const SKILLS = {
  smash:    { gear:'weapon', name:'收割',           perItem:1, desc:'揮下鐮刀全力一擊：命中時造成 2D6＋傷害加成' },
  cover:    { gear:'armor',  name:'斗篷庇護',       perItem:1, desc:'展開斗篷擋在大家前面：這回合所有隊友受到的傷害 -2' },
  soothe:   { gear:'charm',  name:'黑貓的呼嚕',     perItem:1, desc:'骨墜裡傳來貓的呼嚕聲：全體隊友理智 +1D10，陷入瘋狂的人會清醒過來' },
  ultimate: { gear:'own',    name:'找回原本的力量', perItem:1, desc:'必中，造成 3D6 傷害' },
  potion:   { gear:'potion', name:'恢復藥水',       perItem:1, desc:'自己喝或餵給一位還站著的隊友：回復 5 HP（不超過上限），這回合不能攻擊' },
  bind:     { gear:null,     name:'結界束縛',       perItem:0, desc:'巫師把雷雨時沒用完的結界之力纏到怪物身上：這回合牠選的招式失效（甩尾照樣會來）' },
};

// 災獸：探索擲到 1–2
const BEASTS = {
  common: '老鼠大小的錐齒獸',
  crop:   '南瓜頭野狗',
  grave:  '啃骨的錐齒獸',
  moon:   '月下的大蝙蝠',
};

// 特殊事件：探索擲到 3–5，再擲 1D6 查表
// fx：none / ap 多一點行動 / chill 隨機一間房暗掉 / lightNear 相鄰的暗房亮起 / warp 傳送 / stop 回合結束 / sanDown 理智 -1D10 / heal 回復 1D6 HP
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
// 沒有燭台摸黑走進暗房時擲 1D6：危險，但也可能摸到東西
const DARK_WALK = [
  { t:'黑暗中被什麼東西絆倒，摔得不輕。', fx:'trip' },
  { t:'有隻冰冷的手擦過你的脖子。', fx:'sanDown' },
  { t:'黑暗裡有東西在呼吸，你嚇得腿軟。', fx:'skipNext' },
  { t:'你屏住呼吸摸著牆走，什麼事也沒發生。', fx:'none' },
  { t:'手指碰到一根掉在地上的火柴。', fx:'match' },
  { t:'你踢到一個小盒子，摸起來是火柴。', fx:'match' },
];

// 在暗房裡摸黑搜索時擲 1D6：比亮著的房間危險，但更容易摸到燭台
const DARK_SEARCH = [
  { t:'你伸手進櫃子，裡面有東西咬了你一口。', fx:'bite' },
  { t:'你摸到一張濕濕冷冷的臉。', fx:'sanDown' },
  { t:'你撞翻了一堆東西，嚇得不敢再動。', fx:'skipNext' },
  { t:'摸到一盒火柴。', fx:'match' },
  { t:'翻了半天，只摸到滿手灰。', fx:'none' },
  { t:'角落裡有一個燭台，還有點溫度。', fx:'candle' },
];

// 合作模式（沒有怪物偷燭台）沿用比較寬鬆的燭台機率；對抗模式用上面調低過的版本
const DARK_WALK_COOP = DARK_WALK.map((e, i) => i === 5 ? { t:'你踢到一個硬硬的東西，撿起來一摸，是燭台！', fx:'candle' } : e);
const DARK_SEARCH_COOP = DARK_SEARCH.map((e, i) => i === 4 ? { t:'抽屜裡躺著一個燭台。', fx:'candle' } : e);
function darkWalkTable(s){ return s.mode === 'coop' ? DARK_WALK_COOP : DARK_WALK; }
function darkSearchTable(s){ return s.mode === 'coop' ? DARK_SEARCH_COOP : DARK_SEARCH; }
function searchTable(s, table){
  const t = SEARCH[table];
  if (s.mode !== 'coop') return t;
  const extra = { common:{ 0:{ t:'抽屜裡有一個舊燭台，還能用。', fx:'candle' } }, crop:{ 5:{ t:'南瓜燈裡插著一個燭台。', fx:'candle' } } }[table] || {};
  return t.map((e, i) => extra[i] || e);
}

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
    { t:'抽屜裡有幾根火柴。', fx:'match' },
    { t:'衣櫃裡掛著一件稻草人穿過的厚斗篷。', fx:'armor' },
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
    { t:'南瓜燈裡的蠟燭早就燒完了。', fx:'none' },
  ],
  grave: [
    { t:'墓碑上刻著你的名字，你嚇得動彈不得。', fx:'skipNext' },
    { t:'守墓人的油燈旁留著一個燭台。', fx:'candle' },
    { t:'一隻冰冷的手抓住你的腳踝，你被詛咒了。', fx:'curse' },
    { t:'一條掛著黑貓骨頭的墜子，戴上後心情平靜許多。', fx:'charm' },
    { t:'只是一堆枯葉。', fx:'none' },
    { t:'只是一堆碎骨頭。', fx:'none' },
  ],
  moon: [
    { t:'月光照出牆上的祕密通道。', fx:'warp' },
    { t:'月光讓你精神一振。', fx:'apUp' },
    { t:'貓頭鷹一直盯著你，你不太敢動。', fx:'apDown' },
    { t:'窗台上有人留下火柴。', fx:'match' },
    { t:'雲遮住月亮，你的影子不見了。你被詛咒了。', fx:'curse' },
    { t:'鏡框後面掛著一件繡著月亮的厚斗篷。', fx:'armor' },
  ],
};

// 身份卡：勝負條件和能做的事（畫面上用條列呈現，隨時可以翻看）
const ROLE_CARDS = {
  human: {
    win:  ['三道封印全部解開，並在中庭決戰打倒怪物'],
    lose: ['人類陣營所有人都失去燭台', `第 {storms} 次雷雨過後封印還沒解完`, '中庭決戰時所有人倒下或陷入瘋狂'],
    can:  [
      '點燈：用燭台點亮所在房間或相鄰的一格（1 點）。被怪物熄過、受潮的房間要點兩次才會亮',
      '探索：走進點亮的黑暗，擲 1D20 決定遇到什麼（1 點）',
      `搜索：亮著的房間可以翻找（1 點）。同一間房要等雷雨過後才能再搜，整局最多 ${RULES.searchLimit} 次，搜完就翻遍了`,
      '鑰匙：每次雷雨之間可以鎖一間房（不能鎖自己所在的那間），鎖上後到雷雨結束前誰都不能進出（不花行動點）',
      '把可疑的人鎖在房間裡，他在雷雨時就只能對同房間出手。但同一間房不能連續兩次雷雨被鎖，而且怪物有機會撞開門',
      '落單時燭台可能被偷，跟隊友待在同一間比較安全',
      '中庭決戰時，火柴可以丟向怪物照出弱點（燒傷 1D6，這回合大家更容易命中）；找到的裝備會變成決戰技能',
      `燭光經驗（全隊共用）：大家一共點亮的燈越多，搜索時越容易多找到一件裝備（每 ${RULES.lightBonusStep} 盞多 1/6 機會，最多 ${RULES.lightBonusMax}/6）`,
      '沒有燭台也能摸黑走進暗房、在暗房裡摸黑搜索：容易出事，但也比較容易摸到燭台',
      `身份曝光的怪物跟你在同一間房時，可以攻擊牠（1 點）；累積 ${RULES.stunAt} 點傷害就能壓制牠，造成的傷害也會削弱中庭的怪物`,
    ],
  },
  witch: {
    win:  ['三道封印全部解開，並在中庭決戰打倒怪物'],
    lose: ['人類陣營所有人都失去燭台', `第 {storms} 次雷雨過後封印還沒解完`, '中庭決戰時所有人倒下或陷入瘋狂'],
    can:  [
      '白天：和普通人一樣可以點燈、探索、搜索、上鎖，也能攻擊身份曝光的怪物',
      '雷雨時，下面四件事選一件做：',
      '① 看見真實：用燭火看一個人的身份（整局 1 次，要有燭台，用完燭台燃盡，之後要再找燭台才能點燈）',
      `② 守護結界：保護一個人，他這次雷雨不會被偷燭台、不會被作祟，他所在的房間也不會被熄燈（整局 ${RULES.wardUses} 次，不能守護自己，不能連續兩次守同一人）`,
      `③ 封印結界：守護一間還沒解開的封印房，這次雷雨它不會熄滅，連雷雨的風都吹不熄（整局 ${RULES.sealWardUses} 次）`,
      '④ 什麼都不做，把力量留到最後',
      '結界擋下作祟時，只有你會知道擋下了誰的災難；大家只會看到「有一道結界擋下了什麼」。看見真實的結果也只有你知道，要不要說、跟誰說由你決定',
      '中庭決戰：守護結界和封印結界沒用完的次數，會變成「結界束縛」，每次可以讓怪物一回合選的招式失效',
      `小心：怪物會想找出你。被怪物作祟時擲 1D20，${RULES.hauntFall} 以上（狂暴的怪物是 ${RULES.hauntFallFrenzy} 以上）會墮落成魔人，改站怪物那邊；結界和能力也會一起失去`,
      '沒有燭台的時候，結界還是能用，只是看不見真實',
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
      '理智崩潰後陷入狂暴：熄燈會連相鄰一盞一起熄、偷燭台不用等對方落單、作祟更可怕；但大家也能在同一間房攻擊你，被壓制時下次雷雨不能作祟',
      '你沒有鑰匙，不能鎖門',
      '你的假燈也會算進全隊的燭光經驗；大家搜索時更容易撿到裝備，你撿到的會帶進決戰讓深淵的怪物更強',
      '被鎖在房間裡時：雷雨只能熄你所在那一間的燈、作祟同一間的人；偷不到燭台，也碰不到其他房間（包括封印房）。如果你剛好被鎖在封印房裡，還是可以熄它的燈',
      '鎖上的房間、巫師守護的人所在的房間，你都熄不了；已經解開的封印房永遠亮著',
      `被鎖住時可以撞門：擲 1D20，${RULES.bashDC} 以上（狂暴時 ${RULES.bashDCFrenzy} 以上）就撞開，照常作祟。不管成功失敗，大家都會聽到是哪間房的門在響`,
      '封印解開後，在中庭決戰親自操控深淵的怪物',
      '你和魔人撿到的裝備、火柴，到決戰時都會被深淵吞下：每件裝備讓怪物 HP +6（武器加攻擊、斗篷加防禦），每根火柴 HP +3。所以搜索房間對你也有好處',
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
      '點燈：用燭台點亮所在房間或相鄰的一格（1 點）。受潮的房間要點兩次才會亮',
      '探索：走進點亮的黑暗，擲 1D20 決定遇到什麼（1 點）',
      `搜索：同一間房要等雷雨過後才能再搜，整局最多 ${RULES.searchLimit} 次（1 點）`,
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
  witch:   { name:'巫師',   cls:'role-witch',   desc:'與普通人一起揪出潛伏在人群中的怪物。雷雨時可以用燭台的火光看見一個人的真實（用完會失去燭台），或張開結界守護一個人、守護一間封印房；沒用完的結界會在決戰時變成束縛怪物的力量。如果被怪物作祟，可能墮落成魔人。' },
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
// 目前進行到哪一步：用來確認「推進」針對的是同一個人、同一個階段
function stepKey(st){ return [st.phase, st.round, st.turnIdx, st.storms, st.battle ? st.battle.round : 0].join('|'); }
function nameOf(st, id){ const p = st.seats.find(x => x.id === id); return p ? p.name : '?'; }
function roomName(st, key){ const c = st.map[key]; return c && c.explored ? (c.label || CARDS[c.card].name) : '一片黑暗'; }
function log(s, text, kind = ''){
  s.log.push({ text, kind, ts: s.now || Date.now() });
  if (s._ev && !s._ev.closed && kind !== 'turn') s._ev.lines.push(text);
}
// 事件卡：把這個動作擲的骰子和結果整理起來，讓畫面在地圖上顯示（附擲骰動畫）
function evRoll(s, label, sides, value, bonus = 0){ if (s._ev) s._ev.rolls.push({ label, sides, value, bonus }); }
function evClose(s){ if (s._ev) s._ev.closed = true; }
function note(s, id, text){ if (s.priv[id]) s.priv[id].notes.push({ round:s.round, text }); }
// 不限時模式沒有倒數：卡住時由房主推進（force）
function setDeadline(s, sec){ s.deadline = (s.settings && s.settings.untimed) || !sec ? null : (s.now || Date.now()) + sec * 1000; }
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
  const need = RULES.sealNeedFor(st.seats.length);
  return { found:!!key, lit, tagLit, need, ready: lit && tagLit >= need };
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
    deadline:null, paused:null, seed, rng: seed | 0,
    phase:'reveal', round:1, storms:0, maxStorms:0,
    seats: seats.map(x => ({ id:x.id, name:x.name, alt: !!x.alt })),
    roles:{}, fallen:{}, priv:{}, ready:{}, monster:{}, revealed:{},
    deck:[], map:{}, fakes:{}, pos:{}, stats:{}, status:{}, locks:{}, searched:{}, searchCount:{}, sealSearched:{}, lastLocked:[],
    seals:{}, sinceSeal:0, maxLit:0, storeUsed:false, totalLights:0,
    turnOrder:[], turnIdx:0, ap:0, stormActs:{}, lastStorm:null, battle:null,
    log:[], winner:null,
  };
  s.maxStorms = RULES.maxStormsFor(s.seats.length, s.mode);
  // 副角色（一人多角的第二個角色）固定是普通人，不參加怪物、巫師的抽選
  const ids = shuffle(s, s.seats.filter(x => !x.alt).map(x => x.id)).concat(s.seats.filter(x => x.alt).map(x => x.id));
  const m = s.mode === 'coop' ? 0 : RULES.monstersFor(s.seats.length);
  ids.forEach((id, i) => {
    s.roles[id] = s.mode === 'coop' ? 'human' : i < m ? 'monster' : i === m ? 'witch' : 'human';
    s.priv[id] = { candle: s.roles[id] !== 'monster', checks:[], eyeUsed:false, notes:[], wards: s.roles[id] === 'witch' ? RULES.wardUses : 0, lastWard:null, sealWards: s.roles[id] === 'witch' ? RULES.sealWardUses : 0 };
    if (s.roles[id] === 'monster') s.monster[id] = { sanity:RULES.monsterSanity, stolen:0, wounds:0, dealt:0 };
  });
  s.deck = shuffle(s, Object.keys(CARDS).filter(k => k !== 'start' && k !== 'filler' && !CARDS[k].seal));
  SEALS.forEach(se => { s.seals[se.id] = false; });
  s.map['0,0'] = { card:'start', lit:true, explored:true };
  s.seats.forEach(p => {
    s.pos[p.id] = '0,0';
    s.stats[p.id] = { hp:RULES.baseHp, maxHp:RULES.baseHp, san:RULES.baseSan, maxSan:RULES.baseSan, gear:[] };
    s.status[p.id] = { skip:false, apMod:0, cursed:false, matches:0, lockUsed:false, stunned:false, lights:0 };
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
    if (st.skip){ log(s, `${nm} ${st.skipWhy || '還沒回過神來'}，跳過這回合。`); st.skip = false; st.skipWhy = null; s.turnIdx++; continue; }
    s.ap = Math.max(0, RULES.apPerTurn + st.apMod);
    if (st.apMod > 0) log(s, `${nm} 這回合多 ${st.apMod} 點行動點。`);
    if (st.apMod < 0) log(s, `${nm} 這回合少 ${-st.apMod} 點行動點。`);
    st.apMod = 0;
    if (s.ap === 0){ log(s, `${nm} 的行動點被扣光了，這回合沒有力氣行動。`); s.turnIdx++; continue; }
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
    s.status[id].skip = true; s.status[id].skipWhy = '受了重傷昏過去';
    log(s, `${nameOf(s,id)} 受了重傷昏過去，下回合不能行動。`);
  }
}
function loseSan(s, id, n){ const st = s.stats[id]; st.san = Math.max(1, st.san - n); }
function gainGear(s, id, g){
  // 恢復藥水跟裝備混在同一個池子：找到裝備時有很小的機率其實是藥水
  if (['weapon','armor','charm'].includes(g) && d(s, RULES.potionDie) === 1){
    s.stats[id].gear.push('potion');
    log(s, `${nameOf(s,id)} 再看一眼，手上的東西變成了一瓶「${GEAR.potion.name}」。`);
    return;
  }
  s.stats[id].gear.push(g); log(s, `${nameOf(s,id)} 得到了「${GEAR[g].name}」。`);
}

function applyFx(s, seat, fx){
  const nm = nameOf(s, seat), st = s.status[seat];
  switch (fx){
    case 'ap': s.ap++; log(s, `${nm} 多了一點行動點。`); break;
    case 'apUp': st.apMod += 1; log(s, `${nm} 下回合行動點 +1。`); break;
    case 'apDown': st.apMod -= 1; log(s, `${nm} 下回合行動點 -1。`); break;
    case 'stop': s.ap = 0; log(s, `${nm} 這回合不能再行動。`); break;
    case 'skipNext': st.skip = true; st.skipWhy = '被嚇得還沒回過神來'; log(s, `${nm} 下回合不能行動。`); break;
    case 'curse': st.cursed = true; log(s, `${nm} 被詛咒了，下次雷雨時不能使用能力。`); break;
    case 'match': st.matches++; log(s, `${nm} 拿到一根火柴，沒有燭台也能點一次燈。`); break;
    case 'candle':
      // 有沒有燭台是祕密，公開紀錄只寫「找到東西」
      log(s, `${nm} 找到一點能點火的東西。`);
      if (s.priv[seat].candle || roleOf(s, seat) === 'monster'){ st.matches++; note(s, seat, '你已經有燭台了（或用不了燭台），這個就當作一根火柴收著。'); }
      else { s.priv[seat].candle = true; note(s, seat, '你找到了一個燭台！'); }
      break;
    case 'weapon': case 'armor': case 'charm': gainGear(s, seat, fx); break;
    case 'trip': { const n = d(s, 4); log(s, `${nm} 受到 ${n} 點傷害。`); hurt(s, seat, n); break; }
    case 'bite': { const n = Math.max(1, d(s, 6) - gearTotal(s, seat).armor); log(s, `${nm} 受到 ${n} 點傷害。`); hurt(s, seat, n); break; }
    case 'heal': { const h = d(s, 6); const S = s.stats[seat]; S.hp = Math.min(S.maxHp, S.hp + h); log(s, `${nm} 回復了 ${h} 點 HP。`); break; }
    case 'sanDown': { const n = d(s, RULES.sanDownDie); loseSan(s, seat, n); log(s, `${nm} 理智 -${n}。`); break; }
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
// 1–2 災獸、3–5 特殊事件、其餘一般房間、達到 sealRollFor 門檻為封印房間（原版 19 以上；人少時門檻較低）
function explore(s, seat, key){
  const nm = nameOf(s, seat);
  const r = d(s, 20);
  evRoll(s, '探索', 20, r);
  const remaining = SEALS.filter(se => !Object.values(s.map).some(c => c.explored && c.card === se.room));
  const sealAt = RULES.sealRollFor(s.seats.length);
  const pity = r < sealAt && remaining.length && s.sinceSeal >= RULES.sealPityFor(s.seats.length);
  let card, kind;
  if ((r >= sealAt || pity) && remaining.length){ card = pick(s, remaining).room; kind = 'seal'; s.sinceSeal = 0; }
  else {
    card = s.deck.length ? s.deck.shift() : 'filler';
    kind = r <= 2 ? 'beast' : r <= 5 ? 'event' : 'room';
    if (remaining.length) s.sinceSeal++;
  }
  const c = s.map[key];
  c.card = card; c.explored = true;
  // 房間卡用完後翻到的「無名的房間」加上編號，地圖和上鎖選單才分得出是哪一間
  if (card === 'filler'){ s.fillerN = (s.fillerN || 0) + 1; c.label = `${CARDS.filler.name} ${s.fillerN}`; }
  s.pos[seat] = key;
  const C = CARDS[card];
  log(s, `${nm} 走進黑暗，擲出 1D20＝${r}${pity ? '（保底）' : ''}，發現了「${roomName(s, key)}」。`);
  if (kind === 'seal') log(s, `這裡有一座封印裝置。${SEALS.find(x => x.room === card).icon}`, 'seal-break');
  if (kind === 'beast'){
    const beast = BEASTS[C.table];
    const bonus = gearTotal(s, seat).atk + recovery(s);
    const roll = d(s, 20), total = roll + bonus;
    evRoll(s, '擊退災獸', 20, roll, bonus);
    const rollTxt = `${roll}${bonus ? `+${bonus}＝${total}` : ''}`;
    if (total >= RULES.beastDC){
      log(s, `一隻${beast}撲了上來！${nm} 擲出 ${rollTxt}，把牠趕走了。`);
    } else {
      const dmg = Math.max(1, d(s, 6) - gearTotal(s, seat).armor);
      log(s, `一隻${beast}撲了上來！${nm} 擲出 ${rollTxt}，沒能擋住，受到 ${dmg} 點傷害。`);
      hurt(s, seat, dmg);
      if (d(s, 20) <= RULES.beastDropAt && s.priv[seat].candle){
        s.priv[seat].candle = false;
        log(s, `混亂中，${nm} 手上的東西掉進了黑暗裡。`);
        note(s, seat, '你的燭台在和災獸纏鬥時掉了。');
      }
    }
  } else if (kind === 'event'){
    const er = d(s, 6), ev = EVENTS[C.table][er - 1];
    evRoll(s, '特殊事件', 6, er);
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

  // 0. 巫師的守護結界：被守護的人雷雨中不會被偷、不會被作祟，他所在的房間也不會被熄燈
  let warded = null, wardRoom = null, wardWitch = null, wardHit = false;
  for (const [id, a] of Object.entries(acts)){
    if (roleOf(s, id) !== 'witch' || a.kind !== 'ward' || !a.target) continue;
    const pv = s.priv[id];
    if (pv.wards <= 0) continue;
    pv.wards--; pv.lastWard = { storm:s.storms + 1, target:a.target };
    warded = a.target; wardRoom = s.pos[a.target]; wardWitch = id;
  }
  // 0-1. 封印結界：那次雷雨，這間封印房不會被任何東西熄滅（怪物、魔人、雷雨的風都不行）
  let sealWardRoom = null;
  for (const [id, a] of Object.entries(acts)){
    if (roleOf(s, id) !== 'witch' || a.kind !== 'sealWard' || !a.target) continue;
    const pv = s.priv[id];
    if (pv.sealWards <= 0) continue;
    pv.sealWards--;
    sealWardRoom = a.target;
    note(s, id, `你在「${roomName(s, a.target)}」張開了封印結界，這次雷雨它不會熄滅。`);
  }
  const blocked = (monsterId) => {
    wardHit = true;
    note(s, monsterId, '一道看不見的結界擋住了你。');
  };

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
  for (let [id, a] of Object.entries(acts)){
    if (!isMonsterSide(s, id)) continue;
    const isMonster = roleOf(s, id) === 'monster';
    const myRoom = s.pos[id];
    let trapped = !!s.locks[myRoom];
    const frenzy = isMonster && !!s.revealed[id];   // 理智崩潰後陷入狂暴：作祟變強
    let acted = false;
    // 撞門：被鎖住的怪物擲 1D20，撞開就照常作祟；不管成功失敗，大家都會聽到
    if (isMonster && a.kind === 'bash'){
      const r = d(s, 20), dc = frenzy ? RULES.bashDCFrenzy : RULES.bashDC;
      if (trapped && r >= dc){
        delete s.locks[myRoom];
        trapped = false;
        log(s, `雷雨中，「${roomName(s, myRoom)}」的門被撞開了！`, 'reveal');
        note(s, id, `你撞開了門（1D20＝${r}，需要 ${dc}）。`);
        a = { kind: a.then, target: a.target };
      } else {
        if (trapped) log(s, `雷雨中，「${roomName(s, myRoom)}」的門被撞得砰砰作響，但沒有打開。`, 'reveal');
        note(s, id, trapped ? `你撞門失敗了（1D20＝${r}，需要 ${dc}）。` : '門沒有鎖，你白費了力氣。');
        a = { kind:'none', target:null };
      }
    }
    if (a.kind === 'snuff' && a.target && s.map[a.target]){
      const c = s.map[a.target];
      const reachable = trapped ? a.target === myRoom : !s.locks[a.target];
      if (c.lit && reachable && (a.target === wardRoom || a.target === sealWardRoom)){ blocked(id); acted = true; }
      else if (c.lit && reachable && !sealLocked(s, a.target)){
        c.lit = false; c.wet = true; delete s.fakes[a.target];
        dark.push(a.target); acted = true;
        darkEvents(s, a.target, id);
        if (frenzy){
          // 狂暴：連相鄰的一盞燈一起撲滅
          const near = adj(a.target).filter(k => s.map[k] && s.map[k].lit && !s.locks[k] && !sealLocked(s, k) && k !== '0,0' && k !== wardRoom && k !== sealWardRoom);
          if (near.length){ const k = pick(s, near); s.map[k].lit = false; s.map[k].wet = true; delete s.fakes[k]; dark.push(k); darkEvents(s, k, id); }
        }
      } else note(s, id, trapped ? '你被鎖在房間裡，碰不到那盞燈。' : `「${roomName(s, a.target)}」被鎖上了，或已經暗了，你沒能得手。`);
    }
    if (isMonster && a.kind === 'steal' && a.target && s.priv[a.target]){
      acted = true;
      const where = s.pos[a.target];
      const alone = s.seats.filter(p => p.id !== a.target && s.pos[p.id] === where).length === 0;
      if (trapped){ note(s, id, '你被鎖在房間裡，出不去。'); acted = false; }
      else if (a.target === warded) blocked(id);
      else if (s.locks[where]) note(s, id, `${nameOf(s,a.target)} 所在的房間上了鎖，你進不去。`);
      else if (!alone && !frenzy) note(s, id, `${nameOf(s,a.target)} 身邊有人，你沒辦法下手。`);
      else if (!s.priv[a.target].candle) note(s, id, `${nameOf(s,a.target)} 身上沒有燭台。`);
      else {
        s.priv[a.target].candle = false;
        s.monster[id].stolen++;
        note(s, id, `你偷走了 ${nameOf(s,a.target)} 的燭台。`);
        note(s, a.target, '雷聲過後，你發現燭台不見了。');
      }
    }
    if (isMonster && a.kind === 'haunt' && a.target === warded && !(trapped && s.pos[a.target] !== myRoom)){
      acted = true; blocked(id);
    } else if (isMonster && a.kind === 'haunt' && a.target && s.roles[a.target] && trapped && s.pos[a.target] !== myRoom){
      note(s, id, `你被鎖在房間裡，碰不到 ${nameOf(s, a.target)}。`);
    } else if (isMonster && a.kind === 'haunt' && a.target && s.roles[a.target]){
      acted = true;
      if (roleOf(s, a.target) === 'witch'){
        const r = d(s, 20);
        if (r >= (frenzy ? RULES.hauntFallFrenzy : RULES.hauntFall)){
          s.fallen[a.target] = true;
          note(s, a.target, `怪物的低語鑽進你的腦袋（1D20＝${r}）。你墮落成了魔人，現在站在怪物那一邊。`);
          Object.keys(s.monster).forEach(mid => note(s, mid, `${nameOf(s,a.target)} 是巫師，已經墮落成魔人，成為你的同夥。`));
        } else {
          note(s, a.target, `你感覺到怪物的低語，但撐住了（1D20＝${r}）。`);
          note(s, id, `你作祟了 ${nameOf(s,a.target)}，對方撐住了。`);
        }
      } else {
        s.status[a.target].skip = true; s.status[a.target].skipWhy = '在雷雨中被作祟嚇壞了';
        if (frenzy){ const n = d(s, 6); loseSan(s, a.target, n); note(s, a.target, `狂暴的怪物在你耳邊尖叫，理智 -${n}。`); }
        note(s, id, `你作祟了 ${nameOf(s,a.target)}，對方嚇得下回合不能行動。`);
        note(s, a.target, '雷雨中有什麼東西貼在你耳邊呼吸。你嚇壞了，下回合不能行動。');
        log(s, `${nameOf(s,a.target)} 在雷雨中被什麼東西嚇壞了。`);
      }
    }
    // 理智：作祟就恢復，沒作祟就流失
    if (isMonster && !frenzy){
      const m = s.monster[id];
      m.sanity = acted ? Math.min(RULES.monsterSanity, m.sanity + 1) : m.sanity - 1;
      if (!acted) note(s, id, `你太久沒有作祟，理智剩下 ${Math.max(0, m.sanity)}。`);
      if (m.sanity <= 0 && !s.revealed[id]){ s.revealed[id] = true; revealedNow.push(id); }
    }
  }

  if (wardWitch){
    note(s, wardWitch, wardHit ? `你的結界保護了 ${nameOf(s, warded)}，擋下了一次作祟。` : `你守護了 ${nameOf(s, warded)}，這次雷雨沒有東西靠近。`);
  }
  if (wardHit) log(s, '雷雨中，有一道結界擋下了什麼。', 'night');

  // 3. 雷雨的風吹熄一盞真的燈；無身份模式再多熄一盞（代替怪物）
  const blowable = () => Object.keys(s.map).filter(k => s.map[k].lit && !s.fakes[k] && !s.locks[k] && !sealLocked(s, k) && k !== '0,0' && k !== sealWardRoom);
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
  s.lastLocked = Object.keys(s.locks);   // 同一間房不能連續兩次雷雨被鎖
  s.locks = {};
  s.searched = {};
  s.seats.forEach(p => { s.status[p.id].cursed = false; s.status[p.id].lockUsed = false; s.status[p.id].stunned = false; });

  log(s, darkNames.length ? `第 ${s.storms} 次雷雨過去。${darkNames.map(n => `「${n}」`).join('、')}暗了下來。` : `第 ${s.storms} 次雷雨過去，所有的燈都還亮著。`, 'night');
  revealedNow.forEach(id => log(s, `${nameOf(s,id)} 失去了理智，露出了怪物的真面目！牠陷入狂暴，作祟變得更猛烈，但現在也能被大家攻擊了。`, 'reveal'));
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

// 燭光經驗：點燈越多的人，搜索時越容易在燭光下多看到一件裝備
function lightBonusSearch(s, seat, fx){
  if (['weapon','armor','charm'].includes(fx)) return;   // 這次已經找到裝備了
  const lv = lightLevel(s);
  if (!lv) return;
  const r = d(s, 6);
  evRoll(s, '燭光經驗', 6, r);
  if (r <= lv){
    const g = pick(s, ['weapon','armor','charm']);
    log(s, `燭光照到了角落裡的東西（全隊燭光經驗 ${lv}，1D6＝${r}）。`, 'search');
    gainGear(s, seat, g);
  }
}
function lightLevel(s){ return Math.min(RULES.lightBonusMax, Math.floor((s.totalLights || 0) / RULES.lightBonusStep)); }

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
  const dealt = Object.values(s.monster).reduce((a, m) => a + (m.dealt || 0), 0);
  // 有魔人（墮落的巫師）時：人類少了一個戰力、多了一個爪牙，頭目 HP 另外調低以免一面倒
  const fallenCount = sideIds.filter(id => roleOf(s, id) === 'fallen').length;
  const fallenCut = fallenCount * RULES.fallenBossHpCut;
  // 怪物陣營撿到的裝備和火柴，會讓深淵的怪物更強
  const sideGear = sideIds.flatMap(id => s.stats[id].gear);
  const sideMatches = sideIds.reduce((a, id) => a + (s.status[id].matches || 0), 0);
  const gearHp = sideGear.length * RULES.bossHpPerGear + sideMatches * RULES.bossHpPerMatch;
  const bossDef = sideGear.filter(g => g === 'armor' || g === 'own').length;
  const bossDmg = sideGear.filter(g => g === 'weapon' || g === 'own').length;
  const hp = Math.max(20, RULES.bossHp + stolen * RULES.bossHpPerCandle + Math.min(sideIds.length > 1 ? RULES.bossHpExtraCap : Infinity, Math.max(0, humans.length - 3) * RULES.bossHpPerExtra) - dealt + gearHp - fallenCut);
  s.battle = {
    round:1, bossHp:hp, bossMax:hp, cd:{ sweep:0, whisper:0 }, acts:{}, rec,
    controller: lead, humans, minions: sideIds.filter(id => id !== lead), down:{}, mad:{}, lastDef:null, stolen,
    skills:{}, bossDef, bossDmg,
  };
  humans.forEach(id => {
    const sk = {};
    Object.entries(SKILLS).forEach(([k, S]) => { if (!S.gear) return; const n = s.stats[id].gear.filter(g => g === S.gear).length * S.perItem; if (n) sk[k] = n; });
    // 巫師：雷雨時沒用完的守護結界與封印結界，變成決戰的束縛次數
    if (roleOf(s, id) === 'witch'){ const n = (s.priv[id].wards || 0) + (s.priv[id].sealWards || 0); if (n) sk.bind = n; }
    s.battle.skills[id] = sk;
  });
  humans.forEach(id => {
    const st = s.stats[id], g = gearTotal(s, id);
    st.maxHp = RULES.baseHp + rec * 2;
    st.hp = Math.min(st.maxHp, st.hp + rec * 2);
    st.maxSan = RULES.baseSan + g.san;
    st.san = Math.min(st.maxSan, st.san + g.san);
  });
  log(s, '三道封印全部解開。地面震動，有什麼東西從深淵爬了上來，出現在中庭。', 'seal-break');
  log(s, `封印在深淵、沒有理智的怪物現身了。HP ${hp}${stolen ? `（被偷走的 ${stolen} 個燭台讓牠更強了）` : ''}${dealt ? `（在屋內受的 ${dealt} 點傷讓牠虛弱了一些）` : ''}。`, 'reveal');
  log(s, '身份揭曉：' + s.seats.map(p => `${p.name}是${ROLE_INFO[roleOf(s, p.id)].name}`).join('、') + '。', 'reveal');
  if (lead) log(s, `${nameOf(s, lead)} 操控著怪物。`);
  if (sideGear.length || sideMatches){
    const parts = [];
    if (sideGear.length) parts.push(`${sideGear.length} 件裝備（${[...new Set(sideGear.map(g => GEAR[g].name))].join('、')}）`);
    if (sideMatches) parts.push(`${sideMatches} 根火柴`);
    log(s, `怪物陣營帶來的 ${parts.join('和')}被深淵吞了下去：怪物 HP +${gearHp}${bossDef ? `、防禦 +${bossDef}` : ''}${bossDmg ? `、攻擊傷害 +${bossDmg}` : ''}。`, 'reveal');
  }
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
  const rawDef = d(s, 10) + RULES.bossDefBase + (b.bossDef || 0);
  // 火柴：照亮怪物的弱點，這回合大家的攻擊更容易命中（每根 -2，最多 -4）
  const matchUsers = b.humans.filter(id => !b.down[id] && !b.mad[id] && b.acts[id] && b.acts[id].act === 'match' && s.status[id].matches > 0);
  const defDown = Math.min(4, matchUsers.length * 2);
  const def = Math.max(5, rawDef - defDown);
  b.lastDef = def;
  log(s, `── 第 ${b.round} 回合，怪物的防禦 1D10+${RULES.bossDefBase + (b.bossDef || 0)}＝${rawDef}${defDown ? `，火光照出弱點 -${defDown}＝${def}` : ''} ──`, 'battle');
  // 築起防線：這回合隊友受到的傷害 -2
  const coverBy = b.humans.find(id => !b.down[id] && !b.mad[id] && b.acts[id] && b.acts[id].act === 'cover' && (b.skills[id] || {}).cover > 0);
  const coverBonus = coverBy ? 2 : 0;

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
    const real = Math.max(0, dmg - armorOf(who) - bonus - coverBonus);
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
    } else if (a.act === 'match'){
      if (s.status[id].matches > 0){
        s.status[id].matches--;
        const dmg = d(s, 6);
        b.bossHp -= dmg;
        log(s, `${nm} 劃亮火柴丟向怪物，火光照出牠的弱點！燒傷 1D6＝${dmg} 點。`, 'battle');
      } else log(s, `${nm} 摸了摸口袋，火柴已經用完了。`, 'battle');
    } else if (a.act === 'smash' && (b.skills[id] || {}).smash > 0){
      b.skills[id].smash--;
      const r = d(s, 20), bonus = g.atk + rec, total = r + bonus;
      const rollTxt = `1D20＝${r}${bonus ? `+${bonus}＝${total}` : ''}`;
      if (r === 20 || total >= def){
        const dmg = dn(s, 2, 6) + g.dmg + (r === 20 ? d(s, 6) : 0);
        b.bossHp -= dmg;
        log(s, `${nm} 重擊：${rollTxt}，${r === 20 ? '大成功！' : '命中，'}造成 ${dmg} 點傷害。`, 'battle');
      } else log(s, `${nm} 重擊：${rollTxt}，被怪物躲開了。`, 'battle');
    } else if (a.act === 'cover' && (b.skills[id] || {}).cover > 0){
      b.skills[id].cover--;
      log(s, `${nm} 築起防線，這回合大家受到的傷害 -2。`, 'battle');
    } else if (a.act === 'soothe' && (b.skills[id] || {}).soothe > 0){
      b.skills[id].soothe--;
      log(s, `${nm} 握著熟悉的飾品，輕聲安撫大家。`, 'battle');
      livingHumans(s).forEach(t => {
        const n = d(s, 10), st = s.stats[t];
        st.san = Math.min(st.maxSan, st.san + n);
        if (b.mad[t] && st.san > 0){ b.mad[t] = false; log(s, `${nameOf(s,t)} 清醒過來了（理智 +${n}）。`, 'battle'); }
        else log(s, `${nameOf(s,t)} 理智 +${n}。`, 'battle');
      });
    } else if (a.act === 'ultimate' && (b.skills[id] || {}).ultimate > 0){
      b.skills[id].ultimate--;
      const dmg = dn(s, 3, 6);
      b.bossHp -= dmg;
      log(s, `${nm} 找回了原本的力量，一擊命中！3D6＝${dmg} 點傷害。`, 'battle');
    } else if (a.act === 'potion' && (b.skills[id] || {}).potion > 0){
      b.skills[id].potion--;
      const t = a.target && !b.down[a.target] ? a.target : id, st = s.stats[t];
      const n = Math.min(RULES.potionHeal, st.maxHp - st.hp);
      st.hp += n;
      log(s, t === id ? `${nm} 喝下恢復藥水，HP +${n}。` : `${nm} 把恢復藥水餵給 ${nameOf(s, t)}，HP +${n}。`, 'battle');
    } else if (a.act === 'calm'){
      const n = d(s, 10), st = s.stats[id];
      st.san = Math.min(st.maxSan, st.san + n);
      log(s, `${nm} 深呼吸穩住心神，理智 +${n}。`, 'battle');
    } else if (a.act === 'guard'){
      log(s, `${nm} 守在 ${nameOf(s, a.target)} 身邊。`, 'battle');
    }
  }

  // 巫師的結界束縛：這回合怪物選的招式失效
  const binder = b.humans.find(id => !b.down[id] && !b.mad[id] && b.acts[id] && b.acts[id].act === 'bind' && (b.skills[id] || {}).bind > 0);
  if (binder){
    b.skills[binder].bind--;
    log(s, `${nameOf(s, binder)} 張開最後的結界，纏住了怪物！牠這回合動彈不得。`, 'battle');
  }
  // 怪物行動（操控的玩家沒選，或選了冷卻中的招式，就交給程式）
  if (b.bossHp > 0 && !binder){
    const targets = livingHumans(s);
    let a = b.controller ? b.acts[b.controller] : null;
    if (!a || (a.act === 'sweep' && b.cd.sweep) || (a.act === 'whisper' && b.cd.whisper)) a = aiBoss(s);
    if (a.act === 'bite' && (!a.target || b.down[a.target])) a = { act:'bite', target: pick(s, targets) };
    if (a.act === 'bite' && targets.length){
      const t = a.target, r = d(s, 20) + 4, need = 10 + armorOf(guardOf[t] || t);
      if (r >= need) damageHuman(t, dn(s, RULES.bossBite, 6) + (b.bossDmg || 0), `怪物撕咬 ${nameOf(s,t)}（1D20+4＝${r}）`);
      else log(s, `怪物撲向 ${nameOf(s,t)}（1D20+4＝${r}），被躲開了。`, 'battle');
    } else if (a.act === 'sweep'){
      log(s, '怪物橫掃整個中庭！', 'battle');
      targets.forEach(t => {
        const dmg = Math.max(0, d(s, 6) + RULES.sweepBonus - armorOf(t) - coverBonus);
        s.stats[t].hp -= dmg;
        log(s, `${nameOf(s,t)} 受到 ${dmg} 點傷害。`, 'battle');
      });
      b.cd.sweep = RULES.sweepCooldown + 1;
    } else if (a.act === 'whisper'){
      log(s, '怪物發出低語，聲音直接鑽進每個人的腦袋。', 'battle');
      targets.forEach(t => {
        const st = s.stats[t], r = d(s, 100), ok = r <= st.san;
        const loss = ok ? d(s, 3) : d(s, RULES.whisperFail);
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
    if (r >= 10 + armorOf(guardOf[t] || t)) damageHuman(t, d(s, 6) + (b.bossDmg || 0), `怪物甩尾掃向 ${nameOf(s,t)}（1D20+2＝${r}）`);
    else log(s, `怪物甩尾掃向 ${nameOf(s,t)}，被躲開了。`, 'battle');
  }

  // 爪牙（第二隻怪物、魔人）：每 minionEvery 回合才出手一次
  for (const id of (b.round % RULES.minionEvery === 0 ? b.minions : [])){
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
  // 暫停：凍結倒數，暫停期間除了「繼續」以外的遊戲動作都不能做（聊天不受影響）
  if (a.type === 'pause'){
    if (!seated) return '找不到這個座位';
    if (s.paused) return '已經暫停了';
    if (s.phase === 'over') return '遊戲已經結束';
    s.paused = { remaining: s.deadline ? Math.max(5000, s.deadline - s.now) : null, auto: !!a.auto };
    s.deadline = null;
    log(s, a.auto ? '線上的玩家不夠，遊戲自動暫停，等大家回來。' : '房主暫停了遊戲。');
    return null;
  }
  if (a.type === 'resume'){
    if (!s.paused) return '遊戲沒有暫停';
    if (a.auto && !s.paused.auto) return '這是房主手動暫停的，要等房主按繼續';
    const rem = s.paused.remaining;
    const wasAuto = s.paused.auto;
    s.paused = null;
    s.deadline = rem ? s.now + rem : null;
    log(s, wasAuto ? '大家回來了，遊戲繼續。' : '遊戲繼續。');
    return null;
  }
  if (s.paused) return '遊戲暫停中，等房主按「繼續」';
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
      s.pos[a.seat] = a.to; s.ap--;
      const groping = !c.lit && !s.priv[a.seat].candle && roleOf(s, a.seat) !== 'monster';
      log(s, `${nameOf(s,a.seat)} ${groping ? '摸黑' : ''}走進「${roomName(s,a.to)}」。`);
      if (groping){
        const r = d(s, 6), ev = darkWalkTable(s)[r - 1];
        evRoll(s, '摸黑', 6, r);
        log(s, `黑暗中擲出 ${DICE[r-1]}：${ev.t}`, 'search');
        applyFx(s, a.seat, ev.fx);
      }
      evClose(s);
      afterAp(s);
      return null;
    }
    case 'light': {
      const here = s.pos[a.seat];
      if (!a.target || !(a.target === here || isAdj(here, a.target))) return '只能點亮所在房間或相鄰的一格';
      const c = s.map[a.target];
      if (c && c.lit) return '那裡已經亮著了';
      const e = dayCheck(s, a, 1); if (e) return e;
      const st = s.status[a.seat];
      let source;
      if (roleOf(s, a.seat) === 'monster') source = 'fake';
      else if (s.priv[a.seat].candle) source = 'candle';
      else if (st.matches > 0) source = 'match';
      else return '你沒有燭台，也沒有火柴';
      if (source === 'match') st.matches--;
      if (c && c.wet){
        // 第一次：只烘乾燈芯，房間還是暗的；下一次（誰點都可以）才會亮
        c.wet = false;
        s.ap -= 1;
        log(s, `${nameOf(s,a.seat)} ${source === 'match' ? '劃了一根火柴，' : ''}烘乾了「${roomName(s,a.target)}」受潮的燈芯，再點一次就會亮。`);
        afterAp(s);
        return null;
      }
      if (!c) s.map[a.target] = { card:null, lit:true, explored:false };
      else { c.lit = true; c.wet = false; }
      if (source === 'fake') s.fakes[a.target] = true; else delete s.fakes[a.target];
      s.totalLights = (s.totalLights || 0) + 1;   // 全隊的燭光經驗（假燈也算，不記是誰點的）
      s.ap -= 1;
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
      evClose(s);
      afterAp(s);
      return null;
    }
    case 'search': {
      const e = dayCheck(s, a); if (e) return e;
      const k = s.pos[a.seat], c = s.map[k];
      s.searchCount = s.searchCount || {};
      if ((s.searchCount[k] || 0) >= RULES.searchLimit) return '這間已經被翻遍了，去別的房間看看吧';
      if (s.searched[k]) return '這個房間要等下次雷雨過後才能再搜';
      s.searched[k] = true; s.searchCount[k] = (s.searchCount[k] || 0) + 1; s.ap--;
      const C = CARDS[c.card];
      if (!c.lit){
        const r = d(s, 6), ev = darkSearchTable(s)[r - 1];
        evRoll(s, '摸黑搜索', 6, r);
        log(s, `${nameOf(s,a.seat)} 在「${roomName(s, k)}」摸黑搜索。擲出 ${DICE[r-1]}：${ev.t}`, 'search');
        applyFx(s, a.seat, ev.fx);
      } else if (C.seal && !s.sealSearched[k]){
        s.sealSearched[k] = true;
        log(s, `${nameOf(s,a.seat)} 搜索封印裝置，在底座找到了被奪走的東西。`, 'search');
        gainGear(s, a.seat, 'own');
      } else if (c.card === 'candle_store' && (!s.storeUsed || s.mode === 'coop')){
        s.storeUsed = true;   // 燭台儲藏室只有第一次搜得到燭台
        log(s, `${nameOf(s,a.seat)} 搜索「${roomName(s, k)}」，架子上還剩下能用的東西。`, 'search');
        applyFx(s, a.seat, 'candle');
      } else {
        const r = d(s, 6), ev = searchTable(s, C.table)[r - 1];
        evRoll(s, '搜索', 6, r);
        log(s, `${nameOf(s,a.seat)} 搜索「${roomName(s, k)}」。擲出 ${DICE[r-1]}：${ev.t}`, 'search');
        applyFx(s, a.seat, ev.fx);
        lightBonusSearch(s, a.seat, ev.fx);
      }
      evClose(s);
      afterAp(s);
      return null;
    }
    case 'lock': {
      const e = dayCheck(s, a, 0); if (e) return e;
      const st = s.status[a.seat];
      if (isMonsterSide(s, a.seat)) return '你沒有鑰匙';
      if (st.lockUsed) return '這段時間你已經用過鑰匙了';
      const c = s.map[a.target];
      if (!c || !c.explored) return '只能鎖已經探索過的房間';
      if (s.locks[a.target]) return '這間已經上鎖了';
      if ((s.lastLocked || []).includes(a.target)) return '這間上次雷雨才鎖過，這段時間不能再鎖';
      if (a.target === s.pos[a.seat]) return '不能鎖自己所在的房間';
      s.locks[a.target] = a.seat; st.lockUsed = true;
      const inside = s.seats.filter(p => s.pos[p.id] === a.target).map(p => p.name);
      log(s, `${nameOf(s,a.seat)} 用鑰匙鎖上了「${roomName(s,a.target)}」。${inside.length ? `${inside.join('、')} 在下次雷雨結束前都出不來。` : '下次雷雨結束前誰都進不去。'}`);
      return null;
    }
    case 'attack': {
      // 攻擊身份曝光（理智崩潰）的怪物：要在同一間房
      const e = dayCheck(s, a); if (e) return e;
      if (isMonsterSide(s, a.seat)) return '你不會攻擊自己的同伴';
      if (!a.target || !s.revealed[a.target]) return '只能攻擊身份已經曝光的怪物';
      if (s.pos[a.target] !== s.pos[a.seat]) return '要跟牠在同一間房才能攻擊';
      s.ap--;
      const nm = nameOf(s, a.seat), mn = nameOf(s, a.target), m = s.monster[a.target];
      const bonus = gearTotal(s, a.seat).atk + recovery(s), r = d(s, 20), total = r + bonus;
      evRoll(s, '攻擊', 20, r, bonus);
      const rollTxt = `1D20＝${r}${bonus ? `+${bonus}＝${total}` : ''}`;
      if (r === 20 || total >= RULES.attackDC){
        const dmg = d(s, 6) + gearTotal(s, a.seat).dmg;
        m.wounds += dmg; m.dealt += dmg;
        log(s, `${nm} 攻擊 ${mn}：${rollTxt}，命中，造成 ${dmg} 點傷害。（中庭的怪物也會因此變弱）`, 'battle');
        if (m.wounds >= RULES.stunAt){
          m.wounds = 0;
          s.status[a.target].stunned = true;
          s.status[a.target].skip = true; s.status[a.target].skipWhy = '被壓制在地上';
          log(s, `${mn} 被壓制在地上，下次雷雨不能作祟，下回合也不能行動。`, 'seal-break');
        }
      } else {
        const back = Math.max(1, d(s, 4) - gearTotal(s, a.seat).armor);
        log(s, `${nm} 攻擊 ${mn}：${rollTxt}，沒有命中，反被抓傷，受到 ${back} 點傷害。`, 'battle');
        hurt(s, a.seat, back);
      }
      evClose(s);
      afterAp(s);
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
      if (s.status[a.seat].cursed || s.status[a.seat].stunned || r === 'human') kind = 'none';
      if (r === 'witch' && kind === 'sealWard'){
        const pv = s.priv[a.seat];
        if (pv.sealWards <= 0) return '封印結界已經用過了';
        const c = s.map[a.target];
        if (!c || !c.explored || !CARDS[c.card].seal) return '只能守護封印房';
        if (sealLocked(s, a.target)) return '這道封印已經解開了，不需要守護';
      } else if (r === 'witch' && kind === 'ward'){
        const pv = s.priv[a.seat];
        if (pv.wards <= 0) return '守護結界的次數用完了';
        if (!a.target || a.target === a.seat || !s.roles[a.target]) return '請選一位其他玩家';
        if (pv.lastWard && pv.lastWard.storm === s.storms && pv.lastWard.target === a.target) return '不能連續兩次雷雨守護同一個人';
      } else if (r === 'witch' && kind !== 'none'){
        if (kind !== 'eye') return '巫師只能看見真實、守護人或守護封印房';
        if (!s.priv[a.seat].candle) return '你沒有燭台，看不見真實';
        if (s.priv[a.seat].eyeUsed) return '你已經用過這個能力了';
        if (!a.target || a.target === a.seat || !s.roles[a.target]) return '請選一位其他玩家';
      }
      if (r === 'fallen' && !['none','snuff'].includes(kind)) return '魔人只能熄燈';
      if (r === 'monster' && !['none','snuff','steal','haunt','bash'].includes(kind)) return '不支援這個作祟';
      if (kind === 'bash'){
        if (!s.locks[s.pos[a.seat]]) return '你沒有被鎖住，不用撞門';
        if (!['snuff','steal','haunt'].includes(a.then)) return '撞開之後要做什麼？';
        if (a.then === 'snuff' && !snuffTargets(s).concat([s.pos[a.seat]]).includes(a.target)) return '那盞燈熄不了';
        if (a.then !== 'snuff' && (!a.target || a.target === a.seat || !s.roles[a.target])) return '請選一位其他玩家';
        s.stormActs[a.seat] = { kind:'bash', then:a.then, target:a.target };
        if (s.seats.every(p => s.stormActs[p.id])) resolveStorm(s);
        return null;
      }
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
        if (!['attack','guard','fire','calm','match','smash','cover','soothe','ultimate','bind','potion'].includes(act)) return '不支援這個行動';
        if (act === 'fire' && !s.priv[a.seat].candle) return '你沒有燭台';
        if (act === 'match' && !(s.status[a.seat].matches > 0)) return '你沒有火柴';
        if (SKILLS[act] && !((b.skills[a.seat] || {})[act] > 0)) return '這個技能沒有次數了';
        if (act === 'potion' && a.target && (!b.humans.includes(a.target) || b.down[a.target])) return '只能給自己或還站著的隊友';
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
    case 'force':     // 房主推進：跟時間到一樣處理，但不看倒數（伺服器會先確認是房主）
    case 'timeout': {
      // 任何人都能送，但只有伺服器時間真的過了期限才會生效
      if (!seated) return '找不到這個座位';
      if (a.type === 'timeout' && (!s.deadline || s.now < s.deadline)) return '還沒到時間';
      // 房主按下推進時看到的是哪一段（誰的回合、哪個階段）。按確認的這幾秒內如果已經換人了，就不要誤跳過下一位
      if (a.type === 'force' && a.expect && a.expect !== stepKey(s)) return '畫面已經換到下一位了，這次推進取消。需要的話請再按一次';
      if (a.type === 'force' && s.phase !== 'day') log(s, '房主決定不再等待，直接進行下去。');
      if (s.phase === 'reveal'){ s.seats.forEach(p => { s.ready[p.id] = true; }); startRound(s); return null; }
      if (s.phase === 'day'){ log(s, a.type === 'force' ? `房主跳過了 ${nameOf(s, cur(s))} 的回合。` : `${nameOf(s, cur(s))} 的時間到了。`); endTurn(s); return null; }
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
  if (['move','explore','search','attack'].includes(action.type)) s._ev = { seat: action.seat, kind: action.type, target: action.target || action.to || null, rolls:[], lines:[] };
  const error = reduce(s, action);
  if (s._ev){
    const ev = s._ev; delete s._ev;
    if (!error && ev.rolls.length){
      s.eventSeq = (s.eventSeq || 0) + 1;
      s.lastEvent = { id:s.eventSeq, seat:ev.seat, kind:ev.kind, target:ev.target, rolls:ev.rolls, lines:ev.lines, ts:s.now };
    }
  }
  return error ? { error } : { state: s };
}

// 給某位玩家看的畫面資料：拿掉牌庫、別人的身份與燭台、假燈、亂數
function viewFor(s, viewer){
  const v = JSON.parse(JSON.stringify(s));
  ['deck','roles','fallen','priv','rng','stormActs','monster','fakes'].forEach(k => delete v[k]);
  v.deckCount = s.deck.length;
  v.stormSubmitted = Object.keys(s.stormActs || {});
  v.recovery = recovery(s);
  v.bossDealt = Object.values(s.monster || {}).reduce((t, m) => t + (m.dealt || 0), 0);   // 屋內打在怪物身上的傷害（攻擊本來就公開）
  if (v.battle){ v.battleSubmitted = Object.keys(s.battle.acts || {}); delete v.battle.acts; }
  const open = s.phase === 'battle' || s.phase === 'over';
  v.revealed = {};
  v.wounds = {};
  Object.keys(s.revealed || {}).forEach(id => { v.revealed[id] = 'monster'; if (s.monster[id]) v.wounds[id] = s.monster[id].wounds || 0; });
  if (open){ v.roles = {}; s.seats.forEach(p => { v.roles[p.id] = roleOf(s, p.id); }); }
  if (s.phase !== 'over') delete v.seed;
  v.me = null;
  if (viewer && s.roles[viewer]){
    const role = roleOf(s, viewer), pv = s.priv[viewer];
    const side = isMonsterSide(s, viewer);
    v.me = {
      id: viewer, role, candle: pv.candle, eyeUsed: pv.eyeUsed, wards: pv.wards || 0, lastWard: pv.lastWard || null, sealWards: pv.sealWards || 0,
      checks: pv.checks.slice(), notes: pv.notes.slice(),
      allies: side ? s.seats.map(p => p.id).filter(id => id !== viewer && isMonsterSide(s, id)) : [],
      monster: s.monster[viewer] ? { ...s.monster[viewer] } : null,
      fakes: role === 'monster' ? Object.keys(s.fakes) : [],
      trapped: !!s.locks[s.pos[viewer]],
      freeTargets: side && s.phase === 'storm' && s.locks[s.pos[viewer]] ? snuffTargets(s) : [],
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
  RULES, SPEEDS, DIRS, CARDS, SEALS, GEAR, ROLE_INFO, ROLE_CARDS, SKILLS,
  createGame, applyAction, viewFor, remapSeats, ENDINGS, RECOVERY_TEXT,
  adj, isAdj, step, cur, stepKey, nameOf, roomName, sealStatus, litCount, darkRoomCount, gearTotal, recovery, snuffTargets,
  toPlurkChunks,
};
if (typeof module !== 'undefined' && module.exports) module.exports = LampEngine;
else root.LampEngine = LampEngine;
})(typeof window !== 'undefined' ? window : globalThis);
