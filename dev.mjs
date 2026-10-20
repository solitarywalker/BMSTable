// middleware.js をローカルの HTTP サーバとして動かす。ブラウザで実物を見るためのもの。
//
//   node dev.mjs            → http://localhost:3000/
//   PORT=8080 node dev.mjs
//
// 本物の Google スプレッドシートを読み、index.html から表ページまで通しで
// ブラウザで触れる。デプロイせずに実機確認するための唯一の手段である。
//
// file:// で index.html を直接開くのは不可能なので、これが最も近い代替である。
// 理由は 2 つあり、どちらもコード側では回避できない:
//   - Google の /htmlview に CORS ヘッダが無く、/export?format=csv は最初の 307
//     リダイレクトに CORS ヘッダが無い。CORS はリダイレクト連鎖の各応答が検査を
//     通る必要があるので、ブラウザから直接は読めない。file:// の opaque origin
//     (null) ではなおさらである。つまり変換をクライアント側へ移しても動かない。
//   - file:// のスクリプトは opaque origin 扱いになり、ES モジュールとして
//     読み込めない (Chrome / Firefox とも)。middleware.js を import できない。
//
// ---- 実装の注意 ----
//
// 1. middleware.js は data: URL 経由で動的 import する
//    export を持つ ES モジュールだが、このリポジトリに package.json が無いため
//    Node は .js を CommonJS として読み、export が構文エラーになる。ソースを
//    文字列にして data: URL にすれば ESM として扱われる。package.json を足すと
//    Vercel 側のビルド設定の自動検出に影響しかねないので、この形にしている。
//
// 2. リクエストごとに middleware.js を読み直す
//    data: URL の specifier は中身から作られるので、ファイルを編集すると
//    specifier が変わって別モジュールとして評価される。つまり middleware.js を
//    直したらブラウザを再読み込みするだけでよく、サーバの再起動は要らない。
//    中身が同じなら specifier も同じなので Node のモジュールキャッシュが効く。
//
// 3. Edge Middleware の関数シグネチャがそのまま (Request) => Response なので、
//    Node の http サーバとの変換を被せるだけで本番と同じコードパスが走る。
//
// ---- 本番と違う点 ----
//
// Vercel の Edge Middleware は Node ではなく V8 isolate で動く。Node API が無く、
// ICU のデータも異なる。middleware.js の collator が Intl.Collator の生成失敗を
// 拾っているのはそのためで、ここで見える日本語の並び順は本番では変わりうる。
// 曲名順だけは本番 (https://bmstable.vercel.app/) でも目視すること。

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const PORT = Number(process.env.PORT ?? 3000);
const ROOT = new URL("./", import.meta.url);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/** middleware.js を今のファイル内容で読み込む。編集が即反映される (上の注意 2)。 */
async function loadMiddleware() {
  const src = await readFile(new URL("middleware.js", ROOT), "utf8");
  const mod = await import(`data:text/javascript,${encodeURIComponent(src)}`);
  return mod.default;
}

/**
 * Vercel が middleware.js を呼ぶ条件を再現する。
 * 本番では config.matcher ("/t/:path*") に一致したものだけが middleware へ入り、
 * 残りは静的配信に落ちる。ここも同じ分岐にしておかないと挙動がずれる。
 */
const isMiddlewarePath = (pathname) => pathname === "/t" || pathname.startsWith("/t/");

/** リポジトリ直下の静的ファイルを返す。/ は index.html。 */
async function serveStatic(pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");

  // .. を含むパスはリポジトリの外へ出るので弾く
  if (rel.includes("..")) return new Response("Forbidden\n", { status: 403 });

  try {
    const body = await readFile(new URL(rel, ROOT));
    return new Response(body, {
      headers: { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" },
    });
  } catch {
    return new Response(`Not Found: ${pathname}\n`, {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

createServer(async (req, res) => {
  const host = req.headers.host ?? `localhost:${PORT}`;
  const url = new URL(req.url, `http://${host}`);

  let out;
  try {
    out = isMiddlewarePath(url.pathname)
      ? await (await loadMiddleware())(new Request(url, { method: req.method }))
      : await serveStatic(url.pathname);
  } catch (e) {
    // middleware.js が例外で落ちた場合。本番では 500 になって原因が見えないので、
    // ここではスタックをそのまま返して端末にも出す。
    console.error(e);
    out = new Response(`${e.stack ?? e}\n`, {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  console.log(`${res.statusCode = out.status} ${req.method} ${url.pathname}`);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}/ で待機中 (Ctrl+C で終了)`);
  console.log("middleware.js の編集は再起動なしで反映される。");
});
