/**
 * W5a sim-cli 基础闭环 · Gate 2/3 验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》批次 5a · sim-cli 基础闭环（M1 W3 / W5）。
 *
 * 本文件把三段已验证内核「串成一个闭环」：
 *   · advance（w2-staging/advance.ts）——单步时间推进 / 事件跳段（Gate 2·S2 对象）；
 *   · dispatch（w3-staging/dispatch.ts）——命令权威落库 / 幂等去重（架构 6.1·7.2）；
 *   · hash（w4-staging/hash.ts）——规范状态哈希 / 回放哈希（架构 7.5）。
 * 目标：产出「可批量仿真 + 可回放验证」的统一入口，为长期可玩性六条约束（C1–C6）提供可执行
 *      的验证底座（长期可玩性设计约束 v0.1 §5.1「sim-cli 闭环」）。
 *
 * ── 作用与边界（务必理解，避免夸大）────────────────────────────────────────
 *   本闭环只证明「引擎可复现、可批量」：同一 seed+config → 同一初始状态；同一命令序列 → 逐位
 *   相同的终态哈希；同一物理过程在 tickMs=100/250/1000 下连续量与离散事件一致。它**不证明**任何
 *   「长期不腻」的可玩性结论（那属批次 5b 的 Bot/回归护栏，且只能是反向证伪）。本文件所有断言
 *   均为**静态交付**；实际运行需在具备 vitest 的工程环境执行，本文不声称已运行通过。
 *
 * ── 逐条对应验收条款（本文件）──────────────────────────────────────────────
 *   [Gate 2-A] 步长不变性（连续量）：三档 tickMs 下资源连续量偏差 ≤ 0.1%（本实现为 0）。
 *   [Gate 2-B] 步长不变性（离散事件）：三档 tickMs 下事件序列（kind+atMilli）完全一致。
 *   [Gate 2-D] 同引擎重复回放：同一输入重复 simulate → 逐位相同终态哈希（verifyReplay）。
 *   [Gate 3]   在线逐步 + 离线补算一致：simulate 是统一入口，分段推进 == 一次推进（组合律，
 *              见 sim.test.ts 用例 f）。
 *   [S2]       单一内核事件跳跃与逐 tick 的偏差与段数分布：simulate 复用同一 advance 内核，
 *              tickMs 只影响「多久 push 一帧」，不影响物理/事件（verifyTickInvariance）。
 *   [7.5]      规范状态哈希 / 回放哈希：snapshotSummary 与 verifyReplay 均经 hashState。
 *
 * ── 设计口径（关键约定，务必对照代码）──────────────────────────────────────
 *   1) 状态 = W2 SimState ⊕ W3 DispatchState 的最小并集（见 SimCommandState）。
 *   2) 命令时刻语义（对齐任务约束 2「先 advance 到 atTick，再 dispatch，再继续」）：
 *        · 命令 atTick=T 表示「已推进 T 个整帧（物理时刻 = T×tickMs）之后、推进第 T+1 帧之前」执行。
 *        · atTick=0 在时间 0（首帧结算前）执行；T 落在 [1, targetTick] 内时在对应帧边界执行。
 *        · simulate 结束时只 flush atTick <= targetTick 的命令；atTick > targetTick（超出仿真视界）
 *          的命令**不执行**（仿真没走到它的时刻），保证「推进到哪、命令作用到哪」语义清晰。
 *   3) currentTick 是「已完整推进的帧数」：simulate 推进 N 个整帧后 currentTick == 起始 + N。
 *   4) tickMs 只是 frame 视图粒度：资源连续量与离散事件 atMilli 与 tickMs 无关（Gate 2 根基）。
 *
 * 注：本暂存包先用相对路径 import 同级暂存模块（from '@genesis/engine' 等）；
 * 最终并入 packages/sim-cli 后，改为 from '@genesis/engine' / '@genesis/configs'。
 */

import { advance } from '@genesis/engine';
import type { SimState, SimEvent, EventSource } from '@genesis/engine';
import { resourceBoundarySource } from '@genesis/engine';
import { dispatch } from '@genesis/engine';
import type { GameCommand } from '@genesis/engine';
import { hashState, hashReplay, canonicalize } from '@genesis/engine';

// ---------------------------------------------------------------------------
// 默认配置（暂存最小 GameConfig 子集）
// ---------------------------------------------------------------------------

