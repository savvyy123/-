// Number Space — 球体の世界
// 1人が1つの点になり、ランダムな場所・向きから、入力した速さで大円に沿って進む。
// ふだんは地図（緯度・経度をそのまま縦横に並べる）、Space で球体と切り替える。
//
// 世界はサーバーにあり、全員が同じものを見る。
// 出発点と向きはサーバーが決め、各画面はサーバーの時計に合わせて位置を計算する。

// --- 世界の大きさと速さ ---
// 速さ km/s を比例のまま描くため、世界の大きさで見え方を合わせる。
// 1周 3,000km なら、999 km/s で 3 秒、1 km/s で 50 分で1周する。
const CIRCUMFERENCE_KM = 3000;
const RADIUS_KM = CIRCUMFERENCE_KM / (2 * Math.PI);

// 線が届く距離。これより離れると切れ、近いほど濃く・遠いほど薄くなる。
// 1周 3,000km の世界で 500km は 60°（1/6周）。10〜20人だと線の6〜9割が残る
const MAX_LINK_KM = 500;

const MAX_SPEED_DIGITS = 3;       // 1〜999 km/s
const MAX_CONNECTION_DIGITS = 2;  // 1〜99

// --- 見た目 ---
const POINT_SIZE = 10;            // Figma: 10×10 の白い正方形
const LABEL_OFFSET = 19;          // 点の中心から名前の上端まで
const FONT_STACK = '"Haas Grot Disp Trial", "Helvetica Neue", Helvetica, Arial, sans-serif';
const FONT_SIZE = getComputedStyle(document.documentElement).getPropertyValue('--size').trim() || '24px';
const LABEL_FONT = `${FONT_SIZE} ${FONT_STACK}`;

const GLOBE_RATIO = 0.4;          // 球の半径 = 画面の短辺 × 0.4
const BACK_ALPHA = 0.2;           // 球の裏側にあるものの濃さ
const TRAIL_SEC = 1;              // 軌跡は直近1秒ぶん。速い点ほど長く伸びる
const ARC_STEP = (2 * Math.PI) / 180; // 曲線を 2° ごとに区切って描く
const DRAG_SPEED = 0.005;
const CLICK_SLOP = 4;             // これ以上動いたらクリックではなくドラッグとみなす（px）

const POLL_MS = 3000;             // 新しく来た人を取りに行く間隔（サーバー側のキャッシュと揃える）
const TIME_SYNC_MS = 60000;       // サーバーの時計に合わせ直す間隔

const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
const body = document.body;
const inputs = {
  name: document.getElementById('name'),
  speed: document.getElementById('speed'),
  connections: document.getElementById('connections'),
};

const people = []; // { id, name, speed, connections, p0, d0, born }
const known = new Set(); // 受け取り済みの id
let myId = null;         // この画面で入力した人

let W = 0, H = 0, dpr = 1;
let yaw = 0, pitch = 0;  // 球体の向き

let selected = null;     // 球体で名前を押された人
let nameBoxes = [];      // 球体に描いた名前の当たり判定（毎フレーム作り直す）

const links = document.getElementById('links');
const linksHead = document.getElementById('links-head');
const linksList = document.getElementById('links-list');

// サーバーの時計（秒）。端末の時計のずれを clockOffset で打ち消す
let clockOffset = 0;
let bestRtt = Infinity;
const now = () => (Date.now() + clockOffset) / 1000;

// =========================================================
// ベクトル（球の中心が原点、半径1。z が北）
// =========================================================

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const normalize = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; };

// 大円に沿って、出発点から角度 a だけ進んだ位置
function along(person, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const { p0, d0 } = person;
  return [p0[0] * c + d0[0] * s, p0[1] * c + d0[1] * s, p0[2] * c + d0[2] * s];
}

// 時刻 t までに進んだ角度（rad）。km/s ÷ 半径 km = rad/s
const angleAt = (person, t) => ((t - person.born) * person.speed) / RADIUS_KM;

