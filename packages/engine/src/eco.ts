/**
 * M2 FR-15 生态试验田 · 右轨验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》M2 里程碑 · FR-15 生态试验田与邻接变异（Evolve 式「摆盘策略」内核）。
 * 本文件是右轨（生态/贸易）的决策密度来源：种子在 N×N 网格上的「邻接关系」决定收获时
 * 能变异出哪种催化剂——玩家必须思考怎么摆，才能最大化想要的催化剂产出。
 *
 * ── 归属与并入目标（架构 3.1 五包拓扑）────────────────────────────────────────
 *   本文件最终并入 packages/engine（@genesis/engine）。
 *   暂存包内为避免跨包依赖、并保持「纯函数 + 确定性」可单测，type 层面复用与就地投影：
 *     · w2-staging/events.ts 的 SimEvent / EventGroup（事件载体，同 shape 对齐 @genesis/engine）；
 *     · w5c-staging/economy.ts 的 GameConfig（本层只读取 eras / seeds / adjacencies 切片）；
 *     · configs/types.ts 的 SeedConfig / AdjacencyRecipe / CatalystQualityConfig。
 *   合并进 packages/engine 后：'./events.js' 换用 engine 内部 SimEvent 正式定义，配置类型改用
 *   @genesis/configs 的正式定义；测试从 '../src/eco.js' 命中本文件。
 *   TODO(engine): 并入 @genesis/engine 时，删除下方「最小可用投影」，改 import @genesis/configs。
 *
 * ── 需求与架构依据（逐函数在函数头复述）───────────────────────────────────────────
 *   【FR-15 生态试验田与邻接变异】
 *     · 试验田随纪元升级：纪元 2 为 2×2，纪元 3 为 3×3，纪元 4 为 4×4（任务口径）。
 *     · 每格种一个带元素标签的种子；作物成熟瞬间扫描上下左右 4 个相邻格，命中邻接配方时按
 *       配置概率发生变异，产出高品质催化剂。网格规模 / 种子 / 邻接配方 / 变异概率 / 品质表
 *       全部来自配置。
 *     · 试验田不产出基础资源：收获物只能是订单物（yieldOrderId）或催化剂（原则 D3）。
 *       未触发邻接变异的收获只产订单物；催化剂只由邻接变异产出（与 FR-16 一致）。
 *   【FR-16 建筑插槽与催化剂】本层只负责「产出」催化剂库存；催化剂的镶嵌 / 品质数值 / 蠕变
 *     削减（受 FR-05 1.015 硬下限）在建筑插槽结算层消费 catalysts 计数，不在本层实现。
 *   【架构 5.2 事件点 4「试验田成熟」】成熟是单一结算内核的八类事件点之一；变异在本事件点
 *     ——即「成熟被收获的那一刻」判定，不走随机检定网格（hazardIntervalSec 的 hazard 流）。
 *   【架构 5.5 随机数】eco 变异使用独立命名流（eco 流），只在作物成熟瞬间按格子索引升序抽取；
 *     本层通过「调用方传入 rng」落实——引擎不读时钟、不生随机，按确定性顺序消耗 rng。
 *   【架构 5.6 确定性】遍历顺序固定（邻接固定上→下→左→右；配方按配置声明顺序；收获按行主序
 *     升序），只用 + - * /、min、max、floor、abs；概率比较 p = rng() < rate；无时钟/随机/环境读取。
 *     本文件为纯函数库：所有导出函数输入 eco/config，返回新 eco（不原地修改入参）。
 *
 * ── 静态自检重点（见文件末「静态自检结论」）──────────────────────────────────────
 *   1) 邻接检查顺序固定：上 → 下 → 左 → 右（NEIGHBOR_OFFSETS 显式数组，绝不依赖对象键枚举）。
 *   2) 变异概率确定性：只比较 rng() < rate；多邻接命中时取「字典序最小配方」，与邻接遍历无关。
 *   3) 收获不产基础资源（D3）：yieldOrder 仅记 yieldOrderId→yieldAmount；催化剂只进 catalysts。
 */

import type { SimEvent, EventGroup } from './events.js';

// ---------------------------------------------------------------------------
// 配置类型：本暂存包的「最小可用」投影
// ---------------------------------------------------------------------------
// 说明：暂存包不能 import @genesis/configs 的完整类型（跨包依赖），故就地声明本层用到的配置切片，
// 字段与 packages/configs/src/types.ts（见 w5-staging/configs-types.ts）严格对齐；并入 engine 后
// 直接改用 @genesis/configs 的正式定义，无需本段。

