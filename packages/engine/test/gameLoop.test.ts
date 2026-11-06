/**
 * W5d 游戏循环集成 · M1 收官验收对象
 * 单测覆盖：a gameTick 单步 · b runGame 批量 · c BUILD 命令 · d ADVANCE_ERA ·
 *           e Bot 策略（→纪元 2 / ≥3 建筑 + ≥1 资源边界事件）· f 季节推进 · g 断链事件
 * ---------------------------------------------------------------------------
 * import 路径按任务要求固定为 '../src/gameLoop.js'（并入 packages/engine 后由 vitest 解析到 src/gameLoop.ts）。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是「按 gameLoop.ts + economy.ts 逻辑推演应得的结果」；
 *   实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称已运行通过。
 *
 * 配置夹具：makeConfig() 是 config.m1.ts（M1_CONFIG）的本层字段镜像，供各用例复用；因暂存包不能跨包
 *   import @genesis/configs，故在测试内就地镜像出本层读取的切片（数值与 M1_CONFIG 一致）。
 */

import { describe, it, expect } from 'vitest';
import {
  gameTick,
  runGame,
  advanceEra,
  createBot,
  createInitialGameState,
  enqueueCommand,
  type GameState,
  type GameConfig,
  type GameCommand,
} from '../src/gameLoop.js';

// ---------------------------------------------------------------------------
// 配置夹具（镜像 config.m1.ts / M1_CONFIG 的本层切片）
// ---------------------------------------------------------------------------

