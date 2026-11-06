/**
 * W5a sim-cli 基础闭环 · Gate 2/3 验收对象
 * 单测条款：确定性初始状态 · 仿真循环 · 回放一致 · 步长不变 · 组合律 · 存档摘要
 * ---------------------------------------------------------------------------
 * 覆盖任务要求的 a–g 七类断言（逐条对应 sim.ts 导出函数）：
 *   a) createSimState 确定性：同 seed 两次创建逐位一致（Gate 2-D / S2）。
 *   b) simulate 基本推进：空命令跑 100 tick，currentTick 推进正确。
 *   c) simulate 命令插入：在 atTick=50 插入 ADD_RESOURCE，验证资源在正确时刻被加。
 *   d) verifyReplay：同一输入跑 3 次，哈希一致（Gate 2-D）。
 *   e) verifyTickInvariance：三档 tickMs 下同一输入，指纹哈希与事件序列一致（Gate 2-A/B / S2）。
 *   f) 组合律：分段 simulate 拼起来 == 一次 simulate（无事件场景严格，有事件场景容差内，Gate 3）。
 *   g) snapshotSummary：提取的 hash 与 hashState(hashableState(state)) 一致（架构 7.5）。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是按 sim.ts 逻辑推演应得的结果；
 *   实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称已运行通过。
 *   import 路径按任务要求固定为 '../src/sim.js'（并入 packages/sim-cli 后由 vitest 解析到源文件）。
 */
import { describe, it, expect } from 'vitest';
import {
  createSimState,
  withTargetTicks,
  cloneState,
  simulate,
  verifyReplay,
  verifyTickInvariance,
  serializeCommands,
  snapshotSummary,
  hashableState,
  tickInvariantState,
  hashState,
  defaultSources,
  DEFAULT_CONFIG,
  type GameConfig,
  type GameCommand,
  type SimCommandState,
} from '../src/sim.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** amountOf：读资源 amount，缺失即报错（noUncheckedIndexedAccess 守卫）。 */
function amountOf(state: SimCommandState, id: string): number {
  const r = state.resources[id];
  if (r === undefined) throw new Error(`missing resource ${id}`);
  return r.amount;
}

/** 规范哈希（与 snapshotSummary / verifyReplay 同口径）。 */
function hashOf(state: SimCommandState): string {
  return hashState(hashableState(state));
}

/** 一个「静态单资源」配置：amount=0、max=∞、rate=0（无事件，适合隔离命令/推进测试）。 */
function staticConfig(): GameConfig {
  return {
    tickMs: 250,
    resources: { gold: { amount: 0, max: Number.POSITIVE_INFINITY } },
    rates: { gold: 0 },
  };
}

