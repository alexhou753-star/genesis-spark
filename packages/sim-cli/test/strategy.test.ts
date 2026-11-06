/**
 * W5b 长期策略回归 · C1-C6 验收对象
 * 单测条款：C1 重置新增维度 · C2 无全局占优 · C3 浅层收益递减 · C4 自动化不替代战略
 *           C5 新周目改变约束 · C6 无风险循环
 * ---------------------------------------------------------------------------
 * 逐条对应任务要求的 a–f（每个 `it` 都同时覆盖「通过 valid=true」与「退化 valid=false」两支，
 * 以证明断言**可证伪**——退化形态确实会被判不通过，而非恒真）：
 *   a) C1：下一层 modifiers 键集合新增 → valid=true；无新增（仅数值放大）→ valid=false。
 *   b) C2：两选项各有优势区间（局面依赖）→ valid=true；一选项全面占优 → valid=false。
 *   c) C3：浅层增量递减且总量 < 深层 → valid=true；浅层增量递增 → valid=false。
 *   d) C4：自动化得分显著低于手动 → valid=true；自动化 ≥ 手动 → valid=false。
 *   e) C5：同一模板在多数配置下不达标（成功率低）→ valid=true；同一模板在 ≥K 配置下仍最优 → valid=false。
 *   f) C6：存在「风险恒 0 且净增长 ≥0」的循环 → valid=false；无 → valid=true。
 *
 * 测试夹具说明：StrategyState 的离散字段（race/universe/...）在这些用例里主要是「维度标签」，
 *   判定真正依赖的是 modifiers（维度集合 / 收益 / 代价 / 风险键）与 resources（局面权重 / 净增长）。
 *   所有数值均为有限数，确保可参与确定性判定（strategy.ts 内 assertFiniteTree 会拦截 NaN/∞）。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是按 strategy.ts 逻辑推演应得的结果；
 *   实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称已运行通过。
 *   import 路径按任务要求固定为 '../src/strategy.js'（并入 packages/sim-cli 后由 vitest 解析到 src/strategy.ts）。
 */
