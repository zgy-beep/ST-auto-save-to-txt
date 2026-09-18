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
    version: '1.12.0',            // 扩展版本号
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
    userDisabled: false,          // 用户是否主动手动关闭了连载
};

let lastSavedSignature = {
    messageId: null,
    characterName: '',
    mesSnippet: ''
};
let lastSettledSavedIndex = -1; // 记录最近已定稿落盘入书的最高楼层序号

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
        const fileHtml = recentStatus.file ? `<div class="novel-status-file">文件路径：<code>${recentStatus.file}</code></div>` : '';
        if (state === 'updating') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-spinner fa-spin"></i> <b>更新中：</b>${text}</span>`;
        } else if (state === 'success') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-circle-check"></i> <b>更新完成：</b>${text}</span>${fileHtml}`;
        } else if (state === 'skipped') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-circle-info"></i> <b>已跳过：</b>${text}</span>${fileHtml}`;
        } else if (state === 'error') {
            detailEl.innerHTML = `<span><i class="fa-solid fa-circle-exclamation"></i> <b>写入失败：</b>${text}</span>`;
        } else {
            detailEl.innerHTML = `<i class="fa-solid fa-circle-check" style="opacity: 0.7;"></i> ${text}`;
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
    if (!settings.enabled) return;
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
        <span class="novel-lt-info"><i class="fa-solid fa-book-open"></i> 已连载 ${totalChapters} 章</span>
        <button type="button" class="novel-lt-btn" data-lt="preview"><i class="fa-solid fa-eye"></i> 查看过滤效果</button>
        <button type="button" class="novel-lt-btn" data-lt="export"><i class="fa-solid fa-download"></i> 导出整本 TXT</button>
    `;
    bar.querySelector('[data-lt="preview"]').addEventListener('click', (e) => { e.stopPropagation(); openFilterPreviewModal(); });
    bar.querySelector('[data-lt="export"]').addEventListener('click', (e) => { e.stopPropagation(); exportNovelText(); });
    textEl.appendChild(bar);
}

function getSettings() {
    const extSettings = ctx.extension_settings || ext_settings_raw || window.extension_settings || {};
    if (!extSettings[EXTENSION_NAME]) {
        extSettings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    } else {
        // 版本平滑迁移：针对升级用户，如果版本低于 1.6.0，自动切换历史默认值至 'numbered_floor'
        const curVer = extSettings[EXTENSION_NAME].version;
        if (!curVer || curVer < '1.6.0') {
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
        .replace(/"/g, '&quot;');
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
    if (shouldIndent) {
        return paragraphs.map(p => `　　${p}`).join('\n\n');
    }

    return paragraphs.join('\n\n');
}

/**
 * 动态获取当前扩展相对于酒馆 Web 根目录的相对路径（彻底杜绝硬编码目录名）
 */
function getExtensionRelativePath() {
    try {
        const scriptUrl = new URL(import.meta.url);
        const pathName = scriptUrl.pathname;
        const dir = pathName.substring(0, pathName.lastIndexOf('/'));
        return dir.replace(/^\/+/, '');
    } catch (e) {
        return 'scripts/extensions/third-party/ST-auto-save-to-txt';
    }
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
            return { ready: true, version: data.version, is404: false };
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
            return { success: false, status: response.status, error: errMsg };
        }

        const data = await response.json().catch(() => ({}));
        if (!data.skipped) {
            console.log(`[AutoSaveTxt] 📖 新章节已融入小说: ${data.file || ''}`);
        }
        return {
            success: true,
            file: data.file,
            skipped: data.skipped,
            renamed_from: data.renamed_from,
            kept_name: data.kept_name,
            is_regenerate: (typeof data.is_regenerate !== 'undefined') ? data.is_regenerate : payload.is_regenerate
        };
    } catch (error) {
        console.warn('[AutoSaveTxt] 连接服务端插件异常:', error);
        return { success: false, error: error.message };
    }
}

function seedLastSavedSignature() {
    const settings = getSettings();
    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    if (!chatLog || chatLog.length === 0) {
        lastSavedSignature = { messageId: null, characterName: '', mesSnippet: '' };
        lastSettledSavedIndex = -1;
        return;
    }
    for (let i = chatLog.length - 1; i >= 0; i--) {
        const m = chatLog[i];
        if (!m) continue;
        if (m.is_user && !settings.include_user_dialogue) continue;
        const clean = getCleanedMessage(m, i, settings);
        if (clean) {
            const speaker = m.name || (m.is_user ? '你' : '旁白');
            lastSavedSignature = {
                messageId: i,
                characterName: getBookTitle(settings, speaker),
                mesSnippet: clean.slice(0, 80)
            };
            lastSettledSavedIndex = i;
            break;
        }
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
    const isNumberedFloor = (settings.chapter_style === 'numbered_floor' || !settings.chapter_style);
    const sectionLabel = isNumberedFloor ? `第 ${chapterNumber} 章` : ((settings.chapter_style === 'numbered') ? `第 ${chapterNumber} 节` : '新章节');
    const floorLabel = isNumberedFloor ? ` (原楼层: ${floor})` : '';

    // 1. 设置状态为更新中（顶栏指示灯与面板卡片即时响应）
    const actionText = isRegenerate ? '正在替换更新' : '正在编排写入';
    updateRecentStatus('updating', `${actionText}${sectionLabel} · ${speakerName}${floorLabel}...`);

    const payload = {
        name: speakerName,
        mes: novelText,
        is_user: !!message.is_user,
        characterName: bookTitle,
        chapterNumber: chapterNumber,
        chapterStyle: settings.chapter_style || 'numbered_floor',
        save_dir: settings.save_dir || '',
        is_regenerate: isRegenerate,
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
        recentStatus.chapter = chapterNumber;

        const targetFile = res.file || `${bookTitle}.txt`;

        // 聊天改名自动跟随：服务端 ID 锚定注册表检测到书名变化，已同步更名小说文件
        const renameSuffix = res.renamed_from ? '（检测到聊天改名，小说文件已同步更名）' : '';
        if (res.renamed_from && settings.show_toast !== false && window.toastr) {
            window.toastr.info(`小说文件已跟随聊天改名：${res.renamed_from} → ${targetFile}`, '小说连载', { timeOut: 5000 });
        }

        if (res.skipped) {
            updateRecentStatus('skipped', `${sectionLabel}末尾内容重复，已自动略过写入`, targetFile);
            if (settings.show_toast !== false && window.toastr) {
                window.toastr.info(`${sectionLabel}内容与前文重复，已略过`, '小说连载', { timeOut: 2500 });
            }
        } else if (res.is_regenerate || isRegenerate) {
            updateRecentStatus('success', `${sectionLabel} · ${speakerName}${floorLabel}（重新生成已替换更新）${snippetSuffix}${renameSuffix}`, targetFile);
            if (settings.show_toast !== false && window.toastr) {
                throttledNovelSuccessToast(`${sectionLabel}${floorLabel}已更新为最新生成版本${snippetSuffix}`, '小说连载', {
                    timeOut: 3000,
                    preventDuplicates: true
                });
            }
        } else {
            // 2. 更新完成提示（顶栏指示灯与面板卡片）
            updateRecentStatus('success', `${sectionLabel} · ${speakerName}${floorLabel} 连载成功！${snippetSuffix}${renameSuffix}`, targetFile);

            // 3. 屏幕 Toast 提示通知
            if (settings.show_toast !== false && window.toastr) {
                throttledNovelSuccessToast(`${sectionLabel} · ${speakerName}${floorLabel} 已自动写入《${bookTitle}》${snippetSuffix}`, '小说连载', {
                    timeOut: 3500,
                    preventDuplicates: true
                });
            }
        }

        // ①④ 非跳过的成功写入：登记楼层章节号并重绘"已入书"徽标与最新楼层工具条
        if (!res.skipped) {
            savedChapterMap[messageIndex] = chapterNumber;
            refreshMessageBadges();
            refreshLatestToolbar();
        }
    } else {
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
            window.toastr.warning(`${sectionLabel}自动连载失败: ${errMsg}`, '小说连载', {
                timeOut: 4500
            });
        }
    }
}

// 已探测的服务端插件版本（问候语补写 is_greeting 需要服务端 ≥ 1.7.8 支持，旧服务端自动降级跳过）
let serverPluginVersion = null;

/**
 * 问候语延迟入书：新开聊天时问候语不产生任何文件（看卡/调试零打扰）；
 * 当用户发出第一条消息（会话恰好为 问候语+用户消息）时，把问候语作为第 1 章补写入书。
 * 服务端对已存在内容的文件自动跳过——旧书不会重复写入，新书不会遗漏。
 */
async function ensureGreetingSerialized(settings, chatLog) {
    if (!Array.isArray(chatLog) || chatLog.length !== 2) return;
    if (serverPluginVersion && serverPluginVersion < '1.7.8') return;
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

    if (res && res.success && !res.skipped) {
        lastSavedSignature = { messageId: 0, characterName: bookTitle, mesSnippet };
        lastSettledSavedIndex = Math.max(lastSettledSavedIndex, 0);
        recentStatus.chapter = Math.max(recentStatus.chapter, 1);
        updateRecentStatus('success', `第 1 章 · ${speakerName} (原楼层: 1)（问候语已入书，连载正式开始）`, res.file || `${bookTitle}.txt`);
        // ①④ 问候语入书：登记第 1 章并重绘徽标与工具条
        savedChapterMap[0] = 1;
        refreshMessageBadges();
        refreshLatestToolbar();
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
            seedLastSavedSignature();
            // ①④ 全书同步后重算楼层入书映射并重绘徽标与最新楼层工具条
            savedChapterMap = computeChapterMap(settings, chatLog);
            refreshMessageBadges();
            refreshLatestToolbar();
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
let lastFilterPreview = { rawLength: 0, cleaned: '', speaker: '', floor: 0, whitelistMissed: false, isDraft: false };

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
        lastFilterPreview = { rawLength: 0, cleaned: '', speaker: '', floor: 0, whitelistMissed: false, isDraft: false };
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
 * 打开过滤效果预览弹窗：完整展示过滤后正文 + 字数对比，支持点遮罩 / 右上角 / Esc 关闭
 */
function openFilterPreviewModal() {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('novel_preview_modal');
    if (!overlay) return;
    const body = document.getElementById('novel_modal_body');
    const stat = document.getElementById('novel_modal_stat');
    if (stat) {
        stat.textContent = lastFilterPreview.cleaned
            ? `${lastFilterPreview.speaker} · 原楼层 ${lastFilterPreview.floor}${lastFilterPreview.isDraft ? '（草稿未定稿）' : ''} ｜ 原始 ${lastFilterPreview.rawLength} 字符 → 入书 ${lastFilterPreview.cleaned.length} 字`
            : (lastFilterPreview.speaker ? `${lastFilterPreview.speaker} · 原楼层 ${lastFilterPreview.floor}${lastFilterPreview.isDraft ? '（草稿未定稿）' : ''}` : '');
    }
    if (body) {
        const warnHtml = lastFilterPreview.whitelistMissed
            ? '<div class="novel-tag-empty" style="color: #f39c12; margin-bottom: 6px;">⚠️ 白名单标签在当前消息中一个都没匹配到——引擎已<b>整篇保留</b>原文。请检查白名单拼写，或直接用上方检测器点选标签。</div>'
            : '';
        body.innerHTML = warnHtml + (lastFilterPreview.cleaned
            ? escapeHtml(lastFilterPreview.cleaned).replace(/\n/g, '<br>')
            : '<div class="novel-tag-empty" style="color: #f39c12;">过滤后无正文可入书——请检查白名单拼写，或确认正文是否被黑名单全部剔除。</div>');
    }
    // 健壮定位：部分环境（ancestor transform 等）fixed 会退化为 absolute 跑到文档顶部，
    // 改用绝对坐标显式锚定当前可视区（scrollY 补偿），任何滚动位置都贴在用户眼前
    overlay.style.position = 'absolute';
    overlay.style.top = `${window.scrollY}px`;
    overlay.style.left = '0';
    overlay.style.height = `${window.innerHeight}px`;
    overlay.style.display = 'flex';
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

let renderRetryTimer = null;

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
    return true;
}

async function renderSettingsUI(cachedStatus = null) {
    const settings = getSettings();
    let container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) {
        if (renderRetryTimer) clearInterval(renderRetryTimer);
        let retries = 0;
        renderRetryTimer = setInterval(() => {
            retries++;
            container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
            if (container) {
                clearInterval(renderRetryTimer);
                renderRetryTimer = null;
                renderSettingsUI(cachedStatus);
            } else if (retries > 15) {
                clearInterval(renderRetryTimer);
                renderRetryTimer = null;
                console.warn('[AutoSaveTxt] 未能定位到 extensions_settings 容器');
            }
        }, 300);
        return;
    }

    const status = cachedStatus || await checkServerPluginStatus();

    // 记录服务端插件版本（问候语补写等能力按版本门控）
    if (status.ready) {
        serverPluginVersion = status.version || serverPluginVersion;
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
    // 弹窗若已移出面板挂载在 body，旧面板移除时清理不掉，先手动清除防重复 ID
    const staleModal = document.getElementById('novel_preview_modal');
    if (staleModal) staleModal.remove();

    panel = document.createElement('div');
    panel.id = 'auto-save-to-txt-settings';
    panel.className = 'inline-drawer';

    // 默认折叠，顶栏极简整洁（与酒馆原生抽屉 1:1 一致）；展开后为四分区信息架构：开关置顶，依次为 当前连载 / 正文过滤 / 排版与行为 / 文件与导出
    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>小说连载阅读 <span style="font-weight: normal; opacity: 0.7;">v${DEFAULT_SETTINGS.version}</span></b>
            <div style="display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;">
                <span id="novel_header_status" style="font-size: 11px; opacity: 0.85;"></span>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
            <div class="novel-drawer-inner">
                <!-- 主开关置顶 -->
                <div class="novel-toggle-row">
                    <label class="checkbox_label" title="开启后，每轮 AI 回复将像小说章节一样自动写入 txt，随时用手机或阅读器翻阅">
                        <input type="checkbox" id="novel_save_enabled" ${settings.enabled ? 'checked' : ''} />
                        <span>开启小说自动连载</span>
                    </label>
                    <label class="checkbox_label" title="每当新章节连载更新完成时，在屏幕右上角弹出轻量提示通知">
                        <input type="checkbox" id="novel_show_toast" ${settings.show_toast !== false ? 'checked' : ''} />
                        <span>更新时弹窗提示</span>
                    </label>
                </div>

                <!-- ▍当前连载 -->
                <div class="novel-section">
                    <div class="novel-section-title"><i class="fa-solid fa-book-bookmark"></i> 当前连载</div>
                    <div class="novel-current-book-card">
                        <div class="novel-book-card-header">
                            <div class="novel-book-filename" id="novel_drawer_filename" title="点击复制完整文件路径">${initialFileName}</div>
                            <button type="button" id="novel_copy_filepath_btn" class="novel-copy-pill" title="复制完整文件保存路径">
                                <i class="fa-regular fa-copy"></i> 复制路径
                            </button>
                        </div>
                        <div class="novel-book-path-info"><code id="novel_drawer_filepath">${initialDir}${initialFileName}</code></div>
                        <div id="novel_recent_status" class="novel-status-line ${recentStatus.state === 'updating' ? 'is-updating' : (recentStatus.state === 'success' ? 'is-success' : (recentStatus.state === 'skipped' ? 'is-skipped' : (recentStatus.state === 'error' ? 'is-error' : 'is-idle')))}">
                            <span id="novel_recent_detail">
                                ${recentStatus.state === 'success'
                                    ? `<span><i class="fa-solid fa-circle-check"></i> <b>更新完成：</b>${recentStatus.text}</span>${recentStatus.file ? `<div class="novel-status-file">文件路径：<code>${recentStatus.file}</code></div>` : ''}`
                                    : (recentStatus.state === 'updating'
                                        ? `<span><i class="fa-solid fa-spinner fa-spin"></i> <b>更新中：</b>${recentStatus.text}</span>`
                                        : (recentStatus.state === 'skipped'
                                            ? `<span><i class="fa-solid fa-circle-info"></i> <b>已跳过：</b>${recentStatus.text}</span>${recentStatus.file ? `<div class="novel-status-file">文件路径：<code>${recentStatus.file}</code></div>` : ''}`
                                            : (recentStatus.state === 'error'
                                                ? `<span><i class="fa-solid fa-circle-exclamation"></i> <b>写入失败：</b>${recentStatus.text}</span>`
                                                : `<i class="fa-solid fa-circle-check" style="opacity: 0.7;"></i> ${recentStatus.text}`)))
                                }
                            </span>
                            <span id="novel_recent_time" class="novel-status-time">${recentStatus.time || '--:--:--'}</span>
                        </div>
                    </div>
                    <div id="novel_save_status_badge" class="novel-alert checking">
                        <i class="fa-solid fa-circle-notch fa-spin"></i>
                        <div class="novel-alert-text">正在检查连载服务状态...</div>
                    </div>
                    <div id="novel_deploy_guide" class="novel-guide-section" style="display: none;"></div>
                </div>

                <!-- ▍正文过滤 -->
                <div class="novel-section">
                    <div class="novel-section-title"><i class="fa-solid fa-filter"></i> 正文过滤</div>
                    <div class="novel-form-group">
                        <span class="novel-label">只保留的标签（白名单，留空 = 整篇保留）：</span>
                        <input type="text" id="novel_include_tags" class="text_pole" value="${settings.include_tags || ''}" placeholder="例如: story, response, content" />
                        <small>AI 若把小说写在某个标签内（如 <code>&lt;story&gt;</code>），填入标签名即只提取其中正文，忽略外部元数据。</small>
                    </div>
                    <div class="novel-form-group">
                        <span class="novel-label">剔除的标签块（黑名单）：</span>
                        <input type="text" id="novel_exclude_tags" class="text_pole" value="${settings.exclude_tags || ''}" placeholder="例如: status, memory, details, ooc, note" />
                        <small>无论在整篇还是正文标签内部，都会彻底剔除这些干扰块。</small>
                    </div>
                    <!-- 【会话标签检测】：自动扫描当前聊天出现的标签，一键加入白/黑名单 -->
                    <div class="novel-form-group novel-tag-scanner">
                        <div class="novel-tag-scanner-header">
                            <span class="novel-label"><i class="fa-solid fa-tags"></i> 会话标签检测</span>
                            <span class="novel-tag-scanner-meta">
                                <span id="novel_tag_scan_count"></span>
                                <button type="button" id="novel_rescan_tags_btn" class="novel-chip-btn" title="重新扫描当前会话中出现的标签"><i class="fa-solid fa-rotate"></i> 重新扫描</button>
                            </span>
                        </div>
                        <div id="novel_tag_chips" class="novel-tag-chip-list"></div>
                        <small>点「白」= 只保留该标签内的正文；点「黑」= 彻底剔除该标签块；再次点击可移除；两侧互斥；鼠标悬浮标签可预览其最新内容。</small>
                    </div>

                    <!-- 【过滤效果预览】：按钮弹窗展示最近一条 AI 回复经标签过滤后的完整效果 -->
                    <div class="novel-form-group">
                        <span class="novel-label"><i class="fa-solid fa-eye"></i> 过滤效果预览（最近一条 AI 回复）</span>
                        <button type="button" id="novel_preview_btn" class="novel-btn novel-btn-block" title="弹窗展示最近一条 AI 回复经当前白/黑名单过滤后的完整正文">
                            <i class="fa-solid fa-eye"></i> <span id="novel_preview_btn_label">查看过滤效果预览</span>
                        </button>
                        <small id="novel_preview_btn_stat" class="novel-preview-stat"></small>
                    </div>
                </div>

                <!-- ▍排版与行为 -->
                <div class="novel-section">
                    <div class="novel-section-title"><i class="fa-solid fa-sliders"></i> 排版与行为</div>
                    <!-- 章节排版模式 -->
                    <div class="novel-form-group">
                        <span class="novel-label">章节目录风格：</span>
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

                    <!-- 小说文件命名规则 -->
                    <div class="novel-form-group">
                        <span class="novel-label">文件命名规则：</span>
                        <select id="novel_naming_rule" class="text_pole novel-select">
                            <option value="char_chat" ${settings.naming_rule !== 'char_only' ? 'selected' : ''}>角色名 - 对话名（推荐：新聊天自动新建小说，绝不覆盖旧聊天）</option>
                            <option value="char_only" ${settings.naming_rule === 'char_only' ? 'selected' : ''}>仅角色名（所有聊天合为一本，如 角色名.txt）</option>
                        </select>
                        <small>
                            开启新聊天或平行分支时，默认会自动保存为新小说（如 <code>艾莉丝 - 2026-09-10.txt</code> 或自定义对话名），旧小说绝不被覆盖或串台！
                        </small>
                    </div>

                    <!-- 包含主角互动开关 -->
                    <label class="checkbox_label" title="开启后，你的提问与互动也会作为主角对白融入小说中；关闭则只收录纯故事正文">
                        <input type="checkbox" id="novel_include_user" ${settings.include_user_dialogue ? 'checked' : ''} />
                        <span>将你的发言作为主角对白融入小说</span>
                    </label>

                    <!-- 中文段落缩进 -->
                    <label class="checkbox_label" title="每段开头空两格（全角空格），符合中文出版小说排版规范">
                        <input type="checkbox" id="novel_indent_paragraphs" ${settings.indent_paragraphs ? 'checked' : ''} />
                        <span>段落首行空两格（中文小说规范缩进）</span>
                    </label>

                    <!-- 草稿缓冲（延迟归档最新楼层） -->
                    <label class="checkbox_label" title="开启后，最新一楼暂不写入连载文件，留出充分的 Roll 点与修改空间；待下一轮剧情推进时再正式定稿入书">
                        <input type="checkbox" id="novel_buffer_latest" ${settings.buffer_latest_message ? 'checked' : ''} />
                        <span>延迟归档最新楼层（草稿缓冲：下一轮对话推进时再正式定稿入书）</span>
                    </label>
                </div>

                <!-- ▍文件与导出 -->
                <div class="novel-section">
                    <div class="novel-section-title"><i class="fa-solid fa-folder-open"></i> 文件与导出</div>
                    <!-- 【保存文件夹设置】：自定义存储路径 -->
                    <div class="novel-form-group">
                        <span class="novel-label">指定保存文件夹（可选）：</span>
                        <input type="text" id="novel_save_dir" class="text_pole" value="${settings.save_dir || ''}" placeholder="留空默认存至 plugins/auto-save/logs；填写服务端有效目录" />
                        <small>此处为<b>服务端（运行酒馆的机器）</b>上的保存目录。<span style="color: #f39c12;">注意：若酒馆部署在云服务器(Linux)，无法直接填写本地盘符（如 <code>D:\</code>）；</span>当前保存至：<code id="novel_save_dir_preview">${initialDir}${initialFileName}</code>；如需在本机阅读，可留空并用【导出整本 TXT】直接下载。</small>
                    </div>

                    <!-- 操作按钮组：导出为主按钮，同步为次按钮，试写为弱化诊断按钮 -->
                    <div class="novel-action-buttons">
                        <button type="button" id="novel_export_all_btn" class="novel-btn btn-export" style="flex: 1;" title="无需服务端插件，直接在浏览器中将所有聊天编排为小说 TXT 并下载">
                            <i class="fa-solid fa-download"></i> 导出整本 TXT
                        </button>
                        <button type="button" id="novel_sync_all_btn" class="novel-btn btn-sync" style="flex: 1;" title="将当前聊天所有历史章节完整编排并同步写入服务端文件">
                            <i class="fa-solid fa-file-import"></i> 同步历史连载
                        </button>
                        <button type="button" id="novel_test_btn" class="novel-btn btn-test novel-btn-minor" style="flex: 0 0 auto;" title="测试服务端插件连通性与标签清洗效果">
                            <i class="fa-solid fa-feather-pointed"></i> 试写一章
                        </button>
                    </div>
                </div>

                <!-- 过滤效果预览弹窗（完整正文，点遮罩 / 右上角 / Esc 均可关闭） -->
                <div id="novel_preview_modal" class="novel-modal-overlay" style="display: none;">
                    <div class="novel-modal" role="dialog" aria-modal="true">
                        <div class="novel-modal-header">
                            <b><i class="fa-solid fa-eye"></i> 过滤效果预览（最近一条 AI 回复）</b>
                            <span style="display: inline-flex; align-items: center; gap: 10px;">
                                <small id="novel_modal_stat" class="novel-preview-stat"></small>
                                <button type="button" id="novel_modal_close" class="novel-chip-btn" title="关闭预览"><i class="fa-solid fa-xmark"></i></button>
                            </span>
                        </div>
                        <div id="novel_modal_body" class="novel-modal-body"></div>
                    </div>
                </div>
            </div>
        </div>
    `;

    container.appendChild(panel);
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
                window.toastr.info(`连载文件路径已复制：<br><code>${fullPath}</code>`, '小说连载', { timeOut: 3500 });
            }
        } catch (err) {
            if (window.toastr) {
                window.toastr.info(`当前连载文件：${fullPath}`, '小说连载');
            }
        }
    };

    if (copyPathBtn) copyPathBtn.addEventListener('click', handleCopyPath);
    if (drawerFilenameEl) drawerFilenameEl.addEventListener('click', handleCopyPath);

    // 同步更新顶栏状态指示
    if (recentStatus.state !== 'idle') {
        const headerStatus = panel.querySelector('#novel_header_status');
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

    // 「查看过滤效果预览」按钮 + 弹窗关闭（点遮罩 / 右上角 / Esc 键）
    const previewBtn = panel.querySelector('#novel_preview_btn');
    if (previewBtn) {
        previewBtn.addEventListener('click', () => {
            openFilterPreviewModal();
        });
    }
    const modalOverlay = panel.querySelector('#novel_preview_modal');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) closeFilterPreviewModal();
        });
        const modalCloseBtn = modalOverlay.querySelector('#novel_modal_close');
        if (modalCloseBtn) {
            modalCloseBtn.addEventListener('click', () => closeFilterPreviewModal());
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') closeFilterPreviewModal();
        });
        // 弹窗挂载到 body：抽屉折叠（display:none）时也能从楼层工具条正常弹出
        // （必须在事件绑定完成之后再移动，监听器挂在元素上随元素走）
        if (document.body.contains(modalOverlay)) {
            document.body.appendChild(modalOverlay);
        }
    }

    // 纯前端一键导出整本小说：与最新 AI 楼层内嵌工具条共用 exportNovelText()
    const exportBtn = panel.querySelector('#novel_export_all_btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => exportNovelText());
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
            const cmdOnlineLinux = `curl -fsSL https://cdn.jsdelivr.net/gh/zgy-beep/ST-auto-save-to-txt@main/install.sh | bash`;
            const cmdOnlineWindows = `irm https://cdn.jsdelivr.net/gh/zgy-beep/ST-auto-save-to-txt@main/install.ps1 | iex`;
            const cmdDirectScript = `bash install.sh`;
            const cmdManualDocker = `docker exec sillytavern cp -r /home/node/app/data/default-user/extensions/ST-auto-save-to-txt/plugins/auto-save /home/node/app/plugins/`;

            guideEl.innerHTML = `
                <!-- 零配置免安装直接导出高亮卡片 -->
                <div class="novel-plan-c-card">
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 3px;">
                        <i class="fa-solid fa-circle-check" style="color: #2ecc71;"></i>
                        <b>即开即用：零配置直接导出（推荐）</b>
                    </div>
                    无需配置服务器或 Docker 挂载！随时点击下方<b>【导出整本 TXT】</b>，浏览器可直接排版、生成带楼层/目录的完整小说并一键下载，零门槛、零网络报错！
                </div>

                <!-- 方案一：一键脚本自动部署 -->
                <div class="novel-deploy-card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight: bold; opacity: 0.95;"><i class="fa-solid fa-wand-magic-sparkles"></i> 方案一：一键命令自动部署（国内 CDN 高速加速）</span>
                        <small style="opacity: 0.7; font-size: 11px;">极简一行直达</small>
                    </div>
                    <div class="novel-tab-bar">
                        <button type="button" class="novel-tab-btn active" data-tab="universal"><i class="fa-brands fa-linux"></i> Linux / Docker / NAS (推荐)</button>
                        <button type="button" class="novel-tab-btn" data-tab="windows"><i class="fa-brands fa-windows"></i> Windows 本机</button>
                        <button type="button" class="novel-tab-btn" data-tab="script"><i class="fa-solid fa-terminal"></i> 离线/本地运行</button>
                    </div>
                    <div class="novel-code-wrapper">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 11px; opacity: 0.75;" id="novel_tab_hint">在服务器终端（SSH 或控制台）直接粘贴执行（国内 CDN 高速直连，自动穿透 Docker）：</span>
                            <button type="button" class="novel-copy-btn" id="novel_copy_cmd_btn"><i class="fa-solid fa-copy"></i> 复制命令</button>
                        </div>
                        <code class="novel-code-text" id="novel_cmd_display">${cmdOnlineLinux}</code>
                    </div>
                    <small style="opacity: 0.75; font-size: 11px; line-height: 1.5;">
                        <b>第 1 步：</b>粘贴执行上述命令（全自动感知 Docker 容器、定位挂载卷并完成部署）；<br>
                        <b>第 2 步：</b>确认酒馆 <code>config.yaml</code> 中 <code>enableServerPlugins: true</code> 并重启酒馆。
                    </small>
                </div>

                <!-- 方案二：醒目手动复制保底卡片 -->
                <div class="novel-manual-card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight: bold; color: #f39c12; display: flex; align-items: center; gap: 6px;">
                            <i class="fa-solid fa-triangle-exclamation"></i> 方案二：若脚本自动部署失败，请手动复制（100% 成功保底）
                        </span>
                        <small style="color: #f39c12; font-weight: bold; font-size: 11px;">终极保底</small>
                    </div>
                    <div style="font-size: 11px; opacity: 0.9; line-height: 1.4;">
                        当环境特殊或脚本无法自动感知目录时，只需手动复制一个文件夹即可完全搞定：
                    </div>
                    <div class="novel-manual-paths">
                        <div><b>📂 复制源路径：</b><br><code>SillyTavern/data/default-user/extensions/ST-auto-save-to-txt/plugins/auto-save</code></div>
                        <div style="margin-top: 4px;"><b>🎯 粘贴至目标：</b><br><code>SillyTavern/plugins/auto-save</code></div>
                    </div>
                    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 2px;">
                        <span style="font-size: 11px; opacity: 0.85;">🐳 <b>Docker 容器内直连手动复制命令：</b></span>
                        <button type="button" class="novel-copy-btn" id="novel_copy_docker_manual_btn" style="padding: 2px 8px; font-size: 10px;">
                            <i class="fa-solid fa-copy"></i> 复制 Docker 手动命令
                        </button>
                    </div>
                    <div style="font-size: 11px; opacity: 0.8; line-height: 1.4; border-top: 1px dashed rgba(230, 126, 34, 0.3); padding-top: 5px;">
                        💡 <b>提示：</b>复制完成后，请确认酒馆 <code>config.yaml</code> 中开启 <code>enableServerPlugins: true</code>，重启酒馆（Docker 执行 <code>docker restart &lt;容器名&gt;</code>），刷新网页即可正常使用！
                    </div>
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

    // 立即执行并配合短延迟补救，确保 100% 渲染至酒馆扩展列表
    renderSettingsUI(bootStatus);
    setTimeout(() => {
        // 若用户已展开面板（如正在输入），跳过重复渲染，避免清空其输入与部署指引 tab 状态
        if (!document.getElementById('auto-save-to-txt-settings')) {
            renderSettingsUI(bootStatus);
        }
    }, 500);

    seedLastSavedSignature();

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
                    refreshLatestToolbar();
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
                refreshLatestToolbar();
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
                refreshLatestToolbar();
            });
        }

        const refreshContext = () => {
            cleanTextCache.map.clear();
            seedLastSavedSignature();
            renderTagTools();
            updateDrawerHeaderFileBadge();
            // ①④ 切聊天/角色/群后重算楼层入书映射并重绘徽标与最新楼层工具条
            const ctxChat = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
            savedChapterMap = computeChapterMap(getSettings(), ctxChat);
            refreshMessageBadges();
            refreshLatestToolbar();
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
