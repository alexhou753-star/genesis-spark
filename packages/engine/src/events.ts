/**
 * W2 事件跳段内核 · Gate 2/S2 验收对象（返工批次 2 · 连续时间锚定）
 * ---------------------------------------------------------------------------
 * 事件源登记表抽象（架构 5.2 单一结算内核 / 5.2.9 资源边界事件）。
 *
 * ══ 本次返工的核心变更：离散事件时刻从「frame 量化」改为「连续时间锚定」══
 *
 * 旧设计（已废弃）的致命缺陷：
 *   nextEventDistanceTicks 返回「距事件的整数 frame 数」，advance 以整 frame 推进，
 *   事件 atMilli = frame × tickMs。于是同一物理过程（amount→max）在不同 tickMs 下，
 *   真实到达时刻被量化到不同 frame 末尾：
 *     amount=90.5, rate=1  → 真实到达 9.5s。tickMs=100/250 时 floor 到第 95/38 frame，
 *       恰为 9500/9500ms；tickMs=1000 时 floor 到第 9 frame = 9000ms，但旧 advance 先
 *       clamp 到满仓再在段末结算、或亚 tick 分支把段长抬成 1 frame，最终报在 10000ms，
 *       漂移 500ms。amount=95, rate=0.7 → 真实到达 ≈7.142857s，三档更漂 7200/7250/8000ms。
 *   根因：事件时刻是 tickMs 的因变量（atMilli = frame×tickMs），而 frame 是 tickMs 的
 *   函数，量化点随 tickMs 移动 → 事件时刻漂移，违反 Gate 2-B（离散事件时刻一致）。
 *
 * 新设计（本文件 + advance.ts）把「两套时间概念」彻底分离：
 *   1. 模拟状态仍保留整数 frame（state.currentTick）+ subMilli —— 存档/回放需要整数。
 *   2. 另设「连续模拟时间」模拟秒 simTime（可为小数）。事件时刻统一用连续毫秒整数
 *      atMilli = Math.round(simTime × 1000) 表示，**不再用 frame×tickMs**。
 *   3. 事件源 nextEventDistanceMs(state) 返回「距事件的连续毫秒数（可为小数）」，不含
 *      任何 frame/floor。advance 每步 stepMs = min(所有源连续距离ms, 剩余预算ms)，按
 *      stepMs 精确推进 simTime 与资源量（amount += rate×stepMs/1000），**绝不截断到整数
 *      frame**。整数 currentTick 只是 simTime 的导数视图：currentTick = floor(simTime×1000
 *      /tickMs)。tickMs 只决定「多久 push 一帧到前端」，与物理/事件完全无关。
 *   4. 同一物理过程在任意 tickMs 下 simTime 到达点相同 → atMilli 必然一致（只要 rate 与
 *      初值相同）。这就是 Gate 2-B「离散事件时刻一致」的实现机理。
 *
 * ── Gate 2 / S2 合同（本文件承载事件源侧）───────────────────────────────────
 *   [Gate 2-B] 离散事件序列（kind + atMilli）对 tickMs 不变：源返回连续距离，不含 frame。
 *   [Gate 2-C] 资源边界精确切分：连续距离精确到边界，advance 按连续距离切段、不过冲。
 *   [5.2.9]   资源边界事件求取：未满且 rate>0 → 距满仓；有量且 rate<0 → 距耗尽；rate=0 跳过。
 *
 * 注：本暂存包先定义局部最小类型（SimEvent / SimState），避免跨包依赖；
 * 最终并入 packages/engine 时，SimEvent 换用 @genesis/engine 的正式定义，SimState 换用
 * @genesis/engine 的状态类型（见文件内 TODO 标注）。
 */

/**
 * SimEvent：一次结算产出的离散事件。
 *
 * 形状对齐 @genesis/engine 的 SimEvent：{ atMilli, seq, group, kind, payload }。
 *   - atMilli：事件发生的「绝对模拟时刻（毫秒）」= Math.round(simTime × 1000)。用连续时间
 *       折算的绝对毫秒而非 frame×tickMs，因为同一时长在不同 tickMs 下 frame 序号不同，且
 *       frame×tickMs 会把事件量化到不同 frame 末尾导致漂移；唯有「连续时间取整毫秒」能在
 *       任何 tickMs 下对同一物理到达点给出同一个整数，这正是 Gate 2-B 的比较口径。
 *   - seq：同一时刻内事件的全局稳定序号，用于固定产出顺序（架构 5.6 全序）。
 *   - group：同一时刻固定顺序组 A→K（见 EventGroup），保证结算顺序确定。
 *   - kind：事件种类（如 'resource.boundary' / 'resource.cap' / 'resource.empty'）。
 *   - payload：事件附带数据（资源 ID、触发边界类型、所在 frame 视图 等）。
 *
 * TODO(engine): 并入 packages/engine 后改用 @genesis/engine 的 SimEvent。
 */
