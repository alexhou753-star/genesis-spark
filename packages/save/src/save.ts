/**
 * W4 存档层 · Gate 5 验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》存档层（M1 W4，对应 Gate 5 的 FR-30 部分与架构 7.2–7.5）。
 *
 * 本文件是「暂存验证包」的核心源文件。最终并入 packages/save 时：
 *   - 本文件移动到 packages/save/src/save.ts；
 *   - 下方「本文件内联的存档类型」改为 `import type { ... } from './types.js'`
 *     （即 packages/save/src/types.ts v0.4 的真实定义）；
 *   - `import { canonicalize, hashState } from '@genesis/engine'` 改为
 *     `from '@genesis/engine'`（hash.ts 最终属 packages/engine）。
 * 当前 w4-save-staging/ 是隔离的三文件暂存目录（仅 save.ts / save.test.ts /
 * tsconfig.json），没有同级 types.ts，故此处把 save/types.ts v0.4 中本层用到的类型
 * 内联进来（字段逐一对齐），使 save.ts 在不依赖外部类型文件的情况下可静态审查。
 *
 * ── 依据条款对照（逐函数，Gate 5 / 架构 7.2–7.5）────────────────────────────
 *   encodeEnvelope / decodeEnvelope   7.4 信封格式（GS1…END）+ 7.5 传输校验和
 *   crc32 / crc32Hex                  7.5「传输校验和：CRC32，只发现复制截断与损坏」
 *   base64urlEncode / base64urlDecode 7.4「负载：标准 base64url 编码，无填充」
 *   commitSave                        7.2 写入顺序 + 7.3 原子事务（FR-30 双槽原子提交）
 *   injectWalCrash                    7.2 WAL 清理边界 + Gate 5「写入各步骤注入崩溃」
 *   injectSaveCrash                   7.2 启动恢复 + Gate 5 崩溃注入（write/read/migrate）
 *   migratePayload                    7.8 第 5 步单向迁移链 + AC-09（Gate 5 历史版本往返）
 *   compareVersions                   7.7 版本向量五态 + 截断降级
 *   recoverDecision                   7.2 启动恢复优先级（main → emergency → backup）
 *   payloadCanonicalStateHash（附加）  7.5 规范状态哈希（转发 hash.ts，供往返对比）
 *
 * ── 说明（不得伪造运行结果）──────────────────────────────────────────────
 *   本文件是静态交付物。save.test.ts 的断言按构造逻辑推演成立，但本文不声称已在具备
 *   vitest / @types/node 的环境中实际执行通过；静态自检仅做类型与逻辑审查，未实际运行。
 */

import * as zlib from 'node:zlib';

import { canonicalize, hashState } from '@genesis/engine';

// ===========================================================================
// 〇、本文件内联的存档类型（镜像 packages/save/src/types.ts v0.4；并入正式包改 import）
// ===========================================================================

/** 64 位设备标识，16 位十六进制（types.ts）。 */
export type DeviceId = string;

/** 版本向量：entries 下标 0 为最近一次保存的设备，最多 8 项；truncated 编为末尾 ',~'。 */
export interface VersionVector {
  entries: Array<[DeviceId, number]>;
  truncated: boolean;
}

/** 时间保护（FR-32）：回拨时经过时间记 0，以最大已观测时间戳为准。 */
export interface TimeGuard {
  highWaterMs: number;
  lastSavedAtMs: number;
}

/** 槽位名（types.ts v0.4）。 */
export type SlotName = 'main_0' | 'main_1' | 'emergency' | 'backup_0' | 'backup_1' | 'reset_snapshot';

/** 版本比较六态（架构 7.7）。 */
export type VersionCompare =
  | 'different_run'
  | 'remote_newer'
  | 'remote_older'
  | 'diverged'
  | 'identical'
  | 'maybe_diverged';

/**
 * 信封头部（GS2 顺序，types.ts v0.4）：engineVersion、schemaVersion、configVersion、
 * profileId、runId、versionVector、payloadLength、crc32。
 */
