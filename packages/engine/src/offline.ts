/**
 * M2 FR-20 离线结算 · Gate 3 验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》M2 首批：把「玩家离线 N 小时后回来」的补算做成引擎侧唯一入口，
 * 用 gameTick 循环批量推进一次性补齐，结果与在线逐步推进一致——这是 Gate 3「在线与离线
 * 一致性」的核心验收对象。本文件只负责「补算 + 报告 + 一致性核验」，不引入任何新结算公式：
 * 所有物理量仍由 w5d-staging/gameLoop.ts 的单一结算内核 gameTick 产出。
 *
 * ── 本文件在五包/暂存拓扑中的位置（架构 3.1 / 5.1 / 5.2 单一结算内核）───────────
 *   前序暂存包（同级相对 import，最终并入 packages/engine）：
 *     · w5d-staging/gameLoop.ts → GameState / GameConfig / GameCommand / SimEvent /
 *       gameTick / runGame / createInitialGameState / advanceEra
 *     · w2-staging/advance.ts   → SegmentBudget / SimResult（事件跳段内核，事件跳跃的实现载体）
 *   最终并入 packages/engine 后，'./gameLoop.js' 改为 engine 内部模块，'../src/offline.js'
 *   由测试命中本文件。本文件即 engine 的「离线结算」子模块。
 *
 * ── 与 PRD FR-20 / 架构 5.3 / Gate 3 的逐条对应（设计依据）────────────────────
 *   FR-20 需求：离线最多结算 24 小时（86,400 游戏秒），只结算离线前已激活的策略与队列；
 *     算法采用「季节切片 + 事件跳跃」；一致性回归对 200 个典型存档离线 24 小时结果与
 *     250 ms 逐步模拟相比，资源量/建筑数/收获数/断链时长偏差均 ≤ 1%；没有激活策略时不产生
 *     保底收益；离线报告列出收益、建造清单、收获、爆仓浪费、断链事件。
 *   架构 5.3（在线、后台与离线补算）：
 *     · 调用方把真实时间差换算为 elapsedTicks（毫秒除以 tickMs 取整，余数毫秒留给下一次），
 *       再调用同一个 advance —— 在线/后台/离线共用同一入口，区别只在每次推进多少 tick。
 *     · 24 小时上限在补算入口强制，超出部分不结算并明确告知（本暂存包：24h 截断由【宿主】
 *       负责，引擎只看传入的 offlineMs；见函数头与下注「诚实边界」）。
 *     · 系统时钟回拨（时间差为负）记为 0、不扣库存（引擎侧：offlineMs<0 视作 0）。
 *     · 单次补算最大段数 MAX_SEGMENTS 达上限时不得静默截断，须返回「未完成」并可续算。
 *     · 暂停（pausedTime）不计入补算（FR-10 季节计时「暂停时不走」的同口径）。
 *   Gate 3（在线与离线一致性）：
 *     比较「一次性 advance(totalTicks)」与「逐 tick advance(1)」——资源量、建筑数、断链时长
 *     偏差 ≤ 1%，并校验段数未异常退化；24 小时上限用例：输入 30 小时，只结算 24 小时。
 *
 * ── 确定性约束（架构 5.6 / 5.8，务必遵守）──────────────────────────────────────
 *   · 本文件不读时钟、不用随机、不读环境；只做整数 tick 循环与纯数值比较。
 *   · 只用 + - * /、min、max、floor、abs；哈希只用整数位运算（Math.imul），不用超越函数。
 *   · 所有导出函数为纯函数：输入 state、返回新 state（不原地修改入参；gameTick 本身纯函数）。
 *   · 遍历一律固定顺序：资源按 Object.keys 的稳定插入顺序（与 createInitialGameState 一致），
 *     事件排序用全序比较器（atMilli→组→seq，数值相等时以 tie-break 决胜）。
 */

import { gameTick, type GameState, type GameConfig } from './gameLoop.js';
import type { SimEvent } from './advance.js';

// 统一从本模块再导出：类型 + 测试/上层常用构造器，便于从 './offline.js' 单点引入。
//   - GameState / GameConfig / SimEvent：本地已 import，直接再导出（无重复导出）。
//   - GameCommand：从 gameLoop 再导出（本文件未本地使用）。
//   - SegmentBudget / SimResult：从 advance 再导出（w2 事件跳段内核的形状，供上层复用）。
//   - createInitialGameState / enqueueCommand：gameLoop 的构造/入队工具，供宿主与测试复用。
export type { GameState, GameConfig };
export type { SimEvent };
export type { GameCommand } from './gameLoop.js';
export type { SegmentBudget, SimResult } from './advance.js';
export { createInitialGameState, enqueueCommand } from './gameLoop.js';

