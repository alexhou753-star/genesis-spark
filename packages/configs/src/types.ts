/**
 * 创世火种 · @genesis/configs 配置类型 v0.4（草案，待架构师评审后冻结）
 * 位置：packages/configs/src/types.ts。依赖图的根：不得 import 任何其他包（架构 3.1）。
 * 依据：PRD v3.1 修订 6、技术架构 v2.1。
 *
 * v0.4.1 增补（批次一/A 组，数值占位待审）：
 *  A1 行政算力三消费者：AdminPowerConfig 补来源与不足行为（perBuildingSource / perTechSource / perEraGain / perNeighborActionCost / insufficientBehavior）。
 *  A2 FR-48 渐进解锁强制点：新增 UnlockCondition 与 AutomationUnlockConfig，GameConfig.automation。
 *  A3 规则替换式种族：ResourceConfig.regen（猎物可再生）、RaceConfig.vitalityChain（真菌维生主链，与溢出转化分离）。
 *  A4 士气最小规则：新增 MoraleConfig（全局公式，不进 ModifierTarget）。
 *  不改动既有判别联合与字段。
 *
 * v0.4.1 增补（批次二/B 组，M2 槽位，字段全部可选、数值占位待审）：
 *  B5 生态/贸易轨：ResourceKind 追加 'order'（订单物，类型层落实 D3 右轨不产基础资源）；新增 SeedConfig /
 *     AdjacencyRecipe / CatalystQualityConfig / OrderRewardKind+OrderRewardPoolConfig；GameConfig 追加
 *     seeds / adjacencies / catalystQualities / orderRewardPools / morale 可选字段。
 *  B6 事件负载：TIMER 的 timer 联合追加 'government_cooldown' | 'failure_duration' | 'neighbor_slow_change'。
 *  与批次一同样只做追加/可选，不改动既有判别联合与字段。
 *
 * v0.4.1 增补（批次三/C 组，M2/M3 槽位，字段全部可选、数值占位待审）：
 *  C7 政体：新增 GovernmentConfig（2+2 强正面/强负面强制，仅冷却，unlockEraIndex=5）；GameConfig.governments?。
 *  C9/OQ-08 挑战基因：ChallengeGeneConfig（结构占位，不写预设组合）；GameConfig.challengeGenes?。
 *  FR-23 质粒软上限：SoftCapConfig（软上限拐点，对齐 Evolve 250 收益递减）；GameConfig.plasmidSoftCap?。
 *  仅追加可选字段与独立接口，不改动既有判别联合与字段。
 *
 * v0.4 变更：TutorialOverrides 移除 chain（危机/断链参数），从类型层面拒绝引导注入断链阈值，
 *   对齐架构 5.7.1「正常周目不得用 tutorialOverrides 制造强制爆仓/断链」；纪元 1 门槛只可经 eraGateScale 缩放。
 *
 * v0.3 增补：修饰器目标语法 v2、OverflowConversion、AdminPowerConfig（见各处注释）。
 *
 * v0.2 相对 v0.1 的变更（自审时逐条对照 PRD 验收条款发现）：
 *  1. EraRequirement 改为可判别联合，能表达“指定建筑”门槛（FR-08：人口、知识、指定建筑）。
 *  2. EraConfig 增加 storageCeilingMultiplier（FR-04：每个纪元设仓储倍率天花板）。
 *  3. 增加 SeasonConfig、GameConfig.seasons、ClockConfig.seasonForewarnSec、RaceConfig.seasonOverrides（FR-10）。
 *  4. RaceConfig 增加 disabledResources / disabledBuildings（FR-07：被种族废除的资源与建筑不出现在界面）。
 *  5. ModifierConfig.target 改为模板字面量类型 ModifierTarget；目标语法见下。
 *  6. BuildingCategory 增加 'orbital'（PRD 附录 C.1 的“太空轨道与巨构组件”类）。
 *  7. 类型按包拆成 configs / engine / save 三个文件，依赖方向单向。
 */

/** ADR-06：V1.0 用 number，所有数值运算经此别名，预留大数库替换点。 */
export type GameNum = number;

