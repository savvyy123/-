// ロゴのローディング
// 読み込みが終わり、かつ最低表示時間を過ぎた時点でフェードアウトする。

const MIN_SHOW_MS = 1500; // 読み込みが一瞬で終わっても、ロゴはこの時間は見せる
const FADE_MS = 600;      // style.css の .loader の transition と揃える

(() => {
  const loader = document.getElementById('loader');
  const body = document.body;

  const pageLoaded = new Promise((resolve) => {
    if (document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve, { once: true });
  });

  // performance.now() はページを開いた瞬間からの経過時間
  const minShown = new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, MIN_SHOW_MS - performance.now()));
  });

  Promise.all([pageLoaded, document.fonts.ready, minShown]).then(() => {
    loader.classList.add('done');
    body.removeAttribute('data-loading'); // ここから画面1の操作を受け付ける
    setTimeout(() => loader.remove(), FADE_MS);
  });
})();
