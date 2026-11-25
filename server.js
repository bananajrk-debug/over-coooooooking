// ============================================================
//  ドタバタキッチン（仮） - サーバー
//  最大8人オンライン協力料理ゲーム / 全20マップ・5ジャンル
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const T = 48;              // 1マスの大きさ(px)
const ROUND_TIME = 200;    // 1ラウンドの秒数
const MAX_PLAYERS = 8;
const TICK = 1 / 20;       // サーバー更新 20回/秒

// ------------------------------------------------------------
//  食材・料理
// ------------------------------------------------------------
// chop: 切れる / fry: フライパンで焼ける(切った後) / boil: 鍋で煮る(そのまま)
// soup: 切った物3つでスープ / ready: そのまま皿にのせられる
const ING = {
  tomato:   { jp: 'トマト',     e: '🍅', chop: true, soup: true },
  onion:    { jp: 'タマネギ',   e: '🧅', chop: true, soup: true },
  mushroom: { jp: 'キノコ',     e: '🍄', chop: true, soup: true },
  lettuce:  { jp: 'レタス',     e: '🥬', chop: true },
  cheese:   { jp: 'チーズ',     e: '🧀', chop: true },
  meat:     { jp: '肉',         e: '🥩', chop: true, fry: true, ef: '🍖' },
  fish:     { jp: '魚',         e: '🐟', chop: true, fry: true, ef: '🐟' },
  potato:   { jp: 'ジャガイモ', e: '🥔', chop: true, fry: true, ef: '🍟' },
  bun:      { jp: 'バンズ',     e: '🍞', ready: true },
  nori:     { jp: 'のり',       e: '🟩', ready: true },
  rice:     { jp: '米',         e: '🌾', boil: true, ek: '🍚' },
  noodle:   { jp: '麺',         e: '🍝', boil: true, ek: '🍜' },
};
const CRATE = { t: 'tomato', o: 'onion', u: 'mushroom', l: 'lettuce', c: 'cheese', m: 'meat',
  f: 'fish', p: 'potato', b: 'bun', n: 'nori', r: 'rice', d: 'noodle' };

// 皿にのる「部品」
const COMP = {};
for (const [k, v] of Object.entries(ING)) {
  if (v.ready) COMP[k] = { e: v.e, tag: '', jp: v.jp };
  if (v.chop) COMP[k + '_c'] = { e: v.e, tag: '切', jp: v.jp };
  if (v.fry) COMP[k + '_f'] = { e: v.ef || v.e, tag: '焼', jp: v.jp };
  if (v.boil) COMP[k + '_k'] = { e: v.ek || v.e, tag: '煮', jp: v.jp };
  if (v.soup) COMP['soup_' + k] = { e: v.e, tag: 'スープ', jp: v.jp };
}

const RECIPES = {
  salad:     { jp: 'サラダ',           c: ['lettuce_c'] },
  tomasalad: { jp: 'トマトサラダ',     c: ['lettuce_c', 'tomato_c'] },
  tsoup:     { jp: 'トマトスープ',     c: ['soup_tomato'] },
  osoup:     { jp: 'オニオンスープ',   c: ['soup_onion'] },
  msoup:     { jp: 'キノコスープ',     c: ['soup_mushroom'] },
  burger:    { jp: 'バーガー',         c: ['bun', 'meat_f'] },
  cburger:   { jp: 'チーズバーガー',   c: ['bun', 'meat_f', 'cheese_c'] },
  dxburger:  { jp: '全部のせバーガー', c: ['bun', 'meat_f', 'lettuce_c', 'tomato_c'] },
  sashimi:   { jp: '刺身',             c: ['fish_c'] },
  sushi:     { jp: '寿司',             c: ['rice_k', 'fish_c', 'nori'] },
  teishoku:  { jp: '焼き魚定食',       c: ['fish_f', 'rice_k'] },
  ramen:     { jp: 'ラーメン',         c: ['noodle_k', 'meat_f'] },
  negiramen: { jp: 'ネギラーメン',     c: ['noodle_k', 'meat_f', 'onion_c'] },
  fries:     { jp: 'フライドポテト',   c: ['potato_f'] },
};
for (const r of Object.values(RECIPES)) r.key = [...r.c].sort().join('|');

