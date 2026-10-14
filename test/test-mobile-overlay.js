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
    'measureSafeAreaBottom', 'keepFloatWindowInsideViewport', 'getDocScrollTop'
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
</style>
</head><body>
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
    document.querySelectorAll('#novel_settings_modal,#novel_preview_modal,#novel-floating-window').forEach(n => n.remove());
    document.documentElement.removeAttribute('style');
    document.body.removeAttribute('style');
    STUB.float_pos = null;

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
    document.body.appendChild(overlay);

    const pv = document.createElement('div');
    pv.id = 'novel_preview_modal';
    pv.className = 'novel-modal-overlay';
    pv.style.display = 'none';
    pv.innerHTML = '<div class="novel-modal novel-modal-preview"><div class="novel-modal-header"><b class="novel-modal-title">x</b></div><div class="novel-modal-body novel-mv-body"><div class="novel-mv-grid"><section class="novel-mv-col is-clean"><div class="novel-mv-text">t</div></section></div></div></div>';
    document.body.appendChild(pv);

    const win = document.createElement('div');
    win.id = 'novel-floating-window';
    win.className = 'novel-floating-window';
    win.innerHTML = FW_HTML;
    document.body.appendChild(win);

    overlay.style.display = 'flex';
    positionOverlay(overlay);
    pv.style.display = 'flex';
    positionOverlay(pv);
    applyFloatPos();

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
    // 手机端额外要求：药丸要让开底部常驻输入栏
    out.fwAboveInput = out.fw.bottom <= vp.height - Math.min(gap.bottom, 74) + 0.6;
    out.phoneGap = gap.bottom > 20;
    out.allOk = out.modalOk && out.previewOk && out.fwOk && (!out.phoneGap || out.fwAboveInput);
    return out;
}
window.__run = scenario;
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
    ['H 普通宿主 + 盒子高于可见区', 'H-vanilla-tall']
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
            if (r.allOk) {
                pass++;
                console.log(`[PASS] ${label}`);
            } else {
                fail++;
                console.error(`[FAIL] ${label}`);
                if (!r.modalOk) console.error(`       设置弹窗跑出可见区：${JSON.stringify(r.modal)}（可见区 ${r.vp.w}×${r.vp.h}）`);
                if (!r.previewOk) console.error(`       预览弹窗跑出可见区：${JSON.stringify(r.preview)}`);
                if (!r.fwOk) console.error(`       悬浮药丸跑出可见区：${JSON.stringify(r.fw)}`);
                else if (!r.fwAboveInput) console.error(`       悬浮药丸被输入栏压住：${JSON.stringify(r.fw)} bottom 应 ≤ ${(r.vp.h - 74).toFixed(1)}`);
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
