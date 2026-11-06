/**
 * W3 dispatch 命令层 · 架构 6.1/7.2 验收对象
 * ---------------------------------------------------------------------------
 * M1 W3 核心：命令权威入口（架构 6.1 线程职责与消息契约 · WAL）与崩溃恢复 /
 * 幂等去重（架构 7.2 写入顺序与启动恢复）。
 *
 * 本文件是「把一条玩家命令确定性地落进引擎状态」的最小可验证实现：它把
 *   ① 幂等权威键（commandId）
 *   ② 单调排序键（cmdSeq）
 *   ③ 由调用方注入的权威时刻（atTick）
 * 三件事拆清楚，从而保证：
 *   - 重复派发同一条命令（网络重发、应急槽重放、恢复重放）不产生二次副作用；
 *   - 崩溃后按 WAL 重放，结果与「从未崩溃一次跑完」逐位一致（关键验收）；
 *   - 引擎自身绝不读取时钟 / 随机数（确定性，架构 5.6、7.2）。
 *
 * ── 设计约束（逐条对应任务背景，缺一不可）────────────────────────────────
 *  [C1] Worker 赋权威 atTick：命令对象本身不带 atTick。atTick 由 Worker 宿主在
 *       dispatch 时显式传入，引擎只把它当作「权威时刻」记下（appliedAtTick），
 *       绝不自行生成。引擎内禁止 Date.now / performance.now。
 *  [C2] 幂等去重：commandId 是幂等权威键，cmdSeq 仅用于排序。dispatch 用
 *       appliedCommandIds 判重，命中即返回 { ok:true, duplicate:true }，不碰状态。
 *  [C3] lastAppliedCmdSeq 提交边界：记录已应用到的最大 cmdSeq（只增不减）。恢复时
 *       cmdSeq <= lastAppliedCmdSeq 或 commandId 已在 appliedCommandIds 中 → 跳过重放。
 *  [C4] 恢复重放：recoverFromWal 按 cmdSeq 升序逐条 dispatch，已应用的跳过；重放
 *       结果与「从未崩溃一次跑完」逐位一致。
 *  [C5] 命令有效性：dispatch 先校验先决条件 → 失败返回 { ok:false, reason }，不改状态
 *       （拒绝不产生副作用）。
 *  [C6] 确定性：命令应用只用整数 / 确定运算，不依赖时间 / 随机。
 *
 * ── 幂等去重与恢复重放为何正确（对应「特别说明」）────────────────────────
 *  设某进程「从未崩溃一次跑完」的权威结果记为 S*。它等价于：初始状态依次 dispatch
 *  了 WAL 中的全部条目（每个 commandId 恰应用一次）。现在考虑崩溃恢复场景：
 *    - 崩溃前已把前 N 条应用进 state（用同一套 dispatch 逻辑），于是
 *      state.appliedCommandIds 恰为这 N 条的 commandId 集合，
 *      state.lastAppliedCmdSeq = 这 N 条里最大的 cmdSeq（记作 N*）。
 *    - 应急槽 WAL 含全部 N+M 条（含已应用的 N 条 + 未应用的 M 条）。
 *  恢复时 recoverFromWal 按 cmdSeq 升序逐条 dispatch：
 *    ① 对前 N 条：要么 commandId 已在 appliedCommandIds（C2 命中 → duplicate，不改状态），
 *       要么 cmdSeq <= lastAppliedCmdSeq（C3 命中 → 跳过）。两条判据都指向「已应用」，
 *       因此它们一律被跳过、不产生任何副作用。这两条判据同时存在是刻意的冗余：
 *       commandId 覆盖「不连续但已应用」的条目，lastAppliedCmdSeq 覆盖「连续已提交」的
 *       边界；任一成立即安全跳过。
 *    ② 对后 M 条：commandId 不在集合、cmdSeq > lastAppliedCmdSeq，故正常应用，
 *       且应用顺序与一次跑完时的顺序一致（同一套 dispatch，cmdSeq 升序）。
 *  于是恢复后的 appliedCommandIds / lastAppliedCmdSeq / 资源与计数，与 S* 在「应用过的
 *  条目集合」与「最终状态」上完全一致 —— 逐位一致。
 *  关键点：dispatch 是纯函数式增量（同一状态 + 同一命令 → 同一结果），且拒绝的命令
 *  在两种流程里以同样方式失败、同样不改变状态，故不会出现「一次跑完成功、重放失败」
 *  或相反的分叉。
 *
 * 注：本暂存包先定义局部最小 GameCommand 子集（C 的 ADD_RESOURCE / SUB_RESOURCE /
 * SET_COUNT），避免跨包依赖；最终并入 packages/engine 时改用 @genesis/engine 的正式
 * GameCommand（见文件内 TODO 标注）。
 */