// ------------------------------------------------------------
//  マップ（全20個 / 5ジャンル×4）
// ------------------------------------------------------------
// X:壁 #:台 .:床 $:スタート位置 ~:水 _:穴 i:氷
// C:まな板 S:コンロ(鍋) F:コンロ(フライパン) W:シンク R:皿返却口 P:提供口 G:ゴミ箱
// D:皿の置かれた台 E:消火器の置かれた台
// 小文字:食材箱 (t,o,u,l,c,m,f,p,b,n,r,d)
// ▶◀▲▼:ベルトコンベア台  →←↑↓:動く床  0-9:テレポーター(同じ数字どうし)  H:切り替わるマス(溶岩/すき間)
const GENRES = ['街のお店', '乗り物の上', '自然・天候', '分断キッチン', 'へんてこ'];
const W12 = 'XXXXXXXXXXXXXXXXXXXX';
const MAPS = [
  // ===== ジャンル1：街のお店 =====
  { name: 'ラーメン屋', genre: 0, theme: 'city', stars: [40, 100, 170],
    desc: '基本を覚えよう。麺を鍋で煮て、肉を切って焼く。皿は返却口からきれいなまま戻る。',
    recipes: ['ramen', 'negiramen'], g: {},
    rows: [W12,
      'X#SS#FF###P###R#DDGX',
      'X..................X',
      'X..................X',
      'X...#CC#....#DD#...X',
      'X...#EC#....#C##...X',
      'X..................X',
      'X..$..$..$..$..$...X',
      'X..................X',
      'X..$..$..$.........X',
      'X..................X',
      'X##dd##mm##oo####D#X',
      W12] },
  { name: 'ハンバーガー店', genre: 0, theme: 'city', stars: [50, 120, 200],
    desc: '汚れた皿はシンクで洗おう。皿が足りなくなると料理が出せない！',
    recipes: ['burger', 'cburger', 'dxburger'], g: {},
    rows: [W12,
      'X#FFF###P###RW##DD#X',
      'X..................X',
      'X..$...$....$...$..X',
      'X..######..######..X',
      'X..#CCE##..#CC#D#..X',
      'X..................X',
      'X..$...$....$...$..X',
      'X..................X',
      'X..................X',
      'X..................X',
      'X#bb#mm#cc#ll#tt#GDX',
      W12] },
  { name: '回転寿司', genre: 0, theme: 'city', stars: [50, 120, 200],
    desc: 'ベルトコンベアに皿をのせると提供口まで運んでくれる。コンベアは食材を投げて越えよう。',
    recipes: ['sashimi', 'sushi', 'teishoku'], g: {},
    rows: [W12,
      'X#SS#F###RW###DDD#GX',
      'X..................X',
      'X..$...$....$...$..X',
      'X..................X',
      'X...▶▶▶▶▶▶▶▶▶▶▶▶▶▶PX',
      'X..$...$....$...$..X',
      'X..#CC#.....#CC#...X',
      'X..#E##.....####...X',
      'X..................X',
      'X..................X',
      'X##ff###rr###nn###DX',
      W12] },
  { name: '巨大フードコート', genre: 0, theme: 'city', stars: [70, 170, 280],
    desc: '6種類の料理が同時に来る大きな厨房。担当を分けよう。',
    recipes: ['salad', 'tsoup', 'burger', 'ramen', 'sushi', 'fries'], g: {},
    rows: ['XXXXXXXXXXXXXXXXXXXXXXXX',
      'X#SSS#FFF###PP###RW#DDGX',
      'X......................X',
      'X..$....$....$....$....X',
      'X..#CC#....#CC#...#DD#.X',
      'X..#E##....####...####.X',
      'X......................X',
      'X..$....$....$....$....X',
      'X......................X',
      'X...#DD#....#EG#.......X',
      'X...####....####.......X',
      'X......................X',
      'X#ll#tt#bb#mm#dd#rr#fnpX',
      'XXXXXXXXXXXXXXXXXXXXXXXX'] },

  // ===== ジャンル2：乗り物の上 =====
  { name: '食堂車', genre: 1, theme: 'train', stars: [50, 120, 200],
    desc: '肉と魚の箱は、駅に停車している間しか開かない。停車中に仕入れておこう。',
    recipes: ['salad', 'tomasalad', 'burger', 'teishoku'], g: { train: { move: 30, stop: 10, crates: ['m', 'f'] } },
    rows: [W12,
      'X#FF#SS##P##RW#DD#GX',
      'X..................X',
      'X.$..$..$..$..$..$.X',
      'X..................X',
      'X...#CC#....#CC#E..X',
      'X...#DD#....####...X',
      'X..................X',
      'X.$..$.............X',
      'X..................X',
      'X#ll#tt#bb#rr#mm#ffX',
      W12, W12] },
  { name: '海賊船', genre: 1, theme: 'ship', stars: [45, 110, 180],
    desc: '船が左右に揺れて、みんな滑る。床に置いた物は海に落ちることも。',
    recipes: ['teishoku', 'sashimi', 'fries'], g: { tilt: { period: 9, force: 85 } },
    rows: ['~~~~~~~~~~~~~~~~~~~~',
      '~~XXXXXXXXXXXXXXXX~~',
      '~X#FF#SS##P#RW#DD#X~',
      '~X..$....$....$...X~',
      '~~................~~',
      '~X...#CC#..#CC#...X~',
      '~X...#E##..#DG#...X~',
      '~~................~~',
      '~X..$....$....$...X~',
      '~X.$..............X~',
      '~X#ff##rr##pp##D##X~',
      '~~XXXXXXXXXXXXXXXX~~',
      '~~~~~~~~~~~~~~~~~~~~'] },
  { name: '並走トラック', genre: 1, theme: 'truck', stars: [40, 100, 170],
    desc: '2台のトラックがくっついたり離れたり。離れている間は食材を投げて渡そう。',
    recipes: ['burger', 'cburger', 'fries'], g: { toggle: { kind: 'gap', off: 14, on: 8 } },
    rows: [W12,
      'X#bb#mmcc__#FFFF#P#X',
      'X........HH........X',
      'X.$..$...HH.$..$...X',
      'X..#CC#..HH..#DD#..X',
      'X..#CE#..HH..#DG#..X',
      'X........HH........X',
      'X.$..$...HH.$..$...X',
      'X........HH........X',
      'X#pp#G#C#__#RW#EDD#X',
      W12, W12, W12] },
  { name: '熱気球', genre: 1, theme: 'balloon', stars: [40, 100, 170],
    desc: '高く上がると寒くて料理が遅くなり、下がると熱くて早く焦げる。高度計を見よう。',
    recipes: ['tsoup', 'osoup', 'msoup'], g: { temp: { period: 30 } },
    rows: [W12,
      'X#SSSS##P##RW#DDD#GX',
      'X..................X',
      'X..$..$..$..$..$...X',
      'X..................X',
      'X....#CCC##CCC#....X',
      'X....#E########....X',
      'X..................X',
      'X..$..$..$.........X',
      'X..................X',
      'X##tt###oo###uu##D#X',
      W12, W12] },

  // ===== ジャンル3：自然・天候 =====
  { name: '雪山ロッジ', genre: 2, theme: 'snow', stars: [40, 100, 170],
    desc: '真ん中は氷の床。つるつる滑って止まれない！',
    recipes: ['msoup', 'osoup', 'ramen'], g: {},
    rows: [W12,
      'X#SSS#FF##P#RW#DD#GX',
      'X......iiiiii......X',
      'X..$..iiiiiiii..$..X',
      'X....iii#CC#iii....X',
      'X.$..iii#CE#iii..$.X',
      'X....iiiiiiiiii....X',
      'X..$..iiiiiiii..$..X',
      'X......iiiiii......X',
      'X...#DD#....#CG#...X',
      'X..................X',
      'X##uu###oo###dd#mm#X',
      W12] },
  { name: 'ジャングル', genre: 2, theme: 'jungle', stars: [40, 100, 170],
    desc: '夜になると真っ暗。自分のまわりしか見えない。',
    recipes: ['salad', 'tomasalad', 'teishoku', 'fries'], g: { night: { day: 25, night: 18 } },
    rows: [W12,
      'X#SS#FF##P##RW#DD#GX',
      'X..................X',
      'X..$...$....$...$..X',
      'X..#CC#..##..#CC#..X',
      'X..#E##..##..#DD#..X',
      'X..................X',
      'X..$...$....$...$..X',
      'X.......####.......X',
      'X..................X',
      'X#ll##tt##ff##rr#ppX',
      W12, W12] },
  { name: '嵐の島', genre: 2, theme: 'island', stars: [40, 100, 170],
    desc: 'ときどき突風が吹いて、体も投げた食材も流される。矢印の予告に注意。',
    recipes: ['burger', 'dxburger', 'sashimi'], g: { wind: { calm: 9, gust: 6, force: 120 } },
    rows: ['~~~~~~~~~~~~~~~~~~~~',
      '~#FF#FF#P#RW#DDD#G#~',
      '~..................~',
      '~..$...$....$...$..~',
      '~.....##CCCC##.....~',
      '~.....#E####D#.....~',
      '~..................~',
      '~..$...$....$...$..~',
      '~~................~~',
      '~#bb#mm#ll#tt#ff#D#~',
      '~~~~~~~~~~~~~~~~~~~~',
      '~~~~~~~~~~~~~~~~~~~~',
      '~~~~~~~~~~~~~~~~~~~~'] },
  { name: '火山のふもと', genre: 2, theme: 'volcano', stars: [40, 100, 170],
    desc: '溶岩がときどき吹き出して道がふさがる。溶岩に触れると持っている物が燃える！',
    recipes: ['ramen', 'negiramen', 'tsoup'], g: { toggle: { kind: 'lava', off: 12, on: 6 } },
    rows: [W12,
      'X#SSS#FF##P##RW#DD#X',
      'X..................X',
      'X..$..HH....HH..$..X',
      'X.....HH....HH.....X',
      'X..#CC#HHHHHH#CG#..X',
      'X..#E##HHHHHH#DD#..X',
      'X.....HH....HH.....X',
      'X..$..HH....HH..$..X',
      'X..................X',
      'X.$.....$....$...$.X',
      'X##dd###mm###oo#tt#X',
      W12] },

  // ===== ジャンル4：分断キッチン =====
  { name: '川をはさんだ厨房', genre: 3, theme: 'river', stars: [35, 90, 150],
    desc: '左に食材とまな板、右にコンロと提供口。川の向こうへ食材を投げて渡そう。',
    recipes: ['burger', 'cburger', 'salad'], g: {},
    rows: [W12,
      'X#bb#mm#C~~#FFF#P#GX',
      'X........~~........X',
      'X.$..$...~~.$..$...X',
      'X..#CC#..~~..#DD#..X',
      'X..#CE#..~~..#DD#..X',
      'X........~~........X',
      'X.$..$...~~.$..$...X',
      'X........~~........X',
      'X#cc#ll#G~~#RW#E#D#X',
      W12, W12, W12] },
  { name: '2階建てレストラン', genre: 3, theme: 'house', stars: [35, 90, 150],
    desc: '左が1階、右が2階。エレベーター（数字のマス）は来ている間だけ使える。',
    recipes: ['sushi', 'sashimi', 'teishoku'], g: { elevator: { off: 5, on: 3 } },
    rows: [W12,
      'X#ff#rr#nXX#SS#F#P#X',
      'X........XX........X',
      'X.$..$...XX.$..$...X',
      'X..#CC#..XX..#DD#..X',
      'X..#CE#.1XX1.#DG#..X',
      'X........XX........X',
      'X.$..$..2XX2.$..$..X',
      'X........XX........X',
      'X#G#ff#D#XX#RW#E#D#X',
      W12, W12, W12] },
  { name: '回る床の厨房', genre: 3, theme: 'lab', stars: [40, 100, 170],
    desc: '厨房のまわりを床がぐるぐる回っている。乗ると勝手に運ばれる。',
    recipes: ['tsoup', 'osoup', 'salad', 'tomasalad'], g: {},
    rows: [W12,
      'X#SSSS##P##RW#DD#G#X',
      'X..$....$....$...$.X',
      'X..→→→→→→→→→→→→→↓..X',
      'X..↑............↓..X',
      'X..↑...#CCCC#...↓..X',
      'X..↑...#E##D#...↓..X',
      'X..↑............↓..X',
      'X..↑←←←←←←←←←←←←←..X',
      'X..$....$....$...$.X',
      'X..................X',
      'X##tt###oo###ll##DDX',
      W12] },
  { name: 'テレポーター研究所', genre: 3, theme: 'lab', stars: [35, 90, 150],
    desc: '3つの部屋は壁で分かれている。同じ数字のテレポーターでワープ。投げた食材もワープする。',
    recipes: ['burger', 'ramen', 'fries'], g: {},
    rows: [W12,
      'X#bbmmX#CCCC#XFFSSPX',
      'X.....X......X.....X',
      'X.$..1X1.$..2X2.$..X',
      'X.....X......X.....X',
      'X#dd#.X..#E#.X.#DD#X',
      'X.....X......X.....X',
      'X.$..3X..$...X3.$..X',
      'X.....X......X.....X',
      'X#pp#GX#CC#GDXRW#DGX',
      W12, W12, W12] },

  // ===== ジャンル5：へんてこ =====
  { name: 'お化け屋敷', genre: 4, theme: 'haunted', stars: [35, 90, 150],
    desc: '薄暗い屋敷。台に置いた食材をお化けが勝手に動かす！',
    recipes: ['msoup', 'fries', 'dxburger'], g: { ghost: { interval: 6 }, dark: 0.55 },
    rows: [W12,
      'X#SSS#FFF#P#RW#DD#GX',
      'X..................X',
      'X..$...$....$...$..X',
      'X..#CC#..##..#CC#..X',
      'X..#E##..##..#DD#..X',
      'X..................X',
      'X..$...$....$...$..X',
      'X.....##....##.....X',
      'X..................X',
      'X#uu#pp#bb#mm#ll#ttX',
      W12, W12] },
  { name: '宇宙ステーション', genre: 4, theme: 'space', stars: [35, 90, 150],
    desc: '無重力でふわふわ。止まるのが難しいけど、投げた物は遠くまで飛ぶ。',
    recipes: ['sushi', 'ramen', 'tsoup'], g: { space: true },
    rows: [W12,
      'X#SSSS#FF#P##RW#DD#X',
      'X..................X',
      'X..$...$....$...$..X',
      'X...##CC#..#CC##...X',
      'X...#E##G..#DD#....X',
      'X..................X',
      'X..$...$....$...$..X',
      'X..................X',
      'X#rr#ff#nn#dd#mm#ttX',
      W12, W12, W12] },
  { name: '怪獣の背中', genre: 4, theme: 'kaiju', stars: [40, 100, 170],
    desc: '怪獣の背中の上の厨房。ときどき怪獣が暴れて、全員ふっとび、台の物が落ちる。',
    recipes: ['burger', 'cburger', 'teishoku', 'fries'], g: { quake: { interval: 22 } },
    rows: [W12,
      'X#FFF#SS#P##RW#DD#GX',
      'X..................X',
      'X..$...$....$...$..X',
      'X...#CC#....#CC#...X',
      'X...#E##....#DD#...X',
      'X..................X',
      'X..$...$....$...$..X',
      'X..................X',
      'X#bb#mm#cc#ff#rr#ppX',
      W12, W12, W12] },
  { name: 'ラスボス厨房', genre: 4, theme: 'boss', stars: [60, 150, 250],
    desc: 'コンベア・溶岩・突風・夜。これまでのギミックが全部来る最終ステージ。',
    recipes: ['burger', 'cburger', 'dxburger', 'ramen', 'sushi', 'tsoup', 'fries'],
    g: { toggle: { kind: 'lava', off: 13, on: 6 }, wind: { calm: 12, gust: 5, force: 110 }, night: { day: 30, night: 15 } },
    rows: ['XXXXXXXXXXXXXXXXXXXXXXXX',
      'X#SSS#FFF#▶▶▶▶P◀◀◀#RWDDX',
      'X......................X',
      'X..$....HH....HH...$...X',
      'X.......HH....HH.......X',
      'X..#CCC#HH#E#GHH#CCC#..X',
      'X..#DD##HH####HH#DDG#..X',
      'X.......HH....HH.......X',
      'X..$....HH....HH...$...X',
      'X......................X',
      'X..$....$.....$....$...X',
      'X......................X',
      'X#bb#mm#cc#dd#rr#fn#tlpX',
      'XXXXXXXXXXXXXXXXXXXXXXXX'] },
];

