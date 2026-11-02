/**
 * 任務的條件、可行性檢查與集合判定
 *
 * missions.js 管生命週期（發布 → 記帳 → 結算），這裡管「誰跟誰配對才算數」
 * 以及「這個任務現在發下去，做不做得完」。全部是純函式：不碰 WebSocket、
 * 不讀全域狀態，場上資料由呼叫端以 ctx 傳入，測試可以直接餵假資料。
 *
 * 配對型任務的條件在**提交碼**那一步判定（與 COLOR_HUNT 同一個理由：讓人白等
 * 對方確認 30 秒才被告知「他不是」很差，還會佔掉雙方的 pending 名額）。
 * 條件是有方向的 —— 「被輸入碼的那一方」要符合；但兩個人誰輸入誰的碼是隨機的，
 * 所以可行性檢查把兩個方向都算進去。
 */

import { MISSION_TYPES, PAIR_ERRORS } from '../shared/protocol.js';
import { COLOR_FAMILY_MAP, avatarMatchesFamily } from '../shared/colorFamily.js';

/**
 * @typedef {object} RuleCtx
 * @property {(id: string) => object|null} avatarOf
 * @property {(id: string, key: string) => {value: string, label?: string}|null} traitOf
 */

/**
 * 這一對（a 輸入 b 的碼）在目前任務下算不算數。
 * @returns {string|null} 不算數的原因（PAIR_ERRORS），算數回 null
 */
export function pairRule(rule, a, b, ctx) {
  switch (rule?.type) {
    case undefined:
    case null:
    case 'PAIRING':
      return null;
    case 'COLOR_HUNT':
      return avatarMatchesFamily(ctx.avatarOf(b), rule.colorFamily) ? null : PAIR_ERRORS.COLOR_MISMATCH;
    case 'TRAIT_HUNT':
      return ctx.traitOf(b, rule.trait.key)?.value === rule.trait.value ? null : PAIR_ERRORS.TRAIT_MISMATCH;
    case 'DIFF_TRAIT':
    case 'SAME_TRAIT': {
      const mine = ctx.traitOf(a, rule.traitKey);
      if (!mine) return PAIR_ERRORS.NO_TRAIT_SELF;
      const theirs = ctx.traitOf(b, rule.traitKey);
      if (!theirs) return PAIR_ERRORS.NO_TRAIT_PEER;
      const same = mine.value === theirs.value;
      if (rule.type === 'DIFF_TRAIT') return same ? PAIR_ERRORS.NOT_DIFFERENT : null;
      return same ? null : PAIR_ERRORS.NOT_SAME;
    }
    default:
      return PAIR_ERRORS.NOT_PAIR_MISSION;
  }
}

/** 兩人之間不論誰輸入誰的碼，有沒有一個方向算數 */
const pairable = (rule, a, b, ctx) => pairRule(rule, a, b, ctx) === null || pairRule(rule, b, a, ctx) === null;

/**
 * 場上已有的標籤，供主辦端挑條件。只列在場的人身上真的有的值 ——
 * 列出沒有人有的選項，等於讓主辦端發一個沒人做得完的任務。
 *
 * @param {string[]} presentIds
 * @param {(id: string) => Record<string, {value: string, label?: string}>} traitsOf
 * @param {(key: string) => string} titleOf 標籤鍵的人話名稱（題目文字）
 */
export function traitCatalog(presentIds, traitsOf, titleOf) {
  /** @type {Map<string, {key: string, title: string, answered: number, values: Map<string, {value: string, label: string, count: number}>}>} */
  const keys = new Map();
  for (const id of presentIds) {
    for (const [key, t] of Object.entries(traitsOf(id) ?? {})) {
      if (!t || t.value == null) continue;
      if (!keys.has(key)) keys.set(key, { key, title: titleOf(key) || key, answered: 0, values: new Map() });
      const entry = keys.get(key);
      entry.answered += 1;
      const v = entry.values.get(t.value) ?? { value: t.value, label: t.label || String(t.value), count: 0 };
      v.count += 1;
      entry.values.set(t.value, v);
    }
  }
  return [...keys.values()].map((k) => ({
    key: k.key, title: k.title, answered: k.answered,
    values: [...k.values.values()].sort((x, y) => y.count - x.count),
  }));
}

