/**
 * SillyTavern UI Kit · 规范守护测试（独立项目）
 * 运行方式（在本目录下）: node test/test-ui-kit.js（或 npm test）
 *
 * 本文件只读取本项目内的文件，不依赖任何外部仓库/父目录，因此
 * 整个 ui-kit 目录可以被任意移动后直接运行。
 *
 * 覆盖：
 *  0) 项目文件结构、版本号（package.json / CSS 头 / README / CHANGELOG / preview 多处一致）；
 *  1) token 完整性：必填清单齐全、组件里用到的 token 都有定义、每个 token 都被使用且被文档覆盖、命名合法；
 *  2) 配色规范：组件禁用硬编码颜色、颜色声明走 token、深/浅主题对比度达 WCAG AA、
 *     核心 token 取值与金标准一致（防止后人静默改色）；
 *  3) 组件清单：components.css / preview.html / README.md 三方覆盖；
 *  4) 关键实现：宿主 checkbox 隔离、top-layer 载体、focus-visible、reduced-motion、响应式；
 *  5) 作用域红线：无裸元素选择器、类名前缀、!important 仅限宿主隔离与降级块；
 *  6) 预览页离线可用、无外部依赖；
 *  7) 文档契约：章节完整、宿主兼容与可访问性要点齐全、独立项目说明完整；
 *  8) 版本与包信息自洽（可独立发布/移动）。
 */

const fs = require('fs');
const path = require('path');