// ------------------------------------------------------------
//  マス判定
// ------------------------------------------------------------
const CONV = { '▶': [1, 0], '◀': [-1, 0], '▲': [0, -1], '▼': [0, 1] };
const WALK = new Set(['.', 'i', '→', '←', '↑', '↓', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
const isDigit = (ch) => ch >= '0' && ch <= '9' && ch.length === 1;
const isCrate = (ch) => !!CRATE[ch];
function isWalkable(room, ch) { if (WALK.has(ch)) return true; if (ch === 'H') return !room.g.hOn; return false; }
function isCounterish(ch) {
  return ch === '#' || ch === 'C' || ch === 'S' || ch === 'P' || ch === 'W' || ch === 'R' || ch === 'G' || !!CONV[ch] || isCrate(ch);
}
function canHoldItem(ch) { return ch === '#' || ch === 'C' || ch === 'S' || !!CONV[ch]; }
function placeOK(ch, it) {
  if (ch === 'C') return it.k === 'ing';
  if (ch === 'S') return it.k === 'pot' || it.k === 'pan';
  return ch === '#' || !!CONV[ch];
}
const K = (x, y) => x + ',' + y;
const unK = (k) => k.split(',').map(Number);
function tileAt(room, cx, cy) {
  if (cy < 0 || cy >= room.tiles.length || cx < 0 || cx >= room.tiles[0].length) return 'X';
  return room.tiles[cy][cx];
}
const isVoid = (room, ch) => ch === '~' || ch === '_' || (ch === 'H' && room.g.hOn);

// ------------------------------------------------------------
//  アイテム
// ------------------------------------------------------------
let ITEM_ID = 1;
const newIng = (n) => ({ id: ITEM_ID++, k: 'ing', n, s: 'raw', ch: 0 });
const newPlate = () => ({ id: ITEM_ID++, k: 'plate', cm: [] });
const newUtensil = (k, home) => ({ id: ITEM_ID++, k, ct: [], pr: 0, bu: 0, done: false, bt: false, home });
const newExt = (home) => ({ id: ITEM_ID++, k: 'ext', home });

function compOf(it) {
  if (it.k !== 'ing') return null;
  const d = ING[it.n];
  if (it.s === 'chopped') return it.n + '_c';
  if (it.s === 'raw' && d.ready) return it.n;
  return null;
}
function canAddComp(plate, c) { return !!c && plate.cm.length < 4 && !plate.cm.includes(c); }
function utensilAccepts(u, ing) {
  if (ing.k !== 'ing' || u.done || u.bt) return false;
  const d = ING[ing.n];
  if (u.k === 'pot') {
    if (d.boil && ing.s === 'raw' && u.ct.length === 0) return true;
    if (d.soup && ing.s === 'chopped' && (u.ct.length === 0 || (u.ct[0] === ing.n && u.ct.length < 3))) return true;
    return false;
  }
  if (u.k === 'pan') return !!d.fry && ing.s === 'chopped' && u.ct.length === 0;
  return false;
}
function utensilFull(u) {
  if (u.ct.length === 0) return false;
  if (u.k === 'pan') return true;
  return ING[u.ct[0]].boil ? u.ct.length === 1 : u.ct.length === 3;
}
function cookTime(u) { if (u.k === 'pan') return 7; return ING[u.ct[0]].boil ? 9 : 11; }
const BURN_TIME = 11;
function utensilResult(u) {
  const n = u.ct[0];
  if (u.k === 'pan') return n + '_f';
  return ING[n].boil ? n + '_k' : 'soup_' + n;
}
function resetUtensil(u) { u.ct = []; u.pr = 0; u.bu = 0; u.done = false; u.bt = false; }

// ------------------------------------------------------------
//  ルーム
// ------------------------------------------------------------
const rooms = {};
const COLORS = ['#ff5a5a', '#4f8cff', '#4cd964', '#ffcc00', '#c66bff', '#ff9500', '#35d6d0', '#ff6fb5'];

function makeRoom(code) {
  return { code, players: {}, hostId: null, phase: 'lobby', mapIdx: 0, g: {}, tiles: [[]], events: [] };
}
function genCode() {
  let c;
  do { c = String(Math.floor(10000 + Math.random() * 90000)); } while (rooms[c]);
  return c;
}
function lobbyInfo(room) {
  return {
    code: room.code, hostId: room.hostId, mapIdx: room.mapIdx, phase: room.phase,
    players: Object.values(room.players).map((p) => ({ id: p.id, name: p.name, color: p.color })),
  };
}
function ev(room, e) { room.events.push(e); }

function startGame(room) {
  const M = MAPS[room.mapIdx];
  room.tiles = M.rows.map((r) => [...r]);
  room.items = {}; room.sink = {}; room.ret = {}; room.fire = {}; room.floor = []; room.proj = [];
  room.resp = []; room.orders = []; room.oid = 0; room.score = 0; room.combo = 0; room.served = 0; room.failed = 0;
  room.tele = {}; room.g = {}; room.gt = 0; room.fireT = 0; room.convT = 0; room.ghostT = 0;
  room.windIdx = -1; room.windDir = [1, 0]; room.quakeIdx = 0; room.events = [];
  const spawns = [];
  for (let y = 0; y < room.tiles.length; y++) {
    for (let x = 0; x < room.tiles[y].length; x++) {
      const ch = room.tiles[y][x]; const k = K(x, y);
      if (ch === 'D') { room.tiles[y][x] = '#'; room.items[k] = newPlate(); }
      else if (ch === 'E') { room.tiles[y][x] = '#'; room.items[k] = newExt(k); }
      else if (ch === 'S') { room.items[k] = newUtensil('pot', k); }
      else if (ch === 'F') { room.tiles[y][x] = 'S'; room.items[k] = newUtensil('pan', k); }
      else if (ch === '$') { room.tiles[y][x] = '.'; spawns.push([x, y]); }
      else if (ch === 'W') room.sink[k] = { d: 0, c: 0, p: 0 };
      else if (ch === 'R') room.ret[k] = { d: 0, c: 0 };
      if (isDigit(ch)) (room.tele[ch] = room.tele[ch] || []).push(k);
    }
  }
  room.hasSink = Object.keys(room.sink).length > 0;
  const ids = Object.keys(room.players);
  room.n = Math.max(1, ids.length);
  // スタート位置が足りない場合は床からランダムに
  const floorTiles = [];
  for (let y = 0; y < room.tiles.length; y++) for (let x = 0; x < room.tiles[y].length; x++) if (room.tiles[y][x] === '.') floorTiles.push([x, y]);
  ids.forEach((id, i) => {
    const p = room.players[id];
    const s = spawns[i] || floorTiles[Math.floor(Math.random() * floorTiles.length)];
    p.x = s[0] * T + T / 2; p.y = s[1] * T + T / 2; p.fx = 0; p.fy = 1; p.h = null; p.o = false; p.sp = false;
  });
  room.timeLeft = ROUND_TIME; room.phase = 'cd'; room.cd = 3.5;
  room.orderInt = Math.max(7, 24 - 2.2 * room.n);
  room.maxOrders = Math.min(7, 3 + Math.floor(room.n / 2));
  room.orderT = 0;
  spawnOrder(room); spawnOrder(room);
  updateGimmick(room, 0);
  io.to(room.code).emit('mapStart', {
    mapIdx: room.mapIdx, rows: room.tiles.map((r) => r.join('')), n: room.n,
    pos: Object.fromEntries(ids.map((id) => [id, [room.players[id].x, room.players[id].y]])),
  });
}

function spawnOrder(room) {
  const M = MAPS[room.mapIdx];
  const r = M.recipes[Math.floor(Math.random() * M.recipes.length)];
  const n = RECIPES[r].c.length;
  const max = 50 + 14 * n;
  room.orders.push({ id: ++room.oid, r, t: max, max });
}

// ------------------------------------------------------------
//  提供・破棄・復活
// ------------------------------------------------------------
function serve(room, plate, key) {
  if (!plate || plate.k !== 'plate' || plate.cm.length === 0) return false;
  const k = [...plate.cm].sort().join('|');
  const idx = room.orders.findIndex((o) => RECIPES[o.r].key === k);
  const [cx, cy] = key ? unK(key) : [0, 0];
  if (idx < 0) { ev(room, { ty: 'fail', x: cx * T + T / 2, y: cy * T }); return false; }
  const o = room.orders[idx];
  room.orders.splice(idx, 1);
  room.combo = Math.min(4, room.combo + 1);
  const n = RECIPES[o.r].c.length;
  const pts = 20 + 8 * (n - 1) + Math.round(8 * o.t / o.max) * room.combo;
  room.score += pts; room.served++;
  ev(room, { ty: 'serve', pts, cb: room.combo, r: o.r, x: cx * T + T / 2, y: cy * T });
  room.resp.push({ t: 7, k: 'plate' });
  return true;
}
function destroyItem(room, it) {
  if (!it) return;
  if (it.k === 'plate') room.resp.push({ t: 8, k: 'plate' });
  else if (it.k === 'dirty') for (let i = 0; i < it.cnt; i++) room.resp.push({ t: 8, k: 'plate' });
  else if (it.k === 'pot' || it.k === 'pan' || it.k === 'ext') room.resp.push({ t: 6, k: it.k, home: it.home });
}
function tickRespawn(room, dt) {
  for (let i = room.resp.length - 1; i >= 0; i--) {
    const r = room.resp[i];
    r.t -= dt;
    if (r.t > 0) continue;
    if (r.k === 'plate') {
      const rk = Object.keys(room.ret)[0];
      if (rk) { if (room.hasSink) room.ret[rk].d++; else room.ret[rk].c++; }
      else {
        const free = Object.keys(room.items).length; // 返却口がないマップ用
        const spot = findFreeCounter(room);
        if (spot) room.items[spot] = newPlate(); else { r.t = 2; continue; }
        void free;
      }
    } else {
      if (room.items[r.home] || room.fire[r.home]) { r.t = 2; continue; }
      room.items[r.home] = r.k === 'ext' ? newExt(r.home) : newUtensil(r.k, r.home);
    }
    room.resp.splice(i, 1);
  }
}
function findFreeCounter(room) {
  for (let y = 0; y < room.tiles.length; y++) for (let x = 0; x < room.tiles[y].length; x++) {
    if (room.tiles[y][x] === '#' && !room.items[K(x, y)]) return K(x, y);
  }
  return null;
}
function nearestFloor(room, cx, cy) {
  for (let r = 0; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const ch = tileAt(room, cx + dx, cy + dy);
      if (isWalkable(room, ch) && ch !== 'H') return [(cx + dx) * T + T / 2, (cy + dy) * T + T / 2];
    }
  }
  return null;
}
function dropToFloor(room, it, cx, cy) {
  const f = nearestFloor(room, cx, cy);
  if (f) room.floor.push({ it, x: f[0] + (Math.random() - 0.5) * 16, y: f[1] + (Math.random() - 0.5) * 16 });
  else destroyItem(room, it);
}

// 投げた物などが落ちたとき
function land(room, it, x, y) {
  const cx = Math.floor(x / T), cy = Math.floor(y / T);
  const ch = tileAt(room, cx, cy);
  const key = K(cx, cy);
  if (isWalkable(room, ch)) { room.floor.push({ it, x, y }); return; }
  if (isVoid(room, ch)) { destroyItem(room, it); ev(room, { ty: 'splash', x, y }); return; }
  if (ch === 'G') { destroyItem(room, it); return; }
  if (isCounterish(ch) && !room.fire[key]) {
    const Y = room.items[key];
    if (!Y && canHoldItem(ch) && placeOK(ch, it)) { room.items[key] = it; return; }
    if (Y && Y.k === 'plate' && it.k === 'ing') { const c = compOf(it); if (canAddComp(Y, c)) { Y.cm.push(c); return; } }
    if (Y && (Y.k === 'pot' || Y.k === 'pan') && utensilAccepts(Y, it)) { Y.ct.push(it.n); return; }
  }
  dropToFloor(room, it, cx, cy);
}

// ------------------------------------------------------------
//  プレイヤー操作
// ------------------------------------------------------------
function targetTile(room, p) {
  let fx = p.fx, fy = p.fy;
  const l = Math.hypot(fx, fy) || 1; fx /= l; fy /= l;
  const cands = [[fx, fy]];
  if (Math.abs(fx) > Math.abs(fy)) cands.push([Math.sign(fx), 0]); else cands.push([0, Math.sign(fy) || 1]);
  for (const [dx, dy] of cands) {
    const cx = Math.floor((p.x + dx * T * 0.8) / T), cy = Math.floor((p.y + dy * T * 0.8) / T);
    const ch = tileAt(room, cx, cy);
    if (isCounterish(ch)) return { cx, cy, ch, key: K(cx, cy) };
  }
  const cx = Math.floor((p.x + fx * T * 0.8) / T), cy = Math.floor((p.y + fy * T * 0.8) / T);
  return { cx, cy, ch: tileAt(room, cx, cy), key: K(cx, cy), floor: true, fx, fy };
}

function pickFloor(room, p) {
  const fx = p.x + p.fx * 28, fy = p.y + p.fy * 28;
  let best = -1, bd = 46;
  room.floor.forEach((f, i) => { const d = Math.min(Math.hypot(f.x - fx, f.y - fy), Math.hypot(f.x - p.x, f.y - p.y) + 6); if (d < bd) { bd = d; best = i; } });
  if (best >= 0) { p.h = room.floor[best].it; room.floor.splice(best, 1); return true; }
  return false;
}

function interact(room, p) {
  if (room.phase !== 'play') return;
  const tg = targetTile(room, p);
  const H = p.h;
  const items = room.items;
  if (tg.floor) {
    if (H) {
      if (isWalkable(room, tg.ch)) { room.floor.push({ it: H, x: p.x + tg.fx * 30, y: p.y + tg.fy * 30 }); p.h = null; }
      else if (isVoid(room, tg.ch)) { destroyItem(room, H); p.h = null; ev(room, { ty: 'splash', x: p.x + tg.fx * 40, y: p.y + tg.fy * 40 }); }
    } else pickFloor(room, p);
    return;
  }
  const key = tg.key, ch = tg.ch;
  if (room.fire[key]) { ev(room, { ty: 'msg', id: p.id, t: '燃えてる！消火器で消そう' }); return; }
  const Y = items[key];

  if (!H) {
    if (isCrate(ch)) {
      const G = MAPS[room.mapIdx].g;
      if (G.train && G.train.crates.includes(ch) && !room.g.stopped) { ev(room, { ty: 'msg', id: p.id, t: '停車中しか開かない！' }); return; }
      p.h = newIng(CRATE[ch]); return;
    }
    if (ch === 'W') { const s = room.sink[key]; if (s.c > 0) { s.c--; p.h = newPlate(); } return; }
    if (ch === 'R') {
      const r = room.ret[key];
      if (r.d > 0) { p.h = { id: ITEM_ID++, k: 'dirty', cnt: r.d }; r.d = 0; }
      else if (r.c > 0) { r.c--; p.h = newPlate(); }
      return;
    }
    if (Y && canHoldItem(ch)) { p.h = Y; delete items[key]; return; }
    pickFloor(room, p);
    return;
  }

  // 何か持っている
  if (ch === 'G') {
    if (H.k === 'ing') { p.h = null; }
    else if (H.k === 'plate') H.cm = [];
    else if (H.k === 'pot' || H.k === 'pan') resetUtensil(H);
    return;
  }
  if (ch === 'P') { if (H.k === 'plate' && serve(room, H, key)) p.h = null; return; }
  if (ch === 'W') {
    const s = room.sink[key];
    if (H.k === 'dirty') { s.d += H.cnt; p.h = null; }
    else if (H.k === 'plate' && H.cm.length === 0) { s.c++; p.h = null; }
    return;
  }
  if (ch === 'R') return;
  if (isCrate(ch)) {
    if (H.k === 'plate') { const n = CRATE[ch]; if (ING[n].ready && canAddComp(H, n)) {
      const G = MAPS[room.mapIdx].g;
      if (G.train && G.train.crates.includes(ch) && !room.g.stopped) return;
      H.cm.push(n);
    } }
    return;
  }
  if (Y) {
    if (H.k === 'ing') {
      if (Y.k === 'plate') { const c = compOf(H); if (canAddComp(Y, c)) { Y.cm.push(c); p.h = null; } }
      else if ((Y.k === 'pot' || Y.k === 'pan') && utensilAccepts(Y, H)) { Y.ct.push(H.n); p.h = null; }
    } else if (H.k === 'plate') {
      if (Y.k === 'ing') { const c = compOf(Y); if (canAddComp(H, c)) { H.cm.push(c); delete items[key]; } }
      else if ((Y.k === 'pot' || Y.k === 'pan') && Y.done && !Y.bt) { const c = utensilResult(Y); if (canAddComp(H, c)) { H.cm.push(c); resetUtensil(Y); } }
    } else if (H.k === 'pot' || H.k === 'pan') {
      if (Y.k === 'plate' && H.done && !H.bt) { const c = utensilResult(H); if (canAddComp(Y, c)) { Y.cm.push(c); resetUtensil(H); } }
      else if (Y.k === 'ing' && utensilAccepts(H, Y)) { H.ct.push(Y.n); delete items[key]; }
    } else if (H.k === 'dirty' && Y.k === 'dirty') { Y.cnt += H.cnt; p.h = null; }
    return;
  }
  if (canHoldItem(ch) && placeOK(ch, H)) { items[key] = H; p.h = null; }
}

function throwItem(room, p, pw) {
  if (room.phase !== 'play' || !p.h) return;
  if (p.h.k !== 'ing') { interact(room, p); return; }
  const l = Math.hypot(p.fx, p.fy) || 1;
  const fx = p.fx / l, fy = p.fy / l;
  const G = MAPS[room.mapIdx].g;
  const max = T * (2.5 + 4.5 * Math.max(0, Math.min(1, pw))) * (G.space ? 1.4 : 1);
  room.proj.push({ it: p.h, x: p.x + fx * 16, y: p.y + fy * 16, vx: fx * 560, vy: fy * 560, dist: 0, max, th: p.id, age: 0, lock: null });
  p.h = null;
}

// ------------------------------------------------------------
//  ギミック
// ------------------------------------------------------------
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function updateGimmick(room, dt) {
  const G = MAPS[room.mapIdx].g; const g = room.g;
  room.gt += dt; const t = room.gt;
  if (G.train) {
    const cyc = G.train.move + G.train.stop; const ph = t % cyc;
    g.stopped = ph >= G.train.move; g.trainLeft = Math.ceil(g.stopped ? cyc - ph : G.train.move - ph);
  }
  if (G.tilt) g.tilt = Math.sin(t * 2 * Math.PI / G.tilt.period);
  if (G.toggle) {
    const cyc = G.toggle.off + G.toggle.on; const ph = t % cyc;
    const on = ph >= G.toggle.off;
    g.hWarn = !on && ph >= G.toggle.off - 2.5;
    if (on && !g.hOn) { g.hOn = true; onToggleOn(room, G.toggle.kind); }
    g.hOn = on;
  }
  if (G.temp) { g.alt = (Math.sin(t * 2 * Math.PI / G.temp.period) + 1) / 2; }
  if (G.night) { const cyc = G.night.day + G.night.night; const ph = t % cyc; g.night = ph >= G.night.day; g.nightWarn = !g.night && ph >= G.night.day - 3; }
  if (G.dark) g.dark = G.dark;
  if (G.wind) {
    const cyc = G.wind.calm + G.wind.gust; const ph = t % cyc; const idx = Math.floor(t / cyc);
    if (idx !== room.windIdx) { room.windIdx = idx; room.windDir = DIRS[Math.floor(Math.random() * 4)]; }
    g.wind = ph >= G.wind.calm ? room.windDir : [0, 0];
    g.windWarn = ph >= G.wind.calm - 2.5 && ph < G.wind.calm ? room.windDir : null;
  }
  if (G.elevator) { const cyc = G.elevator.off + G.elevator.on; g.elev = (t % cyc) >= G.elevator.off; }
  if (G.quake) {
    const ph = t % G.quake.interval; const idx = Math.floor(t / G.quake.interval);
    g.quakeWarn = ph >= G.quake.interval - 2.5;
    if (idx !== room.quakeIdx) { room.quakeIdx = idx; doQuake(room); }
  }
  if (G.ghost) { room.ghostT += dt; if (room.ghostT >= G.ghost.interval) { room.ghostT = 0; doGhost(room); } }
}
function teleActive(room) { const G = MAPS[room.mapIdx].g; return !G.elevator || room.g.elev; }

function onToggleOn(room, kind) {
  for (const p of Object.values(room.players)) {
    const ch = tileAt(room, Math.floor(p.x / T), Math.floor(p.y / T));
    if (ch === 'H' && kind === 'lava' && p.h) { destroyItem(room, p.h); p.h = null; ev(room, { ty: 'burn', x: p.x, y: p.y }); }
  }
  room.floor = room.floor.filter((f) => {
    const ch = tileAt(room, Math.floor(f.x / T), Math.floor(f.y / T));
    if (ch === 'H') { destroyItem(room, f.it); return false; }
    return true;
  });
}
function doQuake(room) {
  ev(room, { ty: 'quake' });
  for (const f of room.floor) {
    const nx = f.x + (Math.random() - 0.5) * 90, ny = f.y + (Math.random() - 0.5) * 90;
    if (isWalkable(room, tileAt(room, Math.floor(nx / T), Math.floor(ny / T)))) { f.x = nx; f.y = ny; }
  }
  const keys = Object.keys(room.items).filter((k) => { const [x, y] = unK(k); const ch = tileAt(room, x, y); return ch === '#' || ch === 'C' || CONV[ch]; });
  for (let i = 0; i < 2 && keys.length; i++) {
    const k = keys.splice(Math.floor(Math.random() * keys.length), 1)[0];
    const it = room.items[k]; delete room.items[k];
    const [x, y] = unK(k); dropToFloor(room, it, x, y);
  }
}
function doGhost(room) {
  const keys = Object.keys(room.items).filter((k) => { const [x, y] = unK(k); return room.items[k].k === 'ing' && tileAt(room, x, y) !== 'S' && !room.fire[k]; });
  if (!keys.length) return;
  const k = keys[Math.floor(Math.random() * keys.length)];
  const [x, y] = unK(k); const it = room.items[k];
  const opts = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy, ch = tileAt(room, nx, ny), nk = K(nx, ny);
    if (canHoldItem(ch) && placeOK(ch, it) && !room.items[nk] && !room.fire[nk]) opts.push(['c', nk]);
    else if (isWalkable(room, ch) && ch !== 'H') opts.push(['f', nx, ny]);
  }
  if (!opts.length) return;
  const o = opts[Math.floor(Math.random() * opts.length)];
  delete room.items[k];
  if (o[0] === 'c') room.items[o[1]] = it;
  else room.floor.push({ it, x: o[1] * T + T / 2, y: o[2] * T + T / 2 });
  ev(room, { ty: 'ghost', x: x * T + T / 2, y: y * T + T / 2 });
}

