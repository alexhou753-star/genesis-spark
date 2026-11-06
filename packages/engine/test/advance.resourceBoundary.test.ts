/**
 * W2 事件跳段内核 · Gate 2/S2 验收对象（返工批次 2 · 连续时间锚定）
 * 单测条款：Gate 2（资源边界精确切分）/ 架构 5.2 / 5.2.9
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) 满仓精确切分：amount=90,max=100,rate=1/s,tickMs=1000 → 第 10 秒恰好到 100，绝不超过。
 *   2) 耗尽精确切分：amount=10,rate=-1/s → 第 10 秒恰好到 0，绝不穿 0。
 *   3) rate=0 资源不产生边界事件、也不压短段长。
 *   4) max=Infinity 资源不产生满仓事件（只增不封顶）。
 *   5) 已满仓资源不产生伪事件、也不把步长压成极小段（边界稳态排除）。
 *   6) 直接校验 resourceBoundarySource.nextEventDistanceMs 返回「连续毫秒」（不做 floor、
 *      且与 tickMs 无关：三档 tickMs 下同一物理到达点返回同一个连续毫秒）。
 *
 * 返工说明：接口由 nextEventDistanceTicks（整数 frame，含 floor）改为 nextEventDistanceMs
 * （连续毫秒，不含 floor）。因此本文件的距离断言由「整数 tick」改为「连续毫秒」，且额外
 * 断言其对 tickMs 的不变性 —— 这正是 Gate 2-B 事件时刻不漂移的根基。
 *
 * 说明：本文件 import 同级 './advance.js' 与 './events.js'（nodenext ESM，带 .js 扩展）。
 */
import { describe, it, expect } from 'vitest';
import { advance } from '../src/advance.js';
import type { SimState } from '../src/advance.js';
import { resourceBoundarySource } from '../src/events.js';

/** 读取资源量（避开 noUncheckedIndexedAccess 的 undefined 推断）。 */
function amount(s: SimState, id: string): number {
  const r = s.resources[id];
  if (r === undefined) throw new Error(`missing resource ${id}`);
  return r.amount;
}

/** 组装一个最小状态。 */
function mk(resources: Record<string, { amount: number; max: number }>, rates: Record<string, number>, tickMs: number): SimState {
  return { currentTick: 0, tickMs, subMilli: 0, resources, rates };
}

