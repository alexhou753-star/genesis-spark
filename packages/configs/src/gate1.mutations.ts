/**
 * Gate 1 变异测试：对合格配置逐项注入单个故障，断言“被预期的那条规则拦住”。
 * 用来证明校验脚本不是摆设。基线必须 0 错误 0 警告。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GameConfig } from './types.js';
import { M1_CONFIG } from './config.m1.js';
import { extractStringLiterals, scanEngineSource, validateConfig } from './gate1.js';

type Mut = (c: GameConfig) => void;
const clone = (): GameConfig => JSON.parse(JSON.stringify(M1_CONFIG)) as GameConfig;
const anyT = (m: { target: string }, t: string): void => { m.target = t; };

/** [名称, 期望规则编号, 注入故障, 可选：错误信息里必须出现的片段] */
const cases: Array<[string, string, Mut, string?]> = [
  ['资源 ID 重复', 'G1-01', (c) => { c.resources.push({ ...c.resources[0] }); }],
  ['ID 含大写', 'G1-01', (c) => { c.jobs[0].id = 'Farmer'; }],
  ['资源 ID 与引擎保留字重名（knowledge）', 'G1-01', (c) => { c.resources[4].id = 'knowledge'; }],
  ['工种与资源同名', 'G1-01', (c) => { c.jobs[0].id = 'food'; }],
  ['工种产出不存在的资源', 'G1-02', (c) => { c.jobs[0].producesPerSec = { ghost: 1 }; }],
  ['建筑岗位引用不存在的工种', 'G1-02', (c) => { c.buildings[0].jobSlots = { ghost: 2 }; }],
  ['科技依赖不存在的科技', 'G1-02', (c) => { c.techs[1].requires = ['nope']; }],
  ['纪元门槛引用不存在的建筑', 'G1-02', (c) => { c.eras[0].gate = [{ kind: 'building', buildingId: 'ghost', count: 1 }]; }],
  ['种族季节覆写引用不存在的季节', 'G1-02', (c) => { c.races[1].seasonOverrides = { monsoon: [] }; }],
  ['科技成环', 'G1-03', (c) => { c.techs[0].requires = ['masonry']; }],
  ['科技依赖自身', 'G1-03', (c) => { c.techs[0].requires = ['tool_making']; }],
  ['科技依赖更晚纪元', 'G1-03', (c) => { c.techs[0].requires = ['masonry']; c.techs[1].requires = []; }],
  ['修饰器目标引用不存在的资源（拼写错误）', 'G1-04', (c) => { anyT(c.races[1].modifiers[0], 'res.sunligth.rate'); }],
  ['修饰器目标语法错误', 'G1-04', (c) => { anyT(c.techs[0].modifiers[0], 'foo.bar.rate'); }],
  ['修饰器属性与对象不匹配', 'G1-04', (c) => { anyT(c.techs[0].modifiers[0], 'job.woodcutter.max'); }],
  ['add_pct 压到 0 以下', 'G1-04', (c) => { c.seasons[3].modifiers[0].value = -1.2; }],
  ['配置里出现每 tick 单位', 'G1-05', (c) => { (c.population as unknown as Record<string, number>).growthPerTick = 0.01; }],
  ['周期不是整数秒', 'G1-06', (c) => { c.clock.hazardIntervalSec = 0.3; }],
  ['tickMs 不能整除 1000', 'G1-06', (c) => { c.clock.tickMs = 300; }],
  ['季节预告不小于季长', 'G1-06', (c) => { c.clock.seasonForewarnSec = 900; }],
  ['断链阈值顺序错误', 'G1-07', (c) => { c.chain.l2Sec = 3; }],
  // v0.4：tutorialOverrides.chain 已从类型层移除（禁止引导注入断链阈值），此处改用 starveRatio 注入阈值顺序错误，保留原 66 项检查数。
  ['断链阈值顺序错误（starveRatio 不低于 recoverRatio）', 'G1-07', (c) => { c.chain.starveRatio = 0.9; }],
  ['纪元 index 不连续', 'G1-08', (c) => { c.eras[1].index = 5; }],
  ['仓储天花板低于倍率', 'G1-08', (c) => { c.eras[1].storageCeilingMultiplier = 1; }],
  ['引导缩放大于 1', 'G1-08', (c) => { c.tutorialOverrides.eraGateScale.era_1 = 1.5; }],
  ['纪元门槛资源在更晚纪元才解锁', 'G1-09', (c) => { c.eras[0].gate = [{ kind: 'resource', resId: 'stone', amount: 10 }]; }],
  ['纪元 1 建筑成本里用了纪元 2 才解锁的资源', 'G1-09', (c) => { c.buildings[0].baseCost = { stone: 5 }; }],
  ['孤儿资源（无任何产出源）', 'G1-10', (c) => { c.resources.push({ id: 'mana', kind: 'secondary', unlockEraIndex: 1, baseMax: 50 }); }],
  ['孤儿工种（无岗位建筑）', 'G1-10', (c) => { c.jobs.push({ id: 'hunter', unlockEraIndex: 1, producesPerSec: { food: 0.2 } }); }],
  ['岗位建筑晚于工种解锁纪元', 'G1-10', (c) => { c.jobs[4].unlockEraIndex = 1; c.resources[3].unlockEraIndex = 1; }],
  ['蠕变低于硬下限 1.015', 'G1-11', (c) => { c.buildings[0].creepBase = 1.01; }],
  ['蠕变等于 1（成本不递增）', 'G1-11', (c) => { c.buildings[2].creepBase = 1.0; }],
  ['首批建筑成本超过纪元起点上限', 'G1-12', (c) => { c.buildings[3].baseCost = { wood: 150 }; }],
  ['纪元门槛超过天花板', 'G1-12', (c) => { c.eras[0].gate = [{ kind: 'resource', resId: 'food', amount: 5000 }]; }],
  ['纪元没有首批建筑', 'G1-12', (c) => { c.buildings[6].isEraEntry = false; }],
  ['非首批建筑成本永远攒不够', 'G1-12', (c) => { c.buildings[7].baseCost = { wood: 99999 }; }],
  ['植物种族：门槛 food 映射成阳光后超过阳光上限（只应在植物视图报错）', 'G1-12', (c) => { c.resources[2].baseMax = 40; }, 'plantoid'],
  ['种族维生工种不存在', 'G1-02', (c) => { c.races[1].sustenance.jobId = 'ghost'; }],
  ['维生工种不产出维生资源', 'G1-13', (c) => { c.races[0].sustenance = { resId: 'food', jobId: 'woodcutter' }; }],
  ['种族废除了自己维生工种的岗位建筑', 'G1-13', (c) => { c.races[1].disabledBuildings = ['sun_garden', 'field']; }],
  ['resourceMap 链式替换', 'G1-13', (c) => { c.races[1].resourceMap = { food: 'sunlight', sunlight: 'wood' }; }],
  ['维生资源已被替换却仍声明原资源', 'G1-13', (c) => { c.races[1].sustenance = { resId: 'food', jobId: 'photosynth' }; }],
  ['种族废除不存在的建筑', 'G1-13', (c) => { c.races[0].disabledBuildings.push('ghost'); }],
  ['人类废除农田后食物无来源', 'G1-10', (c) => { c.races[0].disabledBuildings = ['sun_garden', 'field']; }],
  ['无种族时的中性维生声明错误', 'G1-13', (c) => { c.neutralSustenance = { resId: 'wood', jobId: 'farmer' }; }],
  ['类别蠕变目标引用不存在的建筑类别', 'G1-04', (c) => { anyT(c.techs[0].modifiers[0], 'cat.ghost.creep'); }],
  ['溢出转化比例不低于 1（价值不得高于直接产出）', 'G1-15', (c) => { c.overflowConversions[0].ratio = 1; }],
  ['溢出转化引用不存在的科技', 'G1-02', (c) => { c.overflowConversions[0].requiresTech = 'nope'; }],
  ['建材废料折扣超出 1%–3%', 'G1-15', (c) => { c.overflowConversions[1].nextBuildCostDiscount = 0.1; }],
  ['单条规则的行政算力超过基础容量', 'G1-15', (c) => { c.governor.adminPower.perRuleCost = 9; }],
  ['成本为负数', 'G1-15', (c) => { c.buildings[0].baseCost = { wood: -5 }; }],
  ['数值为 NaN', 'G1-15', (c) => { c.buildings[0].baseCost = { wood: NaN }; }],
  // ---- v0.4.1（批次三）新增检查项的注入用例：G1-21 / G1-22 / G1-23 / G1-24 / G1-20 ----
  ['自动化规则槽位 cap 非单调不减', 'G1-21', (c) => {
    c.automation = {
      governorRuleSlots: [{ cap: 3, unlock: { kind: 'era', eraIndex: 1 } }, { cap: 2, unlock: { kind: 'era', eraIndex: 2 } }],
      queueLengthCaps: [{ cap: 2, unlock: { kind: 'era', eraIndex: 1 } }],
    };
  }],
  ['自动化队列长度 cap 非单调不减', 'G1-21', (c) => {
    c.automation = {
      governorRuleSlots: [{ cap: 1, unlock: { kind: 'era', eraIndex: 1 } }],
      queueLengthCaps: [{ cap: 5, unlock: { kind: 'era', eraIndex: 1 } }, { cap: 4, unlock: { kind: 'era', eraIndex: 2 } }],
    };
  }],
  ['政体强正面不足 2 条', 'G1-22', (c) => {
    c.governments = [{
      id: 'mercantile', unlockEraIndex: 5, switchCooldownSec: 600, maxSwitchesPerRun: 3,
      strongPros: [{ target: 'res.food.rate', op: 'add_pct', value: 0.1 }],
      strongCons: [{ target: 'res.food.rate', op: 'add_pct', value: -0.05 }, { target: 'res.wood.rate', op: 'add_pct', value: -0.05 }],
    }];
  }],
  ['政体强负面不足 2 条', 'G1-22', (c) => {
    c.governments = [{
      id: 'warlike', unlockEraIndex: 5, switchCooldownSec: 600, maxSwitchesPerRun: 3,
      strongPros: [{ target: 'job.miner.rate', op: 'add_pct', value: 0.1 }, { target: 'res.food.rate', op: 'add_pct', value: 0.1 }],
      strongCons: [{ target: 'res.food.rate', op: 'add_pct', value: -0.05 }],
    }];
  }],
  ['催化剂蠕变削减击穿硬下限 1.015', 'G1-23', (c) => {
    c.catalystQualities = [{ catalystId: 'slime', quality: 'superb', creepReduction: 0.2 }];
  }],
  ['行政算力建筑来源引用不存在的建筑', 'G1-24', (c) => { c.governor.adminPower.perBuildingSource = { ghost_bldg: 1 }; }],
  ['行政算力科技来源引用不存在的科技', 'G1-24', (c) => { c.governor.adminPower.perTechSource = { ghost_tech: 1 }; }],
  ['种子 yieldOrderId 指向非订单物资源', 'G1-20', (c) => {
    c.resources.push({ id: 'wood_goods', kind: 'order', unlockEraIndex: 1, baseMax: 50 });
    c.seeds = [
      { id: 'sapling', element: 'wood', matureSec: 60, yieldOrderId: 'wood', yieldAmount: 1 },
      { id: 'rocklet', element: 'rock', matureSec: 60, yieldOrderId: 'wood_goods', yieldAmount: 1 },
    ];
  }],
  ['孤儿订单物（未被任何种子引用）', 'G1-20', (c) => {
    c.resources.push({ id: 'orphan_goods', kind: 'order', unlockEraIndex: 1, baseMax: 50 });
    c.resources.push({ id: 'fire_goods', kind: 'order', unlockEraIndex: 1, baseMax: 50 });
    c.seeds = [{ id: 'ember_seed', element: 'fire', matureSec: 60, yieldOrderId: 'fire_goods', yieldAmount: 1 }];
  }],
];

