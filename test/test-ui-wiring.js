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
    'bindFloatingWindowDrag', 'onFwPointerMove', 'onFwPointerEnd', 'onFwPointerUp',
    'onFwPointerCancel', 'fwSlop', 'applyFloatPos', 'clampFloatPos']) {
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
check('拖动阈值按指针类型区分（触屏放宽，手机轻点不被误判成拖动）', /fwSlop\(fwDrag\.pointerType\)/.test(moveFn), true);
check('触屏阈值 10px / 鼠标 4px（FW_SLOP）', /FW_SLOP = \{ touch: 10, pen: 4, mouse: 4 \}/.test(src), true);
check('拖拽坐标经 clampFloatPos 夹取（拖不出屏幕）', /clampFloatPos\(fwDrag\.startLeft/.test(moveFn), true);

const endFn = extractFn('onFwPointerEnd') || '';
check('轻点在 pointerup 当场判定（不依赖浏览器补发的 click）',
    /fwTapHandledAt = Date\.now\(\)/.test(endFn) && /fwOnTap\(\)/.test(endFn), true);
check('拖动结束写入 float_pos 并持久化', /settings\.float_pos = \{/.test(endFn) && /saveSettingsDebounced/.test(endFn), true);
check('拖动结束记录时间戳（fwDragEndAt）', /fwDragEndAt = Date\.now\(\)/.test(endFn), true);
check('pointercancel（手势被系统取消）既不算点击也不算拖动',
    /if \(isCancel && !moved\) return;/.test(endFn) && /function onFwPointerCancel/.test(src), true);

const buildFn = extractFn('buildFloatingWindow') || '';
check('药丸点击即打开设置弹窗（纯入口）',
    /pill\.addEventListener\('click'[\s\S]{0,300}activate\(\)/.test(buildFn) && /openNovelSettingsModal\(\)/.test(buildFn), true);
check('click 仅作兜底：pointerup 已处理 / 刚拖动过都会被忽略',
    /Date\.now\(\) - fwTapHandledAt < 500/.test(buildFn) && /Date\.now\(\) - fwDragEndAt < 400/.test(buildFn), true);
check('药丸可键盘触发（role=button + Enter/Space）', /role="button"/.test(buildFn) && /'Enter' \|\| e\.key === ' '/.test(buildFn), true);
check('旧版点击守卫已下线（fwLastDragAt）', /fwLastDragAt/.test(src), false);
check('悬浮入口已无二级展开面板', /novel-fw-panel/.test(src), false);
check('面板相关设置项已清理（floating_window_collapsed）', /floating_window_collapsed/.test(src), false);
check('无遗留的展开面板 CSS', /novel-fw-panel|novel-fw-btn|novel-fw-chevron/.test(css), false);
check('拖拽状态只绑一次 document 监听（fwDragBound）', /fwDragBound/.test(dragFn), true);
check('拖拽把手禁用触摸滚动（touch-action: none）', /\.novel-fw-drag-handle \{[\s\S]*?touch-action: none/.test(css), true);
check('悬浮窗为 fixed 定位', /\.novel-floating-window \{[\s\S]*?position: fixed/.test(css), true);
check('手机端药丸上移避开输入栏（bottom 74px + 安全区）',
    /bottom: calc\(74px \+ env\(safe-area-inset-bottom/.test(css), true);
check('启动即渲染悬浮窗口（init 调用 refreshNovelToolbars）', /seedLastSavedSignature\(\);[\s\S]{0,400}refreshNovelToolbars\(\)/.test(src), true);

console.log('\n=== ③b 悬浮窗跨设备适配与「必须看得见」（v1.16）===');
check('init 绑定视口变化统一重排（只绑一次）',
    /refreshNovelToolbars\(\);\s*\n\s*\/\/[^\n]*\n\s*bindOverlayResync\(\);/.test(src) && /overlayResyncBound/.test(src), true);
check('重排覆盖 resize / 横竖屏 / visualViewport 尺寸与位移 / 文档级滚动',
    /window\.addEventListener\('resize', scheduleOverlayResync\)/.test(src)
    && /orientationchange/.test(src)
    && /visualViewport[\s\S]{0,400}vv\.addEventListener\('resize'/.test(src)
    && /document\.addEventListener\('scroll', onDocScroll/.test(src), true);
check('弹窗正文滚动不会触发重排（只认文档级滚动量变化）',
    /const st = getDocScrollTop\(\);\s*\n\s*if \(st === lastObservedScrollTop\) return;/.test(src), true);
check('跨设备坐标不套用（保存时记 vw，宽度差 > 120px 即回落默认锚点）',
    /function isFloatPosUsableForViewport/.test(src)
    && /Math\.abs\(pos\.vw - vp\.width\) > 120/.test(src), true);
check('药丸保存屏幕坐标 + 记录视口宽度',
    /left: Math\.round\(rect\.left\),\s*\n\s*top: Math\.round\(rect\.top\),/.test(src)
    && /vw: Math\.round\(getVisibleViewportBox\(\)\.width\)/.test(src), true);
check('药丸跑出可见区即被实测推回（含手机端让开输入栏）',
    /function keepFloatWindowInsideViewport/.test(src)
    && /const maxBottom = vp\.height - floatBottomClearance\(readFloatGap\(win\)\);/.test(src), true);
check('药丸底部让位由 CSS 变量给出（JS 与样式表单一口径）',
    /--nv-fw-gap-bottom: 12px;/.test(css) && /--nv-fw-gap-bottom: 74px;/.test(css)
    && /getPropertyValue\('--nv-fw-gap-bottom'\)/.test(src), true);
check('底部安全区由探针实测（env() 在 computedStyle 里读不出解析值）',
    /function measureSafeAreaBottom/.test(src) && /height:env\(safe-area-inset-bottom, 0px\)/.test(src), true);
check('拖动按下时把包含块补偿折成像素坐标（防按下瞬间跳位）',
    /const off = measureHostFixedOffset\(\);\s*\n\s*win\.style\.transform = '';/.test(src)
    && /fwDrag\.startLeft = rect\.left - off\.x;/.test(src), true);

// 行为用例：坐标是否适用于当前视口（纯函数，真实执行）
const usableFn = extractFn('isFloatPosUsableForViewport');
const clearanceFn = extractFn('floatBottomClearance');
check('可抽取 isFloatPosUsableForViewport / floatBottomClearance', !!(usableFn && clearanceFn), true);
if (usableFn && clearanceFn) {
    const api = new Function(`${clearanceFn}\n${usableFn}\nreturn { isFloatPosUsableForViewport, floatBottomClearance };`)();
    const vpPhone = { width: 390, height: 844 };
    const gapPhone = { bottom: 74, right: 10 };
    const gapDesk = { bottom: 12, right: 12 };
    check('手机端跨设备坐标被拒（桌面拖出的 1140,720）',
        api.isFloatPosUsableForViewport({ left: 1140, top: 720, vw: 1280 }, 105, 40, vpPhone, gapPhone), false);
    check('手机端本设备坐标可用',
        api.isFloatPosUsableForViewport({ left: 250, top: 700, vw: 390 }, 105, 40, vpPhone, gapPhone), true);
    check('坐标右溢出被拒', api.isFloatPosUsableForViewport({ left: 330, top: 700, vw: 390 }, 105, 40, vpPhone, gapPhone), false);
    check('手机端压住输入栏的坐标被拒（top 810 + 40 > 844 - 74）',
        api.isFloatPosUsableForViewport({ left: 100, top: 810, vw: 390 }, 105, 40, vpPhone, gapPhone), false);
    check('桌面端贴底坐标可用（桌面档不让开输入栏）',
        api.isFloatPosUsableForViewport({ left: 100, top: 790, vw: 390 }, 105, 40, vpPhone, gapDesk), true);
    check('负坐标被拒', api.isFloatPosUsableForViewport({ left: -20, top: 100, vw: 390 }, 105, 40, vpPhone, gapPhone), false);
    check('缺 vw 的老数据不做跨设备判定（按几何是否放得下决定）',
        api.isFloatPosUsableForViewport({ left: 250, top: 700 }, 105, 40, vpPhone, gapPhone), true);
    check('NaN / 空值安全返回 false',
        api.isFloatPosUsableForViewport({ left: NaN, top: 1 }, 105, 40, vpPhone, gapPhone) === false
        && api.isFloatPosUsableForViewport(null, 105, 40, vpPhone, gapPhone) === false, true);
    check('桌面档（12px）不算让位，手机档（74px）算',
        api.floatBottomClearance(gapDesk) === 0 && api.floatBottomClearance(gapPhone) === 74, true);
}

console.log('\n=== ④ 弹窗定位与层级 ===');
check('弹窗定位改为「钉住可见视口 + 实测反向补偿」',
    /function pinElementToVisibleViewport/.test(src)
    && /el\.style\.height = `\$\{vp\.height\}px`/.test(src)
    && /el\.style\.left = `\$\{-off\.x\}px`/.test(src), true);
check('宿主包含块偏移实测探针存在（酒馆 html 的 transform 会劫持 fixed 包含块）',
    /function measureHostFixedOffset/.test(src)
    && /position:fixed;top:0;left:0;width:1px;height:1px/.test(src), true);
check('positionOverlay 已无「切 absolute 按文档坐标推走」的退化分支',
    /function positionOverlay\(overlay\) \{\s*\n\s*if \(!overlay\) return;\s*\n\s*pinElementToVisibleViewport\(overlay\);\s*\n\}/.test(src)
    && /window\.scrollY \|\| window\.pageYOffset/.test(src), false);
check('可见视口优先取 visualViewport（手机端 URL 栏 / 软键盘）',
    /function getVisibleViewportBox/.test(src) && /window\.visualViewport/.test(src), true);
check('弹窗先显示后定位（display:none 时 getBoundingClientRect 恒为 0）',
    /overlay\.style\.display = 'flex';\s*\n\s*positionOverlay\(overlay\);/.test(src), true);
check('遮罩点击关闭带「刚打开」守卫（防同一次触摸补发的 click 秒关弹窗）',
    /Date\.now\(\) - settingsModalOpenedAt < 400/.test(src), true);
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

console.log('\n=== ⑨ v1.15 视觉重设计（参考图：深色石板 + 紫罗兰强调）===');
// 设计令牌：深色石板底 / 紫罗兰强调 / 发丝线 / 虚线空态
check('设计令牌已定义（深色石板底 #161a24）', /--nv-bg: #161a24;/.test(css), true);
check('强调色唯一为紫罗兰 #8b6dff', /--nv-accent: #8b6dff;/.test(css), true);
check('发丝分隔线令牌 --nv-line', /--nv-line: rgba\(255, 255, 255, 0\.07\);/.test(css), true);
check('虚线空态描边令牌 --nv-dash', /--nv-dash: rgba\(255, 255, 255, 0\.17\);/.test(css), true);
check('令牌作用域限定在自有浮层（不污染聊天楼层）',
    /\.novel-modal-overlay,\s*\n\.novel-floating-window,\s*\n\.novel-chip-tooltip \{/.test(css), true);
// 头部：标题 + 右侧方形图标按钮（参考图右上角）
check('弹窗头部标题类 novel-modal-title', src.includes('class="novel-modal-title"'), true);
check('设置弹窗头部含紫色强调方形按钮', src.includes('id="novel_settings_preview"') && /id="novel_settings_preview" class="novel-icon-btn is-accent"/.test(src), true);
check('两个弹窗的关闭按钮统一为方形图标按钮', (src.match(/class="novel-icon-btn"/g) || []).length >= 2, true);
check('强调按钮已绑定过滤预览', /novel_settings_preview'\)[\s\S]{0,120}openFilterPreviewModal\(\)/.test(src), true);
// 方形图标按钮尺寸与强调变体
check('方形图标按钮 34×34 圆角方块', /\.novel-icon-btn \{[\s\S]*?width: 34px;[\s\S]*?height: 34px;/.test(css), true);
check('强调变体 is-accent 用紫罗兰', /\.novel-icon-btn\.is-accent \{[\s\S]*?background: var\(--nv-accent-bg\)/.test(css), true);
// 分区标题：靠「标题 + 下方发丝线」建立结构，而不是左边条
check('分区标题取消左边条、改用下边框发丝线',
    /#auto-save-to-txt-settings \.novel-section-title \{[\s\S]*?border-left: none;[\s\S]*?border-bottom: 1px solid var\(--nv-line\);/.test(css), true);
// 空态虚线卡（参考图「还没有全局角色」的签名元素）
check('会话标签区容器走虚线空态卡',
    /\.novel-tag-chip-list \{[\s\S]*?border: 1px dashed var\(--nv-dash\);/.test(css), true);
check('中性状态条亦为虚线卡', /\.novel-alert\.checking \{[\s\S]*?border: 1px dashed var\(--nv-dash\) !important;/.test(css), true);
// 主操作=紫罗兰实心
check('主按钮（导出）改为紫罗兰实心',
    /\.novel-btn\.btn-export \{[\s\S]*?background: var\(--nv-accent\);/.test(css), true);
// 说明文字：靠颜色而非 opacity 压暗（避免与宿主主题冲突）
check('说明文字改用灰阶而非 opacity 压暗',
    /#auto-save-to-txt-settings small \{[\s\S]*?color: var\(--nv-text-2\) !important;[\s\S]*?opacity: 1 !important;/.test(css), true);
// 输入焦点环 = 紫罗兰
check('输入框焦点环为紫罗兰',
    /#auto-save-to-txt-settings \.text_pole:focus[\s\S]*?border-color: var\(--nv-accent\);[\s\S]*?box-shadow: 0 0 0 3px var\(--nv-accent-bg\);/.test(css), true);
// 手机端全屏 sheet 在新主题下仍然成立
check('新主题未破坏手机端全屏 sheet（圆角归零 / 去边框）',
    /@media \(max-width: 600px\) \{[\s\S]*?\.novel-modal \{[\s\S]*?border-radius: 0;/.test(css), true);
check('手机端图标按钮放大到 40×40（易点中）',
    /@media \(max-width: 600px\) \{[\s\S]*?\.novel-icon-btn \{ width: 40px; height: 40px;/.test(css), true);

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