/**
 * GameConfig：本闭环用到的「配置最小子集」。
 *
 * 完整配置见 w5-staging/configs-types.ts 的 GameConfig（规模庞大）。闭环只需其中三样：
 *   - tickMs：每帧毫秒基准（对应 ClockConfig.tickMs；Gate 2 取 100 | 250 | 1000，生产固定 250）。
 *   - resources：由 ResourceConfig[] 投影出的「资源初值表」：每个资源给 baseMax 与初始 amount。
 *       配置提供资源初值（任务约束 1「配置提供 tickMs 与资源初值」）。
 *   - rates：各资源初值对应的净速率（每秒）。初始速率也来自配置（缺省 0，即静态）。
 *
 * TODO(configs): 并入 packages/sim-cli 后改用 @genesis/configs 的 GameConfig，并从
 *   resources: ResourceConfig[] 派生初值 / 上限 / 速率，本结构仅暂存占位。
 */
export interface GameConfig {
  /** 每帧毫秒基准（Gate 2：100 | 250 | 1000；生产固定 250）。 */
  tickMs: number;
  /** 资源初值表：id → { 初始 amount, 上限 max }。 */
  resources: Record<string, { amount: number; max: number }>;
  /** 资源初速表：id → 每秒净速率（正=增长，负=消耗）；缺省视为 0。 */
  rates: Record<string, number>;
}

/**
 * DEFAULT_CONFIG：默认配置（cli 子命令未显式给配置时使用）。
 *
 * 取 tickMs=250（生产基准），单资源 'food'：初值 0、上限 1000、速率 +10/s。
 * 仅用于让 `sim run/replay/tick-invariance/snapshot` 在没有外部配置时也能跑通闭环。
 * 数值为占位，非玩法数值（待数值评审，见 PRD 附录 C / OQ-15）。
 */
export const DEFAULT_CONFIG: GameConfig = {
  tickMs: 250,
  resources: { food: { amount: 0, max: 1000 } },
  rates: { food: 10 },
};

// ---------------------------------------------------------------------------
// 组合状态：SimState ⊕ DispatchState 的最小并集
// ---------------------------------------------------------------------------

/**
 * SimCommandState：simulate / verifyReplay 使用的最小可序列化状态。
 *
 * 继承 W2 SimState（currentTick/tickMs/subMilli/resources/rates），并增补：
 *   - seed：命名流随机数种子真源（架构 5.2 Mulberry32）。进入初始状态、进入规范状态哈希。
 *   - counts：命名计数表（W3 SET_COUNT 目标，属游戏状态）。
 *   - lastAppliedCmdSeq / appliedCommandIds：W3 命令提交元数据。架构 7.5 明确**不进入规范状态哈希**
 *       （保存序号类字段排除在规范哈希外），但必须随存档持久化以支撑恢复去重。
 *   - targetTicks?：仿真时长提示（verifyReplay 无 budget 参数时据此确定推进时长）。属**仿真框架
 *      提示**、非游戏状态，不进规范哈希；由 withTargetTicks 设置。
 *
 * TODO(engine): 并入 packages/engine 后并入完整 GameState（RunState 资源 + meta 命令边界）。
 */
export interface SimCommandState extends SimState {
  /** 命名流随机数种子（进入初始状态与规范状态哈希）。 */
  seed: number;
  /** 命名计数表（W3 SET_COUNT 的目标）。 */
  counts: Record<string, number>;
  /** 已应用的最大 cmdSeq（提交边界，只增不减；不进入规范状态哈希）。 */
  lastAppliedCmdSeq: number;
  /** 已应用 commandId 集合（幂等权威键；不进入规范状态哈希）。 */
  appliedCommandIds: Set<string>;
  /** 仿真时长提示（verifyReplay 用；非游戏状态，不进入规范状态哈希）。 */
  targetTicks?: number;
}

/** 带时刻的命令项：atTick 由调用方注入（架构 6.1·C1，命令对象本身不带 atTick）。 */
export interface TimedCommand {
  /** 权威时刻：已推进 atTick 个整帧（物理时刻 atTick×tickMs）之后执行。 */
  atTick: number;
  /** 命令本身（W3 GameCommand）。 */
  cmd: GameCommand;
}