// ---------------------------------------------------------------------------
// WAL 与命令类型
// ---------------------------------------------------------------------------

/**
 * WalEntry：预写日志条目（架构 6.1 消息契约 `WalEntry` 的最小投影）。
 *
 * 架构 6.1 原始定义为 `{ cmdSeq; atTick; cmd }`，把 atTick 内联在日志条目里，作为
 * 「崩溃后先把状态 advance 到该 atTick 再执行命令」的锚点（架构 7.2 启动恢复第 3 步）。
 * 本暂存包按任务 C1 把 atTick 从命令对象 `cmd` 中剥离（cmd 不带 atTick），改由 dispatch
 * 的 atTick 参数显式传入；WalEntry 这里保留 commandId 作为幂等权威键（正式引擎会由
 * 宿主随命令一并记录，用于对账）。
 *
 * TODO(engine): 并入 packages/engine 后，用 @genesis/engine 的正式 WAL 类型；若采用
 * 架构 6.1 的 `{ cmdSeq; atTick; cmd }` 形状，则 recoverFromWal 直接读取 entry.atTick
 * 作为 dispatch 的 atTick 参数，其余逻辑不变。
 */
export interface WalEntry {
  /** 幂等权威键：稳定唯一，重发 / 重放时用于去重。 */
  commandId: string;
  /** 单调排序键：仅用于排序与提交边界比较，不携带任何时刻语义。 */
  cmdSeq: number;
  /** 命令本身：**不含 atTick**（atTick 由 dispatch 参数注入，见 C1）。 */
  cmd: GameCommand;
}

/**
 * GameCommand：dispatch 命令层的最小可验证子集（正式引擎用 @genesis/engine 的联合）。
 *
 * 这是一个刻意最小化的集合，足以覆盖「幂等 / 排序 / 恢复重放 / 先决条件拒绝 / 权威
 * atTick」全部验收点，同时避免在暂存包引入跨包依赖：
 *   - ADD_RESOURCE：给资源加上 amount（应用时按 max 封顶）。
 *   - SUB_RESOURCE：从资源扣掉 amount（先决条件：不得超量，否则拒绝）。
 *   - SET_COUNT：把一个命名计数设为 value（幂等的绝对赋值，天然适合演示重放一致性）。
 *
 * TODO(engine): 并入 packages/engine 后改用 @genesis/engine 的 GameCommand（CHOOSE_RACE /
 * BUILD / RESEARCH … 全量联合）；届时本层只保留 dispatch 的幂等 / WAL / 恢复骨架。
 */
export type GameCommand =
  | { type: 'ADD_RESOURCE'; resId: string; amount: number }
  | { type: 'SUB_RESOURCE'; resId: string; amount: number }
  | { type: 'SET_COUNT'; key: string; value: number };

