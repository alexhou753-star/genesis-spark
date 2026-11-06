/**
 * W4 规范状态哈希 · 架构 7.5 验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》规范状态哈希模块（M1 W3，架构 7.5「三种哈希的分工」）。
 *
 * 架构 7.5 原文口径（本文件逐条落地）：
 *   - 规范状态哈希：64 位 FNV-1a，**用两个 32 位整数实现，不依赖 BigInt**
 *     （BigInt 在三内核 / 旧引擎上可用性不一，且 V8 的 BigInt 属较新特性，
 *     旧 WebView / 降级内核可能缺失；故一律走 32 位整数 + Math.imul，保证
 *     任何 ES2015+ 引擎结果逐位一致）。覆盖「游戏状态本身」：perma、run、rng
 *     与 meta 中的 currentTick、tickMs、runId、引导标记；排除保存时间、导出
 *     记录、设备标识、版本向量、saveSeq、时间保护字段与三个版本号。
 *   - 回放哈希 = 规范状态哈希 + 输入序列摘要 + 配置版本 + 引擎版本，四段按
 *     固定分隔拼接后同算法求 FNV-1a 64。
 *   - 规范序列化：保证「同状态 → 同哈希、不同状态 → 不同哈希」。
 *
 * ── 本文件对外导出 ──────────────────────────────────────────────────────────
 *   fnv1a64(bytes)               底层：对「原始字节」做 64 位 FNV-1a（黄金向量对照用）
 *   fnv1a64Hex(bytes)            底层：同上但返回 16 位小写十六进制
 *   canonicalize(value)          规范序列化：任意值 → 无歧义字节级可比的字符串
 *   hashState(state)             规范状态哈希：canonicalize → FNV-1a 64 → 16 位 hex
 *   hashReplay(...)              回放哈希：四段拼接 → FNV-1a 64 → 16 位 hex
 *
 * ── 为什么「无 BigInt」还能做 64 位乘法 ────────────────────────────────────
 *   64 位无符号乘法 (a * b) mod 2^64 可以被精确拆成 32x32→64 的分段乘积，
 *   每个分段乘积都 < 2^64 但单个 a_i*b_j 仍可能达到 2^62 左右，超出 IEEE-754
 *   双精度「整数精确表示」的 2^53 上限 —— 所以绝不能直接用 `a*b`（会丢低位）。
 *   这里用 Math.imul（把两操作数各截成 32 位、返回 32 位乘积的低 32 位、不经过
 *   浮点）来精确取得每个分段的低 32 位与进位。详见 mul64 的逐段注释。
 *
 * 说明（不得伪造运行结果）：本文件是静态交付物；黄金向量等断言在构造上成立，
 * 但本文不声称已在具备 vitest 的环境中实际执行通过。见 hash.test.ts 文件头。
 */

// ---------------------------------------------------------------------------
// 64 位无符号整数的 (hi, lo) 表示
// ---------------------------------------------------------------------------

/**
 * U64：64 位无符号整数的「高低字」对表示。
 *
 *   - hi、lo 均为 uint32（0 <= x <= 0xffffffff），合起来表示 hi * 2^32 + lo。
 *   - 之所以拆成两个 32 位字而不是用 BigInt / 普通 number 存 64 位：
 *       · 普通 number 是 IEEE-754 双精度，只精确到 2^53，装不下 64 位；
 *       · BigInt 在旧内核可用性不一（架构 7.5 明确排除）。
 *     两个 32 位字可被 Math.imul / 位运算（均按 32 位处理）精确操作。
 */
export interface U64 {
  readonly hi: number;
  readonly lo: number;
}

// ---------------------------------------------------------------------------
// FNV-1a 64 位常量
// ---------------------------------------------------------------------------

/**
 * FNV offset basis（FNV-1a 64 位初始值）= 0xcbf29ce484222325。
 *   拆成 hi = 0xcbf29ce4、lo = 0x84222325。
 */
const FNV_OFFSET_BASIS_HI = 0xcbf29ce4;
const FNV_OFFSET_BASIS_LO = 0x84222325;

