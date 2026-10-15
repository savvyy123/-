// Number Space の世界（Netlify Functions 版）
//   GET  /people … 世界にいる全員
//   POST /people … 1人加える
//
// 保存先は Netlify Blobs。1人を1件として、別々のキーに保存する。
// 全員を1つにまとめると、同時に送信した人どうしの書き込みがぶつかって失敗するため
// （20人同時で6人が登録できなかった）。別々のキーなら何人同時でもぶつからない。

import { getStore } from "@netlify/blobs";

const PREFIX = "person/";

// ブラウザー側の入力制限だけに頼らず、ここでも確かめる
const NAME_MAX = 24;
const SPEED = /^[1-9]\d{0,2}$/;     // 1〜999
const CONNECTIONS = /^[1-9]\d?$/;   // 1〜99

// --- 球面の乱数（全員が同じ世界を見るため、出発点と向きはサーバーで決める） ---

// 球面上で均等にばらまく。緯度・経度を別々にランダムにすると極に集まるため
function randomOnSphere() {
  const z = Math.random() * 2 - 1;
  const t = Math.random() * 2 * Math.PI;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(t), r * Math.sin(t), z];
}

// p に接する、ランダムな向き
function randomTangent(p) {
  for (;;) {
    const r = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    const k = r[0] * p[0] + r[1] * p[1] + r[2] * p[2];
    const d = [r[0] - k * p[0], r[1] - k * p[1], r[2] - k * p[2]];
    const l = Math.hypot(...d);
    if (l > 1e-3) return d.map((v) => v / l);
  }
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// store を外から渡せるようにしておく（Netlify の外でも動作を確かめられるように）
export async function handle(req, store) {
  if (req.method === "GET") {
    const { blobs } = await store.list({ prefix: PREFIX });
    const people = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }))))
      .filter(Boolean)
      .sort((a, b) => a.bornAt - b.bornAt);
    return json(people, 200, {
      // 見ている人が多くても関数の呼び出しが増えないよう、Netlify の CDN に3秒だけ覚えさせる
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, s-maxage=3, stale-while-revalidate=10",
    });
  }

  if (req.method === "POST") {
    let input;
    try {
      input = await req.json();
    } catch {
      return json({ error: "invalid" }, 400);
    }

    const { name, speed, connections } = input ?? {};
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (
      trimmed === "" || trimmed.length > NAME_MAX ||
      !SPEED.test(String(speed)) ||
      !CONNECTIONS.test(String(connections))
    ) {
      return json({ error: "invalid" }, 400);
    }

    const p0 = randomOnSphere();
    const bornAt = Date.now();
    // キーは生まれた時刻＋乱数。時刻順に並び、同じミリ秒に2人来ても重ならない
    const id = `${String(bornAt).padStart(15, "0")}-${crypto.randomUUID().slice(0, 8)}`;
    const person = {
      id,
      name: trimmed,
      speed: Number(speed),
      connections: Number(connections),
      p0,
      d0: randomTangent(p0),
      bornAt,
    };

    await store.setJSON(PREFIX + id, person, { onlyIfNew: true });
    return json({ now: Date.now(), person }, 201);
  }

  return json({ error: "method not allowed" }, 405, { Allow: "GET, POST" });
}

// 書き込んだ直後に他の人の画面へ届くよう、読み書きとも strong にする
// （eventual だと反映に最大で1分ほどかかる）
export default (req) => handle(req, getStore({ name: "numberspace", consistency: "strong" }));

export const config = { path: "/people" };
