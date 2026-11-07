"use strict";
var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { setInterval, clearInterval, setTimeout, clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
var { MailServices } = ChromeUtils.importESModule(
  "resource:///modules/MailServices.sys.mjs"
);
var { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);

function loadColumns() {
  for (const p of [
    "chrome://messenger/content/ThreadPaneColumns.mjs",
    "chrome://messenger/content/thread-pane-columns.mjs",
  ]) {
    try { return ChromeUtils.importESModule(p).ThreadPaneColumns; } catch (e) {}
  }
  throw new Error("ThreadPaneColumns not found");
}

const COL_ID = "authcols-auth";
const JA = (Services.locale.appLocaleAsBCP47 || "").startsWith("ja");
const T = JA
  ? { col: "認証", none: "なし", unchecked: "検証ヘッダーなし（未検証）" }
  : { col: "Auth", none: "none", unchecked: "No authentication header (not checked)" };
const HDRS = ["authentication-results", "arc-authentication-results"];
const KEYS = ["spf", "dkim", "dmarc"];
const BAD = ["fail", "softfail", "policy"];
const ERR = ["permerror", "temperror"];  // 判定できなかった

// ---- 補完：DBに検証ヘッダーがないメールは本体から読んで保存する ----
// デバッグ用ログ（公開版では出力しない）
function log() {}

const SCANNED = "x-authcols-scanned2";
const retries = new Map();   // uri -> 再試行回数
const queue = [];
const queued = new Set();
let running = false;

function enqueue(hdr, fromRetry = false) {
  try {
    if (hdr.getStringProperty(SCANNED)) return;   // 読み取り済み（ヘッダーなし確定）
    const uri = hdr.folder.getUriForMsg(hdr);
    if (queued.has(uri)) return;
    // 一度失敗したメールは、再描画のたびではなく再試行タイマーからだけ読みに行く
    if (!fromRetry && retries.has(uri)) return;
    queued.add(uri);
    queue.push({ hdr, uri });
    log("enqueue", uri);
    if (!running) setTimeout(runQueue, 0);
  } catch (e) { log("enqueue error", e); }
}

function readHeaders(uri) {
  return new Promise(resolve => {
    let data = "", finished = false;
    const finish = v => { if (!finished) { finished = true; resolve(v); } };
    const timer = setTimeout(() => { log("timeout", uri, "len=" + data.length); finish(data); }, 10000);   // 応答がなければ10秒で打ち切る
    const listener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener", "nsIRequestObserver"]),
      onStartRequest() {},
      onDataAvailable(req, stream, off, count) {
        data += NetUtil.readInputStreamToString(stream, count);
      },
      onStopRequest() { clearTimeout(timer); finish(data); },
    };
    try {
      MailServices.messageServiceFromURI(uri).streamHeaders(uri, listener, null, false);
    } catch (e) { log("streamHeaders error", uri, e); clearTimeout(timer); finish(""); }
  });
}

function extract(raw) {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, " ");
  const found = { "authentication-results": [], "arc-authentication-results": [] };
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^(arc-authentication-results|authentication-results):\s*(.*)$/i);
    if (m) found[m[1].toLowerCase()].push(m[2]);
  }
  return found;
}

async function runQueue() {
  running = true;
  let done = 0;
  while (queue.length) {
    const { hdr, uri } = queue.shift();
    try {
      const raw = await readHeaders(uri);
      const f = extract(raw);
      let found = false;
      for (const h of HDRS) {
        if (f[h].length) { hdr.setStringProperty(h, f[h].join(" ")); found = true; }
      }
      // ヘッダー部分を最後まで読めたのに認証ヘッダーがない → 本当に「なし」と確定
      const complete = /\r?\n\r?\n/.test(raw);
      log("read", uri, "len=" + raw.length, "found=" + found, "complete=" + complete);
      if (found || complete) {
        hdr.setStringProperty(SCANNED, "1");
        retries.delete(uri);
      } else {
        // 読めなかった（受信直後など）→ 30秒後に再試行（最大5回）
        const n = (retries.get(uri) || 0) + 1;
        retries.set(uri, n);
        if (n <= 5) setTimeout(() => enqueue(hdr, true), 30000);
      }
    } catch (e) { log("runQueue error", uri, e); }
    queued.delete(uri);
    if (++done % 20 === 0) refreshTrees();
  }
  refreshTrees();
  running = false;
}

const newMailListener = {
  msgAdded(hdr) { setTimeout(() => enqueue(hdr), 5000); },
};

function refreshTrees() {
  for (const win of Services.wm.getEnumerator("mail:3pane")) {
    for (const tab of win.gTabmail?.tabInfo || []) {
      try { tab.chromeBrowser?.contentDocument?.getElementById("threadTree")?.invalidate(); } catch (e) {}
    }
  }
}

// 各方式の結果を集める（例: {spf:["pass"], dkim:["pass","fail"], dmarc:[]}）
function collect(msgHdr) {
  const v = HDRS.map(h => msgHdr.getStringProperty(h) || "").join(" ");
  if (v.trim() === "") enqueue(msgHdr);
  const out = { checked: v.trim() !== "" };
  for (const k of KEYS) {
    const re = new RegExp("\\b" + k + "=([a-z]+)", "gi");
    out[k] = [...new Set([...v.matchAll(re)].map(m => m[1].toLowerCase()))];
  }
  return out;
}

// 方式ごとの判定: 失敗→red / 判定不能→error / pass→green / それ以外→yellow
function status(list) {
  if (list.some(x => BAD.includes(x))) return "red";
  if (list.some(x => ERR.includes(x))) return "error";
  if (list.includes("pass")) return "green";
  return "yellow";
}

