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
    version: '1.6.0',             // 扩展版本号
    enabled: true,                // 小说连载总开关
    include_user_dialogue: false, // 是否将主角（你的互动）也以对话形式写入小说
    chapter_style: 'numbered_floor', // 章节标题样式: 'numbered_floor' (默认：第 1 章 · 角色名 (原楼层: 1)), 'numbered' (第 1 节 · 角色名), 'separator' (* * *), 'dialogue' (【角色名】)
    naming_rule: 'char_chat',     // 文件命名规则: 'char_chat' (角色名 - 对话名), 'char_only' (仅角色名)
    indent_paragraphs: true,      // 自动段落首行空两格（中文小说规范排版）
    include_tags: '',             // 【白名单】：指定正文标签（留空代表整篇保留；填入如 story 则只提取 <story>...</story>）
    exclude_tags: 'status,memory,details,variables,analysis,ooc,note,draft,system,log', // 【黑名单】：需剔除的标签块内容
    save_dir: '',                 // 自定义保存文件夹路径（留空则保存至默认 plugins/auto-save/logs；支持任意绝对路径如 D:\MyNovels）
    show_toast: true,             // 连载更新时弹出轻量提示通知
};

let lastSavedSignature = {
    messageId: null,
    characterName: '',
    mesSnippet: ''
};

let recentStatus = {
    state: 'idle', // 'idle' | 'updating' | 'success' | 'skipped' | 'error'
    text: '连载服务就绪（收到 AI 回复将自动排版写入）',
    time: '',
    file: ''
};

function updateRecentStatus(state, text, file = '') {
    recentStatus.state = state;
    recentStatus.text = text;
    recentStatus.time = new Date().toLocaleTimeString();
    if (file) recentStatus.file = file;

    // 更新面板顶栏标题右侧小指示灯（无论抽屉是否展开均可见）
    const headerStatus = document.getElementById('novel_header_status');
    if (headerStatus) {
        if (state === 'updating') {
            headerStatus.innerHTML = `<span style="color: var(--SmartThemeQuoteColor, #3498db); font-weight: normal;"><i class="fa-solid fa-spinner fa-spin"></i> 连载更新中...</span>`;
        } else if (state === 'success') {
            headerStatus.innerHTML = `<span style="color: var(--SmartThemeEmColor, #2ecc71); font-weight: normal;"><i class="fa-solid fa-circle-check"></i> 已连载 ${recentStatus.time}</span>`;
        } else if (state === 'skipped') {
            headerStatus.innerHTML = `<span style="color: #f39c12; font-weight: normal;"><i class="fa-solid fa-circle-info"></i> 已跳过</span>`;
        } else if (state === 'error') {
            headerStatus.innerHTML = `<span style="color: #e74c3c; font-weight: normal;"><i class="fa-solid fa-circle-exclamation"></i> 连载失败</span>`;
        }
    }

    // 更新抽屉内部的状态卡片
    const detailEl = document.getElementById('novel_recent_detail');
    const timeEl = document.getElementById('novel_recent_time');
    const cardEl = document.getElementById('novel_recent_status');

    if (detailEl && timeEl && cardEl) {
        timeEl.textContent = recentStatus.time;
        if (state === 'updating') {
            cardEl.style.borderColor = 'var(--SmartThemeQuoteColor, #3498db)';
            detailEl.innerHTML = `<span style="color: var(--SmartThemeQuoteColor, #3498db);"><i class="fa-solid fa-spinner fa-spin"></i> <b>更新中：</b>${text}</span>`;
        } else if (state === 'success') {
            cardEl.style.borderColor = 'var(--SmartThemeEmColor, #2ecc71)';
            detailEl.innerHTML = `<span style="color: var(--SmartThemeEmColor, #2ecc71);"><i class="fa-solid fa-circle-check"></i> <b>更新完成：</b>${text}</span>` + 
                (recentStatus.file ? `<div style="margin-top: 3px; font-size: 11px; opacity: 0.85;">文件路径：<code>${recentStatus.file}</code></div>` : '');
        } else if (state === 'skipped') {
            cardEl.style.borderColor = '#f39c12';
            detailEl.innerHTML = `<span style="color: #f39c12;"><i class="fa-solid fa-circle-info"></i> <b>已跳过：</b>${text}</span>` +
                (recentStatus.file ? `<div style="margin-top: 3px; font-size: 11px; opacity: 0.85;">文件路径：<code>${recentStatus.file}</code></div>` : '');
        } else if (state === 'error') {
            cardEl.style.borderColor = '#e74c3c';
            detailEl.innerHTML = `<span style="color: #e74c3c;"><i class="fa-solid fa-circle-exclamation"></i> <b>写入失败：</b>${text}</span>`;
        } else {
            cardEl.style.borderColor = 'var(--SmartThemeEmColor, #2ecc71)';
            detailEl.innerHTML = `<i class="fa-solid fa-circle-check" style="opacity: 0.7;"></i> ${text}`;
        }
    }
}

