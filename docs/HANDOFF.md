# 创世火种 · 新对话框施工交接指令

> 用途：新开对话框后，把本文件内容作为第一条消息发给 AI，即可无缝接续施工。
> 生成时间：2026-11-06

---

## 一、你是谁、用户要什么

你是《创世火种》（genesis-spark）项目的**总指挥/架构师**。用户是技术新手，偏好你**直接代为操作**（SSH/命令/部署），不要给命令让他自己敲。

**用户的核心诉求（已多次确认，务必牢记）**：
1. 游戏体验要对标 **Evolve（进化）**——《进化》是放置增量游戏，核心是**多层重置 + 组合内容 + 指数节奏**，玩法硬核、决策密度高。
2. 目标不是「首发塞满 2000 小时内容」，而是**玩家能持续玩 2000+ 小时仍不觉得腻**——即「每 X 小时必然面对一个新的决策空间」，策略不能过早被解穿。
3. **硬核深度优先于外围低门槛**；移动端只优化信息与操作，**不降低任何机制**；不做弹窗教程、不做脚本强制灾难；自动化是后期管理能力、不是前期免死保护。
4. 禁止：欺骗用户、迎合用户说违心话、泄露隐私。

**工作方式要求**：用户明确说「你只需要指挥，实际工作由子代理做」。所以：
- 你负责：规划、拆分施工单、验收、提交推送、汇报
- 子代理负责：写代码/文档
- **你必须亲自做验收**（真实终端运行），不能只信子代理自述——历史多次抓到子代理"静态自检通过但实际有 bug"

---

## 二、当前真实状态（务必先核实，不要盲信本文）

### 2.1 代码仓库
- 路径：**Termux home**：`~/genesis`（`/data/data/com.termux/files/home/genesis`）
- 远端：`github.com:alexhou753-star/genesis-spark`（main 分支，SSH 走 443 端口，已配置好）
- 最新 commit：`d4fd589 docs: 同步模块开发地图修正 + 长期可玩性设计约束`
- 工作区干净（0 未提交）

### 2.2 技术栈与环境坑（已踩过的，别重复踩）
- Node 24 + npm workspaces（**pnpm 在 Android 上崩溃，严禁使用**）
- TypeScript 5.9.3，ESM（nodenext），composite project references
- 编译产物在 `packages/*/out/src/`
- **`.bin/` 软链 shebang 在 Termux 失效** → 一律用 `node node_modules/<pkg>/入口` 直调
- **Android 共享存储不能装 node_modules** → 代码在 Lyra 工作区，node_modules 在 Termux home
- 验证命令：`cd ~/genesis && npm run verify`（= typecheck + Gate 1 + Gate 1 变异测试）
- 测试：`node node_modules/vitest/vitest.mjs run`
- 子代理只能写 Lyra 工作区，**不能写 Termux home** → 流程是：子代理在 `*-staging/` 产出 → 你 `cp` 到 `~/genesis` → 真实验证 → 提交推送

### 2.3 已完成模块（全部真实跑绿）
| 批次 | 内容 | commit |
|---|---|---|
| W1 | 数学原语（mulberry32/secToTicks/fastPowInt/deterministicLn1p）| 15ad796 |
| W2 | advance 事件跳段（连续时间锚定，修复过 500ms 漂移）| 7641969 |
| W3 | dispatch 命令层（幂等去重 + WAL 恢复重放）| 6d16ca6 |
| W4 | 规范状态哈希（FNV-1a 64 双32位）+ 存档层（信封/双槽/WAL/崩溃/迁移/恢复）| 0264135, ac1d292 |
| W5a/b | sim-cli 仿真闭环 + 六条长期可玩性约束可证伪验证 | a398048, d7d8b23 |
| W5c | 经济结算层（修饰器/资源/成本/断链/纪元门槛）| 4a78761 |
| W5d | 游戏循环集成 + M1 流程实测（Bot 纪元1→2：205 tick/51秒，哈希逐位一致）| 5cb33c3 |
| FR-29 | Web 界面基础版（Worker 宿主 + 资源条/建筑卡/预警/季节）| abf79e5 |
| M2 FR-20 | 离线结算（24h 偏差 ≤1%，实测 maxDev=0%）| 497372c |
| M2 FR-15 | 生态试验田（邻接变异，D3 合规）| 7d0ba87 |
| M2 FR-16 | 催化剂与插槽（蠕变削减 + 1.015 硬下限）| 07634c9 |

**当前验证基线：237 项测试全绿 + Gate 1 PASS（75 项变异）**

### 2.4 未完成的工作（**这是你要接手的重点**）

#### 【最高优先级】M2 FR-18/19/48：内政总管 + 排程队列 + 渐进解锁
- **状态：施工到一半，被上下文上限中断，代码在 Lyra 工作区 `m2-automation-work/`，未合入仓库**
- 已有文件：`m2-automation-work/packages/engine/src/automation.ts`（约 700 行）+ 已改的 `economy.ts` / `gameLoop.ts` + `test/automation.test.ts`（约 532 行）
- **已发现的真实缺陷（接手必须修）**：
  1. **生产不读 jobAssignments**：`economy.ts` 的 `deriveJobWorkers` 仍按 `Σ(active × jobSlots)` 自动填满，导致 ASSIGN_JOB 只改记录不改产出 → FR-18 整条失效
  2. **人口无守恒**：ASSIGN_JOB 只按岗位容量钳制，不校验 `population` → 1 个人可占 2 个岗位
  3. **clone 丢新字段**：`cloneGameState` / `withEconomy` / `cloneEconomyState` / `offline.hashState` 全是逐字段枚举，新增 automation 字段会被静默清空
  4. **行政算力未接入**：`planGovernor` / `planQueueCommand` / 安装校验都没调用 `computeAdminUsage` / `isAdminOverloaded` → 算力约束无效
  5. **`QueueItem.maxAcceptableCost` 类型错误**：当前是 `number`（把所有资源成本相加），正式契约 `engine/types.ts` 是 `Record<ResId, GameNum>`（逐资源，不同单位不能加总）
  6. **drafted 归还错源**：`drafted` 只记 `ruleId->number`，释放会归还到错误工种，还可能盗用手动新派的工人
  7. **TS 编译报错**：`automation.ts:264` 缺 `neutralSustenance` 类型；`economy.ts:49` `AdminPowerConfig` 未使用
