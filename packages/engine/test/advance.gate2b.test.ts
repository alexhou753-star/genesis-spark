/**
 * W2 事件跳段内核 · Gate 2-B 专项回归（返工批次 2 · 连续时间锚定）
 * ===========================================================================
 * 目的：锁死「步长不变性-离散事件时刻一致」（Gate 2-B）在【非 tick 对齐】场景下的回归。
 *
 * 返工前实测 bug（旧实现用 frame floor 切段，事件推到 frame 末尾的整数 tick）：
 *   - amount=90.5, rate=1：
 *       tickMs=100/250 → cap 事件 @9500ms，但 tickMs=1000 → @10000ms（漂 500ms）。
 *   - amount=95, rate=0.7：
 *       tickMs=100 → 7200ms / 250 → 7250ms / 1000 → 8000ms（漂 800ms）。
 *   根因：旧事件时刻 = frame×tickMs，frame 是 tickMs 的函数，量化点随 tickMs 移动。
 *
 * 修复后（连续时间锚定）：事件源返回「连续毫秒距离」，advance 按连续毫秒精确推进 simTime，
 * 事件 atMilli = round(simTimeMs)。同一物理到达点在任何 tickMs 下 simTime 相同 → atMilli 必然
 * 一致。本文件用下面 4 个非 tick 对齐用例，对 tickMs=100/250/1000 三档断言：
 *   (a) 事件序列（kind + atMilli）逐项完全一致；
 *   (b) 事件 atMilli 等于物理到达点（round）；
 *   (c) 连续量终值三档一致。
 *
 * 4 个用例（均 max=100，仅资源名 'r'）：
 *   ① amount=90.5, rate=1   → 到达 (100-90.5)/1   = 9.5s   = 9500ms   （旧 @1000 漂到 10000）
 *   ② amount=90.1, rate=1   → 到达 (100-90.1)/1   = 9.9s   = 9900ms   （旧 @1000 漂到 10000）
 *   ③ amount=80,   rate=3.7 → 到达 (100-80)/3.7   ≈ 5.4054s= 5405ms   （旧三档 5405/5405/6000）
 *   ④ amount=95,   rate=0.7 → 到达 (100-95)/0.7   ≈ 7.1429s= 7143ms   （旧三档 7200/7250/8000）
 *
 * 静态说明：本文件只做静态自检（类型 + 断言逻辑），运行由 vitest 执行；不伪造运行结果。
 */
import { describe, it, expect } from 'vitest';
import { advance } from '../src/advance.js';
import type { SimState } from '../src/advance.js';
import { resourceBoundarySource } from '../src/events.js';

/** 三档 tickMs（Gate 2 口径）。 */
const TICK_MS = [100, 250, 1000] as const;

/** 总时长（秒）：20s 足以覆盖全部 4 个用例的到达点（最晚 9.9s），且对三档 tickMs 都整除。 */
const TOTAL_SEC = 20;

/** 组装单资源状态：id 固定为 'r'。 */
function mkState(amount: number, max: number, rate: number, tickMs: number): SimState {
  return {
    currentTick: 0,
    tickMs,
    subMilli: 0,
    resources: { r: { amount, max } },
    rates: { r: rate },
  };
}

/** 读取资源量（避开 noUncheckedIndexedAccess）。 */
function amountOf(s: SimState, id: string): number {
  const res = s.resources[id];
  if (res === undefined) throw new Error(`missing resource ${id}`);
  return res.amount;
}

/** 事件归一化为「kind|resourceId|atMilli」的可比字符串数组（按 atMilli、kind 排序便于比较）。 */
function norm(events: { kind: string; payload: Record<string, unknown>; atMilli: number }[]): string[] {
  return events
    .map((e) => `${e.kind}|${String(e.payload.resourceId)}|${e.atMilli}`)
    .sort();
}

interface RunResult {
  seq: string[];
  finalAmount: number;
  atMillis: number[];
}

