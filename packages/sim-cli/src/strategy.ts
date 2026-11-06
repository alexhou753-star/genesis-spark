/**
 * W5b 长期策略回归 · C1-C6 验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》批次 5b · 长期策略回归（六条约束可执行验证，对应《长期可玩性设计约束》C1-C6）。
 *
 * ── 本文件要做什么、绝对不做什么 ─────────────────────────────────────────────
 *   用「策略骨架仿真」验证长期可玩性的六条结构性质，**不依赖完整经济系统**。做法是把「决策维度」
 *   抽象成一个极简状态机：政体 / 种族 / 宇宙 / 重置层各是一个决策维度，选项只携带「修饰器」
 *   （modifiers，代表收益 / 代价）与「前置条件」（requirements）。于是 C1-C6 都能落成对状态机
 *   做差集 / 极值 / 求和 / 计数的**可证伪断言**，而无需真实玩法数值。
 *
 *   边界（务必理解，否则会把「未发现退化」误读成「证明了不腻」）：
 *     · 本文件所有判定都是**反向证伪**口径：「若出现某类结构性退化 → valid=false」。valid=true
 *       只意味着「在这组样本 / 骨架下未发现该退化」，**≠ 证明长期不腻**（见约束文档 §1.2 / §7）。
 *     · 这是静态交付物：断言在逻辑上可执行，但本文件不声称已在 vitest 环境实际运行通过。
 *
 * ── 与既有内核的关系（对齐 w5a-staging/sim.ts 的边界）─────────────────────────
 *   本文件是「策略层」验证，**不**复用 w5a 的事件跳段 / 回放 / tick 不变性内核（那是 5a 的
 *   「引擎可复现、可批量」）。这里的 StrategyState 是另一层抽象：它只表达「决策维度 + 修饰器」，
 *   数值由测试夹具注入，不来自真实经济系统。import 关系见文件末尾「依赖说明」。
 *
 * ── 设计约束（任务硬约束，逐条对照）─────────────────────────────────────────
 *   1) StrategyState：{ era; race; universe; government; resetLayer; resetCount; resources;
 *      modifiers }。每个字段是一个决策维度。整型计数用 resetCount；resources / modifiers 为数值表。
 *   2) StrategyOption：{ id; axis; modifiers; requirements? }。axis ∈ government|race|universe|
 *      resetLayer|star；每选项有修饰器与前置条件。
 *   3-8) 六个验证函数（见各函数头「对应 Cx」与「可证伪断言」）。
 *
 * ── 依赖说明（为何 import from './sim.js'）──────────────────────────────────
 *   任务要求「import 用相对路径 from './sim.js'（暂存包同级，最终并入 packages/sim-cli 时改为
 *   @genesis/sim-cli）」。本文件忠实沿用该指令引入 w5a 的类型锚点 SimState（仅类型用途），以显式
 *   声明「策略层状态与引擎状态同源」，同时不拖入任何运行期副作用（import type 在编译期被完全擦除）。
 *   注意：在 w5b-staging/ 暂存目录下并无 ./sim.js，故真正运行 / 类型检查时需把本文件并入
 *   packages/sim-cli/src/（与 sim.ts 同目录）。tsconfig 仅把 strategy.ts 纳入自检的前提即此——
 *   若单目录自检，需临时把该 import 指向 ../w5a-staging/sim.js。
 *
 *   TODO(sim-cli): 并入 packages/sim-cli 后，本行改为 import type { SimState } from '@genesis/sim-cli'；
 *     测试文件从 '../src/strategy.js' 命中本文件（见 strategy.test.ts 头部）。
 */

import type { SimState as EngineSimState } from './sim.js';

// ---------------------------------------------------------------------------
// 类型定义：策略骨架状态与策略选项
// ---------------------------------------------------------------------------