// ------------------------------------------------------------
//  毎フレームの更新
// ------------------------------------------------------------
function step(room, dt) {
  room.events = [];
  if (room.phase === 'cd') {
    room.cd -= dt;
    if (room.cd <= 0) room.phase = 'play';
    return;
  }
  if (room.phase !== 'play') return;
  room.timeLeft -= dt;
  if (room.timeLeft <= 0) { endGame(room); return; }
  updateGimmick(room, dt);
  const G = MAPS[room.mapIdx].g;
  const mult = G.temp ? 1.5 - room.g.alt : 1;

  // 調理
  for (const [key, it] of Object.entries(room.items)) {
    if (it.k !== 'pot' && it.k !== 'pan') continue;
    const [x, y] = unK(key);
    if (tileAt(room, x, y) !== 'S' || room.fire[key] || it.bt || !utensilFull(it)) continue;
    if (!it.done) { it.pr += dt * mult / cookTime(it); if (it.pr >= 1) { it.pr = 1; it.done = true; it.bu = 0; ev(room, { ty: 'done', x: x * T + T / 2, y: y * T }); } }
    else { it.bu += dt * mult / BURN_TIME; if (it.bu >= 1) { it.bt = true; room.fire[key] = 100; ev(room, { ty: 'fire', x: x * T + T / 2, y: y * T }); } }
  }

  // 切る・洗う・消火
  for (const p of Object.values(room.players)) {
    p.sp = false;
    if (!p.o) continue;
    if (p.h && p.h.k === 'ext') {
      p.sp = true;
      const l = Math.hypot(p.fx, p.fy) || 1; const fx = p.fx / l, fy = p.fy / l;
      const hit = new Set();
      for (const d of [0.6, 1.2, 1.8, 2.4]) hit.add(K(Math.floor((p.x + fx * T * d) / T), Math.floor((p.y + fy * T * d) / T)));
      for (const k of hit) if (room.fire[k] !== undefined) { room.fire[k] -= 95 * dt; if (room.fire[k] <= 0) delete room.fire[k]; }
      continue;
    }
    if (p.h) continue;
    const tg = targetTile(room, p);
    if (room.fire[tg.key]) continue;
    if (tg.ch === 'C') {
      const it = room.items[tg.key];
      if (it && it.k === 'ing' && it.s === 'raw' && ING[it.n].chop) {
        it.ch += dt / 2.0;
        if (it.ch >= 1) { it.s = 'chopped'; it.ch = 0; }
      }
    } else if (tg.ch === 'W') {
      const s = room.sink[tg.key];
      if (s.d > 0) { s.p += dt / 1.6; if (s.p >= 1) { s.p = 0; s.d--; s.c++; } }
    }
  }

  // 火事が広がる
  room.fireT += dt;
  if (room.fireT >= 4) {
    room.fireT = 0;
    const fk = Object.keys(room.fire);
    if (fk.length < 14) for (const k of fk) {
      if (Math.random() > 0.45) continue;
      const [x, y] = unK(k);
      const opts = DIRS.map(([dx, dy]) => [x + dx, y + dy]).filter(([nx, ny]) => isCounterish(tileAt(room, nx, ny)) && room.fire[K(nx, ny)] === undefined);
      if (opts.length) { const [nx, ny] = opts[Math.floor(Math.random() * opts.length)]; room.fire[K(nx, ny)] = 100; }
    }
  }

  // ベルトコンベア
  room.convT += dt;
  if (room.convT >= 0.8) {
    room.convT = 0;
    const occupied = new Set(Object.keys(room.items));
    const moves = [];
    for (const [key, it] of Object.entries(room.items)) {
      const [x, y] = unK(key); const ch = tileAt(room, x, y);
      if (!CONV[ch] || room.fire[key]) continue;
      const [dx, dy] = CONV[ch]; const nx = x + dx, ny = y + dy, nch = tileAt(room, nx, ny), nk = K(nx, ny);
      if (nch === 'P') { if (it.k === 'plate' && serve(room, it, nk)) delete room.items[key]; continue; }
      if (nch === 'G') { delete room.items[key]; destroyItem(room, it); continue; }
      if (canHoldItem(nch) && placeOK(nch, it) && !occupied.has(nk) && !room.fire[nk]) moves.push([key, nk]);
    }
    const used = new Set();
    for (const [from, to] of moves) { if (used.has(to)) continue; used.add(to); room.items[to] = room.items[from]; delete room.items[from]; }
  }

  // 投げた食材
  const wind = room.g.wind || [0, 0];
  const windF = G.wind ? G.wind.force : 0;
  for (let i = room.proj.length - 1; i >= 0; i--) {
    const pr = room.proj[i];
    pr.age += dt;
    pr.vx += wind[0] * windF * 4 * dt; pr.vy += wind[1] * windF * 4 * dt;
    const nx = pr.x + pr.vx * dt, ny = pr.y + pr.vy * dt;
    const ch = tileAt(room, Math.floor(nx / T), Math.floor(ny / T));
    if (ch === 'X') { room.proj.splice(i, 1); land(room, pr.it, pr.x, pr.y); continue; }
    pr.dist += Math.hypot(nx - pr.x, ny - pr.y); pr.x = nx; pr.y = ny;
    const ck = K(Math.floor(pr.x / T), Math.floor(pr.y / T));
    if (isDigit(ch) && teleActive(room) && pr.lock !== ck) {
      const pair = room.tele[ch] || []; const other = pair.find((k) => k !== ck);
      if (other) { const [ox, oy] = unK(other); pr.x = ox * T + T / 2; pr.y = oy * T + T / 2; pr.lock = other; }
    }
    let caught = false;
    for (const p of Object.values(room.players)) {
      if (p.h || (p.id === pr.th && pr.age < 0.6)) continue;
      if (Math.hypot(p.x - pr.x, p.y - pr.y) < 28) { p.h = pr.it; caught = true; ev(room, { ty: 'catch', x: p.x, y: p.y }); break; }
    }
    if (caught) { room.proj.splice(i, 1); continue; }
    if (pr.dist >= pr.max) { room.proj.splice(i, 1); land(room, pr.it, pr.x, pr.y); }
  }

  // 床の物が流される（揺れ・風）
  let fxv = 0, fyv = 0;
  if (G.tilt) fxv += room.g.tilt * G.tilt.force * 0.7;
  if (G.wind) { fxv += wind[0] * windF * 0.8; fyv += wind[1] * windF * 0.8; }
  if (fxv || fyv) {
    room.floor = room.floor.filter((f) => {
      const nx = f.x + fxv * dt, ny = f.y + fyv * dt;
      const ch = tileAt(room, Math.floor(nx / T), Math.floor(ny / T));
      if (isWalkable(room, ch)) { f.x = nx; f.y = ny; return true; }
      if (isVoid(room, ch)) { destroyItem(room, f.it); ev(room, { ty: 'splash', x: nx, y: ny }); return false; }
      return true;
    });
  }

  tickRespawn(room, dt);

  // 注文
  for (let i = room.orders.length - 1; i >= 0; i--) {
    const o = room.orders[i]; o.t -= dt;
    if (o.t <= 0) { room.orders.splice(i, 1); room.score = Math.max(0, room.score - 10); room.combo = 0; room.failed++; ev(room, { ty: 'expire', r: o.r }); }
  }
  room.orderT += dt;
  if ((room.orderT >= room.orderInt || (room.orders.length === 0 && room.orderT > 2)) && room.orders.length < room.maxOrders) { room.orderT = 0; spawnOrder(room); }
}