/** SimResult：simulate 的结果。 */
export interface SimResult {
  /** 推进后的终态（就地推进后原样返回）。 */
  state: SimCommandState;
  /** 全流程产出的离散事件（按 atMilli、A→K 组、seq 稳定排列）。 */
  events: SimEvent[];
  /** 累计段数（S2 段数分布观察量）。 */
  segmentsRun: number;
  /** 本次推进的完整 tick 数（= 结束 currentTick − 起始 currentTick，由各次 advance 累计）。 */
  ticksAdvanced: number;
  /** 预算中尚未消费的完整 tick 数（= targetTick − 结束 currentTick；正常跑满为 0）。 */
  remainingTicks: number;
  /** 亚 tick 毫秒余量（0 <= remainingMs < tickMs）＝ 最后一次 advance 回传的相位，供下次 SegmentBudget.remainingMs 续算。 */
  remainingMs: number;
  /** 预算是否已全部推进（整帧跑满且亚 tick 相位也已推进到最后一步的目标）。 */
  completed: boolean;
}

/** SegmentBudget：一次推进的预算（沿用 W2 advance 的分段参数定义）。 */
export interface SegmentBudget {
  /** 最多推进的完整 tick 数。 */
  ticks: number;
  /** 亚 tick 毫秒相位（0 <= remainingMs < tickMs）。 */
  remainingMs: number;
  /** 本次切片允许的最大段数（架构 5.3 MAX_SEGMENTS 的切片版）。 */
  maxSegmentsThisSlice: number;
}

/** 单次切片允许的最大段数（防事件过密时单次补算卡死；对齐架构 5.3 MAX_SEGMENTS）。 */
const MAX_SEGMENTS_PER_SLICE = 1_000_000;

// ---------------------------------------------------------------------------
// 确定性初始状态
// ---------------------------------------------------------------------------

/**
 * createSimState：从「配置 + seed」构建确定性初始状态（逐位可复现）。
 * ── 依据：任务约束 1「确定性初始状态」；Gate 2-D「同引擎重复回放」；S2「可复现」。
 *
 * 设计要点：
 *   · seed 进入初始状态：写入 state.seed，作为「命名流随机数初始化」的输入（架构 5.2 真源），
 *       并进入规范状态哈希（不同 seed → 不同哈希）。
 *   · 配置提供 tickMs 与资源初值：深拷贝 resources（amount/max）与 rates（不共享引用，避免就地推进
 *       污染相邻状态）。
 *   · 纯构造：不读时钟 / 随机 / 环境；同一 (seed, config) 恒定输出同一状态（逐位）。
 *
 * @param seed   随机流种子（整数；命名流初始化用）。
 * @param config 配置最小子集（tickMs + 资源初值 + 速率）。
 * @returns      初始 SimCommandState（currentTick=0, subMilli=0）。
 */
export function createSimState(seed: number, config: GameConfig): SimCommandState {
  const resources: Record<string, { amount: number; max: number }> = {};
  for (const id of Object.keys(config.resources)) {
    const r = config.resources[id];
    if (r === undefined) continue; // noUncheckedIndexedAccess 守卫
    resources[id] = { amount: r.amount, max: r.max };
  }
  const rates: Record<string, number> = {};
  for (const id of Object.keys(config.rates)) {
    const v = config.rates[id];
    if (v === undefined) continue;
    rates[id] = v;
  }
  return {
    currentTick: 0,
    tickMs: config.tickMs,
    subMilli: 0,
    resources,
    rates,
    seed,
    counts: {},
    lastAppliedCmdSeq: -1,
    appliedCommandIds: new Set<string>(),
  };
}

/**
 * withTargetTicks：为初始状态打上「本次要推进的 tick 数」提示（供 verifyReplay 确定推进时长）。
 *
 * verifyReplay 的签名（任务约束 3）不含预算/时长参数，但 simulate 需要推进时长才能跑出终态。
 * 该值随状态携带（属仿真框架提示，非游戏状态、不进规范哈希），使重复回放口径明确、可复现。
 * 生产版会由「周目总时长 / 离线补算目标」显式传入 budget，届时可移除本提示。
 */
export function withTargetTicks(state: SimCommandState, ticks: number): SimCommandState {
  state.targetTicks = ticks;
  return state;
}

/**
 * cloneState：深拷贝 SimCommandState（供 verifyReplay / verifyTickInvariance 每轮重建独立起点）。
 * 深拷贝 resources（逐资源新对象）、rates、counts；新建 appliedCommandIds 副本；按需复制 targetTicks。
 */