/**
 * StrategyState：策略骨架状态（任务硬约束 1）。每个字段是一个**决策维度**。
 *
 *   - era：纪元编号（整数，只增）。
 *   - race / universe / government / resetLayer：四个「离散决策维度」的当前取值（维度标签）。
 *   - resetCount：已执行的重置次数（整型计数；约束文档 T1 建议的 ResetLayerId 记录在此骨架中
 *       简化为一个计数，仅用于 C6「重置螺旋」风险信号的评估，不做多层并集）。
 *   - resources：资源表（维度无关的「量」）。C3 / C6 用它度量「收益 / 净增长」。
 *   - modifiers：修饰器表（收益 / 代价）。**键集合代表「可用决策维度集合 D_L」**（C1 用它做
 *       层间差集：D_L ≜ modifiers 的键集合）。值可正（收益）可负（代价）。resources 与 modifiers
 *       共同服务 C2「收益 ≥ 且代价 ≤」的占优判定。
 *
 * 注：EngineSimState（来自 './sim.js'）在此仅作「策略层状态与引擎 SimState 同源」的类型锚点，
 *   见下方 StrategyStateAnchor。二者字段不同（策略层是更高维的抽象），不互相包含。
 */
export interface StrategyState {
  era: number;
  race: string;
  universe: string;
  government: string;
  resetLayer: string;
  resetCount: number;
  resources: Record<string, number>;
  modifiers: Record<string, number>;
}

/**
 * StrategyStateAnchor：把「策略层状态」与「引擎 SimState」显式锚定在同一份类型来源上。
 *
 * 仅用于满足任务的 from './sim.js' 引用要求并留下可追溯的类型同源声明；它是一个**类型别名**，
 * 不产生运行期值、不引入副作用。并入 sim-cli 后可将真正的对接落在这里（例如把 StrategyState
 * 投影为一份 EngineSimState 供 5a 内核回放）。
 */
export type StrategyStateAnchor = StrategyState & {
  /** 引擎侧状态类型锚点（仅类型，永不赋值）。 */
  readonly __engineState?: EngineSimState;
};

/** 策略轴：政体 / 种族 / 宇宙 / 重置层 / 星级（任务硬约束 2）。 */
export type StrategyAxis = 'government' | 'race' | 'universe' | 'resetLayer' | 'star';

/**
 * StrategyOption：一个策略选项（任务硬约束 2）。
 *
 *   - id：选项唯一标识。
 *   - axis：所属策略轴。
 *   - modifiers：该选项提供的修饰器（收益 / 代价）。
 *   - requirements：前置条件（对当前局面的要求，如「需 era≥2」「需 resetCount≥1」等，字符串谓词）。
 *       受 exactOptionalPropertyTypes 影响，本字段为「可选存在」：要么不写，要么写 string[]。
 *       本文件所有验证函数对该字段只读不写，判定逻辑不依赖它（保留给上层策略生成器 / Bot 用）。
 */
export interface StrategyOption {
  id: string;
  axis: StrategyAxis;
  modifiers: Record<string, number>;
  requirements?: string[];
}

// ---------------------------------------------------------------------------
// 内部工具（纯函数、不依赖时钟 / 随机 / 环境，确定性）
// ---------------------------------------------------------------------------

/** sortedKeys：返回对象键的字典序排序副本（确定性遍历，杜绝依赖键枚举顺序）。 */
function sortedKeys(obj: Record<string, number>): string[] {
  return Object.keys(obj).sort();
}

/** keySet：返回对象键集合（Set，供差集 / 并集运算）。 */
function keySet(obj: Record<string, number>): Set<string> {
  return new Set(Object.keys(obj));
}

/** modValue：读修饰器值，缺失视为 0（noUncheckedIndexedAccess 下的安全读取）。 */
function modValue(mods: Record<string, number>, key: string): number {
  const v = mods[key];
  return v === undefined ? 0 : v;
}

/** round4：仅用于「总分」输出的展示归一，避免浮点尾差污染报告；不改变判定语义。 */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * finiteTree：断言一棵「数值树」不含 NaN / ±Infinity。
 *
 * 之所以要它：w4 的 canonicalize（hashState 的底层）会拒绝非有限数并抛 NON_FINITE。若测试夹具
 * 里混入 NaN/∞ 又拿去 hashState，就会在「断言之外」意外抛错。本函数把该风险就地、确定性地拦住。
 */
function assertFiniteTree(value: unknown, path: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`strategy 骨架含非有限数（${path}=${String(value)}），无法参与确定性判定`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertFiniteTree(v, `${path}[${i}]`));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) {
      assertFiniteTree((value as Record<string, unknown>)[k], `${path}.${k}`);
    }
  }
}

