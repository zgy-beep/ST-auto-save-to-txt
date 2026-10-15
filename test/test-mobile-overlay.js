/**
 * 移动端浮层可见性回归测试（v1.16「悬浮窗/弹窗跑到屏幕外」事故）
 * 运行方式: node test/test-mobile-overlay.js
 *
 * 事故背景
 *   SillyTavern release 分支的 public/style.css 里有：
 *       html { -webkit-transform: translateZ(0); -webkit-backface-visibility: hidden;
 *              -webkit-perspective: 1000 }
 *   按 CSS 规范，html 上的 transform 会让它成为 position:fixed 子元素的包含块 ——
 *   fixed 不再钉住「可见视口」，而是钉住「文档盒子」。桌面端两者恒等所以看不出来；
 *   手机端 URL 栏 / 软键盘会让两者脱节（100dvh 大于可见高、或文档被顶起一截），
 *   此时用 `bottom: 74px`（悬浮药丸）与 `inset: 0`（弹窗）直接描述几何就会整块落到
 *   可见区之外 —— 用户报的「手机端悬浮窗与弹窗都不显示」。
 *
 * 本测试在真实宿主条件下（把上面那条 html 规则原样搬进来）渲染真实的浮层 DOM，
 * 逐场景断言：设置弹窗 / 过滤预览弹窗 / 悬浮药丸在屏幕上必须完整落在「可见视口」内，
 * 且手机端药丸必须让开底部常驻输入栏。
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
    console.log('[SKIP] 未安装 playwright-core / playwright，跳过移动端浮层可见性测试');
    console.log('       本地要跑：NODE_PATH=<node_modules 目录> node test/test-mobile-overlay.js');
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
    console.log('[SKIP] 未找到 Edge / Chrome，跳过移动端浮层可见性测试');
    process.exit(0);
}

// —— 从 index.js 抽取真实实现，保证测的是同一份代码 ——
function extractFn(name) {
    const m = src.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    return m ? m[0] : `/* ${name}: 缺失 */`;
}
function extractTemplate(anchor, tag) {
    const seg = src.split(anchor)[1];
    if (!seg) throw new Error('找不到锚点：' + anchor);
    const m = seg.match(/innerHTML = `([\s\S]*?)`;/);
    if (!m) throw new Error('找不到模板：' + tag);
    return m[1].replace(/\$\{DEFAULT_SETTINGS\.version\}/g, '0.0.0-test');
}

const settingsModalHtml = extractTemplate("overlay.id = 'novel_settings_modal';", 'settings');
const fwHtml = extractTemplate('function buildFloatingWindow', 'floating');

const FNS = [
    'positionOverlay', 'pinElementToVisibleViewport', 'getVisibleViewportBox',
    'measureHostFixedOffset', 'clampFloatPos', 'applyFloatPos', 'getUserFloatPos',
    'isFloatPosUsableForViewport', 'floatBottomClearance', 'readFloatGap',
    'measureSafeAreaBottom', 'keepFloatWindowInsideViewport', 'ensureFloatingWindowVisible',
    'ensureFloatPosEventually', 'getDocScrollTop', 'ensureTopLayer', 'mountInTopLayer'
].map(extractFn).join('\n');

const HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, viewport-fit=cover, initial-scale=1, maximum-scale=1.0, user-scalable=no, interactive-widget=resizes-content">
<link rel="stylesheet" href="${path.posix.join(ROOT.replace(/\\/g, '/'), 'style.css')}">
<style>
/* ==== 酒馆宿主 CSS（原样抄自 release，含劫持 fixed 包含块的那条 html 规则）==== */
html { -webkit-transform: translateZ(0); -webkit-backface-visibility: hidden; -webkit-perspective: 1000; }
body { margin: 0; padding: 0; width: 100%; height: 100vh; height: 100dvh; overflow: hidden; }
:root { --SmartThemeBlurTintColor: rgba(22,24,30,.97); --SmartThemeEmColor: #ddd; --SmartThemeQuoteColor: #8b6dff; }
.text_pole { background: rgba(0,0,0,.25); border: 1px solid rgba(255,255,255,.2); color:#eee; border-radius:4px; padding:6px 8px; font-size:13px; width:100%; box-sizing:border-box; }
.checkbox_label { display:flex; align-items:center; gap:6px; font-size:13px; }
.novel-btn { border:1px solid rgba(255,255,255,.2); background:rgba(255,255,255,.06); color:#ddd; border-radius:5px; padding:7px 12px; display:inline-flex; gap:6px; }

/* ==== 宿主 UI 元素（v1.17.4 新增）====
 * 之前这个测试页只有 html 的 transform 规则、**没有任何宿主 UI**，
 * 于是「浮层被酒馆界面盖住」这个致命 bug 永远测不出来 ——
 * 空文档里 z-index auto 的载体照样压在最上面。
 * 酒馆真实量级：顶栏/底栏 29998~29999，遮罩 100（扩展用 1e6 系列本应稳赢，
 * 但 html 的 transform 让它变成了一个层叠上下文，dialog 载体困在里面出不去）。
 * 这几个元素是**不透明**的，命中测试能直接判定谁在上层。 */
.stui { position: fixed; }
#stui-top    { top: 0; left: 0; right: 0; height: 40px; background: #ff0000; z-index: 29999; }
#stui-sheld  { inset: 0; background: #00ff00; z-index: 100; }
#stui-drawer { bottom: 0; left: 0; right: 0; height: 74px; background: #0000ff; z-index: 29998; }
#stui-toast  { top: 50px; right: 10px; width: 120px; height: 40px; background: #00ff00; z-index: 29997; }
</style>
</head><body>
<div class="stui" id="stui-top"></div>
<div class="stui" id="stui-sheld"></div>
<div class="stui" id="stui-toast"></div>
<div class="stui" id="stui-drawer"></div>
<script>
const SETTINGS_MODAL_HTML = ${JSON.stringify(settingsModalHtml)};
const FW_HTML = ${JSON.stringify(fwHtml)};
${FNS}
let STUB = { float_pos: null, show_floating_window: true };
function getSettings() { return STUB; }
let fwDrag = { active: false };
let cachedSafeAreaBottom = null;

const VPB = (typeof getVisibleViewportBox === 'function') ? getVisibleViewportBox : () => ({ width: window.innerWidth, height: window.innerHeight });
const GAP = (typeof readFloatGap === 'function') ? readFloatGap : () => ({ bottom: 12, right: 12 });
const SCROLLTOP = (typeof getDocScrollTop === 'function') ? getDocScrollTop : () => { const se = document.scrollingElement || document.documentElement; return se ? (se.scrollTop || 0) : 0; };

function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { top: +r.top.toFixed(1), left: +r.left.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), bottom: +r.bottom.toFixed(1), right: +r.right.toFixed(1) };
}
function fullyInside(r, w, h) { return r.left >= -0.6 && r.top >= -0.6 && r.right <= w + 0.6 && r.bottom <= h + 0.6; }

function scenario(name) {
    document.querySelectorAll('#novel_settings_modal,#novel_preview_modal,#novel-floating-window,dialog.novel-tl').forEach(n => {
        try { n.close(); } catch { /* 非 dialog */ }
        n.remove();
    });
    document.getElementById('nv-env-killer')?.remove();
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    STUB.float_pos = null;

    // 场景 J：视口暂时量不到（页面刚加载 / 切回后台标签时 innerWidth 会短暂为 0）。
    // 老代码在 applyFloatPos 里遇到 vp 为 0 直接 return，什么都不做，而且没有事件会通知它重试。
    if (name.includes('novp')) window.__breakViewportFor(3);

    // 模拟「手机端锚点声明整体失效」：某些浏览器 / App 内置 WebView 不认 env()，
    // bottom: calc(74px + env(...)) 会在 computed-value 阶段整条作废 → bottom 回退 auto；
    // 若 right 也一并失效，position:fixed 的药丸就落到「静态位置」= body 流末尾。
    // 这里用 bottom/right: auto !important 复现该终态。
    if (name.includes('noenv')) {
        // 撑出一个真实的文档流（模拟酒馆里 #chat / #send_form 撑着高度），
        // 让药丸的静态位置落在屏幕之外，而不是仅仅跑到左上角。
        const spacer = document.createElement('div');
        spacer.style.cssText = 'height:' + Math.round(window.innerHeight * 1.9) + 'px;';
        document.body.appendChild(spacer);
        const killer = document.createElement('style');
        killer.id = 'nv-env-killer';
        killer.textContent = '.novel-floating-window { bottom: auto !important; right: auto !important; }';
        document.head.appendChild(killer);
    }
    if (name.includes('tall')) document.body.style.height = Math.round(window.innerHeight * 1.25) + 'px';
    if (name.includes('scrolled')) {
        document.body.style.height = Math.round(window.innerHeight * 1.6) + 'px';
        (document.scrollingElement || document.documentElement).scrollTop = 180;
    }
    if (name.includes('crossdevice')) STUB.float_pos = { left: 1140, top: 720, vw: 1280 };
    if (name.includes('sameDevice')) STUB.float_pos = { left: 250, top: 700, vw: window.innerWidth };
    if (name.includes('vanilla')) {
        document.documentElement.style.transform = 'none';
        document.documentElement.style.webkitTransform = 'none';
        document.documentElement.style.perspective = 'none';
        document.documentElement.style.webkitPerspective = 'none';
    }

    const overlay = document.createElement('div');
    overlay.id = 'novel_settings_modal';
    overlay.className = 'novel-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = SETTINGS_MODAL_HTML;
    // v1.17.3：与产品一致，浮层挂进 top-layer 载体
    mountInTopLayer('novel-tl-settings', overlay);

    const pv = document.createElement('div');
    pv.id = 'novel_preview_modal';
    pv.className = 'novel-modal-overlay';
    pv.style.display = 'none';
    pv.innerHTML = '<div class="novel-modal novel-modal-preview"><div class="novel-modal-header"><b class="novel-modal-title">x</b></div><div class="novel-modal-body novel-mv-body"><div class="novel-mv-grid"><section class="novel-mv-col is-clean"><div class="novel-mv-text">t</div></section></div></div></div>';
    mountInTopLayer('novel-tl-preview', pv);

    const win = document.createElement('div');
    win.id = 'novel-floating-window';
    win.className = 'novel-floating-window';
    win.innerHTML = FW_HTML;
    mountInTopLayer('novel-tl-floating', win);

    overlay.style.display = 'flex';
    positionOverlay(overlay);
    pv.style.display = 'flex';
    positionOverlay(pv);
    const done = { vpbroke: !!name.includes('novp') };
    // 视口量不到的场景要走产品里的有界重试（产品代码在 refreshFloatingWindow 里调它）
    if (name.includes('novp')) done.resolved = ensureFloatPosEventually();
    else applyFloatPos();
    return { win, overlay, pv, done };
}

function measure(win, overlay, pv, done) {
    const vp = VPB();
    const gap = GAP(win);
    const out = {
        modal: rectOf(overlay.querySelector('.novel-modal')),
        preview: rectOf(pv.querySelector('.novel-modal')),
        fw: rectOf(win),
        vp: { w: +vp.width.toFixed(1), h: +vp.height.toFixed(1) },
        gapBottom: gap.bottom,
        scrollTop: SCROLLTOP()
    };
    out.modalOk = fullyInside(out.modal, vp.width, vp.height);
    out.previewOk = fullyInside(out.preview, vp.width, vp.height);
    out.fwOk = fullyInside(out.fw, vp.width, vp.height);
    // 药丸是否被「屏幕坐标硬放」接管（applyFloatPos 的默认分支会把 left 写成 auto）
    out.fwForced = !!win.style.left && win.style.left !== 'auto';
    // 锚点：不论走哪条分支，最终都必须贴在右下角（而不是被顶到左上角 / 屏幕中央）
    out.fwAnchored = out.fw.right >= vp.width - 40 && out.fw.bottom >= vp.height * 0.6;
    // 手机端额外要求：药丸要让开底部常驻输入栏
    out.fwAboveInput = out.fw.bottom <= vp.height - Math.min(gap.bottom, 74) + 0.6;
    out.phoneGap = gap.bottom > 20;
    // ---- v1.17.3 top layer 专项 ----
    // 浮层必须挂在 <dialog class="novel-tl"> 里（非模态 show()，不进 top layer 就前功尽弃）
    const tlOf = (el) => (el.closest ? el.closest('dialog.novel-tl') : null);
    out.tlFloating = !!tlOf(win);
    out.tlSettings = !!tlOf(overlay);
    out.tlPreview = !!tlOf(pv);
    // 载体必须已 show()（open 属性），否则 dialog 是 display:none，什么都看不见
    out.tlOpen = [out.tlFloating, out.tlSettings, out.tlPreview]
        .map((ok, i) => (ok ? tlOf([win, overlay, pv][i]).open : false))
        .every(Boolean);
    // 载体不能是模态（showModal 会给文档加 inert → 药丸在弹窗打开时点不到）
    out.tlNotModal = !document.querySelector('dialog.novel-tl[open]')?.matches(':modal');
    // 载体铺满视口（内层 absolute 的解析基准就是它）
    const layer = tlOf(win);
    if (layer) {
        const lr = layer.getBoundingClientRect();
        out.tlBox = { w: +lr.width.toFixed(1), h: +lr.height.toFixed(1) };
        out.tlCoversViewport = Math.abs(lr.width - vp.width) <= 1 && Math.abs(lr.height - vp.height) <= 1;
    } else {
        out.tlBox = { w: 0, h: 0 };
        out.tlCoversViewport = false;
    }
    // 载体不吃指针事件（否则透明 dialog 会把整个页面挡死）
    out.tlClickThrough = getComputedStyle(layer || document.body).pointerEvents === 'none'
        || out.tlCoversViewport === false;
    // 药丸在 top layer 里 → 坐标系就是视口，不该再有任何补偿 transform
    out.fwNoCompensation = (win.style.transform || '') === '';
    // 药丸真实可点（elementFromPoint 命中它，而不是被透明载体吃掉）
    const hit = document.elementFromPoint(out.fw.left + 8, out.fw.top + out.fw.h / 2);
    out.fwHittable = !!(hit && win.contains(hit));
    // 载体不能加 contain:strict —— 其 paint 包含会裁剪溢出内容，
    // 曾经导致设置弹窗正文滚不动（scrollTop 写进去读回 0）。这里钉死这条负面约束。
    out.tlNoContain = !layer || getComputedStyle(layer).contain === 'none';
    // ---- v1.17.4 层叠专项：浮层必须真的盖在宿主 UI 上面 ----
    // 背景：html 的 transform 不只劫持 fixed 的包含块，还让 html 成为**层叠上下文**；
    // dialog show() 后绘制仍困在这个上下文里比较，载体 z-index:auto（=0）输给宿主 29999，
    // 症状是「弹窗显示在酒馆界面后面」。本页已补上 .stui 宿主元素来复现该冲突。
    // 命中测试：命中自己的浮层 = 在最上层；命中 stui-* = 被盖住。
    //
    // ⚠️ 探针必须打在**设置弹窗独有**的位置，且判定归属要用 closest('#novel_settings_modal')：
    // ① 预览弹窗也铺满视口且同样在 top layer，用「视口中心」取点会命中它；
    // ② 两个弹窗都带 .novel-modal-header，直接 contains 会命中「另一个弹窗的同名节点」；
    // ③ 测试页里两个弹窗是同时打开的（真实产品里互斥），所以**只比「浮层 vs 宿主 UI」**，
    //    不比浮层之间的先后 —— 那不是层叠契约。
    const probePoint = (el, sel, fallbackDy) => {
        const target = el.querySelector(sel);
        if (target) {
            const r = target.getBoundingClientRect();
            if (r.width > 4 && r.height > 4) return { x: r.left + r.width / 2, y: r.top + r.height / 2, target };
        }
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + (fallbackDy || 24), target: el };
    };
    const mPt = probePoint(overlay, '.novel-modal-settings .novel-modal-header');
    const fPt = probePoint(win, '.novel-fw-pill');
    // 宿主 UI 探针：绿遮罩铺满全屏，任何点都该命中它（除非被浮层盖住）
    const hitM = document.elementFromPoint(mPt.x, mPt.y);
    const hitF = document.elementFromPoint(fPt.x, fPt.y);
    // 药丸：它的载体是最早 show 的，测试页里下面还压着两个弹窗，
    // 因此只在「未被弹窗覆盖」时判定层叠 —— 用药丸自身不与弹窗重叠的点。
    out.fwOnTop = !!(hitF && win.contains(hitF));
    // 设置弹窗：在它自己那层，判定「命中的是自己 或 自己下层的宿主UI之外的东西」都不算被盖住。
    // 严格判据 = 命中点不是宿主 UI（stui-*）。这才是层叠契约本身。
    out.modalOnTop = !!(hitM && !(hitM.id && hitM.id.startsWith('stui-')));
    // 载体与内层的 z-index 都必须写死顶层值（实测：只加内层完全无效）
    out.layerZ = layer ? getComputedStyle(layer).zIndex : '';
    out.innerZ = layer ? getComputedStyle(overlay).zIndex : '';
    out.zIndexTop = out.layerZ === '2147483647' && out.innerZ === '2147483647';
    // 命中点不能落在宿主元素上（双保险：即使 contains 判定漏了也拦得住）
    out.notBehindHost = !(hitF && hitF.id && hitF.id.startsWith('stui-'))
        && !(hitM && hitM.id && hitM.id.startsWith('stui-'));
    out.hostHitIds = [hitF && hitF.id, hitM && hitM.id].filter(Boolean).join(',');
    out.modalProbe = { probeOn: mPt.target.className, hitClass: hitM && (typeof hitM.className === 'string' ? hitM.className : ''),
        closestSettings: hitM && hitM.closest && hitM.closest('#novel_settings_modal') ? 'YES' : 'NO' };

    out.allOk = out.modalOk && out.previewOk && out.fwOk && out.fwAnchored
        && (!out.phoneGap || out.fwAboveInput)
        && out.tlFloating && out.tlSettings && out.tlPreview
        && out.tlOpen && out.tlNotModal && out.tlCoversViewport
        && out.fwNoCompensation && out.fwHittable && out.tlNoContain
        && out.fwOnTop && out.modalOnTop && out.zIndexTop && out.notBehindHost;
    return out;
}
// 视口故障注入：前 n 次 getVisibleViewportBox() 返回 0×0，模拟页面刚加载 / 后台标签
window.__breakViewportFor = (n) => {
    const orig = window.getVisibleViewportBox;
    let left = n;
    window.getVisibleViewportBox = () => (left-- > 0 ? { width: 0, height: 0 } : orig());
};
window.__run = async (key) => {
    const parts = scenario(key);
    if (parts.done.resolved) await parts.done.resolved;
    return measure(parts.win, parts.overlay, parts.pv, parts.done);
};
</script>
</body></html>`;

