/**
 * SillyTavern 聊天小说连载阅读扩展 (Novel Reader Stream)
 * 
 * 核心特性：
 * - 默认折叠收起，间距 1:1 完美契合酒馆原生抽屉。
 * - 白名单 + 黑名单双重标签过滤引擎：
 *   1. 【白名单】：指定提取正文标签块（如 <story>...</story>），留空则整篇全保留。
 *   2. 【黑名单】：在已提取的正文中，支持继续深度剔除指定的子标签块（如 <status>、<ooc> 等）。
 * - 每次 AI 回复自动编排为规范小说章节追加写入 TXT。
 * - 纯前端一键导出整本排版小说，零服务端门槛。
 */

import { getContext, extension_settings as ext_settings_raw } from '../../../extensions.js';
import {
    eventSource as es_raw,
    event_types as et_raw,
    getRequestHeaders as grh_raw,
    saveSettingsDebounced as ssd_raw,
    chat as chat_raw,
    characters as characters_raw,
    this_chid as this_chid_raw
} from '../../../../script.js';

function getStContext() {
    if (typeof getContext === 'function') {
        return getContext();
    }
    if (typeof window !== 'undefined' && window.SillyTavern && typeof window.SillyTavern.getContext === 'function') {
        return window.SillyTavern.getContext();
    }
    return {};
}

const ctx = getStContext();
const eventSource = ctx.eventSource || es_raw;
const event_types = ctx.event_types || et_raw;
const getRequestHeaders = ctx.getRequestHeaders || grh_raw;
const saveSettingsDebounced = ctx.saveSettingsDebounced || ssd_raw;

const EXTENSION_NAME = 'autoSaveTxt';
const DEFAULT_SETTINGS = {
    version: '1.20.0',            // 扩展版本号（D11：前端与服务端单一版本源，勿各自漂移）
    enabled: true,                // 小说连载总开关
    include_user_dialogue: false, // 是否将主角（你的互动）也以对话形式写入小说
    chapter_style: 'numbered_floor', // 章节标题样式: 'numbered_floor' (默认：第 1 章 · 角色名 (原楼层: 1)), 'numbered' (第 1 节 · 角色名), 'separator' (* * *), 'dialogue' (【角色名】)
    naming_rule: 'char_chat',     // 文件命名规则: 'char_chat' (角色名 - 对话名), 'char_only' (仅角色名)
    indent_paragraphs: true,      // 自动段落首行空两格（中文小说规范排版）
    buffer_latest_message: false, // 延迟归档最新楼层（草稿缓冲：最后一楼不立刻写入，待下一轮剧情推进时正式定稿入书）
    include_tags: '',             // 【白名单】：指定正文标签（留空代表整篇保留；填入如 story 则只提取 <story>...</story>）
    exclude_tags: 'status,memory,details,variables,analysis,ooc,note,draft,system,log', // 【黑名单】：需剔除的标签块内容
    save_dir: '',                 // 自定义保存文件夹路径（留空则保存至默认 plugins/auto-save/logs；支持任意绝对路径如 D:\MyNovels）
    show_toast: true,             // 连载更新时弹出轻量提示通知
    show_embedded_toolbar: true,  // 最新 AI 楼层底部是否显示内嵌快捷工具条
    show_floating_window: true,   // 常驻悬浮入口（v1.14 起为纯入口按钮：显示章节进度，点击即打开设置弹窗；可拖动移动；可在设置里关闭）
    float_pos: null,              // 悬浮入口被拖动后的位置 { left, top }；null = 默认右下角
    acc_open: [],                 // 设置弹窗里「展开着的折叠分组」key 列表；空数组 = 全部收起（默认）
    ui_v113_migrated: false,      // v1.13 一次性迁移标记（老用户自动补开悬浮窗作为主入口）
    userDisabled: false,          // 用户是否主动手动关闭了连载
    // ===== 图片电子书（EPUB）=====
    ebook_embed_images: false,    // 导出 EPUB 时嵌入图片（默认关：不影响任何现有 TXT 流程）
    ebook_max_image_mb: 5,        // 单张图片大小上限（MB），超限跳过并在结果里报告
    ebook_max_total_mb: 80,       // 全书图片总量上限（MB），超限返回 413
    ebook_st_root: '',            // 可选：酒馆根目录覆盖（留空自动推导，容器/NAS 部署时填）
};

let lastSavedSignature = {
    messageId: null,
    characterName: '',
    mesSnippet: ''
};
let lastSettledSavedIndex = -1; // 记录最近已定稿落盘入书的最高楼层序号
/**
 * F6：最近一次**成功写入文件**的章节号（文件视角，不是聊天视角）。
 *
 * `chapterNumber` 是按聊天实时重算的编号（问候语算第 1 章 → AI 首答是第 2 章），
 * 而 `is_regenerate` 的意图是「替换文件里最后一个已写入章节」。两者混用会把
 * 「文件里并不存在的第 2 章」当成替换目标 → 服务端守卫正确返回 409 chapter_not_found
 * → 用户的第一条 AI 回复被丢弃。替换时定位键必须取本变量。
 * 0 表示「刷新后状态未知」，此时不得发 is_regenerate（退化为普通追加，宁可重复不丢内容）。
 */
let lastWrittenChapterNumber = 0;

let recentStatus = {
    state: 'idle', // 'idle' | 'updating' | 'success' | 'skipped' | 'error'
    text: '连载服务就绪（开始对话后将自动逐章写入小说）',
    time: '',
    file: '',
    chapter: 0 // 最近成功写入的章节序号（进度感知：顶栏显示"已连载第 N 章"）
};

// 顶栏书名截断（折叠态空间狭小，超长书名省略）
function shortBookTitle(title) {
    const t = String(title || '');
    return t.length > 14 ? t.slice(0, 14) + '…' : t;
}

function updateRecentStatus(state, text, file = '') {
    recentStatus.state = state;
    recentStatus.text = text;
    recentStatus.time = new Date().toLocaleTimeString();
    if (file) recentStatus.file = file;

    // D3：本函数所有内容都进 innerHTML，插值必须先转义。
    // 注意 recentStatus.text 保持原文（内部状态只用于逻辑判断），只在插入点转义。
    const safeText = escapeHtml(text == null ? '' : text);
    const safeFile = escapeHtml(recentStatus.file == null ? '' : recentStatus.file);

    // 顶栏状态灯（折叠抽屉时依然可见）
    const headerStatus = document.getElementById('novel_header_status');
    if (headerStatus) {
        if (state === 'updating') {
            headerStatus.innerHTML = '<span class="novel-header-state is-updating"><i class="fa-solid fa-spinner fa-spin"></i> 连载中...</span>';
        } else if (state === 'success') {
            headerStatus.innerHTML = `<span class="novel-header-state is-success"><i class="fa-solid fa-circle-check"></i> 已连载${recentStatus.chapter > 0 ? ' ' + recentStatus.chapter + ' 章 ·' : ''} ${recentStatus.time}</span>`;
        } else if (state === 'skipped') {
            headerStatus.innerHTML = '<span class="novel-header-state is-skipped"><i class="fa-solid fa-circle-info"></i> 已跳过</span>';
        } else if (state === 'error') {
            headerStatus.innerHTML = '<span class="novel-header-state is-error"><i class="fa-solid fa-circle-exclamation"></i> 连载失败</span>';
        }
    }

    // 书卡内的连载状态行（连通性与最近动态聚合）
    const detailEl = document.getElementById('novel_recent_detail');
    const timeEl = document.getElementById('novel_recent_time');
    const lineEl = document.getElementById('novel_recent_status');
    if (detailEl && timeEl && lineEl) {
        timeEl.textContent = recentStatus.time;
        const stateClass = { updating: 'is-updating', success: 'is-success', skipped: 'is-skipped', error: 'is-error' }[state] || 'is-idle';
        lineEl.className = 'novel-status-line ' + stateClass;
        const fileHtml = recentStatus.file ? `<div class="novel-status-file">文件路径：<code>${safeFile}</code></div>` : '';
        if (state === 'updating') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-spinner fa-spin"></i> <b>更新中：</b>${safeText}</span>`;
        } else if (state === 'success') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-circle-check"></i> <b>更新完成：</b>${safeText}</span>${fileHtml}`;
        } else if (state === 'skipped') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-circle-info"></i> <b>已跳过：</b>${safeText}</span>${fileHtml}`;
        } else if (state === 'error') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-circle-exclamation"></i> <b>写入失败：</b>${safeText}</span>`;
        } else {
            detailEl.innerHTML = `<i class="fa-solid fa-circle-check" style="opacity: 0.7;"></i> ${safeText}`;
        }
    }
}

// ==================== 酒馆助手 (JS-Slash-Runner) 软依赖桥接 ====================
// 检测到 window.TavernHelper 即启用增强；未安装时一切功能走 ST 原生降级路径，绝不报错
const tavernHelper = { ready: false, api: null };

function detectTavernHelper() {
    return (typeof window !== 'undefined' && window.TavernHelper && typeof window.TavernHelper.getTavernHelperVersion === 'function')
        ? window.TavernHelper : null;
}

function initTavernHelperBridge() {
    const activate = () => {
        const api = detectTavernHelper();
        if (!api || tavernHelper.ready) return;
        tavernHelper.api = api;
        tavernHelper.ready = true;
        try { onTavernHelperReady(); } catch (e) { console.warn('[AutoSaveTxt] 酒馆助手集成初始化失败:', e); }
    };
    if (eventSource && event_types && event_types.APP_READY) eventSource.on(event_types.APP_READY, activate);
    activate();
    let tries = 0;
    const timer = setInterval(() => {
        tries++;
        activate();
        if (tavernHelper.ready || tries >= 15) clearInterval(timer);
    }, 1000);
}

function onTavernHelperReady() {
    try {
        console.log('[AutoSaveTxt] 已连接酒馆助手 v' + (tavernHelper.api.getTavernHelperVersion?.() || '?') + '，启用楼层徽标增强与改名即时刷新');
    } catch (e) { /* 日志失败无关紧要 */ }
    // ② 角色改名即时刷新书卡与标签工具（原先要等到下一次写入才生效）
    try {
        if (typeof tavernHelper.api.eventOn === 'function') {
            tavernHelper.api.eventOn('CHARACTER_RENAMED', () => {
                updateDrawerHeaderFileBadge();
                renderTagTools();
            });
        }
    } catch (e) { console.warn('[AutoSaveTxt] 酒馆助手事件订阅失败:', e); }
    refreshMessageBadges();
}

// 楼层序号 → 已入书章节号（徽标展示用；切换聊天时重算）
let savedChapterMap = {};

function computeChapterMap(settings, chatLog) {
    const map = {};
    if (!Array.isArray(chatLog)) return map;
    let chapter = 0;
    for (let i = 0; i < chatLog.length; i++) {
        const m = chatLog[i];
        if (!m) continue;
        if (m.is_user && !settings.include_user_dialogue) continue;
        if (getCleanedMessage(m, i, settings)) { chapter++; map[i] = chapter; }
    }
    return map;
}

// 定位楼层正文 DOM：优先酒馆助手的稳定楼层定位，降级 ST 原生选择器
function findMessageTextEl(index) {
    if (typeof document === 'undefined') return null;
    // 优先酒馆助手的稳定楼层定位
    if (tavernHelper.ready && tavernHelper.api.displayed_message && typeof tavernHelper.api.displayed_message.retrieveDisplayedMessage === 'function') {
        try {
            const $el = tavernHelper.api.displayed_message.retrieveDisplayedMessage(index);
            const dom = ($el && $el.length) ? ($el[0].matches?.('.mes_text') ? $el[0] : $el[0].querySelector?.('.mes_text')) : null;
            if (dom) return dom;
        } catch (e) { /* 降级原生 */ }
    }
    const mesEl = document.querySelector(`.mes[mesid="${index}"]`);
    return mesEl ? mesEl.querySelector('.mes_text') : null;
}

// ① 楼层"已入书"徽标：幂等重绘（先清后插），无 DOM 环境（node 测试）直接跳过
function refreshMessageBadges() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('.novel-mes-badge').forEach(el => el.remove());
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    for (const idxStr of Object.keys(savedChapterMap)) {
        const idx = Number(idxStr);
        if (!chatLog[idx]) continue;
        const textEl = findMessageTextEl(idx);
        if (!textEl) continue;
        const badge = document.createElement('div');
        badge.className = 'novel-mes-badge';
        badge.title = '该楼层已写入连载小说文件（第 ' + savedChapterMap[idxStr] + ' 章）';
        badge.innerHTML = `<i class="fa-solid fa-book-bookmark"></i> 第 ${savedChapterMap[idxStr]} 章已入书`;
        textEl.appendChild(badge);
    }
}

// ④ 最新 AI 楼层内嵌快捷工具条：幂等重绘（先清后插），无 DOM 环境（node 测试）直接跳过
function refreshLatestToolbar() {
    if (typeof document === 'undefined') return;
    document.getElementById('novel-latest-toolbar')?.remove();
    const settings = getSettings();
    if (!settings.enabled || settings.show_embedded_toolbar === false) return;
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    let latestIdx = -1;
    for (let i = chatLog.length - 1; i >= 0; i--) {
        const m = chatLog[i];
        if (m && !m.is_user) { latestIdx = i; break; }
    }
    if (latestIdx < 0 || Object.keys(savedChapterMap).length === 0) return;
    const totalChapters = Math.max(recentStatus.chapter, ...Object.values(savedChapterMap));
    const textEl = findMessageTextEl(latestIdx);
    if (!textEl) return;
    const bar = document.createElement('div');
    bar.id = 'novel-latest-toolbar';
    bar.className = 'novel-latest-toolbar';
    bar.innerHTML = `
        <button type="button" class="novel-lt-info" data-lt="settings" title="打开小说连载设置"><i class="fa-solid fa-book-open"></i> 已连载 ${totalChapters} 章</button>
        <button type="button" class="novel-lt-btn" data-lt="preview"><i class="fa-solid fa-eye"></i> 查看过滤效果</button>
        <button type="button" class="novel-lt-btn" data-lt="export"><i class="fa-solid fa-download"></i> 导出整本 TXT</button>
    `;
    bar.querySelector('[data-lt="settings"]').addEventListener('click', (e) => { e.stopPropagation(); openNovelSettingsModal(); });
    bar.querySelector('[data-lt="preview"]').addEventListener('click', (e) => { e.stopPropagation(); openFilterPreviewModal(); });
    bar.querySelector('[data-lt="export"]').addEventListener('click', (e) => { e.stopPropagation(); exportNovelText(); });
    textEl.appendChild(bar);
}

// ⑥ 左下角「魔法棒」入口：注册为酒馆原生扩展菜单（#extensionsMenu）的一项，
//    点击魔法棒 → 「小说连载阅读」→ 打开设置弹窗。
//    幂等：酒馆重绘菜单后可再次调用补回；返回是否已就位（未就位由启动轮询兜底）
function injectWandEntry() {
    if (typeof document === 'undefined') return false;
    if (document.getElementById('novel-wand-menu-item')) return true;

    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;

    // 标记与酒馆官方扩展菜单项一致：#extensionsMenu 的直接子元素 + list-group-item 外观
    // （酒馆自身每秒检查「菜单里是否有可见项」来决定魔法棒按钮显隐，本项即作为可见项）
    const item = document.createElement('div');
    item.id = 'novel-wand-menu-item';
    item.className = 'list-group-item flex-container flexGap5';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.title = '小说连载阅读：打开设置面板（开关连载 / 过滤配置 / 导出整本 TXT）';
    item.innerHTML = '<div class="fa-solid fa-book-bookmark extensionsMenuExtensionButton"></div><span class="novel-wand-item-label">小说连载阅读</span><span class="novel-wand-item-state" id="novel_wand_menu_state"></span>';

    // 注意：不能 stopPropagation，酒馆靠 body/html 上的点击监听来收起这个下拉菜单
    const activate = () => openNovelSettingsModal();
    item.addEventListener('click', activate);
    item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    });

    menu.appendChild(item);
    syncWandEntryState();
    return true;
}

// 魔法棒菜单项状态副标（连载中 / 已关闭），与悬浮窗药丸语义一致
function syncWandEntryState() {
    if (typeof document === 'undefined') return;
    const stateEl = document.getElementById('novel_wand_menu_state');
    if (!stateEl) return;
    const settings = getSettings();
    const on = !!settings.enabled;
    stateEl.textContent = on ? '连载中' : '已关闭';
    stateEl.classList.toggle('is-on', on);
}

// ============================================================================
// 浮层载体：原生 <dialog> + top layer
// ----------------------------------------------------------------------------
// 为什么必须换成 <dialog>（v1.17.3，根治「手机端悬浮窗看不见」）：
//
// 酒馆 public/style.css 给 html 加了
//     html { -webkit-transform: translateZ(0); -webkit-perspective: 1000; ... }
// transform 不是 none → **html 成为 position:fixed 的包含块**，
// 于是 fixed 钉的是「文档盒子」而不是「视口」。而手机端文档盒子远高于可见区
// （聊天记录 + 常驻输入栏，body 又是 100dvh/overflow:hidden），
// 任何「用 bottom/right 描述几何」的浮层都会整块跑到屏幕外 ——
// 用户看到的现象就是「悬浮窗不见了」，跟有没有创建过无关。
//
// 浏览器对这套劫持的标准解法就是 **top layer**：原生 <dialog> 的 show()/showModal()
// 把元素提到浏览器顶层渲染，此时它不参与文档流，**fixed 的包含块重新变回视口**，
// 完全绕开 html 上的 transform。酒馆自己的弹窗就是这么做的
// （酒馆助手 @types/iframe/exported.sillytavern.d.ts：SillyTavern.Popup → dlg: HTMLDialogElement）。
//
// 但 top layer **只解决定位，不解决层叠**（v1.17.4 实测踩坑，代价是弹窗全体消失）：
// html 上的 transform 同时让 **html 成为一个层叠上下文**，dialog show() 之后绘制
// 仍在这个层叠上下文里参与比较 —— 载体 `z-index: auto`（等价 0）直接输给酒馆 UI 的
// 29999，用户看到的是「弹窗显示在酒馆界面后面」。
// **载体与内层都必须显式写 z-index 顶层值**，且内层那条不能省（只加载体时药丸仍会被
// 宿主底栏的半透明背景透过叠加）。详见 style.css 末尾 v1.17.4 覆盖块里的实测记录。
// 教训：判断层叠顺序只能靠**像素采样**，z-index 数值推理在这个场景里会给出错误结论。
//
// 实测（temp/diag-dialog4.js，条件=html劫持 + 文档1.6×高 + scrollTop180 + 锚点整体失效）：
//     div+fixed（v1.17.2 的做法）    → 药丸 top 550，不贴底
//     dialog载体static + 内层fixed   → 药丸 top 224，漂得更远（载体没铺满视口）
//     dialog自身fixed:inset:0 + 内层absolute → 药丸 top 730.4，稳稳贴右下
// 所以载体必须**自己铺满视口**（fixed + inset:0），内层才改用 absolute，
// 解析基准就是载体盒子（=视口），与 html 的 transform 完全无关。
//
// 为什么不用 showModal()：模态 dialog 会给整个文档加 inert，
// 药丸在设置弹窗打开时就点不到了（实测），而入口必须始终可点。
// 因此统一用非模态 show()，模态语义（点遮罩关闭、Esc）继续由我们自己实现。
// ============================================================================

/**
 * 把浮层挂进 top-layer 载体。
 *
 * 这里**必须**留一条「挂不进载体就直接挂 body」的兜底：
 * 一旦载体建不出来（极老 WebView 没有 <dialog>）而调用方又没有兜底，
 * 浮层元素就**从未被插入 DOM** —— 症状是弹窗彻底消失且毫无报错，
 * 极难定位。挂回 body 时补一个 z-index，保证仍能盖住宿主 UI。
 *
 * @param {string} layerId 载体 id（同一浮层复用同一个载体）
 * @returns {HTMLElement|null} 载体元素；不支持 <dialog> 时返回 null（调用方回退到裸浮层）
 */
function ensureTopLayer(layerId) {
    if (typeof document === 'undefined') return null;
    const existing = document.getElementById(layerId);
    if (existing) return existing;
    // 老环境兜底：极老的 WebView 没有 <dialog>，此时沿用原来的裸浮层方案
    if (typeof HTMLDialogElement === 'undefined'
        || typeof HTMLDialogElement.prototype.show !== 'function') return null;
    const layer = document.createElement('dialog');
    layer.id = layerId;
    layer.className = 'novel-tl';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
    // show() 非模态：进 top layer 但不给文档加 inert，页面其它部分照常可点
    try { layer.show(); } catch { /* 已在 top layer */ }
    return layer;
}

/**
 * 把浮层元素移入 top-layer 载体（幂等）。
 *
 * 兜底：载体不存在（老环境）时**直接把浮层挂到 body**，
 * 否则调用方拿到的元素从未进过 DOM —— 弹窗会彻底消失且不报错。
 * 回退路径同时补 z-index，保证仍能盖过宿主 UI（宿主最高用到 29999）。
 *
 * z-index 分档（v1.17.5）：**不用 int32 顶格 2147483647**。
 * 顶格会让药丸压在自己打开的设置弹窗之上，还会盖住酒馆后续 show() 的任何东西；
 * 只保证「高于宿主 29999」，谁高谁低交给 CSS 按 id 分档：
 * 药丸 1000010 < 设置弹窗 1000015 < 预览弹窗 1000025。
 */
function mountInTopLayer(layerId, el) {
    if (!el) return false;
    const layer = ensureTopLayer(layerId);
    if (!layer) {
        if (el.parentElement !== document.body) {
            document.body.appendChild(el);
            if (!el.style.zIndex) el.style.zIndex = '1000010';
        }
        return false;
    }
    if (el.parentElement !== layer) layer.appendChild(el);
    return true;
}

// ⑤ 悬浮入口（v1.14 起简化为「纯入口」）：右下角一枚可拖动的药丸，
//    常显当前连载进度（第 N 章 / 连载已关 / 等待开书），点击即打开设置弹窗——
//    不再有二级展开面板，所有操作集中在弹窗内，信息与入口一一对应。
//    位置持久化；不依赖任何楼层 DOM，切聊天全程跟随；无 DOM 环境（node 测试）直接跳过
let fwDragEndAt = 0;    // 最近一次「拖动结束」的时间戳：抑制随后补发的 click（防误当点击）
let fwTapHandledAt = 0;  // 最近一次「已在 pointerup 里判定为轻点」的时间戳：抑制补发的 click 重复打开
let fwOnTap = null;      // 轻点回调（由 buildFloatingWindow 注入），pointerup 里就直接调用

/** 读取用户拖动后的悬浮窗坐标（从未拖动过返回 null = 默认右下角） */
function getUserFloatPos() {
    const pos = getSettings().float_pos;
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return null;
    return pos;
}

/** 坐标夹取：保证窗口怎么拖都出不了可视区 */
function clampFloatPos(left, top, w, h) {
    const maxLeft = Math.max(0, (window.innerWidth || 0) - w);
    const maxTop = Math.max(0, (window.innerHeight || 0) - h);
    return {
        left: Math.min(Math.max(0, left), maxLeft),
        top: Math.min(Math.max(0, top), maxTop)
    };
}

/**
 * 贴边校正：药丸尺寸变了以后，之前保存的「左上角坐标」就对不上当前尺寸了。
 *
 * 背景（v1.17.5 药丸从 129×40 缩成 36×36 圆钮时暴露）：
 * 用户当初把药丸拖到右下角，存的是「左上角 = (250, 700)」；
 * 药丸缩窄 70px 之后同一个左上角反而离右边缘 104px —— 药丸**悬在半空不贴角**，
 * 看起来就像「被拖到奇怪的位置」。
 *
 * 这里只校正「本意就是贴边」的落点：右/下边距与目标边距的差落在一个旧药丸
 * 尺寸的窗口内（96px）时，认为用户当初是贴边拖的，按**当前**尺寸重算贴边坐标。
 * 超出这个窗口 → 视为用户故意摆在中间，原样保留。
 * 绝不能无条件贴边：那会把用户摆在页面中间的药丸强行拽回右下角。
 */
function realignFloatPosToEdge(pos, w, h, vp, gap) {
    if (!pos) return pos;
    const tol = 96;   // 一个旧药丸的宽度量级；只有「贴边」的落点才会落在这个窗口内
    const clearance = floatBottomClearance(gap);
    const next = { left: pos.left, top: pos.top };
    const rightGap = vp.width - (pos.left + w);
    const bottomGap = vp.height - (pos.top + h);
    if (Math.abs(rightGap - gap.right) <= tol) {
        next.left = Math.max(0, Math.round(vp.width - gap.right - w));
    }
    if (Math.abs(bottomGap - clearance) <= tol) {
        next.top = Math.max(0, Math.round(vp.height - clearance - h));
    }
    return next;
}

/**
 * 实测底部安全区高度（刘海屏 / Home Indicator）。
 * CSS 的 env() 在 getComputedStyle 里读不到解析值（自定义属性保留的是原始 token），
 * 所以用一个零尺寸探针把它量出来，供 JS 计算底部让位；尺寸变化时清缓存重测。
 */
let cachedSafeAreaBottom = null;
function measureSafeAreaBottom() {
    if (cachedSafeAreaBottom !== null) return cachedSafeAreaBottom;
    if (typeof document === 'undefined' || !document.body) return 0;
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:env(safe-area-inset-bottom, 0px);';
    document.body.appendChild(probe);
    const h = probe.getBoundingClientRect().height || 0;
    probe.remove();
    cachedSafeAreaBottom = h;
    return h;
}

/** 读取悬浮入口的底部/右侧让位（CSS 变量给出档位，底部再叠加实测安全区） */
function readFloatGap(win) {
    const fallback = { bottom: 12, right: 12 };
    if (!win || typeof getComputedStyle !== 'function') return fallback;
    const cs = getComputedStyle(win);
    const bottom = parseFloat(cs.getPropertyValue('--nv-fw-gap-bottom'));
    const right = parseFloat(cs.getPropertyValue('--nv-fw-gap-right'));
    return {
        bottom: (Number.isFinite(bottom) ? bottom : fallback.bottom) + measureSafeAreaBottom(),
        right: Number.isFinite(right) ? right : fallback.right
    };
}

/**
 * 底部需要额外让开的高度：桌面档（12px）不算，只有手机档（74px 起）要让开常驻输入栏。
 * 修正与「坐标是否可用」两处共用，避免出现「贴到屏幕最底边、被输入栏压住」的结果。
 */
function floatBottomClearance(gap) {
    return (gap && gap.bottom > 20) ? gap.bottom : 0;
}

/**
 * 持久化坐标是否适用于当前视口（屏幕坐标）。
 * 「悬浮窗不会根据手机端/电脑端适配」的根因：坐标是在另一台设备上拖出来的，
 * 硬套到当前视口只能贴边，容易被输入栏压住甚至整颗跑出可见区。
 * 规则：① 记录过保存时视口宽 vw，与当前宽度相差 > 120px 视为跨设备 → 不采用；
 *      ② 坐标必须让整颗药丸完整落在可见区内（手机端还要让开底部输入栏）→ 否则不采用。
 * 不采用时回落到「本设备默认锚点」（桌面右下 12px / 手机输入栏上方 74px）。
 */
function isFloatPosUsableForViewport(pos, w, h, vp, gap) {
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return false;
    if (!Number.isFinite(pos.left) || !Number.isFinite(pos.top)) return false;
    if (!vp || !vp.width || !vp.height || !w || !h) return false;
    if (Number.isFinite(pos.vw) && Math.abs(pos.vw - vp.width) > 120) return false;
    if (pos.left < 0 || pos.top < 0) return false;
    if (pos.left + w > vp.width) return false;
    if (pos.top + h > vp.height - floatBottomClearance(gap)) return false;
    return true;
}

/**
 * 实测修正：把药丸整颗推回可见区（用 translate 补偿，不动布局坐标，不影响拖拽逻辑）。
 * 覆盖「宿主把 fixed 钉在高于可见区的文档盒子上」「文档被顶起」「跨设备旧坐标」
 * 等所有会让药丸跑到屏幕外的情形；手机端同时保证不让常驻输入栏压住。
 *
 * 量之前必须先把上一轮的 transform 清掉：`getBoundingClientRect()` 反映的是
 * 「CSS 锚点 + 已有补偿」之后的矩形，若拿它去算新的补偿再**替换** transform，
 * 残差恰好等于旧值 —— 每调用一次就左右各偏一次、永远收敛不了（实测会看到
 * inlineTransform 在 translate(0,-62) 这类值上来回跳）。
 */
