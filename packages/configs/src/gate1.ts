/**
 * Gate 1：配置完整性与可达性（架构 9 章，对应 PRD NFR-14、FR-01、FR-07、FR-08、FR-09、FR-34）。
 * 位置：packages/configs（构建期校验，sim-cli 提供命令行入口）。失败即阻断合并。
 *
 * 本脚本覆盖架构 Gate 1 的哪些条目、哪些不覆盖，见 COVERAGE。
 * 错误前缀 [G1-xx] 是稳定的规则编号，变异测试靠它断言“是对的规则拦住的”。
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  BuildingCategory, BuildingConfig, EraConfig, GameConfig, JobConfig, ModifierConfig, ModifierOp,
  RaceConfig, RaceKind, ResourceKind, Sustenance,
} from './types.js';
import { M1_CONFIG } from './config.m1.js';

/** V1.0 蠕变系数硬下限（FR-05）。 */
export const CREEP_FLOOR = 1.015;
/** PRD 附录 C.1 的蠕变基准区间，只作 warning（PRD A-04：均为建议初值，M1 原型校准）。 */
export const CREEP_BASELINE: Partial<Record<BuildingCategory, readonly [number, number]>> = {
  housing: [1.2, 1.24], gather: [1.14, 1.18], storage: [1.25, 1.28], orbital: [1.05, 1.1],
};
/** “可达上限”的简化估算：假定玩家最多额外建这么多座仓储或住房。M2 应改为与成本蠕变联动的可负担性计算。 */
export const MAX_STORAGE_UNITS = 10;
/** PRD FR-06：预热 20–60 秒（建议值，只作 warning）。 */
export const WARMUP_RANGE = [20, 60] as const;
/** PRD FR-20：离线与后台补算上限 24 小时。 */
export const EXPECTED_MAX_OFFLINE_SEC = 86400;

export interface Gate1Report {
  errors: string[];
  warnings: string[];
}

export const COVERAGE: ReadonlyArray<readonly [string, string, string]> = [
  ['引用无悬空', 'G1-02', '已实现'],
  ['科技图无环', 'G1-03', '已实现（含自依赖与逆纪元依赖）'],
  ['引擎源码中具体种族/资源/工种 ID 出现 0 处', 'G1-14', '已实现：scanEngineSource，须指向 packages/engine/src；引擎目录尚不存在时 CI 先跳过'],
  ['每种资源有产出源、每个工种有提供岗位上限的建筑', 'G1-10', '已实现：全局视图 + 每个种族视图各校验一遍'],
  ['每个纪元首批建筑与门槛成本不超过当时可达上限', 'G1-12', '已实现：简化估算，见 MAX_STORAGE_UNITS；每个种族按 resourceMap 映射后各算一遍'],
  ['配置速率单位必须为每秒', 'G1-05 / G1-06', '已实现：键名不得含 tick；周期必须是整数秒（保证 100/250/1000 ms 都能精确换算）'],
  ['外观主题配置不含数值字段', '—', '未覆盖：M1 没有主题配置，随 FR-34（M4）补'],
  ['四阶段之间无反向依赖', '—', '未覆盖：不属于配置校验，用 ESLint 边界规则或 dependency-cruiser，W1 接入'],
];

// ---------------------------------------------------------------------------
// 保留字：引擎里合法出现的字面量，配置 ID 不得与之重名，否则静态扫描会误伤
// ---------------------------------------------------------------------------
// v0.4.1（批次三修复）：ResourceKind 已追加 'order'（批次二类型层已落地），此处穷举映射必须同步补 order: true，
// 否则 Record<ResourceKind, true> 因缺键导致类型不完整（tsc 报错），且 REFERENCE 保留字集合会漏掉 'order'。
const RESOURCE_KINDS: Record<ResourceKind, true> = { primary: true, secondary: true, knowledge: true, population: true, order: true };
const BUILDING_CATEGORIES: Record<BuildingCategory, true> = {
  gather: true, storage: true, housing: true, workshop: true, research: true, power: true, orbital: true,
};
const RACE_KINDS: Record<RaceKind, true> = { standard: true, plant: true, silicon: true, large: true, fungal: true, carnivore: true };
const MODIFIER_OPS: Record<ModifierOp, true> = { add_base: true, add_pct: true, mul: true, override: true };

export const RESERVED_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(RESOURCE_KINDS), ...Object.keys(BUILDING_CATEGORIES), ...Object.keys(RACE_KINDS), ...Object.keys(MODIFIER_OPS),
  'sustenance', 'hazard', 'eco', 'tutorial', 'rate', 'max', 'creep', 'cost', 'upkeep', 'storage', 'conv', 'growth', 'all', 'pop', 'cat', 'res', 'job', 'bldg', 'constructor', 'prototype',
]);

