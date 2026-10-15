# Number Space

名前・速さ（km/s）・つながりの数を入力すると、球体の世界に点が1つ生まれる。
点はランダムな場所から、ランダムな向きへ、入力した速さで大円に沿って進み続ける。
近くの点どうしは線でつながり、離れるほど薄くなって、500km を超えると切れる。

ホームで Space を押すと、地図と球体が切り替わる。

## 構成

```
public/               画面（HTML / CSS / JS）
netlify/functions/
  people.mjs          GET /people（全員）・POST /people（1人加える）
  time.mjs            GET /time（サーバーの時計）
netlify.toml
```

保存先は Netlify Blobs（1人 = 1件）。Netlify にデプロイすれば、追加の設定なしで動く。

## 書体について

Neue Haas Grotesk Display（Commercial Type）の Trial 版を使っている。
Trial 版の規約では再配布と Web 埋め込み（`@font-face`）が許可されていないため、
`public/fonts/` はリポジトリに含めていない。

公開版では、閲覧者の端末にこの書体がインストールされていればそれを使い（`local()`）、
なければ Helvetica 系で表示される。