/**
 * FNV prime（FNV-1a 64 位乘子）= 0x00000100_000001b3 = 0x100 * 2^32 + 0x1b3。
 *   拆成：primeHi = 0x00000100、primeLo = 0x000001b3。
 *   注意 prime 的真实值是「2^40 + 0x1b3」，并非把 0x100000001b3 当浮点；下面
 *   完全用这两个 32 位字参与 mul64 分段乘法，绝不写大整数常量。
 */
const FNV_PRIME_HI = 0x00000100;
const FNV_PRIME_LO = 0x000001b3;

// ---------------------------------------------------------------------------
// 32x32 → 低 64 位 的分段乘法（核心：无精度丢失、无 BigInt）
// ---------------------------------------------------------------------------

/**
 * mul64：计算 (a * b) mod 2^64，返回 { hi, lo }，全程 32 位整数运算。
 *
 * 依据（为何必须这样写，架构 7.5 FNV-1a 用 32 位整数实现的核心难点）：
 *   设 a = aHi·2^32 + aLo，b = bHi·2^32 + bLo（每个 aHi/… 都是 0..2^32-1 的 uint32）。
 *   展开：
 *     a·b = aHi·bHi·2^64
 *         + (aHi·bLo + aLo·bHi)·2^32
 *         + aLo·bLo
 *   取 mod 2^64 后，aHi·bHi·2^64 整项消去（是 2^64 的倍数）。剩下：
 *     (a·b) mod 2^64 = (aLo·bLo) + (aHi·bLo + aLo·bHi)·2^32   （mod 2^64）
 *   具体分段（每一步都用 Math.imul 取 32 位乘积的「低 32 位」，用无符号右移 / 拆位
 *   取「高 32 位进位」）：
 *
 *   【段 1】aHi·bHi 不参与结果，直接丢弃。
 *   【段 2】aLo·bLo：这是唯一真正落到 bits 0..63 的双 32 位乘积。把它拆成
 *           p0 = 低 32 位（进 lo 的低半）、p1 = 高 32 位（进位，进结果的高半）。
 *           用 Math.imul(aLo, bLo) 得低 32 位；高 32 位用「16 位拆分」精确取：
 *           把 aLo、bLo 各拆成高低 16 位，交叉相乘再组合 —— 因为 16x16 乘积最大
 *           2^32，落在一个 double 的精确整数范围内（< 2^53），可以安全相加。
 *   【段 3】aLo·bHi 与 aHi·bLo：它们都要左移 32 位（即各自贡献到结果 bits 32..95，
 *           取低 64 位时只保留其低 32 位，作为「进位」叠加到结果的 hi 字）。
 *           这两个乘积的低 32 位同样用 Math.imul 精确取得。
 *
 *   最后 lo = 段2低32 + (段3两个乘积的低32之和 左移 32 位的截断部分) 的组合；
 *   hi = 段2高32 + 段3两乘积低32之和（按 2^32 折叠）。下面用最清晰的逐位写法。
 *
 * 确定性 / 精度依据：所有中间乘积要么经 Math.imul（返回精确的低 32 位，不经浮点），
 *   要么是两个 16 位数的乘积（< 2^32 < 2^53，double 精确）。全程无 `*` 直接乘两个
 *   可能 > 2^26 的大数，故绝无精度丢失，也不产生 BigInt。
 */
