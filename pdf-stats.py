#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""從班級課表 PDF 抽出每頁的「科目＋老師＋時數」統計表，輸出 JSON 到 stdout。

給 validate-schedule.mjs --pdf 用，也可以單獨跑來看抽到什麼：

    python pdf-stats.py "private/115-1 class.pdf"

為什麼要這張表：它是 PDF 自己算的、獨立於課表格子的第二份資料，
可以用來驗「洗出來的 JSON 忠不忠於原稿」——這是 validate-schedule.mjs
單看 JSON 永遠驗不到的部分。特別是它逐位老師分開列，
所以「對開輔導課哪位老師教哪一科」有現成答案，不必靠推論。

⚠️ 注意「總時數」欄算的是**格數**不是筆數（同格多老師只算一格），
   所以回傳時分成 total_cells（PDF 寫的）與 sum_hours（統計表加總）兩個數字，
   後者才對得起展開後的 JSON 筆數。

抽取上的三個坑（都已處理）：
  1. 科目名太長會溢位、吃掉老師欄，而且**還會被截斷**
     （「高三彈性-自社充補」在表上是「高三彈性-自社充莊舒婷」）。
  2. 沒有老師的課（社團活動）只有兩欄。
  3. PDF 文字層可能壞掉，姓名出現問號（「張瑀洆」→「張瑀?」），
     統計表也會跟著壞，不是抽取錯誤。
"""

import sys
import json
import re

try:
    import fitz  # PyMuPDF
except ImportError:
    print(json.dumps({"error": "需要 PyMuPDF：pip install pymupdf"}, ensure_ascii=False))
    sys.exit(3)

DIGITS = re.compile(r"^\d+$")
ROW_TOL = 4.0          # 同一列的 y 容差（pt）
CJK = re.compile(r"^[一-鿿㐀-䶿·]+$")


def page_words_below_stats_anchor(page):
    """回傳統計區的 words，以及該頁的『總時數』數字。"""
    words = page.get_text("words")  # (x0, y0, x1, y1, text, block, line, word_no)
    anchor_y = None
    total_cells = None
    for w in words:
        if "總時數" in w[4]:
            anchor_y = w[1]
            # 「總時數：」標籤在左，數值在同一列稍右（另一個 y 幾乎相同的純數字）
            break
    if anchor_y is None:
        return [], None
    for w in words:
        if abs(w[1] - anchor_y) < 6 and DIGITS.match(w[4]):
            total_cells = int(w[4])
            break
    stats = [w for w in words if w[1] > anchor_y + 5]
    return stats, total_cells


def cluster_rows(words):
    """把 words 依 y 座標分列，每列內依 x 排序。"""
    rows = []
    for w in sorted(words, key=lambda w: (w[1], w[0])):
        if rows and abs(w[1] - rows[-1][0]) <= ROW_TOL:
            rows[-1][1].append(w)
        else:
            rows.append([w[1], [w]])
    return [sorted(cells, key=lambda w: w[0]) for _, cells in rows]


def split_groups(row):
    """一列裡有 4 組 (科目[, 老師], 時數)。用『純數字＝時數』當分界切開。"""
    groups, buf = [], []
    for w in row:
        if DIGITS.match(w[4]):
            if buf:
                groups.append((buf, int(w[4])))
                buf = []
        else:
            buf.append(w)
    return groups


# 科目欄寬約 72pt。沒有老師的課（社團活動）量到 36pt，
# 科目名溢位吃掉老師欄的量到 99pt——中間差很開，取 60 當門檻很安全。
OVERFLOW_W = 60.0


def extract(path):
    doc = fitz.open(path)
    pages = []
    for pg in range(len(doc)):
        page = doc[pg]
        lines = [x.strip() for x in page.get_text().split("\n") if x.strip()]
        cls = lines[0] if lines else "?"
        stats, total_cells = page_words_below_stats_anchor(page)
        raw = []
        for row in cluster_rows(stats):
            for texts, hours in split_groups(row):
                # 單欄項目要靠寬度分辨「沒有老師」還是「科目名溢位吃掉老師欄」
                wide = len(texts) == 1 and (texts[0][2] - texts[0][0]) > OVERFLOW_W
                raw.append(([t[4] for t in texts], hours, wide))
        pages.append({"page": pg + 1, "cls": cls, "total_cells": total_cells, "raw": raw})
    doc.close()

    # ── 第一遍：從「科目、老師」兩欄俱全的項目收集老師名 ────────────
    teachers = set()
    for p in pages:
        for texts, _, _ in p["raw"]:
            if len(texts) >= 2:
                teachers.add(texts[-1])

    # ── 第二遍：解開只有一欄的項目 ──────────────────────────
    # 寬度沒超過門檻 → 這門課本來就沒有老師（社團活動）。
    # 寬度超過 → 科目名溢位、把老師名黏在後面，而且科目本身已被截斷。
    #   這時先用已知老師名去剝尾巴；剝不掉就標成未解析，
    #   讓比對端只比科目前綴，不要自己猜姓名（只出現在黏住欄位的老師學不到名字）。
    out = []
    for p in pages:
        rows, notes = [], []
        for texts, hours, wide in p["raw"]:
            if len(texts) >= 2:
                subject, teacher, truncated = "".join(texts[:-1]), texts[-1], False
            elif not wide:
                subject, teacher, truncated = texts[0], "—", False
            else:
                s = texts[0]
                teacher = next((t for t in sorted(teachers, key=len, reverse=True)
                                if len(s) > len(t) and s.endswith(t)), None)
                truncated = True
                if teacher:
                    subject = s[: -len(teacher)]
                else:
                    # 認不出姓名就不猜是誰，但姓名還黏在字串尾、不能整串拿去前綴比對。
                    # 中文姓名 2–3 字，固定剝掉 3 字：姓名只有 2 字時會多剝一個科目字，
                    # 前綴變短但仍然正確——前綴比對寧可剝多不可剝少。
                    subject, teacher = s[:-3], None
                    notes.append("姓名黏在科目後面且無法辨識，只比科目前綴「%s」：%s" % (s[:-3], s))
            broken = teacher is not None and teacher != "—" and not CJK.match(teacher)
            if broken:
                notes.append("姓名疑似 PDF 文字層缺陷：%s" % teacher)
            rows.append({"subject": subject, "teacher": teacher, "hours": hours,
                         "truncated": truncated, "broken": broken})
        out.append({"page": p["page"], "cls": p["cls"], "total_cells": p["total_cells"],
                    "sum_hours": sum(r["hours"] for r in rows), "rows": rows, "notes": notes})
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法：python pdf-stats.py <課表.pdf>"}, ensure_ascii=False))
        sys.exit(2)
    try:
        data = extract(sys.argv[1])
    except Exception as e:  # 讓 Node 端拿得到原因，而不是一片空白
        print(json.dumps({"error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))
        sys.exit(3)
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(data, ensure_ascii=False))
