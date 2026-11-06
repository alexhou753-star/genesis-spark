/**
 * M2 FR-16 催化剂与插槽 · 右轨闭环验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》M2 里程碑 · FR-16 催化剂镶嵌与建筑插槽引擎（Evolve 式「取舍」内核）。
 * 本文件是右轨（生态/贸易）催化剂产出的「消费端」：eco.ts（FR-15）产出的催化剂，
 * 必须镶进建筑插槽才能削减该建筑的成本蠕变——而削减受 FR-05 的 1.015 硬下限约束，
 * 「永远不可能把蠕变降到无成本增长」。这是「边际收益递减」在建筑维度的体现：
 * 催化剂永远不够用，玩家必须选择镶到哪座建筑。
 *
 * ── 归属与并入目标（架构 3.1 五包拓扑）────────────────────────────────────────
 *   本文件最终并入 packages/engine（@genesis/engine）。
 *   暂存包内为避免跨包依赖、并保持「纯函数 + 确定性」可单测，type 层面就地投影（最小可用）：
 *     · EconomyState / GameConfig —— 字段与 w5c-staging/economy.ts 严格对齐；本层只读取
 *       buildings[].creepBase / baseCost / sockets 与常量 1.015，其余字段原样透传。
 *     · EcoState —— 字段与 m2-eco-staging/eco.ts 对齐；本层只读取 / 拷贝 catalysts: Record<string, number>。
 *     · CatalystQualityConfig{ catalystId, quality, creepReduction } —— 对齐 configs/types.ts。
 *   合并进 packages/engine 后：EconomyState / GameConfig / EcoState 改用 engine 内部正式定义，
 *   催化剂品质直接读 @genesis/configs 的 CatalystQualityConfig；届时把 state.socketStates 提升为
 *   正式 BuildingState.sockets: Array<CatalystId | null>（见 reviewed-vNext engine types）；
 *   测试从 '../src/socket.js' 命中本文件。
 *   TODO(engine): 并入 @genesis/engine 时，删除下方「最小可用投影」，改 import @genesis/configs。
 *   说明为何就地投影而不 import：w5c-staging/economy.ts 自身 import './events.js' / './math.js'，
 *   这两个文件不在 w5c-staging/ 下（分处 w2-staging / w1-staging），暂存目录内相对解析不成立；
 *   若本文件 import 之，tsc 会因传递依赖不可解析而报错。故按本工程暂存惯例就地投影，保证本文件
 *   可独立通过 strict 类型自检。
 *
 * ── 插槽状态如何随 EconomyState 传递（设计说明）─────────────────────────────────
 *   任务把六个导出（1 个状态结构 + 5 个函数）的签名固定为只接收 (state, eco, config, ...)，
 *   而插槽占用信息必须可序列化地跟随 state 流动。故本文件用 SocketState（任务硬约束 1 的结构）
 *   承载「每座建筑」的插槽，并挂在 EconomyState 的可选扩展字段：
 *     socketStates?: Record<buildingId, SocketState>
 *   该字段只在插槽层读写（economy.ts 的结算不读取它），随 state 一起被浅拷贝、可序列化，
 *   不引入任何非确定性。并入 engine 后由 BuildingState.sockets 正式数组承载，本扩展删除。
 *
 * ── 需求与架构依据（逐函数在函数头复述）───────────────────────────────────────────
 *   【FR-16 催化剂与建筑插槽】
 *     · 催化剂镶入建筑插槽后削减该建筑的成本蠕变；插槽数量来自配置（BuildingConfig.sockets）：
 *       纪元 2（M1）为 0 个，纪元 3–4 起为 1–2 个（插槽上限受噬菌体提升 FR-24，至多 3，本批不做）。
 *     · 镶嵌消耗催化剂库存（eco.catalysts 扣 1），卸下返还库存；同一建筑的多个插槽不能放同一催化剂。
 *     · 蠕变削减逐插槽按固定顺序（socket[0]→socket[n]）扣减，最终 clamp 到 ≥ 1.015。
 *   【FR-05 建筑成本蠕变与 1.015 硬下限】
 *     第 count+1 座成本 = baseCost × effectiveCreep^count；effectiveCreep 恒 ≥ 1.015，
 *     任何催化剂叠加都不能把蠕变降到无成本增长（1.0）。
 *   【架构 5.6 确定性】
 *     遍历与扣减顺序固定（socket 索引升序；品质查表按配置声明顺序）；只用 + − × /、min、max；
 *     幂用 fastPowInt（平方乘法，禁 Math.pow）；无时钟 / 随机 / 环境读取。
 *     本文件为纯函数库：所有导出函数输入 state / eco，返回新对象（不原地修改入参）。
 *
 * ── 静态自检重点（见文件末「静态自检结论」）──────────────────────────────────────
 *   1) 蠕变硬下限不被突破：effectiveCreep 结果 clamp 到 ≥ 1.015；buildingCostWithSockets 再兜底一次。
 *   2) 同建筑同催化剂去重：socketCatalyst 拒绝「同 catalystId 已在该建筑任一插槽」。
 *   3) 确定性：品质按配置声明顺序查表；扣减按 socket 索引固定顺序；幂用 fastPowInt。
 */

