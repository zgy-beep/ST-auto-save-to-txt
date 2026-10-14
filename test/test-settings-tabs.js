/**
 * 设置弹窗标签页化回归测试（v1.17）
 * 运行方式: node test/test-settings-tabs.js
 *
 * 覆盖三条必须在真实渲染下才能验证的契约：
 *   1. 五个标签 / 五个面板一一对应，初始只显示「连载」；
 *   2. 面板**全部挂载**（切到「文件」时输入框依然在 DOM 里可查），
 *      且切标签前后输入框里未提交的内容不丢 —— 这是 v1.17 的红线：
 *      禁止按标签重建 innerHTML（面板内大量 `panel.querySelector('#id')` 按 ID 现取元素，
 *      会话标签检测又是异步渲染，重建即失效）;
 *   3. 双端排布：桌面标签行在内容之上；手机端标签栏落到弹窗底部（order 重排 + sticky）。
 *
 * 依赖：playwright-core + 本机 Edge/Chrome。缺任一则跳过（不影响其它测试）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');

let playwright = null;
try {
    playwright = require('playwright-core');
} catch (e) {
    try { playwright = require('playwright'); } catch (e2) { playwright = null; }
}
if (!playwright) {
    console.log('[SKIP] 未安装 playwright-core / playwright，跳过设置弹窗标签页测试');
    console.log('       本地要跑：NODE_PATH=<node_modules 目录> node test/test-settings-tabs.js');
    process.exit(0);
}

const BROWSERS = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
];
const executablePath = BROWSERS.find((p) => fs.existsSync(p));
if (!executablePath) {
    console.log('[SKIP] 未找到 Edge / Chrome，跳过设置弹窗标签页测试');
    process.exit(0);
}

// 本机没有完整酒馆包（FontAwesome 缺失），截图里图标会渲染成空盒子、布局也跟着塌。
// 托管 node workspace 里装了 @fortawesome/fontawesome-free，优先用真字体；
// 拿不到时才退回「等尺寸色块占位」，保证测量与截图仍然真实。
let faCssPath = null;
try { faCssPath = require.resolve('@fortawesome/fontawesome-free/css/all.min.css'); } catch (e) { faCssPath = null; }
const faLink = faCssPath ? `<link rel="stylesheet" href="file:///${faCssPath.replace(/\\/g, '/')}">` : '';
const faFallback = faCssPath ? '' : `
/* FontAwesome 占位（拿不到真字体时才用）：等尺寸色块，保证字号/行高/占位一致 */
.fa-solid, .fa-regular, .fa-brands { display:inline-block; width:1em; height:1em; background:currentColor; opacity:.8; border-radius:2px; vertical-align:middle; }
`;

// —— 从 index.js 抽取真实实现 / 真实模板 ——
function extractFn(name) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    return m ? m[0] : `/* ${name}: 缺失 */`;
}
function extractConstObj(name) {
    const m = src.match(new RegExp(`const ${name} = \\{[\\s\\S]*?\\};`));
    return m ? m[0] : `const ${name} = {};`;
}
function extractTemplateAfter(anchor) {
    const seg = src.split(anchor)[1];
    if (!seg) throw new Error('找不到锚点：' + anchor);
    const m = seg.match(/innerHTML = `([\s\S]*?)`;/);
    if (!m) throw new Error('找不到模板，锚点：' + anchor);
    return m[1];
}

const modalShellTpl = extractTemplateAfter("overlay.id = 'novel_settings_modal';")
    .replace(/\$\{DEFAULT_SETTINGS\.version\}/g, '0.0.0-test');
const panelTpl = extractTemplateAfter("panel.className = 'novel-drawer-inner';");

// 面板模板里含 async 才拿得到的运行期数据，这里用桩数据渲染出真实结构
const renderPanel = new Function(
    'settings', 'initialFileName', 'initialDir', 'recentStatus',
    'return `' + panelTpl + '`;'
);
const panelHtml = renderPanel(
    {
        enabled: true, show_floating_window: true, show_embedded_toolbar: true, show_toast: true,
        include_tags: 'story', exclude_tags: 'status, ooc', chapter_style: 'numbered_floor',
        naming_rule: 'char_chat', include_user_dialogue: false, indent_paragraphs: true,
        buffer_latest_message: false, save_dir: ''
    },
    '艾莉丝 - 2026-10-14.txt',
    'SillyTavern/plugins/auto-save/logs/',
    { state: 'success', text: '第 12 章 · 艾莉丝', time: '12:34:56', file: '/logs/x.txt', chapter: 12 }
);

const FNS = [
    'positionOverlay', 'pinElementToVisibleViewport', 'getVisibleViewportBox',
    'measureHostFixedOffset', 'bindNovelTabs', 'bindNovelAccordions',
    'applyNovelAccordionDefaults', 'refreshNovelAccSummaries'
].map(extractFn).join('\n') + '\n'
    + extractConstObj('NOVEL_STYLE_SUMMARY') + '\n'
    + extractConstObj('NOVEL_NAMING_SUMMARY');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, viewport-fit=cover, initial-scale=1, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="${path.posix.join(ROOT.replace(/\\/g, '/'), 'style.css')}">
${faLink}
<style>
/* ==== 酒馆宿主 CSS（含劫持 fixed 包含块的那条 html 规则）==== */
html { -webkit-transform: translateZ(0); -webkit-backface-visibility: hidden; -webkit-perspective: 1000; }
body { margin: 0; padding: 0; width: 100%; height: 100vh; height: 100dvh; overflow: hidden; }
:root { --SmartThemeBlurTintColor: rgba(22,24,30,.97); --SmartThemeEmColor: #ddd; --SmartThemeQuoteColor: #8b6dff; }
.text_pole { background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.2); color:#eee; border-radius:4px; padding:6px 8px; font-size:13px; width:100%; box-sizing:border-box; }
.checkbox_label { display:flex; align-items:center; gap:6px; font-size:13px; }
.novel-btn { border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.06); color:#ddd; border-radius:5px; padding:7px 12px; display:inline-flex; gap:6px; }
${faFallback}
</style>
</head><body>
<script>
const MODAL_SHELL_HTML = ${JSON.stringify(modalShellTpl)};
const PANEL_HTML = ${JSON.stringify(panelHtml)};
${FNS}

let settingsModalOpenedAt = 0;
let cachedStatus = null;
let serverPluginVersion = '';
// 折叠行摘要要读连载状态（与 index.js 里的模块级变量同名同形）
let recentStatus = { state: 'success', text: '第 12 章 · 艾莉丝', time: '12:34:56', file: '/logs/x.txt', chapter: 12 };
function getSettings() { return {}; }
function saveSettingsDebounced() {}
function closeNovelSettingsModal() {}
function renderSettingsUI() {}

const overlay = document.createElement('div');
overlay.id = 'novel_settings_modal';
overlay.className = 'novel-modal-overlay';
overlay.style.display = 'none';
overlay.innerHTML = MODAL_SHELL_HTML;
document.body.appendChild(overlay);

const panel = document.createElement('div');
panel.id = 'auto-save-to-txt-settings';
panel.className = 'novel-drawer-inner';
panel.innerHTML = PANEL_HTML;
overlay.querySelector('#novel_settings_body').appendChild(panel);

// 走真实接线
bindNovelTabs(panel);
bindNovelAccordions(panel);
// 初始开合：与 index.js 挂载点一致（单分组分区默认展开）
applyNovelAccordionDefaults(panel);
refreshNovelAccSummaries(panel);
overlay.style.display = 'flex';
positionOverlay(overlay);

function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { top: +r.top.toFixed(1), left: +r.left.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1), right: +r.right.toFixed(1) };
}
function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
}
function visiblePanes() {
    return Array.from(document.querySelectorAll('.novel-tabpane')).filter(visible).map((p) => p.dataset.nvPane);
}
function visibleTabs() {
    return Array.from(document.querySelectorAll('.novel-tab')).filter((t) => t.classList.contains('is-active')).map((t) => t.dataset.nvTab);
}
function clickTab(key) {
    document.querySelector('.novel-tab[data-nv-tab="' + key + '"]').click();
}

window.__api = {
    tabCount: () => document.querySelectorAll('.novel-tab').length,
    paneCount: () => document.querySelectorAll('.novel-tabpane').length,
    visiblePanes,
    visibleTabs,
    clickTab,
    panelKeys: () => Array.from(document.querySelectorAll('.novel-tabpane')).map((p) => p.dataset.nvPane).join(','),
    // 红线探针：面板是否一直挂在 DOM 里（切到别的标签后依然能按 ID 查到）
    mountedIds: () => ['novel_save_enabled', 'novel_show_floating_window', 'novel_show_embedded_toolbar',
        'novel_show_toast', 'novel_include_tags', 'novel_exclude_tags', 'novel_chapter_style',
        'novel_naming_rule', 'novel_include_user', 'novel_indent_paragraphs', 'novel_buffer_latest',
        'novel_save_dir', 'novel_export_all_btn', 'novel_sync_all_btn', 'novel_test_btn',
        'novel_preview_btn', 'novel_rescan_tags_btn', 'novel_copy_filepath_btn']
        .filter((id) => !!document.getElementById(id)).length,
    // 主开关必须在任何标签下都可见
    mainSwitchVisible: () => visible(document.getElementById('novel_save_enabled')),
    // 输入内容在切标签往返后必须还在（红线：不许重建 innerHTML）
    typeAndRoundTrip: (text) => {
        clickTab('filter');
        const input = document.getElementById('novel_include_tags');
        input.value = text;
        clickTab('file');
        clickTab('filter');
        const same = document.getElementById('novel_include_tags');
        return { sameNode: same === input, value: same.value };
    },
    // 焦点是否还在同一个输入框上（重建 DOM 会立刻丢焦点）
    // 注意：折叠分组默认收起，收起体 display:none 时不可聚焦，必须先展开 —— 顺便也就验了折叠接线
    focusRoundTrip: () => {
        clickTab('filter');
        document.querySelector('.novel-acc[data-nv-acc="include"] .novel-acc-head').click();
        const input = document.getElementById('novel_include_tags');
        input.focus();
        const before = document.activeElement === input;
        clickTab('file');
        clickTab('filter');
        return { before, after: document.activeElement === document.getElementById('novel_include_tags') };
    },
    // ---- 折叠分组 ----
    accKeys: () => Array.from(document.querySelectorAll('.novel-acc')).map((a) => a.dataset.nvAcc).join(','),
    flatCount: () => document.querySelectorAll('.novel-acc-flat').length,
    openAccordions: () => Array.from(document.querySelectorAll('.novel-acc.is-open')).map((a) => a.dataset.nvAcc),
    clickAcc: (key) => document.querySelector('.novel-acc[data-nv-acc="' + key + '"] .novel-acc-head').click(),
    accState: (key) => {
        const item = document.querySelector('.novel-acc[data-nv-acc="' + key + '"]');
        const head = item.querySelector('.novel-acc-head');
        const body = item.querySelector('.novel-acc-body');
        const chev = item.querySelector('.novel-acc-chev');
        return {
            open: item.classList.contains('is-open'),
            aria: head.getAttribute('aria-expanded'),
            bodyVisible: body.getBoundingClientRect().height > 0,
            chevRotation: getComputedStyle(chev).transform
        };
    },
    summaries: () => ({
        include: document.getElementById('novel_acc_summary_include').textContent,
        exclude: document.getElementById('novel_acc_summary_exclude').textContent,
        style: document.getElementById('novel_acc_summary_style').textContent,
        naming: document.getElementById('novel_acc_summary_naming').textContent,
        dir: document.getElementById('novel_acc_summary_dir').textContent,
        write: document.getElementById('novel_acc_summary_write').textContent,
        display: document.getElementById('novel_acc_summary_display').textContent,
        book: document.getElementById('novel_acc_summary_book').textContent
    }),
    // 改一个值，看摘要有没有跟着变（收起状态下的唯一线索）
    setInclude: (v) => {
        const el = document.getElementById('novel_include_tags');
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return document.getElementById('novel_acc_summary_include').textContent;
    },
    toggleDisplaySwitch: () => {
        const el = document.getElementById('novel_show_toast');
        el.checked = !el.checked;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return document.getElementById('novel_acc_summary_display').textContent;
    },
    // 标签激活态的诊断探针（真实计算样式，避免只靠肉眼判断截图）
    tabStyles: () => Array.from(document.querySelectorAll('.novel-tab')).map((t) => ({
        key: t.dataset.nvTab,
        active: t.classList.contains('is-active'),
        bg: getComputedStyle(t).backgroundColor,
        border: getComputedStyle(t).borderTopColor
    })),
    rects: () => {
        const tabs = document.querySelector('.novel-tabs');
        const panes = document.querySelector('.novel-tabpanes');
        const modal = document.querySelector('.novel-modal-settings');
        const modalBody = document.getElementById('novel_settings_body');
        const activeTab = document.querySelector('.novel-tab.is-active');
        const activeSection = document.querySelector('.novel-tabpane.is-active .novel-section');
        return {
            tabs: rectOf(tabs), tabsOrder: getComputedStyle(tabs).order, tabsPos: getComputedStyle(tabs).position,
            panes: rectOf(panes), panesOrder: getComputedStyle(panes).order,
            modal: rectOf(modal), modalBody: rectOf(modalBody),
            section: activeSection ? rectOf(activeSection) : null,
            gridCols: getComputedStyle(document.querySelector('.novel-settings-grid')).gridTemplateColumns,
            bodyPad: getComputedStyle(modalBody).padding,
            bodyBox: getComputedStyle(modalBody).boxSizing,
            activeTab: rectOf(activeTab), vw: window.innerWidth, vh: window.innerHeight
        };
    }
};
</script>
</body></html>`;

