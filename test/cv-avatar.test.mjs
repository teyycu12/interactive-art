/**
 * 掃描生成角色（CV Avatar）驗證測試
 *
 * 對應整合計畫階段 3：PF2 接受由 vision/ 服務產出的貼圖角色。
 * 重點在兩件事 ——
 *   1. 捏臉（備援路徑）的行為一個字都不能變
 *   2. CV 分支的 URL 與顏色驗證必須擋得住路徑穿越與注入
 *
 * 執行：node --test
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateAvatarConfig, renderAvatarSVG } from '../shared/avatars.js';

const ASSET = 'a'.repeat(32);

const CV_AVATAR = {
  source: 'CV',
  textures: {
    head: `/assets/gen/${ASSET}/head.webp`,
    torso: `/assets/gen/${ASSET}/torso.webp`,
    legs: `/assets/gen/${ASSET}/legs.webp`,
  },
  fallbackColors: {
    skin: '#F4C08A', hair: '#4A2C1A', torso: '#8FA05E', legs: '#B7A98A',
  },
};

/** 深拷貝後改一個欄位，避免測試之間互相污染 */
function withCV(mutate) {
  const cfg = structuredClone(CV_AVATAR);
  mutate(cfg);
  return cfg;
}

const TOKEN_AVATAR = {
  head: 'head_short_01', face: 'face_smile_01', body: 'body_tee_01',
  accentColor: '#E76F51', skinTone: '#F4A261',
};

describe('CV avatar：合法輸入', () => {
  test('三張貼圖與四個取樣色齊全時通過', () => {
    const r = validateAvatarConfig(CV_AVATAR);
    assert.equal(r.ok, true);
    assert.equal(r.value.source, 'CV');
    assert.deepEqual(r.value.textures, CV_AVATAR.textures);
    assert.deepEqual(r.value.fallbackColors, CV_AVATAR.fallbackColors);
  });

  test('丟棄客戶端夾帶的額外欄位', () => {
    const cfg = withCV((c) => {
      c.isAdmin = true;
      c.textures.extra = '/assets/gen/x/evil.webp';
    });
    const r = validateAvatarConfig(cfg);
    assert.equal(r.ok, true);
    assert.equal(r.value.isAdmin, undefined);
    assert.deepEqual(Object.keys(r.value.textures), ['head', 'torso', 'legs']);
  });

  test('大寫十六進位的取樣色可接受', () => {
    const r = validateAvatarConfig(withCV((c) => { c.fallbackColors.skin = '#ABCDEF'; }));
    assert.equal(r.ok, true);
  });
});

describe('CV avatar：貼圖路徑', () => {
  // 路徑穿越是這個分支最主要的風險：URL 直接來自客戶端，
  // 而它會被螢幕端當成圖片來源載入。
  const BAD_URLS = [
    ['上層目錄穿越', `/assets/gen/${ASSET}/../../../etc/passwd`],
    ['目錄名不是 32 位十六進位', '/assets/gen/..%2F..%2Fetc/head.webp'],
    ['換成絕對外部網址', 'https://evil.example/head.webp'],
    ['協定相對網址', '//evil.example/head.webp'],
    ['data URI', 'data:image/png;base64,AAAA'],
    ['前綴不符', '/assets/other/' + ASSET + '/head.webp'],
    ['副檔名不符', `/assets/gen/${ASSET}/head.svg`],
    ['目錄名含大寫', `/assets/gen/${'A'.repeat(32)}/head.webp`],
    ['目錄名長度不足', '/assets/gen/abc/head.webp'],
    ['尾端夾帶查詢字串', `/assets/gen/${ASSET}/head.webp?x=1`],
  ];

  for (const [label, url] of BAD_URLS) {
    test(`拒絕：${label}`, () => {
      const r = validateAvatarConfig(withCV((c) => { c.textures.head = url; }));
      assert.equal(r.ok, false);
    });
  }

  test('拒絕：部位與檔名對不上（torso 指向 head.webp）', () => {
    const r = validateAvatarConfig(withCV((c) => {
      c.textures.torso = `/assets/gen/${ASSET}/head.webp`;
    }));
    assert.equal(r.ok, false);
  });

  test('拒絕：三張貼圖混用不同資產目錄', () => {
    const r = validateAvatarConfig(withCV((c) => {
      c.textures.legs = `/assets/gen/${'b'.repeat(32)}/legs.webp`;
    }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /資產目錄/);
  });

  test('拒絕：缺少任一部位', () => {
    for (const part of ['head', 'torso', 'legs']) {
      const r = validateAvatarConfig(withCV((c) => { delete c.textures[part]; }));
      assert.equal(r.ok, false, `缺 ${part} 應該被擋下`);
    }
  });

  test('拒絕：textures 不是物件', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      // 陣列雖是物件，但取不到 head/torso/legs，仍會被逐部位檢查擋下
      const r = validateAvatarConfig(withCV((c) => { c.textures = bad; }));
      assert.equal(r.ok, false);
    }
  });
});

