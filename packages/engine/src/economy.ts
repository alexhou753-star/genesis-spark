/**
 * W5c 经济结算层 · FR-03/04/05/06/08 验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》M1 W5 · 经济结算层的「修饰器与上限 → 资源产出 → 建筑成本 → 断链」四层内核。
 * 这是把 W1–W5b 的空引擎变成「可玩游戏」的核心：四阶段结算里阶段 1（修饰器与上限）、
 * 阶段 3（资源流转 / 建筑成本）与阶段 4（断链离散事件）在本文件落实。
 *
 * ── 归属与并入目标（架构 3.1 五包拓扑）────────────────────────────────────────
 *   本文件最终并入 packages/engine（@genesis/engine）。
 *   暂存包内为避免跨包依赖，type 层面复用：
 *     · w2-staging/events.ts 的 SimState（由 './events.js' 引入）；
 *     · w1-staging/math.ts 的 fastPowInt（由 './math.js' 引入）。
 *   合并进 packages/engine 后：'./events.js' 换用 engine 内部 SimState 正式定义并在本层之上扩展，
 *   './math.js' 数学原语随 engine 内部保留；测试从 '../src/economy.js' 命中本文件。
 *   TODO(engine): 并入 @genesis/engine 时，本文件的本地配置类型（下方「最小可用投影」）改用
 *     @genesis/configs 的正式定义；EconomyState 的 modifierGroups 由阶段 1 脏标记缓存承载。
 *
 * ── 四阶段结算内核（架构 5.2 单一结算内核）与 FR 对应 ──────────────────────────
 *   阶段 1 修饰器与上限   → recomputeModifiers(state, config)             【FR-03 修饰器；本层只汇总】
 *   阶段 2 电网与负载     → (本文件不涉及，FR-12/13 后续里程碑)
 *   阶段 3 资源流转        → settleResources(state, dtSec, config)         【FR-03/04 资源结算】
 *                           buildingCost(config, id, count)               【FR-05 成本蠕变】
 *   阶段 4 生态与内政      → updateChainState(state, dtSec, config)        【FR-06 断链级联】
 *                           checkEraGate(state, config)                   【FR-08 纪元门槛】
 *
 * ── Evolve 式硬核体验的三个关键机制（本文件必须正确实现）──────────────────────
 *   1. 【上限与满仓】资源产量不得无限堆叠：amount >= max 时该资源产出归零（浪费事件，事件点 1）。
 *      这是 Evolve「撞墙」体验的核心——玩家必须扩仓或转化，否则简单堆人头会撞天花板。
 *   2. 【成本蠕变】每建一座建筑成本递增：第 count+1 座 = baseCost × creep^count，硬下限 1.015。
 *      这是 Evolve「边际成本递增」体验——线性扩产策略会自动失效，必须提效或转产。
 *   3. 【断链级联】关键资源不足时下游产业链减速甚至停摆（三级断链 l1→l2→l3，预热后恢复）。
 *      这是 Evolve「真实风险」体验——上游断供会沿依赖链传导，形成真实经营风险。
 *
 * ── 确定性约束（架构 5.6 / 5.8，见各函数头「确定性依据」）──────────────────────
 *   · 修饰器叠加顺序固定：add_base → add_pct → mul → override；同 op 内按稳定 id 字典序，
 *     稳定 id 由「来源 + op + 数值」合成，与输入数组排列无关（结论对输入排列不变）。
 *   · 遍历一律按配置声明数组顺序（不依赖对象键枚举）。
 *   · 只用 + - * /、min、max、floor、abs；幂用 fastPowInt（禁 Math.pow）；无时钟 / 随机 / 环境读取。
 *   · 本文件为纯函数库：所有导出函数输入 state、返回新 state（不原地修改入参）。
 */

import type { SimState } from './events.js';
import { fastPowInt } from './math.js';

// ---------------------------------------------------------------------------
// 配置类型：本暂存包的「最小可用」投影
// ---------------------------------------------------------------------------
// 说明：暂存包不能 import @genesis/configs 的完整类型（跨包依赖），故此处就地声明本层用到的
// 配置切片，字段与 packages/configs/src/types.ts（见 w5-staging/configs-types.ts）严格对齐。
// 并入 packages/engine 后直接改用 @genesis/configs 的正式定义，无需本段。

/** 修饰器运算种类（架构 5.8 / configs.types.ModifierOp）。 */
export type ModifierOp = 'add_base' | 'add_pct' | 'mul' | 'override';

/**
 * 修饰器目标语法（架构 5.8 / configs.types.ModifierTarget）。
 * 本次验收子集：res.<id>.rate | res.<id>.max | job.<id>.rate | bldg.<id>.creep | bldg.<id>.cost | pop.growth。
 * 为兼容完整语法其余成员，用宽模板联合承载。
 */
export type ModifierTarget =
  | `res.${string}.rate`
  | `res.${string}.max`
  | `res.${string}.upkeep`
  | `job.${string}.rate`
  | `bldg.${string}.creep`
  | `bldg.${string}.cost`
  | `bldg.${string}.storage`
  | `bldg.${string}.upkeep`
  | `bldg.${string}.conv`
  | 'all.creep'
  | `cat.${string}.creep`
  | 'pop.growth';

/** 一条修饰器配置（架构 5.8 / configs.types.ModifierConfig）。 */
export interface ModifierConfig {
  target: ModifierTarget;
  op: ModifierOp;
  value: number;
}

/** 资源种类（configs.types.ResourceKind 前四类；order 本层不涉及）。 */
export type ResourceKind = 'primary' | 'secondary' | 'knowledge' | 'population';