export function mul64(a: U64, b: U64): U64 {
  const aHi = a.hi >>> 0;
  const aLo = a.lo >>> 0;
  const bHi = b.hi >>> 0;
  const bLo = b.lo >>> 0;

  // —— 段 2：aLo·bLo 的 64 位结果（低 32 + 高 32），用 16 位拆分精确求。 ——
  // 把 aLo、bLo 各拆成 16 位两半：a = a1·2^16 + a0，b = b1·2^16 + b0。
  const aLo0 = aLo & 0xffff;         // aLo 低 16 位
  const aLo1 = aLo >>> 16;           // aLo 高 16 位
  const bLo0 = bLo & 0xffff;         // bLo 低 16 位
  const bLo1 = bLo >>> 16;           // bLo 高 16 位

  // 四个 16x16 乘积（每个 < 2^32，double 精确）：
  const p00 = aLo0 * bLo0;           // 权重 2^0
  const p01 = aLo0 * bLo1;           // 权重 2^16
  const p10 = aLo1 * bLo0;           // 权重 2^16
  const p11 = aLo1 * bLo1;           // 权重 2^32

  // 组合出 aLo·bLo 的低 32 位与高 32 位：
  //   mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff)，是 bits 16..31 的累积。
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  const loLo = ((mid & 0xffff) << 16) | (p00 & 0xffff);        // 段2 结果的低 32 位
  const loHi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0; // 段2 结果的高 32 位（进位）

  // —— 段 3：aLo·bHi + aHi·bLo 的低 32 位（它们整体要左移 32 位）。 ——
  // Math.imul 精确返回 32 位乘积的低 32 位，不经过浮点、无精度丢失。
  const cross = (Math.imul(aLo, bHi) + Math.imul(aHi, bLo)) >>> 0;

  // —— 合成 64 位结果 ——
  // 结果低 32 位 = 段2低32（段3 都左移 32 位，对 bits 0..31 无贡献）。
  const lo = loLo >>> 0;
  // 结果高 32 位 = 段2高32（进位） + 段3两乘积低32之和（各自左移 32 位后落在 high 字）。
  // Math.imul 相加可能超过 2^32，故 `>>> 0` 自动按 mod 2^32 折叠（丢弃溢出，正是 mod 2^64 所需）。
  const hi = (loHi + cross) >>> 0;

  return { hi, lo };
}

// ---------------------------------------------------------------------------
// FNV-1a 64 位主体（对原始字节）
// ---------------------------------------------------------------------------

/**
 * fnv1a64：对一列原始 8 位字节做 64 位 FNV-1a，返回 { hi, lo }。
 *
 * 算法（FNV-1a 规范）：
 *   hash = offset_basis
 *   for each byte b (0..255):
 *     hash = hash XOR b         // 先异或（FNV-1a 与 FNV-1 的区别就在这里）
 *     hash = (hash * prime) mod 2^64   // 用 mul64，绝不直接 `*`
 * 返回终态 hash。
 *
 * 确定性依据：纯函数、逐字节、只用 XOR 与 mul64；同样的字节序列在任何合规引擎
 *   上得到逐位相同结果。异或一个 byte 只动 lo 的最低位字节：
 *     lo' = lo ^ b，hi' = hi（因为 b < 2^8 只影响最低字节）。
 *
 * 架构 7.5 依据：这是「两个 32 位整数实现、不依赖 BigInt」的落地；调用方决定喂
 *   什么字节（黄金向量喂原始 ASCII 字节，hashState 喂 canonicalize 的结果字节）。
 */
export function fnv1a64(bytes: Uint8Array): U64 {
  let hi = FNV_OFFSET_BASIS_HI >>> 0;
  let lo = FNV_OFFSET_BASIS_LO >>> 0;
  const prime: U64 = { hi: FNV_PRIME_HI, lo: FNV_PRIME_LO };
  for (let i = 0; i < bytes.length; i++) {
    // noUncheckedIndexedAccess 守卫：Uint8Array 下标语义上必定有值，undefined 兜底 0。
    const b = bytes[i] ?? 0;
    // 1) hash ^= byte（只影响 lo 的最低字节）
    lo = (lo ^ b) >>> 0;
    // 2) hash = hash * prime (mod 2^64)
    const next = mul64({ hi, lo }, prime);
    hi = next.hi;
    lo = next.lo;
  }
  return { hi, lo };
}

/** u64ToHex：把 { hi, lo } 拼成 16 位小写十六进制（hi 高 8 位 + lo 低 8 位）。 */
export function u64ToHex(v: U64): string {
  const hiHex = (v.hi >>> 0).toString(16).padStart(8, '0');
  const loHex = (v.lo >>> 0).toString(16).padStart(8, '0');
  return hiHex + loHex;
}

/**
 * fnv1a64Hex：对原始字节做 FNV-1a 64 并返回 16 位小写十六进制。
 * 供测试用「业界标准 FNV-1a 64 公开黄金向量」直接对原始 ASCII 字节对照
 * （不经过 canonicalize 的 type-tag 前缀，保证向量口径纯净）。
 */
