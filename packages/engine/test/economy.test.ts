/**
 * W5c 经济结算层 · FR-03/04/05/06/08 验收对象
 * 单测覆盖：a 修饰器汇总 · b 资源结算 · c 建筑成本 · d 断链状态机 · e 纪元门槛 · f 季节 · g 种族规则替换
 * ---------------------------------------------------------------------------
 * import 路径按任务要求固定为 '../src/economy.js'（并入 packages/engine 后由 vitest 解析到 src/economy.ts）。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是「按 economy.ts 逻辑推演应得的结果」；
 *   实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称已运行通过。
 *
 * 配置夹具：TEST_CONFIG 是 config.m1.ts（M1_CONFIG）的本层字段镜像，用于 f/g 的「M1_CONFIG 实测」；
 *   因暂存包不能跨包 import @genesis/configs，故在测试内就地镜像出本层读取的切片（数值与 M1_CONFIG 一致）。
 */

import { describe, it, expect } from 'vitest';
import {
  recomputeModifiers,
  settleResources,
  buildingCost,
  totalCostForCount,
  updateChainState,
  checkEraGate,
  CREEP_HARD_LOWER_BOUND,
  type EconomyState,
  type GameConfig,
  type ChainState,
} from '../src/economy.js';

// ---------------------------------------------------------------------------
// 配置夹具（镜像 config.m1.ts / M1_CONFIG 的本层切片）
// ---------------------------------------------------------------------------

