/**
 * M2 FR-20 离线结算 · Gate 3 验收对象
 * 单测覆盖：
 *   a) 基本离线：初始状态 + 3600s 离线 → 资源增长、报告非空。
 *   b) 确定性：同参数跑两次，终态哈希一致。
 *   c) 一致性核心（Gate 3）：offlineMs=24h，chunkSize=1h（24 块）分步 vs 一次 → 偏差 ≤ 1%。
 *   d) 一致性核心：chunkSize=1min vs 一次 → 同样 ≤ 1%。
 *   e) 空离线：offlineMs=0 → 状态不变（含时钟回拨负值同为不变）。
 *   f) 报告正确性：resourcesGained 与实际差值一致；chainIncidents 与事件计数一致。
 *   g) maxSegmentsPerSlice 不足时 completed=false，宿主可续（续算终态 = 一次跑终态）。
 * ---------------------------------------------------------------------------
 * import 路径按任务要求固定为 '../src/offline.js'（并入 packages/engine 后由 vitest 解析到
 * src/offline.ts）。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的是「按 offline.ts + gameLoop.ts
 * 逻辑推演应得的结果」；实际执行需在具备 vitest 的工程环境中 `npm run test`，本文不声称
 * 已运行通过。因暂存包不能跨包 import @genesis/configs，故在测试内就地镜像 config.m1.ts
 * （M1_CONFIG）本层读取的切片（数值与 M1_CONFIG 一致，与 w5d-staging/gameLoop.test.ts 同源）。
 *
 * 单位约定：verifyOfflineConsistency 的 chunkSize 以「tick 数」计（函数签名统一为 number）。
 *   故「1 小时 / 1 分钟」需换算为 tick：ONE_HOUR_TICKS = 3600×1000/tickMs；1min 同理。
 */

import { describe, it, expect } from 'vitest';
import {
  settleOffline,
  verifyOfflineConsistency,
  hashState,
  createInitialGameState,
  type GameState,
  type GameConfig,
} from '../src/offline.js';

// ---------------------------------------------------------------------------
// 配置夹具（镜像 config.m1.ts / M1_CONFIG 的本层切片；与 gameLoop.test.ts 同源）
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

/** 构造一个「有 1 座 field（2 名 farmer → 0.8 food/s）」的初始状态；raceId=（无维生消耗）。 */
function initialStateWithField(cfg: GameConfig, seed: number): GameState {
  const s = createInitialGameState(cfg, seed, null, {});
  s.buildings.field = { count: 1, active: 1 };
  return s;
}

const OFFLINE_3600S_MS = 3600 * 1000; // a) 用：3600 游戏秒 = 1h
const DAY_MS = 24 * 3600 * 1000; // c)/d) 用：24h
const TICK_MS = 250;

