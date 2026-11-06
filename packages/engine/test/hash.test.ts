/**
 * W4 规范状态哈希 · 架构 7.5 验收对象
 * 单测条款：64 位 FNV-1a 黄金向量 · 规范序列化 · 确定性 · 回放哈希
 * ---------------------------------------------------------------------------
 * 覆盖任务要求的 a–f 六类断言：
 *   a) FNV-1a 64 公开黄金向量（直接对原始 ASCII 字节，用 fnv1a64Hex 对照，
 *      不经 canonicalize 的 type-tag 前缀，保证向量口径纯净）。
 *   b) 规范化：键序无关（同哈希）、数组序有关（不同哈希）、长度前缀消除拼接歧义。
 *   c) 确定性：同对象重复哈希相同；改一个字段哈希变。
 *   d) -0 与 0 同哈希；NaN / ±Infinity 抛错。
 *   e) hashReplay：变更 inputLog / configVersion / engineVersion 任一 → 哈希变。
 *   f) 嵌套复杂对象（模拟状态快照：resources / rates / 数组 / 嵌套）哈希稳定。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物，断言的数值均来自
 *   · 业界标准 FNV-1a 64 公开测试向量（空串 / "a" / "b" / "foobar"），以及
 *   · 按本模块 canonicalize / fnv1a64 逻辑静态推演应得的结果。
 *   实际运行需在具备 vitest 的工程环境中 `npm run test`；本文件不声称已实际执行通过。
 *   import 路径按任务要求固定为 '../src/hash.js'（并入 packages/engine 后由 vitest
 *   解析到源文件）。
 */
import { describe, it, expect } from 'vitest';
import {
  fnv1a64Hex,
  fnv1a64,
  canonicalize,
  hashState,
  hashReplay,
  u64ToHex,
} from '../src/hash.js';

// ---------------------------------------------------------------------------
// 测试辅助
// ---------------------------------------------------------------------------

/** ascii：把纯 ASCII 字符串转成原始字节（黄金向量用；不做任何规范化）。 */
function ascii(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff);
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------------------
// a) FNV-1a 64 公开黄金向量（对照原始字节，不经过 canonicalize）
// ---------------------------------------------------------------------------
describe('fnv1a64 · 业界标准 FNV-1a 64 黄金向量（架构 7.5 算法正确性）', () => {
  it('空串 "" → 0xcbf29ce484222325（offset basis）', () => {
    expect(fnv1a64Hex(ascii(''))).toBe('cbf29ce484222325');
  });

  it('"a" → 0xaf63dc4c8601ec8c', () => {
    expect(fnv1a64Hex(ascii('a'))).toBe('af63dc4c8601ec8c');
  });

  it('"b" → 0xaf63df4c8601f1a5', () => {
    expect(fnv1a64Hex(ascii('b'))).toBe('af63df4c8601f1a5');
  });

  it('"foobar" → 0x85944171f73967e8', () => {
    expect(fnv1a64Hex(ascii('foobar'))).toBe('85944171f73967e8');
  });

  it('fnv1a64 返回的 hi/lo 拼成 16 位 hex 与 fnv1a64Hex 一致', () => {
    const h = fnv1a64(ascii('foobar'));
    expect(u64ToHex(h)).toBe('85944171f73967e8');
    // hi / lo 各 8 位 hex
    expect((h.hi >>> 0).toString(16).padStart(8, '0')).toBe('85944171');
    expect((h.lo >>> 0).toString(16).padStart(8, '0')).toBe('f73967e8');
  });
});

