/**
 * W2 事件跳段内核 · Gate 2/S2 验收对象（返工批次 2 · 连续时间锚定）
 * 单测条款：remainingMs 亚 tick 续算（Gate 2 / 架构 5.3）
 * ---------------------------------------------------------------------------
 * 覆盖：
 *   1) remainingMs 回传且落在 [0, tickMs)；绝不 ceil 成整 tick 重复推进。
 *   2) 多次分段 advance 拼接 == 一次 advance（组合律 advance(a)+advance(b) ≡ advance(a+b)），
 *      在无离散事件场景下严格相等。
 *   3) 累积毫秒跨段折算：跨多次调用后，被消费的完整 tick 总数 == floor(总毫秒 / tickMs)。
 *   4) 非法 remainingMs（<0 或 >= tickMs）抛确定性错误。
 *
 * 返工说明（重要，与旧版语义差异）：
 *  新设计把「物理/事件推进」与「frame 量化」彻底分离：advance 以连续毫秒推进 simTime 与资源量
 *  （stepMs 可为小数、不受 tick 限制），remainingMs 仍是「亚 tick 相位」——调用返回的 remainingMs
 *  == 结算后的 state.subMilli（模拟时间尚不足一个整 frame 的余额），语义未变，仍是「亚 tick 毫秒余量」。
 *
 *  但旧实现「只推进整 tick、把亚 tick 余量扣下不结算」，导致同一真实时长下被结算的物理时长依赖
 *  tickMs（余量被 tickMs 量化）。本批次按任务要求让「推进以毫秒为单位、不受 tick 限制」，于是亚 tick
 *  余量也参与连续结算。因此累积 8×235ms=1880ms 后，资源量由旧版「整 tick 折算的 1.75」变为
 *  「连续折算的 1.88」（= 1.88s × 1/s），且这个终值现在与 tickMs 无关（见最后一个用例）。
 *  这正是把物理从 frame 量化中解放出来的直接结果，故此处同步修正数值期望。
 *
 * 说明：advance 采用就地推进（同份 state 连续调用），因此「组合律」用同一份 state 连续调用与
 * 「一次大预算」两种方式得到最终状态，再逐位比较。
 */
import { describe, it, expect } from 'vitest';
import { advance, DeterminismError } from '../src/advance.js';
import type { SimState } from '../src/advance.js';

/** 无离散事件场景：单资源，rate 恒定，max=Infinity（永不触边），故严格线性、无事件干扰。 */
function mkNoEvent(tickMs: number): SimState {
  return {
    currentTick: 0,
    tickMs,
    subMilli: 0,
    resources: { x: { amount: 0, max: Number.POSITIVE_INFINITY } },
    rates: { x: 1 }, // 1/s
  };
}

function amount(s: SimState, id: string): number {
  const r = s.resources[id];
  if (r === undefined) throw new Error(`missing resource ${id}`);
  return r.amount;
}

