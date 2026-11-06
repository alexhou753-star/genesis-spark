/**
 * FR-29 基础版 · M1 收官验收对象
 * =============================================================================
 * 文件：worker.ts —— 引擎 Worker 宿主侧（gameTick 循环 + postMessage 投影）
 * 依据：任务约束 1（Worker 宿主）；架构 ADR-01（引擎运行在专用 Worker，主线程只做界面，
 *       只传视图投影，仅在初始化/重置/导入时传受控快照）；架构 6.1（ToWorkerMsg /
 *       FromWorkerMsg 消息契约）、架构 6.2（心跳：每 250 ms 一脉冲，按单调时钟差换算整数
 *       tick；暂停/挂起时不补偿）、架构 6.4（投影不高于 4 Hz）、Spike S1。
 *
 * 职责（严格按任务约束 1）：
 *   1. 在 Worker 内运行 gameTick 循环：每 250 ms（1 tick）执行一次 gameTick；
 *   2. 每次 tick 后用 buildView 生成「视图投影」并 postMessage 给主线程——只传视图需要的数据，
 *      绝不 postMessage 整个 GameState；
 *   3. 每 15 秒同步一次「压缩信封」（完整状态快照的字面量 + tick 偏移，供主线程兜底/恢复）；
 *   4. 暂停时 tick 不走（内部计时器停摆，currentTick 不推进）。
 *
 * 确定性（架构 5.6）：
 *   - 引擎内核（gameTick / buildView）是纯函数，tick 数由「单调时钟差」换算得到，
 *     同一段真实时间（相同毫秒差）→ 相同 tick 数 → 相同状态；不读 Date / Math.random 进入内核。
 *   - Worker 本身读 clock.now() 只为「把墙钟时间换算成整数 tick」，不进入游戏状态计算。
 *
 * 并入 packages/web 后的落位：
 *   createWorkerRuntime(deps) 通过依赖注入口接收引擎与配置，正式工程可：
 *     import { gameTick, createInitialGameState, enqueueCommand } from '@genesis/engine';
 *     import { M1_CONFIG } from '@genesis/configs';
 *   并把它们组装成 WorkerEngineDeps 传入。当前暂存包在文件末尾附「内联最小引擎桩」，
 *   使 worker.ts 脱离 w1–w5d 暂存目录时仍可 tsc --strict 通过、并在浏览器里跑起来。
 */

import { buildView, type ViewProjection, type ViewConfig, type ViewState } from './view.js';

// ===========================================================================
// 一、引擎最小类型（结构化，兼容 @genesis/engine 的真实 GameState / GameConfig）
// ===========================================================================

/**
 * GameConfig：直接采用 view.ts 的 ViewConfig（视图/引擎共用同一份「配置切片」形状）。
 * 真实 @genesis/configs 的 GameConfig 字段更多，结构上可赋值给 ViewConfig。
 */
export type GameConfig = ViewConfig;

/**
 * GameCommand：M1 游戏循环承载的四类玩法命令（与 w5d-staging/gameLoop.ts 对齐）。
 * 仅保留 FR-29 原型需要的四类；ADD/SUB 资源命令由引擎侧扩展，本原型不承载。
 */
export type GameCommand =
  | { type: 'BUILD'; buildingId: string }
  | { type: 'RESEARCH'; techId: string }
  | { type: 'ADVANCE_ERA' }
  | { type: 'ASSIGN_JOB'; jobId: string; delta: number };

/** QueuedCommand：命令收件箱中的一条待执行命令（幂等键 + 排序键）。 */
export interface QueuedCommand {
  commandId: string;
  cmdSeq: number;
  cmd: GameCommand;
}

/**
 * GameState：在 view.ViewState 的只读切片之上，补齐 Worker 自己的簿记字段
 * （subMilli / raceId / seed / jobAssignments / dispatch）。与 @genesis/engine 的
 * GameState 结构兼容（真实类型是这里的超集）。
 */
export interface GameState extends ViewState {
  subMilli: number;
  raceId: string | null;
  seed: number;
  jobAssignments: Record<string, number>;
  dispatch: {
    lastAppliedCmdSeq: number;
    appliedCommandIds: Set<string>;
    pending: QueuedCommand[];
  };
}