export interface SaveEnvelopeHeader {
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

/** 引擎状态元信息（engine/types.ts v0.4 投影；这里只列存档层读取的字段）。 */
export interface StateMeta {
  engineVersion: number;
  schemaVersion: number;
  configVersion: number;
  tickMs: number;
  currentTick: number;
  /** 当前整 tick 内已消费的整数毫秒，0 <= subMilli < tickMs。 */
  subMilli: number;
  runId: string;
  /** 宿主持久化提交边界，用于 WAL 幂等去重；不参与玩法公式。 */
  lastAppliedCmdSeq: number;
  isPracticeRun: boolean;
  isTutorialRun: boolean;
}

/** 命名流随机数（engine/types.ts）：每条流独立的 32 位整数状态。 */
export type RngStream = 'hazard' | 'eco' | 'tutorial' | 'diplomacy';

/** 永久成长段（perma）：存档层只关心 profileId，其余字段对本层不透明。 */
export interface PermaState {
  profileId: string;
  [key: string]: unknown;
}

/** 周目数据段（run）：存档层整体搬运，不解释内部结构。 */
export interface RunState {
  [key: string]: unknown;
}

/** 游戏命令（engine/types.ts 的大型判别联合）：存档层把命令当作不透明载荷搬运。 */
export type GameCommand = { readonly type: string } & Record<string, unknown>;

/** 信封负载（deflate + base64url 之前的 JSON）：perma / run / rng / meta / timeGuard 五段。 */
export interface SavePayload {
  perma: PermaState;
  run: RunState;
  rng: Record<RngStream, number>;
  meta: Omit<StateMeta, 'engineVersion'>;
  timeGuard: TimeGuard;
}

/** 槽记录（types.ts v0.4）：committedThroughCmdSeq 为基线信封实际包含到的最大命令序号。 */
export interface SlotRecord {
  slot: SlotName;
  saveSeq: number;
  committedThroughCmdSeq: number;
  envelope: string;
  savedAtMs: number;
}

/** WAL 条目：commandId 为幂等键，cmdSeq 仅用于升序重放排序。 */
export interface WalEntry {
  commandId: string;
  cmdSeq: number;
  atTick: number;
  cmd: GameCommand;
}

/** 应急槽（types.ts v0.4）：应急基线信封 + 未落盘 WAL + 卸载时已知最新进度。 */
export interface EmergencySlot {
  saveSeq: number;
  committedThroughCmdSeq: number;
  lastAppliedCmdSeq: number;
  envelope: string;
  wal: WalEntry[];
  lastKnownTick: number;
  savedAtMs: number;
}

/** 游戏状态（engine/types.ts v0.4 投影）：meta / rng / perma / run 四段。 */
export interface GameState {
  meta: StateMeta;
  rng: Record<RngStream, number>;
  perma: PermaState;
  run: RunState;
}

// ===========================================================================
// 一、常量与小工具
// ===========================================================================

/**
 * 负载字段的「规范键顺序」。
 *
 * 依据：架构 7.4「负载：deflate 压缩后的状态 JSON（perma、run、rng、meta、timeGuard 五段）」。
 * JSON.stringify 按对象自身键的插入顺序输出；为了让「同一 payload 恒得同一字节流」（从而
 * CRC32 与 base64url 可复算、encode→decode→encode 逐位一致），在 stringify 前用
 * sortKeysDeep 显式按「五段固定顺序 + 其余键字典序」重建对象。
 */
const PAYLOAD_SECTION_ORDER: readonly string[] = ['perma', 'run', 'rng', 'meta', 'timeGuard'];

/** 信封格式标识（架构 7.4）。 */
const ENV_PREFIX = 'GS1';
/** 信封终止标（架构 7.4）：尾部被聊天软件截断时必然缺失。 */
const ENV_SUFFIX = 'END';

/** fail：统一抛错入口（代替散落的 throw，便于集中文案）；返回 never 保证分支收敛。 */
function fail(message: string): never {
  throw new Error(message);
}

// ===========================================================================
// 二、CRC32 传输校验（架构 7.5）
// ===========================================================================

/**
 * CRC32 查表（IEEE 802.3 多项式 0xEDB88320，反射输入/输出，初值 0xFFFFFFFF，末值取反）。
 *
 * 依据 7.5：传输校验和覆盖「压缩编码后的负载字符串」，算法 CRC32，只发现复制截断与
 * 损坏，不参与状态校验、不防篡改。标准查表实现，全 32 位整数运算、无浮点、确定性。
 */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * crc32：对「原始字节」计算 CRC32，返回无符号 32 位整数。
 * 为何对字节而非字符串：负载为 base64url 纯 ASCII，按字节取无歧义，且与业界标准向量一致、可外部复算。
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    crc = ((CRC32_TABLE[(crc ^ b) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** crc32Hex：CRC32 的 8 位小写十六进制（架构 7.4「8 位十六进制 CRC32」）。 */
export function crc32Hex(bytes: Uint8Array): string {
  return (crc32(bytes) >>> 0).toString(16).padStart(8, '0');
}

// ===========================================================================
// 三、base64url 编解码（架构 7.4「标准 base64url，无填充，只含 A-Z a-z 0-9 - _」）
// ===========================================================================

/** Base64url 字母表（RFC 4648 §5）。 */
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 反查表（字符 → 6 位值）；用无原型对象避免 'constructor' 等键命中。 */
const B64URL_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = Object.create(null) as Record<string, number>;
  for (let i = 0; i < B64URL_ALPHABET.length; i++) {
    map[B64URL_ALPHABET.charAt(i)] = i;
  }
  return map;
})();

/**
 * base64urlEncode：字节 → base64url（无填充）。
 * 显式实现而不依赖 Buffer：save 包同时用于 Worker 与浏览器主线程，Buffer 在浏览器不存在；
 * 显式实现保证跨环境一致（架构 6.x）。纯整数运算、确定性。
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = '';
  const n = bytes.length;
  let i = 0;
  for (; i + 3 <= n; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const n24 = (b0 << 16) | (b1 << 8) | b2;
    out += B64URL_ALPHABET.charAt((n24 >>> 18) & 0x3f);
    out += B64URL_ALPHABET.charAt((n24 >>> 12) & 0x3f);
    out += B64URL_ALPHABET.charAt((n24 >>> 6) & 0x3f);
    out += B64URL_ALPHABET.charAt(n24 & 0x3f);
  }
  const rem = n - i;
  if (rem === 1) {
    const b0 = bytes[i] ?? 0;
    const n12 = b0 << 16;
    out += B64URL_ALPHABET.charAt((n12 >>> 18) & 0x3f);
    out += B64URL_ALPHABET.charAt((n12 >>> 12) & 0x3f);
  } else if (rem === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const n24 = (b0 << 16) | (b1 << 8);
    out += B64URL_ALPHABET.charAt((n24 >>> 18) & 0x3f);
    out += B64URL_ALPHABET.charAt((n24 >>> 12) & 0x3f);
    out += B64URL_ALPHABET.charAt((n24 >>> 6) & 0x3f);
  }
  return out;
}

/**
 * base64urlDecode：base64url（无填充）→ 字节。
 * 严格模式：字母表外字符、或长度 mod 4 === 1（非法）即抛错——对应架构 7.8 第 1 步信封硬校验，
 * 把损坏/截断的负载在解码阶段即拒绝，而不是静默产生错误字节。
 */
export function base64urlDecode(s: string): Uint8Array {
  if (s.length % 4 === 1) {
    fail('base64urlDecode: 非法长度（余 1 个字符，复制可能被截断）');
  }
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    const val = B64URL_LOOKUP[ch];
    if (val === undefined) {
      fail(`base64urlDecode: 含非法字符 '${ch}'（只允许 A-Z a-z 0-9 - _）`);
    }
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

// ===========================================================================
// 四、JSON 规范键序（保证 encode/decode 逐位一致）
// ===========================================================================

/** compareCodeUnits：UTF-16 code unit 字典序（确定性键序，与 hash.ts 的 canonicalize 同口径）。 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * sortKeysDeep：把任意 JSON 值重建为「键序确定」的等价结构。
 * 顶层按 PAYLOAD_SECTION_ORDER（五段固定顺序），顶层其余键与所有嵌套对象键按 code unit 字典序；
 * 数组保持原序。仅用于输出稳定性，不改语义（架构 7.4 负载五段）。
 */
function sortKeysDeep(value: unknown, isTop: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeysDeep(v, false));
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    let ordered: string[];
    if (isTop) {
      const head = PAYLOAD_SECTION_ORDER.filter((k) => keys.includes(k));
      const tail = keys.filter((k) => !PAYLOAD_SECTION_ORDER.includes(k)).sort(compareCodeUnits);
      ordered = [...head, ...tail];
    } else {
      ordered = [...keys].sort(compareCodeUnits);
    }
    const out: Record<string, unknown> = {};
    for (const k of ordered) {
      out[k] = sortKeysDeep(obj[k], false);
    }
    return out;
  }
  return value;
}

// ===========================================================================
// 五、信封编解码（架构 7.4 + 7.5）
// ===========================================================================

/**
 * serializeVector：版本向量 → 头部字段串（架构 7.4 版本向量格式）。
 * 形如 a3f9c10200000001:50,b7e2d41100000002:12 ；发生过淘汰时末尾追加 ',~'。
 * 只用 ASCII、不含句号（句号是信封字段分隔符），可安全嵌入头部。
 */
function serializeVector(v: VersionVector): string {
  const parts = v.entries.map((e) => `${e[0]}:${e[1]}`);
  const s = parts.join(',');
  if (v.truncated) {
    return s.length > 0 ? `${s},~` : ',~';
  }
  return s;
}

/**
 * parseVector：头部字段串 → 版本向量（serializeVector 的逆）。
 * 截断标记 ',~' 识别为 truncated=true 并剥离；每项须为 `<设备ID>:<非负整数>`，否则抛错（头部损坏）。
 */
function parseVector(raw: string): VersionVector {
  let s = raw;
  let truncated = false;
  if (s.endsWith(',~')) {
    truncated = true;
    s = s.slice(0, -2);
  }
  if (s.length === 0) {
    return { entries: [], truncated };
  }
  const entries: Array<[string, number]> = [];
  for (const item of s.split(',')) {
    const idx = item.lastIndexOf(':');
    if (idx <= 0) {
      fail(`parseVector: 版本向量项格式非法 '${item}'`);
    }
    const deviceId = item.slice(0, idx);
    const countStr = item.slice(idx + 1);
    if (!/^\d+$/.test(countStr)) {
      fail(`parseVector: 版本向量计数非法 '${countStr}'`);
    }
    entries.push([deviceId, Number(countStr)]);
  }
  return { entries, truncated };
}

/** parseIntStrict：十进制非负整数字符串 → number，否则抛错（头部字段严格解析）。 */
function parseIntStrict(s: string, field: string): number {
  if (!/^\d+$/.test(s)) {
    fail(`decodeEnvelope: 头部字段 '${field}' 不是非负整数（'${s}'）`);
  }
  const v = Number(s);
  if (!Number.isSafeInteger(v)) {
    fail(`decodeEnvelope: 头部字段 '${field}' 超出安全整数范围（'${s}'）`);
  }
  return v;
}

/**
 * encodeEnvelope：SavePayload + SaveEnvelopeHeader → 自描述纯 ASCII 信封串（架构 7.4）。
 *
 * 流程：① payload 规范键序化 → JSON.stringify → UTF-8 字节；② deflate 压缩（Node zlib；
 * 浏览器落地换 fflate，架构 8.3 允许 save 引 fflate）；③ 压缩字节 → base64url（无填充）；
 * ④ 计算负载字符数与 CRC32 回填；⑤ 按 GS2 头部字段顺序拼装：
 *   GS1.<engineVersion>.<schemaVersion>.<configVersion>.<profileId>.<runId>.
 *       <versionVector>.<payloadLength>.<crc32>.<payload>.END
 *
 * 注意：CRC32 只查传输损坏（7.5），不参与状态校验；payloadLength 以「压缩编码后负载字符数」
 * 计（base64url 是 ASCII，字符数=字节数），用于识别复制截断（7.4 用途）。
 *
 * @throws Error 若 header 与 payload.meta 的版本号不一致（架构 7.4：不一致按损坏处理）
 */
export function encodeEnvelope(payload: SavePayload, header: SaveEnvelopeHeader): string {
  const metaProbe = payload.meta as unknown as { schemaVersion?: number; configVersion?: number };
  if (metaProbe.schemaVersion !== undefined && metaProbe.schemaVersion !== header.schemaVersion) {
    fail('encodeEnvelope: payload.meta.schemaVersion 与 header.schemaVersion 不一致（按损坏处理）');
  }
  if (metaProbe.configVersion !== undefined && metaProbe.configVersion !== header.configVersion) {
    fail('encodeEnvelope: payload.meta.configVersion 与 header.configVersion 不一致（按损坏处理）');
  }

  const ordered = sortKeysDeep(payload, true);
  const json = JSON.stringify(ordered);
  const jsonBytes = utf8Bytes(json);

  const compressed = zlib.deflateRawSync(jsonBytes);
  const payloadStr = base64urlEncode(new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength));