/** 种子元素标签（对齐 configs.types.SeedConfig['element']：木/岩/水/火四元素）。 */
export type EcoElement = 'wood' | 'rock' | 'water' | 'fire';

/**
 * SeedConfig（configs.types.SeedConfig）：生态试验田种子。
 * 【FR-15 / D3】yieldOrderId 为订单物 ID，收获产订单物而非基础资源；matureSec / yieldAmount 占位。
 */
export interface SeedConfig {
  id: string;
  element: EcoElement;
  matureSec: number;
  yieldOrderId: string;
  yieldAmount: number;
}

/**
 * AdjacencyRecipe（configs.types.AdjacencyRecipe）：两两元素相邻时的变异规则。
 * 【口径】变异在「成熟判定」时结算，不走随机检定网格；baseMutationRate 为基础突变率（建议 25%）。
 * a / b 复用 SeedConfig 的元素取值；catalystId 为催化剂 ID。
 */
export interface AdjacencyRecipe {
  a: EcoElement;
  b: EcoElement;
  catalystId: string;
  baseMutationRate: number;
}

/**
 * CatalystQualityConfig（configs.types.CatalystQualityConfig）：催化剂品质表。
 * 【FR-16】quality 三档 normal/fine/superb；creepReduction 受 FR-05 1.015 硬下限约束（在镶嵌层消费）。
 */
export interface CatalystQualityConfig {
  catalystId: string;
  quality: 'normal' | 'fine' | 'superb';
  creepReduction: number;
}

/** 纪元配置切片（configs.types.EraConfig）：本层只读 index 与 ecoGridSize。 */
export interface EraConfigSlice {
  id: string;
  index: number;
  ecoGridSize: 0 | 2 | 3 | 4;
}

/**
 * EcoConfig：本层依赖的最小配置总表（字段与 w5c GameConfig / configs.types.GameConfig 对齐）。
 * seeds / adjacencies 设为可选并给出「缺省按空处理」，与 configs.types.GameConfig 的可选口径一致；
 * catalystQualities 本层不直接消费（品质在镶嵌层读取），保留供并入后类型完整。
 */
export interface EcoConfig {
  eras: EraConfigSlice[];
  seeds?: SeedConfig[];
  adjacencies?: AdjacencyRecipe[];
  catalystQualities?: CatalystQualityConfig[];
}

/**
 * EcoState（任务硬约束 1）：生态试验田可序列化状态。
 *   - grid：N×N 网格；每格为 null（空格）或 { seedId, plantedAtTick, totalTicks }。
 *     · seedId：种子 ID；plantedAtTick：播种时的绝对 tick；totalTicks：成熟所需 tick 数。
 *   - catalysts：催化剂库存，按 catalystId 计数。
 * 说明：只保留任务定义的三字段（不含 element 冗余缓存）；元素由 seedId 经配置查得，保证 seeds 为
 *   唯一真源（并入 engine 后可加派生缓存，但缓存不得成为第二真源）。
 */
export interface EcoCell {
  seedId: string;
  plantedAtTick: number;
  totalTicks: number;
}

export interface EcoState {
  grid: Array<Array<EcoCell | null>>;
  catalysts: Record<string, number>;
}

/** 收获结算的返回（任务硬约束 3）。 */
export interface HarvestResult {
  eco: EcoState;
  yieldOrder: Record<string, number>;
  catalystGained: string | null;
  events: SimEvent[];
}

/** checkMaturity 的单格成熟状态（任务硬约束 5）。 */
export interface MaturityInfo {
  row: number;
  col: number;
  seedId: string;
  readyToHarvest: boolean;
}

// ---------------------------------------------------------------------------
// 类型守卫与内部工具（纯函数，确定性）
// ---------------------------------------------------------------------------

/** isEcoElement：元素标签守卫（用于外部字符串的安全收窄，避免隐式 any）。 */
export function isEcoElement(x: unknown): x is EcoElement {
  return x === 'wood' || x === 'rock' || x === 'water' || x === 'fire';
}

/** findSeed：按 id 查种子配置；缺失返回 undefined（noUncheckedIndexedAccess 守卫）。 */
function findSeed(config: EcoConfig, seedId: string): SeedConfig | undefined {
  return (config.seeds ?? []).find((s) => s.id === seedId);
}