export type Id = string;
export type ResId = Id;
export type JobId = Id;
export type BuildingId = Id;
export type TechId = Id;
export type RaceId = Id;
export type EraId = Id;
export type SeasonId = Id;

// ---------------------------------------------------------------------------
// 修饰器配置（架构 5.8）
// ---------------------------------------------------------------------------

export type ModifierOp = 'add_base' | 'add_pct' | 'mul' | 'override';

/**
 * 修饰器目标语法（本文件为准；架构 5.8 只给了示例，没有定义语法）：
 *   res.<资源ID>.rate | res.<资源ID>.max   资源速率 / 资源上限
 *   job.<工种ID>.rate                      工种单人产率
 *   bldg.<建筑ID>.creep | bldg.<建筑ID>.cost   蠕变系数 / 基础成本
 * v0.3 增补（模块开发地图 B 表逐条核对 FR-16/24/26 的结果）：
 *   res.<资源ID>.upkeep                    资源消耗（FR-26 重引力提高粮食消耗）
 *   bldg.<建筑ID>.storage                  单座建筑的仓储贡献（FR-16 折叠基质只乘仓储建筑自己的贡献）
 *   bldg.<建筑ID>.upkeep | .conv           建筑能耗 / 转化速度（FR-16 超导线圈）
 *   all.creep | cat.<建筑类别>.creep       全局或按类别的蠕变（FR-24 噬菌体、FR-26 宇宙）
 *   pop.growth                             人口增长率（FR-26 重引力）
 * 所有蠕变类目标最终都受 1.015 硬下限约束（FR-05）。ID 是否真实存在由 Gate 1 校验。
 */
export type ModifierTarget =
  | `res.${string}.rate`
  | `res.${string}.max`
  | `res.${string}.upkeep`
  | `job.${string}.rate`
  | `bldg.${string}.creep`
  | `bldg.${string}.cost`
  | `bldg.${string}.storage`
  | `bldg.${string}.upkeep`
  | `bldg.${string}.conv`
  | 'all.creep'
  | `cat.${BuildingCategory}.creep`
  | 'pop.growth';

export interface ModifierConfig {
  target: ModifierTarget;
  op: ModifierOp;
  value: number;
}

// ---------------------------------------------------------------------------
// FR-48 自动化渐进解锁（v0.4.1）
// ---------------------------------------------------------------------------

/**
 * v0.4.1: 解锁条件——编译期强制点。引擎在 dispatch 与离线推进都必须按此求值，
 * 未满足条件的策略不得执行（前期不得满 10 队列 / 全部规则）。三种判别形式：
 *   era：纪元序号达到 eraIndex（对应 EraConfig.index）；
 *   tech：已研究 techId；
 *   resetLayer：某重置层（'ash' 灰烬 / 'seed' 播种）累计执行次数达到 times（依据 PermaState.resetCounts）。
 */
export type UnlockCondition =
  | { kind: 'era'; eraIndex: number }
  | { kind: 'tech'; techId: TechId }
  | { kind: 'resetLayer'; layer: 'ash' | 'seed'; times: number };

/**
 * v0.4.1: 自动化渐进解锁配置（FR-48）。规则槽位上限与队列长度上限均按 UnlockCondition 逐阶段放开；
 * autoReplant / autoBuild 可选，不设表示该自动化能力暂不开放。数值与曲线占位，待 GDD 第 2 节评审。
 */
export interface AutomationUnlockConfig {
  /** 内政总管规则槽位：每个 cap 为一个槽位上限，达到 unlock 条件后放开到该上限。 */
  governorRuleSlots: Array<{ cap: number; unlock: UnlockCondition }>;
  /** 排程队列长度：每个 cap 为一个队列长度上限，达到 unlock 条件后放开到该上限。 */
  queueLengthCaps: Array<{ cap: number; unlock: UnlockCondition }>;
  /** 自动补种（生态试验田）解锁条件；不设表示暂不开放。 */
  autoReplant?: UnlockCondition;
  /** 自动建造解锁条件；不设表示暂不开放。 */
  autoBuild?: UnlockCondition;
}

