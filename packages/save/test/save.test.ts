/**
 * W4 存档层 · Gate 5 验收对象
 * 单测条款：信封往返 · CRC32 损坏检测 · 双槽原子提交 · WAL 故障注入 · 崩溃注入 ·
 *           迁移链 · 版本比较五态 · 恢复决策
 * ---------------------------------------------------------------------------
 * 覆盖任务要求的 a–h 八类断言（对应 Gate 5 的 FR-30 部分、架构 7.2–7.5、7.7、7.8）：
 *   a) 信封往返：encode→decode 后 payload 与 header 逐位一致（另验 encode→decode→encode 逐位一致）。
 *   b) CRC32 损坏检测：改负载一字节 → decode 抛错（CRC32 不符）。
 *   c) 双槽原子提交：写 currentSlot 对面槽，成功后切换；写失败当前槽不变。
 *   d) WAL 故障注入：crashAfter=3 时 WAL 截断到 3 条。
 *   e) 崩溃注入：write 崩溃后当前（活动）槽不损坏。
 *   f) 迁移链：v1→v2 加字段，迁移后结构正确；缺步/降级抛错。
 *   g) 版本比较：五态各覆盖（different_run/remote_newer/remote_older/diverged/identical/maybe_diverged）。
 *   h) 恢复决策：按 committedThroughCmdSeq 选择正确槽（含应急槽领先/落后）。
 *
 * 说明（不得伪造运行结果）：
 *   本文件是静态交付物。断言的“期望值”来自本模块构造逻辑的静态推演（往返一致、字节翻转
 *   必改 CRC、槽切换语义、WAL 截断、迁移加字段、六态判定、按提交边界选槽），并非已在具备
 *   vitest 的环境中实际 `npm run test` 通过的结果；本文不声称已实际运行。
 *   import 路径按任务要求固定为 '../src/save.js'（并入 packages/save 后，测试位于
 *   packages/save/test/，vitest 解析到 packages/save/src/save.ts）。
 */
import { describe, it, expect } from 'vitest';

import {
  encodeEnvelope,
  decodeEnvelope,
  crc32Hex,
  commitSave,
  oppositeMainSlot,
  injectWalCrash,
  injectSaveCrash,
  migratePayload,
  compareVersions,
  recoverDecision,
  payloadFromState,
  payloadCanonicalStateHash,
} from '../src/save.js';
import type {
  EmergencySlot,
  GameState,
  SaveEnvelopeHeader,
  SavePayload,
  SlotRecord,
  VersionVector,
  WalEntry,
} from '../src/save.js';

// ---------------------------------------------------------------------------
// 测试夹具（fixtures）
// ---------------------------------------------------------------------------

/** utf8：测试内把字符串转 UTF-8 字节（仅用于校验 CRC，不参与被测实现）。 */
function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** makePayload：构造一个结构完整的 SavePayload v2（含五段）。 */
function makePayload(overrides: Partial<SavePayload> = {}): SavePayload {
  const base: SavePayload = {
    perma: { profileId: 'profile-abc', currency: { ash: 12 }, unlocked: ['a', 'b'] },
    run: { universeId: 'u0', starLevel: 1, eraIndex: 2, tick: 4000 },
    rng: { hazard: 12345, eco: 67890, tutorial: 111, diplomacy: 222 },
    meta: {
      schemaVersion: 2,
      configVersion: 5,
      tickMs: 250,
      currentTick: 4000,
      subMilli: 125,
      runId: 'run-7f3a',
      lastAppliedCmdSeq: 40,
      isPracticeRun: false,
      isTutorialRun: false,
    },
    timeGuard: { highWaterMs: 1_700_000_000_000, lastSavedAtMs: 1_700_000_000_000 },
  };
  return { ...base, ...overrides };
}

/** makeHeader：构造与 payload.meta 版本号一致的 GS2 头部。 */
function makeHeader(payload: SavePayload, overrides: Partial<SaveEnvelopeHeader> = {}): SaveEnvelopeHeader {
  const base: SaveEnvelopeHeader = {
    engineVersion: 1,
    schemaVersion: payload.meta.schemaVersion,
    configVersion: payload.meta.configVersion,
    runId: payload.meta.runId,
    profileId: payload.perma.profileId,
    versionVector: { entries: [['dev0000000000001', 7]], truncated: false },
    payloadLength: 0,
    crc32: '00000000',
  };
  return { ...base, ...overrides };
}

