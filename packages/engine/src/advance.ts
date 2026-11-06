/**
 * W2 事件跳段内核 · Gate 2/S2 验收对象（返工批次 2 · 连续时间锚定）
 * ---------------------------------------------------------------------------
 * advance() 事件跳段内核（架构 5.2 单一结算内核 / 5.3 在线·后台·离线补算）。
 *
 * ══ 与 events.ts 配套的核心设计：两套时间概念分离 ═══════════════════════════
 *
 *  ① 模拟状态保留整数 frame：state.currentTick（整数）+ state.subMilli（亚 frame 毫秒）。
 *     二者共同把「连续模拟时间」无损表示为 simTimeMs = currentTick×tickMs + subMilli（毫秒）。
 *     存档/回放只需存这两个整数（subMilli 虽是小数，但范围 <tickMs，可定点存），回放逐位一致。
 *
 *  ② 另设「连续模拟时间」simTimeMs（浮点毫秒）。advance 内部以它为准推进；事件时刻统一用
 *     atMilli = Math.round(simTimeMs) 表示，**绝不用 currentTick×tickMs**。
 *
 *  ③ nextEventDistanceMs 返回「距事件的连续毫秒数（可小数）」，advance 每步：
 *        stepMs = min(所有源连续距离毫秒, 剩余预算毫秒)
 *     按 stepMs 精确推进 simTimeMs 与资源量（amount += rate×stepMs/1000），**绝不截断到整数
 *     frame**。只有当 simTimeMs 累积到完整 tick 时，currentTick 才作为「导数视图」被同步：
 *        currentTick = floor(simTimeMs / tickMs) ；subMilli = simTimeMs − currentTick×tickMs
 *     资源结算与事件触发完全基于 simTimeMs，与 tickMs 无关。tickMs 只决定「多久 push 一帧到
 *     前端」，不影响物理/事件。
 *
 *  ④ 事件触发：源用连续距离，advance 在 simTimeMs 到达该点的那一步结算事件，atMilli =
 *     round(simTimeMs)。同一物理过程（amount→max）在任何 tickMs 下 simTime 到达点相同，只要
 *     rate 与初值相同，atMilli 必然一致 —— 这就是 Gate 2-B「离散事件时刻一致」的实现机理。
 *
 * ══ 回归证据（返工批次 2 修复的 bug）═══════════════════════════════════════
 *  旧实现 nextEventDistanceTicks 返回整数 frame、advance 整 frame 推进、atMilli=frame×tickMs。
 *  于是同一物理过程在不同 tickMs 下被量化到不同 frame 末尾：
 *    amount=90.5, rate=1 → 真实到达 9.5s；旧 @100/250ms→9500，旧 @1000ms→10000（漂 500ms）。
 *    amount=95,   rate=0.7 → 真实到达≈7.142857s；旧 @100/250/1000→7200/7250/8000（漂 800ms）。
 *  新实现三档 atMilli 均为真实到达点（9500 / 7143），逐位一致；见 advance.gate2b.test.ts。
 *
 * ── 本文件逐条对应的验收条款（Gate 2 / S2 / 架构 5.2 / 5.3）────────────────
 *  [Gate 2-A] 步长不变性（连续量）：tickMs∈{100,250,1000} 三档推进同一初始状态与总时长，
 *             连续量（资源 amount）偏差 ≤ 0.1%（本实现为 0：三档推进完全相同的连续物理时长）。
 *  [Gate 2-B] 步长不变性（离散事件）：三档下离散事件序列（kind + atMilli）完全一致。
 *  [Gate 2-C] 资源边界精确切分：连续距离精确到边界，段按连续毫秒切到该点、不过冲。
 *  [Gate 2-D] 同引擎重复回放：同一输入 + 同一预算 → 逐位相同的事件序列与状态。
 *  [5.2-1]   段内资源按连续速率线性结算：amount += rate × 段长秒。
 *  [5.2.9]   资源边界事件求取（events.ts 的 A 源提供连续距离）。
 *  [5.3]     remainingMs 亚 tick 续算：以绝对目标时刻表达，绝不 ceil 成整 tick 重复推进。
 *  [5.2/5.6] 段末与结束的确定性不变量断言（见 assertInvariants）。
 *
 * ── 关于「状态推进」的约定 ─────────────────────────────────────────────────
 *  SimResult 不含 state 字段（任务固定接口），advance() 采用「就地推进」：直接就地修改传入的
 *  state.currentTick / state.resources / state.subMilli，并把事件与剩余预算通过返回值交回。
 *  调用方用同一份 state 连续调用即可拼接时间（组合律 advance(a)+advance(b) ≡ advance(a+b)）。
 */