// ---------------------------------------------------------------------------
// 总配置
// ---------------------------------------------------------------------------

export interface GameConfig {
  configVersion: number;
  clock: ClockConfig;
  chain: ChainThresholds;
  governor: GovernorConfig;
  population: PopulationConfig;
  /** 种族锁定前使用的种族无关维生声明（FR-28、架构 5.7）。 */
  neutralSustenance: Sustenance;
  tutorialOverrides: TutorialOverrides;
  /** FR-04：溢出转化，需科技解锁，转化后的单位价值必须低于直接产出。 */
  overflowConversions: OverflowConversion[];
  seasons: SeasonConfig[];
  eras: EraConfig[];
  races: RaceConfig[];
  resources: ResourceConfig[];
  jobs: JobConfig[];
  buildings: BuildingConfig[];
  techs: TechConfig[];
  /**
   * v0.4.1: FR-48 自动化渐进解锁（规则槽位 / 队列上限于解锁后才放开）。
   * 以可选字段落地，以兼容现有 config.m1.ts（本组不修改配置文件，M1_CONFIG 暂未提供该段）；
   * 正式配置应显式提供，缺省时引擎按“无自动化能力开放”处理。
   */
  automation?: AutomationUnlockConfig;
  /**
   * v0.4.1: 生态试验田种子表（M2，可选）。缺省表示当前配置不含生态右轨内容，引擎按“无种子”处理。
   * 以可选字段落地以兼容现有 config.m1.ts（本组不修改配置文件，M1_CONFIG 未提供该段）。
   */
  seeds?: SeedConfig[];
  /** v0.4.1: 邻接配方表（M2，可选）；缺省表示无变异配方。*/
  adjacencies?: AdjacencyRecipe[];
  /** v0.4.1: 催化剂品质表（M2，可选）；缺省表示催化剂无品质差异。*/
  catalystQualities?: CatalystQualityConfig[];
  /** v0.4.1: 订单奖励池（M2，可选，按纪元分层）；缺省表示无订单奖励。*/
  orderRewardPools?: OrderRewardPoolConfig[];
  /**
   * v0.4.1: 士气全局规则（批次一建 MoraleConfig 的挂载点，可选）。
   * 缺省表示使用引擎内置默认士气系数；正式配置应显式提供。
   */
  morale?: MoraleConfig;
  /**
   * v0.4.1: C7 政体表（M3，可选）。缺省表示当前配置不含政体内容（纪元 1–4 恒 'anarchy'）。
   * 数值占位，待 GDD v0.26 与数值评审；2+2 强正面/强负面结构由 Gate 1 断言。
   */
  governments?: GovernmentConfig[];
  /**
   * v0.4.1: C9 挑战基因表（OQ-08 未定，可选）。仅结构占位，不写预设组合。
   * 缺省表示无挑战基因；具体倍率与组合待 OQ-08 定稿。
   */
  challengeGenes?: ChallengeGeneConfig[];
  /**
   * v0.4.1: FR-23 质粒软上限（可选）。缺省表示使用引擎内置默认软上限。
   * knee 为软上限拐点，对齐 Evolve 250 收益递减的占位值，待数值评审。
   */
  plasmidSoftCap?: SoftCapConfig;
}

/**
 * 所有周期以“游戏秒”声明（FR-01），运行时用 secToTicks 转整数 tick。
 * 为使 tickMs = 100 / 250 / 1000 都能精确换算，秒数必须是整数（Gate 1 校验）。
 */
export interface ClockConfig {
  tickMs: number;
  /** FR-20：离线与后台补算最多结算的秒数，默认 86400。 */
  maxOfflineSec: number;
  /** 随机检定网格周期，默认 10 秒。 */
  hazardIntervalSec: number;
  /** 每季秒数，默认 900，一年 3600（FR-10）。 */
  seasonSec: number;
  /** 切换前多少秒预告下一季节，默认 60（FR-10）。 */
  seasonForewarnSec: number;
  /** 商队订单刷新间隔，默认 86400。 */
  orderRefreshSec: number;
}

