#!/usr/bin/env node
/* 調課雷達｜洗檔驗證器  validate-schedule.mjs
 *
 * 用途：JSON 交出去（或匯入 index.html）之前，先在這裡過一關。
 * 不管課表是誰洗的、在 chat 還是在 Claude Code 洗的，最後都跑同一套檢查。
 *
 *   node validate-schedule.mjs <schedule.json>
 *   node validate-schedule.mjs <新.json> --baseline <上學期.json>
 *
 * 判斷標準與 index.html 的 loadData()／auditData() 對齊，但**更嚴**：
 * 工具端只需要「不誤報」，洗檔端要「抓得出錯」，所以這裡多做三件工具做不到的事：
 *   1. 對開科目檢查 —— index.html 的重格判斷裡 week 排在「同科目」前面，
 *      有 week 標記就直接放行，所以「兩筆抄成同一科」工具永遠看不到。
 *   2. week 值互斥檢查 —— 工具只要看到 week 就跳過撞課判斷，兩筆都是「單」也不會吭聲。
 *   3. 姓名字元健檢 —— PDF 文字層壞掉時姓名會變成問號／缺字框。
 *
 * 離開碼：有 ❌ 錯誤 → 1；只有 ⚠️ 提醒 → 0。
 */

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/* ── 小工具 ───────────────────────────────────────────── */
const DAY = ["", "一", "二", "三", "四", "五"];
const cell = r => `${r.cls} 週${DAY[r.day] || r.day}第${r.period}節`;
const key = (...p) => p.join("|");
const groupBy = (arr, fn) => {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

const errors = [];   // ❌ 一定要修
const warns = [];    // ⚠️ 請確認
const notes = [];    // ℹ️ 只是告知
const sections = []; // 報告區塊

function load(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    console.error(`❌ 讀不到檔案：${path}\n   ${e.message}`);
    process.exit(2);
  }
  // 洗檔常見狀況：LLM 回傳的 JSON 前後夾了 ``` 圍欄或 BOM
  raw = raw.replace(/^﻿/, "").trim()
           .replace(/^```(?:json)?\s*/i, "")
           .replace(/```$/, "");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ ${path} 不是合法 JSON：${e.message}`);
    process.exit(2);
  }
  if (!Array.isArray(data)) {
    console.error(`❌ ${path} 最外層必須是陣列，實際是 ${typeof data}`);
    process.exit(2);
  }
  return data;
}

/* ── A. 欄位格式 ──────────────────────────────────────── */
const KNOWN = new Set(["cls", "day", "period", "subject", "teacher", "fixed", "flex", "week"]);

function checkShape(rows) {
  const bad = [];
  const unknown = new Map();
  rows.forEach((r, i) => {
    const at = `第 ${i + 1} 筆`;
    if (typeof r !== "object" || r === null) { bad.push(`${at}：不是物件`); return; }
    if (typeof r.cls !== "string" || !r.cls.trim())
      bad.push(`${at}：cls 必須是非空字串（現在是 ${JSON.stringify(r.cls)}）`);
    if (!Number.isInteger(r.day) || r.day < 1 || r.day > 5)
      bad.push(`${at}：day 必須是 1–5 的整數（現在是 ${JSON.stringify(r.day)}）`);
    if (!Number.isInteger(r.period) || r.period < 1 || r.period > 8)
      bad.push(`${at}：period 必須是 1–8 的整數（現在是 ${JSON.stringify(r.period)}）`);
    if (typeof r.subject !== "string" || !r.subject.trim())
      bad.push(`${at}：subject 必須是非空字串`);
    if (!("teacher" in r))
      bad.push(`${at}：缺 teacher 欄（沒有老師請填 "—"，不要整個省略）`);
    if ("week" in r && r.week !== "單" && r.week !== "雙")
      bad.push(`${at}：week 只能是 "單" 或 "雙"（現在是 ${JSON.stringify(r.week)}）`);
    if ("fixed" in r && r.fixed !== true)
      bad.push(`${at}：fixed 有值就必須是 true（不用就整個拿掉，不要寫 false）`);
    if ("flex" in r && r.flex !== true)
      bad.push(`${at}：flex 有值就必須是 true`);
    if (r.fixed && r.week)
      warns.push(`${cell(r)}「${r.subject}」同時有 fixed 與 week——隔週輪替是可對調的，通常不該標 fixed`);
    for (const k of Object.keys(r)) if (!KNOWN.has(k)) unknown.set(k, (unknown.get(k) || 0) + 1);
  });
  if (bad.length) {
    errors.push(...bad.slice(0, 20));
    if (bad.length > 20) errors.push(`（另有 ${bad.length - 20} 筆格式問題未列出）`);
  }
  for (const [k, n] of unknown) warns.push(`出現工具不認得的欄位 "${k}"（${n} 筆），匯入時會被忽略`);

  // 完全重複的筆數
  const seen = new Map();
  for (const r of rows) {
    const k = key(r.cls, r.day, r.period, r.subject, r.teacher, r.week || "");
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dupes = [...seen].filter(([, n]) => n > 1);
  if (dupes.length) {
    errors.push(`有 ${dupes.length} 組完全重複的資料：`);
    dupes.slice(0, 8).forEach(([k, n]) => errors.push(`   ${k.split("|").slice(0, 5).join(" / ")} ×${n}`));
  }
}

/* ── B. 重格（照 index.html loadData 的判斷順序，順序不可調換） ── */
function checkCells(rows) {
  const co = [], dup = [];
  for (const [, g] of groupBy(rows, r => key(r.cls, r.day, r.period))) {
    if (g.length < 2) continue;
    if (g.some(r => r.week)) continue;                                        // 1. 隔週輪替 → 合法
    if (new Set(g.map(r => r.subject)).size === 1) { co.push(g); continue; }  // 2. 同科目 → 共同授課
    if (g.every(r => r.fixed)) continue;                                      // 3. 全 fixed → 合法分組
    dup.push(g);                                                              // 4. 其餘 → 疑似重格
  }
  if (dup.length) {
    errors.push(`疑似重格 ${dup.length} 處（同一班同一節有多筆、又不符合任何合法例外，匯入後工具會標紅）：`);
    dup.slice(0, 10).forEach(g =>
      errors.push(`   ${cell(g[0])}：` + g.map(r => `${r.subject}·${r.teacher}`).join(" ＋ ")));
  }
  if (co.length) notes.push(`共同授課 ${co.length} 格（同格同科多位老師）——工具會標示「不列入對調」，確認這是你要的`);
  sections.push(["重格", dup.length ? `❌ ${dup.length} 處` : "✅ 無", `共同授課 ${co.length} 格`]);
}

/* ── C. 撞課（index.html auditData 的 predicate ＋ 更嚴的 week 互斥） ── */
function checkClash(rows) {
  // C-1 工具看得到的撞課：排除 缺教師／"—"／week／fixed
  const byTP = groupBy(
    rows.filter(r => r.teacher && r.teacher !== "—" && !r.week && !r.fixed),
    r => key(r.teacher, r.day, r.period));
  const clash = [...byTP.values()].filter(g => g.length > 1);
  if (clash.length) {
    errors.push(`疑似撞課 ${clash.length} 處（同一位老師同一節有多筆一般課）：`);
    clash.slice(0, 10).forEach(g =>
      errors.push(`   ${g[0].teacher} 週${DAY[g[0].day]}第${g[0].period}節：`
        + g.map(r => `${r.cls}·${r.subject}`).join(" ＋ ")));
  }

  // C-2 工具看不到的：同老師同節多筆 week，但 week 值沒有互斥（例如兩筆都「單」）
  const wk = groupBy(rows.filter(r => r.week && r.teacher && r.teacher !== "—"),
                     r => key(r.teacher, r.day, r.period));
  const badWk = [...wk.values()].filter(g => g.length > 1 && new Set(g.map(r => r.week)).size !== g.length);
  if (badWk.length) {
    errors.push(`隔週輪替撞課 ${badWk.length} 處（同一位老師同一節有多筆，但單／雙週沒有錯開——工具不會抓這個）：`);
    badWk.forEach(g =>
      errors.push(`   ${g[0].teacher} 週${DAY[g[0].day]}第${g[0].period}節：`
        + g.map(r => `${r.cls}·${r.subject}(${r.week}週)`).join(" ＋ ")));
  }
  sections.push(["撞課", (clash.length || badWk.length) ? `❌ ${clash.length + badWk.length} 處` : "✅ 無", ""]);
}

/* ── D. 對開科目（工具抓不到，洗檔端專屬） ───────────────── */
function checkPairedSubjects(rows) {
  let wkSame = 0, wkDiff = 0;
  const offenders = [];
  for (const [, g] of groupBy(rows, r => key(r.cls, r.day, r.period))) {
    if (g.length < 2 || !g.some(r => r.week)) continue;
    if (new Set(g.map(r => r.subject)).size === 1) { wkSame++; offenders.push(g); } else wkDiff++;
  }
  if (offenders.length) {
    warns.push(`對開科目可疑 ${offenders.length} 格：隔週輪替的兩筆填了同一科。`);
    warns.push(`   班級課表那格通常只寫得下一科，兩位老師實際上多半是兩科對開（實測 13/13 格全部兩科不同）。`);
    warns.push(`   請確認每筆的 subject 有跟著「那位老師的本科」走，而不是照抄格子上的標籤：`);
    offenders.slice(0, 10).forEach(g =>
      warns.push(`   ${cell(g[0])}：` + g.map(r => `${r.teacher}(${r.week}週)·${r.subject}`).join(" ＋ ")));
  }
  sections.push(["對開科目", wkSame ? `⚠️ ${wkSame} 格同科` : "✅ 無同科", `輪替共 ${wkSame + wkDiff} 格`]);
}

/* ── E. 姓名字元健檢（PDF 文字層缺陷） ────────────────────── */
function checkNames(rows) {
  // 正常應為中文姓名或 "—"；出現問號、缺字框、拉丁字母都可疑
  const suspect = new Set();
  for (const r of rows) {
    const t = String(r.teacher ?? "");
    if (t === "" || t === "—") continue;
    if (!/^[一-鿿㐀-䶿·]+$/.test(t)) suspect.add(t);
  }
  if (suspect.size) {
    warns.push(`有 ${suspect.size} 個老師姓名含可疑字元：${[...suspect].join("、")}`);
    warns.push(`   這通常不是排版問題，是 PDF 文字層本身壞掉（連 PDF 自己的統計欄也會壞）。`);
    warns.push(`   請拿學校教師名單比對訂正，不要照字形或發音硬猜。`);
  }
  sections.push(["姓名字元", suspect.size ? `⚠️ ${suspect.size} 個可疑` : "✅ 正常", ""]);
}

/* ── F. 結構統計（給人眼核對總時數用） ──────────────────── */
function summarize(rows) {
  const classes = [...new Set(rows.map(r => r.cls))].sort();
  const teachers = [...new Set(rows.map(r => r.teacher))]
    .filter(t => t && t !== "—")
    .sort((a, b) => String(a).localeCompare(b, "zh-Hant"));
  const need = rows.filter(r => !r.teacher).length;
  if (need) warns.push(`缺教師 ${need} 筆（teacher 是空的）——工具會標「不列入對調」。沒有老師的固定活動請填 "—"，不要留空`);

  const perClass = classes.map(c => [c, rows.filter(r => r.cls === c).length]);
  /* 各班筆數本來就會因年級而不同（高一 35 節、高三 42 節都正常），
     所以不看全距，改抓「明顯偏離中位數」的離群班——那才像是整塊漏掉或重複。 */
  const counts = perClass.map(([, n]) => n).sort((a, b) => a - b);
  if (counts.length >= 3) {
    const med = counts[Math.floor(counts.length / 2)];
    const odd = perClass.filter(([, n]) => Math.abs(n - med) > med * 0.2);
    if (odd.length) {
      warns.push(`這幾班的筆數明顯偏離其他班（中位數 ${med} 筆），請對照 PDF 該頁的「總時數」欄確認沒有整塊漏掉或重複：`);
      odd.forEach(([c, n]) => warns.push(`   ${c}：${n} 筆（${n > med ? "+" : ""}${n - med}）`));
    }
  }
  return { classes, teachers, perClass, need };
}

/* ── G. 與上學期對照 ─────────────────────────────────── */
function diffBaseline(rows, base) {
  const setOf = (a, fn) => new Set(a.map(fn));
  const only = (a, b) => [...a].filter(x => !b.has(x));
  const out = [];
  const nc = setOf(rows, r => r.cls), oc = setOf(base, r => r.cls);
  const nt = setOf(rows.filter(r => r.teacher && r.teacher !== "—"), r => r.teacher);
  const ot = setOf(base.filter(r => r.teacher && r.teacher !== "—"), r => r.teacher);

  const d = rows.length - base.length;
  out.push(`總筆數　${base.length} → ${rows.length}（${d >= 0 ? "+" : ""}${d}）`);
  out.push(`班級數　${oc.size} → ${nc.size}`
    + (only(nc, oc).length ? `　新增：${only(nc, oc).join("、")}` : "")
    + (only(oc, nc).length ? `　消失：${only(oc, nc).join("、")}` : ""));
  out.push(`老師數　${ot.size} → ${nt.size}`);
  if (only(nt, ot).length) out.push(`　新老師（${only(nt, ot).length}）：${only(nt, ot).join("、")}`);
  if (only(ot, nt).length) out.push(`　不在了（${only(ot, nt).length}）：${only(ot, nt).join("、")}`);

  const tally = a => {
    const t = { fixed: 0, flex: 0, week: 0 };
    a.forEach(r => { if (r.fixed) t.fixed++; if (r.flex) t.flex++; if (r.week) t.week++; });
    return t;
  };
  const a = tally(base), b = tally(rows);
  out.push(`fixed　${a.fixed} → ${b.fixed}　／　flex　${a.flex} → ${b.flex}　／　week　${a.week} → ${b.week}`);

  // 上學期標過 fixed/flex/week 的科目，這學期出現了卻一個標記都沒有 → 最可能的漏標來源
  const flagged = s => {
    const m = new Map();
    s.forEach(r => { if (r.fixed || r.flex || r.week) m.set(r.subject, (m.get(r.subject) || 0) + 1); });
    return m;
  };
  const of_ = flagged(base), nf = flagged(rows);
  const lost = [...of_.keys()].filter(s => !nf.has(s) && rows.some(r => r.subject === s));
  if (lost.length) {
    warns.push(`這些科目上學期有標 fixed／flex／week，這學期出現了卻一個標記都沒有——很可能是漏標：`);
    lost.forEach(s => warns.push(`   「${s}」（上學期 ${of_.get(s)} 筆有標記）`));
  }
  return out;
}

/* ── H. 與原始 PDF 對帳（唯一能驗「忠於原稿」的檢查） ──────────
 *
 * 前面 A–G 驗的都是「內部一致性」：JSON 自己不矛盾。但抄錯成另一個真實科目、
 * 抄成另一位真實老師、整班漏一節——只要結果自己不打架，前面全部會放行。
 * PDF 每頁附的「科目＋老師＋時數」統計表是獨立於課表格子的第二份資料，
 * 拿它逐列對帳才驗得到忠實度。
 */
function crossCheckPdf(rows, pdfPath) {
  const py = ["python", "py", "python3"].find(cmd => {
    const t = spawnSync(cmd, ["-c", "import fitz"], { encoding: "utf8" });
    return t.status === 0;
  });
  if (!py) {
    warns.push(`--pdf 需要 Python 加 PyMuPDF（pip install pymupdf），目前找不到，已跳過 PDF 對帳。`);
    return;
  }
  const r = spawnSync(py, ["pdf-stats.py", pdfPath], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  let pages;
  try {
    pages = JSON.parse(r.stdout);
  } catch {
    errors.push(`PDF 抽取失敗：${(r.stderr || r.stdout || "無輸出").trim().split("\n").slice(-3).join(" ")}`);
    return;
  }
  if (pages.error) { errors.push(`PDF 抽取失敗：${pages.error}`); return; }

  const lines = [];
  let okCls = 0, badCls = 0, brokenNames = 0;

  for (const p of pages) {
    // 這班在 JSON 裡的 (科目|老師) → 筆數
    const actual = new Map();
    for (const x of rows.filter(x => x.cls === p.cls)) {
      const k = key(x.subject, x.teacher);
      actual.set(k, (actual.get(k) || 0) + 1);
    }
    const jsonCount = [...actual.values()].reduce((a, b) => a + b, 0);
    const miss = [];

    for (const pr of p.rows) {
      if (pr.broken) brokenNames++;
      // 找出 JSON 裡對應的那一筆。
      // 截斷 → 科目只能前綴比對；姓名壞掉或黏住認不出 → 放寬老師欄，只比科目與節數。
      const anyTeacher = pr.broken || pr.teacher === null;
      const hit = [...actual.keys()].find(k => {
        const [s, t] = k.split("|");
        const subjOK = pr.truncated ? s.startsWith(pr.subject) : s === pr.subject;
        return subjOK && (anyTeacher || t === pr.teacher) && actual.get(k) > 0;
      });
      if (!hit) { miss.push(`PDF 有、JSON 沒有：${pr.subject}·${pr.teacher ?? "（姓名認不出）"} ${pr.hours} 節`); continue; }
      const got = actual.get(hit);
      if (got !== pr.hours) miss.push(`節數不符：${pr.subject}·${pr.teacher}　PDF ${pr.hours}　JSON ${got}`);
      actual.set(hit, 0);
    }
    for (const [k, n] of actual) if (n > 0) miss.push(`JSON 有、PDF 沒有：${k.replace("|", "·")} ${n} 筆`);

    if (jsonCount !== p.sum_hours) miss.unshift(`筆數不符：PDF 統計表合計 ${p.sum_hours}　JSON ${jsonCount} 筆`);

    if (miss.length) {
      badCls++;
      errors.push(`${p.cls} 與 PDF 第 ${p.page} 頁對不上（${miss.length} 項）：`);
      miss.slice(0, 8).forEach(m => errors.push(`   ${m}`));
      if (miss.length > 8) errors.push(`   （另有 ${miss.length - 8} 項）`);
    } else {
      okCls++;
      lines.push(`${p.cls} ✅ ${p.rows.length} 列／${p.sum_hours} 筆`);
    }
  }
  if (brokenNames) {
    notes.push(`PDF 統計表裡有 ${brokenNames} 列的老師姓名是壞的（文字層缺陷），對帳時已放寬姓名比對、只對科目與節數`);
  }
  notes.push(`「總時數」欄算的是格數（同格多老師只算一格），所以一定小於筆數；對帳用的是統計表合計，不是那個數字`);
  sections.push(["PDF 對帳", badCls ? `❌ ${badCls} 班對不上` : `✅ ${okCls} 班全對`, ""]);
  return lines;
}

/* ── 主流程 ─────────────────────────────────────────── */
const args = process.argv.slice(2);
const bi = args.indexOf("--baseline");
const pi = args.indexOf("--pdf");
const baseFile = bi >= 0 ? args[bi + 1] : null;
const pdfFile = pi >= 0 ? args[pi + 1] : null;
// 位置參數＝第一個不是旗標、也不是旗標的值的東西
const flagValue = i => (bi >= 0 && i === bi + 1) || (pi >= 0 && i === pi + 1);
const file = args.find((a, i) => !a.startsWith("--") && !flagValue(i));

if (!file) {
  console.error("用法：node validate-schedule.mjs <schedule.json> [--baseline <上學期.json>] [--pdf <課表.pdf>]");
  process.exit(2);
}

const rows = load(file);
checkShape(rows);
checkCells(rows);
checkClash(rows);
checkPairedSubjects(rows);
checkNames(rows);
const sum = summarize(rows);
const pdfLines = pdfFile ? crossCheckPdf(rows, pdfFile) : null;

console.log(`\n調課雷達｜洗檔驗證　${file}`);
console.log("─".repeat(60));
console.log(`${rows.length} 筆　${sum.classes.length} 班　${sum.teachers.length} 位老師`
  + `　（fixed ${rows.filter(r => r.fixed).length}`
  + `／flex ${rows.filter(r => r.flex).length}`
  + `／week ${rows.filter(r => r.week).length}）`);

console.log("\n各班筆數（對照 PDF 每頁的「總時數」欄）：");
for (let i = 0; i < sum.perClass.length; i += 6) {
  console.log("  " + sum.perClass.slice(i, i + 6).map(([c, n]) => `${c} ${String(n).padStart(3)}`).join("   "));
}

console.log("\n檢查項目：");
// 中文字是雙寬、英數是單寬，padEnd 只數字元會對不齊，所以自己算顯示寬度
const dispWidth = s => [...s].reduce((n, c) => n + (/[⺀-鿿＀-｠　]/.test(c) ? 2 : 1), 0);
for (const [name, status, extra] of sections) {
  console.log(`  ${name}${" ".repeat(Math.max(1, 12 - dispWidth(name)))}${status}${extra ? "　" + extra : ""}`);
}

if (pdfLines && pdfLines.length) {
  console.log(`\n與 ${pdfFile} 逐科逐師對帳（全對的班）：`);
  for (let i = 0; i < pdfLines.length; i += 3) console.log("  " + pdfLines.slice(i, i + 3).join("   "));
}

if (baseFile) {
  console.log(`\n與 ${baseFile} 對照：`);
  diffBaseline(rows, load(baseFile)).forEach(l => console.log("  " + l));
}

if (errors.length) { console.log("\n❌ 錯誤（匯入前一定要修）"); errors.forEach(l => console.log("  " + l)); }
if (warns.length)  { console.log("\n⚠️  請確認（工具抓不到，只有這裡會提醒）"); warns.forEach(l => console.log("  " + l)); }
if (notes.length)  { console.log("\nℹ️  提醒"); notes.forEach(l => console.log("  " + l)); }

console.log("");
if (errors.length) {
  console.log(`結果：❌ ${errors.length} 項錯誤，先修完再匯入。\n`);
  process.exit(1);
}
console.log(warns.length
  ? `結果：✅ 沒有錯誤，但有 ${warns.length} 項要你確認。\n`
  : "結果：✅ 全部通過，可以匯入了。\n");