/** makeState：由 payload 构造对应的 GameState（用于 commitSave）。 */
function makeState(overrides: Partial<GameState['meta']> = {}, lastAppliedCmdSeq = 40): GameState {
  return {
    meta: {
      engineVersion: 1,
      schemaVersion: 2,
      configVersion: 5,
      tickMs: 250,
      currentTick: 4000,
      subMilli: 125,
      runId: 'run-7f3a',
      lastAppliedCmdSeq,
      isPracticeRun: false,
      isTutorialRun: false,
      ...overrides,
    },
    rng: { hazard: 12345, eco: 67890, tutorial: 111, diplomacy: 222 },
    perma: { profileId: 'profile-abc', currency: { ash: 12 } },
    run: { universeId: 'u0', starLevel: 1, eraIndex: 2, tick: 4000 },
  };
}

/** makeWal：构造 n 条 WAL 条目。 */
function makeWal(n: number): WalEntry[] {
  const out: WalEntry[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ commandId: `cmd-${i}`, cmdSeq: i + 1, atTick: 100 + i, cmd: { type: 'BUILD', buildingId: 'b1', count: 1 } });
  }
  return out;
}

/** realEnvelope：用真实编解码生成一个可解码的信封串（供槽记录使用）。 */
function realEnvelope(seq: number): string {
  const payload = makePayload({
    meta: { ...makePayload().meta, lastAppliedCmdSeq: seq, currentTick: 4000 + seq },
  });
  const header = makeHeader(payload);
  return encodeEnvelope(payload, header);
}

// ---------------------------------------------------------------------------
// a) 信封往返：encode→decode 后 payload 与 header 逐位一致
// ---------------------------------------------------------------------------
describe('a) 信封编解码往返（架构 7.4）', () => {
  it('encode→decode 后 payload 深度相等、header 逐字段一致', () => {
    const payload = makePayload();
    const header = makeHeader(payload);
    const envelope = encodeEnvelope(payload, header);
    const decoded = decodeEnvelope(envelope);

    // payload 逐位一致（JSON 语义深度相等）
    expect(decoded.payload).toEqual(payload);
    // header 各字段一致（payloadLength/crc32 由编码时回填，decode 应读回）
    expect(decoded.header.engineVersion).toBe(header.engineVersion);
    expect(decoded.header.schemaVersion).toBe(header.schemaVersion);
    expect(decoded.header.configVersion).toBe(header.configVersion);
    expect(decoded.header.runId).toBe(header.runId);
    expect(decoded.header.profileId).toBe(header.profileId);
    expect(decoded.header.versionVector).toEqual(header.versionVector);
    expect(decoded.header.payloadLength).toBeGreaterThan(0);
    expect(decoded.header.crc32).toMatch(/^[0-9a-f]{8}$/);
  });

  it('encode→decode→encode 逐位一致（规范键序稳定，CRC/长度可复算）', () => {
    const payload = makePayload();
    const header = makeHeader(payload);
    const e1 = encodeEnvelope(payload, header);
    const { payload: p2, header: h2 } = decodeEnvelope(e1);
    const e2 = encodeEnvelope(p2, h2);
    expect(e2).toBe(e1);
  });

  it('信封以 GS1. 开头、.END 结尾，负载只含 base64url 字符', () => {
    const payload = makePayload();
    const env = encodeEnvelope(payload, makeHeader(payload));
    expect(env.startsWith('GS1.')).toBe(true);
    expect(env.endsWith('.END')).toBe(true);
    const body = env.slice(4, env.length - 4);
    const payloadStr = body.split('.')[8];
    expect(payloadStr).toMatch(/^[A-Za-z0-9_-]+$/); // 无填充 base64url
  });

  it('版本向量往返（含截断标记 ,~）', () => {
    const payload = makePayload();
    const vector: VersionVector = { entries: [['aaaaaaaaaaaaaaaa', 3], ['bbbbbbbbbbbbbbbb', 9]], truncated: true };
    const env = encodeEnvelope(payload, makeHeader(payload, { versionVector: vector }));
    const { header } = decodeEnvelope(env);
    expect(header.versionVector).toEqual(vector);
  });
});