let failed = 0;
const row = (ok: boolean, name: string, detail: string): void => {
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}  ${detail}`);
};

// 基线
const base = validateConfig(clone());
row(base.errors.length === 0, '基线配置 0 错误', base.errors.join(' | '));
row(base.warnings.length === 0, '基线配置 0 警告', base.warnings.join(' | '));

// v0.3 新增的目标语法必须被接受
{
  const c = clone();
  const mk = (target: string): void => { c.techs[0].modifiers.push({ target: target as GameConfig['techs'][number]['modifiers'][number]['target'], op: 'add_pct', value: 0.1 }); };
  ['all.creep', 'pop.growth', 'cat.gather.creep', 'bldg.field.conv', 'bldg.granary.storage', 'bldg.field.upkeep', 'res.food.upkeep'].forEach(mk);
  const r = validateConfig(c);
  row(r.errors.length === 0, '目标语法 v2 的合法写法全部通过', r.errors.join(' | '));
}

// 变异
for (const [name, code, mut, mustInclude] of cases) {
  const c = clone();
  mut(c);
  const r = validateConfig(c);
  const hit = r.errors.some((e) => e.startsWith(`[${code}]`) && (mustInclude === undefined || e.includes(mustInclude)));
  row(hit, `${name}`, hit ? `被 ${code} 拦截（共 ${r.errors.length} 条）` : `期望 ${code}，实际: ${r.errors.slice(0, 2).join(' | ') || '无错误'}`);
}

// 警告：蠕变区间、仓储不高于采集
{
  const c = clone(); c.buildings[0].creepBase = 1.3;
  row(validateConfig(c).warnings.some((w) => w.startsWith('[G1-W1]')), '蠕变偏离附录 C 区间给出警告', '');
  const d = clone(); d.buildings[4].creepBase = 1.1; d.buildings[7].creepBase = 1.1;
  row(validateConfig(d).warnings.some((w) => w.startsWith('[G1-W2]')), '仓储蠕变不高于采集给出警告', '');
}

// 引擎源码扫描
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-scan-'));
  const w = (rel: string, body: string): void => {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  w('clean.ts', "// 注释里提到 food 与 farmer 不算\n/* 块注释里的 'wood' 也不算 */\nexport const KIND = 'population';\nexport const t = `res.${'x'}.rate`;\n");
  w('bad_literal.ts', "export const id = 'food';\n");
  w('bad_path.ts', "export const target = 'res.sunlight.rate';\n");
  w('bad_template.ts', 'export const f = (x: string) => `${x ? "farmer" : ""}`;\n');
  w('bad_race.ts', 'export const r = "plantoid";\n');
  w('sub/bad_nested.ts', "\nexport const s = 'stone';\n");
  w('ignored.test.ts', "export const id = 'food';\n");
  w('__fixtures__/ignored.ts', "export const id = 'food';\n");
  const found = scanEngineSource(tmp, M1_CONFIG);
  const has = (f: string): boolean => found.some((x) => x.includes(f));
  row(!has('clean.ts'), '引擎扫描：注释与保留字不误报', '');
  row(has('bad_literal.ts'), '引擎扫描：拦住 \'food\'', '');
  row(has('bad_path.ts'), '引擎扫描：拦住 res.sunlight.rate 这类路径字面量', '');
  row(has('bad_template.ts'), '引擎扫描：拦住插值里的 "farmer"', '');
  row(has('bad_race.ts'), '引擎扫描：拦住种族 ID', '');
  row(has('nested.ts'), '引擎扫描：递归子目录', '');
  row(!has('ignored.test.ts') && !has('__fixtures__'), '引擎扫描：跳过测试与夹具', '');
  row(found.length === 5, `引擎扫描：恰好 5 处命中（实际 ${found.length}）`, '');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 字符串字面量提取的行号
{
  const lits = extractStringLiterals("a\n'x'\n\n`y${'z'}`\n").filter((l) => l.value !== '');
  const ok = lits.map((l) => `${l.value}@${l.line}`).join(',') === 'x@2,y@4,z@4';
  row(ok, '字面量提取：值与行号正确（含模板插值）', JSON.stringify(lits));
}

const total = cases.length + 2 + 1 + 2 + 8 + 1;
console.log(failed === 0 ? `MUTATIONS PASS（${total} 项检查全部通过）` : `MUTATIONS FAIL（${failed} 项失败）`);
if (failed > 0) process.exit(1);