// ---------------------------------------------------------------------------
// 类型定义：离线报告（FR-20「离线报告要告知玩家」的引擎侧数据契约）
// ---------------------------------------------------------------------------

/**
 * OfflineReportSummary：离线收益摘要的「可展示指标」。
 *   - resourcesGained：各资源 net 变化量（终态 − 初态；正为净赚、负为净耗）。
 *   - buildingsBuilt：离线期间新建建筑总数（终态 count 之和 − 初态 count 之和）。
 *   - chainIncidents：断链跃迁事件总数（chain.transition 计数，FR-06 / 架构 5.4）。
 *   - eraAdvanced：离线期间是否发生了纪元推进（era.advance 事件）。
 *   - seasonChanges：季节切换次数（season.change 计数，FR-10）。
 */
export interface OfflineReportSummary {
  resourcesGained: Record<string, number>;
  buildingsBuilt: number;
  chainIncidents: number;
  eraAdvanced: boolean;
  seasonChanges: number;
}

/**
 * OfflineReport：玩家回来后看到的「你不在的时候发生了什么」。
 *
 * 【FR-20 验收：离线报告列出收益、建造清单、收获、爆仓浪费、断链事件；架构 5.3 报告语义】
 *   - offlineMs：本次补算的墙钟差（毫秒，宿主传入，引擎不读时钟）。
 *   - gameSecondsAdvanced：实际推进的游戏秒（= ticksRun × tickMs / 1000），供玩家直观理解。
 *   - ticksRun：实际运行的 gameTick 次数（= 推进的整 tick 数）。
 *   - eventsCount：本次补算产出的全部离散事件数。
 *   - summary：收益摘要（见 OfflineReportSummary）。
 *   - topEvents：最重要的前 10 个事件（按 atMilli 升序；纪元推进/断链跃迁/满仓 优先）。
 */
export interface OfflineReport {
  offlineMs: number;
  gameSecondsAdvanced: number;
  ticksRun: number;
  eventsCount: number;
  summary: OfflineReportSummary;
  topEvents: SimEvent[];
}

// ---------------------------------------------------------------------------
// 内部常量：事件优先级与报告排序（确定性）
// ---------------------------------------------------------------------------

/** 报告 topEvents 上限（任务约束 2）。 */
const TOP_EVENTS_LIMIT = 10;

/**
 * eventImportance：给事件一个「重要性等级」，数字越大越重要（0 最低）。
 * 规则（任务约束 2：纪元推进 / 断链 / 满仓 优先）：
 *   3 = 纪元推进（era.advance）或断链跃迁（chain.transition）
 *   2 = 满仓（resource.cap）
 *   1 = 资源耗尽（resource.empty）/ 纪元门槛满足 / 季节切换
 *   0 = 其它（含建造/研究/调岗等 command.* 事件）
 * 纯函数，只读事件字段，无随机。
 */
function eventImportance(kind: string): number {
  if (kind === 'era.advance' || kind === 'chain.transition') return 3;
  if (kind === 'resource.cap') return 2;
  if (kind === 'resource.empty' || kind === 'era.gate_ready' || kind === 'season.change') return 1;
  return 0;
}

/**
 * selectTopEvents：挑选最重要的前 N（默认 10）个事件。
 *
 * 排序策略（确定性、全序）：
 *   1) 先按重要性等级降序（重要者优先保留）；
 *   2) 同级按 atMilli 升序（先发生者在前，报告时间线顺序）；
 *   3) 再按 seq 升序（同一时刻的稳定次序）；
 *   4) 仍相等则用「原始下标」决胜（保证全序，绝不出现不稳定排序）。
 * 取前 N 后，再按 atMilli 升序（同级按 seq）重排返回，使 topEvents 呈「时间线」顺序展示。
 */
function selectTopEvents(events: SimEvent[], limit: number): SimEvent[] {
  const indexed = events.map((e, idx) => ({ e, idx }));
  indexed.sort((a, b) => {
    const ia = eventImportance(a.e.kind);
    const ib = eventImportance(b.e.kind);
    if (ia !== ib) return ib - ia; // 重要性降序
    if (a.e.atMilli !== b.e.atMilli) return a.e.atMilli - b.e.atMilli;
    if (a.e.seq !== b.e.seq) return a.e.seq - b.e.seq;
    return a.idx - b.idx; // 全序决胜
  });
  const top = indexed.slice(0, Math.max(0, limit)).map((x) => x.e);
  // 展示顺序：时间线（atMilli 升序，同级 seq 升序）。
  top.sort((a, b) => {
    if (a.atMilli !== b.atMilli) return a.atMilli - b.atMilli;
    return a.seq - b.seq;
  });
  return top;
}