  const payloadBytes = asciiBytes(payloadStr);
  const payloadLength = payloadStr.length;
  const crc = crc32Hex(payloadBytes);

  const vectorStr = serializeVector(header.versionVector);
  return [
    ENV_PREFIX,
    String(header.engineVersion),
    String(header.schemaVersion),
    String(header.configVersion),
    header.profileId,
    header.runId,
    vectorStr,
    String(payloadLength),
    crc,
    payloadStr,
    ENV_SUFFIX,
  ].join('.');
}

/**
 * decodeEnvelope：自描述信封串 → { payload, header }（架构 7.4 + 7.8 静态校验部分）。
 *
 * 校验顺序：① GS1 前缀 + END 终止标 + 字段数；② 版本/向量解析、payloadLength 严格匹配；
 * ③ 负载 base64url 解码 → inflate → JSON；④ CRC32 重算比对（只查传输损坏）；⑤ 头/负载 meta
 * 版本号一致性复核。
 *
 * @throws Error 任一校验失败（视为复制截断 / 损坏）
 */
export function decodeEnvelope(raw: string): { payload: SavePayload; header: SaveEnvelopeHeader } {
  if (typeof raw !== 'string' || raw.length === 0) {
    fail('decodeEnvelope: 输入为空');
  }
  if (!raw.startsWith(`${ENV_PREFIX}.`)) {
    fail('decodeEnvelope: 缺少 GS1 前缀（非本游戏信封或已损坏）');
  }
  if (!raw.endsWith(`.${ENV_SUFFIX}`)) {
    fail('decodeEnvelope: 缺少 END 终止标（文本可能在复制中被截断）');
  }
  const body = raw.slice(ENV_PREFIX.length + 1, raw.length - (ENV_SUFFIX.length + 1));
  const fields = body.split('.');
  if (fields.length !== 9) {
    fail(`decodeEnvelope: 字段数量非法（期望 9 段，实得 ${fields.length} 段）`);
  }
  const engineVersionStr = fields[0] ?? '';
  const schemaVersionStr = fields[1] ?? '';
  const configVersionStr = fields[2] ?? '';
  const profileId = fields[3] ?? '';
  const runId = fields[4] ?? '';
  const vectorStr = fields[5] ?? '';
  const payloadLengthStr = fields[6] ?? '';
  const crcField = fields[7] ?? '';
  const payloadStr = fields[8] ?? '';

  const engineVersion = parseIntStrict(engineVersionStr, 'engineVersion');
  const schemaVersion = parseIntStrict(schemaVersionStr, 'schemaVersion');
  const configVersion = parseIntStrict(configVersionStr, 'configVersion');
  const payloadLength = parseIntStrict(payloadLengthStr, 'payloadLength');
  if (!/^[0-9a-f]{8}$/.test(crcField)) {
    fail('decodeEnvelope: CRC32 字段必须为 8 位小写十六进制');
  }
  if (payloadStr.length !== payloadLength) {
    fail(
      `decodeEnvelope: 负载长度不符（头部声明 ${payloadLength}，实际 ${payloadStr.length}，疑似复制截断）`,
    );
  }
  const versionVector = parseVector(vectorStr);

  const compressed = base64urlDecode(payloadStr);
  let jsonBytes!: Uint8Array;
  try {
    const inflated = zlib.inflateRawSync(new Uint8Array(compressed.buffer, compressed.byteOffset, compressed.byteLength));
    jsonBytes = new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength);
  } catch (e) {
    fail(`decodeEnvelope: 负载解压失败（流损坏）: ${(e as Error).message}`);
  }
  let payload!: SavePayload;
  try {
    payload = JSON.parse(utf8Decode(jsonBytes)) as SavePayload;
  } catch (e) {
    fail(`decodeEnvelope: 负载 JSON 解析失败: ${(e as Error).message}`);
  }

  const crcActual = crc32Hex(asciiBytes(payloadStr));
  if (crcActual !== crcField) {
    fail(`decodeEnvelope: CRC32 校验失败（头部 ${crcField} ≠ 实算 ${crcActual}，可能传输损坏）`);
  }

  const metaProbe = payload.meta as unknown as { schemaVersion?: number; configVersion?: number };
  if (metaProbe.schemaVersion !== undefined && metaProbe.schemaVersion !== schemaVersion) {
    fail('decodeEnvelope: header.schemaVersion 与 payload.meta.schemaVersion 不一致（按损坏处理）');
  }
  if (metaProbe.configVersion !== undefined && metaProbe.configVersion !== configVersion) {
    fail('decodeEnvelope: header.configVersion 与 payload.meta.configVersion 不一致（按损坏处理）');
  }

  const header: SaveEnvelopeHeader = {
    engineVersion,
    schemaVersion,
    configVersion,
    runId,
    profileId,
    versionVector,
    payloadLength,
    crc32: crcField,
  };
  return { payload, header };
}