/**
 * CommandResult：dispatch 的返回结果（对齐 @genesis/engine 的 CommandResult，增补字段）。
 *
 *   - ok：命令是否被接受（或作为重复而被安全忽略）。
 *   - duplicate：命中幂等判重时为 true（此路径 ok 也为 true，但无任何副作用）。
 *   - reason：失败原因码（snake_case 大写常量，由本地化表翻译；引擎里不写自然语言）。
 *   - appliedAtTick：命令被接受时记录其权威时刻（等于 dispatch 传入的 atTick，见 C1）。
 */
export interface CommandResult {
  ok: boolean;
  duplicate?: boolean;
  reason?: string;
  appliedAtTick?: number;
}

/**
 * DispatchState：dispatch 命令层的最小可序列化状态。
 *
 *   - currentTick：当前模拟帧（整数）。dispatch 本身**不改**它（推进是 advance 的职责），
 *       保留它只为与 W2 SimState 的 (currentTick, tickMs, subMilli, resources) 对齐，
 *       便于并入引擎时直接对接。
 *   - resources：资源表 { amount, max }（max = Infinity 表示无限）。应用时按 max 封顶。
 *   - counts：命名计数表（SET_COUNT 的目标），演示非资源类副作用的重放一致性。
 *   - lastAppliedCmdSeq：已应用到的最大 cmdSeq（提交边界，只增不减，见 C3）。
 *   - appliedCommandIds：已应用 commandId 集合（幂等权威键索引，见 C2）。
 *
 * TODO(engine): 并入 packages/engine 后并入完整 GameState；appliedCommandIds 与
 * lastAppliedCmdSeq 属于「命令提交元数据」，正式实现可能不进入规范状态哈希（架构 7.5
 * 排除保存序号类字段），但必须随存档持久化以支撑恢复去重。
 */
export interface DispatchState {
  currentTick: number;
  resources: Record<string, { amount: number; max: number }>;
  counts: Record<string, number>;
  lastAppliedCmdSeq: number;
  appliedCommandIds: Set<string>;
}

// ---------------------------------------------------------------------------
// 失败原因码（稳定常量；由本地化表翻译，引擎内不写自然语言）
// ---------------------------------------------------------------------------

/** 未知 / 不支持的命令类型。 */
export const REASON_UNKNOWN_COMMAND = 'UNKNOWN_COMMAND';
/** SUB_RESOURCE 超量（资源不足）。 */
export const REASON_INSUFFICIENT_RESOURCES = 'INSUFFICIENT_RESOURCES';
/** 数值字段非法（非有限数、amount 为负等确定性前置校验失败）。 */
export const REASON_INVALID_AMOUNT = 'INVALID_AMOUNT';

// ---------------------------------------------------------------------------
// 状态构造
// ---------------------------------------------------------------------------

/**
 * createDispatchState：构造初始 DispatchState。
 *
 * 初始约定（务必清晰，否则去重边界会错）：
 *   - lastAppliedCmdSeq = -1：表示「尚未应用任何命令」。要求 cmdSeq 从 0 起单调递增，
 *     -1 保证第一条 cmdSeq=0 的命令满足 `cmdSeq > lastAppliedCmdSeq`。
 *     若改用 0，则第一条 cmdSeq=0 的命令会被 C3 判据误当作「已提交」而跳过，故用 -1。
 *   - appliedCommandIds 为空集。
 *   - resources / counts 由调用方按需填（默认空）。
 *
 * 确定性依据（C6）：纯构造，不读时钟 / 随机。
 */
export function createDispatchState(): DispatchState {
  return {
    currentTick: 0,
    resources: {},
    counts: {},
    lastAppliedCmdSeq: -1,
    appliedCommandIds: new Set<string>(),
  };
}

// ---------------------------------------------------------------------------
// 先决条件校验（拒绝不产生副作用，见 C5）
// ---------------------------------------------------------------------------