// ---------------------------------------------------------------------------
// 内部：事件统计与摘要（纯函数，确定性）
// ---------------------------------------------------------------------------

/** sumBuildingCount：建筑总座数（count 之和，按 Object.keys 稳定顺序累加）。 */
function sumBuildingCount(state: GameState): number {
  let total = 0;
  for (const id of Object.keys(state.buildings)) {
    total += state.buildings[id]?.count ?? 0;
  }
  return total;
}

/**
 * finalizeReport：依据初/终态与累计事件生成 OfflineReport。
 *   - resourcesGained：遍历终态全部资源，amount 终 − 初；初态缺失视作 0。
 *     注：这里以终态资源集合为准（纪元推进可能新增资源键），保证「新增资源」也计入净变化。
 *   - buildingsBuilt：终态 count 之和 − 初态 count 之和（离线期间净增座数）。
 *   - chainIncidents：统计 kind==='chain.transition' 的事件数。
 *   - eraAdvanced：是否存在 kind==='era.advance' 的事件。
 *   - seasonChanges：统计 kind==='season.change' 的事件数。
 * 纯函数：不修改入参，只读。
 */
function finalizeReport(
  initialState: GameState,
  finalState: GameState,
  events: SimEvent[],
  offlineMs: number,
  ticksRun: number,
): OfflineReport {
  // 资源净变化（终态为基准，初态缺失当 0）。
  const resourcesGained: Record<string, number> = {};
  for (const id of Object.keys(finalState.resources)) {
    const after = finalState.resources[id]?.amount ?? 0;
    const before = initialState.resources[id]?.amount ?? 0;
    resourcesGained[id] = after - before;
  }

  // 事件统计（单遍扫描）。
  let chainIncidents = 0;
  let seasonChanges = 0;
  let eraAdvanced = false;
  for (const e of events) {
    if (e.kind === 'chain.transition') chainIncidents++;
    else if (e.kind === 'season.change') seasonChanges++;
    else if (e.kind === 'era.advance') eraAdvanced = true;
  }

  const buildingsBuilt = sumBuildingCount(finalState) - sumBuildingCount(initialState);
  const gameSecondsAdvanced = (ticksRun * finalState.tickMs) / 1000;

  return {
    offlineMs,
    gameSecondsAdvanced,
    ticksRun,
    eventsCount: events.length,
    summary: {
      resourcesGained,
      buildingsBuilt,
      chainIncidents,
      eraAdvanced,
      seasonChanges,
    },
    topEvents: selectTopEvents(events, TOP_EVENTS_LIMIT),
  };
}

// ---------------------------------------------------------------------------
// 内部：offlineMs → tick 预算（架构 5.3「毫秒除以 tickMs，余数留给下一次」）
// ---------------------------------------------------------------------------

/**
 * ticksFromOfflineMs：把墙钟毫秒差换算为完整 tick 数（向下取整）。
 *   ticks = floor(offlineMs / tickMs)；余数毫秒（offlineMs − ticks×tickMs）不结算、留给下一次。
 * 这正是架构 5.3「毫秒除以 tickMs 取整，余数毫秒留给下一次」的实现。
 * 负值 / 非法 / 0 → 0（对应架构 5.3 系统时钟回拨记 0，不扣库存）。
 */
function ticksFromOfflineMs(offlineMs: number, tickMs: number): number {
  if (!Number.isFinite(offlineMs) || offlineMs <= 0) return 0;
  if (!(tickMs > 0) || !Number.isFinite(tickMs)) return 0;
  return Math.floor(offlineMs / tickMs);
}

/**
 * maxSegmentsFromSlice：把 maxSegmentsPerSlice 归一为非负整数段数上限（<1 或非法 → 1）。
 * 对应架构 5.3「单次补算最大段数 MAX_SEGMENTS」：达到上限即停止并返回未完成，待宿主续算。
 */
function maxSegmentsFromSlice(maxSegmentsPerSlice: number): number {
  if (!Number.isFinite(maxSegmentsPerSlice) || maxSegmentsPerSlice < 1) return 1;
  return Math.floor(maxSegmentsPerSlice);
}