export function cloneState(state: SimCommandState): SimCommandState {
  const resources: Record<string, { amount: number; max: number }> = {};
  for (const id of Object.keys(state.resources)) {
    const r = state.resources[id];
    if (r === undefined) continue;
    resources[id] = { amount: r.amount, max: r.max };
  }
  const rates: Record<string, number> = {};
  for (const id of Object.keys(state.rates)) {
    const v = state.rates[id];
    if (v === undefined) continue;
    rates[id] = v;
  }
  const counts: Record<string, number> = {};
  for (const id of Object.keys(state.counts)) {
    const v = state.counts[id];
    if (v === undefined) continue;
    counts[id] = v;
  }
  const copy: SimCommandState = {
    currentTick: state.currentTick,
    tickMs: state.tickMs,
    subMilli: state.subMilli,
    resources,
    rates,
    seed: state.seed,
    counts,
    lastAppliedCmdSeq: state.lastAppliedCmdSeq,
    appliedCommandIds: new Set<string>(state.appliedCommandIds),
  };
  if (state.targetTicks !== undefined) copy.targetTicks = state.targetTicks;
  return copy;
}

// ---------------------------------------------------------------------------
// 仿真循环（在线逐步 + 离线补算的统一入口）
// ---------------------------------------------------------------------------

/** normalizeCommands：按 (atTick 升序, 同 atTick 数组顺序) 全序排序，并派生稳定的 cmdSeq / commandId。 */
function normalizeCommands(
  commands: Array<{ atTick: number; cmd: GameCommand }>,
): Array<{ atTick: number; cmd: GameCommand; cmdSeq: number; commandId: string; order: number }> {
  return commands
    .map((c, idx) => ({
      atTick: c.atTick,
      cmd: c.cmd,
      // cmdSeq 用数组下标：单调、唯一、稳定；正式引擎由 WAL 提供真实 cmdSeq。
      cmdSeq: idx,
      // commandId 用 `${idx}@${atTick}`：唯一、稳定；正式引擎由宿主生成 UUID。
      commandId: `cmdid:${idx}@${c.atTick}`,
      order: idx,
    }))
    .sort((a, b) => {
      if (a.atTick !== b.atTick) return a.atTick - b.atTick;
      return a.order - b.order; // 同 atTick：原始数组顺序
    });
}

/**
 * simulate：把命令按 atTick 插入推进 ——「先 advance 到 atTick，再 dispatch 命令，再继续」。
 * ── 依据：任务约束 2「仿真循环」；Gate 2-A/B、Gate 3「在线逐步 + 离线补算一致」、S2。
 *
 * 算法（逐帧推进）：
 *   1) 规范化命令（atTick 升序、同 atTick 数组顺序），维护「下一个待执行命令」游标。
 *   2) 循环推进 targetTick = 起始 currentTick + budget.ticks 个整帧。每次循环开始时，先把
 *      所有 atTick <= 当前 currentTick 的命令 dispatch（即「已 advance 到其时刻」的命令），
 *      再 advance 一个整帧（最后一步用 budget.remainingMs 作亚 tick 相位）。
 *        → 命令 atTick=T 在 currentTick==T（物理时刻 T×tickMs）时执行，正合「先 advance 到 T 再 dispatch」。
 *   3) 收尾：flush 所有 atTick <= targetTick 的剩余命令（如 atTick==targetTick）；atTick > targetTick 的
 *      命令超出仿真视界，不执行（仿真未走到其时刻）。
 *   4) 返回终态 + 全事件 + 累计段数。
 *
 * 就地推进：advance / dispatch 均就地修改 state，故 state 必须是「本次仿真独占」的实例（cloneState
 * 或 createSimState 每次新建，满足）。
 *
 * @param state    初始状态（就地推进）。
 * @param commands 带 atTick 的命令序列。
 * @param budget   推进预算：budget.ticks 为要推进的完整 tick 数。
 * @param sources  事件源数组（一般传 [resourceBoundarySource()]）。
 */
