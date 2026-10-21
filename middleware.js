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
//
// 7. name と symbol は必須で、しかも String でなければならない
//      if (!(result.get("name") instanceof String)
//          || !(result.get("symbol") instanceof String))
//          throw new IOException("ヘッダ部の情報が不足しています");
//    → symbol が空でもキーを省略できない。省略すると譜面データに到達する前に
//      失敗し、ログは「難易度表 - <url> の読み込み失敗。」だけで原因が出ない。
//      JSON の数値も String ではないので弾かれる（level_order が "[1,2]" の表で
//      symbol や name に "0" や "12" が入っていると踏む）。
//      空文字は通る。tag が無ければ symbol が代用され（BMSTable.getTag）、
//      フォルダ名は "" + level = level になって name.length() > 0 を満たす。

// ルート直下の middleware.js は Vercel が Edge Middleware として扱う。
// matcher に一致したリクエストだけこのファイルが処理し、それ以外（/ の index.html など）は
// 静的配信のまま通る。middleware が自分でパスを解釈するので vercel.json の rewrite は不要。
export const config = { matcher: "/t/:path*" };

const CACHE = "public, max-age=600";
const BASE = (id) => `https://docs.google.com/spreadsheets/d/${id}`;
const HEADER_KEYS = ["name", "symbol", "level_order", "description", "tag", "mode"];

// Google へ同時に投げる本数。シート 1 枚が CSV 1 本なので、シートの枚数がそのまま
// 同時接続数になる。40 枚を超えるスプレッドシートを全部同時に取ると Google が 429 を
// 返す（Vercel の出口 IP は共有なので、自分の端末から叩くより早く制限に当たる）。
const CONCURRENCY = 4;

// 再試行するステータス。429 と 5xx は時間をおけば通ることがある。
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Google の取得に使える合計時間。再試行の待ちと、新しい取得を始めるかの判断に使う。
// Edge Middleware の実行時間上限は 25 秒なので、超えて 500 になるより
// 読めたシートだけで一覧を返すほうがよい。
const FETCH_BUDGET_MS = 15000;

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ステータスから利用者向けの説明を作る。429 を共有設定の問題と誤解させないため。 */
function describeStatus(status) {
  if (status === 429) {
    return "Google のレート制限（429）に当たりました。少し待ってから再読み込みしてください";
  }
  if ([401, 403, 404].includes(status)) {
    return "共有設定が「リンクを知っている全員が閲覧可」か確認してください";
  }
  return "Google スプレッドシートからの応答が異常です";
}

/**
 * Google から 1 本取得する。429 / 5xx は指数バックオフで数回だけ粘る。
 * Retry-After が付いていればそれに従う。
 *
 * deadline は呼び出し側で共有する。シートが多い表では再試行が何本も重なるので、
 * 1 本ずつに時間を与えると Edge Middleware の実行時間上限に届いてしまう。
 */
async function fetchText(url, deadline = Date.now() + FETCH_BUDGET_MS) {
  let wait = 500;

  for (;;) {
    const res = await fetch(url);
    if (res.ok) return res.text();

    // 読まない本文は明示的に捨てる（Edge ランタイムでは放置するとリークになる）
    res.body?.cancel().catch(() => { /* すでに閉じている場合は何もしない */ });

    const after = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(after) && after > 0 ? after * 1000 : wait;

    if (!RETRY_STATUS.has(res.status) || Date.now() + delay > deadline) {
      throw new Error(`HTTP ${res.status} — ${describeStatus(res.status)}`);
    }
    // ジッタを足して、同時に走っている取得が同じ瞬間に再試行しないようにする
    await sleep(delay + Math.random() * 250);
    wait = Math.min(wait * 2, 4000);
  }
}

/** items を最大 limit 本の並列で map する。入力と同じ順序で返す。 */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;

  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- シートの読み込み

/**
 * シート一覧（{name, gid} の配列）を得る。シート名も gid も決め打ちしない。
 * /htmlview に items.push({name:"…", …, gid:"…"}) が埋まっているので、そこから取る。
 * CSV は読まないので、スプレッドシートの枚数に関係なくリクエストは 1 本。
 */
async function loadSheetList(id, deadline) {
  const html = await fetchText(`${BASE(id)}/htmlview`, deadline);
  const found = [...html.matchAll(/items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?gid:\s*"(\d+)"/g)];
  if (!found.length) throw new Error("シート一覧を取得できませんでした");

  return found.map(([, name, gid]) => ({ name: JSON.parse(`"${name}"`), gid }));
}

/** シート 1 枚の CSV を読んで {name, gid, keys, records} にする。 */
async function loadSheet(id, meta, deadline) {
  const csv = await fetchText(`${BASE(id)}/export?format=csv&gid=${meta.gid}`, deadline);
  return { ...meta, ...toRecords(csv) };
}