/**
 * yieldScore：把一份「正向修饰器」按**局面资源权重**折算成一个标量收益分（点积）。
 *
 * 口径：yield = Σ_{k ∈ axisKeys, mods[k] > 0} mods[k] × resources[k]。
 *   · 只计**正向**修饰器（收益）；负向修饰器属「代价」，交由 totalCost 单独度量，避免重复计入。
 *   · 用「正向修饰器 × 该资源在本局面的存量」做点积，使**收益随局面变化**：某选项加成「军事」，
 *     在军事资源丰沛的局面收益高、在军事稀缺的局面收益低。这正是 C2「各选项各有优势区间」能否
 *     被观测到的关键——若收益只按选项自身取值、与局面无关，则任两选项的相对优劣将与局面无关，
 *     也就无法表达「优势区间」这种真实取舍。
 *   · axisKeys 限定到「本轴相关修饰器键并集」，避免跨轴通用键干扰本轴比较。
 *
 * 这是 C2 / C5 判定「收益」的口径；「代价」用 totalCost（负向修饰器之和，静态）单独度量。
 */
function yieldScore(
  mods: Record<string, number>,
  resources: Record<string, number>,
  axisKeys: string[],
): number {
  let total = 0;
  for (const k of axisKeys) {
    const v = modValue(mods, k);
    if (v > 0) {
      const r = resources[k];
      total += v * (r === undefined ? 0 : r);
    }
  }
  return total;
}

/**
 * totalCost：把一份修饰器里**所有负向项**折算成正的「代价总量」（代价 ≤ 时该值越小越好）。
 *
 * 收益 / 代价分离是为了让 C2 的占优定义可执行：A 对 B 占优 ⟺ A.yield ≥ B.yield 且 A.cost ≤ B.cost
 * （至少一处严格）。负向修饰器即代价；正向修饰器不计入代价。
 */
function totalCost(mods: Record<string, number>): number {
  let cost = 0;
  for (const k of sortedKeys(mods)) {
    const v = modValue(mods, k);
    if (v < 0) cost += -v;
  }
  return cost;
}

// ---------------------------------------------------------------------------
// C1 每次重置新增决策维度
// ---------------------------------------------------------------------------

/**
 * verifyC1_ResetDimension：验证「进入下一层后，可用决策维度集合是否新增」。
 * ── 对应约束：C1「每次重置新增决策维度」。
 * ── 可证伪断言：设当前层可用决策维度集合 D_L ≜ Object.keys(state.modifiers)（键集合代表维度），
 *    「下一层」新增维度集合 Δ = nextModifiers 的键集合 \ D_L。**断言 |Δ| ≥ 1**（强化版对齐约束
 *    文档「|D_{L+1} \ D_L| ≥ 1 且操作集合非上一周目子集」）。若 |Δ| = 0（只是数值放大、无新维度）
 *    则 valid=false。
 *
 * 说明：本骨架用「未来层已激活的修饰器键集合 nextModifiers」代表 D_{L+1}（在骨架里，决策升级即
 *   「解锁一个新修饰器键」）。newDimensions 按字典序返回，便于报告与断言稳定。
 *
 * @param state        当前层状态（其 modifiers 键集合即 D_L）。
 * @param nextModifiers 进入下一层后可用的修饰器表（其键集合即 D_{L+1}）。
 * @returns { newDimensions, valid }：newDimensions = D_{L+1} \ D_L；valid = 是否至少新增 1 个维度。
 */
export function verifyC1_ResetDimension(
  state: StrategyState,
  nextModifiers: Record<string, number>,
): { newDimensions: string[]; valid: boolean } {
  assertFiniteTree(state.modifiers, 'state.modifiers');
  assertFiniteTree(nextModifiers, 'nextModifiers');
  const current = keySet(state.modifiers); // D_L
  const next = keySet(nextModifiers); // D_{L+1}
  const newDimensions: string[] = [];
  for (const key of Array.from(next).sort()) {
    if (!current.has(key)) newDimensions.push(key);
  }
  const valid = newDimensions.length >= 1;
  return { newDimensions, valid };
}

// ---------------------------------------------------------------------------
// C2 无全局严格占优
// ---------------------------------------------------------------------------