describe('CV avatar：取樣色', () => {
  const BAD_HEX = [
    ['三位縮寫', '#ABC'],
    ['缺井字號', 'F4C08A'],
    ['非十六進位字元', '#GGGGGG'],
    ['夾帶 SVG 標記', '#000"/><script>alert(1)</script>'],
    ['夾帶 CSS', 'red;fill:url(#x)'],
    ['八位含 alpha', '#F4C08AFF'],
    ['空字串', ''],
  ];

  for (const [label, hex] of BAD_HEX) {
    test(`拒絕：${label}`, () => {
      const r = validateAvatarConfig(withCV((c) => { c.fallbackColors.skin = hex; }));
      assert.equal(r.ok, false);
    });
  }

  test('拒絕：缺少任一取樣色', () => {
    for (const key of ['skin', 'hair', 'torso', 'legs']) {
      const r = validateAvatarConfig(withCV((c) => { delete c.fallbackColors[key]; }));
      assert.equal(r.ok, false, `缺 ${key} 應該被擋下`);
    }
  });

  test('拒絕：fallbackColors 不是物件', () => {
    const r = validateAvatarConfig(withCV((c) => { c.fallbackColors = null; }));
    assert.equal(r.ok, false);
  });
});

describe('捏臉備援路徑不受影響', () => {
  test('合法 token 設定仍通過，且不帶 source', () => {
    const r = validateAvatarConfig(TOKEN_AVATAR);
    assert.equal(r.ok, true);
    assert.equal(r.value.source, undefined);
    assert.equal(r.value.head, 'head_short_01');
  });

  test('非法 token 仍被擋下', () => {
    const r = validateAvatarConfig({ ...TOKEN_AVATAR, head: 'head_evil' });
    assert.equal(r.ok, false);
  });

  test('調色盤外的顏色仍被擋下', () => {
    const r = validateAvatarConfig({ ...TOKEN_AVATAR, accentColor: '#123456' });
    assert.equal(r.ok, false);
  });

  test('source 不是 CV 時一律走 token 分支', () => {
    // 避免有人用 source 繞過 token 驗證
    const r = validateAvatarConfig({ ...CV_AVATAR, source: 'cv' });
    assert.equal(r.ok, false);
  });

  test('非物件輸入', () => {
    for (const bad of [null, undefined, 'x', 42]) {
      assert.equal(validateAvatarConfig(bad).ok, false);
    }
  });
});

describe('renderAvatarSVG 對 CV 角色的降級', () => {
  test('用取樣色出圖，不留下 undefined', () => {
    const svg = renderAvatarSVG(validateAvatarConfig(CV_AVATAR).value);
    assert.ok(!svg.includes('undefined'), 'SVG 不應出現 undefined');
    assert.ok(svg.includes('#F4C08A'), '應套用取樣的膚色');
    assert.ok(svg.includes('#8FA05E'), '應套用取樣的上衣色');
  });

  test('token 角色的輸出維持原樣', () => {
    const svg = renderAvatarSVG(TOKEN_AVATAR);
    assert.ok(svg.includes('#F4A261'));
    assert.ok(!svg.includes('undefined'));
  });
});
describe('CV avatar：未切割的整張圖（選用）', () => {
  // 2D 大螢幕優先用整張圖 —— 切了又照同一組比例疊回去等於沒切，卻換來三個
  // 請求與整體變形。三張切片保留給之後貼到 3D 部件的用途。
  const withFull = () => withCV((c) => { c.textures.full = `/assets/gen/${ASSET}/full.webp`; });

  test('沒有 full 仍通過（改版前生成的資產不得被踢出場）', () => {
    const r = validateAvatarConfig(CV_AVATAR);
    assert.equal(r.ok, true);
    assert.equal(r.value.textures.full, undefined);
  });

  test('合法的 full 會被保留', () => {
    const r = validateAvatarConfig(withFull());
    assert.equal(r.ok, true);
    assert.equal(r.value.textures.full, `/assets/gen/${ASSET}/full.webp`);
  });

  test('拒絕：full 與三張切片混用不同資產目錄', () => {
    // 少了這條就等於允許把別人的整張圖拼進自己的角色
    const cfg = withCV((c) => { c.textures.full = `/assets/gen/${'b'.repeat(32)}/full.webp`; });
    assert.equal(validateAvatarConfig(cfg).ok, false);
  });

  test('拒絕：full 指向別的部位檔名', () => {
    const cfg = withCV((c) => { c.textures.full = `/assets/gen/${ASSET}/head.webp`; });
    assert.equal(validateAvatarConfig(cfg).ok, false);
  });

  test('拒絕：full 路徑穿越', () => {
    const cfg = withCV((c) => { c.textures.full = `/assets/gen/${ASSET}/../../../etc/passwd`; });
    assert.equal(validateAvatarConfig(cfg).ok, false);
  });

  test('拒絕：full 不是字串', () => {
    const cfg = withCV((c) => { c.textures.full = 42; });
    assert.equal(validateAvatarConfig(cfg).ok, false);
  });
});
