/**
 * W5a sim-cli 基础闭环 · Gate 2/3 验收对象
 * ---------------------------------------------------------------------------
 * 《创世火种》批次 5a · sim-cli 最小命令行入口。
 *
 * 本文件是 packages/sim-cli 的命令行入口（最终并入 packages/sim-cli 后，改为从
 * `@genesis/engine` / `@genesis/configs` 取引擎与配置，并从 ./sim.js 取本闭环入口）。
 * 它把 sim.ts 的闭环能力暴露为四个子命令，供开发/QA 在 Node 下快速跑通「可批量仿真 +
 * 可回放验证」：
 *
 *   sim run              --seed <n> --ticks <n>              跑 n tick，输出最终状态摘要
 *   sim replay           --seed <n> --ticks <n> --runs <n>   跑 verifyReplay，输出一致性结果
 *   sim tick-invariance  --seed <n> --ticks <n>              跑 verifyTickInvariance，输出三档
 *                                                            哈希与事件序列
 *   sim snapshot         --seed <n> --ticks <n>              输出 snapshotSummary
 *
 * 说明：
 *   · 只用 process.argv 手写解析，不依赖任何第三方 CLI 库（commander/yargs 等）。
 *   · 默认配置见 sim.ts 的 DEFAULT_CONFIG（tickMs=250，单资源 food）。
 *   · 本命令只证明「引擎可复现、可批量」，不证明任何可玩性结论（见 sim.ts 文件头边界）。
 *   · 静态交付：本文件为类型自检对象，未在具备 vitest 的环境实际运行；输出格式为占位示例。
 *
 * TODO(sim-cli): 并入 packages/sim-cli 后：
 *   1) import { ... } from '@genesis/engine'（advance/dispatch/types）与 '@genesis/configs'（GameConfig）；
 *   2) 增加 --config <path> 读取真实 config.m1.ts，替代 DEFAULT_CONFIG；
 *   3) 增加 --json 机器可读输出，供 CI 回归比对规范哈希。
 */

import {
  makeDefaultState,
  simulate,
  verifyReplay,
  verifyTickInvariance,
  snapshotSummary,
  defaultSources,
  DEFAULT_CONFIG,
  type SimCommandState,
  type GameCommand,
} from './sim.js';

// ---------------------------------------------------------------------------
// 参数解析（手写，不依赖第三方 CLI 库）
// ---------------------------------------------------------------------------

/**
 * extractCommandTokens：从完整 argv 中截取「以 sim 开头」的命令 token。
 * 兼容两种调用：
 *   · process.argv = ['/path/node', '/path/cli.js', 'sim', 'run', ...] → 从 'sim' 处截取；
 *   · 直接传 ['sim', 'run', ...]（测试/嵌入调用）→ 原样。
 */
function extractCommandTokens(argv: string[]): string[] {
  const i = argv.indexOf('sim');
  if (i >= 0) return argv.slice(i);
  // 找不到 'sim'：按 process.argv 约定跳过头两个元素（node 与脚本路径）。
  return argv.slice(2);
}

/**
 * parseFlags：把 ['--seed','1','--ticks','100'] 解析为 { seed:'1', ticks:'100' }。
 * 仅支持 `--key value` 与布尔 `--flag`；不依赖第三方库。
 */
