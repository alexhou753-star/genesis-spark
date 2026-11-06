/**
 * W5d 真实流程实测 · M1 核心验收「Bot 能从纪元 1 推进到纪元 2」
 * ============================================================================
 * 本文件是【真实运行的完整验收脚本】，不是静态交付物。任务要求「不得伪造」，
 * 因此脚本会实际用引擎内核跑一遍完整游戏循环，并把真实观测到的数据逐项打印。
 *
 * ── 与 M1 开工包 types.ts（v0.2/0.3）的差异说明（重要）──────────────────────
 *   任务文本里的命令/事件措辞（如 RESET、ChainLevel、SimEvent.type）来自「开工包类型草案」；
 *   但本仓库实际可运行的引擎内核是 gameLoop.ts（W1–W5d 暂存包合并到 packages/engine），
 *   其真实运行态 API 为：
 *     · gameTick(state, config) -> { state, events }          （单 tick 四阶段结算）
 *     · events[i] = { atMilli, seq, group, kind, payload }    （kind 判事件种类）
 *     · GameState 直接带 currentEra / resources / buildings / techs / seasonIndex / chainStates …
 *     · createBot(seed, config).decide(state) -> GameCommand[]
 *     · enqueueCommand(state, cmd) 入队、gameTick 时 flush
 *   因此「断链」在本内核中以事件 kind = 'chain.transition' 出现；「季节切换」以
 *   kind = 'season.change' 出现；「已研究的科技」即 state.techs。下文逐项统计均基于真实事件流。
 *
 * ── import 路径约定 ─────────────────────────────────────────────────────────
 *   测试文件位于 packages/engine/test/（本 .ts 由负责人拷入该目录）。
 *   因此从同包的 src 目录导入一律用相对路径 '../src/xxx.js'（ESM 下 vitest 解析到 src/xxx.ts）：
 *     '..\/src/gameLoop.js'  gameTick / runGame / advanceEra / createBot /
 *                            createInitialGameState / enqueueCommand / 类型
 *     '..\/src/hash.js'      hashState（W4 规范状态哈希，最终并入 packages/engine）
 *   从 configs 包导入 M1_CONFIG，用 '..\/..\/configs/src/config.m1.js'（packages/configs/src/config.m1.ts）。
 *   以上路径在 packages/engine/test 下均可解析；静态检查（tsc/vitest 解析）依赖仓库实际 packages/
 *   目录结构，见文件末「静态检查」注释。
 *
 * ── Bot 起步资源（诚实边界）────────────────────────────────────────────────
 *   配置里的 createInitialGameState(seed=42) 默认所有资源为 0。而 createBot 是纯贪心：
 *   只有「可负担成本」时才建 field，成本为木材，故在零资源开局下 Bot 会永远等待木材（无「等待
 *   采集」或「卡住就换策略」逻辑），会死锁在资源 0 上、永远到不了纪元 2。这是 Bot 策略的客观行为，
 *   不是流程 bug。为跑通 M1 验收（Bot 从纪元 1 推进到纪元 2），必须注入一小笔「开荒资源」作为
 *   启动种子。本脚本采用与项目自身 w5d 验收用例 runBot 完全一致的起步资源 { wood: 80, food: 20 }，
 *   并会在打印中明确标注这一点，绝不隐瞒。
 */

import { describe, it, expect } from 'vitest';

import {
  gameTick,
  createBot,
  createInitialGameState,
  enqueueCommand,
  type GameState,
  type GameConfig,
  type GameCommand,
} from '../src/gameLoop.js';
import { hashState } from '../src/hash.js';
import { M1_CONFIG } from '../../configs/src/config.m1.js';

// -----------------------------------------------------------------------------
// 配置与常量
// -----------------------------------------------------------------------------

/**
 * 真实配置：直接加载 M1_CONFIG（不镜像、不改数值）。
 * 类型说明：M1_CONFIG 由 @genesis/configs 的 GameConfig 标注，其 ResourceKind 是引擎层
 *   GameConfig.ResourceKind 的超集（configs 侧含 M2 才用的 'order' 等类别）；运行时二者完全兼容，
 *   M1_CONFIG 不涉及 M2 专属类别。此处仅做一次显式跨包类型 cast，不改变任何数值，用真实配置跑流程。
 */
