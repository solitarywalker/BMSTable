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
const HEADER_KEYS = ["name", "symbol", "level_order", "description", "tag", "mode", "course"];

// ヘッダ行からそのまま header.json に流さない列。
// level_order は配列に直してから入れ（制約 2）、course はシート名なので段位に展開する。
const HEADER_SKIP = new Set(["level_order", "course"]);

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

/**
 * 段位認定シートか。**name 列があって md5 / sha256 列もある**のが目印。
 *
 * 段位シートは難易度表と同じ列（level / title / artist / url / url_diff）を持てるので、
 * それらでは区別できない。区別できるのは name 列である。
 *
 *   難易度表のデータシート … 譜面名は title。name 列は持たない
 *   段位認定シート        … name = 段位名。level は譜面自体のレベル
 *   ヘッダシート          … name は持つが md5 / sha256 は持たない
 *
 * level_order を持つシートはヘッダシートなので除く。
 */
const isCourseSheet = (s) =>
  s.records.length > 0 &&
  s.keys.includes("name") &&
  (s.keys.includes("md5") || s.keys.includes("sha256")) &&
  !s.keys.includes("level_order");

const isDataSheet = (s) =>
  !isCourseSheet(s) && s.records.length > 0 && (s.keys.includes("md5") || s.keys.includes("sha256"));

const isHeaderSheet = (s) =>
  !isDataSheet(s) && !isCourseSheet(s) &&
  s.records.length > 0 && HEADER_KEYS.some((k) => s.keys.includes(k));

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
 * データシートに対応するヘッダ行を引く。**一致する行が無ければ null**。
 *
 * name 列がタブ名と一致するものを使う。表が 1 つだけでヘッダ行も 1 つだけなら、
 * name が一致しなくてもそれを使う。loadTable（course 列を読む）と buildTable で
 * 同じ行を選ばないと、段位だけ別の表のものになる。
 *
 * null を返すのは呼び出し側で警告を出すため。ヘッダシートが読めていても name が
 * タブ名と食い違っていると、symbol / description / level_order / course が
 * まとめて無視される。黙って落とすと気付けない（headerMissing では拾えない）。
 */
function pickHeaderRow(sheet, { headerRows, singleTable }) {
  return headerRows.find((r) => r.name === sheet.name)
    ?? (singleTable && headerRows.length === 1 ? headerRows[0] : null);
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
  if (isCourseSheet(sheet)) return loadCourse(id, list, sheet, deadline);
  if (!isDataSheet(sheet)) {
    return { error: `「${sheet.name}」は難易度表ではありません（md5 / sha256 の列がありません）。` };
  }

  // ヘッダシートは「対象を除いた先頭のタブ」1 枚しか見ない。外れたら探さず打ち切る。
  //
  // 探し続けると、リクエスト数がスプレッドシートの構成次第で膨らむ。ヘッダシートが
  // 後ろにあるほど増え（CSV 1 → 5 → 9 → …）、ヘッダシートを置いていない表では
  // 見つかるまで打ち切れないので毎回全シートを読むことになる。1 枚に固定すれば
  // どんな構成でも必ず 3 リクエスト（htmlview + 対象 + 1 枚）で終わる。
  //
  // 代わりにヘッダシートを先頭に置いていない表はヘッダを読めなくなる。黙って
  // name / symbol / description / level_order が変わると気付けないので、
  // headerMissing を返してページ側で知らせる（README「ヘッダシートの位置」）。
  const rest = list.filter((m) => m.gid !== meta.gid);
  let first = null;

  if (rest.length) {
    try {
      first = await loadSheet(id, rest[0], deadline);
    } catch { /* 読めなければヘッダ無しで表を返す */ }
  }
  const headerSheet = first && isHeaderSheet(first) ? first : null;
  const headerRows = headerSheet?.records ?? [];

  // buildTable の「name が一致しなくてもヘッダ行を使う」フォールバック用。
  // 先頭 1 枚しか読まないので、シートが 2 枚（ヘッダ + データ）のときだけ確定する。
  const singleTable = rest.length === 0 || (rest.length === 1 && first != null && !isDataSheet(first));

  // 段位認定シートは、ヘッダ行の course 列にタブ名（または gid）が書かれている場合だけ読む。
  // 空欄なら 1 本も増えないので、段位を持たない表は 3 リクエストのまま。持つ表だけ 4 本。
  // ヘッダシートと違って「探す」ことはしない。どのタブかは course 列が名指ししている。
  const headerRow = pickHeaderRow(sheet, { headerRows, singleTable });
  const courseKey = (headerRow?.course ?? "").trim();
  let courseSheet = null;

  if (courseKey) {
    const courseMeta = findSheet(rest, courseKey);
    if (courseMeta) {
      try {
        // ヘッダ探しで読んだ 1 枚が指定先そのものなら、取り直さない
        const cs = courseMeta.gid === first?.gid ? first : await loadSheet(id, courseMeta, deadline);
        if (isCourseSheet(cs)) courseSheet = cs;
      } catch { /* 読めなければ段位なしで表を返す */ }
    }
  }

  return {
    sheet,
    headerSheet,
    headerRows,
    singleTable,
    courseSheet,
    // 他にシートがあるのにヘッダが取れていない。ヘッダシートを置いていない表でも
    // 立つので、文言は「読んでいない」であって「無い」ではない。
    headerMissing: rest.length > 0 && !headerSheet,
    // ヘッダシートは読めたが、このタブ名に一致する name の行が無い。
    // symbol / description / level_order / course がまとめて無視されるので、
    // 選べる name を添えてページで知らせる（headerMissing とは別の症状）。
    headerUnmatched: headerSheet && !headerRow
      ? headerRows.map((r) => r.name).filter(Boolean)
      : null,
    // course 列が名指ししたシートが読めなかった / 段位シートの形になっていない。
    // 黙って段位が消えると気付けないのでページで知らせる。
    courseMissing: courseKey && !courseSheet ? courseKey : null,
  };
}