export function simulate(
  state: SimCommandState,
  commands: Array<{ atTick: number; cmd: GameCommand }>,
  budget: SegmentBudget,
  sources: EventSource[],
): SimResult {
  const normalized = normalizeCommands(commands);
  const targetTick = state.currentTick + budget.ticks;

  const allEvents: SimEvent[] = [];
  let segmentsRun = 0;
  let cmdCursor = 0;
  // 续算相关累计量：ticksAdvanced 跨帧求和；剩余 tick / 亚 tick 相位以「最后一次 advance」为准。
  // ranAny 用于区分「一次 advance 都没跑」的退化情形（budget.ticks==0）。
  let ticksAdvanced = 0;
  let lastRemainingTicks = 0;
  let lastRemainingMs = 0;
  let lastCompleted = true;
  let ranAny = false;

  while (state.currentTick < targetTick) {
    // (a) 已 advance 到其时刻（atTick <= currentTick）的命令，先 dispatch。
    while (cmdCursor < normalized.length) {
      const item = normalized[cmdCursor];
      if (item === undefined) break;
      if (item.atTick > state.currentTick) break; // 尚未到该时刻，留待后续
      dispatch(state, item.cmdSeq, item.commandId, item.cmd, item.atTick);
      cmdCursor += 1;
    }
    // (b) 推进一个整帧；最后一步用 remainingMs 表达亚 tick 相位。
    const isLast = state.currentTick + 1 === targetTick;
    const remainingMs = isLast ? budget.remainingMs : 0;
    const step = advance(state, { ticks: 1, remainingMs, maxSegmentsThisSlice: MAX_SEGMENTS_PER_SLICE }, sources);
    for (const e of step.events) allEvents.push(e);
    segmentsRun += step.segmentsRun;
    // 从本次 advance 的返回结果正确传递（advance 返回 SimResult 已含这些字段）：
    //   · ticksAdvanced 跨帧累加（完整 tick 推进数）；
    //   · remainingTicks / remainingMs / completed 取「最后一次」的返回值（= 最终相位）。
    ticksAdvanced += step.ticksAdvanced;
    lastRemainingTicks = step.remainingTicks;
    lastRemainingMs = step.remainingMs;
    lastCompleted = step.completed;
    ranAny = true;
  }

  // (c) 收尾：flush atTick <= targetTick 的剩余命令（如 atTick==targetTick）；超视界的命令不执行。
  while (cmdCursor < normalized.length) {
    const item = normalized[cmdCursor];
    if (item === undefined) break;
    if (item.atTick > targetTick) break;
    dispatch(state, item.cmdSeq, item.commandId, item.cmd, item.atTick);
    cmdCursor += 1;
  }

  // ── 组装返回值 ───────────────────────────────────────────────────────────
  // remainingTicks：传递「最后一次 advance 回传的未消费完整 tick 数」（advance 内定义为
  //   targetTick − 结束 currentTick，正常跑满=0；段数上限提前返回则 >0）。
  //   若一次都没跑（budget.ticks==0），回落为 targetTick − 结束 currentTick（此时恒为 0）。
  const remainingTicks = ranAny ? lastRemainingTicks : targetTick - state.currentTick;
  // remainingMs：传递「最后一次 advance 回传的亚 tick 相位」；若一次都没跑（budget.ticks==0），
  //   回落到当前实际相位 state.subMilli（= 起始相位，未被推进），保证 0<=remainingMs<tickMs。
  const remainingMs = ranAny ? lastRemainingMs : state.subMilli;
  // completed：整帧跑满且最后一次 advance 报「预算已全部推进」；空推进的退化情形视为已完成。
  //   段数上限导致提前返回时 lastCompleted=false（或 currentTick<targetTick），故 completed=false，
  //   remainingTicks/remainingMs 反映实际已推进到的相位，供调用方续算。
  const completed = ranAny ? lastCompleted && state.currentTick === targetTick : true;

  return {
    state,
    events: allEvents,
    segmentsRun,
    ticksAdvanced,
    remainingTicks,
    remainingMs,
    completed,
  };
}

// ---------------------------------------------------------------------------
// 规范哈希投影（区分「规范状态哈希」与「tick 不变指纹」）
// ---------------------------------------------------------------------------

/** normalizeMax：把资源上限转成可规范序列化的形式（有限值原样；+Infinity → 'inf' 字面量）。 */
function normalizeMax(max: number): number | 'inf' {
  return Number.isFinite(max) ? max : 'inf';
}

/**
 * hashableState：构造「可进入规范状态哈希」的纯状态子集（架构 7.5 覆盖范围）。
 *
 * 仅取「游戏状态本身」：currentTick、tickMs、subMilli（时刻与步长）、resources（amount/max）、
 * rates（净速率）、counts（含 SET_COUNT 各计数）、seed（命名流随机状态真源）。
 * **排除**命令提交元数据：lastAppliedCmdSeq、appliedCommandIds（Set 无规范序，且架构 7.5 明确保存
 * 序号类字段不进规范哈希，但需持久化以支撑恢复去重）；**排除** targetTicks（仿真框架提示）。
 *
 * 资源/速率/计数一律按 id 字典序输出为数组，使哈希口径清晰、可解释、不依赖对象键枚举顺序。
 * 资源 max 以 normalizeMax 归一（+Infinity → 'inf'，因 canonicalize 拒绝非有限数）。
 */