import { DeterminismError, groupRank } from './events.js';
import type { EventGroup, EventSource, SimEvent, SimState } from './events.js';

export type { SimEvent, SimState, EventSource, EventGroup };
export { DeterminismError };

/** 判定「贴合边界」的相对容差基准。 */
const REL_EPS = 1e-9;
/** 判定「预算/段长≈0」的毫秒绝对容差（仅为吸收浮点末位，远小于 1ms）。 */
const EPS_MS = 1e-9;

function near(value: number, target: number): boolean {
  const scale = Math.max(1, Math.abs(target));
  return Math.abs(value - target) <= REL_EPS * scale;
}
/** 与 0 比较的绝对容差（资源量有界，绝对 1e-9 足够吸收末位误差）。 */
function nearZero(value: number): boolean {
  return Math.abs(value) <= REL_EPS;
}

/**
 * SegmentBudget：一次 advance 的预算（架构 5.3 补算入口的分段参数）。
 *
 *   - ticks：本次最多可推进的完整 tick 数（非负整数）＝ 物理时长 ticks×tickMs 毫秒。
 *   - remainingMs：亚 tick 毫秒余量（0 <= remainingMs < tickMs），代表本次「目标绝对时刻」
 *       的亚 tick 相位。本实现把预算解释为「推进到绝对目标时刻」：
 *           targetSimMs = (currentTick + ticks)×tickMs + remainingMs
 *       故本次实际推进的连续毫秒 = targetSimMs − (currentTick×tickMs + subMilli)。
 *       这在组合律 advance(a)+advance(b)≡advance(a+b) 下严格成立（见 advance.remainingMs.test.ts）。
 *   - maxSegmentsThisSlice：本次切片允许运行的最大段数（架构 5.3 MAX_SEGMENTS 的切片版），
 *       达到即返回，剩余留待下一次，防止事件过密时单次补算卡死。
 */
export interface SegmentBudget {
  ticks: number;
  remainingMs: number;
  maxSegmentsThisSlice: number;
}

/**
 * SimResult：一次 advance 的结果。
 *
 *   - events：本次推进产出的全部离散事件（按 atMilli、A→K 组、seq 稳定排列）。
 *   - segmentsRun：本次实际运行的段数（S2 段数分布观察量）。
 *   - ticksAdvanced：本次推进的完整 tick 数（= 结束 currentTick − 起始 currentTick 的导数差）。
 *   - remainingTicks：预算里尚未用掉、留给下一次的完整 tick 数（= 目标 currentTick − 当前 currentTick）。
 *   - remainingMs：结算后的亚 tick 相位（0 <= remainingMs < tickMs）＝ state.subMilli，回传下一次
 *       SegmentBudget.remainingMs（Gate 2 / 5.3 亚 tick 续算；绝不 ceil 成整 tick 重复推进）。
 *   - completed：本次预算是否已全部推进完（targetSimMs − simTimeMs ≈ 0）。
 */
export interface SimResult {
  events: SimEvent[];
  segmentsRun: number;
  ticksAdvanced: number;
  remainingTicks: number;
  remainingMs: number;
  completed: boolean;
}

/** 资源上限是否有限（Infinity / 非有限表示无上限）。 */
function isFiniteMax(max: number): boolean {
  return Number.isFinite(max);
}

/**
 * assertInvariants：确定性不变量断言（架构 5.2「阶段末断言」+ 5.6 算术约束）。
 *
 * 在「advance 入口」「每个段末」「整个 advance 结束」三处调用。逐条校验：
 *   [INV-1] amount 必须有限；max 允许 +Infinity，但不得为 NaN / -Infinity。
 *   [INV-2] amount >= 0（耗尽不得穿 0）。
 *   [INV-3] 若 max 有限：amount <= max（满仓不得过冲）。
 *   [INV-4] max >= 0。
 *   [INV-5] 人口非负（本暂存包以 resources 中的 'population' 键表示人口，须非负）。
 *   [INV-6] currentTick 为非负整数。
 *   [INV-7] subMilli ∈ [0, tickMs)（亚 frame 余量语义，绝不攒成整 frame）。
 *
 * 违反任一条 → 抛 DeterminismError（带稳定 code），形状固定、跨内核同一断言。
 * 容差 REL_EPS 只吸收浮点末位误差，不允许真正的越界蒙混。
 */