/**
 * FR-04 溢出转化（食物→堆肥、木石→建材废料、知识→灵感碎片）。
 * 满仓时多出来的产量按 ratio 折算成 toResId；ratio 必须在 (0, 1) 内，保证价值低于直接产出。
 * 建材废料类转化可带“下一次同类建筑成本一次性折扣”，折扣只作用于成本，不改蠕变系数（FR-04：1%–3%）。
 */
export interface OverflowConversion {
  fromResId: ResId;
  toResId: ResId;
  ratio: number;
  requiresTech: TechId;
  /** 取值 0.01–0.03；不设表示无折扣。 */
  nextBuildCostDiscount?: number;
}

/** 断链阈值（FR-06）。 */
export interface ChainThresholds {
  /** 稳态满足率低于此值才计入断链计时，默认 0.5。 */
  starveRatio: number;
  /** 稳态满足率回升到此值以上才开始衰减计时，默认 0.85。 */
  recoverRatio: number;
  /** 欠载持续满此秒数才确认一级并写日志与埋点，默认 5，引导期为 0。 */
  l1ConfirmSec: number;
  l2Sec: number;
  l3Sec: number;
  /** 三级恢复预热，建议 20–60 秒（FR-06）。 */
  warmupSec: number;
}

export interface GovernorConfig {
  /** FR-18 默认保底规则从哪个纪元序号开始启用，值为 2（架构 5.7 的 governorDefaultsFromEra）。 */
  defaultsFromEraIndex: number;
  survivalTriggerRatio: number; // 默认 0.15
  survivalReleaseRatio: number; // 默认 0.5
  cooldownSec: number; // 默认 15
  /** 抽调工种的优先级，靠前的先被抽调。 */
  drawOrder: JobId[];
  /**
   * FR-18/19：行政算力由内政总管规则与排程队列共用。
   * 来源（建筑、科技、纪元）与单价是 GDD 条目，这里先给出结构与占位值，详见模块开发地图 A 表。
   */
  adminPower: AdminPowerConfig;
}

export interface AdminPowerConfig {
  /** 基础算力容量。 */
  baseCapacity: number;
  /** 每条激活规则占用。 */
  perRuleCost: number;
  /** 每个排程队列项占用，0 表示队列不占算力（待 GDD 决定）。 */
  perQueueItemCost: number;
  /**
   * v0.4.1: 行政算力的「建筑来源」——按建筑 ID 给出的每座算力贡献（三消费者共用同一算力池）。
   * 数值占位，待 GDD/数值评审。键必须为已存在的 BuildingId（Gate 1 校验）。
   */
  perBuildingSource?: Record<BuildingId, number>;
  /**
   * v0.4.1: 行政算力的「科技来源」——按科技 ID 给出的算力贡献（解锁后计入）。
   * 数值占位，待 GDD/数值评审。键必须为已存在的 TechId（Gate 1 校验）。
   */
  perTechSource?: Record<TechId, number>;
  /**
   * v0.4.1: 每进入一个新纪元带来的固定算力增益。
   * 数值占位，待 GDD/数值评审。
   */
  perEraGain?: number;
  /**
   * v0.4.1: 邻国博弈（FR-51）每个外交行动消耗的行政算力（行政算力三消费者之第三：内政规则、排程队列、邻国行动）。
   * 数值占位，待数值策划与 FR-51 一并评审。
   */
  perNeighborActionCost?: number;
  /**
   * v0.4.1: 算力不足时的行为——reject_new：拒绝新消耗（如拒绝新建规则/行动），与 FR-51「算力不足拒绝新建并提示行政过载」一致；
   * drop_lowest_priority_rule：按优先级丢弃最低优先级的现有规则以腾出算力。数值/策略占位，待评审。
   */
  insufficientBehavior?: 'reject_new' | 'drop_lowest_priority_rule';
}

export interface PopulationConfig {
  /** 每秒基础增长（人/秒），受住房上限约束。 */
  growthPerSec: number;
  /** 每人每秒消耗的维生资源量。 */
  upkeepPerSec: number;
}