// ---------------------------------------------------------------------------
// 配置与状态类型：本暂存包的「最小可用」投影
// ---------------------------------------------------------------------------
// 字段与 packages/configs/src/types.ts（见 w5-staging/configs-types.ts）、w5c-staging/economy.ts、
// m2-eco-staging/eco.ts 严格对齐；并入 engine 后直接改用正式定义，无需本段。

/** 催化剂品质档（configs.types.CatalystQualityConfig['quality']：normal / fine / superb）。 */
export type CatalystQuality = 'normal' | 'fine' | 'superb';

/**
 * CatalystQualityConfig（configs.types.CatalystQualityConfig）：催化剂品质表项。
 * 【FR-16】quality 三档 normal/fine/superb；creepReduction 为该催化剂镶入后对蠕变的削减量，
 * 受 FR-05 1.015 硬下限约束（削减可叠加但最终 clamp，绝不低于 1.015）。
 */
export interface CatalystQualityConfig {
  catalystId: string;
  quality: CatalystQuality;
  creepReduction: number;
}

/**
 * BuildingConfig（configs.types.BuildingConfig 的切片）：本层只读 id / baseCost / creepBase / sockets。
 * sockets 为该建筑可镶入催化剂的插槽数（M1 纪元 2 为 0；纪元 3–4 起 1–2；上限受 FR-24 至多 3）。
 */
export interface BuildingConfig {
  id: string;
  baseCost: Record<string, number>;
  creepBase: number;
  sockets: number;
}

/**
 * GameConfig（configs.types.GameConfig / w5c GameConfig 的切片）：本层只依赖 buildings 与可选
 * catalystQualities。并入 engine 后改为完整 GameConfig。
 */
export interface GameConfig {
  buildings: BuildingConfig[];
  catalystQualities?: CatalystQualityConfig[];
}

/**
 * EconomyState（w5c-staging/economy.ts 的 EconomyState 投影）：本层只透传、不读取其结算字段；
 * 索引签名承接正式 EconomyState 的其余字段（resources / currentEra / buildings / population 等），
 * 保证正式 EconomyState 可直接传入本层。slot 占用见 SocketCarrier.socketStates。
 */
export interface EconomyState {
  /** 建筑表（本层仅透传，不读取；插槽占用见 SocketCarrier.socketStates）。 */
  buildings: Record<string, { count: number; active: number }>;
  [k: string]: unknown;
}