function endGame(room) {
  room.phase = 'result';
  const M = MAPS[room.mapIdx];
  const scale = 0.6 + 0.2 * room.n;
  const th = M.stars.map((s) => Math.round(s * scale));
  const stars = th.filter((s) => room.score >= s).length;
  io.to(room.code).emit('result', { mapIdx: room.mapIdx, score: room.score, stars, th, served: room.served, failed: room.failed });
  io.to(room.code).emit('lobby', lobbyInfo(room));
}

function snapshot(room) {
  const pl = {};
  for (const p of Object.values(room.players)) pl[p.id] = [Math.round(p.x), Math.round(p.y), +p.fx.toFixed(2), +p.fy.toFixed(2), p.h, p.sp ? 1 : 0];
  return {
    ph: room.phase, cd: room.cd, t: room.timeLeft, sc: room.score, cb: room.combo,
    o: room.orders.map((o) => [o.id, o.r, +o.t.toFixed(1), o.max]),
    p: pl, it: room.items, sk: room.sink, rt: room.ret, fi: room.fire,
    fl: room.floor.map((f) => [Math.round(f.x), Math.round(f.y), f.it]),
    pr: room.proj.map((p) => [Math.round(p.x), Math.round(p.y), p.it]),
    g: room.g, ev: room.events,
  };
}