export function assertInvariants(state: SimState): void {
  const tickMs = state.tickMs;
  if (!(tickMs > 0) || !Number.isFinite(tickMs)) {
    throw new DeterminismError('INV_TICK_MS', `tickMs must be finite and > 0, got ${tickMs}`);
  }
  if (!Number.isInteger(state.currentTick) || state.currentTick < 0) {
    throw new DeterminismError('INV_CURRENT_TICK', `currentTick must be a non-negative integer, got ${state.currentTick}`);
  }
  if (!(state.subMilli >= 0 && state.subMilli < tickMs)) {
    throw new DeterminismError('INV_SUB_MILLI', `subMilli must satisfy 0 <= subMilli < tickMs, got ${state.subMilli} (tickMs=${tickMs})`);
  }
  for (const id of Object.keys(state.resources)) {
    const r = state.resources[id];
    if (r === undefined) continue;
    const { amount, max } = r;
    if (!Number.isFinite(amount)) {
      throw new DeterminismError('INV_AMOUNT_FINITE', `resource '${id}' amount is not finite: ${amount}`);
    }
    if (Number.isNaN(max) || max === Number.NEGATIVE_INFINITY) {
      throw new DeterminismError('INV_MAX_INVALID', `resource '${id}' max invalid: ${max}`);
    }
    if (max < 0) {
      throw new DeterminismError('INV_MAX_NEGATIVE', `resource '${id}' max < 0: ${max}`);
    }
    if (amount < -Math.abs(REL_EPS * Math.max(1, Math.abs(amount)))) {
      throw new DeterminismError('INV_AMOUNT_NEGATIVE', `resource '${id}' amount < 0: ${amount}`);
    }
    if (isFiniteMax(max) && amount > max + Math.abs(REL_EPS * Math.max(1, Math.abs(max)))) {
      throw new DeterminismError('INV_AMOUNT_OVER_MAX', `resource '${id}' amount exceeds max: amount=${amount}, max=${max}`);
    }
    if (id === 'population' && amount < -Math.abs(REL_EPS * Math.max(1, Math.abs(amount)))) {
      throw new DeterminismError('INV_POPULATION_NEGATIVE', `population amount < 0: ${amount}`);
    }
  }
}

/**
 * settleContinuous：段内线性结算（架构 5.2「段内速率为常数」的解析式推进）。
 *
 *   stepSec = stepMs / 1000（游戏秒）
 *   amount += rate × stepSec            [5.2-1]
 *
 * 本函数只做「连续速率线性结算」这一层；断链满载/欠载切分、电网分配、工坊转化等由后续
 * 里程碑在阶段函数内实现，不改变「按连续距离切段、段内常数速率」的语义。
 * 确定性依据（Gate 2）：单次 + − × ／，IEEE-754 正确舍入，跨内核一致（架构 5.6）。
 */
function settleContinuous(state: SimState, stepMs: number): void {
  const stepSec = stepMs / 1000;
  for (const id of Object.keys(state.resources)) {
    const r = state.resources[id];
    if (r === undefined) continue;
    const rate = state.rates[id] ?? 0;
    if (rate === 0) continue;
    r.amount = r.amount + rate * stepSec;
  }
}

/**
 * clampResourcesToBounds：边界钳制 + 贴边吸附（最后一道不变量保险）。
 *
 * 由于段按连续距离精确切到边界，到达点越过量仅为浮点末位（~1e-12，远 <1e-6），本函数做两件事：
 *   1) 硬钳制（无条件，守 INV-2/INV-3）：amount<0 → 0；有限 max 且 amount>max → max。
 *   2) 方向性贴边吸附（消除浮点残差，防近零距离抖动/重复事件）：
 *        - 增长型（rate>0）逼近有限 max → 精确置 max；
 *        - 消耗型（rate<0）逼近 0 → 精确置 0。
 *      按速率方向吸附：避免把「缓慢增长中、尚处极小值」的资源误吸附成 0，从而扭曲连续量。
 * 它绝不用于掩盖「段长切错」——段长由连续距离精确切分，钳制/吸附只做最后保险。
 */
