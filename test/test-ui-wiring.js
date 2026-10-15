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

/**
 * 把源码/模板里所有 class 属性拆成**单独的类名**再比对。
 * 直接用 `class="novel-section"` 做子串判断会被 `class="novel-section-title"` 放过，
 * 于是「包裹层已删除」这类断言会静默变成空转（实测踩到过）。
 */
function classTokens(text) {
    return (String(text).match(/class="([^"]*)"/g) || [])
        .reduce((acc, m) => acc.concat(m.slice(7, -1).trim().split(/\s+/)), []);
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
    /const off = measureHostFixedOffset\(win\);\s*\n\s*win\.style\.transform = '';/.test(src)
    && /fwDrag\.startLeft = rect\.left - off\.x;/.test(src), true);

console.log('\n=== ③c 悬浮窗「绝不能消失」的两道兜底（v1.17.2）===');
const keepFn = extractFn('keepFloatWindowInsideViewport');
const ensureFn = extractFn('ensureFloatingWindowVisible');
const retryFn = extractFn('ensureFloatPosEventually');
const applyFn = extractFn('applyFloatPos');
const refreshFwFn = extractFn('refreshFloatingWindow');
check('keepFloatWindowInsideViewport 量矩形前先清掉上一轮 transform（否则残差=旧值、每帧左右横跳）',
    /win\.style\.transform = '';\s*\n\s*const r = win\.getBoundingClientRect\(\)/.test(keepFn || ''), true);
check('兜底一：ensureFloatingWindowVisible 存在且用屏幕坐标硬放',
    !!ensureFn && /win\.style\.left = `\$\{left - off\.x\}px`/.test(ensureFn || '')
    && /measureHostFixedOffset\(win\)/.test(ensureFn || ''), true);
check('兜底一同时校验「位置对不对」（不只看在不在屏内）',
    /enforceDefaultAnchor/.test(ensureFn || '') && /anchored/.test(ensureFn || ''), true);
check('兜底一在 applyFloatPos 末尾被调用', /ensureFloatingWindowVisible\(win, !pos\);/.test(applyFn || ''), true);
check('用户拖过的药丸不被拽回右下角（enforceDefaultAnchor 由「没有持久化坐标」决定）',
    /ensureFloatingWindowVisible\(win, !pos\)/.test(src) && /const pos = getUserFloatPos\(\)/.test(applyFn || ''), true);
check('兜底二：ensureFloatPosEventually 有界重试（视口量不到时单次重排等于没做）',
    !!retryFn && /n > 60/.test(retryFn || '') && /requestAnimationFrame\(tick\)/.test(retryFn || ''), true);
