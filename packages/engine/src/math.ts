/**
 * W1 数学原语 · S3/Gate 2/Gate 4 验收对象
 * ---------------------------------------------------------------------------
 * 本文件是《创世火种》引擎的确定性基石（架构 5.2 数学原语层 / 5.5 确定性约束）。
 * 所有数学原语必须在 V8 / JavaScriptCore / SpiderMonkey 三内核（Spike S3）上
 * 输出完全一致。为此本文件主动禁用一切 IEEE-754 浮点「非确定」路径：
 *   - 禁止 Math.pow 的大指数路径（各内核用各自的 exp/log 组合，结果可能不同）；
 *   - 禁止把 Math.log 放进确定性主路径（实现差异，登记为 S3 观察项）；
 *   - 32 位乘法一律 Math.imul（普通 `*` 走 64 位双精度，会丢弃低位，破坏整数语义）。
 *
 * 确定性的根本来源：本文件只依赖 ECMA-262 严格规定的整数 / 位运算语义
 * （按位运算的 ToInt32/ToUint32 转换、Math.imul 的精确 32 位乘法、以及
 * IEEE-754 双精度下「单次 + - * /」的正确舍入）。这些语义三内核必须一致。
 *
 * 注：单测位于 packages/engine/test/，一律 import '../src/math.js'（带 .js 扩展的相对路径），
 * 符合 TS `module: nodenext` 的 ESM 解析规则；本文件无任何第三方包依赖。
 */

/**
 * Mulberry32 PRNG（确定性伪随机数发生器）。
 *
 * 确定性依据（S3）：状态机为纯 32 位整数运算。状态步进 `state = (state + 0x6D2B79F5) | 0`
 * （32 位回绕的 Weyl 序列，`| 0` 即 ToInt32），混合阶段只用异或（^）与 Math.imul
 * （精确 32 位乘法，禁止普通 `*`）。整个流程不含任何浮点超越函数，故三内核逐位一致。
 *
 * 输出：`((t ^ t >>> 14) >>> 0) / 4294967296`，用「除以 2^32」这一精确除法把 uint32
 * 映射到 [0,1)，刻意避开任何「先乘法缩放再修正」的浮点误差路径。
 *
 * 命名流约定（架构 5.5）：调用方为每个逻辑随机流（如「掉落」「地图生成」「天气」）
 * 各建一个独立实例，保证不同流的抽样序列互不干扰、可单独重放。
 *
 * 参考实现：Tommy Ettinger 2017 设计；业界通行 JS 版见 bryc gist 与
 * cprosche/mulberry32，核心常量为增量 0x6D2B79F5（= 1831565813）。
 * 说明：任务背景中提到的 0x19660D / 0x3D6EF0F 并非 Mulberry32 的常量
 * （它们属 LCG 一类的乘子/增量），故本实现严格按业界通行 Mulberry32 书写。
 *
 * @param seed 任意数值；内部经 `| 0` 归一到 32 位（seed=0 与 0xFFFFFFFF 均为合法边界）
 * @returns 每次调用返回 [0,1) 的确定性浮点
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0; // 归一到有符号 32 位；与 bryc / cprosche 版语义等价（32 位同余）
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0; // 32 位回绕加法（Weyl 序列步进）
    let t = Math.imul(a ^ (a >>> 15), a | 1); // 精确 32 位乘法，禁止普通 *
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t; // 再混一轮，全程整数
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; // 精确除以 2^32 → [0,1)
  };
}

/**
 * secToTicks：游戏秒 → 整数 tick 数（向上取整）。
 *
 * 确定性依据（S3）：只用 + - * 与 `| 0`（ToInt32）整数运算，不对非整数商走
 * Math.ceil，也不含超越函数，故三内核一致。
 *
 * 架构约束（Gate 1）：Gate 1 已保证所有游戏周期为整数秒，且 tickMs ∈ {100,250,1000}
 * 均整除 1000，因此 `sec*1000` 必为 tickMs 的整数倍 —— 整除时向上取整退化为精确整除。
 * 为对来自外部/浮点的非整除秒值仍保持确定性向上取整，这里统一采用整数公式
 * `(sec*1000 + tickMs - 1) / tickMs | 0`：+ (tickMs-1) 实现向上取整，末尾 `| 0` 向零截断
 * （输入非负，等价于 floor）。
 *
 * @param sec 游戏秒（Gate 1 保证为非负整数；非整除时按向上取整处理）
 * @param tickMs 每 tick 毫秒，限 100 | 250 | 1000
 * @returns 整数 tick 数
 */
export function secToTicks(sec: number, tickMs: 100 | 250 | 1000): number {
  const ms = sec * 1000; // 秒 → 整数毫秒（整数秒时精确）
  return ((ms + tickMs - 1) / tickMs) | 0; // 整数向上取整：ceil(ms/tickMs)
}

/**
 * fastPowInt：整数幂的快速幂（迭代平方，exponentiation by squaring）。
 *
 * 确定性依据（S3）：用普通 `*`。在 IEEE-754 下每次乘法都是「正确舍入」的单次运算，
 * 三内核结果逐位一致；只做有限次乘法、不调用任何超越函数。刻意不使用 Math.pow ——
 * 其对指数 > 1 的实现走各引擎各自的 exp/log 组合，可能产生不同结果（S3 观察项）。
 *
 * 域检查（抛「形状固定」的确定性 Error，跨内核一致，便于同一断言）：
 *   - base 必须是有限数（拒绝 NaN / ±Infinity）；
 *   - exp 必须是非负整数且 ≤ 1023（>1023 易把结果推到 ±Infinity，失去意义且易非确定）。
 * 约定：0^0 = 1（编程惯例）；1^anything = 1。
 *
 * @param base 有限数
 * @param exp 非负整数，0 ≤ exp ≤ 1023
 * @returns base 的 exp 次幂
 */