// a から b へ、球面に沿って n 等分した点（大円の弧）
function arc(a, b) {
  const cos = Math.min(1, Math.max(-1, dot(a, b)));
  const theta = Math.acos(cos);
  const sin = Math.sin(theta);
  if (sin < 1e-6) return [a, b]; // ほぼ同じ点（ちょうど反対側は向きが決まらないので直線で代用）

  const n = Math.max(1, Math.ceil(theta / ARC_STEP));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const wa = Math.sin((1 - t) * theta) / sin;
    const wb = Math.sin(t * theta) / sin;
    out.push([a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb]);
  }
  return out;
}

// =========================================================
// 線でつなぐ相手
// =========================================================

// 各点から、球面上で近い順に「つながりの数」だけ手を伸ばす。
// 他の人から伸びてきた手も受け入れるので、自分の数より線が増えることがある。
// ただし MAX_LINK_KM より遠い相手には手が届かない（線は切れる）。
// 返す線は [i, j, 濃さ]。濃さは距離 0 で 1、MAX_LINK_KM で 0
function computeEdges(pos) {
  const seen = new Set();
  const edges = [];

  for (let i = 0; i < pos.length; i++) {
    const k = Math.min(people[i].connections, pos.length - 1);
    if (k <= 0) continue;

    const near = [];
    for (let j = 0; j < pos.length; j++) {
      if (j !== i) near.push([dot(pos[i], pos[j]), j]); // 内積が大きいほど近い
    }
    near.sort((a, b) => b[0] - a[0]);

    for (let m = 0; m < k; m++) {
      const [cos, j] = near[m];
      const km = Math.acos(Math.min(1, cos)) * RADIUS_KM;
      if (km > MAX_LINK_KM) break; // 近い順に並んでいるので、ここから先も届かない

      const key = i < j ? `${i}-${j}` : `${j}-${i}`; // 同じ線を二重に引かない
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([i, j, 1 - km / MAX_LINK_KM]);
    }
  }
  return edges;
}

// =========================================================
// 地図（正距円筒図法）
// =========================================================