const harnessPath = path.join(os.tmpdir(), 'st-novel-mobile-overlay-test.html');
fs.writeFileSync(harnessPath, HTML);

const SCENARIOS = [
    ['A 默认（手机竖屏）', 'A-fresh'],
    ['B 宿主盒子高于可见区（100dvh 大于可见高）', 'B-tall-body'],
    ['C 文档被顶起一截（键盘/焦点滚动）', 'C-scrolled-doc'],
    ['D 跨设备旧坐标（桌面拖到 1140,720）', 'D-crossdevice-pos'],
    ['E 本设备正常拖拽坐标', 'E-sameDevice-pos'],
    ['F 宿主盒子高于可见区 + 文档被顶起', 'F-tall-scrolled'],
    ['G 普通宿主（无 html transform）', 'G-vanilla-host'],
    ['H 普通宿主 + 盒子高于可见区', 'H-vanilla-tall'],
    ['I 手机端锚点声明整体失效（env() 不被识别 → bottom/right 回退 auto）', 'I-noenv-anchor'],
    ['J 视口暂时量不到（页面刚加载 / 后台标签，innerWidth=0）', 'J-novp-boot']
];

(async () => {
    let pass = 0;
    let fail = 0;
    const browser = await playwright.chromium.launch({ executablePath, headless: true });
    try {
        const ctx = await browser.newContext({
            viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
            userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
        });
        const page = await ctx.newPage();
        const pageErrors = [];
        page.on('pageerror', (e) => pageErrors.push(e.message));
        await page.goto('file:///' + harnessPath.replace(/\\/g, '/'), { waitUntil: 'load' });
        await page.waitForTimeout(400);

        console.log('=== 移动端浮层可见性（真实宿主 CSS 条件：390×844）===');
        for (const [label, key] of SCENARIOS) {
            const r = await page.evaluate((x) => window.__run(x), key);
            // 场景 I 额外要求：必须是 JS 兜底把它硬放回来的（left/top 显式像素），
            // 而不是碰巧在屏内 —— 否则这条断言会在旧代码上「侥幸通过」而失去意义。
            const forcedOk = !key.includes('noenv') || r.fwForced;
            if (r.allOk && forcedOk) {
                pass++;
                console.log(`[PASS] ${label}` + (key.includes('noenv') ? '（已由 ensureFloatingWindowVisible 兜底移回）' : ''));
            } else {
                fail++;
                console.error(`[FAIL] ${label}`);
                if (!r.modalOk) console.error(`       设置弹窗跑出可见区：${JSON.stringify(r.modal)}（可见区 ${r.vp.w}×${r.vp.h}）`);
                if (!r.previewOk) console.error(`       预览弹窗跑出可见区：${JSON.stringify(r.preview)}`);
                if (!r.fwOk) console.error(`       悬浮药丸跑出可见区：${JSON.stringify(r.fw)}`);
                else if (!r.fwAboveInput) console.error(`       悬浮药丸被输入栏压住：${JSON.stringify(r.fw)} bottom 应 ≤ ${(r.vp.h - 74).toFixed(1)}`);
                else if (!r.fwAnchored) console.error(`       悬浮药丸没贴住右下角：${JSON.stringify(r.fw)}（可见区 ${r.vp.w}×${r.vp.h}）`);
                if (!r.tlFloating) console.error('       药丸没挂进 top-layer 载体 dialog.novel-tl');
                if (!r.tlSettings) console.error('       设置弹窗没挂进 top-layer 载体');
                if (!r.tlPreview) console.error('       预览弹窗没挂进 top-layer 载体');
                if (!r.tlOpen) console.error('       top-layer 载体没有 show()（缺 open 属性 = display:none）');
                if (!r.tlNotModal) console.error('       top-layer 载体被 showModal() 了（会给文档加 inert，药丸将点不到）');
                if (!r.tlCoversViewport) console.error(`       top-layer 载体没铺满视口：${JSON.stringify(r.tlBox)}，内层 absolute 会失去基准`);
                if (!r.fwNoCompensation) console.error('       药丸在 top layer 里仍带补偿 transform（坐标系已经对了，不该再补偿）');
                if (!r.fwHittable) console.error('       药丸不可点（透明载体可能吃掉了指针事件）');
                if (!r.fwOnTop) console.error('       药丸被宿主 UI 盖住了（层叠问题，不是定位问题）');
                if (!r.modalOnTop) console.error(`       设置弹窗被宿主 UI 盖住了（层叠问题）probe=${JSON.stringify(r.modalProbe)} modal=${JSON.stringify(r.modal)}`);
                if (!r.zIndexTop) console.error(`       z-index 不对：载体=${r.layerZ} 内层=${r.innerZ}（都应为 2147483647）`);
                if (!r.notBehindHost) console.error(`       命中测试落在宿主元素上：${r.hostHitIds}`);
                if (!r.tlNoContain) console.error('       载体带了 contain 属性（paint 包含会裁剪溢出，弹窗正文会滚不动）');
                if (r.fwOk && !r.fwAnchored) console.error(`       悬浮药丸没贴在右下角（跑到别处去了）：${JSON.stringify(r.fw)}`);
                if (!forcedOk) console.error('       药丸虽在屏内，但没走 ensureFloatingWindowVisible 兜底 —— 场景失去意义');
            }
        }
        if (pageErrors.length) {
            fail++;
            console.error('[FAIL] 页面运行报错：' + pageErrors.join(' | '));
        }
    } finally {
        await browser.close();
        try { fs.unlinkSync(harnessPath); } catch (e) { /* 忽略 */ }
    }

    console.log(`\n移动端浮层可见性测试结果: 通过: ${pass}, 失败: ${fail}`);
    if (fail > 0) process.exit(1);
    console.log('全部场景的浮层都完整落在可见视口内（手机端药丸也让开了输入栏）');
})().catch((e) => {
    console.error('[FAIL] 测试执行异常：' + (e && e.message));
    process.exit(1);
});