function getSettings() {
    const extSettings = ctx.extension_settings || ext_settings_raw || window.extension_settings || {};
    if (!extSettings[EXTENSION_NAME]) {
        extSettings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS, version: '1.6.0' };
    } else {
        // 版本平滑迁移：针对升级用户，如果仍为历史默认值 'numbered'，自动切换至推荐的 'numbered_floor'
        if (extSettings[EXTENSION_NAME].version !== '1.6.0') {
            if (extSettings[EXTENSION_NAME].chapter_style === 'numbered') {
                extSettings[EXTENSION_NAME].chapter_style = 'numbered_floor';
            }
            extSettings[EXTENSION_NAME].version = '1.6.0';
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        }

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

    // 获取当前对话标题或文件名（自动区分同一角色的不同聊天会话 / 平行分支）
    let chatTitle = '';
    if (Array.isArray(charList) && typeof chid !== 'undefined' && charList[chid]) {
        const charObj = charList[chid];
        if (charObj.chat && typeof charObj.chat === 'string') {
            chatTitle = charObj.chat.replace(/\.jsonl$/i, '').trim();
        }
    }
    if (!chatTitle && ctx.chatMetadata && typeof ctx.chatMetadata === 'object' && ctx.chatMetadata.title) {
        chatTitle = String(ctx.chatMetadata.title).trim();
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

const INLINE_TAGS = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'span', 'sub', 'sup', 'small', 'del', 'mark']);

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
        const match = text.match(/^([\s\S]*?)<\/\s*([a-zA-Z0-9_\-~.:#]+)\s*>\s*/i);
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
    const includeInput = (typeof settings.include_tags === 'string') ? settings.include_tags.trim() : '';
    if (includeInput) {
        const includeTags = includeInput
            .split(/[,，\s]+/)
            .map(t => t.trim().replace(/^<|>$/g, ''))
            .filter(Boolean);

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
    }

    // 阶段二【黑名单模式】：深度剔除不要的标签块（支持成对、开篇无开标签、尾部未闭合等各类异常形态）
    const excludeInput = (typeof settings.exclude_tags === 'string') 
        ? settings.exclude_tags 
        : (DEFAULT_SETTINGS.exclude_tags || '');

    if (excludeInput && excludeInput.trim()) {
        const excludeTags = excludeInput
            .split(/[,，\s]+/)
            .map(t => t.trim().replace(/^<|>$/g, ''))
            .filter(Boolean);

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
            is_regenerate: (typeof data.is_regenerate !== 'undefined') ? data.is_regenerate : payload.is_regenerate
        };
    } catch (error) {
        console.warn('[AutoSaveTxt] 连接服务端插件异常:', error);
        return { success: false, error: error.message };
    }
}

async function handleMessageSave(messageIdOrData, isFromUser = false) {
    const settings = getSettings();
    if (!settings.enabled) return;

    if (isFromUser && !settings.include_user_dialogue) {
        return;
    }

    const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
    if (!chatLog || chatLog.length === 0) return;

    let messageIndex = -1;
    if (typeof messageIdOrData === 'number') {
        messageIndex = messageIdOrData;
    } else if (messageIdOrData && typeof messageIdOrData.messageId === 'number') {
        messageIndex = messageIdOrData.messageId;
    } else {
        messageIndex = chatLog.length - 1;
    }

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
        const c = cleanNovelText(m.mes || '', settings);
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
        floor: floor
    };

    const res = await postChapterToServer(payload);
    if (res && res.success) {
        lastSavedSignature = {
            messageId: messageIndex,
            characterName: bookTitle,
            mesSnippet: mesSnippet
        };

        const targetFile = res.file || `${bookTitle}.txt`;

        if (res.skipped) {
            updateRecentStatus('skipped', `${sectionLabel}末尾内容重复，已自动略过写入`, targetFile);
            if (settings.show_toast !== false && window.toastr) {
                window.toastr.info(`${sectionLabel}内容与前文重复，已略过`, '小说连载提示', { timeOut: 2500 });
            }
        } else if (res.is_regenerate || isRegenerate) {
            updateRecentStatus('success', `${sectionLabel} · ${speakerName}${floorLabel}（重新生成已替换更新）`, targetFile);
            if (settings.show_toast !== false && window.toastr) {
                window.toastr.success(`${sectionLabel}${floorLabel}已更新为最新生成版本！`, '小说连载已更新', {
                    timeOut: 3000,
                    preventDuplicates: true
                });
            }
        } else {
            // 2. 更新完成提示（顶栏指示灯与面板卡片）
            updateRecentStatus('success', `${sectionLabel} · ${speakerName}${floorLabel} 连载成功！`, targetFile);

            // 3. 屏幕 Toast 提示通知
            if (settings.show_toast !== false && window.toastr) {
                window.toastr.success(`${sectionLabel} · ${speakerName}${floorLabel} 已自动写入《${bookTitle}》`, '小说连载更新完成', {
                    timeOut: 3500,
                    preventDuplicates: true
                });
            }
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
                    '未检测到服务端插件 (HTTP 404)，已自动为您取消勾选连载，防止频繁报错。您可以随时使用【导出整本小说 TXT】一键下载，或参考指引安装插件。',
                    '连载功能已自动暂停',
                    { timeOut: 6000, preventDuplicates: true }
                );
            }
            return;
        }

        const errMsg = (res && res.error) ? res.error : (res && res.status ? `HTTP ${res.status}` : '连接服务端插件异常');
        updateRecentStatus('error', `${sectionLabel}写入失败: ${errMsg}`);

        if (settings.show_toast !== false && window.toastr) {
            window.toastr.warning(`${sectionLabel}自动连载失败: ${errMsg}`, '小说连载更新失败', {
                timeOut: 4500
            });
        }
    }
}

