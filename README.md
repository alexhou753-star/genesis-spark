# 创世火种 · genesis-spark

Evolve 式硬核体验的移动端放置游戏。类型 v0.4.1（草案，待架构师评审后冻结）。

## 包结构（npm workspaces）

- `packages/configs` — 配置类型（依赖图根）、M1 占位配置、Gate 1 校验与变异测试
- `packages/engine` — 状态、命令、事件类型
- `packages/save` — 存档信封、槽位、哈希输入类型
- `packages/sim-cli` — 批量仿真命令行（M1 W3）
- `packages/web` — Worker 宿主与界面（M1 W4）

## 环境（Termux / Android aarch64 实测）

- Node 24 + npm workspaces（pnpm 在 Android 上崩溃，勿用）
- TypeScript 5.9.3，ESM（nodenext），composite project references
- 编译产物在 `packages/*/out/src/`（gate1.js 经 `npm run gate1` 直跑）
- shell 脚本一律 `node <入口>` 直调（.bin 软链 shebang 在 Termux 失效）

## 验证

```
npm install
npm run verify   # typecheck + Gate 1 + 75 项变异测试
```

Gate 1 引擎源码扫描：`npm run gate1 -- packages/engine/src`

## 文档

PRD / 架构 / GDD / M1 开工包 / 模块开发地图见 docs/（开发节奏以 M1 开工包为准）。
