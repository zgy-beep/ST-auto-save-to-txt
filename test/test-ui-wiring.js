/**
 * UI 接线与递归守卫回归测试
 * 运行方式: node test/test-ui-wiring.js
 *
 * 背景：v1.12.1 曾因全局替换把 refreshNovelToolbars() 内部的调用替换成自身，
 * 造成无限递归（每次保存/切聊天都栈溢出，UI 刷新全线失效）。
 * 本测试从 index.js 抽取真实源码做结构断言 + 对 analyzeRemovedContent 做行为断言，
 * 防止同类事故复发。
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, '..', 'index.js');
const src = fs.readFileSync(INDEX_PATH, 'utf8');

let pass = 0;
let fail = 0;
function check(name, actual, expected) {
    if (actual === expected) {
        pass++;
        console.log(`[PASS] ${name}`);
    } else {
        fail++;
        console.error(`[FAIL] ${name}: 期望 ${expected}，实际 ${actual}`);
    }
}

function extractFn(name) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    return m ? m[0] : null;
}

console.log('=== ① 递归守卫（v1.12.1 事故回归）===');
const refreshFn = extractFn('refreshNovelToolbars');
check('refreshNovelToolbars 定义存在', !!refreshFn, true);
// 只检查函数体（跳过声明行），声明自身的名字不算自调用
const refreshBody = refreshFn ? refreshFn.slice(refreshFn.indexOf('{')) : '';
check('函数体内不含自身调用（防无限递归）', /refreshNovelToolbars\s*\(/.test(refreshBody), false);
check('函数体调用 refreshLatestToolbar', /refreshLatestToolbar\s*\(/.test(refreshFn || ''), true);
check('函数体调用 refreshFloatingWindow', /refreshFloatingWindow\s*\(/.test(refreshFn || ''), true);
check('函数体调用 syncWandEntryState', /syncWandEntryState\s*\(/.test(refreshFn || ''), true);

console.log('\n=== ② 关键函数与设置项存在性 ===');
for (const fn of ['injectWandEntry', 'syncWandEntryState', 'openFullSettings', 'analyzeRemovedContent', 'refreshFloatingWindow']) {
    check(`${fn} 已定义`, src.includes(`function ${fn}(`), true);
}
check('DEFAULT_SETTINGS 含 show_floating_window', src.includes('show_floating_window:'), true);
check('DEFAULT_SETTINGS 含 floating_window_collapsed', src.includes('floating_window_collapsed:'), true);
check('魔法棒入口容器 id 存在（novel-wand-entry）', src.includes("'novel-wand-entry'"), true);
check('启动轮询兜底逻辑存在', /wandRetryTimer/.test(src), true);

console.log('\n=== ③ 新版弹窗结构（旧 id 已下线）===');
check('统计栏容器 novel_modal_statbar', src.includes('id="novel_modal_statbar"'), true);
check('入书正文列 novel_modal_clean', src.includes('id="novel_modal_clean"'), true);
check('原始回复列 novel_modal_raw', src.includes('id="novel_modal_raw"'), true);
check('头部徽标 novel_modal_speaker', src.includes('id="novel_modal_speaker"'), true);
check('旧版单栏 body 已移除', src.includes('novel_modal_body'), false);

console.log('\n=== ④ analyzeRemovedContent 行为断言（真实源码执行）===');
const escapeFn = extractFn('escapeHtml');
const parseFn = extractFn('parseTagList');
const analyzeFn = extractFn('analyzeRemovedContent');
check('依赖函数可抽取（escapeHtml / parseTagList / analyzeRemovedContent）', !!(escapeFn && parseFn && analyzeFn), true);

if (escapeFn && parseFn && analyzeFn) {
    const factory = new Function(`
        ${escapeFn}
        ${parseFn}
        ${analyzeFn}
        return { analyzeRemovedContent, escapeHtml, parseTagList };
    `);
    const { analyzeRemovedContent, escapeHtml } = factory();

    const settings = { exclude_tags: 'status,memory,ooc' };
    const raw = '<status>HP: 100/100</status>\n夜幕低垂，她合拢斗篷。\n<think>正在分析剧情...</think>\n<ooc>作者闲聊</ooc>';

    const r1 = analyzeRemovedContent(raw, settings);
    check('剔除计数 = 3（status/think/ooc 各一）', r1.removedCount, 3);
    check('status 标签被统计', r1.removedTags.some(t => t.name === 'status' && t.count === 1), true);
    check('think 族被归并统计', r1.removedTags.some(t => t.name === 'think族' && t.count === 1), true);
    check('ooc 标签被统计', r1.removedTags.some(t => t.name === 'ooc' && t.count === 1), true);
    check('剔除内容高亮 <mark> 出现 3 次', (r1.html.match(/<mark class="novel-mv-removed">/g) || []).length, 3);
    check('正文不被误高亮', r1.html.includes('夜幕低垂，她合拢斗篷。'), true);
    check('高亮内容经过转义（无裸 <status>）', /<status>/.test(r1.html), false);

    const r2 = analyzeRemovedContent('普通正文，没有任何标签。', settings);
    check('无剔除时 removedCount = 0', r2.removedCount, 0);
    check('无剔除时 removedTags 为空', r2.removedTags.length, 0);
    check('无剔除时原文原样转义输出', r2.html, escapeHtml('普通正文，没有任何标签。'));

    const r3 = analyzeRemovedContent('', settings);
    check('空输入安全返回', r3.removedCount === 0 && r3.html === '', true);
}

console.log(`\nUI 接线测试结果: 通过: ${pass}, 失败: ${fail}`);
if (fail > 0) process.exit(1);
console.log('所有 UI 接线与递归守卫测试全部通过！');
