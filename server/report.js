/**
 * 活動報告：把整場的任務、問答、問卷與社交圖譜彙整成兩張表。
 *
 * 這些資料本來就都在伺服器上（快照也存著），但只有主辦端看得到「當下」，
 * 活動一結束就沒有人整理得出「誰跟幾個人互動過、哪一輪大家最投入」。
 * 校內實測的成果與檢討要的正是這些數字。
 *
 * 純函式：只吃各模組 export() 出來的資料，不碰 WebSocket 或檔案，方便測試。
 * 名字對不回來（被移除的人會從 directory 刪掉）時留空，由主辦端顯示「已離場」。
 */

/**
 * @param {object} src
 * @param {object} src.missions   MissionBoard#export()
 * @param {object} src.quiz       QuizSession#export()
 * @param {object} src.survey     SurveySession#export()
 * @param {object} src.scores     ScoreBoard#export()
 * @param {object} src.graph      SocialGraph#export()
 * @param {(id: string) => string} src.nameOf     找不到時回傳空字串
 * @param {(id: string) => boolean} src.isPresent 目前是否在場
 * @param {number} [src.now]
 */
export function buildReport({ missions, quiz, survey, scores, graph, nameOf, isPresent, now = Date.now() }) {
  const missionList = [...(missions.history ?? []), ...(missions.active ? [missions.active] : [])];
  const quizList = [...(quiz.history ?? []), ...(quiz.current ? [quiz.current] : [])];
  const surveyList = [...(survey.history ?? []), ...(survey.current ? [survey.current] : [])];
  const edges = graph.edges ?? [];

  /** @type {Map<string, object>} */
  const people = new Map();
  const person = (id) => {
    if (!people.has(id)) {
      people.set(id, {
        id, name: nameOf(id) || '', present: isPresent(id),
        score: 0, connections: 0, missionCompletions: 0,
        quizAnswered: 0, quizCorrect: 0, surveyTags: [],
      });
    }
    return people.get(id);
  };

  for (const [id, s] of Object.entries(scores.totals ?? {})) person(id).score = s.total ?? 0;
  for (const e of edges) { person(e.a).connections++; person(e.b).connections++; }
  for (const m of missionList) {
    for (const ev of m.events ?? []) if (ev.agentId) person(ev.agentId).missionCompletions++;
  }
  for (const q of quizList) {
    for (const a of q.answers ?? []) {
      const p = person(a.agentId);
      p.quizAnswered++;
      // 還在作答中的題目沒有揭曉，不算對錯
      if (q.revealedAt && a.choice === q.correctIndex) p.quizCorrect++;
    }
  }
  for (const t of survey.traits ?? []) {
    const p = person(t.agentId);
    for (const v of Object.values(t.tags ?? {})) p.surveyTags.push(typeof v === 'string' ? v : v?.label ?? '');
  }

  const activities = [];
  for (const m of missionList) {
    activities.push({
      kind: '任務',
      title: m.title,
      startedAt: m.publishedAt,
      endedAt: m.closedAt ?? null,
      participants: Object.keys(m.progress ?? {}).length,
      result: `每人 ${m.target} 次・共完成 ${(m.events ?? []).length} 次・`
        + `${Object.values(m.progress ?? {}).filter((n) => n >= m.target).length} 人達標`,
    });
  }
  for (const q of quizList) {
    const answers = q.answers ?? [];
    const right = q.revealedAt ? answers.filter((a) => a.choice === q.correctIndex).length : null;
    activities.push({
      kind: '問答',
      title: q.question,
      startedAt: q.startedAt,
      endedAt: q.revealedAt ?? null,
      participants: answers.length,
      result: right === null
        ? '尚未公布'
        : `正解「${q.options?.[q.correctIndex] ?? ''}」・${right} / ${answers.length} 人答對`,
    });
  }
  for (const s of surveyList) {
    const answers = s.answers ?? [];
    const dist = (s.options ?? []).map((o, i) => {
      const n = answers.filter((a) => a.choice === i).length;
      return `${o.label ?? o} ${n}`;
    });
    activities.push({
      kind: '問卷',
      title: s.question,
      startedAt: s.startedAt,
      endedAt: s.closedAt ?? null,
      participants: answers.length,
      result: dist.join('・'),
    });
  }
  activities.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  const rows = [...people.values()].sort((a, b) => b.score - a.score || b.connections - a.connections);
  return {
    generatedAt: now,
    summary: {
      participants: rows.length,
      present: rows.filter((p) => p.present).length,
      edges: edges.length,
      // 「孤島」是這個作品最在意的數字：整場沒跟任何人配對過的人
      isolated: rows.filter((p) => p.connections === 0).length,
      missions: missionList.length,
      quizzes: quizList.length,
      surveys: surveyList.length,
    },
    people: rows,
    activities,
  };
}