// ---------------------------------------------------------------------------
// b) CRC32 损坏检测：改一字节 → decode 抛错
// ---------------------------------------------------------------------------
describe('b) CRC32 传输损坏检测（架构 7.5）', () => {
  // 已知 CRC32 标准向量："123456789" → 0xCBF43926
  it('CRC32 对标准向量 "123456789" 得 0xcbf43926', () => {
    expect(crc32Hex(utf8('123456789'))).toBe('cbf43926');
  });

  it('改负载一字节 → decode 抛错（传输损坏被识别）', () => {
    const payload = makePayload();
    const env = encodeEnvelope(payload, makeHeader(payload));
    // 在负载段（第 9 段）中部翻一个字符，保持长度不变（只改内容）
    const parts = env.slice(4, env.length - 4).split('.');
    const p = parts[8] as string;
    const mid = Math.floor(p.length / 2);
    const ch = p.charAt(mid);
    const flipped = ch === 'A' ? 'B' : 'A';
    parts[8] = p.slice(0, mid) + flipped + p.slice(mid + 1);
    const tampered = 'GS1.' + parts.join('.') + '.END';
    // 改内容后：或解压失败、或 CRC32 不符，任一均应抛错（此处只断言“抛错”）
    expect(() => decodeEnvelope(tampered)).toThrow();
  });

  it('篡改头部 CRC32 字段（负载不变）→ 专判 CRC32 校验失败', () => {
    const payload = makePayload();
    const env = encodeEnvelope(payload, makeHeader(payload));
    const parts = env.slice(4, env.length - 4).split('.');
    const crcField = parts[7] as string;
    // 只改 CRC32 字段首字符（保证与原值不同且仍是 8 位小写十六进制）
    const newCrc = (crcField.charAt(0) === '0' ? '1' : '0') + crcField.slice(1);
    parts[7] = newCrc;
    const tampered = 'GS1.' + parts.join('.') + '.END';
    expect(() => decodeEnvelope(tampered)).toThrow(/CRC32/);
  });

  it('截断负载（长度不符）→ decode 抛错', () => {
    const payload = makePayload();
    const env = encodeEnvelope(payload, makeHeader(payload));
    const truncated = env.slice(0, env.length - 10) + '.END';
    expect(() => decodeEnvelope(truncated)).toThrow();
  });

  it('缺少 END 终止标 → decode 抛错', () => {
    const payload = makePayload();
    const env = encodeEnvelope(payload, makeHeader(payload));
    expect(() => decodeEnvelope(env.slice(0, env.length - 4))).toThrow(/END/);
  });
});

// ---------------------------------------------------------------------------
// c) 双槽原子提交：写对面槽并切换；写失败当前槽不变
// ---------------------------------------------------------------------------
describe('c) 双槽原子提交（架构 7.2 + 7.3 · FR-30）', () => {
  const main0: SlotRecord = { slot: 'main_0', saveSeq: 5, committedThroughCmdSeq: 40, envelope: realEnvelope(40), savedAtMs: 4040 };
  const main1: SlotRecord = { slot: 'main_1', saveSeq: 6, committedThroughCmdSeq: 45, envelope: realEnvelope(45), savedAtMs: 4045 };

  it('oppositeMainSlot：main_0 ↔ main_1', () => {
    expect(oppositeMainSlot('main_0')).toBe('main_1');
    expect(oppositeMainSlot('main_1')).toBe('main_0');
  });

  it('从 currentSlot=main_1 提交：写入对面 main_0，saveSeq+1，committed 后目标槽成为新活动槽', () => {
    const slots = [main0, main1];
    const state = makeState({}, 50);
    const { newSlots, committed } = commitSave(state, slots, 'main_1');
    expect(committed).toBe(true);
    // 目标槽 main_0 被更新，saveSeq = 6 + 1 = 7（取当前活动 main_1 的 saveSeq+1）
    const target = newSlots.find((s) => s.slot === 'main_0') as SlotRecord;
    expect(target.saveSeq).toBe(7);
    expect(target.committedThroughCmdSeq).toBe(50);
    // main_1 保持不变
    expect(newSlots.find((s) => s.slot === 'main_1')).toEqual(main1);
    // 不改入参
    expect(slots.find((s) => s.slot === 'main_0')).toEqual(main0);
    // 新活动槽 = saveSeq 最大者 = main_0(7) > main_1(6)
    expect(target.saveSeq).toBeGreaterThan(main1.saveSeq);
  });

  it('写失败（当前活动槽不存在）→ 抛错，不产生新槽', () => {
    const slots = [main0, main1];
    expect(() => commitSave(makeState(), slots, 'main_0' as never)).not.toThrow(); // main_0 存在
    // 构造一个只有 main_1 的数组，却要求从 main_0 提交 → 目标处理前即失败
    expect(() => commitSave(makeState(), [main1], 'main_0')).toThrow();
  });

  it('编码失败导致提交失败 → committed=false 且当前槽逐项不变（返回副本）', () => {
    const state = makeState();
    // 制造一个含 NaN 的状态（canonicalize 会抛确定性错误 → encodeEnvelope 失败）
    const badState: GameState = {
      ...state,
      run: { ...state.run, weird: Number.NaN },
    };
    const slots = [main0, main1];
    const res = commitSave(badState, slots, 'main_1');
    expect(res.committed).toBe(false);
    expect(res.newSlots).toEqual(slots); // 内容逐项一致
    expect(res.newSlots).not.toBe(slots); // 但为新数组（不改入参）
  });
});