/** secToTicks：游戏秒 → 整数 tick（= round(sec*1000/tickMs)），对齐架构 5.2 secToTicks。 */
function secToTicks(sec: number, tickMs: number): number {
  const ms = sec * 1000;
  return Math.round(ms / tickMs);
}

/**
 * adjacencyMatches：判断某配方是否匹配 (myElement, neighborElement)。
 * 【口径】配方元素无序——(a,b) 与 (b,a) 视为同一配方，故双向比较。
 */
function adjacencyMatches(recipe: AdjacencyRecipe, my: EcoElement, nb: EcoElement): boolean {
  return (recipe.a === my && recipe.b === nb) || (recipe.a === nb && recipe.b === my);
}

/**
 * NEIGHBOR_OFFSETS：四邻偏移，固定顺序「上 → 下 → 左 → 右」（任务硬约束 8 的确定性来源）。
 * 显式常量数组，绝不依赖对象键枚举或外部排序——这是「邻接检查顺序固定」的唯一依据。
 */
const NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], // 上
  [1, 0],  // 下
  [0, -1], // 左
  [0, 1],  // 右
];

/** cloneGrid：深拷贝网格（不原地修改入参）。 */
function cloneGrid(grid: Array<Array<EcoCell | null>>): Array<Array<EcoCell | null>> {
  const out: Array<Array<EcoCell | null>> = [];
  for (const row of grid) {
    const r: Array<EcoCell | null> = [];
    for (const cell of row) {
      r.push(cell === null ? null : { seedId: cell.seedId, plantedAtTick: cell.plantedAtTick, totalTicks: cell.totalTicks });
    }
    out.push(r);
  }
  return out;
}

/** cloneCatalysts：深拷贝催化剂库存（不原地修改入参）。 */
function cloneCatalysts(catalysts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of Object.keys(catalysts)) {
    const v = catalysts[id];
    if (v !== undefined) out[id] = v;
  }
  return out;
}

/** cloneEco：整体深拷贝一个 EcoState（不原地修改入参）。 */
function cloneEco(eco: EcoState): EcoState {
  return { grid: cloneGrid(eco.grid), catalysts: cloneCatalysts(eco.catalysts) };
}

/**
 * assertInBounds：行列越界检查（非法坐标抛 RangeError，稳定 code，便于跨内核同一断言）。
 * 网格必须为正方形（N×N）：若行列超出网格范围即视为非法。
 */
function assertInBounds(eco: EcoState, gridRow: number, gridCol: number): void {
  const n = eco.grid.length;
  if (!Number.isInteger(gridRow) || !Number.isInteger(gridCol) || gridRow < 0 || gridCol < 0 || gridRow >= n || gridCol >= n) {
    throw new RangeError(`eco.outOfBounds: (${gridRow},${gridCol}) 超出 ${n}×${n} 网格`);
  }
}

// ---------------------------------------------------------------------------
// 1) ecoGridSize：网格推导（FR-15「网格规模来自配置」）
// ---------------------------------------------------------------------------

/**
 * ecoGridSize：从配置读纪元对应的网格大小（FR-15；对齐 EraConfig.ecoGridSize）。
 * 【FR-15】纪元 2=2×2、纪元 3=3×3、纪元 4=4×4；纪元 1 及无对应配置返回 0（试验田未开放）。
 *
 * 确定性依据：按 eras 声明顺序 find 首个 index 命中项，只读配置，无时钟/随机。
 *
 * @param config   生态配置（含 eras）
 * @param eraIndex 纪元序号（1 起）
 * @returns 0 | 2 | 3 | 4
 */
export function ecoGridSize(config: EcoConfig, eraIndex: number): 0 | 2 | 3 | 4 {
  const era = config.eras.find((e) => e.index === eraIndex);
  return era ? era.ecoGridSize : 0;
}

// ---------------------------------------------------------------------------
// 2) plantSeed：种植（FR-15「每格种植一个带元素标签的种子」）
// ---------------------------------------------------------------------------