const ID_RE = /^[a-z][a-z0-9_]*$/;
const TARGET_RE = /^(res|job|bldg)\.([a-z][a-z0-9_]*)\.(rate|max|upkeep|creep|cost|storage|conv)$/;
const GLOBAL_TARGET_RE = /^(?:all\.creep|pop\.growth|cat\.([a-z]+)\.creep)$/;
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------
// 校验主体
// ---------------------------------------------------------------------------
export function validateConfig(c: GameConfig): Gate1Report {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (code: string, msg: string): void => { errors.push(`[${code}] ${msg}`); };
  const warn = (code: string, msg: string): void => { warnings.push(`[${code}] ${msg}`); };

  const resById = new Map(c.resources.map((r) => [r.id, r]));
  const jobById = new Map(c.jobs.map((j) => [j.id, j]));
  const bldgById = new Map(c.buildings.map((b) => [b.id, b]));
  const techById = new Map(c.techs.map((t) => [t.id, t]));
  const eraIds = new Set(c.eras.map((e) => e.id));
  const seasonIds = new Set(c.seasons.map((s) => s.id));
  const eraCount = c.eras.length;

  // ---- G1-01 ID：格式、保留字、唯一（资源/工种/建筑/科技/种族之间也不得重名）
  {
    const owner = new Map<string, string>();
    const groups: Array<[string, string[], boolean]> = [
      ['resource', c.resources.map((x) => x.id), true], ['job', c.jobs.map((x) => x.id), true],
      ['building', c.buildings.map((x) => x.id), true], ['tech', c.techs.map((x) => x.id), true],
      ['race', c.races.map((x) => x.id), true], ['era', c.eras.map((x) => x.id), false], ['season', c.seasons.map((x) => x.id), false],
    ];
    for (const [name, ids, crossCheck] of groups) {
      const seen = new Set<string>();
      for (const id of ids) {
        if (!ID_RE.test(id)) err('G1-01', `${name} ID "${id}" 格式不合法，须为 snake_case 小写`);
        if (RESERVED_IDS.has(id)) err('G1-01', `${name} ID "${id}" 与引擎保留字重名`);
        if (seen.has(id)) err('G1-01', `${name} 出现重复 ID: ${id}`);
        seen.add(id);
        if (crossCheck) {
          const prev = owner.get(id);
          if (prev !== undefined && prev !== name) err('G1-01', `ID "${id}" 同时被 ${prev} 与 ${name} 使用`);
          owner.set(id, name);
        }
      }
    }
  }

  // ---- G1-05 / G1-15 递归扫描：键名不得含 tick（除 tickMs），数值必须有限
  {
    const visit = (v: unknown, p: string): void => {
      if (typeof v === 'number') { if (!Number.isFinite(v)) err('G1-15', `${p} 不是有限数: ${String(v)}`); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${p}[${i}]`)); return; }
      if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          if (/tick/i.test(k) && k !== 'tickMs') err('G1-05', `${p}.${k} 的键名含 tick：配置速率与周期必须以“每秒/秒”表达（FR-01）`);
          visit(x, `${p}.${k}`);
        }
      }
    };
    visit(c, 'config');
  }

  // ---- G1-06 时钟与周期：整数秒，保证 tickMs = 100/250/1000 都能精确换算
  {
    const k = c.clock;
    if (!Number.isInteger(k.tickMs) || k.tickMs <= 0 || 1000 % k.tickMs !== 0) err('G1-06', `clock.tickMs=${k.tickMs} 须为能整除 1000 的正整数`);
    const durs: Array<[string, number, boolean]> = [
      ['clock.maxOfflineSec', k.maxOfflineSec, true], ['clock.hazardIntervalSec', k.hazardIntervalSec, true],
      ['clock.seasonSec', k.seasonSec, true], ['clock.seasonForewarnSec', k.seasonForewarnSec, true], ['clock.orderRefreshSec', k.orderRefreshSec, true],
      ['chain.l2Sec', c.chain.l2Sec, true], ['chain.l3Sec', c.chain.l3Sec, true], ['chain.warmupSec', c.chain.warmupSec, true],
      ['chain.l1ConfirmSec', c.chain.l1ConfirmSec, false], ['governor.cooldownSec', c.governor.cooldownSec, true],
    ];
    for (const [name, v, mustPositive] of durs) {
      if (!Number.isInteger(v) || v < 0 || (mustPositive && v === 0)) err('G1-06', `${name}=${v} 须为${mustPositive ? '正' : '非负'}整数秒`);
    }
    if (k.seasonForewarnSec >= k.seasonSec) err('G1-06', 'clock.seasonForewarnSec 必须小于 seasonSec');
    if (c.seasons.length === 0) err('G1-06', '至少需要一个季节（FR-10）');
    else if (c.seasons.length !== 4) warn('G1-W3', `季节数为 ${c.seasons.length}，PRD FR-10 约定一年 4 季（3600 秒）`);
    if (k.maxOfflineSec !== EXPECTED_MAX_OFFLINE_SEC) warn('G1-W4', `maxOfflineSec=${k.maxOfflineSec}，PRD FR-20 约定 24 小时 = ${EXPECTED_MAX_OFFLINE_SEC}`);
  }

  // ---- G1-07 断链阈值（含引导期合并后的取值）
  {
    const checkChain = (label: string, t: GameConfig['chain']): void => {
      if (!(t.starveRatio > 0 && t.starveRatio < t.recoverRatio && t.recoverRatio <= 1)) err('G1-07', `${label}：须满足 0 < starveRatio < recoverRatio ≤ 1`);
      if (!(t.l1ConfirmSec < t.l2Sec && t.l2Sec < t.l3Sec)) err('G1-07', `${label}：须满足 l1ConfirmSec < l2Sec < l3Sec`);
    };
    checkChain('chain', c.chain);
    // v0.4：TutorialOverrides 已移除 chain（类型层拒绝引导注入断链阈值，架构 5.7.1），故不再合并 tutorialOverrides.chain 校验。
    if (c.chain.warmupSec < WARMUP_RANGE[0] || c.chain.warmupSec > WARMUP_RANGE[1]) warn('G1-W5', `warmupSec=${c.chain.warmupSec}，PRD FR-06 建议 ${WARMUP_RANGE[0]}–${WARMUP_RANGE[1]} 秒`);
  }

  // ---- G1-08 纪元结构、门槛、倍率、引导缩放、总管与人口参数
  {
    c.eras.forEach((e, i) => {
      if (e.index !== i + 1) err('G1-08', `纪元 ${e.id} 的 index 应为 ${i + 1}，实际 ${e.index}`);
      if (e.gate === null && i !== eraCount - 1) err('G1-08', `纪元 ${e.id} 不是最后一个却没有进入门槛`);
      if (e.gate !== null && i === eraCount - 1) warn('G1-W6', `最后一个已配置纪元 ${e.id} 仍有门槛，但下一纪元未配置`);
      if (!(e.storageMultiplier >= 1)) err('G1-08', `纪元 ${e.id} 的 storageMultiplier 须 ≥ 1`);
      if (!(e.storageCeilingMultiplier >= e.storageMultiplier)) err('G1-08', `纪元 ${e.id} 的 storageCeilingMultiplier 须 ≥ storageMultiplier（FR-04 天花板）`);
      const prev = c.eras[i - 1];
      if (prev) {
        if (e.storageMultiplier < prev.storageMultiplier) err('G1-08', `纪元 ${e.id} 的仓储倍率低于上一纪元（FR-08：进入时重置并提升）`);
        if (e.storageCeilingMultiplier < prev.storageCeilingMultiplier) err('G1-08', `纪元 ${e.id} 的仓储天花板低于上一纪元`);
        if (e.ecoGridSize < prev.ecoGridSize) err('G1-08', `纪元 ${e.id} 的试验田规格小于上一纪元`);
      }
      for (const req of e.gate ?? []) {
        if (req.kind === 'resource') {
          const r = resById.get(req.resId);
          if (!r) err('G1-02', `纪元 ${e.id} 门槛引用了不存在的资源 ${req.resId}`);
          else if (r.unlockEraIndex > e.index) err('G1-09', `纪元 ${e.id} 门槛要求的资源 ${req.resId} 在纪元 ${r.unlockEraIndex} 才解锁`);
          if (!(req.amount > 0)) err('G1-15', `纪元 ${e.id} 门槛资源 ${req.resId} 的 amount 须 > 0`);
        } else {
          const b = bldgById.get(req.buildingId);
          if (!b) err('G1-02', `纪元 ${e.id} 门槛引用了不存在的建筑 ${req.buildingId}`);
          else if (b.eraIndex > e.index) err('G1-09', `纪元 ${e.id} 门槛要求的建筑 ${req.buildingId} 在纪元 ${b.eraIndex} 才出现`);
          if (!Number.isInteger(req.count) || req.count < 1) err('G1-15', `纪元 ${e.id} 门槛建筑 ${req.buildingId} 的 count 须为正整数`);
        }
      }
    });
    for (const [eid, scale] of Object.entries(c.tutorialOverrides.eraGateScale)) {
      if (!eraIds.has(eid)) err('G1-02', `tutorialOverrides.eraGateScale 引用了不存在的纪元 ${eid}`);
      if (!(scale > 0 && scale <= 1)) err('G1-08', `tutorialOverrides.eraGateScale.${eid}=${scale} 须在 (0, 1] 内`);
    }
    const g = c.governor;
    if (!(g.survivalTriggerRatio > 0 && g.survivalTriggerRatio < g.survivalReleaseRatio && g.survivalReleaseRatio < 1)) err('G1-08', 'governor：须满足 0 < survivalTriggerRatio < survivalReleaseRatio < 1');
    if (!(g.defaultsFromEraIndex >= 1 && g.defaultsFromEraIndex <= eraCount)) err('G1-08', `governor.defaultsFromEraIndex=${g.defaultsFromEraIndex} 超出已配置纪元 1–${eraCount}`);
    if (new Set(g.drawOrder).size !== g.drawOrder.length) err('G1-08', 'governor.drawOrder 有重复工种');
    for (const j of g.drawOrder) if (!jobById.has(j)) err('G1-02', `governor.drawOrder 引用了不存在的工种 ${j}`);
    if (!(c.population.growthPerSec > 0)) err('G1-15', 'population.growthPerSec 须 > 0');
    if (!(c.population.upkeepPerSec > 0)) err('G1-15', 'population.upkeepPerSec 须 > 0');
    const ap = g.adminPower;
    if (!(isFiniteNum(ap.baseCapacity) && ap.baseCapacity > 0 && isFiniteNum(ap.perRuleCost) && ap.perRuleCost > 0 && isFiniteNum(ap.perQueueItemCost) && ap.perQueueItemCost >= 0)) err('G1-15', 'governor.adminPower：baseCapacity、perRuleCost 须 > 0，perQueueItemCost 须 ≥ 0');
    else if (ap.perRuleCost > ap.baseCapacity) err('G1-15', 'governor.adminPower：单条规则占用不能超过基础容量，否则默认保底规则永远无法启用');
    c.overflowConversions.forEach((o, i) => {
      const w = `overflowConversions[${i}]`;
      if (!resById.has(o.fromResId)) err('G1-02', `${w} 引用了不存在的资源 ${o.fromResId}`);
      if (!resById.has(o.toResId)) err('G1-02', `${w} 引用了不存在的资源 ${o.toResId}`);
      if (!techById.has(o.requiresTech)) err('G1-02', `${w} 引用了不存在的科技 ${o.requiresTech}`);
      if (o.fromResId === o.toResId) err('G1-08', `${w} 的来源与目标是同一资源`);
      if (!(o.ratio > 0 && o.ratio < 1)) err('G1-15', `${w}.ratio=${o.ratio} 须在 (0, 1) 内（FR-04：转化后的单位价值必须低于直接产出）`);
      if (o.nextBuildCostDiscount !== undefined && !(o.nextBuildCostDiscount >= 0.01 && o.nextBuildCostDiscount <= 0.03)) err('G1-15', `${w}.nextBuildCostDiscount=${o.nextBuildCostDiscount} 须在 0.01–0.03 内（FR-04）`);
    });
  }

  // ---- G1-02 / G1-09 / G1-15 资源、工种、建筑、科技的引用与解锁纪元
  for (const r of c.resources) {
    if (!(r.unlockEraIndex >= 1 && r.unlockEraIndex <= eraCount)) err('G1-09', `资源 ${r.id} 的 unlockEraIndex=${r.unlockEraIndex} 超出已配置纪元`);
    if (!(r.baseMax > 0)) err('G1-15', `资源 ${r.id} 的 baseMax 须 > 0`);
  }
  for (const j of c.jobs) {
    if (!(j.unlockEraIndex >= 1 && j.unlockEraIndex <= eraCount)) err('G1-09', `工种 ${j.id} 的 unlockEraIndex 超出已配置纪元`);
    for (const [kind, rec] of [['产出', j.producesPerSec], ['消耗', j.consumesPerSec ?? {}]] as const) {
      for (const [rid, v] of Object.entries(rec)) {
        const r = resById.get(rid);
        if (!r) err('G1-02', `工种 ${j.id} ${kind}了不存在的资源 ${rid}`);
        else if (r.unlockEraIndex > j.unlockEraIndex) err('G1-09', `工种 ${j.id}（纪元 ${j.unlockEraIndex}）${kind}的资源 ${rid} 在纪元 ${r.unlockEraIndex} 才解锁`);
        if (!(v > 0)) err('G1-15', `工种 ${j.id} 的 ${kind}速率 ${rid} 须 > 0`);
      }
    }
    if (Object.keys(j.producesPerSec).length === 0) err('G1-10', `工种 ${j.id} 没有任何产出`);
  }
  for (const b of c.buildings) {
    if (!(b.eraIndex >= 1 && b.eraIndex <= eraCount)) err('G1-09', `建筑 ${b.id} 的纪元 ${b.eraIndex} 未配置`);
    for (const [rid, v] of Object.entries(b.baseCost)) {
      const r = resById.get(rid);
      if (!r) err('G1-02', `建筑 ${b.id} 的成本引用了不存在的资源 ${rid}`);
      else if (r.unlockEraIndex > b.eraIndex) err('G1-09', `建筑 ${b.id}（纪元 ${b.eraIndex}）的成本资源 ${rid} 在纪元 ${r.unlockEraIndex} 才解锁`);
      if (!(v > 0)) err('G1-15', `建筑 ${b.id} 的成本 ${rid} 须 > 0`);
    }
    if (Object.keys(b.baseCost).length === 0) err('G1-15', `建筑 ${b.id} 没有成本`);
    for (const [jid, n] of Object.entries(b.jobSlots ?? {})) {
      if (!jobById.has(jid)) err('G1-02', `建筑 ${b.id} 的 jobSlots 引用了不存在的工种 ${jid}`);
      if (!Number.isInteger(n) || n < 1) err('G1-15', `建筑 ${b.id} 的 jobSlots.${jid} 须为正整数`);
    }
    for (const [rid, v] of Object.entries(b.storagePerUnit ?? {})) {
      if (!resById.has(rid)) err('G1-02', `建筑 ${b.id} 的 storagePerUnit 引用了不存在的资源 ${rid}`);
      if (!(v > 0)) err('G1-15', `建筑 ${b.id} 的 storagePerUnit.${rid} 须 > 0`);
    }
    for (const rec of [b.passiveProducesPerSec, b.passiveConsumesPerSec]) {
      for (const [rid, v] of Object.entries(rec ?? {})) {
        if (!resById.has(rid)) err('G1-02', `建筑 ${b.id} 的被动产耗引用了不存在的资源 ${rid}`);
        if (!(v > 0)) err('G1-15', `建筑 ${b.id} 的被动产耗 ${rid} 须 > 0`);
      }
    }
    if (b.housingPerUnit !== undefined && !(b.housingPerUnit > 0)) err('G1-15', `建筑 ${b.id} 的 housingPerUnit 须 > 0`);
    if (!Number.isInteger(b.sockets) || b.sockets < 0) err('G1-15', `建筑 ${b.id} 的 sockets 须为非负整数`);
  }
  for (const t of c.techs) {
    if (!(t.eraIndex >= 1 && t.eraIndex <= eraCount)) err('G1-09', `科技 ${t.id} 的纪元 ${t.eraIndex} 未配置`);
    for (const [rid, v] of Object.entries(t.cost)) {
      const r = resById.get(rid);
      if (!r) err('G1-02', `科技 ${t.id} 的成本引用了不存在的资源 ${rid}`);
      else if (r.unlockEraIndex > t.eraIndex) err('G1-09', `科技 ${t.id}（纪元 ${t.eraIndex}）的成本资源 ${rid} 在纪元 ${r.unlockEraIndex} 才解锁`);
      if (!(v > 0)) err('G1-15', `科技 ${t.id} 的成本 ${rid} 须 > 0`);
    }
    for (const q of t.requires) {
      const qt = techById.get(q);
      if (!qt) err('G1-02', `科技 ${t.id} 依赖不存在的科技 ${q}`);
      else if (qt.eraIndex > t.eraIndex) err('G1-03', `科技 ${t.id}（纪元 ${t.eraIndex}）依赖更晚纪元的科技 ${q}（纪元 ${qt.eraIndex}）`);
    }
  }

  // ---- G1-03 科技图无环（FR-09）
  {
    const color = new Map<string, 1 | 2>();
    const dfs = (id: string, stack: string[]): void => {
      const st = color.get(id);
      if (st === 2) return;
      if (st === 1) { err('G1-03', `科技图有环: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`); return; }
      color.set(id, 1);
      for (const q of techById.get(id)?.requires ?? []) if (techById.has(q)) dfs(q, [...stack, id]);
      color.set(id, 2);
    };
    for (const id of techById.keys()) dfs(id, []);
  }

  // ---- G1-04 修饰器目标：语法 + 引用真实存在 + 数值范围
  {
    const mods: Array<[string, ModifierConfig]> = [];
    c.techs.forEach((t) => t.modifiers.forEach((m, i) => mods.push([`科技 ${t.id}.modifiers[${i}]`, m])));
    c.seasons.forEach((s) => s.modifiers.forEach((m, i) => mods.push([`季节 ${s.id}.modifiers[${i}]`, m])));
    for (const r of c.races) {
      r.modifiers.forEach((m, i) => mods.push([`种族 ${r.id}.modifiers[${i}]`, m]));
      for (const [sid, ms] of Object.entries(r.seasonOverrides)) {
        if (!seasonIds.has(sid)) err('G1-02', `种族 ${r.id} 的 seasonOverrides 引用了不存在的季节 ${sid}`);
        ms.forEach((m, i) => mods.push([`种族 ${r.id}.seasonOverrides.${sid}[${i}]`, m]));
      }
    }
    for (const [where, m] of mods) {
      const glob = GLOBAL_TARGET_RE.exec(m.target);
      const hit = glob ? null : TARGET_RE.exec(m.target);
      if (!glob && !hit) { err('G1-04', `${where} 的目标 "${m.target}" 不符合目标语法（见 configs/types.ts 的 ModifierTarget）`); continue; }
      if (glob) {
        if (glob[1] !== undefined && !own(BUILDING_CATEGORIES, glob[1])) err('G1-04', `${where} 的目标 "${m.target}" 引用了不存在的建筑类别 ${glob[1]}`);
      } else if (hit) {
        const [, kind, id, attr] = hit;
        const okAttr = (kind === 'res' && (attr === 'rate' || attr === 'max' || attr === 'upkeep')) || (kind === 'job' && attr === 'rate')
          || (kind === 'bldg' && (attr === 'creep' || attr === 'cost' || attr === 'storage' || attr === 'upkeep' || attr === 'conv'));
        if (!okAttr) err('G1-04', `${where} 的目标 "${m.target}" 属性与对象类型不匹配`);
        const exists = kind === 'res' ? resById.has(id) : kind === 'job' ? jobById.has(id) : bldgById.has(id);
        if (!exists) err('G1-04', `${where} 的目标 "${m.target}" 引用了不存在的 ${kind === 'res' ? '资源' : kind === 'job' ? '工种' : '建筑'} ${id}`);
      }
      if (!own(MODIFIER_OPS, m.op)) err('G1-04', `${where} 的 op "${m.op}" 非法`);
      if (!isFiniteNum(m.value)) err('G1-15', `${where} 的 value 不是有限数`);
      else if (m.op === 'mul' && m.value <= 0) err('G1-04', `${where}：mul 的 value 须 > 0`);
      else if (m.op === 'add_pct' && m.value <= -1) err('G1-04', `${where}：add_pct 的 value 须 > -1（不能把属性压到 0 以下）`);
    }
  }

  // ---- G1-11 蠕变硬下限与基准区间
  for (const b of c.buildings) {
    if (!(b.creepBase >= CREEP_FLOOR)) err('G1-11', `建筑 ${b.id} 的 creepBase=${b.creepBase} 低于硬下限 ${CREEP_FLOOR}（FR-05）`);
    const band = CREEP_BASELINE[b.category];
    if (band && (b.creepBase < band[0] || b.creepBase > band[1])) warn('G1-W1', `建筑 ${b.id}（${b.category}）creepBase=${b.creepBase} 不在附录 C.1 区间 ${band[0]}–${band[1]}`);
  }
  {
    const maxOf = (cat: BuildingCategory): number => Math.max(0, ...c.buildings.filter((b) => b.category === cat).map((b) => b.creepBase));
    const minOf = (cat: BuildingCategory): number => Math.min(Infinity, ...c.buildings.filter((b) => b.category === cat).map((b) => b.creepBase));
    if (c.buildings.some((b) => b.category === 'storage') && c.buildings.some((b) => b.category === 'gather') && !(minOf('storage') > maxOf('gather'))) {
      warn('G1-W2', '仓储类的蠕变系数应高于采集类（附录 C.1：仓库比建筑涨价更快）');
    }
  }

  // ---- 种族自身声明（与视图无关的部分）
  for (const r of c.races) {
    for (const [from, to] of Object.entries(r.resourceMap)) {
      if (!resById.has(from)) err('G1-13', `种族 ${r.id} 的 resourceMap 键 ${from} 不是已知资源`);
      if (!resById.has(to)) err('G1-13', `种族 ${r.id} 的 resourceMap 值 ${to} 不是已知资源`);
      if (from === to) err('G1-13', `种族 ${r.id} 的 resourceMap 把 ${from} 映射到自身`);
      if (own(r.resourceMap, to)) err('G1-13', `种族 ${r.id} 的 resourceMap 出现链式替换 ${from} -> ${to} -> ${r.resourceMap[to]}`);
      if (r.disabledResources.includes(to)) err('G1-13', `种族 ${r.id} 的替换目标资源 ${to} 同时被废除`);
    }
    for (const x of r.disabledResources) if (!resById.has(x)) err('G1-13', `种族 ${r.id} 废除了不存在的资源 ${x}`);
    for (const x of r.disabledBuildings) if (!bldgById.has(x)) err('G1-13', `种族 ${r.id} 废除了不存在的建筑 ${x}`);
    if (new Set(r.disabledFeatures).size !== r.disabledFeatures.length) err('G1-13', `种族 ${r.id} 的 disabledFeatures 有重复项`);
    if (own(r.resourceMap, r.sustenance.resId)) err('G1-13', `种族 ${r.id} 的维生资源 ${r.sustenance.resId} 已被替换，应声明替换后的资源`);
    if (r.disabledResources.includes(r.sustenance.resId)) err('G1-13', `种族 ${r.id} 的维生资源 ${r.sustenance.resId} 被废除`);
  }

  // ---- 视图校验：种族无关视图 + 每个种族视图（FR-07、FR-08：被废除/被替换后仍须可达）
  interface View {
    label: string;
    race: RaceConfig | null;
    mapRes: (r: string) => string;
    res: Set<string>;
    buildings: BuildingConfig[];
    jobs: JobConfig[];
  }
  const buildView = (race: RaceConfig | null): View => {
    const replaced = new Set(race ? Object.keys(race.resourceMap) : []);
    const offR = new Set(race?.disabledResources ?? []);
    const offB = new Set(race?.disabledBuildings ?? []);
    const buildings = c.buildings.filter((b) => !offB.has(b.id));
    return {
      label: race ? `种族 ${race.id}` : '种族无关视图',
      race,
      mapRes: (r) => (race !== null && own(race.resourceMap, r) ? race.resourceMap[r] : r),
      res: new Set(c.resources.filter((r) => !offR.has(r.id) && !replaced.has(r.id)).map((r) => r.id)),
      buildings,
      jobs: c.jobs.filter((j) => buildings.some((b) => b.jobSlots !== undefined && own(b.jobSlots, j.id))),
    };
  };
  const checkSustenance = (v: View, s: Sustenance): void => {
    if (!resById.has(s.resId)) { err('G1-02', `${v.label} 的维生资源 ${s.resId} 不存在`); return; }
    if (!jobById.has(s.jobId)) { err('G1-02', `${v.label} 的维生工种 ${s.jobId} 不存在`); return; }
    if (!v.res.has(s.resId)) err('G1-13', `${v.label} 的维生资源 ${s.resId} 对该种族不可用`);
    const j = v.jobs.find((x) => x.id === s.jobId);
    if (!j) err('G1-13', `${v.label} 的维生工种 ${s.jobId} 不可用（它的岗位建筑被废除，或没有建筑提供岗位）`);
    else if (!own(j.producesPerSec, s.resId)) err('G1-13', `${v.label} 的维生工种 ${s.jobId} 不产出维生资源 ${s.resId}`);
  };
  const supportedMax = (v: View, rid: string, era: EraConfig): number => {
    const r = resById.get(rid);
    if (!r) return 0;
    const built = v.buildings.filter((b) => b.eraIndex <= era.index);
    if (r.kind === 'population') return r.baseMax + MAX_STORAGE_UNITS * Math.max(0, ...built.map((b) => b.housingPerUnit ?? 0));
    const perUnit = Math.max(0, ...built.map((b) => (b.storagePerUnit !== undefined && own(b.storagePerUnit, rid) ? b.storagePerUnit[rid] : 0)));
    return Math.min(r.baseMax * era.storageCeilingMultiplier, r.baseMax * era.storageMultiplier + MAX_STORAGE_UNITS * perUnit);
  };
  const entryMax = (rid: string, era: EraConfig): number => {
    const r = resById.get(rid);
    if (!r) return 0;
    return r.kind === 'population' ? r.baseMax : r.baseMax * era.storageMultiplier;
  };
  const checkView = (v: View): void => {
    // 工种：岗位建筑
    for (const j of c.jobs) {
      const providers = v.buildings.filter((b) => b.jobSlots !== undefined && own(b.jobSlots, j.id));
      if (providers.length === 0) {
        if (v.race === null) err('G1-10', `工种 ${j.id} 没有任何建筑提供岗位上限`);
        continue;
      }
      if (!providers.some((b) => b.eraIndex <= j.unlockEraIndex)) err('G1-10', `${v.label}：工种 ${j.id} 的岗位建筑都晚于工种解锁纪元 ${j.unlockEraIndex}`);
      for (const rid of [...Object.keys(j.producesPerSec), ...Object.keys(j.consumesPerSec ?? {})]) {
        if (!v.res.has(rid)) err('G1-10', `${v.label}：工种 ${j.id} 仍可用，却涉及该种族已废除或被替换的资源 ${rid}`);
      }
    }
    // 资源：产出源
    for (const r of c.resources) {
      // v0.4.1（G1-10 修复）：订单物（kind='order'）是右轨产物，不由工种/被动/溢出产出，豁免“每资源有产出来源”判定；
      // 订单物的来源完整性改由 G1-20（种子 yieldOrderId 引用检查）保证。
      if (!v.res.has(r.id) || r.kind === 'population' || r.kind === 'order') continue;
      const byJob = v.jobs.some((j) => own(j.producesPerSec, r.id));
      const byPassive = v.buildings.some((b) => b.passiveProducesPerSec !== undefined && own(b.passiveProducesPerSec, r.id));
      const byOverflow = c.overflowConversions.some((o) => o.toResId === r.id && v.res.has(o.fromResId));
      if (!byJob && !byPassive && !byOverflow) err('G1-10', `${v.label}：资源 ${r.id} 没有任何可用的产出来源`);
    }
    // 成本只能引用该种族可用的资源（按 resourceMap 映射后）
    for (const b of v.buildings) {
      for (const rid of Object.keys(b.baseCost)) {
        if (!v.res.has(v.mapRes(rid))) err('G1-13', `${v.label}：建筑 ${b.id} 的成本资源 ${rid}（映射为 ${v.mapRes(rid)}）不可用`);
      }
    }
    for (const t of c.techs) {
      for (const rid of Object.keys(t.cost)) {
        if (!v.res.has(v.mapRes(rid))) err('G1-13', `${v.label}：科技 ${t.id} 的成本资源 ${rid}（映射为 ${v.mapRes(rid)}）不可用`);
      }
    }
    // 纪元：首批建筑、门槛、可达性
    for (const e of c.eras) {
      const inEra = v.buildings.filter((b) => b.eraIndex === e.index);
      const entries = inEra.filter((b) => b.isEraEntry === true);
      if (entries.length === 0) err('G1-12', `${v.label}：纪元 ${e.id} 没有可用的首批建筑（isEraEntry）`);
      for (const b of entries) {
        for (const [rid, amt] of Object.entries(b.baseCost)) {
          const lim = entryMax(v.mapRes(rid), e);
          if (amt > lim) err('G1-12', `${v.label}：首批建筑 ${b.id} 的 ${rid} 成本 ${amt} 超过纪元起点可达上限 ${lim}`);
        }
      }
      for (const b of inEra) {
        for (const [rid, amt] of Object.entries(b.baseCost)) {
          const lim = supportedMax(v, v.mapRes(rid), e);
          if (amt > lim) err('G1-12', `${v.label}：建筑 ${b.id} 的 ${rid} 成本 ${amt} 超过本纪元可达上限 ${lim}，永远攒不够`);
        }
      }
      for (const t of c.techs.filter((x) => x.eraIndex === e.index)) {
        for (const [rid, amt] of Object.entries(t.cost)) {
          const lim = supportedMax(v, v.mapRes(rid), e);
          if (amt > lim) err('G1-12', `${v.label}：科技 ${t.id} 的 ${rid} 成本 ${amt} 超过本纪元可达上限 ${lim}`);
        }
      }
      for (const req of e.gate ?? []) {
        if (req.kind === 'resource') {
          const m = v.mapRes(req.resId);
          if (!v.res.has(m)) { err('G1-13', `${v.label}：纪元 ${e.id} 门槛资源 ${req.resId}（映射为 ${m}）不可用`); continue; }
          const lim = supportedMax(v, m, e);
          if (req.amount > lim) err('G1-12', `${v.label}：纪元 ${e.id} 门槛 ${req.resId} 需要 ${req.amount}，超过可达上限 ${lim}`);
        } else if (!v.buildings.some((b) => b.id === req.buildingId)) {
          err('G1-13', `${v.label}：纪元 ${e.id} 门槛要求的建筑 ${req.buildingId} 对该种族不可用`);
        }
      }
    }
  };

  const neutral = buildView(null);
  checkSustenance(neutral, c.neutralSustenance);
  checkView(neutral);
  for (const r of c.races) {
    const v = buildView(r);
    checkSustenance(v, r.sustenance);
    checkView(v);
  }
  if (c.races.length === 0) err('G1-13', '至少需要一个种族');

  // ---- v0.4.1（批次三）：新增检查项 G1-20（订单物/种子引用）、G1-21（自动化切片单调）、G1-22（政体 2+2）、
  //      G1-23（催化剂蠕变削减）、G1-24（行政算力来源键）。字段未提供时静默跳过，提供时校验。
  {
    const checkCapSchedule = (label: string, slots: Array<{ cap: number }>): void => {
      // 首个 cap 可 < 满配（容许首项 0，表示前期不放开），但必须单调不减。
      for (let i = 1; i < slots.length; i++) {
        if (!(slots[i].cap >= slots[i - 1].cap)) err('G1-21', `${label} 的 cap 须单调不减，但 [${i}](${slots[i].cap}) < [${i - 1}](${slots[i - 1].cap})`);
      }
    };
    // G1-21：automation 的 governorRuleSlots / queueLengthCaps cap 单调不减
    if (c.automation !== undefined) {
      checkCapSchedule('automation.governorRuleSlots', c.automation.governorRuleSlots);
      checkCapSchedule('automation.queueLengthCaps', c.automation.queueLengthCaps);
    }
    // G1-22：每政体 strongPros / strongCons 各 ≥ 2（2+2 结构强制）
    if (c.governments !== undefined) {
      for (const gov of c.governments) {
        if (gov.strongPros.length < 2) err('G1-22', `政体 ${gov.id} 的 strongPros 须 ≥ 2 条（实际 ${gov.strongPros.length}）`);
        if (gov.strongCons.length < 2) err('G1-22', `政体 ${gov.id} 的 strongCons 须 ≥ 2 条（实际 ${gov.strongCons.length}）`);
      }
    }
    // G1-23：catalystQualities 的 creepReduction 使关联建筑 creepBase - creepReduction ≥ 1.015（未提供时跳过）
    if (c.catalystQualities !== undefined) {
      for (const q of c.catalystQualities) {
        // 按 creepBase 最低的候选建筑估算最坏情形：只须保证存在至少一座可用建筑削减后不低于硬下限。
        const floors = c.buildings.map((b) => b.creepBase - q.creepReduction);
        if (floors.length > 0 && Math.min(...floors) < CREEP_FLOOR) {
          err('G1-23', `催化剂品质 ${q.catalystId}（${q.quality}）的 creepReduction=${q.creepReduction} 使关联建筑 creepBase 削减后低于硬下限 ${CREEP_FLOOR}（FR-05）`);
        }
      }
    }
    // G1-24：adminPower 的 perBuildingSource / perTechSource 键存在性（未提供时跳过）
    const apSources = c.governor.adminPower;
    if (apSources.perBuildingSource !== undefined) {
      for (const bid of Object.keys(apSources.perBuildingSource)) {
        if (!bldgById.has(bid)) err('G1-24', `governor.adminPower.perBuildingSource 引用了不存在的建筑 ${bid}`);
      }
    }
    if (apSources.perTechSource !== undefined) {
      for (const tid of Object.keys(apSources.perTechSource)) {
        if (!techById.has(tid)) err('G1-24', `governor.adminPower.perTechSource 引用了不存在的科技 ${tid}`);
      }
    }
    // G1-20：订单物（kind='order'）必须被某 SeedConfig.yieldOrderId 引用（孤儿订单物检查）；seeds 未提供时跳过；
    //       且 SeedConfig.yieldOrderId 必须指向 kind='order' 资源。
    if (c.seeds !== undefined) {
      const orderResIds = new Set(c.resources.filter((r) => r.kind === 'order').map((r) => r.id));
      for (const s of c.seeds) {
        const target = resById.get(s.yieldOrderId);
        if (!target) err('G1-20', `种子 ${s.id} 的 yieldOrderId=${s.yieldOrderId} 不是已知资源`);
        else if (target.kind !== 'order') err('G1-20', `种子 ${s.id} 的 yieldOrderId=${s.yieldOrderId} 须指向 kind='order' 的资源，实际 kind='${target.kind}'`);
      }
      const referenced = new Set(c.seeds.map((s) => s.yieldOrderId));
      for (const rid of orderResIds) {
        if (!referenced.has(rid)) err('G1-20', `订单物资源 ${rid} 未被任何种子（SeedConfig.yieldOrderId）引用（孤儿订单物）`);
      }
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// G1-14 静态扫描引擎源码：具体种族、资源、工种 ID 出现 0 处（FR-07、FR-08、架构 2.5）
// ---------------------------------------------------------------------------

/** 提取源码中的字符串字面量（忽略注释；模板字符串的静态段与插值内的字面量都会取到）。 */
export function extractStringLiterals(src: string): Array<{ value: string; line: number }> {
  const out: Array<{ value: string; line: number }> = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  while (i < n) {
    const ch = src[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      let v = '';
      i++;
      while (i < n && src[i] !== ch && src[i] !== '\n') {
        if (src[i] === '\\') { v += src[i + 1] ?? ''; i += 2; } else { v += src[i]; i++; }
      }
      i++;
      out.push({ value: v, line: startLine });
      continue;
    }
    if (ch === '`') {
      const startLine = line;
      let v = '';
      i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { v += src[i + 1] ?? ''; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          out.push({ value: v, line: startLine });
          v = '';
          const bodyLine = line;
          let depth = 1;
          i += 2;
          const from = i;
          while (i < n && depth > 0) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') depth--;
            else if (src[i] === '\n') line++;
            i++;
          }
          for (const lit of extractStringLiterals(src.slice(from, i - 1))) out.push({ value: lit.value, line: bodyLine + lit.line - 1 });
          continue;
        }
        if (src[i] === '\n') line++;
        v += src[i];
        i++;
      }
      i++;
      out.push({ value: v, line: startLine });
      continue;
    }
    i++;
  }
  return out;
}

