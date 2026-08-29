# 介面樣式：顏色、可觸範圍、鍵盤與輔助技術

> 由 [CLAUDE.md](../../CLAUDE.md) 索引。動到 `public/*/style.css`、
> `public/screen/index.html` 的 `<style>`、控制器的覆蓋層，或任何
> 輸入框與錯誤訊息之前先讀。
> 這裡每一條都屬於「違反了也不會報錯，但現場會咬人」那一類 ——
> 而且多數在桌機開發時完全看不出來。

## 亮色只做填色，寫字要用 `-ink` 版本

三個介面各有一組成對的顏色 token：

| 用途 | 控制器 | 主辦端 |
|---|---|---|
| 填色／邊框（原本的亮色） | `--accent` `--warn` `--ok` | `--accent` `--teal` |
| **文字**（深色版本） | `--accent-ink` `--warn-ink` `--ok-ink` | `--accent-ink` `--teal-ink` |

原因是那組亮色對紙底的對比不足，**當成文字一律不合格**（WCAG AA 要 4.5:1）：

- `--accent` `#E76F51` → 2.92:1
- `--warn` `#E9A23B` → 2.04:1
- `--ok` `#2A9D8F` → 3.14:1

大面積填色、邊框、進度條不受此限（那是裝飾，不是資訊），所以原色留著沒有改。
**只有「拿來寫字」的地方要換成 `-ink`。**

### 不這樣做會怎樣

不會有任何錯誤訊息，本機看起來也正常 —— 因為你是在室內、盯著一塊亮度適中的
螢幕看。校內實測的場地光線比桌前亮得多，而受害的正好都是**沒有第二來源的訊息**：

- `.pill.warn`（11px、2.04:1）是「你還連著線嗎」唯一的指示
- `.btn-danger` 原本是紙色字壓在亮橘底上（2.92:1），而那是「確定離開」——
  現場按錯沒有補救餘地的那一顆
- 大螢幕的 `.mission .m-prog b` 是全場在追的任務進度，隔著整個場地看

新增元件時如果順手寫 `color: var(--accent)`，它會安靜地變成下一個難讀的地方。

### 例外：刻意壓低對比的地方

大螢幕的 `.hint-key`（1.44:1）是**故意的** —— 那行字只是給操作者的鍵盤提示，
投影時本來就不該顯眼。不要「順手修好」它。

判斷標準是問：**這段字是資訊，還是提示操作者不要看的東西？**

## 視覺尺寸與可觸範圍可以不一致

`.btn-exit`（27px）、`.btn-haptics`（36px）、`.sheet-close`（34px）、
`.swatch`（38px）在視覺上都小於 44px 的觸控下限，但它們**沒有被放大**，
而是用 `::after` 把可觸範圍撐到 44px：

```css
.btn-exit { position: relative; }        /* ::after 的定位基準 */
.btn-exit::after {
  content: ""; position: absolute;
  top: 50%; left: 50%; transform: translate(-50%, -50%);
  width: max(100%, 44px); height: max(100%, 44px);
}
```

把「看起來多大」與「按得到多大」分開，是因為那些元件小是**刻意的**：
離開鍵放大就會提高誤觸率，而誤觸離開在現場沒有補救餘地（見 `style.css`
該處註解）。直接改 `padding` 會把當初的取捨一起改掉。

### 色票的 `scale` 會連 `::after` 一起放大

`.swatch[aria-pressed="true"]` 有 `transform: scale(1.12)`，會把 44px 的
可觸範圍一起放大到約 49px，而色票間距只有 46px（38 + 8）——
相鄰色票的可觸範圍會**重疊**，點到邊緣時選中隔壁那一顆。

所以另外加了一條抵銷回去：

```css
.swatch[aria-pressed="true"]::after { scale: calc(1 / 1.12); }
```

要調整 `.swatches` 的 `gap` 或 `.swatch` 尺寸時，記得重算
「間距 ≥ 可觸範圍」這個條件。

## 改顏色之後怎麼驗

沒有自動化測試會擋下對比問題（測試不看樣式），所以要自己算。這段可以直接跑：

```python
def lin(c):
    c /= 255
    return c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4

def L(h):
    h = h.lstrip('#')
    r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
    return .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b)

def ratio(fg, bg):
    a, b = L(fg), L(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + .05) / (lo + .05)

# 控制器底色 #FAF8F5、主辦端表面 #FFFDFA、大螢幕 #FAF8F5
print(ratio('#C4462A', '#FAF8F5'))   # 4.65
```

門檻：一般文字 4.5:1；18px 以上或 14px 粗體 3:1。

`--ink-soft` 曾經是 `#7A716A`，剛好 4.50:1 —— 卡在及格線上、零餘裕，
而它是 `.lede` / `.hint` 等 30 處次要文字的顏色。現已改為 `#726960`（5.07:1）。
**挑顏色時不要挑剛好壓線的值**，場地光線不會照著你的螢幕走。

