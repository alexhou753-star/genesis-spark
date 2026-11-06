/**
 * M2 FR-15 生态试验田 · 右轨验收对象 —— 单测
 * ---------------------------------------------------------------------------
 * import 路径按任务要求固定为 '../src/eco.js'（并入 packages/engine 后由 vitest 解析到 src/eco.ts）。
 *
 * 覆盖（对应任务交付清单 2 的 a–h）：
 *   a 种植与基础收获：种下 seed → 推进 matureSec → 收获得订单物（不产基础资源，D3）。
 *   b 邻接变异：水+火 → 匹配配方 → 概率产出催化剂（mock rng 0.01 < 0.25 → 变异成功）。
 *   c 邻接不变异：无配方匹配 → catalystGained 为空（不产出催化剂）。
 *   d 多邻接确定性：同一状态多次收获，催化剂产出结果一致（同 rng 序列；且取字典序第一个配方）。
 *   e 空格拒绝：plantSeed 到已占格 → 抛错。
 *   f 自动补种：harvestSlot 后 autoReplant → 格子重新有种子。
 *   g 成熟检测：未成熟 readyToHarvest=false；成熟后 true。
 *   h 网格大小：era2=2x2、era3=3x3、era4=4x4（era1=0 未开放）。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是「按 eco.ts 逻辑推演应得的结果」；
 *   实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称已运行通过。
 *
 * 配置夹具：本文件的 makeConfig() 是 configs/types.ts（SeedConfig / AdjacencyRecipe / EraConfig）
 *   的本层切片镜像；因暂存包不能跨包 import @genesis/configs，故在测试内就地镜像出本层读取的字段
 *   （数值为占位）。
 */

import { describe, it, expect } from 'vitest';
import {
  plantSeed,
  harvestSlot,
  autoReplant,
  checkMaturity,
  ecoGridSize,
  type EcoState,
  type EcoConfig,
  type EcoCell,
} from '../src/eco.js';

// ---------------------------------------------------------------------------
// 配置夹具（镜像 configs/types.ts 的 SeedConfig / AdjacencyRecipe / EraConfig 切片）
// ---------------------------------------------------------------------------

function makeConfig(): EcoConfig {
  return {
    eras: [
      { id: 'era_1', index: 1, ecoGridSize: 0 },
      { id: 'era_2', index: 2, ecoGridSize: 2 },
      { id: 'era_3', index: 3, ecoGridSize: 3 },
      { id: 'era_4', index: 4, ecoGridSize: 4 },
    ],
    seeds: [
      { id: 'water_seed', element: 'water', matureSec: 10, yieldOrderId: 'water_goods', yieldAmount: 3 },
      { id: 'fire_seed', element: 'fire', matureSec: 10, yieldOrderId: 'fire_goods', yieldAmount: 2 },
      { id: 'wood_seed', element: 'wood', matureSec: 10, yieldOrderId: 'wood_goods', yieldAmount: 4 },
    ],
    adjacencies: [
      // 水+火 → 紧缩晶核（基础突变率 25%）
      { a: 'water', b: 'fire', catalystId: 'cryo_core', baseMutationRate: 0.25 },
      // 水+木 → 折叠基质（用于 d 的「多邻接取字典序第一个配方」验证：cryo_core < fold_matrix）
      { a: 'water', b: 'wood', catalystId: 'fold_matrix', baseMutationRate: 0.25 },
    ],
  };
}

const CONFIG = makeConfig();

// matureSec=10、tickMs=250（默认）→ totalTicks = round(10*1000/250) = 40。
const MATURE_TICK = 40;
const NOT_MATURE_TICK = 39;

/** emptyGrid：构造 n×n 全空格网格。 */
function emptyGrid(n: number): Array<Array<EcoCell | null>> {
  const grid: Array<Array<EcoCell | null>> = [];
  for (let r = 0; r < n; r++) {
    const row: Array<EcoCell | null> = [];
    for (let c = 0; c < n; c++) row.push(null);
    grid.push(row);
  }
  return grid;
}

/** emptyEco：构造 n×n 空 EcoState。 */
function emptyEco(n: number): EcoState {
  return { grid: emptyGrid(n), catalysts: {} };
}

// ---------------------------------------------------------------------------
// a) 种植与基础收获：订单物产出、不产基础资源（D3）
// ---------------------------------------------------------------------------

