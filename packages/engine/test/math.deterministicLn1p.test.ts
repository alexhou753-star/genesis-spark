/**
 * W1 数学原语 · S3/Gate 2/Gate 4 验收对象
 * 单测条款：Gate 4 / S3 验收
 * ---------------------------------------------------------------------------
 * Gate 4（精度）：域内 |deterministicLn1p(x) − Math.log(1+x)| ≤ 1e-9。
 * S3（跨内核一致性）：主路径为纯多项式 + − *，不含 Math.log / Math.pow；
 *   Math.log 仅用于域外回退（登记为 S3 观察项）。
 * 本测试覆盖：域内采样与随机点误差、x=0 精确返回 0、违域抛错、黄金向量。
 */
import { describe, it, expect } from 'vitest';
import { deterministicLn1p, mulberry32 } from '../src/math.js';

describe('deterministicLn1p', () => {
  it('域内 vs Math.log(1+x)：误差 ≤ 1e-9（固定采样点）', () => {
    const xs = [-0.5, -0.1, 0, 0.1, 0.5];
    for (const x of xs) {
      const diff = Math.abs(deterministicLn1p(x) - Math.log(1 + x));
      expect(diff).toBeLessThanOrEqual(1e-9);
    }
  });

  it('域内 vs Math.log(1+x)：误差 ≤ 1e-9（100 个伪随机点，确定性可重放）', () => {
    const rng = mulberry32(0x9e3779b9); // 复用本工程 PRNG，保证测试确定性
    for (let i = 0; i < 100; i++) {
      const x = -0.5 + rng() * 1.0; // 映射到 [−0.5, 0.5)
      const diff = Math.abs(deterministicLn1p(x) - Math.log(1 + x));
      expect(diff).toBeLessThanOrEqual(1e-9);
    }
  });

  it('收敛点：x=0 精确返回 0', () => {
    const v = deterministicLn1p(0);
    expect(v).toBe(0);
    // 确认是 +0 而非 −0（Object.is 区分二者）
    expect(Object.is(v, 0)).toBe(true);
  });

  it('违域抛确定性错误：x=-1、x=-2', () => {
    expect(() => deterministicLn1p(-1)).toThrow();
    expect(() => deterministicLn1p(-2)).toThrow();
  });

  it('黄金向量前 3 个值（真实 ln 常数，13 位有效数字）', () => {
    // ln(0.5) = −ln2 = −0.6931471805599453…
    expect(deterministicLn1p(-0.5)).toBeCloseTo(-0.6931471805599453, 9);
    // ln(1.0) = 0
    expect(deterministicLn1p(0)).toBeCloseTo(0, 9);
    // ln(1.5) = 0.40546510810816438…
    expect(deterministicLn1p(0.5)).toBeCloseTo(0.4054651081081644, 9);
  });

  it('域外回退：x=2 与 Math.log(3) 一致（回退路径正确性，非确定性保证）', () => {
    expect(deterministicLn1p(2)).toBeCloseTo(Math.log(3), 12);
  });
});