// ---------------------------------------------------------------------------
// a) 基本离线：初始状态 + 3600s 离线 → 资源增长、报告非空
// ---------------------------------------------------------------------------
describe('a) settleOffline · 基本离线（FR-20）', () => {
  it('3600s 离线：food/citizens 增长、报告非空、ticksRun=14400', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 1);

    const { state, events, report, completed } = settleOffline(s0, cfg, OFFLINE_3600S_MS, 1_000_000);

    // 3600s / 0.25s = 14400 tick，段数上限足够 → 完成。
    expect(completed).toBe(true);
    expect(report.ticksRun).toBe(14400);
    expect(report.gameSecondsAdvanced).toBeCloseTo(3600, 6);
    // 资源增长：food 从 0 → 上限 100；citizens 从 0 → 上限 5。
    expect(state.resources.food?.amount).toBeGreaterThan(s0.resources.food?.amount ?? 0);
    expect(state.resources.citizens?.amount).toBeGreaterThan(s0.resources.citizens?.amount ?? 0);
    expect(report.summary.resourcesGained['food']).toBeGreaterThan(0);
    // 报告非空：至少有满仓/季节切换等事件；topEvents 非空。
    expect(report.eventsCount).toBeGreaterThan(0);
    expect(events.length).toBe(report.eventsCount);
    expect(report.topEvents.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// b) 确定性：同参数跑两次，终态哈希一致
// ---------------------------------------------------------------------------
describe('b) settleOffline · 确定性（架构 5.6）', () => {
  it('同一 initialState + config + offlineMs，两次运行终态哈希一致', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 7);
    const offlineMs = 1000 * 1000; // 1000s

    const r1 = settleOffline(s0, cfg, offlineMs, 1_000_000);
    const r2 = settleOffline(s0, cfg, offlineMs, 1_000_000);

    expect(hashState(r1.state)).toBe(hashState(r2.state));
    // 报告核心字段也应一致（确定性）。
    expect(r1.report.ticksRun).toBe(r2.report.ticksRun);
    expect(r1.report.eventsCount).toBe(r2.report.eventsCount);
    expect(JSON.stringify(r1.report.summary)).toBe(JSON.stringify(r2.report.summary));
  });
});

// ---------------------------------------------------------------------------
// c) 一致性核心（Gate 3）：24h，chunk=1h（24 块）分步 vs 一次 → 偏差 ≤ 1%
// ---------------------------------------------------------------------------
describe('c) verifyOfflineConsistency · Gate 3 24h / 1h 分块（FR-20）', () => {
  it('chunkSize=1h（24 块）分步 vs 一次大步：maxDeviationPct ≤ 1%，哈希一致', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 2025);
    const ONE_HOUR_TICKS = (3600 * 1000) / TICK_MS; // 14400 tick
    // 24 块 × 14400 tick = 345600 tick = 24h。
    expect(ONE_HOUR_TICKS * 24).toBe(DAY_MS / TICK_MS);

    const result = verifyOfflineConsistency(s0, cfg, DAY_MS, ONE_HOUR_TICKS);

    expect(result.consistent).toBe(true);
    expect(result.maxDeviationPct).toBeLessThanOrEqual(1);
    // 同为确定性内核，在线/离线性应逐位一致（哈希相同）为更强证据。
    expect(result.onlineHash).toBe(result.offlineHash);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// d) 一致性核心：chunk=1min vs 一次 → 同样 ≤ 1%
// ---------------------------------------------------------------------------
describe('d) verifyOfflineConsistency · Gate 3 24h / 1min 分块（FR-20）', () => {
  it('chunkSize=1min（1440 块）分步 vs 一次大步：maxDeviationPct ≤ 1%', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 2025);
    const ONE_MIN_TICKS = (60 * 1000) / TICK_MS; // 240 tick

    const result = verifyOfflineConsistency(s0, cfg, DAY_MS, ONE_MIN_TICKS);

    expect(result.consistent).toBe(true);
    expect(result.maxDeviationPct).toBeLessThanOrEqual(1);
    expect(result.onlineHash).toBe(result.offlineHash);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// e) 空离线：offlineMs=0 → 状态不变（含时钟回拨负值同为不变）
// ---------------------------------------------------------------------------
describe('e) settleOffline · 空离线（FR-20 / 架构 5.3 时钟回拨记 0）', () => {
  it('offlineMs=0：状态不变、报告为空、completed=true', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 1);
    const before = hashState(s0);

    const { state, events, report, completed } = settleOffline(s0, cfg, 0, 1_000_000);

    expect(completed).toBe(true);
    expect(events.length).toBe(0);
    expect(hashState(state)).toBe(before);
    expect(state.currentTick).toBe(s0.currentTick);
    expect(report.ticksRun).toBe(0);
    expect(report.eventsCount).toBe(0);
  });

  it('offlineMs<0（时钟回拨）：经过时间记 0、不扣库存、状态不变', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 1);
    const before = hashState(s0);

    const { state, events, completed } = settleOffline(s0, cfg, -5000, 1_000_000);

    expect(completed).toBe(true);
    expect(events.length).toBe(0);
    expect(hashState(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// f) 报告正确性：resourcesGained 与实际差值一致；chainIncidents 与事件计数一致
// ---------------------------------------------------------------------------
describe('f) settleOffline · 报告正确性（FR-20 报告口径）', () => {
  it('resourcesGained = 终态−初态；chainIncidents/seasonChanges/eraAdvanced 与事件计数一致', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 1);
    const offlineMs = 1000 * 1000; // 1000s > seasonSec 900 → 至少 1 次季节切换

    const { state, events, report } = settleOffline(s0, cfg, offlineMs, 1_000_000);

    // resourcesGained：每个资源 = 终态 amount − 初态 amount（逐资源核对）。
    for (const id of Object.keys(state.resources)) {
      const before = s0.resources[id]?.amount ?? 0;
      const after = state.resources[id]?.amount ?? 0;
      const gained = report.summary.resourcesGained[id] ?? 0;
      expect(Math.abs(gained - (after - before))).toBeLessThan(1e-9);
    }

    // chainIncidents：必须等于事件里 chain.transition 的条数。
    const chainTransitions = events.filter((e) => e.kind === 'chain.transition').length;
    expect(report.summary.chainIncidents).toBe(chainTransitions);

    // seasonChanges：等于 season.change 条数（1000s / 900s 窗口内应 ≥ 1）。
    const seasonChanges = events.filter((e) => e.kind === 'season.change').length;
    expect(report.summary.seasonChanges).toBe(seasonChanges);
    expect(seasonChanges).toBeGreaterThanOrEqual(1);

    // eraAdvanced：等于是否出现 era.advance 事件。
    const eraAdvanced = events.some((e) => e.kind === 'era.advance');
    expect(report.summary.eraAdvanced).toBe(eraAdvanced);

    // buildingsBuilt：终态建筑总座数 − 初态建筑总座数（本例无建造 → 0）。
    let beforeCount = 0;
    let afterCount = 0;
    for (const id of Object.keys(s0.buildings)) beforeCount += s0.buildings[id]?.count ?? 0;
    for (const id of Object.keys(state.buildings)) afterCount += state.buildings[id]?.count ?? 0;
    expect(report.summary.buildingsBuilt).toBe(afterCount - beforeCount);

    // topEvents 上限 10，且按 atMilli 升序。
    expect(report.topEvents.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < report.topEvents.length; i++) {
      expect(report.topEvents[i]!.atMilli).toBeGreaterThanOrEqual(report.topEvents[i - 1]!.atMilli);
    }
  });
});

// ---------------------------------------------------------------------------
// g) maxSegmentsPerSlice 不足时 completed=false，宿主可续（续算终态 = 一次跑终态）
// ---------------------------------------------------------------------------
describe('g) settleOffline · 段数上限与续算（架构 5.3 MAX_SEGMENTS）', () => {
  it('段数上限不足 → completed=false；分片续算后终态与一次跑一致', () => {
    const cfg = makeConfig();
    const s0 = initialStateWithField(cfg, 1);
    const offlineMs = 100_000; // 100s → 400 tick

    // 第一次只给 100 段（= 100 tick），不够 400 tick → completed=false。
    const first = settleOffline(s0, cfg, offlineMs, 100);
    expect(first.completed).toBe(false);
    expect(first.report.ticksRun).toBe(100);
    expect(first.state.currentTick).toBe(100);

    // 宿主续算：剩余 offlineMs = 100s − 100×0.25s = 75s → 300 tick；给足段数 → completed=true。
    const remainingMs = offlineMs - first.report.ticksRun * TICK_MS;
    expect(remainingMs).toBe(75_000);
    const second = settleOffline(first.state, cfg, remainingMs, 1_000_000);
    expect(second.completed).toBe(true);
    expect(second.report.ticksRun).toBe(300);
    expect(second.state.currentTick).toBe(400);

    // 与「一次跑 400 tick」相比：终态哈希一致（分片不改变结果）。
    const oneShot = settleOffline(s0, cfg, offlineMs, 1_000_000);
    expect(oneShot.completed).toBe(true);
    expect(hashState(second.state)).toBe(hashState(oneShot.state));
  });
});