/**
 * verifyC2_NoDominance：对每个策略轴，检查是否存在「某选项在所有局面下都最优」。
 * ── 对应约束：C2「无全局严格占优」。
 * ── 可证伪断言：对某轴的一组同轴选项，逐一比对「A 对 B 占优」是否在**全部**场景成立。占优定义：
 *    A.收益 ≥ B.收益（yieldScore，按该轴相关修饰器聚合）**且** A.代价 ≤ B.代价（totalCost），
 *    且至少一处严格（否则视为等价，不判占优）。若某 A 对**其余所有同轴选项**在每个场景都占优，
 *    则 A 是「全局（样本内）占优选项」→ 记入 dominant，valid=false。
 *
 * 口径说明（务必诚实）：
 *   · 这是「样本内证伪」：valid=true 只表示「未在本组选项 / 场景里发现全局占优」，**不能证明全局
 *     无占优**（约束文档 §2 C2「不能证明什么」）。
 *   · 只在同一 axis 内比较（跨轴选项决策维度不同，互相占优无意义）。
 *   · 「每个场景都有 ≥2 个同轴选项」时判定才有意义；少于 2 个同轴选项的轴不参与判占优。
 *   · 若所有选项在所有场景完全等价（无严格差异），不存在「严格占优」，valid=true（未发现占优）。
 *
 * @param options   策略选项（可含多轴；按 axis 分组）。
 * @param scenarios 局面样本（每场景给一份 resources 与场景修饰器，用于折算收益 / 代价）。
 * @returns { dominant, valid }：dominant = 被判定为占优的选项 id（跨轴去重、字典序）；
 *          valid = dominant.length === 0（无全局占优则通过）。
 */
export function verifyC2_NoDominance(
  options: StrategyOption[],
  scenarios: StrategyState[],
): { dominant: string[]; valid: boolean } {
  for (const s of scenarios) {
    assertFiniteTree(s.resources, 'scenario.resources');
    assertFiniteTree(s.modifiers, 'scenario.modifiers');
  }
  for (const o of options) assertFiniteTree(o.modifiers, `option(${o.id}).modifiers`);

  // Step 1：收集每个轴「相关修饰器键」的并集（该轴所有选项 modifiers 的键）。用于单轴收益聚合口径。
  const axisKeysByAxis: Record<string, Set<string>> = {};
  for (const o of options) {
    const set = axisKeysByAxis[o.axis] ?? new Set<string>();
    for (const k of Object.keys(o.modifiers)) set.add(k);
    axisKeysByAxis[o.axis] = set;
  }

  // Step 2：对每个轴，逐一判定某选项是否在其所有场景中对其他所有同轴选项占优。
  const dominantSet = new Set<string>();
  const axes = Array.from(new Set(options.map((o) => o.axis))).sort();
  for (const axis of axes) {
    const peers = options.filter((o) => o.axis === axis);
    if (peers.length < 2) continue; // 单/空选项轴不存在「占优」概念
    const axisKeys = Array.from(axisKeysByAxis[axis] ?? new Set<string>()).sort();

    for (const a of peers) {
      let beatsAllInAllScenarios = true;
      for (const scenario of scenarios) {
        const aYield = yieldScore(a.modifiers, scenario.resources, axisKeys);
        const aCost = totalCost(a.modifiers);
        // 对每个场景，A 必须对「其余所有同轴选项」都不劣（且至少对某一个严格），否则本场景即失守。
        let strictlyBeatsSomeThisScenario = false;
        let notWorseThanAllThisScenario = true;
        for (const b of peers) {
          if (b.id === a.id) continue;
          const bYield = yieldScore(b.modifiers, scenario.resources, axisKeys);
          const bCost = totalCost(b.modifiers);
          const atLeastAsGood = aYield >= bYield && aCost <= bCost;
          const strictlyBetter = aYield > bYield || aCost < bCost;
          if (!atLeastAsGood) {
            notWorseThanAllThisScenario = false;
            break;
          }
          if (strictlyBetter) strictlyBeatsSomeThisScenario = true;
        }
        // 本场景需「不劣于全部其余选项」且「至少严格优于其中一个」（否则只是等价，不构成占优）。
        if (!notWorseThanAllThisScenario || !strictlyBeatsSomeThisScenario) {
          beatsAllInAllScenarios = false;
          break;
        }
      }
      if (beatsAllInAllScenarios) dominantSet.add(a.id);
    }
  }

  const dominant = Array.from(dominantSet).sort();
  return { dominant, valid: dominant.length === 0 };
}

// ---------------------------------------------------------------------------
// C3 浅层重复收益递减
// ---------------------------------------------------------------------------