async function renderSettingsUI(cachedStatus = null) {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) return;

    let panel = document.getElementById('auto-save-to-txt-settings');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'auto-save-to-txt-settings';
    panel.className = 'inline-drawer';

    // 默认折叠（移除 down 类名，内容设为 display: none，移除 emoji 保持对齐）
    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header" style="display: flex; align-items: center;">
            <b>小说连载阅读 (Novel Stream)</b>
            <span id="novel_header_status" style="margin-left: auto; margin-right: 8px; font-size: 11px; opacity: 0.85;"></span>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
            <div class="novel-drawer-inner">
                <!-- 连通性提示 -->
                <div id="novel_save_status_badge" class="novel-alert checking">
                    <i class="fa-solid fa-circle-notch fa-spin"></i>
                    <div class="novel-alert-text">正在检查连载服务状态...</div>
                </div>

                <!-- 未安装服务端插件时的部署与使用指引 -->
                <div id="novel_deploy_guide" class="novel-guide-section" style="display: none;"></div>

                <!-- 最近连载动态卡片 (更新中/更新完成实时展示) -->
                <div id="novel_recent_status" class="novel-status-card" style="border-left: 3px solid ${recentStatus.state === 'error' ? '#e74c3c' : (recentStatus.state === 'updating' ? 'var(--SmartThemeQuoteColor, #3498db)' : (recentStatus.state === 'skipped' ? '#f39c12' : 'var(--SmartThemeEmColor, #2ecc71)'))};">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                        <span style="font-weight: bold; opacity: 0.9;"><i class="fa-solid fa-clock-rotate-left"></i> 最近连载状态</span>
                        <span id="novel_recent_time" style="opacity: 0.65; font-size: 11px;">${recentStatus.time || '--:--:--'}</span>
                    </div>
                    <div id="novel_recent_detail" style="word-break: break-all; line-height: 1.4;">
                        ${recentStatus.state === 'success' 
                            ? `<span style="color: var(--SmartThemeEmColor, #2ecc71);"><i class="fa-solid fa-circle-check"></i> <b>更新完成：</b>${recentStatus.text}</span>${recentStatus.file ? `<div style="margin-top: 3px; font-size: 11px; opacity: 0.85;">文件路径：<code>${recentStatus.file}</code></div>` : ''}`
                            : (recentStatus.state === 'updating'
                                ? `<span style="color: var(--SmartThemeQuoteColor, #3498db);"><i class="fa-solid fa-spinner fa-spin"></i> <b>更新中：</b>${recentStatus.text}</span>`
                                : (recentStatus.state === 'skipped'
                                    ? `<span style="color: #f39c12;"><i class="fa-solid fa-circle-info"></i> <b>已跳过：</b>${recentStatus.text}</span>${recentStatus.file ? `<div style="margin-top: 3px; font-size: 11px; opacity: 0.85;">文件路径：<code>${recentStatus.file}</code></div>` : ''}`
                                    : (recentStatus.state === 'error'
                                        ? `<span style="color: #e74c3c;"><i class="fa-solid fa-circle-exclamation"></i> <b>写入失败：</b>${recentStatus.text}</span>`
                                        : `<i class="fa-solid fa-circle-check" style="opacity: 0.7;"></i> ${recentStatus.text}`)))
                        }
                    </div>
                </div>

                <!-- 主开关 -->
                <label class="checkbox_label" title="开启后，每轮 AI 回复将像小说章节一样自动写入 txt，随时用手机或阅读器翻阅">
                    <input type="checkbox" id="novel_save_enabled" ${settings.enabled ? 'checked' : ''} />
                    <span>开启小说自动连载</span>
                </label>

                <!-- 连载更新弹窗提示开关 -->
                <label class="checkbox_label" title="开启后，每当新章节连载更新完成时，在屏幕右上角弹出轻量提示通知">
                    <input type="checkbox" id="novel_show_toast" ${settings.show_toast !== false ? 'checked' : ''} />
                    <span>连载更新时弹出轻量提示通知（Toast）</span>
                </label>

                <!-- 章节排版模式 -->
                <div class="novel-form-group">
                    <span class="novel-label">章节目录风格：</span>
                    <select id="novel_chapter_style" class="text_pole" style="padding: 5px 8px; border-radius: 4px; font-size: 13px;">
                        <option value="numbered_floor" ${settings.chapter_style !== 'numbered' && settings.chapter_style !== 'separator' && settings.chapter_style !== 'dialogue' ? 'selected' : ''}>第 X 章 · 角色名 (原楼层: Y)（默认推荐：带楼层标记，方便快速定位排查问题）</option>
                        <option value="numbered" ${settings.chapter_style === 'numbered' ? 'selected' : ''}>第 X 节 · 角色名（纯净小说目录，无楼层）</option>
                        <option value="separator" ${settings.chapter_style === 'separator' ? 'selected' : ''}>优雅分割线（* * * 散文小说连续阅读）</option>
                        <option value="dialogue" ${settings.chapter_style === 'dialogue' ? 'selected' : ''}>纯净戏剧体（角色名: 正文）</option>
                    </select>
                </div>

                <!-- 小说文件命名规则 -->
                <div class="novel-form-group">
                    <span class="novel-label">文件命名规则：</span>
                    <select id="novel_naming_rule" class="text_pole" style="padding: 5px 8px; border-radius: 4px; font-size: 13px;">
                        <option value="char_chat" ${settings.naming_rule !== 'char_only' ? 'selected' : ''}>角色名 - 对话名（推荐：新聊天自动新建小说，绝不覆盖旧聊天）</option>
                        <option value="char_only" ${settings.naming_rule === 'char_only' ? 'selected' : ''}>仅角色名（所有聊天合为一本，如 角色名.txt）</option>
                    </select>
                    <small style="opacity: 0.75; font-size: 11px; color: var(--SmartThemeEmColor, #aaa); line-height: 1.4;">
                        开启新聊天或平行分支时，默认会自动保存为新小说（如 <code>艾莉丝 - 2026-09-10.txt</code> 或自定义对话名），旧小说绝不被覆盖或串台！
                    </small>
                </div>

                <!-- 【白名单】：指定提取正文标签块 -->
                <div class="novel-form-group">
                    <span class="novel-label">指定正文标签（白名单，可选）：</span>
                    <input type="text" id="novel_include_tags" class="text_pole" value="${settings.include_tags || ''}" placeholder="留空代表整篇保留；例如: story, response, content" />
                    <small style="opacity: 0.75; font-size: 11px; color: var(--SmartThemeEmColor, #aaa); line-height: 1.4;">
                        若预设把小说写在 <code>&lt;story&gt;</code> 内，填入 <code>story</code> 即可只提取该标签内容，忽略外部其他元数据。
                    </small>
                </div>

                <!-- 【黑名单】：排除的标签块 -->
                <div class="novel-form-group">
                    <span class="novel-label">排除的标签块（黑名单）：</span>
                    <input type="text" id="novel_exclude_tags" class="text_pole" value="${settings.exclude_tags || ''}" placeholder="例如: status, memory, details, ooc, note" />
                    <small style="opacity: 0.75; font-size: 11px; color: var(--SmartThemeEmColor, #aaa); line-height: 1.4;">
                        无论在整篇还是在正文标签内部，都会彻底剔除这些类似 <code>&lt;status&gt;...&lt;/status&gt;</code> 的干扰块。
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

                <!-- 【保存文件夹设置】：自定义存储路径 -->
                <div class="novel-form-group">
                    <span class="novel-label">指定保存文件夹（可选）：</span>
                    <input type="text" id="novel_save_dir" class="text_pole" value="${settings.save_dir || ''}" placeholder="留空默认存至 plugins/auto-save/logs；填写服务端有效目录" />
                    <small style="opacity: 0.75; font-size: 11px; color: var(--SmartThemeEmColor, #aaa); line-height: 1.4;">
                        此处为<b>服务端（运行酒馆的机器）</b>上的保存目录。<span style="color: #f39c12;">注意：若酒馆部署在云服务器(Linux)，无法直接填写本地盘符（如 <code>D:\</code>）；</span>如需在本机阅读，可留空并点击下方<b>【导出整本小说 TXT】</b>直接下载，或使用 Syncthing 自动双向同步。
                    </small>
                </div>

                <!-- 存储位置说明 -->
                <div class="novel-book-info">
                    <i class="fa-solid fa-book-bookmark"></i>
                    <span>实时连载保存于：<code id="novel_save_dir_preview">${settings.save_dir ? (settings.save_dir.replace(/[\\/]+$/, '') + '/') : 'SillyTavern/plugins/auto-save/logs/'}${settings.naming_rule === 'char_only' ? '<角色名>.txt' : '<角色名> - <对话名>.txt'}</code><br>
                    <small style="opacity: 0.8;">若未配置服务端插件，也可随时点击下方<b>“导出整本小说”</b>直接下载。</small></span>
                </div>

                <!-- 操作按钮组 -->
                <div style="display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap;">
                    <button id="novel_sync_all_btn" class="menu_button" style="flex: 1; min-width: 130px; background: var(--SmartThemeEmColor, #27ae60); color: #fff;" title="半路使用插件时，一键将之前的全部历史聊天记录完整编排并同步保存到服务端的 txt 文件中！">
                        <i class="fa-solid fa-file-import"></i> 同步历史到连载文件
                    </button>
                    <button id="novel_export_all_btn" class="menu_button" style="flex: 1; min-width: 120px; background: var(--SmartThemeQuoteColor, #2980b9); color: #fff;" title="即使没有安装服务端插件，也可以一键将当前所有聊天按小说章节排版并下载为 txt！">
                        <i class="fa-solid fa-download"></i> 导出整本小说 TXT
                    </button>
                    <button id="novel_test_btn" class="menu_button" style="flex: 1; min-width: 90px;" title="测试服务端插件连通性">
                        <i class="fa-solid fa-feather-pointed"></i> 试写一章
                    </button>
                </div>
            </div>
        </div>
    `;

    container.appendChild(panel);

    // 同步更新顶栏状态指示
    if (recentStatus.state !== 'idle') {
        const headerStatus = panel.querySelector('#novel_header_status');
        if (headerStatus) {
            if (recentStatus.state === 'updating') {
                headerStatus.innerHTML = `<span style="color: var(--SmartThemeQuoteColor, #3498db);"><i class="fa-solid fa-spinner fa-spin"></i> 连载更新中...</span>`;
            } else if (recentStatus.state === 'success') {
                headerStatus.innerHTML = `<span style="color: var(--SmartThemeEmColor, #2ecc71);"><i class="fa-solid fa-circle-check"></i> 已连载 ${recentStatus.time}</span>`;
            } else if (recentStatus.state === 'skipped') {
                headerStatus.innerHTML = `<span style="color: #f39c12;"><i class="fa-solid fa-circle-info"></i> 已跳过</span>`;
            } else if (recentStatus.state === 'error') {
                headerStatus.innerHTML = `<span style="color: #e74c3c;"><i class="fa-solid fa-circle-exclamation"></i> 连载失败</span>`;
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

    // 主开关绑定：附带未安装服务端的防误触检测
    const enableEl = panel.querySelector('#novel_save_enabled');
    if (enableEl) {
        enableEl.addEventListener('change', async (e) => {
            if (e.target.checked) {
                enableEl.disabled = true;
                try {
                    // 用户尝试手动开启连载时，前置探测服务端是否可用
                    const probe = await checkServerPluginStatus();
                    if (!probe.ready) {
                        e.target.checked = false;
                        settings.enabled = false;
                        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
                        if (window.toastr) {
                            window.toastr.warning(
                                '服务端插件未就绪（未安装或未启动），已自动取消勾选（防止 404 报错）。您可以直接点击下方【导出整本小说 TXT】下载，或参考下方指引部署插件。',
                                '连载服务未就绪',
                                { timeOut: 5500 }
                            );
                        }
                        return;
                    }
                } finally {
                    enableEl.disabled = false;
                }
            }
            settings.enabled = e.target.checked;
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }

    bindCheck('novel_show_toast', 'show_toast');
    bindCheck('novel_include_user', 'include_user_dialogue');
    bindCheck('novel_indent_paragraphs', 'indent_paragraphs');

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
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }

    const inputExclude = panel.querySelector('#novel_exclude_tags');
    if (inputExclude) {
        inputExclude.addEventListener('input', (e) => {
            settings.exclude_tags = e.target.value.trim();
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }

    const inputSaveDir = panel.querySelector('#novel_save_dir');
    const previewEl = panel.querySelector('#novel_save_dir_preview');
    const updatePreview = () => {
        if (!previewEl) return;
        const currentTitle = getBookTitle(settings);
        const prefix = settings.save_dir ? (settings.save_dir.replace(/[\\/]+$/, '') + '/') : 'SillyTavern/plugins/auto-save/logs/';
        previewEl.textContent = `${prefix}${currentTitle}.txt`;
    };

    if (inputSaveDir) {
        inputSaveDir.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            settings.save_dir = val;
            updatePreview();
            if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        });
    }

    // 一键将全部历史同步写入服务端连载文件
    const syncAllBtn = panel.querySelector('#novel_sync_all_btn');
    if (syncAllBtn) {
        syncAllBtn.addEventListener('click', async () => {
            const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
            if (!chatLog || chatLog.length === 0) {
                if (window.toastr) window.toastr.info('当前没有任何聊天内容可供同步。', '小说连载');
                return;
            }

            if (typeof confirm === 'function' && !confirm('是否将当前全部历史聊天记录完整编排并同步保存到连载小说文件中？\n（这会生成包含前置所有章节的完整小说，后续回复将自动接着连载）')) {
                return;
            }

            syncAllBtn.disabled = true;
            syncAllBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在同步历史...';
            updateRecentStatus('updating', '正在编排全量历史章节并同步至连载文件...');
            if (settings.show_toast !== false && window.toastr) {
                window.toastr.info('正在编排历史聊天并写入连载文件...', '小说连载更新中', { timeOut: 2000 });
            }

            let bookTitle = getBookTitle(settings);

            let novelText = `《${bookTitle}》\n\n`;
            let chapterCount = 0;

            for (let i = 0; i < chatLog.length; i++) {
                const msg = chatLog[i];
                if (msg.is_user && !settings.include_user_dialogue) continue;
                const cleanMes = cleanNovelText(msg.mes || '', settings);
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

            if (chapterCount === 0) {
                syncAllBtn.disabled = false;
                syncAllBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> 同步历史到连载文件';
                updateRecentStatus('skipped', '没有可同步的有效剧情章节');
                if (window.toastr) window.toastr.warning('没有可同步的有效剧情章节。', '小说连载');
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
                        save_dir: settings.save_dir || ''
                    }),
                });

                syncAllBtn.disabled = false;
                syncAllBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> 同步历史到连载文件';

                if (response.ok) {
                    const data = await response.json().catch(() => ({}));
                    const targetFile = data.file || '小说文件';
                    updateRecentStatus('success', `全书共 ${chapterCount} 个章节已完整同步！`, targetFile);
                    if (window.toastr) {
                        window.toastr.success(`已成功同步全书共 ${chapterCount} 个章节至：${targetFile}！后续 AI 回复将接着往后连载。`, '小说连载更新完成');
                    } else {
                        alert(`已成功同步全书共 ${chapterCount} 个章节至：${targetFile}！`);
                    }
                } else {
                    const errData = await response.json().catch(() => ({}));
                    const errMsg = errData.error || `HTTP ${response.status}`;
                    updateRecentStatus('error', `同步失败: ${errMsg}`);
                    if (window.toastr) {
                        window.toastr.error(`同步失败: ${errMsg}`, '小说连载更新失败');
                    }
                }
            } catch (err) {
                syncAllBtn.disabled = false;
                syncAllBtn.innerHTML = '<i class="fa-solid fa-file-import"></i> 同步历史到连载文件';
                updateRecentStatus('error', `同步异常: ${err.message}`);
                if (window.toastr) window.toastr.error(`同步异常: ${err.message}`, '小说连载更新失败');
            }
        });
    }

    // 纯前端一键导出整本小说（自动附加 UTF-8 BOM，彻底解决手机阅读器/老Windows乱码）
    const exportBtn = panel.querySelector('#novel_export_all_btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
            if (!chatLog || chatLog.length === 0) {
                if (window.toastr) window.toastr.info('当前没有任何聊天内容可供导出。', '小说连载');
                return;
            }

            let bookTitle = getBookTitle(settings);

            let novelText = `《${bookTitle}》\n\n`;
            let chapterCount = 0;

            for (let i = 0; i < chatLog.length; i++) {
                const msg = chatLog[i];
                if (msg.is_user && !settings.include_user_dialogue) continue;
                const cleanMes = cleanNovelText(msg.mes || '', settings);
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
        });
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

            const res = await postChapterToServer(testPayload);
            testBtn.disabled = false;
            testBtn.innerHTML = '<i class="fa-solid fa-feather-pointed"></i> 试写一章';

            if (res && res.success) {
                const targetText = res.file || (settings.save_dir ? settings.save_dir : 'plugins/auto-save/logs/');
                updateRecentStatus('success', '试读章节已连载成功！', targetText);
                if (settings.show_toast !== false && window.toastr) {
                    window.toastr.success(`试读章节已连载！文件：${targetText}`, '小说连载更新完成');
                } else if (!window.toastr) {
                    alert(`试读章节已连载！文件：${targetText}`);
                }
            } else {
                updateRecentStatus('error', '试读章节写入失败，请检查服务插件');
                if (settings.show_toast !== false && window.toastr) {
                    window.toastr.error('试写失败，请确认服务端插件已启动。', '小说连载更新失败');
                }
            }
        });
    }

    const badge = panel.querySelector('#novel_save_status_badge');
    const guideEl = panel.querySelector('#novel_deploy_guide');
    const status = cachedStatus || await checkServerPluginStatus();

    if (status.ready) {
        badge.className = 'novel-alert success';
        badge.innerHTML = `
            <i class="fa-solid fa-circle-check"></i>
            <div class="novel-alert-text"><b>连载服务已就绪：</b>每次 AI 回复将自动像小说一样顺畅续写。</div>
        `;
        if (guideEl) guideEl.style.display = 'none';
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
                您可直接使用下方<b>【导出整本小说 TXT】</b>一键下载，或参考下方引导复制命令部署插件。
            </div>
        `;

        if (guideEl) {
            guideEl.style.display = 'flex';
            const extRel = getExtensionRelativePath();
            const pluginSrc = `public/${extRel}/plugins/auto-save`;

            const cmdDocker = `cp -r "${pluginSrc}" "plugins/"`;
            const cmdWindows = `Copy-Item -Recurse -Force "${pluginSrc}" "plugins/"`;
            const cmdLinux = `cp -r "${pluginSrc}" "plugins/"`;

            guideEl.innerHTML = `
                <!-- 零配置免安装直接导出高亮卡片 -->
                <div class="novel-plan-c-card">
                    <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 3px;">
                        <i class="fa-solid fa-circle-check" style="color: #2ecc71;"></i>
                        <b>即开即用：零配置直接导出（推荐）</b>
                    </div>
                    无需配置服务器或 Docker 挂载！随时点击下方<b>【📥 导出整本小说 TXT】</b>，浏览器可直接排版、生成带楼层/目录的完整小说并一键下载，零门槛、零网络报错！
                </div>

                <!-- 进阶可选：一键部署服务端自动连载插件 -->
                <div class="novel-deploy-card">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <span style="font-weight: bold; opacity: 0.95;"><i class="fa-solid fa-plug"></i> 进阶配置：开启每轮自动落盘（可选）</span>
                        <small style="opacity: 0.7; font-size: 11px;">两步完成</small>
                    </div>
                    <div class="novel-tab-bar">
                        <button type="button" class="novel-tab-btn active" data-tab="docker"><i class="fa-brands fa-docker"></i> Docker / 容器终端</button>
                        <button type="button" class="novel-tab-btn" data-tab="windows"><i class="fa-brands fa-windows"></i> Windows 本机</button>
                        <button type="button" class="novel-tab-btn" data-tab="linux"><i class="fa-brands fa-linux"></i> Linux / 云服务器</button>
                    </div>
                    <div class="novel-code-wrapper">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="font-size: 11px; opacity: 0.75;" id="novel_tab_hint">在容器面板（群晖/1Panel/Portainer）打开“终端”，粘贴执行：</span>
                            <button type="button" class="novel-copy-btn" id="novel_copy_cmd_btn"><i class="fa-solid fa-copy"></i> 复制命令</button>
                        </div>
                        <code class="novel-code-text" id="novel_cmd_display">${cmdDocker}</code>
                    </div>
                    <small style="opacity: 0.75; font-size: 11px; line-height: 1.4;">
                        <b>第 1 步：</b>在酒馆运行环境（终端）中粘贴执行上述命令；<br>
                        <b>第 2 步：</b>确认酒馆 <code>config.yaml</code> 中 <code>enableServerPlugins: true</code> 并重启酒馆。
                    </small>
                </div>
            `;

            // 绑定 Tab 切换与复制事件
            const tabBtns = guideEl.querySelectorAll('.novel-tab-btn');
            const cmdDisplay = guideEl.querySelector('#novel_cmd_display');
            const tabHint = guideEl.querySelector('#novel_tab_hint');
            const copyBtn = guideEl.querySelector('#novel_copy_cmd_btn');

            let currentCmd = cmdDocker;

            tabBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    tabBtns.forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    const tab = btn.getAttribute('data-tab');
                    if (tab === 'windows') {
                        currentCmd = cmdWindows;
                        if (tabHint) tabHint.textContent = '在酒馆根目录打开 PowerShell，粘贴执行：';
                    } else if (tab === 'linux') {
                        currentCmd = cmdLinux;
                        if (tabHint) tabHint.textContent = '在酒馆根目录 Bash 终端中粘贴执行：';
                    } else {
                        currentCmd = cmdDocker;
                        if (tabHint) tabHint.textContent = '在容器面板（群晖/1Panel/Portainer）打开“终端”，粘贴执行：';
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
        }
    }
}