/**
 * plantSeed：在 (gridRow, gridCol) 种下 seedId，初始化进度（FR-15）。
 * 【FR-15】空格才可种；播种需消耗少量基础资源（原则 D1），该资源扣除由 dispatch 层在调用本函数前
 *   完成——本函数只做「放置 + 初始化进度」这一纯动作（对齐架构：引擎侧不读资源，由命令层结算）。
 *
 * 行为：缺种子/坐标越界抛错；目标格已占用抛错（空格才可种，任务硬约束 2）；成功后写入
 *   { seedId, plantedAtTick: currentTick, totalTicks: secToTicks(matureSec, tickMs) }。返回新 EcoState，不修改入参。
 *
 * 必要性：totalTicks 必须在此固定（而非收获时再算），保证成熟判定 checkMaturity 纯读状态即可复现；
 *   tickMs 缺省时按生产固定 250（架构 5.1：生产 tickMs 固定 250）——仅用于把 matureSec 折算成 tick。
 *
 * @param eco        生态状态
 * @param config     生态配置
 * @param gridRow    行（0 起）
 * @param gridCol    列（0 起）
 * @param seedId     种子 ID（必须在 config.seeds 中）
 * @param currentTick 当前绝对 tick
 * @param tickMs     毫秒/tick（可选，缺省 250；仅用于 matureSec→tick 折算）
 * @returns 新 EcoState
 */
export function plantSeed(
  eco: EcoState,
  config: EcoConfig,
  gridRow: number,
  gridCol: number,
  seedId: string,
  currentTick: number,
  tickMs = 250,
): EcoState {
  const seed = findSeed(config, seedId);
  if (seed === undefined) {
    throw new Error(`eco.unknownSeed: 未找到种子配置 '${seedId}'`);
  }
  assertInBounds(eco, gridRow, gridCol);
  const rowArr = eco.grid[gridRow];
  if (rowArr === undefined) throw new RangeError(`eco.outOfBounds: 行 ${gridRow} 不存在`);
  if (rowArr[gridCol] !== null) {
    throw new Error(`eco.slotOccupied: (${gridRow},${gridCol}) 已被占用，空格才可种`);
  }

  const totalTicks = secToTicks(seed.matureSec, tickMs);
  const next = cloneEco(eco);
  const nextRow = next.grid[gridRow];
  if (nextRow === undefined) throw new RangeError(`eco.outOfBounds: 行 ${gridRow} 不存在`);
  nextRow[gridCol] = { seedId, plantedAtTick: currentTick, totalTicks };
  return next;
}

// ---------------------------------------------------------------------------
// 3) harvestSlot：收获结算 + 邻接变异（FR-15 核心 / 架构 5.2 事件点4）
// ---------------------------------------------------------------------------

/** ECO_MATURITY 事件的固定顺序组（架构 5.2：生态/内政属阶段 4，group='D'）。 */
const ECO_MATURITY_GROUP: EventGroup = 'D';

/**
 * harvestSlot：收获一格并结算产出（FR-15；架构 5.2 事件点4「试验田成熟」）。
 *
 * 结算顺序（确定性）：
 *   1) 【基础产出·D3】seedConfig.yieldAmount → yieldOrderId（订单物）；收获不产任何基础资源。
 *      未成熟（currentTick < plantedAtTick + totalTicks）时产出为 0（空 yieldOrder）。
 *   2) 【邻接变异·架构 5.2 事件点4】成熟且成功时，按「上→下→左→右」固定顺序扫描四邻种子：
 *      · 对每个邻格取邻格种子元素，与「本格元素」构成 (myElement, neighborElement)；
 *      · 在 config.adjacencies（按声明顺序）中找所有匹配配方，取「catalystId 字典序最小」的配方
 *        作为候选（多邻接同时命中时取字典序第一个配方，确定性与邻接遍历/RNG 顺序无关）；
 *      · 用传入 rng() ∈ [0,1) 判定：rng() < baseMutationRate → 变异成功，产出 catalystId。
 *      · **变异在收获那一刻判定，不走随机检定网格**。
 *   3) 收获后单元格清空、进度重置（置 null）；催化剂成功则 catalysts[catalystId] += 1。
 *   4) 产出 ECO_MATURITY 事件（kind='eco.maturity'，group='D'）。
 *
 * 确定性依据：邻接检查顺序固定（NEIGHBOR_OFFSETS）；配方候选按 catalystId 字典序取最小；
 *   rng 只被消耗一次（仅在存在候选配方时）；无时钟/随机/env 读取；返回新 eco，不改入参。
 *
 * @param eco         生态状态
 * @param config      生态配置
 * @param gridRow     行（0 起）
 * @param gridCol     列（0 起）
 * @param currentTick 当前绝对 tick
 * @param rng         随机源 ()=>number ∈ [0,1)；仅在本格存在候选配方时消耗一次
 * @returns { eco, yieldOrder, catalystGained, events }
 */