function makeConfig(): GameConfig {
  return {
    configVersion: 1,
    clock: { tickMs: 250, seasonSec: 900 },
    chain: { starveRatio: 0.5, recoverRatio: 0.85, l1ConfirmSec: 5, l2Sec: 60, l3Sec: 180, warmupSec: 30 },
    population: { growthPerSec: 0.05, upkeepPerSec: 0.1 },
    tutorialOverrides: { eraGateScale: { era_1: 0.2 } },
    seasons: [
      { id: 'spring', name: '春', modifiers: [] },
      { id: 'summer', name: '夏', modifiers: [{ target: 'res.food.rate', op: 'add_pct', value: 0.1 }] },
      { id: 'autumn', name: '秋', modifiers: [] },
      { id: 'winter', name: '冬', modifiers: [{ target: 'res.food.rate', op: 'add_pct', value: -0.5 }] },
    ],
    eras: [
      {
        id: 'era_1',
        index: 1,
        name: '篝火纪元',
        gate: [
          { kind: 'resource', resId: 'citizens', amount: 7 },
          { kind: 'resource', resId: 'food', amount: 200 },
          { kind: 'resource', resId: 'lore', amount: 50 },
          { kind: 'building', buildingId: 'study', count: 1 },
        ],
        storageMultiplier: 1,
        storageCeilingMultiplier: 4,
        ecoGridSize: 0,
      },
      { id: 'era_2', index: 2, name: '聚落纪元', gate: null, storageMultiplier: 2, storageCeilingMultiplier: 8, ecoGridSize: 2 },
    ],
    races: [
      {
        id: 'human',
        kind: 'standard',
        sustenance: { resId: 'food', jobId: 'farmer' },
        resourceMap: {},
        disabledResources: ['sunlight'],
        disabledBuildings: ['sun_garden'],
        disabledFeatures: [],
        seasonOverrides: {},
        modifiers: [],
      },
      {
        id: 'plantoid',
        kind: 'plant',
        sustenance: { resId: 'sunlight', jobId: 'photosynth' },
        resourceMap: { food: 'sunlight' },
        disabledResources: [],
        disabledBuildings: ['field'],
        disabledFeatures: ['hunting'],
        seasonOverrides: { winter: [{ target: 'res.sunlight.rate', op: 'add_pct', value: -0.5 }] },
        modifiers: [{ target: 'res.sunlight.rate', op: 'add_pct', value: 0.1 }],
      },
    ],
    resources: [
      { id: 'food', kind: 'primary', unlockEraIndex: 1, baseMax: 100 },
      { id: 'wood', kind: 'primary', unlockEraIndex: 1, baseMax: 100 },
      { id: 'sunlight', kind: 'primary', unlockEraIndex: 1, baseMax: 100 },
      { id: 'stone', kind: 'primary', unlockEraIndex: 2, baseMax: 80 },
      { id: 'lore', kind: 'knowledge', unlockEraIndex: 1, baseMax: 100 },
      { id: 'scrap', kind: 'secondary', unlockEraIndex: 2, baseMax: 60 },
      { id: 'citizens', kind: 'population', unlockEraIndex: 1, baseMax: 5 },
    ],
    jobs: [
      { id: 'farmer', unlockEraIndex: 1, producesPerSec: { food: 0.4 } },
      { id: 'photosynth', unlockEraIndex: 1, producesPerSec: { sunlight: 0.4 } },
      { id: 'woodcutter', unlockEraIndex: 1, producesPerSec: { wood: 0.3 } },
      { id: 'scholar', unlockEraIndex: 1, producesPerSec: { lore: 0.1 } },
      { id: 'miner', unlockEraIndex: 2, producesPerSec: { stone: 0.25 } },
    ],
    buildings: [
      { id: 'field', eraIndex: 1, category: 'gather', baseCost: { wood: 10 }, creepBase: 1.15, jobSlots: { farmer: 2 }, sockets: 0, isEraEntry: true },
      { id: 'sun_garden', eraIndex: 1, category: 'gather', baseCost: { wood: 10 }, creepBase: 1.15, jobSlots: { photosynth: 2 }, sockets: 0, isEraEntry: true },
      { id: 'lumber_camp', eraIndex: 1, category: 'gather', baseCost: { food: 10 }, creepBase: 1.15, jobSlots: { woodcutter: 2 }, sockets: 0 },
      { id: 'hut', eraIndex: 1, category: 'housing', baseCost: { wood: 15 }, creepBase: 1.22, housingPerUnit: 2, sockets: 0, isEraEntry: true },
      { id: 'granary', eraIndex: 1, category: 'storage', baseCost: { wood: 25 }, creepBase: 1.26, storagePerUnit: { food: 100, sunlight: 100, wood: 100 }, sockets: 0 },
      { id: 'study', eraIndex: 1, category: 'research', baseCost: { wood: 30 }, creepBase: 1.18, jobSlots: { scholar: 2 }, sockets: 0 },
      { id: 'quarry', eraIndex: 2, category: 'gather', baseCost: { wood: 60 }, creepBase: 1.16, jobSlots: { miner: 2 }, sockets: 1, isEraEntry: true },
    ],
    techs: [
      { id: 'tool_making', eraIndex: 1, cost: { lore: 20 }, requires: [], modifiers: [{ target: 'job.woodcutter.rate', op: 'add_pct', value: 0.2 }] },
      { id: 'masonry', eraIndex: 2, cost: { lore: 60 }, requires: ['tool_making'], modifiers: [{ target: 'job.miner.rate', op: 'add_pct', value: 0.2 }] },
    ],
  };
}

