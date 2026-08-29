/**
 * 破冰分組（兩隊）的不變式測試
 *
 * 這一組全部圍繞同一句話：**場上不存在沒有隊伍的角色**。
 * 那條不變式由 state.js 的 assignTeam 單點保證，因此下游
 * （計分聚合、跨隊配對判定、大螢幕色標）可以直接信任 agent.team。
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Stage } from '../server/state.js';
import { Directory } from '../server/persistence.js';
import { TEAM_IDS, TEAMS, GROUPING_QUESTIONS, GROUPING_MAP } from '../shared/protocol.js';
import { MAX_AGENTS } from '../server/config.js';

const avatar = { skin: 0, hair: 0, top: 0, bottom: 0 };
// 角色數一律以 MAX_AGENTS 為上界，不寫死數量 ——
// 上限調整時硬寫的數字會讓 addAgent 回傳 null，而錯誤訊息
// 完全看不出跟人數上限有關（見 docs/notes/SERVER-AND-TESTS.md）。
const addN = (stage, n, team = null) => {
  const made = [];
  for (let i = 0; i < n; i++) {
    made.push(stage.addAgent({ name: `p${i}`, avatar, team }));
  }
  return made;
};

describe('隊伍不變式', () => {
  test('沒帶隊伍的角色一定會拿到一個有效隊伍', () => {
    const stage = new Stage();
    for (const a of addN(stage, MAX_AGENTS)) {
      assert.ok(TEAM_IDS.includes(a.team), `team 必須是白名單內的值，實得 ${a.team}`);
    }
  });

  test('非法隊伍不被採用，改為補位', () => {
    const stage = new Stage();
    for (const bad of ['C', '', 'a', 0, null, undefined, {}, 'A '] ) {
      const agent = stage.addAgent({ name: 'x', avatar, team: bad });
      assert.ok(TEAM_IDS.includes(agent.team));
    }
  });

  test('合法隊伍原樣採用', () => {
    const stage = new Stage();
    for (const t of TEAM_IDS) {
      assert.equal(stage.addAgent({ name: 't', avatar, team: t }).team, t);
    }
  });

  test('補位會平衡人數，兩隊差不超過 1', () => {
    const stage = new Stage();
    addN(stage, MAX_AGENTS);
    const counts = TEAM_IDS.map((t) =>
      [...stage.agents.values()].filter((a) => a.team === t).length);
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1,
      `兩隊人數差過大：${counts.join(' vs ')}`);
  });

  test('補位會往人少的那隊填，抵銷先前的傾斜', () => {
    const stage = new Stage();
    // 先塞一批全部指定 A，再讓補位接手
    const skew = Math.floor(MAX_AGENTS / 2);
    addN(stage, skew, 'A');
    addN(stage, MAX_AGENTS - skew);
    const b = [...stage.agents.values()].filter((a) => a.team === 'B').length;
    assert.equal(b, MAX_AGENTS - skew, '補位應全部進 B');
  });
});

describe('隊伍跨重連存活', () => {
  test('claimAgent 保留原隊伍，不重新分派', () => {
    const stage = new Stage();
    const dir = new Directory();
    // 造一個確定在少數方的隊伍，若被重新分派就會換邊
    const first = stage.addAgent({ name: 'a', avatar, team: 'A' });
    dir.remember(first);
    const token = first.rejoinToken;
    stage.removeAgent(first.id);

    // 場上先站滿 A，讓「補位」必然指向 B —— 隊伍若沒被保留，
    // 認領回來的角色會是 B
    addN(stage, 3, 'A');

    const back = stage.claimAgent(dir.get(first.id), token);
    assert.equal(back.team, 'A', '認領回來的角色必須留在原隊');
  });

  test('Directory 存得住隊伍，export/hydrate 後不變', () => {
    const stage = new Stage();
    const dir = new Directory();
    const agent = stage.addAgent({ name: 'a', avatar, team: 'B' });
    dir.remember(agent);

    const revived = new Directory().hydrate(JSON.parse(JSON.stringify(dir.export())));
    assert.equal(revived.get(agent.id).team, 'B');
  });

  test('舊快照沒有 team 欄位時退回 null，由補位接手（不得是 undefined）', () => {
    const legacy = [{ id: 'usr_old', name: '舊的', avatar, rejoinToken: 'tok' }];
    const dir = new Directory().hydrate(legacy);
    assert.equal(dir.get('usr_old').team, null);

    const stage = new Stage();
    const agent = stage.claimAgent(dir.get('usr_old'), 'tok');
    assert.ok(TEAM_IDS.includes(agent.team), '舊資料認領回來仍須有有效隊伍');
  });
});

describe('名冊廣播', () => {
  test('roster 帶隊伍，但不得夾帶 rejoinToken', () => {
    const stage = new Stage();
    addN(stage, 3);
    for (const row of stage.roster()) {
      assert.ok(TEAM_IDS.includes(row.team));
      assert.equal(row.rejoinToken, undefined, 'rejoinToken 絕不可出現在廣播中');
    }
  });
});

describe('分組題庫', () => {
  test('每題都是兩個選項，對應兩隊', () => {
    for (const q of GROUPING_QUESTIONS) {
      assert.equal(q.options.length, TEAM_IDS.length,
        `「${q.text}」的選項數必須等於隊伍數`);
      for (const o of q.options) assert.ok(o.trim().length > 0);
    }
  });

  test('題目 id 唯一且查得到', () => {
    const ids = GROUPING_QUESTIONS.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, '題目 id 不可重複');
    for (const id of ids) assert.ok(GROUPING_MAP[id]);
  });

  test('隊伍文字色對紙底達 WCAG AA（4.5:1）', () => {
    // 沒有自動化測試會擋下對比問題（測試不看樣式），因此在這裡自己算。
    // 演算法與 docs/notes/UI-STYLING.md 的那段完全相同。
    const lin = (c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const lum = (hex) => {
      const h = hex.replace('#', '');
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const ratio = (fg, bg) => {
      const [a, b] = [lum(fg), lum(bg)];
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };

    // 控制器與大螢幕底色 #FAF8F5、主辦端表面 #FFFDFA
    for (const t of Object.values(TEAMS)) {
      for (const bg of ['#FAF8F5', '#FFFDFA']) {
        const r = ratio(t.ink, bg);
        assert.ok(r >= 4.5, `隊伍 ${t.id} 的文字色 ${t.ink} 對 ${bg} 只有 ${r.toFixed(2)}:1`);
      }
    }
  });

  test('每隊都同時有色塊色與文字色，且不相同', () => {
    // 兩者用途不可互換：拿 color 當文字色會落在 3.7:1 左右，投影出去讀不清
    for (const t of Object.values(TEAMS)) {
      assert.match(t.color, /^#[0-9A-Fa-f]{6}$/);
      assert.match(t.ink, /^#[0-9A-Fa-f]{6}$/);
      assert.notEqual(t.color.toUpperCase(), t.ink.toUpperCase());
    }
  });

  test('兩隊的顏色彼此不同', () => {
    const fills = Object.values(TEAMS).map((t) => t.color.toUpperCase());
    assert.equal(new Set(fills).size, fills.length, '兩隊色塊色不可相同');
  });

  test('隊伍顏色不與問答選項色相撞', async () => {
    const { QUIZ_CHOICES } = await import('../shared/protocol.js');
    // 撞色會讓現場分不清「這是隊伍色還是問答選項色」
    const quizColors = new Set(QUIZ_CHOICES.map((c) => c.color.toUpperCase()));
    for (const t of Object.values(TEAMS)) {
      assert.ok(!quizColors.has(t.color.toUpperCase()),
        `隊伍色 ${t.color} 與問答選項色相撞`);
    }
  });
});