// ---------------------------------------------------------------------------
// b) 规范化：键序无关 / 数组序有关 / 长度前缀消除拼接歧义
// ---------------------------------------------------------------------------
describe('canonicalize · 规范化（同状态同哈希 / 不同状态不同哈希）', () => {
  it('对象键序无关：{a:1,b:2} 与 {b:2,a:1} 哈希相同', () => {
    expect(hashState({ a: 1, b: 2 })).toBe(hashState({ b: 2, a: 1 }));
    // 直接比较规范串也应相等
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
  });

  it('数组顺序有关：[1,2] 与 [2,1] 哈希不同', () => {
    expect(hashState([1, 2])).not.toBe(hashState([2, 1]));
  });

  it('长度前缀消除拼接歧义：[\'ab\',\'c\'] 与 [\'a\',\'bc\'] 哈希不同', () => {
    expect(hashState(['ab', 'c'])).not.toBe(hashState(['a', 'bc']));
  });

  it('长度前缀消除拼接歧义（嵌套对象验证）：{x:\'ab\',y:\'c\'} 与 {x:\'a\',y:\'bc\'} 不同', () => {
    expect(hashState({ x: 'ab', y: 'c' })).not.toBe(hashState({ x: 'a', y: 'bc' }));
  });

  it('类型标签区分不同基本类型：{v:1} / {v:"1"} / {v:true} 两两不同', () => {
    const n = hashState({ v: 1 });
    const s = hashState({ v: '1' });
    const t = hashState({ v: true });
    expect(n).not.toBe(s);
    expect(n).not.toBe(t);
    expect(s).not.toBe(t);
  });

  it('undefined 对象属性被跳过：{a:1,b:undefined} 与 {a:1} 哈希相同', () => {
    expect(hashState({ a: 1, b: undefined })).toBe(hashState({ a: 1 }));
  });

  it('hashState 输出恒为 16 位小写十六进制', () => {
    expect(hashState({ a: 1, b: [1, 2, 3] })).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// c) 确定性：同对象重复相同；改字段即变
// ---------------------------------------------------------------------------
describe('hashState · 确定性（架构 5.6 / 7.5）', () => {
  it('同一对象重复哈希恒相同', () => {
    const state = { run: { currentTick: 100, resources: { wood: 10 } }, rng: { seed: 7 } };
    expect(hashState(state)).toBe(hashState(state));
    expect(hashState(state)).toBe(hashState({ rng: { seed: 7 }, run: { resources: { wood: 10 }, currentTick: 100 } }));
  });

  it('改一个字段哈希即变', () => {
    const base = { run: { currentTick: 100, resources: { wood: 10 } } };
    expect(hashState(base)).not.toBe(hashState({ run: { currentTick: 101, resources: { wood: 10 } } }));
    expect(hashState(base)).not.toBe(hashState({ run: { currentTick: 100, resources: { wood: 11 } } }));
  });
});

// ---------------------------------------------------------------------------
// d) -0 与 0 同哈希；NaN / ±Infinity 抛错
// ---------------------------------------------------------------------------
describe('canonicalize · 数字确定性（-0 归一 / 非有限值抛错）', () => {
  it('-0 与 0 视为同一状态，哈希相同', () => {
    expect(hashState({ v: 0 })).toBe(hashState({ v: -0 }));
    expect(canonicalize({ v: -0 })).toBe(canonicalize({ v: 0 }));
  });

  it('NaN 抛错', () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => hashState({ v: NaN })).toThrow();
  });

  it('Infinity / -Infinity 抛错', () => {
    expect(() => hashState({ v: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => hashState({ v: Number.NEGATIVE_INFINITY })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// e) hashReplay：任一字段变 → 哈希变
// ---------------------------------------------------------------------------
describe('hashReplay · 回放哈希（架构 7.5 四段拼接）', () => {
  it('四元组相同则哈希相同', () => {
    expect(hashReplay('0123456789abcdef', 'input-A', 1, 1)).toBe(
      hashReplay('0123456789abcdef', 'input-A', 1, 1),
    );
  });

  it('变更 inputLog → 哈希变', () => {
    expect(hashReplay('0123456789abcdef', 'input-A', 1, 1)).not.toBe(
      hashReplay('0123456789abcdef', 'input-B', 1, 1),
    );
  });

  it('变更 configVersion → 哈希变', () => {
    expect(hashReplay('0123456789abcdef', 'input-A', 1, 1)).not.toBe(
      hashReplay('0123456789abcdef', 'input-A', 2, 1),
    );
  });

  it('变更 engineVersion → 哈希变', () => {
    expect(hashReplay('0123456789abcdef', 'input-A', 1, 1)).not.toBe(
      hashReplay('0123456789abcdef', 'input-A', 1, 2),
    );
  });

  it('变更 canonicalStateHash → 哈希变', () => {
    expect(hashReplay('0123456789abcdef', 'input-A', 1, 1)).not.toBe(
      hashReplay('fedcba9876543210', 'input-A', 1, 1),
    );
  });

  it('哈希为 16 位小写十六进制', () => {
    expect(hashReplay('0123456789abcdef', 'input-A', 1, 1)).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// f) 嵌套复杂对象（模拟状态快照）哈希稳定
// ---------------------------------------------------------------------------
describe('hashState · 嵌套复杂状态快照（稳定性）', () => {
  const snapshot = {
    perma: { epoch: 1, legacy: { spores: 12 }, unlocked: ['a', 'b', 'c'] },
    run: {
      currentTick: 8000,
      tickMs: 250,
      runId: 'run-abc123',
      resources: {
        wood: { amount: 120.5, max: 500 },
        ore: { amount: 0, max: 1000 },
      },
      rates: { wood: 1.5, ore: -0.25 },
    },
    rng: { seed: 123456789, cursor: 42, queue: [1, 2, 3, 4] },
    meta: { currentTick: 8000, tickMs: 250, runId: 'run-abc123', onboarding: true },
  };

  it('同一快照重复哈希稳定', () => {
    expect(hashState(snapshot)).toBe(hashState(snapshot));
  });

  it('顶层键重排 + 内层键重排后哈希仍相同（键序无关贯穿嵌套）', () => {
    const reordered = {
      meta: { onboarding: true, runId: 'run-abc123', tickMs: 250, currentTick: 8000 },
      rng: { queue: [1, 2, 3, 4], cursor: 42, seed: 123456789 },
      run: {
        rates: { ore: -0.25, wood: 1.5 },
        resources: {
          ore: { max: 1000, amount: 0 },
          wood: { max: 500, amount: 120.5 },
        },
        runId: 'run-abc123',
        tickMs: 250,
        currentTick: 8000,
      },
      perma: { unlocked: ['a', 'b', 'c'], legacy: { spores: 12 }, epoch: 1 },
    };
    expect(hashState(reordered)).toBe(hashState(snapshot));
  });

  it('内层数组顺序变化 → 哈希变（数组有序）', () => {
    const mutated = {
      ...snapshot,
      rng: { seed: 123456789, cursor: 42, queue: [1, 2, 4, 3] },
    };
    expect(hashState(mutated)).not.toBe(hashState(snapshot));
  });
});
