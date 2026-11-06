/**
 * W5d 游戏循环集成 · M1 收官验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》M1 W5 收官：把 W1–W5c 的确定性内核「串成每 tick 完整游戏循环」，
 * 让一个 Bot 能从纪元 1 开局推进到纪元 2，验证 M1「2 小时流程」在引擎层可跑通。
 *
 * ── 本文件在五包拓扑中的位置（架构 3.1 / 5.2 单一结算内核）─────────────────────
 *   前序暂存包（同级相对 import，最终并入 packages/engine）：
 *     · w1-staging/math.ts     → secToTicks（周期秒→整数 tick）
 *     · w2-staging/events.ts   → SimEvent / EventGroup（离散事件形状）
 *     · w3-staging/dispatch.ts → GameCommand 基础联合 / CommandResult / 稳定原因码
 *     · w5c-staging/economy.ts → EconomyState / GameConfig / recomputeModifiers /
 *                                settleResources / buildingCost / updateChainState / checkEraGate
 *   本文件最终并入 @genesis/engine：EconomyState 由 engine 正式状态承载；GameState 的
 *   dispatch/seed/jobAssignments 并入正式 GameState；命令队列并入引擎命令收件箱。
 *   TODO(engine): 并入 packages/engine 后，'./events.js'→engine 内部 SimEvent 正式定义，
 *     './economy.js' 等改为 engine 内部模块；测试从 '../src/gameLoop.js' 命中本文件。
 *
 * ── 四阶段结算（架构 5.2）在本循环的落地顺序（固定、单向、无回环）───────────────
 *   阶段 1 修饰器与上限：recomputeModifiers      —— 见 gameTick 步骤 1（FR-03）
 *   阶段 2 资源流转     ：settleResources         —— 见 gameTick 步骤 2（FR-03/04）
 *   阶段 3 成本与科技   ：buildingCost 预算       —— 见 gameTick 步骤 3（FR-05，只算不建）
 *   阶段 3.5 命令结算   ：BUILD/RESEARCH/ADVANCE_ERA/ASSIGN_JOB —— dispatch 层 flush 后于
 *                         阶段 3 之后、阶段 4 之前执行（任务约束 4，架构 6.1 命令权威入口）
 *   阶段 4 生态与内政   ：updateChainState        —— 见 gameTick 步骤 4（FR-06 断链级联）
 *   事件收集（阶段末）  ：资源边界 + 断链跃迁 + 纪元门槛满足（架构 5.2 事件点 1/5）
 *   季节推进（阶段 f）  ：按 currentTick 与 seasonSec 派生 seasonIndex（FR-01/季节切换）
 *
 * ── 确定性约束（架构 5.6 / 5.8，务必遵守）──────────────────────────────────────
 *   · 阶段与命令执行顺序固定；遍历一律按配置声明顺序；不依赖对象键枚举顺序。
 *   · 只用 + - * /、min、max、floor、abs；幂用 economy/fastPowInt；无 Date/随机/环境读取。
 *   · 所有导出函数为纯函数：输入 state、返回新 state（不原地修改入参）。
 *   · Bot 决策必须确定性：同一 state + 同一 config → 同一 GameCommand[]（无随机）。
 */

import type { SimEvent, EventGroup } from './events.js';
import { secToTicks } from './math.js';
import {
  recomputeModifiers,
  settleResources,
  buildingCost,
  updateChainState,
  checkEraGate,
  type EconomyState,
  type GameConfig,
} from './economy.js';
import type { GameCommand as BaseGameCommand, CommandResult } from './dispatch.js';
import {
  REASON_INSUFFICIENT_RESOURCES,
  REASON_INVALID_AMOUNT,
  REASON_UNKNOWN_COMMAND,
} from './dispatch.js';

// 便于测试与上层从 './gameLoop.js' 单点引入状态/配置类型（并入 engine 后统一由 @genesis/engine 提供）。
export type { EconomyState, GameConfig } from './economy.js';
export type { CommandResult } from './dispatch.js';

// ---------------------------------------------------------------------------
// 失败原因码（稳定常量；本地化表负责翻译，引擎内不写自然语言）
// ---------------------------------------------------------------------------

/** 建筑配置不存在。 */
export const REASON_BUILDING_NOT_FOUND = 'BUILDING_NOT_FOUND';
/** 建筑尚未解锁（eraIndex > currentEra）。 */
export const REASON_BUILDING_LOCKED = 'BUILDING_LOCKED';
/** 科技配置不存在。 */
export const REASON_TECH_NOT_FOUND = 'TECH_NOT_FOUND';
/** 科技尚未解锁（eraIndex > currentEra）。 */
export const REASON_TECH_LOCKED = 'TECH_LOCKED';
/** 科技已研究过。 */
export const REASON_ALREADY_RESEARCHED = 'ALREADY_RESEARCHED';
/** 科技前置未满足。 */
export const REASON_REQUIREMENT_NOT_MET = 'REQUIREMENT_NOT_MET';
/** 纪元门槛未满足，无法推进。 */
export const REASON_ERA_GATE_NOT_MET = 'ERA_GATE_NOT_MET';
/** 已是最后一个纪元，无法再推进。 */
export const REASON_MAX_ERA = 'MAX_ERA';
/** 无建筑岗位支撑该工种。 */
export const REASON_NO_JOB_SLOTS = 'NO_JOB_SLOTS';