import { describe, it, expect } from 'vitest';
import {
  verifyC1_ResetDimension,
  verifyC2_NoDominance,
  verifyC3_DiminishingReturns,
  verifyC4_AutomationNotReplace,
  verifyC5_NewRunChangesConstraints,
  verifyC6_NoRiskFreeLoop,
  type StrategyState,
  type StrategyOption,
} from '../src/strategy.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** makeState：构造一个策略骨架状态；未覆盖字段用中性默认值（每次返回全新对象，避免共享引用）。 */
function makeState(overrides: Partial<StrategyState> = {}): StrategyState {
  return {
    era: 1,
    race: 'human',
    universe: 'standard',
    government: 'democracy',
    resetLayer: 'ash',
    resetCount: 0,
    resources: {},
    modifiers: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// a) C1 每次重置新增决策维度
// ---------------------------------------------------------------------------
describe('C1 · verifyC1_ResetDimension（重置新增决策维度）', () => {
  it('进入下一层后 modifiers 键集合新增维度 → valid=true，且 newDimensions 精确为新增键', () => {
    const st = makeState({ modifiers: { productivity: 1, morale: 2 } }); // D_L = {productivity, morale}
    const r = verifyC1_ResetDimension(st, { productivity: 3, morale: 4, logistics: 5 }); // D_{L+1} 多出 logistics
    expect(r.newDimensions).toEqual(['logistics']);
    expect(r.valid).toBe(true);
  });

  it('无新增维度（仅把旧维度数值放大）→ valid=false，newDimensions 为空', () => {
    const st = makeState({ modifiers: { productivity: 1, morale: 2 } });
    const r = verifyC1_ResetDimension(st, { productivity: 50, morale: 90 }); // 键集合完全相同
    expect(r.newDimensions).toEqual([]);
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// b) C2 无全局严格占优
// ---------------------------------------------------------------------------
describe('C2 · verifyC2_NoDominance（无全局严格占优）', () => {
  it('两选项各有优势区间（军事局面 A 胜、经济局面 B 胜）→ valid=true', () => {
    const options: StrategyOption[] = [
      { id: 'gov_military', axis: 'government', modifiers: { military: 2 } },
      { id: 'gov_economy', axis: 'government', modifiers: { economy: 2 } },
    ];
    const scenarios: StrategyState[] = [
      makeState({ resources: { military: 10, economy: 1 } }), // 军事丰富 → gov_military 收益高
      makeState({ resources: { military: 1, economy: 10 } }), // 经济丰富 → gov_economy 收益高
    ];
    const r = verifyC2_NoDominance(options, scenarios);
    expect(r.dominant).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it('一选项对所有局面都占优（收益更高、代价不高）→ valid=false，且该选项被记为 dominant', () => {
    const options: StrategyOption[] = [
      { id: 'gov_strong', axis: 'government', modifiers: { military: 2, economy: 2 } },
      { id: 'gov_weak', axis: 'government', modifiers: { military: 1, economy: 1 } },
    ];
    const scenarios: StrategyState[] = [
      makeState({ resources: { military: 10, economy: 10 } }),
      makeState({ resources: { military: 3, economy: 4 } }),
    ];
    const r = verifyC2_NoDominance(options, scenarios);
    expect(r.dominant).toContain('gov_strong');
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// c) C3 浅层重复收益递减
// ---------------------------------------------------------------------------
describe('C3 · verifyC3_DiminishingReturns（浅层收益递减）', () => {
  it('浅层增量严格递减且总量 < 深层 → valid=true', () => {
    const base = makeState({ resources: { gold: 0 } });
    // 浅层 5 次：增量 5,4,3,2,1（严格递减，合计 15）。
    const increments = [5, 4, 3, 2, 1];
    let step = 0;
    let cumulative = 0;
    const shallowAction = (): StrategyState => {
      cumulative += increments[step] ?? 0;
      step += 1;
      return makeState({ resources: { gold: cumulative } });
    };
    // 深层一次：+100（远超浅层总量 15）。
    const deepAction = (): StrategyState => makeState({ resources: { gold: 100 } });

    const r = verifyC3_DiminishingReturns(base, shallowAction, deepAction, increments.length);
    expect(r.shallowTotal).toBe(15);
    expect(r.deepTotal).toBe(100);
    expect(r.valid).toBe(true);
  });

  it('浅层增量递增（未递减）→ valid=false', () => {
    const base = makeState({ resources: { gold: 0 } });
    const increments = [1, 2, 3, 4, 5]; // 递增 → 违反边际递减
    let step = 0;
    let cumulative = 0;
    const shallowAction = (): StrategyState => {
      cumulative += increments[step] ?? 0;
      step += 1;
      return makeState({ resources: { gold: cumulative } });
    };
    const deepAction = (): StrategyState => makeState({ resources: { gold: 100 } });

    const r = verifyC3_DiminishingReturns(base, shallowAction, deepAction, increments.length);
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// d) C4 自动化不代替战略选择
// ---------------------------------------------------------------------------
describe('C4 · verifyC4_AutomationNotReplace（自动化不替代战略）', () => {
  it('自动化得分显著低于手动 → valid=true', () => {
    const auto = makeState({ resources: { gold: 100 } }); // 设好就不管
    const manual = makeState({ resources: { gold: 1000 } }); // 持续手动最优
    const r = verifyC4_AutomationNotReplace(auto, manual);
    expect(r.autoScore).toBe(100);
    expect(r.manualScore).toBe(1000);
    expect(r.valid).toBe(true);
  });

  it('自动化得分 ≥ 手动 → valid=false（自动化可替代战略，判不通过）', () => {
    const auto = makeState({ resources: { gold: 1000 } });
    const manual = makeState({ resources: { gold: 100 } });
    const r = verifyC4_AutomationNotReplace(auto, manual);
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// e) C5 新周目改变约束条件
// ---------------------------------------------------------------------------
describe('C5 · verifyC5_NewRunChangesConstraints（新周目改变约束）', () => {
  const template: StrategyOption[] = [
    { id: 'tpl_economy', axis: 'government', modifiers: { economy: 1 } },
  ];

  it('同一模板在多个配置下都不达标（成功率低）→ valid=true', () => {
    // 模板收益 = 1 × economy 存量；三个周目经济都稀缺（2/3/1），基线 10 → 全部 < baseline。
    const configs: StrategyState[] = [
      makeState({ resources: { economy: 2 } }),
      makeState({ resources: { economy: 3 } }),
      makeState({ resources: { economy: 1 } }),
    ];
    const r = verifyC5_NewRunChangesConstraints(template, configs, 2, 10);
    expect(r.sameTemplateSuccess).toBeLessThan(2);
    expect(r.valid).toBe(true);
  });

  it('同一模板在 ≥K 个配置下仍最优 → valid=false', () => {
    // 基线 0、三个配置经济都 ≥0 → 模板在 3 个配置下都「仍最优」，3 ≥ K=2 → 判不通过。
    const configs: StrategyState[] = [
      makeState({ resources: { economy: 5 } }),
      makeState({ resources: { economy: 6 } }),
      makeState({ resources: { economy: 7 } }),
    ];
    const r = verifyC5_NewRunChangesConstraints(template, configs, 2, 0);
    expect(r.sameTemplateSuccess).toBeGreaterThanOrEqual(2);
    expect(r.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// f) C6 无风险循环
// ---------------------------------------------------------------------------
describe('C6 · verifyC6_NoRiskFreeLoop（无风险循环检查）', () => {
  it('存在「风险恒 0 且资源净增长 ≥0」的循环 → valid=false', () => {
    const base = makeState({ resources: { gold: 0 }, modifiers: {} });
    // 两步循环：资源从 0 涨到 10、20；全程无任何风险键（riskScore=0），净增长 20 ≥ 0。
    const actions: Array<() => StrategyState> = [
      (): StrategyState => makeState({ resources: { gold: 10 }, modifiers: {} }),
      (): StrategyState => makeState({ resources: { gold: 20 }, modifiers: {} }),
    ];
    const r = verifyC6_NoRiskFreeLoop(base, actions);
    expect(r.riskFreeLoops).toBe(1);
    expect(r.valid).toBe(false);
  });

  it('循环每一步都伴随风险暴露（risk>0）→ 不构成无风险循环 → valid=true', () => {
    const base = makeState({ resources: { gold: 0 }, modifiers: {} });
    // 资源虽净增，但每一步都带 risk>0，说明「有真实风险」，不是无风险套利。
    const actions: Array<() => StrategyState> = [
      (): StrategyState => makeState({ resources: { gold: 10 }, modifiers: { risk: 1 } }),
      (): StrategyState => makeState({ resources: { gold: 20 }, modifiers: { pollution: 2 } }),
    ];
    const r = verifyC6_NoRiskFreeLoop(base, actions);
    expect(r.riskFreeLoops).toBe(0);
    expect(r.valid).toBe(true);
  });

  it('零风险但资源净减少（净增长 <0）→ 不是净正循环 → valid=true', () => {
    const base = makeState({ resources: { gold: 100 }, modifiers: {} });
    const actions: Array<() => StrategyState> = [
      (): StrategyState => makeState({ resources: { gold: 60 }, modifiers: {} }),
      (): StrategyState => makeState({ resources: { gold: 30 }, modifiers: {} }),
    ];
    const r = verifyC6_NoRiskFreeLoop(base, actions);
    expect(r.riskFreeLoops).toBe(0);
    expect(r.valid).toBe(true);
  });
});
