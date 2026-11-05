"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