// ===========================================================================
// 六、双槽原子提交（架构 7.2 写入顺序 + 7.3 原子事务 · FR-30）
// ===========================================================================

/** 主槽名集合：commitSave 只在 main_0 / main_1 之间交替滚动（架构 7.1）。 */
const MAIN_SLOTS: readonly SlotName[] = ['main_0', 'main_1'];

/**
 * oppositeMainSlot：给定当前主槽，返回「对面」主槽。
 * 架构 7.2 第 2 步：把信封写入「非活动槽」，再切换活动指针。
 */
export function oppositeMainSlot(currentSlot: SlotName): SlotName {
  if (currentSlot === 'main_0') return 'main_1';
  if (currentSlot === 'main_1') return 'main_0';
  return fail(`oppositeMainSlot: 非主槽 '${currentSlot}' 不支持双槽滚动`);
}

/**
 * payloadFromState：GameState → { payload, header }（供 encodeEnvelope）。
 * 抽取 perma/run/rng/meta/timeGuard 五段（架构 7.4）。timeGuard 由存档层维护（FR-32），
 * 这里用状态内 currentTick 占位，不读时钟（保持确定性）。
 */
export function payloadFromState(state: GameState): { payload: SavePayload; header: SaveEnvelopeHeader } {
  const meta = state.meta;
  const payload: SavePayload = {
    perma: state.perma,
    run: state.run,
    rng: state.rng,
    meta: {
      schemaVersion: meta.schemaVersion,
      configVersion: meta.configVersion,
      tickMs: meta.tickMs,
      currentTick: meta.currentTick,
      subMilli: meta.subMilli,
      runId: meta.runId,
      lastAppliedCmdSeq: meta.lastAppliedCmdSeq,
      isPracticeRun: meta.isPracticeRun,
      isTutorialRun: meta.isTutorialRun,
    },
    timeGuard: {
      highWaterMs: meta.currentTick,
      lastSavedAtMs: meta.currentTick,
    },
  };
  const header: SaveEnvelopeHeader = {
    engineVersion: meta.engineVersion,
    schemaVersion: meta.schemaVersion,
    configVersion: meta.configVersion,
    runId: meta.runId,
    profileId: state.perma.profileId,
    versionVector: { entries: [], truncated: false },
    payloadLength: 0, // encodeEnvelope 内部按实际负载回填
    crc32: '00000000',
  };
  return { payload, header };
}