const isDataSheet = (s) =>
  s.records.length > 0 && (s.keys.includes("md5") || s.keys.includes("sha256"));

const isHeaderSheet = (s) =>
  !isDataSheet(s) && s.records.length > 0 && HEADER_KEYS.some((k) => s.keys.includes(k));

/**
 * スプレッドシートを丸ごと読む。一覧ページ専用。
 *
 * 枚数ぶんの CSV を取るので、CONCURRENCY 本までに絞って投げる。
 * 1 枚読めなかっただけで一覧全体を 502 にしないよう、失敗したシートと
 * 時間切れで読まなかったシートは空（keys/records なし・failed）として扱い、
 * 一覧には「不明」で出す。表そのものは個別のページから読めるので実害はない。
 *
 * 返り値:
 *   sheets     全シート [{name, gid, keys, records, failed?}]
 *   dataSheets md5/sha256 列を持つシート = 難易度表
 *   headerRows ヘッダシートの各行。name 列でデータシートに対応づける
 */
async function loadWorkbook(id, list, deadline) {
  const sheets = await mapPool(list, CONCURRENCY, async (meta) => {
    try {
      if (Date.now() >= deadline) throw new Error("時間切れ");
      return await loadSheet(id, meta, deadline);
    } catch {
      return { ...meta, keys: [], records: [], failed: true };
    }
  });

  const dataSheets = sheets.filter(isDataSheet);
  const headerSheet = sheets.find(isHeaderSheet);

  return { sheets, dataSheets, headerSheet, headerRows: headerSheet?.records ?? [] };
}

/**
 * 難易度表 1 つ分だけを読む。表ページ・header.json・data.json 用。
 *
 * ここで必要なのは対象のデータシートとヘッダシートの 2 枚だけである。全部読むと
 * シートが 40 枚あるスプレッドシートでは CSV が 40 本になって 429 を踏むので、
 * まず名前（または gid）で対象を引き、そのあとヘッダシートを探して見つかり次第打ち切る。
 * ヘッダシートが先頭にある表が多いので、実際のリクエストは数本で済む。
 *
 * 失敗時は {error} を返す。
 */
async function loadTable(id, list, key, deadline) {
  const meta = findSheet(list, key);
  if (!meta) {
    let shown = key;
    try { shown = decodeURIComponent(key); } catch { /* 不正なエスケープはそのまま出す */ }
    return { error: `「${shown}」というシートはありません。\nシート一覧: ${list.map((s) => s.name).join(" / ")}` };
  }

  const sheet = await loadSheet(id, meta, deadline);
  if (!isDataSheet(sheet)) {
    return { error: `「${sheet.name}」は難易度表ではありません（md5 / sha256 の列がありません）。` };
  }

  // ヘッダシートが無い表もある（header.json は name と symbol だけで成立する）。
  // 探している途中で失敗・時間切れになっても、そこで打ち切って表自体は返す。
  const rest = list.filter((m) => m.gid !== meta.gid);
  let headerSheet = null;
  let dataSheets = 1;  // 対象のシート
  let unread = rest.length;

  // 最初の 1 枚だけは単独で読む。ヘッダシートが先頭のタブになっている表が
  // ほとんどなので、それだけで当たれば CSV は 2 本（対象 + ヘッダ）で済む。
  // 後ろにあるほど本数が増える（1 → 5 → 9 → …）。README で先頭に置くよう案内している。
  for (let i = 0, step = 1; i < rest.length && !headerSheet && Date.now() < deadline;
    i += step, step = CONCURRENCY) {
    let batch;
    try {
      batch = await mapPool(rest.slice(i, i + step), CONCURRENCY, (m) => loadSheet(id, m, deadline));
    } catch {
      break;
    }
    unread -= batch.length;

    for (const s of batch) {
      if (isDataSheet(s)) dataSheets++;
      else if (!headerSheet && isHeaderSheet(s)) headerSheet = s;
    }
  }

  return {
    sheet,
    headerSheet,
    headerRows: headerSheet?.records ?? [],
    // buildTable の「name が一致しなくてもヘッダ行を使う」フォールバック用。
    // 打ち切って読んでいないシートが残っていれば表の数が確定しないので false。
    singleTable: dataSheets === 1 && unread === 0,
  };
}

/**
 * URL の 1 セグメントからシートを引く。{name, gid} を持つものなら何でも渡せる
 * （CSV を読む前のシート一覧でも、読み終わったシートでも引ける）。
 * rewrite を経由すると percent-encoding が残る場合があるので、素・1回デコード・2回デコードを試し、
 * 最後に gid でも照合する（タブ名に / が入っていて名前では指せない場合の逃げ道）。
 */
