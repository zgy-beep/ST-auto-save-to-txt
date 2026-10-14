/**
 * 语义版本比较（compareVersion）回归测试
 * 运行方式: node test/test-version-compare.js
 *
 * 背景：v1.12.0 及以前使用字符串比较（'1.12.0' < '1.7.8' === true）做版本门控，
 * 导致两个核心问题：
 *   ① ensureGreetingSerialized 的服务端版本门控误判——1.10+ 服务端被当成"低于 1.7.8"，问候语延迟入书完全失效；
 *   ② getSettings 的 chapter_style 迁移门控误判——1.6.0+ 老用户的 'numbered' 被强制改回 'numbered_floor'。
 * 本测试直接从 index.js 抽取真实函数源码执行（非手抄副本），并锁定源码中不再存在裸字符串版本比较。
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const src = fs.readFileSync(INDEX_PATH, 'utf8');

// 从 index.js 抽取真实的 compareVersion 定义并实例化，确保测试锁定线上实现
const match = src.match(/function compareVersion\(a, b\) \{[\s\S]*?\n\}/);
if (!match) {
    console.error('[FAIL] 未在 index.js 中找到 compareVersion 定义（P0 修复是否被回退？）');
    process.exit(1);
}
const compareVersion = new Function(`${match[0]}; return compareVersion;`)();

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
    if (actual === expected) {
        pass++;
        console.log(`[PASS] ${name}: ${actual}`);
    } else {
        fail++;
        console.error(`[FAIL] ${name}: 期望 ${expected}，实际 ${actual}`);
    }
}

console.log('=== compareVersion 基础用例 ===');
check('1.12.0 vs 1.7.8（P0 陷阱：字符串比较会误判为 true）', compareVersion('1.12.0', '1.7.8'), 1);
check('1.10.0 vs 1.7.8', compareVersion('1.10.0', '1.7.8'), 1);
check('1.9.0 vs 1.10.0（跨十位）', compareVersion('1.9.0', '1.10.0'), -1);
check('1.5.9 vs 1.6.0', compareVersion('1.5.9', '1.6.0'), -1);
check('1.6.0 vs 1.6.0（相等）', compareVersion('1.6.0', '1.6.0'), 0);
check('1.12 vs 1.12.0（段数不齐）', compareVersion('1.12', '1.12.0'), 0);
check('2.0.0 vs 1.99.99（主版本优先）', compareVersion('2.0.0', '1.99.99'), 1);
check('null 视为 0.0.0', compareVersion(null, '1.0.0'), -1);
check('undefined 视为 0.0.0', compareVersion(undefined, '0.0.1'), -1);
check('空串 vs 空串', compareVersion('', ''), 0);
check('预发布后缀不破坏解析：1.12.0-beta vs 1.7.8', compareVersion('1.12.0-beta', '1.7.8'), 1);
check('非数字段兜底为 0：1.x.0 vs 1.5.0（x→0，故 1.0.0 < 1.5.0）', compareVersion('1.x.0', '1.5.0'), -1);

console.log('\n=== 门控行为回归（对应两个 P0 故障点）===');
// ① 问候语补写门控：服务端 >= 1.7.8 时绝不能被拦截
check("服务端 1.12.0 不再拦截问候语补写（<1.7.8 为 false）", compareVersion('1.12.0', '1.7.8') < 0, false);
check("服务端 1.10.0 不再拦截问候语补写", compareVersion('1.10.0', '1.7.8') < 0, false);
check("服务端 1.7.8 边界放行", compareVersion('1.7.8', '1.7.8') < 0, false);
check("服务端 1.7.5 仍正确拦截（正向对照）", compareVersion('1.7.5', '1.7.8') < 0, true);
// ② chapter_style 迁移门控：>= 1.6.0 不得触发强制迁移
check("1.12.0 不触发 numbered→numbered_floor 迁移", compareVersion('1.12.0', '1.6.0') < 0, false);
check("1.10.0 不触发迁移", compareVersion('1.10.0', '1.6.0') < 0, false);
check("1.5.0 仍正确触发迁移（正向对照）", compareVersion('1.5.0', '1.6.0') < 0, true);

console.log('\n=== 源码守卫：禁止裸字符串版本比较回流 ===');
const rawCompare1 = /serverPluginVersion\s*&&\s*serverPluginVersion\s*</.test(src);
const rawCompare2 = /curVer\s*<\s*'1\.6\.0'/.test(src);
check('index.js 中不存在 serverPluginVersion 裸字符串比较', rawCompare1, false);
check("index.js 中不存在 curVer < '1.6.0' 裸字符串比较", rawCompare2, false);

console.log(`\n版本比较测试结果: 通过: ${pass}, 失败: ${fail}`);
if (fail > 0) process.exit(1);
console.log('所有语义版本比较回归测试全部通过！');