function keepFloatWindowInsideViewport(win) {
    if (!win) return;
    const vp = getVisibleViewportBox();
    if (!vp.width || !vp.height) return;
    win.style.transform = '';
    const r = win.getBoundingClientRect();
    const maxBottom = vp.height - floatBottomClearance(readFloatGap(win));
    let dx = 0;
    let dy = 0;
    if (r.right > vp.width) dx = vp.width - r.right;
    if (r.left + dx < 0) dx = -r.left;
    if (r.bottom > maxBottom) dy = maxBottom - r.bottom;
    if (r.top + dy < 0) dy = -r.top;
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
        win.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    }
}

/**
 * 最后一道保险：药丸必须在可见区里有实打实的面积，而且贴在该在的位置。
 *
 * 上面的定位全都建立在「CSS 锚点（bottom/right）+ 反向补偿」之上，只要宿主或浏览器
 * 行为超出预期 —— `env()` 不被识别导致整条 bottom 声明作废、fixed 的包含块被换掉、
 * 断点没匹配上 —— 药丸就会整块落到屏幕外，而用户看到的只是「悬浮窗不见了」。
 * 这里实测矩形，发现不可见 / 位置不对就**放弃 CSS 锚点**，直接按屏幕坐标硬放一次
 * （写法与「用户拖过的坐标」同源：left/top + 宿主包含块折算），保证一定看得见且在右下角。
 *
 * @param {boolean} enforceDefaultAnchor 用户没拖过（没有持久化坐标）时为 true：
 *        此时额外要求药丸确实贴在右下角。反例：CSS 锚点整体失效后，
 *        keepFloatWindowInsideViewport 只能把它拉回「左下角」这种半对不对的位置
 *        （在屏内，但压在聊天正文上、也不再是拇指区）。
 *        用户自己拖过的药丸不参与这项校验，否则会被强行拽回右下角。
 */
function ensureFloatingWindowVisible(win, enforceDefaultAnchor) {
    if (!win) return;
    const vp = getVisibleViewportBox();
    if (!vp.width || !vp.height) return;
    const gap = readFloatGap(win);
    const r = win.getBoundingClientRect();
    const sizeOk = r.width > 1 && r.height > 1;
    const inside = r.right > 0 && r.left < vp.width && r.bottom > 0 && r.top < vp.height;
    // 「贴住右下角」的判定：右缘贴近视口右缘（含 gap.right 的让位），且整体落在下半屏
    const anchored = !enforceDefaultAnchor
        || (r.right >= vp.width - Math.max(24, gap.right + 14) && r.bottom >= vp.height * 0.5);
    if (sizeOk && inside && anchored) return;
    const w = win.offsetWidth || r.width || 0;
    const h = win.offsetHeight || r.height || 0;
    // 尺寸都量不到（例如自身 display:none，父级还没布局完）→ 本轮放弃，等下一帧重排
    if (w < 2 || h < 2) return;
    const left = Math.max(0, Math.round(vp.width - gap.right - w));
    const top = Math.max(0, Math.round(vp.height - floatBottomClearance(gap) - h));
    const off = measureHostFixedOffset(win);
    win.style.right = 'auto';
    win.style.bottom = 'auto';
    win.style.transform = '';
    win.style.left = `${left - off.x}px`;
    win.style.top = `${top - off.y}px`;
    win.classList.add('is-moved');
    console.warn('[小说连载] 悬浮入口不在应在的位置，已强制移回右下角。',
        { rect: { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) },
            viewport: { width: Math.round(vp.width), height: Math.round(vp.height) },
            reason: sizeOk ? (inside ? '锚点失效（位置不对）' : '落在可见区之外') : '尺寸为 0' });
}

/**
 * 有界重试：视口还量不到时（页面刚加载 / 切回后台标签，innerWidth 可能短暂为 0），
 * 单次重排等于没做；而「定位失败」这件事本身没有事件会通知我们。
 * 这里最多试 60 帧，一旦量到可见区就定位一次并复查药丸是否真的在屏内，不在就继续试。
 * 返回 Promise 只为方便测试 await，产品代码不依赖它。
 */
function ensureFloatPosEventually() {
    return new Promise((resolve) => {
        if (typeof document === 'undefined' || typeof requestAnimationFrame !== 'function') { resolve(false); return; }
        let n = 0;
        const tick = () => {
            const win = document.getElementById('novel-floating-window');
            if (!win || n > 60) { resolve(false); return; }
            const vp = getVisibleViewportBox();
            if (vp.width > 0 && vp.height > 0) {
                applyFloatPos();
                const r = win.getBoundingClientRect();
                const ok = r.width > 1 && r.height > 1
                    && r.right > 0 && r.left < vp.width && r.bottom > 0 && r.top < vp.height;
                if (ok) { resolve(true); return; }
            }
            n++;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
}

/**
 * 落地悬浮窗位置：本设备拖过就沿用旧坐标，跨设备 / 坐标已失效则回落本设备默认锚点。
 * 末尾统一过一遍 keepFloatWindowInsideViewport，保证屏幕上一定看得见。
 */
function applyFloatPos() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const win = document.getElementById('novel-floating-window');
    if (!win) return;
    if (fwDrag.active) return;   // 拖拽中不与手指抢坐标
    const vp = getVisibleViewportBox();
    if (!vp.width || !vp.height) return;
    const gap = readFloatGap(win);
    const pos = getUserFloatPos();

    if (isFloatPosUsableForViewport(pos, win.offsetWidth || 0, win.offsetHeight || 0, vp, gap)) {
        // 持久化的是屏幕坐标；宿主包含块被劫持时需折算成宿主坐标再写
        // （v1.17.3：浮层在 top layer 里时 measureHostFixedOffset 直接返回 0/0，折算自动失效）
        const off = measureHostFixedOffset(win);
        // 药丸尺寸变过（版本更新 / 折叠展开 / 字体加载）后，旧坐标不再贴边 → 先校正一次
        const fixed = realignFloatPosToEdge(pos, win.offsetWidth || 0, win.offsetHeight || 0, vp, gap);
        win.style.right = 'auto';
        win.style.bottom = 'auto';
        win.style.left = `${fixed.left - off.x}px`;
        win.style.top = `${fixed.top - off.y}px`;
        win.classList.add('is-moved');
    } else {
        // 回落到本设备默认锚点（右/下由 CSS 变量给出，手机端已让开输入栏）
        win.style.left = 'auto';
        win.style.top = 'auto';
        win.style.right = '';
        win.style.bottom = '';
        win.classList.remove('is-moved');
    }
    keepFloatWindowInsideViewport(win);
    // 兜底：万一 CSS 锚点整体失效（env() 不被识别 / 包含块被换 / 断点没匹配），
    // 药丸会跑到左下角甚至屏幕外。这里实测一次，不可见 / 位置不对就用屏幕坐标硬放回来。
    // 用户自己拖过（pos 存在）时不强制锚点，免得把人家的药丸拽回右下角。
    ensureFloatingWindowVisible(win, !pos);
}

// ---- 拖拽 + 轻点（指针事件，鼠标 / 触屏共用） ----
// 关键约定：轻点绝不依赖浏览器补发的 click。
// 移动端手指按下几乎必然带几像素抖动，一旦超过阈值，浏览器会把这次触摸当成手势
// 从而吞掉 click —— 只认 click 就会出现「手机上点药丸没反应 / 弹窗打不开」。
// 因此轻点在 pointerup 当场判定，click 仅作键盘与旧环境的兜底。
const fwDrag = { active: false, moved: false, startX: 0, startY: 0, startLeft: 0, startTop: 0, pointerType: 'mouse', hostOffset: { x: 0, y: 0 } };
let fwDragBound = false;
// 手指抖动远大于鼠标：触屏阈值放宽到 10px（对齐 iOS/Android 的 tap slop），避免轻点被误判成拖动
const FW_SLOP = { touch: 10, pen: 4, mouse: 4 };

function fwSlop(type) {
    return FW_SLOP[type] || 4;
}

function onFwPointerMove(e) {
    if (!fwDrag.active) return;
    const win = document.getElementById('novel-floating-window');
    if (!win) {
        fwDrag.active = false;
        return;
    }
    const dx = e.clientX - fwDrag.startX;
    const dy = e.clientY - fwDrag.startY;
    const slop = fwSlop(fwDrag.pointerType);
    if (!fwDrag.moved && Math.abs(dx) < slop && Math.abs(dy) < slop) return;
    fwDrag.moved = true;
    if (e.cancelable) e.preventDefault();
    const c = clampFloatPos(fwDrag.startLeft + dx, fwDrag.startTop + dy, win.offsetWidth, win.offsetHeight);
    win.style.left = `${c.left}px`;
    win.style.top = `${c.top}px`;
    // 拖动过程中也保一颗在可见区内（宿主盒子高于可见区 / 文档被顶起时，夹取用的是宿主坐标系）
    keepFloatWindowInsideViewport(win);
}

/**
 * 指针结束统一收口：
 * - 未构成拖动（moved=false）→ 判定为「轻点」，当场执行 onTap（打开设置弹窗）
 * - 构成拖动（moved=true）→ 持久化新位置
 * - isCancel（手势被系统取消，如页面开始滚动）且没拖过 → 什么都不做
 */
function onFwPointerEnd(e, isCancel) {
    if (!fwDrag.active) return;
    const win = document.getElementById('novel-floating-window');
    fwDrag.active = false;
    if (win) win.classList.remove('is-dragging');
    const moved = fwDrag.moved;
    fwDrag.moved = false;
    if (isCancel && !moved) return;
    if (!moved) {
        fwTapHandledAt = Date.now();
        if (typeof fwOnTap === 'function') fwOnTap();
        return;
    }
    fwDragEndAt = Date.now();
    if (win) {
        const settings = getSettings();
        // 存「屏幕坐标」：拖动结束时的实测矩形就是用户看到的位置，
        // 天然兼容宿主包含块被劫持（不需要在这里做坐标折算）。
        const rect = win.getBoundingClientRect();
        settings.float_pos = {
            left: Math.round(rect.left),
            top: Math.round(rect.top),
            // 记下当时视口宽度：换到手机/电脑时宽度差过大即判为跨设备，不再套用这份坐标
            vw: Math.round(getVisibleViewportBox().width) || 0
        };
        win.classList.add('is-moved');
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        // 落点若已失效（例如拖到手机端输入栏后面 / 拖出屏幕），立刻回落本设备默认锚点
        fwDrag.active = false;
        applyFloatPos();
    }
}

function onFwPointerUp() { onFwPointerEnd(null, false); }
function onFwPointerCancel() { onFwPointerEnd(null, true); }

/**
 * 绑定拖拽把手；document 级监听全程只绑一次，避免反复重建时重复挂载。
 * onTap：轻点（未构成拖动）时执行的动作，由调用方注入（v1.14.1 起为「打开设置弹窗」）
 */
function bindFloatingWindowDrag(win, handles, onTap) {
    if (typeof onTap === 'function') fwOnTap = onTap;
    if (!fwDragBound && typeof document !== 'undefined') {
        fwDragBound = true;
        document.addEventListener('pointermove', onFwPointerMove, { passive: false });
        document.addEventListener('pointerup', onFwPointerUp);
        document.addEventListener('pointercancel', onFwPointerCancel);
    }
    handles.filter(Boolean).forEach((handle) => {
        handle.classList.add('novel-fw-drag-handle');
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            if (e.target.closest('button, input, select, textarea, a, label')) return;
            const rect = win.getBoundingClientRect();
            // 拖动前先把「包含块补偿」折成像素坐标：清掉可能叠加的修正 transform，
            // 并把当前屏幕位置换算进宿主坐标系，否则按下瞬间药丸会跳位
            const off = measureHostFixedOffset(win);
            win.style.transform = '';
            fwDrag.hostOffset = off;
            fwDrag.active = true;
            fwDrag.moved = false;
            fwDrag.pointerType = e.pointerType || 'mouse';
            fwDrag.startX = e.clientX;
            fwDrag.startY = e.clientY;
            fwDrag.startLeft = rect.left - off.x;
            fwDrag.startTop = rect.top - off.y;
            // 先落成像素坐标再拖，避免 right/bottom 锚点在拖动过程中跳动
            win.style.right = 'auto';
            win.style.bottom = 'auto';
            win.style.left = `${fwDrag.startLeft}px`;
            win.style.top = `${fwDrag.startTop}px`;
            win.classList.add('is-dragging');
        });
    });
}

function buildFloatingWindow() {
    const win = document.createElement('div');
    win.id = 'novel-floating-window';
    win.className = 'novel-floating-window';
    // 纯入口：只有一枚药丸。点击 = 打开设置弹窗；按住 = 拖动移动位置
    win.innerHTML = `
        <div class="novel-fw-pill" id="novel_fw_pill" role="button" tabindex="0" title="点击打开小说连载设置 · 按住可拖动移动位置">
            <i class="fa-solid fa-grip-vertical novel-fw-grip"></i>
            <i class="fa-solid fa-book-open novel-fw-book"></i>
            <span id="novel_fw_pill_text">小说连载</span>
            <i class="fa-solid fa-sliders novel-fw-gear"></i>
        </div>
    `;
    // 关键：挂进 top-layer 载体（v1.17.3）。
    // 载体铺满视口并 show()，药丸的 fixed 因此钉的是视口而不是被 transform 劫持的文档盒子 ——
    // 手机端文档盒子远高于可见区，不这么做药丸整块落在屏幕外，表现就是「悬浮窗看不见」。
    mountInTopLayer('novel-tl-floating', win);

    const pill = win.querySelector('#novel_fw_pill');
    // 轻点动作：由 pointerup 当场执行（见 onFwPointerEnd），移动端不依赖补发的 click
    const activate = () => openNovelSettingsModal();
    // 药丸整体是拖拽把手（内部无按钮/输入框，拖动与轻点由阈值区分）
    bindFloatingWindowDrag(win, [pill], activate);

    pill.addEventListener('click', (e) => {
        e.stopPropagation();
        // 这次轻点已在 pointerup 里处理过（触摸 / 鼠标），或刚拖动完 → 忽略补发的 click 防重复打开
        if (Date.now() - fwTapHandledAt < 500) return;
        if (Date.now() - fwDragEndAt < 400) return;
        activate();
    });
    pill.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
        }
    });

    // 视口变化时夹取坐标，保证拖过的入口不会因缩小窗口/横竖屏切换而跑到屏幕外
    window.addEventListener('resize', applyFloatPos);
    window.addEventListener('orientationchange', () => setTimeout(applyFloatPos, 200));
    return win;
}

function refreshFloatingWindow() {
    if (typeof document === 'undefined') return;
    const settings = getSettings();
    const existing = document.getElementById('novel-floating-window');
    if (settings.show_floating_window === false) {
        existing?.remove();
        // 载体是空的了就一并撤掉，别在 body 上留个透明 dialog
        document.getElementById('novel-tl-floating')?.remove();
        return;
    }
    const win = existing || buildFloatingWindow();

    // 章节统计与内嵌工具条同源：楼层映射 + 最近状态取最大
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    let chapterTotal = 0;
    for (const v of Object.values(savedChapterMap)) chapterTotal = Math.max(chapterTotal, v);
    chapterTotal = Math.max(chapterTotal, recentStatus.chapter || 0);
    const chapterText = !settings.enabled
        ? '连载已关'
        : (chapterTotal > 0 ? `第 ${chapterTotal} 章` : ((Array.isArray(chatLog) && chatLog.length > 0) ? '未开书' : '等待开书'));

    const pillText = win.querySelector('#novel_fw_pill_text');
    if (pillText) pillText.textContent = chapterText;

    const pill = win.querySelector('#novel_fw_pill');
    if (pill) {
        pill.classList.toggle('is-off', !settings.enabled);
        pill.title = `小说连载 · ${chapterText}（点击打开设置，按住可拖动移动位置）`;
        pill.setAttribute('aria-label', `小说连载：${chapterText}，点击打开设置`);
    }

    applyFloatPos();
    // 首次构建时样式/字体可能还没落地，量不准药丸尺寸；下一帧再校正一次位置
    scheduleOverlayResync();
    // 视口暂时量不到时（页面刚加载 / 切回后台标签，innerWidth 可能是 0）单次重排等于没做，
    // 而「定位失败」没有事件会通知我们 —— 有界地多试几帧，直到药丸真的落在可见区里
    ensureFloatPosEventually();
}

// 连载界面 surfaces 统一刷新：楼层内嵌工具条 + 悬浮窗 + 魔法棒菜单项（含被酒馆重绘后的自动补回）
function refreshNovelToolbars() {
    refreshLatestToolbar();
    refreshFloatingWindow();
    injectWandEntry();
    syncWandEntryState();
}

/**
 * 语义版本比较（按数值段逐段比较，杜绝字符串比较陷阱）
 * 背景：JS 字符串比较下 '1.12.0' < '1.7.8' 为 true（逐字符比 '1' vs '7'），
 * 会让版本门控全面误判——v1.12.0 服务端会被当成"低于 1.7.8"而跳过问候语补写。
 * 返回：-1 = a 低于 b；0 = 相等；1 = a 高于 b
 */
function compareVersion(a, b) {
    const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0;
        const nb = pb[i] || 0;
        if (na !== nb) return na < nb ? -1 : 1;
    }
    return 0;
}

function getSettings() {
    const extSettings = ctx.extension_settings || ext_settings_raw || window.extension_settings || {};
    if (!extSettings[EXTENSION_NAME]) {
        extSettings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    } else {
        // 版本平滑迁移：针对升级用户，如果版本低于 1.6.0，自动切换历史默认值至 'numbered_floor'
        const curVer = extSettings[EXTENSION_NAME].version;
        if (!curVer || compareVersion(curVer, '1.6.0') < 0) {
            if (extSettings[EXTENSION_NAME].chapter_style === 'numbered') {
                extSettings[EXTENSION_NAME].chapter_style = 'numbered_floor';
            }
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        }
        extSettings[EXTENSION_NAME].version = DEFAULT_SETTINGS.version;

        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (extSettings[EXTENSION_NAME][key] === undefined) {
                extSettings[EXTENSION_NAME][key] = DEFAULT_SETTINGS[key];
            }
        }

        // v1.13 一次性迁移：界面入口从「扩展抽屉」改为「魔法棒菜单 + 悬浮窗」，
        // 悬浮窗升级为主入口，老用户补开一次（此后用户自己关掉即尊重其选择）
        if (!extSettings[EXTENSION_NAME].ui_v113_migrated) {
            extSettings[EXTENSION_NAME].ui_v113_migrated = true;
            extSettings[EXTENSION_NAME].show_floating_window = true;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        }
    }
    return extSettings[EXTENSION_NAME];
}

/**
 * 健壮的文件名清洗（防 Windows 非法字符与截断）
 */
function sanitizeFilename(rawName) {
    if (!rawName || typeof rawName !== 'string') {
        return '我的小说连载';
    }
    let safeName = rawName
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/[\r\n\t]/g, ' ')
        .replace(/\.{2,}/g, '_')
        .trim();
    safeName = safeName.slice(0, 150).replace(/[. ]+$/, '');

    // 防御 Windows 经典保留设备名 (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safeName)) {
        safeName = `${safeName}_novel`;
    }

    return safeName || '我的小说连载';
}

/**
 * F7：无角色卡上下文下，从聊天记录里取「最近一条非用户消息的说话人」作为角色名候选。
 * 只读、幂等、不抛异常（拿不到就返回空串，调用方继续走原兜底）。
 * 目的：让 getBookTitle(settings) 与 getBookTitle(settings, speakerName) 在无角色卡时同源，
 * 从而 file_name 与 characterName 指向同一本书。
 */
function inferSpeakerNameFromChatLog() {
    try {
        const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
        if (!Array.isArray(chatLog)) return '';
        for (let i = chatLog.length - 1; i >= 0; i--) {
            const m = chatLog[i];
            if (!m || m.is_user) continue;
            const name = (typeof m.name === 'string') ? m.name.trim() : '';
            if (name && name !== '你') return name;
        }
    } catch (e) {
        console.warn('[AutoSaveTxt] 推断角色名失败:', e);
    }
    return '';
}

/**
 * 获取当前连载小说书名
 * 支持根据【文件命名规则】自动区分同一角色卡的不同对话（平行世界、重开等）
 * 支持自动识别多角色群聊 (Group Chat) 并自动聚合为同一部群小说
 */
function getBookTitle(settings, speakerName = '') {
    // 1. 优先检测是否处于群聊 (Group Chat)
    const selectedGroup = (typeof ctx.selected_group !== 'undefined') 
        ? ctx.selected_group 
        : (typeof window !== 'undefined' ? window.selected_group : null);

    if (selectedGroup) {
        let groupName = '群聊纪事';
        const groupList = ctx.groups || (typeof window !== 'undefined' ? window.groups : null) || [];
        if (Array.isArray(groupList)) {
            const grp = groupList.find(g => g.id === selectedGroup);
            if (grp && grp.name) {
                groupName = grp.name;
            }
        }

        const groupPrefix = `[群聊] ${groupName}`;
        if (settings && settings.naming_rule === 'char_only') {
            return groupPrefix;
        }

        let chatTitle = '';
        if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object' && ctx.chatMetadata.title) {
            chatTitle = String(ctx.chatMetadata.title).trim();
        }
        if (!chatTitle) {
            const cId = ctx.chatId || (typeof window !== 'undefined' ? window.chat_id : null);
            if (cId && typeof cId === 'string') {
                chatTitle = cId.replace(/\.jsonl$/i, '').trim();
            }
        }

        if (chatTitle) {
            if (chatTitle.startsWith(groupPrefix + ' - ') || chatTitle.startsWith(groupPrefix + '_')) {
                return chatTitle;
            }
            return `${groupPrefix} - ${chatTitle}`;
        }
        return groupPrefix;
    }

    // 2. 单角色对话逻辑
    let charName = '我的小说连载';
    const charList = ctx.characters || characters_raw || window.characters || [];
    const chid = (typeof ctx.this_chid !== 'undefined') ? ctx.this_chid : (typeof this_chid_raw !== 'undefined' ? this_chid_raw : window.this_chid);
    if (Array.isArray(charList) && typeof chid !== 'undefined' && charList[chid]?.name) {
        charName = charList[chid].name;
    } else if (speakerName && speakerName !== '你') {
        charName = speakerName;
    } else {
        // F7：没有可用角色卡（this_chid 未设置 / characters 未同步）且调用方也没传 speakerName 时，
        // 从聊天记录里推断说话角色名，而不是退回占位名「我的小说连载」。
        // 否则同一次保存会出现 characterName='艾莉丝 - 2026-10-14'、file_name='我的小说连载 - 2026-10-14.txt'
        // 两本不同的书（服务端优先按 file_name 落盘并注册锚点，扉页却用 bookTitle）。
        const inferred = inferSpeakerNameFromChatLog();
        if (inferred) charName = inferred;
    }

    if (settings && settings.naming_rule === 'char_only') {
        return charName;
    }

    // 获取当前对话标题：显示标题(chatMetadata.title)优先，其次角色卡当前聊天文件名，最后聊天文件 ID
    // （与群聊分支"标题跟随"语义一致：改名后书名即时跟随，配合服务端 ID 锚定注册表实现小说文件自动更名）
    let chatTitle = '';
    if (ctx.chatMetadata && typeof ctx.chatMetadata === 'object' && ctx.chatMetadata.title) {
        chatTitle = String(ctx.chatMetadata.title).trim();
    }
    if (!chatTitle && Array.isArray(charList) && typeof chid !== 'undefined' && charList[chid]) {
        const charObj = charList[chid];
        if (charObj.chat && typeof charObj.chat === 'string') {
            chatTitle = charObj.chat.replace(/\.jsonl$/i, '').trim();
        }
    }
    if (!chatTitle) {
        const cId = ctx.chatId || window.chat_id;
        if (cId && typeof cId === 'string') {
            chatTitle = cId.replace(/\.jsonl$/i, '').trim();
        }
    }

    if (chatTitle) {
        // 如果酒馆默认生成的对话文件名已包含角色名前缀（如 "艾莉丝 - 2026-9-10..."）
        if (chatTitle.startsWith(charName + ' - ') || chatTitle.startsWith(charName + '_')) {
            return chatTitle;
        }
        return `${charName} - ${chatTitle}`;
    }

    return charName;
}

// 多账号前缀：仅多用户模式能检测到 currentUser 时生效（防御式多候选读取字段名）
function getAccountPrefix() {
    const acct = ctx.currentUser || (typeof window !== 'undefined' ? window.currentUser : null);
    const name = acct && (acct.name || acct.handle || acct.userName);
    if (!name) return '';
    const safe = sanitizeFilename(String(name)).trim();
    return safe ? `[${safe}] ` : '';
}

// 真实磁盘文件名：账号前缀 + 书名（书卡展示与写入载荷共用，保证两端一致）
function getBookFileName(settings) {
    return `${sanitizeFilename(getAccountPrefix() + getBookTitle(settings))}.txt`;
}

// 聊天文件 ID 锚点（去掉 .jsonl 后缀）：服务端注册表据此实现聊天改名自动跟随重命名
function getChatAnchor() {
    const cId = ctx.chatId || (typeof window !== 'undefined' ? window.chat_id : null);
    return (typeof cId === 'string') ? cId.replace(/\.jsonl$/i, '') : '';
}

const INLINE_TAGS = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'span', 'sub', 'sup', 'small', 'del', 'mark']);

// 标签扫描时忽略的 HTML 结构标签（这些不属于"自定义标签"，不展示在检测器中）
const SCAN_IGNORE_TAGS = new Set([
    ...INLINE_TAGS,
    'html', 'head', 'body', 'div', 'p', 'br', 'hr', 'img', 'a',
    'script', 'style', 'pre', 'code', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'font', 'center', 'blockquote', 'video', 'audio', 'source', 'iframe',
]);

/**
 * 解析标签名单字符串为标签数组（白名单/黑名单输入框与检测器 chips 共用，防止逻辑漂移）
 */
function parseTagList(str) {
    if (typeof str !== 'string' || !str.trim()) return [];
    return str
        .split(/[,，\s]+/)
        .map(t => t.trim().replace(/^<|>$/g, ''))
        .filter(Boolean);
}

/**
 * 扫描会话中出现过的自定义标签，按出现次数降序返回（供"会话标签检测器"展示）
 * 天然跳过闭标签 </tag>、HTML 注释 <!-- --> 与 DOCTYPE；details/summary 不排除（默认黑名单含 details）
 * 返回 { tags: 全部标签 [{tag, count}]（不截断，展示层限高滚动）, total: 总会话标签种数 }
 */