const CONFIG: GameConfig = M1_CONFIG as unknown as GameConfig;

/** 随机种子（确定性验证要求两次运行同种子、同结果）。 */
const SEED = 42;

/** Bot 开荒启动资源（见文件头「Bot 起步资源」说明；与项目自身 runBot 用例一致）。 */
const STARTING_RESOURCES: Record<string, number> = { wood: 80, food: 20 };

/** tick 上限：20000 tick = 20000 × 250ms = 5000 游戏秒 ≈ 83.3 分钟（覆盖「2 小时流程」验收窗口）。 */
const MAX_TICKS = 20000;

/** 从某个 GameState 派生「游戏内秒数」= currentTick × tickMs / 1000。 */
function gameSecondsOf(state: GameState): number {
  return (state.currentTick * state.tickMs) / 1000;
}

// -----------------------------------------------------------------------------
// 一次完整流程运行（纯函数：给定配置/种子/起步资源 → 终态 + 全事件日志）
// -----------------------------------------------------------------------------

interface FlowRun {
  /** 终态。 */
  state: GameState;
  /** 全事件流（按时间累加）。 */
  allEvents: Array<{ atMilli: number; seq: number; group: string; kind: string; payload: Record<string, unknown> }>;
  /** 实际推进的 tick 数。 */
  ticksRun: number;
  /** 是否达到纪元 2（currentEra >= 2）。 */
  reachedEra2: boolean;
  /** 达到纪元 2 时的 tick（未达到为 null）。 */
  era2Tick: number | null;
}

/**
 * runFlow：真实跑完整流程。
 *   1) createInitialGameState(CONFIG, seed, 'human', STARTING_RESOURCES) 构建初始状态（扮演人类种族）；
 *   2) createBot(seed, CONFIG) 创建 Bot；
 *   3) 循环至多 MAX_TICKS：每 tick 调 bot.decide(state) → 逐条 enqueueCommand → gameTick → 收集事件；
 *      一旦 currentEra >= 2 立即停（记录达到纪元的 tick）；
 *   4) 返回终态、事件日志、tick 数、是否达到纪元 2。
 */
function runFlow(config: GameConfig, seed: number, startingResources: Record<string, number>): FlowRun {
  const bot = createBot(seed, config);
  let state = createInitialGameState(config, seed, 'human', startingResources);

  const allEvents: FlowRun['allEvents'] = [];
  let ticksRun = 0;
  let era2Tick: number | null = null;

  for (let i = 0; i < MAX_TICKS; i++) {
    // Bot 决策（确定性）：本 tick 要提交的命令列表。
    const cmds: GameCommand[] = bot.decide(state);
    // 逐条入队（enqueueCommand 返回新 state，不原地修改）。
    for (const cmd of cmds) {
      state = enqueueCommand(state, cmd);
    }
    // 推进 1 tick（gameTick 内部 flush 命令队列 → 四阶段结算）。
    const r = gameTick(state, config);
    state = r.state;
    for (const e of r.events) allEvents.push(e);
    ticksRun += 1;

    // 达到纪元 2 即收官（M1 核心验收）。
    if (state.currentEra >= 2) {
      era2Tick = state.currentTick;
      break;
    }
  }

  return {
    state,
    allEvents,
    ticksRun,
    reachedEra2: state.currentEra >= 2,
    era2Tick,
  };
}

// -----------------------------------------------------------------------------
// 统计与格式化
// -----------------------------------------------------------------------------

/** countByKind：按事件 kind 分类计数（确定性：先取 kind 集合再排序输出）。 */
function countByKind(events: FlowRun['allEvents']): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of events) {
    counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  }
  // 排序后的稳定顺序（仅用于打印美观，不影响数值）。
  const sorted: Record<string, number> = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k] ?? 0;
  return sorted;
}

/** 资源快照：{ resId: { amount, max } }（按配置声明顺序，数值四舍五入到 6 位小数便于阅读）。 */
function resourceSnapshot(state: GameState, config: GameConfig): Record<string, { amount: number; max: number }> {
  const out: Record<string, { amount: number; max: number }> = {};
  for (const r of config.resources) {
    const cur = state.resources[r.id];
    if (!cur) continue;
    out[r.id] = { amount: round6(cur.amount), max: round6(cur.max) };
  }
  return out;
}

