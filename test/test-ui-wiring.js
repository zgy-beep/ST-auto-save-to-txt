/**
 * UI 接线与递归守卫回归测试
 * 运行方式: node test/test-ui-wiring.js
 *
 * 覆盖历史事故与 v1.13 入口重构：
 *  - v1.12.1 曾因全局替换把 refreshNovelToolbars() 内部的调用替换成自身，造成无限递归
 *  - v1.12.2 把入口误插到发送按钮旁（#send_but_holder），魔法棒菜单未生效
 *  - v1.13 设置面板迁出酒馆「扩展程序」抽屉，改为魔法棒菜单 + body 级弹窗 + 可拖拽悬浮窗
 * 本测试从 index.js / style.css 抽取真实源码做结构与行为断言。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const INDEX_PATH = path.join(ROOT, 'index.js');
const CSS_PATH = path.join(ROOT, 'style.css');
const src = fs.readFileSync(INDEX_PATH, 'utf8');
const css = fs.readFileSync(CSS_PATH, 'utf8');

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
check('函数体调用 injectWandEntry', /injectWandEntry\s*\(/.test(refreshFn || ''), true);
check('函数体调用 syncWandEntryState', /syncWandEntryState\s*\(/.test(refreshFn || ''), true);

console.log('\n=== ② 入口架构（v1.13：魔法棒菜单 + 悬浮窗，不再进扩展抽屉）===');
for (const fn of ['injectWandEntry', 'syncWandEntryState', 'ensureSettingsModal',
    'openNovelSettingsModal', 'closeNovelSettingsModal', 'ensurePreviewModal',
    'bindFloatingWindowDrag', 'onFwPointerMove', 'onFwPointerUp', 'applyFloatPos', 'clampFloatPos']) {
    check(`${fn} 已定义`, src.includes(`function ${fn}(`), true);
}
check('魔法棒菜单项挂在 #extensionsMenu', /getElementById\('extensionsMenu'\)/.test(src), true);
check('菜单项 id 为 novel-wand-menu-item', src.includes("'novel-wand-menu-item'"), true);
check('菜单项使用酒馆官方图标类 extensionsMenuExtensionButton', src.includes('extensionsMenuExtensionButton'), true);
check('不再渲染进酒馆扩展抽屉', /getElementById\('extensions_settings'\)/.test(src), false);
check('设置面板挂到独立的设置弹窗容器', src.includes("querySelector('#novel_settings_body')"), true);
check('预览弹窗独立挂 body（不再嵌在面板内）',
    /function ensurePreviewModal/.test(src) && !/panel\.querySelector\('#novel_preview_modal'\)/.test(src), true);
check('旧入口残留已清除（send_but_holder / novel-wand-entry）',
    /send_but_holder|novel-wand-entry/.test(src), false);
check('启动轮询兜底逻辑存在（uiRetryTimer）', /uiRetryTimer/.test(src), true);
check('悬浮窗默认开启（主入口之一）', src.includes('show_floating_window: true'), true);
check('悬浮窗位置持久化字段 float_pos', src.includes('float_pos:'), true);
check('老用户一次性迁移标记 ui_v113_migrated', src.includes('ui_v113_migrated'), true);

console.log('\n=== ③ 悬浮入口（v1.14 纯入口：点击开弹窗 + 可拖拽移动）===');
const dragFn = extractFn('bindFloatingWindowDrag') || '';
check('拖拽把手绑定 pointerdown', /pointerdown/.test(dragFn), true);
check('拖拽把手避让按钮/输入框', /closest\('button, input/.test(dragFn), true);
const moveFn = extractFn('onFwPointerMove') || '';
check('4px 阈值区分「点击打开弹窗」与「拖动移动」', /Math\.abs\(dx\) < 4 && Math\.abs\(dy\) < 4/.test(moveFn), true);
check('拖拽坐标经 clampFloatPos 夹取（拖不出屏幕）', /clampFloatPos\(fwDrag\.startLeft/.test(moveFn), true);
const upFn = extractFn('onFwPointerUp') || '';
check('拖动结束写入 float_pos 并持久化', /settings\.float_pos = \{/.test(upFn) && /saveSettingsDebounced/.test(upFn), true);
check('拖动后抑制补发的 click（fwLastDragAt）', /fwLastDragAt = Date\.now\(\)/.test(upFn), true);
const buildFn = extractFn('buildFloatingWindow') || '';
check('药丸点击即打开设置弹窗（纯入口）',
    /pill\.addEventListener\('click'[\s\S]{0,160}activate\(\)/.test(buildFn) && /openNovelSettingsModal\(\)/.test(buildFn), true);
check('点击与拖动区分（fwLastDragAt 守卫）', /Date\.now\(\) - fwLastDragAt < 300/.test(buildFn), true);
check('药丸可键盘触发（role=button + Enter/Space）', /role="button"/.test(buildFn) && /'Enter' \|\| e\.key === ' '/.test(buildFn), true);
check('悬浮入口已无二级展开面板', /novel-fw-panel/.test(src), false);
check('面板相关设置项已清理（floating_window_collapsed）', /floating_window_collapsed/.test(src), false);
check('无遗留的展开面板 CSS', /novel-fw-panel|novel-fw-btn|novel-fw-chevron/.test(css), false);
check('拖拽状态只绑一次 document 监听（fwDragBound）', /fwDragBound/.test(dragFn), true);
check('拖拽把手禁用触摸滚动（touch-action: none）', /\.novel-fw-drag-handle \{[\s\S]*?touch-action: none/.test(css), true);
check('悬浮窗为 fixed 定位', /\.novel-floating-window \{[\s\S]*?position: fixed/.test(css), true);
check('启动即渲染悬浮窗口（init 调用 refreshNovelToolbars）', /seedLastSavedSignature\(\);[\s\S]{0,400}refreshNovelToolbars\(\)/.test(src), true);

console.log('\n=== ④ 弹窗定位与层级 ===');
check('positionOverlay 具备 fixed 退化兜底',
    /Math\.abs\(rect\.top\) > 1 \|\| Math\.abs\(rect\.left\) > 1/.test(src), true);
check('预览弹窗层级高于设置弹窗',
    /#novel_preview_modal \{ z-index: 1000025/.test(css) && /#novel_settings_modal \{ z-index: 1000015/.test(css), true);
check('Esc 关闭逻辑只绑一次且预览优先', /novelEscBound/.test(src) && /bindNovelEscClose/.test(src), true);

console.log('\n=== ⑤ 新版弹窗结构（旧 id 已下线）===');
check('统计栏容器 novel_modal_statbar', src.includes('id="novel_modal_statbar"'), true);
check('入书正文列 novel_modal_clean', src.includes('id="novel_modal_clean"'), true);
check('原始回复列 novel_modal_raw', src.includes('id="novel_modal_raw"'), true);
check('头部徽标 novel_modal_speaker', src.includes('id="novel_modal_speaker"'), true);
check('旧版单栏 body 已移除', src.includes('novel_modal_body'), false);
check('设置弹窗容器 novel_settings_body', src.includes('id="novel_settings_body"'), true);
check('设置弹窗头部状态位 novel_header_status', src.includes('id="novel_header_status"'), true);

console.log('\n=== ⑥ analyzeRemovedContent 行为断言（真实源码执行）===');
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

console.log('\n=== ⑦ 设置弹窗布局（桌面双列 / 手机单列 + 全屏 sheet）===');
check('分区容器 novel-settings-grid', src.includes('novel-settings-grid'), true);
check('主开关卡片 novel-toggle-card', src.includes('novel-toggle-card'), true);
check('桌面分区双列栅格',
    /\.novel-settings-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css), true);
check('主开关卡桌面双列', /\.novel-toggle-row \{[\s\S]*?grid-template-columns: repeat\(2/.test(css), true);
check('≤900px 退化为单列',
    /@media \(max-width: 900px\) \{[\s\S]*?\.novel-settings-grid \{ grid-template-columns: 1fr/.test(css), true);
check('≤600px 弹窗转全屏 sheet',
    /@media \(max-width: 600px\) \{[\s\S]*?\.novel-modal-overlay \{ padding: 0;[\s\S]*?\.novel-modal \{ width: 100%; height: 100%/.test(css), true);
check('手机端按钮触控高度 ≥42px', /#auto-save-to-txt-settings \.novel-btn \{ min-height: 42px/.test(css), true);
check('手机端输入框/下拉触控高度 ≥40px',
    /\.novel-select \{ min-height: 40px/.test(css), true);
check('说明文字弱化（11.5px / opacity .6）',
    /#auto-save-to-txt-settings small \{[\s\S]*?font-size: 11\.5px[\s\S]*?opacity: 0\.6/.test(css), true);
check('楼层工具条章节信息 = 设置入口', /data-lt="settings"/.test(src) && /novel-lt-info/.test(src), true);
check('已无 openFullSettings 死代码', /function openFullSettings/.test(src), false);

console.log('\n=== ⑧ 悬浮入口坐标夹取行为（真实源码执行）===');
const clampFn = extractFn('clampFloatPos');
check('clampFloatPos 可抽取', !!clampFn, true);
if (clampFn) {
    const clamp = new Function(`${clampFn}\nreturn clampFloatPos;`)();
    const win = { innerWidth: 1000, innerHeight: 800 };
    const g = globalThis.window;
    globalThis.window = win;
    try {
        let c = clamp(-50, -20, 200, 100);
        check('左上越界被夹回 0', c.left === 0 && c.top === 0, true);
        c = clamp(5000, 5000, 200, 100);
        check('右下越界被夹到可视区内', c.left === 800 && c.top === 700, true);
        c = clamp(120, 340, 200, 100);
        check('正常坐标原样保留', c.left === 120 && c.top === 340, true);
    } finally {
        globalThis.window = g;
    }
}

console.log(`\nUI 接线测试结果: 通过: ${pass}, 失败: ${fail}`);
if (fail > 0) process.exit(1);
console.log('所有 UI 接线与递归守卫测试全部通过！');
