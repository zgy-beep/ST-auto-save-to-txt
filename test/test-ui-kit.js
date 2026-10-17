/**
 * UI Kit 设计规范守护测试
 * 运行方式: node test/test-ui-kit.js
 *
 * 目的：让「规范文档 / 令牌 / 组件样式 / 预览页」四者不漂移，并锁住
 * novel-stream 真实实现（style.css）中提炼出的取值与宿主兼容红线。
 *
 * 覆盖：
 *  1) 文件结构、版本号、kit 版本；
 *  2) token 完整性：必填清单齐全、组件里用到的 token 都有定义、每个 token 都被使用且被文档覆盖、命名合法；
 *  3) 配色规范：组件禁用硬编码颜色、所有颜色属性走 token、深/浅主题对比度达 WCAG AA、
 *     与 novel-stream style.css 的取值一致性（含两处有意升级：text-3 提亮、新增 accent-strong）；
 *  4) 组件清单：components.css / preview.html / README.md 三方覆盖；
 *  5) 关键实现：宿主 checkbox 隔离、top-layer 载体、focus-visible、reduced-motion、响应式；
 *  6) 作用域红线：无裸元素选择器、类名前缀、!important 仅限宿主隔离与降级块；
 *  7) 预览页离线可用、文档小节与可访问性要点齐全；
 *  8) 扩展版本三处一致（manifest / index.js / README 徽章）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const KIT = path.join(ROOT, 'ui-kit');
const FILES = {
    tokens: path.join(KIT, 'tokens.css'),
    components: path.join(KIT, 'components.css'),
    readme: path.join(KIT, 'README.md'),
    preview: path.join(KIT, 'preview.html'),
    style: path.join(ROOT, 'style.css'),
    index: path.join(ROOT, 'index.js'),
    manifest: path.join(ROOT, 'manifest.json'),
    mainReadme: path.join(ROOT, 'README.md'),
    self: __filename,
};

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
    if (cond) {
        pass++;
        console.log(`[PASS] ${name}`);
    } else {
        fail++;
        console.error(`[FAIL] ${name}${detail ? '  ->  ' + detail : ''}`);
    }
}
const ok = (name, cond, detail) => check(name, !!cond, detail);

function readText(p) {
    return fs.readFileSync(p, 'utf8');
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取 selector 之后第一个完整 { ... } 块的内容（按大括号配平） */
function blockAfter(css, selector) {
    const i = css.indexOf(selector);
    if (i < 0) return null;
    // 从 selector 起始位置找第一个 '{'：兼容调用方传入带 "{"/"," 的 selector 片段
    const open = css.indexOf('{', i);
    if (open < 0) return null;
    let depth = 0;
    for (let j = open; j < css.length; j++) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') {
            depth--;
            if (depth === 0) return css.slice(open + 1, j);
        }
    }
    return null;
}