// ===========================================================================
// 二、消息契约（ToWorkerMsg / FromWorkerMsg 的 FR-29 子集）
// ===========================================================================
// 说明：完整契约见架构 6.1。本原型只承载「在线游玩 + 暂停/恢复 + 命令派发」子集；
// 存档导出/导入、离线补算、多实例写锁在后续里程碑补齐（此处只保留字段位）。

/** 主线程 → Worker：初始化（创建初始状态并启动循环）。 */
export interface InitMessage {
  type: 'INIT';
  seed: number;
}

/** 主线程 → Worker：重置（重新开局）。 */
export interface ResetMessage {
  type: 'RESET';
  seed: number;
}

/** 主线程 → Worker：派发一条游戏命令（带单调 cmdSeq 供幂等去重）。 */
export interface DispatchCmdMessage {
  type: 'DISPATCH_CMD';
  cmdSeq: number;
  cmd: GameCommand;
}

/** 主线程 → Worker：暂停/恢复（暂停时 tick 不走）。 */
export interface SetPausedMessage {
  type: 'SET_PAUSED';
  paused: boolean;
}

/** 汇总：主线程发给 Worker 的消息联合。 */
export type ToWorkerMsg = InitMessage | ResetMessage | DispatchCmdMessage | SetPausedMessage;

/** Worker → 主线程：视图投影（不含整个 GameState）。 */
export interface ViewProjectionMessage {
  type: 'VIEW_PROJECTION';
  tick: number;
  /** 当前是否暂停（主线程据此切换按钮态）。 */
  paused: boolean;
  viewModel: ViewProjection;
}

/** Worker → 主线程：命令执行结果回执（成功/失败原因码）。 */
export interface CommandAckMessage {
  type: 'COMMAND_ACK';
  cmdSeq: number;
  ok: boolean;
  reason?: string;
}

/** Worker → 主线程：每 15 秒一次的压缩信封（完整状态快照字面量 + tick 偏移）。 */
export interface EnvelopeMessage {
  type: 'ENVELOPE';
  tick: number;
  /** 压缩后的完整状态快照（此处为 JSON 字面量；正式工程改用 save 包 deflate+base64url）。 */
  envelope: string;
}

/** Worker → 主线程：暂停态变化通知。 */
export interface PausedMessage {
  type: 'PAUSED_CHANGED';
  paused: boolean;
}

/** 汇总：Worker 发给主线程的消息联合。 */
export type FromWorkerMsg =
  | ViewProjectionMessage
  | CommandAckMessage
  | EnvelopeMessage
  | PausedMessage;

// ===========================================================================
// 三、依赖注入契约 + 运行时（可被测试 / 正式工程直接复用）
// ===========================================================================

/** Worker 运行所需的「引擎能力」注入接口（正式工程由 @genesis/engine 提供）。 */
export interface WorkerEngineDeps {
  /** 构造初始状态。 */
  createInitialGameState(config: GameConfig, seed: number): GameState;
  /** 单步推进（纯函数）。 */
  gameTick(state: GameState, config: GameConfig): { state: GameState; events: unknown[] };
  /** 命令入队（纯函数，返回新 state）。 */
  enqueueCommand(state: GameState, cmd: GameCommand): GameState;
  /** 完整配置。 */
  config: GameConfig;
}

/** 定时器抽象（便于在无 window 的自检环境替换为假时钟，不影响运行契约）。 */
export interface Clock {
  now(): number;
  every(ms: number, fn: () => void): void;
  clear(): void;
}

/** 运行时选项常量（来自任务约束 1 与架构 6.2 / 6.4）。 */
export const TICK_MS = 250;
export const ENVELOPE_SYNC_MS = 15000;

/** Worker 运行时控制对象（createWorkerRuntime 的返回类型）。 */
export interface WorkerRuntime {
  setPost(fn: (msg: FromWorkerMsg) => void): void;
  start(seed: number): void;
  stop(): void;
  handleMessage(msg: ToWorkerMsg): void;
  _peekTick(): number;
}