function parseFlags(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === undefined || !t.startsWith('--')) continue;
    const key = t.slice(2);
    const next = tokens[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

/** parseIntFlag：读取整型旗标；缺失或非法抛错（含旗标名，便于定位）。 */
function parseIntFlag(flags: Record<string, string>, name: string): number {
  const raw = flags[name];
  if (raw === undefined) throw new Error(`缺少参数 --${name}`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`参数 --${name} 非法：${raw}`);
  return n;
}

// ---------------------------------------------------------------------------
// 子命令实现
// ---------------------------------------------------------------------------

/** 用默认配置与给定 seed、ticks 造一个带目标时长的初始状态；无命令（batch 5a 基础闭环）。 */
function buildState(seed: number, ticks: number): SimCommandState {
  return makeDefaultState(seed, ticks);
}

/** 空命令序列（batch 5a 只验证「推进 + 哈希 + 回放」闭环，命令插入见 sim.test.ts 用例 c）。 */
const NO_COMMANDS: Array<{ atTick: number; cmd: GameCommand }> = [];

/**
 * cmdRun：`sim run --seed <n> --ticks <n>`——从默认配置跑 n tick，输出最终状态摘要。
 * 对应 Gate 2 步长 / S2 的「可跑通、可出规范状态哈希」。
 */
function cmdRun(flags: Record<string, string>): void {
  const seed = parseIntFlag(flags, 'seed');
  const ticks = parseIntFlag(flags, 'ticks');
  const state = buildState(seed, ticks);
  const result = simulate(state, NO_COMMANDS, { ticks, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
  const summary = snapshotSummary(result.state);
  console.log('[sim run] 最终状态摘要：');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`[sim run] 事件数=${result.events.length}，段数=${result.segmentsRun}`);
}

/**
 * cmdReplay：`sim replay --seed <n> --ticks <n> --runs <n>`——跑 verifyReplay，输出一致性结果。
 * 对应 Gate 2-D「同引擎重复回放」。
 */
function cmdReplay(flags: Record<string, string>): void {
  const seed = parseIntFlag(flags, 'seed');
  const ticks = parseIntFlag(flags, 'ticks');
  const runs = parseIntFlag(flags, 'runs');
  const state = buildState(seed, ticks);
  const { consistent, hashes } = verifyReplay(state, NO_COMMANDS, runs);
  console.log('[sim replay] 一致性结果：');
  console.log(JSON.stringify({ consistent, runs, hashes }, null, 2));
}

/**
 * cmdTickInvariance：`sim tick-invariance --seed <n> --ticks <n>`——跑 verifyTickInvariance，输出
 * 三档（100/250/1000ms）哈希与事件序列。对应 Gate 2-A/B / S2「步长不变性」。
 *
 * 注意：默认配置 tickMs=250。要使 ticks×250ms 能同时被 100/250/1000 整除（三档对齐），ticks 需为 4 的
 * 倍数（如 100）。若不能整除，verifyTickInvariance 会抛出明确错误，此处捕获并提示。
 */
function cmdTickInvariance(flags: Record<string, string>): void {
  const seed = parseIntFlag(flags, 'seed');
  const ticks = parseIntFlag(flags, 'ticks');
  const state = buildState(seed, ticks);
  try {
    const { consistent, results } = verifyTickInvariance(state, NO_COMMANDS, [100, 250, 1000]);
    console.log('[sim tick-invariance] 三档 tickMs 结果（tickMs / hash / events）：');
    console.log(JSON.stringify({ consistent, results }, null, 2));
    if (!consistent) {
      console.log('[sim tick-invariance] 警告：三档不一致（应排查 tickMs 依赖性）。');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[sim tick-invariance] 无法对齐比较：${msg}`);
    console.log('[sim tick-invariance] 提示：默认配置 tickMs=250，--ticks 需为 4 的倍数（如 100）。');
  }
}

/**
 * cmdSnapshot：`sim snapshot --seed <n> --ticks <n>`——输出 snapshotSummary。
 * 对应架构 7.5 规范状态哈希（长期回归报告用）。
 */
function cmdSnapshot(flags: Record<string, string>): void {
  const seed = parseIntFlag(flags, 'seed');
  const ticks = parseIntFlag(flags, 'ticks');
  const state = buildState(seed, ticks);
  const result = simulate(state, NO_COMMANDS, { ticks, remainingMs: 0, maxSegmentsThisSlice: 1_000_000 }, defaultSources());
  const summary = snapshotSummary(result.state);
  console.log('[sim snapshot] 存档摘要：');
  console.log(JSON.stringify(summary, null, 2));
}

/** printUsage：打印用法。 */
function printUsage(): void {
  console.log('用法：');
  console.log('  sim run              --seed <n> --ticks <n>');
  console.log('  sim replay           --seed <n> --ticks <n> --runs <n>');
  console.log('  sim tick-invariance  --seed <n> --ticks <n>   （--ticks 建议为 4 的倍数）');
  console.log('  sim snapshot         --seed <n> --ticks <n>');
  console.log(`默认配置：tickMs=${DEFAULT_CONFIG.tickMs}，资源=${Object.keys(DEFAULT_CONFIG.resources).join(',')}`);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * main：命令行主入口。args 约定为 process.argv（自动跳过 node 与脚本路径）。
 * 派发到 run / replay / tick-invariance / snapshot 子命令；未知子命令打印用法。
 * 解析/运行时错误以友好消息打印，不抛裸栈（便于 CLI 使用）。
 */
export function main(args: string[]): void {
  const tokens = extractCommandTokens(args);
  // tokens[0] 应为 'sim'，tokens[1] 为子命令。
  const sub = tokens[1];
  const flags = parseFlags(tokens.slice(2));
  try {
    switch (sub) {
      case 'run':
        cmdRun(flags);
        return;
      case 'replay':
        cmdReplay(flags);
        return;
      case 'tick-invariance':
        cmdTickInvariance(flags);
        return;
      case 'snapshot':
        cmdSnapshot(flags);
        return;
      default:
        printUsage();
        return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[sim-cli] 错误：${msg}`);
    printUsage();
  }
}

// 仅当作为脚本直接运行时执行 main（避免被 sim.test.ts / 其它模块 import 时误触发）。
// 判据：process.argv[1] 的脚本名以 cli.ts / cli.js 结尾。
const entry = typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv[1] : undefined;
if (entry !== undefined && /(^|[\\/])cli\.(ts|js)$/.test(entry)) {
  main(process.argv);
}
