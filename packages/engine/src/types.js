"use strict";
/**
 * 创世火种 · @genesis/engine 状态与命令类型 v0.4（草案，待架构师评审后冻结）
 * 位置：packages/engine/src/types.ts。只允许 import @genesis/configs 的类型（架构 3.1）。
 *
 * v0.4 增补：profileId 谱系、subMilli 整数毫秒进度、diplomacy 随机流与外交权威状态、remainingMs 亚 tick 续算，
 * 以及通用事件契约（atMilli / seq / group / kind / payload，组序与诊断均可表达）。
 *
 * v0.4.1 增补（批次二/B 组）：TIMER 事件负载的 timer 联合追加 'government_cooldown' | 'failure_duration' |
 *   'neighbor_slow_change'（事件点 7 注册表成员，M2/M3 开工前登记口径的固化）。仅追加成员，不破坏已有联合。
 *
 * v0.4.1 增补（批次三/C 组）：新增政体 GovernmentState（挂 RunState.government）、失败梯度 FailureState
 *   （挂 RunState.failure）、母星折叠 HomeworldFoldState（挂 RunState.homeworldFold）；GameCommand 追加
 *   GOVERNMENT_CHOOSE。仅追加类型 / 字段 / 命令成员，不破坏已有联合。
 *
 * v0.3 增补：UniverseRecord / universeId / starLevel（FR-25、26 入存档）、QueueItem 的最大可接受成本与暂停、RESET 带宇宙与星级。
 *
 * v0.2 相对 v0.1 的变更：
 *  1. RESET 命令携带 seed 与 runId：引擎不读时钟、不生成随机数（架构 5.1），新周目的种子与周目 ID 必须由调用方给，
 *     且必须随命令进入输入日志，否则回放无法复现。
 *  2. 移除 OrdersState.highWaterMs：最大已观测系统时间戳是挂钟数据，属存档层的时间保护（FR-32），
 *     放进引擎状态会让引擎状态依赖挂钟，并进入规范状态哈希。已移到 @genesis/save 的 TimeGuard。
 *  3. 文档化“规范状态哈希覆盖范围”：perma、run、rng、meta 中的 currentTick / tickMs / runId / isTutorialRun。
 *     架构 7.4 / 7.5 原文只写 perma 与 run 两段，会漏掉随机数状态与当前 tick；已同步修订架构文档。
 *  4. 季节不入状态：当前季节与剩余时间由 currentTick 与 clock.seasonSec 推导（暂停时 tick 不走，天然满足 FR-10）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
