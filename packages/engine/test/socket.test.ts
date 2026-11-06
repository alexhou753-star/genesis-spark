/**
 * M2 FR-16 催化剂与插槽 · 右轨闭环验收对象 —— 单测
 * ---------------------------------------------------------------------------
 * import 路径按任务要求固定为 '../src/socket.js'（并入 packages/engine 后由 vitest 解析到 src/socket.ts）。
 *
 * 覆盖（对应任务交付清单 2 的 a–h）：
 *   a 镶嵌成功：库存 2 → 镶入 → 库存 1、目标插槽有值（且入参不被修改）。
 *   b 库存不够拒绝：库存 0 → 尝试镶 → 原样返回（state / eco 未变）。
 *   c 越界拒绝：socketIndex >= sockets.length → 拒绝。
 *   d 同建筑同催化剂不重复：同 catalystId 已在此建筑某插槽 → 第二个插槽拒绝。
 *   e 卸下：镶入 → 卸下 → 库存 +1、插槽清空。
 *   f 蠕变削减：base=1.15、催化剂 reduction=0.008 → 有效蠕变=1.142（> 1.015）。
 *   g 硬下限：多个催化剂叠加削减 → 最终 = 1.015、绝不低于。
 *   h 建筑成本：base=10、creep=1.142、第 3 座 → 10 × 1.142^2 ≈ 13.04。
 *   （附）lookupCatalystQuality：命中返回品质、未命中返回 null。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是「按 socket.ts 逻辑推演应得的结果」；
 *   实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称已运行通过。
 *
 * 配置夹具：makeConfig() 是 configs/types.ts（BuildingConfig / CatalystQualityConfig）的本层切片镜像；
 *   因暂存包不能跨包 import @genesis/configs，故在测试内就地镜像出本层读取的字段（数值为占位）。
 */

import { describe, it, expect } from 'vitest';
import {
  socketCatalyst,
  unsocketCatalyst,
  effectiveCreep,
  buildingCostWithSockets,
  lookupCatalystQuality,
  CREEP_HARD_LOWER_BOUND,
  type GameConfig,
  type EconomyState,
  type EcoState,
  type SocketCarrier,
  type SocketedCatalystInfo,
} from '../src/socket.js';

// ---------------------------------------------------------------------------
// 配置夹具（镜像 configs/types.ts 的 BuildingConfig / CatalystQualityConfig 切片）
// ---------------------------------------------------------------------------

function makeConfig(): GameConfig {
  return {
    buildings: [
      // 纪元 2 建筑：0 插槽（验证「纪元 2 无插槽」）
      { id: 'field', baseCost: { wood: 10 }, creepBase: 1.15, sockets: 0 },
      // 纪元 3–4 建筑：2 插槽（验证多插槽与「同建筑去重」）
      { id: 'foundry', baseCost: { wood: 10 }, creepBase: 1.15, sockets: 2 },
      // 纪元 3–4 建筑：1 插槽（验证单插槽结算）
      { id: 'quarry', baseCost: { wood: 10 }, creepBase: 1.15, sockets: 1 },
    ],
    catalystQualities: [
      // 注意声明顺序：lookupCatalystQuality 按此顺序取首个命中
      { catalystId: 'cryo_core', quality: 'fine', creepReduction: 0.008 },
      { catalystId: 'fold_matrix', quality: 'normal', creepReduction: 0.005 },
      { catalystId: 'super_core', quality: 'superb', creepReduction: 0.02 },
    ],
  };
}

const CONFIG = makeConfig();

/** makeState：构造一个最小 EconomyState（本层只透传 buildings；插槽占用由 socketCatalyst 写入）。 */
function makeState(): EconomyState {
  return { buildings: {} };
}

/** makeEco：构造一个仅含催化剂库存的 EcoState。 */
function makeEco(catalysts: Record<string, number>): EcoState {
  return { catalysts: { ...catalysts } };
}

/** readSlot：读取某建筑某插槽的 catalystId（无插槽状态时返回 null）。 */
function readSlot(state: EconomyState, buildingId: string, index: number): string | null {
  const carrier = state as SocketCarrier;
  const slot = carrier.socketStates?.[buildingId]?.sockets[index];
  return slot === undefined ? null : slot.catalystId;
}