/**
 * createWorkerRuntime：装配 Worker 侧的 tick 循环、投影推送与信封同步。
 *
 * 返回 { start, stop, handleMessage }，由真实 Worker 入口（bootstrapWorker）或自检脚本驱动。
 * 所有对外可见行为（投影内容、消息类型、暂停语义、信封周期）都在这里定义，
 * 便于脱离真实 Worker 做静态/单元自检。
 */
export function createWorkerRuntime(deps: WorkerEngineDeps, clock: Clock): WorkerRuntime {
  let state: GameState = deps.createInitialGameState(deps.config, 0);
  let paused = false;

  // 允许外部（bootstrapWorker）覆盖 post 实现。
  let post: (msg: FromWorkerMsg) => void = () => {
    /* 默认空实现，bootstrapWorker 中替换为 self.postMessage */
  };
  const emit = (msg: FromWorkerMsg): void => {
    post(msg);
  };

  // ── tick 循环按「单调时钟差」推进（架构 6.2）：每 TICK_MS 一脉冲，补齐整数 tick 数 ──
  let lastPulseMs = clock.now();
  // 每次 tick 后推送一次视图投影（250ms 即 4 Hz，符合架构 6.4「不高于 4 Hz」）；
  // 每 ENVELOPE_SYNC_MS 同步一次压缩信封（任务约束 1）。
  let msSinceEnvelope = 0;

  /** 生成并推送一帧视图投影（只投影，不传整个 GameState）。 */
  function pushProjection(): void {
    const viewModel = buildView(state, deps.config);
    emit({ type: 'VIEW_PROJECTION', tick: state.currentTick, paused, viewModel });
  }

  /** 生成并推送一份压缩信封（完整状态快照的字面量字符串 + tick）。 */
  function pushEnvelope(): void {
    emit({ type: 'ENVELOPE', tick: state.currentTick, envelope: serializeEnvelope(state) });
  }

  /** 单个 tick：推进一次 gameTick，然后推送投影；累计到周期则同步信封。 */
  function stepOnce(): void {
    const r = deps.gameTick(state, deps.config);
    state = r.state;
    pushProjection();
    msSinceEnvelope += TICK_MS;
    if (msSinceEnvelope >= ENVELOPE_SYNC_MS) {
      msSinceEnvelope = 0;
      pushEnvelope();
    }
  }

  /** 心跳：按下墙钟差换算应补的整数 tick 数（暂停则 0）。只换算 tick 数，不读 Date 进内核。 */
  function tickLoop(): void {
    if (paused) {
      lastPulseMs = clock.now(); // 暂停期间吞掉时间，恢复后不补偿（架构 6.2「暂停不补偿」）
      return;
    }
    const now = clock.now();
    let elapsed = now - lastPulseMs;
    if (elapsed < 0) elapsed = 0; // 防御：时钟回拨记 0
    const steps = Math.floor(elapsed / TICK_MS);
    if (steps > 0) {
      lastPulseMs += steps * TICK_MS; // 余量毫秒留给下一次，避免累积漂移
      // 上限保护：单次最多补 240 tick（60 秒），避免长时间挂起后一次性卡死（离线补算雏形）。
      const capped = steps > 240 ? 240 : steps;
      for (let i = 0; i < capped; i++) stepOnce();
    }
  }

  return {
    setPost(fn: (msg: FromWorkerMsg) => void): void {
      post = fn;
    },
    start(seed: number): void {
      state = deps.createInitialGameState(deps.config, seed);
      paused = false;
      lastPulseMs = clock.now();
      msSinceEnvelope = 0;
      pushProjection();
      pushEnvelope();
      clock.every(TICK_MS, tickLoop);
    },
    stop(): void {
      clock.clear();
    },
    handleMessage(msg: ToWorkerMsg): void {
      switch (msg.type) {
        case 'INIT': {
          state = deps.createInitialGameState(deps.config, msg.seed);
          paused = false;
          lastPulseMs = clock.now();
          msSinceEnvelope = 0;
          pushProjection();
          pushEnvelope();
          emit({ type: 'PAUSED_CHANGED', paused });
          break;
        }
        case 'RESET': {
          state = deps.createInitialGameState(deps.config, msg.seed);
          paused = false;
          lastPulseMs = clock.now();
          msSinceEnvelope = 0;
          pushProjection();
          pushEnvelope();
          break;
        }
        case 'DISPATCH_CMD': {
          // 幂等：以 cmdSeq 去重（同一 cmdSeq 重复送达安全忽略）。
          if (msg.cmdSeq <= state.dispatch.lastAppliedCmdSeq) {
            emit({ type: 'COMMAND_ACK', cmdSeq: msg.cmdSeq, ok: true, reason: 'DUPLICATE' });
            break;
          }
          state = deps.enqueueCommand(state, msg.cmd);
          emit({ type: 'COMMAND_ACK', cmdSeq: msg.cmdSeq, ok: true });
          // 入队后立即推一帧，让主线程尽快看到「按钮点击后」的反馈（可玩性）。
          pushProjection();
          break;
        }
        case 'SET_PAUSED': {
          paused = msg.paused;
          lastPulseMs = clock.now();
          emit({ type: 'PAUSED_CHANGED', paused });
          pushProjection();
          break;
        }
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
          break;
        }
      }
    },
    _peekTick(): number {
      return state.currentTick;
    },
  };
}