/**
 * 把主辦端送來的參數整理成任務規則（含三端要顯示的文字）。
 * 參數必須落在目前場上的選項裡：標籤要有人有、地點要在目前的場景裡。
 *
 * @param {string} type
 * @param {object} msg HOST_PUBLISH_MISSION／HOST_CHECK_MISSION 的內容
 * @param {{catalog: ReturnType<typeof traitCatalog>, spots: {id: string, label: string}[]}} options
 * @returns {{ok: true, rule: object} | {ok: false, reason: string}}
 */
export function buildRule(type, msg, { catalog, spots }) {
  const spec = MISSION_TYPES[type];
  if (!spec) return { ok: false, reason: `未知的任務型別：${type}` };
  switch (spec.param) {
    case undefined:
      return { ok: true, rule: { type } };
    case 'colorFamily': {
      const fam = COLOR_FAMILY_MAP[msg.colorFamily];
      if (!fam) return { ok: false, reason: `未知的顏色：${msg.colorFamily}` };
      return { ok: true, rule: { type, colorFamily: fam.id, label: fam.label } };
    }
    case 'trait': {
      const key = catalog.find((k) => k.key === msg.trait?.key);
      const value = key?.values.find((v) => v.value === msg.trait?.value);
      if (!key || !value) return { ok: false, reason: '場上沒有人屬於這一類，請重新選擇' };
      return {
        ok: true,
        rule: { type, trait: { key: key.key, value: value.value }, title: key.title, label: value.label },
      };
    }
    case 'traitKey': {
      const key = catalog.find((k) => k.key === msg.traitKey);
      if (!key) return { ok: false, reason: '場上沒有人答過這一題，請重新選擇' };
      return { ok: true, rule: { type, traitKey: key.key, title: key.title } };
    }
    case 'spot': {
      const spot = spots.find((s) => s.id === msg.spot);
      if (!spot) return { ok: false, reason: '目前的場景沒有這個集合點' };
      const { min, max } = spec.teamSize;
      const n = Number(msg.teamSize);
      if (!Number.isInteger(n) || n < min || n > max) {
        return { ok: false, reason: `人數須為 ${min} 至 ${max} 人` };
      }
      return { ok: true, rule: { type, spot: spot.id, label: spot.label, teamSize: n } };
    }
    case 'codeLength': {
      const { min, max } = spec.codeLength;
      const n = Number(msg.codeLength ?? spec.codeLength.default);
      if (!Number.isInteger(n) || n < min || n > max) {
        return { ok: false, reason: `密碼長度須為 ${min} 至 ${max} 碼` };
      }
      return { ok: true, rule: { type, codeLength: n } };
    }
    default:
      return { ok: false, reason: '不支援的任務參數' };
  }
}

/**
 * 這個任務現在發下去，做不做得完。
 *
 * 配對型：逐一算每個人「還能跟誰配」—— 條件成立、而且還沒配對過（已配過的兩人
 * 會被 ALREADY_PAIRED 擋下，連續發幾個任務之後可配的人會愈來愈少，這是最容易
 * 被忽略的一種做不完）。可配人數 ≥ 目標次數的人才有機會達標。
 * 這是上限而非保證：大家搶同一批人時實際能完成的會更少。
 *
 * @param {object} rule buildRule() 的結果
 * @param {object} p
 * @param {number} p.target 每人目標次數
 * @param {string[]} p.agents 在場的人
 * @param {RuleCtx} p.ctx
 * @param {(a: string, b: string) => boolean} p.connected 兩人是否已經配對過
 * @returns {{level: 'ok'|'warn'|'block', summary: string, notes: string[], canFinish?: number, total: number}}
 */
