/**
 * FR-29 基础版 · M1 收官验收对象
 * =============================================================================
 * 文件：host.ts —— 主线程 DOM 更新 + 命令回调
 * 依据：任务约束 3（主线程用原生 DOM API、零框架、requestAnimationFrame 节流）；
 *       架构 ADR-01（主线程只做界面）、架构 6.1（主线程接收 Worker 消息、维护 DOM）、
 *       架构 6.4（Worker 投影不高于 4 Hz，主线程按帧合并渲染）、FR-29（同屏信息架构）、
 *       NFR-16（预警不只靠颜色：图标 + 文字；键盘可达）。
 *
 * 设计要点：
 *   1. 只用原生 document.createElement / textContent / addEventListener，零第三方依赖。
 *   2. requestAnimationFrame 节流：多个投影在一帧内到达时只渲染一次（合并到下一帧）。
 *   3. 提供 BUILD / RESEARCH / ADVANCE_ERA / ASSIGN_JOB 四类命令按钮回调：
 *        - BUILD       ：建筑卡上的「建造 +1」（资源不足时禁用并标注原因）；
 *        - RESEARCH    ：科技区每条科技的「研究」（已研究则禁用）；
 *        - ADVANCE_ERA ：控制条上的「推进纪元」；
 *        - ASSIGN_JOB  ：内政岗位区的「+1 / −1」（需调用方传入 jobIds；M1 为占位）。
 *   4. 预警不只靠颜色：每个预警同时渲染「⚠ + 文字描述」，并设置 aria-label 供读屏。
 */

import type { ViewProjection, ResourceView } from './view.js';
import type { GameCommand, FromWorkerMsg } from './worker.js';

// ---------------------------------------------------------------------------
// 一、宿主接口契约
// ---------------------------------------------------------------------------

/** 命令出口：由 app.ts 注入（内部把命令 + 单调 cmdSeq 发给 Worker）。 */
export interface HostCommandSink {
  send(cmd: GameCommand): void;
}

/** 宿主需要操作的一组 DOM 容器（对应 index.html 的结构）。 */
export interface HostElements {
  /** 顶部资源条内部容器（<header> 的 .resource-strip）。 */
  resources: HTMLElement;
  /** 断链预警区（<section id="warnings">）。 */
  warnings: HTMLElement;
  /** 建筑卡列表容器（<main> 的 .building-list）。 */
  buildings: HTMLElement;
  /** 季节仪表（<aside>）。 */
  season: HTMLElement;
  /** 控制条（可选，<div id="controls">）：放「推进纪元」与岗位区。 */
  controls?: HTMLElement;
  /** 科技区（可选，放 RESEARCH 按钮）。 */
  techs?: HTMLElement;
  /** 状态/提示（可选，显示暂停、命令回执、信封同步）。 */
  status?: HTMLElement;
}

/** 宿主控制器：app.ts 通过它把 Worker 消息灌进界面。 */
export interface HostController {
  /** 应用一帧视图投影（rAF 节流后渲染）。 */
  applyProjection(view: ViewProjection, paused: boolean): void;
  /** 处理任意来自 Worker 的消息（内部按 type 分派）。 */
  handleFromWorker(msg: FromWorkerMsg): void;
  /** 读取最近一次节流的渲染是否已完成（自检用）。 */
  _isIdle(): boolean;
}

/** 宿主选项：可选注入岗位列表，用于渲染 ASSIGN_JOB 内政区。 */
export interface HostOptions {
  /** 岗位 ID 列表（M1 占位；正式工程由配置注入）。 */
  jobIds?: string[];
}

// ---------------------------------------------------------------------------
// 二、DOM 小工具（原生 API）
// ---------------------------------------------------------------------------

/** 创建元素并设置 class 与文本（textContent 防注入）。 */
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 清空容器所有子节点。 */
function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** 数字格式化：整数化到 1 位小数（有限数守卫）。 */
function fmtAmount(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return String(Math.round(n * 10) / 10);
}

/** 速率格式化：带正负号 + 一位小数 + /s。 */
function fmtRate(n: number): string {
  if (!Number.isFinite(n)) return '0/s';
  const r = Math.round(n * 100) / 100;
  const sign = r > 0 ? '+' : '';
  return `${sign}${r}/s`;
}

/** 秒数格式化： 返回占位；≤0 返回「即刻」；否则向上取整秒。 */
function fmtSeconds(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return '—';
  if (s <= 0) return '即刻';
  return `${Math.ceil(s)} 秒`;
}

