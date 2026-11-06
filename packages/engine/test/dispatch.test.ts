/**
 * W3 dispatch 命令层 · 架构 6.1/7.2 验收对象
 * 单测条款：命令权威（6.1）· 幂等去重与恢复重放（7.2）
 * ---------------------------------------------------------------------------
 * 覆盖任务要求的 a–f 六类断言：
 *   a) 基本应用：ADD_RESOURCE 后资源增加、lastAppliedCmdSeq 更新。
 *   b) 幂等：同一 commandId 调两次，第二次 duplicate:true，资源只加一次。
 *   c) 去重：cmdSeq <= lastAppliedCmdSeq 的命令在 recoverFromWal 中被跳过。
 *   d) 恢复重放：崩溃前已应用前 N 条、WAL 含全部 N+M 条，recoverFromWal 只补 M 条，
 *      最终状态与「一次性跑完全部」逐位一致（关键验收，架构 7.2）。
 *   e) 先决条件拒绝：SUB_RESOURCE 超量时 ok:false + reason，资源不变；另测未知命令类型。
 *   f) 权威 atTick：dispatch 后 appliedAtTick == 传入的 atTick（非引擎自生成）。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是按 dispatch / recoverFromWal
 * 逻辑推演应得的结果；实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称
 * 已运行通过。import 路径按任务要求固定为 '../src/dispatch.js'（并入 packages/engine 后
 * 由 vitest 解析到源文件）。
 */
import { describe, it, expect } from 'vitest';
import { createDispatchState, dispatch, recoverFromWal } from '../src/dispatch.js';
import type { DispatchState, GameCommand, WalEntry } from '../src/dispatch.js';

// ---------------------------------------------------------------------------
// 测试辅助（避免 noUncheckedIndexedAccess / exactOptionalPropertyTypes 误报）
// ---------------------------------------------------------------------------

/** 读资源 amount，缺失即报错（测试里资源必存在）。 */
function amountOf(state: DispatchState, id: string): number {
  const r = state.resources[id];
  if (r === undefined) throw new Error(`missing resource ${id}`);
  return r.amount;
}

/** 读计数，缺失视为 0。 */
function countOf(state: DispatchState, key: string): number {
  const c = state.counts[key];
  return c === undefined ? 0 : c;
}

/**
 * snap：把状态转成可逐位比较的纯数据快照（Set 与对象键顺序规范化）。
 *
 * 「逐位一致」的验收在此等价为：snapshot(full) 与 snapshot(recovered) 的深比较相等。
 * 之所以要规范化，是因为 Set 无稳定序列、对象键枚举顺序不可依赖（架构 5.6）。
 */
function snap(state: DispatchState): {
  currentTick: number;
  lastAppliedCmdSeq: number;
  resources: Array<{ id: string; amount: number; max: number }>;
  counts: Array<{ key: string; value: number }>;
  appliedIds: string[];
} {
  const resources = Object.keys(state.resources)
    .sort()
    .map((id) => {
      const r = state.resources[id];
      if (r === undefined) throw new Error(`missing resource ${id}`);
      return { id, amount: r.amount, max: r.max };
    });
  const counts = Object.keys(state.counts)
    .sort()
    .map((key) => ({ key, value: countOf(state, key) }));
  return {
    currentTick: state.currentTick,
    lastAppliedCmdSeq: state.lastAppliedCmdSeq,
    resources,
    counts,
    appliedIds: Array.from(state.appliedCommandIds).sort(),
  };
}

/** 从空状态一次性「跑完全部 WAL」的权威结果（作为恢复比对的基准）。 */
function runAll(entries: WalEntry[], tickMs: number): DispatchState {
  void tickMs; // runAll 只演示 dispatch 的确定结果；tickMs 与命令应用无关，显式忽略避免未用参数告警。
  const s = createDispatchState();
  for (const e of entries) {
    // 与 recoverFromWal 内部一致：atTick 只是返回值、不入状态，这里传 0 即可。
    dispatch(s, e.cmdSeq, e.commandId, e.cmd, 0);
  }
  return s;
}