/**
 * serializeEnvelope：把完整状态序列化为「压缩信封」字面量字符串。
 *
 * 诚实边界：暂存包不引入 @genesis/save（fflate + base64url + CRC32），此处用 JSON 作为
 * 占位压缩格式，保证字段齐全、可往返；正式工程替换为 save 包的 encodeEnvelope（ADR-07）。
 * 这里显式剔除 Set（appliedCommandIds）等不可 JSON 化的结构，转为数组。
 */
export function serializeEnvelope(state: GameState): string {
  const applied = Array.from(state.dispatch.appliedCommandIds);
  const plain = {
    currentTick: state.currentTick,
    tickMs: state.tickMs,
    subMilli: state.subMilli,
    resources: state.resources,
    rates: state.rates,
    currentEra: state.currentEra,
    raceId: state.raceId,
    buildings: state.buildings,
    techs: state.techs,
    seasonIndex: state.seasonIndex,
    chainStates: state.chainStates,
    population: state.population,
    seed: state.seed,
    jobAssignments: state.jobAssignments,
    dispatch: {
      lastAppliedCmdSeq: state.dispatch.lastAppliedCmdSeq,
      appliedCommandIds: applied,
      pending: state.dispatch.pending,
    },
  };
  return JSON.stringify(plain);
}

/**
 * bootstrapWorker：真实 Worker 入口装配（在 worker 全局作用域调用）。
 *
 * 正式工程在此处 import 引擎与配置并组装 deps；暂存包用下方「内联引擎桩」作 deps，
 * 使本文件可独立运行/自检。本函数不在模块加载期调用，故可在其后引用 STAGING_ENGINE_DEPS。
 */
export function bootstrapWorker(scope: {
  onmessage: ((ev: { data: ToWorkerMsg }) => void) | null;
  postMessage: (msg: FromWorkerMsg) => void;
}): void {
  const clock: Clock = {
    now: () => Date.now(),
    every: (ms, fn) => {
      setInterval(fn, ms);
    },
    clear: () => {
      /* 正式工程保存 setInterval 句柄后 clearInterval；暂存包为单例循环，页面卸载整体销毁。 */
    },
  };
  const runtime = createWorkerRuntime(STAGING_ENGINE_DEPS, clock);
  runtime.setPost((msg) => scope.postMessage(msg));
  scope.onmessage = (ev) => runtime.handleMessage(ev.data);
  runtime.start(20261104);
}

// ===========================================================================
// 四、内联最小引擎桩（仅在暂存包独立自检时使用；正式工程删除本段）
// ===========================================================================
// 目的：让 worker.ts 脱离 w1–w5d 暂存目录时仍可 tsc --strict 通过、并在浏览器里跑起来。
// 只实现 FR-29 原型所需的简化子集：成本蠕变建造、按岗位产出、满仓归零、季节推进、人口增长。
// 真实四阶段结算（修饰器/断链/纪元门槛）由 @genesis/engine 在正式工程承载。