export function fnv1a64Hex(bytes: Uint8Array): string {
  return u64ToHex(fnv1a64(bytes));
}

// ---------------------------------------------------------------------------
// UTF-8 编码（显式实现，不依赖 TextEncoder，跨内核确定）
// ---------------------------------------------------------------------------

/**
 * utf8Bytes：把字符串编码为 UTF-8 字节序列（显式实现）。
 *
 * 为何自己写而不用 TextEncoder：
 *   - canonicalize 产出的字符串可能含中文键名 / 中文数据；必须保证「同一 JS 字符串
 *     在不同引擎上编码出同一字节序列」。UTF-8 是确定性标准，但 TextEncoder 属于较新
 *     的 Web/Node API，旧内核可能缺失；显式实现消除该可用性风险，且明确处理孤立代理项。
 *   - 孤立代理项（lone surrogate）规范规定用 U+FFFD 替换（与 WHATWG 编码标准一致），
 *     保证不抛错、跨引擎一致。
 */
function utf8Bytes(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    // 处理代理对（U+10000..U+10FFFF 的补充平面字符）
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        // 合法代理对：合成完整码点
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++; // 消耗低位代理
      } else {
        // 孤立高位代理：用替换字符
        code = 0xfffd;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立低位代理：用替换字符
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

// ---------------------------------------------------------------------------
// 规范序列化 canonicalize(value): string
// ---------------------------------------------------------------------------

/**
 * DeterminismError：确定性错误（带稳定 code）。
 *
 * 状态里不应出现 NaN / Infinity / 函数 / Symbol / 循环引用等无法确定序列化的值；
 * 一旦出现，规范序列化必须以「类型与消息恒定」的方式抛错，而不是静默产生一个
 * 依赖引擎的实现细节串（那样会让不同内核产生不同哈希，违反 Gate 2 逐位一致）。
 * 这里自带一个最小错误类型，避免对 w2/w3 暂存包形成跨包依赖。
 */
export class DeterminismError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DeterminismError';
    this.code = code;
  }
}

/**
 * canonicalize：把任意状态值序列化为「无歧义、可逐字节比对」的规范字符串。
 *
 * 目标（架构 7.5「规范序列化」）：同一逻辑状态无论对象键的枚举 / 书写顺序如何，
 * 都映射到同一字符串 → 同一哈希；不同的逻辑状态映射到不同字符串 → 不同哈希。
 *
 * ── 拼接协议（自描述、带类型标签 + 长度前缀，杜绝歧义）─────────────────────
 *   每个值前缀一个类型标签，聚合类型对子元素递归序列化。关键在「字符串」用
 *   **显式长度前缀**，避免拼接歧义（这是本协议防碰撞的核心）：
 *
 *     null      →  "n"
 *     undefined →  "u"                        （见下：对象属性里直接跳过，不进序列化）
 *     boolean   →  "b1" / "b0"
 *     number    →  "d"  + 规范数字文本         （"d" 前缀，见下 number 处理）
 *     string    →  "s"  + <十进制字节长度> + ":" + <UTF-8 字节原样>
 *     array     →  "a"  + <元素个数> + "[" + 各元素规范串顺次拼接 + "]"
 *     object    →  "o"  + <键值对个数> + "{" + 各「键规范串 + 值规范串」按键字典序 + "}"
 *
 *   为何字符串/对象/数组都带「长度或个数」前缀？
 *     · 字符串：'s2:ab' + 's1:c' 与 's1:a' + 's2:bc' 的拼接结果分别含明确的
 *       's2:ab' / 's1:c' 与 's1:a' / 's2:bc' —— 因长度前缀把每个串的边界钉死，
 *       故「'ab'+'c'」与「'a'+'bc'」不会拼出同一 byte 流（任务要求的经典对照）。
 *     · 对象/数组：个数前缀让解析器知道边界，嵌套结构也不会因相邻拼接而混淆。
 *   有了类型标签 + 长度前缀，「不同类型」「长度不同的值」「边界不同的相邻值」都不会
 *   产生同一字符串 → 构造上避免碰撞。
 *
 * ── 各类型确定性规则 ──────────────────────────────────────────────────────
 *   · 对象：键按 UTF-16 code unit 字典序（Array.prototype.sort 默认比较，即
 *     「逐 UTF-16 码元」比较，确定且不依赖引擎 locale）排序后递归；undefined 值的
 *     属性**整条跳过**（等价于该键不存在，保证 {'x':1} 与 {'x':1,'y':undefined} 同）。
 *   · 数组：严格按索引顺序（含空洞按 undefined 处理，但通常状态数组无空洞）。
 *   · 数字：见 stringifyNumber —— 整数直接 String(n)；浮点用 JS 规范最短往返串并
 *     标注跨内核风险；-0 归一为 0；NaN / ±Infinity 抛错。
 *   · 字符串：UTF-8 字节 + 字节长度前缀（见上）。
 *   · null：'n'；undefined：'u'（仅数组元素等「无法跳过」的位置会用到，对象属性跳过）。
 *   · boolean：'b1'/'b0'。
 *
 * 确定性依据：纯函数；排序只依赖码元比较；数字走 JS Number::toString 规范；编码走
 *   自实现 UTF-8。不读时钟 / 随机 / 环境 / locale。同一对象重复序列化恒得同一串。
 */
