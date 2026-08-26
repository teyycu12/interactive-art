"""Windows 主控台編碼修正 —— 匯入即生效。

副作用寫在 import 階段是刻意的：它必須發生在任何 print 之前，而
``config.py`` 在 module 層就會印 SECRET_KEY 警告。

Python 在 Windows 上拿系統 ANSI 代碼頁當 stdout 編碼（繁中版是 cp950）。
本專案的訊息帶 emoji，cp950 編不出來，print 便丟 UnicodeEncodeError；
那個 print 若落在 import 階段，例外會炸穿整條 import ——
``python backend/service.py`` 連 Flask 都還沒起來就結束，
而錯誤訊息指著編碼，完全看不出真正的觸發條件是「少設了 SECRET_KEY」。

英文版 Windows（cp1252）更糟：連中文訊息都編不出來，本專案幾乎每個
print 都會炸。所以這裡修的是整類問題，而不是把那 32 處 emoji 拿掉。

不要求現場先 chcp 65001 —— 展場當天用哪個終端機開機是不可控的。

errors="replace" 而非 "strict"：訊息長什麼樣是次要的，
絕不能因為印不出來就讓行程死掉。
"""

import sys

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        # 這裡刻意攔全部，不列舉例外型別。被重導向的管線、被 pytest 換掉的
        # 擷取物件、把 reconfigure 設成 None 的替身 —— 各自丟的例外不同
        # （AttributeError / ValueError / OSError / TypeError…），而它們
        # 全都不會有 cp950 問題。為了「不要讓行程死掉」而寫的程式碼，
        # 本身更不該是行程死掉的原因。
        pass
