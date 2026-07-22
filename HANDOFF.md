# HANDOFF — 給接手的人（或 LLM）

在你改任何一行程式前，先讀完這頁。這裡是「為什麼這樣做」，不是「怎麼做」。

## 一句話

一個單檔（`index.html`）的高中調課工具。核心是「調課雷達」：以老師為中心，點一節課，算出同班其他任課老師誰能對調。沒有後端。

## 資料模型（唯一真相）

一切都是一個**事件陣列**，每筆＝一格課：`{cls, day(1-5), period(1-8), subject, teacher, fixed?}`。
載入時每筆補一個 `id`（陣列索引）。程式維護兩份：

- `ORIGINAL`：載入後不變，供「重置」「痕跡」比對。
- `WORK`：工作副本，試調時直接改 `WORK` 裡那筆的 `day/period`。
- `workById[id]` 對應同一筆，用來做 ORIGINAL↔WORK 的差異比對（痕跡就是這樣算出來的）。

沒有教師表、沒有班級表。教師課表 = `filter(teacher)`、班級課表 = `filter(cls)`、此刻在哪班 = `filter(cls, day, period)`。要新增檢視角度，就是加一個 filter，不要新增資料結構。

## 幾個關鍵決策（別回頭推翻）

- **用班級課表當來源，不用教師課表**：18 班天生只含高中部，免去判斷老師屬哪個部。教師課表會混國中部。
- **就算只調自己三班，也要餵滿 18 班**：同事的空堂由他教的所有班決定；只餵你的班會把「其實在別班有課」的人誤判成有空。示範資料裡 601/610 就是故意用來製造這種「別班占用」的例子。
- **對調 = 同班兩節互換**：雷達只找「對方在同一班、且非固定」的節次，成立條件是「你在對方那格有空 且 對方在你這格有空」。互換不會產生空格也不會撞課（已驗證）。
- **痕跡是即時算的，不是儲存的狀態**：某老師某格在 ORIGINAL 有課、在 WORK 已移走 → 顯示 `已調出` ghost。所以復原／重置自動消失，不用另外清。
- **資料內嵌，不用 fetch**：本機 `file://` 與沙盒都會擋 fetch 外部 JSON。所以資料要嘛內嵌在 `window.SCHEDULE`，要嘛用匯入 UI（貼上／FileReader）在記憶體載入。**不要改成 fetch('schedule.json')**，會在最重要的兩個環境裡壞掉。
- **不做 PNG 下載**：沙盒 iframe 擋 `<a download>` 與 `window.open`。改用「切到對方課表自己截圖 + 一鍵複製訊息」。若哪天要一鍵出圖，只有在非沙盒（GitHub Pages/本機）才可行，做法是 canvas 繪圖 + toBlob 下載；沙盒內只能 `<img src=dataURL>` 讓使用者右鍵存。

## 程式地圖（`index.html` 內的 `<script>`）

- `loadData(arr)`：建 ORIGINAL/WORK、算 teachers/classes、重畫。匯入與啟動都走它。
- `at / isFree / classAt / teachersOf / scheduleOf`：對 `WORK` 的查詢原語。
- `lianAround`：連堂判斷（相鄰同班同科；第4↔5 跨午休不算相接）。
- `ghostFor`：算某格的「已調出」痕跡。
- `gridHTML(teacher, opts)`：產生課表 HTML，主格與 Modal 共用（含痕跡、步驟色、highlight）。
- `renderRadar`：雷達；同班老師分組、綠/紅燈、連堂、前後脈絡、看對方課表。
- `doSwap / undoLast / resetAll`：試調；`swapLog` 每步記 `{r1,r2,label,step,info}`，`_step` 標在兩筆上供上色。
- `openModal`：看對方課表（固定疊層，關掉自動回原位）。
- `renderLog` / `buildMessage` / `showShare`：試調紀錄與分享訊息（複製有三層 fallback）。
- `renderNow`：此刻課堂。
- 啟動：有 `window.SCHEDULE` 就 `loadData`，否則 `showEmptyState`（匯入畫面）。

## 目前狀態

v0.9.0，功能完整、跑在假資料上。四大塊：調課雷達、此刻課堂、期初連動試調、截圖分享。已用 jsdom 做過載入/點選/對調/匯入/Modal 的無錯測試。

## 還沒做 / 可以做

- **換上真課表**：等下學期真 PDF，用 `wash-prompt.md` 洗成 JSON，取代 `window.SCHEDULE` 或匯入。這是通往 v1.0 的唯一必要步驟。
- **SKILL.md 定稿**：現為 v0.1 草稿，建議先洗一次真資料把眉角補進去。
- **跨部老師的假空堂**：18 班資料裡，也教國中部的老師其國中節次是空的，會被當成「有空」。目前不處理；若要處理，最輕做法是那幾位老師手動補上國中節次的「有課」筆數，或加一個 `partTime`/在校日限制。
- **一鍵出圖**：僅在非沙盒環境可行（見上）。

## 動手前務必

改完跑一次撞課／重格檢查與 jsdom 冒煙測試（見 repo 裡的做法）。資料層一旦破壞，雷達會安靜地給錯建議，很難察覺。