export function harvestSlot(
  eco: EcoState,
  config: EcoConfig,
  gridRow: number,
  gridCol: number,
  currentTick: number,
  rng: () => number,
): HarvestResult {
  assertInBounds(eco, gridRow, gridCol);
  const rowArr = eco.grid[gridRow];
  if (rowArr === undefined) throw new RangeError(`eco.outOfBounds: 行 ${gridRow} 不存在`);
  const cell = rowArr[gridCol];
  if (cell === null || cell === undefined) {
    throw new Error(`eco.emptySlot: (${gridRow},${gridCol}) 为空，无法收获`);
  }

  const seed = findSeed(config, cell.seedId);
  if (seed === undefined) {
    throw new Error(`eco.unknownSeed: 未找到种子配置 '${cell.seedId}'`);
  }

  const mature = cell.plantedAtTick + cell.totalTicks <= currentTick;

  const next = cloneEco(eco);
  const nextRow = next.grid[gridRow];
  if (nextRow === undefined) throw new RangeError(`eco.outOfBounds: 行 ${gridRow} 不存在`);

  const yieldOrder: Record<string, number> = {};
  let catalystGained: string | null = null;

  if (mature) {
    // 1) 基础产出 → 订单物（不产基础资源，D3）
    yieldOrder[seed.yieldOrderId] = (yieldOrder[seed.yieldOrderId] ?? 0) + seed.yieldAmount;

    // 2) 邻接变异（架构 5.2 事件点4：收获那一刻判定）
    const candidates: AdjacencyRecipe[] = [];
    const n = next.grid.length;
    for (const [dRow, dCol] of NEIGHBOR_OFFSETS) {
      const nr = gridRow + dRow;
      const nc = gridCol + dCol;
      if (nr < 0 || nc < 0 || nr >= n || nc >= n) continue; // 边界外跳过（仍是固定顺序）
      const nbRow = next.grid[nr];
      if (nbRow === undefined) continue;
      const nbCell = nbRow[nc];
      if (nbCell === null || nbCell === undefined) continue; // 空格不算邻接种子
      const nbSeed = findSeed(config, nbCell.seedId);
      if (nbSeed === undefined) continue;
      for (const recipe of config.adjacencies ?? []) {
        if (adjacencyMatches(recipe, seed.element, nbSeed.element)) candidates.push(recipe);
      }
    }

    if (candidates.length > 0) {
      // 多邻接同时匹配：取 catalystId 字典序最小的配方（确定性，取第一个配方语义）。
      let chosen = candidates[0];
      if (chosen === undefined) throw new Error('eco.noCandidate: 逻辑不可达');
      for (const c of candidates) {
        if (c.catalystId < chosen.catalystId) chosen = c;
      }
      // 概率判定：只比较 rng() < baseMutationRate（概率空间，架构 5.6），仅此处消耗一次 rng。
      if (rng() < chosen.baseMutationRate) {
        catalystGained = chosen.catalystId;
        next.catalysts[chosen.catalystId] = (next.catalysts[chosen.catalystId] ?? 0) + 1;
      }
    }
  }

  // 3) 收获后格子清空、进度重置
  nextRow[gridCol] = null;

  // 4) ECO_MATURITY 事件（slotIndex = 行主序索引；group='D'）
  const slotIndex = gridRow * next.grid.length + gridCol;
  const event: SimEvent = {
    atMilli: currentTick * 250, // 帧→毫秒的展示视图；真正权威时刻由 advance 的 simTime 折算，本字段仅事件载荷展示
    seq: 0, // 由内核在固定全序中回填；本函数只产出一个事件
    group: ECO_MATURITY_GROUP,
    kind: 'eco.maturity',
    payload: {
      slotIndex,
      row: gridRow,
      col: gridCol,
      seedId: seed.id,
      orderYield: seed.yieldOrderId,
      catalystGained,
    },
  };

  return { eco: next, yieldOrder, catalystGained, events: [event] };
}

// ---------------------------------------------------------------------------
// 4) autoReplant：自动补种（FR-48 渐进解锁的动作实现）
// ---------------------------------------------------------------------------