/** 引导覆写：v0.4 仅保留门槛缩放；不含 chain 等危机参数（类型层拒绝引导制造断链/爆仓，架构 5.7.1）。 */
export interface TutorialOverrides {
  /** 引导周目对纪元门槛中资源数量的缩放，键为纪元 ID，取值 (0, 1]。 */
  eraGateScale: Record<EraId, number>;
}

/** 种族维生声明：内政总管保底规则与新手引导只通过它绑定（FR-07）。 */
export interface Sustenance {
  resId: ResId;
  jobId: JobId;
}

export interface SeasonConfig {
  id: SeasonId;
  name: string;
  /** FR-10：季节修饰器全部来自配置。 */
  modifiers: ModifierConfig[];
}

/**
 * v0.4.1: 资源种类追加 'order'（订单物：木货 / 岩货 / 水货 / 火货）。
 * 【D3 口径】订单物是右轨（生态/贸易）产物，不是基础资源；类型层明确其独立种类，
 * 落实 D3「右轨不产基础资源」——订单物不得被当作 food/wood/stone 等基础资源使用。
 */
export type ResourceKind = 'primary' | 'secondary' | 'knowledge' | 'population' | 'order';

export interface ResourceConfig {
  id: ResId;
  kind: ResourceKind;
  unlockEraIndex: number;
  baseMax: GameNum;
  /**
   * v0.4.1: 猎物等可再生资源的再生参数（占位）——每秒再生量与承载上限。
   * 仅对「可再生资源」（如猫族猎物）设置；不设表示非再生资源（默认资源行为不变）。
   * 与 A3 的 vitalityChain（真菌维生主链）是两套独立机制，见 RaceConfig.vitalityChain 的注释。
   */
  regen?: { perSec: GameNum; carryingCap: GameNum };
}

export interface JobConfig {
  id: JobId;
  unlockEraIndex: number;
  /** 每名工人每秒产出，键为资源 ID。 */
  producesPerSec: Record<ResId, GameNum>;
  /** 每名工人每秒消耗。 */
  consumesPerSec?: Record<ResId, GameNum>;
}

/** 附录 C.1 的蠕变基准按类别给出：housing / gather / storage / orbital。 */
export type BuildingCategory = 'gather' | 'storage' | 'housing' | 'workshop' | 'research' | 'power' | 'orbital';

export interface BuildingConfig {
  id: BuildingId;
  eraIndex: number;
  category: BuildingCategory;
  /** 第 1 座的成本。 */
  baseCost: Record<ResId, GameNum>;
  /** 基准蠕变系数，必须不小于硬下限 1.015（V1.0，FR-05）。 */
  creepBase: number;
  /** 提供的岗位上限（每座）。 */
  jobSlots?: Record<JobId, number>;
  /** 提供的仓储上限（每座）。 */
  storagePerUnit?: Record<ResId, GameNum>;
  /** 提供的住房上限（每座）。 */
  housingPerUnit?: GameNum;
  /** 无需工人的被动产出（每座每秒）。 */
  passiveProducesPerSec?: Record<ResId, GameNum>;
  passiveConsumesPerSec?: Record<ResId, GameNum>;
  sockets: number;
  /** 是否为该纪元的首批关键建筑，Gate 1 校验其成本不超过纪元起点的可达上限。 */
  isEraEntry?: boolean;
}

export interface TechConfig {
  id: TechId;
  eraIndex: number;
  cost: Record<ResId, GameNum>;
  requires: TechId[];
  modifiers: ModifierConfig[];
}

/** FR-08：门槛为“人口、知识、指定建筑”。人口与知识都是资源，用 resource 一种即可。 */
export type EraRequirement =
  | { kind: 'resource'; resId: ResId; amount: GameNum }
  | { kind: 'building'; buildingId: BuildingId; count: number };