jQuery(async () => {
    console.log('[AutoSaveTxt] 小说连载阅读扩展正在初始化...');

    const bootSettings = getSettings();
    const bootStatus = await checkServerPluginStatus();

    // 如果服务端未就绪，强制将 enabled 置为 false，防止首次加载时产生 404 网络请求
    if (!bootStatus.ready && bootSettings.enabled) {
        bootSettings.enabled = false;
        if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
        updateRecentStatus('idle', '未检测到服务端插件，已自动取消勾选实时连载（可直接导出整本小说）');
    }

    setTimeout(() => {
        renderSettingsUI(bootStatus);
    }, 500);

    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
            handleMessageSave(data, false);
        });

        eventSource.on(event_types.MESSAGE_SENT, (data) => {
            handleMessageSave(data, true);
        });

        if (event_types.CHAT_CHANGED) {
            eventSource.on(event_types.CHAT_CHANGED, () => {
                lastSavedSignature = { messageId: null, characterName: '', mesSnippet: '' };
                const curPreview = document.getElementById('novel_save_dir_preview');
                if (curPreview) {
                    const curSettings = getSettings();
                    const curTitle = getBookTitle(curSettings);
                    const prefix = curSettings.save_dir ? (curSettings.save_dir.replace(/[\\/]+$/, '') + '/') : 'SillyTavern/plugins/auto-save/logs/';
                    curPreview.textContent = `${prefix}${curTitle}.txt`;
                }
            });
        }
    }
});
