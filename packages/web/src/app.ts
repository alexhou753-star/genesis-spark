/**
 * FR-29 基础版 · M1 收官验收对象
 * =============================================================================
 * 文件：app.ts —— 主线程入口：创建 Worker、注册 host 回调、处理暂停/恢复
 * 依据：任务约束 6（入口：创建 Worker、注册 host 回调、暂停/恢复）；架构 ADR-01（引擎在
 *       Worker、主线程只做界面）、架构 6.1（主线程与 Worker 只传命令/投影/信封）、
 *       架构 6.2（暂停时 tick 不走）。
 *
 * 职责：
 *   1. new Worker('./worker.js', { type: 'module' }) 起引擎 Worker；
 *   2. 把 worker.onmessage 收到的消息转交 host.handleFromWorker 更新 DOM；
 *   3. 给 host 注入 HostCommandSink：把 BUILD/RESEARCH/ADVANCE_ERA/ASSIGN_JOB 转成
 *      DISPATCH_CMD（附带单调 cmdSeq 供 Worker 幂等去重）发给 Worker；
 *   4. 绑定「暂停/恢复」按钮：发 SET_PAUSED，tick 停走。
 */

import { collectHostElements, createHost, type HostCommandSink } from './host.js';
import type { ToWorkerMsg, FromWorkerMsg, GameCommand } from './worker.js';

/**
 * bootstrapApp：装配整个主线程应用。返回销毁函数（终止 Worker）。
 *
 * @param doc 传入文档对象（便于测试；浏览器里即全局 document）。
 */
export function bootstrapApp(doc: Document): () => void {
  // 1) 收集 index.html 的容器。
  const els = collectHostElements(doc);

  // 2) 起引擎 Worker（模块 Worker；'./worker.js' 相对文档 URL 解析到同目录，index.html 与
  //    app.js/worker.js 同处 w6-web-staging/，故相对路径可用，且无需 import.meta）。
  const worker = new Worker('./worker.js', { type: 'module' });

  // 3) 命令出口：单调 cmdSeq + DISPATCH_CMD。
  let cmdSeq = 0;
  const sink: HostCommandSink = {
    send(cmd: GameCommand): void {
      cmdSeq += 1;
      const msg: ToWorkerMsg = { type: 'DISPATCH_CMD', cmdSeq, cmd };
      worker.postMessage(msg);
    },
  };

  // 4) 建立 host（渲染 + 四类命令按钮）。岗位列表为 M1 占位。
  const host = createHost(els, sink, { jobIds: ['farmer', 'woodcutter', 'scholar'] });

  // 5) Worker → 主线程：全部消息转交 host（VIEW_PROJECTION / PAUSED_CHANGED / ENVELOPE / COMMAND_ACK）。
  worker.onmessage = (ev: MessageEvent<FromWorkerMsg>): void => {
    host.handleFromWorker(ev.data);
  };

  // 6) 启动：发送 INIT（创建初始状态并开始 tick 循环）。
  const initMsg: ToWorkerMsg = { type: 'INIT', seed: 20261104 };
  worker.postMessage(initMsg);

  // 7) 暂停/恢复：SET_PAUSED 后 tick 不走（架构 6.2），按钮文案随状态切换。
  const pauseBtn = doc.getElementById('btn-pause');
  let paused = false;
  const applyPaused = (next: boolean): void => {
    paused = next;
    const msg: ToWorkerMsg = { type: 'SET_PAUSED', paused };
    worker.postMessage(msg);
    if (pauseBtn) pauseBtn.textContent = paused ? '恢复' : '暂停';
  };
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => applyPaused(!paused));
  }

  // 8) 返回销毁函数（页面卸载时调用）。
  return () => {
    worker.terminate();
  };
}

// 浏览器环境下自动启动（DOMContentLoaded 后）。非浏览器/静态自检环境下不触发。
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = (): void => {
    bootstrapApp(document);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
