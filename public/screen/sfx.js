/**
 * 大螢幕的短音效：配對成功、找到寶藏、出題、公布答案……
 *
 * 為什麼要有聲音：大螢幕上同時有 30 個角色，「剛剛有兩個人配對成功」的光束
 * 一兩秒就過去，沒盯著看的人完全不知道。一聲短音效讓全場同時抬頭 ——
 * 現場的注意力是被聲音拉過去的，不是被畫面。
 *
 * 全部用 WebAudio 即時合成，不載任何音檔：與「前端相依一律不走 CDN」同一個理由，
 * 展場網路不通時聲音照樣有，也不必管音檔的授權。
 *
 * 瀏覽器不准沒有使用者手勢的頁面出聲（autoplay policy）。大螢幕通常是操作者
 * 開好就不碰，所以：AudioContext 被擋時在角落顯示一行小字，操作者點一下畫面
 * 就解鎖；解鎖前觸發的音效直接丟掉，不排隊（事後補一串音效比沒有更糟）。
 */

/** 每種音效：音符（Hz）、每個音的間隔（秒）、音色 */
const CUES = {
  // 兩人配對成功：上行兩音，明亮
  pair: { notes: [659, 988], gap: 0.09, type: 'triangle', gain: 0.22 },
  // 互相揮手、碰杯：比配對輕，一聲
  greet: { notes: [784], gap: 0, type: 'sine', gain: 0.16 },
  // 慶祝：上行琶音，最長也最響 —— 賓果結束這類全場一起等的時刻（原本是尋寶找到寶藏）
  fanfare: { notes: [523, 659, 784, 1047], gap: 0.08, type: 'triangle', gain: 0.26 },
  // 出題：提醒全場抬頭看螢幕
  quiz: { notes: [880, 880], gap: 0.14, type: 'square', gain: 0.08 },
  // 討論結束、開始作答
  go: { notes: [988], gap: 0, type: 'square', gain: 0.1 },
  // 公布答案
  reveal: { notes: [523, 784], gap: 0.12, type: 'triangle', gain: 0.2 },
};

/** 同一種音效的最短間隔：30 人同時配對時不能疊成一片噪音 */
const MIN_GAP_MS = 250;

export class Sfx {
  constructor() {
    this.enabled = true;
    /** @type {AudioContext|null} */
    this.ctx = null;
    this.lastAt = new Map();
    this.note = null;
    // 任何一次點擊或按鍵都順便試著解鎖。大螢幕上沒有按鈕，操作者點畫面哪裡都行
    const unlock = () => this.#resume();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this.#ensure();
    this.#renderNote();
  }

  /** @param {keyof typeof CUES} name */
  play(name) {
    const cue = CUES[name];
    if (!cue || !this.enabled) return;
    const ctx = this.#ensure();
    if (!ctx || ctx.state !== 'running') return;   // 還沒解鎖：丟掉，不排隊

    const now = performance.now();
    if (now - (this.lastAt.get(name) ?? -Infinity) < MIN_GAP_MS) return;
    this.lastAt.set(name, now);

    const t0 = ctx.currentTime + 0.01;
    cue.notes.forEach((freq, i) => {
      const start = t0 + i * cue.gap;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = cue.type;
      osc.frequency.value = freq;
      // 短促的起音與指數衰減：聽起來像敲擊，不像警報
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(cue.gain, start + 0.012);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + 0.32);
      osc.connect(amp).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.35);
    });
  }

  #ensure() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      this.ctx = new AC();
    } catch {
      return null;
    }
    this.ctx.addEventListener('statechange', () => this.#renderNote());
    this.#renderNote();
    return this.ctx;
  }

  #resume() {
    const ctx = this.#ensure();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  /**
   * 被瀏覽器擋住時的提示。刻意壓低對比、放在角落：這是給操作者看的，
   * 不是給觀眾（見 docs/notes/UI-STYLING.md「刻意壓低對比的地方」）。
   */
  #renderNote() {
    const blocked = this.enabled && this.ctx && this.ctx.state !== 'running';
    if (blocked && !this.note) {
      this.note = document.createElement('div');
      this.note.className = 'sfx-note';
      this.note.textContent = '點一下畫面開啟音效';
      document.body.append(this.note);
    }
    if (this.note) this.note.hidden = !blocked;
  }
}