export function hashableState(state: SimCommandState): {
  currentTick: number;
  tickMs: number;
  subMilli: number;
  resources: Array<{ id: string; amount: number; max: number | 'inf' }>;
  rates: Array<{ id: string; rate: number }>;
  counts: Array<{ key: string; value: number }>;
  seed: number;
} {
  const resources = Object.keys(state.resources)
    .sort()
    .map((id) => {
      const r = state.resources[id];
      if (r === undefined) throw new Error(`hashableState: missing resource ${id}`);
      return { id, amount: r.amount, max: normalizeMax(r.max) };
    });
  const rates = Object.keys(state.rates)
    .sort()
    .map((id) => ({ id, rate: state.rates[id] ?? 0 }));
  const counts = Object.keys(state.counts)
    .sort()
    .map((key) => ({ key, value: state.counts[key] as number }));
  return {
    currentTick: state.currentTick,
    tickMs: state.tickMs,
    subMilli: state.subMilli,
    resources,
    rates,
    counts,
    seed: state.seed,
  };
}

/**
 * tickInvariantState：构造「与 tickMs 无关」的物理指纹投影，专供 verifyTickInvariance 跨档比较。
 *
 * 为何不能用 hashableState 直接跨档比：hashableState 含 currentTick / tickMs / subMilli —— 它们是
 * 「帧导数视图」，tickMs 一变、帧数一变就必然不同（物理相同也会哈希不同），跨档比较是范畴错误。
 * 本投影只保留与 tickMs 无关的物理量：resources（amount/max）、rates、counts、seed。三档 tickMs 下同一
 * 物理轨迹 → 本投影逐位相同 → 指纹哈希相同，正是 Gate 2-A/B 的正确比较口径。
 */
export function tickInvariantState(state: SimCommandState): {
  resources: Array<{ id: string; amount: number; max: number | 'inf' }>;
  rates: Array<{ id: string; rate: number }>;
  counts: Array<{ key: string; value: number }>;
  seed: number;
} {
  const resources = Object.keys(state.resources)
    .sort()
    .map((id) => {
      const r = state.resources[id];
      if (r === undefined) throw new Error(`tickInvariantState: missing resource ${id}`);
      return { id, amount: r.amount, max: normalizeMax(r.max) };
    });
  const rates = Object.keys(state.rates)
    .sort()
    .map((id) => ({ id, rate: state.rates[id] ?? 0 }));
  const counts = Object.keys(state.counts)
    .sort()
    .map((key) => ({ key, value: state.counts[key] as number }));
  return { resources, rates, counts, seed: state.seed };
}

// ---------------------------------------------------------------------------
// 回放验证
// ---------------------------------------------------------------------------

/**
 * resolveTicks：确定「一次回放要推进的完整 tick 数」。
 *   · 优先用初始状态携带的 targetTicks（withTargetTicks 设置）；
 *   · 缺省时回落到命令序列里的最大 atTick（至少推进到唯一/最后一条命令的时刻）；
 *   · 两者皆无 → 0（不推进，仅对初始状态求哈希的退化情形）。
 */
function resolveTicks(
  state: SimCommandState,
  commands: Array<{ atTick: number; cmd: GameCommand }>,
): number {
  if (state.targetTicks !== undefined) return state.targetTicks;
  let maxAtTick = 0;
  for (const c of commands) if (c.atTick > maxAtTick) maxAtTick = c.atTick;
  return maxAtTick;
}

/**
 * verifyReplay：对同一初始状态 + 命令序列执行 runs 次 simulate，断言所有 runs 的终态哈希逐位一致。
 * ── 依据：任务约束 3「回放验证」；Gate 2-D「同引擎重复回放」；S2；架构 7.5 规范状态哈希。
 *
 * 关键点：每轮都从「同一初始状态副本」重新 simulate（cloneState 深拷贝），杜绝上一轮就地推进污染
 * 下一轮。哈希口径 = hashState(hashableState(终态))（规范状态哈希，含 currentTick/tickMs 等）。
 *
 * @param initialState 初始状态（模板，不被本函数修改；推进时长取其 targetTicks，缺省 0）。
 * @param commands     命令序列。
 * @param runs         重复次数（>=1）。
 * @returns { consistent, hashes }：consistent = 所有 hashes 逐位相等。
 */
export function verifyReplay(
  initialState: SimCommandState,
  commands: Array<{ atTick: number; cmd: GameCommand }>,
  runs: number,
): { consistent: boolean; hashes: string[] } {
  const hashes: string[] = [];
  const sources = [resourceBoundarySource()];
  const ticks = resolveTicks(initialState, commands);
  for (let i = 0; i < runs; i++) {
    const state = cloneState(initialState); // 每轮独立副本
    const budget: SegmentBudget = { ticks, remainingMs: 0, maxSegmentsThisSlice: MAX_SEGMENTS_PER_SLICE };
    const result = simulate(state, commands, budget, sources);
    hashes.push(hashState(hashableState(result.state)));
  }
  const consistent = hashes.length > 0 && hashes.every((h) => h === hashes[0]);
  return { consistent, hashes };
}