function scanChatTags(chatLog) {
    const counts = new Map();
    if (!Array.isArray(chatLog)) return { tags: [], total: 0 };
    const tagRegex = /<\s*([a-zA-Z][a-zA-Z0-9_\-~.:#]*)[^>]*>/g;
    for (const m of chatLog) {
        const text = (m && typeof m.mes === 'string') ? m.mes : '';
        if (!text) continue;
        tagRegex.lastIndex = 0;
        let match;
        while ((match = tagRegex.exec(text)) !== null) {
            const tag = match[1].toLowerCase();
            if (SCAN_IGNORE_TAGS.has(tag)) continue;
            counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }
    const sorted = [...counts.entries()]
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
    // 全量返回绝不截断：哪怕几十个标签也要全部展示，展示层用限高滚动容器承载
    return { tags: sorted, total: sorted.length };
}

// 思维链/草稿类标签的特征模式：与 cleanNovelText 内 genericAuxiliaryPattern 的标签名部分保持一致
// （引擎正则本体已有测试锁定，勿单独修改此处或彼处之一）
const AUX_TAG_NAME_PATTERN = /[a-zA-Z0-9_\-~.:#]*(?:think|thought|reasoning|cot|scratchpad|reflection|inner_thought|analysis|plan)[a-zA-Z0-9_\-~.:#]*/i;

/**
 * 判断标签是否属于思维链/草稿类（会被清洗引擎全自动剔除，检测器据此打「自动」徽标）
 */
function isAuxiliaryTag(tag) {
    return typeof tag === 'string' && AUX_TAG_NAME_PATTERN.test(tag);
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'); // 单引号同样要转义：属性上下文用单引号包裹时 ' 可闭合属性并注入事件处理器
}

// 会话标签 chip 悬浮提示：单例 tooltip 元素，随面板存在周期复用
let chipTooltipEl = null;

function getChipTooltip() {
    if (!chipTooltipEl || !document.body.contains(chipTooltipEl)) {
        chipTooltipEl = document.createElement('div');
        chipTooltipEl.className = 'novel-chip-tooltip';
        chipTooltipEl.style.display = 'none';
        document.body.appendChild(chipTooltipEl);
    }
    return chipTooltipEl;
}

/**
 * 提取某标签在会话中【最近一次】成对出现的内部内容（供悬浮预览判断是否保留）
 */
function extractTagSample(chatLog, tag, maxLen = 300) {
    const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pairRegex = new RegExp(`<\\s*${safeTag}[^>]*>([\\s\\S]*?)<\\/\\s*${safeTag}\\s*>`, 'i');
    // 从最新一条往前找：只展示最近一次的标签块内容
    for (let i = chatLog.length - 1; i >= 0; i--) {
        const m = chatLog[i];
        const text = (m && typeof m.mes === 'string') ? m.mes : '';
        if (!text || text.indexOf('<') === -1) continue;
        const match = text.match(pairRegex);
        if (match && match[1] && match[1].trim()) {
            return match[1].trim().slice(0, maxLen);
        }
    }
    return '';
}

function showChipTooltip(chipEl) {
    const tag = chipEl.getAttribute('data-tag') || '';
    if (!tag) return;
    // 实时解析当前会话：避免面板未重建时悬浮取样命中旧聊天的缓存引用
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    const sample = extractTagSample(chatLog, tag);
    const tip = getChipTooltip();
    tip.innerHTML = sample
        ? `<span class="novel-chip-tooltip-tag">&lt;${escapeHtml(tag)}&gt;</span> 块内的最新内容：<br>${escapeHtml(sample)}${sample.length >= 300 ? '…' : ''}`
        : `<span class="novel-chip-tooltip-tag">&lt;${escapeHtml(tag)}&gt;</span> 在会话中暂无成对标签内容（可能为自闭合标签或仅有闭标签）`;
    tip.style.display = 'block';

    // 定位：优先显示在 chip 上方，空间不足则翻到下方；水平方向防溢出
    const rect = chipEl.getBoundingClientRect();
    const pad = 8;
    tip.style.left = '0px';
    tip.style.top = '0px';
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = Math.max(pad, Math.min(rect.left, window.innerWidth - tw - pad));
    let top = rect.top - th - 6;
    if (top < pad) top = rect.bottom + 6;
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
}

function hideChipTooltip() {
    if (chipTooltipEl) chipTooltipEl.style.display = 'none';
}

// 清洗结果缓存：同一会话内避免每条消息被 cleanNovelText 重复全量正则清洗（O(n²) 性能优化）
const cleanTextCache = { sig: '', map: new Map() };

function getCleanMessageSig(settings) {
    return `${settings.include_tags || ''}|${settings.exclude_tags || ''}|${settings.indent_paragraphs !== false}`;
}

/**
 * 带缓存的消息清洗：设置签名变化、消息对象被替换（Regenerate/滑动分支）或 mes 被原地改写
 * （酒馆编辑消息/切换分支均直接改写 msg.mes）时自动重洗，确保缓存绝不失真
 */
function getCleanedMessage(msg, index, settings) {
    if (!msg) return '';
    const sig = getCleanMessageSig(settings);
    if (cleanTextCache.sig !== sig) {
        cleanTextCache.sig = sig;
        cleanTextCache.map.clear();
    }
    const cached = cleanTextCache.map.get(index);
    if (cached && cached.src === msg && cached.mes === msg.mes) return cached.text;
    const text = cleanNovelText(msg.mes || '', settings);
    cleanTextCache.map.set(index, { src: msg, mes: msg.mes, text });
    return text;
}

/**
 * 将全部聊天编排为整本小说文本（executeSyncAll 与"导出整本 TXT"共用）
 */
// ==================== 图片电子书（EPUB）基础设施 ====================
// 数据来源：msg.extra.bbiImage（结构化字段），位置来源：正文 <bbi_image>…… 原位标记。
// 契约（实机核对）：
//   · extra.bbiImage["0"][<promptHash>][i]，外层键恒为字符串 "0"
//   · 每条消息可多张图，slotSeq 从 0 开始；**存储顺序不保证等于 slotSeq 顺序**（实测 [2,1,0]）
//   · 正文标记形态：`<bbi_image>` + 该图 prompt 全文（到行末）；标记数 == 图片数（实测 56/56）
//   · path 形如 /user/images/<聊天目录>/<文件>.jpg（中文未编码）→ 磁盘 /data/<账号>/user/images/…

// 原位图片占位符：用【】包住 base64，避开清洗管线的标签剥离、实体解码与缩进前缀。
// base64 只含 [A-Za-z0-9+/=]，不会被任何正则破坏。
const IMG_MARK_PREFIX = '【IMGMARK:';
const IMG_MARK_SUFFIX = '】';

/**
 * 从单条消息的 extra.bbiImage 归一化为按 slotSeq 升序的图片清单。
 * 防御式兼容：extra 缺失 / bbiImage 非对象 / 外层键非 "0" / 值是数组或对象 / 单图对象。
 */
function extractBbiImageList(msg) {
    const raw = msg && msg.extra && msg.extra.bbiImage;
    if (!raw || typeof raw !== 'object') return [];

    // 外层通常是 { "0": { <promptHash>: [img, ...] } }；也兼容直接给 { <promptHash>: [...] }
    const buckets = [];
    const pushBucket = (v) => { if (v && typeof v === 'object') buckets.push(v); };
    if (raw['0'] && typeof raw['0'] === 'object') pushBucket(raw['0']);
    // 其它数字键（如 "1"）也收进来，避免未来版本换层级后漏图
    for (const k of Object.keys(raw)) {
        if (k !== '0' && /^\d+$/.test(k)) pushBucket(raw[k]);
    }
    if (buckets.length === 0) pushBucket(raw); // 兜底：把自身当 bucket

    const out = [];
    const seen = new Set();
    for (const bucket of buckets) {
        for (const key of Object.keys(bucket)) {
            const val = bucket[key];
            const arr = Array.isArray(val) ? val : [val];
            for (const img of arr) {
                if (!img || typeof img !== 'object') continue;
                const p = img.path;
                if (typeof p !== 'string' || !p.trim()) continue;
                // 同一对象可能被数组与兜底重复扫到，用 path+slotSeq 去重
                const sig = `${p}#${img.slotSeq}`;
                if (seen.has(sig)) continue;
                seen.add(sig);
                const seq = (typeof img.slotSeq === 'number' && Number.isFinite(img.slotSeq))
                    ? img.slotSeq : (out.length);
                out.push({
                    path: p.trim(),
                    prompt: typeof img.prompt === 'string' ? img.prompt : '',
                    slotSeq: seq,
                    status: typeof img.status === 'string' ? img.status : '',
                    generationId: typeof img.generationId === 'string' ? img.generationId : '',
                    seed: img.seed,
                    createdAt: img.createdAt
                });
            }
        }
    }
    // 关键：必须按 slotSeq 升序，不能用存储/遍历顺序（实测消息 #106 存储顺序 [2,1,0]）
    out.sort((a, b) => a.slotSeq - b.slotSeq);
    return out;
}

/** 标记匹配（与 cleanNovelText 的前置清理同一条规则，保证"数出来的"能被"删掉的"对上） */
function matchBbiImageMarkers(rawText) {
    if (typeof rawText !== 'string') return [];
    return rawText.match(/<bbi_image[^\n]*/gi) || [];
}

/** 把第 n 张图转成可穿越清洗管线的占位符 */
function makeImageMark(n) {
    return IMG_MARK_PREFIX + btoaSafe(String(n)) + IMG_MARK_SUFFIX;
}
function btoaSafe(s) {
    try {
        if (typeof btoa === 'function') return btoa(s);
    } catch (e) { /* 非浏览器环境走下面 */ }
    return Buffer.from(s, 'utf8').toString('base64');
}
function parseImageMark(mark) {
    try {
        const b64 = mark.slice(IMG_MARK_PREFIX.length, -IMG_MARK_SUFFIX.length);
        let s;
        if (typeof atob === 'function') s = atob(b64);
        else s = Buffer.from(b64, 'base64').toString('utf8');
        const n = parseInt(s, 10);
        return Number.isFinite(n) ? n : -1;
    } catch (e) { return -1; }
}

/**
 * 把正文里的 <bbi_image> 标记替换为占位符，并返回该消息的图片槽位信息。
 * 只有"标记数 == 图片数（且图片可嵌入）"时才启用原位；否则返回 degraded=true，
 * 由调用方退化为"章尾插图"并在预览里标注——绝不猜测位置。
 */
function buildImageSlots(msg, text) {
    const images = extractBbiImageList(msg).filter((im) => im.status === '' || im.status === 'ready');
    const markers = matchBbiImageMarkers(text);
    if (images.length === 0) return { images: [], markers, degraded: false, outText: text, hasImages: false };
    if (images.length !== markers.length) {
        return { images, markers, degraded: true, outText: text, hasImages: true, reason: `标记数(${markers.length})≠图片数(${images.length})` };
    }
    let k = 0;
    const outText = text.replace(/<bbi_image[^\n]*/gi, () => makeImageMark(k++));
    return { images, markers, degraded: false, outText, hasImages: true };
}

/** 把一个清洗后的段落按占位符切分为 text / image 块序列 */
function splitParagraphBlocks(paragraph) {
    const blocks = [];
    const re = /【IMGMARK:([A-Za-z0-9+/=]+)】/g;
    let last = 0;
    let m;
    const pushText = (t) => {
        const s = String(t || '').replace(/^　+/, '').trimEnd();
        if (s && s.trim()) blocks.push({ type: 'text', text: s.trim() });
    };
    while ((m = re.exec(paragraph)) !== null) {
        pushText(paragraph.slice(last, m.index));
        const n = parseImageMark(m[0]);
        if (n >= 0) blocks.push({ type: 'image', slot: n });
        last = m.index + m[0].length;
    }
    pushText(paragraph.slice(last));
    return blocks;
}

/**
 * 取某条消息"带图片占位"的清洗正文。
 * 不污染 cleanTextCache（缓存只存纯文本），图片相关调用量小，直接重算。
 */
function getCleanedMessageWithImageSlots(msg, settings) {
    if (!msg || typeof msg.mes !== 'string') return { blocks: [], degraded: false, slots: { images: [], hasImages: false } };
    const slots = buildImageSlots(msg, msg.mes);
    const cleaned = cleanNovelText(slots.outText, { ...settings, preserve_image_marks: true });
    const paragraphs = String(cleaned || '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    const blocks = [];
    for (const para of paragraphs) {
        for (const blk of splitParagraphBlocks(para)) blocks.push(blk);
    }
    return { blocks, degraded: !!slots.degraded, reason: slots.reason || '', slots };
}

/**
 * 生成"结构化的书"——供 EPUB 导出使用。
 * 返回 { bookTitle, chapters:[{title, floor, speaker, blocks:[{type:'text'|'image',...}]}],
 *        embedImages, imagesFound, imagesDeembedded, warnings }
 * 与 buildNovelText 的口径（章节号、说话人、章节标题）完全一致，只是额外携带块结构与图片。
 *
 * v1.18 修复：此前无论 settings.ebook_embed_images 真假都读图片槽位（开关完全无效）。
 * 现在严格 === true 才走图片解析；关闭时用同一份纯文本清洗结果生成 text 块，
 * 因此纯文字 EPUB 的章节数 / 标题 / 正文与 TXT 路径逐字同口径。
 */
function buildStructuredNovel(settings, chatLog) {
    const embedImages = settings.ebook_embed_images === true;
    const bookTitle = getBookTitle(settings);
    const chapters = [];
    const warnings = [];
    let chapterCount = 0;
    let imagesDeembedded = 0;
    let imagesTotal = 0;

    // 注意：必须用括号把三元表达式括起来。写成 `i < Array.isArray(chatLog) ? ... : 0`
    // 会因为运算符优先级被解析成 `(i < Array.isArray(chatLog)) ? ... : 0`，
    // 导致 i=1 起就退出循环 → EPUB 只导出第 1 章（K1 契约测试守护此行为）。
    const list = Array.isArray(chatLog) ? chatLog : [];
    for (let i = 0; i < list.length; i++) {
        const msg = list[i];
        if (!msg) continue;
        if (msg.is_user && !settings.include_user_dialogue) continue;
        // 纯文字模式完全不做图片解析；嵌图模式才去取带占位符的块结构
        const withImages = embedImages ? getCleanedMessageWithImageSlots(msg, settings) : null;
        // 以纯文本清洗结果判断"是否为空楼层"——与 buildNovelText 完全同口径
        const plain = getCleanedMessage(msg, i, settings);
        if (!plain) continue;

        chapterCount++;
        const speaker = msg.name || (msg.is_user ? '你' : '旁白');
        const floor = i + 1;
        let title;
        if (settings.chapter_style === 'separator') title = '* * *';
        else if (settings.chapter_style === 'dialogue') title = `【${speaker}】`;
        else if (settings.chapter_style === 'numbered') title = `第 ${chapterCount} 节 · ${speaker}`;
        else title = `第 ${chapterCount} 章 · ${speaker} (原楼层: ${floor})`;

        const blocks = [];
        const slotImages = withImages ? (withImages.slots.images || []) : [];
        if (withImages) {
            imagesTotal += slotImages.length;
            for (const blk of withImages.blocks) {
                if (blk.type === 'image') {
                    const img = slotImages[blk.slot];
                    if (img && img.path) {
                        blocks.push({ type: 'image', path: img.path, alt: shortPromptAlt(img.prompt, speaker), slotSeq: img.slotSeq });
                    } else {
                        imagesDeembedded++;
                    }
                } else {
                    blocks.push({ type: 'text', text: blk.text });
                }
            }
            // 降级：标记数与图片数不一致时，图片放到章尾（不丢图，但标注）
            if (withImages.degraded && slotImages.length) {
                for (const img of slotImages) {
                    if (img && img.path) blocks.push({ type: 'image', path: img.path, alt: shortPromptAlt(img.prompt, speaker), slotSeq: img.slotSeq });
                }
                warnings.push(`第 ${chapterCount} 章：${withImages.reason}，已退化为章尾插图`);
            }
        } else {
            // 纯文字模式：直接用同一份 plain 文本按 TXT 口径切段，块文本/章节标题/章节数与 buildNovelText 一致
            for (const para of String(plain).split(/\n{2,}/)) {
                const text = para.trim();
                if (text) blocks.push({ type: 'text', text });
            }
        }
        chapters.push({ title, floor, speaker, blocks });
    }

    return {
        bookTitle,
        chapters,
        chapterCount,
        embedImages,
        imagesFound: embedImages ? imagesTotal : 0,
        imagesDeembedded,
        warnings
    };
}

/** 用 prompt 摘要作为图片 alt（阅读器无障碍/加载失败时可见） */
function shortPromptAlt(prompt, fallback) {
    const s = String(prompt || '').replace(/<bbi_image>/i, '').replace(/\s+/g, ' ').trim();
    if (!s) return fallback || '';
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
}

/**
 * 图片清单扫描（P0.5 探针）：只读，用于预览弹窗展示"识别到几张图 / 校验是否一致"。
 * 返回 { messages:[{index, chapterNumber, images, markerCount, degraded, reason}],
 *        totalImages, imageMessages, degradedCount, missingList }
 */
function scanBookImages(settings, chatLog) {
    const result = {
        messages: [],
        totalImages: 0,
        imageMessages: 0,
        degradedCount: 0,
        missingList: []
    };
    const list = Array.isArray(chatLog) ? chatLog : [];
    let chapter = 0;
    for (let i = 0; i < list.length; i++) {
        const msg = list[i];
        if (!msg) continue;
        if (msg.is_user && !settings.include_user_dialogue) continue;
        const plain = getCleanedMessage(msg, i, settings);
        if (!plain) continue;
        chapter++;
        const images = extractBbiImageList(msg);
        if (!images.length) continue;
        const markers = matchBbiImageMarkers(msg.mes || '');
        const embeddable = images.filter((im) => im.status === '' || im.status === 'ready');
        const notReady = images.filter((im) => im.status && im.status !== 'ready');
        // 降级判定只看"可嵌入数 vs 标记数"：非 ready 的图本来就不会去占位，
        // 单独记到 missingList 里（否则会误报"标记数≠图片数"）。
        const degraded = embeddable.length !== markers.length;
        if (degraded) result.degradedCount++;
        for (const im of notReady) {
            result.missingList.push(`楼层 ${i + 1}：图片状态 ${im.status || '未知'}`);
        }
        result.totalImages += images.length;
        result.imageMessages++;
        result.messages.push({
            index: i,
            chapter,
            floor: i + 1,
            speaker: msg.name || '旁白',
            markerCount: markers.length,
            imageCount: images.length,
            embeddableCount: embeddable.length,
            notReadyCount: notReady.length,
            degraded,
            reason: degraded ? `标记数(${markers.length})≠可嵌入图片数(${embeddable.length})` : '',
            images
        });
    }
    return result;
}

/**
 * 将全部聊天编排为整本小说文本（executeSyncAll 与"导出整本 TXT"共用）
 * 口径：章节号、说话人、章节标题与 buildStructuredNovel 完全一致。
 */
function buildNovelText(settings, chatLog) {
    const bookTitle = getBookTitle(settings);
    let novelText = `《${bookTitle}》\n\n`;
    let chapterCount = 0;

    for (let i = 0; i < chatLog.length; i++) {
        const msg = chatLog[i];
        if (!msg) continue;
        if (msg.is_user && !settings.include_user_dialogue) continue;
        const cleanMes = getCleanedMessage(msg, i, settings);
        if (!cleanMes) continue;

        chapterCount++;
        const speaker = msg.name || (msg.is_user ? '你' : '旁白');
        const floor = i + 1;
        if (settings.chapter_style === 'separator') {
            novelText += `* * *\n\n${cleanMes}\n\n\n`;
        } else if (settings.chapter_style === 'dialogue') {
            novelText += `【${speaker}】\n\n${cleanMes}\n\n\n`;
        } else if (settings.chapter_style === 'numbered') {
            novelText += `第 ${chapterCount} 节 · ${speaker}\n\n${cleanMes}\n\n\n`;
        } else {
            novelText += `第 ${chapterCount} 章 · ${speaker} (原楼层: ${floor})\n\n${cleanMes}\n\n\n`;
        }
    }

    return { bookTitle, novelText, chapterCount };
}

/**
 * 通用小说正文排版与全能标签清洗引擎
 */
function cleanNovelText(rawText, settings = {}) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText;

    // 前置清洗：彻底过滤 HTML 注释 (如 <!-- Lorebook: ... -->) 与 Markdown 多媒体图片
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    text = text.replace(/!\[.*?\]\(.*?\)/g, '');
    text = text.replace(/<img[^>]*>/gi, '');
    // bbi 图像生成标记：形如 `<bbi_image>1boy 1girl, close-up, …`（标记 + prompt 直到行末）。
    // 必须【连同 prompt 一起】删到行末——只删标签本身会把英文绘图提示词当正文留下（v1.17.8 修复）。
    // 注意：不能用 `<[^>]*>` 那种通用标签规则，因为 prompt 里可能含 '>'，会只删掉半截。
    // 例外：图片电子书导出时，调用方已把标记换成【IMGMARK:…】占位符（不会命中本规则），
    //       并通过 preserve_image_marks 要求保留占位符以便还原原位。
    text = text.replace(/<bbi_image[^\n]*/gi, '');

    // 阶段零【通用前置无头标签与思维链智能清洗】：
    // 应对任何反代、Prefill、插件导致的“开篇无起始标签、仅有闭标签”问题（无论标签名叫什么，均可自动识别并切除）
    let prevLeadText = '';
    while (prevLeadText !== text) {
        prevLeadText = text;
        const match = text.match(/^([\s\S]*?)<\/\s*([a-zA-Z][a-zA-Z0-9_\-~.:#]*)\s*>\s*/i);
        if (match) {
            const beforeClosing = match[1];
            const tagName = match[2].toLowerCase();
            if (!INLINE_TAGS.has(tagName)) {
                const safeTag = match[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const openTagRegex = new RegExp(`<\\s*${safeTag}[^>]*>`, 'i');
                if (!openTagRegex.test(beforeClosing)) {
                    // 开篇内容中不存在对应开标签，证实这是被省略了开标签的前置内容，彻底切除
                    text = text.slice(match[0].length);
                    continue;
                }
            }
        }
        break;
    }

    // 泛化剔除成对的思考/思维链/草稿/规划标签（覆盖 think, thought, reasoning, cot, scratchpad, reflection, inner_thought 等各类变体）
    const genericAuxiliaryPattern = /<\s*([a-zA-Z0-9_\-~.:#]*(?:think|thought|reasoning|cot|scratchpad|reflection|inner_thought|analysis|plan)[a-zA-Z0-9_\-~.:#]*)[^>]*>[\s\S]*?<\/\s*\1\s*>\s*/gi;
    text = text.replace(genericAuxiliaryPattern, '');

    // 剔除末尾未闭合的思考链（针对 max_tokens 截断未输出闭合标签的情况）
    const unclosedAuxPattern = /<\s*([a-zA-Z0-9_\-~.:#]*(?:think|thought|reasoning|cot|scratchpad|reflection|inner_thought|analysis|plan)[a-zA-Z0-9_\-~.:#]*)[^>]*>[\s\S]*$/i;
    text = text.replace(unclosedAuxPattern, '');

    // 阶段一【白名单模式】：优先提取指定标签内的正文
    const includeTags = parseTagList(settings.include_tags);

    if (includeTags.length > 0) {
        const extractedParts = [];
        for (const tag of includeTags) {
            const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const tagRegex = new RegExp(`<\\s*(${safeTag})[^>]*>([\\s\\S]*?)<\\/\\s*\\1\\s*>`, 'gi');
            let match;
            while ((match = tagRegex.exec(text)) !== null) {
                if (match[2] && match[2].trim()) {
                    extractedParts.push(match[2].trim());
                }
            }
        }
        if (extractedParts.length > 0) {
            text = extractedParts.join('\n\n');
        }
    }

    // 阶段二【黑名单模式】：深度剔除不要的标签块（支持成对、开篇无开标签、尾部未闭合等各类异常形态）
    const excludeTags = parseTagList(
        (typeof settings.exclude_tags === 'string')
            ? settings.exclude_tags
            : (DEFAULT_SETTINGS.exclude_tags || '')
    );

    if (excludeTags.length > 0) {
        for (const tag of excludeTags) {
            const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // 1. 成对标签块排除
            const pairReg = new RegExp(`<\\s*(${safeTag})[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>\\s*`, 'gi');
            text = text.replace(pairReg, '');

            // 2. 开篇缺失开标签、仅有闭标签的孤立块排除
            if (!new RegExp(`<\\s*${safeTag}[^>]*>`, 'i').test(text)) {
                const orphanCloseReg = new RegExp(`^[\\s\\S]*?<\\/\\s*${safeTag}\\s*>\\s*`, 'i');
                text = text.replace(orphanCloseReg, '');
            }

            // 3. 末尾只有开标签但未闭合的残留块排除
            if (!new RegExp(`<\\/\\s*${safeTag}\\s*>`, 'i').test(text)) {
                const unclosedTailReg = new RegExp(`<\\s*${safeTag}[^>]*>[\\s\\S]*$`, 'i');
                text = text.replace(unclosedTailReg, '');
            }
        }
    }

    // 阶段三【网页与排版杂质清洗】
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<br\s*[\/]?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/?[a-zA-Z0-9_\-~.:#]+[^>]*>/g, '');

    text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    // 阶段四【中文出版小说段落规范化】
    const paragraphs = text
        .split(/\r?\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

    const shouldIndent = settings.indent_paragraphs !== false;
    let result = shouldIndent
        ? paragraphs.map(p => `　　${p}`).join('\n\n')
        : paragraphs.join('\n\n');

    // 图片电子书导出：保留原位占位符，供调用方 splitParagraphBlocks 还原为图片块。
    // 默认（普通 TXT 写入）不加 preserve_image_marks，输出与既有行为逐字节一致；
    // 且即使有占位符残留，也在此统一剥掉，绝不让内部标记漏进用户 TXT。
    if (settings.preserve_image_marks === true) {
        return result;
    }
    return result.replace(/【IMGMARK:[A-Za-z0-9+/=]+】/g, '');
}

/**
 * 检测服务端连载插件运行状态（优先探测状态探针，降级探测 append 接口）
 */
async function checkServerPluginStatus() {
    try {
        const headers = (typeof getRequestHeaders === 'function') 
            ? getRequestHeaders() 
            : { 'Content-Type': 'application/json' };

        // 优先探测专用的状态探针接口
        const statusResp = await fetch('/api/plugins/auto-save/status', {
            method: 'GET',
            headers: headers
        }).catch(() => null);

        if (statusResp && statusResp.ok) {
            const data = await statusResp.json().catch(() => ({}));
            // 能力声明：新服务端会带 capabilities；老服务端没有该字段 → 视为只有基础能力。
            // 前端据此 feature-detect（比比较版本号更可靠），例如是否显示「导出 EPUB 电子书」。
            serverCapabilities = (data && typeof data.capabilities === 'object' && data.capabilities) || {};
            return { ready: true, version: data.version, capabilities: serverCapabilities, is404: false };
        }

        if (statusResp && statusResp.status === 404) {
            return { ready: false, is404: true, code: 404 };
        }

        // 降级使用 append 接口探测
        const appendResp = await fetch('/api/plugins/auto-save/append', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({}),
        }).catch(() => null);

        if (appendResp && appendResp.status === 400) {
            return { ready: true, is404: false };
        }

        const is404 = appendResp ? appendResp.status === 404 : false;
        return { ready: false, is404, code: appendResp ? appendResp.status : 0 };
    } catch (err) {
        return { ready: false, is404: false, code: err.message };
    }
}

async function postChapterToServer(payload) {
    try {
        const headers = (typeof getRequestHeaders === 'function') 
            ? getRequestHeaders() 
            : { 'Content-Type': 'application/json' };

        if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        const response = await fetch('/api/plugins/auto-save/append', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData.error || `写入失败 (HTTP ${response.status})`;
            console.warn(`[AutoSaveTxt] ${errMsg}`);
            // D4：409 冲突是「可诊断的拒绝」而非单纯失败，必须把 conflict/reason 一路带到调用方，
            // 否则 saveSpecificMessage 只能显示一句笼统的 HTTP 409，用户不知道该去点【同步历史连载】。
            return {
                success: false,
                status: response.status,
                error: errMsg,
                conflict: !!errData.conflict,
                reason: errData.reason || '',
                chapterNumber: (typeof errData.chapterNumber !== 'undefined') ? errData.chapterNumber : undefined,
            };
        }

        const data = await response.json().catch(() => ({}));
        if (!data.skipped) {
            console.log(`[AutoSaveTxt] 新章节已融入小说: ${data.file || ''}`);
        }
        return {
            success: true,
            file: data.file,
            skipped: data.skipped,
            renamed_from: data.renamed_from,
            kept_name: data.kept_name,
            conflict: !!data.conflict,
            reason: data.reason || '',
            is_regenerate: (typeof data.is_regenerate !== 'undefined') ? data.is_regenerate : payload.is_regenerate
        };
    } catch (error) {
        console.warn('[AutoSaveTxt] 连接服务端插件异常:', error);
        return { success: false, error: error.message };
    }
}

/**
 * 用当前聊天里最后一层可入书内容播种「已保存签名」，用于判断下一次写入是新增还是重生成。
 *
 * @param {{skipGreeting?: boolean}} [options]
 *   D2 修复：boot / refreshContext 必须传 { skipGreeting: true }。
 *   索引 0、非用户的角色问候语**不是**已入书章节（它由 ensureGreetingSerialized 在用户
 *   发出第一条消息时补写为第 1 章）。若把它播种成"已保存"，ensureGreetingSerialized 会
 *   命中同签名 early return，问候语永远写不进文件；同时首条 AI 回复被算成第 2 章。
 *   默认 false 保持旧行为，避免影响其它调用点。
 */
function seedLastSavedSignature(options = {}) {
    const skipGreeting = !!(options && options.skipGreeting);
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    if (!chatLog || chatLog.length === 0) {
        lastSavedSignature = { messageId: null, characterName: '', mesSnippet: '' };
        lastSettledSavedIndex = -1;
        return;
    }
    let seeded = false;
    for (let i = chatLog.length - 1; i >= 0; i--) {
        const m = chatLog[i];
        if (!m) continue;
        if (m.is_user && !settings.include_user_dialogue) continue;
        // 问候语（仅索引 0 且非用户）不登记：它尚未入书，等 ensureGreetingSerialized 补写
        if (skipGreeting && i === 0 && !m.is_user) continue;
        const clean = getCleanedMessage(m, i, settings);
        if (clean) {
            const speaker = m.name || (m.is_user ? '你' : '旁白');
            lastSavedSignature = {
                messageId: i,
                characterName: getBookTitle(settings, speaker),
                mesSnippet: clean.slice(0, 80)
            };
            lastSettledSavedIndex = i;
            seeded = true;
            break;
        }
    }
    // 整个聊天只有问候语（或全部楼层被过滤为空）：明确回到"什么都没保存"的初始态，
    // 否则刷聊天时会残留上一个聊天的签名，误导重生成判定。
    if (!seeded) {
        lastSavedSignature = { messageId: null, characterName: '', mesSnippet: '' };
        lastSettledSavedIndex = -1;
    }
}

async function checkAndSaveBufferedTurn(settings, chatLog) {
    if (!chatLog || chatLog.length < 2) return;

    // 倒序寻找最新一楼之前的最后一个有效回复进行定稿落盘
    for (let i = chatLog.length - 2; i >= 0; i--) {
        const m = chatLog[i];
        if (!m) continue;
        if (i === 0 && !m.is_user) continue; // 角色问候语不入书
        if (m.is_user && !settings.include_user_dialogue) continue;
        const clean = getCleanedMessage(m, i, settings);
        if (!clean) continue;

        // 如果该楼层已经在之前定稿落盘过，无需重复写入
        if (lastSettledSavedIndex >= i) {
            break;
        }

        // 执行定稿写入
        await saveSpecificMessage(i, settings, chatLog);
        break;
    }
}

async function saveSpecificMessage(messageIndex, settings, chatLog) {
    const message = chatLog[messageIndex];
    if (!message) return;

    if (message.is_user && !settings.include_user_dialogue) {
        return;
    }

    let speakerName = message.name || (message.is_user ? '你' : '旁白');
    let bookTitle = getBookTitle(settings, speakerName);

    const novelText = cleanNovelText(message.mes || '', settings);
    if (!novelText) {
        updateRecentStatus('skipped', '最新回复经标签过滤后无正文，已略过写入');
        return;
    }

    const mesSnippet = novelText.slice(0, 80);
    // 存档内容摘要：写入提示里附带开头片段，方便用户核对归档的是哪一条回复
    const previewSnippet = novelText.replace(/\n+/g, ' ').slice(0, 24);
    const snippetSuffix = `：“${previewSnippet}${novelText.length > 24 ? '…' : ''}”`;
    // 判断是否为完全重复的内容（同一条消息且内容一模一样）
    if (
        lastSavedSignature.messageId === messageIndex &&
        lastSavedSignature.characterName === bookTitle &&
        lastSavedSignature.mesSnippet === mesSnippet
    ) {
        return;
    }

    // 智能识别“重新生成 (Regenerate)”或“滑动分支 (Swipe)”：
    // 当消息序号等于上一次保存的序号，但内容不同，说明用户重新生成了该条回复，需要更新替换末尾章节
    const isRegenerate = (
        lastSavedSignature.messageId === messageIndex &&
        lastSavedSignature.characterName === bookTitle &&
        lastSavedSignature.mesSnippet !== '' &&
        lastSavedSignature.mesSnippet !== mesSnippet
    );

    // 精确计算有效章节序号（跳过被过滤为空白的消息，确保与全本同步序号 100% 一致）
    let chapterNumber = 0;
    for (let i = 0; i <= messageIndex; i++) {
        const m = chatLog[i];
        if (!m) continue;
        if (m.is_user && !settings.include_user_dialogue) continue;
        const c = getCleanedMessage(m, i, settings);
        if (c) chapterNumber++;
    }
    chapterNumber = chapterNumber || 1;

    const floor = messageIndex + 1;

    // F6：区分「聊天视角的章节号」与「文件里的定位键」。
    // is_regenerate 的意图是替换**该楼层已经写进文件的章节**，定位键必须来自
    // savedChapterMap[messageIndex]（该楼层真实落盘的章号），而不是实时重算的 chapterNumber。
    // 问候语入书后 AI 首答的聊天视角编号是 2，但文件里此刻只有第 1 章：
    // 拿 2 当替换目标 → 服务端守卫正确返回 409 chapter_not_found → 用户的第一条 AI 回复被丢弃。
    // 三条分支：
    //   a) 该楼层已有落盘章号 → 真正的重生成/swipe，替换它（幂等，文案也反馈真实章号）；
    //   b) 该楼层没有落盘章号（含页面刷新后 lastWrittenChapterNumber === 0 的状态未知）→
    //      退化为普通追加，绝不发替换意图：替换必然 409 丢内容，追加最坏只是多一章，宁可重复也不丢；
    //   c) 其它 → 普通追加。
    const previousWrittenChapter = (typeof savedChapterMap[messageIndex] === 'number') ? savedChapterMap[messageIndex] : 0;
    const wantRegenerate = isRegenerate && previousWrittenChapter > 0;
    if (isRegenerate && previousWrittenChapter <= 0) {
        console.warn(lastWrittenChapterNumber <= 0
            ? '[AutoSaveTxt] 替换目标章号未知（页面刷新后状态丢失），本次退化为普通追加以避免 409 丢内容'
            : `[AutoSaveTxt] 第 ${floor} 楼尚未落盘，本次按新增章节写入（避免替换文件末尾章导致内容错位）`);
    }
    // 替换定位键用该楼层真实落盘章号；仍取不到时才回落到文件末尾章号，最后回落到实时重算值
    const effectiveChapterNumber = wantRegenerate
        ? previousWrittenChapter
        : (chapterNumber || lastWrittenChapterNumber || 1);

    const isNumberedFloor = (settings.chapter_style === 'numbered_floor' || !settings.chapter_style);
    const sectionLabel = isNumberedFloor ? `第 ${chapterNumber} 章` : ((settings.chapter_style === 'numbered') ? `第 ${chapterNumber} 节` : '新章节');
    const floorLabel = isNumberedFloor ? ` (原楼层: ${floor})` : '';
    // 实际落盘所在的章节标签（替换时是文件里的章号，可能与聊天视角编号不同）
    const effectiveChapterLabel = isNumberedFloor ? `第 ${effectiveChapterNumber} 章` : ((settings.chapter_style === 'numbered') ? `第 ${effectiveChapterNumber} 节` : '新章节');

    // 1. 设置状态为更新中（顶栏指示灯与面板卡片即时响应）
    const actionText = wantRegenerate ? '正在替换更新' : '正在编排写入';
    updateRecentStatus('updating', `${actionText}${effectiveChapterLabel} · ${speakerName}${floorLabel}...`);

    const payload = {
        name: speakerName,
        mes: novelText,
        is_user: !!message.is_user,
        characterName: bookTitle,
        chapterNumber: effectiveChapterNumber,
        chapterStyle: settings.chapter_style || 'numbered_floor',
        save_dir: settings.save_dir || '',
        is_regenerate: wantRegenerate,
        floor: floor,
        chat_anchor: getChatAnchor(),
        file_name: getBookFileName(settings)
    };

    const res = await postChapterToServer(payload);
    if (res && res.success) {
        lastSavedSignature = {
            messageId: messageIndex,
            characterName: bookTitle,
            mesSnippet: mesSnippet
        };
        lastSettledSavedIndex = Math.max(lastSettledSavedIndex, messageIndex);
        recentStatus.chapter = effectiveChapterNumber;
        // F6：只有真的写进文件（非 skipped）才算「文件里的最后一章」，skipped 时文件没变
        if (!res.skipped) {
            const ackedChapter = (res && typeof res.chapterNumber === 'number') ? res.chapterNumber : effectiveChapterNumber;
            lastWrittenChapterNumber = ackedChapter > 0 ? ackedChapter : effectiveChapterNumber;
        }

        const targetFile = res.file || `${bookTitle}.txt`;

        // D3：以下提示全部喂给 toastr（支持 HTML），插值一律出口转义
        const safeSpeaker = escapeHtml(speakerName);
        const safeBookTitle = escapeHtml(bookTitle);
        const safeSnippetSuffix = escapeHtml(snippetSuffix);
        const safeTargetFile = escapeHtml(targetFile);

        // 聊天改名自动跟随：服务端 ID 锚定注册表检测到书名变化，已同步更名小说文件
        const renameSuffix = res.renamed_from ? '（检测到聊天改名，小说文件已同步更名）' : '';
        if (res.renamed_from && settings.show_toast !== false && window.toastr) {
            window.toastr.info(`小说文件已跟随聊天改名：${escapeHtml(res.renamed_from)} → ${safeTargetFile}`, '小说连载', { timeOut: 5000 });
        }

        if (res.skipped) {
            updateRecentStatus('skipped', `${sectionLabel}末尾内容重复，已自动略过写入`, targetFile);
            if (settings.show_toast !== false && window.toastr) {
                window.toastr.info(`${sectionLabel}内容与前文重复，已略过`, '小说连载', { timeOut: 2500 });
            }
        } else if (res.is_regenerate || wantRegenerate) {
            // 替换分支：文案里显示的必须是**文件里真正被替换的章号**，否则用户看到的章号与文件对不上
            updateRecentStatus('success', `${effectiveChapterLabel} · ${speakerName}${floorLabel}（重新生成已替换更新）${snippetSuffix}${renameSuffix}`, targetFile);
            if (settings.show_toast !== false && window.toastr) {
                throttledNovelSuccessToast(`${effectiveChapterLabel}${floorLabel}已更新为最新生成版本${safeSnippetSuffix}`, '小说连载', {
                    timeOut: 3000,
                    preventDuplicates: true
                });
            }
        } else {
            // 2. 更新完成提示（顶栏指示灯与面板卡片）
            updateRecentStatus('success', `${sectionLabel} · ${speakerName}${floorLabel} 连载成功！${snippetSuffix}${renameSuffix}`, targetFile);

            // 3. 屏幕 Toast 提示通知
            if (settings.show_toast !== false && window.toastr) {
                throttledNovelSuccessToast(`${sectionLabel} · ${safeSpeaker}${floorLabel} 已自动写入《${safeBookTitle}》${safeSnippetSuffix}`, '小说连载', {
                    timeOut: 3500,
                    preventDuplicates: true
                });
            }
        }

        // ①④ 非跳过的成功写入：登记楼层章节号并重绘"已入书"徽标与最新楼层工具条
        if (!res.skipped) {
            savedChapterMap[messageIndex] = effectiveChapterNumber;
            refreshMessageBadges();
            refreshNovelToolbars();
        }
    } else {
        // D4：服务端 409 冲突专用分支 —— 绝不当作成功，也绝不登记 lastSavedSignature。
        // 一旦误登记，后续 regenerate 判定会把「其实没写进去的章」当成已保存的末尾章，越写越乱。
        const conflictReason = res && (res.reason || '');
        const conflictStatus = res && res.status === 409;
        if (conflictStatus || (res && res.conflict)) {
            const failedChapter = (res && typeof res.chapterNumber === 'number') ? res.chapterNumber : chapterNumber;
            const failedLabel = `第 ${failedChapter} 章`;
            if (conflictReason === 'not_tail_chapter') {
                updateRecentStatus('error', `未替换：${failedLabel}不是文件末尾章，已放弃以避免误删后续章节。请用【同步历史连载】重新校准目录后重试。`);
                if (settings.show_toast !== false && window.toastr) {
                    window.toastr.warning(
                        `${failedLabel}不是文件末尾章，为避免误删后续章节已放弃替换。请点【同步历史连载】校准后再试。`,
                        '小说连载',
                        { timeOut: 6000, preventDuplicates: true }
                    );
                }
            } else if (conflictReason === 'chapter_exists') {
                updateRecentStatus('error', `第 ${failedChapter} 章已存在，已拒绝重复追加。请用【同步历史连载】校准目录后重试。`);
                if (settings.show_toast !== false && window.toastr) {
                    window.toastr.warning(
                        `第 ${failedChapter} 章已存在，已拒绝重复追加（避免同一章写两遍）。请点【同步历史连载】校准后再试。`,
                        '小说连载',
                        { timeOut: 6000, preventDuplicates: true }
                    );
                }
            } else if (conflictReason === 'chapter_not_found') {
                // F7：替换目标章在文件里不存在（例如文件被手工编辑/删章、或换过保存目录）。
                // 与另两条 reason 对齐，必须给明恢复动作，否则用户只知道"被拒绝"却不知道点哪。
                updateRecentStatus('error', `未替换：文件中未找到${failedLabel}，已放弃以避免内容错位。请用【同步历史连载】重新校准后再试。`);
                if (settings.show_toast !== false && window.toastr) {
                    window.toastr.warning(
                        `文件中未找到${failedLabel}，为避免内容错位已放弃替换。请点【同步历史连载】校准后再试。`,
                        '小说连载',
                        { timeOut: 6000, preventDuplicates: true }
                    );
                }
            } else {
                const conflictErr = (res && res.error) ? res.error : `HTTP ${(res && res.status) || 409}`;
                updateRecentStatus('error', `${sectionLabel}写入被拒绝: ${conflictErr}`);
                if (settings.show_toast !== false && window.toastr) {
                    window.toastr.warning(`${sectionLabel}自动连载被拒绝: ${conflictErr}`, '小说连载', { timeOut: 4500 });
                }
            }
            return;
        }

        const is404 = res && (res.status === 404 || (res.error && String(res.error).includes('404')));
        if (is404) {
            settings.enabled = false;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            const enableCheckbox = document.getElementById('novel_save_enabled');
            if (enableCheckbox) enableCheckbox.checked = false;

            updateRecentStatus('idle', '未检测到服务端插件 (HTTP 404)，已自动暂停实时连载以防报错');

            if (settings.show_toast !== false && window.toastr) {
                window.toastr.warning(
                    '未检测到服务端插件 (HTTP 404)，已自动为您取消勾选连载，防止频繁报错。您可以随时使用【导出整本 TXT】一键下载，或参考下方指引部署插件。',
                    '小说连载',
                    { timeOut: 6000, preventDuplicates: true }
                );
            }
            return;
        }

        const errMsg = (res && res.error) ? res.error : (res && res.status ? `HTTP ${res.status}` : '连接服务端插件异常');
        updateRecentStatus('error', `${sectionLabel}写入失败: ${errMsg}`);

        if (settings.show_toast !== false && window.toastr) {
            window.toastr.warning(`${sectionLabel}自动连载失败: ${escapeHtml(errMsg)}`, '小说连载', {
                timeOut: 4500
            });
        }
    }
}

// 已探测的服务端插件版本（问候语补写 is_greeting 需要服务端 ≥ 1.7.8 支持，旧服务端自动降级跳过）
let serverPluginVersion = null;
// 服务端能力声明（来自 /status.capabilities）；老服务端为 {}，据此 feature-detect 新功能
let serverCapabilities = {};

/**
 * 问候语延迟入书：新开聊天时问候语不产生任何文件（看卡/调试零打扰）；
 * 当用户发出第一条消息（会话恰好为 问候语+用户消息）时，把问候语作为第 1 章补写入书。
 * 服务端对已存在内容的文件自动跳过——旧书不会重复写入，新书不会遗漏。
 */
async function ensureGreetingSerialized(settings, chatLog) {
    if (!Array.isArray(chatLog) || chatLog.length !== 2) return;
    if (serverPluginVersion && compareVersion(serverPluginVersion, '1.7.8') < 0) return;
    const greeting = chatLog[0];
    if (!greeting || greeting.is_user) return;
    if (!chatLog[1] || !chatLog[1].is_user) return;
    const novelText = cleanNovelText(greeting.mes || '', settings);
    if (!novelText) return;

    const speakerName = greeting.name || '旁白';
    const bookTitle = getBookTitle(settings, speakerName);
    const mesSnippet = novelText.slice(0, 80);
    if (lastSavedSignature.messageId === 0 &&
        lastSavedSignature.characterName === bookTitle &&
        lastSavedSignature.mesSnippet === mesSnippet) {
        return; // 已入书（例如缓冲模式先一步定稿）
    }

    const res = await postChapterToServer({
        name: speakerName,
        mes: novelText,
        is_user: false,
        characterName: bookTitle,
        chapterNumber: 1,
        chapterStyle: settings.chapter_style || 'numbered_floor',
        save_dir: settings.save_dir || '',
        is_regenerate: false,
        is_greeting: true,
        floor: 1,
        chat_anchor: getChatAnchor(),
        file_name: getBookFileName(settings)
    });

    if (res && res.success && res.skipped) {
        // D2 幂等：服务端因「文件已有内容」跳过问候语时，说明这封信已经在书里了，
        // 只是不是这次写的。同样要把签名登记为"已对齐"，否则每轮消息都会重发一次补写请求；
        // 但不弹成功提示、不播报"连载正式开始"。
        lastSavedSignature = { messageId: 0, characterName: bookTitle, mesSnippet };
        lastSettledSavedIndex = Math.max(lastSettledSavedIndex, 0);
        recentStatus.chapter = Math.max(recentStatus.chapter, 1);
        savedChapterMap[0] = 1;
        refreshMessageBadges();
        refreshNovelToolbars();
    } else if (res && res.success) {
        lastSavedSignature = { messageId: 0, characterName: bookTitle, mesSnippet };
        lastSettledSavedIndex = Math.max(lastSettledSavedIndex, 0);
        recentStatus.chapter = Math.max(recentStatus.chapter, 1);
        // F6：问候语真的写成第 1 章 → 文件里的末尾章号 = 1（后续替换必须定位到 1，而不是聊天视角的第 2 章）
        lastWrittenChapterNumber = 1;
        updateRecentStatus('success', `第 1 章 · ${speakerName} (原楼层: 1)（问候语已入书，连载正式开始）`, res.file || `${bookTitle}.txt`);
        // ①④ 问候语入书：登记第 1 章并重绘徽标与工具条
        savedChapterMap[0] = 1;
        refreshMessageBadges();
        refreshNovelToolbars();
    }
}

async function handleMessageSave(messageIdOrData, isFromUser = false) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    if (!chatLog || chatLog.length === 0) return;

    // 解析目标楼层：仅当事件载荷是合法数组下标、且消息类型与事件匹配时才信任它；
    // 否则回退到最近一条同类型消息（兼容不同 ST 版本的载荷语义、双触发、删除消息后的过期下标等边界）
    let messageIndex = -1;
    let payloadIndex = -1;
    if (typeof messageIdOrData === 'number') {
        payloadIndex = messageIdOrData;
    } else if (messageIdOrData && typeof messageIdOrData.messageId === 'number') {
        payloadIndex = messageIdOrData.messageId;
    }
    if (Number.isInteger(payloadIndex) && payloadIndex >= 0 && payloadIndex < chatLog.length) {
        const target = chatLog[payloadIndex];
        if (target && (isFromUser ? !!target.is_user : !target.is_user)) {
            messageIndex = payloadIndex;
        }
    }
    if (messageIndex < 0) {
        for (let i = chatLog.length - 1; i >= 0; i--) {
            const m = chatLog[i];
            if (m && (isFromUser ? !!m.is_user : !m.is_user)) {
                messageIndex = i;
                break;
            }
        }
    }

    if (isFromUser) {
        // 用户发出第一条消息 = 真正开始对话：先把角色问候语作为第 1 章补写入书
        await ensureGreetingSerialized(settings, chatLog);
    }

    if (isFromUser && !settings.include_user_dialogue) {
        // 用户消息且不包含用户对白：
        // 如果开启了草稿缓冲，用户发送新消息意味着上一轮的 AI 回复已经正式定稿！
        if (settings.buffer_latest_message) {
            await checkAndSaveBufferedTurn(settings, chatLog);
        }
        return;
    }

    if (settings.buffer_latest_message) {
        // 草稿缓冲模式：首先定稿落盘上一轮已确认的回复
        await checkAndSaveBufferedTurn(settings, chatLog);

        // 最新一楼暂作为草稿，不写入磁盘
        const latestMsg = chatLog[chatLog.length - 1];
        if (latestMsg) {
            const speaker = latestMsg.name || (latestMsg.is_user ? '你' : '旁白');
            updateRecentStatus('idle', `草稿缓冲中 · ${speaker} 的最新回复暂未入书（可随意 Roll 点/修改，你发送下一条消息后定稿）`);
        }
        return;
    }

    // 默认模式（即时连载）：直接保存当前 messageIndex
    await saveSpecificMessage(messageIndex, settings, chatLog);
}

/**
 * 实时更新抽屉顶栏（header）当前聊天对应的连载文件名 Badge
 * 无论是切换聊天、切换角色卡、群聊切换还是修改命名规则，均能毫秒级同步响应
 */
function updateDrawerHeaderFileBadge(settings = null) {
    const curSettings = settings || getSettings();
    const fileName = getBookFileName(curSettings);
    const prefix = curSettings.save_dir 
        ? (curSettings.save_dir.replace(/[\\/]+$/, '') + '/') 
        : 'SillyTavern/plugins/auto-save/logs/';
    const fullPath = `${prefix}${fileName}`;

    const drawerFilenameEl = document.getElementById('novel_drawer_filename');
    const drawerFilepathEl = document.getElementById('novel_drawer_filepath');
    const previewEl = document.getElementById('novel_save_dir_preview');

    if (drawerFilenameEl) {
        drawerFilenameEl.textContent = fileName;
    }
    if (drawerFilepathEl) {
        drawerFilepathEl.textContent = fullPath;
    }
    if (previewEl) {
        previewEl.textContent = fullPath;
    }
}

let silentSyncTimer = null;

async function executeSyncAll(isSilent = false) {
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    if (!chatLog || chatLog.length === 0) {
        if (!isSilent && window.toastr) window.toastr.info('当前没有任何聊天内容可供同步。', '小说连载');
        return;
    }

    if (!isSilent) {
        if (typeof confirm === 'function' && !confirm('是否将当前全部历史聊天记录完整编排并同步保存到连载小说文件中？\n（这会生成包含前置所有章节的完整小说，后续回复将自动接着连载）')) {
            return;
        }
    }

    const syncAllBtn = document.getElementById('novel_sync_all_btn');
    if (syncAllBtn && !isSilent) {
        syncAllBtn.disabled = true;
        syncAllBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在同步历史...';
    }

    if (!isSilent) {
        updateRecentStatus('updating', '正在编排全量历史章节并同步至连载文件...');
        if (settings.show_toast !== false && window.toastr) {
            window.toastr.info('正在编排历史聊天并写入连载文件...', '小说连载', { timeOut: 2000 });
        }
    }

    const { bookTitle, novelText, chapterCount } = buildNovelText(settings, chatLog);

    if (chapterCount === 0) {
        if (syncAllBtn && !isSilent) {
            syncAllBtn.disabled = false;
            syncAllBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> 同步历史连载';
        }
        if (!isSilent) {
            updateRecentStatus('skipped', '没有可同步的有效剧情章节');
            if (window.toastr) window.toastr.warning('没有可同步的有效剧情章节。', '小说连载');
        }
        return;
    }

    try {
        const headers = (typeof getRequestHeaders === 'function') 
            ? getRequestHeaders() 
            : { 'Content-Type': 'application/json' };

        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';

        const response = await fetch('/api/plugins/auto-save/sync-all', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                characterName: bookTitle,
                fullText: novelText,
                save_dir: settings.save_dir || '',
                chat_anchor: getChatAnchor(),
                file_name: getBookFileName(settings)
            }),
        });

        if (response.ok) {
            const data = await response.json().catch(() => ({}));
            const targetFile = data.file || `${bookTitle}.txt`;
            recentStatus.chapter = chapterCount;
            // F6：全书同步后文件里真实存在的末尾章号 = 本次同步的章节总数
            lastWrittenChapterNumber = chapterCount;
            seedLastSavedSignature();
            // ①④ 全书同步后重算楼层入书映射并重绘徽标与最新楼层工具条
            savedChapterMap = computeChapterMap(settings, chatLog);
            refreshMessageBadges();
            refreshNovelToolbars();
            // 聊天改名自动跟随：全书同步同样可能触发小说文件更名
            const syncRenameSuffix = data.renamed_from ? '（检测到聊天改名，小说文件已同步更名）' : '';
            if (!isSilent) {
                if (data.renamed_from && window.toastr) {
                    window.toastr.info(`小说文件已跟随聊天改名：${data.renamed_from} → ${targetFile}`, '小说连载', { timeOut: 5000 });
                }
                updateRecentStatus('success', `全书共 ${chapterCount} 个章节已完整同步！${syncRenameSuffix}`, targetFile);
                if (window.toastr) {
                    window.toastr.success(`已成功同步全书共 ${chapterCount} 个章节至：${targetFile}！后续 AI 回复将接着往后连载。`, '小说连载');
                } else {
                    alert(`已成功同步全书共 ${chapterCount} 个章节至：${targetFile}！`);
                }
            } else {
                updateRecentStatus('success', `连载已自动校准同步（共 ${chapterCount} 章）${syncRenameSuffix}`, targetFile);
            }
        } else {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData.error || `HTTP ${response.status}`;
            if (!isSilent) {
                updateRecentStatus('error', `同步失败: ${errMsg}`);
                if (window.toastr) window.toastr.error(`同步失败: ${errMsg}`, '小说连载');
            } else {
                console.warn('[AutoSaveTxt] 自动校准同步失败:', errMsg);
            }
        }
    } catch (err) {
        if (!isSilent) {
            updateRecentStatus('error', `同步异常: ${err.message}`);
            if (window.toastr) window.toastr.error(`同步异常: ${err.message}`, '小说连载');
        } else {
            console.warn('[AutoSaveTxt] 自动校准同步异常:', err);
        }
    } finally {
        if (syncAllBtn && !isSilent) {
            syncAllBtn.disabled = false;
            syncAllBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> 同步历史连载';
        }
    }
}

function debouncedSilentSyncAll() {
    if (silentSyncTimer) clearTimeout(silentSyncTimer);
    silentSyncTimer = setTimeout(async () => {
        const settings = getSettings();
        if (!settings.enabled) return;
        await executeSyncAll(true);
    }, 1500);
}

/**
 * 渲染会话标签检测器 chips 与过滤效果预览（扫描 / 名单变更 / 收到新消息后统一走这里）
 */
// chips 渲染签名：扫描结果与白/黑名单均未变化时跳过 DOM 重建，避免用户正点击时被打断
let lastChipsRenderSig = '';

function renderTagTools() {
    const container = document.getElementById('novel_tag_chips');
    if (!container) return;
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    const { tags, total } = scanChatTags(chatLog);
    const includeSet = new Set(parseTagList(settings.include_tags).map(t => t.toLowerCase()));
    const excludeSet = new Set(parseTagList(settings.exclude_tags).map(t => t.toLowerCase()));

    const countEl = document.getElementById('novel_tag_scan_count');
    if (countEl) {
        countEl.textContent = total > 0 ? `已扫描出 ${total} 个标签` : '';
    }

    const chipsSig = JSON.stringify(tags) + '|' + (settings.include_tags || '') + '|' + (settings.exclude_tags || '');
    if (chipsSig !== lastChipsRenderSig) {
        lastChipsRenderSig = chipsSig;
        if (!tags.length) {
            container.innerHTML = '<div class="novel-tag-empty">未检测到自定义标签——AI 回复中带 &lt;标签&gt; 的内容会自动出现在这里</div>';
        } else {
            container.innerHTML = tags.map(({ tag, count }) => `
                <div class="novel-tag-chip" data-tag="${tag}">
                    <code>${tag}</code><span class="novel-chip-count">×${count}</span>
                    ${isAuxiliaryTag(tag) ? '<span class="novel-chip-auto" title="思维链/草稿类标签已被引擎自动过滤，无需加入黑名单">自动</span>' : ''}
                    <button type="button" class="novel-chip-btn chip-white ${includeSet.has(tag) ? 'active' : ''}" data-action="include" title="加入白名单：只保留该标签内的正文">白</button>
                    <button type="button" class="novel-chip-btn chip-black ${excludeSet.has(tag) ? 'active' : ''}" data-action="exclude" title="加入黑名单：彻底剔除该标签块">黑</button>
                </div>`).join('');

            container.querySelectorAll('.novel-chip-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const chip = btn.closest('.novel-tag-chip');
                    const tagName = chip ? chip.getAttribute('data-tag') : '';
                    if (tagName) toggleTagInList(tagName, btn.getAttribute('data-action'));
                });
            });

            // 悬浮 chip 即展示标签块内的实际内容，无需点入即可快速判断是否保留
            container.querySelectorAll('.novel-tag-chip').forEach(chipEl => {
                chipEl.addEventListener('mouseenter', () => showChipTooltip(chipEl));
                chipEl.addEventListener('mouseleave', hideChipTooltip);
            });
        }
    }

    renderFilterPreview();
    return { tags, total };
}

/**
 * 将标签加入/移出白名单或黑名单（两侧互斥），并同步输入框显示
 */
function toggleTagInList(tag, action) {
    const settings = getSettings();
    let includeList = parseTagList(settings.include_tags).map(t => t.toLowerCase());
    let excludeList = parseTagList(settings.exclude_tags).map(t => t.toLowerCase());

    if (action === 'include') {
        if (includeList.includes(tag)) {
            includeList = includeList.filter(t => t !== tag);
        } else {
            includeList.push(tag);
            excludeList = excludeList.filter(t => t !== tag);
        }
    } else {
        if (excludeList.includes(tag)) {
            excludeList = excludeList.filter(t => t !== tag);
        } else {
            excludeList.push(tag);
            includeList = includeList.filter(t => t !== tag);
        }
    }

    settings.include_tags = includeList.join(', ');
    settings.exclude_tags = excludeList.join(', ');

    const incEl = document.getElementById('novel_include_tags');
    const excEl = document.getElementById('novel_exclude_tags');
    if (incEl) incEl.value = settings.include_tags;
    if (excEl) excEl.value = settings.exclude_tags;
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();

    renderTagTools();
}

// 供弹窗展示用的最近一次预览数据（完整正文，不截断）
let lastFilterPreview = { raw: '', rawLength: 0, cleaned: '', speaker: '', floor: 0, whitelistMissed: false, isDraft: false };

/**
 * 过滤效果预览：刷新面板中"查看预览"按钮的状态与字数统计，正文全文在点击弹窗中展示
 */
function renderFilterPreview() {
    const btn = document.getElementById('novel_preview_btn');
    if (!btn) return;
    const labelEl = document.getElementById('novel_preview_btn_label');
    const statEl = document.getElementById('novel_preview_btn_stat');
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);

    let target = null;
    let targetIndex = -1;
    for (let i = chatLog.length - 1; i >= 0; i--) {
        const m = chatLog[i];
        if (m && !m.is_user) { target = m; targetIndex = i; break; }
    }

    if (!target) {
        btn.disabled = true;
        if (labelEl) labelEl.textContent = '暂无 AI 回复可供预览';
        if (statEl) statEl.textContent = '';
        lastFilterPreview = { raw: '', rawLength: 0, cleaned: '', speaker: '', floor: 0, whitelistMissed: false, isDraft: false };
        return;
    }

    btn.disabled = false;
    if (labelEl) labelEl.textContent = '查看过滤效果预览';
    const raw = target.mes || '';
    const cleaned = getCleanedMessage(target, targetIndex, settings);

    // 白名单静默失效检测：填了白名单但当前消息一个都没匹配上时，引擎会整篇保留而不报错
    const includeList = parseTagList(settings.include_tags);
    let whitelistMissed = false;
    if (includeList.length > 0 && raw) {
        whitelistMissed = !includeList.some(t => {
            const safeT = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`<\\s*${safeT}[^>]*>[\\s\\S]*?<\\/\\s*${safeT}\\s*>`, 'i').test(raw);
        });
    }
    // 草稿缓冲模式下，最新一楼尚未定稿入书
    const isDraft = !!(settings.buffer_latest_message && targetIndex > lastSettledSavedIndex);

    lastFilterPreview = {
        raw,
        rawLength: raw.length,
        cleaned,
        speaker: target.name || '旁白',
        floor: targetIndex + 1,
        whitelistMissed,
        isDraft
    };
    if (statEl) {
        statEl.textContent = (cleaned
            ? `原始内容 ${raw.length} 字符（含标签标记）→ 入书正文 ${cleaned.length} 字`
            : '过滤后无正文（点开查看原因）') + (isDraft ? ' · 草稿未定稿' : '');
    }
}

/**
 * 分析原始回复中被引擎剔除的内容（供预览弹窗"信息显示"使用）：
 * 分类统计黑名单标签块、思维链类标签、HTML 注释/图片标记的命中次数，
 * 并返回带 <mark> 高亮的原文 HTML（剔除部分高亮，保留部分原样转义）
 */
function analyzeRemovedContent(raw, settings) {
    const result = { html: '', removedTags: [], removedCount: 0, removedChars: 0 };
    if (!raw) return result;

    const patterns = [];
    const excludeTags = parseTagList(settings.exclude_tags);
    const tagCount = new Map();

    for (const t of excludeTags) {
        const safeT = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        patterns.push(new RegExp(`<\\s*${safeT}[^>]*>[\\s\\S]*?<\\/\\s*${safeT}\\s*>`, 'gi'));
        tagCount.set(t.toLowerCase(), 0);
    }
    // 思维链/草稿/规划类泛化标签（与 cleanNovelText 阶段零同规则）
    const genericAux = /<\s*([a-zA-Z0-9_\-~.:#]*(?:think|thought|reasoning|cot|scratchpad|reflection|inner_thought|analysis|plan)[a-zA-Z0-9_\-~.:#]*)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi;
    patterns.push(genericAux);
    // HTML 隐藏注释与 Markdown/img 图片标记
    patterns.push(/<!--[\s\S]*?-->/g);
    patterns.push(/!\[.*?\]\(.*?\)/g);
    patterns.push(/<img[^>]*>/gi);
    // bbi 图像生成标记（标记 + prompt 到行末，与 cleanNovelText 前置清洗同规则）
    patterns.push(/<bbi_image[^\n]*/gi);

    const combined = new RegExp(patterns.map(p => `(?:${p.source})`).join('|'), 'gi');
    let html = '';
    let lastIndex = 0;
    let m;
    while ((m = combined.exec(raw)) !== null) {
        html += escapeHtml(raw.slice(lastIndex, m.index));
        html += `<mark class="novel-mv-removed">${escapeHtml(m[0])}</mark>`;
        lastIndex = m.index + m[0].length;
        result.removedCount++;
        result.removedChars += m[0].length;
        // 归类计数：思维链族按通用名计，其余按标签名计
        const tagMatch = m[0].match(/^<\s*([a-zA-Z0-9_\-~.:#]+)/i);
        if (tagMatch) {
            const name = tagMatch[1].toLowerCase();
            const isGeneric = /(?:think|thought|reasoning|cot|scratchpad|reflection|inner_thought|analysis|plan)/.test(name);
            const key = isGeneric ? 'think族' : name;
            tagCount.set(key, (tagCount.get(key) || 0) + 1);
        } else {
            tagCount.set('注释/图片', (tagCount.get('注释/图片') || 0) + 1);
        }
        if (m.index === combined.lastIndex) combined.lastIndex++; // 防空匹配死循环
    }
    html += escapeHtml(raw.slice(lastIndex));
    result.html = html;
    result.removedTags = [...tagCount.entries()].filter(([, c]) => c > 0).map(([name, count]) => ({ name, count }));
    return result;
}

/**
 * 打开过滤效果预览弹窗：左右对照展示「入书正文 vs 原始回复」，
 * 顶部统计栏呈现字数变化、过滤率与剔除标签明细，支持点遮罩 / 右上角 / Esc 关闭
 */
function openFilterPreviewModal() {
    if (typeof document === 'undefined') return;
    const overlay = ensurePreviewModal();
    if (!overlay) return;
    const settings = getSettings();

    // ---- 头部徽标：说话角色 / 原楼层 / 草稿态 ----
    const speakerEl = document.getElementById('novel_modal_speaker');
    const floorEl = document.getElementById('novel_modal_floor');
    const draftEl = document.getElementById('novel_modal_draft');
    if (speakerEl) {
        speakerEl.innerHTML = lastFilterPreview.speaker
            ? `<i class="fa-solid fa-user"></i> ${escapeHtml(lastFilterPreview.speaker)}`
            : '';
        speakerEl.style.display = lastFilterPreview.speaker ? '' : 'none';
    }
    if (floorEl) {
        floorEl.innerHTML = lastFilterPreview.floor
            ? `<i class="fa-solid fa-layer-group"></i> 原楼层 ${lastFilterPreview.floor}`
            : '';
        floorEl.style.display = lastFilterPreview.floor ? '' : 'none';
    }
    if (draftEl) draftEl.style.display = lastFilterPreview.isDraft ? '' : 'none';

    // ---- 统计栏：字数变化 + 过滤率 + 剔除标签明细 ----
    const statbar = document.getElementById('novel_modal_statbar');
    if (statbar) {
        if (!lastFilterPreview.cleaned && !lastFilterPreview.speaker) {
            statbar.innerHTML = '<span class="novel-mv-hint">当前没有可预览的 AI 回复</span>';
        } else {
            const rawLen = lastFilterPreview.rawLength;
            const cleanLen = lastFilterPreview.cleaned.length;
            const removed = Math.max(0, rawLen - cleanLen);
            const rate = rawLen > 0 ? Math.round((removed / rawLen) * 100) : 0;
            const analysis = analyzeRemovedContent(lastFilterPreview.raw, settings);
            const tagHtml = analysis.removedTags.length
                ? analysis.removedTags.map(t => `<span class="novel-mv-tag"><code>&lt;${escapeHtml(t.name)}&gt;</code>×${t.count}</span>`).join('')
                : '<span class="novel-mv-hint">本次无需剔除的标签</span>';
            const wlHtml = lastFilterPreview.whitelistMissed
                ? '<span class="novel-mv-tag is-warn"><i class="fa-solid fa-triangle-exclamation"></i> 白名单未命中任何标签，已整篇保留</span>'
                : (parseTagList(settings.include_tags).length
                    ? `<span class="novel-mv-tag is-ok"><i class="fa-solid fa-filter"></i> 白名单：${escapeHtml(settings.include_tags)}</span>`
                    : '');
            statbar.innerHTML = `
                <span class="novel-mv-stat"><b>${rawLen}</b> 字符原始</span>
                <i class="fa-solid fa-arrow-right novel-mv-arrow"></i>
                <span class="novel-mv-stat is-clean"><b>${cleanLen}</b> 字入书</span>
                <span class="novel-mv-stat ${removed > 0 ? 'is-removed' : ''}">剔除 ${removed} 字${rate > 0 ? `（${rate}%）` : ''}</span>
                <span class="novel-mv-stat-sep"></span>
                <span class="novel-mv-stats-tags">${tagHtml}${wlHtml}</span>
            `;
        }
    }

    // ---- 对照主体：左入书正文 / 右原始回复（剔除部分高亮） ----
    const cleanBox = document.getElementById('novel_modal_clean');
    const rawBox = document.getElementById('novel_modal_raw');
    const cleanCount = document.getElementById('novel_modal_clean_count');
    const rawCount = document.getElementById('novel_modal_raw_count');
    if (cleanCount) cleanCount.textContent = lastFilterPreview.cleaned ? `${lastFilterPreview.cleaned.length} 字` : '';
    if (rawCount) rawCount.textContent = lastFilterPreview.rawLength ? `${lastFilterPreview.rawLength} 字符` : '';

    if (cleanBox) {
        if (lastFilterPreview.cleaned) {
            cleanBox.innerHTML = escapeHtml(lastFilterPreview.cleaned).replace(/\n/g, '<br>');
        } else {
            cleanBox.innerHTML = lastFilterPreview.speaker
                ? '<div class="novel-mv-alert is-warn"><i class="fa-solid fa-triangle-exclamation"></i><div><b>过滤后无正文可入书</b><p>请检查白名单标签拼写，或确认正文是否被黑名单全部剔除。不确定时把白名单完全留空。</p></div></div>'
                : '<div class="novel-mv-alert"><i class="fa-solid fa-circle-info"></i><div><b>暂无 AI 回复</b><p>先在聊天中产生一条 AI 回复，再来查看过滤效果。</p></div></div>';
        }
    }
    if (rawBox) {
        if (lastFilterPreview.raw) {
            const analysis = analyzeRemovedContent(lastFilterPreview.raw, settings);
            rawBox.innerHTML = analysis.html.replace(/\n/g, '<br>') || '<span class="novel-mv-hint">（空）</span>';
        } else {
            rawBox.innerHTML = '<span class="novel-mv-hint">（暂无内容）</span>';
        }
    }

    overlay.style.display = 'flex';
    // 健壮定位：fixed 铺满视口；fixed 退化环境自动降级为绝对坐标锚定当前可视区
    positionOverlay(overlay);
}

function closeFilterPreviewModal() {
    const overlay = document.getElementById('novel_preview_modal');
    if (overlay) overlay.style.display = 'none';
}

// 纯前端一键导出整本小说（自动附加 UTF-8 BOM，彻底解决手机阅读器/老Windows乱码）
// 抽出为具名函数：面板【导出整本 TXT】按钮与最新 AI 楼层内嵌工具条共用
function exportNovelText() {
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    if (!chatLog || chatLog.length === 0) {
        if (window.toastr) window.toastr.info('当前没有任何聊天内容可供导出。', '小说连载');
        return;
    }

    const { bookTitle, novelText, chapterCount } = buildNovelText(settings, chatLog);

    if (chapterCount === 0) {
        if (window.toastr) window.toastr.warning('没有可导出的有效剧情章节。', '小说连载');
        return;
    }

    const safeFileName = sanitizeFilename(bookTitle);
    const blob = new Blob(['\uFEFF' + novelText], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeFileName}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (window.toastr) {
        window.toastr.success(`已成功编排并下载《${bookTitle}》共 ${chapterCount} 个章节！`, '小说连载');
    }
}

/**
 * 打开聊天时的连载状态提示：统计当前聊天的有效章节数，
 * 顶栏即刻显示本书已有章节进度，并提示将从第 N+1 章继续（历史未同步时提醒可一键补全）
 */
function announceChatNovelStatus() {
    const settings = getSettings();
    if (!settings.enabled) return;

    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    if (!chatLog || chatLog.length === 0) {
        updateRecentStatus('idle', '当前聊天为空，发送第一条消息后将自动开书连载');
        return;
    }

    let chapterTotal = 0;
    for (let i = 0; i < chatLog.length; i++) {
        const m = chatLog[i];
        if (!m) continue;
        if (m.is_user && !settings.include_user_dialogue) continue;
        if (getCleanedMessage(m, i, settings)) chapterTotal++;
    }

    recentStatus.chapter = chapterTotal;
    const bookTitle = getBookTitle(settings);

    // 顶栏指示灯：打开旧聊天立即显示本书进度（不依赖下一次写入）
    const headerStatus = document.getElementById('novel_header_status');
    if (headerStatus) {
        headerStatus.innerHTML = chapterTotal > 0
            ? `<span class="novel-header-state is-success"><i class="fa-solid fa-book-open"></i> 《${escapeHtml(shortBookTitle(bookTitle))}》已 ${chapterTotal} 章</span>`
            : '<span class="novel-header-state is-success"><i class="fa-solid fa-circle-check"></i> 连载就绪</span>';
    }

    if (chapterTotal === 0) {
        updateRecentStatus('idle', `《${bookTitle}》：当前聊天没有可连载的有效正文（可能被白/黑名单全部过滤）`);
        return;
    }

    updateRecentStatus('idle', `《${bookTitle}》连载就绪：本聊天共 ${chapterTotal} 个有效章节，新回复将从第 ${chapterTotal + 1} 章开始${chapterTotal >= 3 ? '；若此前未同步过，点【同步历史连载】可一键补全全书' : ''}`);

    if (settings.show_toast !== false && window.toastr) {
        window.toastr.info(`《${bookTitle}》将从第 ${chapterTotal + 1} 章继续连载（已有 ${chapterTotal} 章）`, '小说连载', { timeOut: 4000 });
    }
}

let tagScanTimer = null;
function debouncedRenderTagTools(delay = 1000) {
    if (tagScanTimer) clearTimeout(tagScanTimer);
    tagScanTimer = setTimeout(() => {
        if (document.getElementById('auto-save-to-txt-settings')) renderTagTools();
    }, delay);
}

let settingsSaveTimer = null;
function debouncedSaveSettings() {
    if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(() => {
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    }, 600);
}

// 成功类连载 Toast 节流（群聊多角色连续回复时避免弹窗刷屏）
let lastNovelToastAt = 0;
function throttledNovelSuccessToast(message, title, opts = {}) {
    const now = Date.now();
    if (now - lastNovelToastAt < 2500) return;
    lastNovelToastAt = now;
    if (window.toastr) window.toastr.success(message, title, opts);
}

/* ============================================================
   v1.13 界面入口重构
   设置面板不再塞进酒馆「扩展程序」抽屉（那里入口深、抽屉折叠时弹窗还会被一起隐藏），
   统一改为 body 级弹窗：入口 = 左下角魔法棒菜单 / 悬浮窗 / 楼层内嵌工具条
   ============================================================ */

/* ============================================================
   v1.16 浮层定位加固：修「手机端悬浮窗 / 弹窗跑到屏幕外」
   ------------------------------------------------------------
   宿主事实（核对自 SillyTavern release 分支 public/style.css）：
       html { -webkit-transform: translateZ(0); -webkit-backface-visibility: hidden;
              -webkit-perspective: 1000 }
   按 CSS 规范，html 上的 transform 会让它成为 position:fixed 子元素的包含块 ——
   于是 fixed 不再钉住「可见视口」，而是钉住「文档盒子」。已用 Edge/CDP 实测确认：
   html 带该 transform 时，把文档滚 500px，top:0 的 fixed 元素 rect.top 会变成 -500。
   桌面端文档盒子恒等于视口，所以察觉不到；手机端 URL 栏展开 / 软键盘弹出会让文档盒子
   与可见区脱节（100dvh 大于可见高、或文档被顶起一截）。此时我们原本直接用
   `bottom: 74px`（悬浮药丸）与 `inset: 0`（弹窗）描述几何，就会整块落到可见区之外 ——
   这就是「手机端悬浮窗与弹窗都不显示 / 像在界面外」的成因。
   实测复现（390×844，body 高于可见区）：悬浮药丸 top=941（可见高 844，完全不可见）、
   弹窗高 1055（底部 211px 在屏幕外）；同一场景把 html 的 transform 去掉则一切正常。
   对策：不猜宿主行为，统一「按可见视口给几何 → 实测屏幕矩形 → 反向补偿」，
   收敛后元素在屏幕上必然落在可见区内 —— 对 html transform、文档滚动、
   手机端 URL 栏与软键盘、用户自定义美化 CSS 一律免疫。
   ============================================================ */

/** 可见视口尺寸：手机端 URL 栏 / 软键盘会改变 visualViewport，优先采用它 */
function getVisibleViewportBox() {
    if (typeof window === 'undefined') return { width: 0, height: 0 };
    const vv = window.visualViewport;
    const width = (vv && vv.width > 0) ? vv.width : (window.innerWidth || 0);
    const height = (vv && vv.height > 0) ? vv.height : (window.innerHeight || 0);
    return { width, height };
}

/** 文档滚动量（宿主劫持 fixed 后，它是「屏幕坐标 与 宿主坐标」的换算基准） */
function getDocScrollTop() {
    if (typeof document === 'undefined') return 0;
    const se = document.scrollingElement || document.documentElement;
    return se ? (se.scrollTop || 0) : 0;
}

/**
 * 实测「fixed 元素 style: top/left = 0 时落在屏幕上的坐标」。
 * 正常宿主恒为 (0,0)；酒馆这类被 transform 劫持的宿主在文档滚动后不为 0。
 * 用探针即测即取（同一 tick 内建/测/删），避免缓存过期。
 *
 * v1.17.3：浮层挂进 top-layer 载体后，元素改用 absolute、基准是载体盒子（= 视口），
 * **不再需要任何折算**。而探针仍是普通 fixed div，在被劫持的宿主里会量到非 0 值 ——
 * 若继续拿来折算，等于把 top-layer 已经正确的坐标又减掉一个偏移量，药丸反而跑偏。
 * 所以先判断浮层是否在 top layer 里，是则直接返回 (0,0)。
 */
function measureHostFixedOffset(el) {
    // 在 top layer 里 → 坐标基准就是视口，无需折算（见上方注释）
    if (el && el.closest && el.closest('dialog.novel-tl')) return { x: 0, y: 0 };
    if (typeof document === 'undefined' || !document.body) return { x: 0, y: 0 };
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;visibility:hidden;pointer-events:none;';
    document.body.appendChild(probe);
    const rect = probe.getBoundingClientRect();
    probe.remove();
    // 亚像素抖动归一为 0，避免无谓的补偿 transform
    return {
        x: Math.abs(rect.left) < 0.5 ? 0 : rect.left,
        y: Math.abs(rect.top) < 0.5 ? 0 : rect.top
    };
}

/**
 * 把元素钉满「当前可见视口」。
 * ① 按可见视口给一组几何（已按宿主包含块偏移折算坐标）；
 * ② 实测屏幕矩形，偏差反向补偿，最多两轮（一轮即可收敛，第二轮兜底）。
 *
 * v1.17.3：浮层挂进 top-layer 载体后，元素的定位基准是**载体盒子（= 视口）**，
 * 不再受 html transform 劫持影响，因此：
 *   - measureHostFixedOffset(el) 直接返回 0/0，折算自动失效（详见该函数注释）
 *   - position 写 absolute（与 CSS 里 dialog.novel-tl > 的规则一致），
 *     绝不能写回 fixed —— 那会把元素踢出 top-layer 的坐标系、重新落回被劫持的文档盒子
 */
function pinElementToVisibleViewport(el) {
    if (!el) return;
    const vp = getVisibleViewportBox();
    if (!vp.width || !vp.height) return;
    const inTopLayer = !!(el.closest && el.closest('dialog.novel-tl'));
    const off = inTopLayer ? { x: 0, y: 0 } : measureHostFixedOffset(el);
    el.style.position = inTopLayer ? 'absolute' : 'fixed';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.width = `${vp.width}px`;
    el.style.height = `${vp.height}px`;
    el.style.left = `${-off.x}px`;
    el.style.top = `${-off.y}px`;
    for (let i = 0; i < 2; i++) {
        const rect = el.getBoundingClientRect();
        if (Math.abs(rect.left) < 0.5 && Math.abs(rect.top) < 0.5) break;
        el.style.left = `${(parseFloat(el.style.left) || 0) - rect.left}px`;
        el.style.top = `${(parseFloat(el.style.top) || 0) - rect.top}px`;
    }
}

/**
 * 弹窗定位：钉满当前可见视口。
 * v1.16 起不再依赖宿主的 fixed 行为，也不再使用「退化时切 absolute」的分支 ——
 * 那个分支只会把弹窗按文档坐标推得更远，正是问题的一部分。
 */
function positionOverlay(overlay) {
    if (!overlay) return;
    pinElementToVisibleViewport(overlay);
}

/* ---- 视口变化统一重排：resize / 横竖屏 / 手机端 URL 栏与软键盘 / 文档级滚动 ---- */
let overlayResyncRaf = 0;
let lastObservedScrollTop = 0;
let overlayResyncBound = false;

/** 重排所有「当前可见」的浮层：设置弹窗 / 过滤预览弹窗 / 悬浮入口 */
function resyncNovelOverlays() {
    if (typeof document === 'undefined') return;
    const settings = document.getElementById('novel_settings_modal');
    if (settings && settings.style.display !== 'none') positionOverlay(settings);
    const preview = document.getElementById('novel_preview_modal');
    if (preview && preview.style.display !== 'none') positionOverlay(preview);
    if (document.getElementById('novel-floating-window')) applyFloatPos();
}

/** 合并到下一帧执行，避免 resize / 滚动高频重排 */
function scheduleOverlayResync() {
    if (overlayResyncRaf || typeof document === 'undefined') return;
    const raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : (cb) => setTimeout(cb, 16);
    overlayResyncRaf = raf(() => {
        overlayResyncRaf = 0;
        resyncNovelOverlays();
    });
}

/**
 * 只绑一次。
 * 注意滚动只认「文档级滚动量变化」：弹窗正文滚动同样会冒泡到 document 的捕获监听，
 * 若不筛掉，滚动设置面板时每一帧都会重排浮层（明显卡顿）。
 */
function bindOverlayResync() {
    if (overlayResyncBound || typeof window === 'undefined' || typeof document === 'undefined') return;
    overlayResyncBound = true;
    lastObservedScrollTop = getDocScrollTop();

    window.addEventListener('resize', scheduleOverlayResync);
    window.addEventListener('orientationchange', () => {
        cachedSafeAreaBottom = null;   // 横竖屏切换后底部安全区会变，重测
        setTimeout(scheduleOverlayResync, 200);
    });

    const onDocScroll = () => {
        const st = getDocScrollTop();
        if (st === lastObservedScrollTop) return;
        lastObservedScrollTop = st;
        scheduleOverlayResync();
    };
    document.addEventListener('scroll', onDocScroll, { capture: true, passive: true });

    const vv = window.visualViewport;
    if (vv) {
        // URL 栏收放 / 软键盘弹出 / 手势缩放都会改可见区尺寸与位置，直接重排
        vv.addEventListener('resize', scheduleOverlayResync);
        vv.addEventListener('scroll', scheduleOverlayResync);
    }
}

// 设置弹窗最近一次打开的时间戳：用于拦掉「打开它的同一次触摸补发的 click」把弹窗立刻关掉
let settingsModalOpenedAt = 0;

// Esc 只关闭最上层弹窗（预览弹窗优先于设置弹窗），全局只绑一次
let novelEscBound = false;
function bindNovelEscClose() {
    if (novelEscBound || typeof document === 'undefined') return;
    novelEscBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const preview = document.getElementById('novel_preview_modal');
        if (preview && preview.style.display !== 'none') {
            closeFilterPreviewModal();
            return;
        }
        const settingsModal = document.getElementById('novel_settings_modal');
        if (settingsModal && settingsModal.style.display !== 'none') closeNovelSettingsModal();
    });
}

/** 创建设置弹窗外壳（body 级，全程只建一次），面板内容由 renderSettingsUI 填充 */
function ensureSettingsModal() {
    if (typeof document === 'undefined') return null;
    let overlay = document.getElementById('novel_settings_modal');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'novel_settings_modal';
    overlay.className = 'novel-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div class="novel-modal novel-modal-settings" role="dialog" aria-modal="true" aria-label="小说连载阅读设置">
            <div class="novel-modal-header">
                <b class="novel-modal-title"><i class="fa-solid fa-book-bookmark"></i>小说连载阅读<span class="novel-modal-ver">v${DEFAULT_SETTINGS.version}</span></b>
                <span class="novel-modal-header-meta">
                    <span id="novel_header_status" class="novel-modal-status"></span>
                    <button type="button" id="novel_settings_preview" class="novel-icon-btn is-accent" title="查看最近一条 AI 回复的过滤效果"><i class="fa-solid fa-eye"></i></button>
                    <button type="button" id="novel_settings_close" class="novel-icon-btn" title="关闭设置"><i class="fa-solid fa-xmark"></i></button>
                </span>
            </div>
            <div class="novel-modal-body novel-modal-body-settings" id="novel_settings_body"></div>
        </div>
    `;
    // v1.17.3：挂进 top-layer 载体 —— 弹窗不再受 html transform 劫持 fixed 的影响
    mountInTopLayer('novel-tl-settings', overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target !== overlay) return;
        // 触摸端「轻点药丸」打开弹窗后，同一次触摸可能还会补发一次 click 并落到遮罩上，
        // 若不设守卫，弹窗会刚打开就被自己关掉（表现为「手机点了没反应」）
        if (Date.now() - settingsModalOpenedAt < 400) return;
        closeNovelSettingsModal();
    });
    const closeBtn = overlay.querySelector('#novel_settings_close');
    if (closeBtn) closeBtn.addEventListener('click', closeNovelSettingsModal);
    // 头部紫色强调按钮：直接唤起过滤效果预览（与参考图右侧主按钮同位）
    const headerPreviewBtn = overlay.querySelector('#novel_settings_preview');
    if (headerPreviewBtn) headerPreviewBtn.addEventListener('click', () => openFilterPreviewModal());
    bindNovelEscClose();
    return overlay;
}

/** 打开设置弹窗（魔法棒菜单项 / 悬浮窗【完整设置】共用） */
function openNovelSettingsModal() {
    if (typeof document === 'undefined') return;
    const overlay = ensureSettingsModal();
    if (!overlay) return;
    const body = overlay.querySelector('#novel_settings_body');
    if (!document.getElementById('auto-save-to-txt-settings')) {
        // 懒渲染兜底：面板尚未就绪（服务端探针仍在等待）时先给个占位，随后补渲染
        if (body) body.innerHTML = '<div class="novel-mv-hint">正在载入设置…</div>';
        renderSettingsUI();
    }
    // 先显示、后定位：display:none 时 getBoundingClientRect 恒为全 0，定位探测会失效
    overlay.style.display = 'flex';
    positionOverlay(overlay);
    settingsModalOpenedAt = Date.now();
    if (body) body.scrollTop = 0;
    // 不记忆标签：每次打开都回到「连载」（面板在会话内是复用的，必须显式复位）
    const panelEl = document.getElementById('auto-save-to-txt-settings');
    if (panelEl && typeof panelEl.__novelActivateTab === 'function') panelEl.__novelActivateTab('serial');
    // 折叠开合按上次的选择恢复（settings.acc_open；空数组 = 全部收起）
    applyNovelAccOpen(panelEl);
}

function closeNovelSettingsModal() {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('novel_settings_modal');
    if (overlay) overlay.style.display = 'none';
}

/**
 * 设置弹窗标签页切换（连载 / 过滤 / 排版 / 文件 / 通用）。
 *
 * 红线：面板一次性全部挂载，切换只改 `display`（.is-active 类），**绝不重建 innerHTML**。
 * 原因有二，都是实测踩过的坑：
 *   1. 面板内大量 `panel.querySelector('#novel_xxx')` 按 ID 现取元素，重建即失效；
 *   2. 会话标签检测是异步渲染的，重建会丢掉已扫描出的 chips 与输入框里的未提交内容。
 *
 * 不做「记住上次标签」：每次打开都落在「连载」，行为可预期。
 */
function bindNovelTabs(panel) {
    if (!panel) return;
    const tabs = Array.from(panel.querySelectorAll('.novel-tab'));
    const panes = Array.from(panel.querySelectorAll('.novel-tabpane'));
    if (!tabs.length || !panes.length) return;
    const body = document.getElementById('novel_settings_body');

    const activate = (key, focusTab) => {
        tabs.forEach((t) => {
            const on = t.dataset.nvTab === key;
            t.classList.toggle('is-active', on);
            t.setAttribute('aria-selected', on ? 'true' : 'false');
            // 只有当前标签可 Tab 聚焦（标准 tablist 键盘语义）
            t.tabIndex = on ? 0 : -1;
            if (on && focusTab) t.focus();
        });
        panes.forEach((p) => p.classList.toggle('is-active', p.dataset.nvPane === key));
        // 切标签后回到顶部：否则会停在上一个标签的滚动位置，像是没切换
        if (body) body.scrollTop = 0;
    };

    tabs.forEach((t, i) => {
        t.tabIndex = t.classList.contains('is-active') ? 0 : -1;
        t.addEventListener('click', () => activate(t.dataset.nvTab, false));
        t.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const dir = e.key === 'ArrowRight' ? 1 : -1;
            const next = tabs[(i + dir + tabs.length) % tabs.length];
            activate(next.dataset.nvTab, true);
        });
    });

    // 暴露给 openNovelSettingsModal：面板一旦建好就会在会话内一直复用，
    // 而产品决策是「不记忆标签，每次打开都落在连载」，所以每次打开都要显式复位。
    panel.__novelActivateTab = (key) => activate(key, false);
}

/**
 * 折叠分组（替代卡片）：点标题行展开 / 收起。
 * 与标签页同一条红线 —— 只切 class，不重建 DOM（面板内按 ID 现取元素的代码很多）。
 */
function bindNovelAccordions(panel) {
    if (!panel) return;
    panel.querySelectorAll('.novel-acc-head').forEach((head) => {
        head.addEventListener('click', () => {
            const item = head.closest('.novel-acc');
            if (!item) return;
            const open = item.classList.toggle('is-open');
            head.setAttribute('aria-expanded', open ? 'true' : 'false');
            // 开合是本机偏好：改一次就写回扩展设置（跟 float_pos 同模式）
            persistNovelAccOpen(panel);
        });
    });
    // 任何输入 / 勾选 / 下拉变化后刷新摘要（一处委托，省得逐个 handler 去挂）
    const onMutate = () => refreshNovelAccSummaries(panel);
    panel.addEventListener('input', onMutate);
    panel.addEventListener('change', onMutate);
}

/**
 * 折叠分组开合的**唯一数据源**：`settings.acc_open`（展开着的 key 列表）。
 *
 * 默认全部收起 —— 折叠的本意就是「先给一份目录，想改哪块再点开」，
 * 一进来就摊开三四屏反而不像设置页了。
 * （v1.17.0~v1.17.1 之间曾按「分区内分组个数」推导：单分组的`连载/文件/通用`自动展开。
 *   已按用户要求推翻：一律收起。）
 *
 * 恢复时机 = 每次打开设置弹窗。开合本身持久化，但**标签页仍固定回到「连载」**。
 */
function applyNovelAccOpen(panel) {
    if (!panel) return;
    const raw = getSettings().acc_open;
    const open = new Set(Array.isArray(raw) ? raw : []);
    panel.querySelectorAll('.novel-acc').forEach((item) => {
        const on = open.has(item.dataset.nvAcc);
        item.classList.toggle('is-open', on);
        const head = item.querySelector('.novel-acc-head');
        if (head) head.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
}

/** 把当前展开着的分组写回 `settings.acc_open` 并落盘。 */
function persistNovelAccOpen(panel) {
    if (!panel) return;
    const settings = getSettings();
    settings.acc_open = Array.from(panel.querySelectorAll('.novel-acc.is-open')).map((a) => a.dataset.nvAcc);
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
}

// 折叠行摘要用的短名（下拉里的选项文案太长，收起时放不下）
const NOVEL_STYLE_SUMMARY = {
    numbered_floor: '第 X 章 · 角色名（带楼层）',
    numbered: '第 X 节 · 角色名',
    separator: '优雅分割线',
    dialogue: '【角色名】正文'
};
const NOVEL_NAMING_SUMMARY = { char_chat: '角色名 - 对话名', char_only: '仅角色名' };

/**
 * 刷新折叠行右侧摘要。
 * 收起状态下摘要就是唯一线索，所以每个分组都必须有一句「当前值」，
 * 否则折叠等于把设置藏起来（用户会找不到自己改过的项）。
 */
function refreshNovelAccSummaries(panel) {
    if (!panel) return;
    const set = (id, text) => {
        const el = panel.querySelector(`#${id}`);
        if (el) el.textContent = text;
    };
    const checkedCount = (ids) => ids.filter((id) => {
        const el = panel.querySelector(`#${id}`);
        return !!(el && el.checked);
    }).length;

    const val = (id) => {
        const el = panel.querySelector(`#${id}`);
        return el ? String(el.value || '').trim() : '';
    };

    set('novel_acc_summary_include', val('novel_include_tags') || '整篇保留');
    set('novel_acc_summary_exclude', val('novel_exclude_tags') || '未设置');
    set('novel_acc_summary_style', NOVEL_STYLE_SUMMARY[val('novel_chapter_style')] || val('novel_chapter_style'));
    set('novel_acc_summary_naming', NOVEL_NAMING_SUMMARY[val('novel_naming_rule')] || val('novel_naming_rule'));
    set('novel_acc_summary_dir', val('novel_save_dir') || '默认目录 plugins/auto-save/logs');
    set('novel_acc_summary_write', `已开启 ${checkedCount(['novel_include_user', 'novel_indent_paragraphs', 'novel_buffer_latest'])}/3`);
    set('novel_acc_summary_display', `已开启 ${checkedCount(['novel_show_floating_window', 'novel_show_embedded_toolbar', 'novel_show_toast'])}/3`);
    set('novel_acc_summary_book', recentStatus.text || '暂无记录');
    // v1.18 修复：这里原先直接引用 renderSettingsUI 内部的局部 const（不同作用域），
    // 每次 change 必抛 ReferenceError → EPUB 摘要永远刷不出来。改为在 panel 内查询 DOM 现态。
    const embedEl = panel.querySelector('#novel_ebook_embed_images');
    set('novel_acc_summary_ebook', embedEl && embedEl.checked
        ? `嵌入图片 ${Number(val('novel_ebook_max_image_mb') || 5)}MB/张`
        : '纯文字（不嵌入图片）');
}

// EPUB「嵌入图片」开关的即时说明文案（模板初次渲染与 change 时共用，避免两处文案漂移）
const EBOOK_EMBED_HINT_ON = '会读取每轮回复携带的插画（extra.bbiImage）并按正文原位嵌入；需要服务端插件；只影响 EPUB，不影响 TXT 连载。';
const EBOOK_EMBED_HINT_OFF = '纯文字 EPUB：不读取、不嵌入任何图片；只影响 EPUB，不影响 TXT 连载。';

/** 按开关现态刷新 EPUB 分组的即时说明（纯 DOM 查询，不依赖任何函数内局部变量） */
function refreshEbookEmbedHint(panel) {
    if (!panel) return;
    const hint = panel.querySelector('#novel_ebook_embed_hint');
    if (!hint) return;
    const el = panel.querySelector('#novel_ebook_embed_images');
    hint.textContent = (el && el.checked) ? EBOOK_EMBED_HINT_ON : EBOOK_EMBED_HINT_OFF;
}

// ==================== 图片电子书（EPUB）导出与预览 ====================
/**
 * 把结构化书 + 图片转换成 /ebook 请求体。
 * delivery：'server'（默认，服务端落盘 + JSON 响应）或 'download'（服务端直接返回 EPUB 二进制）。
 * 纯函数，供跨层集成测试直接取 payload（测试专用导出块里已导出）。
 */
function buildEbookPayload(settings, chatLog, delivery = 'server') {
    const structured = buildStructuredNovel(settings, chatLog);
    return { structured, payload: {
        delivery: delivery === 'download' ? 'download' : 'server',
        bookTitle: structured.bookTitle,
        author: getBookTitle(settings),
        account: (typeof ctx.currentUser !== 'undefined' && ctx.currentUser && (ctx.currentUser.name || ctx.currentUser.handle)) || '',
        save_dir: settings.save_dir || '',
        chat_anchor: getChatAnchor(),
        file_name: getBookFileName(settings),
        chapters: structured.chapters,
        options: {
            maxImageBytes: Math.max(1, Number(settings.ebook_max_image_mb) || 5) * 1024 * 1024,
            maxTotalBytes: Math.max(1, Number(settings.ebook_max_total_mb) || 80) * 1024 * 1024,
            stRoot: settings.ebook_st_root || ''
        }
    } };
}

// ==================== 电子书体积预估（v1.19.0：导出前预检 + 预览展示）====================
// 100MB 阈值依据：部分手机阅读器（含微信读书）在电子书超过该体量后导入/下载明显变慢甚至失败，
// 且移动端流量消耗与等待时间陡增 —— 它不是硬限制，只是「体积较大」的强提示分界。
const EBOOK_LARGE_WARN_BYTES = 100 * 1024 * 1024;
// 与服务端设置项「图片总量上限」的 UI 上限（模板 input max="500"）保持一致，自动调上限时封顶于此。
const EBOOK_MAX_TOTAL_LIMIT_MB = 500;

/** 把字节数格式化为 MB 文本（保留一位小数，如 `130.4 MB`）；非法值按 0 处理 */
function formatBytesMb(bytes) {
    const n = Number(bytes);
    const safe = (Number.isFinite(n) && n > 0) ? n : 0;
    return `${(safe / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 导出前体积预估：调服务端只读估算接口（只 stat + 头部魔数嗅探，不读整图、不打包、零落盘）。
 * 能力不可用 / 网络异常 / 响应非法时一律返回 null —— 预估只提供提示，绝不能阻塞导出（静默降级）。
 */
async function estimateEbookPayload(payload) {
    if (serverCapabilities.ebookEstimate !== true) return null;
    try {
        const headers = (typeof getRequestHeaders === 'function') ? getRequestHeaders() : { 'Content-Type': 'application/json' };
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const resp = await fetch('/api/plugins/auto-save/ebook/estimate', {
            method: 'POST', headers, body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            console.warn(`[AutoSaveTxt] EPUB 体积预估失败：HTTP ${resp.status}`);
            return null;
        }
        const data = await resp.json().catch(() => null);
        if (!data || data.success !== true || !data.images || typeof data.images !== 'object') {
            console.warn('[AutoSaveTxt] EPUB 体积预估响应非法，已跳过预检');
            return null;
        }
        return data;
    } catch (e) {
        console.warn('[AutoSaveTxt] EPUB 体积预估异常，已跳过预检:', e && e.message);
        return null;
    }
}

/**
 * 异步填充「图片清单预览」里的体积预估行。
 * 预览永远按「开启嵌图」估算（只用于预估，不修改用户设置）——即使用户当前关闭开关，
 * 也能提前知道打开后会导出多大。能力缺失/预估失败时静默移除占位，不影响清单展示。
 */
async function fillEbookEstimateHint(overlay, settings, chatLog) {
    const estEl = overlay ? overlay.querySelector('#novel_ebook_modal_estimate') : null;
    if (!estEl) return;
    try {
        if (serverCapabilities.ebookEstimate !== true) {
            estEl.remove();
            return;
        }
        const built = buildEbookPayload({ ...settings, ebook_embed_images: true }, chatLog);
        const estimate = await estimateEbookPayload(built.payload);
        // 等待期间弹窗可能被关闭/重新打开：占位节点已不是当前节点就不再写入
        if (!overlay || overlay.querySelector('#novel_ebook_modal_estimate') !== estEl) return;
        if (!estimate || !estimate.images) {
            estEl.remove();
            return;
        }
        const images = estimate.images;
        const estimatedBytes = Number(images.estimatedBytes) || 0;
        const embeddable = Number(images.embeddable) || 0;
        const missing = Number(images.missing) || 0;
        const oversize = Number(images.oversize) || 0;
        const estMb = formatBytesMb(estimatedBytes);
        const parts = [`预计电子书约 ${estMb}（图片可嵌入 ${embeddable} 张 · 缺失 ${missing} · 超限 ${oversize}）`];
        let warn = false;
        if (estimate.overTotalLimit === true) {
            const limitMb = Math.max(1, Number(settings.ebook_max_total_mb) || 80);
            parts.push(`超过当前图片总量上限 ${limitMb} MB，导出会被拒绝，建议提高上限`);
            warn = true;
        }
        if (estimatedBytes >= EBOOK_LARGE_WARN_BYTES) {
            parts.push('体积较大，部分阅读器导入可能失败或很慢');
            warn = true;
        }
        estEl.textContent = parts.join('；');
        if (warn) estEl.classList.add('is-warn');
    } catch (e) {
        console.warn('[AutoSaveTxt] 预览体积预估填充失败:', e && e.message);
        try { estEl.remove(); } catch (err) { /* 占位已不在 DOM 时忽略 */ }
    }
}

/** 只读图片清单预览（P0.5）：不改任何文件，先看再导 */
function openEbookPreviewModal() {
    if (typeof document === 'undefined') return;
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    const scan = scanBookImages(settings, chatLog);

    let overlay = document.getElementById('novel_ebook_modal');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'novel_ebook_modal';
        overlay.className = 'novel-modal-overlay';
        overlay.style.display = 'none';
        overlay.innerHTML = `
            <div class="novel-modal novel-modal-preview" role="dialog" aria-modal="true" aria-label="图片清单预览">
                <div class="novel-modal-header">
                    <b class="novel-modal-title"><i class="fa-solid fa-images"></i>图片清单预览</b>
                    <button type="button" id="novel_ebook_modal_close" class="novel-icon-btn" title="关闭"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="novel-modal-body" id="novel_ebook_modal_body"></div>
            </div>`;
        // 与其它浮层同一约定：必须挂进 top-layer 载体，直接 appendChild 到 body 会被宿主
        // html transform 劫持 fixed 定位（v1.17.3 踩过的坑，测试对此有守护断言）。
        mountInTopLayer('novel-tl-ebook', overlay);
        overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.style.display = 'none'; });
        const closeBtn = overlay.querySelector('#novel_ebook_modal_close');
        if (closeBtn) closeBtn.addEventListener('click', () => { overlay.style.display = 'none'; });
    }

    const body = overlay.querySelector('#novel_ebook_modal_body');
    if (!body) return;
    const rows = [];
    // 开关关着时清单预览仍有排障价值，但必须一眼看清"这些图不会进 EPUB"
    if (!settings.ebook_embed_images) {
        rows.push('<div class="novel-mv-hint is-warn">当前未勾选嵌入，以下图片不会进入 EPUB。</div>');
    }
    rows.push(`<div class="novel-mv-stat">含图消息 <b>${scan.imageMessages}</b> 条 · 图片共 <b>${scan.totalImages}</b> 张`
        + `${scan.degradedCount ? ` · <span class="is-warn">原位校验不一致 ${scan.degradedCount} 条（将退化为章尾插图）</span>` : ' · 原位校验全部一致'}`
        + `${scan.missingList.length ? ` · <span class="is-warn">${scan.missingList.length} 项缺失</span>` : ''}</div>`);
    // 体积预估占位（异步填充）：能力不可用或失败时会被移除，不阻塞清单
    rows.push('<div id="novel_ebook_modal_estimate" class="novel-mv-hint">正在估算图片体积…</div>');
    if (!scan.messages.length) {
        rows.push('<div class="novel-mv-hint">当前会话没有识别到图片。若你在用 bbi 等图像生成扩展，请确认消息里带有 <code>extra.bbiImage</code> 数据。</div>');
    }
    for (const m of scan.messages) {
        rows.push(`<div class="novel-ebook-row"><div class="novel-ebook-row-head"><b>第 ${m.chapter} 章</b> · 楼层 ${m.floor} · ${escapeHtml(m.speaker)} · 标记 ${m.markerCount} / 图 ${m.imageCount}${m.degraded ? ' · <span class="is-warn">降级</span>' : ''}</div>`);
        for (const im of m.images) {
            const ok = !im.status || im.status === 'ready';
            rows.push(`<div class="novel-ebook-img ${ok ? '' : 'is-bad'}"><code>${escapeHtml(im.path.split('/').pop() || im.path)}</code>`
                + ` <span class="novel-chip-count">slot ${im.slotSeq}</span>`
                + `${ok ? '' : ` <span class="is-warn">状态 ${escapeHtml(im.status)}</span>`}</div>`);
        }
        if (m.degraded && m.reason) rows.push(`<div class="novel-mv-hint is-warn">${escapeHtml(m.reason)}</div>`);
        rows.push('</div>');
    }
    if (scan.missingList.length) {
        rows.push('<div class="novel-mv-hint is-warn">缺失项：' + scan.missingList.map(escapeHtml).join('；') + '</div>');
    }
    body.innerHTML = rows.join('');
    overlay.style.display = 'flex';
    // 能力不可用时立即删除占位；可用时异步填「预计电子书约 X MB」（失败静默移除）
    fillEbookEstimateHint(overlay, settings, chatLog);
    if (typeof closeEbookModalOnEsc === 'undefined') { /* 占位，保持结构清晰 */ }
}

/**
 * 导出 EPUB：调服务端 /ebook 打包。
 * mode='server'（默认）：服务端写入保存目录后返回 JSON，提示文件位置（原有行为）；
 * mode='download'：服务端直接返回 EPUB 二进制，由浏览器下载到本机（不写服务器、不需要保存目录）。
 */
async function exportEbook(btn, mode = 'server') {
    const isDownload = mode === 'download';
    const actionName = isDownload ? '下载' : '导出';
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    // 能力门控：老服务端（无 /ebook）直接给可操作提示，不发无效请求
    if (serverCapabilities.ebook !== true) {
        updateRecentStatus('error', '当前服务端插件版本过旧（缺少 /ebook 接口），请重新部署 plugins/auto-save 后重启酒馆');
        if (window.toastr) {
            window.toastr.warning('EPUB 导出需要更新服务端插件（缺少 /ebook 接口）。请重新部署 plugins/auto-save 并重启酒馆。', '小说连载', { timeOut: 8000 });
        }
        return;
    }
    // download 是服务端 1.15.0 新增能力：老服务端不认识 delivery 会按 server 模式落盘，
    // 所以能力不满足时必须拦住，不能让它悄悄写服务器文件。
    if (isDownload && serverCapabilities.ebookDownload !== true) {
        updateRecentStatus('error', '当前服务端插件版本过旧（不支持直接下载），请重新部署 plugins/auto-save 后重启酒馆');
        if (window.toastr) {
            window.toastr.warning('下载到本机需要更新服务端插件（缺少 download 交付能力）。请重新部署 plugins/auto-save 并重启酒馆。', '小说连载', { timeOut: 8000 });
        }
        return;
    }
    if (!chatLog || !chatLog.length) {
        if (window.toastr) window.toastr.info('当前没有任何聊天内容可供导出。', '小说连载');
        return;
    }
    if (!settings.ebook_embed_images && window.toastr) {
        window.toastr.info('未开启「嵌入图片」，本次将导出纯文字 EPUB。可在设置里打开。', '小说连载');
    }

    // 结构化正文只构建一次：体积预估与正式导出复用同一份 payload，避免两次 build 结果不一致。
    // 交付方式由调用入口决定：server = 服务端落盘（原有行为）；download = 二进制直接下载。
    const delivery = mode === 'download' ? 'download' : 'server';
    const { payload } = buildEbookPayload(settings, chatLog, delivery);

    const embedLine = settings.ebook_embed_images ? '将把识别到的插画按正文原位嵌入。' : '图片嵌入未开启，本次为纯文字。';
    const deliveryLine = isDownload
        ? 'EPUB 将直接在浏览器中下载到本机（不写入服务器目录，也不需要保存目录）。'
        : 'EPUB 将被写入服务器保存目录（不下载到本机）。';

    // ===== 导出前体积预估（v1.19.0）：仅嵌图 + 服务端支持 estimate 时预检，失败静默降级 =====
    let estimate = null;
    const canEstimate = settings.ebook_embed_images === true && serverCapabilities.ebookEstimate === true;
    if (canEstimate) {
        updateRecentStatus('updating', '正在估算图片体积…');
        estimate = await estimateEbookPayload(payload);
        if (estimate && estimate.images) {
            const estBytes = Number(estimate.images.estimatedBytes) || 0;
            updateRecentStatus('idle', estBytes > 0
                ? `体积预估完成：图片约 ${formatBytesMb(estBytes)}（${Number(estimate.images.embeddable) || 0} 张可嵌入）`
                : '体积预估完成：没有可嵌入的图片');
        } else {
            estimate = null; // 预估失败绝不能阻塞导出：按原流程继续
            updateRecentStatus('idle', '未能获取图片体积预估，按常规流程继续导出');
        }
    }

    let estimateLine = '';
    let confirmed = false;
    if (estimate && estimate.images) {
        const estBytes = Number(estimate.images.estimatedBytes) || 0;
        const estMb = formatBytesMb(estBytes);
        const embeddable = Number(estimate.images.embeddable) || 0;
        const missing = Number(estimate.images.missing) || 0;
        const oversize = Number(estimate.images.oversize) || 0;
        if (estimate.overTotalLimit === true) {
            // a. 超过当前「图片总量上限」：先问是否自动提高上限，否则服务端必然 413
            const needMb = Math.ceil(estBytes / (1024 * 1024)) + 1; // 带 1MB 余量
            if (needMb > EBOOK_MAX_TOTAL_LIMIT_MB) {
                updateRecentStatus('error', `EPUB 预检：图片预计约 ${estMb}，已超过单次导出上限 ${EBOOK_MAX_TOTAL_LIMIT_MB} MB`);
                if (window.toastr) {
                    window.toastr.error(`图片预计约 ${estMb}，已超过单次导出上限 ${EBOOK_MAX_TOTAL_LIMIT_MB} MB。请减少图片数量或降低「单图上限」后再导出。`, '小说连载', { timeOut: 9000 });
                }
                return; // 不发注定被拒绝的请求
            }
            const curLimitMb = Math.max(1, Number(settings.ebook_max_total_mb) || 80);
            if (!confirm(`电子书预计图片约 ${estMb}（${embeddable} 张可嵌入），超过当前「图片总量上限」${curLimitMb} MB，继续导出会被服务端拒绝。\n是否自动把上限提高到 ${needMb} MB 并继续？`)) {
                updateRecentStatus('idle', '已取消导出（未调整图片总量上限）');
                if (window.toastr) window.toastr.info('已取消导出。可在设置里手动提高「图片总量上限」后再试。', '小说连载', { timeOut: 5000 });
                return;
            }
            settings.ebook_max_total_mb = needMb;
            // 复用同一份 payload 时必须同步抬高 options.maxTotalBytes，否则服务端仍按旧上限 413
            payload.options.maxTotalBytes = needMb * 1024 * 1024;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            const limitEl = document.querySelector('#novel_ebook_max_total_mb');
            if (limitEl) limitEl.value = String(needMb);
            if (window.toastr) window.toastr.success(`已把「图片总量上限」提高到 ${needMb} MB，继续导出`, '小说连载', { timeOut: 4500 });
            confirmed = true; // 自动调限即视为已确认，不再弹第二次 confirm
        } else if (estBytes >= EBOOK_LARGE_WARN_BYTES) {
            // b. 未超限但体积很大：强提示二次确认（含现有交付方式说明）
            if (!confirm(`电子书预计约 ${estMb}（图片 ${embeddable} 张），体积较大：部分手机阅读器/微信读书导入可能变慢或失败，下载也更耗时。\n${deliveryLine}\n${embedLine}\n仍要继续吗？`)) {
                updateRecentStatus('idle', '已取消导出（电子书体积较大）');
                if (window.toastr) window.toastr.info('已取消导出。可减少图片或降低「单图上限」后再试。', '小说连载', { timeOut: 5000 });
                return;
            }
            confirmed = true;
        } else {
            // c. 正常体积：作为普通确认框的附加说明行；预估为 null 时不出现（保持旧行为）
            estimateLine = `预计图片约 ${estMb}（${embeddable} 张可嵌入，缺失 ${missing} 张 / 超限 ${oversize} 张）`;
        }
    }

    if (!confirmed) {
        const confirmLines = [`是否${actionName} EPUB 电子书？`, deliveryLine, embedLine];
        if (estimateLine) confirmLines.push(estimateLine);
        confirmLines.push('后续可在手机阅读器（微信读书/ReadPad/掌阅）中导入。');
        if (!confirm(confirmLines.join('\n'))) {
            updateRecentStatus('idle', '已取消 EPUB 导出');
            return;
        }
    }

    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在打包 EPUB…'; }
    updateRecentStatus('updating', isDownload ? '正在生成 EPUB 电子书并准备下载...' : '正在生成 EPUB 电子书（含图片收集）...');

    try {
        const headers = (typeof getRequestHeaders === 'function') ? getRequestHeaders() : { 'Content-Type': 'application/json' };
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
        const resp = await fetch('/api/plugins/auto-save/ebook', {
            method: 'POST', headers, body: JSON.stringify(payload)
        });
        // 失败一律是 JSON error（download 模式的错误响应同样不带二进制头）
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            const msg = (data && data.error) || `HTTP ${resp.status}`;
            updateRecentStatus('error', `EPUB 导出失败：${msg}`);
            if (window.toastr) window.toastr.error(`EPUB 导出失败：${msg}`, '小说连载');
            return;
        }
        if (isDownload) {
            // 二进制下载：响应体就是 EPUB；统计走 X-Novel-Epub-Stats 响应头（没有 JSON 体）
            const blob = await resp.blob();
            const fileName = `${sanitizeFilename(payload.bookTitle)}.epub`;
            let stats = null;
            try {
                const rawStats = (resp.headers && typeof resp.headers.get === 'function')
                    ? resp.headers.get('x-novel-epub-stats') : null;
                if (rawStats) stats = JSON.parse(decodeURIComponent(rawStats));
            } catch (e) { stats = null; } // 头缺失/损坏绝不能影响下载本身
            // 临时下载链接：不挂进可见 DOM，点完立即移除；对象 URL 延迟回收（立即回收会取消下载）
            const url = URL.createObjectURL(blob);
            try {
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.style.display = 'none';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            } finally {
                setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* 回收失败无影响 */ } }, 60000);
            }
            const imgs = (stats && stats.images) || {};
            const imgMsg = imgs.embedded ? ` 图片 ${imgs.embedded} 张已嵌入` : ' 纯文字';
            const skipMsg = imgs.skipped ? `（跳过 ${imgs.skipped} 张）` : '';
            const sizeMsg = (stats && Number(stats.epubBytes) > 0) ? `（${(Number(stats.epubBytes) / 1024).toFixed(1)} KB）` : '';
            // 本机下载没有服务器文件路径：清掉上一次 server 导出的旧路径，避免状态行挂着过期文件
            recentStatus.file = '';
            updateRecentStatus('success', `EPUB 已下载到本机：${fileName}${sizeMsg}${imgMsg}${skipMsg}`);
            if (window.toastr) {
                window.toastr.success(`EPUB 电子书已下载到本机：${fileName}${sizeMsg}${imgMsg}${skipMsg}`, '小说连载', { timeOut: 6000 });
            }
            return;
        }
        // server 模式：服务端落盘后返回 JSON
        const data = await resp.json().catch(() => ({}));
        if (!data || data.success !== true) {
            const msg = (data && data.error) || `HTTP ${resp.status}`;
            updateRecentStatus('error', `EPUB 导出失败：${msg}`);
            if (window.toastr) window.toastr.error(`EPUB 导出失败：${msg}`, '小说连载');
            return;
        }
        const imgs = data.images || {};
        const imgMsg = imgs.embedded ? ` 图片 ${imgs.embedded} 张已嵌入` : ' 纯文字';
        const skipMsg = imgs.skipped ? `（跳过 ${imgs.skipped} 张）` : '';
        updateRecentStatus('success', `EPUB 已导出：${data.file}${imgMsg}${skipMsg}`);
        if (window.toastr) {
            window.toastr.success(`EPUB 电子书已生成：${data.file}${imgMsg}${skipMsg}`, '小说连载', { timeOut: 6000 });
        }
        if (imgs.missing && imgs.missing.length && window.toastr) {
            window.toastr.warning(`有 ${imgs.missing.length} 张图片未找到：${imgs.missing.slice(0, 3).join('；')}`, '小说连载', { timeOut: 8000 });
        }
    } catch (e) {
        updateRecentStatus('error', `EPUB 导出异常：${e.message}`);
        if (window.toastr) window.toastr.error(`EPUB 导出异常：${e.message}`, '小说连载');
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    }
}

/** 创建过滤效果预览弹窗（body 级，全程只建一次） */
function ensurePreviewModal() {
    if (typeof document === 'undefined') return null;
    let overlay = document.getElementById('novel_preview_modal');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'novel_preview_modal';
    overlay.className = 'novel-modal-overlay';
    overlay.style.display = 'none';
    overlay.innerHTML = `
        <div class="novel-modal novel-modal-preview" role="dialog" aria-modal="true" aria-label="过滤效果预览">
            <div class="novel-modal-header">
                <b class="novel-modal-title"><i class="fa-solid fa-eye"></i>过滤效果预览</b>
                <span class="novel-modal-header-meta">
                    <span class="novel-mv-badge" id="novel_modal_speaker"></span>
                    <span class="novel-mv-badge" id="novel_modal_floor"></span>
                    <span class="novel-mv-badge is-draft" id="novel_modal_draft" style="display: none;"><i class="fa-solid fa-pen-ruler"></i> 草稿未定稿</span>
                    <button type="button" id="novel_modal_close" class="novel-icon-btn" title="关闭预览"><i class="fa-solid fa-xmark"></i></button>
                </span>
            </div>
            <div class="novel-mv-statbar" id="novel_modal_statbar"></div>
            <div class="novel-modal-body novel-mv-body">
                <div class="novel-mv-grid">
                    <section class="novel-mv-col is-clean">
                        <div class="novel-mv-col-title"><i class="fa-solid fa-book-open"></i> 入书正文<span class="novel-mv-count" id="novel_modal_clean_count"></span></div>
                        <div id="novel_modal_clean" class="novel-mv-text"></div>
                    </section>
                    <section class="novel-mv-col is-raw">
                        <div class="novel-mv-col-title"><i class="fa-solid fa-code"></i> 原始回复<span class="novel-mv-count" id="novel_modal_raw_count"></span><span class="novel-mv-legend"><mark class="novel-mv-removed"></mark> 高亮 = 被剔除</span></div>
                        <div id="novel_modal_raw" class="novel-mv-text"></div>
                    </section>
                </div>
            </div>
        </div>
    `;
    // v1.17.3：挂进 top-layer 载体（与设置弹窗同一个坑，同一个修法）
    mountInTopLayer('novel-tl-preview', overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeFilterPreviewModal();
    });
    const closeBtn = overlay.querySelector('#novel_modal_close');
    if (closeBtn) closeBtn.addEventListener('click', () => closeFilterPreviewModal());
    bindNovelEscClose();
    return overlay;
}

/**
 * 连载总开关共享逻辑（面板复选框与底部快捷栏共用）：
 * 开启前前置探测服务端是否可用，未就绪则取消勾选并提示；成功返回 true，被拒返回 false
 */
async function setNovelEnabled(wantEnable) {
    const settings = getSettings();
    if (wantEnable) {
        const probe = await checkServerPluginStatus();
        if (!probe.ready) {
            settings.enabled = false;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            const enableCheckbox = document.getElementById('novel_save_enabled');
            if (enableCheckbox) enableCheckbox.checked = false;
            if (window.toastr) {
                window.toastr.warning(
                    '服务端插件未就绪（未安装或未启动），已自动取消勾选（防止 404 报错）。您可以直接点击下方【导出整本 TXT】下载，或参考下方指引部署插件。',
                    '小说连载',
                    { timeOut: 5500 }
                );
            }
            return false;
        }
        settings.enabled = true;
        settings.userDisabled = false; // 用户主动开启
    } else {
        settings.enabled = false;
        settings.userDisabled = true;  // 用户主动手动关闭，不再自动重新勾选
    }
    const enableCheckbox = document.getElementById('novel_save_enabled');
    if (enableCheckbox) enableCheckbox.checked = settings.enabled;
    if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
    refreshNovelToolbars();
    return true;
}

async function renderSettingsUI(cachedStatus = null) {
    if (typeof document === 'undefined') return;
    const settings = getSettings();
    // 设置面板统一挂到 body 级设置弹窗内（不再进入酒馆「扩展程序」抽屉）
    const overlay = ensureSettingsModal();
    if (!overlay) return;
    const container = overlay.querySelector('#novel_settings_body');
    if (!container) return;

    const status = cachedStatus || await checkServerPluginStatus();

    // 记录服务端插件版本与能力声明（问候语补写等按版本门控；EPUB 等新功能按能力门控）
    if (status.ready) {
        serverPluginVersion = status.version || serverPluginVersion;
        if (status.capabilities && typeof status.capabilities === 'object') {
            serverCapabilities = status.capabilities;
        }
    }

    // 如果服务端已就绪且非用户刻意主动关闭，全自动激活开启连载状态
    if (status.ready && !settings.enabled && !settings.userDisabled) {
        settings.enabled = true;
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        updateRecentStatus('ready', '连载服务已就绪，已自动开启小说连载');
    }

    const initialFileName = getBookFileName(settings);
    const initialDir = settings.save_dir ? (settings.save_dir.replace(/[\\/]+$/, '') + '/') : 'SillyTavern/plugins/auto-save/logs/';

    let panel = document.getElementById('auto-save-to-txt-settings');
    if (panel) panel.remove();
    container.textContent = '';

    panel = document.createElement('div');
    panel.id = 'auto-save-to-txt-settings';
    panel.className = 'novel-drawer-inner';

    // 分区信息架构：开关置顶，依次为 当前连载 / 正文过滤 / 排版与行为 / 文件与导出
    panel.innerHTML = `
                <!-- 主开关：常驻头部下方，不藏进标签（总闸必须在任何标签下都能一眼看到） -->
                <div class="novel-toggle-card">
                    <div class="novel-toggle-row">
                        <label class="checkbox_label is-primary" title="开启后，每轮 AI 回复将像小说章节一样自动写入 txt，随时用手机或阅读器翻阅">
                            <input type="checkbox" id="novel_save_enabled" ${settings.enabled ? 'checked' : ''} />
                            <span>开启小说自动连载</span>
                        </label>
                    </div>
                </div>

                <!-- 标签栏：桌面在头部下方横向排列；手机端由 CSS 的 order 移到底部常驻 -->
                <nav class="novel-tabs" role="tablist" aria-label="小说连载设置分区">
                    <button type="button" class="novel-tab is-active" role="tab" id="novel_tab_serial" aria-selected="true" aria-controls="novel_pane_serial" data-nv-tab="serial"><i class="fa-solid fa-book-bookmark"></i><span>连载</span></button>
                    <button type="button" class="novel-tab" role="tab" id="novel_tab_filter" aria-selected="false" aria-controls="novel_pane_filter" data-nv-tab="filter"><i class="fa-solid fa-filter"></i><span>过滤</span></button>
                    <button type="button" class="novel-tab" role="tab" id="novel_tab_format" aria-selected="false" aria-controls="novel_pane_format" data-nv-tab="format"><i class="fa-solid fa-sliders"></i><span>排版</span></button>
                    <button type="button" class="novel-tab" role="tab" id="novel_tab_file" aria-selected="false" aria-controls="novel_pane_file" data-nv-tab="file"><i class="fa-solid fa-folder-open"></i><span>文件</span></button>
                    <button type="button" class="novel-tab" role="tab" id="novel_tab_general" aria-selected="false" aria-controls="novel_pane_general" data-nv-tab="general"><i class="fa-solid fa-gear"></i><span>通用</span></button>
                </nav>

                <!-- 标签面板：5 个面板一次性全部挂载、切换只改 display。
                     红线：禁止按标签重建 innerHTML —— 面板内大量 panel.querySelector('#id')
                     按 ID 现取元素，且标签扫描是异步渲染的，重建会丢输入焦点与扫描结果。 -->
                <div class="novel-tabpanes">

                <div class="novel-tabpane is-active" id="novel_pane_serial" data-nv-pane="serial" role="tabpanel" aria-labelledby="novel_tab_serial">
                <div class="novel-section-title"><i class="fa-solid fa-book-bookmark"></i> 当前连载</div>
                <!-- 折叠行：默认全部收起，开合由 applyNovelAccOpen 按 settings.acc_open 恢复 -->
                <div class="novel-acc" data-nv-acc="book">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-file-lines"></i> 连载文件</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_book">${escapeHtml(recentStatus.text || initialFileName)}</span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <div class="novel-info-row">
                            <span class="novel-info-key">文件名</span>
                            <span class="novel-info-val novel-book-filename" id="novel_drawer_filename" title="点击复制完整文件路径">${escapeHtml(initialFileName)}</span>
                            <button type="button" id="novel_copy_filepath_btn" class="novel-copy-pill" title="复制完整文件保存路径">
                                <i class="fa-regular fa-copy"></i> 复制路径
                            </button>
                        </div>
                        <div class="novel-info-row">
                            <span class="novel-info-key">保存路径</span>
                            <span class="novel-info-val is-wrap"><code id="novel_drawer_filepath">${escapeHtml(initialDir)}${escapeHtml(initialFileName)}</code></span>
                        </div>
                        <div id="novel_recent_status" class="novel-status-line ${recentStatus.state === 'updating' ? 'is-updating' : (recentStatus.state === 'success' ? 'is-success' : (recentStatus.state === 'skipped' ? 'is-skipped' : (recentStatus.state === 'error' ? 'is-error' : 'is-idle')))}">
                            <span id="novel_recent_detail">
                                ${recentStatus.state === 'success'
                                    ? `<span><i class="fa-solid fa-circle-check"></i> <b>更新完成：</b>${escapeHtml(recentStatus.text)}</span>${recentStatus.file ? `<div class="novel-status-file">文件路径：<code>${escapeHtml(recentStatus.file)}</code></div>` : ''}`
                                    : (recentStatus.state === 'updating'
                                        ? `<span><i class="fa-solid fa-spinner fa-spin"></i> <b>更新中：</b>${escapeHtml(recentStatus.text)}</span>`
                                        : (recentStatus.state === 'skipped'
                                            ? `<span><i class="fa-solid fa-circle-info"></i> <b>已跳过：</b>${escapeHtml(recentStatus.text)}</span>${recentStatus.file ? `<div class="novel-status-file">文件路径：<code>${escapeHtml(recentStatus.file)}</code></div>` : ''}`
                                            : (recentStatus.state === 'error'
                                                ? `<span><i class="fa-solid fa-circle-exclamation"></i> <b>写入失败：</b>${escapeHtml(recentStatus.text)}</span>`
                                                : `<i class="fa-solid fa-circle-check" style="opacity: 0.7;"></i> ${escapeHtml(recentStatus.text)}`)))
                                }
                            </span>
                            <span id="novel_recent_time" class="novel-status-time">${recentStatus.time || '--:--:--'}</span>
                        </div>
                        <div id="novel_save_status_badge" class="novel-alert checking">
                            <i class="fa-solid fa-circle-notch fa-spin"></i>
                            <div class="novel-alert-text">正在检查连载服务状态...</div>
                        </div>
                        <div id="novel_deploy_guide" class="novel-guide-section" style="display: none;"></div>
                    </div>
                </div>
                </div><!-- /.novel-tabpane serial -->

                <div class="novel-tabpane" id="novel_pane_filter" data-nv-pane="filter" role="tabpanel" aria-labelledby="novel_tab_filter">
                <div class="novel-section-title"><i class="fa-solid fa-filter"></i> 正文过滤</div>

                <div class="novel-acc" data-nv-acc="include">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-circle-check"></i> 只保留的标签（白名单）</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_include">${settings.include_tags ? escapeHtml(settings.include_tags) : '整篇保留'}</span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <input type="text" id="novel_include_tags" class="text_pole" value="${escapeHtml(settings.include_tags || '')}" placeholder="例如: story, response, content" />
                        <small>留空 = 整篇保留。AI 若把小说写在某个标签内（如 <code>&lt;story&gt;</code>），填入标签名即只提取其中正文，忽略外部元数据。</small>
                    </div>
                </div>

                <div class="novel-acc" data-nv-acc="exclude">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-circle-minus"></i> 剔除的标签块（黑名单）</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_exclude">${settings.exclude_tags ? escapeHtml(settings.exclude_tags) : '未设置'}</span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <input type="text" id="novel_exclude_tags" class="text_pole" value="${escapeHtml(settings.exclude_tags || '')}" placeholder="例如: status, memory, details, ooc, note" />
                        <small>无论在整篇还是正文标签内部，都会彻底剔除这些干扰块。</small>
                    </div>
                </div>

                <!-- 【会话标签检测】：自动扫描当前聊天出现的标签，一键加入白/黑名单 -->
                <div class="novel-acc" data-nv-acc="scan">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-tags"></i> 会话标签检测</span>
                        <span class="novel-acc-summary" id="novel_tag_scan_count"></span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <button type="button" id="novel_rescan_tags_btn" class="novel-chip-btn novel-acc-action" title="重新扫描当前会话中出现的标签"><i class="fa-solid fa-rotate"></i> 重新扫描</button>
                        <div id="novel_tag_chips" class="novel-tag-chip-list"></div>
                        <small>点「白」= 只保留该标签内的正文；点「黑」= 彻底剔除该标签块；再次点击可移除；两侧互斥；鼠标悬浮标签可预览其最新内容。</small>
                    </div>
                </div>

                <!-- 【过滤效果预览】：动作行，不折叠（要一眼能找到） -->
                <div class="novel-acc-flat">
                    <span class="novel-acc-title"><i class="fa-solid fa-eye"></i> 过滤效果预览</span>
                    <button type="button" id="novel_preview_btn" class="novel-btn novel-btn-block" title="弹窗展示最近一条 AI 回复经当前白/黑名单过滤后的完整正文">
                        <i class="fa-solid fa-eye"></i> <span id="novel_preview_btn_label">查看最近一条 AI 回复的过滤效果</span>
                    </button>
                    <small id="novel_preview_btn_stat" class="novel-preview-stat"></small>
                </div>
                </div><!-- /.novel-tabpane filter -->

                <div class="novel-tabpane" id="novel_pane_format" data-nv-pane="format" role="tabpanel" aria-labelledby="novel_tab_format">
                <div class="novel-section-title"><i class="fa-solid fa-sliders"></i> 排版与行为</div>

                <div class="novel-acc" data-nv-acc="style">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-list-ol"></i> 章节目录风格</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_style"></span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <select id="novel_chapter_style" class="text_pole novel-select">
                            <option value="numbered_floor" ${settings.chapter_style !== 'numbered' && settings.chapter_style !== 'separator' && settings.chapter_style !== 'dialogue' ? 'selected' : ''}>第 X 章 · 角色名 (原楼层: Y)（默认推荐：带楼层标记，方便快速定位排查问题）</option>
                            <option value="numbered" ${settings.chapter_style === 'numbered' ? 'selected' : ''}>第 X 节 · 角色名（纯净小说目录，无楼层）</option>
                            <option value="separator" ${settings.chapter_style === 'separator' ? 'selected' : ''}>优雅分割线（* * * 散文小说连续阅读）</option>
                            <option value="dialogue" ${settings.chapter_style === 'dialogue' ? 'selected' : ''}>【角色名】正文（纯净戏剧体，无章节号）</option>
                        </select>
                        <small>
                            切换后仅对<b>新写入章节</b>生效；想让已写内容统一为新样式，点一次【同步历史连载】即可全书重写。「原楼层」= 聊天记录中从上到下的消息序号（含问候语与你的发言），与酒馆界面楼层一致。
                        </small>
                    </div>
                </div>

                <div class="novel-acc" data-nv-acc="naming">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-file-signature"></i> 文件命名规则</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_naming"></span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <select id="novel_naming_rule" class="text_pole novel-select">
                            <option value="char_chat" ${settings.naming_rule !== 'char_only' ? 'selected' : ''}>角色名 - 对话名（推荐：新聊天自动新建小说，绝不覆盖旧聊天）</option>
                            <option value="char_only" ${settings.naming_rule === 'char_only' ? 'selected' : ''}>仅角色名（所有聊天合为一本，如 角色名.txt）</option>
                        </select>
                        <small>
                            开启新聊天或平行分支时，默认会自动保存为新小说（如 <code>艾莉丝 - 2026-09-10.txt</code> 或自定义对话名），旧小说绝不被覆盖或串台！
                        </small>
                    </div>
                </div>

                <div class="novel-acc" data-nv-acc="write">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-pen-nib"></i> 阅读与写入</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_write"></span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <!-- 三个开关都是「左标题 + 右控件」的扁平行，分隔靠发丝线（样式见 .novel-acc-body > .checkbox_label） -->
                        <label class="checkbox_label" title="开启后，你的提问与互动也会作为主角对白融入小说中；关闭则只收录纯故事正文">
                            <input type="checkbox" id="novel_include_user" ${settings.include_user_dialogue ? 'checked' : ''} />
                            <span>将你的发言作为主角对白融入小说</span>
                        </label>
                        <label class="checkbox_label" title="每段开头空两格（全角空格），符合中文出版小说排版规范">
                            <input type="checkbox" id="novel_indent_paragraphs" ${settings.indent_paragraphs ? 'checked' : ''} />
                            <span>段落首行空两格（中文小说规范缩进）</span>
                        </label>
                        <label class="checkbox_label" title="开启后，最新一楼暂不写入连载文件，留出充分的 Roll 点与修改空间；待下一轮剧情推进时再正式定稿入书">
                            <input type="checkbox" id="novel_buffer_latest" ${settings.buffer_latest_message ? 'checked' : ''} />
                            <span>草稿缓冲（最新楼层延迟定稿）</span>
                        </label>
                    </div>
                </div>
                </div><!-- /.novel-tabpane format -->

                <div class="novel-tabpane" id="novel_pane_file" data-nv-pane="file" role="tabpanel" aria-labelledby="novel_tab_file">
                <div class="novel-section-title"><i class="fa-solid fa-folder-open"></i> 文件与导出</div>

                <div class="novel-acc" data-nv-acc="dir">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-folder"></i> 保存位置</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_dir"></span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <input type="text" id="novel_save_dir" class="text_pole" value="${escapeHtml(settings.save_dir || '')}" placeholder="留空默认存至 plugins/auto-save/logs；填写服务端有效目录" />
                        <small title="若酒馆部署在云服务器(Linux)，无法直接填写本地盘符（如 D:\），此时建议留空并用【导出整本 TXT】下载">服务端（运行酒馆的机器）目录，留空为默认。当前：<code id="novel_save_dir_preview">${escapeHtml(initialDir)}${escapeHtml(initialFileName)}</code></small>
                    </div>
                </div>

                <!-- 动作行：不折叠，要一眼能找到。按钮的伸缩由 .novel-acc-flat > .novel-btn 的 CSS 决定，不写内联样式 -->
                <div class="novel-acc-flat">
                    <span class="novel-acc-title"><i class="fa-solid fa-file-export"></i> 导出与同步</span>
                    <div class="novel-btn-row">
                        <button type="button" id="novel_export_all_btn" class="novel-btn btn-export" title="无需服务端插件，直接在浏览器中将所有聊天编排为小说 TXT 并下载">
                            <i class="fa-solid fa-download"></i> 导出整本 TXT
                        </button>
                        <button type="button" id="novel_sync_all_btn" class="novel-btn btn-sync" title="将当前聊天所有历史章节完整编排并同步写入服务端文件">
                            <i class="fa-solid fa-file-import"></i> 同步历史连载
                        </button>
                    </div>
                    <button type="button" id="novel_test_btn" class="novel-btn btn-test novel-btn-minor novel-btn-inline" title="测试服务端插件连通性与标签清洗效果">
                        <i class="fa-solid fa-feather-pointed"></i> 试写一章
                    </button>
                </div>

                <!-- 【图片电子书 EPUB】：默认关闭，开箱不影响 TXT 导出 -->
                <div class="novel-acc" data-nv-acc="ebook">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-book-open"></i> 图片电子书（EPUB）</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_ebook"></span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <label class="checkbox_label" title="开启后导出 EPUB 时会读取每轮回复携带的插画（extra.bbiImage）并按正文原位嵌入；需要服务端插件，且不影响 TXT 连载">
                            <input type="checkbox" id="novel_ebook_embed_images" ${settings.ebook_embed_images ? 'checked' : ''} />
                            <span>导出时嵌入图片</span>
                        </label>
                        <small id="novel_ebook_embed_hint">${settings.ebook_embed_images ? EBOOK_EMBED_HINT_ON : EBOOK_EMBED_HINT_OFF}</small>
                        <div class="novel-btn-row">
                            <button type="button" id="novel_ebook_preview_btn" class="novel-btn novel-btn-block" title="只读扫描：列出识别到的图片、原位校验结果与将跳过的项">
                                <i class="fa-solid fa-images"></i> 图片清单预览
                            </button>
                            <button type="button" id="novel_ebook_export_btn" class="novel-btn btn-export" title="服务端打包 EPUB 电子书并写入服务器保存目录（不下载到本机）">
                                <i class="fa-solid fa-book"></i> 导出到服务器
                            </button>
                            <button type="button" id="novel_ebook_download_btn" class="novel-btn btn-download" title="在浏览器中直接下载 EPUB 到本机：不写入服务器、不需要保存目录">
                                <i class="fa-solid fa-download"></i> 下载到本机
                            </button>
                        </div>
                        <label class="novel-row">
                            <input type="number" id="novel_ebook_max_image_mb" class="text_pole" min="1" max="50" step="1" value="${Number(settings.ebook_max_image_mb) || 5}" />
                            <span>单图上限 (MB)</span>
                        </label>
                        <label class="novel-row">
                            <input type="number" id="novel_ebook_max_total_mb" class="text_pole" min="1" max="500" step="1" value="${Number(settings.ebook_max_total_mb) || 80}" />
                            <span>图片总量上限 (MB)</span>
                        </label>
                        <label class="novel-row">
                            <input type="text" id="novel_ebook_st_root" class="text_pole" value="${escapeHtml(settings.ebook_st_root || '')}" placeholder="留空自动推导；容器/NAS 部署时可填，如 /home/node/app" />
                            <span>酒馆根目录（可选）</span>
                        </label>
                        <small>图片实际路径为 <code>&lt;酒馆根&gt;/data/&lt;账号&gt;/user/images/…</code>。留空时按 ①当前账号 ②default-user ③其它账号 顺序自动查找，找不到的图会在结果里列为 missing（不会静默丢弃）。</small>
                    </div>
                </div>
                </div><!-- /.novel-tabpane file -->

                <div class="novel-tabpane" id="novel_pane_general" data-nv-pane="general" role="tabpanel" aria-labelledby="novel_tab_general">
                <div class="novel-section-title"><i class="fa-solid fa-gear"></i> 通用</div>
                <div class="novel-acc" data-nv-acc="display">
                    <button type="button" class="novel-acc-head" aria-expanded="false">
                        <span class="novel-acc-title"><i class="fa-solid fa-desktop"></i> 界面显示</span>
                        <span class="novel-acc-summary" id="novel_acc_summary_display"></span>
                        <i class="fa-solid fa-chevron-down novel-acc-chev"></i>
                    </button>
                    <div class="novel-acc-body">
                        <label class="checkbox_label" title="显示右下角悬浮入口：常显连载进度，点击打开本设置弹窗；按住可拖动到任意位置（位置会被记住）">
                            <input type="checkbox" id="novel_show_floating_window" ${settings.show_floating_window ? 'checked' : ''} />
                            <span>右下角悬浮入口</span>
                        </label>
                        <label class="checkbox_label" title="在最新一条 AI 回复底部显示内嵌快捷操作条（连载进度、查看过滤效果、一键导出）">
                            <input type="checkbox" id="novel_show_embedded_toolbar" ${settings.show_embedded_toolbar !== false ? 'checked' : ''} />
                            <span>回复底部内嵌工具条</span>
                        </label>
                        <label class="checkbox_label" title="每当新章节连载更新完成时，在屏幕右上角弹出轻量提示通知">
                            <input type="checkbox" id="novel_show_toast" ${settings.show_toast !== false ? 'checked' : ''} />
                            <span>更新时弹窗提示</span>
                        </label>
                    </div>
                </div>
                </div><!-- /.novel-tabpane general -->

                </div><!-- /.novel-tabpanes -->

    `;

    container.appendChild(panel);
    // 标签页切换：只切 display，面板全部挂载（见 bindNovelTabs 注释里的红线说明）
    bindNovelTabs(panel);
    // 折叠分组接线（替代卡片式分区）
    bindNovelAccordions(panel);
    // 开合：默认全部收起，之后按 settings.acc_open 恢复（与打开弹窗时同一套逻辑）
    applyNovelAccOpen(panel);
    // 面板为全新 DOM：重置 chips 渲染签名，确保尾部 renderTagTools() 一定完成首次绘制
    lastChipsRenderSig = '';

    // 绑定置顶作品卡片【复制路径】按钮与书名大触控区
    const copyPathBtn = panel.querySelector('#novel_copy_filepath_btn');
    const drawerFilenameEl = panel.querySelector('#novel_drawer_filename');

    const handleCopyPath = async (e) => {
        if (e) e.stopPropagation();
        const curSettings = getSettings();
        const curTitle = getBookTitle(curSettings);
        const curFileName = `${sanitizeFilename(curTitle)}.txt`;
        const curPrefix = curSettings.save_dir ? (curSettings.save_dir.replace(/[\\/]+$/, '') + '/') : 'SillyTavern/plugins/auto-save/logs/';
        const fullPath = `${curPrefix}${curFileName}`;
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(fullPath);
            } else {
                const ta = document.createElement('textarea');
                ta.value = fullPath;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            if (copyPathBtn) {
                const originalHtml = copyPathBtn.innerHTML;
                copyPathBtn.innerHTML = `<i class="fa-solid fa-check"></i> 已复制`;
                copyPathBtn.classList.add('copied');
                setTimeout(() => {
                    copyPathBtn.innerHTML = originalHtml;
                    copyPathBtn.classList.remove('copied');
                }, 2000);
            }
            if (drawerFilenameEl) {
                drawerFilenameEl.classList.add('copy-success-flash');
                setTimeout(() => {
                    drawerFilenameEl.classList.remove('copy-success-flash');
                }, 1200);
            }
            if (window.toastr) {
                // D3：toastr 支持 HTML，文件名派生自书名/聊天名，插入前必须转义
                window.toastr.info(`连载文件路径已复制：<br><code>${escapeHtml(fullPath)}</code>`, '小说连载', { timeOut: 3500 });
            }
        } catch (err) {
            if (window.toastr) {
                window.toastr.info(`当前连载文件：${escapeHtml(fullPath)}`, '小说连载');
            }
        }
    };

    if (copyPathBtn) copyPathBtn.addEventListener('click', handleCopyPath);
    if (drawerFilenameEl) drawerFilenameEl.addEventListener('click', handleCopyPath);

    // 同步更新顶栏状态指示
    if (recentStatus.state !== 'idle') {
        const headerStatus = document.getElementById('novel_header_status');
        if (headerStatus) {
            if (recentStatus.state === 'updating') {
                headerStatus.innerHTML = '<span class="novel-header-state is-updating"><i class="fa-solid fa-spinner fa-spin"></i> 连载中...</span>';
            } else if (recentStatus.state === 'success') {
                headerStatus.innerHTML = `<span class="novel-header-state is-success"><i class="fa-solid fa-circle-check"></i> 已连载${recentStatus.chapter > 0 ? ' ' + recentStatus.chapter + ' 章 ·' : ''} ${recentStatus.time}</span>`;
            } else if (recentStatus.state === 'skipped') {
                headerStatus.innerHTML = '<span class="novel-header-state is-skipped"><i class="fa-solid fa-circle-info"></i> 已跳过</span>';
            } else if (recentStatus.state === 'error') {
                headerStatus.innerHTML = '<span class="novel-header-state is-error"><i class="fa-solid fa-circle-exclamation"></i> 连载失败</span>';
            }
        }
    }

    // 绑定设置事件
    const bindCheck = (id, key) => {
        const el = panel.querySelector(`#${id}`);
        if (el) {
            el.addEventListener('change', (e) => {
                settings[key] = e.target.checked;
                if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            });
        }
    };

    // 主开关绑定：附带未安装服务端的防误触检测（主体走共享 setNovelEnabled，快捷栏复用）
    const enableEl = panel.querySelector('#novel_save_enabled');
    if (enableEl) {
        enableEl.addEventListener('change', async (e) => {
            enableEl.disabled = true;
            try {
                await setNovelEnabled(e.target.checked);
            } finally {
                enableEl.disabled = false;
            }
        });
    }

    bindCheck('novel_show_toast', 'show_toast');

    const toolbarEl = panel.querySelector('#novel_show_embedded_toolbar');
    if (toolbarEl) {
        toolbarEl.addEventListener('change', (e) => {
            settings.show_embedded_toolbar = e.target.checked;
            refreshNovelToolbars();
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }

    const floatWinEl = panel.querySelector('#novel_show_floating_window');
    if (floatWinEl) {
        floatWinEl.addEventListener('change', (e) => {
            settings.show_floating_window = e.target.checked;
            refreshFloatingWindow();
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            if (e.target.checked && window.toastr) {
                window.toastr.success('悬浮入口已开启：位于屏幕右下角，点击即打开设置弹窗，按住可拖动到任意位置', '小说连载', { timeOut: 4000 });
            }
        });
    }

    bindCheck('novel_include_user', 'include_user_dialogue');
    bindCheck('novel_indent_paragraphs', 'indent_paragraphs');
    bindCheck('novel_buffer_latest', 'buffer_latest_message');

    const selectStyle = panel.querySelector('#novel_chapter_style');
    if (selectStyle) {
        selectStyle.addEventListener('change', (e) => {
            settings.chapter_style = e.target.value;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }

    const selectNaming = panel.querySelector('#novel_naming_rule');
    if (selectNaming) {
        selectNaming.addEventListener('change', (e) => {
            settings.naming_rule = e.target.value;
            updatePreview();
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }

    const inputInclude = panel.querySelector('#novel_include_tags');
    if (inputInclude) {
        inputInclude.addEventListener('input', (e) => {
            settings.include_tags = e.target.value.trim();
            debouncedSaveSettings();
            debouncedRenderTagTools(400);
        });
    }

    const inputExclude = panel.querySelector('#novel_exclude_tags');
    if (inputExclude) {
        inputExclude.addEventListener('input', (e) => {
            settings.exclude_tags = e.target.value.trim();
            debouncedSaveSettings();
            debouncedRenderTagTools(400);
        });
    }

    const inputSaveDir = panel.querySelector('#novel_save_dir');
    const previewEl = panel.querySelector('#novel_save_dir_preview');
    const updatePreview = () => {
        updateDrawerHeaderFileBadge(settings);
    };

    if (inputSaveDir) {
        inputSaveDir.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            settings.save_dir = val;
            updatePreview();
            debouncedSaveSettings();
        });
    }

    // 一键将全部历史同步写入服务端连载文件
    const syncAllBtn = panel.querySelector('#novel_sync_all_btn');
    if (syncAllBtn) {
        syncAllBtn.addEventListener('click', () => {
            executeSyncAll(false);
        });
    }

    // 「重新扫描」按钮：手动触发会话标签检测与过滤预览刷新，带扫描中与完成反馈
    const rescanBtn = panel.querySelector('#novel_rescan_tags_btn');
    if (rescanBtn) {
        rescanBtn.addEventListener('click', () => {
            const originalHtml = rescanBtn.innerHTML;
            rescanBtn.disabled = true;
            rescanBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 扫描中...';
            setTimeout(() => {
                const result = renderTagTools();
                rescanBtn.disabled = false;
                rescanBtn.innerHTML = originalHtml;
                refreshNovelAccSummaries(panel);
                // 主动操作的直接反馈：不受"连载更新提示"开关控制
                if (window.toastr) {
                    const total = (result && result.total) ? result.total : 0;
                    window.toastr.info(
                        total > 0 ? `扫描完成：共检测到 ${total} 个自定义标签` : '扫描完成：未检测到自定义标签',
                        '会话标签检测',
                        { timeOut: 2500 }
                    );
                }
            }, 80);
        });
    }

    // 「查看过滤效果预览」按钮（弹窗本体由 ensurePreviewModal 独立挂 body，点遮罩/Esc 关闭）
    const previewBtn = panel.querySelector('#novel_preview_btn');
    if (previewBtn) {
        previewBtn.addEventListener('click', () => {
            openFilterPreviewModal();
        });
    }

    // 纯前端一键导出整本小说：与最新 AI 楼层内嵌工具条共用 exportNovelText()
    const exportBtn = panel.querySelector('#novel_export_all_btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => exportNovelText());
    }

    // ===== 图片电子书（EPUB）设置项 =====
    const ebookEmbedEl = panel.querySelector('#novel_ebook_embed_images');
    if (ebookEmbedEl) {
        ebookEmbedEl.addEventListener('change', () => {
            settings.ebook_embed_images = !!ebookEmbedEl.checked;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            // 即时反馈：说明文案随开关切换 + toastr 明确本次改动的效果（toastr 可能不存在，必须判空）
            refreshEbookEmbedHint(panel);
            refreshNovelAccSummaries(panel);
            if (window.toastr) {
                window.toastr.info(
                    settings.ebook_embed_images
                        ? '已开启图片嵌入：导出 EPUB 时会读取 bbi 插画并按正文原位嵌入（需要服务端插件）。'
                        : '已关闭图片嵌入：导出的 EPUB 为纯文字（TXT 连载不受影响）。',
                    '小说连载',
                    { timeOut: 3500 }
                );
            }
        });
    }
    const ebookMaxImgEl = panel.querySelector('#novel_ebook_max_image_mb');
    if (ebookMaxImgEl) {
        ebookMaxImgEl.addEventListener('change', () => {
            const v = Math.max(1, Math.min(50, Number(ebookMaxImgEl.value) || 5));
            settings.ebook_max_image_mb = v;
            ebookMaxImgEl.value = String(v);
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }
    const ebookMaxTotalEl = panel.querySelector('#novel_ebook_max_total_mb');
    if (ebookMaxTotalEl) {
        ebookMaxTotalEl.addEventListener('change', () => {
            const v = Math.max(1, Math.min(500, Number(ebookMaxTotalEl.value) || 80));
            settings.ebook_max_total_mb = v;
            ebookMaxTotalEl.value = String(v);
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }
    const ebookRootEl = panel.querySelector('#novel_ebook_st_root');
    if (ebookRootEl) {
        ebookRootEl.addEventListener('change', () => {
            settings.ebook_st_root = String(ebookRootEl.value || '').trim();
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            refreshNovelAccSummaries(panel);
        });
    }
    const ebookPreviewBtn = panel.querySelector('#novel_ebook_preview_btn');
    if (ebookPreviewBtn) {
        ebookPreviewBtn.addEventListener('click', () => openEbookPreviewModal());
    }
    // 两个导出入口：写服务器（原有）/ 浏览器本机下载（v1.18 新增，需服务端 1.15.0+ 的 ebookDownload 能力）
    const ebookExportBtn = panel.querySelector('#novel_ebook_export_btn');
    if (ebookExportBtn) {
        ebookExportBtn.addEventListener('click', () => exportEbook(ebookExportBtn, 'server'));
        // 能力门控：老服务端没有 /ebook，导出前就禁用并给出原因（避免点了才报错）
        if (serverCapabilities.ebook !== true) {
            ebookExportBtn.disabled = true;
            ebookExportBtn.title = '需要更新服务端插件（缺少 /ebook 接口）：重新部署 plugins/auto-save 并重启酒馆';
        }
    }
    const ebookDownloadBtn = panel.querySelector('#novel_ebook_download_btn');
    if (ebookDownloadBtn) {
        ebookDownloadBtn.addEventListener('click', () => exportEbook(ebookDownloadBtn, 'download'));
        // 能力门控：缺 /ebook 或缺少 download 交付能力都禁用，并统一提示"需要更新服务端插件"
        if (serverCapabilities.ebook !== true) {
            ebookDownloadBtn.disabled = true;
            ebookDownloadBtn.title = '需要更新服务端插件（缺少 /ebook 接口）：重新部署 plugins/auto-save 并重启酒馆';
        } else if (serverCapabilities.ebookDownload !== true) {
            ebookDownloadBtn.disabled = true;
            ebookDownloadBtn.title = '需要更新服务端插件（不支持直接下载）：重新部署 plugins/auto-save 并重启酒馆';
        }
    }

    // 绑定测试按钮
    const testBtn = panel.querySelector('#novel_test_btn');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            testBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在生成小说章节...';
            updateRecentStatus('updating', '正在向服务端写入测试连载章节...');

            const rawSample = `
<status>HP: 100/100, 外部状态忽略</status>
<story>
<ooc>内部小提示：此段被黑名单排除</ooc>
夜幕低垂，微风拂过静谧的街角。
书页翻动的沙沙声在耳边回荡，这是一部由你与 AI 共同谱写的故事。
如果您在 txt 小说文件中看到这一段文字，说明白名单提取与黑名单剔除已完美协同工作！
</story>
<meta>tokens: 88</meta>`;

            const cleanSample = cleanNovelText(rawSample, settings);

            const testPayload = {
                name: '故事序幕',
                mes: cleanSample,
                is_user: false,
                characterName: '我的小说试读本',
                chapterNumber: 1,
                chapterStyle: settings.chapter_style || 'numbered_floor',
                save_dir: settings.save_dir || '',
                floor: 1
            };

            try {
                const res = await postChapterToServer(testPayload);
                if (res && res.success) {
                    const targetText = res.file || (settings.save_dir ? settings.save_dir : 'plugins/auto-save/logs/');
                    updateRecentStatus('success', '试读章节已连载成功！', targetText);
                    if (settings.show_toast !== false && window.toastr) {
                        window.toastr.success(`试读章节已连载！文件：${targetText}`, '小说连载');
                    } else if (!window.toastr) {
                        alert(`试读章节已连载！文件：${targetText}`);
                    }
                } else {
                    updateRecentStatus('error', '试读章节写入失败，请检查服务端插件');
                    if (settings.show_toast !== false && window.toastr) {
                        window.toastr.error('试写失败，请确认服务端插件已启动。', '小说连载');
                    }
                }
            } catch (err) {
                updateRecentStatus('error', `试写异常: ${err.message}`);
                if (settings.show_toast !== false && window.toastr) {
                    window.toastr.error(`试写异常: ${err.message}`, '小说连载');
                }
            } finally {
                testBtn.disabled = false;
                testBtn.innerHTML = '<i class="fa-solid fa-feather-pointed"></i> 试写一章';
            }
        });
    }

    const badge = panel.querySelector('#novel_save_status_badge');
    const guideEl = panel.querySelector('#novel_deploy_guide');

    if (status.ready) {
        badge.className = 'novel-alert success';
        badge.innerHTML = `
            <i class="fa-solid fa-circle-check"></i>
            <div class="novel-alert-text"><b>连载服务已就绪：</b>已自动开启小说连载，每次 AI 回复将像小说一样顺畅续写。</div>
        `;
        if (guideEl) guideEl.style.display = 'none';

        // 服务端就绪：若当前未开启且非用户刻意主动关闭，全自动勾选并激活连载主开关！
        if (!settings.enabled && !settings.userDisabled) {
            settings.enabled = true;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            const enableCb = panel.querySelector('#novel_save_enabled');
            if (enableCb) enableCb.checked = true;
            updateRecentStatus('ready', '连载服务已就绪，已全自动开启小说连载');
        }
    } else {
        // 未安装服务端插件时：强制取消勾选并保存，彻底杜绝后续网络 404 报错
        if (settings.enabled) {
            settings.enabled = false;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            const enableCb = panel.querySelector('#novel_save_enabled');
            if (enableCb) enableCb.checked = false;
        }

        badge.className = 'novel-alert warning';
        badge.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation"></i>
            <div class="novel-alert-text">
                <b>未检测到服务端插件：</b>已自动取消勾选自动连载（防止产生网络 404 错误）。<br>
                您可参考下方<b>方案一（一键命令自动部署）</b>或<b>方案二（手动复制保底）</b>进行部署，亦可直接使用<b>【导出整本 TXT】</b>零配置打包下载。
            </div>
        `;

        if (guideEl) {
            guideEl.style.display = 'flex';
            // 一键部署命令：极简一行命令，国内 CDN 高速直连，所有复杂感知与挂载穿透完全封装在 install 脚本中
            const cmdOnlineLinux = `curl -fsSL https://cdn.jsdelivr.net/gh/zgy-beep/novel-stream@main/install.sh | bash`;
            const cmdOnlineWindows = `irm https://cdn.jsdelivr.net/gh/zgy-beep/novel-stream@main/install.ps1 | iex`;
            const cmdDirectScript = `bash install.sh`;
            const cmdManualDocker = `docker exec sillytavern cp -r /home/node/app/data/default-user/extensions/novel-stream/plugins/auto-save /home/node/app/plugins/`;

            // 结构上刻意保持扁平：三块「方案」+ 若干「一行」。行内的左右排布一律交给
            // .novel-guide-row / .novel-info-row，不再往模板里塞内联 flex 样式。
            guideEl.innerHTML = `
                <div class="novel-plan-c-card">
                    <div class="novel-guide-row">
                        <span class="novel-guide-title"><i class="fa-solid fa-circle-check"></i> 即开即用：零配置直接导出（推荐）</span>
                    </div>
                    <p class="novel-guide-text">无需配置服务器或 Docker 挂载！在【文件】标签点一次<b>【导出整本 TXT】</b>，浏览器即可排版、生成带楼层与目录的完整小说并一键下载，零门槛、零网络报错。</p>
                </div>

                <div class="novel-deploy-card">
                    <div class="novel-guide-row">
                        <span class="novel-guide-title"><i class="fa-solid fa-wand-magic-sparkles"></i> 方案一：一键命令自动部署</span>
                        <small class="novel-guide-tag">极简一行直达</small>
                    </div>
                    <div class="novel-tab-bar">
                        <button type="button" class="novel-tab-btn active" data-tab="universal"><i class="fa-brands fa-linux"></i> Linux / Docker / NAS (推荐)</button>
                        <button type="button" class="novel-tab-btn" data-tab="windows"><i class="fa-brands fa-windows"></i> Windows 本机</button>
                        <button type="button" class="novel-tab-btn" data-tab="script"><i class="fa-solid fa-terminal"></i> 离线/本地运行</button>
                    </div>
                    <div class="novel-code-wrapper">
                        <div class="novel-guide-row">
                            <small class="novel-guide-hint" id="novel_tab_hint">在服务器终端（SSH 或控制台）直接粘贴执行（国内 CDN 高速直连，自动穿透 Docker）：</small>
                            <button type="button" class="novel-copy-btn" id="novel_copy_cmd_btn"><i class="fa-solid fa-copy"></i> 复制命令</button>
                        </div>
                        <code class="novel-code-text" id="novel_cmd_display">${cmdOnlineLinux}</code>
                    </div>
                    <small class="novel-guide-text">
                        <b>第 1 步：</b>粘贴执行上述命令（自动感知 Docker 容器、定位挂载卷并完成部署）；<br>
                        <b>第 2 步：</b>确认酒馆 <code>config.yaml</code> 中 <code>enableServerPlugins: true</code> 并重启酒馆。
                    </small>
                </div>

                <div class="novel-manual-card">
                    <div class="novel-guide-row">
                        <span class="novel-guide-title"><i class="fa-solid fa-triangle-exclamation"></i> 方案二：脚本失败时手动复制（100% 保底）</span>
                        <small class="novel-guide-tag">终极保底</small>
                    </div>
                    <small class="novel-guide-text">环境特殊或脚本无法自动感知目录时，手动复制一个文件夹即可完全搞定：</small>
                    <div class="novel-info-row">
                        <span class="novel-info-key">复制源</span>
                        <span class="novel-info-val is-wrap"><code>SillyTavern/data/default-user/extensions/novel-stream/plugins/auto-save</code></span>
                    </div>
                    <div class="novel-info-row">
                        <span class="novel-info-key">粘贴至</span>
                        <span class="novel-info-val is-wrap"><code>SillyTavern/plugins/auto-save</code></span>
                    </div>
                    <div class="novel-guide-row">
                        <small class="novel-guide-text"><b>Docker 容器内直连手动复制命令：</b></small>
                        <button type="button" class="novel-copy-btn" id="novel_copy_docker_manual_btn">
                            <i class="fa-solid fa-copy"></i> 复制 Docker 手动命令
                        </button>
                    </div>
                    <small class="novel-guide-text novel-guide-foot"><b>提示：</b>复制完成后，请确认酒馆 <code>config.yaml</code> 中开启 <code>enableServerPlugins: true</code>，重启酒馆（Docker 执行 <code>docker restart &lt;容器名&gt;</code>），刷新网页即可正常使用。</small>
                </div>
            `;

            // 绑定 Tab 切换与复制事件
            const tabBtns = guideEl.querySelectorAll('.novel-tab-btn');
            const cmdDisplay = guideEl.querySelector('#novel_cmd_display');
            const tabHint = guideEl.querySelector('#novel_tab_hint');
            const copyBtn = guideEl.querySelector('#novel_copy_cmd_btn');
            const copyDockerManualBtn = guideEl.querySelector('#novel_copy_docker_manual_btn');

            let currentCmd = cmdOnlineLinux;

            tabBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    tabBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const tab = btn.getAttribute('data-tab');
                    if (tab === 'windows') {
                        currentCmd = cmdOnlineWindows;
                        if (tabHint) tabHint.textContent = '在 Windows PowerShell 中直接粘贴执行（国内高速加速）：';
                    } else if (tab === 'script') {
                        currentCmd = cmdDirectScript;
                        if (tabHint) tabHint.textContent = '在酒馆根目录或扩展目录中直接执行官方脚本（0 网络依赖）：';
                    } else {
                        currentCmd = cmdOnlineLinux;
                        if (tabHint) tabHint.textContent = '在服务器终端（SSH 或控制台）直接粘贴执行（国内 CDN 高速直连，自动穿透 Docker）：';
                    }
                    if (cmdDisplay) cmdDisplay.textContent = currentCmd;
                });
            });

            if (copyBtn) {
                copyBtn.addEventListener('click', async () => {
                    try {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            await navigator.clipboard.writeText(currentCmd);
                        } else {
                            const ta = document.createElement('textarea');
                            ta.value = currentCmd;
                            document.body.appendChild(ta);
                            ta.select();
                            document.execCommand('copy');
                            document.body.removeChild(ta);
                        }
                        copyBtn.classList.add('copied');
                        copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> 已复制命令！';
                        if (window.toastr) {
                            window.toastr.success('安装命令已复制到剪贴板！', '小说连载');
                        }
                        setTimeout(() => {
                            copyBtn.classList.remove('copied');
                            copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> 复制命令';
                        }, 2000);
                    } catch (e) {
                        alert('复制失败，请手动选中文本复制：\n' + currentCmd);
                    }
                });
            }

            if (copyDockerManualBtn) {
                copyDockerManualBtn.addEventListener('click', async () => {
                    try {
                        if (navigator.clipboard && navigator.clipboard.writeText) {
                            await navigator.clipboard.writeText(cmdManualDocker);
                        } else {
                            const ta = document.createElement('textarea');
                            ta.value = cmdManualDocker;
                            document.body.appendChild(ta);
                            ta.select();
                            document.execCommand('copy');
                            document.body.removeChild(ta);
                        }
                        copyDockerManualBtn.classList.add('copied');
                        copyDockerManualBtn.innerHTML = '<i class="fa-solid fa-check"></i> 已复制 Docker 命令！';
                        if (window.toastr) {
                            window.toastr.success('Docker 手动复制命令已复制到剪贴板！', '小说连载');
                        }
                        setTimeout(() => {
                            copyDockerManualBtn.classList.remove('copied');
                            copyDockerManualBtn.innerHTML = '<i class="fa-solid fa-copy"></i> 复制 Docker 手动命令';
                        }, 2500);
                    } catch (e) {
                        alert('复制失败，请手动选中文本复制：\n' + cmdManualDocker);
                    }
                });
            }
        }
    }

    // 面板渲染完成后立即扫描一次会话标签并刷新过滤效果预览
    renderTagTools();
    // 折叠行摘要在 DOM 就绪后再刷一次（此时 #novel_tag_scan_count 等已在位）
    refreshNovelAccSummaries(panel);
    // EPUB 开关的即时说明也与设置现态对齐（模板初次渲染之外再兜一次，避免迁移数据后不同步）
    refreshEbookEmbedHint(panel);
}

// ==================== 测试专用导出（浏览器环境完全无副作用）====================
// 浏览器里 typeof module === 'undefined'，整块被跳过；Node 下由 test/_helpers/load-index.js
// 注入 module 桩后取用，让测试锁的是本文件的真实实现，而不是手抄副本。
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // 清洗引擎
        cleanNovelText,
        buildNovelText,
        getCleanedMessage,
        getCleanMessageSig,
        cleanTextCache,
        // 标签检测器
        scanChatTags,
        parseTagList,
        isAuxiliaryTag,
        extractTagSample,
        // 楼层 → 章节映射
        computeChapterMap,
        // 排版/命名
        escapeHtml,
        compareVersion,
        sanitizeFilename,
        getBookTitle,
        getBookFileName,
        getChatAnchor,
        getAccountPrefix,
        shortBookTitle,
        // 设置与状态
        DEFAULT_SETTINGS,
        getSettings,
        // 连载写入链路（回归用：问候语入书 / 409 冲突分支 / 签名登记）
        postChapterToServer,
        seedLastSavedSignature,
        saveSpecificMessage,
        ensureGreetingSerialized,
        handleMessageSave,
        updateRecentStatus,
        // 图片电子书（EPUB）：清单扫描 / 结构化正文 / 原位图片
        extractBbiImageList,
        matchBbiImageMarkers,
        buildImageSlots,
        splitParagraphBlocks,
        getCleanedMessageWithImageSlots,
        buildStructuredNovel,
        buildEbookPayload,
        // v1.19.0：导出前体积预估（测试/verifier 直接调用真实实现）
        formatBytesMb,
        estimateEbookPayload,
        scanBookImages,
        shortPromptAlt,
        __testState: {
            getLastSavedSignature: () => lastSavedSignature,
            setLastSavedSignature: (v) => { lastSavedSignature = v; },
            getLastSettledSavedIndex: () => lastSettledSavedIndex,
            setLastSettledSavedIndex: (v) => { lastSettledSavedIndex = v; },
            // F6：文件视角的末尾章号（替换定位键）
            getLastWrittenChapterNumber: () => lastWrittenChapterNumber,
            setLastWrittenChapterNumber: (v) => { lastWrittenChapterNumber = v; },
            getRecentStatus: () => recentStatus,
            setRecentStatus: (v) => { recentStatus = v; },
            getSavedChapterMap: () => savedChapterMap,
            getServerPluginVersion: () => serverPluginVersion,
            setServerPluginVersion: (v) => { serverPluginVersion = v; },
            // v1.19.0：能力声明读写（测试/verifier 用来模拟服务端是否支持 ebookEstimate 等能力）
            getServerCapabilities: () => serverCapabilities,
            setServerCapabilities: (v) => { serverCapabilities = (v && typeof v === 'object') ? v : {}; },
        },
        __internals: {
            INLINE_TAGS,
            SCAN_IGNORE_TAGS,
            AUX_TAG_NAME_PATTERN,
            EXTENSION_NAME,
        },
    };
}

jQuery(async () => {
    console.log('[AutoSaveTxt] 小说连载阅读扩展正在初始化...');

    const bootSettings = getSettings();
    let bootStatus = { ready: false };
    try {
        bootStatus = await checkServerPluginStatus();
    } catch (e) {
        console.warn('[AutoSaveTxt] 启动探针检测异常:', e);
    }

    if (bootStatus.ready) {
        serverPluginVersion = bootStatus.version || null;
    }

    // 如果服务端未就绪，强制将 enabled 置为 false，防止产生 404 网络请求
    if (!bootStatus.ready && bootSettings.enabled) {
        bootSettings.enabled = false;
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        updateRecentStatus('idle', '未检测到服务端插件，已自动取消勾选实时连载（可直接导出整本小说）');
    } else if (bootStatus.ready && !bootSettings.enabled && !bootSettings.userDisabled) {
        // 服务端就绪且未被用户主动刻意关闭：全自动开启小说连载！
        bootSettings.enabled = true;
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        updateRecentStatus('ready', '服务端连载服务已就绪，已全自动开启连载功能');
    }

    // 立即执行并配合短延迟补救，确保设置面板 100% 渲染进 body 级设置弹窗
    renderSettingsUI(bootStatus);
    setTimeout(() => {
        // 面板已存在则跳过重复渲染，避免清空用户正在输入的内容与部署指引状态
        if (!document.getElementById('auto-save-to-txt-settings')) {
            renderSettingsUI(bootStatus);
        }
    }, 500);

    // D2：boot 播种时跳过角色问候语，否则问候语被误登记为已保存 → 永不入书
    seedLastSavedSignature({ skipGreeting: true });

    // 魔法棒菜单项 + 悬浮窗：立即就位，并用短轮询兜底酒馆慢渲染 / 菜单后置重绘
    refreshNovelToolbars();
    // 视口变化（含手机端 URL 栏 / 软键盘 / 横竖屏 / 文档级滚动）统一重排浮层，只绑一次
    bindOverlayResync();
    let uiRetries = 0;
    const uiRetryTimer = setInterval(() => {
        uiRetries++;
        const wandReady = injectWandEntry();
        refreshNovelToolbars();
        if ((wandReady && uiRetries > 3) || uiRetries > 20) {
            clearInterval(uiRetryTimer);
        }
    }, 500);

    // 酒馆助手 (JS-Slash-Runner) 软依赖桥接：APP_READY 后探测 + 1s 轮询最多 15 次兜底
    initTavernHelperBridge();

    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (data, genType) => {
            // 角色问候语（新开聊天 / 重新生成问候语 / 加载仅含问候的聊天）不触发连载：
            // 等用户真正发出第一条消息、AI 首次回复时才正式开书写第 1 章
            if (genType === 'first_message') {
                updateDrawerHeaderFileBadge();
                return;
            }
            handleMessageSave(data, false);
            updateDrawerHeaderFileBadge();
            debouncedRenderTagTools();
        });

        eventSource.on(event_types.MESSAGE_SENT, (data) => {
            handleMessageSave(data, true);
            updateDrawerHeaderFileBadge();
            debouncedRenderTagTools();
        });

        if (event_types.MESSAGE_SWIPED) {
            eventSource.on(event_types.MESSAGE_SWIPED, (data) => {
                const settings = getSettings();
                if (settings.buffer_latest_message) {
                    updateRecentStatus('idle', '草稿缓冲中（所选分支将在你发送下一条消息后定稿入书）');
                    refreshMessageBadges();
                    refreshNovelToolbars();
                    return;
                }
                // 角色问候语的滑动/重新生成同样不入书：连载只从真实对话开始
                const swipeChat = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
                if (data === 0 && swipeChat[0] && !swipeChat[0].is_user) {
                    updateDrawerHeaderFileBadge();
                    return;
                }
                handleMessageSave(data, false);
                updateDrawerHeaderFileBadge();
                debouncedRenderTagTools();
                // ST 滑动楼层会重建 mes_text 导致内嵌元素丢失：幂等重绘补救
                refreshMessageBadges();
                refreshNovelToolbars();
            });
        }

        if (event_types.MESSAGE_DELETED) {
            eventSource.on(event_types.MESSAGE_DELETED, () => {
                debouncedSilentSyncAll();
                updateDrawerHeaderFileBadge();
            });
        }

        // 消息被编辑时酒馆会原地改写 mes：重扫标签并刷新过滤预览（老版本酒馆无此事件则自动跳过，缓存指纹仍保证正确性）
        if (event_types.MESSAGE_EDITED) {
            eventSource.on(event_types.MESSAGE_EDITED, () => {
                debouncedRenderTagTools();
                updateDrawerHeaderFileBadge();
                // ST 编辑楼层会重建 mes_text 导致内嵌元素丢失：幂等重绘补救
                refreshMessageBadges();
                refreshNovelToolbars();
            });
        }

        const refreshContext = () => {
            cleanTextCache.map.clear();
            // D2：切聊天同样跳过问候语播种，避免"刚开的新聊天"里问候语又被当成已入书
            seedLastSavedSignature({ skipGreeting: true });
            renderTagTools();
            updateDrawerHeaderFileBadge();
            // ①④ 切聊天/角色/群后重算楼层入书映射并重绘徽标与最新楼层工具条
            const ctxChat = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
            savedChapterMap = computeChapterMap(getSettings(), ctxChat);
            refreshMessageBadges();
            refreshNovelToolbars();
        };

        if (event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, () => {
                refreshContext();
                announceChatNovelStatus();
            });
        }
        if (event_types.CHARACTER_PAGE_LOADED) {
            eventSource.on(event_types.CHARACTER_PAGE_LOADED, refreshContext);
        }
        if (event_types.CHARACTER_EDITED) {
            eventSource.on(event_types.CHARACTER_EDITED, refreshContext);
        }
        if (event_types.GROUP_UPDATED) {
            eventSource.on(event_types.GROUP_UPDATED, refreshContext);
        }
    }
});