const KIT = path.join(__dirname, '..'); // 本文件位于 <ui-kit>/test/
const FILES = {
    tokens: path.join(KIT, 'tokens.css'),
    components: path.join(KIT, 'components.css'),
    readme: path.join(KIT, 'README.md'),
    preview: path.join(KIT, 'preview.html'),
    pkg: path.join(KIT, 'package.json'),
    license: path.join(KIT, 'LICENSE'),
    changelog: path.join(KIT, 'CHANGELOG.md'),
    gitignore: path.join(KIT, '.gitignore'),
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

const readText = (p) => fs.readFileSync(p, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const normalizeValue = (v) => String(v).replace(/\s+/g, ' ').trim().toLowerCase();

/** 取 selector 之后第一个完整 { ... } 块的内容（按大括号配平） */
function blockAfter(css, selector) {
    const i = css.indexOf(selector);
    if (i < 0) return null;
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

// ==================== 读取 ====================
const tokensCss = readText(FILES.tokens);
const componentsCss = readText(FILES.components);
const readme = readText(FILES.readme);
const preview = readText(FILES.preview);
const pkg = JSON.parse(readText(FILES.pkg));
const license = readText(FILES.license);
const changelog = readText(FILES.changelog);
const testSrc = readText(FILES.self);

const tokensClean = stripComments(tokensCss);
const componentsClean = stripComments(componentsCss);
const previewClean = stripComments(preview);

// ==================== 0. 独立项目结构与版本 ====================
console.log('\n=== 0. 独立项目结构与版本 ===');
const REQUIRED_FILES = {
    'tokens.css': FILES.tokens,
    'components.css': FILES.components,
    'preview.html': FILES.preview,
    'README.md': FILES.readme,
    'package.json': FILES.pkg,
    'LICENSE': FILES.license,
    'CHANGELOG.md': FILES.changelog,
    'test/test-ui-kit.js': FILES.self,
    '.gitignore': FILES.gitignore,
};
for (const [name, p] of Object.entries(REQUIRED_FILES)) {
    check(`独立项目文件存在：${name}`, fs.existsSync(p) && fs.statSync(p).size > 10, p);
}
const KIT_VERSION = pkg.version;
check('package.json 版本为合法 semver（1.1.0）',
    /^1\.1\.0$/.test(String(KIT_VERSION)), String(KIT_VERSION));
check('package.json 声明 MIT 许可且与 LICENSE 文件一致',
    pkg.license === 'MIT' && /^MIT License/.test(license));
check('package.json scripts.test 指向项目内测试（可 npm test）',
    pkg.scripts && pkg.scripts.test === 'node test/test-ui-kit.js',
    JSON.stringify(pkg.scripts));

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

/** 核心 token 金标准：锁死规范取值，防止静默改色（改这里必须同时升版本并更新 CHANGELOG） */
const GOLDEN_DARK = {
    '--nvui-bg': '#161a24',
    '--nvui-bg-2': '#1c2130',
    '--nvui-bg-3': '#232939',
    '--nvui-block-bg': 'rgba(255, 255, 255, 0.05)',
    '--nvui-block-bg-2': 'rgba(255, 255, 255, 0.078)',
    '--nvui-line': 'rgba(255, 255, 255, 0.07)',
    '--nvui-line-2': 'rgba(255, 255, 255, 0.12)',
    '--nvui-dash': 'rgba(255, 255, 255, 0.17)',
    '--nvui-block-line': 'rgba(255, 255, 255, 0.06)',
    '--nvui-block-line-2': 'rgba(255, 255, 255, 0.1)',
    '--nvui-text': '#e9ecf3',
    '--nvui-text-2': '#98a1b3',
    '--nvui-text-3': '#7d879b',
    '--nvui-accent': '#8b6dff',
    '--nvui-accent-2': '#a997ff',
    '--nvui-accent-strong': '#6d4df2',
    '--nvui-accent-strong-hover': '#5b3fd6',
    '--nvui-accent-bg': 'rgba(139, 109, 255, 0.14)',
    '--nvui-accent-line': 'rgba(139, 109, 255, 0.4)',
    '--nvui-ok': '#4ade80',
    '--nvui-warn': '#fbbf24',
    '--nvui-danger': '#f87171',
    '--nvui-info': '#3498db',
    '--nvui-radius': '12px',
};
const goldenDrift = Object.entries(GOLDEN_DARK)
    .filter(([token, expected]) => normalizeValue(darkMap[token]) !== normalizeValue(expected))
    .map(([token, expected]) => `${token}: 期望 ${expected} / 实际 ${darkMap[token]}`);
check('深色主题核心 token 与金标准逐值一致（防静默改色）',
    goldenDrift.length === 0, goldenDrift.join(' | '));

const GOLDEN_LIGHT = {
    '--nvui-bg': '#f7f8fc',
    '--nvui-text': '#1f2430',
    '--nvui-text-2': '#4a5365',
    '--nvui-text-3': '#5f6879',
    '--nvui-accent': '#6d4df2',
    '--nvui-accent-2': '#5b3fd6',
    '--nvui-accent-strong': '#6d4df2',
    '--nvui-accent-strong-hover': '#5b3fd6',
    '--nvui-ok': '#15803d',
    '--nvui-warn': '#b45309',
    '--nvui-danger': '#dc2626',
    '--nvui-info': '#1d4ed8',
};
const lightDrift = Object.entries(GOLDEN_LIGHT)
    .filter(([token, expected]) => normalizeValue(lightMap[token]) !== normalizeValue(expected))
    .map(([token, expected]) => `${token}: 期望 ${expected} / 实际 ${lightMap[token]}`);
check('浅色主题核心 token 与金标准逐值一致',
    lightDrift.length === 0, lightDrift.join(' | '));

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

check('text-3 为相对旧实现的已记录升级（README 说明提亮一档）',
    contrast(darkMap['--nvui-text-3'], darkBg) >= 4.5 && readme.includes('提亮一档'));
check('填充按钮主色 accent-strong 说明白字 AA 对比度',
    readme.includes('--nvui-accent-strong') && readme.includes('白字 5.26:1'));

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
check('README 声明本目录是独立项目、可整目录移动/复用',
    readme.includes('独立项目') && /(?:整目录|整体)/.test(readme) && /(?:移动|复制)/.test(readme));
check('README 记录独立项目文件结构（package.json / LICENSE / CHANGELOG / test/）',
    ['package.json', 'LICENSE', 'CHANGELOG.md', 'test/test-ui-kit.js'].every((f) => readme.includes(f)));
check('项目内文档不依赖父目录相对链接（可整体移动）',
    !/\]\(\.\.\//.test(readme) && !/href="\.\.\//.test(preview) && !/url\('\.\.\//.test(tokensCss + componentsCss));
const parentJoinRefs = testSrc.split(/\r?\n/).filter((line) =>
    /path\.join\([^)]*'\.\.[^']*'/.test(line) && !/parentJoinRefs|const KIT\b/.test(line));
check('守护测试不读取项目外文件（除项目根外无父目录路径引用）',
    parentJoinRefs.length === 0, parentJoinRefs.join(' | '));

const emojiRe = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]|\uFE0F/;
const emojiFiles = [
    [FILES.tokens, 'tokens.css'], [FILES.components, 'components.css'],
    [FILES.readme, 'README.md'], [FILES.preview, 'preview.html'],
    [FILES.pkg, 'package.json'], [FILES.changelog, 'CHANGELOG.md'], [FILES.self, 'test/test-ui-kit.js'],
];
const emojiHits = emojiFiles.filter(([p]) => emojiRe.test(readText(p))).map(([, n]) => n);
check('项目文件不含 emoji', emojiHits.length === 0, emojiHits.join(', '));

// ==================== 8. 版本一致性 ====================
console.log('\n=== 8. 版本一致性（独立项目自洽） ===');
const versionRefs = {
    'tokens.css 文件头': tokensCss.includes(`ui-kit v${KIT_VERSION}`),
    'components.css 文件头': componentsCss.includes(`ui-kit v${KIT_VERSION}`),
    'README 标题版本': readme.includes(`版本：**v${KIT_VERSION}**`),
    'CHANGELOG 最新条目': new RegExp(`^## v${KIT_VERSION.replace(/\./g, '\\.')}`, 'm').test(changelog),
    'preview 标题': preview.includes(`UI Kit v${KIT_VERSION}`),
    'preview 页面徽标': preview.includes(`>v${KIT_VERSION}<`),
};
const versionMismatch = Object.entries(versionRefs).filter(([, v]) => !v).map(([k]) => k);
check(`kit 版本 v${KIT_VERSION} 在 6 处声明一致`, versionMismatch.length === 0, versionMismatch.join(', '));
check('测试本身位于项目内（test/test-ui-kit.js）',
    path.resolve(FILES.self) === path.join(KIT, 'test', 'test-ui-kit.js'));

// ==================== 汇总 ====================
console.log(`\n=== UI Kit 规范测试结果: 通过 ${pass}, 失败 ${fail} ===`);
if (fail > 0) {
    console.error('UI Kit 规范存在漂移/违规，请先修复再提交。');
    process.exit(1);
}
console.log('UI Kit 规范与实现、预览、文档三方一致，宿主兼容红线全部在位。');