function makeConfig(): GameConfig {
  return {
    configVersion: 4,
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

/** 关闭引导门槛缩放的配置（用于 d 用例验证「原始门槛」）。 */
function makeGateConfig(): GameConfig {
  const c = makeConfig();
  c.tutorialOverrides = { eraGateScale: {} };
  return c;
}

// ---------------------------------------------------------------------------
// a) gameTick 单步：推进 1 tick，资源按速率增长，事件非空
// ---------------------------------------------------------------------------
describe('a) gameTick · 单步四阶段（FR-01/03/04）', () => {
  it('初始状态推进 1 tick：food 按净速率增长、并产生资源边界事件（citizens 满仓）', () => {
    const cfg = makeConfig();
    const s0 = createInitialGameState(cfg, 1, 'human', {});
    s0.buildings.field = { count: 1, active: 1 }; // 1 座 field → 2 名 farmer → food 毛产 0.8/s
    s0.population = 4.99; // 逼近 citizens 上限 5，本 tick 触发满仓事件
    s0.resources.citizens = { amount: 4.99, max: 5 };

    const { state, events } = gameTick(s0, cfg);

    // tick 前进 1。
    expect(state.currentTick).toBe(1);
    // food 净速率 = 毛产 0.8 − 人口维生 0.1×4.99 = 0.301/s；本 tick（0.25s）增长 0.07525。
    expect(state.rates.food).toBeCloseTo(0.301, 10);
    expect(state.resources.food?.amount).toBeCloseTo(0.07525, 10);
    // 事件非空：citizens 由 4.99 → 5（满仓）。
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'resource.cap' && e.payload['resId'] === 'citizens')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// b) runGame 批量：推进 100 tick，currentTick=100，资源累积正确
// ---------------------------------------------------------------------------
describe('b) runGame · 批量推进（FR-20 补算入口）', () => {
  it('推进 100 tick：currentTick=100、food 累积 = 0.8/s × 25s = 20', () => {
    const cfg = makeConfig();
    const s0 = createInitialGameState(cfg, 7, null, {}); // raceId=：无维生消耗，food 纯增长
    s0.buildings.field = { count: 1, active: 1 }; // 2 farmer → 0.8/s

    const { state, tickCount } = runGame(s0, cfg, 100, 64);

    expect(tickCount).toBe(100);
    expect(state.currentTick).toBe(100);
    // 0.8/s × (100 × 0.25s) = 20（food 上限 100，未触顶）。
    expect(state.resources.food?.amount).toBeCloseTo(20, 6);
  });
});

// ---------------------------------------------------------------------------
// c) BUILD 命令：资源够 → 建 field 成功；资源不够 → 失败且不改状态
// ---------------------------------------------------------------------------
describe('c) BUILD 命令 · 建造与资源扣减（FR-05）', () => {
  it('资源充足：wood=100 → 建 field 成功，count=1、wood −10', () => {
    const cfg = makeConfig();
    const s0 = createInitialGameState(cfg, 1, null, { wood: 100 });
    const queued = enqueueCommand(s0, { type: 'BUILD', buildingId: 'field' });

    const { state } = gameTick(queued, cfg);

    expect(state.buildings.field?.count).toBe(1);
    expect(state.buildings.field?.active).toBe(1);
    expect(state.resources.wood?.amount).toBeCloseTo(90, 10);
    expect(state.dispatch.appliedCommandIds.size).toBe(1);
  });

  it('资源不足：wood=5 → 建 field 失败（count=0、wood 不变、不记账）', () => {
    const cfg = makeConfig();
    const s0 = createInitialGameState(cfg, 1, null, { wood: 5 });
    const queued = enqueueCommand(s0, { type: 'BUILD', buildingId: 'field' });

    const { state } = gameTick(queued, cfg);

    expect(state.buildings.field?.count ?? 0).toBe(0);
    expect(state.resources.wood?.amount).toBeCloseTo(5, 10);
    expect(state.dispatch.appliedCommandIds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// d) ADVANCE_ERA：门槛满足 → 纪元 1→2；不满足 → 不可推进
// ---------------------------------------------------------------------------
describe('d) advanceEra · 纪元推进与仓储重算（FR-08）', () => {
  it('门槛满足：推进到纪元 2，food 上限按 storageMultiplier(2) 重算为 200', () => {
    const cfg = makeGateConfig();
    const s0 = createInitialGameState(cfg, 1, 'human', { lore: 50 });
    s0.population = 7;
    s0.resources.citizens = { amount: 7, max: 7 };
    s0.resources.food = { amount: 200, max: 200 };
    s0.buildings.study = { count: 1, active: 1 };

    const { state, events } = advanceEra(s0, cfg);

    expect(state.currentEra).toBe(2);
    expect(events.some((e) => e.kind === 'era.advance')).toBe(true);
    // 纪元 2 storageMultiplier=2：food 上限 = baseMax(100) × 2 = 200。
    expect(state.resources.food?.max).toBe(200);
  });

  it('门槛不满足：保持纪元 1，产出 era.advance_blocked', () => {
    const cfg = makeGateConfig();
    const s0 = createInitialGameState(cfg, 1, 'human', {});
    s0.population = 1;
    s0.resources.citizens = { amount: 1, max: 5 };

    const { state, events } = advanceEra(s0, cfg);

    expect(state.currentEra).toBe(1);
    expect(events.some((e) => e.kind === 'era.advance_blocked')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// e) Bot 策略：从初始状态跑 500 tick，能推进到纪元 2（或 ≥3 建筑 + ≥1 资源边界事件）
// ---------------------------------------------------------------------------
describe('e) createBot · 确定性贪心 Bot（FR-01 流程验证）', () => {
  /** runBot：每 tick 让 Bot 决策 → 入队 → gameTick，返回终态与全部事件。 */
  function runBot(
    cfg: GameConfig,
    seed: number,
    startingResources: Record<string, number>,
    ticks: number,
  ): { state: GameState; allEvents: ReturnType<typeof gameTick>['events'] } {
    const bot = createBot(seed, cfg);
    let s = createInitialGameState(cfg, seed, 'human', startingResources);
    const allEvents: ReturnType<typeof gameTick>['events'] = [];
    for (let i = 0; i < ticks; i++) {
      const cmds: GameCommand[] = bot.decide(s);
      for (const cmd of cmds) s = enqueueCommand(s, cmd);
      const r = gameTick(s, cfg);
      s = r.state;
      for (const e of r.events) allEvents.push(e);
    }
    return { state: s, allEvents };
  }

  it('500 tick：推进到纪元 2，或至少建 3 座建筑并产生 1 个资源边界事件', () => {
    const cfg = makeConfig();
    const { state, allEvents } = runBot(cfg, 2025, { wood: 80, food: 20 }, 500);

    const reachedEra2 = state.currentEra >= 2;
    const totalBuildings = Object.keys(state.buildings).reduce(
      (acc, id) => acc + (state.buildings[id]?.count ?? 0),
      0,
    );
    const boundaryEvents = allEvents.filter(
      (e) => e.kind === 'resource.cap' || e.kind === 'resource.empty',
    ).length;

    expect(reachedEra2 || (totalBuildings >= 3 && boundaryEvents >= 1)).toBe(true);
  });

  it('确定性：同一 seed + 同一 config，两次运行终态建筑与纪元一致', () => {
    const cfg = makeConfig();
    const a = runBot(cfg, 2025, { wood: 80, food: 20 }, 200);
    const b = runBot(cfg, 2025, { wood: 80, food: 20 }, 200);
    expect(a.state.currentEra).toBe(b.state.currentEra);
    expect(JSON.stringify(a.state.buildings)).toBe(JSON.stringify(b.state.buildings));
    expect(a.state.population).toBe(b.state.population);
  });
});

// ---------------------------------------------------------------------------
// f) 季节推进：推进 seasonSec 对应的 tick 数后 seasonIndex 变化
// ---------------------------------------------------------------------------
describe('f) 季节推进 · seasonIndex 派生（FR-01）', () => {
  it('seasonSec=1s（=4 tick @250ms）：推进 4 tick 后 seasonIndex 由 0→1', () => {
    const cfg = makeConfig();
    cfg.clock = { ...cfg.clock, seasonSec: 1 };
    let s = createInitialGameState(cfg, 1, null, {});
    expect(s.seasonIndex).toBe(0);

    const events: ReturnType<typeof gameTick>['events'] = [];
    for (let i = 0; i < 4; i++) {
      const r = gameTick(s, cfg);
      s = r.state;
      for (const e of r.events) events.push(e);
    }

    expect(s.seasonIndex).toBe(1);
    expect(events.some((e) => e.kind === 'season.change')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// g) 断链事件：food 耗尽后产生断链跃迁事件
// ---------------------------------------------------------------------------
describe('g) 断链事件 · 资源耗尽触发断链跃迁（FR-06）', () => {
  it('food 耗尽（resource.empty）+ 满足率低于阈值 → 计时到 l1 产生 chain.transition', () => {
    const cfg = makeConfig();
    const s0 = createInitialGameState(cfg, 1, 'human', {});
    s0.population = 2;
    s0.resources.citizens = { amount: 2, max: 5 };
    s0.resources.food = { amount: 0.05, max: 100 }; // 无产出，仅有维生需求 → 本 tick 即耗尽

    // 25 tick = 6.25s > l1ConfirmSec(5s)，足以让断链计时升到一级。
    const { allEvents } = runGame(s0, cfg, 25, 64);

    expect(allEvents.some((e) => e.kind === 'resource.empty' && e.payload['resId'] === 'food')).toBe(true);
    expect(
      allEvents.some(
        (e) =>
          e.kind === 'chain.transition' &&
          e.payload['chainId'] === 'food' &&
          Number(e.payload['to']) >= 1,
      ),
    ).toBe(true);
  });
});