// ---------------------------------------------------------------------------
// 主入口：settleOffline（FR-20 离线补算唯一入口 / 架构 5.3）
// ---------------------------------------------------------------------------

/**
 * settleOffline：离线补算的唯一入口。
 *
 * 【FR-20 离线结算；架构 5.3 在线·后台·离线共用同一补算入口；Gate 3 一致性】
 *
 * 设计契约（严格遵循任务约束 1）：
 *   · offlineMs 是墙钟差（毫秒），引擎不读时钟、由宿主算好传入（架构 5.1「引擎不读系统时钟」）；
 *   · 内部用 gameTick 循环推进（每 tick 走完整四阶段），保证在线离线同一内核（架构 5.2 单一结算内核）；
 *   · maxSegmentsPerSlice 防卡死：达到上限则 completed=false，宿主可分片继续（不发布近似结果，
 *     对应架构 5.3「达到 MAX_SEGMENTS 仍有余量时不静默截断」）；
 *   · 24 小时截断由宿主负责，不进引擎（宿主先把 offlineMs 截到 ≤86,400,000 ms 再传入本函数）；
 *   · 返回 OfflineReport 供前端展示（FR-20「离线报告告知玩家」）。
 *
 * 语义要点：
 *   1) 段预算 = floor(offlineMs / tickMs)（余数毫秒留给下一次）。
 *   2) 段数上限 = maxSegmentsPerSlice。实际推进段数 = min(段预算, 段数上限)。
 *      completed =（实际推进段数 === 段预算）。未完成时不发布近似结果，只把已推进状态 + 报告返回，
 *      宿主可把剩余 offlineMs（= 剩余 tick × tickMs + 原余数）再传入续算。
 *   3) offlineMs ≤ 0（含时钟回拨负差）→ 不推进、不改状态、报告为空（empty 报告）。
 *   4) Bot 策略在离线期间不激活：本函数只调用 gameTick（纯内核循环），从不调用 bot.decide；
 *      只有 state.dispatch.pending 里已排队的命令会在各 tick 开头被 flush 执行（确定性）。
 *   5) 无激活策略不产保底：本函数不注入任何额外产出/资源/建筑；没有内政规则、没有排程队列时，
 *      离线期间只有基础资源产出（= gameTick 阶段 2 的 settleResources 自然产出）。
 *
 * 确定性：同一 initialState + config + offlineMs（+ 同一 maxSegmentsPerSlice）→ 同一终态与报告。
 *   逐 tick 串行调用纯函数 gameTick；事件按 tick 顺序累加；报告只由初/终态与事件确定性派生。
 *
 * @param state               离线前状态（不被修改）
 * @param config              完整配置
 * @param offlineMs           离线墙钟差（毫秒；24h 截断由宿主完成）
 * @param maxSegmentsPerSlice 单次补算段数上限（防卡死；达到即 completed=false）
 * @returns { state, events, report, completed }
 */
export function settleOffline(
  state: GameState,
  config: GameConfig,
  offlineMs: number,
  maxSegmentsPerSlice: number,
): { state: GameState; events: SimEvent[]; report: OfflineReport; completed: boolean } {
  const tickMs = state.tickMs;
  const totalTicks = ticksFromOfflineMs(offlineMs, tickMs);
  const segCap = maxSegmentsFromSlice(maxSegmentsPerSlice);
  const ticksToRun = Math.min(totalTicks, segCap);

  // 空离线（offlineMs≤0 或不足一个 tick）：状态不变、报告为空。
  if (ticksToRun <= 0) {
    return {
      state,
      events: [],
      report: finalizeReport(state, state, [], offlineMs, 0),
      completed: totalTicks === 0,
    };
  }

  // 逐 tick 串行推进（每 tick 走完整四阶段；同一内核 = gameTick）。
  let cur = state;
  const events: SimEvent[] = [];
  for (let i = 0; i < ticksToRun; i++) {
    const r = gameTick(cur, config);
    cur = r.state;
    for (const e of r.events) events.push(e);
  }

  const completed = ticksToRun === totalTicks; // 段数上限是否够用
  const report = finalizeReport(state, cur, events, offlineMs, ticksToRun);
  return { state: cur, events, report, completed };
}

// ---------------------------------------------------------------------------
// 状态哈希（Gate 3 / FR-31 规范状态哈希的「引擎侧最小实现」）
// ---------------------------------------------------------------------------