/**
 * verifyC3_DiminishingReturns：对比「连续 N 次浅层操作」与「一次深层操作」的总收益。
 * ── 对应约束：C3「浅层重复收益递减」。
 * ── 可证伪断言（对齐约束文档 §2 C3）：**若「连续 N 次纯浅层的总收益 ≥ 一次深层 / 换维路径的
 *    收益」→ valid=false**。这里把「收益」定义为每次操作后资源总量相对操作前的增量；浅层序列的
 *    逐次增量应**严格递减**（边际收益递减），且浅层 N 次增量之和应**严格小于**深层一次增量。
 *
 * 判定细则：
 *   · shallowGains：第 k 次浅层操作的增量 = total(resources after k) − total(resources before)。
 *   · 严格递减：对每个 k，shallowGains[k] < shallowGains[k−1]（初值设为 +∞ 使首个元素恒可判）。
 *   · shallowTotal = Σ shallowGains；deepTotal = 深层一次操作的增量。
 *   · valid = (浅层增量严格递减) 且 (shallowTotal < deepTotal)。
 *     「递增则不通过」与「浅层总量不低于深层则不通过」两条都覆盖到了。
 *
 * @param state          起点状态（模板，不改动；内部 clone 后分别执行）。
 * @param shallowAction  一次浅层操作的「状态转移」（输入当前态，返回新态；通常用结构克隆）。
 * @param deepAction     一次深层操作的「状态转移」。
 * @param iterations     N（浅层连续执行次数，>= 1）。
 * @returns { shallowTotal, deepTotal, valid }。
 */
export function verifyC3_DiminishingReturns(
  state: StrategyState,
  shallowAction: () => StrategyState,
  deepAction: () => StrategyState,
  iterations: number,
): { shallowTotal: number; deepTotal: number; valid: boolean } {
  const totalOf = (s: StrategyState): number => {
    let t = 0;
    for (const k of sortedKeys(s.resources)) t += modValue(s.resources, k);
    return t;
  };

  const shallowGains: number[] = [];
  let prev = totalOf(state);
  for (let k = 0; k < iterations; k++) {
    const next = shallowAction();
    assertFiniteTree(next.resources, `shallow[${k}].resources`);
    const cur = totalOf(next);
    shallowGains.push(cur - prev);
    prev = cur;
  }

  const deepNext = deepAction();
  assertFiniteTree(deepNext.resources, 'deep.resources');
  const deepTotal = totalOf(deepNext) - totalOf(state);

  let shallowTotal = 0;
  for (const g of shallowGains) shallowTotal += g;

  // 严格递减判定：每个增量都必须严格小于上一次（首项与 +∞ 比，恒成立）。
  let strictlyDecreasing = true;
  let last = Number.POSITIVE_INFINITY;
  for (const g of shallowGains) {
    if (!(g < last)) {
      strictlyDecreasing = false;
      break;
    }
    last = g;
  }

  const valid = strictlyDecreasing && shallowTotal < deepTotal;
  return { shallowTotal: round4(shallowTotal), deepTotal: round4(deepTotal), valid };
}

// ---------------------------------------------------------------------------
// C4 自动化不代替战略选择
// ---------------------------------------------------------------------------

/**
 * strategyScore：把一份策略态折算成「长期结果分」（资源总量 + 正向修饰器之和）。
 * 仅用于 C4 的自动 / 手动对照；口径固定、确定（不读时钟 / 随机）。
 */
function strategyScore(s: StrategyState): number {
  let score = 0;
  for (const k of sortedKeys(s.resources)) score += modValue(s.resources, k);
  for (const k of sortedKeys(s.modifiers)) {
    const v = modValue(s.modifiers, k);
    if (v > 0) score += v;
  }
  return score;
}

/**
 * verifyC4_AutomationNotReplace：对比「自动化策略」与「手动策略」的长期结果。
 * ── 对应约束：C4「自动化不代替战略选择」。
 * ── 可证伪断言（对齐约束文档 §2 C4）：**若自动化策略的长期结果 ≥ 手动策略结果 → valid=false**
 *    （即自动化可替代战略，判不通过）。通过口径要求自动化**显著低于**手动——本实现取
 *    「manualScore − autoScore > 0」为最低要求，并额外要求该差距占手动的比例 ≥ MIN_C4_GAP_RATIO
 *    （默认 0.1，即至少低 10%）才算「显著」。阈值可传入覆盖。
 *
 * 注：autoStrategy / manualStrategy 分别是「设好就不管」与「持续手动最优」两条 Bot 的**终态**
 *   快照（由测试夹具按策略差异构造）；本函数只做结果对比，不模拟中间过程。
 *
 * @param autoStrategy   自动化策略终态。
 * @param manualStrategy 手动策略终态。
 * @param minGapRatio    「显著」差距占手动的比例阈值（默认 0.1）。
 * @returns { autoScore, manualScore, valid }：valid = 自动显著低于手动。
 */