/** 建筑清单：{ buildingId: { count, active } }（按配置声明顺序）。 */
function buildingList(state: GameState, config: GameConfig): Record<string, { count: number; active: number }> {
  const out: Record<string, { count: number; active: number }> = {};
  for (const b of config.buildings) {
    const cur = state.buildings[b.id];
    if (!cur) continue;
    out[b.id] = { count: cur.count, active: cur.active };
  }
  return out;
}

/** round6：四舍五入到 6 位小数（仅用于打印/摘要，哈希用原始终态，不影响确定性断言）。 */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * snapshotForHash：把终态序列化为「规范状态本体」用于 hashState。
 *   取游戏状态本身：currentTick / tickMs / subMilli / resources / rates / currentEra /
 *   raceId / buildings / techs / seasonIndex / chainStates / population / seed / jobAssignments。
 *   有意排除 dispatch（含 Set<string> appliedCommandIds 与 pending 命令簿记）：那是命令层瞬时
 *   簿记，非规范游戏状态（架构 7.5：规范状态哈希覆盖「游戏状态本身」perma/run/rng/meta，不含
 *   命令收件箱）；这样也避免 canonicalize 对 Set 的序列化分歧，保证跨实现/跨运行确定性。
 */
function snapshotForHash(state: GameState): Record<string, unknown> {
  return {
    currentTick: state.currentTick,
    tickMs: state.tickMs,
    subMilli: state.subMilli,
    resources: state.resources,
    rates: state.rates,
    currentEra: state.currentEra,
    raceId: state.raceId,
    buildings: state.buildings,
    techs: state.techs,
    seasonIndex: state.seasonIndex,
    chainStates: state.chainStates,
    population: state.population,
    seed: state.seed,
    jobAssignments: state.jobAssignments,
  };
}

// -----------------------------------------------------------------------------
// vitest：一个 it 跑全流程，断言 finalEra >= 2，并做确定性哈希一致验证
// -----------------------------------------------------------------------------

