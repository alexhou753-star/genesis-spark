/**
 * FR-29 基础版 · M1 收官验收对象
 * =============================================================================
 * 文件：view.ts —— 视图投影纯函数层
 * 依据：FR-29（同屏信息架构与预警）、FR-04（资源上限）、FR-05（成本蠕变）、
 *       FR-06（断链级联与预警）、FR-10（季节与剩余时间）、架构 6.1（线程职责与
 *       消息契约：主线程与 Worker 只传「视图投影」）、架构 6.4（界面同步：Worker 以
 *       不高于 4 Hz 发 VIEW_PROJECTION，只含当前界面所需的语义化切片）、Spike S1。
 *
 * 设计边界（务必遵守）：
 *   1. 【纯函数】buildView(state, config) 只读输入、返回全新投影对象；不读时钟、不读随机、
 *      不修改入参。同状态同配置 → 逐字段相同的投影（可用 projectionSignature 比对）。
 *   2. 【只投影视图所需数据】投影不含 dispatch / appliedCommandIds / pending / seed 等
 *      引擎内部簿记，主线程拿不到、也不需要整个 GameState。
 *   3. 【预警不只靠颜色】投影用语义化的 warning / chainStatus 字段（'chain' | 'cap' |
 *      'empty' / 断链等级数字），由主线程再翻译成「⚠ 图标 + 文字」；投影层不产出 HTML 颜色。
 *   4. 【ID→展示名】M1 不引入本地化表，暂用 designName 直出（ID 占位）；并入 @genesis/web
 *      后改为本地化 key（NFR-15），投影结构不变。
 *
 * 类型可移植性：本文件用「结构化最小接口」描述输入（ViewState / ViewConfig）。正式工程里
 * 直接传入 @genesis/engine 的 GameState 与 @genesis/configs 的 GameConfig 即可——只要它们的
 * 字段覆盖本文件所需字段（本文件依赖的是更小的子集，GameState/GameConfig 结构上可赋值）。
 */

// ---------------------------------------------------------------------------
// 一、视图投影契约（严格按任务约束 2）
// ---------------------------------------------------------------------------

/** 单条资源的投影项。 */
export interface ResourceView {
  id: string;
  name: string;
  /** 当前量。 */
  amount: number;
  /** 上限（已含纪元仓储倍率与修饰器，取自 state.resources[id].max）。 */
  max: number;
  /** 每秒净变化率（正=产出，负=消耗）。 */
  netPerSec: number;
  /** 距满仓剩余秒数（净速率为正且未满时给出）；无意义时为 null。 */
  timeToFull: number | null;
  /** 距见底剩余秒数（净速率为负且未空时给出）；无意义时为 null。 */
  timeToEmpty: number | null;
  /** 预警类型：'chain' 断链关联 / 'cap' 即将满仓 / 'empty' 即将见底；无预警则缺省。 */
  warning?: 'chain' | 'cap' | 'empty';
}

/** 单张建筑卡的投影项。 */
export interface BuildingView {
  id: string;
  name: string;
  /** 已建座数。 */
  count: number;
  /** 活跃座数（active ≤ count）。 */
  active: number;
  /** 第 count+1 座（= 下一座）的成本表：资源 ID → 数量。 */
  cost: Record<string, number>;
  /** 下一座成本的人类可读摘要（如「wood 12.3 / stone 4」），便于卡片直接展示。 */
  nextCost: string;
  /** 蠕变系数（有效值，已施加 1.015 硬下限），对应 FR-05「蠕变量」。 */
  creepBase: number;
  /** 当前资源是否买得起「下一座」。 */
  canAfford: boolean;
  /** 所属产业链状态：0 正常 / 1 一级断链 / 2 二级 / 3 三级（缺省 = 无链或正常）。 */
  chainStatus?: 0 | 1 | 2 | 3;
}

/** 季节投影：当前季节 + 剩余秒数 + 下一季节（切换前 60 秒预告，FR-10）。 */
export interface SeasonView {
  id: string;
  name: string;
  secondsRemaining: number;
  nextSeason: string;
}

/** 纪元投影。 */
export interface EraView {
  index: number;
  name: string;
}

/** 科技投影。 */
export interface TechView {
  id: string;
  name: string;
  researched: boolean;
}

