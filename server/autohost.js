/**
 * 專展用自動主持（2026-11-15）
 *
 * 專展跟迎新不一樣：沒有人站在台上一輪一輪發任務，參與者陸續走進來、每人只停 1–3 分鐘，
 * 場上通常只有 2–5 個人。自動主持就是把「主持人按下一項」這件事交給伺服器：
 * 照節目內容（server/autohostPlaylist.js）輪流發任務、出問答、開文字雲，一輪接一輪。
 *
 * **它不直接碰任何玩法的狀態。** 每一步都組成跟主辦端按鈕一模一樣的訊息，
 * 交給 index.js 的 handleHostMessage —— 驗證、「做不做得完」的檢查、三端的廣播、
 * 事件紀錄全部走原本那一條路。主辦端按的和自動主持發的，伺服器分不出來，也不需要分。
 *
 * 讓位規則：
 *   - 只在「什麼都沒在跑」時發下一項。主持人自己發了任務、出了題，自動主持就等它結束。
 *   - 自己發的那一項被主持人提早收掉，也當作結束，照常接下一項。
 *   - 場上真人少於 minPeople（預設 2）時不發，等人來。NPC 不算人。
 *   - 活動暫停時不發。
 *   - 關掉自動主持時不收掉正在跑的那一項（問答會自己結束；文字雲、任務由主持人決定）。
 *
 * 這個類別是純邏輯：時間、場上狀態、送出訊息都由外部注入，測試可以直接驅動。
 */

/**
 * @typedef {object} AutoStatus 每次 tick 時場上的狀態（index.js 組）
 * @property {number} present          連線中的真人數（不含 NPC、斷線的人）
 * @property {boolean} paused          活動暫停中
 * @property {boolean} quiz            有問答在進行（含公布後停留的那幾秒）
 * @property {boolean} [quizRevealed]  問答已公布答案（還停在大螢幕上）
 * @property {boolean} wordcloud       有文字雲在收答案
 * @property {boolean} wordcloudResult 文字雲的結果還蓋在大螢幕上
 * @property {boolean} bingo           人物賓果進行中
 * @property {string[]} missions       進行中任務的 id
 * @property {(id: string) => boolean} missionDone 這個任務場上每個人都做完了嗎
 * @property {{id: string, label: string}[]} spots 目前場景的集合點
 */

/** 任務的 label 可以寫 {missionType: label}：輪替的那幾種各自叫什麼 */
const labelOf = (step, type) => (typeof step.label === 'object' ? step.label[type] : step.label) ?? type;

import { EV } from '../shared/protocol.js';

export class AutoHost {
  /**
   * @param {object} p
   * @param {object} p.content     { settings, playlist, quizPool, wordcloudPool }（見 autohostPlaylist.js）
   * @param {() => AutoStatus} p.status
   * @param {(msg: object) => {ok: boolean, reason?: string}} p.run 送出一則主辦端訊息
   * @param {(line: string) => void} [p.log]
   * @param {(c: {id: string, title: string, ms: number}) => void} [p.countdown]
   *   任務結束前的倒數（settings.countdownMs）。任務是不限時發的，手機和大螢幕本來看不到時間
   */
  constructor({ content, status, run, log = () => {}, countdown = () => {} }) {
    this.settings = content.settings;
    this.playlist = content.playlist;
    this.quizPool = content.quizPool ?? [];
    this.wordcloudPool = content.wordcloudPool ?? [];
    this.status = status;
    this.run = run;
    this.log = log;
    this.countdown = countdown;
    /** 輪替型任務（missionType 是陣列）每一項各自輪到第幾種，依節目內容的索引 */
    this.rotation = new Map();

    this.enabled = false;
    /** 下一項從節目內容的第幾項開始找 */
    this.pointer = 0;
    this.quizIndex = 0;
    this.wordcloudIndex = 0;
    /** @type {null | {step: object, label: string, startedAt: number, missionId?: string, closedAt?: number}} */
    this.current = null;
    /** 兩項之間的空檔，讓大螢幕的結果停留一下、讓人喘口氣 */
    this.restUntil = 0;
    /** 主辦端看的狀態：'off' | 'waiting' | 'paused' | 'manual' | 'running' | 'rest' */
    this.phase = 'off';
    /** 最近一次被跳過的原因（主辦端看得到，直到關掉自動主持）*/
    this.lastReason = null;
  }