export function verifyC4_AutomationNotReplace(
  autoStrategy: StrategyState,
  manualStrategy: StrategyState,
  minGapRatio: number = 0.1,
): { autoScore: number; manualScore: number; valid: boolean } {
  assertFiniteTree(autoStrategy.resources, 'autoStrategy.resources');
  assertFiniteTree(autoStrategy.modifiers, 'autoStrategy.modifiers');
  assertFiniteTree(manualStrategy.resources, 'manualStrategy.resources');
  assertFiniteTree(manualStrategy.modifiers, 'manualStrategy.modifiers');

  const autoScore = strategyScore(autoStrategy);
  const manualScore = strategyScore(manualStrategy);

  const gap = manualScore - autoScore;
  // 「自动 < 手动」且「差距显著」：当手动 > 0 时按比例判显著；手动 <= 0 时仅要求自动严格更低。
  const requiredGap = manualScore > 0 ? manualScore * minGapRatio : 0;
  const valid = gap > 0 && gap >= requiredGap;

  return {
    autoScore: round4(autoScore),
    manualScore: round4(manualScore),
    valid,
  };
}

// ---------------------------------------------------------------------------
// C5 新周目改变约束条件
// ---------------------------------------------------------------------------

/**
 * verifyC5_NewRunChangesConstraints：用「固定模板策略」跨配置跑，统计同一模板在多少个配置下仍最优。
 * ── 对应约束：C5「新周目改变约束条件」。
 * ── 可证伪断言（对齐约束文档 §2 C5）：**若同一套模板在 ≥ K 个不同周目配置下都能通关且相对最优，
 *    判不通过**（即约束改变未真正改变最优解）。这里把「模板最优」具化为：在给定配置下，模板选项
 *    按单轴收益（yieldScore）折算后的分数 **≥** 该配置内的「基线策略」分数。统计「仍最优」的配置
 *    个数 sameTemplateSuccess。**valid = sameTemplateSuccess < K**（少于 K 个配置仍最优 → 约束确实
 *    改变了最优解 → 通过）。
 *
 * 口径说明：
 *   · templates 是「固定模板」的同轴选项集合；configs 是不同周目配置（用 resources 表达各周目
 *     不同的资源权重）。模板得分 = Σ_{t∈templates} yieldScore(t, config.resources, axisKeys)。
 *   · baseline 是「上一周目最优解」的参照得分（通常随手动最优）。模板在新配置下得分低于 baseline，
 *     说明旧解不能直接复用（这正是 C5 想要的）。
 *   · K 默认 2（可传入覆盖）；约束文档要求阈值由 OQ-15 锁定，本处给最小可执行默认值。
 *
 * @param templates 固定模板策略（同轴选项集）。
 * @param configs   不同周目配置（StrategyState[]，其 resources 表达配置差异）。
 * @param K         「同一模板仍最优的配置数」上限阈值（默认 2）。
 * @param baseline  每周目的基线（上一周目最优解）参照分；缺省按「0」处理（模板分≥0 即算仍最优）。
 * @returns { sameTemplateSuccess, valid }：valid = sameTemplateSuccess < K。
 */
export function verifyC5_NewRunChangesConstraints(
  templates: StrategyOption[],
  configs: StrategyState[],
  K: number = 2,
  baseline: number = 0,
): { sameTemplateSuccess: number; valid: boolean } {
  for (const t of templates) assertFiniteTree(t.modifiers, `template(${t.id}).modifiers`);
  for (const c of configs) assertFiniteTree(c.resources, 'config.resources');

  // 模板相关修饰器键 = 所有模板 modifiers 的键并集（单轴收益聚合口径）。
  const axisKeysSet = new Set<string>();
  for (const t of templates) for (const k of Object.keys(t.modifiers)) axisKeysSet.add(k);
  const axisKeys = Array.from(axisKeysSet).sort();

  let sameTemplateSuccess = 0;
  for (const config of configs) {
    let templateScore = 0;
    for (const t of templates) {
      templateScore += yieldScore(t.modifiers, config.resources, axisKeys);
    }
    // 「同一模板仍最优」≜ 模板分 ≥ 该配置基线分。
    if (templateScore >= baseline) sameTemplateSuccess += 1;
  }

  const valid = sameTemplateSuccess < K;
  return { sameTemplateSuccess, valid };
}