/**
 * EcoState（m2-eco-staging/eco.ts 的 EcoState 投影）：本层只读取 / 拷贝 catalysts 计数；
 * 索引签名承接正式 EcoState 的其余字段（grid 等），保证正式 EcoState 可直接传入本层。
 */
export interface EcoState {
  catalysts: Record<string, number>;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// SocketState（任务硬约束 1）
// ---------------------------------------------------------------------------

/**
 * SocketState：某座建筑的插槽可序列化状态（任务硬约束 1）。
 *   - buildingId：建筑 ID（对应 GameConfig.buildings[].id）。
 *   - sockets：插槽数组，长度 = 该建筑 BuildingConfig.sockets（M1 纪元 2 为 0；纪元 3–4 起 1–2）。
 *     每项 { catalystId: string | null }： 为空插槽，字符串为已镶入的催化剂 ID。
 * 说明：插槽数量由配置 BuildingConfig.sockets 决定并在 socketCatalyst / unsocketCatalyst 时校验；
 *   FR-24 噬菌体提升插槽上限（至多 3）本批不实现，届时只放开上限，不改本结构。
 */
export interface SocketState {
  buildingId: string;
  sockets: Array<{ catalystId: string | null }>;
}

/**
 * SocketCarrier：EconomyState 的插槽承载视图（本层内部与外部读占用用）。
 * socketStates: buildingId → SocketState，随 state 传递、可序列化；economy.ts 不读取该字段。
 */
export type SocketCarrier = EconomyState & {
  socketStates?: Record<string, SocketState>;
};

// ---------------------------------------------------------------------------
// 常量与内部工具（纯函数，确定性）
// ---------------------------------------------------------------------------

/**
 * CREEP_HARD_LOWER_BOUND：建筑蠕变的硬下限（FR-05：V1.0 恒 ≥ 1.015）。
 * 与 w5c-staging/economy.ts 同名常量同值；此处再声明一份，确保插槽层「自足」且不因跨包 import
 * 常量失败而失去硬下限保护（并入 engine 后统一复用 engine 常量）。
 */
export const CREEP_HARD_LOWER_BOUND = 1.015;

/**
 * fastPowInt：整数幂（平方乘法）。与 w1-staging/math.ts 的 fastPowInt 同义的本地副本——
 * 暂存包为避免跨目录 import 运行时依赖，内联同实现；只用 + − ×，每步单次正确舍入，跨内核一致
 * （架构 5.6：禁 Math.pow）。并入 engine 后改用 engine 内部 math 原语。
 *
 * @param base 底数
 * @param exp  非负整数指数
 * @returns base^exp
 */
function fastPowInt(base: number, exp: number): number {
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if ((e & 1) === 1) {
      result = result * b; // 普通乘法：整数幂下每次均为单次正确舍入，跨内核一致
    }
    e = e >>> 1; // 32 位无符号右移，逐位消耗指数
    if (e > 0) {
      b = b * b; // 迭代平方
    }
  }
  return result;
}

