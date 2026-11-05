/**
 * M1 起步切片配置样例 v0.4：纪元 1–2、2 个种族（标准人类 + 植物）。
 * 所有数值都是占位，只用来证明结构可表达 PRD 并通过 Gate 1；数值由数值策划接手（PRD 13.2：M1 开工前给初版）。
 * 注意：PRD 的 M1 范围是纪元 1–4 主体，这里只是前四周要用的切片。
 *
 * 【夹具声明】下面 eras 里 era_1、era_2 的门槛（gate）与倍率数值仅为“结构测试夹具”，用于验证类型结构与 Gate 1
 * 能表达纪元门槛，不是纪元定稿数值，不得当作策划定稿引用；M1 完整范围（纪元 1–4）待数值策划补全。
 *
 * 命名约定：ID 用 snake_case 小写，不得与引擎保留字重名（资源种类、建筑类别、种族类型等），
 * 否则引擎里的合法字面量会被“引擎不得出现具体 ID”的静态扫描误伤。
 * 蠕变系数落在 PRD 附录 C.1 的类别区间内：采集 1.14–1.18、住宅 1.20–1.24、仓储 1.25–1.28。
 */
import type { GameConfig } from './types';

export const M1_CONFIG: GameConfig = {
  configVersion: 4,
  clock: { tickMs: 250, maxOfflineSec: 86400, hazardIntervalSec: 10, seasonSec: 900, seasonForewarnSec: 60, orderRefreshSec: 86400 },
  chain: { starveRatio: 0.5, recoverRatio: 0.85, l1ConfirmSec: 5, l2Sec: 60, l3Sec: 180, warmupSec: 30 },
  governor: { defaultsFromEraIndex: 2, survivalTriggerRatio: 0.15, survivalReleaseRatio: 0.5, cooldownSec: 15, drawOrder: ['miner', 'scholar'],
    adminPower: { baseCapacity: 4, perRuleCost: 1, perQueueItemCost: 0 } },
  population: { growthPerSec: 0.05, upkeepPerSec: 0.1 },
  neutralSustenance: { resId: 'food', jobId: 'farmer' },
  // v0.4：引导覆写只保留门槛缩放（移除 chain，禁止引导注入断链阈值，架构 5.7.1）。
  tutorialOverrides: { eraGateScale: { era_1: 0.2 } },
  // FR-04 溢出转化占位：木石 → 建材废料，价值折半；建材废料只给“下一次同类建筑成本”一次性折扣，不动蠕变系数。
  overflowConversions: [
    { fromResId: 'wood', toResId: 'scrap', ratio: 0.5, requiresTech: 'tool_making' },
    { fromResId: 'stone', toResId: 'scrap', ratio: 0.5, requiresTech: 'masonry', nextBuildCostDiscount: 0.02 },
  ],

  seasons: [
    { id: 'spring', name: '春', modifiers: [] },
    { id: 'summer', name: '夏', modifiers: [{ target: 'res.food.rate', op: 'add_pct', value: 0.1 }] },
    { id: 'autumn', name: '秋', modifiers: [] },
    { id: 'winter', name: '冬', modifiers: [{ target: 'res.food.rate', op: 'add_pct', value: -0.5 }] },
  ],

  eras: [
    {
      id: 'era_1', index: 1, name: '篝火纪元',
      gate: [
        { kind: 'resource', resId: 'citizens', amount: 7 },
        { kind: 'resource', resId: 'food', amount: 200 },
        { kind: 'resource', resId: 'lore', amount: 50 },
        { kind: 'building', buildingId: 'study', count: 1 },
      ],
      storageMultiplier: 1, storageCeilingMultiplier: 4, ecoGridSize: 0,
    },
    { id: 'era_2', index: 2, name: '聚落纪元', gate: null, storageMultiplier: 2, storageCeilingMultiplier: 8, ecoGridSize: 2 },
  ],

  races: [
    {
      id: 'human', kind: 'standard',
      sustenance: { resId: 'food', jobId: 'farmer' },
      resourceMap: {}, disabledResources: ['sunlight'], disabledBuildings: ['sun_garden'], disabledFeatures: [],
      seasonOverrides: {}, modifiers: [],
    },
    {
      id: 'plantoid', kind: 'plant',
      sustenance: { resId: 'sunlight', jobId: 'photosynth' },
      resourceMap: { food: 'sunlight' }, disabledResources: [], disabledBuildings: ['field'], disabledFeatures: ['hunting'],
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
    { id: 'warehouse', eraIndex: 2, category: 'storage', baseCost: { wood: 80, stone: 20 }, creepBase: 1.27, storagePerUnit: { food: 200, sunlight: 200, wood: 200, stone: 150 }, sockets: 0 },
  ],

  techs: [
    { id: 'tool_making', eraIndex: 1, cost: { lore: 20 }, requires: [], modifiers: [{ target: 'job.woodcutter.rate', op: 'add_pct', value: 0.2 }] },
    { id: 'masonry', eraIndex: 2, cost: { lore: 60 }, requires: ['tool_making'], modifiers: [{ target: 'job.miner.rate', op: 'add_pct', value: 0.2 }] },
  ],
};
