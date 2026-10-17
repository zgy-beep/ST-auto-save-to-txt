/**
 * 真实实现加载器：把 index.js 的源码当作函数体执行，取出其中的真实函数。
 *
 * 背景：index.js 是浏览器 ES module（顶层 import + jQuery 引导），Node 不能直接 require。
 * 历史做法是测试里手抄一份副本 —— 副本会随实现漂移（</3d> 数字开头伪标签、内联黑名单少/多 state
 * 都真实发生过），测试因此变成"锁副本"而不是"锁实现"。
 *
 * 本加载器改用「读源码 + 剥 import + new Function」：
 *   1. 读出 index.js 原文（可选 sourcePath 覆盖，用于定点突变验证）；
 *   2. 只剥掉**开头连续**的 import 语句（保留其余行数，便于报错定位）；
 *   3. 把 import 绑定的名字 + 浏览器全局（window/document/jQuery/fetch…）作为形参注入，
 *      用 new Function 执行整个模块体 —— 函数声明照常提升，模块级 const/let 成为闭包变量；
 *   4. index.js 末尾有一处「测试专用导出」条件块（`typeof module !== 'undefined' && module.exports`），
 *      在 new Function 里 module 是我们注入的桩，所以 module.exports 会拿到真实函数对象。
 *
 * 用法：
 *   const { loadIndexModule } = require('./_helpers/load-index.js');
 *   const api = loadIndexModule();                       // 锁线上 index.js
 *   const api = loadIndexModule({ sourcePath: '...' });  // 锁一份突变副本（判别性验证用）
 *   api.cleanNovelText('<story>正文</story>', {});
 *
 * 环境变量 AUTOSAVE_INDEX_SOURCE 也可指定源码路径（测试脚本无需改代码即可对突变副本整跑）。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE_PATH = path.join(__dirname, '..', '..', 'index.js');

/** 只有顶层、整行、非缩进的 import 语句会被剥掉；其余源码一字不动 */
const TOP_LEVEL_IMPORT_RE = /^[ \t]*import[\s\S]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;

function stripTopLevelImports(src) {
    return src.replace(TOP_LEVEL_IMPORT_RE, (line) => ' '.repeat(line.length));
}

/** document 桩：返回「什么都有、什么都不做」的元素，足以让模块级函数被调用而不炸 */
function createFakeElement() {
    const el = {
        innerHTML: '',
        textContent: '',
        className: '',
        value: '',
        checked: false,
        disabled: false,
        style: {},
        dataset: {},
        children: [],
        offsetWidth: 0,
        offsetHeight: 0,
        classList: {
            add() {}, remove() {}, toggle() {}, contains() { return false; },
        },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
        addEventListener() {}, removeEventListener() {},
        appendChild(c) { el.children.push(c); return c; },
        removeChild() {},
        remove() {},
        replaceChildren() {},
        querySelector() { return null; },
        querySelectorAll() { return []; },
        closest() { return null; },
        getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
        contains() { return false; },
        focus() {}, select() {}, click() {},
    };
    return el;
}