describe('advance · remainingMs 亚 tick 续算（Gate 2 / 5.3）', () => {
  it('remainingMs 落在 [0, tickMs)，且余量不 ceil 成整 tick（ticks 未因余量而多推进）', () => {
    const s = mkNoEvent(250);
    // 预算 ticks=1、remainingMs=100：目标绝对时刻 = 1×250 + 100 = 350ms → 1 整 tick + 余 100ms
    const r = advance(s, { ticks: 1, remainingMs: 100, maxSegmentsThisSlice: 10 }, []);
    expect(r.ticksAdvanced).toBe(1);
    expect(r.remainingTicks).toBe(0);
    expect(r.remainingMs).toBe(100); // 余量原样保留，未被 ceil
    expect(s.subMilli).toBe(100); // 亚 tick 相位 = 100ms（< tickMs）
    expect(r.completed).toBe(true); // 预算全部推进完
  });

  it('累积毫秒跨段折算：多次 +235ms@250ms 只推进完整的 tick，余量逐次结转', () => {
    const tickMs = 250;
    const s = mkNoEvent(tickMs);
    let carry = 0;
    let totalTicks = 0;
    // 模拟真实补算：每次把「上次余量 + 本次新到时间 235ms」并入 carry，
    // 再把其中「整 tick」部分作为 ticks 传入，余量作为 remainingMs 传回。
    for (let i = 0; i < 8; i++) {
      carry = carry + 235; // 累计到 8*235 = 1880ms
      const wholeTicks = Math.floor(carry / tickMs);
      carry = carry - wholeTicks * tickMs; // 0 <= carry < tickMs
      const rr = advance(s, { ticks: wholeTicks, remainingMs: carry, maxSegmentsThisSlice: 10 }, []);
      totalTicks += rr.ticksAdvanced;
      // 回传的 remainingMs 必须等于外部账本 carry（advance 未擅自 ceil）
      expect(rr.remainingMs).toBe(carry);
      expect(s.subMilli).toBe(carry); // 内部亚 tick 相位与外部账本自洽
    }
    // 1880ms / 250ms = 7.52 → 应推进 7 个完整 tick，余 130ms
    expect(totalTicks).toBe(7);
    expect(carry).toBe(1880 - 7 * 250); // 130ms
    // 资源量：连续结算整段真实时长 1880ms = 1.88s × 1/s = 1.88（旧实现只折算整 tick 得 1.75）
    expect(amount(s, 'x')).toBeCloseTo(1.88, 12);
  });

  it('同一真实时长（8×235ms=1880ms）：三档 tickMs 终值一致（旧实现随 tickMs 漂移 1.8/1.75/1.0）', () => {
    const finals = [100, 250, 1000].map((tickMs) => {
      const s = mkNoEvent(tickMs);
      let carry = 0;
      for (let i = 0; i < 8; i++) {
        carry = carry + 235;
        const wholeTicks = Math.floor(carry / tickMs);
        carry = carry - wholeTicks * tickMs;
        advance(s, { ticks: wholeTicks, remainingMs: carry, maxSegmentsThisSlice: 10 }, []);
      }
      return amount(s, 'x');
    });
    const base = finals[0];
    if (base === undefined) throw new Error('no base');
    // 三档都应结算同样的真实时长 1.88s → 连续量终值一致（这正是连续时间锚定带来的 tickMs 无关性）
    for (const f of finals) expect(f).toBeCloseTo(base, 12);
    expect(base).toBeCloseTo(1.88, 12);
  });

  it('组合律：advance(a)+advance(b) 与 advance(a+b) 在无事件场景严格相等', () => {
    const tickMs = 1000; // 1000ms + rate=1/s：每 tick 恰好 +1（整数，二进制精确，可严格 toBe）
    // 一次算完：ticks=13 → 13 tick
    const whole = mkNoEvent(tickMs);
    const rWhole = advance(whole, { ticks: 13, remainingMs: 0, maxSegmentsThisSlice: 10 }, []);

    // 分段：先 6 tick，再 7 tick（同一份 state 连续调用）
    const split = mkNoEvent(tickMs);
    const r1 = advance(split, { ticks: 6, remainingMs: 0, maxSegmentsThisSlice: 10 }, []);
    const r2 = advance(split, { ticks: 7, remainingMs: r1.remainingMs, maxSegmentsThisSlice: 10 }, []);

    // 最终状态逐位相等
    expect(amount(split, 'x')).toBe(amount(whole, 'x'));
    expect(split.currentTick).toBe(whole.currentTick);
    // 累计推进 tick 数相等
    expect(r1.ticksAdvanced + r2.ticksAdvanced).toBe(rWhole.ticksAdvanced);
    // 无事件
    expect(rWhole.events.length).toBe(0);
    expect(r1.events.length + r2.events.length).toBe(0);
  });

  it('组合律（带亚 tick 余量）：把余量原样结转后与一次推进一致', () => {
    const tickMs = 250;
    // 总计 3.6 秒 = 3600ms = 14 tick + 100ms 余量（3600/250=14.4）
    const whole = mkNoEvent(tickMs);
    const rWhole = advance(whole, { ticks: 14, remainingMs: 100, maxSegmentsThisSlice: 10 }, []);

    const split = mkNoEvent(tickMs);
    const r1 = advance(split, { ticks: 5, remainingMs: 100, maxSegmentsThisSlice: 10 }, []);
    const r2 = advance(split, { ticks: 9, remainingMs: r1.remainingMs, maxSegmentsThisSlice: 10 }, []);

    expect(amount(split, 'x')).toBe(amount(whole, 'x'));
    expect(split.currentTick).toBe(whole.currentTick);
    expect(r2.remainingMs).toBe(rWhole.remainingMs); // 余量一致
  });

  it('非法 remainingMs（<0 或 >= tickMs）抛确定性错误（带 code）', () => {
    const s = mkNoEvent(250);
    // >= tickMs
    try {
      advance(s, { ticks: 1, remainingMs: 250, maxSegmentsThisSlice: 1 }, []);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DeterminismError);
      expect((e as DeterminismError).code).toBe('BUDGET_REMAINING_MS');
    }
    // < 0
    try {
      advance(s, { ticks: 1, remainingMs: -1, maxSegmentsThisSlice: 1 }, []);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(DeterminismError);
      expect((e as DeterminismError).code).toBe('BUDGET_REMAINING_MS');
    }
  });
});