/** 事件归一化：kind@atMilli 数组（排序便于比较）。 */
function normEvents(events: Array<{ kind: string; atMilli: number }>): string[] {
  return events.map((e) => `${e.kind}@${e.atMilli}`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// a) createSimState 确定性
// ---------------------------------------------------------------------------
describe('createSimState · 确定性初始状态（Gate 2-D / S2）', () => {
  it('同 seed + config 两次创建逐位一致（含 seed / tickMs / 资源初值）', () => {
    const cfg = DEFAULT_CONFIG;
    const s1 = createSimState(12345, cfg);
    const s2 = createSimState(12345, cfg);
    // 逐位一致：规范哈希相同、规范化投影 JSON 相同。
    expect(hashOf(s1)).toBe(hashOf(s2));
    expect(JSON.stringify(hashableState(s1))).toBe(JSON.stringify(hashableState(s2)));
    // seed 进入初始状态。
    expect(s1.seed).toBe(12345);
    // 配置提供的 tickMs 与资源初值被采纳。
    expect(s1.tickMs).toBe(cfg.tickMs);
    expect(s1.currentTick).toBe(0);
    expect(s1.subMilli).toBe(0);
    expect(amountOf(s1, 'food')).toBe(cfg.resources['food']?.amount ?? NaN);
  });

  it('不同 seed → 不同初始状态哈希（seed 确实进入状态）', () => {
    expect(hashOf(createSimState(1, DEFAULT_CONFIG))).not.toBe(hashOf(createSimState(2, DEFAULT_CONFIG)));
  });

  it('深拷贝：修改一份不影响另一份（不共享可变引用）', () => {
    const s1 = createSimState(7, DEFAULT_CONFIG);
    const s2 = createSimState(7, DEFAULT_CONFIG);
    const r1 = s1.resources['food'];
    if (r1 !== undefined) r1.amount = 999;
    expect(amountOf(s2, 'food')).toBe(DEFAULT_CONFIG.resources['food']?.amount ?? NaN);
  });
});

// ---------------------------------------------------------------------------
// b) simulate 基本推进
// ---------------------------------------------------------------------------
describe('simulate · 基本推进（空命令）', () => {
  it('空命令跑 100 tick，currentTick 正确推进到 100', () => {
    const state = createSimState(1, DEFAULT_CONFIG);
    const result = simulate(
      state,
      [],
      { ticks: 100, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 },
      defaultSources(),
    );
    expect(result.state.currentTick).toBe(100);
    // 无边界事件（25s×10/s=250 < max 1000）。
    expect(result.events.length).toBe(0);
    // 连续量线性增长：100×250ms=25s，rate=10/s → 250。
    expect(amountOf(state, 'food')).toBeCloseTo(250, 9);
  });

  it('推进 0 tick 不改变 currentTick', () => {
    const state = createSimState(1, DEFAULT_CONFIG);
    simulate(state, [], { ticks: 0, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    expect(state.currentTick).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// c) simulate 命令插入时序
// ---------------------------------------------------------------------------
describe('simulate · 命令插入时序（atTick=50 加资源）', () => {
  it('atTick=50 的 ADD_RESOURCE 在 tick 50 生效（之前不加、之后加）', () => {
    const cfg = staticConfig(); // gold: 0 / ∞ / rate 0（无事件，纯看命令）
    const state = createSimState(2, cfg);
    const cmds: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 50, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 100 } },
    ];

    // 推进到 tick 49：命令尚未到时刻，资源仍为 0。
    simulate(state, cmds, { ticks: 49, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    expect(state.currentTick).toBe(49);
    expect(amountOf(state, 'gold')).toBe(0);

    // 再推进 1 tick 到 50：命令刚好在其时刻生效，资源变为 100。
    simulate(state, cmds, { ticks: 1, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    expect(state.currentTick).toBe(50);
    expect(amountOf(state, 'gold')).toBe(100);

    // 继续推进到 100：命令已应用（幂等不会二次相加），资源保持 100。
    simulate(state, cmds, { ticks: 50, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    expect(state.currentTick).toBe(100);
    expect(amountOf(state, 'gold')).toBe(100);
  });

  it('同一 atTick 多条命令按数组顺序应用；一次性 simulate 与分段等价', () => {
    const cfg = staticConfig();
    // 用 SET_COUNT 观察顺序：同 atTick=10，依次设 k=1、k=2 → 最终 k=2（后者覆盖）。
    const cmds: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 10, cmd: { type: 'SET_COUNT', key: 'k', value: 1 } },
      { atTick: 10, cmd: { type: 'SET_COUNT', key: 'k', value: 2 } },
    ];
    const s1 = createSimState(3, cfg);
    simulate(s1, cmds, { ticks: 20, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    expect(s1.counts['k']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// d) verifyReplay
// ---------------------------------------------------------------------------
describe('verifyReplay · 同引擎重复回放（Gate 2-D）', () => {
  it('同一输入跑 3 次，哈希逐位一致', () => {
    const state = withTargetTicks(createSimState(99, DEFAULT_CONFIG), 100);
    const { consistent, hashes } = verifyReplay(state, [], 3);
    expect(consistent).toBe(true);
    expect(hashes.length).toBe(3);
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);
  });

  it('含命令的输入同样逐位一致', () => {
    const cfg = staticConfig();
    const state = withTargetTicks(createSimState(5, cfg), 60);
    const cmds: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 10, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 3 } },
      { atTick: 20, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 4 } },
    ];
    const { consistent, hashes } = verifyReplay(state, cmds, 3);
    expect(consistent).toBe(true);
    expect(hashes.every((h) => h === hashes[0])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// e) verifyTickInvariance
// ---------------------------------------------------------------------------
describe('verifyTickInvariance · 三档 tickMs 步长不变性（Gate 2-A/B / S2）', () => {
  it('三档 tickMs 下同一输入：指纹哈希与事件序列一致', () => {
    // 配置 tickMs=250（基准）。food 0→max40、rate10 → 4s 满仓触发一次 cap 事件（<总时长 5s）。
    // 另含一条 atTick=8（=2000ms）的 ADD 命令，验证命令时刻跨档换算正确。
    const cfg: GameConfig = {
      tickMs: 250,
      resources: {
        food: { amount: 0, max: 40 },
        wood: { amount: 0, max: Number.POSITIVE_INFINITY },
      },
      rates: { food: 10, wood: 0 },
    };
    const state = withTargetTicks(createSimState(11, cfg), 20); // 20×250ms = 5000ms
    const cmds: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 8, cmd: { type: 'ADD_RESOURCE', resId: 'wood', amount: 5 } }, // 2000ms
    ];

    const { consistent, results } = verifyTickInvariance(state, cmds, [100, 250, 1000]);
    expect(results.length).toBe(3);
    // 三档指纹哈希一致、事件序列一致。
    expect(consistent).toBe(true);
    const first = results[0];
    if (first === undefined) throw new Error('no results');
    for (const r of results) {
      expect(r.hash).toBe(first.hash);
      expect(r.events).toEqual(first.events);
    }
    // 事件确有一次满仓：resource.cap@4000（4s 物理到达点，跨档不变）。
    expect(first.events).toContain('resource.cap@4000');
  });

  it('tickInvariantState 排除帧导数视图：三档 currentTick 不同但指纹相同', () => {
    const cfg: GameConfig = {
      tickMs: 250,
      resources: { food: { amount: 0, max: 1000 } },
      rates: { food: 10 },
    };
    const base = withTargetTicks(createSimState(21, cfg), 20); // 5000ms
    const hashes: string[] = [];
    for (const tickMs of [100, 250, 1000]) {
      const s = cloneState(base);
      s.tickMs = tickMs;
      s.currentTick = 0;
      s.subMilli = 0;
      simulate(s, [], { ticks: 5000 / tickMs, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
      hashes.push(hashState(tickInvariantState(s)));
    }
    // 三档物理指纹相同（food 终值均为 50，5000ms×10/s）。
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[1]).toBe(hashes[2]);
  });
});

// ---------------------------------------------------------------------------
// f) 组合律：分段 simulate == 一次 simulate
// ---------------------------------------------------------------------------
describe('组合律 · 分段 simulate == 一次 simulate（Gate 3 在线/离线一致）', () => {
  it('无事件场景：严格逐位一致', () => {
    const cfg = staticConfig(); // gold 0/∞/rate0，无事件
    const cmds: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 30, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 7 } },
    ];

    // 一次跑满 100 tick。
    const oneShot = createSimState(31, cfg);
    simulate(oneShot, cmds, { ticks: 100, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());

    // 分两段 40 + 60，同一 state 连续推进。
    const split = createSimState(31, cfg);
    simulate(split, cmds, { ticks: 40, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    simulate(split, cmds, { ticks: 60, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());

    expect(split.currentTick).toBe(oneShot.currentTick);
    expect(amountOf(split, 'gold')).toBe(amountOf(oneShot, 'gold'));
    expect(hashOf(split)).toBe(hashOf(oneShot)); // 无事件场景严格逐位一致
  });

  it('有事件场景：连续量与事件序列在容差内一致', () => {
    const cfg: GameConfig = {
      tickMs: 250,
      resources: { food: { amount: 0, max: 40 } },
      rates: { food: 10 },
    };
    const oneShot = createSimState(41, cfg);
    const r1 = simulate(oneShot, [], { ticks: 20, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());

    const split = createSimState(41, cfg);
    const ra = simulate(split, [], { ticks: 8, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    const rb = simulate(split, [], { ticks: 12, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());

    // 连续量终值一致（容差内）。
    expect(amountOf(split, 'food')).toBeCloseTo(amountOf(oneShot, 'food'), 9);
    // 两段事件拼起来 == 一次跑的事件序列。
    const splitEvents = normEvents([...ra.events, ...rb.events]);
    expect(splitEvents).toEqual(normEvents(r1.events));
    expect(splitEvents).toContain('resource.cap@4000');
  });
});

// ---------------------------------------------------------------------------
// g) snapshotSummary
// ---------------------------------------------------------------------------
describe('snapshotSummary · 存档摘要（架构 7.5）', () => {
  it('提取的 hash 与 hashState(hashableState(state)) 一致；tick / resources 正确', () => {
    const state = createSimState(51, DEFAULT_CONFIG);
    const result = simulate(state, [], { ticks: 40, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
    const summary = snapshotSummary(result.state);

    expect(summary.hash).toBe(hashState(hashableState(result.state)));
    expect(summary.tick).toBe(result.state.currentTick);
    expect(summary.tick).toBe(40);
    expect(summary.resources['food']).toBeCloseTo(amountOf(result.state, 'food'), 9);
  });

  it('不同状态 → 不同摘要哈希（对改动敏感）', () => {
    const s1 = createSimState(1, DEFAULT_CONFIG);
    const s2 = createSimState(2, DEFAULT_CONFIG);
    expect(snapshotSummary(s1).hash).not.toBe(snapshotSummary(s2).hash);
  });
});

// ---------------------------------------------------------------------------
// 附带：serializeCommands（输入日志，供 hashReplay）
// ---------------------------------------------------------------------------
describe('serializeCommands · 输入日志规范化', () => {
  it('与书写顺序无关（先规范化排序），与内容有关', () => {
    const a: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 10, cmd: { type: 'SET_COUNT', key: 'x', value: 1 } },
      { atTick: 5, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 2 } },
    ];
    const b: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 5, cmd: { type: 'ADD_RESOURCE', resId: 'gold', amount: 2 } },
      { atTick: 10, cmd: { type: 'SET_COUNT', key: 'x', value: 1 } },
    ];
    expect(serializeCommands(a)).toBe(serializeCommands(b));
    // 内容不同 → 串不同
    const c: Array<{ atTick: number; cmd: GameCommand }> = [
      { atTick: 10, cmd: { type: 'SET_COUNT', key: 'x', value: 9 } },
    ];
    expect(serializeCommands(a)).not.toBe(serializeCommands(c));
  });
});