function createDocumentStub() {
    const byId = new Map();
    return {
        body: createFakeElement(),
        documentElement: createFakeElement(),
        head: createFakeElement(),
        getElementById(id) {
            if (!byId.has(id)) byId.set(id, createFakeElement());
            return byId.get(id);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        createElement() { return createFakeElement(); },
        createTextNode() { return createFakeElement(); },
        addEventListener() {}, removeEventListener() {},
        execCommand() { return false; },
    };
}

/** window 桩：无 toastr / 无 TavernHelper，走纯 ST 原生降级路径 */
function createWindowStub() {
    const win = {
        innerWidth: 1280,
        innerHeight: 800,
        devicePixelRatio: 1,
        scrollX: 0,
        scrollY: 0,
        location: { href: 'http://localhost/', search: '' },
        navigator: { userAgent: 'node-loader', clipboard: null },
        setTimeout: (fn) => (typeof setTimeout === 'function' ? setTimeout(fn, 0) : 0),
        clearTimeout: (t) => { if (typeof clearTimeout === 'function') clearTimeout(t); },
        setInterval: () => 0,
        clearInterval: () => {},
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        addEventListener() {}, removeEventListener() {},
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
    };
    win.window = win;
    return win;
}

function loadIndexModule(options = {}) {
    const sourcePath = options.sourcePath
        || process.env.AUTOSAVE_INDEX_SOURCE
        || DEFAULT_SOURCE_PATH;
    const absPath = path.resolve(sourcePath);
    if (!fs.existsSync(absPath)) {
        throw new Error(`[load-index] 找不到 index.js 源码：${absPath}`);
    }
    const rawSrc = fs.readFileSync(absPath, 'utf8');
    const src = stripTopLevelImports(rawSrc);
    if (/^[ \t]*import\s/m.test(src)) {
        throw new Error('[load-index] 仍残留顶层 import，无法在 new Function 中执行（源码结构已变？）');
    }

    const documentStub = options.document || createDocumentStub();
    const windowStub = options.window || createWindowStub();
    // jQuery 引导回调只收集、不执行：测试只取模块里的纯函数，不跑真实 UI 引导
    const bootCallbacks = [];
    const jqueryStub = options.jQuery || function jqueryStub(fn) {
        if (typeof fn === 'function') bootCallbacks.push(fn);
        return { ready() {}, on() {} };
    };

    // import 绑定的名字：默认给安全桩（getContext 返回 {} 即最保守的空上下文）
    const defaultStubs = {
        getContext: () => ({}),
        ext_settings_raw: {},
        es_raw: null,
        et_raw: null,
        grh_raw: null,
        ssd_raw: null,
        chat_raw: [],
        characters_raw: [],
        this_chid_raw: undefined,
    };
    const globals = {
        window: windowStub,
        document: documentStub,
        jQuery: jqueryStub,
        fetch: () => Promise.reject(new Error('[load-index] fetch 未接线的桩')),
        setTimeout: (fn) => (typeof setTimeout === 'function' ? setTimeout(fn, 0) : 0),
        clearTimeout: (t) => { if (typeof clearTimeout === 'function') clearTimeout(t); },
        setInterval: () => 0,
        clearInterval: () => {},
        requestAnimationFrame: () => 0,
        cancelAnimationFrame: () => {},
        alert: () => {},
        Blob: typeof Blob !== 'undefined' ? Blob : function BlobStub() {},
        URL: typeof URL !== 'undefined' ? URL : { createObjectURL: () => '', revokeObjectURL: () => {} },
        navigator: windowStub.navigator,
        getComputedStyle: windowStub.getComputedStyle,
        module: { exports: {} },
        exports: {},
        console,
        JSON, Math, Date, String, Number, Boolean, Array, Object, RegExp, Error, Map, Set, Promise,
    };

    // 注入顺序：默认桩 → 浏览器全局桩 → 调用方覆盖（deps 最后合并，必须能盖掉全局桩）
    const injected = Object.assign({}, defaultStubs, globals, options.deps || {});
    const names = Object.keys(injected);
    const values = names.map((n) => injected[n]);

    const trailingModule = injected.module;
    const factory = new Function(...names, `${src}\n;return { api: (typeof module !== 'undefined' && module.exports) ? module.exports : null, bootCallbacks: null };`);
    let result;
    try {
        result = factory(...values);
    } catch (err) {
        err.message = `[load-index] 执行 ${absPath} 源码失败: ${err.message}`;
        throw err;
    }

    const api = (result && result.api) || trailingModule.exports;
    if (!api || typeof api !== 'object') {
        throw new Error(`[load-index] ${absPath} 末尾未执行「测试专用导出」块，未取到任何导出（导出块被删或被移出模块末尾？）`);
    }
    api.__sourcePath = absPath;
    api.__source = rawSrc;
    api.__bootCallbacks = bootCallbacks;
    return api;
}

module.exports = { loadIndexModule, DEFAULT_SOURCE_PATH };
