/**
 * W2 事件跳段内核 · Gate 2/S2 验收对象（返工批次 2 · 连续时间锚定）
 * 单测条款：Gate 2 核心（步长不变性）/ S2
 * ---------------------------------------------------------------------------
 * Gate 2 前两项（架构 M1 开工包）：tickMs ∈ {100,250,1000} 三档推进同一初始状态与总时长，
 *   (A) 连续量（资源 amount）偏差 ≤ 0.1%；
 *   (B) 离散事件序列（种类 + 绝对模拟时刻 atMilli）完全一致。
 *
 * 关键：离散事件的可比口径是「种类 + 绝对模拟时刻（毫秒 atMilli）」，不是 tick 序号——
 * 同一时长在不同 tickMs 下 tick 序号不同（10000ms = @1000ms 的 tick 10 = @100ms 的 tick 100）。
 * 事件 atMilli 由连续模拟时间取整（Math.round(simTimeMs)）给出，与 tickMs 无关，故三档一致。
 *
 * 场景设计（本用例边界恰好落在整数毫秒的整数秒上，便于直观核对 absolute 时刻）：
 *   - res「ore」：amount=0,  max=100, rate=+10/s → gap=100，10s 满仓（均 10000ms）
 *   - res「food」：amount=20, max=140, rate=+10/s → gap=120，12s 满仓（均 12000ms）
 *   总时长 60s。三档下满仓事件应出现在完全相同的两项绝对时刻 10000ms / 12000ms。
 *
 * 返工说明：本用例断言与旧版一致（旧版靠 floor 恰好切到整数 tick；新版靠连续距离精确切到
 * 整数毫秒）。旧版「非 tick 对齐到达由 floor 保守取整引入 ≤1 tick 误差」的说明已作废——
 * 新版按连续距离精确切段，任何到达点（含非 tick 对齐）事件 atMilli 都对 tickMs 不变；
 * 该更强的非 tick 对齐一致性由 advance.gate2b.test.ts 覆盖（amount=90.5/90.1/80/3.7/95,0.7）。
 */
import { describe, it, expect } from 'vitest';
import { advance } from '../src/advance.js';
import type { SimState } from '../src/advance.js';
import { resourceBoundarySource } from '../src/events.js';

/** 事件归一化为「种类|资源|绝对毫秒」的可比字符串。 */
function norm(events: { kind: string; payload: Record<string, unknown>; atMilli: number }[]): string[] {
  return events
    .map((e) => `${e.kind}|${String(e.payload.resourceId)}|${e.atMilli}`)
    .sort();
}

function mk(tickMs: number): SimState {
  return {
    currentTick: 0,
    tickMs,
    subMilli: 0,
    resources: {
      ore: { amount: 0, max: 100 },
      food: { amount: 20, max: 140 },
    },
    rates: { ore: 10, food: 10 }, // 10/s：每 tick 增量 10 / 2.5 / 1（精确二进制）
  };
}

function amount(s: SimState, id: string): number {
  const r = s.resources[id];
  if (r === undefined) throw new Error(`missing resource ${id}`);
  return r.amount;
}

describe('advance · 步长不变性（Gate 2 核心 / S2）', () => {
  const src = [resourceBoundarySource()];
  const TICK_MS = [100, 250, 1000] as const;
  const TOTAL_SEC = 60;

  it('(A) 连续量偏差 ≤ 0.1%：三档资源 amount 一致', () => {
    const finals = TICK_MS.map((tickMs) => {
      const s = mk(tickMs);
      const ticks = (TOTAL_SEC * 1000) / tickMs; // 60s 对应的整 tick 数（三档均整除）
      advance(s, { ticks, remainingMs: 0, maxSegmentsThisSlice: 100000 }, src);
      return { ore: amount(s, 'ore'), food: amount(s, 'food') };
    });
    const base = finals[0];
    if (base === undefined) throw new Error('no base');
    for (const f of finals) {
      // 相对偏差 ≤ 0.1%（此处二者均应精确为满仓，偏差为 0；用相对容差表达 Gate 2 阈值）
      expect(Math.abs(f.ore - base.ore) / Math.max(1, Math.abs(base.ore))).toBeLessThanOrEqual(0.001);
      expect(Math.abs(f.food - base.food) / Math.max(1, Math.abs(base.food))).toBeLessThanOrEqual(0.001);
    }
    // 场景落到满仓（封顶精确）
    expect(base.ore).toBe(100);
    expect(base.food).toBe(140);
  });

  it('(B) 离散事件序列完全一致：种类 + 绝对游戏时刻，三档逐项相等', () => {
    const seqs = TICK_MS.map((tickMs) => {
      const s = mk(tickMs);
      const ticks = (TOTAL_SEC * 1000) / tickMs;
      const r = advance(s, { ticks, remainingMs: 0, maxSegmentsThisSlice: 100000 }, src);
      return norm(r.events);
    });
    const base = seqs[0];
    if (base === undefined) throw new Error('no base');
    // 三档事件序列应逐项完全相等
    for (const seq of seqs) expect(seq).toEqual(base);
    // 且确实包含两枚边界事件（ore 10000ms、food 12000ms）
    expect(base).toContain('resource.cap|ore|10000');
    expect(base).toContain('resource.cap|food|12000');
  });

  it('(D) 同引擎重复回放：同一输入两次调用事件逐位一致', () => {
    const run = (): string[] => {
      const s = mk(250);
      const r = advance(s, { ticks: 240, remainingMs: 0, maxSegmentsThisSlice: 100000 }, src);
      return norm(r.events);
    };
    expect(run()).toEqual(run());
  });
});