// ------------------------------------------------------------
//  通信
// ------------------------------------------------------------
let io = { to: () => ({ emit: () => {} }) }; // テスト用のダミー

function startServer() {
  const app = express();
  const server = http.createServer(app);
  io = new Server(server);
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  const DEFS = {
    T, ING, COMP, RECIPES, GENRES, ROUND_TIME, MAX_PLAYERS,
    MAPS: MAPS.map((m) => ({ name: m.name, genre: m.genre, theme: m.theme, desc: m.desc, recipes: m.recipes, stars: m.stars, g: m.g })),
  };

  io.on('connection', (socket) => {
    socket.emit('defs', DEFS);
    let room = null;
    const cleanName = (n) => String(n || '').trim().slice(0, 10) || 'シェフ';

    function joinRoom(r, name) {
      if (Object.keys(r.players).length >= MAX_PLAYERS) { socket.emit('err', 'この部屋は満員です（8人まで）'); return; }
      if (r.phase !== 'lobby' && r.phase !== 'result') { socket.emit('err', 'この部屋はゲーム中です。終わるまで待ってね'); return; }
      room = r;
      const used = new Set(Object.values(r.players).map((p) => p.color));
      const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
      r.players[socket.id] = { id: socket.id, name: cleanName(name), color, x: 0, y: 0, fx: 0, fy: 1, h: null, o: false, sp: false };
      if (!r.hostId) r.hostId = socket.id;
      socket.join(r.code);
      socket.emit('joined', { code: r.code, id: socket.id });
      io.to(r.code).emit('lobby', lobbyInfo(r));
    }

    socket.on('create', (name) => { if (room) return; const code = genCode(); rooms[code] = makeRoom(code); joinRoom(rooms[code], name); });
    socket.on('join', (d) => {
      if (room) return;
      const r = rooms[String((d && d.code) || '').trim()];
      if (!r) { socket.emit('err', 'その部屋番号は見つかりません'); return; }
      joinRoom(r, d.name);
    });
    socket.on('pick', (i) => {
      if (!room || socket.id !== room.hostId || (room.phase !== 'lobby' && room.phase !== 'result')) return;
      if (Number.isInteger(i) && i >= 0 && i < MAPS.length) { room.mapIdx = i; io.to(room.code).emit('lobby', lobbyInfo(room)); }
    });
    socket.on('start', () => {
      if (!room || socket.id !== room.hostId || (room.phase !== 'lobby' && room.phase !== 'result')) return;
      startGame(room);
    });
    socket.on('toLobby', () => {
      if (!room || socket.id !== room.hostId) return;
      room.phase = 'lobby'; io.to(room.code).emit('lobby', lobbyInfo(room));
    });
    socket.on('pos', (a) => {
      if (!room || !Array.isArray(a)) return;
      const p = room.players[socket.id]; if (!p || (room.phase !== 'play' && room.phase !== 'cd')) return;
      const [x, y, fx, fy] = a.map(Number);
      if ([x, y, fx, fy].some((v) => !Number.isFinite(v))) return;
      p.x = x; p.y = y; if (fx || fy) { p.fx = fx; p.fy = fy; }
    });
    socket.on('k', (d) => {
      if (!room) return; const p = room.players[socket.id]; if (!p) return;
      if (d && d.m === 'throw') throwItem(room, p, Number(d.pw) || 0); else interact(room, p);
    });
    socket.on('o', (d) => { if (!room) return; const p = room.players[socket.id]; if (p) p.o = !!(d && d.d); });
    socket.on('emote', (n) => { if (!room || ![1, 2, 3, 4].includes(n)) return; io.to(room.code).emit('ev', { ty: 'emote', id: socket.id, n }); });
    socket.on('disconnect', () => {
      if (!room) return;
      const p = room.players[socket.id];
      if (p && p.h && room.phase === 'play') { room.floor.push({ it: p.h, x: p.x, y: p.y }); }
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) { delete rooms[room.code]; return; }
      if (room.hostId === socket.id) room.hostId = Object.keys(room.players)[0];
      io.to(room.code).emit('lobby', lobbyInfo(room));
    });
  });

  setInterval(() => {
    for (const room of Object.values(rooms)) {
      if (room.phase !== 'cd' && room.phase !== 'play') continue;
      step(room, TICK);
      if (room.phase === 'cd' || room.phase === 'play') io.to(room.code).emit('state', snapshot(room));
    }
  }, TICK * 1000);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('ドタバタキッチン 起動: http://localhost:' + PORT));
}

if (require.main === module) startServer();

// テスト用
module.exports = { MAPS, RECIPES, ING, CRATE, COMP, makeRoom, startGame, step, interact, throwItem, targetTile, rooms, T,
  _setIO: (x) => { io = x; } };