// 総合判定: 失敗を含む→fail / 判定不能を含む→none / 両方合格→both / 片方合格→one / それ以外→none
function verdict(r) {
  if (!r.checked) return "unchecked";   // 検証ヘッダー自体がない（社内メール等）
  if (status(r.dmarc) === "red") return "fail";
  const a = status(r.spf), b = status(r.dkim);
  if (a === "red" || b === "red") return "fail";
  if (a === "error" || b === "error") return "none";
  if (a === "green" && b === "green") return "both";
  if (a === "green" || b === "green") return "one";
  return "none";
}

// 表示記号（日本語環境は◎○△✕◇、それ以外は英語圏で意味が通じる記号）
const SYM = JA
  ? { both: "◎", one: "○", none: "△", fail: "✕", unchecked: "◇" }
  : { both: "★", one: "✓", none: "?", fail: "☠", unchecked: "–" };
const COLOR_BY_KEY = { both: "#2e9e44", one: "#9acd32", none: "#e0b000", fail: "#e03030", unchecked: "#888888" };
const COLORS = Object.fromEntries(Object.entries(SYM).map(([k, v]) => [v, COLOR_BY_KEY[k]]));

function tooltip(r) {
  if (!r.checked) return T.unchecked;
  // DMARC はさくらが判定しないため、結果があるときだけ表示
  return KEYS.filter(k => k !== "dmarc" || r[k].length).map(k => `${k.toUpperCase()}: ${r[k].length ? r[k].join(", ") : T.none}`).join("\n");
}

// ---- ホバー表示：一覧のセルに title を付ける ----
const hooked = new WeakSet();

function onOver(event) {
  const td = event.target.closest?.("td");
  if (!td) return;
  const doc = td.ownerDocument;
  const tr = td.closest("tr");
  // 列の位置を見出しから特定
  const th = doc.getElementById(COL_ID) || doc.querySelector(`th[id="${COL_ID}"]`);
  if (!tr || !th) return;
  const isOurs =
    td.classList.contains(`${COL_ID}-column`) ||
    [...tr.children].indexOf(td) === [...th.parentNode.children].indexOf(th);
  if (!isOurs || typeof tr.index !== "number") return;
  const win = doc.defaultView;
  const view = win.gDBView || doc.getElementById("threadTree")?.view;
  try {
    const hdr = view.getMsgHdrAt(tr.index);
    td.title = tooltip(collect(hdr));
  } catch (e) {}
}

// ---- 文字色：一覧の描画を監視して記号に色を付ける ----
function columnIndex(doc) {
  const th = doc.getElementById(COL_ID);
  return th ? [...th.parentNode.children].indexOf(th) : -1;
}

function colorCells(tree) {
  const doc = tree.ownerDocument;
  const idx = columnIndex(doc);
  for (const tr of tree.querySelectorAll("tbody tr")) {
    const td = tr.querySelector(`td.${COL_ID}-column`) || (idx >= 0 ? tr.children[idx] : null);
    if (!td) continue;
    const c = COLORS[td.textContent.trim()];
    if (c && td.style.color !== c) {
      td.style.color = c;
      td.style.fontWeight = "bold";
      td.style.textAlign = "center";
    }
  }
}

const observers = new WeakMap();

function watchTree(tree) {
  const win = tree.ownerDocument.defaultView;
  let pending = false;
  const obs = new win.MutationObserver(() => {
    if (pending) return;
    pending = true;
    win.requestAnimationFrame(() => { pending = false; colorCells(tree); });
  });
  obs.observe(tree, { childList: true, subtree: true, characterData: true });
  observers.set(tree, obs);
  colorCells(tree);
}

function hookAll() {
  for (const win of Services.wm.getEnumerator("mail:3pane")) {
    const tabs = win.gTabmail?.tabInfo || [];
    for (const tab of tabs) {
      const doc = tab.chromeBrowser?.contentDocument;
      const tree = doc?.getElementById("threadTree");
      if (tree && !hooked.has(tree)) {
        tree.addEventListener("mouseover", onOver);
        watchTree(tree);
        hooked.add(tree);
      }
    }
  }
}

let timer = null;

this.authCols = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    return {
      authCols: {
        async register() {

          const TPC = loadColumns();
          // 旧版の2列を片付ける
          for (const old of ["authcols-spf", "authcols-dkim", COL_ID]) {
            try { TPC.removeCustomColumn(old); } catch (e) {}
          }
          TPC.addCustomColumn(COL_ID, {
            name: T.col,
            hidden: false,
            icon: false,
            resizable: true,
            sortable: false,
            textCallback: hdr => SYM[verdict(collect(hdr))],
          });

          // 新着メールの通知を受け取る
          try {
            MailServices.mfn.removeListener(newMailListener);
          } catch (e) {}
          MailServices.mfn.addListener(newMailListener, Ci.nsIMsgFolderNotificationService.msgAdded);

          // 新しく開いたタブ・ウィンドウにも付くよう定期的に確認
          hookAll();
          if (!timer) timer = setInterval(hookAll, 3000);
        },
      },
    };
  }
  onShutdown(isAppShutdown) {
    if (timer) { clearInterval(timer); timer = null; }
    try { MailServices.mfn.removeListener(newMailListener); } catch (e) {}
    if (isAppShutdown) return;
    try { loadColumns().removeCustomColumn(COL_ID); } catch (e) {}
    for (const win of Services.wm.getEnumerator("mail:3pane")) {
      for (const tab of win.gTabmail?.tabInfo || []) {
        const tree = tab.chromeBrowser?.contentDocument?.getElementById("threadTree");
        if (!tree) continue;
        tree.removeEventListener("mouseover", onOver);
        observers.get(tree)?.disconnect();
      }
    }
  }
};