/**
 * hashState：生成 GameState 的稳定哈希字符串（跨调用确定性，用于在线/离线终态比对）。
 *
 * 【Gate 3 一致性校验；架构 5.6 确定性契约；FR-31 规范状态哈希精神】
 *   本暂存包不依赖 SHA-256 运行时，用「确定性 32 位整数折叠」实现稳定指纹：
 *     1) 序列化：把状态按固定字段顺序拼成 canonical 字符串（对象键一律排序，避免枚举顺序差异）；
 *     2) 折叠：对字符串逐字符做 FNV-1a 变体（h ^= c; h = imul(h, 16777619)），全程整数位运算；
 *     3) 输出：8 位十六进制（4 字节）。
 *   包含：currentTick / tickMs / subMilli / 各资源 amount&max / currentEra / raceId / 建筑 /
 *         techs / seasonIndex / chainStates / population / jobAssignments / seed。
 *   排除：dispatch.appliedCommandIds / pending / lastAppliedCmdSeq —— 与 FR-31「规范状态哈希排除
 *         元数据」一致（命令簿记不进入物理观测量）。seed 是命名流真源，纳入。
 *
 * 确定性：整数位运算 + 固定键排序，无浮点超越函数、无随机、无时钟；同一状态 → 同一哈希。
 */