describe('advance · 资源边界精确切分（Gate 2-C / 5.2.9）', () => {
  const src = [resourceBoundarySource()];

  it('满仓精确切分：90→100 @ rate=1/s, tickMs=1000，第 10 秒恰好到 100 且不过冲', () => {
    const s = mk({ wood: { amount: 90, max: 100 } }, { wood: 1 }, 1000);
    const r = advance(s, { ticks: 10, remainingMs: 0, maxSegmentsThisSlice: 1000 }, src);
    expect(amount(s, 'wood')).toBe(100); // 精确 100，绝不超过
    expect(r.ticksAdvanced).toBe(10);
    expect(r.remainingTicks).toBe(0);
    expect(r.completed).toBe(true);
    const caps = r.events.filter((e) => e.kind === 'resource.cap' && e.payload.resourceId === 'wood');
    expect(caps.length).toBe(1);
    expect(caps[0]?.atMilli).toBe(10000); // 连续时刻 10s = 10000ms（绝对模拟时刻）
  });

  it('满仓后继续推进：封顶在 100，不重复刷事件', () => {
    const s = mk({ wood: { amount: 90, max: 100 } }, { wood: 1 }, 1000);
    const r = advance(s, { ticks: 30, remainingMs: 0, maxSegmentsThisSlice: 1000 }, src);
    expect(amount(s, 'wood')).toBe(100);
    // 整段只应产生 1 次满仓事件（跃迁一次），后续保持段不再产事件
    expect(r.events.filter((e) => e.kind === 'resource.cap').length).toBe(1);
  });

  it('耗尽精确切分：10→0 @ rate=-1/s，第 10 秒恰好到 0 且不穿 0', () => {
    const s = mk({ food: { amount: 10, max: 100 } }, { food: -1 }, 1000);
    const r = advance(s, { ticks: 10, remainingMs: 0, maxSegmentsThisSlice: 1000 }, src);
    expect(amount(s, 'food')).toBe(0);
    const empties = r.events.filter((e) => e.kind === 'resource.empty' && e.payload.resourceId === 'food');
    expect(empties.length).toBe(1);
    expect(empties[0]?.atMilli).toBe(10000);
  });

  it('耗尽后继续推进：停在 0，不为负', () => {
    const s = mk({ food: { amount: 10, max: 100 } }, { food: -1 }, 1000);
    advance(s, { ticks: 30, remainingMs: 0, maxSegmentsThisSlice: 1000 }, src);
    expect(amount(s, 'food')).toBe(0); // 全程不为负
  });

  it('rate=0 资源不产生边界事件、不压短段长', () => {
    const s = mk({ idle: { amount: 50, max: 100 } }, { idle: 0 }, 1000);
    const r = advance(s, { ticks: 100, remainingMs: 0, maxSegmentsThisSlice: 1000 }, src);
    expect(amount(s, 'idle')).toBe(50);
    expect(r.events.length).toBe(0);
    expect(r.ticksAdvanced).toBe(100); // 一次性走完（无事件把步长压短）
  });

  it('max=Infinity 资源只增不封顶、不产生满仓事件', () => {
    const s = mk({ mana: { amount: 0, max: Number.POSITIVE_INFINITY } }, { mana: 1 }, 1000);
    const r = advance(s, { ticks: 5, remainingMs: 0, maxSegmentsThisSlice: 1000 }, src);
    expect(amount(s, 'mana')).toBe(5);
    expect(r.events.length).toBe(0);
  });

  it('已满仓资源不产生伪事件、也不把步长压成极小段（边界稳态排除）', () => {
    const s = mk({ wood: { amount: 100, max: 100 } }, { wood: 1 }, 1000);
    const r = advance(s, { ticks: 5, remainingMs: 0, maxSegmentsThisSlice: 1000 }, src);
    expect(amount(s, 'wood')).toBe(100); // 封顶
    expect(r.events.length).toBe(0); // 稳态：无事件
    expect(r.ticksAdvanced).toBe(5);
  });

  it('nextEventDistanceMs 返回连续毫秒：不做 floor，且与 tickMs 无关（三档一致）', () => {
    const a = resourceBoundarySource();
    // 90→100 @ rate=1/s → 距满仓 10s = 10000ms（三档 tickMs 完全一致，证明不读 tickMs）
    for (const t of [100, 250, 1000]) {
      expect(a.nextEventDistanceMs(mk({ r: { amount: 90, max: 100 } }, { r: 1 }, t))).toBe(10000);
    }
    // 95→100 @ rate=3/s → 5/3 s ≈ 1666.666…ms（连续小数，不 floor 成整数）
    const d95 = a.nextEventDistanceMs(mk({ r: { amount: 95, max: 100 } }, { r: 3 }, 1000));
    expect(d95).toBeCloseTo(5000 / 3, 9); // 5000/3 ms
    // rate=0 → Infinity（无事件）
    expect(a.nextEventDistanceMs(mk({ r: { amount: 50, max: 100 } }, { r: 0 }, 1000))).toBe(Number.POSITIVE_INFINITY);
    // 已满仓 → Infinity（稳态排除）
    expect(a.nextEventDistanceMs(mk({ r: { amount: 100, max: 100 } }, { r: 1 }, 1000))).toBe(Number.POSITIVE_INFINITY);
    // 耗尽型：10 库存 @ rate=-2/s → 5s = 5000ms
    expect(a.nextEventDistanceMs(mk({ r: { amount: 10, max: 100 } }, { r: -2 }, 1000))).toBe(5000);
  });
});