/** findBuilding：按 id 查建筑配置；缺失返回 undefined（noUncheckedIndexedAccess 守卫）。 */
function findBuilding(config: GameConfig, buildingId: string): BuildingConfig | undefined {
  return config.buildings.find((b) => b.id === buildingId);
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

/** makeEmptySockets：构造 n 个空插槽（catalystId 全为 null）。 */
function makeEmptySockets(n: number): Array<{ catalystId: string | null }> {
  const arr: Array<{ catalystId: string | null }> = [];
  for (let i = 0; i < n; i++) arr.push({ catalystId: null });
  return arr;
}

/** cloneSocketState：深拷贝单个 SocketState（不原地修改入参）。 */
function cloneSocketState(ss: SocketState): SocketState {
  const sockets: Array<{ catalystId: string | null }> = [];
  for (const s of ss.sockets) sockets.push({ catalystId: s.catalystId });
  return { buildingId: ss.buildingId, sockets };
}

/** cloneSocketStates：深拷贝插槽表（缺省返回空表；不原地修改入参）。 */
function cloneSocketStates(
  map: Record<string, SocketState> | undefined,
): Record<string, SocketState> {
  const out: Record<string, SocketState> = {};
  if (map === undefined) return out;
  for (const id of Object.keys(map)) {
    const ss = map[id];
    if (ss === undefined) continue;
    out[id] = cloneSocketState(ss);
  }
  return out;
}

/**
 * cloneWithSocketStates：浅拷贝 EconomyState 顶层 + 深拷贝 socketStates（不原地修改入参）。
 * 返回对象满足 EconomyState（socketStates 为其可选扩展），供本层在其上安全写入。
 */
function cloneWithSocketStates(state: EconomyState): EconomyState {
  const carrier = state as SocketCarrier;
  const cloned: SocketCarrier = { ...state };
  cloned.socketStates = cloneSocketStates(carrier.socketStates);
  return cloned;
}

/** readSockets：只读获取某建筑当前插槽数组（无则返回 socketCount 个空槽，不改动入参）。 */
function readSockets(
  state: EconomyState,
  buildingId: string,
  socketCount: number,
): Array<{ catalystId: string | null }> {
  const carrier = state as SocketCarrier;
  const ss = carrier.socketStates?.[buildingId];
  if (ss === undefined) return makeEmptySockets(socketCount);
  return ss.sockets;
}

/** writableSocketState：在（已克隆的）state 上取或建某建筑的 SocketState 并返回可写引用。 */
function writableSocketState(
  carrier: SocketCarrier,
  buildingId: string,
  socketCount: number,
): SocketState {
  if (carrier.socketStates === undefined) carrier.socketStates = {};
  const existing = carrier.socketStates[buildingId];
  if (existing !== undefined) return existing;
  const created: SocketState = { buildingId, sockets: makeEmptySockets(socketCount) };
  carrier.socketStates[buildingId] = created;
  return created;
}

// ---------------------------------------------------------------------------
// 1) socketCatalyst：镶嵌催化剂（FR-16）
// ---------------------------------------------------------------------------

/**
 * socketCatalyst：把 1 个催化剂镶入建筑插槽（FR-16；架构 5.6 纯函数）。
 *
 * 【FR-16 建筑插槽与催化剂】
 *   - 从 eco.catalysts 扣除 1 个（库存不足则拒绝）；
 *   - 插入 buildingId 建筑的 socketIndex 位置（越界则拒绝：socketIndex < 0 或 ≥ BuildingConfig.sockets）；
 *   - 同一催化剂不能重复镶入同一建筑（该建筑任一插槽已有同一 catalystId 则拒绝）；
 *   - 目标插槽已被占用（非 null）则拒绝（一个插槽只放一个催化剂）；
 *   - 返回更新后的 { state, eco }，两者均为新对象（不原地修改入参）。
 *
 * 拒绝语义（确定性、无副作用）：任一前置不满足即「原样返回」输入引用——
 *   返回 { state, eco } 均为入参本身（等价无操作），上层可用「=== 入参」判定是否被拒。
 *
 * 确定性依据：只读配置与入参；线性查找建筑与插槽；无时钟 / 随机 / 环境读取。
 *
 * @param state       经济状态（承载 socketStates；返回新对象）
 * @param eco         生态状态（催化剂库存来源；返回新对象）
 * @param config      完整配置（校验 buildingId 与插槽数）
 * @param buildingId  目标建筑 ID
 * @param socketIndex 目标插槽下标（0 起）
 * @param catalystId  要镶入的催化剂 ID
 * @returns { state, eco }（成功为新对象；拒绝为原引用）
 */
export function socketCatalyst(
  state: EconomyState,
  eco: EcoState,
  config: GameConfig,
  buildingId: string,
  socketIndex: number,
  catalystId: string,
): { state: EconomyState; eco: EcoState } {
  // 建筑必须存在（否则无从判断插槽结构）
  const bldg = findBuilding(config, buildingId);
  if (bldg === undefined) return { state, eco };

  // 插槽越界：socketIndex 必须是 [0, BuildingConfig.sockets) 内的整数
  if (!Number.isInteger(socketIndex) || socketIndex < 0 || socketIndex >= bldg.sockets) {
    return { state, eco };
  }

  // 库存不足：catalysts[catalystId] 必须 ≥ 1
  const have = eco.catalysts[catalystId] ?? 0;
  if (!(have >= 1)) return { state, eco };

  // 读取当前插槽（只读，不修改入参）
  const currentSockets = readSockets(state, buildingId, bldg.sockets);

  // 同建筑同催化剂去重：任一插槽已含同一 catalystId 则拒绝（先去重、后判空槽）
  for (const s of currentSockets) {
    if (s.catalystId === catalystId) return { state, eco };
  }

  // 目标插槽必须存在且为空
  const target = currentSockets[socketIndex];
  if (target === undefined || target.catalystId !== null) return { state, eco };

  // —— 通过全部校验，克隆并写入 ——
  const nextState = cloneWithSocketStates(state);
  const nextSocketState = writableSocketState(nextState as SocketCarrier, buildingId, bldg.sockets);
  const slot = nextSocketState.sockets[socketIndex];
  if (slot !== undefined) slot.catalystId = catalystId;

  const nextEco: EcoState = { ...eco, catalysts: cloneCatalysts(eco.catalysts) };
  const left = (nextEco.catalysts[catalystId] ?? 0) - 1;
  if (left <= 0) {
    delete nextEco.catalysts[catalystId];
  } else {
    nextEco.catalysts[catalystId] = left;
  }

  return { state: nextState, eco: nextEco };
}

// ---------------------------------------------------------------------------
// 2) unsocketCatalyst：卸下催化剂（FR-16）
// ---------------------------------------------------------------------------

/**
 * unsocketCatalyst：卸下建筑插槽中的催化剂并返还库存（FR-16；架构 5.6 纯函数）。
 *
 * 【FR-16 建筑插槽与催化剂】
 *   - 取出 buildingId 建筑 socketIndex 位置的催化剂（越界或空插槽则拒绝，原样返回）；
 *   - 返还 1 个到 eco.catalysts（库存 +1）；
 *   - 返回更新后的 { state, eco }，两者均为新对象（不原地修改入参）。
 *
 * 确定性依据：只读配置与入参；线性定位插槽；无时钟 / 随机 / 环境读取。
 *
 * @param state       经济状态（承载 socketStates；返回新对象）
 * @param eco         生态状态（催化剂库存返还目标；返回新对象）
 * @param config      完整配置（校验 buildingId 与插槽数）
 * @param buildingId  目标建筑 ID
 * @param socketIndex 目标插槽下标（0 起）
 * @returns { state, eco }（成功为新对象；拒绝为原引用）
 */
export function unsocketCatalyst(
  state: EconomyState,
  eco: EcoState,
  config: GameConfig,
  buildingId: string,
  socketIndex: number,
): { state: EconomyState; eco: EcoState } {
  const bldg = findBuilding(config, buildingId);
  if (bldg === undefined) return { state, eco };
  if (!Number.isInteger(socketIndex) || socketIndex < 0 || socketIndex >= bldg.sockets) {
    return { state, eco };
  }

  // 该建筑必须已有插槽状态，且目标插槽已镶入催化剂
  const carrier = state as SocketCarrier;
  const ss = carrier.socketStates?.[buildingId];
  if (ss === undefined) return { state, eco };
  const current = ss.sockets[socketIndex];
  if (current === undefined || current.catalystId === null) return { state, eco };
  const removed = current.catalystId;

  // —— 通过校验，克隆并写回 ——
  const nextState = cloneWithSocketStates(state);
  const nextSS = (nextState as SocketCarrier).socketStates?.[buildingId];
  if (nextSS !== undefined) {
    const slot = nextSS.sockets[socketIndex];
    if (slot !== undefined) slot.catalystId = null;
  }

  const nextEco: EcoState = { ...eco, catalysts: cloneCatalysts(eco.catalysts) };
  nextEco.catalysts[removed] = (nextEco.catalysts[removed] ?? 0) + 1;

  return { state: nextState, eco: nextEco };
}

// ---------------------------------------------------------------------------
// 3) effectiveCreep：蠕变削减结算（FR-16 / FR-05）
// ---------------------------------------------------------------------------

/** 单个已镶入催化剂的品质信息（effectiveCreep 的入参元素； 表示空插槽）。 */
export interface SocketedCatalystInfo {
  catalystId: string;
  quality: string;
  creepReduction: number;
}

/**
 * effectiveCreep：计算某建筑镶入催化剂后的有效蠕变系数（FR-16 削减 / FR-05 硬下限）。
 *
 * 【FR-16 / FR-05】
 *   - base = 该建筑 BuildingConfig.creepBase；
 *   - 对每个非空插槽，按其 catalyst 的 creepReduction 依次扣减：creep = creep − reduction；
 *     扣减顺序固定为 socket[0] → socket[n]（数组下标升序，确定性）；
 *   - 最终结果 clamp 到 ≥ 1.015（FR-05 硬下限）——催化剂再多也不能把蠕变降到无成本增长；
 *   - 无催化剂（全空或空数组）时返回 base；但 base 本身仍经 1.015 下限钳制（若配置的
 *     creepBase < 1.015，返回 1.015，与 economy.buildingCost 的防御性下限一致）。
 *
 * 确定性依据：线性遍历 socketedCatalysts（下标升序固定）；只用 + − 与比较；无超越函数。
 *
 * @param config            完整配置（读取 buildingId 的 creepBase）
 * @param buildingId        建筑 ID
 * @param socketedCatalysts 已镶入催化剂数组（元素 null 表示空插槽）
 * @returns 有效蠕变（≥ 1.015）
 */
export function effectiveCreep(
  config: GameConfig,
  buildingId: string,
  socketedCatalysts: Array<SocketedCatalystInfo | null>,
): number {
  const bldg = findBuilding(config, buildingId);
  if (bldg === undefined) return CREEP_HARD_LOWER_BOUND;

  let creep = bldg.creepBase;
  // 固定顺序：socket[0] → socket[n]
  for (const socket of socketedCatalysts) {
    if (socket === null) continue;
    const reduction = socket.creepReduction;
    if (!Number.isFinite(reduction)) continue;
    creep = creep - reduction;
  }
  // 硬下限（FR-05）：clamp 到 ≥ 1.015
  if (creep < CREEP_HARD_LOWER_BOUND) creep = CREEP_HARD_LOWER_BOUND;
  return creep;
}

// ---------------------------------------------------------------------------
// 4) buildingCostWithSockets：带插槽的建筑成本（FR-05 / FR-16）
// ---------------------------------------------------------------------------

/**
 * buildingCostWithSockets：第 count+1 座建筑成本，蠕变取「镶入催化剂后的有效蠕变」（FR-05 / FR-16）。
 *
 * 【FR-05 建筑成本蠕变 / FR-16 催化剂削减】
 *   第 count+1 座 = baseCost × effectiveCreep^count。effectiveCreep 受 1.015 硬下限保护，
 *   故即便插满催化剂，成本仍随座数单调递增（永不出现「无成本增长」）。
 *   幂用 fastPowInt（平方乘法，禁 Math.pow，架构 5.6）。
 *
 * 确定性依据：按 baseCost 键声明顺序输出；fastPowInt 有限次单次舍入；无时钟 / 随机。
 *
 * @param config            完整配置
 * @param buildingId        建筑 ID
 * @param count             已建座数（≥ 0 整数；返回第 count+1 座成本）
 * @param socketedCatalysts 已镶入催化剂数组（ 表示整座无插槽 / 无催化剂）
 * @returns 资源 ID → 成本（第 count+1 座）
 */
export function buildingCostWithSockets(
  config: GameConfig,
  buildingId: string,
  count: number,
  socketedCatalysts: Array<SocketedCatalystInfo | null> | null,
): Record<string, number> {
  const bldg = findBuilding(config, buildingId);
  if (bldg === undefined) return {};

  const safeCount = Number.isInteger(count) && count > 0 ? count : 0;
  const creep = effectiveCreep(config, buildingId, socketedCatalysts ?? []); // 已含 1.015 下限
  const factor = fastPowInt(creep, safeCount);

  const out: Record<string, number> = {};
  for (const resId of Object.keys(bldg.baseCost)) {
    out[resId] = (bldg.baseCost[resId] ?? 0) * factor;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5) lookupCatalystQuality：品质查表（FR-16）
// ---------------------------------------------------------------------------

/**
 * lookupCatalystQuality：从 catalystQualities 配置查催化剂品质（FR-16）。
 *
 * 【FR-16】按配置声明顺序 find 首个 catalystId 命中项，返回 { quality, creepReduction }；
 *   找不到返回 null（调用方据此不施加削减）。quality 为 normal / fine / superb 三档之一。
 *
 * 确定性依据：`Array.prototype.find` 按数组声明顺序，只读配置，无时钟 / 随机。
 *
 * @param config     完整配置（读取可选 catalystQualities）
 * @param catalystId 催化剂 ID
 * @returns { quality, creepReduction } | null
 */
export function lookupCatalystQuality(
  config: GameConfig,
  catalystId: string,
): { quality: string; creepReduction: number } | null {
  const table = config.catalystQualities ?? [];
  const hit = table.find((c) => c.catalystId === catalystId);
  if (hit === undefined) return null;
  return { quality: hit.quality, creepReduction: hit.creepReduction };
}

// ---------------------------------------------------------------------------
// 静态自检结论（静态推演，非运行结果；不得伪造运行结果）
// ---------------------------------------------------------------------------
// S1 蠕变硬下限不被突破：effectiveCreep 末尾 `if (creep < 1.015) creep = 1.015` 无条件封顶；
//    buildingCostWithSockets 的 creep 直接取自 effectiveCreep（已含下限）；因此任何 reduction
//    叠加（含超大 reduction / 多次叠加）最终 effectiveCreep 恒 ≥ 1.015，第 count+1 座
//    factor = 1.015^count 恒 ≥ 1（count≥1 时 > 1），绝无「无成本增长」（蠕变不会降到 1.0）。
// S2 同建筑同催化剂去重：socketCatalyst 写入前遍历「该建筑当前所有插槽」，任一含同一 catalystId
//    即原样返回；故同一建筑任意两插槽不可能放同一 catalystId（顺序：先去重、后判空槽）。
// S3 确定性：品质查表用 Array.find 按配置声明顺序；扣减按 socketedCatalysts 数组下标升序；
//    幂用 fastPowInt（禁 Math.pow）；无 Date / Math.random / env / 对象键枚举决定数值。
// S4 纯函数：socketCatalyst / unsocketCatalyst 先 cloneWithSocketStates（浅拷贝 state + 深拷贝
//    socketStates）与 cloneCatalysts（深拷贝库存）再写，不修改入参；effectiveCreep /
//    buildingCostWithSockets / lookupCatalystQuality 只读。
// S5 类型安全（strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes）：所有索引访问带
//    undefined 守卫；catalystQualities 可选、读时 `?? []` 归一；无隐式 any、无未用局部 / 参数。
// 说明：本段为对源码的静态推断，不代表已执行 tsc / vitest；实跑需在具备 vitest 的工程中执行。