// ---------------------------------------------------------------------------
// a) 基本应用
// ---------------------------------------------------------------------------
describe('dispatch · 基本应用（架构 6.1 命令权威入口）', () => {
  it('ADD_RESOURCE 后资源增加，lastAppliedCmdSeq 更新为 cmdSeq', () => {
    const s = createDispatchState();
    expect(s.lastAppliedCmdSeq).toBe(-1); // 初始约定：尚未应用任何命令

    const r = dispatch(s, 0, 'cmd-0', { type: 'ADD_RESOURCE', resId: 'wood', amount: 10 }, 100);

    expect(r.ok).toBe(true);
    expect(r.duplicate).toBeUndefined();
    expect(amountOf(s, 'wood')).toBe(10);
    expect(s.lastAppliedCmdSeq).toBe(0);
    expect(s.appliedCommandIds.has('cmd-0')).toBe(true);
  });

  it('多条命令按 cmdSeq 推进，lastAppliedCmdSeq 取最大值（只增不减）', () => {
    const s = createDispatchState();
    dispatch(s, 3, 'a', { type: 'ADD_RESOURCE', resId: 'wood', amount: 1 }, 10);
    dispatch(s, 7, 'b', { type: 'ADD_RESOURCE', resId: 'wood', amount: 2 }, 20);
    // 乱序来一个小 cmdSeq：不应把边界回退（max 语义）。
    dispatch(s, 5, 'c', { type: 'ADD_RESOURCE', resId: 'wood', amount: 4 }, 30);
    expect(s.lastAppliedCmdSeq).toBe(7);
    expect(amountOf(s, 'wood')).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// b) 幂等去重（同一 commandId 二次派发）
// ---------------------------------------------------------------------------
describe('dispatch · 幂等去重（7.2 commandId 幂等）+ C2', () => {
  it('同一 commandId 调两次：第二次 duplicate:true，资源只加一次', () => {
    const s = createDispatchState();
    const cmd: GameCommand = { type: 'ADD_RESOURCE', resId: 'ore', amount: 5 };

    const r1 = dispatch(s, 0, 'idem-1', cmd, 100);
    const r2 = dispatch(s, 0, 'idem-1', cmd, 100); // 重发

    expect(r1.ok).toBe(true);
    expect(r1.duplicate).toBeUndefined();
    expect(r2.ok).toBe(true);
    expect(r2.duplicate).toBe(true); // 命中幂等，安全忽略
    expect(amountOf(s, 'ore')).toBe(5); // 只加一次
    expect(s.appliedCommandIds.size).toBe(1);
  });

  it('重复派发不产生副作用：counts 不被二次写、lastAppliedCmdSeq 不因重复而变化', () => {
    const s = createDispatchState();
    dispatch(s, 2, 'x', { type: 'SET_COUNT', key: 'era', value: 1 }, 0);
    const before = snap(s);
    const r = dispatch(s, 2, 'x', { type: 'SET_COUNT', key: 'era', value: 1 }, 0);
    expect(r.duplicate).toBe(true);
    expect(snap(s)).toEqual(before); // 状态逐位不变
  });
});

// ---------------------------------------------------------------------------
// c) 去重：cmdSeq <= lastAppliedCmdSeq 被跳过（recoverFromWal 中）
// ---------------------------------------------------------------------------
describe('recoverFromWal · cmdSeq 提交边界跳过（7.2 / C3）', () => {
  it('新 commandId 但 cmdSeq <= lastAppliedCmdSeq：被跳过，不应用', () => {
    const s = createDispatchState();
    // 先应用一条 cmdSeq=10 的命令，把提交边界推到 10。
    dispatch(s, 10, 'base', { type: 'ADD_RESOURCE', resId: 'gold', amount: 100 }, 0);
    expect(s.lastAppliedCmdSeq).toBe(10);

    // WAL 含：一条全新 commandId 但 cmdSeq=4（<=10，应被 C3 跳过）；一条 cmdSeq=11（应应用）。
    const wal: WalEntry[] = [
      { commandId: 'stale-x', cmdSeq: 4, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 999 } },
      { commandId: 'fresh-y', cmdSeq: 11, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 1 } },
    ];
    const report = recoverFromWal(wal, s, 250);

    // stale-x 被 cmdSeq 边界跳过；fresh-y 应用。
    expect(report.skipped).toBe(1);
    expect(report.applied).toBe(1);
    expect(amountOf(s, 'gold')).toBe(101); // 100 + 1，999 未被应用
    expect(s.appliedCommandIds.has('stale-x')).toBe(false);
    expect(s.appliedCommandIds.has('fresh-y')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// d) 恢复重放：只补 M 条，最终状态 == 一次性跑完全部（逐位一致）
// ---------------------------------------------------------------------------
describe('recoverFromWal · 崩溃恢复逐位一致（7.2 关键验收 / C4）', () => {
  // 全部合法命令：N+M = 6 条。
  const all: WalEntry[] = [
    { commandId: 'c0', cmdSeq: 0, cmd: { type: 'ADD_RESOURCE', resId: 'wood', amount: 10 } },
    { commandId: 'c1', cmdSeq: 1, cmd: { type: 'ADD_RESOURCE', resId: 'wood', amount: 5 } },
    { commandId: 'c2', cmdSeq: 2, cmd: { type: 'SUB_RESOURCE', resId: 'wood', amount: 3 } },
    { commandId: 'c3', cmdSeq: 3, cmd: { type: 'SET_COUNT', key: 'level', value: 2 } },
    { commandId: 'c4', cmdSeq: 4, cmd: { type: 'ADD_RESOURCE', resId: 'stone', amount: 7 } },
    { commandId: 'c5', cmdSeq: 5, cmd: { type: 'SUB_RESOURCE', resId: 'stone', amount: 2 } },
  ];
  const N = 3; // 崩溃前已应用的前 N 条
  const M = 3; // 应急槽中尚未应用的 M 条
  const tickMs = 250;

  it('恢复后与一次性跑完全部逐位一致；只补 M 条、跳过 N 条', () => {
    // 基准：从空状态一次跑完全部。
    const full = runAll(all, tickMs);

    // 崩溃前状态：已应用前 N 条。
    const crashed = createDispatchState();
    for (let i = 0; i < N; i++) {
      const e = all[i];
      if (e === undefined) throw new Error(`missing entry ${i}`);
      dispatch(crashed, e.cmdSeq, e.commandId, e.cmd, 0);
    }
    expect(crashed.lastAppliedCmdSeq).toBe(2);

    // 恢复：应急槽 WAL 含全部 N+M 条，且**乱序**传入，考验内部排序（架构 5.6 全序）。
    const shuffled: WalEntry[] = [4, 0, 5, 2, 3, 1].map((idx) => {
      const e = all[idx];
      if (e === undefined) throw new Error(`missing entry ${idx}`);
      return e;
    });
    const report = recoverFromWal(shuffled, crashed, tickMs);

    expect(report.applied).toBe(M); // 只补 3 条
    expect(report.skipped).toBe(N); // 跳过已应用的 3 条

    // 关键验收：逐位一致（资源、计数、提交边界、已应用集合）。
    expect(snap(crashed)).toEqual(snap(full));
    expect(amountOf(crashed, 'wood')).toBe(12); // 10 +5 -3
    expect(amountOf(crashed, 'stone')).toBe(5); // +7 -2
    expect(countOf(crashed, 'level')).toBe(2);
    expect(crashed.lastAppliedCmdSeq).toBe(5);
  });

  it('对已恢复状态再次 recoverFromWal：全跳过（applied=0），状态不变', () => {
    const s = createDispatchState();
    // 先完整恢复一次。
    recoverFromWal(all, s, tickMs);
    const after = snap(s);

    // 再恢复一次同样的 WAL：应全部跳过。
    const report = recoverFromWal(all, s, tickMs);
    expect(report.applied).toBe(0);
    expect(report.skipped).toBe(all.length);
    expect(snap(s)).toEqual(after);
  });
});

// ---------------------------------------------------------------------------
// e) 先决条件拒绝（拒绝不产生副作用）
// ---------------------------------------------------------------------------
describe('dispatch · 先决条件校验（C5 拒绝无副作用）', () => {
  it('SUB_RESOURCE 超量：ok:false + INSUFFICIENT_RESOURCES，资源不变', () => {
    const s = createDispatchState();
    // 先放入 5 单位 wood。
    dispatch(s, 0, 'seed', { type: 'ADD_RESOURCE', resId: 'wood', amount: 5 }, 0);
    const before = snap(s);

    const r = dispatch(s, 1, 'over-sub', { type: 'SUB_RESOURCE', resId: 'wood', amount: 100 }, 0);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INSUFFICIENT_RESOURCES');
    expect(r.appliedAtTick).toBeUndefined();
    // 拒绝不产生任何副作用：资源、边界、已应用集合都不变。
    expect(snap(s)).toEqual(before);
    expect(amountOf(s, 'wood')).toBe(5);
    expect(s.lastAppliedCmdSeq).toBe(0); // 仍是 seed 的 0，未被失败的 1 推进
    expect(s.appliedCommandIds.has('over-sub')).toBe(false);
  });

  it('未知命令类型：ok:false + UNKNOWN_COMMAND，资源不变', () => {
    const s = createDispatchState();
    const before = snap(s);
    // 用 cast 构造一个运行期未知类型（模拟旧版本 / 不可信 WAL 输入）。
    const bogus = { type: 'NOT_A_REAL_COMMAND' } as unknown as GameCommand;

    const r = dispatch(s, 0, 'bogus', bogus, 0);

    expect(r.ok).toBe(false);
    expect(r.reason).toBe('UNKNOWN_COMMAND');
    expect(snap(s)).toEqual(before);
  });

  it('数值非法（amount 非有限）：ok:false + INVALID_AMOUNT', () => {
    const s = createDispatchState();
    const r = dispatch(s, 0, 'nan', { type: 'ADD_RESOURCE', resId: 'wood', amount: Number.NaN }, 0);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('INVALID_AMOUNT');
    expect(s.resources['wood']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// f) 权威 atTick：appliedAtTick == 传入的 atTick（非引擎自生成）
// ---------------------------------------------------------------------------
describe('dispatch · 权威 atTick（6.1 Worker 赋权威 / C1）', () => {
  it('appliedAtTick 恒等于调用方传入的 atTick', () => {
    const s = createDispatchState();
    const r1 = dispatch(s, 0, 'k1', { type: 'ADD_RESOURCE', resId: 'wood', amount: 1 }, 12345);
    expect(r1.appliedAtTick).toBe(12345);

    // 换一个明显“非时间”的整数，仍应原样记录 —— 证明引擎不生成、不读时钟。
    const r2 = dispatch(s, 1, 'k2', { type: 'ADD_RESOURCE', resId: 'wood', amount: 1 }, 42);
    expect(r2.appliedAtTick).toBe(42);
  });

  it('命令对象不含 atTick：同一命令用不同 atTick 派发得到对应 appliedAtTick', () => {
    const s = createDispatchState();
    const cmd: GameCommand = { type: 'ADD_RESOURCE', resId: 'wood', amount: 1 };
    // cmd 结构里没有 atTick 字段（类型层面即保证），atTick 只能从参数注入。
    const a = dispatch(s, 0, 'p', cmd, 7);
    expect(a.appliedAtTick).toBe(7);
    expect(Object.prototype.hasOwnProperty.call(cmd, 'atTick')).toBe(false);
  });
});