// ---------------------------------------------------------------------------
// C6 推进始终有真实风险与恢复成本
// ---------------------------------------------------------------------------

/**
 * riskScore：从一份策略态的修饰器里读「风险指标」综合值。
 * 风险键约定为 risk / pollution / failureTier / casualties / chain（断链）等（见 RISK_KEYS）。
 * 返回其**绝对值之和**（风险指标无论正负，只要偏离 0 即视为「有风险暴露」）。
 */
const RISK_KEYS: readonly string[] = ['risk', 'pollution', 'failureTier', 'casualties', 'chain'];
function riskScore(mods: Record<string, number>): number {
  let total = 0;
  for (const k of RISK_KEYS) {
    const v = mods[k];
    if (v !== undefined) total += Math.abs(v);
  }
  return total;
}

/** totalResources：资源总量（C6 净增长判定用）。 */
function totalResources(s: StrategyState): number {
  let t = 0;
  for (const k of sortedKeys(s.resources)) t += modValue(s.resources, k);
  return t;
}

/**
 * verifyC6_NoRiskFreeLoop：搜索是否存在「资源净增长 ≥ 0 且风险指标始终为 0」的循环。
 * ── 对应约束：C6「推进始终有真实风险与恢复成本」。
 * ── 可证伪断言（对齐约束文档 §2 C6）：**若存在一条循环操作序列，使资源 / 进度净增长 ≥ 0 且期间
 *    任何风险指标（断链 / 污染 / 失败 tier / 伤亡）始终为 0 或无需恢复成本 → valid=false**
 *    （发现无风险净正循环）。本实现：对给定动作序列逐步执行，检查**每一步**的风险分。若所有步风险
 *    都为 0 且末态资源总量 ≥ 起点（净增长 ≥ 0 且首尾构成循环），计为一个无风险循环 riskFreeLoops++。
 *    **valid = riskFreeLoops === 0**。
 *
 * 判定细则（务必诚实）：
 *   · 「始终为 0」= 循环内每一步风险分都为 0（任一时刻有风险暴露即该循环「有风险」，不算无风险）。
 *   · 「净增长 ≥ 0」= 末态资源总量 − 起点资源总量 ≥ 0（达到则即使持平也算不通过——因为零成本持平
 *     仍是无风险套利的外壳）。
 *   · 这是「已发现即证伪」口径：valid=true 只表示「本组动作序列里没找到无风险循环」，**不能证明
 *     状态空间里绝对不存在**（约束文档 §2 C6 / §5.3）。
 *   · 循环若干步后动作不再变化（幂等），以「动作序列走一遍」为一次循环；如需多次迭代可在外层重复调用。
 *
 * @param state   起点状态（资源总量作为「净增长」基线；不改动）。
 * @param actions 循环动作序列（每个动作是 State→State 的转移）。
 * @returns { riskFreeLoops, valid }：riskFreeLoops ∈ {0,1}（本函数判定给定序列是否构成无风险循环）。
 */
export function verifyC6_NoRiskFreeLoop(
  state: StrategyState,
  actions: Array<() => StrategyState>,
): { riskFreeLoops: number; valid: boolean } {
  const baseTotal = totalResources(state);
  assertFiniteTree(state.resources, 'state.resources');

  let riskFreeLoops = 0;
  if (actions.length > 0) {
    let allStepsRiskZero = true;
    let last: StrategyState = state;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (action === undefined) continue;
      const next = action();
      assertFiniteTree(next.resources, `action[${i}].resources`);
      assertFiniteTree(next.modifiers, `action[${i}].modifiers`);
      if (riskScore(next.modifiers) !== 0) {
        allStepsRiskZero = false;
      }
      last = next;
    }
    const net = totalResources(last) - baseTotal;
    if (allStepsRiskZero && net >= 0) riskFreeLoops = 1;
  }

  return { riskFreeLoops, valid: riskFreeLoops === 0 };
}
