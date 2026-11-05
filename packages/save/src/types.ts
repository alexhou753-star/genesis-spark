/**
 * 创世火种 · @genesis/save 存档类型 v0.4（草案，待架构师评审后冻结）
 * 位置：packages/save/src/types.ts。只允许 import @genesis/engine 的状态类型（架构 3.1）。
 *
 * v0.4 增补（对齐架构 5.8 / 6.1 / 7.2 / 7.4 / 7.5）：
 *  1. WAL 提交边界清晰化、去语义重复：WalEntry 每条命令一个稳定 commandId（唯一幂等键），cmdSeq 只用于排序；
 *     基线 SlotRecord 与应急 EmergencySlot 各自带“已提交到的命令序号”边界，恢复时据此跳过已提交 WAL，不靠 saveSeq 大小判断。
 *  2. 三种哈希齐全：transportCrc32（仅查传输损坏）+ canonicalStateHash（规范状态哈希）+ replayHash（回放哈希）。
 *  3. 信封头字段按 GS2 顺序（结构/配置/引擎/perma 档案 ID/profileId/runId/版本向量/长度/CRC）。
 *
 * v0.2 相对 v0.1 的变更：
 *  1. 新增 TimeGuard：最大已观测系统时间戳属存档层（FR-32），不进引擎状态，也不进规范状态哈希。
 *  2. 新增 CanonicalHashInput：把“规范状态哈希覆盖什么”写成类型，避免各处理解不一致。
 *  3. SavePayload 明确为 perma / run / rng / meta / timeGuard 五段（架构 7.4 原文只写 perma 与 run，已同步修订）。
 */

import type { GameCommand, GameState, PermaState, RngStream, RunState, StateMeta } from '@genesis/engine';

/** 64 位设备标识，16 位十六进制。 */
export type DeviceId = string;

export interface VersionVector {
  /** 下标 0 为最近一次保存的设备，最多 8 项。 */
  entries: Array<[DeviceId, number]>;
  /** 发生过淘汰时为真，编码为末尾的 ',~'。 */
  truncated: boolean;
}

/** 信封头部字段与架构 7.4 的 GS2 顺序一致；GS1 旧格式只经迁移链读取。 */
export interface SaveEnvelopeHeader {
  /** 精确回放与兼容判断必须同时识别引擎版本。 */
  engineVersion: number;
  schemaVersion: number;
  configVersion: number;
  /** 128 位随机十六进制；周目谱系。 */
  runId: string;
  /** 128 位随机十六进制；永久档案谱系，跨周目稳定。 */
  profileId: string;
  versionVector: VersionVector;
  payloadLength: number;
  /** 8 位十六进制。 */
  crc32: string;
}

/** 时间保护（FR-32）：回拨时经过时间记 0，以最大已观测时间戳为准。 */
export interface TimeGuard {
  highWaterMs: number;
  lastSavedAtMs: number;
}

/**
 * 信封负载（deflate + base64url 之前的 JSON）。
 * 规则：meta.schemaVersion / meta.configVersion 必须与信封头部一致，不一致按损坏处理。
 */
export interface SavePayload {
  perma: PermaState;
  run: RunState;
  rng: Record<RngStream, number>;
  meta: Omit<StateMeta, 'engineVersion'>;
  timeGuard: TimeGuard;
}

/**
 * 规范状态哈希的输入（架构 7.5）：64 位 FNV-1a，覆盖游戏状态本身。
 * 排除：保存时间、导出记录、设备标识、版本向量、saveSeq、timeGuard、三个版本号。
 * 必须包含 rng 与 currentTick，否则两个随机数状态不同的存档会得到相同哈希，读档后行为分叉。
 */
export interface CanonicalHashInput {
  perma: GameState['perma'];
  run: GameState['run'];
  rng: GameState['rng'];
  meta: Pick<StateMeta, 'tickMs' | 'currentTick' | 'subMilli' | 'runId' | 'isTutorialRun' | 'isPracticeRun'>;
}

export type SlotName = 'main_0' | 'main_1' | 'emergency' | 'backup_0' | 'backup_1' | 'reset_snapshot';

export interface SlotRecord {
  slot: SlotName;
  saveSeq: number;
  /**
   * v0.4：基线信封本身实际包含到的最大命令序号 = 提交边界。
   * 恢复时凡 cmdSeq ≤ 此值的 WAL 一律视为已提交、跳过重放（架构 7.2），不靠 saveSeq 大小判断。
   */
  committedThroughCmdSeq: number;
  envelope: string;
  savedAtMs: number;
}

export interface WalEntry {
  /**
   * 由写者会话分配的永久唯一 ID，是幂等去重的权威键（架构 6.1）；
   * 恢复时凡 commandId ∈ 已应用集合即跳过，与 cmdSeq 边界互补，二者不重复语义。
   */
  commandId: string;
  /** 单调递增命令序号，仅用于恢复时的升序重放排序，不作为幂等键。 */
  cmdSeq: number;
  /** Worker 宿主赋予的权威时刻（毫秒）；主线程不决定，避免回放错位。 */
  atTick: number;
  cmd: GameCommand;
}

export interface EmergencySlot {
  /** 仅用于挑选信封（与主槽比较新旧），绝不作为丢弃 WAL 的依据（架构 7.2）。 */
  saveSeq: number;
  /** 应急基线信封实际包含的最大命令序号 = 提交边界；恢复时跳过 cmdSeq ≤ 此值的已提交 WAL。 */
  committedThroughCmdSeq: number;
  /** 应急快照已应用到的最大命令序号；与基线 combined 判断是否有未落盘进度需重放。 */
  lastAppliedCmdSeq: number;
  envelope: string;
  wal: WalEntry[];
  /** 卸载时主线程已知的最新引擎进度，恢复时先追平到这里（架构 7.3）；与 savedAtMs 同刻快照。 */
  lastKnownTick: number;
  /** 与 lastKnownTick 同刻的墙钟，用于离线差换算（架构 7.2）。 */
  savedAtMs: number;
}

export type VersionCompare = 'different_run' | 'remote_newer' | 'remote_older' | 'diverged' | 'identical' | 'maybe_diverged';

/** 三种哈希的分工见架构 7.5。回放哈希 = 规范状态哈希 + 输入序列摘要 + 配置版本 + 引擎版本，同算法。 */
export interface StateHashes {
  /** ① 传输校验和：CRC32，覆盖头部关键字段 + 负载副本，仅查复制截断、损坏与头部篡改，不防恶意重算。 */
  transportCrc32: string;
  /** ② 规范状态哈希：64 位 FNV-1a（两个 32 位整数实现，不依赖 BigInt），覆盖游戏状态本身；导入与导出对比用。 */
  canonicalStateHash: string;
  /** ③ 回放哈希：规范状态哈希 + 输入序列摘要 + 配置版本 + 引擎版本，同算法；诊断回放与跨内核比较用。 */
  replayHash: string;
}