/** 扫描目录下的 .ts 源码（跳过 *.test.ts、*.spec.ts、*.d.ts、__fixtures__、node_modules）。 */
export function scanEngineSource(dir: string, c: GameConfig): string[] {
  const ids = new Set<string>([...c.races.map((r) => r.id), ...c.resources.map((r) => r.id), ...c.jobs.map((j) => j.id)]);
  const found: string[] = [];
  const scanFile = (file: string): void => {
    for (const lit of extractStringLiterals(fs.readFileSync(file, 'utf8'))) {
      const hit = lit.value.split(/[^a-z0-9_]+/).find((tok) => ids.has(tok));
      if (hit !== undefined) found.push(`[G1-14] ${file}:${lit.line} 字符串 "${lit.value}" 含具体 ID "${hit}"，引擎代码只能通过配置与种族声明取用`);
    }
  };
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '__fixtures__') walk(p); }
      else if (e.isFile() && e.name.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(e.name)) scanFile(p);
    }
  };
  walk(dir);
  return found;
}

export function runGate1(c: GameConfig, engineSrcDir?: string): Gate1Report {
  const rep = validateConfig(c);
  if (engineSrcDir !== undefined) rep.errors.push(...scanEngineSource(engineSrcDir, c));
  return rep;
}

// ---------------------------------------------------------------------------
// 命令行：node gate1.js [engine/src 目录]
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === 'file://' + encodeURI(process.argv[1]).replace(/\?/g, '%3F').replace(/\#/g, '%23')) {
  const rep = runGate1(M1_CONFIG, process.argv[2]);
  console.log('Gate 1 覆盖范围：');
  for (const [item, code, status] of COVERAGE) console.log(`  - ${item}  [${code}]  ${status}`);
  if (process.argv[2] === undefined) console.log('  （本次未传入引擎源码目录，G1-14 未执行）');
  for (const w of rep.warnings) console.log(`WARN  ${w}`);
  if (rep.errors.length > 0) {
    console.error(`GATE1 FAIL（${rep.errors.length} 项）`);
    for (const e of rep.errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(`GATE1 PASS（警告 ${rep.warnings.length} 项）`);
}
