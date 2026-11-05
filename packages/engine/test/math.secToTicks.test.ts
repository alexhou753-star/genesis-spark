/**
 * W1 数学原语 · S3/Gate 2/Gate 4 验收对象
 * 单测条款：Gate 2 / S3 验收
 * ---------------------------------------------------------------------------
 * Gate 2（确定性）：整数秒 + 整除 tickMs 时结果为精确整除，向上取整无浮点歧义。
 * S3（跨内核一致性）：仅用整数运算与 `| 0`，三内核一致。
 * 本测试覆盖 tickMs=100/250/1000 三档 × sec=1/60/3600/86400 全组合（手算写死），
 * 以及非整除输入的确定性向上取整案例（设计主要面向整数秒，见 math.ts 注释）。
 */
import { describe, it, expect } from 'vitest';
import { secToTicks } from '../src/math.js';

describe('secToTicks', () => {
  // 手算依据：ticks = ceil(sec*1000 / tickMs)。整数秒时 sec*1000 必被三档 tickMs 整除，
  // 结果即精确整除值。逐格手算：
  //   @100ms : 1s→10, 60s→600, 3600s→36000, 86400s→864000
  //   @250ms : 1s→4,  60s→240, 3600s→14400, 86400s→345600
  //   @1000ms: 1s→1,  60s→60,  3600s→3600,  86400s→86400
  const secs = [1, 60, 3600, 86400];

  it('tickMs=100 全组合', () => {
    const expected = [10, 600, 36000, 864000];
    secs.forEach((s, i) => expect(secToTicks(s, 100)).toBe(expected[i]));
  });

  it('tickMs=250 全组合', () => {
    const expected = [4, 240, 14400, 345600];
    secs.forEach((s, i) => expect(secToTicks(s, 250)).toBe(expected[i]));
  });

  it('tickMs=1000 全组合', () => {
    const expected = [1, 60, 3600, 86400];
    secs.forEach((s, i) => expect(secToTicks(s, 1000)).toBe(expected[i]));
  });

  it('关键锚点：86400s @ 100ms = 864000 ticks', () => {
    expect(secToTicks(86400, 100)).toBe(864000);
  });

  it('sec=0 恒为 0', () => {
    expect(secToTicks(0, 100)).toBe(0);
    expect(secToTicks(0, 250)).toBe(0);
    expect(secToTicks(0, 1000)).toBe(0);
  });

  it('非整除输入：确定性向上取整（设计允许的兜底）', () => {
    // 0.1s = 100ms；@250ms → 100/250 = 0.4，向上取整应为 1
    expect(secToTicks(0.1, 250)).toBe(1);
    // 0.2s = 200ms；@1000ms → 0.2，向上取整应为 1
    expect(secToTicks(0.2, 1000)).toBe(1);
    // 0.3s = 300ms；@250ms → 1.2，向上取整应为 2
    expect(secToTicks(0.3, 250)).toBe(2);
  });
});