/**
 * autoReplant：自动补种——把网格中所有空格补种为 seedId（FR-48「自动补种」的动作实现）。
 * 【FR-48】autoReplant 是渐进解锁能力；本函数**只做动作**，是否已解锁由 dispatch 层按
 *   AutomationUnlockConfig.autoReplant 校验——本层不读解锁状态、不做权限判断。
 *
 * 语义：auto 场景下「收获后自动续种同一作物」——收获使某格清空，本函数把所有空格重新播种，
 *   从而被收获的那格恢复为 seedId（已占用格保持不动，幂等）。种子缺失抛错；行为与 plantSeed 一致
 *   （secToTicks 折算 totalTicks + plantedAtTick=currentTick）。返回新 EcoState，不修改入参。
 *
 * 确定性依据：行主序双重遍历固定顺序；secToTicks 纯算术；无时钟/随机。
 *
 * @param eco         生态状态
 * @param config      生态配置
 * @param seedId      种子 ID（必须在 config.seeds 中）
 * @param currentTick 当前绝对 tick
 * @param tickMs      毫秒/tick（可选，缺省 250；仅用于 matureSec→tick 折算）
 * @returns 新 EcoState
 */
export function autoReplant(
  eco: EcoState,
  config: EcoConfig,
  seedId: string,
  currentTick: number,
  tickMs = 250,
): EcoState {
  const seed = findSeed(config, seedId);
  if (seed === undefined) {
    throw new Error(`eco.unknownSeed: 未找到种子配置 '${seedId}'`);
  }
  const totalTicks = secToTicks(seed.matureSec, tickMs);
  const next = cloneEco(eco);
  const n = next.grid.length;
  for (let row = 0; row < n; row++) {
    const rowArr = next.grid[row];
    if (rowArr === undefined) continue;
    const cols = rowArr.length;
    for (let col = 0; col < cols; col++) {
      if (rowArr[col] === null) {
        rowArr[col] = { seedId, plantedAtTick: currentTick, totalTicks };
      }
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// 5) checkMaturity：成熟检测（FR-15 / 架构 5.2 事件点4 的求取侧）
// ---------------------------------------------------------------------------

/**
 * checkMaturity：返回所有「已种植」格子的成熟状态（FR-15；架构 5.2 事件点4 求「最近成熟格」）。
 * 【FR-15】成熟判据：plantedAtTick + totalTicks ≤ currentTick 则 readyToHarvest=true。
 * 只返回占用格（空格不参与）；顺序为行主序升序（row 外层、col 内层），确定且与配置无关。
 *
 * 确定性依据：行主序双重循环；纯比较；无时钟/随机。
 *
 * @param eco         生态状态
 * @param currentTick 当前绝对 tick
 * @returns MaturityInfo[]（行主序）
 */
export function checkMaturity(eco: EcoState, currentTick: number): MaturityInfo[] {
  const out: MaturityInfo[] = [];
  const n = eco.grid.length;
  for (let row = 0; row < n; row++) {
    const rowArr = eco.grid[row];
    if (rowArr === undefined) continue;
    const cols = rowArr.length;
    for (let col = 0; col < cols; col++) {
      const cell = rowArr[col];
      if (cell === null || cell === undefined) continue;
      const readyToHarvest = cell.plantedAtTick + cell.totalTicks <= currentTick;
      out.push({ row, col, seedId: cell.seedId, readyToHarvest });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 静态自检结论（静态推演，非运行结果；不得伪造运行结果）
// ---------------------------------------------------------------------------
// S1 邻接检查顺序固定：NEIGHBOR_OFFSETS = [上, 下, 左, 右] 常量；harvestSlot 单循环按此顺序扫描；
//    无对象键枚举、无排序，满足「上→下→左→右」。
// S2 变异概率确定性：仅 `rng() < chosen.baseMutationRate`（概率空间，架构 5.6）；候选配方按
//    catalystId 字典序取最小（与邻接命中顺序无关）；rng 只在存在候选时消耗一次，序列可复现。
// S3 收获不产基础资源（D3）：yieldOrder 只有 `[seed.yieldOrderId] = yieldAmount`（订单物）；
//    催化剂仅进 `next.catalysts`；返回值不含任何 kind!=='order' 的产出。未成熟收获 yieldOrder 为空。
// S4 纯函数：所有导出函数先 clone 再写，不修改入参 eco；无 Date/Math.random/env 读取；幂用配置读值。
// S5 类型安全（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）：所有索引访问带
//    undefined 守卫；seeds/adjacencies 可选用 `?? []` 归一，无隐式 any、无未用局部/参数。
// 说明：本段为对源码的静态推断，不代表已执行 tsc / vitest；实跑需在具备 vitest 的工程中执行。