/** 资源配置（configs.types.ResourceConfig）。 */
export interface ResourceConfig {
  id: string;
  kind: ResourceKind;
  unlockEraIndex: number;
  baseMax: number;
}

/** 工种配置（configs.types.JobConfig）。 */
export interface JobConfig {
  id: string;
  unlockEraIndex: number;
  producesPerSec: Record<string, number>;
  consumesPerSec?: Record<string, number>;
}

/** 建筑类别（configs.types.BuildingCategory）。 */
export type BuildingCategory =
  | 'gather'
  | 'storage'
  | 'housing'
  | 'workshop'
  | 'research'
  | 'power'
  | 'orbital';

/** 建筑配置（configs.types.BuildingConfig）。 */
export interface BuildingConfig {
  id: string;
  eraIndex: number;
  category: BuildingCategory;
  baseCost: Record<string, number>;
  creepBase: number;
  jobSlots?: Record<string, number>;
  storagePerUnit?: Record<string, number>;
  housingPerUnit?: number;
  passiveProducesPerSec?: Record<string, number>;
  passiveConsumesPerSec?: Record<string, number>;
  sockets: number;
  isEraEntry?: boolean;
}

/** 科技配置（configs.types.TechConfig）。 */
export interface TechConfig {
  id: string;
  eraIndex: number;
  cost: Record<string, number>;
  requires: string[];
  modifiers: ModifierConfig[];
}

/** 季节配置（configs.types.SeasonConfig）。 */
export interface SeasonConfig {
  id: string;
  name: string;
  modifiers: ModifierConfig[];
}

/** 种族配置（configs.types.RaceConfig）。 */
export interface RaceConfig {
  id: string;
  kind: string;
  sustenance: { resId: string; jobId: string };
  resourceMap: Record<string, string>;
  disabledResources: string[];
  disabledBuildings: string[];
  disabledFeatures: string[];
  seasonOverrides: Record<string, ModifierConfig[]>;
  modifiers: ModifierConfig[];
}

/** 纪元门槛项（configs.types.EraRequirement：resource 同时承载「人口」「知识」，FR-08）。 */
export type EraRequirement =
  | { kind: 'resource'; resId: string; amount: number }
  | { kind: 'building'; buildingId: string; count: number };

/** 纪元配置（configs.types.EraConfig）。 */
export interface EraConfig {
  id: string;
  index: number;
  name: string;
  gate: EraRequirement[] | null;
  storageMultiplier: number;
  storageCeilingMultiplier: number;
  ecoGridSize: 0 | 2 | 3 | 4;
}

/** 断链阈值（configs.types.ChainThresholds，FR-06）。 */
export interface ChainThresholds {
  starveRatio: number;
  recoverRatio: number;
  l1ConfirmSec: number;
  l2Sec: number;
  l3Sec: number;
  warmupSec: number;
}

/** 引导覆写（configs.types.TutorialOverrides；v0.4 起只保留门槛缩放，不含 chain）。 */
export interface TutorialOverrides {
  eraGateScale: Record<string, number>;
}

/** GameConfig：本层依赖的最小配置总表（字段与 configs.types.GameConfig 对齐）。 */
export interface GameConfig {
  configVersion: number;
  clock: { tickMs: number; seasonSec: number; [k: string]: unknown };
  chain: ChainThresholds;
  population: { growthPerSec: number; upkeepPerSec: number };
  tutorialOverrides: TutorialOverrides;
  seasons: SeasonConfig[];
  eras: EraConfig[];
  races: RaceConfig[];
  resources: ResourceConfig[];
  jobs: JobConfig[];
  buildings: BuildingConfig[];
  techs: TechConfig[];
}

// ---------------------------------------------------------------------------
// 经济状态：EconomyState（任务硬约束 6）
// ---------------------------------------------------------------------------

/**
 * 断链状态机的一条链状态（任务硬约束 6；对齐 engine-types.ts 的 ChainState 语义并扩展预热字段）。
 *   - level：断链等级 0/1/2/3。
 *   - timerSec：欠载累计计时（秒）——满足率 < starveRatio 时累加，达阈值升到对应等级。
 *   - warmupRemainingSec：三级恢复预热剩余秒数（满足率回升 recoverRatio 以上后，先预热再恢复）。
 *   - l1Confirmed：一级是否已确认（l1ConfirmSec），避免重复写日志（对齐 engine-types.ts 注释）。
 */
export interface ChainState {
  level: 0 | 1 | 2 | 3;
  timerSec: number;
  warmupRemainingSec: number;
  l1Confirmed: boolean;
}

/**
 * EconomyState：经济结算层的可序列化状态（任务硬约束 6）。
 *
 * = SimState 基础字段（currentTick / tickMs / subMilli / resources / rates）+ 以下经济扩展字段 =
 *   - currentEra：当前纪元序号（1 起；checkEraGate 检查「当前纪元自身 gate」= 进入下一纪元的门槛）。
 *   - raceId：当前种族（ 表示尚未锁定，取中性口径）。
 *   - buildings：建筑表 { count: 已建座数, active: 活跃座数 }（active ≤ count）。
 *   - techs：已研究科技 ID 列表。
 *   - seasonIndex：当前季节下标（索引 config.seasons）。季节本应由 tick 推导，
 *       本层为可单测性显式携带（并入 engine 后可由 currentTick 与 clock.seasonSec 派生，届时移除）。
 *   - chainStates：各产业链断链状态机（按 chainId 索引）。
 *   - population：人口值（同时同步到 resources['citizens'].amount，见 settleResources 尾注）。
 *   - modifierGroups（可选）：阶段 1 的「修饰器视图缓存」（target → 折叠生效值），供阶段 3 读取；
 *       对应架构 5.2 阶段 1「按目标属性分桶做脏标记缓存」。并入 engine 后由阶段 1 缓存承载。
 */