/**
 * commitSave：双槽原子提交（架构 7.2 写入顺序 + 7.3 原子事务）。
 *
 * 语义（对应 7.2 第 1–2 步、7.3 第 6 步）：
 *   1. 目标槽 = currentSlot 的对面槽；新 saveSeq = 当前活动槽 saveSeq + 1。
 *   2. 在内存中把 state 编码为新信封（编码失败 → 指针不移动）。
 *   3. 写入目标槽后返回「已切换」的槽数组（新数组，不改入参）：目标槽成为新活动槽。
 *   4. 写入失败则**不破坏当前槽**：返回原样副本 + committed=false。
 *
 * 原子性说明：真实持久化由 IndexedDB 事务保证「写目标槽 + 移动指针」原子（7.2 第 2 步）；
 * 本函数是该事务「提交成功 / 失败」的纯内存建模。返回新数组而非原地修改，天然满足
 * 「写一半崩溃不损坏当前槽」——要么得到含新信封的新数组，要么得到与入参逐项相同的副本。
 *
 * @returns { newSlots, committed }
 */
export function commitSave(
  state: GameState,
  slots: SlotRecord[],
  currentSlot: SlotName,
): { newSlots: SlotRecord[]; committed: boolean } {
  const target = oppositeMainSlot(currentSlot);
  const current = slots.find((s) => s.slot === currentSlot);
  if (!current) {
    return fail(`commitSave: 当前活动槽 '${currentSlot}' 不存在于 slots 中`);
  }
  const nextSeq = current.saveSeq + 1;
  const committedThroughCmdSeq = state.meta.lastAppliedCmdSeq;

  // 1) 生成信封（写入前完成；任何异常都发生在指针移动前 → 当前槽不受影响）
  //    写前先做状态有限性守卫（架构 5.6 阶段末断言：所有库存/速率为有限值）。含 NaN/Infinity
  //    的状态在真实引擎里应中止当前步、不落盘；这里建模为「写入失败 → 不移动指针」。
  let envelope: string;
  try {
    if (containsNonFinite(state)) {
      throw new Error('commitSave: 状态含非有限数值，拒绝落盘（模拟写入失败）');
    }
    const { payload, header } = payloadFromState(state);
    envelope = encodeEnvelope(payload, header);
  } catch {
    return { newSlots: slots.slice(), committed: false };
  }

  // 2) 写入目标槽（模型化 IndexedDB 写入）
  const newRecord: SlotRecord = {
    slot: target,
    saveSeq: nextSeq,
    committedThroughCmdSeq,
    envelope,
    savedAtMs: state.meta.currentTick, // 存档层时间占位；不读时钟，保持确定性
  };

  // 3) 原子「提交成功」建模：只替换目标槽，其余原样
  const newSlots: SlotRecord[] = slots.map((s) => (s.slot === target ? newRecord : s));
  return { newSlots, committed: true };
}

// ===========================================================================
// 七、WAL 故障注入（架构 7.2 WAL 清理边界 + Gate 5 写入各步骤崩溃）
// ===========================================================================

/**
 * injectWalCrash：模拟 WAL 写入过程中崩溃（Gate 5「写入各步骤注入崩溃」）。
 *
 * 语义：崩溃发生在第 crashAfter 条之后、第 crashAfter+1 条之前，故 WAL 只保留前 crashAfter 条
 * （截断到 crashAfter 条）。测试恢复时应只重放这 crashAfter 条已落盘命令，缩小丢档窗口
 * （架构 6.3 / S8）。
 *
 * 边界：crashAfter <= 0 → 空数组；crashAfter >= wal.length → 全量。纯函数、返回新数组。
 *
 * @param wal        原始 WAL
 * @param crashAfter 崩溃前已成功写入的条数
 */
export function injectWalCrash(wal: WalEntry[], crashAfter: number): WalEntry[] {
  const keep = Math.max(0, Math.min(Math.floor(crashAfter), wal.length));
  return wal.slice(0, keep);
}

// ===========================================================================
// 八、崩溃注入（架构 7.2 启动恢复 + Gate 5 崩溃注入三阶段）
// ===========================================================================

/** pickActiveSlot：按 saveSeq 最大挑选活动槽（并列取后出现者，确定）——用于崩溃注入的「活动指针」语义。 */
function pickActiveSlot(slots: SlotRecord[]): SlotRecord {
  let best = slots[0] as SlotRecord;
  for (const s of slots) {
    if (s.saveSeq >= best.saveSeq) best = s;
  }
  return best;
}