/** 在指定 tickMs 下跑满 TOTAL_SEC，返回事件序列 + 连续量终值 + 事件 atMilli 列表。 */
function runAt(amount: number, max: number, rate: number, tickMs: number): RunResult {
  const s = mkState(amount, max, rate, tickMs);
  const ticks = (TOTAL_SEC * 1000) / tickMs; // 三档均整除（200/80/20）
  const r = advance(s, { ticks, remainingMs: 0, maxSegmentsThisSlice: 100000 }, [resourceBoundarySource()]);
  const atMillis = r.events.map((e) => e.atMilli);
  return { seq: norm(r.events), finalAmount: amountOf(s, 'r'), atMillis };
}

/**
 * 对单个用例，跨三档 tickMs 断言 Gate 2-B：事件序列一致、atMilli = 期望物理到达点、终值一致。
 * 期望事件：恰好一条 'resource.cap|r|<expectAtMilli>'。
 */
function assertCase(amount: number, rate: number, expectAtMilli: number): void {
  const runs = TICK_MS.map((tickMs) => ({ tickMs, res: runAt(amount, 100, rate, tickMs) }));
  const base = runs[0];
  if (base === undefined) throw new Error('no base run');

  // 期望事件序列（单一满仓事件，atMilli 为物理到达点 round）。
  const expectedSeq = [`resource.cap|r|${expectAtMilli}`];

  for (const { tickMs, res } of runs) {
    // (a) 事件序列（kind + atMilli）三档逐项完全一致，且等于期望物理到达点。
    expect(res.seq, `tickMs=${tickMs} 事件序列`).toEqual(expectedSeq);
    expect(res.seq, `tickMs=${tickMs} 应与基准逐项相等`).toEqual(base.res.seq);

    // (b) 事件 atMilli 精确等于期望（Math.round(物理秒×1000)），且三档相同。
    expect(res.atMillis, `tickMs=${tickMs} atMilli`).toEqual([expectAtMilli]);

    // (c) 连续量终值三档一致（此场景到达后封顶于 max=100）。
    expect(res.finalAmount, `tickMs=${tickMs} 终值`).toBe(base.res.finalAmount);
    expect(res.finalAmount, `tickMs=${tickMs} 应封顶为 100`).toBe(100);
  }
}

describe('advance · Gate 2-B 非 tick 对齐回归（连续时间锚定）', () => {
  it('① amount=90.5, rate=1 → cap @9500ms（三档一致；旧 @1000ms 漂到 10000）', () => {
    assertCase(90.5, 1, 9500);
  });

  it('② amount=90.1, rate=1 → cap @9900ms（三档一致；旧 @1000ms 漂到 10000）', () => {
    assertCase(90.1, 1, 9900);
  });

  it('③ amount=80, rate=3.7 → cap @5405ms（三档一致；旧 @1000ms 漂到 6000）', () => {
    assertCase(80, 3.7, 5405);
  });

  it('④ amount=95, rate=0.7 → cap @7143ms（三档一致；旧 7200/7250/8000 漂 800ms）', () => {
    assertCase(95, 0.7, 7143);
  });

  it('补充：连续量终值对 tickMs 不变——不封顶场景（max=Infinity）三档终值一致', () => {
    // rate=1/s 跑 TOTAL_SEC=20s → 终值 20（不触任何边界），三档应逐位一致。
    const finals = TICK_MS.map((tickMs) => {
      const s = mkState(0, Number.POSITIVE_INFINITY, 1, tickMs);
      const ticks = (TOTAL_SEC * 1000) / tickMs;
      advance(s, { ticks, remainingMs: 0, maxSegmentsThisSlice: 100000 }, [resourceBoundarySource()]);
      return amountOf(s, 'r');
    });
    const base = finals[0];
    if (base === undefined) throw new Error('no base');
    for (const f of finals) expect(f).toBeCloseTo(base, 12);
    expect(base).toBeCloseTo(20, 12);
  });
});