function clampResourcesToBounds(state: SimState): void {
  for (const id of Object.keys(state.resources)) {
    const r = state.resources[id];
    if (r === undefined) continue;
    const rate = state.rates[id] ?? 0;
    if (isFiniteMax(r.max)) {
      const scale = Math.max(1, Math.abs(r.max));
      if (r.amount > r.max) {
        r.amount = r.max; // 硬钳制
      } else if (rate > 0 && r.max - r.amount <= REL_EPS * scale) {
        r.amount = r.max; // 增长型逼近满仓：吸附到 max
      }
    }
    const scale0 = Math.max(1, Math.abs(r.amount));
    if (r.amount < 0) {
      r.amount = 0; // 硬钳制
    } else if (rate < 0 && r.amount <= REL_EPS * scale0) {
      r.amount = 0; // 消耗型逼近空：吸附到 0
    }
  }
}

/**
 * collectBoundaryEvents：段末/事件点结算「A 资源边界」事件（架构 5.2 事件点 1）。
 *
 * 用「段初快照 startAmounts」判定本段是否发生边界跃迁，避免「用当前值反推」产生伪事件：
 *   - 增长型（rate>0，有限 max）：段初尚未满仓、段末已满仓 → 'resource.cap'。
 *   - 消耗型（rate<0）：段初尚有库存、段末已耗尽 → 'resource.empty'。
 * 「段初已贴边」（持续满仓/耗尽）不产事件，保证一个边界只在跃迁那一步产出一次。
 *
 * 事件 atMilli = Math.round(simTimeMs)（连续时间取整毫秒），跨 tickMs 对齐 —— Gate 2-B 口径。
 * 同一时刻固定顺序组 A→K：先按 group 升序、再按 source 注册顺序、最后按资源声明顺序产出。
 */
function collectBoundaryEvents(
  state: SimState,
  sources: EventSource[],
  startAmounts: Record<string, number>,
  simTimeMs: number,
): SimEvent[] {
  const events: SimEvent[] = [];
  const atMilli = Math.round(simTimeMs);
  const orderedSources = sources
    .map((s, idx) => ({ s, idx }))
    .sort((a, b) => {
      const ga = groupRank(a.s.group);
      const gb = groupRank(b.s.group);
      if (ga !== gb) return ga - gb;
      return a.idx - b.idx; // 稳定：同组保持注册顺序
    });
  let localSeq = 0;
  for (const { s } of orderedSources) {
    if (s.kind !== 'resource.boundary') continue; // 本批仅 A 资源边界源；其余源未来扩展
    for (const id of Object.keys(state.resources)) {
      const r = state.resources[id];
      if (r === undefined) continue;
      const rate = state.rates[id] ?? 0;
      if (rate === 0) continue;
      const start = startAmounts[id];
      if (start === undefined) continue;
      if (rate > 0 && isFiniteMax(r.max)) {
        // 段初未满、段末已满 → 到达上限（只报一次跃迁）
        if (!near(start, r.max) && start < r.max && near(r.amount, r.max)) {
          events.push({ atMilli, seq: localSeq++, group: s.group, kind: 'resource.cap', payload: { resourceId: id, amount: r.amount, max: r.max } });
        }
      } else if (rate < 0) {
        // 段初有量、段末耗尽 → 降到 0（只报一次跃迁）
        if (!nearZero(start) && start > 0 && nearZero(r.amount)) {
          events.push({ atMilli, seq: localSeq++, group: s.group, kind: 'resource.empty', payload: { resourceId: id, amount: r.amount } });
        }
      }
    }
  }
  return events;
}

/** 段初资源快照（用于边界跃迁判定）。 */
function snapshotAmounts(state: SimState): Record<string, number> {
  const snap: Record<string, number> = {};
  for (const id of Object.keys(state.resources)) {
    const r = state.resources[id];
    if (r === undefined) continue;
    snap[id] = r.amount;
  }
  return snap;
}

/**
 * minEventDistanceMs：求全体事件源中「距下一个事件的连续毫秒数」的最小值。
 *
 * 返回：>=0 的连续毫秒（可为小数）或 +Infinity（无事件）。0 表示「即时事件」。
 * 负距离属于源的确定性违约 → 抛 EVENT_DISTANCE_NEGATIVE。
 * 注意：**不做任何 frame/floor**，直接返回连续毫秒；段长切分因此不受 tick 限制。
 */