/**
 * pickByCommitted：按 committedThroughCmdSeq 最大挑选基线槽（并列时取 saveSeq 更大者）。
 *
 * 依据 save/types.ts v0.4 对 SlotRecord.committedThroughCmdSeq 的注释：
 * 「恢复时按 cmdSeq ≤ committedThroughCmdSeq 判定已提交，不靠 saveSeq 大小判断」。
 * 故恢复基线由「提交边界更高的槽」决定，而非 saveSeq。
 */
function pickByCommitted(slots: SlotRecord[]): SlotRecord {
  let best = slots[0] as SlotRecord;
  for (const s of slots) {
    if (s.committedThroughCmdSeq > best.committedThroughCmdSeq) {
      best = s;
    } else if (s.committedThroughCmdSeq === best.committedThroughCmdSeq && s.saveSeq >= best.saveSeq) {
      best = s;
    }
  }
  return best;
}

/** pickNonActiveSlot：返回一个非活动槽（优先 saveSeq 最大者），无则 null。 */
function pickNonActiveSlot(slots: SlotRecord[], active: SlotRecord): SlotRecord | null {
  let best: SlotRecord | null = null;
  for (const s of slots) {
    if (s.slot === active.slot) continue;
    if (best === null || s.saveSeq >= best.saveSeq) best = s;
  }
  return best;
}

/** withCorruptEnvelope：把一个槽的信封替换成「损坏/半迁移」的伪信封（必使 decodeEnvelope 抛错）。 */
function withCorruptEnvelope(s: SlotRecord, stage: 'write' | 'read' | 'migrate'): SlotRecord {
  const marker = `#CRASH-${stage}#`;
  const corrupt = marker + s.envelope.slice(0, Math.max(0, Math.floor(s.envelope.length / 2)));
  return { ...s, envelope: corrupt };
}

/**
 * injectSaveCrash：模拟存档各阶段崩溃（Gate 5 崩溃注入）。
 *
 *   - 'write'  ：写一半 → 只破坏「非当前活动」的槽（写目标是活动槽的对面槽）；当前活动槽
 *                保持有效 → 满足「写一半崩溃不损坏当前槽」。
 *   - 'read'   ：读损坏 → 破坏一个非活动槽（模拟读取时发现该槽损坏，应回退到活动/上一槽）。
 *   - 'migrate'：迁移中断 → 追加一个「半迁移」残骸记录（slot 复用活动槽名以示试图迁移它），
 *                但不覆盖原活动槽有效记录（迁移失败不移动指针，7.3 第 6 步）。
 *
 * 返回新数组，不改入参。恢复决策见 recoverDecision。
 *
 * @param slots       原始槽记录
 * @param crashDuring 崩溃阶段
 */
export function injectSaveCrash(slots: SlotRecord[], crashDuring: 'write' | 'read' | 'migrate'): SlotRecord[] {
  if (slots.length === 0) return [];
  const active = pickActiveSlot(slots);
  switch (crashDuring) {
    case 'write': {
      const victim = pickNonActiveSlot(slots, active);
      if (!victim) return slots.map((s) => ({ ...s }));
      return slots.map((s) => (s.slot === victim.slot ? withCorruptEnvelope(s, 'write') : { ...s }));
    }
    case 'read': {
      const victim = pickNonActiveSlot(slots, active);
      if (!victim) return slots.map((s) => ({ ...s }));
      return slots.map((s) => (s.slot === victim.slot ? withCorruptEnvelope(s, 'read') : { ...s }));
    }
    case 'migrate': {
      const corruptMigrating = withCorruptEnvelope({ ...active }, 'migrate');
      // 原活动槽仍有效；残骸追加在末尾，供恢复逻辑忽略。
      return [...slots.map((s) => ({ ...s })), corruptMigrating];
    }
    default:
      return fail(`injectSaveCrash: 未知 crashDuring '${String(crashDuring)}'`);
  }
}

// ===========================================================================
// 九、迁移链骨架（架构 7.8 第 5 步 · AC-09）
// ===========================================================================

/** 迁移函数类型：把一个版本的 payload 迁移到下一个版本（只做 N → N+1）。 */
export type MigrationStep = (payload: SavePayload) => SavePayload;

/**
 * 迁移链注册表：key 为起始版本，value 为「迁到 key+1」的迁移函数。
 *
 * 当前只有 v1 → v2 的示例迁移：v2 在 run 段新增 `journal`（周目日志，对应架构 8.1 体积预算里
 * 「周目日志设上限」的字段）——用显式新字段演示「加字段」迁移。后续版本在此追加（2→3、3→4…），
 * migratePayload 会自动逐级串接，调用方无需改动。
 *
 * 依据 7.8：结构版本高于客户端则拒绝；低于则执行单向迁移链。
 */
const MIGRATIONS: Readonly<Record<number, MigrationStep>> = {
  1: (payload) => {
    const run = payload.run as unknown as Record<string, unknown>;
    const nextRun: Record<string, unknown> = { ...run };
    if (!('journal' in nextRun)) {
      nextRun.journal = [] as unknown[];
    }
    return {
      ...payload,
      run: nextRun as unknown as RunState,
    };
  },
  // 预留：2: (p) => {...}, 3: (p) => {...}, ...
};

/**
 * migratePayload：按迁移链把 payload 从 fromVersion 逐级迁移到 toVersion（架构 7.8 第 5 步、AC-09）。
 *
 * 规则：
 *   - fromVersion === toVersion：原样返回。
 *   - fromVersion > toVersion：降级不受支持，抛错（高版本结构不能安全回退）。
 *   - fromVersion === 0：视为「无结构」的新建，归一为最低版本 1 再迁移。
 *   - 逐级：对 v = from; v < to; v++ 执行 MIGRATIONS[v]，缺步骤即抛错（迁移链不完整）。
 *
 * 纯函数：不修改入参 payload（各步返回新对象）。
 *
 * @returns 迁移到 toVersion 的 payload
 * @throws Error 迁移链缺步 / 降级 / 非整数版本
 */