/** makeState：构造一个基础 EconomyState（未覆盖字段用中性默认）。 */
function makeState(overrides: Partial<EconomyState> = {}): EconomyState {
  const base: EconomyState = {
    currentTick: 0,
    tickMs: 250,
    subMilli: 0,
    resources: {
      food: { amount: 0, max: 100 },
      wood: { amount: 0, max: 100 },
      sunlight: { amount: 0, max: 100 },
      stone: { amount: 0, max: 80 },
      lore: { amount: 0, max: 100 },
      scrap: { amount: 0, max: 60 },
      citizens: { amount: 0, max: 5 },
    },
    rates: {},
    currentEra: 1,
    raceId: null,
    buildings: {},
    techs: [],
    seasonIndex: 0,
    chainStates: {},
    population: 0,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// a) 修饰器汇总：add_base→add_pct→mul→override 固定顺序 + 同 target 叠加
// ---------------------------------------------------------------------------
describe('a) recomputeModifiers · 修饰器汇总（FR-03 / 架构 5.8）', () => {
  /** 构造一个仅通过 tech 注入修饰器的配置（隔离 race/season 干扰）。 */
  function configWithTech(mods: Array<{ target: `res.${string}.rate`; op: 'add_base' | 'add_pct' | 'mul' | 'override'; value: number }>): GameConfig {
    const c = makeConfig();
    c.techs = [{ id: 'test_tech', eraIndex: 1, cost: {}, requires: [], modifiers: mods }];
    return c;
  }

  it('顺序 add_base→add_pct→mul：base1 → +3 → ×(1+0.5) → ×7 = 42', () => {
    const c = configWithTech([
      { target: 'res.lore.rate', op: 'mul', value: 7 },
      { target: 'res.lore.rate', op: 'add_base', value: 3 },
      { target: 'res.lore.rate', op: 'add_pct', value: 0.5 },
    ]);
    const st = makeState({ techs: ['test_tech'] });
    const out = recomputeModifiers(st, c);
    // 1 + 3 = 4; 4 × (1+0.5) = 6; 6 × 7 = 42
    expect(out.modifierGroups?.['res.lore.rate']).toBeCloseTo(42, 10);
  });

  it('override 最后摘取（与数组顺序无关）：最终恒为 override 值 5', () => {
    const a = configWithTech([
      { target: 'res.lore.rate', op: 'override', value: 5 },
      { target: 'res.lore.rate', op: 'add_base', value: 3 },
      { target: 'res.lore.rate', op: 'mul', value: 2 },
    ]);
    const b = configWithTech([
      { target: 'res.lore.rate', op: 'add_base', value: 3 },
      { target: 'res.lore.rate', op: 'mul', value: 2 },
      { target: 'res.lore.rate', op: 'override', value: 5 },
    ]);
    const outA = recomputeModifiers(makeState({ techs: ['test_tech'] }), a);
    const outB = recomputeModifiers(makeState({ techs: ['test_tech'] }), b);
    expect(outA.modifierGroups?.['res.lore.rate']).toBeCloseTo(5, 10);
    expect(outB.modifierGroups?.['res.lore.rate']).toBeCloseTo(5, 10);
  });

  it('同 target 多个 add_pct 连乘：1 × 1.5 × 1.2 = 1.8', () => {
    const c = configWithTech([
      { target: 'res.lore.rate', op: 'add_pct', value: 0.5 },
      { target: 'res.lore.rate', op: 'add_pct', value: 0.2 },
    ]);
    const out = recomputeModifiers(makeState({ techs: ['test_tech'] }), c);
    expect(out.modifierGroups?.['res.lore.rate']).toBeCloseTo(1.8, 10);
  });

  it('确定性：修饰器数组重排后结果逐位一致', () => {
    const mods = [
      { target: 'res.lore.rate' as const, op: 'add_base' as const, value: 3 },
      { target: 'res.lore.rate' as const, op: 'add_pct' as const, value: 0.5 },
      { target: 'res.lore.rate' as const, op: 'mul' as const, value: 7 },
    ];
    const forward = recomputeModifiers(makeState({ techs: ['test_tech'] }), configWithTech(mods));
    const reverse = recomputeModifiers(makeState({ techs: ['test_tech'] }), configWithTech([...mods].reverse()));
    expect(forward.modifierGroups?.['res.lore.rate']).toBe(reverse.modifierGroups?.['res.lore.rate']);
  });
});

// ---------------------------------------------------------------------------
// b) 资源结算：基础产出 / 满仓归零 / 消耗 / 净速率为负（FR-03/04）
// ---------------------------------------------------------------------------
describe('b) settleResources · 资源结算（FR-03/04）', () => {
  it('基础产出正确：field(2 farmers) → food 0.4×2 = 0.8/s', () => {
    const c = makeConfig();
    const st = makeState({ buildings: { field: { count: 1, active: 1 } } });
    const out = settleResources(st, 1, c);
    expect(out.rates.food).toBeCloseTo(0.8, 10);
    expect(out.resources.food?.amount).toBeCloseTo(0.8, 10);
  });

  it('满仓归零（事件点 1）：food 已满 → 产出归零、净速率 0、量不溢出', () => {
    const c = makeConfig();
    const st = makeState({
      buildings: { field: { count: 1, active: 1 } },
      resources: { ...makeState().resources, food: { amount: 100, max: 100 } },
    });
    const out = settleResources(st, 10, c);
    expect(out.rates.food).toBe(0);
    expect(out.resources.food?.amount).toBe(100);
  });

  it('未满仓不归零：food=99 且持续产出 → 钳制到上限 100（不越过）', () => {
    const c = makeConfig();
    const st = makeState({
      buildings: { field: { count: 1, active: 1 } },
      resources: { ...makeState().resources, food: { amount: 99, max: 100 } },
    });
    const out = settleResources(st, 10, c);
    expect(out.resources.food?.amount).toBe(100);
  });

  it('消耗正确：eater(2 workers) 每人 0.25 → food −0.5/s', () => {
    const c = makeConfig();
    c.jobs = [{ id: 'eater', unlockEraIndex: 1, producesPerSec: {}, consumesPerSec: { food: 0.25 } }];
    c.buildings = [{ id: 'mess', eraIndex: 1, category: 'workshop', baseCost: { wood: 5 }, creepBase: 1.15, jobSlots: { eater: 2 }, sockets: 0 }];
    const st = makeState({
      buildings: { mess: { count: 1, active: 1 } },
      resources: { ...makeState().resources, food: { amount: 10, max: 100 } },
    });
    const out = settleResources(st, 1, c);
    expect(out.rates.food).toBeCloseTo(-0.5, 10);
    expect(out.resources.food?.amount).toBeCloseTo(9.5, 10);
  });

  it('净速率可为负且钳制到 0：food=0.2 但消耗 0.5/s → 到 0 不为负', () => {
    const c = makeConfig();
    c.jobs = [{ id: 'eater', unlockEraIndex: 1, producesPerSec: {}, consumesPerSec: { food: 0.25 } }];
    c.buildings = [{ id: 'mess', eraIndex: 1, category: 'workshop', baseCost: { wood: 5 }, creepBase: 1.15, jobSlots: { eater: 2 }, sockets: 0 }];
    const st = makeState({
      buildings: { mess: { count: 1, active: 1 } },
      resources: { ...makeState().resources, food: { amount: 0.2, max: 100 } },
    });
    const out = settleResources(st, 1, c);
    expect(out.rates.food).toBeCloseTo(-0.5, 10);
    expect(out.resources.food?.amount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// c) 建筑成本：首座=baseCost；第2座=×creep；硬下限 1.015（FR-05）
// ---------------------------------------------------------------------------
describe('c) buildingCost · 成本蠕变（FR-05 / 架构 5.6 fastPowInt）', () => {
  it('首座 = baseCost（field 木 10）', () => {
    const c = makeConfig();
    expect(buildingCost(c, 'field', 0)).toEqual({ wood: 10 });
  });

  it('第 2 座 = baseCost × creep（10 × 1.15 = 11.5）', () => {
    const c = makeConfig();
    expect(buildingCost(c, 'field', 1).wood).toBeCloseTo(11.5, 10);
  });

  it('成本严格递增：第 3 座 = 10 × 1.15² = 13.225', () => {
    const c = makeConfig();
    expect(buildingCost(c, 'field', 2).wood).toBeCloseTo(13.225, 10);
    const b0 = buildingCost(c, 'field', 0).wood ?? 0;
    const b1 = buildingCost(c, 'field', 1).wood ?? 0;
    const b2 = buildingCost(c, 'field', 2).wood ?? 0;
    expect(b1).toBeGreaterThan(b0);
    expect(b2).toBeGreaterThan(b1);
  });

  it('硬下限 1.015：creepBase=0.5 的非法配置 → 仍按 ≥1.015 计（10×1.015）', () => {
    const c = makeConfig();
    c.buildings = [{ id: 'flimsy', eraIndex: 1, category: 'gather', baseCost: { wood: 10 }, creepBase: 0.5, sockets: 0 }];
    expect(buildingCost(c, 'flimsy', 1).wood).toBeCloseTo(10 * CREEP_HARD_LOWER_BOUND, 10);
  });

  it('总成本可查：2 座总成本 = 10 + 11.5 = 21.5', () => {
    const c = makeConfig();
    expect(totalCostForCount(c, 'field', 2).wood).toBeCloseTo(21.5, 10);
  });
});

// ---------------------------------------------------------------------------
// d) 断链状态机：l1确认需 l1ConfirmSec；l2/l3 递进；恢复需预热；影响下游产出（FR-06）
// ---------------------------------------------------------------------------
describe('d) updateChainState · 断链状态机（FR-06 / 架构 5.4）', () => {
  /** 构造饥饿场景：population 100 维生 food 需求 10/s，但产出仅 0.8/s（η=0.08<0.5）。 */
  function starveState(chainStates: Record<string, ChainState> = {}): EconomyState {
    return makeState({
      raceId: 'human',
      population: 100,
      buildings: { field: { count: 1, active: 1 } },
      chainStates,
    });
  }

  /** 构造恢复场景：population 1 维生需求 0.1/s，产出 0.8/s（η 钳制为 1>0.85）。 */
  function recoverState(chainStates: Record<string, ChainState>): EconomyState {
    return makeState({
      raceId: 'human',
      population: 1,
      buildings: { field: { count: 1, active: 1 } },
      chainStates,
    });
  }

  it('l1 确认需 l1ConfirmSec：dt=5 才到 level1 并 l1Confirmed=true', () => {
    const c = makeConfig();
    // 4.9s 未达，仍 level0
    const before = updateChainState(starveState(), 4.9, c);
    expect(before.chainStates.food?.level).toBe(0);
    expect(before.chainStates.food?.l1Confirmed).toBe(false);
    // 满 5s 确认一级
    const at = updateChainState(starveState(), 5, c);
    expect(at.chainStates.food?.level).toBe(1);
    expect(at.chainStates.food?.l1Confirmed).toBe(true);
  });

  it('l2/l3 递进：timer 达标依次升级 2、3', () => {
    const c = makeConfig();
    let st = starveState();
    st = updateChainState(st, 5, c); // timer 5 → level1
    expect(st.chainStates.food?.level).toBe(1);
    st = updateChainState(st, 55, c); // timer 60 → level2
    expect(st.chainStates.food?.level).toBe(2);
    st = updateChainState(st, 120, c); // timer 180 → level3
    expect(st.chainStates.food?.level).toBe(3);
  });

  it('恢复需预热：三级断链回升后须 warmupSec 才归 0（dt<warmup 不恢复）', () => {
    const c = makeConfig();
    const lvl3: ChainState = { level: 3, timerSec: 180, warmupRemainingSec: 0, l1Confirmed: true };
    const half = updateChainState(recoverState({ food: lvl3 }), 10, c); // 预热 30−10=20
    expect(half.chainStates.food?.level).toBe(3);
    expect(half.chainStates.food?.warmupRemainingSec).toBeCloseTo(20, 10);
    const done = updateChainState(half, 25, c); // 20−25→0 → level0
    expect(done.chainStates.food?.level).toBe(0);
    expect(done.chainStates.food?.warmupRemainingSec).toBe(0);
  });

  it('断链等级影响下游产出：food 链 l1 → meals 产出 ×0.7', () => {
    const c = makeConfig();
    c.resources = [
      { id: 'food', kind: 'primary', unlockEraIndex: 1, baseMax: 100 },
      { id: 'meals', kind: 'secondary', unlockEraIndex: 1, baseMax: 100 },
      { id: 'citizens', kind: 'population', unlockEraIndex: 1, baseMax: 5 },
    ];
    c.jobs = [
      { id: 'farmer', unlockEraIndex: 1, producesPerSec: { food: 0.4 } },
      { id: 'cook', unlockEraIndex: 1, producesPerSec: { meals: 0.3 }, consumesPerSec: { food: 0.1 } },
    ];
    c.buildings = [
      { id: 'field', eraIndex: 1, category: 'gather', baseCost: { wood: 10 }, creepBase: 1.15, jobSlots: { farmer: 2 }, sockets: 0 },
      { id: 'kitchen', eraIndex: 1, category: 'workshop', baseCost: { wood: 10 }, creepBase: 1.15, jobSlots: { cook: 2 }, sockets: 0 },
    ];
    const base = makeState({
      buildings: { field: { count: 1, active: 1 }, kitchen: { count: 1, active: 1 } },
      resources: { food: { amount: 0, max: 100 }, meals: { amount: 0, max: 100 }, citizens: { amount: 0, max: 5 } },
    });
    const lvl0 = settleResources({ ...base, chainStates: { food: { level: 0, timerSec: 0, warmupRemainingSec: 0, l1Confirmed: false } } }, 1, c);
    const lvl1 = settleResources({ ...base, chainStates: { food: { level: 1, timerSec: 5, warmupRemainingSec: 0, l1Confirmed: true } } }, 1, c);
    // cook 2 workers × 0.3 = 0.6；l1 下游 ×0.7 = 0.42
    expect(lvl0.rates.meals).toBeCloseTo(0.6, 10);
    expect(lvl1.rates.meals).toBeCloseTo(0.42, 10);
  });
});

// ---------------------------------------------------------------------------
// e) 纪元门槛：全部满足→canAdvance；缺任一→unmet 列出（FR-08）
// ---------------------------------------------------------------------------
describe('e) checkEraGate · 纪元门槛（FR-08）', () => {
  function gateConfig(): GameConfig {
    const c = makeConfig();
    c.tutorialOverrides = { eraGateScale: {} }; // 关闭引导缩放，验证原始门槛
    return c;
  }

  it('全部满足 → canAdvance=true、unmet 为空', () => {
    const c = gateConfig();
    const st = makeState({
      currentEra: 1,
      population: 7,
      buildings: { study: { count: 1, active: 1 } },
      resources: {
        ...makeState().resources,
        citizens: { amount: 7, max: 5 },
        food: { amount: 200, max: 300 },
        lore: { amount: 50, max: 100 },
      },
    });
    const r = checkEraGate(st, c);
    expect(r.canAdvance).toBe(true);
    expect(r.unmet).toEqual([]);
  });

  it('缺任一资源 → canAdvance=false 且 unmet 列出该项（food 不足）', () => {
    const c = gateConfig();
    const st = makeState({
      currentEra: 1,
      population: 7,
      buildings: { study: { count: 1, active: 1 } },
      resources: {
        ...makeState().resources,
        citizens: { amount: 7, max: 5 },
        food: { amount: 150, max: 300 },
        lore: { amount: 50, max: 100 },
      },
    });
    const r = checkEraGate(st, c);
    expect(r.canAdvance).toBe(false);
    expect(r.unmet.some((u) => u.startsWith('resource:food'))).toBe(true);
  });

  it('缺指定建筑 → unmet 列出 building:study', () => {
    const c = gateConfig();
    const st = makeState({
      currentEra: 1,
      population: 7,
      buildings: {},
      resources: {
        ...makeState().resources,
        citizens: { amount: 7, max: 5 },
        food: { amount: 200, max: 300 },
        lore: { amount: 50, max: 100 },
      },
    });
    const r = checkEraGate(st, c);
    expect(r.canAdvance).toBe(false);
    expect(r.unmet.some((u) => u.startsWith('building:study'))).toBe(true);
  });

  it('末纪元 gate= → canAdvance=true', () => {
    const c = gateConfig();
    const r = checkEraGate(makeState({ currentEra: 2 }), c);
    expect(r.canAdvance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// f) 季节修饰器：冬季 food 产出减半（M1_CONFIG 实测）
// ---------------------------------------------------------------------------
describe('f) 季节修饰器 · 冬季 food 减半（FR-10 / M1_CONFIG）', () => {
  it('冬季 res.food.rate add_pct −0.5 → 0.8/s × 0.5 = 0.4/s', () => {
    const c = makeConfig();
    const winterIndex = c.seasons.findIndex((s) => s.id === 'winter');
    const st = makeState({ raceId: 'human', seasonIndex: winterIndex, buildings: { field: { count: 1, active: 1 } } });
    const modded = recomputeModifiers(st, c);
    const out = settleResources(modded, 1, c);
    expect(out.rates.food).toBeCloseTo(0.4, 10);
    expect(out.resources.food?.amount).toBeCloseTo(0.4, 10);
  });

  it('对照：春季（无修饰）同配置 food = 0.8/s（证明减半来自季节）', () => {
    const c = makeConfig();
    const springIndex = c.seasons.findIndex((s) => s.id === 'spring');
    const st = makeState({ raceId: 'human', seasonIndex: springIndex, buildings: { field: { count: 1, active: 1 } } });
    const out = settleResources(recomputeModifiers(st, c), 1, c);
    expect(out.rates.food).toBeCloseTo(0.8, 10);
  });
});

// ---------------------------------------------------------------------------
// g) 种族规则替换：plantoid 的 food 替换为 sunlight（M1_CONFIG 实测）
// ---------------------------------------------------------------------------
describe('g) 种族规则替换 · plantoid food→sunlight（FR-07 / M1_CONFIG）', () => {
  it('plantoid resourceMap{food:sunlight}：food 产出改记到 sunlight；food 不产', () => {
    const c = makeConfig();
    const springIndex = c.seasons.findIndex((s) => s.id === 'spring');
    // plantoid 通过 farmer 产 food，但被 resourceMap 映射为 sunlight；另有 res.sunlight.rate +0.1。
    const st = makeState({
      raceId: 'plantoid',
      seasonIndex: springIndex,
      buildings: { field: { count: 1, active: 1 } }, // farmer 2 workers × 0.4 = 0.8（应记 sunlight）
    });
    const out = settleResources(recomputeModifiers(st, c), 1, c);
    // sunlight 毛产 0.8 ×（1+0.1）= 0.88
    expect(out.rates.sunlight).toBeCloseTo(0.88, 10);
    expect(out.resources.sunlight?.amount).toBeCloseTo(0.88, 10);
    // food 未产（产出已被替换）
    expect(out.rates.food ?? 0).toBe(0);
    expect(out.resources.food?.amount).toBe(0);
  });

  it('对照：human 同配置 food = 0.8、sunlight = 0（证明替换来自种族规则）', () => {
    const c = makeConfig();
    const springIndex = c.seasons.findIndex((s) => s.id === 'spring');
    const st = makeState({ raceId: 'human', seasonIndex: springIndex, buildings: { field: { count: 1, active: 1 } } });
    const out = settleResources(recomputeModifiers(st, c), 1, c);
    expect(out.rates.food).toBeCloseTo(0.8, 10);
    expect(out.rates.sunlight ?? 0).toBe(0);
    expect(out.resources.sunlight?.amount).toBe(0);
  });
});
