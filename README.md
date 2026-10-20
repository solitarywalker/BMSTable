# BMSTable

公開された Google スプレッドシートを BMS 難易度表として配信します。
**データは保存しません。** リクエストのたびにスプレッドシートから取得して変換するだけです。

```
https://bmstable.vercel.app/t/<スプレッドシートID>/<表の名前>/header.json
```

この URL を beatoraja の難易度表に登録します。ID を差し替えれば誰の表でも読めます。事前登録は不要です。
**1 つのスプレッドシートに複数の難易度表（データシート）を置けます。**

| ルート | 内容 |
|---|---|
| `/t/<ID>/` | スプレッドシート内のシート一覧 |
| `/t/<ID>/<表の名前>/` | その難易度表のページ |
| `/t/<ID>/<表の名前>/header.json` | beatoraja に登録する URL |
| `/t/<ID>/<表の名前>/data.json` | 譜面データ（`header.json` から相対参照） |
| `/` | スプレッドシートの URL から一覧ページへ飛ぶページ |

`data.json` は **`level_order` の順 → 曲名順**に並べ替えて返します。
スプレッドシートの行順には依存しないので、シートを並べ替えたり行を追記しても順序は安定します。
曲名の比較は `Intl.Collator("ja", { numeric: true })` です
（漢字は ICU 日本語照合の順。読み順にするにはシートに読みの列が必要です）。

`<表の名前>` はデータシートのタブ名です（URL エンコードされます）。
タブ名に `/` が含まれて指定できない場合は、代わりに **gid** を使えます。

| status | 意味 |
|---|---|
| 200 | 成功 |
| 400 | ID の形式が不正 |
| 404 | ルートが存在しない / その名前の難易度表が無い（本文に候補名を出します） |
| 502 | スプレッドシートが非公開 / 存在しない / 構成が条件を満たさない |

結果は 600 秒キャッシュします。

## スプレッドシート側の条件

シート名も `gid` も決め打ちしていません。**列名だけ**を見て役割を判定します。

### データシート（必須）

`md5` または `sha256` の列を持つシート。1 行目が列名、2 行目以降が 1 行 1 譜面。

| level | title | md5 | artist | comment |
|---|---|---|---|---|
| 18 | -+　 -EX- | bca300b4… | | |

- `level` と `title`、そして `md5` / `sha256` のどちらかが必須。欠けた行は読み飛ばす
- `artist` `comment` など**他の列はそのまま `data.json` に通る**
- **このシートのタブ名が URL の `<表の名前>` になる。** 対応するヘッダ行が無ければ表の名前にもなる

### ヘッダシート（任意）

`name` / `symbol` / `level_order` / `description` のいずれかの列を持つシート。1 行目が列名、**2 行目以降が 1 行 1 表**。

| name | description | symbol | level_order |
|---|---|---|---|
| さつき難易度表 | ふつうの表 | ☆ | `[1,2,3]` |
| おにレベル表 | きつい表 | ◆ | `[A,B]` |

- **`name` 列の値がデータシートのタブ名と一致する行**が、その表のヘッダとして使われる
- データシートが 1 枚だけ、ヘッダ行も 1 行だけなら、一致しなくてもその行を使う
- `level_order` は `[1,2,3]` / `["A","B"]` / `[A,B]` / `1,2,3` のいずれでもよい（配列に正規化する）
- ヘッダシートが無くても、データシートだけで成立する（表名はタブ名、`symbol` なし）

共有設定は**「リンクを知っている全員が閲覧可」**にしてください。

## beatoraja 側の制約

0.8.8 の jar を読んで確認し、実機で検証したものです。変換側で対処済みですが、
スプレッドシートを編集するときに関係します。

| 制約 | 根拠 | 対処 |
|---|---|---|
| 登録 URL は文字列として `.json` で終わる必要がある | `if (url.endsWith(".json"))` で header 直読みか HTML 解析かを分岐 | ID と表名を**クエリではなくパス**に入れている |
| `level_order` は JSON 配列でなければならない | `(List) values.get("level_order")` と無条件キャスト。文字列だと `ClassCastException` で表ごと失敗（ログは「読み込み失敗」だけ） | `"1,2,3"` でも配列に正規化 |
| `level_order` に無い `level` の譜面は消える | フォルダは `level_order` から作られ、`level` の文字列 `equals` で振り分け | 未知の `level` を `level_order` の末尾に追加 |
| `level` に `symbol` を含めると二重になる | 表示時に `symbol` が前置される | 先頭が `symbol` と一致したら外す |
| `★21(▼21)` のような注記は `level_order` に一致しない | 同上。一致しないと譜面が消える | 括弧部分を `level` から外し `comment` に移す |
| 相対 `data_url` の解決でクエリが落ちる | `url.substring(0, url.lastIndexOf('/') + 1) + data_url` | `data_url` は `"data.json"`。`header.json` と同じ階層に置く |
| Content-Type は見ていない | `new URL(s).openStream()` を直読み | 気にしなくてよい |