/** 内联桩：构造最小可玩配置（纪元 1 的资源/建筑/科技；资源用 id 作展示名占位）。 */
export const STAGING_CONFIG: GameConfig = {
  clock: { tickMs: 250, seasonSec: 900, seasonForewarnSec: 60 },
  chain: { starveRatio: 0.5, recoverRatio: 0.85 },
  resources: [
    { id: 'food', baseMax: 100 },
    { id: 'wood', baseMax: 100 },
    { id: 'stone', baseMax: 80 },
    { id: 'lore', baseMax: 100 },
  ],
  jobs: [
    { id: 'farmer', producesPerSec: { food: 0.4 } },
    { id: 'woodcutter', producesPerSec: { wood: 0.3 } },
    { id: 'scholar', producesPerSec: { lore: 0.1 } },
  ],
  buildings: [
    { id: 'field', eraIndex: 1, baseCost: { wood: 10 }, creepBase: 1.15, jobSlots: { farmer: 2 } },
    { id: 'lumber_camp', eraIndex: 1, baseCost: { food: 10 }, creepBase: 1.15, jobSlots: { woodcutter: 2 } },
    { id: 'study', eraIndex: 1, baseCost: { wood: 30 }, creepBase: 1.18, jobSlots: { scholar: 2 } },
    { id: 'hut', eraIndex: 1, baseCost: { wood: 15 }, creepBase: 1.22 },
  ],
  techs: [{ id: 'tool_making' }],
  seasons: [
    { id: 'spring', name: '春' },
    { id: 'summer', name: '夏' },
    { id: 'autumn', name: '秋' },
    { id: 'winter', name: '冬' },
  ],
  eras: [
    { index: 1, name: '篝火纪元' },
    { index: 2, name: '聚落纪元' },
  ],
};

/** 内联桩：构造初始状态。 */
function stagingCreateInitialState(config: GameConfig, seed: number): GameState {
  const resources: Record<string, { amount: number; max: number }> = {};
  for (const r of config.resources) resources[r.id] = { amount: 0, max: r.baseMax };
  return {
    currentTick: 0,
    tickMs: config.clock.tickMs,
    subMilli: 0,
    resources,
    rates: {},
    currentEra: 1,
    raceId: null,
    buildings: {},
    techs: [],
    seasonIndex: 0,
    chainStates: {},
    population: 0,
    seed,
    jobAssignments: {},
    dispatch: { lastAppliedCmdSeq: -1, appliedCommandIds: new Set<string>(), pending: [] },
  };
}

/** 内联桩：命令入队（等价 w5d enqueueCommand 语义，返回新 state）。 */
function stagingEnqueue(state: GameState, cmd: GameCommand): GameState {
  const seq = state.dispatch.lastAppliedCmdSeq + state.dispatch.pending.length + 1;
  const commandId = `cmd-${state.seed}-${seq}`;
  const pending = state.dispatch.pending.concat([{ commandId, cmdSeq: seq, cmd }]);
  return {
    ...state,
    dispatch: {
      lastAppliedCmdSeq: state.dispatch.lastAppliedCmdSeq,
      appliedCommandIds: new Set(state.dispatch.appliedCommandIds),
      pending,
    },
  };
}