/**
 * validateCommand：纯前置校验，返回 null 表示通过，否则返回稳定原因码。
 *
 * 只做「会决定命令能否应用」的确定性检查，绝不修改 state：
 *   - 未知命令类型 → UNKNOWN_COMMAND。
 *   - 数值非法（amount / value 非有限、ADD/SUB 的 amount 为负）→ INVALID_AMOUNT。
 *   - SUB_RESOURCE 超量（目标资源存在且 amount < 扣除量）→ INSUFFICIENT_RESOURCES。
 *
 * 确定性依据（C6）：只读 state 的数值字段，做整数 / 有限性比较，无时钟 / 随机。
 */
function validateCommand(state: DispatchState, cmd: GameCommand): string | null {
  switch (cmd.type) {
    case 'ADD_RESOURCE': {
      if (!Number.isFinite(cmd.amount) || cmd.amount < 0) return REASON_INVALID_AMOUNT;
      return null;
    }
    case 'SUB_RESOURCE': {
      if (!Number.isFinite(cmd.amount) || cmd.amount < 0) return REASON_INVALID_AMOUNT;
      const res = state.resources[cmd.resId];
      // 资源不存在时可用量为 0；扣除正数即视为不足。
      const available = res === undefined ? 0 : res.amount;
      if (cmd.amount > available) return REASON_INSUFFICIENT_RESOURCES;
      return null;
    }
    case 'SET_COUNT': {
      if (!Number.isFinite(cmd.value)) return REASON_INVALID_AMOUNT;
      return null;
    }
    default: {
      // 运行期防御：GameCommand 在类型上是封闭联合，但 WAL / 消息在正式引擎里可能携带
      // 未受信任或旧版本的命令，故运行期仍要拒绝未知类型（架构 6.1 命令权威入口的输入
      // 校验）。REASON_UNKNOWN_COMMAND 为稳定原因码。
      // 同时保留编译期穷尽性：若联合新增分支而未在上方处理，下面 `never` 赋值会报错。
      const _exhaustive: never = cmd;
      void _exhaustive;
      return REASON_UNKNOWN_COMMAND;
    }
  }
}

// ---------------------------------------------------------------------------
// 应用副作用（仅在通过幂等与前置校验后调用；见 C2 / C5）
// ---------------------------------------------------------------------------

/**
 * applyCommand：把命令副作用写进 state（纯确定性整数运算）。
 *
 * 前置：已通过 validateCommand。此处不再做任何可能失败的校验，避免「半应用」。
 *   - ADD_RESOURCE：amount 增加并按 max 封顶（Infinity 不封顶）。
 *   - SUB_RESOURCE：amount 扣减（已保证不超量，结果 >= 0）。
 *   - SET_COUNT：counts[key] 绝对赋值。
 *
 * 确定性依据（C6）：只用 + - 与 min / 赋值，不读时钟 / 随机 / 环境。
 */
