import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { listHistoricalAvatars, withAssetOutfit } from '../server/devAvatars.js';
import { validateAvatarConfig } from '../shared/avatars.js';

const HEX32 = (c) => c.repeat(32);

/** 造一個假的 public/assets/gen，parts 指定哪幾張貼圖存在 */
async function fixture(dirs) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-dev-'));
  for (const [name, spec] of Object.entries(dirs)) {
    const dir = path.join(root, 'assets', 'gen', name);
    await fs.mkdir(dir, { recursive: true });
    for (const part of spec.parts ?? []) await fs.writeFile(path.join(dir, part), 'x');
    if (spec.colors !== undefined) {
      await fs.writeFile(path.join(dir, 'colors.json'), spec.colors);
    }
  }
  return root;
}

const FOUR = ['head.webp', 'torso.webp', 'legs.webp', 'full.webp'];
const GOOD_COLORS = JSON.stringify({ hair: '#3B2B28', skin: '#C7A099', torso: '#E8E8E8', legs: '#ECBFA3' });

test('貼圖齊全的才列出來', async () => {
  const root = await fixture({
    [HEX32('a')]: { parts: FOUR, colors: GOOD_COLORS },
    // 缺 full 的：validateAvatarConfig 不會拒（full 是選用），但少了它大螢幕就得走
    // 三張切片那條路，而匯入台的縮圖也沒東西可顯示，一律當成不可用
    [HEX32('b')]: { parts: ['head.webp', 'torso.webp', 'legs.webp'] },
    // 改版前的 .png 舊資產：TEXTURE_URL_RE 只接受 .webp，列出來只會變成按了被拒的那一格
    [HEX32('c')]: { parts: ['head.png', 'torso.png', 'legs.png', 'full.png'] },
    // 不是 uuid4().hex 的目錄名（場景自己的貼圖夾之類）
    'not-an-asset-id': { parts: FOUR },
  });
  const list = await listHistoricalAvatars(root);
  assert.deepEqual(list.map((a) => a.assetId), [HEX32('a')]);
});

test('列出來的外觀能直接通過伺服器端的驗證', async () => {
  const root = await fixture({ [HEX32('d')]: { parts: FOUR, colors: GOOD_COLORS } });
  const [only] = await listHistoricalAvatars(root);
  // 這一條是這個模組存在的理由：清單上的東西必須能真的進場。
  // 貼圖路徑形狀或色票鍵名對不上時，症狀是匯入台按了沒反應（CLIENT_REJECT），
  // 而瀏覽器主控台不會有任何錯誤。
  const res = validateAvatarConfig({
    source: 'CV', textures: only.textures, fallbackColors: only.colors,
  });
  assert.equal(res.ok, true, res.reason);
});

test('色票壞掉或沒有時回 null，不就地補假色', async () => {
  const root = await fixture({
    [HEX32('e')]: { parts: FOUR },                                   // 沒跑取樣腳本
    [HEX32('f')]: { parts: FOUR, colors: '{ 壞掉的 json' },
    [HEX32('0')]: { parts: FOUR, colors: JSON.stringify({ hair: '#fff' }) },      // 缺鍵
    [HEX32('1')]: { parts: FOUR, colors: JSON.stringify({ hair: 'red', skin: '#C7A099', torso: '#E8E8E8', legs: '#ECBFA3' }) },
  });
  const list = await listHistoricalAvatars(root);
  assert.equal(list.length, 4);
  // 假色會讓顏色任務叫大家去找紅衣服的人，而那個人在畫面上是藍的，
  // 因此寧可回 null 讓匯入台明確警告
  assert.ok(list.every((a) => a.colors === null), JSON.stringify(list.map((a) => a.colors)));
});

test('新生成的排前面', async () => {
  const root = await fixture({
    [HEX32('2')]: { parts: FOUR },
    [HEX32('3')]: { parts: FOUR },
  });
  const newer = path.join(root, 'assets', 'gen', HEX32('2'), 'full.webp');
  const future = new Date(Date.now() + 60_000);
  await fs.utimes(newer, future, future);
  const list = await listHistoricalAvatars(root);
  assert.deepEqual(list.map((a) => a.assetId), [HEX32('2'), HEX32('3')]);
});

test('還沒有人生成過時回空陣列，而不是拋例外', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pf-dev-empty-'));
  assert.deepEqual(await listHistoricalAvatars(root), []);
});

test('有側面與背面就帶上，並標 turns（NPC 只挑會轉身的）', async () => {
  const root = await fixture({
    [HEX32('7')]: { parts: [...FOUR, 'side.webp', 'back.webp'], colors: GOOD_COLORS },
    [HEX32('8')]: { parts: FOUR, colors: GOOD_COLORS },
  });
  const list = await listHistoricalAvatars(root);
  const full = list.find((a) => a.assetId === HEX32('7'));
  const flat = list.find((a) => a.assetId === HEX32('8'));
  // 少了側面與背面，角色只有正面：不會轉身、走路不擺手（avatarSprite 只在有側面時載 arms.json）
  assert.equal(full.turns, true);
  assert.match(full.textures.side, /side\.webp$/);
  assert.match(full.textures.back, /back\.webp$/);
  assert.equal(flat.turns, false);
  assert.equal(flat.textures.side, undefined);
  // 帶上側面與背面之後，照樣過得了伺服器端的驗證
  const res = validateAvatarConfig({ source: 'CV', textures: full.textures, fallbackColors: full.colors });
  assert.equal(res.ok, true, res.reason);
  assert.ok(res.value.textures.side && res.value.textures.back);
});

test('舊手機沒送衣服顏色清單：伺服器從資產目錄補上；有送就不動', async () => {
  const id = HEX32('9');
  const root = await fixture({
    [id]: { parts: FOUR, colors: JSON.stringify({ ...JSON.parse(GOOD_COLORS), outfit: ['#52687C', '#8E775F', 'bad'] }) },
  });
  const textures = Object.fromEntries(['head', 'torso', 'legs', 'full'].map((p) => [p, `/assets/gen/${id}/${p}.webp`]));
  const old = validateAvatarConfig({ source: 'CV', textures, fallbackColors: JSON.parse(GOOD_COLORS) }).value;
  assert.deepEqual(withAssetOutfit(root, old, 4).outfitColors, ['#52687C', '#8E775F']);

  const sent = { ...old, outfitColors: ['#FF0000'] };
  assert.equal(withAssetOutfit(root, sent, 4), sent);
  // 資產目錄不存在、或不是 CV 角色：原樣回傳，不擋進場
  const gone = { ...old, textures: { ...textures, full: `/assets/gen/${HEX32('8')}/full.webp` } };
  assert.equal(withAssetOutfit(root, gone, 4), gone);
  const token = { source: 'TOKEN', accentColor: '#123456' };
  assert.equal(withAssetOutfit(root, token, 4), token);
});