check('兜底二在 refreshFloatingWindow 里被调用', /ensureFloatPosEventually\(\);/.test(refreshFwFn || ''), true);
check('CSS 手机端锚点双写 bottom：不认 env() 的浏览器至少拿到不含 env() 的那条',
    /bottom: 74px;\s*\n\s*bottom: calc\(74px \+ env\(safe-area-inset-bottom/.test(css), true);

console.log('\n=== ③d 浮层载体：原生 <dialog> + top layer（v1.17.3，根治手段）===');
const ensureTlFn = extractFn('ensureTopLayer');
const mountTlFn = extractFn('mountInTopLayer');
const pinFn = extractFn('pinElementToVisibleViewport');
const hostOffFn = extractFn('measureHostFixedOffset');
check('载体用原生 <dialog>（酒馆官方弹窗也是这个：SillyTavern.Popup → dlg: HTMLDialogElement）',
    /document\.createElement\('dialog'\)/.test(ensureTlFn || ''), true);
check('载体必须 show() 才进 top layer；且用非模态（showModal 会给文档加 inert → 药丸点不到）',
    /layer\.show\(\)/.test(ensureTlFn || '') && !/showModal/.test(ensureTlFn || ''), true);
check('老环境兜底：环境不支持 <dialog> 时返回 null，调用方回退裸浮层',
    /HTMLDialogElement === 'undefined'/.test(ensureTlFn || '') && /return null/.test(ensureTlFn || ''), true);
check('mountInTopLayer 幂等（已在载体里就不重复搬）',
    /el\.parentElement !== layer/.test(mountTlFn || ''), true);
['novel-tl-floating', 'novel-tl-settings', 'novel-tl-preview'].forEach((id) => {
    check(`浮层挂进 top-layer 载体：${id}`, new RegExp(`mountInTopLayer\\('${id}'`).test(src), true);
});
check('三个浮层都不再直接 appendChild 到 body（那会被 html transform 劫持 fixed）',
    (src.match(/document\.body\.appendChild\((overlay|win|pv)\)/g) || []).length, 0);
check('载体样式：铺满视口（fixed + inset:0），内层 absolute 的基准就是它',
    /dialog\.novel-tl \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/.test(css), true);
check('载体高度显式写死 100dvh（只给 inset:0 会被文档盒子撑高，实测撑到 1350px）',
    /dialog\.novel-tl \{[\s\S]*?height: 100dvh;/.test(css), true);
check('载体不吃指针事件（否则透明 dialog 会把整个页面挡死），子浮层各自恢复',
    /dialog\.novel-tl \{[\s\S]*?pointer-events: none;/.test(css)
    && /dialog\.novel-tl > \.novel-floating-window,[\s\S]*?pointer-events: auto;/.test(css), true);
check('内层浮层改 position:absolute（基准=载体盒子=视口，免疫 html transform）',
    /dialog\.novel-tl > \.novel-floating-window,[\s\S]*?position: absolute;/.test(css), true);
check('载体不能加 contain（含 paint 包含会裁剪溢出，弹窗正文会滚不动）',
    !/dialog\.novel-tl \{[^}]*contain:/.test(css), true);
check('在 top layer 里时 measureHostFixedOffset 直接返回 0/0（坐标系已是视口，再折算反而跑偏）',
    /closest\('dialog\.novel-tl'\)\) return \{ x: 0, y: 0 \}/.test(hostOffFn || ''), true);
check('measureHostFixedOffset 已接收元素参数（三处调用都传了 win/el）',
    /function measureHostFixedOffset\(el\)/.test(src)
    && (src.match(/measureHostFixedOffset\(win\)/g) || []).length >= 2, true);
check('pinElementToVisibleViewport 在 top layer 里写 absolute，绝不写回 fixed',
    /inTopLayer \? 'absolute' : 'fixed'/.test(pinFn || ''), true);
check('关闭悬浮入口时连载体一起撤掉（别在 body 上留空 dialog）',
    /getElementById\('novel-tl-floating'\)\?\.remove\(\)/.test(src), true);

console.log('\n=== ③e 层叠：浮层必须盖过宿主 UI（v1.17.4，修「弹窗显示在界面后面」）===');
// 背景：宿主 html 上的 transform 除了劫持 fixed 包含块，还让 html 成为**层叠上下文**。
// dialog show() 之后绘制仍困在这个上下文里比较，载体 z-index:auto（=0）直接输给
// 酒馆 UI 的 29999 → 弹窗/药丸全部被盖住。**top layer 只解决定位，不解决层叠。**
check('载体写死 z-index 顶层值（auto 会输给宿主 29999，实测弹窗被完全遮住）',
    /dialog\.novel-tl \{[^}]*z-index: 2147483647;/.test(css), true);
check('内层也写死同一值（只加载体时药丸仍被宿主底栏半透明背景透过叠加，黄变暗黄）',
    /dialog\.novel-tl > #novel_settings_modal,[\s\S]*?z-index: 2147483647;/.test(css), true);
check('内层选择器必须带 id：#novel_settings_modal 特异性 (1,0,0) 胜过 (0,1,2)，只写类会被压过去',
    /dialog\.novel-tl > #novel_settings_modal/.test(css)
    && /dialog\.novel-tl > #novel_preview_modal/.test(css)
    && /dialog\.novel-tl > #novel-floating-window/.test(css), true);
check('预览弹窗同样要写死（它在另一个载体里，靠同一套规则）',
    /dialog\.novel-tl > #novel_preview_modal,/.test(css), true);
check('mountInTopLayer 载体缺失时把浮层挂回 body（否则元素从未进 DOM，弹窗彻底消失且不报错）',
    /if \(!layer\) \{[\s\S]*?document\.body\.appendChild\(el\)/.test(mountTlFn || ''), true);
check('回退路径补 z-index（挂回 body 仍要能盖住宿主 UI）',
    /if \(!layer\) \{[\s\S]*?zIndex = '2147483647'/.test(mountTlFn || ''), true);
check('代码注释记录了「top layer 只解决定位不解决层叠」这个坑',
    /top layer \*\*只解决定位，不解决层叠\*\*/.test(src), true);
check('移动端浮层测试页复刻了宿主 UI 元素（.stui）——没有它就测不出层叠冲突',
    /#stui-sheld/.test(fs.readFileSync(path.join(__dirname, 'test-mobile-overlay.js'), 'utf8')), true);

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
check('已无「栅格 + 分区」两层纯包裹容器（v1.17.1 扁平化）',
    classTokens(src).some((c) => c === 'novel-settings-grid' || c === 'novel-section'), false);
check('面板内容直接挂在 .novel-tabpane 下（层次：面板 > 折叠行 > 展开体 > 控件）',
    /class="novel-tabpane[^"]*"[\s\S]{0,220}?class="novel-section-title"/.test(src), true);
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

console.log('\n=== ⑩ v1.17 设置弹窗标签页化 + 桌面端去卡片 ===');

// —— 结构：五个标签 / 五个面板一一对应 ——
const TAB_KEYS = ['serial', 'filter', 'format', 'file', 'general'];
const tabBtns = (src.match(/class="novel-tab(?: is-active)?"/g) || []).length;
const paneDivs = (src.match(/class="novel-tabpane(?: is-active)?"/g) || []).length;
check('标签按钮 5 个', tabBtns, 5);
check('标签面板 5 个', paneDivs, 5);
TAB_KEYS.forEach((k) => {
    check(`标签 data-nv-tab="${k}" 存在`, src.includes(`data-nv-tab="${k}"`), true);
    check(`面板 data-nv-pane="${k}" 存在`, src.includes(`data-nv-pane="${k}"`), true);
});
check('默认只有「连载」面板带 is-active',
    (src.match(/class="novel-tabpane is-active"/g) || []).length, 1);
check('默认只有「连载」标签带 is-active',
    (src.match(/class="novel-tab is-active"/g) || []).length, 1);
check('标签栏与面板容器成对出现',
    src.includes('class="novel-tabs"') && src.includes('class="novel-tabpanes"'), true);

// —— 红线：面板全部挂载、只切 display，禁止重建 innerHTML ——
const tabsFn = extractFn('bindNovelTabs');
check('bindNovelTabs 定义存在', !!tabsFn, true);
check('bindNovelTabs 用 classList.toggle 切显示（不是重建 DOM）',
    /classList\.toggle\('is-active'/.test(tabsFn || ''), true);
check('bindNovelTabs 内没有任何 innerHTML 写入（红线守卫）',
    /innerHTML/.test(tabsFn || ''), false);
check('bindNovelTabs 内没有 removeChild / replaceChildren（红线守卫）',
    /removeChild|replaceChildren|\.remove\(\)/.test(tabsFn || ''), false);
check('切换标签后回到滚动顶部', /scrollTop = 0/.test(tabsFn || ''), true);
check('标签支持左右方向键（tablist 键盘语义）',
    /ArrowRight/.test(tabsFn || '') && /ArrowLeft/.test(tabsFn || ''), true);
check('非激活标签移出 Tab 焦点序（tabIndex = -1）', /tabIndex = on \? 0 : -1/.test(tabsFn || ''), true);
check('面板建好后立即接线', /container\.appendChild\(panel\);[\s\S]{0,200}bindNovelTabs\(panel\)/.test(src), true);
check('每次打开弹窗复位到「连载」（不记忆标签）',
    /__novelActivateTab\('serial'\)/.test(src), true);

// —— 主开关常驻：不进任何标签面板 ——
check('主开关仍在面板顶部（标签栏之前）',
    src.indexOf('id="novel_save_enabled"') < src.indexOf('class="novel-tabs"'), true);
check('界面偏好三开关已移入「通用」面板', (() => {
    const seg = src.split('data-nv-pane="general"')[1] || '';
    return seg.includes('id="novel_show_floating_window"')
        && seg.includes('id="novel_show_embedded_toolbar"')
        && seg.includes('id="novel_show_toast"');
})(), true);

// —— 模板完整性：注释里的反引号会把模板字符串提前截断（v1.17 实测事故）——
// 语法仍然合法（后半段被解析成「标签模板调用」），node --check 查不出来，只有渲染时才暴露。
const panelTplMatch = src.split("panel.className = 'novel-drawer-inner';")[1];
const panelTpl = panelTplMatch ? (panelTplMatch.match(/innerHTML = `([\s\S]*?)`;/) || [])[1] : null;
check('可抽取设置面板模板', !!panelTpl, true);
const REQUIRED_IDS = [
    'novel_save_enabled', 'novel_show_floating_window', 'novel_show_embedded_toolbar', 'novel_show_toast',
    'novel_include_tags', 'novel_exclude_tags', 'novel_chapter_style', 'novel_naming_rule',
    'novel_include_user', 'novel_indent_paragraphs', 'novel_buffer_latest', 'novel_save_dir',
    'novel_export_all_btn', 'novel_sync_all_btn', 'novel_test_btn', 'novel_preview_btn',
    'novel_rescan_tags_btn', 'novel_copy_filepath_btn'
];
if (panelTpl) {
    const missing = REQUIRED_IDS.filter((id) => !panelTpl.includes(`id="${id}"`));
    check('面板模板包含全部 18 个控件（模板未被截断）', missing.length === 0 ? 'ok' : missing.join(','), 'ok');
    // 只看「注释内部、闭合 --> 之前」是否有反引号：注释外的反引号是 ${} 里的嵌套模板，合法
    check('模板内 HTML 注释不含裸反引号（会截断模板字符串）',
        /<!--(?:(?!-->)[\s\S])*`/.test(panelTpl), false);
    check('5 个标签面板各自直接以分区标题开头（没有中间包裹层）',
        (panelTpl.match(/class="novel-tabpane[^"]*"[\s\S]{0,200}?class="novel-section-title"/g) || []).length, 5);
    check('模板里已无 novel-settings-grid / novel-section 包裹层',
        (panelTpl.match(/class="novel-settings-grid"|class="novel-section"/g) || []).length, 0);
}

// —— CSS：标签栏 / 去卡片 / 手机端底部吸附 ——
check('标签栏样式已定义', /#auto-save-to-txt-settings \.novel-tabs \{/.test(css), true);
check('激活标签用紫罗兰淡底',
    /\.novel-tab\.is-active \{[\s\S]*?background: var\(--nv-accent-bg\);/.test(css), true);
check('未激活面板 display:none（只切 display）',
    /#auto-save-to-txt-settings \.novel-tabpane \{ display: none; \}/.test(css), true);
check('激活面板恢复显示',
    /#auto-save-to-txt-settings \.novel-tabpane\.is-active \{ display: block; \}/.test(css), true);
check('去卡片 ①：主开关卡去掉底色与描边',
    /#auto-save-to-txt-settings \.novel-toggle-card \{[\s\S]*?background: none;[\s\S]*?border: none;/.test(css), true);
check('去卡片 ②：分区去掉底色与描边',
    /#auto-save-to-txt-settings \.novel-settings-grid \.novel-section \{[\s\S]*?background: none;[\s\S]*?border: none;/.test(css), true);
check('去卡片 ③：书卡改成「键 + 值」扁平行（v1.17.1，不再是嵌套盒子）',
    /#auto-save-to-txt-settings \.novel-info-row \{[\s\S]*?display: flex;[\s\S]*?border-bottom: 1px solid var\(--nv-block-line\);/.test(css), true);
check('手机端标签栏 sticky 吸附底部',
    /@media \(max-width: 768px\) \{[\s\S]*?\.novel-tabs \{[\s\S]*?position: sticky;[\s\S]*?bottom: 0;/.test(css), true);
check('手机端正文容器撑满弹窗（否则 sticky 无处可吸附）',
    /\.novel-modal-body-settings \{[\s\S]*?flex: 1 1 auto;[\s\S]*?flex-direction: column;/.test(css), true);
check('手机端标签栏用 order 排到内容之后',
    /\.novel-tabpanes \{[\s\S]*?order: 2;/.test(css) && /\.novel-tabs \{[\s\S]*?order: 3;/.test(css), true);
check('手机端标签图标在上、文字在下（底部栏形态）',
    /@media \(max-width: 768px\) \{[\s\S]*?\.novel-tab \{[\s\S]*?flex-direction: column;/.test(css), true);
// 旧 CSS 规则必须保留（v1.15/v1.16 断言依赖它们，只追加不删改）
check('v1.17 未删改旧的双列栅格规则（仍可被断言命中）',
    /\.novel-settings-grid \{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/.test(css), true);

// —— 两处已修的回归 ——
// ① 标签页化后每个面板只剩 1 个分区，双列会让右半列整片空着（看起来像内容没居中）
check('分区栅格已覆盖为单列（内容铺满弹窗宽度）',
    /#auto-save-to-txt-settings \.novel-settings-grid \{[\s\S]*?grid-template-columns: 1fr;/.test(css), true);
// ② v1.14 遗留的 #novel_settings_body { padding: 0 }（特异性 1,0,0）会压掉所有
//    .novel-modal-body-settings 的 padding，实测 computed padding 为 "0px"，内容贴屏幕边
check('正文容器内边距已恢复（不再被 #novel_settings_body 的 padding:0 压掉）',
    /#novel_settings_body \{ padding: 16px; \}/.test(css), true);
check('手机端正文容器给标签栏让出通栏（水平 padding 归零、内容侧留 12px）',
    /@media \(max-width: 768px\) \{[\s\S]*?#novel_settings_body \{ padding: 12px 0 0; \}/.test(css)
    && /\.novel-tabpanes \{[\s\S]{0,80}padding: 0 12px;/.test(css), true);
check('设置弹窗保持居中（overlay 用 flex 居中，且不写死 margin/translate 偏移）',
    /\.novel-modal-overlay \{[\s\S]*?align-items: center;[\s\S]*?justify-content: center;/.test(css)
    && !/#novel_settings_modal \{[^}]*transform:/.test(css), true);

console.log('\n=== ⑪ v1.17 折叠分组（替代卡片）===');

// —— 结构：分组行 + 展开体 ——
const ACC_KEYS = ['book', 'include', 'exclude', 'scan', 'style', 'naming', 'write', 'dir', 'display'];
check('折叠分组 9 个', (src.match(/class="novel-acc"|class="novel-acc is-open"/g) || []).length, 9);
ACC_KEYS.forEach((k) => {
    check(`分组 data-nv-acc="${k}" 存在`, src.includes(`data-nv-acc="${k}"`), true);
    check(`分组「${k}」有右侧摘要位`, new RegExp(`data-nv-acc="${k}"[\\s\\S]{0,400}?novel-acc-summary`).test(src), true);
});
check('不折叠的动作行 2 个（过滤预览 / 导出与同步）',
    (src.match(/class="novel-acc-flat"/g) || []).length, 2);
check('初始开合不在模板里写死（书卡上不预置 is-open）',
    (src.match(/class="novel-acc is-open"/g) || []).length, 0);
check('开合由 applyNovelAccOpen 统一决定（唯一入口）',
    !!extractFn('applyNovelAccOpen'), true);
check('默认全部收起（按 settings.acc_open 恢复，不再按分组个数推导）',
    /const on = open\.has\(item\.dataset\.nvAcc\)/.test(extractFn('applyNovelAccOpen') || '')
    && !/items\.length === 1/.test(extractFn('applyNovelAccOpen') || ''), true);
check('开合状态源 = settings.acc_open（读）',
    /getSettings\(\)\.acc_open/.test(extractFn('applyNovelAccOpen') || ''), true);
check('acc_open 是默认设置项（空数组 = 全部收起）',
    /acc_open:\s*\[\]/.test(src), true);
check('面板建好后会应用开合',
    /applyNovelAccOpen\(panel\)/.test(src), true);
check('每次打开设置按持久化状态恢复开合（记忆折叠）',
    /applyNovelAccOpen\(panelEl\)/.test(src), true);
check('折叠开合变更后写回 settings.acc_open',
    /settings\.acc_open\s*=/.test(extractFn('persistNovelAccOpen') || ''), true);
check('写回后落盘（saveSettingsDebounced）',
    /saveSettingsDebounced/.test(extractFn('persistNovelAccOpen') || ''), true);
check('点击折叠标题时触发持久化',
    /persistNovelAccOpen\(panel\)/.test(extractFn('bindNovelAccordions') || ''), true);
check('展开体 aria 语义齐备（aria-expanded）',
    (src.match(/class="novel-acc-head" aria-expanded="/g) || []).length, 9);
check('折叠行标题带箭头图标（.novel-acc-chev）',
    (src.match(/novel-acc-chev/g) || []).length, 9);
check('每个分组都有对应的展开体容器',
    (src.match(/class="novel-acc-body"/g) || []).length, 9);

// —— 接线：与标签页同一条红线（只切 class，不重建 DOM）——
const accFn = extractFn('bindNovelAccordions');
check('bindNovelAccordions 定义存在', !!accFn, true);
check('折叠切换用 classList.toggle（不重建 DOM）', /classList\.toggle\('is-open'/.test(accFn || ''), true);
check('bindNovelAccordions 内无 innerHTML / removeChild（红线守卫）',
    /innerHTML|removeChild|replaceChildren/.test(accFn || ''), false);
check('同步维护 aria-expanded', /setAttribute\('aria-expanded'/.test(accFn || ''), true);
check('面板建好后同时接线标签页与折叠分组',
    /bindNovelTabs\(panel\);[\s\S]{0,200}bindNovelAccordions\(panel\)/.test(src), true);

// —— 摘要：收起时唯一的线索，每个分组都必须有当前值 ——
const sumFn = extractFn('refreshNovelAccSummaries');
check('refreshNovelAccSummaries 定义存在', !!sumFn, true);
const SUMMARY_IDS = ['novel_acc_summary_include', 'novel_acc_summary_exclude', 'novel_acc_summary_style',
    'novel_acc_summary_naming', 'novel_acc_summary_dir', 'novel_acc_summary_write',
    'novel_acc_summary_display', 'novel_acc_summary_book'];
SUMMARY_IDS.forEach((id) => {
    check(`摘要 ${id} 有刷新逻辑`, (sumFn || '').includes(id), true);
});
check('改值后摘要跟着刷新（input / change 委托）',
    /addEventListener\('input'/.test(accFn || '') && /addEventListener\('change'/.test(accFn || ''), true);
check('会话标签数走 renderTagTools 写入（不重复维护）',
    src.includes('id="novel_tag_scan_count"') && /countEl\.textContent/.test(src), true);

// —— CSS：一行 + 发丝线，没有盒子 ——
check('分组行用底部发丝线分隔（不是卡片描边）',
    /#auto-save-to-txt-settings \.novel-acc \{ border-bottom: 1px solid var\(--nv-line\); \}/.test(css), true);
check('标题行去掉按钮默认外观（无底色 / 无描边）',
    /#auto-save-to-txt-settings \.novel-acc-head \{[\s\S]*?background: none;[\s\S]*?border: none;/.test(css), true);
check('展开体默认 display:none、展开后 block',
    /\.novel-acc-body \{ display: none;/.test(css) && /\.novel-acc\.is-open \.novel-acc-body \{ display: block; \}/.test(css), true);
check('展开时箭头旋转 180°',
    /\.novel-acc\.is-open \.novel-acc-chev \{ transform: rotate\(180deg\)/.test(css), true);
check('摘要超长省略号（窄屏不撑破行）',
    /\.novel-acc-summary \{[\s\S]*?text-overflow: ellipsis;/.test(css), true);

// —— 去卡片 ④⑤⑥：剩下的盒子也全部扁平化 ——
check('去卡片 ④：状态提示条改为左侧细竖线（无底色 / 无描边）',
    /#auto-save-to-txt-settings \.novel-alert \{[\s\S]*?background: none !important;[\s\S]*?border-left: 2px solid var\(--nv-line-2\) !important;/.test(css), true);
check('去卡片 ④：各状态用左竖线颜色区分',
    /\.novel-alert\.checking \{ border-left-color: var\(--nv-dash\) !important; \}/.test(css)
    && /\.novel-alert\.warning \{ border-left-color: var\(--nv-danger\) !important; \}/.test(css)
    && /\.novel-alert\.success \{ border-left-color: var\(--nv-ok\) !important; \}/.test(css), true);
check('去卡片 ⑤：标签检测容器无框（chips 自己就是形状）',
    /#auto-save-to-txt-settings \.novel-tag-chip-list \{[\s\S]*?background: none !important;[\s\S]*?border: none !important;/.test(css), true);
check('去卡片 ⑥：部署指引内的卡片同样扁平化',
    /#auto-save-to-txt-settings \.novel-deploy-card,[\s\S]*?#auto-save-to-txt-settings \.novel-manual-card \{[\s\S]*?background: none !important;/.test(css), true);
check('状态行分隔线改实线（虚线只留给空态）',
    /#auto-save-to-txt-settings \.novel-status-line \{ border-top: 1px solid var\(--nv-line\); \}/.test(css), true);

console.log('\n=== ⑫ v1.17.1 展开体扁平化（去掉层层嵌套）===');

// 这些容器只起包裹作用，删掉后层次从「面板 > 栅格 > 分区 > 折叠行 > 展开体 > 包装 > 控件」
// 压到「面板 > 折叠行 > 展开体 > 控件」。用「不得出现」把它们钉死，防止以后再长回来。
// 比对用 classTokens()（精确类名），别用子串 —— 否则 `class="novel-form-group novel-tag-scanner"`
// 这种带副类的写法会被漏掉（第一版就这么漏了一个）。
const panelTokens = classTokens(panelTpl || '');
['novel-settings-grid', 'novel-section', 'novel-form-group', 'novel-tag-scanner',
    'novel-tag-scanner-actions', 'novel-action-buttons',
    'novel-current-book-card', 'novel-book-card-header'
].forEach((w) => {
    check(`纯包裹容器已移除：.${w}`, panelTokens.includes(w), false);
});
check('展开体里的左右排布交给类，模板内不再写内联 flex',
    /style="[^"]*display:\s*flex/.test(panelTpl || ''), false);
check('剩下的内联样式只该是 display:none / opacity 这类状态开关',
    (src.match(/style="(?![^"]*display:\s*none)(?![^"]*opacity:)[^"]*"/g) || []).length, 0);

// 三种行的样式必须真的落地，否则「扁平化」只是删了结构、内容会挤成一坨
check('信息行样式已定义（键 + 值）',
    /\.novel-info-key \{/.test(css) && /\.novel-info-val \{/.test(css), true);
check('信息行之间用发丝线分隔（不再套盒子）',
    /\.novel-info-row \{[\s\S]*?border-bottom: 1px solid var\(--nv-block-line\);/.test(css), true);
check('开关行「左标题 + 右控件」（row-reverse，跟参考图一致）',
    /\.novel-acc-body > \.checkbox_label \{[\s\S]*?flex-direction: row-reverse;/.test(css), true);
check('开关行同样靠发丝线分隔',
    /\.novel-acc-body > \.checkbox_label \{[\s\S]*?border-bottom: 1px solid var\(--nv-block-line\);/.test(css), true);
check('动作行：重新扫描按钮贴右（auto 外边距，不额外包一层）',
    /\.novel-acc-body > \.novel-acc-action \{[\s\S]*?margin: 0 0 10px auto;/.test(css), true);
check('动作行：导出/同步并排等宽，内联 flex:1 已撤掉',
    /\.novel-btn-row > \.novel-btn \{ flex: 1 1 140px; margin: 0; \}/.test(css)
    && !/style="flex: 1;"/.test(src), true);
check('部署指引行内排布改为类',
    /\.novel-guide-row \{/.test(css) && src.includes('class="novel-guide-title"'), true);
check('最后一张指引卡也扁平化（左侧竖线，不再是独立盒子）',
    /#auto-save-to-txt-settings \.novel-plan-c-card \{[\s\S]*?background: none !important;[\s\S]*?border-left: 2px solid var\(--nv-ok\) !important;/.test(css), true);

console.log(`\nUI 接线测试结果: 通过: ${pass}, 失败: ${fail}`);
if (fail > 0) process.exit(1);
console.log('所有 UI 接线与递归守卫测试全部通过！');