function applyCommand(state: DispatchState, cmd: GameCommand): void {
  switch (cmd.type) {
    case 'ADD_RESOURCE': {
      const res = state.resources[cmd.resId];
      if (res === undefined) {
        // 首次出现的资源：以 max=Infinity 落库，再由封顶逻辑（此处 Infinity 不封）写入。
        state.resources[cmd.resId] = { amount: cmd.amount, max: Number.POSITIVE_INFINITY };
      } else {
        const next = res.amount + cmd.amount;
        res.amount = next > res.max ? res.max : next;
      }
      return;
    }
    case 'SUB_RESOURCE': {
      const res = state.resources[cmd.resId];
      // validateCommand 已保证可用量 >= amount，故此处 res 必存在或 amount 为 0。
      if (res !== undefined) {
        res.amount = res.amount - cmd.amount;
      }
      return;
    }
    case 'SET_COUNT': {
      state.counts[cmd.key] = cmd.value;
      return;
    }
    default: {
      // applyCommand 仅在 validateCommand 通过后被调用，未知类型已在 validate 阶段拒绝，
      // 正常不可达。保留 never 赋值以维持编译期穷尽性检查。
      const _exhaustive: never = cmd;
      void _exhaustive;
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// dispatch：命令权威入口（架构 6.1 命令派发 / 7.2 去重）
// ---------------------------------------------------------------------------

/**
 * dispatch：把一条命令确定性地应用到 state（引擎唯一的命令入口）。
 *
 * 架构依据：
 *   - 6.1 命令权威：命令由 Worker 宿主派发；atTick 由宿主在派发时显式传入并赋为权威
 *     时刻。命令对象不带 atTick，引擎不读时钟。
 *   - 7.2 恢复去重：commandId 幂等 + cmdSeq 提交边界，使重复 / 重放安全。
 *
 * 执行顺序（严格按 C2 → C5 → 应用 → C3/C2 记账）：
 *   1) 幂等判重（C2）：commandId 已在 appliedCommandIds → 直接返回 duplicate，不改状态。
 *   2) 先决条件校验（C5）：validateCommand 失败 → 返回 ok:false + reason，不改状态。
 *   3) 应用副作用：applyCommand（此时已知必然成功）。
 *   4) 记账：lastAppliedCmdSeq = max(旧, cmdSeq)（C3，只增不减）；
 *           appliedCommandIds.add(commandId)（C2）。
 *   5) 返回 { ok:true, appliedAtTick: atTick }（C1：权威时刻来自参数，非引擎自生成）。
 *
 * 参数：
 *   - state：就地修改的 DispatchState（引擎内唯一状态持有者）。
 *   - cmdSeq：单调排序 / 提交边界键（不携带时刻语义）。
 *   - commandId：稳定唯一幂等权威键。
 *   - cmd：命令本身（不带 atTick）。
 *   - atTick：由调用方（Worker 宿主）注入的权威时刻，原样记录为 appliedAtTick。
 *
 * 确定性依据（C6 / 架构 6.1 / 7.2）：不读 Date.now / performance.now / Math.random；
 * 副作用只用整数 / 确定运算；同一 (state, cmdSeq, commandId, cmd, atTick) 恒定同结果。
 */
export function dispatch(
  state: DispatchState,
  cmdSeq: number,
  commandId: string,
  cmd: GameCommand,
  atTick: number,
): CommandResult {
  // 1) 幂等判重（C2）：命中即安全忽略，不改任何状态、不重复副作用。
  if (state.appliedCommandIds.has(commandId)) {
    return { ok: true, duplicate: true };
  }

  // 2) 先决条件校验（C5）：失败不产生副作用。
  const reason = validateCommand(state, cmd);
  if (reason !== null) {
    return { ok: false, reason };
  }

  // 3) 应用副作用（已验证必然成功）。
  applyCommand(state, cmd);

  // 4) 提交记账（C3 提交边界只增不减；C2 幂等键入集合）。
  if (cmdSeq > state.lastAppliedCmdSeq) {
    state.lastAppliedCmdSeq = cmdSeq;
  }
  state.appliedCommandIds.add(commandId);

  // 5) 记录权威时刻（C1：来自参数，引擎绝不自行生成）。
  return { ok: true, appliedAtTick: atTick };
}

// ---------------------------------------------------------------------------
// recoverFromWal：恢复重放（架构 7.2 启动恢复）
// ---------------------------------------------------------------------------

/**
 * recoverFromWal：按 cmdSeq 升序重放 WAL，跳过已应用条目，补齐未应用条目。
 *
 * 架构依据：7.2 启动恢复第 3 步「按序对每条 WAL……再执行命令」；配合 6.1 的 WAL 契约。
 *
 * 算法（严格按 C3 / C4）：
 *   1) 复制 entries 并按 cmdSeq 升序稳定排序（先按 cmdSeq，相等时按 commandId 字典序
 *      决胜 —— 全序比较器，杜绝依赖 Array 稳定性或对象键顺序，架构 5.6）。
 *   2) 逐条判断是否「已应用」：
 *        a. commandId 已在 appliedCommandIds → 跳过（C2，覆盖不连续但已应用）；
 *        b. 否则若 cmdSeq <= lastAppliedCmdSeq → 跳过（C3，覆盖连续已提交边界）。
 *      两条判据同时存在是刻意的冗余（见文件头「为何正确」）。
 *   3) 未应用条目用 dispatch 应用（本最小 WalEntry 无 atTick，派发参数取中性 0；不写状态，
 *      故不影响逐位一致；正式引擎改传 entry.atTick，见下方函数体注释）。
 *   4) 统计 applied（本次真正应用条数）与 skipped（被跳过条数）。
 *
 * 参数：
 *   - entries：应急槽 / 输入日志中的全部 WAL 条目（可含已应用与未应用的混合，且可能乱序）。
 *   - state：就地恢复的 DispatchState（通常是「崩溃前已应用前 N 条」的快照状态）。
 *   - tickMs：帧毫秒基准。本实现不改 currentTick（推进是 advance 的职责），故仅保留参数
 *     以对齐宿主调用签名与未来「先 advance 到 entry 的 atTick 再 dispatch」的扩展点。
 *
 * 返回值：{ applied, skipped } 便于宿主记录恢复报告。
 *
 * 关键验收（C4）：恢复后状态与「从未崩溃一次跑完」逐位一致 —— 因为前 N 条被判重跳过、
 * 后 M 条按同一 dispatch、同一 cmdSeq 顺序补跑，最终 appliedCommandIds / lastAppliedCmdSeq /
 * resources / counts 与一次跑完完全相同。
 *
 * 确定性依据（C6）：排序用全序比较器；应用只用 dispatch 的确定运算；不读时钟 / 随机。
 */
export function recoverFromWal(
  entries: WalEntry[],
  state: DispatchState,
  tickMs: number,
): { applied: number; skipped: number } {
  // tickMs 目前不参与计算（currentTick 由 advance 维护）。显式空引用避免 noUnusedParameters，
  // 并保留为「先 advance 到 atTick 再 dispatch」的扩展点。
  void tickMs;

  // 1) 全序排序：cmdSeq 升序，相等时 commandId 字典序决胜（架构 5.6 全序比较器）。
  const sorted = entries.slice().sort((a, b) => {
    if (a.cmdSeq !== b.cmdSeq) return a.cmdSeq - b.cmdSeq;
    return a.commandId < b.commandId ? -1 : a.commandId > b.commandId ? 1 : 0;
  });

  let applied = 0;
  let skipped = 0;

  for (const entry of sorted) {
    // 2a) commandId 已应用 → 跳过（C2）。
    if (state.appliedCommandIds.has(entry.commandId)) {
      skipped += 1;
      continue;
    }
    // 2b) cmdSeq 落在已提交边界内 → 跳过（C3）。
    if (entry.cmdSeq <= state.lastAppliedCmdSeq) {
      skipped += 1;
      continue;
    }
    // 3) 未应用 → 用同一 dispatch 补跑。若命令本身非法被拒，它与「一次跑完」时同样
    //    被拒、同样不改变状态，因此不破坏逐位一致。
    //
    //    关于 atTick：本最小 WalEntry 按任务约定不含 atTick（命令不带 atTick）。恢复重放
    //    时用中性的 atTick=0 作为派发参数——它不会写进 DispatchState（appliedAtTick 仅作
    //    返回值、不被持久化），故不影响「逐位一致」的验收口径。正式引擎采用架构 6.1 的
    //    `{ cmdSeq; atTick; cmd }` 形状时，这里改传 entry.atTick（先 advance 到该 atTick
    //    再 dispatch，见架构 7.2 启动恢复第 3 步），其余逻辑不变。
    dispatch(state, entry.cmdSeq, entry.commandId, entry.cmd, 0);
    applied += 1;
  }

  return { applied, skipped };
}