export function hashState(state: GameState): string {
  const parts: string[] = [];

  // ── 标量字段（固定顺序）──
  parts.push(`tick=${state.currentTick}`);
  parts.push(`tickMs=${state.tickMs}`);
  parts.push(`sub=${num(state.subMilli)}`);
  parts.push(`era=${state.currentEra}`);
  parts.push(`race=${state.raceId === null ? '' : state.raceId}`);
  parts.push(`season=${state.seasonIndex}`);
  parts.push(`pop=${num(state.population)}`);
  parts.push(`seed=${state.seed}`);

  // ── 资源（键排序，稳定）──
  for (const id of Object.keys(state.resources).sort()) {
    const r = state.resources[id];
    if (!r) continue;
    parts.push(`res.${id}=${num(r.amount)}/${num(r.max)}`);
  }

  // ── 速率（键排序；rates 由阶段计算得出，纳入以更严格）──
  for (const id of Object.keys(state.rates).sort()) {
    parts.push(`rate.${id}=${num(state.rates[id] ?? 0)}`);
  }

  // ── 建筑（键排序；count 与 active）──
  for (const id of Object.keys(state.buildings).sort()) {
    const b = state.buildings[id];
    if (!b) continue;
    parts.push(`bldg.${id}=${b.count}/${b.active}`);
  }

  // ── 科技（保持声明顺序，已排序后拼接以消除插入顺序影响）──
  parts.push(`techs=${[...state.techs].sort().join(',')}`);

  // ── 断链状态（键排序；level/timer/warmup/l1）──
  for (const id of Object.keys(state.chainStates).sort()) {
    const c = state.chainStates[id];
    if (!c) continue;
    parts.push(`chain.${id}=${c.level}/${num(c.timerSec)}/${num(c.warmupRemainingSec)}/${c.l1Confirmed ? 1 : 0}`);
  }

  // ── 工种分配（键排序）──
  for (const id of Object.keys(state.jobAssignments).sort()) {
    parts.push(`job.${id}=${state.jobAssignments[id] ?? 0}`);
  }

  const canonical = parts.join('|');
  // FNV-1a 32 位（整数位运算，确定性）。
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 转无符号并补零到 8 位十六进制。
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** num：把数值稳定格式化为字符串（避免 -0 与浮点尾差的显示噪声，便于哈希跨调用一致）。 */
function num(x: number): string {
  if (Object.is(x, -0)) return '0';
  return String(x);
}

// ---------------------------------------------------------------------------
// 一致性验证：verifyOfflineConsistency（FR-20 / Gate 3）
// ---------------------------------------------------------------------------

/**
 * resourceDeltaPct：计算两终态各资源的偏差百分比（Gate 3 ≤ 1% 判定用）。
 *   对每个资源 id 取 reference（online）与 candidate（offline），
 *   pct = |offline − online| / max(1, |online|) × 100。
 *   用 max(1, |online|) 作分母，避免初值接近 0 时出现虚假的巨大百分比（对「极小基数」做保护，
 *   与 Gate 3「偏差 ≤1%」的工程口径一致：小于 1 的绝对差对小量资源不敏感）。
 *   返回 { perRes, maxPct }。
 */
function resourceDeltaPct(
  online: GameState,
  offline: GameState,
): { perRes: Record<string, number>; maxPct: number; delta: Record<string, number> } {
  const perRes: Record<string, number> = {};
  const delta: Record<string, number> = {};
  let maxPct = 0;
  // 以两态资源键的并集为准（固定排序，确定性）。
  const ids = Array.from(
    new Set<string>([...Object.keys(online.resources), ...Object.keys(offline.resources)]),
  ).sort();
  for (const id of ids) {
    const a = online.resources[id]?.amount ?? 0;
    const b = offline.resources[id]?.amount ?? 0;
    const d = b - a;
    delta[id] = d;
    const denom = Math.max(1, Math.abs(a));
    const pct = (Math.abs(d) / denom) * 100;
    perRes[id] = pct;
    if (pct > maxPct) maxPct = pct;
  }
  return { perRes, maxPct, delta };
}

/**
 * verifyOfflineConsistency：验证「一次大步补算 == 分块多次补算」（FR-20 / Gate 3 核心）。
 *
 * 【FR-20 一致性回归；Gate 3 在线与离线一致性；架构 5.2 单一结算内核 / 5.3 同入口】
 *
 * 做法：
 *   · offlineHash：一次性大步补算 —— 用 settleOffline（单段，段数上限设为足够大）在
 *     chunkSize 个 tick 的总预算上一次推进完（= 一次 advance(totalTicks)）。
 *   · onlineHash：分块多次补算 —— 把总 tick 数拆成每 chunkTicks 个一块，逐块调用 settleOffline
 *     （等价于「在线逐块 / 逐步推进」），把每块终态作为下一块初态，累积全部事件。
 *     注：本暂存包内 settleOffline 与 online 用的是同一内核 gameTick；这里比较的是「一次跑完
 *     全部 tick」与「分 chunkSize 多块跑完」两条路径，验证两者终态逐位一致（hash 相同）且
 *     各资源偏差 ≤ 1%——即「分块不改变结果」（组合律的离线版）。
 *   · 比较：hashState(online) vs hashState(offline)，以及各资源偏差百分比 maxDeviationPct。
 *   · consistent =（maxDeviationPct ≤ 1%）。（在线/离线同为确定性内核，正常应逐位一致，hash 相同。）
 *
 * 参数：
 *   - initialState：离线前状态（不被修改）。
 *   - config：完整配置。
 *   - offlineMs：离线墙钟差（毫秒）；总 tick = floor(offlineMs / tickMs)。
 *   - chunkSize：在线分块的每块 tick 数（>0；<1 或非法按 1 处理，即逐 tick 推进）。
 *
 * 返回详细对比数据：{ consistent, onlineHash, offlineHash, resourceDelta, maxDeviationPct }。
 *   resourceDelta：offline − online 的各资源净差（正=离线更高）。
 *
 * 确定性：两条路径都只调用纯函数内核；chunk 划分固定；无时钟/随机。同输入 → 同输出。
 */
export function verifyOfflineConsistency(
  initialState: GameState,
  config: GameConfig,
  offlineMs: number,
  chunkSize: number,
): {
  consistent: boolean;
  onlineHash: string;
  offlineHash: string;
  resourceDelta: Record<string, number>;
  maxDeviationPct: number;
} {
  const tickMs = initialState.tickMs;
  const totalTicks = ticksFromOfflineMs(offlineMs, tickMs);
  const chunkTicks = Number.isFinite(chunkSize) && chunkSize >= 1 ? Math.floor(chunkSize) : 1;

  // ── online：分 chunkSize 块多次补算（模拟在线逐块推进）──
  let online = initialState;
  let remaining = totalTicks;
  while (remaining > 0) {
    const step = Math.min(chunkTicks, remaining);
    const r = settleOffline(online, config, step * tickMs, step);
    online = r.state;
    remaining -= step;
  }

  // ── offline：一次性大步补算（单段推进全部 tick）──
  const oneShot = settleOffline(initialState, config, totalTicks * tickMs, Math.max(1, totalTicks));
  const offline = oneShot.state;

  // ── 比较 ──
  const onlineHash = hashState(online);
  const offlineHash = hashState(offline);
  const cmp = resourceDeltaPct(online, offline);
  const maxDeviationPct = cmp.maxPct;
  // Gate 3：偏差 ≤ 1% 为一致；且终态哈希相同为更强的逐位一致证据。
  const consistent = maxDeviationPct <= 1;

  return {
    consistent,
    onlineHash,
    offlineHash,
    resourceDelta: cmp.delta,
    maxDeviationPct,
  };
}