const harnessPath = path.join(os.tmpdir(), 'st-novel-settings-tabs-test.html');
fs.writeFileSync(harnessPath, HTML);

function fullyInside(r, w, h) { return r.left >= -1 && r.top >= -1 && r.right <= w + 1 && r.bottom <= h + 1; }

/** 点标签后等背景过渡（0.15s）走完再测量/截图，否则会读到「旧标签还在淡出」的中间态 */
async function clickTab(page, key) {
    await page.evaluate((k) => window.__api.clickTab(k), key);
    await page.waitForTimeout(260);
}

(async () => {
    let pass = 0;
    let fail = 0;
    const failList = [];
    function check(name, actual, expected) {
        if (actual === expected) { pass++; console.log(`[PASS] ${name}`); }
        else { fail++; failList.push(name); console.error(`[FAIL] ${name}: 期望 ${expected}，实际 ${actual}`); }
    }

    const browser = await playwright.chromium.launch({ executablePath, headless: true });
    try {
        const pageErrors = [];

        // ---------------- 桌面端 1280×900 ----------------
        const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const dpage = await dctx.newPage();
        dpage.on('pageerror', (e) => pageErrors.push('desktop: ' + e.message));
        await dpage.goto('file:///' + harnessPath.replace(/\\/g, '/'), { waitUntil: 'load' });
        await dpage.waitForTimeout(300);

        console.log('=== ① 标签 / 面板结构与初始状态（1280×900）===');
        check('五个标签', await dpage.evaluate(() => window.__api.tabCount()), 5);
        check('五个面板', await dpage.evaluate(() => window.__api.paneCount()), 5);
        check('面板键顺序 = serial,filter,format,file,general',
            await dpage.evaluate(() => window.__api.panelKeys()), 'serial,filter,format,file,general');
        check('初始只显示「连载」面板', (await dpage.evaluate(() => window.__api.visiblePanes())).join(','), 'serial');
        check('初始只有「连载」标签为激活态', (await dpage.evaluate(() => window.__api.visibleTabs())).join(','), 'serial');

        console.log('\n=== ② 红线：面板全部挂载、切标签不丢内容 ===');
        const allIds = await dpage.evaluate(() => window.__api.mountedIds());
        check('18 个控件全部常驻 DOM（含未激活面板里的）', allIds, 18);
        await clickTab(dpage, 'file');
        const idsAfterSwitch = await dpage.evaluate(() => window.__api.mountedIds());
        check('切到「文件」后其它面板控件仍在 DOM 中', idsAfterSwitch, 18);
        check('切到「文件」后只显示「文件」面板',
            (await dpage.evaluate(() => window.__api.visiblePanes())).join(','), 'file');
        const rt = await dpage.evaluate(() => window.__api.typeAndRoundTrip('story, response'));
        check('切标签往返后仍指向同一个 DOM 节点（未重建 innerHTML）', rt.sameNode, true);
        check('切标签往返后输入内容完好', rt.value, 'story, response');
        const fr = await dpage.evaluate(() => window.__api.focusRoundTrip());
        check('切标签往返后焦点仍落在同一输入框', fr.before && fr.after, true);

        console.log('\n=== ③ 主开关在每个标签下都可见 ===');
        for (const key of ['serial', 'filter', 'format', 'file', 'general']) {
            await clickTab(dpage, key);
            check(`「${key}」标签下主开关可见`, await dpage.evaluate(() => window.__api.mainSwitchVisible()), true);
        }

        console.log('\n=== ④ 桌面端排布：标签行在内容之上 ===');
        await clickTab(dpage, 'serial');
        const dr = await dpage.evaluate(() => window.__api.rects());
        check('标签行位于面板内容之上', dr.tabs.bottom <= dr.panes.top + 1, true);
        check('标签行整体落在可见视口内', fullyInside(dr.tabs, dr.vw, dr.vh), true);
        check('激活标签在标签行内', dr.activeTab.left >= dr.tabs.left - 1 && dr.activeTab.right <= dr.tabs.right + 1, true);
        check('桌面端标签栏未吸附底部（position 非 sticky）', dr.tabsPos, 'static');
        check('弹窗完整落在可见视口内', fullyInside(dr.modal, dr.vw, dr.vh), true);
        // 居中：弹窗几何中心必须贴住可见视口中心（±2px 容差留给边框取整）
        check('弹窗在可见视口内水平居中',
            Math.abs((dr.modal.left + dr.modal.right) / 2 - dr.vw / 2) <= 2, true);
        check('弹窗在可见视口内垂直居中',
            Math.abs((dr.modal.top + dr.modal.bottom) / 2 - dr.vh / 2) <= 2, true);
        // 单列：每个标签里只有 1 个分区，双列会让右半列整片空着（看起来像内容没居中）
        check('分区栅格退化为单列', dr.gridCols.trim().split(/\s+/).length, 1);
        check('分区铺满弹窗内容区（不再只占左半列）',
            dr.section && dr.section.right - dr.section.left > dr.modal.w - 60, true);

        await dpage.screenshot({ path: path.join(ROOT, 'temp', 'shot-v117-desktop-serial.png') });
        await clickTab(dpage, 'filter');
        // 标签激活态：类名正确不代表样式正确，这里按真实计算样式核对，
        // 同时也是对「过渡动画跑完后激活态只落在一处」的回归守卫
        const tabStyleList = await dpage.evaluate(() => window.__api.tabStyles());
        const activeStyles = tabStyleList.filter((s) => s.active);
        check('样式层面激活态只落在一个标签上', activeStyles.length, 1);
        check('激活标签背景为紫罗兰淡底', /139, 109, 255/.test(activeStyles[0] ? activeStyles[0].bg : ''), true);
        check('非激活标签背景完全透明',
            tabStyleList.filter((s) => !s.active).every((s) => s.bg === 'rgba(0, 0, 0, 0)'), true);
        await dpage.screenshot({ path: path.join(ROOT, 'temp', 'shot-v117-desktop-filter.png') });
        await dctx.close();

        // ---------------- 手机端 390×844 ----------------
        const mctx = await browser.newContext({
            viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
        });
        const mpage = await mctx.newPage();
        mpage.on('pageerror', (e) => pageErrors.push('mobile: ' + e.message));
        await mpage.goto('file:///' + harnessPath.replace(/\\/g, '/'), { waitUntil: 'load' });
        await mpage.waitForTimeout(300);

        console.log('\n=== ⑤ 手机端排布：标签栏落到弹窗底部（390×844）===');
        const mr = await mpage.evaluate(() => window.__api.rects());
        console.log('       手机端实测矩形：' + JSON.stringify(mr));
        check('手机端标签栏用 sticky 吸附', mr.tabsPos, 'sticky');
        check('手机端标签栏排在内容之后（order 重排生效）',
            Number(mr.tabsOrder) > Number(mr.panesOrder), true);
        check('手机端标签栏位于面板内容之下', mr.tabs.top >= mr.panes.top, true);
        check('手机端标签栏贴住弹窗底部', Math.abs(mr.tabs.bottom - mr.modal.bottom) <= 2, true);
        check('手机端标签栏完整落在可见视口内', fullyInside(mr.tabs, mr.vw, mr.vh), true);
        check('手机端弹窗完整落在可见视口内', fullyInside(mr.modal, mr.vw, mr.vh), true);
        check('手机端标签仍然 5 个', await mpage.evaluate(() => window.__api.tabCount()), 5);

        await mpage.screenshot({ path: path.join(ROOT, 'temp', 'shot-v117-mobile-serial.png') });
        await clickTab(mpage, 'filter');
        await mpage.screenshot({ path: path.join(ROOT, 'temp', 'shot-v117-mobile-filter.png') });
        await clickTab(mpage, 'general');
        await mpage.screenshot({ path: path.join(ROOT, 'temp', 'shot-v117-mobile-general.png') });
        check('手机端切到「通用」后只显示通用面板',
            (await mpage.evaluate(() => window.__api.visiblePanes())).join(','), 'general');
        await mctx.close();

        check('页面无运行报错', pageErrors.length === 0 ? 'none' : pageErrors.join(' | '), 'none');

        // ---------------- ⑥ 折叠分组（替代卡片） ----------------
        console.log('\n=== ⑥ 折叠分组（替代卡片）===');
        const fctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        const fpage = await fctx.newPage();
        fpage.on('pageerror', (e) => pageErrors.push('accordion: ' + e.message));
        await fpage.goto('file:///' + harnessPath.replace(/\\/g, '/'), { waitUntil: 'load' });
        await fpage.waitForTimeout(300);
        // 折叠体的可见性要在激活面板里量（隐藏标签里的元素 rect 恒为 0）
        await clickTab(fpage, 'filter');

        check('折叠分组共 9 个（连载 1 + 过滤 3 + 排版 3 + 文件 1 + 通用 1）',
            await fpage.evaluate(() => window.__api.accKeys()),
            'book,include,exclude,scan,style,naming,write,dir,display');
        check('不折叠的动作行 2 个（过滤预览、导出与同步）',
            await fpage.evaluate(() => window.__api.flatCount()), 2);
        // 初始开合规则：单分组分区（连载 / 文件 / 通用）展开，多分组分区（过滤 / 排版）收起
        check('单分组分区默认展开、多分组分区默认收起',
            (await fpage.evaluate(() => window.__api.openAccordions())).join(','), 'book,dir,display');
        check('多分组分区（过滤）里 3 个分组全部收起',
            await fpage.evaluate(() => ['include', 'exclude', 'scan']
                .every((k) => window.__api.accState(k).bodyVisible === false)), true);

        const closed = await fpage.evaluate(() => window.__api.accState('include'));
        check('收起时 aria-expanded=false', closed.aria, 'false');
        check('收起时展开体不可见', closed.bodyVisible, false);

        await fpage.evaluate(() => window.__api.clickAcc('include'));
        await fpage.waitForTimeout(260);
        const opened = await fpage.evaluate(() => window.__api.accState('include'));
        check('点击标题行后 is-open', opened.open, true);
        check('展开后 aria-expanded=true', opened.aria, 'true');
        check('展开后内容可见', opened.bodyVisible, true);
        check('展开后箭头旋转 180°', /matrix\(-1,\s*0,\s*0,\s*-1/.test(opened.chevRotation), true);
        check('展开时输入框可聚焦（正文可交互）',
            await fpage.evaluate(() => {
                const i = document.getElementById('novel_include_tags');
                i.focus();
                return document.activeElement === i;
            }), true);

        await fpage.evaluate(() => window.__api.clickAcc('include'));
        await fpage.waitForTimeout(260);
        check('再点一次可收起', (await fpage.evaluate(() => window.__api.accState('include'))).bodyVisible, false);

        // 摘要是「收起也能看出当前值」的唯一线索，必须真实反映当前设置
        const sums = await fpage.evaluate(() => window.__api.summaries());
        check('白名单摘要 = 当前值', sums.include, 'story');
        check('黑名单摘要 = 当前值', sums.exclude, 'status, ooc');
        check('章节风格摘要 = 短名', sums.style, '第 X 章 · 角色名（带楼层）');
        check('命名规则摘要 = 短名', sums.naming, '角色名 - 对话名');
        check('保存位置摘要 = 默认目录', /默认目录/.test(sums.dir), true);
        check('阅读与写入摘要 = 已开启 1/3（仅段落缩进默认开启）', sums.write, '已开启 1/3');
        check('界面显示摘要 = 已开启 3/3', sums.display, '已开启 3/3');
        check('连载文件摘要 = 最近状态', sums.book, '第 12 章 · 艾莉丝');

        check('改白名单后摘要跟着变',
            await fpage.evaluate(() => window.__api.setInclude('story, response')), 'story, response');
        check('切换开关后摘要跟着变',
            await fpage.evaluate(() => window.__api.toggleDisplaySwitch()), '已开启 2/3');

        // 折叠体里的控件必须与折叠无关地常驻 DOM（切标签/折叠都不重建）
        check('折叠收起时控件仍在 DOM 中', await fpage.evaluate(() => window.__api.mountedIds()), 18);

        await fctx.close();
        check('折叠分组测试期间无运行报错', pageErrors.length === 0 ? 'none' : pageErrors.join(' | '), 'none');
    } finally {
        await browser.close();
        try { fs.unlinkSync(harnessPath); } catch (e) { /* 忽略 */ }
    }

    function getOrderOf() { return '0'; } // 面板容器未设 order，默认 0

    console.log(`\n设置弹窗标签页测试结果: 通过: ${pass}, 失败: ${fail}`);
    if (fail > 0) {
        console.error('失败用例：' + failList.join('；'));
        process.exit(1);
    }
    console.log('标签结构、面板常驻、双端排布全部符合预期');
})().catch((e) => {
    console.error('[FAIL] 测试执行异常：' + (e && e.message));
    process.exit(1);
});