- **施工原则**：修上述 7 项 + 补测试（0槽/tech/reset 解锁、安装与执行双校验、人口守恒、多规则共享 15s 工种冷却、真实队列扣费/研究/回跳、在线 gameTick vs offline 短程同终态）
- **不要**：新增 UI、改 offline/正式 types、改旧 test 来掩盖实际分配 bug

#### 之后依次
- M2 剩余：FR-21 中性视图、FR-28 前30分钟引导、FR-31/32 存档导入导出+完整性
- M3：纪元 5–7、污染/电网/支撑力、政体、失败梯度、灰烬/播种协议、邻国博弈
- M4：8种族、商队订单、星级、宇宙、外观、软启动

---

## 三、关键设计约束（不能违反）

1. **D3 原则**：右轨（试验田/订单）只产催化剂与订单物，**绝不产基础资源**
2. **硬下限 1.015**：任何蠕变削减叠加后不得低于此值
3. **断链三级**：l1确认→l2→l3，恢复需预热；断链等级影响下游产出
4. **无弹窗、无脚本强制灾难**：正常周目不做假危机；保底变异只在可选教学沙盒
5. **自动化渐进解锁**：前期不给满 10 队列与全部规则；行政算力是后期稀缺约束
6. **政体**：纪元 1–4 无政府起步，纪元 5 选择；仅冷却无产出惩罚；每政体 2+2 强正负
7. **重置层配置驱动**：`ResetLayerId` 已在类型层泛化，不要再写死 `ash|seed`
8. **确定性**：同一输入必须逐位相同；不读时钟/随机；hash 用 FNV-1a 64（双32位，不用 BigInt）

---

## 四、施工流程（每次都要走）

```
1. 【规划】你拆分任务 → 写详细施工单（含背景约束、验收标准、文件路径）
2. 【派工】run_sub_agents 派给子代理（写 Lyra 工作区 *-staging/）
3. 【验收】你 cp 到 ~/genesis → npm run verify + vitest 真实跑
4. 【对抗测试】对关键模块，你自己写独立验证脚本（不复用子代理测试）打边界
5. 【修复】发现问题 → 打回子代理修 / 或你直接修小问题
6. 【提交】全绿后 git commit + push，commit message 写清验证结果
7. 【汇报】给用户简洁的验收数据（真实数字，不吹）
```

**重要经验**：
- 子代理测试 import 路径常写错（写 `./xxx.js` 但实际在 `test/` 目录）→ 统一要求写 `../src/xxx.js`
- 子代理会覆盖之前修好的 ESM 入口（`require.main`）→ 每次拷入后检查 `gate1.ts` 入口判断
- 子代理的"静态自检通过"不能当验收依据 → 必须真实跑
- vitest 默认 5s timeout，长测试要加 `{ timeout: 30000 }`

---

## 五、当前文档位置

| 文档 | Lyra 工作区 | 仓库 docs |
|---|---|---|
| PRD v3.1 | `reviewed-vNext/创世火种 产品需求文档 PRD v3.1（协同评审修订版）.md` | `docs/PRD.md` |
| 技术架构 v2.1 | `reviewed-vNext/创世火种 技术架构设计文档 v2.1（PRD修订3协同版）.md` | `docs/ARCHITECTURE.md` |
| GDD v0.26 | `reviewed-vNext/创世火种 · GDD 草案 v0.2（协同修订待评审）.md` | `docs/GDD.md` |
| M1 开工包 v1.1 | `reviewed-vNext/创世火种 · M1 开工包 v1.1（协同修订版）.md` | `docs/M1-KICKOFF.md` |
| 模块开发地图 v1.1 | `reviewed-vNext/创世火种 · 模块开发地图 v1.1（协同修订版）.md` | `docs/MODULE-MAP.md` |
| 长期可玩性设计约束 v0.1 | `reviewed-vNext/创世火种 · 长期可玩性设计约束 v0.1.md` | `docs/LONGEVITY-CONSTRAINTS.md` |

> 注意：Lyra 工作区里的文档是最新修订版；仓库 docs 已同步（d4fd589）。若发现不一致，以工作区 reviewed-vNext 为准。

---

## 六、第一条消息建议模板

```
继续《创世火种》M2 施工。

先做三件事：
1. 读这个文件：~/genesis 仓库最新 commit 应为 d4fd589；跑 npm run verify 确认 237 项测试全绿
2. 读 Lyra 工作区 m2-automation-work/packages/engine/src/automation.ts 与改过的 economy.ts/gameLoop.ts，了解 FR-18/19/48 断点
3. 按"7 项真实缺陷"清单制定修复施工单，派子代理修复

要求：你只指挥，实际代码由子代理写；你必须真实跑测试验收，不能只信子代理自述。
大方向不变：Evolve 式硬核体验 + 2000 小时不腻（决策新鲜度）。
```

---

## 七、给用户的提醒

- 新对话框开头发：本文件全文（或路径）+ 上面模板
- 如果 AI 说"找不到 ~/genesis"，让它先确认 Termux 在后台运行
- 每完成一个批次，让 AI 给出：commit hash + 测试数 + Gate 1 结果 + 关键验收数据