function minEventDistanceMs(sources: EventSource[], state: SimState): number {
  let best = Number.POSITIVE_INFINITY;
  for (const s of sources) {
    const d = s.nextEventDistanceMs(state);
    if (!Number.isFinite(d)) {
      if (d === Number.NEGATIVE_INFINITY) {
        throw new DeterminismError('EVENT_DISTANCE_NEGATIVE', `source '${s.kind}' returned -Infinity`);
      }
      continue; // +Infinity：无事件
    }
    if (d < 0) {
      throw new DeterminismError('EVENT_DISTANCE_NEGATIVE', `source '${s.kind}' returned negative distance ${d}`);
    }
    if (d < best) best = d;
  }
  return best;
}

/** 由连续毫秒 simTimeMs 反推 (currentTick, subMilli) 导数视图，并就地写回 state。 */
function syncDerivedFrame(state: SimState, simTimeMs: number): void {
  const tickMs = state.tickMs;
  let tick = Math.floor(simTimeMs / tickMs);
  let sub = simTimeMs - tick * tickMs;
  // 把 sub 校正到 [0, tickMs)（消除浮点越界，仅可能 ±1 frame 的末位误差）
  if (sub < 0) {
    tick -= 1;
    sub += tickMs;
  } else if (sub >= tickMs) {
    tick += 1;
    sub -= tickMs;
  }
  state.currentTick = tick;
  state.subMilli = sub;
}

/**
 * advance：唯一的时间推进入口（本暂存包的事件跳段内核，架构 5.2 / 5.3）。
 *
 * 主循环（每段，段长以毫秒计、不受 tick 限制）：
 *   1. 剩余预算毫秒 budgetLeftMs = targetSimMs − simTimeMs。
 *   2. minDist = 全体事件源连续距离毫秒的最小值。
 *   3. 若 minDist == 0 → 即时事件分支（不推进时间，先尝试结算；无事件可结算则抛错防死循环）。
 *   4. 否则 stepMs = min(minDist, budgetLeftMs)：
 *        settleContinuous(stepMs) → simTimeMs += stepMs → budgetLeftMs −= stepMs →
 *        clamp/吸附 → syncDerivedFrame（currentTick 只作导数视图）→ 结算该点的边界事件。
 *   5. 累计 segmentsRun；预算耗尽或段数达 maxSegmentsThisSlice → 返回。
 *
 * 预算即「绝对目标时刻」targetSimMs = (currentTick + ticks)×tickMs + remainingMs；本次推进的
 * 连续毫秒 = targetSimMs − (currentTick×tickMs + subMilli)。这保证：同一物理过程在任何 tickMs 下
 * 推进到相同的绝对连续时刻 → 事件 atMilli 一致（Gate 2-B），且组合律严格成立。
 *
 * 确定性依据（Gate 2/S2）：纯数值推进，无随机/时钟/环境依赖；事件按 atMilli、A→K 组、seq 稳定
 * 产出；同一输入 → 同一输出（逐位）。
 */