// ---------------------------------------------------------------------------
// 游戏命令：扩展 W3 基础联合（任务约束 4）
// ---------------------------------------------------------------------------

/**
 * GameCommand：在 W3 dispatch 的基础命令（ADD/SUB/SET_COUNT）之上，扩展 M1 玩法四类命令。
 *   - BUILD       ：建一座建筑（检查资源、扣资源、count+1）。
 *   - RESEARCH    ：研究科技（检查前置与资源、扣资源、加入 techs）。
 *   - ADVANCE_ERA ：纪元推进（检查 gate、推进 currentEra、重算仓储上限）。
 *   - ASSIGN_JOB  ：工种人数调整（需建筑岗位支撑）。
 * 说明：M1 游戏循环承载 BUILD/RESEARCH/ADVANCE_ERA/ASSIGN_JOB 四类（并兼容 W3 的
 *   ADD/SUB 资源命令）；SET_COUNT 是 W3 幂等演示命令，游戏循环不承载，按 UNKNOWN_COMMAND 拒绝。
 */
export type GameCommand =
  | BaseGameCommand
  | { type: 'BUILD'; buildingId: string }
  | { type: 'RESEARCH'; techId: string }
  | { type: 'ADVANCE_ERA' }
  | { type: 'ASSIGN_JOB'; jobId: string; delta: number };

// ---------------------------------------------------------------------------
// 游戏状态：GameState（任务硬约束 1）
// ---------------------------------------------------------------------------

/**
 * QueuedCommand：命令收件箱中的一条待执行命令（带幂等键与排序键）。
 *   - commandId：幂等权威键（重复入队/重放去重）。
 *   - cmdSeq   ：单调排序键（提交边界比较）。
 *   - cmd      ：命令本体（不含 atTick；atTick 由 tick 派生，架构 6.1·C1）。
 */
export interface QueuedCommand {
  commandId: string;
  cmdSeq: number;
  cmd: GameCommand;
}

/**
 * GameDispatchState：命令层在游戏循环中的簿记投影。
 *
 * 语义对齐 W3 DispatchState 的「（lastAppliedCmdSeq / appliedCommandIds）」两个核心字段
 * （任务约束 1 明确以这两个字段作为 dispatch 部分的契约），并增补 pending 命令收件箱：
 *   - lastAppliedCmdSeq  ：已应用到的最大 cmdSeq（提交边界，只增不减）。
 *   - appliedCommandIds  ：已应用 commandId 集合（幂等权威键索引）。
 *   - pending            ：待 flush 的命令队列（每 tick 开头 flush，阶段 3 后执行）。
 *
 * 注：W3 的完整 DispatchState 还含 currentTick/resources/counts，那部分与 EconomyState 重复，
 *   游戏循环以 EconomyState 的 resources 为唯一真源，故此处只保留命令簿记 + 收件箱。
 * TODO(engine): 并入 @genesis/engine 后，pending 并入引擎命令收件箱；两字段并入正式命令元数据。
 */
export interface GameDispatchState {
  lastAppliedCmdSeq: number;
  appliedCommandIds: Set<string>;
  pending: QueuedCommand[];
}

/**
 * GameState：游戏循环的完整可序列化状态（任务硬约束 1）。
 *
 * = EconomyState（currentTick/tickMs/subMilli/resources/rates/currentEra/raceId/buildings/
 *   techs/seasonIndex/chainStates/population）
 * + dispatch: GameDispatchState（命令簿记 + 收件箱）
 * + seed: number（命名流种子真源，架构 5.2 Mulberry32；进入初始状态与状态哈希）
 * + jobAssignments: Record<string, number>（ASSIGN_JOB 的工种分配意图；见下注）
 *
 * 注（jobAssignments 的诚实边界）：本暂存包的工人生成由 economy 的 deriveJobWorkers
 *   （= Σ active × jobSlots）自动推导，jobAssignments 记录玩家显式分配意图、并按岗位上限
 *   钳制以支撑「需建筑岗位支撑」的校验；其与生产的完全绑定在并入 engine 后由正式调度承载。
 * TODO(engine): 并入 @genesis/engine 的正式 GameState（run/perma 分段、civ.tutorialStage 等）。
 */