// 2:1 の地図を画面に収める
function mapRect() {
  const w = Math.min(W, H * 2);
  const h = w / 2;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function toMap(v, m) {
  const lon = Math.atan2(v[1], v[0]);
  const lat = Math.asin(Math.min(1, Math.max(-1, v[2])));
  return [m.x + ((lon + Math.PI) / (2 * Math.PI)) * m.w, m.y + ((Math.PI / 2 - lat) / Math.PI) * m.h];
}

// 経度 ±180° をまたぐ区間は、左右にずらして2回描くと端でつながって見える
function mapPolyline(path, m) {
  let prev = toMap(path[0], m);
  for (let i = 1; i < path.length; i++) {
    const cur = toMap(path[i], m);
    const dx = cur[0] - prev[0];
    if (Math.abs(dx) > m.w / 2) {
      const shift = dx > 0 ? -m.w : m.w;
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(cur[0] + shift, cur[1]);
      ctx.moveTo(prev[0] - shift, prev[1]);
      ctx.lineTo(cur[0], cur[1]);
    } else {
      ctx.moveTo(prev[0], prev[1]);
      ctx.lineTo(cur[0], cur[1]);
    }
    prev = cur;
  }
}

function drawMap(pos, edges) {
  const m = mapRect();

  ctx.save();
  ctx.beginPath();
  ctx.rect(m.x, m.y, m.w, m.h);
  ctx.clip();

  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  for (const [i, j, alpha] of edges) {
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    mapPolyline(arc(pos[i], pos[j]), m);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  ctx.fillStyle = '#fff';
  for (let i = 0; i < pos.length; i++) {
    const [x, y] = toMap(pos[i], m);
    drawPoint(x, y);
    drawName(people[i].name, x, y);
  }
}

// =========================================================
// 球体（正射影）
// =========================================================

// 画面の手前が +y、上が +z
function toView(v) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const x1 = v[0] * cy - v[1] * sy;
  const y1 = v[0] * sy + v[1] * cy;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  return [x1, y1 * cp + v[2] * sp, -y1 * sp + v[2] * cp];
}

function globe() {
  return { cx: W / 2, cy: H / 2, r: Math.min(W, H) * GLOBE_RATIO };
}

const toScreen = (q, g) => [g.cx + q[0] * g.r, g.cy - q[2] * g.r];

// 区間ごとに、手前なら濃く・裏側なら薄く描く。alphaOf で区間ごとの濃さも足せる
function globePolyline(path, g, alphaOf = () => 1) {
  let prev = toView(path[0]);
  for (let i = 1; i < path.length; i++) {
    const cur = toView(path[i]);
    const front = prev[1] + cur[1] > 0;
    ctx.globalAlpha = (front ? 1 : BACK_ALPHA) * alphaOf(i);
    ctx.beginPath();
    ctx.moveTo(...toScreen(prev, g));
    ctx.lineTo(...toScreen(cur, g));
    ctx.stroke();
    prev = cur;
  }
  ctx.globalAlpha = 1;
}

function drawGlobe(pos, edges, t) {
  const g = globe();

  // 球の輪郭
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(g.cx, g.cy, g.r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#fff';

  for (const [i, j, alpha] of edges) globePolyline(arc(pos[i], pos[j]), g, () => alpha);

  // 軌跡：直近 TRAIL_SEC 秒に通った大円の弧。尾に向かって消えていく
  for (const person of people) {
    const a = angleAt(person, t);
    const sweep = (TRAIL_SEC * person.speed) / RADIUS_KM;
    const n = Math.max(2, Math.ceil(sweep / ARC_STEP));
    const path = [];
    for (let k = n; k >= 0; k--) path.push(along(person, a - (sweep * k) / n));
    globePolyline(path, g, (seg) => seg / n);
  }

  // 点と名前：裏側を先に描き、手前を上に重ねる。名前は手前の点だけ
  const order = pos.map((v, i) => [toView(v), i]).sort((p, q) => p[0][1] - q[0][1]);
  const lineH = parseFloat(FONT_SIZE) * 1.25;
  nameBoxes = [];
  ctx.fillStyle = '#fff';
  for (const [q, i] of order) {
    const [x, y] = toScreen(q, g);
    const front = q[1] > 0;
    ctx.globalAlpha = front ? 1 : BACK_ALPHA;
    drawPoint(x, y);
    if (!front) continue;

    const w = drawName(people[i].name, x, y);
    // 名前と点をまとめて押せる範囲にする
    nameBoxes.push({
      person: people[i],
      x0: Math.min(x - w / 2, x - POINT_SIZE / 2) - 4,
      x1: Math.max(x + w / 2, x + POINT_SIZE / 2) + 4,
      y0: y - POINT_SIZE / 2 - 4,
      y1: y + LABEL_OFFSET + lineH + 4,
    });
  }
  ctx.globalAlpha = 1;
}

// 自分の点が正面に来る向き（まだ入力していなければ一番新しい人）
function faceMine() {
  if (!people.length) return;
  const person = people.find((p) => p.id === myId) ?? people[people.length - 1];
  const v = along(person, angleAt(person, now()));
  const lon = Math.atan2(v[1], v[0]);
  const lat = Math.asin(Math.min(1, Math.max(-1, v[2])));
  yaw = Math.PI / 2 - lon;
  pitch = lat;
}

// =========================================================
// 描画
// =========================================================

function drawPoint(x, y) {
  ctx.fillRect(Math.round(x - POINT_SIZE / 2), Math.round(y - POINT_SIZE / 2), POINT_SIZE, POINT_SIZE);
}

function drawName(name, x, y) {
  ctx.font = LABEL_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(name, Math.round(x), Math.round(y + LABEL_OFFSET));
  return ctx.measureText(name).width;
}

// =========================================================
// 右の一覧：選んだ人が誰とつながっているか
// =========================================================

// 手前に描いた名前から順に調べる
function hit(x, y) {
  for (let k = nameBoxes.length - 1; k >= 0; k--) {
    const b = nameBoxes[k];
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return b;
  }
  return null;
}

// 点は動き続け、つながる相手も入れ替わるので、毎フレーム確かめて変わったときだけ書き換える
let linksKey = '';

function updateLinks(pos, edges) {
  const i = selected ? people.indexOf(selected) : -1;
  if (i < 0 || body.dataset.view !== 'globe') {
    showLinks(null);
    return;
  }

  const others = [];
  for (const [a, b] of edges) {
    if (a === i) others.push(b);
    else if (b === i) others.push(a);
  }
  others.sort((a, b) => dot(pos[i], pos[b]) - dot(pos[i], pos[a])); // 近い順
  showLinks(selected.name, others.map((j) => people[j].name));
}

function showLinks(name, names = []) {
  const key = name === null ? '' : [name, ...names].join('\u0000');
  if (key === linksKey) return;
  linksKey = key;

  if (name === null) {
    links.hidden = true;
    return;
  }
  linksHead.textContent = names.length ? `${name} is connected to` : `${name} is connected to no one.`;
  linksList.replaceChildren(...names.map((n) => {
    const li = document.createElement('li');
    li.textContent = n;
    return li;
  }));
  links.hidden = false;
}

function frame() {
  requestAnimationFrame(frame);
  if (body.dataset.stage !== 'home') return; // 見えていない間も時間は進む（位置は時刻から決まる）

  const t = now();
  const pos = people.map((p) => along(p, angleAt(p, t)));
  const edges = computeEdges(pos);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  if (body.dataset.view === 'globe') drawGlobe(pos, edges, t);
  else drawMap(pos, edges);

  updateLinks(pos, edges);
}

function resize() {
  dpr = window.devicePixelRatio || 1;
  W = canvas.clientWidth;
  H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// =========================================================
// 入力
// =========================================================

const STAGES = ['intro', 'name', 'speed', 'connections', 'home'];
const stage = () => body.dataset.stage;

function goTo(next) {
  body.dataset.stage = next;
  const input = inputs[next];
  if (input) input.focus();
}

const measure = document.createElement('canvas').getContext('2d');

// 文字が等幅ではないので、実際の文字幅で入力欄の幅を決める
function fitWidth(input) {
  measure.font = `100px ${FONT_STACK}`;
  const w = measure.measureText(input.value || input.placeholder).width / 100;
  input.style.width = `${w + 0.04}em`;
}

// 数字だけ・先頭の 0 なし・桁数まで。これで打てる値はすべて正しい値になる
function digitsOnly(input, maxDigits) {
  const v = input.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, maxDigits);
  if (v !== input.value) input.value = v;
}

inputs.speed.addEventListener('input', () => { digitsOnly(inputs.speed, MAX_SPEED_DIGITS); fitWidth(inputs.speed); });
inputs.connections.addEventListener('input', () => { digitsOnly(inputs.connections, MAX_CONNECTION_DIGITS); fitWidth(inputs.connections); });
inputs.name.addEventListener('input', () => fitWidth(inputs.name));

// --- サーバーとのやり取り ---

// 通信の往復が一番短かったときの値で、サーバーとの時計のずれを決める。
// 毎回更新すると、通信の揺らぎで点がぴくっと動くため
function syncClock(serverNow, sentAt, receivedAt) {
  const rtt = receivedAt - sentAt;
  if (rtt >= bestRtt) return;
  bestRtt = rtt;
  clockOffset = serverNow + rtt / 2 - receivedAt;
}

function addPeople(list) {
  for (const p of list) {
    if (known.has(p.id)) continue;
    known.add(p.id);
    people.push({ ...p, born: p.bornAt / 1000 });
  }
}

// 世界にいる全員を受け取る。サーバー側で数秒キャッシュされるので、時刻はここでは合わせない
async function poll() {
  try {
    const res = await fetch('/people', { cache: 'no-store' });
    addPeople(await res.json());
  } catch (err) {
    // つながらない間は、手元の世界をそのまま動かし続ける
  }
}

// サーバーの時計を数回聞いて、往復が一番短かったときの値で合わせる
async function syncTime(times = 1) {
  for (let i = 0; i < times; i++) {
    try {
      const sentAt = Date.now();
      const res = await fetch('/time', { cache: 'no-store' });
      const data = await res.json();
      syncClock(data.now, sentAt, Date.now());
    } catch (err) {
      return;
    }
  }
}

let sending = false;

async function sendPerson() {
  if (sending) return false; // Enter の連打で二重に登録しない
  sending = true;
  try {
    const sentAt = Date.now();
    const res = await fetch('/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: inputs.name.value.trim(),
        speed: inputs.speed.value,
        connections: inputs.connections.value,
      }),
    });
    if (!res.ok) return false;

    const data = await res.json();
    syncClock(data.now, sentAt, Date.now());
    addPeople([data.person]);
    myId = data.person.id;

    for (const input of Object.values(inputs)) {
      input.value = '';
      fitWidth(input);
    }
    if (body.dataset.view === 'globe') faceMine();
    return true;
  } catch (err) {
    console.warn('送信できませんでした', err);
    return false;
  } finally {
    sending = false;
  }
}