  setEnabled(on, now = Date.now()) {
    on = on === true;
    if (on === this.enabled) return;
    this.enabled = on;
    this.current = null;
    this.lastReason = null;
    // 打開後先等一下再發第一項：主持人按下去的同時可能還在跟人講話
    this.restUntil = on ? now + this.settings.startDelayMs : 0;
    this.phase = on ? 'rest' : 'off';
    this.log(on ? '自動主持開啟' : '自動主持關閉');
  }

  tick(now = Date.now()) {
    if (!this.enabled) { this.phase = 'off'; return; }
    const s = this.status();

    if (this.current) {
      this.phase = 'running';
      if (this.followCurrent(s, now)) this.finish(now);
      return;
    }

    if (s.paused) { this.phase = 'paused'; return; }
    // 主持人自己開的活動還在跑：等它結束
    if (s.quiz || s.wordcloud || s.bingo || s.missions.length) { this.phase = 'manual'; return; }
    if (now < this.restUntil) { this.phase = 'rest'; return; }
    if (s.present < this.settings.minPeople) { this.phase = 'waiting'; return; }

    this.launchNext(s, now);
  }

  /** 追蹤自己發出去的那一項。回傳 true = 這一項結束了 */
  followCurrent(s, now) {
    const { step, startedAt } = this.current;
    const elapsed = now - startedAt;

    if (step.kind === 'quiz') {
      // 公布由主迴圈依時間推進（quiz.shouldAutoReveal）。公布後伺服器預設停 15 秒才收，
      // 專展嫌長：停 revealMs 就由這裡收掉
      if (s.quiz) {
        if (s.quizRevealed && step.revealMs) {
          this.current.revealedAt ??= now;
          if (now - this.current.revealedAt >= step.revealMs) this.run({ type: EV.HOST_END_QUIZ });
        }
        return false;
      }
      // 這一段要連續出 count 題：收掉一題就接下一題（題目不夠就到此為止）
      const asked = (this.current.asked ?? 1);
      if (asked < (step.count ?? 1)) {
        const [next] = this.build(step, s, 0, asked + 1);
        if (next && this.run(next.msg).ok) {
          next.commit();
          this.current.asked = asked + 1;
          this.current.label = next.label;
          this.current.revealedAt = null;
          this.log(`開始：${next.label}`);
          return false;
        }
      }
      return true;
    }

    if (step.kind === 'wordcloud') {
      if (s.wordcloud) {
        if (elapsed >= step.answerMs) {
          this.run({ type: EV.HOST_CLOSE_WORDCLOUD });
          this.current.closedAt = now;
        }
        return false;
      }
      // 收題後結果留在大螢幕上 resultMs，再收起來
      const closedAt = this.current.closedAt ?? now;
      this.current.closedAt = closedAt;
      if (!s.wordcloudResult) return true;
      if (now - closedAt >= step.resultMs) {
        this.run({ type: EV.HOST_DISMISS_WORDCLOUD });
        return true;
      }
      return false;
    }

    // 任務
    const id = this.current.missionId;
    if (!id || !s.missions.includes(id)) return true;   // 被主持人結算了
    if (elapsed >= step.limitMs || s.missionDone(id)) {
      this.run({ type: EV.HOST_CLOSE_MISSION, missionId: id });
      return true;
    }
    const cd = this.settings.countdownMs ?? 0;
    if (cd > 0 && !this.current.countdownSent && elapsed >= step.limitMs - cd) {
      this.current.countdownSent = true;
      this.countdown({ id, title: this.current.label, ms: step.limitMs - elapsed });
    }
    return false;
  }

  finish(now) {
    this.log(`結束：${this.current.label}`);
    this.current = null;
    this.restUntil = now + this.settings.restMs;
    this.phase = 'rest';
  }

  /** 從 pointer 往後找第一個現在人數能做、而且伺服器收下的一項 */
  launchNext(s, now) {
    const n = this.playlist.length;
    for (let tried = 0; tried < n; tried++) {
      const i = (this.pointer + tried) % n;
      const step = this.playlist[i];
      if (s.present < (step.minPeople ?? this.settings.minPeople)) continue;
      if (step.maxPeople && s.present > step.maxPeople) continue;

      // 一項可能有好幾個候選（輪替型任務：這輪輪到的那種做不完，就換另一種）
      const before = new Set(s.missions);
      let built = null;
      for (const c of this.build(step, s, i)) {
        const r = this.run(c.msg);
        if (r.ok) { built = c; break; }
        this.lastReason = `${c.label}：${r.reason}`;
        this.log(`跳過「${c.label}」：${r.reason}`);
      }
      if (!built) continue;

      built.commit();
      this.pointer = (i + 1) % n;
      this.current = { step, label: built.label, startedAt: now };
      if (step.kind === 'mission') {
        this.current.missionId = this.status().missions.find((id) => !before.has(id)) ?? null;
      }
      this.phase = 'running';
      this.log(`開始：${built.label}`);
      return;
    }
    // 整份都發不出去（例如題庫是空的、人數都不符）：過一陣子再試，不要每個 tick 都重試一輪
    this.restUntil = now + this.settings.retryMs;
    this.phase = 'waiting';
  }