// ---------------------------------------------------------------------------
// d) WAL 故障注入：crashAfter=3 截断到 3 条
// ---------------------------------------------------------------------------
describe('d) WAL 故障注入（Gate 5 写入各步骤崩溃）', () => {
  it('crashAfter=3 → 只保留前 3 条', () => {
    const wal = makeWal(10);
    const kept = injectWalCrash(wal, 3);
    expect(kept.length).toBe(3);
    expect(kept.map((e) => e.cmdSeq)).toEqual([1, 2, 3]);
  });

  it('crashAfter=0 → 空；crashAfter ≥ 长度 → 全量；不改入参', () => {
    const wal = makeWal(5);
    expect(injectWalCrash(wal, 0).length).toBe(0);
    expect(injectWalCrash(wal, 5).length).toBe(5);
    expect(injectWalCrash(wal, 99).length).toBe(5);
    expect(wal.length).toBe(5); // 入参未被修改
  });
});

// ---------------------------------------------------------------------------
// e) 崩溃注入：write 崩溃后当前（活动）槽不损坏
// ---------------------------------------------------------------------------
describe('e) 崩溃注入（write/read/migrate · 架构 7.2）', () => {
  const main0: SlotRecord = { slot: 'main_0', saveSeq: 5, committedThroughCmdSeq: 40, envelope: realEnvelope(40), savedAtMs: 4040 };
  const main1: SlotRecord = { slot: 'main_1', saveSeq: 6, committedThroughCmdSeq: 45, envelope: realEnvelope(45), savedAtMs: 4045 };

  it('write 崩溃：活动槽（saveSeq 最大=main_1）仍可正常 decode，仅非活动槽被破坏', () => {
    const slots = [main0, main1];
    const crashed = injectSaveCrash(slots, 'write');
    const active = crashed.find((s) => s.slot === 'main_1') as SlotRecord;
    // 活动槽不损坏：仍可解码
    expect(() => decodeEnvelope(active.envelope)).not.toThrow();
    // 非活动槽 main_0 被截断破坏：不可解码
    const victim = crashed.find((s) => s.slot === 'main_0') as SlotRecord;
    expect(() => decodeEnvelope(victim.envelope)).toThrow();
  });

  it('read 崩溃：只破坏非活动槽，活动槽保持有效', () => {
    const crashed = injectSaveCrash([main0, main1], 'read');
    expect(() => decodeEnvelope((crashed.find((s) => s.slot === 'main_1') as SlotRecord).envelope)).not.toThrow();
    expect(() => decodeEnvelope((crashed.find((s) => s.slot === 'main_0') as SlotRecord).envelope)).toThrow();
  });

  it('migrate 中断：追加一个半迁移残骸，原活动槽记录仍有效', () => {
    const crashed = injectSaveCrash([main0, main1], 'migrate');
    // 原两条槽仍在且活动槽可解码
    expect(() => decodeEnvelope((crashed.find((s) => s.slot === 'main_1') as SlotRecord).envelope)).not.toThrow();
    // 残骸追加在末尾且不可解码
    expect(crashed.length).toBe(3);
    const leftover = crashed[2] as SlotRecord;
    expect(() => decodeEnvelope(leftover.envelope)).toThrow();
  });

  it('不改入参（原 slots 内容不变）', () => {
    const slots = [main0, main1];
    const snapshotActive = slots[1] as SlotRecord;
    injectSaveCrash(slots, 'write');
    expect(slots[1]).toBe(snapshotActive);
    expect(() => decodeEnvelope(snapshotActive.envelope)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// f) 迁移链：v1→v2 加字段；缺步/降级抛错
// ---------------------------------------------------------------------------
describe('f) 迁移链骨架（架构 7.8 第 5 步 · AC-09）', () => {
  it('v1→v2：run 段新增 journal 空数组，结构正确，且其它字段不变', () => {
    const v1 = makePayload();
    // 确保 v1 没有 journal 字段
    const runV1 = { ...(v1.run as Record<string, unknown>) };
    delete runV1.journal;
    const p1: SavePayload = { ...v1, run: runV1 };

    const migrated = migratePayload(p1, 1, 2);
    expect((migrated.run as Record<string, unknown>).journal).toEqual([]);
    // 其它段不变
    expect(migrated.perma).toEqual(p1.perma);
    expect(migrated.rng).toEqual(p1.rng);
    expect(migrated.meta).toEqual(p1.meta);
    // 不改入参 p1（无 journal）
    expect('journal' in (p1.run as Record<string, unknown>)).toBe(false);
  });

  it('fromVersion === toVersion：原样返回（同一引用）', () => {
    const p = makePayload();
    expect(migratePayload(p, 2, 2)).toBe(p);
  });

  it('v1→v2 迁移幂等：已含 journal 时不覆盖', () => {
    const p = makePayload({ run: { journal: ['existing'] } });
    const migrated = migratePayload(p, 1, 2);
    expect((migrated.run as Record<string, unknown>).journal).toEqual(['existing']);
  });

  it('缺迁移步（v2→v3 暂无）→ 抛错', () => {
    expect(() => migratePayload(makePayload(), 2, 3)).toThrow(/迁移链/);
  });

  it('降级（from > to）→ 抛错', () => {
    expect(() => migratePayload(makePayload(), 3, 1)).toThrow(/降级/);
  });
});

// ---------------------------------------------------------------------------
// g) 版本比较：五态各覆盖
// ---------------------------------------------------------------------------
describe('g) 版本比较（架构 7.7 版本向量五态 + 截断降级）', () => {
  it('identical：逐设备计数相等（顺序无关）', () => {
    const l: VersionVector = { entries: [['d1', 5], ['d2', 3]], truncated: false };
    const r: VersionVector = { entries: [['d2', 3], ['d1', 5]], truncated: false };
    expect(compareVersions(l, r)).toBe('identical');
  });

  it('remote_newer：remote 严格支配 local', () => {
    const l: VersionVector = { entries: [['d1', 5], ['d2', 3]], truncated: false };
    const r: VersionVector = { entries: [['d1', 6], ['d2', 3]], truncated: false };
    expect(compareVersions(l, r)).toBe('remote_newer');
  });

  it('remote_older：local 严格支配 remote', () => {
    const l: VersionVector = { entries: [['d1', 6], ['d2', 3]], truncated: false };
    const r: VersionVector = { entries: [['d1', 5], ['d2', 3]], truncated: false };
    expect(compareVersions(l, r)).toBe('remote_older');
  });

  it('diverged：互不支配且总计数不等（各自推进）', () => {
    // d1: 5>2（本地领先），d2: 2<6（远端领先）→ 交叉；总和 7 ≠ 8
    const l: VersionVector = { entries: [['d1', 5], ['d2', 2]], truncated: false };
    const r: VersionVector = { entries: [['d1', 2], ['d2', 6]], truncated: false };
    expect(compareVersions(l, r)).toBe('diverged');
  });

  it('maybe_diverged：互不支配但总计数相等（同分不同分布）', () => {
    // d1: 5>3（本地领先），d2: 3<5（远端领先）→ 交叉；总和同为 8
    const l: VersionVector = { entries: [['d1', 5], ['d2', 3]], truncated: false };
    const r: VersionVector = { entries: [['d1', 3], ['d2', 5]], truncated: false };
    expect(compareVersions(l, r)).toBe('maybe_diverged');
  });

  it('different_run：两向量设备集合完全不相交', () => {
    const l: VersionVector = { entries: [['d1', 5]], truncated: false };
    const r: VersionVector = { entries: [['d9', 5]], truncated: false };
    expect(compareVersions(l, r)).toBe('different_run');
  });

  it('截断降级：remote 支配但本地 truncated=true → maybe_diverged', () => {
    const l: VersionVector = { entries: [['d1', 5], ['d2', 3]], truncated: true };
    const r: VersionVector = { entries: [['d1', 6], ['d2', 3]], truncated: false };
    expect(compareVersions(l, r)).toBe('maybe_diverged');
  });
});

// ---------------------------------------------------------------------------
// h) 恢复决策：按 committedThroughCmdSeq 选择正确槽
// ---------------------------------------------------------------------------
describe('h) 恢复决策（架构 7.2 启动恢复 + v0.4 提交边界）', () => {
  /** makeSlot：构造槽记录（信封内容无关紧要，恢复决策只看边界字段）。 */
  function makeSlot(slot: SlotRecord['slot'], saveSeq: number, committedThroughCmdSeq: number, savedAtMs: number): SlotRecord {
    return { slot, saveSeq, committedThroughCmdSeq, envelope: 'x', savedAtMs };
  }

  it('无应急槽：按 committedThroughCmdSeq 选主槽（而非 saveSeq）', () => {
    // main_0 saveSeq 更大但提交边界更低；main_1 提交边界更高 → 应选 main_1
    const slots = [
      makeSlot('main_0', 99, 40, 5000),
      makeSlot('main_1', 10, 80, 4000),
    ];
    const d = recoverDecision(slots, null);
    expect(d.useSlot).toBe('main_1');
    expect(d.useEmergency).toBe(false);
  });

  it('应急槽领先（saveSeq ≥ 基线且 lastKnownTick/已应用序号领先）→ 用应急槽', () => {
    const slots = [makeSlot('main_0', 50, 40, 5000), makeSlot('main_1', 50, 40, 5000)];
    const emergency: EmergencySlot = {
      saveSeq: 50,
      committedThroughCmdSeq: 40,
      lastAppliedCmdSeq: 60, // 已应用命令序号领先基线 committedThroughCmdSeq=40
      envelope: 'x',
      wal: makeWal(2),
      lastKnownTick: 6000, // 领先基线 savedAtMs=5000
      savedAtMs: 5000,
    };
    const d = recoverDecision(slots, emergency);
    expect(d.useSlot).toBe('emergency');
    expect(d.useEmergency).toBe(true);
  });

  it('应急槽落后（saveSeq < 基线）→ 丢弃应急槽，用主槽', () => {
    const slots = [makeSlot('main_0', 80, 70, 8000), makeSlot('main_1', 60, 50, 6000)];
    const emergency: EmergencySlot = {
      saveSeq: 10, // < 基线 saveSeq=80
      committedThroughCmdSeq: 5,
      lastAppliedCmdSeq: 5,
      envelope: 'x',
      wal: [],
      lastKnownTick: 100,
      savedAtMs: 100,
    };
    const d = recoverDecision(slots, emergency);
    expect(d.useEmergency).toBe(false);
    expect(d.useSlot).toBe('main_0'); // 提交边界最高的槽
  });

  it('无主槽但有应急槽 → 用应急槽', () => {
    const emergency: EmergencySlot = {
      saveSeq: 1,
      committedThroughCmdSeq: 0,
      lastAppliedCmdSeq: 0,
      envelope: 'x',
      wal: [],
      lastKnownTick: 0,
      savedAtMs: 0,
    };
    const d = recoverDecision([], emergency);
    expect(d.useSlot).toBe('emergency');
    expect(d.useEmergency).toBe(true);
  });

  it('主槽与应急槽均无 → 抛错', () => {
    expect(() => recoverDecision([], null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 附加：payloadFromState 与 payloadCanonicalStateHash（架构 7.4 / 7.5）
// ---------------------------------------------------------------------------
describe('附加) 状态装配与规范状态哈希（架构 7.4 / 7.5）', () => {
  it('payloadFromState：五段齐全，meta 版本号与 header 一致', () => {
    const state = makeState();
    const { payload, header } = payloadFromState(state);
    expect(payload.perma.profileId).toBe(state.perma.profileId);
    expect(payload.meta.currentTick).toBe(state.meta.currentTick);
    expect(header.schemaVersion).toBe(state.meta.schemaVersion);
    expect(header.configVersion).toBe(state.meta.configVersion);
  });

  it('payloadCanonicalStateHash：同进度不同保存时刻（timeGuard 不同）→ 哈希相同（排除 timeGuard）', () => {
    const p1 = makePayload();
    const p2: SavePayload = { ...p1, timeGuard: { highWaterMs: 1, lastSavedAtMs: 2 } };
    expect(payloadCanonicalStateHash(p1)).toBe(payloadCanonicalStateHash(p2));
  });

  it('payloadCanonicalStateHash：改 currentTick → 哈希变', () => {
    const p1 = makePayload();
    const p2: SavePayload = { ...p1, meta: { ...p1.meta, currentTick: p1.meta.currentTick + 1 } };
    expect(payloadCanonicalStateHash(p1)).not.toBe(payloadCanonicalStateHash(p2));
  });
});