/** 视图投影总成：Worker → 主线程 VIEW_PROJECTION 的 viewModel 载荷。 */
export interface ViewProjection {
  resources: ResourceView[];
  buildings: BuildingView[];
  season: SeasonView;
  era: EraView;
  population: number;
  techs: TechView[];
}

// ---------------------------------------------------------------------------
// 二、视图需要的最小输入结构（结构化子集，可被引擎的 GameConfig / GameState 赋值）
// ---------------------------------------------------------------------------

/** 资源条目（视图只用 id/baseMax）。 */
export interface CfgResource {
  id: string;
  baseMax: number;
}

/** 建筑条目（视图用 id/baseCost/creepBase/eraIndex/jobSlots）。 */
export interface CfgBuilding {
  id: string;
  baseCost: Record<string, number>;
  creepBase: number;
  /** 解锁纪元（缺省按纪元 1 处理）。 */
  eraIndex?: number;
  /** 岗位表；用于把采集建筑映射到其产出的产业链。 */
  jobSlots?: Record<string, number>;
}

/** 工种条目（视图只用 id/producesPerSec 定位产业链）。 */
export interface CfgJob {
  id: string;
  producesPerSec?: Record<string, number>;
}

/** 科技条目（视图用 id）。 */
export interface CfgTech {
  id: string;
}

/** 季节条目（视图用 id/name）。 */
export interface CfgSeason {
  id: string;
  name: string;
}

/** 纪元条目（视图用 index/name）。 */
export interface CfgEra {
  index: number;
  name: string;
}

/** 视图所需的最小 GameConfig 切片。 */
export interface ViewConfig {
  clock: { tickMs: number; seasonSec: number; seasonForewarnSec?: number };
  chain: { starveRatio: number; recoverRatio: number };
  resources: CfgResource[];
  buildings: CfgBuilding[];
  /** 工种表（缺省空数组；用于建筑→产业链映射）。 */
  jobs?: CfgJob[];
  techs: CfgTech[];
  seasons: CfgSeason[];
  eras: CfgEra[];
}

/** 视图所需的最小 GameState 切片（= EconomyState 的只读字段子集）。 */
export interface ViewState {
  currentTick: number;
  tickMs: number;
  resources: Record<string, { amount: number; max: number }>;
  /** 每秒净速率（引擎在阶段 3 写入；可能缺省）。 */
  rates: Record<string, number>;
  currentEra: number;
  buildings: Record<string, { count: number; active: number }>;
  techs: string[];
  seasonIndex: number;
  chainStates: Record<string, { level: 0 | 1 | 2 | 3 }>;
  population: number;
}

// ---------------------------------------------------------------------------
// 三、常量（展示阈值；均为「视图判定」用途，不改动引擎结算）
// ---------------------------------------------------------------------------

/** 距满仓 / 见底小于此秒数即视为「即将触及边界」，资源条亮预警（FR-04 同屏预警）。 */
export const RESOURCE_EDGE_WARN_SEC = 60;
/** 断链关联资源的识别阈值：δ 秒内会被吃空即标 'chain'（与 FR-06「库存耗尽」对齐）。 */
export const CHAIN_STARVE_HORIZON_SEC = 120;
/** 断链等级达到 1 即视为「预警」（FR-06：一级为红色预警并开始计时）。 */
export const CHAIN_WARN_LEVEL = 1;
/** 内部浮点容差（与引擎 ADR-04 的 EPSILON = 1e-9 一致）。 */
const EPS = 1e-9;
/** 蠕变硬下限（FR-05：V1.0 恒 ≥ 1.015）。 */
const CREEP_FLOOR = 1.015;

// ---------------------------------------------------------------------------
// 四、内部工具（纯函数）
// ---------------------------------------------------------------------------