export function migratePayload(payload: SavePayload, fromVersion: number, toVersion: number): SavePayload {
  if (!Number.isInteger(fromVersion) || !Number.isInteger(toVersion)) {
    return fail('migratePayload: 版本号必须为整数');
  }
  if (fromVersion > toVersion) {
    return fail(`migratePayload: 不支持降级迁移（from ${fromVersion} > to ${toVersion}）`);
  }
  if (fromVersion === toVersion) {
    return payload;
  }
  let current = fromVersion === 0 ? 1 : fromVersion;
  let result = payload;
  while (current < toVersion) {
    const step = MIGRATIONS[current];
    if (!step) {
      return fail(`migratePayload: 迁移链缺少 v${current} → v${current + 1} 的迁移步骤`);
    }
    result = step(result);
    current += 1;
  }
  return result;
}

// ===========================================================================
// 十、版本比较（架构 7.7 版本向量五态 + 截断降级）
// ===========================================================================

/** vectorToMap：版本向量 → 设备计数映射（未出现设备视为 0，架构 7.7）。 */
function vectorToMap(v: VersionVector): Map<string, number> {
  const m = new Map<string, number>();
  for (const [id, count] of v.entries) {
    const prev = m.get(id);
    m.set(id, prev === undefined ? count : Math.max(prev, count));
  }
  return m;
}

/** vectorSum：版本向量所有设备计数之和（「同分不同分布」判定用）。 */
function vectorSum(v: VersionVector): number {
  let sum = 0;
  for (const [, count] of v.entries) sum += count;
  return sum;
}

/** canonicalVectorKey：向量归一为「排序后的 设备:计数」串（identical 比较，忽略顺序）。 */
function canonicalVectorKey(v: VersionVector): string {
  return [...vectorToMap(v).entries()]
    .sort((a, b) => compareCodeUnits(a[0], b[0]))
    .map(([id, count]) => `${id}:${count}`)
    .join(',');
}

/**
 * compareVersions：比较本机版本向量 local 与待导入存档 remote，返回 VersionCompare（架构 7.7）。
 *
 * 判定（未出现设备计数视为 0）：
 *   - identical      : 两向量计数逐设备完全相等（顺序无关）。
 *   - remote_newer   : remote 严格支配 local（每设备 ≥，且至少一个更大）。
 *   - remote_older   : local 严格支配 remote。
 *   - diverged       : 互不支配且总计数不等（两台各自推进的真分叉）。
 *   - maybe_diverged : 互不支配但总计数相等；或任一方截断标记为真时的保守降级。
 *   - different_run  : 两向量设备集合完全不相交（无法建立共同谱系，视为不同周目/不同设备链）。
 *
 * 截断降级（架构 7.7 末段）：任一方 truncated 为真 → 任何「支配」结论降级为 maybe_diverged
 *   （宁可多问一次也不误判）；identical 因计数完全相等仍可直接判定。
 *
 * @param local  本机存档版本向量
 * @param remote 待导入存档版本向量
 */
export function compareVersions(local: VersionVector, remote: VersionVector): VersionCompare {
  if (canonicalVectorKey(local) === canonicalVectorKey(remote)) {
    return 'identical';
  }

  const lm = vectorToMap(local);
  const rm = vectorToMap(remote);
  const deviceIds = new Set<string>([...lm.keys(), ...rm.keys()]);

  if (deviceIds.size === 0) {
    return 'different_run';
  }
  const hasCommon = [...lm.keys()].some((id) => rm.has(id));
  if (!hasCommon) {
    return 'different_run';
  }

  let remoteDominates = true;
  let localDominates = true;
  let anyGreaterRemote = false;
  let anyGreaterLocal = false;
  for (const id of deviceIds) {
    const l = lm.get(id) ?? 0;
    const r = rm.get(id) ?? 0;
    if (r < l) remoteDominates = false;
    if (r > l) anyGreaterRemote = true;
    if (l < r) localDominates = false;
    if (l > r) anyGreaterLocal = true;
  }
  if (!anyGreaterRemote) remoteDominates = false;
  if (!anyGreaterLocal) localDominates = false;

  const truncated = local.truncated || remote.truncated;
  if (remoteDominates) {
    return truncated ? 'maybe_diverged' : 'remote_newer';
  }
  if (localDominates) {
    return truncated ? 'maybe_diverged' : 'remote_older';
  }

  if (vectorSum(local) === vectorSum(remote)) {
    return 'maybe_diverged';
  }
  return 'diverged';
}

// ===========================================================================
// 十一、恢复决策（架构 7.2 启动恢复优先级）
// ===========================================================================

/**
 * recoverDecision：根据主槽与应急槽决定用哪个槽恢复（架构 7.2 第 1–3 步）。
 *
 * 依据 7.2 + save/types.ts v0.4：主槽取 committedThroughCmdSeq 最大者为基线（对齐 v0.4
 * 「不靠 saveSeq 大小判断」）；若应急槽校验通过且「基于的 saveSeq ≥ 基线」且「lastKnownTick /
 * 已应用命令序号领先基线」，则用应急信封 + WAL 追平；若 emergency.saveSeq 小于基线，说明
 * 主槽更新，直接丢弃 emergency。无主槽时回退应急槽。reason 中同时给出 saveSeq 以便诊断。
 *
 * @throws Error 主槽与应急槽均不可用（调用方进入新游戏/备份恢复，7.2 第 5 步）
 */