export function canonicalize(value: unknown): string {
  // 用显式栈式递归（见 serializeValue），并对循环引用做检测。
  return serializeValue(value, new WeakSet<object>());
}

/** 递归序列化主体（带循环引用检测）。 */
function serializeValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'n';

  const t = typeof value;
  switch (t) {
    case 'undefined':
      // 顶层 / 数组元素位置遇到 undefined：单独标记，保证 [undefined] 不与 [] 相同。
      return 'u';
    case 'boolean':
      return value ? 'b1' : 'b0';
    case 'number':
      return stringifyNumber(value as number);
    case 'string':
      return stringifyString(value as string);
    case 'object': {
      if (Array.isArray(value)) {
        if (seen.has(value)) throw new DeterminismError('CIRCULAR', 'canonicalize: 检测到循环引用（数组）');
        seen.add(value);
        const parts: string[] = [];
        for (let i = 0; i < value.length; i++) {
          parts.push(serializeValue(value[i], seen));
        }
        seen.delete(value);
        return 'a' + String(value.length) + '[' + parts.join('') + ']';
      }
      // 普通对象：按键字典序排序后递归。
      const obj = value as Record<string, unknown>;
      if (seen.has(obj)) throw new DeterminismError('CIRCULAR', 'canonicalize: 检测到循环引用（对象）');
      seen.add(obj);
      const keys = Object.keys(obj).sort(compareCodeUnits);
      const chunks: string[] = [];
      for (const key of keys) {
        const child = obj[key];
        // undefined 值属性整条跳过（等价键不存在）。
        if (child === undefined) continue;
        chunks.push(stringifyString(key));
        chunks.push(serializeValue(child, seen));
      }
      seen.delete(obj);
      const count = chunks.length / 2; // 键值对各占一个 chunk
      return 'o' + String(count) + '{' + chunks.join('') + '}';
    }
    default: {
      // function / symbol / bigint 等：状态里不应出现，抛确定性错误。
      throw new DeterminismError('UNSUPPORTED_TYPE', 'canonicalize: 不支持的值类型 ' + t);
    }
  }
}

/**
 * compareCodeUnits：按 UTF-16 code unit 字典序比较（架构 7.5「键顺序确定」）。
 *
 * 直接用码元数值比较而非 localeCompare：localeCompare 受引擎 locale / ICU 影响，
 * 不同内核可能给出不同顺序，会破坏「同状态同哈希」。逐码元比较是纯数值、确定的。
 */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * stringifyString：字符串 → 's' + <UTF-8 字节长度> + ':' + <UTF-8 字节原样>。
 *
 * 为何用「字节长度前缀」：
 *   任务要求 'ab'+'c' 与 'a'+'bc' 不能雷同。用长度前缀后：
 *     'ab' → 's2:ab'，'c' → 's1:c' ；拼接得 's2:abs1:c'
 *     'a'  → 's1:a'， 'bc' → 's2:bc'；拼接得 's1:as2:bc'
 *   两者不同，且任何读者都能靠长度前缀唯一切分出原串边界，故无歧义。
 *   用「字节长度」而非「字符长度」：因为终态是 UTF-8 字节流，前缀与字节边界一致，
 *   读者按字节数取即可精确切分（对含中文的键同样无歧义）。
 */