/** 解析一个块里所有 --nvui-* 定义 */
function tokenMap(css, selector) {
    const body = blockAfter(css, selector);
    const out = {};
    if (!body) return out;
    for (const m of body.matchAll(/(--nvui-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
}

/** 解析 style.css 里的旧 --nv-* 令牌块（主色板块 + 块级色板块） */
function legacyTokenMaps(styleCss) {
    const blocks = [];
    const first = blockAfter(styleCss, '.novel-modal-overlay,');
    if (first) blocks.push(first);
    // 块级色板块：以 --nv-block-bg 定义处为锚点，向前找所在规则块（避免被同名工具提示规则干扰）
    const anchor = styleCss.indexOf('--nv-block-bg:');
    if (anchor >= 0) {
        const open = styleCss.lastIndexOf('{', anchor);
        const close = styleCss.indexOf('}', anchor);
        if (open >= 0 && close > open) blocks.push(styleCss.slice(open + 1, close));
    }
    const out = {};
    for (const body of blocks) {
        for (const m of body.matchAll(/(--nv-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    }
    return out;
}

function hexToRgb(hex) {
    const s = String(hex).trim().replace(/^#/, '');
    const n = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    if (!/^[0-9a-fA-F]{6}$/.test(n)) return null;
    return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}
function relLuminance(rgb) {
    const f = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}
function contrast(hexA, hexB) {
    const a = hexToRgb(hexA);
    const b = hexToRgb(hexB);
    if (!a || !b) return 0;
    const la = relLuminance(a);
    const lb = relLuminance(b);
    const hi = Math.max(la, lb);
    const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
}

// ==================== 读取 ====================
const tokensCss = readText(FILES.tokens);
const componentsCss = readText(FILES.components);
const readme = readText(FILES.readme);
const preview = readText(FILES.preview);
const styleCss = readText(FILES.style);
const indexJs = readText(FILES.index);
const manifest = JSON.parse(readText(FILES.manifest));
const mainReadme = readText(FILES.mainReadme);

const tokensClean = stripComments(tokensCss);
const componentsClean = stripComments(componentsCss);
const previewClean = stripComments(preview);

// ==================== 0. 文件与版本 ====================
console.log('\n=== 0. 文件结构与版本 ===');
for (const [name, p] of [['tokens.css', FILES.tokens], ['components.css', FILES.components],
    ['README.md', FILES.readme], ['preview.html', FILES.preview]]) {
    check(`ui-kit/${name} 存在且非空`, fs.existsSync(p) && fs.statSync(p).size > 500, p);
}
const KIT_VERSION = '1.0.0';
check('tokens.css 文件头声明 kit 版本 v1.0.0',
    /ui-kit v1\.0\.0/.test(tokensCss));
check('components.css 文件头声明 kit 版本 v1.0.0',
    /ui-kit v1\.0\.0/.test(componentsCss));
check('README 标题声明 kit 版本 v1.0.0',
    /# SillyTavern 插件 UI Kit · 设计规范/.test(readme) && /版本：\*\*v1\.0\.0\*\*/.test(readme));

// ==================== 1. Token 完整性 ====================
console.log('\n=== 1. Token 完整性 ===');
const darkMap = tokenMap(tokensClean, ':root,');
const lightMap = tokenMap(tokensClean, '.nvui-theme-light {');
const allTokens = new Set(Object.keys(darkMap).concat(Object.keys(lightMap)).filter((k) => k.startsWith('--nvui-')));

const CORE_TOKENS = [
    '--nvui-bg', '--nvui-bg-2', '--nvui-bg-3', '--nvui-block-bg', '--nvui-block-bg-2',
    '--nvui-input-bg', '--nvui-code-bg', '--nvui-overlay-bg', '--nvui-switch-off-bg',
    '--nvui-knob', '--nvui-knob-off',
    '--nvui-line', '--nvui-line-2', '--nvui-dash', '--nvui-block-line', '--nvui-block-line-2',
    '--nvui-text', '--nvui-text-2', '--nvui-text-3',
    '--nvui-accent', '--nvui-accent-2', '--nvui-accent-strong', '--nvui-accent-strong-hover',
    '--nvui-accent-bg', '--nvui-accent-bg-hover', '--nvui-accent-line',
    '--nvui-ok', '--nvui-ok-bg', '--nvui-ok-line',
    '--nvui-warn', '--nvui-warn-bg', '--nvui-warn-line',
    '--nvui-danger', '--nvui-danger-bg', '--nvui-danger-line',
    '--nvui-info', '--nvui-info-bg', '--nvui-info-line',
    '--nvui-radius-xs', '--nvui-radius-sm', '--nvui-radius', '--nvui-radius-lg', '--nvui-radius-pill',
    '--nvui-space-05', '--nvui-space-1', '--nvui-space-15', '--nvui-space-2', '--nvui-space-25',
    '--nvui-space-3', '--nvui-space-4', '--nvui-space-5', '--nvui-space-6',
    '--nvui-fs-2xs', '--nvui-fs-xs', '--nvui-fs-sm', '--nvui-fs-md', '--nvui-fs-lg', '--nvui-fs-xl', '--nvui-fs-2xl',
    '--nvui-fw-regular', '--nvui-fw-medium', '--nvui-fw-semibold', '--nvui-fw-bold',
    '--nvui-lh-tight', '--nvui-lh-normal', '--nvui-lh-relaxed', '--nvui-lh-loose',
    '--nvui-shadow-modal', '--nvui-shadow-pop', '--nvui-shadow-accent',
    '--nvui-transition', '--nvui-transition-slow', '--nvui-spin-duration',
    '--nvui-control-h', '--nvui-switch-w', '--nvui-switch-h', '--nvui-switch-knob',
    '--nvui-switch-knob-offset', '--nvui-switch-knob-on', '--nvui-modal-width', '--nvui-modal-max-h',
    '--nvui-z-floating', '--nvui-z-overlay', '--nvui-z-tooltip',
];
const missingTokens = CORE_TOKENS.filter((t) => !allTokens.has(t));
check('必填 token 清单齐全（84 个核心令牌）', missingTokens.length === 0,
    `缺少: ${missingTokens.join(', ')}`);
check('token 命名规范（--nvui- 前缀 + kebab-case）',
    [...allTokens].every((t) => /^--nvui-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t)));
check('深色主题令牌在 :root/.nvui-scope 作用域定义', Object.keys(darkMap).length >= 80,
    `实际 ${Object.keys(darkMap).length} 个`);
check('浅色主题覆盖块 .nvui-theme-light 存在且覆盖核心文字/主色令牌',
    Object.keys(lightMap).length >= 40 && !!lightMap['--nvui-text'] && !!lightMap['--nvui-accent-strong'],
    `实际 ${Object.keys(lightMap).length} 个`);

const usedVars = new Set([...componentsClean.matchAll(/var\(\s*(--nvui-[\w-]+)/g)].map((m) => m[1]));
const undefinedVars = [...usedVars].filter((t) => !allTokens.has(t));
check('components.css 引用的 token 全部有定义', undefinedVars.length === 0,
    `未定义: ${undefinedVars.join(', ')}`);
const unusedTokens = CORE_TOKENS.filter((t) => !usedVars.has(t) && !previewClean.includes(t));
check('每个 token 至少在组件或预览页中被使用（无僵尸令牌）', unusedTokens.length === 0,
    `未使用: ${unusedTokens.join(', ')}`);
const undocumented = CORE_TOKENS.filter((t) => !readme.includes(t));
check('每个核心 token 都在 README 规范表格中出现（文档不滞后）', undocumented.length === 0,
    `未记录: ${undocumented.join(', ')}`);

// ==================== 2. 配色规范 ====================
console.log('\n=== 2. 配色规范 ===');
const rawColorInComponents = [...componentsClean.matchAll(/#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl)a?\(/g)];
check('components.css 禁止硬编码颜色（#hex / rgb / hsl 零命中）', rawColorInComponents.length === 0,
    `命中: ${rawColorInComponents.slice(0, 5).map((m) => m[0]).join(', ')}`);

// 颜色相关声明必须走 token（transparent/inherit/none 等关键词除外）
const colorDeclRe = /(?:^|[;{\n])\s*(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?-color|box-shadow|outline|fill)\s*:\s*([^;{}]+);/g;
const badColorDecls = [];
for (const m of componentsClean.matchAll(colorDeclRe)) {
    const value = m[1].trim();
    if (/^(?:none|transparent|inherit|currentColor|0)$/i.test(value)) continue;
    if (value.includes('var(--nvui-')) continue;
    badColorDecls.push(value);
}
check('颜色/背景/边框/阴影声明全部引用 var(--nvui-*)',
    badColorDecls.length === 0, badColorDecls.slice(0, 5).join(' | '));

const darkBg = darkMap['--nvui-bg'];
const ratioPairs = [
    ['--nvui-text', 7], ['--nvui-text-2', 4.5], ['--nvui-text-3', 4.5],
    ['--nvui-accent', 4.5], ['--nvui-accent-2', 4.5],
    ['--nvui-ok', 4.5], ['--nvui-warn', 4.5], ['--nvui-danger', 4.5], ['--nvui-info', 4.5],
];
for (const [token, min] of ratioPairs) {
    const ratio = contrast(darkMap[token], darkBg);
    check(`深色主题 ${token} 对比度 >= ${min}:1`, ratio >= min, `实际 ${ratio.toFixed(2)}:1`);
}
check('深色主题主按钮白字对比度 >= 4.5:1（--nvui-accent-strong）',
    contrast('#ffffff', darkMap['--nvui-accent-strong']) >= 4.5,
    `实际 ${contrast('#ffffff', darkMap['--nvui-accent-strong']).toFixed(2)}:1`);
check('深色主题主按钮悬停白字对比度 >= 4.5:1',
    contrast('#ffffff', darkMap['--nvui-accent-strong-hover']) >= 4.5,
    `实际 ${contrast('#ffffff', darkMap['--nvui-accent-strong-hover']).toFixed(2)}:1`);

const lightBg = lightMap['--nvui-bg'];
const lightPairs = [
    ['--nvui-text', 7], ['--nvui-text-2', 4.5], ['--nvui-text-3', 4.5],
    ['--nvui-accent', 4.5], ['--nvui-accent-2', 4.5],
    ['--nvui-ok', 4.5], ['--nvui-warn', 4.5], ['--nvui-danger', 4.5], ['--nvui-info', 4.5],
];
for (const [token, min] of lightPairs) {
    const ratio = contrast(lightMap[token], lightBg);
    check(`浅色主题 ${token} 对比度 >= ${min}:1`, ratio >= min, `实际 ${ratio.toFixed(2)}:1`);
}
check('浅色主题主按钮白字对比度 >= 4.5:1',
    contrast('#ffffff', lightMap['--nvui-accent-strong']) >= 4.5,
    `实际 ${contrast('#ffffff', lightMap['--nvui-accent-strong']).toFixed(2)}:1`);

// 与 novel-stream 参考实现（style.css）取值一致，防止 kit 与实现漂移
const legacy = legacyTokenMaps(styleCss);
const DRIFT_SUFFIXES = ['bg', 'bg-2', 'bg-3', 'line', 'line-2', 'dash', 'block-bg', 'block-bg-2',
    'block-line', 'block-line-2', 'text', 'text-2', 'accent', 'accent-2', 'accent-bg', 'accent-line',
    'ok', 'warn', 'danger', 'radius'];
const drift = [];
for (const suffix of DRIFT_SUFFIXES) {
    const oldVal = legacy[`--nv-${suffix}`];
    const newVal = darkMap[`--nvui-${suffix}`];
    if (!oldVal || !newVal) drift.push(`${suffix}(缺值)`);
    else if (oldVal !== newVal) drift.push(`${suffix}: ${oldVal} != ${newVal}`);
}
check('核心配色/圆角与 novel-stream style.css 参考实现逐值一致', drift.length === 0,
    drift.join(' | '));
check('text-3 为有意升级：与旧实现不同且对比度 >= 4.5:1',
    legacy['--nv-text-3'] !== darkMap['--nvui-text-3']
    && contrast(darkMap['--nvui-text-3'], darkBg) >= 4.5
    && readme.includes('提亮一档'),
    `旧 ${legacy['--nv-text-3']} / 新 ${darkMap['--nvui-text-3']}`);
check('填充按钮主色 accent-strong 为新增令牌且文档说明白字 AA',
    !legacy['--nv-accent-strong']
    && readme.includes('--nvui-accent-strong') && readme.includes('白字 5.26:1'));

// ==================== 3. 组件清单三方覆盖 ====================
console.log('\n=== 3. 组件清单（样式/预览/文档三方覆盖） ===');
const COMPONENT_CLASSES = [
    'nvui-scope', 'nvui-sr-only', 'nvui-overlay', 'nvui-modal', 'nvui-modal-header',
    'nvui-modal-title', 'nvui-modal-ver', 'nvui-modal-actions', 'nvui-modal-body', 'nvui-modal-footer',
    'nvui-icon-btn', 'nvui-btn', 'nvui-btn-row', 'nvui-switch-row', 'nvui-input-row', 'nvui-input',
    'nvui-tabs', 'nvui-tab', 'nvui-tabpane', 'nvui-acc', 'nvui-acc-head', 'nvui-acc-title',
    'nvui-acc-summary', 'nvui-acc-chev', 'nvui-acc-body', 'nvui-section-title', 'nvui-hint',
    'nvui-alert', 'nvui-status-line', 'nvui-status-time', 'nvui-status-file', 'nvui-badge',
    'nvui-chip', 'nvui-chip-count', 'nvui-empty', 'nvui-spinner', 'nvui-floating',
    'nvui-floating-handle', 'nvui-tooltip', 'nvui-stack', 'nvui-row', 'nvui-grow', 'nvui-divider',
    'nvui-muted', 'nvui-muted-2', 'nvui-accent-text', 'nvui-ok-text', 'nvui-warn-text',
    'nvui-danger-text', 'nvui-info-text', 'nvui-code', 'nvui-tl', 'nvui-theme-light',
];
const kitAllSources = [tokensClean, componentsClean, previewClean].join('\n');
const missingInCss = COMPONENT_CLASSES.filter((c) => !kitAllSources.includes('.' + c));
const missingInPreview = COMPONENT_CLASSES.filter((c) => !previewClean.includes(c));
const missingInDoc = COMPONENT_CLASSES.filter((c) => !readme.includes(c));
check('组件类名在 kit CSS 中全部有实现', missingInCss.length === 0, missingInCss.join(', '));
check('组件类名在 preview.html 中全部有示例', missingInPreview.length === 0, missingInPreview.join(', '));
check('组件类名在 README 中全部有说明', missingInDoc.length === 0, missingInDoc.join(', '));

// ==================== 4. 关键组件实现 ====================
console.log('\n=== 4. 关键实现红线 ===');
const tlBody = blockAfter(componentsClean, 'dialog.nvui-tl {') || '';
check('top-layer 载体：fixed 铺满视口 + 100dvh 兜底',
    /position:\s*fixed/.test(tlBody) && /100dvh/.test(tlBody));
check('top-layer 载体：pointer-events:none（不挡页面）', /pointer-events:\s*none/.test(tlBody));
check('top-layer 载体子浮层恢复 pointer-events:auto',
    /dialog\.nvui-tl > \.nvui-overlay/.test(componentsClean)
    && /dialog\.nvui-tl > \.nvui-floating/.test(componentsClean)
    && /pointer-events:\s*auto/.test(componentsClean));
check('top-layer 载体未 show() 时 display:none',
    /dialog\.nvui-tl:not\(\[open\]\)[^{]*\{\s*display:\s*none/.test(componentsClean));

const switchInputBody = blockAfter(componentsClean, '.nvui-switch-row input[type="checkbox"] {') || '';
check('胶囊开关：appearance:none + 尺寸走 token + 手型光标',
    /appearance:\s*none/.test(switchInputBody)
    && /width:\s*var\(--nvui-switch-w\)/.test(switchInputBody)
    && /height:\s*var\(--nvui-switch-h\)/.test(switchInputBody)
    && /cursor:\s*pointer/.test(switchInputBody));
check('胶囊开关：压掉宿主 ::before 对勾（content/display 双关）',
    /\.nvui-switch-row input\[type="checkbox"\]::before[\s\S]{0,260}content:\s*none !important/.test(componentsClean)
    && /display:\s*none !important/.test(blockAfter(componentsClean, '.nvui-switch-row input[type="checkbox"]::before,') || ''));
check('胶囊开关：勾选态轨道变主色',
    /\.nvui-switch-row input\[type="checkbox"\]:checked\s*\{[\s\S]{0,160}background:\s*var\(--nvui-accent\)/.test(componentsClean));
check('胶囊开关：勾选态滑钮右移 15px 且变白',
    /:checked::after\s*\{[\s\S]{0,160}transform:\s*translateX\(var\(--nvui-switch-knob-on\)\)/.test(componentsClean)
    && /background:\s*var\(--nvui-knob\)/.test(componentsClean));
check('组件内 focus-visible 焦点环数量充足（>= 6 处）',
    (componentsClean.match(/:focus-visible/g) || []).length >= 6,
    `实际 ${(componentsClean.match(/:focus-visible/g) || []).length}`);
check('尊重 prefers-reduced-motion 降级',
    /prefers-reduced-motion: reduce/.test(componentsClean)
    && /animation-duration:\s*0\.01ms !important/.test(componentsClean)
    && /transition-duration:\s*0\.01ms !important/.test(componentsClean));
check('窄屏响应式（<=600px 弹窗与按钮组适配）',
    /@media \(max-width: 600px\)/.test(componentsClean)
    && /max-height:\s*92dvh/.test(componentsClean)
    && /\.nvui-btn-row > \.nvui-btn[\s\S]{0,80}flex:\s*1 1 100%/.test(componentsClean));
check('纯 CSS 加载环动画 @keyframes nvui-spin 存在',
    /@keyframes nvui-spin/.test(componentsClean) && /animation:\s*nvui-spin/.test(componentsClean));
check('读屏专用隐藏文本 .nvui-sr-only 使用 clip 方案（非 display:none）',
    /\.nvui-sr-only\s*\{[\s\S]{0,400}clip:\s*rect\(/.test(componentsClean));
check('遮罩支持 hidden 属性切换隐藏',
    /\.nvui-overlay\[hidden\]\s*\{\s*display:\s*none/.test(componentsClean));
check('标签页面板只切 display（不重建 DOM 的样式前提）',
    /\.nvui-tabpane\s*\{\s*display:\s*none/.test(componentsClean)
    && /\.nvui-tabpane\.is-active\s*\{\s*display:\s*block/.test(componentsClean));
check('折叠箭头为纯 CSS 且展开旋转 225 度',
    /\.nvui-acc-chev\s*\{[\s\S]{0,400}transform:\s*rotate\(45deg\)/.test(componentsClean)
    && /\.nvui-acc\.is-open \.nvui-acc-chev\s*\{\s*transform:\s*rotate\(225deg\)/.test(componentsClean));

// ==================== 5. 作用域与工程红线 ====================
console.log('\n=== 5. 作用域与工程约定 ===');
/** 解析规则选择器（含 @media 内层），跳过 @keyframes 内部 */
function collectSelectors(css) {
    const selectors = [];
    let depth = 0;
    let selStart = 0;
    let inKeyframes = 0;
    for (let i = 0; i < css.length; i++) {
        const ch = css[i];
        if (ch === '{') {
            const raw = css.slice(selStart, i).trim();
            if (raw.startsWith('@keyframes')) inKeyframes = depth + 1;
            else if (raw.startsWith('@')) { /* @media/@supports 等，下一层继续检查 */ }
            else if (depth > 0 && inKeyframes === depth) { /* keyframe 步骤选择器，跳过 */ }
            else selectors.push({ selector: raw, depth });
            depth++;
            selStart = i + 1;
        } else if (ch === '}') {
            depth--;
            if (inKeyframes === depth + 1) inKeyframes = 0;
            selStart = i + 1;
        }
    }
    return selectors;
}
const compSelectors = collectSelectors(componentsClean);
const bareSelectors = compSelectors.filter(({ selector }) => {
    if (!selector) return false;
    return !/^(?:\.nvui-|dialog\.nvui-tl)/.test(selector);
});
check('components.css 无裸元素选择器（全部 .nvui-* / dialog.nvui-tl 作用域）',
    bareSelectors.length === 0, bareSelectors.slice(0, 5).map((s) => s.selector).join(' | '));

const classTokens = new Set();
for (const { selector } of compSelectors) {
    for (const m of selector.matchAll(/\.([A-Za-z][\w-]*)/g)) classTokens.add(m[1]);
}
const badClassTokens = [...classTokens].filter((c) => !c.startsWith('nvui-') && !c.startsWith('is-'));
check('组件选择器中的类名只允许 nvui-* 与 is-* 状态类', badClassTokens.length === 0,
    badClassTokens.join(', '));

const importantCount = (componentsClean.match(/!important/g) || []).length;
check('!important 数量受控（<= 8，仅宿主隔离 + 动效降级）', importantCount <= 8,
    `实际 ${importantCount}`);
const importantLines = componentsClean.split(/\r?\n/).filter((l) => l.includes('!important'));
const badImportantLines = importantLines.filter((l) =>
    !/(::before|content:|display:|animation-|transition-|scroll-behavior)/.test(l));
check('!important 只出现在宿主 ::before 隔离与 reduced-motion 降级声明上',
    badImportantLines.length === 0, badImportantLines.slice(0, 3).join(' | '));

check('kit CSS/预览页不残留旧 --nv- / novel- 命名（仅 README 迁移表允许）',
    !/--nv-(?!ui)/.test(tokensClean + componentsClean + previewClean)
    && !/novel-/.test(tokensClean + componentsClean + previewClean));

// ==================== 6. 预览页离线可用 ====================
console.log('\n=== 6. 预览页 ===');
check('preview.html 以相对路径引入 tokens.css / components.css',
    /href="\.\/tokens\.css"/.test(preview) && /href="\.\/components\.css"/.test(preview));
check('preview.html 离线可用（无外链脚本/样式/字体请求）',
    !/<script[^>]+src=/.test(preview) && !/(?:src|href)="https?:/.test(preview));
check('preview.html 根节点带 nvui-scope，且提供深浅主题切换',
    /<body[^>]*class="[^"]*nvui-scope/.test(preview) && preview.includes('nvui-theme-light'));
check('preview.html 演示了弹窗 top-layer 载体 dialog.nvui-tl',
    /<dialog class="nvui-tl"/.test(preview) && /class="nvui-overlay"/.test(preview));

// ==================== 7. 文档契约 ====================
console.log('\n=== 7. 规范文档契约 ===');
const REQUIRED_SECTIONS = [
    '## 1. 它是什么 / 不是什么', '## 2. 快速开始', '## 3. 设计原则', '## 4. 配色规范',
    '## 5. 文字与排版', '## 6. 尺寸、间距、圆角、阴影、动效、层级', '## 7. 组件规范',
    '## 8. SillyTavern 宿主兼容红线', '## 9. 命名与工程约定',
    '## 10. 从 novel-stream 迁移对照表', '## 11. 版本管理', '## 12. 许可',
];
const missingSections = REQUIRED_SECTIONS.filter((s) => !readme.includes(s));
check('README 章节完整（1-12 节）', missingSections.length === 0, missingSections.join(' | '));
const HOST_KEYWORDS = ['dialog', 'inert', 'appearance', '::before', 'safe-area', '100dvh',
    'prefers-reduced-motion', 'pointer-events'];
const missingHostKeywords = HOST_KEYWORDS.filter((k) => !readme.toLowerCase().includes(k.toLowerCase()));
check('README 覆盖 SillyTavern 宿主兼容要点（top-layer/inert/checkbox/safe-area 等）',
    missingHostKeywords.length === 0, missingHostKeywords.join(', '));
const A11Y_KEYWORDS = ['role="dialog"', 'role="tablist"', 'aria-expanded', 'aria-label', 'aria-selected'];
const missingA11y = A11Y_KEYWORDS.filter((k) => !readme.includes(k));
check('README 覆盖可访问性契约（role/aria 语义）', missingA11y.length === 0, missingA11y.join(', '));
check('README 明确「组件禁止硬编码颜色」与「WCAG/对比度」要求',
    readme.includes('禁止硬编码颜色') && /WCAG/.test(readme) && readme.includes('对比度'));
check('README 提供旧实现迁移对照（token 与类名两张映射表）',
    /### 10\.1 Token 映射/.test(readme) && /### 10\.2 组件类名映射/.test(readme));
check('main README 提供 UI Kit 入口（下个插件可复用）',
    mainReadme.includes('ui-kit/README.md'));

const emojiRe = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|\uFE0F/;
const emojiFiles = [[FILES.tokens, 'tokens.css'], [FILES.components, 'components.css'],
    [FILES.readme, 'ui-kit/README.md'], [FILES.preview, 'preview.html'], [FILES.self, 'test-ui-kit.js']];
const emojiHits = emojiFiles.filter(([p]) => emojiRe.test(readText(p))).map(([, n]) => n);
check('kit 文件与测试文件不含 emoji', emojiHits.length === 0, emojiHits.join(', '));

// ==================== 8. 扩展版本一致性 ====================
console.log('\n=== 8. 版本一致性 ===');
const indexVersionMatch = indexJs.match(/version:\s*'([\d.]+)'/);
const indexVersion = indexVersionMatch ? indexVersionMatch[1] : null;
const badgeVersionMatch = mainReadme.match(/badge\/Version-([\d.]+)-/);
const badgeVersion = badgeVersionMatch ? badgeVersionMatch[1] : null;
check('manifest.json / index.js / README 徽章 三处版本一致',
    !!manifest.version && manifest.version === indexVersion && indexVersion === badgeVersion,
    `manifest=${manifest.version} index=${indexVersion} badge=${badgeVersion}`);
check('UI Kit 版本与扩展版本相互独立且均已声明',
    KIT_VERSION === '1.0.0' && !!indexVersion && indexVersion !== KIT_VERSION);

// ==================== 汇总 ====================
console.log(`\n=== UI Kit 规范测试结果: 通过 ${pass}, 失败 ${fail} ===`);
if (fail > 0) {
    console.error('UI Kit 规范存在漂移/违规，请先修复再提交。');
    process.exit(1);
}
console.log('UI Kit 规范与实现、预览、文档三方一致，宿主兼容红线全部在位。');