/**
 * 段位認定シート 1 枚を段位ページ用に読む。loadTable から呼ばれる。
 *
 * 段位は単独の難易度表にならないので、この URL には登録先の header.json が無い。
 * 代わりに「この段位を載せている難易度表」を探し、その表の header.json を
 * 登録 URL として案内する（meta name=bmstable もそれを指すので、こちらの URL を
 * beatoraja に登録しても難易度表ごと読まれる）。
 *
 * 載せている表はヘッダシートの course 列から引く。見つかったらその表のデータシートも
 * 読み、md5 → 曲名・レベルの対応を作って課題曲を曲名で出す。
 * リクエストは htmlview + 段位シート + ヘッダシート + データシート の 4 本。
 */
async function loadCourse(id, list, sheet, deadline) {
  const rest = list.filter((m) => m.gid !== sheet.gid);
  let first = null;

  if (rest.length) {
    try {
      first = await loadSheet(id, rest[0], deadline);
    } catch { /* 読めなければ登録 URL 無しで段位だけ出す */ }
  }
  const headerSheet = first && isHeaderSheet(first) ? first : null;
  const headerRows = headerSheet?.records ?? [];

  // course 列がこのシートを名指ししているヘッダ行 = この段位を載せている表。
  // ヘッダ行の name 列はデータシートのタブ名なので、シート一覧で実在を確かめる。
  const ownerRows = headerRows.filter((r) => {
    const key = (r.course ?? "").trim();
    return key === sheet.name || key === sheet.gid;
  });
  const owners = ownerRows.map((r) => findSheet(rest, r.name)).filter(Boolean);
  const symbol = String(ownerRows[0]?.symbol ?? "");

  // course 列はこのシートを指しているのに、その行の name 列に一致するタブが無い。
  // 「course 列の書き忘れ」とは原因が違うので、ページで言い分ける。
  const ownerUnmatched = ownerRows.length && !owners.length
    ? ownerRows.map((r) => r.name).filter(Boolean)
    : null;

  // 段位シートが自分で曲名を持っていれば、ここで完結する（3 リクエスト）。
  // md5 しか書かれていない課題曲があるときだけ、曲名を引くために表のデータシートを
  // 1 枚読む（4 リクエスト）。読めなくても段位ページ自体は md5 のまま出せる。
  let course = buildCourse(sheet, { symbol });
  const needsTitles = course.flat().some((c) => courseCharts(c).some((e) => !e.title));

  if (needsTitles && owners.length) {
    try {
      const data = owners[0].gid === first?.gid ? first : await loadSheet(id, owners[0], deadline);
      const built = buildTable(data, { headerRows, headerSheet, singleTable: false, courseSheet: null });

      const byHash = new Map();
      for (const e of built.data) {
        if (e.md5) byHash.set(e.md5, e);
        if (e.sha256) byHash.set(e.sha256, e);
      }
      course = buildCourse(sheet, { symbol: built.header.symbol, resolve: (h) => byHash.get(h) });
    } catch { /* 曲名が出ないだけ。md5 で表示する */ }
  }

  return {
    courseSheet: sheet,
    owners: owners.map((m) => m.name),
    course,
    symbol,
    headerMissing: rest.length > 0 && !headerSheet,
    ownerUnmatched,
    sheetNames: list.map((m) => m.name),
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
 * セル 1 つを文字列の配列にする。level_order・段位の md5・constraint が同じ書式を使う。
 * 受ける書式: [1,2,3] / ["A","B"] / [A,B] / 1,2,3 / A,B
 *
 * [A,B] のように角括弧の中が JSON として不正な場合（クォートの無い文字列レベル。
 * sl0 や ▼ 系の表でありうる）、JSON.parse は失敗する。そのまま split すると
 * "[A" と "B]" という存在しない要素ができるので、角括弧を剥がしてから split する。
 * セル内改行も区切りとして扱う（md5 を縦に並べて書けるようにする）。
 */
function toList(cell) {
  const s = (cell ?? "").trim();
  if (!s) return [];

  let a = null;
  if (s.startsWith("[")) {
    try { a = JSON.parse(s); } catch { /* クォート無しの要素。下で角括弧を剥がす */ }
  }
  if (!Array.isArray(a)) a = s.replace(/^\[/, "").replace(/\]$/, "").split(/[,\n]/);

  return a
    .map((v) => String(v).trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

/** level_order は必ず JSON 配列でなければならない（制約 2, 3）。空欄は null。 */
function toLevelOrder(cell) {
  const out = toList(cell);
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

// ---------------------------------------------------------------- 段位認定
//
// header.json の course は Course[][]（グループの配列）だが、グループは 1 つだけ出す。
//
// beatoraja はこの入れ子を捨てる。TableDataAccessor$DifficultyTableAccessor が
// Stream.of(course).flatMap(...) で平らにし、TableData.course は CourseData[] の
// 一次元配列になる。グループ名を入れる場所も JSON に無い。つまり分けても
// 選曲画面に並ぶ順序が変わるだけでフォルダは分かれないので、シート側に
// 切り分けの列は置かない。順序はシートの行順をそのまま使う。
//
// 1 件の形（bms.table.Course のフィールドのうち、beatoraja の挙動に効くものだけ書く）:
//   {name, constraint[], trophy[{name, missrate, scorerate}], md5[] / sha256[]}
//
// style は出さない。bms.table.Course には style フィールドがあるものの、
// 読み戻すのは encodeJSONTableHeader（header.json の書き出し）だけで、
// CourseData（beatoraja が実際に使う型）には style が無いため選曲にも演奏にも効かない。
// NEW GENERATION が自分の表ページの配色に使っているキーで、Satellite / Stella は出していない。
//
// 譜面リストは md5 の配列・sha256 の配列・charts[{md5|sha256, title}] の 3 形式が
// 認められている（bms.table.DifficultyTableParser が読む文字列で確認）。ここでは
// title を持たない md5 / sha256 の配列で出す。

// beatoraja が受ける constraint の文字列（CourseData$CourseDataConstraint の name）。
// getValue は知らない文字列に null を返すので、ここに無いものは落とす。
const CONSTRAINTS = new Set([
  "grade", "grade_mirror", "grade_random",
  "no_speed", "no_good", "no_great",
  "gauge_lr2", "gauge_5k", "gauge_7k", "gauge_9k", "gauge_24k",
  "ln", "cn", "hcn",
]);

// constraint 空欄の既定値。beatoraja が旧 grade キーを course に変換するときと同じ組。
const DEFAULT_CONSTRAINT = ["grade_mirror", "gauge_lr2"];

// trophy を名前だけで書いたときに補う閾値。段位認定で実際に使われているのはこの 3 つだけ。
const MEDALS = {
  bronzemedal: { missrate: 7.5, scorerate: 0.0 },
  silvermedal: { missrate: 5.0, scorerate: 70.0 },
  goldmedal: { missrate: 2.5, scorerate: 85.0 },
};
const DEFAULT_TROPHY = Object.entries(MEDALS).map(([name, v]) => ({ name, ...v }));

// trophy の側の style も出さない。bms.table.Course$Trophy のフィールドは
// パーサが読むだけで誰も読み戻さず、CourseData$TrophyData にも存在しない。
const TROPHY_KEYS = new Set(["name", "missrate", "scorerate"]);

// trophy セルの key: value を 1 組ずつ拾う。キーのクォートは任意、値はクォート付きでも
// 素でもよい。括弧（[] {}）と区切り（,）は読み飛ばすので、JSON らしい書き方でも通る。
const TROPHY_PAIR = /(["']?)([A-Za-z_]\w*)\1\s*:\s*(?:(["'])(.*?)\3|([^,\]}]*))/g;

// md5 / sha256 はハッシュの長さで振り分ける。列をまたいで混ざっていても正しく分かれる。
const HASH_KEY = { 32: "md5", 64: "sha256" };

/**
 * md5 / sha256 のセルから {md5?: [...], sha256?: [...]} を作る。
 *
 * toList を通さず、セルから 16 進の並びを直接拾う。toList は `[` で始まるセルを
 * まず JSON として読むので、`[11111111111111111111111111111111,2222…]` のように
 * **全桁が数字の md5** だと数値の配列として解釈され、`1.1111111111111111e+31` に
 * なって消えてしまう（level_order では数値になって構わないが、ハッシュでは困る）。
 * 正規表現で拾えば区切り（角括弧・カンマ・改行）も書式も問わない。
 */
function toHashes(cells) {
  const out = {};
  for (const c of cells) {
    for (const h of String(c ?? "").match(/[0-9a-fA-F]{32,64}/g) ?? []) {
      const key = HASH_KEY[h.length]; // 32 でも 64 でもない長さは捨てる
      if (key) (out[key] ??= []).push(h.toLowerCase());
    }
  }
  return out;
}

/** constraint セルを beatoraja が解釈できる文字列の配列にする。空欄は既定値。 */
function toConstraint(cell) {
  const a = toList(cell)
    .map((v) => v.toLowerCase().replace(/[\s-]+/g, "_"))
    .filter((v) => CONSTRAINTS.has(v));
  return a.length ? [...new Set(a)] : DEFAULT_CONSTRAINT;
}

/**
 * trophy セルを配列にする。
 *
 *   空欄                                        → 銅・銀・金の既定 3 段
 *   [] / -                                      → メダルなし
 *   [silvermedal,goldmedal]                     → 名前だけ。既知メダルの閾値を補う
 *   ["name": "goldmedal", "missrate": 2.5, …]   → 明示。name で次の 1 件に切り替わる
 */
function toTrophy(cell) {
  const s = (cell ?? "").trim();
  if (!s) return DEFAULT_TROPHY;
  if (s === "[]" || s === "-") return [];

  // key: value が 1 つも無ければ名前の並びとして読む
  if (!s.includes(":")) {
    const a = toList(s).filter((n) => MEDALS[n]).map((n) => ({ name: n, ...MEDALS[n] }));
    return a.length ? a : DEFAULT_TROPHY;
  }

  const out = [];
  let cur = null;

  for (const [, , key, , quoted, bare] of s.matchAll(TROPHY_PAIR)) {
    const k = key.toLowerCase();
    if (!TROPHY_KEYS.has(k)) continue;

    const v = (quoted ?? bare ?? "").trim().replace(/^["']|["']$/g, "").trim();
    if (k === "name") {
      if (!v) continue;
      cur = { name: v };
      out.push(cur);
      continue;
    }
    if (!cur) continue; // name より前に書かれた値は属する先が無いので捨てる
    cur[k] = Number.isFinite(Number(v)) ? Number(v) : 0;
  }
  if (!out.length) return DEFAULT_TROPHY;

  // 閾値を省いた件は既知メダルの値で埋める（無ければ 0 = 条件なし）
  for (const t of out) {
    const d = MEDALS[t.name] ?? { missrate: 0, scorerate: 0 };
    t.missrate ??= d.missrate;
    t.scorerate ??= d.scorerate;
  }
  return out;
}

/** 課題曲 1 件に書ける曲情報。beatoraja は title / artist / url / url_diff を SongData へ写す。 */
const CHART_KEYS = ["title", "artist", "url", "url_diff", "level"];

/**
 * 段位シートの 1 行を、その行が指す課題曲の配列にする。
 *
 * 1 行 = 1 課題曲（難易度表と同じ列を持つ形）なら 1 件で、その行の曲情報を結び付ける。
 * 1 行に md5 を並べた形なら複数件で、どの譜面の情報かを決められないので曲情報は付けない。
 */
function rowCharts(r, symbol) {
  const hashes = toHashes([r.md5, r.sha256]);
  const out = [
    ...(hashes.md5 ?? []).map((h) => ({ md5: h })),
    ...(hashes.sha256 ?? []).map((h) => ({ sha256: h })),
  ];
  if (out.length !== 1) return out;

  // level は譜面自体のレベル（段位名は name 列）。表と同じく symbol は外す（制約 4）
  let level = (r.level ?? "").trim();
  if (symbol && level.startsWith(symbol)) level = level.slice(symbol.length).trim();

  const values = { ...r, level };
  for (const k of CHART_KEYS) if (values[k]) out[0][k] = values[k];
  return out;
}

/**
 * 段位認定シート 1 枚を course（Course[][]）にする。**name 列が段位名**で、
 * 同じ name の行が 1 つの段位になる。name の初出順・行順をそのまま保つ
 * （段位は初段→皆伝、課題曲も並びに意味があるので並べ替えない）。グループは常に 1 つ。
 *
 * resolve(hash) を渡すと、シートに書かれていない曲情報をそこから補う
 * （段位シートが md5 だけの場合に、難易度表のデータから曲名を埋めるため）。
 * 有効な行が 0 件なら空配列を返し、呼び出し側が course キーごと落とす。
 */
function buildCourse(sheet, { resolve, symbol } = {}) {
  const groups = new Map();

  for (const r of sheet.records) {
    const name = (r.name ?? "").trim();
    if (!name) continue; // name の無い行はどの段位にも属さない

    const charts = rowCharts(r, symbol);
    if (!charts.length) continue;

    if (!groups.has(name)) groups.set(name, { name, constraint: null, trophy: null, charts: [] });
    const g = groups.get(name);

    // constraint と trophy は段位ごとの値。1 行 = 1 課題曲 の形では同じ段位が
    // 複数行に跨るので、その段位で最初に書かれた値を採る（全行に書いても同じ）。
    if (g.constraint == null && (r.constraint ?? "").trim()) g.constraint = toConstraint(r.constraint);
    if (g.trophy == null && (r.trophy ?? "").trim()) g.trophy = toTrophy(r.trophy);

    g.charts.push(...charts);
  }

  const courses = [...groups.values()].map((g) => {
    for (const e of g.charts) {
      const found = resolve?.(e.md5 ?? e.sha256);
      if (found) for (const k of CHART_KEYS) if (!e[k] && found[k]) e[k] = found[k];
    }

    const course = {
      name: g.name,
      constraint: g.constraint ?? DEFAULT_CONSTRAINT,
      trophy: g.trophy ?? DEFAULT_TROPHY,
    };

    // 曲情報が 1 つも無いなら md5 / sha256 の配列で出す（charts にすると冗長なだけ）
    if (g.charts.some((e) => CHART_KEYS.some((k) => e[k]))) {
      course.charts = g.charts;
    } else {
      for (const e of g.charts) {
        const key = e.md5 ? "md5" : "sha256";
        (course[key] ??= []).push(e[key]);
      }
    }
    return course;
  });

  return courses.length ? [courses] : [];
}

/** course の 1 件から課題曲を {md5|sha256, title, …} の配列で取り出す（両方の出力形に対応）。 */
const courseCharts = (c) => c.charts ?? [
  ...(c.md5 ?? []).map((h) => ({ md5: h })),
  ...(c.sha256 ?? []).map((h) => ({ sha256: h })),
];

// ---------------------------------------------------------------- 表の生成

/**
 * データシート 1 枚を {header, data} にする。
 * ヘッダ行は name 列がタブ名と一致するものを使う。
 * 表が 1 つだけでヘッダ行も 1 つだけなら、name が一致しなくてもそれを使う。
 */
function buildTable(sheet, { headerRows, headerSheet, singleTable, courseSheet }) {
  const row = pickHeaderRow(sheet, { headerRows, singleTable }) ?? {};

  const header = {};
  for (const k of headerSheet?.keys ?? []) {
    if (!HEADER_SKIP.has(k) && row[k]) header[k] = coerce(row[k]);
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

  // 段位認定。有効な行が 0 件のシートを指していたらキーごと落とす
  // （course: [] を出すと選曲画面に空のコースフォルダができる）。
  //
  // 段位シートに曲情報が書かれていない課題曲は、この表のデータから md5 で補う。
  // すでに読んである data を引くだけなのでリクエストは増えない。曲情報が付いた
  // 課題曲は charts 形式で出るので、beatoraja 側では持っていない譜面でも
  // 曲名が表示され、url / url_diff から配布元も辿れる。
  if (courseSheet) {
    const byHash = new Map();
    for (const e of data) {
      if (e.md5) byHash.set(e.md5, e);
      if (e.sha256) byHash.set(e.sha256, e);
    }

    const course = buildCourse(courseSheet, { symbol, resolve: (h) => byHash.get(h) });
    if (course.length) header.course = course;
  }

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

/**
 * テキストを 1 つの HTML 片にする。href が http(s) ならリンクにし、そうでなければ素のテキスト。
 * url / url_diff はスプレッドシート由来の任意の文字列なので、`javascript:` などを弾く
 * （表ページの safeUrl と同じ基準。表の持ち主以外が編集できるシートもある）。
 */
const link = (text, href) => {
  const s = String(href ?? "").trim();
  return /^https?:\/\//i.test(s)
    ? `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(text)}</a>`
    : esc(text);
};

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

// 警告から構成の直し方へ案内する先。見出しのアンカーは GitHub の採番に合わせてある。
const README = "https://github.com/solitarywalker/BMSTable";

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

    if (isCourseSheet(s)) {
      // 段位シートは単独では難易度表にならない。登録 URL は、この段位を
      // 載せている表（ヘッダシートの course 列がこのシートを指す行）と同じものになる。
      const owner = wb.headerRows.find((r) => {
        const key = (r.course ?? "").trim();
        return key === s.name || key === s.gid;
      });
      const url = owner
        ? `${origin}/t/${esc(id)}/${encodeURIComponent(owner.name)}/header.json`
        : "—";

      return `                    <tr>
                        <td><a href="/t/${esc(id)}/${seg}/">${esc(s.name)}</a></td>
                        <td>段位認定</td>
                        <td class="text-end">${buildCourse(s).flat().length}段位</td>
                        <td>${owner ? `<code class="user-select-all">${url}</code>` : "—"}</td>
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

  // 各表のページはヘッダシートを先頭のタブ 1 枚しか探さない（loadTable）。一覧は
  // 全シートを読むのでヘッダシートが何枚目かを知っている。ここでしか気付けないので言う。
  const headerAt = wb.headerSheet ? wb.sheets.indexOf(wb.headerSheet) : -1;
  const misplaced = headerAt <= 0 ? "" : `
        <div class="alert alert-warning" role="alert">
            <p class="mb-0">ヘッダシート「${esc(wb.headerSheet.name)}」が${headerAt + 1}枚目のタブにあります。
                各難易度表のページは<strong>先頭のタブ</strong>しか見ないので、このままでは
                <code>name</code>・<code>symbol</code>・<code>description</code>・<code>level_order</code>
                が反映されません。<a href="${README}#ヘッダシートの位置" target="_blank" rel="noopener">タブを先頭に移動</a>してください。</p>
        </div>`;

  // ヘッダ行の name とデータシートのタブ名の食い違い。一覧は全シートを読むので
  // どのタブにも対応しないヘッダ行をここで洗い出せる。食い違うとそのヘッダ行の
  // 内容（symbol / description / level_order / course）がまるごと無視される。
  const orphans = (wb.headerRows ?? [])
    .map((r) => r.name)
    .filter((n) => n && !wb.sheets.some((s) => s.name === n));

  const mismatch = !orphans.length ? "" : `
        <div class="alert alert-warning" role="alert">
            <p class="mb-1">ヘッダシートの <code>name</code> が、どのタブ名とも一致していません:
                ${orphans.map((n) => `<code>${esc(n)}</code>`).join(" / ")}</p>
            <p class="mb-0">一致しないヘッダ行は使われないので、その表の
                <code>symbol</code>・<code>description</code>・<code>level_order</code>・<code>course</code>
                がまるごと無視されます。<strong><code>name</code> 列の値はデータシートのタブ名と
                一致させてください</strong>（<a href="${README}#ヘッダシート任意" target="_blank" rel="noopener">ヘッダシート</a>）。</p>
        </div>`;

  return htmlResponse(`${HEAD("シート一覧")}${BOOTSTRAP}
</head>
${NAV("シート一覧", "/")}

    <div class="container">${misplaced}${mismatch}
        <p>このスプレッドシートに含まれるシートです。
            <code>md5</code> または <code>sha256</code> の列を持つシートが難易度表として読まれます。
            <code>name</code> と <code>md5</code> を持ち <code>title</code>・<code>level</code> が無いシートは
            <a href="${README}#段位認定course" target="_blank" rel="noopener">段位認定</a>として扱い、
            ヘッダシートの <code>course</code> 列から参照されたときだけ表に付きます。</p>

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

// ---------------------------------------------------------------- 段位認定ページ

const IR_CHART = (md5) => `https://ir.stellabms.xyz/charts/${encodeURIComponent(md5)}`;

/** メダル 1 つを「goldmedal ミス2.5% スコア85%」の形にする。 */
const trophyText = (t) => `${t.name} ミス${t.missrate}% スコア${t.scorerate}%`;

/**
 * 段位認定シートのページ。段位ごとに課題曲を並べる。
 *
 * 登録 URL はこの段位を載せている難易度表の header.json にする。段位シート自体には
 * header.json が無く（難易度表ではないので data.json も作れない）、段位は表の
 * header.json の course に入って配信されるため、登録先は表と同じ URL でよい。
 * meta name=bmstable も同じものを指すので、この URL を beatoraja に登録しても通る。
 */
function coursePage(id, origin, {
  courseSheet, owners, course: grouped, symbol, headerMissing, ownerUnmatched, sheetNames,
}) {
  const course = grouped.flat();
  const tableUrl = owners.length
    ? `${origin}/t/${esc(id)}/${encodeURIComponent(owners[0])}/header.json`
    : null;

  // 載せている表が分からない場合。原因は 3 つあって直し方が違うので言い分ける。
  // 段位だけ出しても beatoraja には登録できないので、必ず知らせる。
  const cause = headerMissing
    ? "ヘッダシートを読んでいません（<strong>先頭のタブ</strong>にある場合だけ読みます）。"
    : ownerUnmatched
      ? `<code>course</code> 列は「${esc(courseSheet.name)}」を指していますが、その行の
                <code>name</code> 列「${esc(ownerUnmatched.join("」「"))}」に一致するタブがありません。
                <strong><code>name</code> 列の値はデータシートのタブ名と一致させてください</strong>
                （タブ名: ${esc(sheetNames.join(" / "))}）。`
      : `ヘッダシートの <code>course</code> 列に「${esc(courseSheet.name)}」と書くと、その表の
                <code>header.json</code> に段位が入ります。`;

  const warning = tableUrl ? "" : `
        <div class="alert alert-warning mb-3" role="alert">
            <p class="mb-0">この段位を載せている難易度表が分かりません。${cause}
                <a href="${README}#段位認定course" target="_blank" rel="noopener">段位認定（course）</a></p>
        </div>`;

  const rows = course.map((c) => {
    const songs = courseCharts(c).map((e, i) => {
      const hash = e.md5 ?? e.sha256;
      // 曲名が無い課題曲は md5 をそのまま出す（どの表にも載っていない譜面）
      const title = e.title || hash;
      const level = e.level ? `${symbol}${e.level}` : "";

      return `                    <tr>
                        <td class="text-end text-muted" width="5%">${i + 1}</td>
                        <td width="8%">${link(level, e.url_diff)}</td>
                        <td width="52%">${link(title, e.md5 ? IR_CHART(e.md5) : null)}</td>
                        <td>${link(e.artist ?? "", e.url)}</td>
                    </tr>`;
    }).join("\n");

    return `                    <tr class="table-dark">
                        <td colspan="4">
                            <b>${esc(c.name)}</b>
                            <span class="small ms-2">${esc((c.constraint ?? []).join(" "))}</span>
                            <span class="small ms-2 text-muted">${esc((c.trophy ?? []).map(trophyText).join("　"))}</span>
                        </td>
                    </tr>
${songs}`;
  }).join("\n");

  return htmlResponse(`${HEAD(courseSheet.name)}
    <!--
      登録 URL は難易度表と同じ header.json。段位シートに header.json は無い。
      beatoraja / LR2 はこの1行を行単位の文字列一致で探すので、属性の順序を変えないこと。
    -->${tableUrl ? `
    <meta name="bmstable" content="${tableUrl}" />` : ""}${BOOTSTRAP}
</head>
${NAV(courseSheet.name, `/t/${esc(id)}/`)}

    <div class="container">${warning}
        <div class="alert alert-success mb-3" role="alert">
            <p class="mb-0">段位認定${course.length ? `（${course.length}段位）` : ""}です。${owners.length
    ? `難易度表「<a href="/t/${esc(id)}/${encodeURIComponent(owners[0])}/">${esc(owners[0])}</a>」に付いています。`
    : ""}</p>${tableUrl ? `
            <hr>
            <p class="mb-1">beatoraja に登録する URL（<strong>難易度表と同じ</strong>です。登録すると表と段位の両方が入ります）:</p>
            <p class="mb-0"><code class="user-select-all">${tableUrl}</code></p>` : ""}
        </div>

        <div class="table-responsive">
            <table class="table table-light table-striped table-hover">
                <thead class="table-dark">
                    <tr><th class="text-end">#</th><th>Level</th><th>Title</th><th>Artist</th></tr>
                </thead>
                <tbody>
${rows}
                </tbody>
            </table>
        </div>

        <p class="small text-muted">
            曲名は段位シートに書かれていればそれを使い、無ければ難易度表のデータシートから
            <code>md5</code> で引きます。どちらにも無い譜面は <code>md5</code> のまま表示します。
            リンク先は Level が <code>url_diff</code>（差分）、Title が Stellaverse IR の譜面ページ、
            Artist が <code>url</code>（本体）です。
        </p>
    </div>
</body>

</html>
`);
}

// ---------------------------------------------------------------- 難易度表ページ

function tablePage(id, sheet, header, origin, {
  headerMissing, headerUnmatched, courseMissing, courseSheet,
}) {
  const seg = encodeURIComponent(sheet.name);
  const headerUrl = `${origin}/t/${esc(id)}/${seg}/header.json`;

  // ヘッダシートは先頭のタブ 1 枚しか見ない（loadTable）。外れると表の名前や
  // symbol が黙って変わるので、ここで言う。ヘッダシートを置いていない表でも
  // 出るため、最後の 1 文で「それなら正常」と断ってある。
  const warning = !headerMissing ? "" : `
        <div class="alert alert-warning mb-3" role="alert">
            <p class="mb-0">ヘッダシートを読んでいません。表の名前・<code>symbol</code>・<code>description</code>・<code>level_order</code>
                はこのシートの内容から決めた値です。ヘッダシートは<strong>先頭のタブ</strong>にある場合だけ読むので、
                反映したい場合は<a href="${README}#ヘッダシートの位置" target="_blank" rel="noopener">タブを先頭に移動</a>してください。
                ヘッダシートを置いていない場合はこの表示で正常です。</p>
        </div>`;

  // ヘッダシートは読めたが、このタブ名に一致する name の行が無い。
  // ヘッダの内容がまるごと無視されるので、タブ名と選べる name を並べて出す。
  const unmatched = !headerUnmatched ? "" : `
        <div class="alert alert-warning mb-3" role="alert">
            <p class="mb-1">ヘッダシートに、このタブ名「<code>${esc(sheet.name)}</code>」に一致する
                <code>name</code> の行がありません。<strong><code>symbol</code>・<code>description</code>・<code>level_order</code>・<code>course</code>
                はすべて無視されています。</strong></p>
            <p class="mb-0">ヘッダシートにある <code>name</code>: ${headerUnmatched.length
    ? headerUnmatched.map((n) => `<code>${esc(n)}</code>`).join(" / ")
    : "（なし）"}<br>
                <code>name</code> 列の値をタブ名に合わせるか、タブ名を <code>name</code> に合わせてください
                （<a href="${README}#ヘッダシート任意" target="_blank" rel="noopener">ヘッダシート</a>）。</p>
        </div>`;

  // course 列が名指ししたシートが読めていない。段位が黙って消えるので言う。
  const courseWarning = !courseMissing ? "" : `
        <div class="alert alert-warning mb-3" role="alert">
            <p class="mb-0">ヘッダシートの <code>course</code> 列が指している「${esc(courseMissing)}」を段位認定として読めませんでした。
                タブ名が合っているか、<code>name</code> 列と <code>md5</code> 列があるかを確認してください
                （<a href="${README}#段位認定course" target="_blank" rel="noopener">段位認定（course）</a>）。</p>
        </div>`;

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

    <div class="container">${warning}${unmatched}${courseWarning}
        <div class="alert alert-success mb-3" role="alert">
            <p>${esc(header.description).replace(/\n/g, "<br>")}</p>
            <p class="mb-0">難易度表の読み込みと表示に数秒かかります。</p>${courseSheet
    ? `\n            <p class="mb-0">段位認定: <a href="/t/${esc(id)}/${encodeURIComponent(courseSheet.name)}/">${esc(courseSheet.name)}</a></p>`
    : ""}
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

  // 段位認定シートは難易度表ではないので header.json / data.json を持たない。
  // 登録先はこの段位を載せている表と同じ URL なので、そこへ案内する。
  if (t.courseSheet && !t.sheet) {
    if (file === "header.json" || file === "data.json") {
      const to = t.owners.length
        ? `${url.origin}/t/${id}/${encodeURIComponent(t.owners[0])}/${file}`
        : "（ヘッダシートの course 列にこのシート名を書いてください）";
      return fail(`「${t.courseSheet.name}」は段位認定のシートです。${file} はありません。\n段位は難易度表の header.json に入ります: ${to}`, 404);
    }
    return coursePage(id, url.origin, t);
  }

  let built;
  try {
    built = buildTable(t.sheet, t);
  } catch (e) {
    return fail(`難易度表を生成できませんでした: ${e.message}`, 502);
  }

  if (file === "header.json") return json(built.header);
  if (file === "data.json") return json(built.data);
  return tablePage(id, t.sheet, built.header, url.origin, t);
}