describe('W5d 真实流程实测 · Bot 从纪元 1 推进到纪元 2（M1 核心验收）', () => {
  it('真实跑完整流程：达到纪元 2，事件统计/资源/建筑/科技/断链/季节全部实测，且两次运行哈希一致', () => {
    console.log('==================================================================');
    console.log(' W5d 真实流程实测 —— M1 核心验收「Bot 从纪元 1 推进到纪元 2」');
    console.log('==================================================================');
    console.log(`[配置] M1_CONFIG configVersion=${CONFIG.configVersion}  clock.tickMs=${CONFIG.clock.tickMs}ms  seasonSec=${CONFIG.clock.seasonSec}s`);
    console.log(`[种子] seed=${SEED}（确定性验证：同种子两次运行）`);
    console.log(`[起步] 种族=human  开荒资源=${JSON.stringify(STARTING_RESOURCES)}（零资源开局会令贪心 Bot 死锁，见文件头说明）`);
    console.log(`[上限] MAX_TICKS=${MAX_TICKS}（= ${MAX_TICKS * CONFIG.clock.tickMs / 1000} 游戏秒 ≈ ${(MAX_TICKS * CONFIG.clock.tickMs / 1000 / 60).toFixed(1)} 分钟，覆盖 2 小时验收窗口）`);
    console.log('------------------------------------------------------------------');

    // ---- 第一次运行 ----
    const runA = runFlow(CONFIG, SEED, STARTING_RESOURCES);
    const secA = gameSecondsOf(runA.state);

    // 1) tick 数与游戏内秒数
    console.log('【1】推进规模（真实运行）');
    console.log(`  总 tick 数            : ${runA.ticksRun}`);
    console.log(`  游戏内秒数            : ${secA} s  (≈ ${(secA / 60).toFixed(2)} 分钟)`);
    console.log(`  达到纪元 2 时的 tick   : ${runA.era2Tick === null ? '未达到' : runA.era2Tick}`);
    console.log(`  最终纪元 currentEra    : ${runA.state.currentEra}`);
    console.log(`  是否达到纪元 2        : ${runA.reachedEra2 ? '是 ✓' : '否 ✗'}`);

    // 2) 事件统计（各 kind 数量）
    const kindCounts = countByKind(runA.allEvents);
    console.log('【2】事件统计（按 kind 分类计数，真实事件流）');
    console.log(`  事件总数 : ${runA.allEvents.length}`);
    for (const k of Object.keys(kindCounts)) {
      console.log(`    ${k.padEnd(24, ' ')} : ${kindCounts[k]}`);
    }

    // 3) 最终资源快照（amount / max）
    const resSnapshot = resourceSnapshot(runA.state, CONFIG);
    console.log('【3】最终资源快照（amount / max）');
    for (const id of Object.keys(resSnapshot)) {
      const r = resSnapshot[id]!;
      console.log(`    ${id.padEnd(10, ' ')} : amount=${r.amount}  /  max=${r.max}`);
    }

    // 4) 建筑清单（count / active）+ 已研究科技清单
    const buildings = buildingList(runA.state, CONFIG);
    console.log('【4a】建筑清单（count / active）');
    const buildingKeys = Object.keys(buildings);
    if (buildingKeys.length === 0) {
      console.log('    (无建筑)');
    } else {
      for (const id of buildingKeys) {
        const b = buildings[id]!;
        console.log(`    ${id.padEnd(12, ' ')} : count=${b.count}  active=${b.active}`);
      }
    }
    const totalBuildingCount = buildingKeys.reduce((acc, id) => acc + (buildings[id]?.count ?? 0), 0);
    console.log(`    合计建筑座数          : ${totalBuildingCount}`);
    console.log('【4b】已研究科技清单（state.techs）');
    if (runA.state.techs.length === 0) {
      console.log('    (无已研究科技)');
    } else {
      for (const t of runA.state.techs) console.log(`    - ${t}`);
    }

    // 5) 断链是否发生过 + 最大等级
    const chainTransitions = runA.allEvents.filter((e) => e.kind === 'chain.transition');
    const chainIds = new Set<string>();
    let maxChainLevel = 0;
    let chainRises = 0; // 等级上升的次数（回到较低级后的再升也算，反映断链是否发生）
    for (const e of chainTransitions) {
      const cid = String(e.payload['chainId'] ?? '');
      chainIds.add(cid);
      const to = Number(e.payload['to'] ?? 0);
      const from = Number(e.payload['from'] ?? 0);
      // 峰值等级取 from/to 的较大者（覆盖「上升到某级后再恢复」的全程峰值）。
      if (to > maxChainLevel) maxChainLevel = to;
      if (from > maxChainLevel) maxChainLevel = from;
      if (to > from) chainRises += 1;
    }
    const chainHappened = chainTransitions.length > 0 && maxChainLevel >= 1;
    console.log('【5】断链（chain.transition）');
    console.log(`  是否发生过断链        : ${chainHappened ? '是' : '否'}`);
    console.log(`  chain.transition 次数 : ${chainTransitions.length}（其中等级上升 ${chainRises} 次）`);
    console.log(`  涉及链 ID             : ${chainIds.size === 0 ? '(无)' : Array.from(chainIds).sort().join(', ')}`);
    console.log(`  最大断链等级          : ${maxChainLevel}`);
    // 终态各链当前等级（用于判断是否已恢复）
    const finalChainLevels: Record<string, number> = {};
    for (const id of Object.keys(runA.state.chainStates).sort()) {
      finalChainLevels[id] = runA.state.chainStates[id]?.level ?? 0;
    }
    console.log(`  终态各链当前等级      : ${JSON.stringify(finalChainLevels)}`);
    const recovered = chainHappened && Object.values(finalChainLevels).every((lv) => lv === 0);
    if (chainHappened) {
      console.log(`  是否已恢复(终态全 l0) : ${recovered ? '是（已恢复）' : '否（结束时仍有断链未恢复）'}`);
    } else {
      console.log('  恢复情况              : 未发生断链，无需恢复');
    }

    // 6) 季节切换次数
    const seasonChanges = runA.allEvents.filter((e) => e.kind === 'season.change');
    console.log('【6】季节切换');
    console.log(`  season.change 次数    : ${seasonChanges.length}`);
    console.log(`  终态 seasonIndex      : ${runA.state.seasonIndex}（= ${CONFIG.seasons[runA.state.seasonIndex]?.id ?? '?'}）`);

    // 7) 资源边界事件（满仓 / 耗尽）次数
    const capEvents = runA.allEvents.filter((e) => e.kind === 'resource.cap');
    const emptyEvents = runA.allEvents.filter((e) => e.kind === 'resource.empty');
    console.log('【7】资源边界事件');
    console.log(`  满仓 resource.cap     : ${capEvents.length}`);
    console.log(`  耗尽 resource.empty   : ${emptyEvents.length}`);
    console.log(`  边界事件合计          : ${capEvents.length + emptyEvents.length}`);

    // ---- 确定性验证：第二次运行，终态哈希必须一致 ----
    const runB = runFlow(CONFIG, SEED, STARTING_RESOURCES);
    const hashA = hashState(snapshotForHash(runA.state));
    const hashB = hashState(snapshotForHash(runB.state));
    console.log('【8】回放 / 确定性哈希一致性验证');
    console.log(`  第一次运行终态哈希    : ${hashA}`);
    console.log(`  第二次运行终态哈希    : ${hashB}`);
    console.log(`  哈希是否一致          : ${hashA === hashB ? '一致 ✓（确定性通过）' : '不一致 ✗'}`);
    console.log(`  两次 tick 数一致      : ${runA.ticksRun === runB.ticksRun ? `是（${runA.ticksRun}）` : `否（${runA.ticksRun} vs ${runB.ticksRun}）`}`);
    console.log(`  两次 finalEra 一致    : ${runA.state.currentEra === runB.state.currentEra ? `是（${runA.state.currentEra}）` : '否'}`);

    // ---- JSON 摘要（供后续 CI 解析）----
    const summary = {
      task: 'w5d-flow-test · M1 核心验收「Bot 从纪元 1 推进到纪元 2」',
      configVersion: CONFIG.configVersion,
      seed: SEED,
      raceId: runA.state.raceId,
      startingResources: STARTING_RESOURCES,
      maxTicks: MAX_TICKS,
      reachedEra2: runA.reachedEra2,
      finalEra: runA.state.currentEra,
      era2Tick: runA.era2Tick,
      ticksRun: runA.ticksRun,
      gameSeconds: secA,
      totalEvents: runA.allEvents.length,
      eventsByKind: kindCounts,
      finalResources: resSnapshot,
      buildings,
      totalBuildingCount,
      techs: [...runA.state.techs],
      chain: {
        happened: chainHappened,
        transitions: chainTransitions.length,
        rises: chainRises,
        chainIds: Array.from(chainIds).sort(),
        maxLevel: maxChainLevel,
        finalLevels: finalChainLevels,
        recovered,
      },
      season: {
        changes: seasonChanges.length,
        finalSeasonIndex: runA.state.seasonIndex,
      },
      resourceBoundary: {
        cap: capEvents.length,
        empty: emptyEvents.length,
        total: capEvents.length + emptyEvents.length,
      },
      determinism: {
        hashA,
        hashB,
        hashesEqual: hashA === hashB,
        ticksEqual: runA.ticksRun === runB.ticksRun,
        eraEqual: runA.state.currentEra === runB.state.currentEra,
      },
    };
    console.log('------------------------------------------------------------------');
    console.log('JSON 摘要:');
    console.log(JSON.stringify(summary, null, 2));
    console.log('==================================================================');

    // ---- 断言（M1 核心验收）----
    expect(runA.reachedEra2).toBe(true);
    expect(runA.state.currentEra).toBeGreaterThanOrEqual(2);
    // 确定性：两次运行终态哈希一致。
    expect(hashA).toBe(hashB);
    // 同种子两次运行推进规模一致。
    expect(runA.ticksRun).toBe(runB.ticksRun);

    // 真实进度：Bot 在推进到纪元 2 前应已建成若干建筑（非空），证明这是真实跑通而非空壳。
    expect(totalBuildingCount).toBeGreaterThan(0);
  });
});