export function recoverDecision(
  slots: SlotRecord[],
  emergency: EmergencySlot | null,
): { useSlot: SlotName; useEmergency: boolean; reason: string } {
  const mainSlots = slots.filter((s) => MAIN_SLOTS.includes(s.slot));

  if (mainSlots.length === 0) {
    if (emergency) {
      return {
        useSlot: 'emergency',
        useEmergency: true,
        reason: '无有效主槽，回退到校验通过的应急槽（架构 7.2 第 3 步）',
      };
    }
    return fail('recoverDecision: 主槽与应急槽均不可用，调用方应进入新游戏或从备份槽恢复');
  }

  const baseline = pickByCommitted(mainSlots);
  const baselineTick = baseline.savedAtMs;
  const baselineCommitted = baseline.committedThroughCmdSeq;

  if (emergency) {
    const emergencyNotOlder = emergency.saveSeq >= baseline.saveSeq;
    const emergencyAhead =
      emergency.lastKnownTick > baselineTick ||
      emergency.lastAppliedCmdSeq > baselineCommitted ||
      emergency.committedThroughCmdSeq > baselineCommitted;
    if (emergencyNotOlder && emergencyAhead) {
      return {
        useSlot: 'emergency',
        useEmergency: true,
        reason:
          `应急槽更新（saveSeq=${emergency.saveSeq} ≥ 基线 ${baseline.saveSeq}，` +
          `lastKnownTick=${emergency.lastKnownTick} 领先）→ 加载应急信封并重放 WAL 追平（架构 7.2 第 3 步）`,
      };
    }
    return {
      useSlot: baseline.slot,
      useEmergency: false,
      reason:
        `应急槽不领先（saveSeq=${emergency.saveSeq} / 基线 ${baseline.saveSeq}）→ 用主槽 ` +
        `${baseline.slot}（saveSeq=${baseline.saveSeq}，架构 7.2 第 2 步）`,
    };
  }

  return {
    useSlot: baseline.slot,
    useEmergency: false,
    reason: `无应急槽，用 saveSeq 最大的主槽 ${baseline.slot}（saveSeq=${baseline.saveSeq}，架构 7.2 第 2 步）`,
  };
}

// ===========================================================================
// 十二、（附加）规范状态哈希封装（转发 hash.ts，架构 7.5，供往返对比）
// ===========================================================================

/**
 * payloadCanonicalStateHash：计算 payload 的规范状态哈希（架构 7.5）。
 *
 * 覆盖：perma、run、rng 与 meta 中应纳入字段（currentTick/subMilli/tickMs/runId/
 * isTutorialRun/isPracticeRun）；排除 timeGuard、版本向量、saveSeq、三个版本号。
 * 做法：先构造「裁剪后的纯状态子对象」，再交 hash.ts 的 canonicalize / hashState
 * （单一来源，不重复实现）。Gate 5 往返测试用它对比导入前后一致。
 */
export function payloadCanonicalStateHash(payload: SavePayload): string {
  const meta = payload.meta;
  const hashInput = {
    perma: payload.perma,
    run: payload.run,
    rng: payload.rng,
    meta: {
      currentTick: meta.currentTick,
      subMilli: meta.subMilli,
      tickMs: meta.tickMs,
      runId: meta.runId,
      isTutorialRun: meta.isTutorialRun,
      isPracticeRun: meta.isPracticeRun,
    },
  };
  void canonicalize(hashInput); // 先触发 NaN/Infinity 等确定性错误
  return hashState(hashInput);
}

// ===========================================================================
// 十三、UTF-8 / ASCII 字节工具（显式实现，不依赖 TextEncoder/Buffer）
// ===========================================================================

/**
 * containsNonFinite：递归检测状态中是否含 NaN / ±Infinity。
 *
 * 用途：commitSave 写前的有限性守卫（架构 5.6 阶段末断言「所有库存与速率为有限值」）。
 * 只遍历普通对象与数组；JSON 负载本身不允许出现非有限数值，遇到即应拒绝落盘。
 */
function containsNonFinite(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (typeof value === 'number') {
    return !Number.isFinite(value);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (seen.has(value)) return false; // 循环引用防御（状态里不应出现，但避免死循环）
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value as unknown[]) {
      if (containsNonFinite(v, seen)) return true;
    }
  } else {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (containsNonFinite(obj[k], seen)) return true;
    }
  }
  return false;
}

/** asciiBytes：纯 ASCII 字符串 → 字节（信封负载、头部均为 ASCII）。 */
function asciiBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    out.push(s.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

/**
 * utf8Bytes：字符串 → UTF-8 字节（显式实现，与 hash.ts 同口径）。
 * 不用 TextEncoder：保证跨内核编码一致、不依赖较新 API；孤立代理项用 U+FFFD（WHATWG 一致）。
 */
function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      } else {
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      code = 0xfffd;
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** utf8Decode：UTF-8 字节 → 字符串（逆 utf8Bytes）；非法序列抛错（视为负载损坏）。 */
function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i] ?? 0;
    let code: number;
    if (b0 < 0x80) {
      code = b0;
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i + 1];
      if (b1 === undefined || (b1 & 0xc0) !== 0x80) return fail('utf8Decode: 非法 2 字节序列');
      code = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      if (b1 === undefined || b2 === undefined || (b1 & 0xc0) !== 0x80 || (b2 & 0xc0) !== 0x80) {
        return fail('utf8Decode: 非法 3 字节序列');
      }
      code = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      i += 3;
    } else if ((b0 & 0xf8) === 0xf0) {
      const b1 = bytes[i + 1];
      const b2 = bytes[i + 2];
      const b3 = bytes[i + 3];
      if (
        b1 === undefined ||
        b2 === undefined ||
        b3 === undefined ||
        (b1 & 0xc0) !== 0x80 ||
        (b2 & 0xc0) !== 0x80 ||
        (b3 & 0xc0) !== 0x80
      ) {
        return fail('utf8Decode: 非法 4 字节序列');
      }
      code = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      i += 4;
    } else {
      return fail('utf8Decode: 非法 UTF-8 首字节');
    }
    if (code <= 0xffff) {
      out += String.fromCharCode(code);
    } else {
      const cp = code - 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}