function findSheet(sheets, key) {
  const cands = new Set([key]);
  for (let i = 0; i < 2; i++) {
    for (const c of [...cands]) {
      try { cands.add(decodeURIComponent(c)); } catch { /* 不正なエスケープは無視 */ }
    }
  }
  return sheets.find((s) => cands.has(s.name)) ?? sheets.find((s) => s.gid === key) ?? null;
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
  // name と symbol は必須かつ String でなければならない（制約 7）。
  // セルが空でも symbol のキーを落とせないので、ここで必ず文字列として埋める。
  // coerce が "12" を数値にしてしまうため、数値になったものも文字列へ戻す。
  header.name = String(header.name ?? "") || sheet.name; // 空ならタブ名を表の名前にする
  header.symbol = header.symbol == null ? "" : String(header.symbol);
  const symbol = header.symbol;

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

    // 読めなかったシートは種別が判定できない。リンクだけは出して個別に開かせる
    // （一覧は全シートを取るので、ここだけ 429 に当たることがある）。
    if (s.failed) {
      return `                    <tr>
                        <td><a href="/t/${esc(id)}/${seg}/">${esc(s.name)}</a></td>
                        <td class="text-muted">不明（読み込み失敗）</td>
                        <td class="text-end">—</td><td>—</td>
                    </tr>`;
    }

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

            // href に入れてよい URL だけを通す。
            // url / url_diff はスプレッドシート由来の任意の文字列なので、そのまま
            // href に入れると "javascript:..." を踏ませられる。表の持ち主以外が
            // 編集できるシートもあるため、http(s) 以外は弾いてリンクにしない。
            //
            // 正規表現を使っていないのは、このスクリプトがテンプレートリテラルの
            // 中にあるため。/^https?:\/\//i と書くと \/ が / に解釈されて
            // /^https?://i … が出力され、// 以降が行コメントになる。結果
            // return /^https?:/ だけが残り、常に truthy を返して検査が無効になる。
            function safeUrl(u) {
                if (!u) return null;
                var s = String(u).trim();
                var l = s.toLowerCase();
                return (l.indexOf("http://") === 0 || l.indexOf("https://") === 0) ? s : null;
            }

            // セルを1つ作る。href が有効ならリンクにし、そうでなければ素のテキスト。
            // 中身は必ず .text() で入れる（曲名に < や & が入っていても壊れない）。
            function cell(width, text, href) {
                var td = $("<td></td>").attr("width", width);
                var url = safeUrl(href);
                if (url) {
                    $("<a target='_blank' rel='noopener'></a>")
                        .attr("href", url).text(text).appendTo(td);
                } else {
                    td.text(text);
                }
                return td;
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

                        // Level → url_diff（差分の配布元）
                        // Title → Stellaverse IR の譜面ページ（LR2IR は現在アクセスできない）
                        // Artist → url（本体の配布元）
                        // url / url_diff が空の行はリンクにせず素のテキストで出す。
                        cell("5%", mark + level, e.url_diff).appendTo(tr);
                        cell("45%", e.title,
                            e.md5 ? "https://ir.stellabms.xyz/charts/" + encodeURIComponent(e.md5) : null)
                            .appendTo(tr);
                        cell("40%", e.artist || "", e.url).appendTo(tr);
                        cell("10%", e.comment || "", null).appendTo(tr);
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

  // 取得の時間予算はリクエスト全体で 1 つ。シートごとに与えると合計で上限を超える。
  const deadline = Date.now() + FETCH_BUDGET_MS;

  let list;
  try {
    list = await loadSheetList(id, deadline);
  } catch (e) {
    return fail(`スプレッドシートを読めませんでした: ${e.message}`, 502);
  }

  // /t/<ID>/ → シート一覧。ここだけは全シートの CSV が必要になる
  if (!table) {
    try {
      return listPage(id, await loadWorkbook(id, list, deadline), url.origin);
    } catch (e) {
      return fail(`スプレッドシートを読めませんでした: ${e.message}`, 502);
    }
  }

  // 表ページ・header.json・data.json は対象のシートとヘッダシートだけ読む
  let t;
  try {
    t = await loadTable(id, list, table, deadline);
  } catch (e) {
    return fail(`難易度表を読めませんでした: ${e.message}`, 502);
  }
  if (t.error) return fail(t.error, 404);

  let built;
  try {
    built = buildTable(t.sheet, t);
  } catch (e) {
    return fail(`難易度表を生成できませんでした: ${e.message}`, 502);
  }

  if (file === "header.json") return json(built.header);
  if (file === "data.json") return json(built.data);
  return tablePage(id, t.sheet, built.header, url.origin);
}
