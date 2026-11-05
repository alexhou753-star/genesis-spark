/**
 * W1 数学原语 · S3/Gate 2/Gate 4 验收对象
 * 单测条款：Gate 2 / S3 验收
 * ---------------------------------------------------------------------------
 * Gate 2（确定性）：同一 seed 的 Mulberry32 序列在任意引擎上必须逐位可重现。
 * S3（跨内核一致性）：输出仅由 32 位整数运算决定，V8 / JavaScriptCore / SpiderMonkey 一致。
 * 本测试校验：同 seed 序列确定、不同 seed 不同、分布粗检、边界 seed、
 * 以及与业界参考向量（Hawkynt/Cipher 文档 + bryc 实现）的黄金向量对照。
 */
import { describe, it, expect } from 'vitest';
import { mulberry32 } from '../src/math.js';

describe('mulberry32', () => {
  it('同 seed 两次实例序列逐位相等（Gate 2 确定性）', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it('不同 seed 序列不同', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (a() === b()) same++;
    }
    expect(same).toBeLessThan(5); // 100 次里几乎不可能出现 ≥5 次相等
  });

  it('分布粗检：10 万样本均值 ∈ [0.45, 0.55]', () => {
    const rng = mulberry32(2024);
    let sum = 0;
    const n = 100000;
    for (let i = 0; i < n; i++) sum += rng();
    expect(sum / n).toBeGreaterThanOrEqual(0.45);
    expect(sum / n).toBeLessThanOrEqual(0.55);
  });

  it('边界 seed=0 与 seed=0xFFFFFFFF 可用（返回有限 [0,1) 值）', () => {
    for (const seed of [0, 0xffffffff]) {
      const rng = mulberry32(seed);
      for (let i = 0; i < 10; i++) {
        const v = rng();
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('黄金向量：seed=0 前 5 个值（对照 Hawkynt/Cipher 文档与 bryc 参考实现）', () => {
    // 参考文档给出 uint32 输出的大端字节序（big-endian），逐 4 字节解读为 uint32，
    // 再 /2^32 得到 [0,1) 浮点。实现与本断言用同一整数分子 + 同一 2^32 除数，
    // 故两次 IEEE 除法结果逐位相同，可用 toBe 精确断言。
    const rng = mulberry32(0);
    const expected = [
      0x4434b462 / 4294967296, // ≈ 0.26642920868471265
      0x00159c37 / 4294967296,
      0x39285b08 / 4294967296,
      0x256d8104 / 4294967296,
      0x77a2cbd4 / 4294967296,
    ];
    for (const e of expected) expect(rng()).toBe(e);
  });

  it('黄金向量：seed=42 前 5 个值', () => {
    const rng = mulberry32(42);
    const expected = [
      0x99e1ef7c / 4294967296, // ≈ 0.6011037519201636
      0x72c32b8a / 4294967296,
      0xda3b32c0 / 4294967296,
      0xab73b0ad / 4294967296,
      0x2cc09a8a / 4294967296,
    ];
    for (const e of expected) expect(rng()).toBe(e);
  });

  it('黄金向量：seed=12345 前 5 个值', () => {
    const rng = mulberry32(12345);
    const expected = [
      0xfacf78c5 / 4294967296, // ≈ 0.9796807284297556
      0x4e875100 / 4294967296,
      0x7bf4e2f2 / 4294967296,
      0xd1642650 / 4294967296,
      0x8269e5ca / 4294967296,
    ];
    for (const e of expected) expect(rng()).toBe(e);
  });

  it('黄金向量：seed=0xFFFFFFFF（最大 32 位）前 5 个值', () => {
    const rng = mulberry32(0xffffffff);
    const expected = [
      0xe57bf3d3 / 4294967296,
      0x3081a5a4 / 4294967296,
      0xb7350390 / 4294967296,
      0xf1ade904 / 4294967296,
      0xd8616a2f / 4294967296,
    ];
    for (const e of expected) expect(rng()).toBe(e);
  });
});