## 覆蓋層擋得住視線，擋不住鍵盤

控制器有四個覆蓋層：配對面板、配對確認、退出確認、問答。它們都是
`position: fixed; inset: 0` 加一層遮罩 —— 視覺上蓋住整個畫面，
但**焦點順序完全不受影響**。

原本的行為：面板開著時按 Tab，焦點會穿過遮罩走到底下的搖桿與表情鍵上。
焦點框出現在一塊被遮住、看不見的區域裡，使用者不知道自己選到了什麼，
按下 Enter 卻真的會送出乾杯或愛心。

現在四層都走 `pushOverlay()` / `popOverlay()`（`app.js` 開頭），它做三件事：

1. **`inert`** —— 對 `#app` 下 `inert`，底下整棵樹同時退出焦點順序與輔助技術。
   覆蓋層是 `#app` 的兄弟節點，所以不受影響。
2. **Esc 關閉** —— 沒有它，鍵盤使用者進得去出不來。
   問答是唯一沒有 `onEscape` 的：它由伺服器控制開始與結束，使用者不能自己關掉，
   但仍然要 `pushOverlay`，否則 Tab 一樣會穿過去。
3. **關閉後把焦點還給觸發的按鈕** —— 否則焦點掉回 `<body>`，
   下一次 Tab 要從整個頁面的最開頭重走一遍。

### 兩個容易忽略的細節

**預設焦點放在破壞性操作的反面。** 退出確認開啟時焦點在「取消」，不是
「確定離開」—— 不該讓一個 Enter 就把人送出場。配對確認則放在「確認配對」，
因為那不是破壞性的。

**退出流程會對沒開過的覆蓋層呼叫 close。** `btn-confirm-exit` 依序呼叫
`closeConfirm()` → `closeSheet()` → `closeConfirmPair()` → `closeQuiz()`，
其中多數本來就是關的。每個 close 都有 `if (hidden) return;` 擋住，
否則 `#app` 的 `inert` 可能解不開 —— **症狀是離場畫面整個不能操作，
而且不會有任何錯誤訊息**。

回歸測試在 [`test/overlay-focus.test.mjs`](../../test/overlay-focus.test.mjs)。
那份測試重建了同一套堆疊邏輯（`app.js` 直接綁 `document`，在 node 環境載不進來），
**改 `pushOverlay` / `popOverlay` 時要同步改測試** —— 兩邊漂移了測試會繼續綠燈。

## placeholder 不是 label

`#name-input`（控制器進場命名）與 `#key-input`（主辦端密鑰）原本都只有
`placeholder`，沒有任何 `<label>`。讀螢幕軟體念出來的是「編輯文字，最多 12 個字」——
使用者不會知道這格要填什麼。

兩處畫面上本來就有一句說明文字（`<p class="lede">`），視覺上它就是標籤，
只是沒有跟輸入框接起來。用 `aria-labelledby` 指過去即可，**視覺完全不變**：

```html
<p class="lede" id="name-label">先告訴大家你叫什麼名字</p>
<input id="name-input" aria-labelledby="name-label" aria-describedby="name-hint" …>
```

新增輸入框時：畫面上若已有說明文字，用 `aria-labelledby` 接；沒有的話才加
視覺隱藏的 `<label>`。不要只靠 `placeholder`。

## 錯誤訊息要能被播報

`#pair-msg`（配對失敗）、`#auth-err`（密鑰錯誤）、`#quiz-msg`、`#scan-error`
原本都只是普通的 `<p>`：文字換了，但讀螢幕軟體不會念。使用者按下送出後，
畫面上出現了紅字，而他完全不知道發生什麼事。

現在都加了 live region：

- **`role="alert"` + `aria-live="assertive"`** —— 使用者主動送出後的失敗
  （配對、密鑰）。要打斷當下的朗讀。
- **`role="status"` + `aria-live="polite"`** —— 被動出現的狀態
  （問答回饋、生成失敗）。等當下唸完再說。

原本只有 `#toast` 有。新增任何「送出後才出現的訊息」都要一併加上。

## reduced-motion 要蓋到全部，但不能蓋掉回饋

原本有三個動畫沒被 `prefers-reduced-motion` 蓋到，其中最要緊的是
**快門白閃**（`shutter-flash`）—— 全螢幕 `#fff`、`opacity: .92`，
是整個 App 對光敏感最不友善的一個效果。

但它**不能直接關掉**：拍完照直接跳到「生成中」，白閃是「有拍到」的唯一回饋。
所以改成淡一階（`.35`）、慢一點（`.5s`），保留訊息、去掉強閃。

**這是處理 reduced-motion 的通則：先問這個動畫有沒有在傳遞訊息。**
純裝飾的（`count-tick` 的縮放跳動、`toast-in` 的滑入）直接 `animation: none`；
承載訊息的要降級，不是移除。