export interface GameState extends EconomyState {
  dispatch: GameDispatchState;
  seed: number;
  jobAssignments: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 内部：深拷贝与状态拼接（纯函数，不原地修改入参）
// ---------------------------------------------------------------------------

/** cloneGameState：整体深拷贝 GameState（含 dispatch 的 Set/pending 与 jobAssignments）。 */
function cloneGameState(s: GameState): GameState {
  const resources: Record<string, { amount: number; max: number }> = {};
  for (const id of Object.keys(s.resources)) {
    const r = s.resources[id];
    if (r) resources[id] = { amount: r.amount, max: r.max };
  }
  const buildings: Record<string, { count: number; active: number }> = {};
  for (const id of Object.keys(s.buildings)) {
    const b = s.buildings[id];
    if (b) buildings[id] = { count: b.count, active: b.active };
  }
  const chainStates: EconomyState['chainStates'] = {};
  for (const id of Object.keys(s.chainStates)) {
    const c = s.chainStates[id];
    if (c) {
      chainStates[id] = {
        level: c.level,
        timerSec: c.timerSec,
        warmupRemainingSec: c.warmupRemainingSec,
        l1Confirmed: c.l1Confirmed,
      };
    }
  }
  const pending: QueuedCommand[] = s.dispatch.pending.map((q) => ({
    commandId: q.commandId,
    cmdSeq: q.cmdSeq,
    cmd: q.cmd,
  }));
  return {
    currentTick: s.currentTick,
    tickMs: s.tickMs,
    subMilli: s.subMilli,
    resources,
    rates: { ...s.rates },
    currentEra: s.currentEra,
    raceId: s.raceId,
    buildings,
    techs: [...s.techs],
    seasonIndex: s.seasonIndex,
    chainStates,
    population: s.population,
    modifierGroups: s.modifierGroups ? { ...s.modifierGroups } : {},
    dispatch: {
      lastAppliedCmdSeq: s.dispatch.lastAppliedCmdSeq,
      appliedCommandIds: new Set(s.dispatch.appliedCommandIds),
      pending,
    },
    seed: s.seed,
    jobAssignments: { ...s.jobAssignments },
  };
}

/**
 * withEconomy：把 economy 内核返回的 EconomyState 拼回带 dispatch/seed/jobAssignments 的 GameState。
 * 用于阶段函数（recomputeModifiers/settleResources/updateChainState）返回新 EconomyState 后，
 * 保留游戏层字段。显式逐字段赋值以满足 exactOptionalPropertyTypes。
 */
function withEconomy(base: GameState, eco: EconomyState): GameState {
  return {
    currentTick: eco.currentTick,
    tickMs: eco.tickMs,
    subMilli: eco.subMilli,
    resources: eco.resources,
    rates: eco.rates,
    currentEra: eco.currentEra,
    raceId: eco.raceId,
    buildings: eco.buildings,
    techs: eco.techs,
    seasonIndex: eco.seasonIndex,
    chainStates: eco.chainStates,
    population: eco.population,
    modifierGroups: eco.modifierGroups ?? {},
    dispatch: base.dispatch,
    seed: base.seed,
    jobAssignments: base.jobAssignments,
  };
}

// ---------------------------------------------------------------------------
// 内部：季节派生（架构 5.2 阶段 4「季节切换」/ FR-01 周期秒配置）
// ---------------------------------------------------------------------------

/**
 * computeSeasonIndex：按「已推进的绝对 tick」与 clock.seasonSec 派生当前季节下标。
 *   ticksPerSeason = secToTicks(seasonSec, tickMs)；index = floor(tick / ticksPerSeason) % seasons.length。
 * 确定性：整数除法 + 取模，无时钟/随机；tickMs 只影响每季 tick 数，同一物理秒数得到同一季。
 */
function computeSeasonIndex(tick: number, tickMs: number, config: GameConfig): number {
  const n = config.seasons.length;
  const seasonSec = config.clock.seasonSec;
  if (n <= 0 || !(seasonSec > 0)) return 0;
  const ticksPerSeason = secToTicks(seasonSec, tickMs as 100 | 250 | 1000);
  if (ticksPerSeason <= 0) return 0;
  const idx = Math.floor(tick / ticksPerSeason) % n;
  return ((idx % n) + n) % n;
}

/** isGateReady：当前纪元「存在下一纪元」且门槛已满足 → true（用于纪元门槛满足事件，架构 5.2 / FR-08）。 */
function isGateReady(state: GameState, config: GameConfig): boolean {
  const curEra = config.eras.find((e) => e.index === state.currentEra);
  const hasNext = config.eras.some((e) => e.index === state.currentEra + 1);
  if (!curEra || curEra.gate === null || !hasNext) return false;
  return checkEraGate(state, config).canAdvance;
}

// ---------------------------------------------------------------------------
// 内部：工种岗位容量（ASSIGN_JOB 的「需建筑岗位支撑」校验，FR-05/内政）
// ---------------------------------------------------------------------------

/** jobSlotCapacity：某工种的可用岗位 = Σ_建筑(active × jobSlots[jobId])（确定性，按 config.buildings 顺序）。 */
function jobSlotCapacity(state: GameState, config: GameConfig, jobId: string): number {
  let cap = 0;
  for (const bldg of config.buildings) {
    const b = state.buildings[bldg.id];
    if (!b || b.active <= 0 || !bldg.jobSlots) continue;
    const slots = bldg.jobSlots[jobId];
    if (slots !== undefined) cap += slots * b.active;
  }
  return cap;
}

/** canAfford：资源是否满足一份成本表（含 1e-9 容差，确定性）。 */
function canAfford(state: GameState, cost: Record<string, number>): boolean {
  for (const resId of Object.keys(cost)) {
    const need = cost[resId] ?? 0;
    const have = state.resources[resId]?.amount ?? 0;
    if (have + 1e-9 < need) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 命令结算（阶段 3 之后、阶段 4 之前执行；架构 6.1 命令权威入口 / FR-05/08）
// ---------------------------------------------------------------------------

/**
 * applyGameCommand：把一条队列命令确定性地落进 GameState（纯函数，返回新 state）。
 *
 * 时序（任务约束 4 / C2/C5）：先幂等判重 → 先决条件校验（失败不改状态、不记账）→ 应用副作用
 *   → 提交记账（lastAppliedCmdSeq / appliedCommandIds）。
 * 事件：经 emit 回调产出（由 gameTick 统一分配 atMilli 与 seq）。
 *
 * @param state        当前（本 tick 工作副本）
 * @param queued       待执行命令
 * @param config       完整配置
 * @param costSnapshot 阶段 3 预算的建筑成本快照（BUILD 使用；成功后同 tick 增量刷新）
 * @param emit         事件发射器 (group, kind, payload)
 * @returns { state, result }
 */
function applyGameCommand(
  state: GameState,
  queued: QueuedCommand,
  config: GameConfig,
  costSnapshot: Record<string, Record<string, number>>,
  emit: (group: EventGroup, kind: string, payload: Record<string, unknown>) => void,
): { state: GameState; result: CommandResult } {
  const cmd = queued.cmd;
  const fail = (reason: string): { state: GameState; result: CommandResult } => ({
    state,
    result: { ok: false, reason },
  });
  const markApplied = (next: GameState): void => {
    if (queued.cmdSeq > next.dispatch.lastAppliedCmdSeq) {
      next.dispatch.lastAppliedCmdSeq = queued.cmdSeq;
    }
    next.dispatch.appliedCommandIds.add(queued.commandId);
  };

  // 幂等判重（C2）：命中即安全忽略，无副作用。
  if (state.dispatch.appliedCommandIds.has(queued.commandId)) {
    return { state, result: { ok: true, duplicate: true } };
  }

  const next = cloneGameState(state);

  switch (cmd.type) {
    case 'BUILD': {
      const bldg = config.buildings.find((b) => b.id === cmd.buildingId);
      const cost = costSnapshot[cmd.buildingId];
      if (!bldg || cost === undefined) return fail(REASON_BUILDING_NOT_FOUND);
      if (bldg.eraIndex > next.currentEra) return fail(REASON_BUILDING_LOCKED);
      if (!canAfford(next, cost)) return fail(REASON_INSUFFICIENT_RESOURCES);
      // 扣资源（已校验充足，结果非负；仍 Math.max 兜底浮点）。
      for (const resId of Object.keys(cost)) {
        const r = next.resources[resId];
        if (r) r.amount = Math.max(0, r.amount - (cost[resId] ?? 0));
      }
      const cur = next.buildings[cmd.buildingId] ?? { count: 0, active: 0 };
      const newCount = cur.count + 1;
      next.buildings[cmd.buildingId] = { count: newCount, active: newCount };
      // 同 tick 后续对同一建筑的 BUILD：刷新成本快照（FR-05 成本蠕变）。
      costSnapshot[cmd.buildingId] = buildingCost(config, cmd.buildingId, newCount);
      markApplied(next);
      emit('C', 'command.build', { buildingId: cmd.buildingId, count: newCount });
      return { state: next, result: { ok: true, appliedAtTick: next.currentTick } };
    }

    case 'RESEARCH': {
      const tech = config.techs.find((t) => t.id === cmd.techId);
      if (!tech) return fail(REASON_TECH_NOT_FOUND);
      if (next.techs.includes(cmd.techId)) return fail(REASON_ALREADY_RESEARCHED);
      if (tech.eraIndex > next.currentEra) return fail(REASON_TECH_LOCKED);
      for (const req of tech.requires) {
        if (!next.techs.includes(req)) return fail(REASON_REQUIREMENT_NOT_MET);
      }
      if (!canAfford(next, tech.cost)) return fail(REASON_INSUFFICIENT_RESOURCES);
      for (const resId of Object.keys(tech.cost)) {
        const r = next.resources[resId];
        if (r) r.amount = Math.max(0, r.amount - (tech.cost[resId] ?? 0));
      }
      next.techs.push(cmd.techId);
      markApplied(next);
      emit('C', 'command.research', { techId: cmd.techId });
      return { state: next, result: { ok: true, appliedAtTick: next.currentTick } };
    }

    case 'ADVANCE_ERA': {
      const advanced = advanceEra(next, config);
      const advancedOk = advanced.state.currentEra > next.currentEra;
      if (!advancedOk) {
        // 拒绝：把 advanceEra 的 blocked 事件透传，返回失败原因（不记账）。
        for (const e of advanced.events) emit(e.group, e.kind, e.payload);
        return { state, result: { ok: false, reason: REASON_ERA_GATE_NOT_MET } };
      }
      // advanceEra 内部已 clone 并保留 dispatch/seed/jobAssignments，直接沿用其返回的状态。
      const merged = advanced.state;
      markApplied(merged);
      for (const e of advanced.events) emit(e.group, e.kind, e.payload);
      return { state: merged, result: { ok: true, appliedAtTick: merged.currentTick } };
    }

    case 'ASSIGN_JOB': {
      if (!Number.isFinite(cmd.delta) || !Number.isInteger(cmd.delta)) {
        return fail(REASON_INVALID_AMOUNT);
      }
      const cap = jobSlotCapacity(next, config, cmd.jobId);
      if (cmd.delta > 0 && cap <= 0) return fail(REASON_NO_JOB_SLOTS);
      const current = next.jobAssignments[cmd.jobId] ?? 0;
      let target = current + cmd.delta;
      if (target < 0) target = 0;
      if (target > cap) target = cap;
      next.jobAssignments[cmd.jobId] = target;
      markApplied(next);
      emit('C', 'command.assign_job', {
        jobId: cmd.jobId,
        assigned: target,
        capacity: cap,
      });
      return { state: next, result: { ok: true, appliedAtTick: next.currentTick } };
    }

    case 'ADD_RESOURCE': {
      if (!Number.isFinite(cmd.amount) || cmd.amount < 0) return fail(REASON_INVALID_AMOUNT);
      const r = next.resources[cmd.resId];
      if (r) {
        r.amount = Math.min(r.max, r.amount + cmd.amount);
      } else {
        next.resources[cmd.resId] = { amount: cmd.amount, max: Number.POSITIVE_INFINITY };
      }
      markApplied(next);
      emit('C', 'command.add_resource', { resId: cmd.resId, amount: cmd.amount });
      return { state: next, result: { ok: true, appliedAtTick: next.currentTick } };
    }

    case 'SUB_RESOURCE': {
      if (!Number.isFinite(cmd.amount) || cmd.amount < 0) return fail(REASON_INVALID_AMOUNT);
      const r = next.resources[cmd.resId];
      const available = r ? r.amount : 0;
      if (cmd.amount > available) return fail(REASON_INSUFFICIENT_RESOURCES);
      if (r) r.amount = r.amount - cmd.amount;
      markApplied(next);
      emit('C', 'command.sub_resource', { resId: cmd.resId, amount: cmd.amount });
      return { state: next, result: { ok: true, appliedAtTick: next.currentTick } };
    }

    case 'SET_COUNT': {
      // W3 幂等演示命令，M1 游戏循环不承载（无 counts 语义）；按未知命令拒绝。
      return fail(REASON_UNKNOWN_COMMAND);
    }

    default: {
      const _exhaustive: never = cmd;
      void _exhaustive;
      return fail(REASON_UNKNOWN_COMMAND);
    }
  }
}

// ---------------------------------------------------------------------------
// 纪元推进（FR-08 / 架构 5.2 阶段 4 + storageMultiplier 仓储重算）
// ---------------------------------------------------------------------------

/**
 * advanceEra：(阶段 4 / FR-08) 检查当前纪元门槛、推进到下一纪元、按新纪元 storageMultiplier
 * 重算资源上限（经阶段 1 修饰器）、重置季节（seasonIndex 归零作为锚点），并发事件。
 *
 * 不可推进时（门槛未满足 / 已是末纪元）返回原因事件（kind='era.advance_blocked'），state 不变。
 *
 * 确定性：门槛检查按 gate 声明顺序；重算走上限=baseMax×storageMultiplier + res.max 修饰器（recomputeModifiers）；无时钟/随机。
 *
 * @param state  GameState
 * @param config 完整配置
 * @returns { state, events }（events 为该次推进的离散事件）
 */
export function advanceEra(
  state: GameState,
  config: GameConfig,
): { state: GameState; events: SimEvent[] } {
  const atMilli = Math.round(state.currentTick * state.tickMs);
  const events: SimEvent[] = [];
  let seq = 0;
  const emit = (group: EventGroup, kind: string, payload: Record<string, unknown>): void => {
    events.push({ atMilli, seq: seq++, group, kind, payload });
  };

  const hasNext = config.eras.some((e) => e.index === state.currentEra + 1);
  if (!hasNext) {
    emit('E', 'era.advance_blocked', { reason: REASON_MAX_ERA, from: state.currentEra });
    return { state: cloneGameState(state), events };
  }
  const gate = checkEraGate(state, config);
  if (!gate.canAdvance) {
    emit('E', 'era.advance_blocked', {
      reason: REASON_ERA_GATE_NOT_MET,
      from: state.currentEra,
      unmet: gate.unmet,
    });
    return { state: cloneGameState(state), events };
  }

  let next = cloneGameState(state);
  const fromEra = next.currentEra;
  next.currentEra = next.currentEra + 1;
  next.seasonIndex = 0; // 重置季节锚点（下一 tick 派生时以 currentTick 为准）
  // 重算仓储上限：走阶段 1 修饰器（baseMax × 新纪元 storageMultiplier + res.max 修饰器）。
  const eco = recomputeModifiers(next, config);
  next = withEconomy(next, eco);
  emit('E', 'era.advance', { from: fromEra, to: next.currentEra });
  return { state: next, events };
}

// ---------------------------------------------------------------------------
// tick 主循环（FR-01/03/04/05/06/08/10 / 架构 5.2 四阶段完整串联）
// ---------------------------------------------------------------------------

/**
 * gameTick：单次完整 tick（固定步长 = 1 tick = tickMs 毫秒）。
 *
 * 【FR-01/03/04/05/06/08/10；架构 5.2 四阶段完整串联（阶段 1→2→3→4 固定顺序）】
 *
 * 执行顺序（严格固定，单向无回环）：
 *   0) flush：取走 dispatch.pending 命令队列（本 tick 开头 flush）；
 *   1) 阶段 1：recomputeModifiers（种族/科技/季节/催化剂修饰器与资源上限汇总，FR-03/10）；
 *   2) 阶段 2：settleResources（资源结算、满仓归零、人口维生与增长，FR-03/04）；
 *   3) 阶段 3：buildingCost 预算（本 tick 只算成本供命令使用，不自动建造，FR-05）；
 *   3.5) 命令结算：执行 flush 出的 BUILD/RESEARCH/ADVANCE_ERA/ASSIGN_JOB（阶段 3 后、阶段 4 前）；
 *   4) 阶段 4：updateChainState（断链状态机推进，FR-06）；
 *   e) 事件收集：资源边界（满仓/耗尽）+ 断链跃迁 + 纪元门槛满足（架构 5.2 事件点 1/5）；
 *   f) 季节推进：按 currentTick 与 seasonSec 派生 seasonIndex（切换产生事件）；
 *   末) currentTick += 1。
 *
 * 返回本 tick 产生的全部离散事件（atMilli = 本 tick 结束时刻 = (currentTick+1)×tickMs）。
 *
 * @param state  GameState
 * @param config 完整配置
 * @returns { state: 新 GameState, events: 本 tick 事件 }
 */
export function gameTick(
  state: GameState,
  config: GameConfig,
): { state: GameState; events: SimEvent[] } {
  // 0) flush：本 tick 开头取走命令队列（执行时机在阶段 3 之后，见下）。
  const queued: QueuedCommand[] = state.dispatch.pending.map((q) => ({
    commandId: q.commandId,
    cmdSeq: q.cmdSeq,
    cmd: q.cmd,
  }));

  // 工作副本（清空 pending；本 tick 的新命令由外部在下一次 tick 前重新入队）。
  let gs = cloneGameState(state);
  gs.dispatch.pending = [];

  const startTick = gs.currentTick;
  const endTick = startTick + 1;
  const dtSec = gs.tickMs / 1000;
  const atMilli = Math.round(endTick * gs.tickMs + gs.subMilli);

  const events: SimEvent[] = [];
  let seq = 0;
  const emit = (group: EventGroup, kind: string, payload: Record<string, unknown>): void => {
    events.push({ atMilli, seq: seq++, group, kind, payload });
  };

  // 纪元门槛满足事件的「前态」快照（用于「未满足→满足」的单次触发）。
  const gateBefore = isGateReady(state, config);

  // 记录阶段 2 前的资源量（用于资源边界事件：满仓/耗尽）。
  const preSettle: Record<string, number> = {};
  for (const res of config.resources) {
    const r = gs.resources[res.id];
    if (r) preSettle[res.id] = r.amount;
  }

  // ── 阶段 1：修饰器与上限（FR-03/10）──
  gs = withEconomy(gs, recomputeModifiers(gs, config));

  // ── 阶段 2：资源流转（FR-03/04）──
  gs = withEconomy(gs, settleResources(gs, dtSec, config));

  // 阶段 2 后发射资源边界事件（满仓/耗尽，架构 5.2 事件点 1）。
  for (const res of config.resources) {
    const r = gs.resources[res.id];
    if (!r) continue;
    const before = preSettle[res.id] ?? r.amount;
    const after = r.amount;
    if (before < r.max && after >= r.max) {
      emit('A', 'resource.cap', { resId: res.id, max: r.max });
    } else if (before > 0 && after <= 0) {
      emit('A', 'resource.empty', { resId: res.id });
    }
  }

  // ── 阶段 3：建筑成本与科技结算（只算成本供 dispatch 用，不自动建造，FR-05）──
  const costSnapshot: Record<string, Record<string, number>> = {};
  for (const bldg of config.buildings) {
    const count = gs.buildings[bldg.id]?.count ?? 0;
    costSnapshot[bldg.id] = buildingCost(config, bldg.id, count);
  }

  // ── 阶段 3.5：命令结算（dispatch 层 flush 的命令，阶段 3 后、阶段 4 前）──
  for (const q of queued) {
    const out = applyGameCommand(gs, q, config, costSnapshot, emit);
    gs = out.state;
  }

  // 记录阶段 4 前的断链等级（用于断链跃迁事件）。
  const chainBefore: Record<string, number> = {};
  for (const id of Object.keys(gs.chainStates)) {
    const c = gs.chainStates[id];
    if (c) chainBefore[id] = c.level;
  }

  // ── 阶段 4：断链状态机推进（FR-06）──
  gs = withEconomy(gs, updateChainState(gs, dtSec, config));

  // 断链跃迁事件（按 id 字典序，确定性）。
  const chainIds = Object.keys(gs.chainStates).sort();
  for (const id of chainIds) {
    const c = gs.chainStates[id];
    if (!c) continue;
    const beforeLevel = chainBefore[id] ?? 0;
    if (c.level !== beforeLevel) {
      emit('D', 'chain.transition', { chainId: id, from: beforeLevel, to: c.level });
    }
  }

  // 末) 推进 tick（currentTick 为「已完整推进的帧数」）。
  gs.currentTick = endTick;

  // ── f) 季节推进：按 currentTick 与 seasonSec 派生季节；切换产生事件（FR-01）──
  const newSeason = computeSeasonIndex(endTick, gs.tickMs, config);
  if (newSeason !== gs.seasonIndex) {
    const fromSeason = gs.seasonIndex;
    gs.seasonIndex = newSeason;
    emit('F', 'season.change', { from: fromSeason, to: newSeason });
  }

  // ── e) 纪元门槛满足事件：未满足→满足（单次触发，架构 5.2 / FR-08）──
  const gateAfter = isGateReady(gs, config);
  if (!gateBefore && gateAfter) {
    emit('E', 'era.gate_ready', { era: gs.currentEra });
  }

  return { state: gs, events };
}

// ---------------------------------------------------------------------------
// 批量推进（FR-20 补算 / 架构 5.3 单次补算入口）
// ---------------------------------------------------------------------------

/**
 * runGame：批量推进 ticks 个 tick（循环调用 gameTick），返回最终状态与全部事件。
 *
 * maxSegmentsPerTick：限制每 tick 的段数。本文件为「固定步长」模式——每个 gameTick 恰为
 *   1 段，故该参数在固定步长下不进一步切分（<1 兜底为 1）；事件跳段模式（并入 engine 的
 *   advance 后）将用它限制每 tick 内的细分段数。
 *
 * 确定性：逐 tick 串行调用纯函数 gameTick；事件按 tick 顺序累加（同 tick 内 seq 保证稳定）。
 *
 * @param state              GameState
 * @param config             完整配置
 * @param ticks              推进的 tick 数（非负；向下取整）
 * @param maxSegmentsPerTick 每 tick 段数上限（固定步长模式下的兼容参数）
 * @returns { state, allEvents, tickCount }
 */
export function runGame(
  state: GameState,
  config: GameConfig,
  ticks: number,
  maxSegmentsPerTick: number,
): { state: GameState; allEvents: SimEvent[]; tickCount: number } {
  const total = Number.isFinite(ticks) && ticks > 0 ? Math.floor(ticks) : 0;
  // 固定步长：每 tick 恰 1 段；仅对 <1 的入参做兜底（事件跳段模式启用后生效）。
  const segCap = Number.isFinite(maxSegmentsPerTick) && maxSegmentsPerTick >= 1
    ? Math.floor(maxSegmentsPerTick)
    : 1;
  void segCap;

  let cur = state;
  const allEvents: SimEvent[] = [];
  let tickCount = 0;
  for (let i = 0; i < total; i++) {
    const r = gameTick(cur, config);
    cur = r.state;
    for (const e of r.events) allEvents.push(e);
    tickCount++;
  }
  return { state: cur, allEvents, tickCount };
}

// ---------------------------------------------------------------------------
// Bot 策略（FR-01 流程验证 / 架构 5.3；确定性贪心）
// ---------------------------------------------------------------------------

/** Bot 接口：decide 返回本 tick 要提交的命令列表（确定性）。 */
export interface Bot {
  decide(state: GameState): GameCommand[];
}

/**
 * createBot：创建确定性贪心 Bot。
 *
 * 策略（任务约束 5，确定性——同一 state 同一决策）：
 *   1) 当前纪元门槛已满足且存在下一纪元 → ADVANCE_ERA（最高优先，第一时间收官推进）；
 *   2) 优先发展食物链：field 少于目标数时建 field（食物不足亦建 field）；
 *   3) 门槛需要 study 且未建 → 建 study（产生 lore）；
 *   4) 木材不足且可负担 → 建 lumber_camp（保障后续建造）；
 *   5) 有可研究科技且资源（在不危及门槛余量的前提下）充足 → RESEARCH；
 *   6) 建筑后按岗位 ASSIGN_JOB：优先 farmer，其次 woodcutter，最后 scholar。
 *
 * 确定性依据：纯函数，按固定优先级与固定遍历顺序比较数值；不读时钟/随机；seed 仅为后续
 *   随机化平局打破预留（当前用 void 显式声明未使用，决策本身完全由 state 决定）。
 *
 * @param seed   随机流种子（保留，当前不影响决策）
 * @param config 完整配置
 */
export function createBot(seed: number, config: GameConfig): Bot {
  void seed; // 保留：当前决策为确定性贪心，无随机；并入 engine 后用于命名流平局打破

  /** 门槛需求快照（按当前纪元 gate 解析 food/lore/study 需求，确定性）。 */
  function gateNeeds(state: GameState): {
    foodNeed: number | null;
    loreNeed: number | null;
    studyNeed: number | null;
    citizensNeed: number | null;
  } {
    const curEra = config.eras.find((e) => e.index === state.currentEra);
    const scale = curEra ? config.tutorialOverrides.eraGateScale[curEra.id] ?? 1 : 1;
    let foodNeed: number | null = null;
    let loreNeed: number | null = null;
    let studyNeed: number | null = null;
    let citizensNeed: number | null = null;
    if (curEra && curEra.gate) {
      for (const req of curEra.gate) {
        if (req.kind === 'resource') {
          const need = req.amount * scale;
          if (req.resId === 'food') foodNeed = need;
          else if (req.resId === 'lore') loreNeed = need;
          else if (req.resId === 'citizens') citizensNeed = need;
        } else if (req.kind === 'building' && req.buildingId === 'study') {
          studyNeed = req.count;
        }
      }
    }
    return { foodNeed, loreNeed, studyNeed, citizensNeed };
  }

  /** 为每个工种补齐岗位分配命令（优先 farmer → woodcutter → scholar）。 */
  function assignmentCommands(state: GameState): GameCommand[] {
    const out: GameCommand[] = [];
    for (const jobId of ['farmer', 'woodcutter', 'scholar']) {
      const cap = jobSlotCapacity(state, config, jobId);
      const cur = state.jobAssignments[jobId] ?? 0;
      if (cap > cur) out.push({ type: 'ASSIGN_JOB', jobId, delta: cap - cur });
    }
    return out;
  }

  /** researchCommands：仅在 lore 高于门槛需求余量时研究（避免把门槛资源花光）。 */
  function researchCommands(
    state: GameState,
    needs: { loreNeed: number | null },
  ): GameCommand[] {
    const lore = state.resources['lore']?.amount ?? 0;
    const loreReserve = (needs.loreNeed ?? 0) + 5; // 保留门槛 + 少量余量
    for (const tech of config.techs) {
      if (state.techs.includes(tech.id)) continue;
      if (tech.eraIndex > state.currentEra) continue;
      if (!tech.requires.every((r) => state.techs.includes(r))) continue;
      const cost = tech.cost;
      const loreCost = cost['lore'] ?? 0;
      if (lore - loreCost < loreReserve) continue; // 会侵蚀门槛余量则跳过
      if (canAfford(state, cost)) {
        return [{ type: 'RESEARCH', techId: tech.id }, ...assignmentCommands(state)];
      }
    }
    return [];
  }

  return {
    decide(state: GameState): GameCommand[] {
      // 1) 门槛满足且存在下一纪元 → 立即推进。
      if (isGateReady(state, config)) {
        return [{ type: 'ADVANCE_ERA' }];
      }

      const needs = gateNeeds(state);
      const food = state.resources['food']?.amount ?? 0;
      const wood = state.resources['wood']?.amount ?? 0;
      const fieldCount = state.buildings['field']?.count ?? 0;
      const studyCount = state.buildings['study']?.count ?? 0;
      const lumberCount = state.buildings['lumber_camp']?.count ?? 0;

      // 2) 食物链优先：field 少于目标数（或食物不足）就建 field。
      const targetFields = 3;
      if (fieldCount < targetFields) {
        const cost = buildingCost(config, 'field', fieldCount);
        if (canAfford(state, cost)) {
          return [
            { type: 'BUILD', buildingId: 'field' },
            ...assignmentCommands(state),
          ];
        }
      }

      // 3) 门槛需要 study 且未达标 → 建 study（产生 lore）。
      if (needs.studyNeed !== null && studyCount < needs.studyNeed) {
        const cost = buildingCost(config, 'study', studyCount);
        if (canAfford(state, cost)) {
          return [
            { type: 'BUILD', buildingId: 'study' },
            ...assignmentCommands(state),
          ];
        }
      }

      // 4) 木材不足且可负担 → 建 lumber_camp（食物有富余时）。
      if (wood < 30 && lumberCount < 2 && food > 15) {
        const cost = buildingCost(config, 'lumber_camp', lumberCount);
        if (canAfford(state, cost)) {
          return [
            { type: 'BUILD', buildingId: 'lumber_camp' },
            ...assignmentCommands(state),
          ];
        }
      }

      // 5) 有可研究科技且资源「不危及门槛余量」充足 → RESEARCH。
      const techCmds = researchCommands(state, needs);
      if (techCmds.length > 0) return techCmds;

      // 6) 无建设动作 → 补齐工种分配。
      return assignmentCommands(state);
    },
  };
}

// ---------------------------------------------------------------------------
// 便捷构造与命令入队（供测试 / 引擎初始化复用）
// ---------------------------------------------------------------------------

/**
 * createInitialGameState：构造纪元 1 开局的 GameState（M1 初始状态）。
 * 资源初值默认 0（= baseMax 上限由配置派生）；可通过 startingResources 注入开荒资源。
 *
 * @param config            完整配置
 * @param seed              随机流种子
 * @param raceId            种族（ = 未锁定，取中性口径）
 * @param startingResources 初始资源量覆盖（resId → amount）
 */
export function createInitialGameState(
  config: GameConfig,
  seed: number,
  raceId: string | null = null,
  startingResources: Record<string, number> = {},
): GameState {
  const resources: Record<string, { amount: number; max: number }> = {};
  for (const r of config.resources) {
    const start = startingResources[r.id] ?? 0;
    resources[r.id] = { amount: Math.min(start, r.baseMax), max: r.baseMax };
  }
  return {
    currentTick: 0,
    tickMs: config.clock.tickMs,
    subMilli: 0,
    resources,
    rates: {},
    currentEra: 1,
    raceId,
    buildings: {},
    techs: [],
    seasonIndex: 0,
    chainStates: {},
    population: 0,
    modifierGroups: {},
    dispatch: {
      lastAppliedCmdSeq: -1,
      appliedCommandIds: new Set<string>(),
      pending: [],
    },
    seed,
    jobAssignments: {},
  };
}

/**
 * enqueueCommand：把一条命令追加进 state 的命令收件箱（返回新 state，不原地修改）。
 *
 * commandId / cmdSeq 由「seed + 当前提交边界 + 在队数量」确定性合成（同一 state 同一入队序列
 * 得到同一 commandId，保证幂等与可重放）。
 *
 * @param state GameState
 * @param cmd   要入队的命令
 */
export function enqueueCommand(state: GameState, cmd: GameCommand): GameState {
  const next = cloneGameState(state);
  // seq = 已提交边界 + 在队数量 + 1（-1 起算 → 首条为 0 或续接提交边界）。
  const seq = next.dispatch.lastAppliedCmdSeq + next.dispatch.pending.length + 1;
  const commandId = `cmd-${next.seed}-${seq}`;
  next.dispatch.pending.push({ commandId, cmdSeq: seq, cmd });
  return next;
}