export interface EraConfig {
  id: EraId;
  index: number;
  name: string;
  /** 进入下一纪元的硬门槛；最后一个已配置纪元为 null。 */
  gate: EraRequirement[] | null;
  /** 进入该纪元时的全局仓储倍率（FR-08：进入时重置并提升）。 */
  storageMultiplier: number;
  /**
   * 该纪元内任一资源的上限（含全部仓储建筑与加成）相对 baseMax 的最大倍数（FR-04 的“天花板”）。
   * 语义待数值与架构确认：目前按“baseMax × 此值”实现。
   */
  storageCeilingMultiplier: number;
  ecoGridSize: 0 | 2 | 3 | 4;
}

export type RaceKind = 'standard' | 'plant' | 'silicon' | 'large' | 'fungal' | 'carnivore';

export interface RaceConfig {
  id: RaceId;
  kind: RaceKind;
  sustenance: Sustenance;
  /** 资源替换：键资源被值资源替代，键资源对该种族不再出现（FR-07）。不允许链式替换。 */
  resourceMap: Record<ResId, ResId>;
  /** 被废除的资源，对该种族不出现。 */
  disabledResources: ResId[];
  /** 被废除的建筑，对该种族不出现；仅提供被废除建筑岗位的工种随之不可用。 */
  disabledBuildings: BuildingId[];
  /** 被废除的系统（引擎侧特性开关，如 'hunting'）。 */
  disabledFeatures: string[];
  /** 种族对季节修饰器的覆写：键为季节 ID，值替换该季节的修饰器（FR-10）。 */
  seasonOverrides: Record<SeasonId, ModifierConfig[]>;
  /**
   * v0.4.1: 规则替换式种族的「维生主链」——from→to 按 ratio 逐级折算，用于真菌（无农业）原木→有机废料→堆肥的维生主链。
   * 【口径隔离】本链只表达「维生资源逐级转化」这一规则替换语义，与 FR-04 的 OverflowConversion（满仓溢出转化）
   * 是两套完全独立的口径，禁止混用：溢出转化只在满仓时触发、受 requiresTech 与 nextBuildCostDiscount 约束；
   * 维生主链是种族固有的常驻转换，不受满仓触发、不产生建材废料折扣。两者不得共用实现或相互替代。
   * 不设表示该种族没有维生主链。比例与链序为占位，待系统策划评审。
   */
  vitalityChain?: Array<{ from: ResId; to: ResId; ratio: number }>;
  modifiers: ModifierConfig[];
}

// ---------------------------------------------------------------------------
// 士气（FR-10，v0.4.1）
// ---------------------------------------------------------------------------

/**
 * v0.4.1: 士气最小规则（占位值）。2026-11-04 产品已拍板方向：
 * 士气低于 100% 时每低 1 点扣 1 点产出（lowPenaltyPerPoint），高于 100% 时每高 1 点加 0.5 点产出（highBonusPerPoint）。
 * 【为何不进 ModifierTarget】士气是「全局公式」而非逐来源的修饰器：
 *   把它纳入修饰器体系会与其它来源的 add_pct / mul 叠加，造成叠乘污染与来源分解不可解释；
 *   故建模为独立的全局产出系数，不参与 ModifierConfig / ModifierTarget 的叠加。
 * 士气来源留到纪元 4 税收系统再补，此处只给最小规则的两系数（占位，待数值评审）。
 */
export interface MoraleConfig {
  lowPenaltyPerPoint: number;
  highBonusPerPoint: number;
}

// ---------------------------------------------------------------------------
// 生态试验田：种子 / 邻接 / 催化品质 / 订单奖励池（M2 槽位，v0.4.1，全部可选、数值占位）
// ---------------------------------------------------------------------------

/**
 * v0.4.1: 种子配置（生态试验田，M2）。element 为木/岩/水/火四元素（与邻接配方元素同一枚举）。
 * 【FR-15 / D3】收获只产订单物（yieldOrderId），不产基础资源——右轨不产基础资源，订单物由 ResourceKind 'order' 承载。
 * matureSec（成熟时间）与 yieldAmount（产量）为占位，待评审。id 必须为已存在的 SeedId（Gate 1 校验）。
 */
export interface SeedConfig {
  id: Id;
  element: 'wood' | 'rock' | 'water' | 'fire';
  matureSec: number;
  yieldOrderId: Id;
  yieldAmount: GameNum;
}