// 空のまま Enter を押しても進まない。最後の問いでは、送信できたときだけ進む
async function submit(current) {
  const input = inputs[current];
  if (!input.value.trim()) return;

  const next = STAGES[STAGES.indexOf(current) + 1];
  if (next === 'home' && !(await sendPerson())) return;
  goTo(next);
}

for (const [key, input] of Object.entries(inputs)) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(key);
    }
  });
}

window.addEventListener('keydown', (e) => {
  if (body.hasAttribute('data-loading')) return; // ロゴが消えるまでは待つ
  if (e.target instanceof HTMLInputElement) return; // 入力中の Space は文字として扱う

  if (stage() === 'intro') {
    e.preventDefault();
    goTo('name');
    return;
  }

  if (stage() !== 'home') return;

  if (e.code === 'Space') {
    e.preventDefault();
    const toGlobe = body.dataset.view !== 'globe';
    body.dataset.view = toGlobe ? 'globe' : 'map';
    if (!toGlobe) selected = null; // 地図に戻ったら一覧は閉じる
    if (toGlobe) faceMine();
  } else if (e.key === 'Enter') {
    // 次の人の入力へ。世界はそのまま残る
    e.preventDefault();
    goTo('name');
  }
});

// 球体：ドラッグで回す。動かさずに離したらクリック（名前を選ぶ）
canvas.addEventListener('pointerdown', (e) => {
  if (body.dataset.view !== 'globe') return;
  canvas.classList.add('dragging');
  canvas.setPointerCapture(e.pointerId);
  const startX = e.clientX, startY = e.clientY;
  let lastX = startX, lastY = startY;
  let moved = false;

  const move = (ev) => {
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > CLICK_SLOP) moved = true;
    yaw -= (ev.clientX - lastX) * DRAG_SPEED;
    pitch = Math.min(Math.PI / 2, Math.max(-Math.PI / 2, pitch + (ev.clientY - lastY) * DRAG_SPEED));
    lastX = ev.clientX;
    lastY = ev.clientY;
  };
  const end = (ev) => {
    canvas.classList.remove('dragging');
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', end);
    canvas.removeEventListener('pointercancel', end);
    if (ev.type === 'pointerup' && !moved) {
      selected = hit(ev.clientX, ev.clientY)?.person ?? null; // 何もないところを押したら閉じる
    }
  };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
});

// 名前の上では指のカーソルにする
canvas.addEventListener('pointermove', (e) => {
  const over = body.dataset.view === 'globe' && !canvas.classList.contains('dragging') && hit(e.clientX, e.clientY);
  canvas.classList.toggle('over-name', Boolean(over));
});

document.addEventListener('pointerdown', (e) => {
  if (body.hasAttribute('data-loading')) return;
  if (stage() === 'intro') goTo('name');
  else if (inputs[stage()] && e.target !== inputs[stage()]) {
    e.preventDefault(); // 入力欄の外を押してもフォーカスを外さない
    inputs[stage()].focus();
  }
});

window.addEventListener('resize', resize);

// =========================================================
// 起動
// =========================================================

resize();
document.fonts.load(LABEL_FONT).finally(() => {
  for (const input of Object.values(inputs)) fitWidth(input);
});
syncTime(3);
setInterval(syncTime, TIME_SYNC_MS);
poll();
setInterval(poll, POLL_MS);
requestAnimationFrame(frame);