/** 资源预警的「图标 + 文字」描述（FR-29：预警不只靠颜色）。 */
function resourceWarningText(w: ResourceView['warning']): string {
  switch (w) {
    case 'chain':
      return '⚠ 断链风险';
    case 'cap':
      return '⚠ 即将满仓';
    case 'empty':
      return '⚠ 即将见底';
    default:
      return '';
  }
}

/** 断链等级的中文描述（FR-06：一级红警、二级降效、三级停摆）。 */
function chainLevelText(level: 0 | 1 | 2 | 3): string {
  switch (level) {
    case 1:
      return '一级断链';
    case 2:
      return '二级断链（下游降效）';
    case 3:
      return '三级断链（整链停摆）';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// 三、宿主控制器实现
// ---------------------------------------------------------------------------

/**
 * createHost：绑定 DOM 容器与命令出口，返回控制器。
 *
 * 渲染采用「最新投影 + rAF 合并」策略：applyProjection 仅记录最新快照并预约一帧，
 * 同一帧内的多次投影只触发一次 paint（对应架构 6.4 主线程按帧刷新）。
 */
export function createHost(
  els: HostElements,
  sink: HostCommandSink,
  options: HostOptions = {},
): HostController {
  let latest: ViewProjection | null = null;
  let paused = false;
  let scheduled = false;
  let idle = true;

  // ── rAF 节流：预约一次渲染 ──
  function schedulePaint(): void {
    if (scheduled) return;
    scheduled = true;
    idle = false;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback): number => setTimeout(() => cb(0), 16) as unknown as number;
    raf(() => {
      scheduled = false;
      try {
        paint();
      } finally {
        idle = true;
      }
    });
  }

  // ── 整帧渲染：资源条 / 预警 / 建筑卡 / 季节仪表 / 科技 / 控制条 ──
  function paint(): void {
    if (!latest) return;
    renderResources(latest);
    renderWarnings(latest);
    renderBuildings(latest);
    renderSeason(latest);
    renderTechs(latest);
    renderControls(latest);
    updateStatusPaused();
  }

  // 1) 顶部资源条：每项显示 当前/上限、净变化、距满或距空；>4 资源由 CSS 横向滚动。
  function renderResources(view: ViewProjection): void {
    const strip = els.resources;
    clear(strip);
    for (const r of view.resources) {
      const chip = make('div', 'resource-chip');
      if (r.warning) {
        chip.classList.add('is-warning', `warn-${r.warning}`);
        chip.setAttribute('role', 'alert');
      }
      const head = make('div', 'resource-head');
      head.appendChild(make('span', 'resource-name', r.name));
      head.appendChild(make('span', 'resource-amount', `${fmtAmount(r.amount)}/${fmtAmount(r.max)}`));
      chip.appendChild(head);

      const meta = make('div', 'resource-meta', fmtRate(r.netPerSec));
      chip.appendChild(meta);

      // 距满仓 / 距见底（只在有意义时显示）
      if (r.timeToFull !== null) {
        chip.appendChild(make('div', 'resource-eta', `距满 ${fmtSeconds(r.timeToFull)}`));
      } else if (r.timeToEmpty !== null) {
        chip.appendChild(make('div', 'resource-eta', `距空 ${fmtSeconds(r.timeToEmpty)}`));
      }

      // 预警文字（不只靠颜色）
      if (r.warning) {
        chip.appendChild(make('div', 'resource-warn', resourceWarningText(r.warning)));
      }
      chip.setAttribute(
        'aria-label',
        `${r.name} 当前 ${fmtAmount(r.amount)}，上限 ${fmtAmount(r.max)}，净变化 ${fmtRate(r.netPerSec)}` +
          (r.warning ? `，${resourceWarningText(r.warning)}` : ''),
      );
      strip.appendChild(chip);
    }
  }

  // 2) 断链预警区（非模态、就地显示）：汇总资源与建筑的链路预警。
  function renderWarnings(view: ViewProjection): void {
    const box = els.warnings;
    clear(box);
    const items: string[] = [];
    for (const r of view.resources) {
      if (r.warning === 'chain') {
        items.push(`${r.name}：⚠ 断链风险（${fmtSeconds(r.timeToEmpty)}后见底）`);
      }
    }
    for (const b of view.buildings) {
      if (b.chainStatus && b.chainStatus >= 1) {
        items.push(`${b.name}：⚠ ${chainLevelText(b.chainStatus)}`);
      }
    }
    const title = make('h2', 'warnings-title', items.length > 0 ? `⚠ 预警（${items.length}）` : '预警');
    box.appendChild(title);
    if (items.length === 0) {
      box.appendChild(make('p', 'warnings-empty', '当前无断链或边界预警。'));
      box.classList.remove('has-warning');
      return;
    }
    box.classList.add('has-warning');
    const ul = make('ul', 'warnings-list');
    for (const text of items) {
      ul.appendChild(make('li', 'warning-item', text));
    }
    box.appendChild(ul);
  }

  // 3) 建筑卡列表：名称 / 数量 / 成本 / 下一座成本 / 蠕变 / 建造按钮 / 链路状态。
  function renderBuildings(view: ViewProjection): void {
    const list = els.buildings;
    clear(list);
    for (const b of view.buildings) {
      const card = make('article', 'building-card');
      if (b.chainStatus && b.chainStatus >= 1) {
        card.classList.add('is-warning');
        card.setAttribute('role', 'alert');
      }

      const head = make('div', 'building-head');
      head.appendChild(make('span', 'building-name', b.name));
      head.appendChild(make('span', 'building-count', `×${b.count}`));
      card.appendChild(head);

      const stats = make('div', 'building-stats');
      stats.appendChild(make('span', 'stat', `当前成本 ${b.nextCost}`));
      stats.appendChild(make('span', 'stat', `蠕变 ×${(Math.round(b.creepBase * 1000) / 1000)}`));
      card.appendChild(stats);

      if (b.chainStatus && b.chainStatus >= 1) {
        card.appendChild(make('div', 'building-warn', `⚠ ${chainLevelText(b.chainStatus)}`));
      }

      const actions = make('div', 'building-actions');
      const buildBtn = make('button', 'btn btn-build', b.canAfford ? '建造 +1' : '资源不足');
      buildBtn.type = 'button';
      buildBtn.disabled = !b.canAfford;
      buildBtn.setAttribute('aria-label', `建造 ${b.name}，成本 ${b.nextCost}`);
      buildBtn.dataset['action'] = 'BUILD';
      buildBtn.dataset['buildingId'] = b.id;
      buildBtn.addEventListener('click', () => {
        sink.send({ type: 'BUILD', buildingId: b.id });
      });
      actions.appendChild(buildBtn);
      card.appendChild(actions);

      list.appendChild(card);
    }
  }

  // 4) 季节仪表（固定右上角）：当前季节 + 剩余时间 + 下一季节（前 60 秒预告）。
  function renderSeason(view: ViewProjection): void {
    const box = els.season;
    clear(box);
    box.appendChild(make('div', 'season-label', '季节'));
    box.appendChild(make('div', 'season-name', view.season.name || '—'));
    box.appendChild(make('div', 'season-remaining', `剩余 ${fmtSeconds(view.season.secondsRemaining)}`));
    // 切换前 60 秒预告（FR-10）。
    if (view.season.secondsRemaining <= 60 && view.season.nextSeason) {
      const fore = make('div', 'season-forewarn', `⚠ 即将转入：${view.season.nextSeason}`);
      box.appendChild(fore);
    }
    box.setAttribute(
      'aria-label',
      `当前季节 ${view.season.name}，剩余 ${fmtSeconds(view.season.secondsRemaining)}，下一季 ${view.season.nextSeason}`,
    );
  }

  // 5) 科技区（可选）：每条科技一个 RESEARCH 按钮。
  function renderTechs(view: ViewProjection): void {
    if (!els.techs) return;
    const box = els.techs;
    clear(box);
    if (view.techs.length === 0) {
      box.appendChild(make('p', 'techs-empty', '暂无科技。'));
      return;
    }
    for (const t of view.techs) {
      const row = make('div', 'tech-row');
      row.appendChild(make('span', 'tech-name', t.name));
      const btn = make('button', 'btn btn-research', t.researched ? '已研究' : '研究');
      btn.type = 'button';
      btn.disabled = t.researched;
      btn.setAttribute('aria-label', `${t.researched ? '已研究' : '研究'} ${t.name}`);
      btn.addEventListener('click', () => sink.send({ type: 'RESEARCH', techId: t.id }));
      row.appendChild(btn);
      box.appendChild(row);
    }
  }

  // 6) 控制条（可选）：推进纪元 + 内政岗位（ASSIGN_JOB）。
  function renderControls(view: ViewProjection): void {
    if (!els.controls) return;
    const box = els.controls;
    clear(box);

    // 推进纪元（ADVANCE_ERA）
    const eraRow = make('div', 'control-row');
    eraRow.appendChild(make('span', 'era-name', `${view.era.name}（纪元 ${view.era.index}）`));
    const advanceBtn = make('button', 'btn btn-advance', '推进纪元 ▶');
    advanceBtn.type = 'button';
    advanceBtn.setAttribute('aria-label', '推进到下一纪元');
    advanceBtn.addEventListener('click', () => sink.send({ type: 'ADVANCE_ERA' }));
    eraRow.appendChild(advanceBtn);
    box.appendChild(eraRow);

    // 内政岗位（ASSIGN_JOB）：仅在调用方提供 jobIds 时渲染。
    const jobIds = options.jobIds ?? [];
    if (jobIds.length > 0) {
      const jobRow = make('div', 'control-row jobs-row');
      jobRow.appendChild(make('span', 'jobs-label', '岗位'));
      for (const jobId of jobIds) {
        const wrap = make('span', 'job-control');
        wrap.appendChild(make('span', 'job-name', jobId));
        const minus = make('button', 'btn btn-job', '−');
        minus.type = 'button';
        minus.setAttribute('aria-label', `减少 ${jobId} 岗位`);
        minus.addEventListener('click', () => sink.send({ type: 'ASSIGN_JOB', jobId, delta: -1 }));
        const plus = make('button', 'btn btn-job', '+');
        plus.type = 'button';
        plus.setAttribute('aria-label', `增加 ${jobId} 岗位`);
        plus.addEventListener('click', () => sink.send({ type: 'ASSIGN_JOB', jobId, delta: 1 }));
        wrap.appendChild(minus);
        wrap.appendChild(plus);
        jobRow.appendChild(wrap);
      }
      box.appendChild(jobRow);
    }
  }

  // 7) 暂停态提示（状态区）。
  function updateStatusPaused(): void {
    if (!els.status) return;
    const text = paused ? '⏸ 已暂停（tick 不走）' : '▶ 运行中';
    els.status.setAttribute('data-paused', paused ? 'true' : 'false');
    // 在 status 里维护一个固定的暂停指示节点，避免覆盖其它提示。
    let ind = els.status.querySelector('.status-paused') as HTMLElement | null;
    if (!ind) {
      ind = make('span', 'status-paused');
      els.status.appendChild(ind);
    }
    ind.textContent = text;
  }

  // ── 对外控制器 ──
  return {
    applyProjection(view: ViewProjection, isPaused: boolean): void {
      latest = view;
      paused = isPaused;
      schedulePaint();
    },
    handleFromWorker(msg: FromWorkerMsg): void {
      switch (msg.type) {
        case 'VIEW_PROJECTION':
          host_applyProjection(msg.viewModel, msg.paused);
          break;
        case 'PAUSED_CHANGED':
          paused = msg.paused;
          updateStatusPaused();
          break;
        case 'COMMAND_ACK':
          if (els.status && !msg.ok) {
            els.status.appendChild(make('span', 'status-ack', `命令被拒：${msg.reason ?? '未知原因'}`));
          }
          break;
        case 'ENVELOPE':
          if (els.status) {
            let env = els.status.querySelector('.status-envelope') as HTMLElement | null;
            if (!env) {
              env = make('span', 'status-envelope');
              els.status.appendChild(env);
            }
            env.textContent = `进度已同步 · tick ${msg.tick}`;
          }
          break;
        default: {
          const _exhaustive: never = msg;
          void _exhaustive;
          break;
        }
      }
    },
    _isIdle(): boolean {
      return idle;
    },
  };

  // 命名别名：便于 handleFromWorker 内调用（避免 this 绑定问题）。
  function host_applyProjection(view: ViewProjection, isPaused: boolean): void {
    latest = view;
    paused = isPaused;
    schedulePaint();
  }
}

// ---------------------------------------------------------------------------
// 四、便捷：从 document 按 id 收集宿主容器
// ---------------------------------------------------------------------------

/** collectHostElements：按固定 id 收集 index.html 的容器（缺省返回 undefined 的可选项）。 */
export function collectHostElements(doc: Document): HostElements {
  const required = (id: string): HTMLElement => {
    const node = doc.getElementById(id);
    if (!node) throw new Error(`host: 缺少必需容器 #${id}`);
    return node;
  };
  const optional = (id: string): HTMLElement | undefined => doc.getElementById(id) ?? undefined;
  const els: HostElements = {
    resources: required('resource-strip'),
    warnings: required('warnings'),
    buildings: required('building-list'),
    season: required('season-gauge'),
  };
  const controls = optional('controls');
  if (controls) els.controls = controls;
  const techs = optional('techs');
  if (techs) els.techs = techs;
  const status = optional('status');
  if (status) els.status = status;
  return els;
}