/**
 * v0.4.1: 邻接配方（生态试验田两两元素相邻时的变异规则，M2）。
 * 【口径】变异在「成熟判定」时结算，不走随机检定网格（hazardIntervalSec 的随机流），避免与灾害判定耦合。
 * baseMutationRate 为基础突变率占位，待评审。a / b 复用 SeedConfig 的元素取值；catalystId 为已存在的 CatalystId（Gate 1 校验）。
 */
export interface AdjacencyRecipe {
  a: SeedConfig['element'];
  b: SeedConfig['element'];
  catalystId: Id;
  baseMutationRate: number;
}

/**
 * v0.4.1: 催化剂品质配置（M2）。quality 三档：普通 / 优良 / 卓越；creepReduction 为其对蠕变的削减量（占位）。
 * 【硬约束】仍受 1.015 蠕变硬下限约束（FR-05）：削减后不得低于 1.015——此为 Gate 1 待登记检查项。
 * catalystId 必须为已存在的 CatalystId（Gate 1 校验）。
 */
export interface CatalystQualityConfig {
  catalystId: Id;
  quality: 'normal' | 'fine' | 'superb';
  creepReduction: number;
}

/** v0.4.1: 订单奖励种类——稀有材料 / 临时增益（订单物奖励池，M2）。 */
export type OrderRewardKind = 'rareMaterial' | 'tempBoost';

/**
 * v0.4.1: 订单奖励池配置（按纪元分层，M2）。entries 每项按 weight 抽取；dailyCap 为每日上限（可选，不设表示不限）。
 * 【价值约束】奖励总价值须低于直接产出的 70%——占位，Gate 1 待登记检查（防止订单物奖励绕过 D3 右轨不产基础资源的经济口径）。
 * eraIndex 对应 EraConfig.index；rewardId 的具体语义由 kind 决定。
 */
export interface OrderRewardPoolConfig {
  eraIndex: number;
  entries: Array<{ kind: OrderRewardKind; rewardId: Id; weight: number; dailyCap?: number }>;
}

// ---------------------------------------------------------------------------
// 政体 / 挑战基因 / 质粒软上限（M2/M3 槽位，v0.4.1，全部可选、数值占位）
// ---------------------------------------------------------------------------

/**
 * v0.4.1: C7 政体配置（GDD v0.26 收口口径）。纪元 1–4 恒 'anarchy'，unlockEraIndex=5 起可选择。
 * 【2+2 结构强制】每政体必须给出 ≥2 条强正面（strongPros）与 ≥2 条强负面（strongCons），Gate 1 断言；
 *   强正面/强负面用 ModifierConfig 表达（target 遵循 ModifierTarget 语法）。
 * 【仅冷却】切换政体只有 switchCooldownSec 冷却与 maxSwitchesPerRun 次数上限，无产出惩罚（旧「政变期 -30%」已废止）。
 * 数值占位，待 GDD v0.26 与数值评审。
 */
export interface GovernmentConfig {
  id: Id;
  unlockEraIndex: number;
  switchCooldownSec: number;
  maxSwitchesPerRun: number;
  strongPros: ModifierConfig[];
  strongCons: ModifierConfig[];
}

/**
 * v0.4.1: C9 挑战基因 ID（引用 Id）。
 * 【OQ-08 未定】仅结构占位，不写预设组合；具体基因清单与倍率待 OQ-08 定稿后补。
 */
export type ChallengeGeneId = Id;

/**
 * v0.4.1: 挑战基因配置占位（OQ-08 未定）。multiplier 为该基因的全局难度/收益倍率占位。
 * 本批仅落结构，不写预设组合；具体语义待 OQ-08 定稿。
 */
export interface ChallengeGeneConfig {
  id: ChallengeGeneId;
  multiplier: number;
}

/**
 * v0.4.1: FR-23 质粒软上限配置。knee 为软上限拐点（占位），对齐 Evolve 250 的收益递减曲线：
 * 质粒产出在超过 knee 后按递减曲线收敛，避免线性扩张。数值占位，待数值评审。
 */
export interface SoftCapConfig {
  knee: GameNum;
}