// ---------------------------------------------------------------------------
// a) 镶嵌成功
// ---------------------------------------------------------------------------
describe('a) socketCatalyst · 镶嵌成功', () => {
  it('库存 2 → 镶入 quarry[0] → 库存 1、插槽有值；入参不被修改', () => {
    const state = makeState();
    const eco = makeEco({ cryo_core: 2 });

    const out = socketCatalyst(state, eco, CONFIG, 'quarry', 0, 'cryo_core');

    // 库存扣减 1
    expect(out.eco.catalysts['cryo_core']).toBe(1);
    // 插槽写入
    expect(readSlot(out.state, 'quarry', 0)).toBe('cryo_core');
    // 纯函数：入参未被修改
    expect(eco.catalysts['cryo_core']).toBe(2);
    expect((state as SocketCarrier).socketStates).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// b) 库存不够拒绝
// ---------------------------------------------------------------------------
describe('b) socketCatalyst · 库存不足拒绝', () => {
  it('库存 0 → 尝试镶 → 原样返回（state / eco 引用不变）', () => {
    const state = makeState();
    const eco = makeEco({}); // 无 cryo_core

    const out = socketCatalyst(state, eco, CONFIG, 'quarry', 0, 'cryo_core');

    expect(out.state).toBe(state); // 拒绝即原引用
    expect(out.eco).toBe(eco);
    expect(out.eco.catalysts['cryo_core']).toBeUndefined();
    expect(readSlot(out.state, 'quarry', 0)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// c) 越界拒绝
// ---------------------------------------------------------------------------
describe('c) socketCatalyst · 越界拒绝', () => {
  it('socketIndex >= sockets.length（quarry 只有 1 槽，index=1）→ 拒绝', () => {
    const state = makeState();
    const eco = makeEco({ cryo_core: 2 });

    const out = socketCatalyst(state, eco, CONFIG, 'quarry', 1, 'cryo_core');

    expect(out.state).toBe(state);
    expect(out.eco).toBe(eco);
    expect(eco.catalysts['cryo_core']).toBe(2); // 未扣库存
  });

  it('负索引同样拒绝', () => {
    const state = makeState();
    const eco = makeEco({ cryo_core: 2 });
    const out = socketCatalyst(state, eco, CONFIG, 'quarry', -1, 'cryo_core');
    expect(out.state).toBe(state);
    expect(eco.catalysts['cryo_core']).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// d) 同建筑同催化剂不重复
// ---------------------------------------------------------------------------
describe('d) socketCatalyst · 同建筑同催化剂去重', () => {
  it('foundry 有 2 槽：cryo_core 镶入 slot0 后，再往 slot1 镶同催化剂 → 拒绝', () => {
    const state = makeState();
    const eco = makeEco({ cryo_core: 2 });

    const first = socketCatalyst(state, eco, CONFIG, 'foundry', 0, 'cryo_core');
    expect(readSlot(first.state, 'foundry', 0)).toBe('cryo_core');
    expect(first.eco.catalysts['cryo_core']).toBe(1);

    // 同建筑同催化剂 → 拒绝（原样返回 first 的 state / eco）
    const second = socketCatalyst(first.state, first.eco, CONFIG, 'foundry', 1, 'cryo_core');
    expect(second.state).toBe(first.state);
    expect(second.eco).toBe(first.eco);
    expect(readSlot(second.state, 'foundry', 1)).toBe(null);
    expect(second.eco.catalysts['cryo_core']).toBe(1); // 未再扣
  });
});

// ---------------------------------------------------------------------------
// e) 卸下
// ---------------------------------------------------------------------------
describe('e) unsocketCatalyst · 卸下返还库存', () => {
  it('镶入 → 卸下 → 库存 +1、插槽清空', () => {
    const state = makeState();
    const eco = makeEco({ cryo_core: 1 });

    const socketed = socketCatalyst(state, eco, CONFIG, 'quarry', 0, 'cryo_core');
    expect(socketed.eco.catalysts['cryo_core'] ?? 0).toBe(0); // 1 - 1（实现把 0 库存键 delete，?? 0 归一）
    expect(readSlot(socketed.state, 'quarry', 0)).toBe('cryo_core');

    const removed = unsocketCatalyst(socketed.state, socketed.eco, CONFIG, 'quarry', 0);
    expect(removed.eco.catalysts['cryo_core']).toBe(1); // 返还 +1
    expect(readSlot(removed.state, 'quarry', 0)).toBe(null);
  });

  it('卸下空插槽 → 原样返回（拒绝）', () => {
    const state = makeState();
    const eco = makeEco({});
    const out = unsocketCatalyst(state, eco, CONFIG, 'quarry', 0);
    expect(out.state).toBe(state);
    expect(out.eco).toBe(eco);
  });
});

// ---------------------------------------------------------------------------
// f) 蠕变削减
// ---------------------------------------------------------------------------
describe('f) effectiveCreep · 蠕变削减', () => {
  it('base=1.15、reduction=0.008 → 有效蠕变 1.142（> 1.015）', () => {
    const socketed: Array<SocketedCatalystInfo | null> = [
      { catalystId: 'cryo_core', quality: 'fine', creepReduction: 0.008 },
    ];
    const creep = effectiveCreep(CONFIG, 'quarry', socketed);
    expect(creep).toBeCloseTo(1.142, 10);
    expect(creep).toBeGreaterThan(CREEP_HARD_LOWER_BOUND);
  });

  it('无催化剂 → 返回 base（1.15）', () => {
    expect(effectiveCreep(CONFIG, 'quarry', [])).toBeCloseTo(1.15, 10);
    expect(effectiveCreep(CONFIG, 'quarry', [])).toBeCloseTo(1.15, 10);
  });
});

// ---------------------------------------------------------------------------
// g) 硬下限
// ---------------------------------------------------------------------------
describe('g) effectiveCreep · 1.015 硬下限不被突破', () => {
  it('多个催化剂叠加削减（0.1 + 0.1 → 0.95）→ 结果恒为 1.015，绝不低于', () => {
    const socketed: Array<SocketedCatalystInfo | null> = [
      { catalystId: 'heavy_a', quality: 'superb', creepReduction: 0.1 },
      { catalystId: 'heavy_b', quality: 'superb', creepReduction: 0.1 },
    ];
    const creep = effectiveCreep(CONFIG, 'quarry', socketed);
    // 1.15 - 0.2 = 0.95 < 1.015 → clamp 到 1.015
    expect(creep).toBeCloseTo(CREEP_HARD_LOWER_BOUND, 12);
    expect(creep).toBeGreaterThanOrEqual(CREEP_HARD_LOWER_BOUND);
  });

  it('超大削减（reduction=100）仍被钳到 1.015', () => {
    const socketed: Array<SocketedCatalystInfo | null> = [
      { catalystId: 'absurd', quality: 'superb', creepReduction: 100 },
    ];
    expect(effectiveCreep(CONFIG, 'quarry', socketed)).toBeCloseTo(CREEP_HARD_LOWER_BOUND, 12);
  });
});

// ---------------------------------------------------------------------------
// h) 建筑成本
// ---------------------------------------------------------------------------
describe('h) buildingCostWithSockets · 带插槽成本 = baseCost × creep^count', () => {
  it('base=10、creep=1.142、第 3 座 → 10 × 1.142^2 ≈ 13.04', () => {
    const socketed: Array<SocketedCatalystInfo | null> = [
      { catalystId: 'cryo_core', quality: 'fine', creepReduction: 0.008 }, // 1.15 - 0.008 = 1.142
    ];
    // count=2 表示「已建 2 座」，返回第 3 座成本 = 10 × 1.142^2
    const cost = buildingCostWithSockets(CONFIG, 'quarry', 2, socketed);
    expect(cost['wood']).toBeCloseTo(13.04164, 4); // 10 × 1.304164
    expect(cost['wood']).toBeCloseTo(10 * 1.142 * 1.142, 8);
  });

  it('count=0（首座）→ 等于 baseCost（creep^0 = 1）', () => {
    const cost = buildingCostWithSockets(CONFIG, 'quarry', 0, []);
    expect(cost['wood']).toBeCloseTo(10, 10);
  });

  it('硬下限保护：即便插满超强催化剂，第 2 座仍严格 > baseCost', () => {
    const socketed: Array<SocketedCatalystInfo | null> = [
      { catalystId: 'absurd', quality: 'superb', creepReduction: 100 },
    ];
    const cost = buildingCostWithSockets(CONFIG, 'quarry', 1, socketed);
    // creep 钳到 1.015 → 10 × 1.015 = 10.15 > 10
    expect(cost['wood']).toBeCloseTo(10 * 1.015, 10);
    expect(cost['wood']).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
// （附）lookupCatalystQuality
// ---------------------------------------------------------------------------
describe('附) lookupCatalystQuality · 品质查表', () => {
  it('命中 → 返回品质与削减；未命中 → null', () => {
    expect(lookupCatalystQuality(CONFIG, 'cryo_core')).toEqual({ quality: 'fine', creepReduction: 0.008 });
    expect(lookupCatalystQuality(CONFIG, 'nope')).toBe(null);
  });

  it('按配置声明顺序取首个命中', () => {
    // 追加一个同 catalystId 的第二项，验证取声明顺序第一个
    const c = makeConfig();
    c.catalystQualities = [
      { catalystId: 'dup', quality: 'normal', creepReduction: 0.001 },
      { catalystId: 'dup', quality: 'superb', creepReduction: 0.09 },
    ];
    expect(lookupCatalystQuality(c, 'dup')).toEqual({ quality: 'normal', creepReduction: 0.001 });
  });
});

// ---------------------------------------------------------------------------
// 确定性 / 纯函数（补充）
// ---------------------------------------------------------------------------
describe('确定性 · 相同输入多次调用结果一致', () => {
  it('effectiveCreep 对同一输入恒定', () => {
    const socketed: Array<SocketedCatalystInfo | null> = [
      { catalystId: 'cryo_core', quality: 'fine', creepReduction: 0.008 },
    ];
    const a = effectiveCreep(CONFIG, 'quarry', socketed);
    const b = effectiveCreep(CONFIG, 'quarry', socketed);
    expect(a).toBe(b);
  });
});
