// 公開 Google スプレッドシートを BMS 難易度表として配信する。
// 1 つのスプレッドシートに複数の難易度表（データシート）を置ける。
//
//   /t/<ID>/                      スプレッドシート内のシート一覧
//   /t/<ID>/<表の名前>/            その難易度表のページ
//   /t/<ID>/<表の名前>/header.json beatoraja に登録する URL
//   /t/<ID>/<表の名前>/data.json   譜面データ（header.json から相対参照される）
//
// <表の名前> はデータシートのタブ名。gid でも指定できる（タブ名に / が入る場合の逃げ道）。
// 難易度表のデータは保存しない。リクエストのたびにスプレッドシートから取得する。
//
// ---- beatoraja 0.8.8 の実装を読んで確認した制約（すべて実機の jar で検証済み）----
//
// 1. 登録 URL が文字列として ".json" で終わるかで分岐する
//      if (url.endsWith(".json")) setHeadURL(url);   // header.json を直接読む
//      else                       setSourceURL(url); // HTML から <meta> を探す
//    → ID と表名はクエリではなくパスに入れる。
//      "…/header.json?id=X" は末尾が ".json" でないので HTML 扱いになって失敗する。
//      （クエリの最後が file=header.json なら endsWith は通るが、今度は下の 5 で
//        相対 data_url の解決がクエリごと切られて壊れる。どちらにしてもパスが正しい。）
//
// 2. level_order は必ず JSON 配列でなければならない
//      List list = (List) getValues().get("level_order");
//    → 文字列だと ClassCastException で表ごと読み込み失敗する。
//      ログは「難易度表 - <url> の読み込み失敗。」だけで原因が出ない。
//
// 3. フォルダは level_order から作られ、level の文字列 equals で振り分けられる
//      folder名 = tag + levelDescription[i]
//    → level_order に無い level の譜面は、どのフォルダにも入らず黙って消える。
//
// 4. level には symbol を含めない（表示時に前置されるので "★12" は "★★12" になる）
//
// 5. 相対 data_url は「URL の最後の / までを切って連結」で解決される
//      getAbsoluteURL: url.substring(0, url.lastIndexOf('/') + 1) + data_url
//    → header.json と data.json は同じ階層に置く。
//
// 6. Content-Type は見ていない。JavaScript も実行しない
//    （HTML を行単位で読んで <meta name="bmstable"> を探すだけ）

// ルート直下の middleware.js は Vercel が Edge Middleware として扱う。
// matcher に一致したリクエストだけこのファイルが処理し、それ以外（/ の index.html など）は
// 静的配信のまま通る。middleware が自分でパスを解釈するので vercel.json の rewrite は不要。
export const config = { matcher: "/t/:path*" };

const CACHE = "public, max-age=600";
const BASE = (id) => `https://docs.google.com/spreadsheets/d/${id}`;
const HEADER_KEYS = ["name", "symbol", "level_order", "description", "tag", "mode"];

// ---------------------------------------------------------------- CSV