// ---------------------------------------------------------------------------
// tickMs 不变性验证
// ---------------------------------------------------------------------------

/**
 * verifyTickInvariance：同一初始状态 + 命令序列，三档 tickMs 下比较「终态物理指纹哈希」与「离散事件
 * 序列（kind+atMilli）」，验证 Gate 2-A/B / S2 的步长不变性。
 * ── 依据：任务约束 4「tickMs 不变性验证」；Gate 2-A（连续量）/2-B（离散事件）/S2。
 *
 * 关键设计（务必理解，否则跑成假阴性/假阳性）：
 *   · 同一物理时长、不同 tickMs 才可比：总毫秒 = (初始状态 targetTicks) × (初始状态 tickMs)，各档
 *     ticks = 总毫秒 / tickMs（必须整除，否则报错）。
 *   · state.tickMs 每轮前强制覆盖为对应档值（配置初值只作基准，比较时覆盖）。
 *   · 命令时刻跨档换算：命令 atTick 以「初始配置 tickMs」为基准（帧索引）。跨档时按**物理时间等价**
 *     换算到目标档帧索引 targetAtTick = atTick × baseTickMs / tickMs（须整除，否则报错——该输入在该
 *     档 tickMs 下无法精确表达）。这样「同一命令序列」在任一 tickMs 下作用于**同一模拟物理时刻**，
 *     才是 apples-to-apples 的比较（否则 atTick=50 在 250ms=12.5s、在 100ms=5s，根本非同一输入）。
 *   · 终态比较口径：用 tickInvariantState（排除 currentTick/tickMs/subMilli 这些帧导数视图）+ hashState；
 *     事件归一为 `${kind}@${atMilli}`（atMilli 是连续物理毫秒，跨档应与 tickMs 无关）。
 *
 * @param initialState 初始状态（模板；每轮深拷贝，tickMs 被覆盖）。
 * @param commands     命令序列（atTick 以 initialState.tickMs 为基准）。
 * @param tickMsList   要比较的 tickMs 档位（如 [100,250,1000]）。
 * @returns { consistent, results }：consistent = 各档指纹哈希与事件序列均与首档逐项相等。
 */
export function verifyTickInvariance(
  initialState: SimCommandState,
  commands: Array<{ atTick: number; cmd: GameCommand }>,
  tickMsList: number[],
): { consistent: boolean; results: Array<{ tickMs: number; hash: string; events: string[] }> } {
  const baseTickMs = initialState.tickMs;
  const baseTicks = resolveTicks(initialState, commands);
  const totalMs = baseTicks * baseTickMs;
  const sources = [resourceBoundarySource()];

  const results: Array<{ tickMs: number; hash: string; events: string[] }> = [];
  for (const tickMs of tickMsList) {
    if (!(tickMs > 0) || !Number.isInteger(totalMs / tickMs)) {
      throw new Error(
        `verifyTickInvariance: 总时长 ${totalMs}ms 不能被 tickMs=${tickMs} 整除，无法对齐比较`,
      );
    }
    const ticks = totalMs / tickMs;

    // 跨档换算命令时刻（物理时间等价）：targetAtTick = atTick × baseTickMs / tickMs，须整除。
    const rescaled = commands.map((c) => {
      const physicalMs = c.atTick * baseTickMs;
      if (!Number.isInteger(physicalMs / tickMs)) {
        throw new Error(
          `verifyTickInvariance: 命令 atTick=${c.atTick}（物理 ${physicalMs}ms）无法被 tickMs=${tickMs} 整除表达`,
        );
      }
      return { atTick: physicalMs / tickMs, cmd: c.cmd };
    });

    // 深拷贝模板后「强制覆盖 tickMs」（任务约束 4），并把 currentTick/subMilli 归零到比较起点。
    const state = cloneState(initialState);
    state.tickMs = tickMs;
    state.currentTick = 0;
    state.subMilli = 0;

    const budget: SegmentBudget = { ticks, remainingMs: 0, maxSegmentsThisSlice: MAX_SEGMENTS_PER_SLICE };
    const result = simulate(state, rescaled, budget, sources);
    const hash = hashState(tickInvariantState(result.state));
    const events = result.events
      .map((e) => `${e.kind}@${e.atMilli}`)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    results.push({ tickMs, hash, events });
  }

  const first = results[0];
  const consistent =
    first !== undefined &&
    results.every(
      (r) =>
        r.hash === first.hash &&
        r.events.length === first.events.length &&
        r.events.every((e, i) => e === first.events[i]),
    );
  return { consistent, results };
}