  /**
   * 節目內容的一項 → 依序要試的主辦端訊息。commit 在伺服器收下後才呼叫：
   * 被拒絕的題目不能把題庫往前推，否則那一題就被跳過了。
   * @param {number} index 這一項在節目內容裡的位置（輪替狀態依它記）
   * @param {number} number 問答：這一段的第幾題（畫面上的「第 N 題」每一輪從 1 數）
   * @returns {{msg: object, label: string, commit: () => void}[]}
   */
  build(step, s, index = 0, number = 1) {
    if (step.kind === 'quiz') {
      if (!this.quizPool.length) return [];
      const q = this.quizPool[this.quizIndex % this.quizPool.length];
      return [{
        label: `問答：${q.question}`,
        msg: {
          type: EV.HOST_START_QUIZ,
          question: q.question, options: q.options, correctIndex: q.correctIndex,
          durationMs: step.durationMs, talkMs: step.talkMs ?? 0,
          talkKind: step.talkKind, multiplier: q.multiplier ?? 1, number,
        },
        commit: () => { this.quizIndex++; },
      }];
    }

    if (step.kind === 'wordcloud') {
      if (!this.wordcloudPool.length) return [];
      const question = this.wordcloudPool[this.wordcloudIndex % this.wordcloudPool.length];
      return [{
        label: `文字雲：${question}`,
        msg: { type: EV.HOST_START_WORDCLOUD, question },
        commit: () => { this.wordcloudIndex++; },
      }];
    }

    if (step.kind !== 'mission') return [];
    // missionType 是陣列 = 輪替：每一輪換下一種；這輪那種做不完（例如場上的人全是同一種動物），就試下一種
    const types = Array.isArray(step.missionType) ? step.missionType : [step.missionType];
    const turn = this.rotation.get(index) ?? 0;
    const out = [];
    for (let k = 0; k < types.length; k++) {
      const type = types[(turn + k) % types.length];
      const c = this.buildMission(step, type, s);
      if (!c) continue;
      out.push({ ...c, commit: () => this.rotation.set(index, turn + k + 1) });
    }
    return out;
  }

  buildMission(step, type, s) {
    const msg = {
      type: EV.HOST_PUBLISH_MISSION,
      missionType: type,
      target: step.target ?? 1,
      // 不用伺服器的限時（最短 3 分鐘，對 1–3 分鐘的停留太長）：時間由自動主持自己收
      durationMs: 0,
    };
    if (step.codeLength) msg.codeLength = step.codeLength;
    if (step.traitKey) msg.traitKey = step.traitKey;
    if (type === 'GATHER') {
      const spot = s.spots.find((x) => x.id === step.spot) ?? s.spots[0];
      if (!spot) return null;
      msg.spot = spot.id;
      // 'all' = 現在場上所有人一起：2–5 人的場子，最好玩的是全部人湊在一起
      msg.teamSize = step.teamSize === 'all' ? s.present : step.teamSize;
    }
    return { label: labelOf(step, type), msg };
  }

  nextLabel(step) {
    if (step.kind === 'quiz') return '問答';
    if (step.kind === 'wordcloud') return '文字雲';
    const types = Array.isArray(step.missionType) ? step.missionType : [step.missionType];
    return labelOf(step, types[(this.rotation.get(this.pointer) ?? 0) % types.length]);
  }

  /** 主辦端面板看的狀態 */
  view(now = Date.now()) {
    const nextStep = this.playlist[this.pointer];
    return {
      enabled: this.enabled,
      phase: this.phase,
      minPeople: this.settings.minPeople,
      current: this.current?.label ?? null,
      next: nextStep ? this.nextLabel(nextStep) : null,
      restMs: this.phase === 'rest' ? Math.max(0, this.restUntil - now) : 0,
      lastReason: this.lastReason,
      quizCount: this.quizPool.length,
      wordcloudCount: this.wordcloudPool.length,
    };
  }
}