/** 内联桩：单步推进（简化结算）。 */
function stagingGameTick(state: GameState, config: GameConfig): { state: GameState; events: unknown[] } {
  const next: GameState = {
    ...state,
    resources: {},
    rates: {},
    buildings: { ...state.buildings },
    techs: [...state.techs],
    chainStates: { ...state.chainStates },
    dispatch: {
      lastAppliedCmdSeq: state.dispatch.lastAppliedCmdSeq,
      appliedCommandIds: new Set(state.dispatch.appliedCommandIds),
      pending: [],
    },
  };
  for (const id of Object.keys(state.resources)) {
    const r = state.resources[id];
    if (r) next.resources[id] = { amount: r.amount, max: r.max };
  }

  const dtSec = next.tickMs / 1000;

  // 0) flush + 执行命令（简化 BUILD / RESEARCH / ADVANCE_ERA / ASSIGN_JOB）。
  for (const q of state.dispatch.pending) {
    const cmd = q.cmd;
    if (cmd.type === 'BUILD') {
      const bldg = config.buildings.find((b) => b.id === cmd.buildingId);
      if (bldg) {
        const cur = next.buildings[bldg.id] ?? { count: 0, active: 0 };
        // 成本蠕变系数：用循环乘（与引擎 fastPowInt 同理念，禁 Math.pow，保持确定性）。
        const creep = bldg.creepBase < 1.015 ? 1.015 : bldg.creepBase;
        let factor = 1;
        for (let k = 0; k < cur.count; k++) factor = factor * creep;
        let affordable = true;
        for (const resId of Object.keys(bldg.baseCost)) {
          const need = (bldg.baseCost[resId] ?? 0) * factor;
          const have = next.resources[resId]?.amount ?? 0;
          if (have + 1e-9 < need) affordable = false;
        }
        if (affordable) {
          for (const resId of Object.keys(bldg.baseCost)) {
            const r = next.resources[resId];
            if (r) r.amount = Math.max(0, r.amount - (bldg.baseCost[resId] ?? 0) * factor);
          }
          const newCount = cur.count + 1;
          next.buildings[bldg.id] = { count: newCount, active: newCount };
        }
      }
    } else if (cmd.type === 'RESEARCH') {
      if (!next.techs.includes(cmd.techId)) next.techs.push(cmd.techId);
    } else if (cmd.type === 'ADVANCE_ERA') {
      next.currentEra = next.currentEra + 1;
      next.seasonIndex = 0;
    } else if (cmd.type === 'ASSIGN_JOB') {
      const prev = next.jobAssignments[cmd.jobId] ?? 0;
      let target = prev + cmd.delta;
      if (target < 0) target = 0;
      next.jobAssignments = { ...next.jobAssignments, [cmd.jobId]: target };
    }
    if (q.cmdSeq > next.dispatch.lastAppliedCmdSeq) next.dispatch.lastAppliedCmdSeq = q.cmdSeq;
    next.dispatch.appliedCommandIds.add(q.commandId);
  }

  // 1) 产出：按建筑 jobSlots×活跃座数×产率，满仓归零。
  const workers: Record<string, number> = {};
  for (const bldg of config.buildings) {
    const b = next.buildings[bldg.id];
    if (!b || !bldg.jobSlots) continue;
    for (const jobId of Object.keys(bldg.jobSlots)) {
      workers[jobId] = (workers[jobId] ?? 0) + (bldg.jobSlots[jobId] ?? 0) * b.active;
    }
  }
  const pos: Record<string, number> = {};
  for (const job of config.jobs ?? []) {
    const w = workers[job.id] ?? 0;
    if (w <= 0 || !job.producesPerSec) continue;
    for (const rid of Object.keys(job.producesPerSec)) {
      pos[rid] = (pos[rid] ?? 0) + (job.producesPerSec[rid] ?? 0) * w;
    }
  }
  for (const res of config.resources) {
    const r = next.resources[res.id];
    if (!r) continue;
    let netRate = pos[res.id] ?? 0;
    if (r.amount >= r.max) netRate = 0; // 满仓归零
    next.rates[res.id] = netRate;
    let amt = r.amount + netRate * dtSec;
    if (amt < 0) amt = 0;
    if (amt > r.max) amt = r.max;
    r.amount = amt;
  }

  // 2) 人口缓慢增长。
  next.population = next.population + 0.05 * dtSec;

  // 3) 推进 tick + 季节派生（与引擎 computeSeasonIndex 同口径）。
  next.currentTick = state.currentTick + 1;
  const ticksPerSeason = Math.ceil((config.clock.seasonSec * 1000) / next.tickMs);
  if (ticksPerSeason > 0) {
    next.seasonIndex = Math.floor(next.currentTick / ticksPerSeason) % config.seasons.length;
  }

  return { state: next, events: [] };
}

/** 内联桩依赖包。 */
export const STAGING_ENGINE_DEPS: WorkerEngineDeps = {
  createInitialGameState: stagingCreateInitialState,
  gameTick: stagingGameTick,
  enqueueCommand: stagingEnqueue,
  config: STAGING_CONFIG,
};