// ---------------------------------------------------------------------------
// 输入日志（供 hashReplay 的 inputLog）
// ---------------------------------------------------------------------------

/**
 * serializeCommands：把命令序列规范化为字符串（用 canonicalize），供 hashReplay 的 inputLog。
 * ── 依据：任务约束 5「输入日志」；架构 7.5 回放哈希「输入序列摘要」。
 *
 * 规范化口径：先按 (atTick 升序, 同 atTick 数组顺序) 稳定排序（与 simulate 执行序一致）；每项只保留
 * 输入二元组 atTick + cmd（派生 cmdSeq/commandId 属内部实现细节，不掺入）；用 canonicalize 序列化，
 * 保证「同输入 → 同串、不同输入 → 不同串」且跨内核确定（架构 7.5）。
 */
export function serializeCommands(
  commands: Array<{ atTick: number; cmd: GameCommand }>,
): string {
  const ordered = commands
    .map((c, idx) => ({ c, idx }))
    .sort((a, b) => {
      if (a.c.atTick !== b.c.atTick) return a.c.atTick - b.c.atTick;
      return a.idx - b.idx;
    })
    .map(({ c }) => ({ atTick: c.atTick, cmd: c.cmd }));
  return canonicalize(ordered);
}

// ---------------------------------------------------------------------------
// 存档摘要（长期回归报告）
// ---------------------------------------------------------------------------

/**
 * snapshotSummary：提取关键状态摘要（当前 tick、各资源 amount、规范哈希），供长期回归报告用。
 * ── 依据：任务约束 6「存档摘要」；架构 7.5 规范状态哈希；长期可玩性约束 v0.1 §5.1「输出规范状态哈希」。
 *
 *   · tick：state.currentTick。
 *   · resources：id → amount 的纯数值映射（便于人读与报告 diff）。
 *   · hash：hashState(hashableState(state))，与 verifyReplay 同口径（16 位小写 hex）。
 *     注：因 appliedCommandIds 为 Set 无法规范序列化、且架构 7.5 明确其不进规范哈希，规范哈希
 *     统一定义在 hashableState 投影上；snapshotSummary 与 verifyReplay 均用此投影，保持自洽。
 */
export function snapshotSummary(state: SimCommandState): {
  tick: number;
  resources: Record<string, number>;
  hash: string;
} {
  const resources: Record<string, number> = {};
  for (const id of Object.keys(state.resources)) {
    const r = state.resources[id];
    if (r === undefined) continue;
    resources[id] = r.amount;
  }
  return {
    tick: state.currentTick,
    resources,
    hash: hashState(hashableState(state)),
  };
}

// ---------------------------------------------------------------------------
// 便捷入口（供 cli / test 复用）
// ---------------------------------------------------------------------------

export type { GameCommand, EventSource, SimEvent, SimState };
// 便捷再导出：便于 sim-cli 下游（含测试）从 './sim.js' 统一拿到规范哈希入口（架构 7.5）。
// （hashState 已在文件顶部 import；此处把该绑定再导出，避免测试跨到 @genesis/engine 取哈希。）
export { hashState };

/** defaultSources：默认事件源集合（A 资源边界）。 */
export function defaultSources(): EventSource[] {
  return [resourceBoundarySource()];
}

/**
 * replayHashOf：组装一次回放哈希（规范状态哈希 + 输入日志 + 配置版本 + 引擎版本，架构 7.5 四段）。
 * 供 cli 的 replay 子命令在需要「完整回放哈希」时使用。
 */
export function replayHashOf(
  state: SimCommandState,
  commands: Array<{ atTick: number; cmd: GameCommand }>,
  configVersion: number,
  engineVersion: number,
): string {
  return hashReplay(
    hashState(hashableState(state)),
    serializeCommands(commands),
    configVersion,
    engineVersion,
  );
}

/** makeDefaultState：按 DEFAULT_CONFIG 构造初始状态并设置目标 tick（cli 无外部配置时使用）。 */
export function makeDefaultState(seed: number, ticks: number): SimCommandState {
  const state = createSimState(seed, DEFAULT_CONFIG);
  return withTargetTicks(state, ticks);
}
