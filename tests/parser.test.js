import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../public/js/parser.js';
import { defaultParams, PARAMS } from '../public/js/params.js';

const run = (text, cur = defaultParams()) => parseCommand(text, cur);
const sign = (v) => Math.sign(v ?? 0);

test('太暗 → 提高曝光', () => {
  assert.equal(sign(run('照片太暗了').changes.exposure), 1);
});

test('太亮 / 過曝 → 降低曝光', () => {
  assert.equal(sign(run('有點太亮').changes.exposure), -1);
  assert.equal(sign(run('過曝了').changes.highlights), -1);
});

test('提亮陰影壓暗亮部（動詞在前）', () => {
  const c = run('提亮陰影壓暗亮部').changes;
  assert.equal(sign(c.shadows), 1);
  assert.equal(sign(c.highlights), -1);
  assert.equal(c.exposure, undefined);
});

test('陰影提亮、亮部拉回（動詞在後）', () => {
  const c = run('陰影提亮一點，亮部拉回來').changes;
  assert.equal(sign(c.shadows), 1);
  assert.equal(sign(c.highlights), -1);
});

test('沒有標點的語音輸入可拆出多個指令', () => {
  const c = run('暖一點亮一點').changes;
  assert.equal(sign(c.temp), 1);
  assert.equal(sign(c.exposure), 1);
});

test('數值：增量與絕對值', () => {
  assert.equal(run('對比加20').changes.contrast, 20);
  assert.equal(run('曝光減0.5').changes.exposure, -0.5);
  assert.equal(run('清晰度調到30').changes.clarity, 30);
  assert.equal(run('飽和度-30').changes.saturation, -30);
});

test('「太」「不要那麼」反轉方向', () => {
  assert.equal(sign(run('飽和度不要太高').changes.saturation), -1);
  assert.equal(sign(run('不要那麼飽和').changes.saturation), -1);
  assert.equal(sign(run('對比太強').changes.contrast), -1);
});

test('色偏修正', () => {
  assert.equal(sign(run('顏色偏黃').changes.temp), -1);
  assert.equal(sign(run('整張偏藍').changes.temp), 1);
  assert.equal(sign(run('有點偏綠').changes.tint), 1);
});

test('膚色只動 HSL / 紋理，不動任何幾何', () => {
  const c = run('膚色太黃了');
  assert.ok(Object.keys(c.changes).every((k) => /_(orange|red|yellow)$/.test(k)));
  const soft = run('皮膚柔一點').changes;
  assert.ok(soft.texture < 0 && soft.texture >= -30, '柔膚有上限，避免塑膠感');
});

test('天空 / 草地', () => {
  assert.equal(sign(run('天空藍一點').changes.sat_blue), 1);
  assert.equal(sign(run('草地更綠').changes.sat_green), 1);
});

test('動作與預設', () => {
  assert.equal(run('復原').action, 'undo');
  assert.equal(run('全部重置').action, 'reset');
  assert.equal(run('黑白').changes.saturation, -100);
  assert.ok(run('來點電影感').reply.includes('電影感'));
});

test('結果都在參數範圍內', () => {
  const r = run('曝光加100 對比調到500 非常非常暖');
  for (const [k, v] of Object.entries(r.changes)) {
    const p = PARAMS.find((x) => x.key === k);
    assert.ok(v >= p.min && v <= p.max, `${k}=${v}`);
  }
});

test('聽不懂時回報 understood=false', () => {
  assert.equal(run('今天天氣如何').understood, false);
});