/** RFC4180 準拠の最小パーサ。引用符内の改行・カンマ・"" を扱う（description に改行が入る）。 */
function parseCsv(text) {
  const src = text.replace(/^﻿/, "");
  const rows = [];
  let row = [], field = "", quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') { field += '"'; i++; } // "" は literal な "
      else quoted = false;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ",") { row.push(field); field = ""; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** 1行目を列名として {keys, records} にする。見出しが空の列と全セル空の行は捨てる。 */
function toRecords(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return { keys: [], records: [] };

  const cols = rows[0].map((k, i) => [k.trim(), i]).filter(([k]) => k);
  const records = rows.slice(1)
    .map((r) => Object.fromEntries(cols.map(([k, i]) => [k, (r[i] ?? "").trim()])))
    .filter((o) => Object.values(o).some((v) => v !== ""));

  return { keys: cols.map(([k]) => k), records };
}

// ---------------------------------------------------------------- Sheets

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — 共有設定が「リンクを知っている全員が閲覧可」か確認してください`);
  return res.text();
}

/**
 * スプレッドシートを丸ごと読む。シート名も gid も決め打ちしない。
 * /htmlview に items.push({name:"…", …, gid:"…"}) が埋まっているので、そこから gid を得る。
 *
 * 返り値:
 *   sheets     全シート [{name, gid, keys, records}]
 *   dataSheets md5/sha256 列を持つシート = 難易度表
 *   headerRows ヘッダシートの各行。name 列でデータシートに対応づける
 */
async function loadWorkbook(id) {
  const html = await fetchText(`${BASE(id)}/htmlview`);
  const found = [...html.matchAll(/items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?gid:\s*"(\d+)"/g)];
  if (!found.length) throw new Error("シート一覧を取得できませんでした");

  const sheets = await Promise.all(found.map(async ([, name, gid]) => ({
    name: JSON.parse(`"${name}"`),
    gid,
    ...toRecords(await fetchText(`${BASE(id)}/export?format=csv&gid=${gid}`)),
  })));

  const dataSheets = sheets.filter((s) => s.records.length && (s.keys.includes("md5") || s.keys.includes("sha256")));
  const headerSheet = sheets.find((s) => !dataSheets.includes(s) && s.records.length &&
    HEADER_KEYS.some((k) => s.keys.includes(k)));

  return { sheets, dataSheets, headerSheet, headerRows: headerSheet?.records ?? [] };
}

/**
 * URL の 1 セグメントからデータシートを引く。
 * rewrite を経由すると percent-encoding が残る場合があるので、素・1回デコード・2回デコードを試し、
 * 最後に gid でも照合する（タブ名に / が入っていて名前では指せない場合の逃げ道）。
 */
function findSheet(dataSheets, key) {
  const cands = new Set([key]);
  for (let i = 0; i < 2; i++) {
    for (const c of [...cands]) {
      try { cands.add(decodeURIComponent(c)); } catch { /* 不正なエスケープは無視 */ }
    }
  }
  return dataSheets.find((s) => cands.has(s.name)) ?? dataSheets.find((s) => s.gid === key) ?? null;
}

// ---------------------------------------------------------------- 変換

/**
 * level_order を必ず文字列の配列にする（制約 2, 3）。
 * 受ける書式: [1,2,3] / ["A","B"] / [A,B] / 1,2,3 / A,B
 *
 * [A,B] のように角括弧の中が JSON として不正な場合（クォートの無い文字列レベル。
 * sl0 や ▼ 系の表でありうる）、JSON.parse は失敗する。そのまま split すると
 * "[A" と "B]" という存在しないレベルができ、空のフォルダが並ぶので、
 * 角括弧を剥がしてから split する。
 */
function toLevelOrder(cell) {
  const s = (cell ?? "").trim();
  if (!s) return null;

  let a = null;
  if (s.startsWith("[")) {
    try { a = JSON.parse(s); } catch { /* クォート無しの要素。下で角括弧を剥がす */ }
  }
  if (!Array.isArray(a)) a = s.replace(/^\[/, "").replace(/\]$/, "").split(",");

  const out = a
    .map((v) => String(v).trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
  return out.length ? out : null;
}

/**
 * 曲名の比較。表ページ側の compareTitle と同じ基準にしてある。
 *
 * Edge ランタイムの ICU が日本語データを持っていない場合でも落ちないよう、
 * Collator が作れなければコードポイント比較に落とす。
 */
const collator = (() => {
  try { return new Intl.Collator("ja", { numeric: true, sensitivity: "variant" }); }
  catch { return null; }
})();

const compareTitle = (x, y) =>
  collator ? collator.compare(x ?? "", y ?? "") : (x < y ? -1 : x > y ? 1 : 0);

/** セルを JSON 値に寄せる。"[1,2]" → 配列, "12" → 数値。 */
function coerce(s) {
  if (/^[[{]/.test(s)) { try { return JSON.parse(s); } catch { /* 文字列として扱う */ } }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/**
 * データシート 1 枚を {header, data} にする。
 * ヘッダ行は name 列がタブ名と一致するものを使う。
 * 表が 1 つだけでヘッダ行も 1 つだけなら、name が一致しなくてもそれを使う。
 */
function buildTable(sheet, { headerRows, headerSheet, singleTable }) {
  const row = headerRows.find((r) => r.name === sheet.name)
    ?? (singleTable && headerRows.length === 1 ? headerRows[0] : null)
    ?? {};

  const header = {};
  for (const k of headerSheet?.keys ?? []) {
    if (k !== "level_order" && row[k]) header[k] = coerce(row[k]);
  }
  header.name ||= sheet.name; // name 列が無ければタブ名を表の名前にする
  const symbol = typeof header.symbol === "string" ? header.symbol : "";

  const levels = [];
  const data = [];

  for (const r of sheet.records) {
    if (!r.title || !(r.md5 || r.sha256)) continue; // title と md5/sha256 が無い行は表に載らない

    let level = (r.level ?? "").trim();
    if (symbol && level.startsWith(symbol)) level = level.slice(symbol.length).trim(); // 制約 4

    // "21(▼21)" の注記は level から外す。付けたままだと level_order に一致せず消える（制約 3）
    const note = level.match(/^(.*?)\s*[(（](.+?)[)）]\s*$/);
    if (note) level = note[1].trim();

    // level が空だと folder 名が symbol だけの空フォルダになるので載せない
    if (!level) continue;

    const out = { ...Object.fromEntries(Object.entries(r).filter(([, v]) => v)), level };
    if (out.md5) out.md5 = out.md5.toLowerCase();
    if (note) out.comment = out.comment ? `${out.comment} ${note[2]}` : note[2];

    if (!levels.includes(level)) levels.push(level);
    data.push(out);
  }
  if (!data.length) throw new Error(`「${sheet.name}」に有効な譜面が0件です`);

  // level_order に無い level は末尾に足す（黙って譜面が消えるのを防ぐ）
  const order = toLevelOrder(row.level_order) ?? [...levels].sort((a, b) => a - b || a.localeCompare(b));
  header.level_order = [...order, ...levels.filter((l) => !order.includes(l))];
  header.data_url = "data.json"; // header.json と同じ階層。相対で解決される（制約 5）

  // level_order の順 → 曲名順に並べ替える。
  // スプレッドシートの行順には頼らない（Google の並べ替えは漢字をコードポイント順にするため、
  // 一般的な日本語の順序と食い違う）。表ページと beatoraja のフォルダ内の順序が揃う。
  const rank = new Map(header.level_order.map((l, i) => [l, i]));
  data.sort((a, b) =>
    (rank.get(a.level) - rank.get(b.level)) || compareTitle(a.title, b.title));

  return { header, data };
}

// ---------------------------------------------------------------- HTTP 部品

const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const json = (body) => new Response(JSON.stringify(body, null, 2) + "\n", {
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": CACHE,
    "access-control-allow-origin": "*",
  },
});

const fail = (msg, status) => new Response(msg + "\n", {
  status,
  headers: { "content-type": "text/plain; charset=utf-8" },
});

const HEAD = (title) => `<!DOCTYPE html>
<html lang="ja">

<head>
    <title>${esc(title)}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">`;

const NAV = (title, back) => `
<body>
    <header class="mb-3">
        <nav class="navbar navbar-dark bg-dark">
            <div class="container-fluid">
                <span class="navbar-brand mb-0 h1">${esc(title)}</span>${back
    ? `\n                <a class="btn btn-sm btn-outline-light" href="${esc(back)}">${esc(back === "/" ? "トップへ" : "一覧へ")}</a>`
    : ""}
            </div>
        </nav>
    </header>`;

const BOOTSTRAP = `
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.0.0-beta1/dist/css/bootstrap.min.css" rel="stylesheet"
        integrity="sha384-giJF6kkoqNQ00vy+HMDP7azOuL0xtbfIcaT9wjKHr8RbDVddVHyTfAAsrekwKmP1" crossorigin="anonymous">`;

const htmlResponse = (body) => new Response(body,
  { headers: { "content-type": "text/html; charset=utf-8", "cache-control": CACHE } });

// ---------------------------------------------------------------- 一覧ページ

function listPage(id, wb, origin) {
  const rows = wb.sheets.map((s) => {
    const isData = wb.dataSheets.includes(s);
    const seg = encodeURIComponent(s.name);

    if (!isData) {
      const role = s === wb.headerSheet ? "ヘッダ" : "—";
      return `                    <tr class="text-muted">
                        <td>${esc(s.name)}</td><td>${role}</td><td class="text-end">—</td><td>—</td>
                    </tr>`;
    }

    let songs = "—";
    try {
      songs = String(buildTable(s, { ...wb, singleTable: wb.dataSheets.length === 1 }).data.length);
    } catch { songs = "0"; }

    return `                    <tr>
                        <td><a href="/t/${esc(id)}/${seg}/">${esc(s.name)}</a></td>
                        <td>難易度表</td>
                        <td class="text-end">${songs}</td>
                        <td><code class="user-select-all">${origin}/t/${esc(id)}/${seg}/header.json</code></td>
                    </tr>`;
  }).join("\n");

  return htmlResponse(`${HEAD("シート一覧")}${BOOTSTRAP}
</head>
${NAV("シート一覧", "/")}

    <div class="container">
        <p>このスプレッドシートに含まれるシートです。
            <code>md5</code> または <code>sha256</code> の列を持つシートが難易度表として読まれます。</p>

        <div class="table-responsive">
            <table class="table table-light table-striped table-hover">
                <thead class="table-dark">
                    <tr><th>シート名</th><th>種別</th><th class="text-end">譜面数</th><th>header.json</th></tr>
                </thead>
                <tbody>
${rows}
                </tbody>
            </table>
        </div>

        <p class="small text-muted">
            元データ: <a href="${BASE(esc(id))}/" target="_blank" rel="noopener">Google スプレッドシート</a>
        </p>
    </div>
</body>

</html>
`);
}

// ---------------------------------------------------------------- 難易度表ページ

function tablePage(id, sheet, header, origin) {
  const seg = encodeURIComponent(sheet.name);
  const headerUrl = `${origin}/t/${esc(id)}/${seg}/header.json`;

  return htmlResponse(`${HEAD(header.name)}
    <!--
      beatoraja / LR2 はこの1行を行単位の文字列一致で探し、4番目の " 区切りトークンを content とする。
      属性の順序を変えたり改行を挟んだりしないこと。
      絶対 URL にしてあるのは、末尾スラッシュの有無で解決先が変わらないようにするため。
    -->
    <meta name="bmstable" content="${headerUrl}" />
    <script src="https://code.jquery.com/jquery-2.2.4.min.js"></script>${BOOTSTRAP}
</head>
${NAV(header.name, `/t/${esc(id)}/`)}

    <div class="container">
        <div class="alert alert-success mb-3" role="alert">
            <p>${esc(header.description).replace(/\n/g, "<br>")}</p>
            <p class="mb-0">難易度表の読み込みと表示に数秒かかります。</p>
            <hr>
            <p class="mb-1">beatoraja に登録する URL:</p>
            <p class="mb-0"><code class="user-select-all">${headerUrl}</code></p>
        </div>

        <!--ここから難易度表本体-->
        <div class="table-responsive">
            <table class="table table-light table-striped table-hover" id="table_int"></table>
        </div>

        <script type="text/javascript">
            $(document).ready(function () {
                var meta = $("meta[name=bmstable]").attr("content");
                $.getJSON(meta, function (header) {
                    $.getJSON(new URL(header.data_url, meta).href, function (info) {
                        makeBMSTable(info, header.symbol || "", header.level_order);
                    });
                });
            });

            // 曲名の比較。Intl.Collator があれば日本語の照合順序を使う。
            // numeric: true で "Song 2" が "Song 10" より先に来る。
            //
            // スプレッドシートの行順には頼らない。Google スプレッドシートの並べ替えは
            // 漢字をコードポイント順にするので、「恋色…」が「感情の…」より先に来るなど
            // 一般的な日本語の順序と食い違う。表示側で毎回並べ直す。
            var collator = (window.Intl && Intl.Collator)
                ? new Intl.Collator("ja", { numeric: true, sensitivity: "variant" })
                : null;

            function compareTitle(a, b) {
                var x = a.title || "", y = b.title || "";
                if (collator) return collator.compare(x, y);
                return x < y ? -1 : x > y ? 1 : 0;
            }

            function makeBMSTable(info, mark, order) {
                var obj = $("#table_int");
                obj.html("");
                $("<thead class='table-dark'><tr><th>Level</th><th>Title</th><th>Artist</th><th>Comment</th></tr></thead><tbody>")
                    .appendTo(obj);

                // header.json の level_order の順に並べる。
                // data.json の行順に依存しないので、シートを並べ替えても表示が崩れない。
                var levels = (order && order.length) ? order : [];
                if (!levels.length) {
                    info.forEach(function (e) { if (levels.indexOf(e.level) < 0) levels.push(e.level); });
                }

                levels.forEach(function (level) {
                    // filter が新しい配列を返すので、そのまま sort してよい（info は壊さない）
                    var rows = info.filter(function (e) { return e.level === level; }).sort(compareTitle);
                    if (!rows.length) return;

                    $("<tr class='table-dark' style='text-align:center'><td colspan='4'><b>" +
                        mark + level + " (" + rows.length + "譜面)</b></td></tr>").appendTo(obj);

                    rows.forEach(function (e) {
                        var tr = $("<tr></tr>");
                        $("<td width='5%'></td>").text(mark + level).appendTo(tr);

                        // .text() で入れることで、曲名に < や & が入っていても壊れない
                        var td = $("<td width='45%'></td>");
                        if (e.md5) {
                            // Stellaverse IR の譜面ページ。LR2IR は現在アクセスできない。
                            $("<a target='_blank' rel='noopener'></a>")
                                .attr("href", "https://ir.stellabms.xyz/charts/" + encodeURIComponent(e.md5))
                                .text(e.title).appendTo(td);
                        } else {
                            td.text(e.title);
                        }
                        td.appendTo(tr);

                        $("<td width='40%'></td>").text(e.artist || "").appendTo(tr);
                        $("<td width='10%'></td>").text(e.comment || "").appendTo(tr);
                        tr.appendTo(obj);
                    });
                });

                $("</tbody>").appendTo(obj);
            }
        </script>
    </div>
</body>

</html>
`);
}

// ---------------------------------------------------------------- ルーティング

export default async function middleware(request) {
  const url = new URL(request.url);

  // middleware はリクエストされたパスをそのまま受け取るので、ここで直接切り分ける。
  // /t/<ID>  /t/<ID>/<表>  /t/<ID>/<表>/<file>  （末尾スラッシュは任意）
  const m = url.pathname.match(/^\/t\/([^/]+)(?:\/([^/]+))?(?:\/([^/]*))?\/?$/);
  if (!m) return fail("Not Found", 404);
  const [, id, table, file] = m;

  if (!/^[A-Za-z0-9_-]{20,80}$/.test(id)) return fail(`スプレッドシートIDの形式が不正です: ${id}`, 400);

  // /t/<ID>/<表>/<file> の file は header.json / data.json のみ。
  // 省略時（/t/<ID>/<表>/）はページを返す。
  if (file && !["header.json", "data.json", "index.html"].includes(file)) return fail("Not Found", 404);

  let wb;
  try {
    wb = await loadWorkbook(id);
  } catch (e) {
    return fail(`スプレッドシートを読めませんでした: ${e.message}`, 502);
  }

  // /t/<ID>/ → シート一覧
  if (!table) return listPage(id, wb, url.origin);

  const sheet = findSheet(wb.dataSheets, table);
  if (!sheet) {
    const names = wb.dataSheets.map((s) => s.name).join(" / ") || "（難易度表が1つもありません）";
    return fail(`「${decodeURIComponent(table)}」という難易度表はありません。\n候補: ${names}`, 404);
  }

  let built;
  try {
    built = buildTable(sheet, { ...wb, singleTable: wb.dataSheets.length === 1 });
  } catch (e) {
    return fail(`難易度表を生成できませんでした: ${e.message}`, 502);
  }

  if (file === "header.json") return json(built.header);
  if (file === "data.json") return json(built.data);
  return tablePage(id, sheet, built.header, url.origin);
}