export interface EconomyState extends SimState {
  currentEra: number;
  raceId: string | null;
  buildings: Record<string, { count: number; active: number }>;
  techs: string[];
  seasonIndex: number;
  chainStates: Record<string, ChainState>;
  population: number;
  modifierGroups?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 常量与内部工具（纯函数，确定性）
// ---------------------------------------------------------------------------

/**
 * CHAIN_LEVEL_OUTPUT：断链等级对下游产出的乘区（任务占位值）。
 *   l0 → ×1；l1 → ×0.7；l2 → ×0.4；l3 → ×0.1。只影响下游资源，不影响断链资源本身。
 */
const CHAIN_LEVEL_OUTPUT: Record<0 | 1 | 2 | 3, number> = { 0: 1, 1: 0.7, 2: 0.4, 3: 0.1 };

/** 建筑蠕变的硬下限（FR-05：V1.0 恒 ≥ 1.015，任何修饰器叠加后都不得低于此值）。 */
export const CREEP_HARD_LOWER_BOUND = 1.015;

/** sortedIds：去重后字典序排序（确定性遍历）。 */
function sortedIds(ids: Iterable<string>): string[] {
  return Array.from(new Set(ids)).sort();
}

/** findBuilding：按 id 查建筑配置；缺失返回 undefined（noUncheckedIndexedAccess 守卫）。 */
function findBuilding(config: GameConfig, id: string): BuildingConfig | undefined {
  return config.buildings.find((b) => b.id === id);
}

/**
 * splitTarget：把 ModifierTarget 拆成 { head, id, attr }，供分组与基础值选择。
 *   'res.food.rate' → { head:'res', id:'food', attr:'rate' }；
 *   'pop.growth'    → { head:'pop', id:'',    attr:'growth' }。
 * 本工程 ID 用 snake_case（不含点），按 '.' 分割安全。
 */
function splitTarget(target: string): { head: string; id: string; attr: string } {
  const parts = target.split('.');
  const head = parts[0] ?? '';
  if (head === 'pop') return { head: 'pop', id: '', attr: parts[1] ?? '' };
  if (head === 'all') return { head: 'all', id: '', attr: parts[1] ?? '' }; // all.creep
  return { head, id: parts[1] ?? '', attr: parts[2] ?? '' };
}

// ---------------------------------------------------------------------------
// 阶段 1：修饰器汇总（FR-03，架构 5.8）
// ---------------------------------------------------------------------------

/** 单条携带稳定 id 的修饰器（汇总中间量，不进入状态）。 */
interface SourcedModifier {
  /** 稳定 id = `<来源>|<op>|<value>`，内容决定排序，与输入数组排列无关。 */
  id: string;
  op: ModifierOp;
  value: number;
}

/**
 * applyOpChain：把「同 target 的修饰器集合」按固定语义折叠为一个数值。
 *
 * 叠加顺序（架构 5.8：add_base → add_pct → mul → override；同类内按 id 字典序）：
 *   1) 起点 base（属性未经修饰的基础值）。
 *   2) add_base：v = v + value。
 *   3) add_pct ：v = v × (1 + value)（多个 add_pct 连乘成 (1+a)(1+b)…，而非把百分比求和）。
 *   4) mul     ：v = v × value。
 *   5) override：v = value（最后摘取；仍按 id 字典序，胜者为最后一个）。
 *
 * 确定性依据：每步为有限次 + 或 ×；同 op 桶内按稳定 id 字典序（与输入排列无关）；不含超越函数。
 *
 * @param base 属性基础值（无修饰器时返回它本身）
 * @param mods 该 target 的所有修饰器
 * @returns 叠加后的数值
 */
function applyOpChain(base: number, mods: SourcedModifier[]): number {
  if (mods.length === 0) return base;
  const byOp: Record<ModifierOp, SourcedModifier[]> = { add_base: [], add_pct: [], mul: [], override: [] };
  for (const m of mods) byOp[m.op].push(m);
  for (const op of ['add_base', 'add_pct', 'mul', 'override'] as const) {
    byOp[op].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  let v = base;
  for (const m of byOp.add_base) v = v + m.value;
  for (const m of byOp.add_pct) v = v * (1 + m.value);
  for (const m of byOp.mul) v = v * m.value;
  for (const m of byOp.override) v = m.value;
  return v;
}

/**
 * recomputeModifiers：(阶段 1) 汇总种族 / 科技 / 催化剂 / 宇宙 / 季节 / 政体的全部修饰器，
 * 按 target 路径分组并按固定顺序叠加，写回 EconomyState 的修饰器视图缓存。
 *
 * 【FR-03 修饰器】本函数只做「汇总 + 分组 + 固定顺序叠加 + 上限重算」，不改动产出本身；
 * 产出在阶段 3（settleResources）读取本函数写入的 modifierGroups 与 resources[].max。
 *
 * 修饰器来源（固定收集顺序，保证确定性）：
 *   1) 种族 modifiers（raceId 已锁定时）；
 *   2) 科技 modifiers（按 state.techs 顺序）；
 *   3) 季节 modifiers（当前季节；若种族对本季有 seasonOverrides 则整体替换，FR-10）；
 *   4) 催化剂 / 宇宙 / 政体：本 M1 层未实现，留空（后续里程碑填槽）。
 *
 * 写回：
 *   - resources[*].max = baseMax × 纪元仓储倍率，再叠加 res.<id>.max 修饰器；
 *   - modifierGroups[target] = 折叠生效值（rate / creep / growth 为乘区基准 1，creep 额外施硬下限）。
 *
 * 确定性依据：收集顺序固定、叠加顺序固定、桶内按稳定 id 字典序；只做有限 + / ×；无时钟/随机。
 *
 * @param state  经济状态
 * @param config 完整配置
 * @returns 新 EconomyState（不原地修改入参）
 */
export function recomputeModifiers(state: EconomyState, config: GameConfig): EconomyState {
  const race = state.raceId === null ? undefined : config.races.find((r) => r.id === state.raceId);

  // ── 收集所有修饰器（按 target 分桶；稳定 id = 来源|op|value，排序与输入排列无关）──
  const byTargetRaw = new Map<string, SourcedModifier[]>();
  const collect = (target: string, op: ModifierOp, value: number, srcTag: string): void => {
    const sm: SourcedModifier = { id: `${srcTag}|${op}|${value}`, op, value };
    const arr = byTargetRaw.get(target);
    if (arr) arr.push(sm);
    else byTargetRaw.set(target, [sm]);
  };

  if (race) for (const m of race.modifiers) collect(m.target, m.op, m.value, `race:${race.id}`);

  for (const techId of state.techs) {
    const tech = config.techs.find((t) => t.id === techId);
    if (tech) for (const m of tech.modifiers) collect(m.target, m.op, m.value, `tech:${tech.id}`);
  }

  // 季节：当前季节修饰器；种族 seasonOverrides 若声明该季则整体替换（FR-10）。
  const season = config.seasons[state.seasonIndex];
  if (season) {
    const override = race?.seasonOverrides[season.id];
    const mods = override !== undefined ? override : season.modifiers;
    const tag = override !== undefined ? `race-season:${race?.id ?? '?'}:${season.id}` : `season:${season.id}`;
    for (const m of mods) collect(m.target, m.op, m.value, tag);
  }
  // 催化剂 / 宇宙 / 政体：M1 层未实现，槽位留空（后续里程碑 collect）。

  // ── 深拷贝状态 ──
  const next: EconomyState = {
    currentTick: state.currentTick,
    tickMs: state.tickMs,
    subMilli: state.subMilli,
    resources: cloneResources(state.resources),
    rates: { ...state.rates },
    currentEra: state.currentEra,
    raceId: state.raceId,
    buildings: cloneBuildings(state.buildings),
    techs: [...state.techs],
    seasonIndex: state.seasonIndex,
    chainStates: cloneChainStates(state.chainStates),
    population: state.population,
    modifierGroups: {},
  };

  // ── 资源上限重算：baseMax × 纪元仓储倍率，再叠加 res.<id>.max 修饰器 ──
  const eraCfg = config.eras.find((e) => e.index === state.currentEra);
  const eraStorageMul = eraCfg ? eraCfg.storageMultiplier : 1;
  for (const res of config.resources) {
    const cur = next.resources[res.id];
    if (!cur) continue;
    const baseMax = res.baseMax * eraStorageMul;
    const mods = byTargetRaw.get(`res.${res.id}.max`);
    cur.max = mods ? applyOpChain(baseMax, mods) : baseMax;
  }

  // ── 修饰器视图缓存（rate / creep / growth 乘区基准 1；res.max 已并入 resources）──
  const groups: Record<string, number> = {};
  for (const [target, mods] of byTargetRaw) {
    const split = splitTarget(target);
    if (split.head === 'res' && split.attr === 'max') continue; // 已并入 resources[].max
    let base = 1;
    if (split.head === 'bldg' && split.attr === 'creep') {
      const b = findBuilding(config, split.id);
      base = b ? b.creepBase : 1;
    }
    let value = applyOpChain(base, mods);
    if (split.attr === 'creep') value = Math.max(CREEP_HARD_LOWER_BOUND, value); // FR-05 硬下限
    groups[target] = value;
  }
  next.modifierGroups = groups;

  return next;
}

/** modifierFactor：读修饰器视图中的乘区值，缺失回落到 1（noUncheckedIndexedAccess 安全）。 */
function modifierFactor(state: EconomyState, target: string): number {
  const g = state.modifierGroups;
  if (g === undefined) return 1;
  const v = g[target];
  return v === undefined ? 1 : v;
}

// ---------------------------------------------------------------------------
// 资源速率计算：工种/建筑产出与需求（阶段 3 与阶段 4 共用，确定性）
// ---------------------------------------------------------------------------

/** deriveJobWorkers：从建筑岗位推导每工种人数 = Σ_建筑(active × jobSlots[jobId])。 */
function deriveJobWorkers(state: EconomyState, config: GameConfig): Record<string, number> {
  const out: Record<string, number> = {};
  for (const bldg of config.buildings) {
    const b = state.buildings[bldg.id];
    if (!b || b.active <= 0 || !bldg.jobSlots) continue;
    for (const jobId of Object.keys(bldg.jobSlots)) {
      const slots = bldg.jobSlots[jobId] ?? 0;
      out[jobId] = (out[jobId] ?? 0) + slots * b.active;
    }
  }
  return out;
}

/** mapRes：按种族 resourceMap 替换资源 ID（无映射返回原值）。种族规则替换（FR-07）。 */
function mapRes(resourceMap: Record<string, string>, resId: string): string {
  const to = resourceMap[resId];
  return to === undefined ? resId : to;
}

/** resourceMapOf：取当前种族的 resourceMap（未锁定种族返回空映射）。 */
function resourceMapOf(state: EconomyState, config: GameConfig): Record<string, string> {
  if (state.raceId === null) return {};
  const race = config.races.find((r) => r.id === state.raceId);
  return race ? race.resourceMap : {};
}

/**
 * computeGrossProduction：某资源的「毛产出速率」（每秒，未扣消耗、未满仓截断）。
 *   = Σ_工种(每人产率 × job.<id>.rate 乘区 × 人数) + Σ_建筑(被动产率 × 活跃座数)。
 * 并按种族 resourceMap 把产出资源改记到映射目标（如 food→sunlight）。
 */
function computeGrossProduction(state: EconomyState, config: GameConfig, resId: string): number {
  const workers = deriveJobWorkers(state, config);
  const resourceMap = resourceMapOf(state, config);
  let p = 0;
  for (const job of config.jobs) {
    const w = workers[job.id] ?? 0;
    if (w <= 0) continue;
    const jm = modifierFactor(state, `job.${job.id}.rate`);
    for (const rid of Object.keys(job.producesPerSec)) {
      if (mapRes(resourceMap, rid) !== resId) continue;
      p += (job.producesPerSec[rid] ?? 0) * jm * w;
    }
  }
  for (const bldg of config.buildings) {
    const b = state.buildings[bldg.id];
    const active = b ? b.active : 0;
    if (active <= 0 || !bldg.passiveProducesPerSec) continue;
    for (const rid of Object.keys(bldg.passiveProducesPerSec)) {
      if (mapRes(resourceMap, rid) !== resId) continue;
      p += (bldg.passiveProducesPerSec[rid] ?? 0) * active;
    }
  }
  return p;
}

/**
 * computeDemand：某资源的「下游需求速率」（每秒）。
 *   = Σ_工种(每人消耗 × 人数) + (若该资源是种族维生资源) 人口维生消耗 upkeepPerSec × population。
 */
function computeDemand(state: EconomyState, config: GameConfig, resId: string): number {
  const workers = deriveJobWorkers(state, config);
  let d = 0;
  for (const job of config.jobs) {
    const w = workers[job.id] ?? 0;
    if (w <= 0 || !job.consumesPerSec) continue;
    const per = job.consumesPerSec[resId];
    if (per !== undefined) d += per * w;
  }
  if (state.raceId !== null) {
    const race = config.races.find((r) => r.id === state.raceId);
    if (race && race.sustenance.resId === resId) d += config.population.upkeepPerSec * state.population;
  }
  return d;
}

// ---------------------------------------------------------------------------
// 阶段 3：资源结算（FR-03/04）
// ---------------------------------------------------------------------------

/**
 * settleResources：(阶段 3) 按「修饰器后的每资源净速率」推进 amount（不满仓不归零）；
 * 满仓资源产出归零（浪费事件）；人口增长按 pop.growth 修饰器；消耗按 job.consumesPerSec。
 *
 * 【FR-03 资源结算 / FR-04 资源上限与爆仓】
 *
 * 每资源净速率（每秒）：
 *   毛产出 = Σ_工种(每人产率 × job.<id>.rate 乘区 × 人数) + Σ_建筑(被动产率 × 活跃座数)
 *   毛产出再乘 res.<id>.rate 乘区（如冬季 food 减半），再乘断链下游乘区（阶段 4 writeback，l1×0.7 等）。
 *   净速率 = 毛产出(修饰+断链+满仓截断后) − Σ_工种消耗 − 人口维生消耗。
 *
 * 满仓归零（事件点 1，FR-04 核心）：amount >= max 时正产出截断为 0，只保留负向消耗。
 * 未满仓：按净速率推进并钳制到 [0, max]（不满仓不归零）。
 * 净速率可为负：消耗 > 产出时 amount 下降并钳制到 0，不报错。
 *
 * 人口增长：population.growthPerSec × pop.growth 乘区，受 citizens 资源 max 承载上限约束；
 *   population 与 resources['citizens'].amount 同步（架构 5.7：人口按资源处理）。
 *
 * 前置：state 应已过 recomputeModifiers（阶段 1）；若未过则 modifierGroups 缺省为基态乘区 1。
 *
 * 确定性依据：遍历按 config.jobs / config.buildings / config.resources 声明顺序；只用 + − × 与 min/max。
 *
 * @param state  经济状态
 * @param dtSec  推进秒数（≥ 0）
 * @param config 完整配置
 * @returns 新 EconomyState
 */
export function settleResources(state: EconomyState, dtSec: number, config: GameConfig): EconomyState {
  const next = cloneEconomyState(state);
  const dt = dtSec < 0 ? 0 : dtSec;
  const workers = deriveJobWorkers(next, config);
  const resourceMap = resourceMapOf(next, config);

  // ── 聚合每资源毛产出与消耗 ──
  const posAcc: Record<string, number> = {};
  const negAcc: Record<string, number> = {};
  const addTo = (acc: Record<string, number>, key: string, v: number): void => {
    acc[key] = (acc[key] ?? 0) + v;
  };

  for (const job of config.jobs) {
    const w = workers[job.id] ?? 0;
    if (w <= 0) continue;
    const jm = modifierFactor(next, `job.${job.id}.rate`);
    for (const rid of Object.keys(job.producesPerSec)) {
      const perWorker = (job.producesPerSec[rid] ?? 0) * jm;
      addTo(posAcc, mapRes(resourceMap, rid), perWorker * w);
    }
    if (job.consumesPerSec) {
      for (const rid of Object.keys(job.consumesPerSec)) {
        addTo(negAcc, rid, (job.consumesPerSec[rid] ?? 0) * w);
      }
    }
  }

  for (const bldg of config.buildings) {
    const b = next.buildings[bldg.id];
    const active = b ? b.active : 0;
    if (active <= 0) continue;
    if (bldg.passiveProducesPerSec) {
      for (const rid of Object.keys(bldg.passiveProducesPerSec)) {
        addTo(posAcc, mapRes(resourceMap, rid), (bldg.passiveProducesPerSec[rid] ?? 0) * active);
      }
    }
    if (bldg.passiveConsumesPerSec) {
      for (const rid of Object.keys(bldg.passiveConsumesPerSec)) {
        addTo(negAcc, rid, (bldg.passiveConsumesPerSec[rid] ?? 0) * active);
      }
    }
  }

  // 人口维生消耗（种族维生资源 × 人口 × 每人 upkeep）。
  if (next.raceId !== null) {
    const race = config.races.find((r) => r.id === next.raceId);
    if (race && next.population > 0) {
      addTo(negAcc, race.sustenance.resId, config.population.upkeepPerSec * next.population);
    }
  }

  // ── 逐资源推进 amount（修饰 + 断链 + 满仓归零 + 钳制）──
  for (const res of config.resources) {
    const cur = next.resources[res.id];
    if (!cur) continue;
    const max = cur.max;
    const rateFactor = modifierFactor(next, `res.${res.id}.rate`);
    const chainMul = downstreamChainMultiplier(next, config, res.id);
    let posEff = (posAcc[res.id] ?? 0) * rateFactor * chainMul;
    if (cur.amount >= max) posEff = 0; // 满仓归零（事件点 1）
    const netRate = posEff - (negAcc[res.id] ?? 0);
    next.rates[res.id] = netRate;

    let amount = cur.amount + netRate * dt;
    if (amount < 0) amount = 0;
    if (amount > max) amount = max;
    cur.amount = amount;
  }

  // ── 人口增长（pop.growth 乘区）──
  {
    const popMult = modifierFactor(next, 'pop.growth');
    const capRes = next.resources['citizens'];
    const cap = capRes ? capRes.max : Number.POSITIVE_INFINITY;
    let pop = next.population + config.population.growthPerSec * popMult * dt;
    if (pop < 0) pop = 0;
    if (pop > cap) pop = cap;
    next.population = pop;
    if (capRes) capRes.amount = pop; // 人口按资源处理（架构 5.7）
  }

  return next;
}

// ---------------------------------------------------------------------------
// 建筑成本（FR-05，架构 5.6 fastPowInt）
// ---------------------------------------------------------------------------

/**
 * buildingCost：(阶段 3 · 建筑成本) 第 count+1 座的成本 = baseCost × creepBase^count。
 *
 * 【FR-05 建筑成本蠕变】
 *   - count = 0 → 首座成本 = baseCost（creep^0 = 1）；
 *   - count = 1 → 第 2 座 = baseCost × creepBase；
 *   - 幂用 fastPowInt（平方乘法，防浮点非确定，禁 Math.pow，架构 5.6）；
 *   - 成本严格递增；总成本可查（见 totalCostForCount）。
 *
 * 硬下限（FR-05：系数恒 ≥ 1.015）：本函数对 creepBase 再做一次防御性下限钳制，
 *   保证任何配置 / 修饰后 creep 恒 ≥ 1.015（10 万组修饰器属性测试的守卫）。
 *
 * 确定性依据：fastPowInt 为有限次平方乘法（单次舍入）；无超越函数；按 baseCost 键声明顺序输出。
 *
 * @param config     完整配置
 * @param buildingId 建筑 ID
 * @param count      已建座数（≥ 0 整数；返回第 count+1 座的成本）
 * @returns 资源 ID → 成本（第 count+1 座）
 */
export function buildingCost(
  config: GameConfig,
  buildingId: string,
  count: number,
): Record<string, number> {
  const bldg = findBuilding(config, buildingId);
  if (!bldg) return {};
  const safeCount = Number.isInteger(count) && count > 0 ? count : 0;
  const creep = Math.max(CREEP_HARD_LOWER_BOUND, bldg.creepBase); // 防御性硬下限
  const factor = fastPowInt(creep, safeCount);
  const out: Record<string, number> = {};
  for (const resId of Object.keys(bldg.baseCost)) {
    out[resId] = (bldg.baseCost[resId] ?? 0) * factor;
  }
  return out;
}

/**
 * totalCostForCount：从 0 座建到 count 座的总成本（Σ_{k=0}^{count-1} baseCost × creep^k）。
 * 仅用于「总成本可查」的 UI/AI，不参与主结算路径。幂用 fastPowInt。
 *
 * @param config     完整配置
 * @param buildingId 建筑 ID
 * @param count      目标座数（≥ 0 整数）
 * @returns 资源 ID → 累计成本
 */
export function totalCostForCount(
  config: GameConfig,
  buildingId: string,
  count: number,
): Record<string, number> {
  const bldg = findBuilding(config, buildingId);
  if (!bldg) return {};
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  const creep = Math.max(CREEP_HARD_LOWER_BOUND, bldg.creepBase);
  const out: Record<string, number> = {};
  for (const resId of Object.keys(bldg.baseCost)) out[resId] = 0;
  for (let k = 0; k < n; k++) {
    const f = fastPowInt(creep, k);
    for (const resId of Object.keys(bldg.baseCost)) {
      out[resId] = (out[resId] ?? 0) + (bldg.baseCost[resId] ?? 0) * f;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 阶段 4：断链状态机（FR-06，架构 5.4 / 事件点 5）
// ---------------------------------------------------------------------------

/**
 * 产业链结构（由资源依赖图推导；见 deriveChains）。
 *   - id：链 ID（= 上游资源 id，如 'food'）。
 *   - upstreamResId：决定满足率的上游资源（如 'food'）。
 *   - downstreamResIds：断链时产出受乘区影响的下游资源（如食物链断 → 'meals' 减速）。
 */
interface ChainDef {
  id: string;
  upstreamResId: string;
  downstreamResIds: string[];
}

/**
 * deriveChains：由资源依赖图推导产业链（任务：「如 food 依赖 farmer 依赖 field 建筑」）。
 *
 * 推导规则（确定性、仅读配置）：
 *   对每个「有工种产出」的资源 R：建一条链，chainId = R，upstreamResId = R；
 *   downstreamResIds = 所有「消耗 R 的工种」所产出的资源集合（如 cook 消耗 food 产 meals → meals）。
 *   本 M1 配置无 job.consumesPerSec，故 food 链仅由人口维生需求驱动（见 computeDemand）；
 *   测试可用带消耗关系的最小配置演示下游乘区。
 *
 * @param config 完整配置
 * @returns 产业链定义数组（按资源声明顺序）
 */
function deriveChains(config: GameConfig): ChainDef[] {
  const producers = new Set<string>();
  for (const job of config.jobs) {
    for (const rid of Object.keys(job.producesPerSec)) producers.add(rid);
  }
  const chains: ChainDef[] = [];
  for (const res of config.resources) {
    if (!producers.has(res.id)) continue;
    const downstream: string[] = [];
    for (const job of config.jobs) {
      if (job.consumesPerSec && job.consumesPerSec[res.id] !== undefined) {
        for (const outRes of Object.keys(job.producesPerSec)) downstream.push(outRes);
      }
    }
    chains.push({ id: res.id, upstreamResId: res.id, downstreamResIds: sortedIds(downstream) });
  }
  return chains;
}

/**
 * downstreamChainMultiplier：某资源作为「下游资源」时，取所有断链链等级乘区的最小值（最坏链决定下游）。
 *   l1→0.7、l2→0.4、l3→0.1。无链覆盖返回 1。
 */
function downstreamChainMultiplier(state: EconomyState, config: GameConfig, resId: string): number {
  let mul = 1;
  for (const chain of deriveChains(config)) {
    if (!chain.downstreamResIds.includes(resId)) continue;
    const cs = state.chainStates[chain.id];
    if (!cs) continue;
    const m = CHAIN_LEVEL_OUTPUT[cs.level];
    if (m < mul) mul = m;
  }
  return mul;
}

/**
 * computeSatisfaction：某链稳态满足率 η = P / D（架构 5.4），钳制到 [0, 1]。
 *   P = 上游毛产出（computeGrossProduction）；D = 下游需求（computeDemand，含人口维生）。
 *   D ≤ 0 视为无需求 → η = 1（不饿死）。
 */
function computeSatisfaction(state: EconomyState, config: GameConfig, chain: ChainDef): number {
  const p = Math.max(0, computeGrossProduction(state, config, chain.upstreamResId));
  const d = computeDemand(state, config, chain.upstreamResId);
  if (d <= 0) return 1;
  const eta = p / d;
  if (eta < 0) return 0;
  if (eta > 1) return 1;
  return eta;
}

/**
 * updateChainState：(阶段 4) 逐链推进断链状态机。
 *
 * 【FR-06 断链级联；架构 5.4 断链结算 / 事件点 5 断链状态跃迁】
 *
 * 对每条产业链检查稳态满足率 η：
 *   - η < starveRatio  → 欠载：timerSec += dt，清空预热；达 l1ConfirmSec→level1（l1Confirmed=true），
 *      达 l2Sec→level2，达 l3Sec→level3；
 *   - η > recoverRatio → 恢复：level 3 须先预热 warmupSec（warmupRemainingSec 递减到 0 才归 0），
 *      level 2→1（计时回落到较低区间），level 1→0（计时清零）；
 *   - 平台区 [starveRatio, recoverRatio] → 计时暂停、保持当前级别（架构 5.4）。
 *
 * 断链等级对下游产出的影响见 CHAIN_LEVEL_OUTPUT（l1×0.7、l2×0.4、l3×0.1），由 settleResources 施加。
 *
 * 确定性依据：按 deriveChains 声明顺序遍历；timer 用 + − 与 min/max；无时钟/随机；返回新 state。
 *
 * @param state  经济状态
 * @param dtSec  推进秒数（≥ 0）
 * @param config 完整配置
 * @returns 新 EconomyState（chainStates 已推进）
 */
export function updateChainState(state: EconomyState, dtSec: number, config: GameConfig): EconomyState {
  const next = cloneEconomyState(state);
  const dt = dtSec < 0 ? 0 : dtSec;
  const th = config.chain;

  for (const chain of deriveChains(config)) {
    const prev = next.chainStates[chain.id] ?? {
      level: 0 as const,
      timerSec: 0,
      warmupRemainingSec: 0,
      l1Confirmed: false,
    };
    const cs: ChainState = {
      level: prev.level,
      timerSec: prev.timerSec,
      warmupRemainingSec: prev.warmupRemainingSec,
      l1Confirmed: prev.l1Confirmed,
    };
    const eta = computeSatisfaction(next, config, chain);

    if (eta < th.starveRatio) {
      // 欠载：计时累积，清空预热（再次吃紧即打断恢复爬坡）。
      cs.timerSec += dt;
      cs.warmupRemainingSec = 0;
      let level: 0 | 1 | 2 | 3 = cs.level;
      if (cs.timerSec >= th.l1ConfirmSec && level < 1) level = 1;
      if (cs.timerSec >= th.l2Sec && level < 2) level = 2;
      if (cs.timerSec >= th.l3Sec && level < 3) level = 3;
      cs.level = level;
      if (cs.level >= 1) cs.l1Confirmed = true;
    } else if (eta > th.recoverRatio) {
      // 恢复：计时暂停/衰减；三级须先预热。
      if (cs.level >= 3) {
        if (cs.warmupRemainingSec <= 0) cs.warmupRemainingSec = th.warmupSec;
        cs.warmupRemainingSec = Math.max(0, cs.warmupRemainingSec - dt);
        if (cs.warmupRemainingSec === 0) {
          cs.level = 0;
          cs.timerSec = 0;
          cs.l1Confirmed = false;
        }
      } else if (cs.level === 2) {
        cs.level = 1;
        cs.timerSec = Math.max(th.l1ConfirmSec, Math.min(cs.timerSec, Math.max(th.l1ConfirmSec, th.l2Sec - 1e-9)));
      } else if (cs.level === 1) {
        cs.level = 0;
        cs.timerSec = 0;
        cs.l1Confirmed = false;
      } else {
        cs.timerSec = 0;
      }
    } else {
      // 平台区：计时暂停，保持级别（架构 5.4）。
    }

    next.chainStates[chain.id] = cs;
  }

  return next;
}

// ---------------------------------------------------------------------------
// 纪元门槛（FR-08）
// ---------------------------------------------------------------------------

/**
 * checkEraGate：(阶段 4 / FR-08) 检查「当前纪元门槛」是否全部满足（= 能否进入下一纪元）。
 *
 * 【FR-08 纪元演替】EraConfig.gate 语义为「进入下一纪元的硬门槛」（持于当前纪元；最后纪元为 null）：
 *   - resource 门槛：某资源 amount ≥ 要求值（人口、知识均为资源，kind=population/knowledge）；
 *   - building 门槛：某建筑已建座数 count ≥ 要求值。
 *   取 config.eras 中 index === state.currentEra 的 gate；不存在或 gate === null → canAdvance=true。
 *   引导周目：tutorialOverrides.eraGateScale[当前纪元id] 缩放「资源数量门槛」（FR-08 只缩放数量）。
 *
 * 确定性依据：按 gate 数组声明顺序遍历；数值比较；无时钟/随机。
 *
 * @param state  经济状态
 * @param config 完整配置
 * @returns { canAdvance: boolean; unmet: string[] }  unmet 为未满足门槛（确定性顺序）
 */
export function checkEraGate(
  state: EconomyState,
  config: GameConfig,
): { canAdvance: boolean; unmet: string[] } {
  const curEra = config.eras.find((e) => e.index === state.currentEra);
  if (!curEra || curEra.gate === null) return { canAdvance: true, unmet: [] };
  const scale = config.tutorialOverrides.eraGateScale[curEra.id] ?? 1;
  const unmet: string[] = [];

  for (const req of curEra.gate) {
    if (req.kind === 'resource') {
      const res = state.resources[req.resId];
      const have = res ? res.amount : 0;
      const effective = req.resId === 'citizens' ? Math.max(have, state.population) : have;
      const need = req.amount * scale;
      if (effective + 1e-9 < need) {
        unmet.push(`resource:${req.resId} need ${need} have ${effective}`);
      }
    } else {
      const b = state.buildings[req.buildingId];
      const have = b ? b.count : 0;
      if (have < req.count) {
        unmet.push(`building:${req.buildingId} need ${req.count} have ${have}`);
      }
    }
  }

  return { canAdvance: unmet.length === 0, unmet };
}

// ---------------------------------------------------------------------------
// 内部工具：深拷贝（避免原地修改入参）
// ---------------------------------------------------------------------------

function cloneResources(
  resources: Record<string, { amount: number; max: number }>,
): Record<string, { amount: number; max: number }> {
  const out: Record<string, { amount: number; max: number }> = {};
  for (const id of Object.keys(resources)) {
    const r = resources[id];
    if (r) out[id] = { amount: r.amount, max: r.max };
  }
  return out;
}

function cloneBuildings(
  buildings: Record<string, { count: number; active: number }>,
): Record<string, { count: number; active: number }> {
  const out: Record<string, { count: number; active: number }> = {};
  for (const id of Object.keys(buildings)) {
    const b = buildings[id];
    if (b) out[id] = { count: b.count, active: b.active };
  }
  return out;
}

function cloneChainStates(chainStates: Record<string, ChainState>): Record<string, ChainState> {
  const out: Record<string, ChainState> = {};
  for (const id of Object.keys(chainStates)) {
    const c = chainStates[id];
    if (c) out[id] = { level: c.level, timerSec: c.timerSec, warmupRemainingSec: c.warmupRemainingSec, l1Confirmed: c.l1Confirmed };
  }
  return out;
}

/** cloneEconomyState：整体深拷贝一个 EconomyState（不原地修改入参）。 */
function cloneEconomyState(state: EconomyState): EconomyState {
  return {
    currentTick: state.currentTick,
    tickMs: state.tickMs,
    subMilli: state.subMilli,
    resources: cloneResources(state.resources),
    rates: { ...state.rates },
    currentEra: state.currentEra,
    raceId: state.raceId,
    buildings: cloneBuildings(state.buildings),
    techs: [...state.techs],
    seasonIndex: state.seasonIndex,
    chainStates: cloneChainStates(state.chainStates),
    population: state.population,
    modifierGroups: state.modifierGroups ? { ...state.modifierGroups } : {},
  };
}