describe('a) 种植与基础收获（FR-15 / D3）', () => {
  it('种下 seed → 推进 matureSec → 收获得订单物，且不产基础资源', () => {
    const eco0 = emptyEco(2);
    const eco1 = plantSeed(eco0, CONFIG, 0, 0, 'water_seed', 0);

    // 空格已被填充，进度字段正确
    const cell = eco1.grid[0]?.[0];
    expect(cell).toBeTruthy();
    expect(cell?.seedId).toBe('water_seed');
    expect(cell?.plantedAtTick).toBe(0);
    expect(cell?.totalTicks).toBe(MATURE_TICK);

    // 成熟后收获（无相邻种子 → 不触发变异）
    const res = harvestSlot(eco1, CONFIG, 0, 0, MATURE_TICK, () => 0.99);

    // 产出只有订单物 water_goods × 3
    expect(res.yieldOrder).toEqual({ water_goods: 3 });

    // D3：收获物不含任何基础资源——yieldOrder 的键只能是订单物 ID（本层仅 yieldOrderId）
    const producedKeys = Object.keys(res.yieldOrder);
    expect(producedKeys).toEqual(['water_goods']);
    expect(producedKeys).not.toContain('food');
    expect(producedKeys).not.toContain('wood');
    expect(producedKeys).not.toContain('stone');

    // 无邻接 → 无催化剂（catalystGained 为空）
    expect(res.catalystGained).toBeFalsy();

    // 事件：kind='eco.maturity'、group='D'、payload 字段齐全
    expect(res.events).toHaveLength(1);
    const ev = res.events[0];
    expect(ev?.kind).toBe('eco.maturity');
    expect(ev?.group).toBe('D');
    expect(ev?.payload['row']).toBe(0);
    expect(ev?.payload['col']).toBe(0);
    expect(ev?.payload['seedId']).toBe('water_seed');
    expect(ev?.payload['orderYield']).toBe('water_goods');
    expect(ev?.payload['catalystGained']).toBeFalsy();

    // 收获后格子清空、进度重置
    expect(res.eco.grid[0]?.[0]).toBeFalsy();

    // 纯函数：入参 eco1 未被原地修改（格子仍在）
    expect(eco1.grid[0]?.[0]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// b) 邻接变异：水+火 → 匹配配方 → 概率产出催化剂（rng 0.01 < 0.25 → 成功）
// ---------------------------------------------------------------------------

describe('b) 邻接变异成功（FR-15 / 架构 5.2 事件点4）', () => {
  it('水在 (0,0)、火在 (0,1) → 收获水时按 25% 概率变异（0.01 < 0.25 → 成功）', () => {
    let eco = emptyEco(2);
    eco = plantSeed(eco, CONFIG, 0, 0, 'water_seed', 0);
    eco = plantSeed(eco, CONFIG, 0, 1, 'fire_seed', 0);

    const res = harvestSlot(eco, CONFIG, 0, 0, MATURE_TICK, () => 0.01);

    // 基础产出照旧（订单物）
    expect(res.yieldOrder).toEqual({ water_goods: 3 });
    // 邻接变异命中 water+fire → cryo_core
    expect(res.catalystGained).toBe('cryo_core');
    expect(res.eco.catalysts['cryo_core']).toBe(1);
    // 事件里的 catalystGained 同步
    expect(res.events[0]?.payload['catalystGained']).toBe('cryo_core');
  });

  it('概率判定使用 rng() < baseMutationRate：0.30 ≥ 0.25 → 不变异', () => {
    let eco = emptyEco(2);
    eco = plantSeed(eco, CONFIG, 0, 0, 'water_seed', 0);
    eco = plantSeed(eco, CONFIG, 0, 1, 'fire_seed', 0);

    const res = harvestSlot(eco, CONFIG, 0, 0, MATURE_TICK, () => 0.3);
    expect(res.catalystGained).toBeFalsy();
    expect(res.eco.catalysts['cryo_core']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// c) 邻接不变异：无配方匹配 → catalystGained 为空
// ---------------------------------------------------------------------------

describe('c) 邻接无配方匹配（FR-15）', () => {
  it('水+水（无 water+water 配方）→ 收获水时 catalystGained 为空', () => {
    let eco = emptyEco(2);
    eco = plantSeed(eco, CONFIG, 0, 0, 'water_seed', 0);
    eco = plantSeed(eco, CONFIG, 0, 1, 'water_seed', 0);

    const res = harvestSlot(eco, CONFIG, 0, 0, MATURE_TICK, () => 0.01);
    expect(res.yieldOrder).toEqual({ water_goods: 3 });
    expect(res.catalystGained).toBeFalsy();
    expect(res.eco.catalysts['cryo_core']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// d) 多邻接确定性：同一状态多次收获结果一致（同 rng 序列）；取字典序第一个配方
// ---------------------------------------------------------------------------

describe('d) 多邻接确定性（架构 5.2 事件点4 / 5.6）', () => {
  it('水在中心，上邻火、下邻木：两配方都命中 → 取 catalystId 字典序最小 cryo_core，且可复现', () => {
    // 3×3：中心 (1,1) 水；上 (0,1) 火；下 (2,1) 木。均为空格其余。
    let eco = emptyEco(3);
    eco = plantSeed(eco, CONFIG, 1, 1, 'water_seed', 0);
    eco = plantSeed(eco, CONFIG, 0, 1, 'fire_seed', 0);
    eco = plantSeed(eco, CONFIG, 2, 1, 'wood_seed', 0);

    // 同一状态、同一 rng 序列（每次新造 ()=>0.01）→ 结果应逐个一致
    const r1 = harvestSlot(eco, CONFIG, 1, 1, MATURE_TICK, () => 0.01);
    const r2 = harvestSlot(eco, CONFIG, 1, 1, MATURE_TICK, () => 0.01);

    // 候选：cryo_core(水+火) 与 fold_matrix(水+木)；字典序最小 = 'cryo_core'
    expect(r1.catalystGained).toBe('cryo_core');
    expect(r2.catalystGained).toBe('cryo_core');
    // 两次结果一致（确定性）
    expect(r1.catalystGained).toBe(r2.catalystGained);
    expect(r1.yieldOrder).toEqual(r2.yieldOrder);
    // 入参未被修改（两次都从同一 eco 出发仍一致）
    expect(eco.grid[1]?.[1]).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// e) 空格拒绝：plantSeed 到已占格 → 抛错
// ---------------------------------------------------------------------------

describe('e) 空格才可种（FR-15）', () => {
  it('plantSeed 到已占格 → 抛错', () => {
    let eco = emptyEco(2);
    eco = plantSeed(eco, CONFIG, 0, 0, 'water_seed', 0);
    expect(() => plantSeed(eco, CONFIG, 0, 0, 'fire_seed', 1)).toThrow();
  });

  it('缺种子配置 → 抛错；越界 → 抛错', () => {
    const eco = emptyEco(2);
    expect(() => plantSeed(eco, CONFIG, 0, 0, 'no_such_seed', 0)).toThrow();
    expect(() => plantSeed(eco, CONFIG, 5, 5, 'water_seed', 0)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// f) 自动补种：harvestSlot 后 autoReplant → 格子重新有种子（FR-48 动作）
// ---------------------------------------------------------------------------

describe('f) 自动补种（FR-48 动作实现）', () => {
  it('收获清空格子后 autoReplant 使空格重新种上 seed', () => {
    let eco = emptyEco(2);
    eco = plantSeed(eco, CONFIG, 0, 0, 'water_seed', 0);

    const harvested = harvestSlot(eco, CONFIG, 0, 0, MATURE_TICK, () => 0.99);
    expect(harvested.eco.grid[0]?.[0]).toBeFalsy();

    const replanted = autoReplant(harvested.eco, CONFIG, 'water_seed', MATURE_TICK + 1);
    const cell = replanted.grid[0]?.[0];
    expect(cell).toBeTruthy();
    expect(cell?.seedId).toBe('water_seed');
    expect(cell?.plantedAtTick).toBe(MATURE_TICK + 1);
    expect(cell?.totalTicks).toBe(MATURE_TICK);
  });
});

// ---------------------------------------------------------------------------
// g) 成熟检测：未成熟 false；成熟 true
// ---------------------------------------------------------------------------

describe('g) 成熟检测（FR-15 / 架构 5.2 事件点4）', () => {
  it('未成熟 readyToHarvest=false；成熟后 true', () => {
    let eco = emptyEco(2);
    eco = plantSeed(eco, CONFIG, 0, 0, 'water_seed', 0);

    const before = checkMaturity(eco, NOT_MATURE_TICK);
    expect(before).toHaveLength(1);
    expect(before[0]).toEqual({ row: 0, col: 0, seedId: 'water_seed', readyToHarvest: false });

    const at = checkMaturity(eco, MATURE_TICK);
    expect(at[0]?.readyToHarvest).toBe(true);
  });

  it('空格不参与成熟检测', () => {
    const eco = emptyEco(2);
    expect(checkMaturity(eco, MATURE_TICK)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// h) 网格大小：era2=2x2、era3=3x3、era4=4x4（era1=0 未开放）
// ---------------------------------------------------------------------------

describe('h) 网格推导（FR-15）', () => {
  it('ecoGridSize 从配置读纪元网格大小', () => {
    expect(ecoGridSize(CONFIG, 1)).toBe(0);
    expect(ecoGridSize(CONFIG, 2)).toBe(2);
    expect(ecoGridSize(CONFIG, 3)).toBe(3);
    expect(ecoGridSize(CONFIG, 4)).toBe(4);
    // 未配置纪元 → 0
    expect(ecoGridSize(CONFIG, 9)).toBe(0);
  });
});