function stringifyString(s: string): string {
  const bytes = utf8Bytes(s);
  // 注意：这里拼的是「前缀 + 原字符串本身」。前缀记录的是字节长度，随后原样追加
  // 字符串；最终整体会被 utf8Bytes 再编码成字节喂给 FNV。因为前缀与正文都在同一
  // 字符串里，读者按「前缀声明的字节数」切正文即可。为与字节口径一致，正文用原 s。
  return 's' + String(bytes.length) + ':' + s;
}

/**
 * stringifyNumber：数字 → 'd' + 规范数字文本。
 *
 * 规则（确定性关键）：
 *   · NaN / +Infinity / -Infinity：状态里不应出现非有限值，抛 DeterminismError
 *     （否则不同内核可能把它写成不同串，产生不确定哈希）。
 *   · -0：归一为 '0'（-0 与 0 是同一状态，必须同哈希；Object.is(-0,0) 为 false，
 *     但逻辑上当 0 处理 —— 见测试 d）。
 *   · 整数（Number.isInteger，且在安全范围内）：直接 String(n)，无歧义、跨内核一致。
 *   · 浮点：用 String(n)（ECMAScript 规范要求 Number::toString 产出「能唯一往返的
 *     最短十进制串」，现代引擎一致）。**跨内核风险**：若某个旧引擎的 Number::toString
 *     实现有偏差（如极少数边界值的十进制展开差异），同一浮点可能得到不同串 → 不同
 *     哈希。架构 7.5 建议「有限浮点用固定的有效位数或直接 String(n)，但要注释跨内核
 *     风险」；这里选 String(n) 并强制区分整数/浮点分支。若需绝对跨内核一致，可改用
 *     .toPrecision(17) 固定有效位数（见下方注释代码）。
 *
 * 确定性依据：整数走精确十进制；浮点走规范最短往返串；-0 归一。
 */
function stringifyNumber(n: number): string {
  if (Number.isNaN(n)) throw new DeterminismError('NON_FINITE', 'canonicalize: 状态含 NaN，无法确定序列化');
  if (!Number.isFinite(n)) throw new DeterminismError('NON_FINITE', 'canonicalize: 状态含 ±Infinity，无法确定序列化');
  // -0 → 0（归一为同一状态）
  if (n === 0) return 'd0';
  if (Number.isInteger(n)) return 'd' + String(n);
  // 有限浮点：规范最短往返串。跨内核风险见函数注释；如需固定有效位数可改为：
  //   return 'd' + n.toPrecision(17);
  return 'd' + String(n);
}

// ---------------------------------------------------------------------------
// hashState：规范状态哈希（canonicalize → FNV-1a 64 → 16 位 hex）
// ---------------------------------------------------------------------------

/**
 * hashState：给定任意状态对象，返回其规范状态哈希（16 位小写十六进制）。
 *
 * 步骤：canonicalize(state) 得到规范字符串 → UTF-8 编码为字节 → fnv1a64 →
 *   u64ToHex（hi/lo 各 8 位）。
 *
 * 覆盖范围（架构 7.5，务必由调用方理解）：本模块只负责「给定任意状态对象算出规范
 *   哈希」，**具体覆盖哪些字段由调用方决定传入什么**。要得到符合架构 7.5 的规范
 *   状态哈希，调用方应传入「游戏状态本身」：
 *
 *   ✓ 推荐传入（游戏状态本身）：
 *       perma 段、run 段、rng 段，以及 meta 中的 currentTick、tickMs、runId、引导标记
 *       （缺少 rng 与 currentTick 会让随机状态不同 / 时刻不同的存档得到相同哈希）。
 *
 *   ✗ 必须排除（否则会引入不确定 / 非状态因素，导致同进度不同哈希或本地噪声漂移）：
 *       保存时间、导出记录（exportMeta）、设备标识、版本向量、saveSeq（存档序号）、
 *       时间保护字段（timeGuard）、以及三个版本号（结构版本 / 配置版本 / 引擎版本）。
 *
 *   即：调用方应先「只挑出应覆盖的字段」组成一个纯状态子对象再传入；本函数不替调用
 *   方做字段裁剪（保持与调用方状态模型解耦）。
 *
 * 确定性依据：canonicalize 确定 + fnv1a64 确定 ⇒ 同一状态恒得同一 16 位 hex。
 */
