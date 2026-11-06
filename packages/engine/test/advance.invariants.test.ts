/**
 * W2 事件跳段内核 · Gate 2/S2 验收对象
 * 单测条款：不变量断言（架构 5.2 阶段末断言 / 5.6 算术约束）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 人为构造「会超调」的场景（未登记边界源、用大预算一次推进），断言边界钳制守住：
 *      amount 不超 max、不为负；人口非负。
 *   2) assertInvariants 对若干非法状态抛带 code 的确定性错误：
 *      amount<0 / amount>max / max<0 / subMilli 越界 / amount 非有限。
 *   3) 正常推进（含边界事件）后整段不变量恒成立（段末 + 结束断言不误报）。
 *
 * 说明：本测试刻意验证「钳制是最后一道保险」——即使没有 A 边界源精确切段，大预算推进
 * 后也不允许 amount 越界为负或超上限。
 */
import { describe, it, expect } from 'vitest';
import { advance, assertInvariants, DeterminismError } from '../src/advance.js';
import type { SimState } from '../src/advance.js';
import { resourceBoundarySource } from '../src/events.js';

/** 组装状态：显式参数，避免 exactOptionalPropertyTypes 下展开可选字段的问题。 */
function mk(
  resources: Record<string, { amount: number; max: number }>,
  rates: Record<string, number> = {},
  subMilli = 0,
): SimState {
  return { currentTick: 0, tickMs: 1000, subMilli, resources, rates };
}

function amount(s: SimState, id: string): number {
  const r = s.resources[id];
  if (r === undefined) throw new Error(`missing resource ${id}`);
  return r.amount;
}

/** 断言 assertInvariants 抛出指定 code 的 DeterminismError。 */
function expectCode(state: SimState, code: string): void {
  try {
    assertInvariants(state);
    throw new Error('should have thrown');
  } catch (e) {
    expect(e).toBeInstanceOf(DeterminismError);
    expect((e as DeterminismError).code).toBe(code);
  }
}

describe('advance · 不变量断言（Gate 2 / 5.2 / 5.6）', () => {
  it('会超调场景（无边界源、大预算）：amount 不超 max、不为负', () => {
    // 增长型从 90 用 rate=5/s 一次性推进 100 tick（100s）→ 名义 90+500=590，应被封顶到 100
    const grow = mk({ a: { amount: 90, max: 100 } }, { a: 5 });
    advance(grow, { ticks: 100, remainingMs: 0, maxSegmentsThisSlice: 10 }, []); // 无事件源
    expect(amount(grow, 'a')).toBe(100); // 不超 max
    expect(amount(grow, 'a')).toBeLessThanOrEqual(100);

    // 消耗型从 10 用 rate=-5/s 一次性推进 100 tick → 名义 10-500=-490，应被夹到 0
    const drain = mk({ b: { amount: 10, max: 100 } }, { b: -5 });
    advance(drain, { ticks: 100, remainingMs: 0, maxSegmentsThisSlice: 10 }, []);
    expect(amount(drain, 'b')).toBe(0); // 不为负
    expect(amount(drain, 'b')).toBeGreaterThanOrEqual(0);
  });

  it('人口非负：population 资源耗尽也被夹到 0，不变量不报错', () => {
    const s = mk({ population: { amount: 3, max: 50 } }, { population: -10 });
    expect(() => advance(s, { ticks: 100, remainingMs: 0, maxSegmentsThisSlice: 10 }, [])).not.toThrow();
    expect(amount(s, 'population')).toBe(0);
  });

  it('assertInvariants：amount<0 抛 INV_AMOUNT_NEGATIVE', () => {
    expectCode(mk({ a: { amount: -1, max: 100 } }), 'INV_AMOUNT_NEGATIVE');
  });

  it('assertInvariants：amount>max 抛 INV_AMOUNT_OVER_MAX', () => {
    expectCode(mk({ a: { amount: 101, max: 100 } }), 'INV_AMOUNT_OVER_MAX');
  });

  it('assertInvariants：max<0 抛 INV_MAX_NEGATIVE', () => {
    expectCode(mk({ a: { amount: 0, max: -1 } }), 'INV_MAX_NEGATIVE');
  });

  it('assertInvariants：subMilli 越界（>=tickMs）抛 INV_SUB_MILLI', () => {
    expectCode(mk({ a: { amount: 0, max: 100 } }, {}, 1000), 'INV_SUB_MILLI');
  });

  it('assertInvariants：amount 非有限（NaN）抛 INV_AMOUNT_FINITE', () => {
    expectCode(mk({ a: { amount: Number.NaN, max: 100 } }), 'INV_AMOUNT_FINITE');
  });

  it('advance 入口对非法状态抛 code 错误（不静默推进）', () => {
    const bad = mk({ a: { amount: -5, max: 100 } }, { a: 1 });
    try {
      advance(bad, { ticks: 1, remainingMs: 0, maxSegmentsThisSlice: 10 }, []);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DeterminismError);
      expect((e as DeterminismError).code).toBe('INV_AMOUNT_NEGATIVE');
    }
    // 脏状态未被静默推进：currentTick 仍为 0
    expect(bad.currentTick).toBe(0);
  });

  it('正常推进（含边界事件）后不变量恒成立：逐段断言不误报', () => {
    const s = mk({ a: { amount: 90, max: 100 } }, { a: 1 });
    // 用 A 边界源跑 20 tick（10 tick 满仓 + 10 tick 保持）；段末与结束断言应全程通过。
    expect(() =>
      advance(s, { ticks: 20, remainingMs: 0, maxSegmentsThisSlice: 1000 }, [resourceBoundarySource()]),
    ).not.toThrow();
    expect(amount(s, 'a')).toBe(100);
  });
});
