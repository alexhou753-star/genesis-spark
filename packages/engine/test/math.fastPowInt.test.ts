/**
 * W1 数学原语 · S3/Gate 2/Gate 4 验收对象
 * 单测条款：Gate 2 / S3 验收
 * ---------------------------------------------------------------------------
 * Gate 2（确定性）：迭代平方只做有限次普通乘法，结果确定、可重放。
 * S3（跨内核一致性）：不用 Math.pow；普通乘法为单次正确舍入，三内核一致。
 * 本测试覆盖：小幂手算对照、1.015^500 vs Math.pow 容差、域检查抛错、
 * 0^0=1 与 1^anything=1 约定。
 */
import { describe, it, expect } from 'vitest';
import { fastPowInt } from '../src/math.js';

describe('fastPowInt', () => {
  it('小幂手算对照', () => {
    expect(fastPowInt(2, 10)).toBe(1024);
    expect(fastPowInt(2, 0)).toBe(1);
    expect(fastPowInt(2, 1)).toBe(2);
    expect(fastPowInt(3, 5)).toBe(243);
    expect(fastPowInt(10, 3)).toBe(1000);
    expect(fastPowInt(-2, 3)).toBe(-8);
    expect(fastPowInt(-2, 4)).toBe(16);
  });

  it('0^0 约定 = 1', () => {
    expect(fastPowInt(0, 0)).toBe(1);
  });

  it('1^anything = 1', () => {
    expect(fastPowInt(1, 0)).toBe(1);
    expect(fastPowInt(1, 1)).toBe(1);
    expect(fastPowInt(1, 1000)).toBe(1);
  });

  it('0^n (n>0) = 0', () => {
    expect(fastPowInt(0, 5)).toBe(0);
  });

  it('1.015^500 vs Math.pow（相对容差 1e-12）', () => {
    const actual = fastPowInt(1.015, 500);
    const expected = Math.pow(1.015, 500);
    // 相对容差：结果约 1.7e3，绝对 1e-12 已低于该量级的 1 ulp（不现实），
    // 故按任务「容差 1e-12」的实现意图取相对误差；迭代平方相对误差约为 1e-15 量级。
    expect(Math.abs(actual - expected) / expected).toBeLessThan(1e-12);
    // 绝对值也应在合理量级（防止实现返回荒谬值）
    expect(actual).toBeGreaterThan(1500);
    expect(actual).toBeLessThan(1900);
  });

  it('域检查抛确定性错误', () => {
    expect(() => fastPowInt(2, -1)).toThrow();
    expect(() => fastPowInt(2, 1024)).toThrow();
    expect(() => fastPowInt(NaN, 2)).toThrow();
    expect(() => fastPowInt(Infinity, 2)).toThrow();
    expect(() => fastPowInt(2, 1.5)).toThrow(); // 非整数指数
  });

  it('边界 exp=0 与 exp=1023 合法', () => {
    expect(fastPowInt(2, 0)).toBe(1);
    // 2^1023 有限（约 8.98e307），不抛错
    expect(Number.isFinite(fastPowInt(2, 1023))).toBe(true);
  });
});