export function advance(state: SimState, budget: SegmentBudget, sources: EventSource[]): SimResult {
  const tickMs = state.tickMs;
  if (!(tickMs > 0) || !Number.isFinite(tickMs)) {
    throw new DeterminismError('INV_TICK_MS', `tickMs must be finite and > 0, got ${tickMs}`);
  }
  if (!Number.isInteger(budget.ticks) || budget.ticks < 0) {
    throw new DeterminismError('BUDGET_TICKS', `budget.ticks must be a non-negative integer, got ${budget.ticks}`);
  }
  if (!(budget.remainingMs >= 0 && budget.remainingMs < tickMs)) {
    throw new DeterminismError('BUDGET_REMAINING_MS', `budget.remainingMs must satisfy 0 <= remainingMs < tickMs, got ${budget.remainingMs} (tickMs=${tickMs})`);
  }
  if (!Number.isInteger(budget.maxSegmentsThisSlice) || budget.maxSegmentsThisSlice < 0) {
    throw new DeterminismError('BUDGET_MAX_SEGMENTS', `budget.maxSegmentsThisSlice must be a non-negative integer, got ${budget.maxSegmentsThisSlice}`);
  }

  // 入口不变量断言（非法状态在此以稳定 code 抛出，便于「非法状态抛 code 错误」的断言）。
  assertInvariants(state);

  // ── 绝对目标时刻 & 本次连续推进预算（毫秒）──
  const startTick = state.currentTick;
  const startSimMs = state.currentTick * tickMs + state.subMilli;
  const targetTick = state.currentTick + budget.ticks; // 目标 frame（导数视图）
  const targetSimMs = targetTick * tickMs + budget.remainingMs; // 目标绝对连续时刻
  let budgetLeftMs = targetSimMs - startSimMs;
  if (budgetLeftMs < -EPS_MS) {
    throw new DeterminismError('BUDGET_NEGATIVE_DURATION', `budget resolves to negative duration: target ${targetSimMs} < start ${startSimMs}`);
  }
  if (budgetLeftMs < 0) budgetLeftMs = 0;

  let simTimeMs = startSimMs; // 连续模拟时间（毫秒，浮点）
  const allEvents: SimEvent[] = [];
  let segmentsRun = 0;
  let runningSeq = 0; // 跨段全局序号，保证稳定全序

  while (budgetLeftMs > EPS_MS && segmentsRun < budget.maxSegmentsThisSlice) {
    // minDist：全体源连续距离最小值（>=0，负数已在 minEventDistanceMs 抛错；+Infinity 表无事件）。
    const minDist = minEventDistanceMs(sources, state);

    if (minDist <= 0) {
      // ── 即时事件分支（距离==0：不推进时间，先结算即时事件）──
      // 内置 A 源对「已贴边资源」返回 Infinity、对外部可达点返回严格正值，正常不会返回 0；
      // 故此处仅为未来「当前时刻即到期」的外部事件源预留。若既无可结算事件又无法推进 → 抛错防死循环。
      const snap = snapshotAmounts(state);
      const immediate = collectBoundaryEvents(state, sources, snap, simTimeMs);
      if (immediate.length === 0) {
        throw new DeterminismError('ZERO_DISTANCE_NO_EVENT', `minEventDistanceMs == 0 but no immediate event can be settled at simTimeMs=${simTimeMs}`);
      }
      for (const e of immediate) allEvents.push({ ...e, seq: runningSeq++ });
      segmentsRun++;
      assertInvariants(state);
      continue;
    }

    const stepMs = Math.min(minDist, budgetLeftMs);
    const startAmounts = snapshotAmounts(state);
    settleContinuous(state, stepMs); // [5.2-1]
    simTimeMs += stepMs; // 连续推进（不截断到整数 frame，不经 tickMs）
    budgetLeftMs -= stepMs;
    clampResourcesToBounds(state); // 边界钳制 + 贴边吸附（最后保险）
    syncDerivedFrame(state, simTimeMs); // currentTick 只作 simTimeMs 的导数视图
    const segEvents = collectBoundaryEvents(state, sources, startAmounts, simTimeMs); // 该点结算
    for (const e of segEvents) allEvents.push({ ...e, seq: runningSeq++ });

    segmentsRun++;
    assertInvariants(state); // 段末不变量断言
  }

  // ── 收尾：预算若仅剩浮点末位则吸附到目标，重算导数视图 ──
  let leftoverMs = targetSimMs - simTimeMs;
  if (leftoverMs <= EPS_MS) {
    leftoverMs = 0;
    simTimeMs = targetSimMs;
    syncDerivedFrame(state, simTimeMs);
  }

  const remainingTicks = targetTick - state.currentTick; // 尚未推进的完整 tick 数
  // remainingMs 直接取结算后的亚 tick 相位 state.subMilli（与返回的 state 永远自洽）：
  //   - 预算耗尽时 state.subMilli == budget.remainingMs（见收尾吸附）；
  //   - 段数达上限提前返回时，state.subMilli 是「实际已推进到的相位」，供下一次续算。
  const remainingMs = state.subMilli;
  const completed = leftoverMs === 0; // simTimeMs 已到达 targetSimMs

  assertInvariants(state); // 整个 advance 结束不变量断言

  // 事件全局排序：atMilli → A→K 组 → seq，保证同一时刻 A→K 且跨内核稳定。
  allEvents.sort((a, b) => {
    if (a.atMilli !== b.atMilli) return a.atMilli - b.atMilli;
    const ga = groupRank(a.group);
    const gb = groupRank(b.group);
    if (ga !== gb) return ga - gb;
    return a.seq - b.seq;
  });

  const ticksAdvanced = state.currentTick - startTick;

  return { events: allEvents, segmentsRun, ticksAdvanced, remainingTicks, remainingMs, completed };
}