export function feasibility(rule, { target, agents, ctx, connected }) {
  const total = agents.length;
  const notes = [];

  if (rule.type === 'GATHER') {
    if (total < rule.teamSize) {
      return { level: 'block', total, notes, summary: `場上只有 ${total} 人，湊不滿 ${rule.teamSize} 人` };
    }
    const groups = Math.floor(total / rule.teamSize);
    const left = total % rule.teamSize;
    if (left) notes.push(`湊不成整組的 ${left} 人要等新的人進場才完成得了`);
    return {
      level: left ? 'warn' : 'ok', total, notes, canFinish: total - left,
      summary: `${total} 人在場，可以湊成 ${groups} 組，${total - left} 人有機會完成`,
    };
  }

  if (total < 2) return { level: 'block', total, notes, summary: '場上不到 2 人，沒有人可以配對' };

  // 解碼由伺服器分組，不看條件也不看配對過沒有：兩人以上就湊得成組，奇數時有一組三人
  if (rule.type === 'DECODE') {
    if (total % 2) notes.push('人數是奇數，會有一組三人（密碼本拆兩半）');
    return {
      level: 'ok', total, notes, canFinish: total,
      summary: `${total} 人在場，可以分成 ${Math.floor(total / 2)} 組`,
    };
  }

  // 標籤類任務先說清楚資料夠不夠：沒答過的人在這個任務裡什麼都不能做
  if (rule.trait || rule.traitKey) {
    const key = rule.trait?.key ?? rule.traitKey;
    const answered = agents.filter((id) => ctx.traitOf(id, key)).length;
    if (answered < total) notes.push(`${total - answered} 人還沒答過「${rule.title}」`);
    if (rule.trait) {
      const matching = agents.filter((id) => ctx.traitOf(id, key)?.value === rule.trait.value).length;
      notes.push(`符合「${rule.label}」的有 ${matching} 人`);
    }
  }
  if (rule.colorFamily) {
    const matching = agents.filter((id) => avatarMatchesFamily(ctx.avatarOf(id), rule.colorFamily)).length;
    notes.push(`身上有${rule.label}的有 ${matching} 人`);
  }

  let canFinish = 0;
  let anyPair = false;
  let blockedByHistory = 0;
  for (const a of agents) {
    let partners = 0;
    let fresh = 0;
    for (const b of agents) {
      if (a === b || !pairable(rule, a, b, ctx)) continue;
      fresh += 1;
      if (!connected(a, b)) partners += 1;
    }
    if (partners > 0) anyPair = true;
    if (partners >= target) canFinish += 1;
    else if (fresh >= target) blockedByHistory += 1;
  }
  if (blockedByHistory) notes.push(`${blockedByHistory} 人因為符合條件的人都已經配對過，做不滿 ${target} 次`);

  if (!anyPair) {
    return { level: 'block', total, notes, canFinish, summary: '沒有任何一組人能完成這個任務' };
  }
  // 配得成，但沒有人配得滿目標次數：同樣是沒有人做得完
  if (canFinish === 0) {
    return { level: 'block', total, notes, canFinish, summary: `沒有人能做滿 ${target} 次，請降低目標次數` };
  }
  return {
    level: canFinish === total ? 'ok' : 'warn', total, notes, canFinish,
    summary: canFinish === total
      ? `${total} 人都有機會做滿 ${target} 次`
      : `${total} 人中最多 ${canFinish} 人做得滿 ${target} 次`,
  };
}

/**
 * GATHER 的集合判定。每個 tick 呼叫一次。
 *
 * 只數還沒完成的人：已完成的人留在原地不幫後來的人湊數（理由見 MISSION_TYPES.GATHER）。
 * 人數湊齊後要持續 holdMs 才算，免得有人只是路過；中途有人走開就重新計時。
 * 範圍是道具半徑 + MISSION_TYPES.GATHER.reachRadius，
 * 大螢幕畫的那一圈才會跟判定一致。
 */
export class GatherTracker {
  /**
   * @param {{spot: {x: number, y: number, r?: number}, teamSize: number, holdMs: number}} opts
   */
  constructor({ spot, teamSize, holdMs }) {
    this.spot = spot;
    this.teamSize = teamSize;
    this.holdMs = holdMs;
    this.reach = (spot.r ?? 0) + MISSION_TYPES.GATHER.reachRadius;
    /** 人數湊齊的時刻；不夠時為 null */
    this.since = null;
    /** 上一次回報的人數，只在變動時通知三端 */
    this.lastInside = -1;
  }

  /**
   * @param {Iterable<{id: string, x: number, y: number}>} agents
   * @param {(id: string) => boolean} isDone 這個人是否已經完成
   * @returns {{inside: number, changed: boolean, completed: string[]}}
   */
  step(agents, isDone, now = Date.now()) {
    const here = [];
    for (const a of agents) {
      if (isDone(a.id)) continue;
      if (Math.hypot(a.x - this.spot.x, a.y - this.spot.y) <= this.reach) here.push(a.id);
    }
    let completed = [];
    if (here.length >= this.teamSize) {
      if (this.since === null) this.since = now;
      else if (now - this.since >= this.holdMs) {
        completed = here;
        this.since = null;
      }
    } else {
      this.since = null;
    }
    const inside = here.length - completed.length;
    const changed = inside !== this.lastInside;
    this.lastInside = inside;
    return { inside, changed, completed };
  }
}