JavaScript も実行しません（HTML を行単位で読んで `<meta name="bmstable">` を探すだけ）。
そのため `/t/<ID>/<表の名前>/` の meta は**絶対 URL**にしてあります
（末尾スラッシュの有無で解決先が変わらないようにするため）。

なお `level_order` に `[A,B]` のようにクォート無しの要素を書いた場合、JSON としては不正なので
`JSON.parse` が失敗します。そのまま `,` で分割すると `[A` と `B]` という存在しないレベルができて
空のフォルダが並ぶため、角括弧を剥がしてから分割しています。`level` が空の行も、
`symbol` だけの空フォルダになるので読み飛ばします。

## ファイル構成

```
middleware.js   全部（ルーティング・シート取得・変換・一覧ページ・表ページ）
index.html      案内ページ（Vercel が静的配信する）
vercel.json     master 以外のブランチで自動デプロイを行わない設定
dev.mjs         ローカル確認用のサーバ（本番では使わない）
```

ルート直下の `middleware.js` は Vercel が Edge Middleware として扱います。
`export const config = { matcher: "/t/:path*" }` に一致したリクエストだけこのファイルが処理し、
`/` の `index.html` は静的配信のまま通ります。

middleware はリクエストされたパスをそのまま受け取るので、**`vercel.json` の rewrite は不要**です。
依存パッケージも無いので `package.json` もありません
（`export` 構文のみで、Vercel の Edge ランタイムはそのまま ESM として扱います）。

関数を `api/` に置く構成（`api/table.js` + `vercel.json` の rewrite）でも同じことができますが、
ファイルが 1 つ増えるので middleware にしています。

## ローカルで確認する

Node 18 以降が必要です（`Request` / `Response` / `fetch` がグローバルにあればよい）。

```
node dev.mjs          # → http://localhost:3000/
PORT=8080 node dev.mjs
```

本物の Google スプレッドシートを読むので、`index.html` に URL を貼るところから
表ページの表示まで通しで確認できます。**`middleware.js` を編集したらブラウザの
再読み込みだけでよく、サーバの再起動は要りません**（リクエストごとに読み直します）。

### `index.html` を `file://` で直接開いても動きません

ブラウザでファイルを開くだけでは、**変換を行うサーバが存在しない**ため動きません。
`index.html` は URL を組み立てるだけの入力フォームで、実体は `middleware.js` です。
`location.origin` も `file://` では使えないので、表示される URL も壊れます。

変換処理をクライアント側に移しても解決しません。理由は 2 つあり、どちらも回避不能です。

| 壁 | 内容 |
|---|---|
| CORS | `/htmlview` に CORS ヘッダが無い。`/export?format=csv` は最終応答には `Access-Control-Allow-Origin: *` が付くが、**最初の 307 リダイレクトには無い**。CORS はリダイレクト連鎖の各応答が検査を通る必要があるため失敗する（`file://` の opaque origin ならなおさら） |
| ESM | `file://` のスクリプトは opaque origin 扱いになり、ES モジュールとして読み込めない（Chrome / Firefox とも）。`middleware.js` を `import` できない |

静的ファイルサーバ（`python3 -m http.server` など）でも不十分です。`index.html` は
表示できますが、`/t/...` は middleware が実行されないので 404 になります。

### 本番と違う点

Vercel の Edge Middleware は Node ではなく V8 isolate で動きます。Node API が無く、
**ICU のデータも異なります**。`middleware.js` が `Intl.Collator` の生成失敗を拾って
コードポイント比較に落としているのはそのためで、`dev.mjs` で見える日本語の並び順は
本番と一致する保証がありません。**曲名順だけは本番でも目視してください。**

### `dev.mjs` の実装メモ

`dev.mjs` は `middleware.js` をソースとして読み、`data:` URL 経由で動的 `import` します。
`export` を持つ ES モジュールなのに `package.json` が無いため、Node は拡張子 `.js` を
CommonJS として解釈し、`import ... from "./middleware.js"` と書くと `export` が構文エラーに
なるからです。`package.json` を足せば解決しますが、Vercel 側のビルド設定の自動検出に
影響しかねないので避けています。

また、本番と同じく `/t/*` だけを middleware に渡し、残りは静的配信に落としています
（`config.matcher` の再現）。ここを揃えないとルーティングの挙動がずれます。

`dev.mjs` は本番にもデプロイされ `/dev.mjs` として静的配信されます（秘密情報は含みません）。
隠す場合は `.vercelignore` に追加してください。