/** isFiniteNum：有限数守卫（noUncheckedIndexedAccess 下取到的可能是 undefined）。 */
function isFiniteNum(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * designName：ID → 展示名。M1 占位实现（ID 直出）。并入 @genesis/web 后替换为本地化 key 查表
 * （NFR-15），投影结构与调用点不变。
 */
function designName(id: string): string {
  return id;
}

/**
 * displayCreep：有效蠕变系数。与引擎 buildingCost 同口径施加 1.015 硬下限（FR-05），
 * 保证建筑卡「蠕变量」与真实结算一致（投影不改结算，只是同口径展示）。
 */
export function displayCreep(raw: number): number {
  const safe = isFiniteNum(raw) ? raw : CREEP_FLOOR;
  return safe < CREEP_FLOOR ? CREEP_FLOOR : safe;
}

/**
 * formatCost：把成本表格式化为「资源 数量」摘要（确定性顺序：按 cost 键声明顺序）。
 * 数量保留至多 1 位小数；无成本返回「—」。
 */
export function formatCost(cost: Record<string, number>): string {
  const parts: string[] = [];
  for (const resId of Object.keys(cost)) {
    const v = cost[resId];
    if (!isFiniteNum(v)) continue;
    const rounded = Math.round(v * 10) / 10;
    parts.push(`${designName(resId)} ${rounded}`);
  }
  return parts.length > 0 ? parts.join(' / ') : '—';
}

/**
 * canAffordWith：资源是否买得起一份成本（含 1e-9 容差）。与引擎 gameLoop 的 canAfford 同口径，
 * 仅用于卡片按钮可用态展示，不作为结算依据。
 */
export function canAffordWith(state: ViewState, cost: Record<string, number>): boolean {
  for (const resId of Object.keys(cost)) {
    const need = cost[resId] ?? 0;
    const have = state.resources[resId]?.amount ?? 0;
    if (have + EPS < need) return false;
  }
  return true;
}

/**
 * nextBuildingCost：第 count+1 座成本 = baseCost × creep^count（FR-05）。
 * 投影层为避免跨包依赖，用「简单循环乘」实现（count 为小整数时与 fastPowInt 结果在显示精度内一致）；
 * 并入 @genesis/web 后可直接调用引擎 buildingCost(config, id, count)（单一真源）。
 */
export function nextBuildingCost(cfg: CfgBuilding, count: number): Record<string, number> {
  const creep = displayCreep(cfg.creepBase);
  const n = Number.isInteger(count) && count > 0 ? count : 0;
  let factor = 1;
  for (let k = 0; k < n; k++) factor = factor * creep;
  const out: Record<string, number> = {};
  for (const resId of Object.keys(cfg.baseCost)) {
    out[resId] = (cfg.baseCost[resId] ?? 0) * factor;
  }
  return out;
}

/**
 * deriveChainIndex：资源 → 所属产业链等级映射（FR-06 展示投影）。
 * M1 配置无 job 消耗，链主体资源即自身；链等级取 chainStates[resId].level。纯读，确定性。
 */
function deriveChainIndex(state: ViewState, config: ViewConfig): Map<string, 0 | 1 | 2 | 3> {
  const map = new Map<string, 0 | 1 | 2 | 3>();
  for (const res of config.resources) {
    const cs = state.chainStates[res.id];
    if (cs) map.set(res.id, cs.level);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 五、资源投影
// ---------------------------------------------------------------------------

/**
 * buildResourceViews：把资源表投影为资源条数组（FR-04 五项数据 + 预警）。
 *   - netPerSec 取 state.rates[id]（阶段 3 写入的每秒净速率）；
 *   - timeToFull / timeToEmpty 由「amount、max、netPerSec」纯算术推导，不读时钟；
 *   - warning 判定优先级：断链关联 > 即将见底 > 即将满仓。
 */
function buildResourceViews(
  state: ViewState,
  config: ViewConfig,
  chainIndex: Map<string, 0 | 1 | 2 | 3>,
): ResourceView[] {
  const out: ResourceView[] = [];
  for (const res of config.resources) {
    const r = state.resources[res.id];
    const amount = r ? r.amount : 0;
    const max = r ? r.max : res.baseMax;
    const rateVal = state.rates[res.id];
    const netPerSec = isFiniteNum(rateVal) ? rateVal : 0;

    let timeToFull: number | null = null;
    let timeToEmpty: number | null = null;
    if (netPerSec > EPS) {
      const room = max - amount;
      timeToFull = room <= EPS ? 0 : room / netPerSec;
    } else if (netPerSec < -EPS) {
      timeToEmpty = amount <= EPS ? 0 : amount / -netPerSec;
    }

    let warning: ResourceView['warning'];
    const chainLevel = chainIndex.get(res.id) ?? 0;
    const willStarveSoon =
      netPerSec < -EPS && timeToEmpty !== null && timeToEmpty <= CHAIN_STARVE_HORIZON_SEC;
    if (chainLevel >= CHAIN_WARN_LEVEL || willStarveSoon) {
      warning = 'chain';
    } else if (timeToEmpty !== null && timeToEmpty <= RESOURCE_EDGE_WARN_SEC) {
      warning = 'empty';
    } else if (timeToFull !== null && timeToFull <= RESOURCE_EDGE_WARN_SEC) {
      warning = 'cap';
    }

    const item: ResourceView = {
      id: res.id,
      name: designName(res.id),
      amount,
      max,
      netPerSec,
      timeToFull,
      timeToEmpty,
    };
    if (warning !== undefined) item.warning = warning;
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 六、建筑投影
// ---------------------------------------------------------------------------

/**
 * buildBuildingViews：把建筑表投影为建筑卡数组（FR-05 成本/蠕变 + FR-06 链路状态）。
 *   - 只投影「已解锁可建」的建筑：eraIndex ≤ currentEra（未解锁不展示，避免信息噪声）；
 *   - cost = 第 count+1 座成本；nextCost 为其人读摘要；canAfford 为按钮可用态。
 */
function buildBuildingViews(state: ViewState, config: ViewConfig): BuildingView[] {
  const out: BuildingView[] = [];
  for (const bldg of config.buildings) {
    const eraIndex = isFiniteNum(bldg.eraIndex) ? bldg.eraIndex : 1;
    if (eraIndex > state.currentEra) continue;
    const b = state.buildings[bldg.id];
    const count = b ? b.count : 0;
    const active = b ? b.active : 0;
    const cost = nextBuildingCost(bldg, count);
    out.push({
      id: bldg.id,
      name: designName(bldg.id),
      count,
      active,
      cost,
      nextCost: formatCost(cost),
      creepBase: displayCreep(bldg.creepBase),
      canAfford: canAffordWith(state, cost),
    });
  }
  return out;
}

/**
 * attachBuildingChainStatus：为建筑卡补 chainStatus（FR-06：断链预警在「对应建筑」上同时出现）。
 * 映射（M1 占位、确定性）：采集建筑按 jobSlots → 工种 → 产出资源 → 产业链等级；
 * 若该链等级 ≥ CHAIN_WARN_LEVEL，建筑卡标同等级。无 jobSlots 的建筑不标。
 */
function attachBuildingChainStatus(
  buildings: BuildingView[],
  config: ViewConfig,
  chainIndex: Map<string, 0 | 1 | 2 | 3>,
): BuildingView[] {
  const jobProducer: Record<string, string[]> = {};
  for (const job of config.jobs ?? []) {
    if (!job.producesPerSec) continue;
    jobProducer[job.id] = Object.keys(job.producesPerSec);
  }

  const byId = new Map<string, CfgBuilding>();
  for (const bldg of config.buildings) byId.set(bldg.id, bldg);

  for (const view of buildings) {
    const bldg = byId.get(view.id);
    if (!bldg || !bldg.jobSlots) continue;
    let worst: 0 | 1 | 2 | 3 = 0;
    for (const jobId of Object.keys(bldg.jobSlots)) {
      for (const resId of jobProducer[jobId] ?? []) {
        const lvl = chainIndex.get(resId) ?? 0;
        if (lvl > worst) worst = lvl;
      }
    }
    if (worst >= CHAIN_WARN_LEVEL) view.chainStatus = worst;
  }
  return buildings;
}

// ---------------------------------------------------------------------------
// 七、季节 / 纪元 / 科技 / 人口投影
// ---------------------------------------------------------------------------

/**
 * buildSeasonView：投影当前季节、剩余秒数与下一季节（FR-10）。
 * 剩余秒数由「currentTick、tickMs、seasonSec」纯算术推导（与引擎 computeSeasonIndex 同口径）：
 *   ticksPerSeason = ceil(seasonSec×1000 / tickMs)；elapsed = currentTick % ticksPerSeason；
 *   secondsRemaining = (ticksPerSeason − elapsed) × tickMs / 1000。
 * 不读时钟；暂停时 currentTick 不走，剩余时间自然冻结（满足 FR-10「暂停时不走」）。
 */
export function buildSeasonView(state: ViewState, config: ViewConfig): SeasonView {
  const seasons = config.seasons;
  const n = seasons.length;
  if (n <= 0) return { id: '', name: '', secondsRemaining: 0, nextSeason: '' };

  const tickMs = state.tickMs > 0 ? state.tickMs : config.clock.tickMs;
  const seasonSec = config.clock.seasonSec;
  const ticksPerSeason = seasonSec > 0 ? Math.ceil((seasonSec * 1000) / tickMs) : 0;

  let idx = Number.isInteger(state.seasonIndex) ? state.seasonIndex : 0;
  idx = ((idx % n) + n) % n;

  let secondsRemaining = 0;
  if (ticksPerSeason > 0) {
    const elapsed = ((state.currentTick % ticksPerSeason) + ticksPerSeason) % ticksPerSeason;
    secondsRemaining = ((ticksPerSeason - elapsed) * tickMs) / 1000;
  }

  const cur = seasons[idx];
  const next = seasons[(idx + 1) % n];
  return {
    id: cur ? cur.id : '',
    name: cur ? cur.name : '',
    secondsRemaining,
    nextSeason: next ? next.name : '',
  };
}

/** buildEraView：投影当前纪元（index + name）。 */
export function buildEraView(state: ViewState, config: ViewConfig): EraView {
  const era = config.eras.find((e) => e.index === state.currentEra);
  return { index: state.currentEra, name: era ? era.name : String(state.currentEra) };
}

/** buildTechViews：投影全部科技（按配置声明顺序）+ 是否已研究。 */
export function buildTechViews(state: ViewState, config: ViewConfig): TechView[] {
  const researched = new Set(state.techs);
  return config.techs.map((t) => ({
    id: t.id,
    name: designName(t.id),
    researched: researched.has(t.id),
  }));
}

// ---------------------------------------------------------------------------
// 八、总入口：buildView（纯函数投影）
// ---------------------------------------------------------------------------

/**
 * buildView：GameState + GameConfig → ViewProjection。
 *
 * 【FR-29 / 架构 6.1 / 架构 6.4 / Spike S1】
 *   - 输入只读，输出全新对象，不共享引用、不修改入参；
 *   - 不含任何引擎簿记（dispatch / seed / pending 等），主线程只拿到展示所需切片；
 *   - 确定性：同 state + 同 config → 逐字段相同投影（不读时钟/随机/环境）。
 */
export function buildView(state: ViewState, config: ViewConfig): ViewProjection {
  const chainIndex = deriveChainIndex(state, config);
  const resources = buildResourceViews(state, config, chainIndex);
  const buildings = attachBuildingChainStatus(buildBuildingViews(state, config), config, chainIndex);
  const season = buildSeasonView(state, config);
  const era = buildEraView(state, config);
  const techs = buildTechViews(state, config);
  return {
    resources,
    buildings,
    season,
    era,
    population: isFiniteNum(state.population) ? state.population : 0,
    techs,
  };
}

// ---------------------------------------------------------------------------
// 九、投影确定性自检辅助（纯函数；供 host / 自检脚本复用，不进运行热路径）
// ---------------------------------------------------------------------------

/**
 * projectionSignature：把投影序列化为「稳定字符串」，供确定性自检比较两份投影是否逐字段相等。
 * 仅用于静态自检 / 单测；不是运行期状态哈希。确定性：按数组声明顺序拼接。
 */
export function projectionSignature(view: ViewProjection): string {
  const res = view.resources
    .map(
      (r) =>
        `${r.id}:${r.amount.toFixed(6)}/${r.max.toFixed(6)}@${r.netPerSec.toFixed(6)}` +
        `${r.warning ? '!' + r.warning : ''}`,
    )
    .join(',');
  const bld = view.buildings
    .map((b) => `${b.id}#${b.count}:${b.nextCost}:${b.creepBase.toFixed(6)}:${b.canAfford}`)
    .join(',');
  return (
    `R[${res}]|B[${bld}]|S{${view.season.id}/${view.season.secondsRemaining.toFixed(3)}>` +
    `${view.season.nextSeason}}|E{${view.era.index}/${view.era.name}}|P{${view.population.toFixed(6)}}` +
    `|T[${view.techs.map((t) => `${t.id}:${t.researched}`).join(',')}]`
  );
}