export interface SimEvent {
  atMilli: number;
  seq: number;
  group: EventGroup;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * EventGroup：同一时刻固定顺序组 A→K（11 组）。
 *
 * 架构 5.2 规定一段内按阶段 1→4 顺序结算；这里把「同一时刻的离散事件」再细化为 11 个
 * 有序组 A→K，advance() 在同一时刻严格按 A→K 组顺序结算，避免因对象键枚举/插入顺序
 * 不同而产出不同事件序列（确定性要求，架构 5.6）。本批只用到 A 组（资源边界），其余为
 * 后续里程碑预留占位。
 */
export type EventGroup = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K';

/**
 * GROUP_ORDER：A→K 的固定序号表，供事件排序用（值越小越先结算）。
 * 用显式数组而非对象键枚举，杜绝依赖键顺序（架构 5.6「遍历顺序固定」）。
 */
export const GROUP_ORDER: readonly EventGroup[] = [
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K',
];

/** groupRank：返回组的排序权重（A=0 … K=10）。未知组保守排在最后。 */
export function groupRank(group: EventGroup): number {
  const i = GROUP_ORDER.indexOf(group);
  return i < 0 ? GROUP_ORDER.length : i;
}

/**
 * SimState：advance() 的最小可序列化状态（本暂存包的局部最小子集）。
 *
 * 只保留事件跳段内核用到的字段：
 *   - currentTick：当前绝对 frame（整数，只增不减）——**仅作 simTime 的导数视图 / 存档回放用**，
 *       由 advance 每步按 floor(simTime×1000/tickMs) 重算，不参与事件时刻计算。
 *   - tickMs：每 frame 毫秒基准，Gate 2 取 100 | 250 | 1000（生产固定 250）。**只决定「多久
 *       push 一帧到前端」，绝不影响物理/事件。**
 *   - subMilli：亚 frame 毫秒余量（0 <= subMilli < tickMs），= simTime 尚不足一个整 frame 的
 *       余额。仅用于存档/回放把 simTime 无损表示为 tick×tickMs + subMilli（不变量 INV-7）。
 *   - resources：资源表 { amount:当前量, max:上限（Infinity 表示无限）}。
 *   - rates：各资源当前净速率（单位：每秒；正=增长，负=消耗）。
 *
 * simTime 的来源（advance 逐步维护）：simTime = currentTick×tickMs/1000 + subMilli/1000。
 * 状态里不额外存一份易失同步的浮点 simTime 字段，始终由 (currentTick, subMilli, tickMs)
 * 确定性导出，从而存档只需存整数 currentTick 与 subMilli，回放逐位一致。
 *
 * TODO(engine): 并入 packages/engine 后改用 @genesis/engine 的完整状态类型；
 * 届时 population 作为 kind='population' 的资源并入 resources（架构 5.7 门槛口径）。
 */
export interface SimState {
  currentTick: number;
  tickMs: number;
  subMilli: number;
  resources: Record<string, { amount: number; max: number }>;
  rates: Record<string, number>;
}

/**
 * EventSource：事件源契约（架构 5.2 八类事件点统一抽象）。
 *
 *   - group：归属的同一时刻固定顺序组 A→K。
 *   - kind：该源产出的事件种类前缀/名称。
 *   - nextEventDistanceMs(state)：返回「距该源下一个事件的连续毫秒数」。
 *       无事件 → 返回 Infinity；有事件 → 返回 **非负** 的连续毫秒（可为小数，**不做任何
 *       frame/floor**）。返回 0 表示「即时事件」（当前时刻就应结算、推进不耗时），advance()
 *       会先结算该即时事件再继续。返回的是「距离」，以毫秒为单位、与时基（tickMs）无关，
 *       故同一 state 在不同 tickMs 下返回同一个连续距离（源内部只用 rate 与 amount/max 求
 *       物理到达时间，不读 tickMs），这是 Gate 2-B 的根基。
 *
 * 确定性依据（Gate 2/S2）：纯函数，仅读 state 的连续量（resources/rates），不读时钟/随机/
 * 环境，不读 tickMs（避免把 frame 量化带回距离里）；对同一物理 state 恒定返回同一距离。
 */
export interface EventSource {
  group: EventGroup;
  kind: string;
  nextEventDistanceMs(state: SimState): number;
}

/**
 * resourceBoundarySource：内置「A 资源边界」事件源（架构 5.2 事件点 1 / 5.2.9）。
 *
 * 求取规则（对齐架构 5.2 表第 1、3 行）：
 *   - 只对「未满仓且净速率为正」的资源求「距满仓还需多少毫秒」；已满仓资源不产生事件
 *     （边界稳态排除；否则一个满仓资源会把步长永远压成极小段）。
 *   - 只对「有库存且净速率为负」的资源求「距耗尽还需多少毫秒」；已耗尽资源不产生事件。
 *   - rate = 0 的资源既不增长也不消耗，不产生任何边界事件（返回 Infinity）。
 *
 * 计算过程（连续时间，**不涉及 tickMs / frame**）：
 *   每秒速率 rate（正=增长），距满仓需补 (max - amount)，到达耗时 = (max - amount) / rate 秒。
 *   距耗尽需耗 amount，到达耗时 = amount / (-rate) 秒。
 *   对全部候选取最小值，乘以 1000 得连续毫秒。全程只用 + - * / 与 min，不含 floor、不读
 *   tickMs——这正是「同一物理到达点在任何 tickMs 下距离相同」的来源。
 *
 * 浮点健壮性：到达耗时恒 >= 0。若 amount 已贴边（gap<=0 或 amount<=0 但 rate 方向相反）
 * 视为即时事件返回 0；正常 tick 对齐/非对齐场景都返回精确连续毫秒，交由 advance 精确切段。
 * 因按连续距离精确切段，到达点无需边界钳制（advance 的 clamp 仅作最后兜底不变量）。
 *
 * 确定性依据（Gate 2/S2）：只用 + - * / 与 min，遍历顺序用 resources 的声明顺序，不含超越
 * 函数、不读时钟/随机/tickMs；同一 state 恒定输出。返回 Infinity 表示本资源无边界事件。
 */
export function resourceBoundarySource(): EventSource {
  return {
    group: 'A',
    kind: 'resource.boundary',
    nextEventDistanceMs(state: SimState): number {
      let best = Number.POSITIVE_INFINITY;
      // 按 resources 的声明顺序遍历（架构 5.6：不依赖对象键枚举顺序由调用方保证 resources 为有序记录）。
      for (const id of Object.keys(state.resources)) {
        const res = state.resources[id];
        if (res === undefined) continue; // noUncheckedIndexedAccess 守卫
        const rate = state.rates[id] ?? 0; // 无速率视为 0（不产生事件）
        if (rate === 0) continue; // Gate 2：rate=0 不产生边界事件
        const amount = res.amount;
        const max = res.max;
        let seconds = Number.POSITIVE_INFINITY; // 距边界的连续秒数
        if (rate > 0 && Number.isFinite(max) && amount < max) {
          // 未满仓且增长 → 距满仓（连续秒）
          seconds = (max - amount) / rate;
        } else if (rate < 0 && amount > 0) {
          // 有库存且消耗 → 距耗尽（连续秒）
          seconds = amount / -rate;
        }
        if (seconds === Number.POSITIVE_INFINITY) continue; // 该资源无边界事件
        if (seconds <= 0) {
          // 已触边（浮点贴着边界）：即时事件
          if (0 < best) best = 0;
          continue;
        }
        const ms = seconds * 1000; // 连续毫秒（可为小数，不 floor）
        if (ms < best) best = ms;
      }
      return best;
    },
  };
}

/**
 * DeterminismError：确定性错误的统一载体（带 code）。
 *
 * 引擎在遇到不变量违背 / 非法状态时，抛出「类型与消息恒定」的错误对象，携带稳定 code，
 * 便于跨内核得到同一断言、并把诊断快照定级（架构 5.2/5.6「违反则中止当前步并生成诊断快照」）。
 * 不使用 Error 子类的堆栈差异做判据。
 */
export class DeterminismError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DeterminismError';
    this.code = code;
  }
}