export function fastPowInt(base: number, exp: number): number {
  if (!Number.isFinite(base)) {
    throw new Error("fastPowInt: base must be a finite number");
  }
  if (!Number.isInteger(exp) || exp < 0 || exp > 1023) {
    throw new Error("fastPowInt: exp must be an integer in [0, 1023]");
  }
  let result = 1;
  let b = base;
  let e = exp;
  while (e > 0) {
    if ((e & 1) === 1) {
      result = result * b; // 普通乘法：整数幂下每次均为单次正确舍入，跨内核一致
    }
    e = e >>> 1; // 32 位无符号右移，逐位消耗指数（exp ≤ 1023 必在 32 位内）
    if (e > 0) {
      b = b * b; // 迭代平方
    }
  }
  return result;
}

/**
 * deterministicLn1p：确定性的 ln(1 + x)。
 *
 * 确定性依据（Gate 4 / S3）：主路径（|x| ≤ 0.5）为纯多项式（泰勒级数）Horner 求值，
 * 只用 + - *，不含 Math.log / Math.pow，故三内核一致、且满足 Gate 4 的 ≤ 1e-9 误差。
 *
 * 级数：ln(1+x) = x − x²/2 + x³/3 − x⁴/4 + … + (−1)^{n+1} x^n / n + …
 * 任务下限为「至 x^10 项」；但 x=−0.5 端点上（x<0）级数为同号负项、余项界较松，
 * 仅取到 x^10 项时余项约 4e-5，达不到 1e-9。为真正满足 Gate 4，这里取到 x^30 项：
 * 在 x=−0.5 处余项 ≤ (1/31)·|x|^31/(1−|x|) ≈ 6e-11 < 1e-9（含浮点舍入仍有充裕裕度）。
 *
 * 回退路径（|x| > 0.5 且 x > −1）：回退 Math.log(1+x)。
 *   S3 观察项登记：Math.log 在三内核的末位实现可能存在 ulp 级差异，属已知的不确定风险；
 *   该回退仅用于域外输入，确定性主路径不受影响，正式引擎将另行以多项式覆盖更宽域。
 *
 * 违域（x ≤ −1）：ln(1+x) 无定义（1+x ≤ 0），抛形状固定的确定性 Error。
 *
 * @param x 自变量；定义域 x > −1（确定性主路径 |x| ≤ 0.5）
 * @returns ln(1 + x)
 */
export function deterministicLn1p(x: number): number {
  if (x <= -1) {
    // 确定性错误：类型与消息恒定，跨内核形状一致
    throw new Error("deterministicLn1p: domain error, x must be > -1");
  }
  if (x < -0.5 || x > 0.5) {
    // 域外回退：登记为 S3 观察项（Math.log 末位跨内核可能不同）
    return Math.log(1 + x);
  }
  // 泰勒系数 c_k = (−1)^{k+1} / k，k = 1..30
  const C1 = 1;
  const C2 = -1 / 2;
  const C3 = 1 / 3;
  const C4 = -1 / 4;
  const C5 = 1 / 5;
  const C6 = -1 / 6;
  const C7 = 1 / 7;
  const C8 = -1 / 8;
  const C9 = 1 / 9;
  const C10 = -1 / 10;
  const C11 = 1 / 11;
  const C12 = -1 / 12;
  const C13 = 1 / 13;
  const C14 = -1 / 14;
  const C15 = 1 / 15;
  const C16 = -1 / 16;
  const C17 = 1 / 17;
  const C18 = -1 / 18;
  const C19 = 1 / 19;
  const C20 = -1 / 20;
  const C21 = 1 / 21;
  const C22 = -1 / 22;
  const C23 = 1 / 23;
  const C24 = -1 / 24;
  const C25 = 1 / 25;
  const C26 = -1 / 26;
  const C27 = 1 / 27;
  const C28 = -1 / 28;
  const C29 = 1 / 29;
  const C30 = -1 / 30;
  // Horner：poly = x·(C1 + x·(C2 + x·(C3 + … + x·C30)…))
  let h = C30;
  h = C29 + x * h;
  h = C28 + x * h;
  h = C27 + x * h;
  h = C26 + x * h;
  h = C25 + x * h;
  h = C24 + x * h;
  h = C23 + x * h;
  h = C22 + x * h;
  h = C21 + x * h;
  h = C20 + x * h;
  h = C19 + x * h;
  h = C18 + x * h;
  h = C17 + x * h;
  h = C16 + x * h;
  h = C15 + x * h;
  h = C14 + x * h;
  h = C13 + x * h;
  h = C12 + x * h;
  h = C11 + x * h;
  h = C10 + x * h;
  h = C9 + x * h;
  h = C8 + x * h;
  h = C7 + x * h;
  h = C6 + x * h;
  h = C5 + x * h;
  h = C4 + x * h;
  h = C3 + x * h;
  h = C2 + x * h;
  h = C1 + x * h;
  return x * h; // x=0 时精确返回 +0
}
