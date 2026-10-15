// サーバーの時計。各画面はこれに合わせて点の位置を計算する。
// 時刻なのでキャッシュさせない
export default () =>
  new Response(JSON.stringify({ now: Date.now() }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Netlify-CDN-Cache-Control": "no-store",
    },
  });

export const config = { path: "/time" };