export function hashState(state: unknown): string {
  const canonical = canonicalize(state);
  return fnv1a64Hex(utf8Bytes(canonical));
}

// ---------------------------------------------------------------------------
// hashReplay：回放哈希（四段按固定分隔拼接 → FNV-1a 64 → 16 位 hex）
// ---------------------------------------------------------------------------

/**
 * 回放哈希分段分隔符。
 *
 * 用一个「不会出现在规范状态哈希 / 摘要 / 版本号字段中出现」的显式分隔。规范状态哈希
 * 是 16 位 hex，inputLog 是字符串（可能含任意字符，但这里用长度前缀编码，见下），
 * 版本号是数字。为杜绝「不同分段拼接后撞车」，这里对 inputLog 用长度前缀、并用醒目
 * 分隔符 '|' 连接四段，且对每段标注段名前缀，使边界恒可重建。
 */
const REPLAY_SEP = '|';

/**
 * hashReplay：回放哈希 = 规范状态哈希 + 输入序列摘要 + 配置版本 + 引擎版本。
 *
 * 架构 7.5：「回放哈希 = 规范状态哈希，加输入序列摘要、配置版本、引擎版本」。
 * 用于诊断回放与 Gate 2 跨内核比较。
 *
 * 拼接协议（固定分隔 + 段名 + 长度前缀，杜绝歧义）：把四部分按固定顺序、以 '|' 分隔、
 * 每段带段名与（对变长串）长度前缀拼成一个串，再整体 FNV-1a 64：
 *
 *   'h' + <规范状态哈希 16 hex>        // 已经是定长，无需长度前缀
 *   '|i' + <inputLog 长度> + ':' + <inputLog>   // inputLog 变长，用长度前缀钉边界
 *   '|c' + <配置版本整数>
 *   '|e' + <引擎版本整数>
 *
 * 为何这样能保证「任一字段变 → 哈希变」：四段各自是独立、可边界重建的片段；改
 * inputLog / configVersion / engineVersion 任一项都会改变拼接串的字节流，从而改变
 * FNV-1a 结果（测试 e 验证）。
 *
 * 确定性依据：四段均为纯数据（无时钟 / 随机）；fnv1a64 确定 ⇒ 同一四元组恒得同一哈希。
 *
 * @param canonicalStateHash 已算好的规范状态哈希（16 位小写 hex，通常来自 hashState）
 * @param inputLog           输入序列摘要（可为任意字符串；此处按原样 + 长度前缀纳入）
 * @param configVersion      配置版本号（整数）
 * @param engineVersion      引擎版本号（整数）
 */
export function hashReplay(
  canonicalStateHash: string,
  inputLog: string,
  configVersion: number,
  engineVersion: number,
): string {
  if (typeof canonicalStateHash !== 'string') {
    throw new DeterminismError('INVALID_ARG', 'hashReplay: canonicalStateHash 必须是字符串');
  }
  if (typeof inputLog !== 'string') {
    throw new DeterminismError('INVALID_ARG', 'hashReplay: inputLog 必须是字符串');
  }
  if (!Number.isInteger(configVersion) || !Number.isInteger(engineVersion)) {
    throw new DeterminismError('INVALID_ARG', 'hashReplay: configVersion / engineVersion 必须是整数');
  }
  const inputBytesLen = utf8Bytes(inputLog).length;
  const payload =
    'h' + canonicalStateHash +
    REPLAY_SEP + 'i' + String(inputBytesLen) + ':' + inputLog +
    REPLAY_SEP + 'c' + String(configVersion) +
    REPLAY_SEP + 'e' + String(engineVersion);
  return fnv1a64Hex(utf8Bytes(payload));
}
