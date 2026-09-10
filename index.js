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
    enabled: true,                // 小说连载总开关
    include_user_dialogue: false, // 是否将主角（你的互动）也以对话形式写入小说
    chapter_style: 'numbered',    // 章节标题样式: 'numbered' (第 1 节 · 角色名), 'separator' (* * *), 'dialogue' (【角色名】)
    indent_paragraphs: true,      // 自动段落首行空两格（中文小说规范排版）
    include_tags: '',             // 【白名单】：指定正文标签（留空代表整篇保留；填入如 story 则只提取 <story>...</story>）
    exclude_tags: 'status,memory,details,variables,analysis,ooc,note,draft,system,log', // 【黑名单】：需剔除的标签块内容
};

let lastSavedSignature = {
    messageId: null,
    characterName: '',
    mesSnippet: ''
};

function getSettings() {
    const extSettings = ctx.extension_settings || ext_settings_raw || window.extension_settings || {};
    if (!extSettings[EXTENSION_NAME]) {
        extSettings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    } else {
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (extSettings[EXTENSION_NAME][key] === undefined) {
                extSettings[EXTENSION_NAME][key] = DEFAULT_SETTINGS[key];
            }
        }
    }
    return extSettings[EXTENSION_NAME];
}

const INLINE_TAGS = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'span', 'sub', 'sup', 'small', 'del', 'mark']);

/**
 * 通用小说正文排版与全能标签清洗引擎
 */
function cleanNovelText(rawText, settings = {}) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText;

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

async function checkServerPluginStatus() {
    try {
        const headers = (typeof getRequestHeaders === 'function') 
            ? getRequestHeaders() 
            : { 'Content-Type': 'application/json' };

        const response = await fetch('/api/plugins/auto-save/append', {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({}),
        });

        return response.status === 400 ? { ready: true } : { ready: false, code: response.status };
    } catch (err) {
        return { ready: false, code: err.message };
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
            console.warn(`[AutoSaveTxt] 写入失败 (${response.status})`);
            return false;
        }

        const data = await response.json().catch(() => ({}));
        if (!data.skipped) {
            console.log(`[AutoSaveTxt] 📖 新章节已融入小说: ${data.file || ''}`);
        }
        return true;
    } catch (error) {
        console.warn('[AutoSaveTxt] 连接服务端插件异常:', error);
        return false;
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

    let bookTitle = '我的小说连载';
    const charList = ctx.characters || characters_raw || window.characters || [];
    const chid = (typeof ctx.this_chid !== 'undefined') ? ctx.this_chid : (typeof this_chid_raw !== 'undefined' ? this_chid_raw : window.this_chid);
    if (Array.isArray(charList) && typeof chid !== 'undefined' && charList[chid]?.name) {
        bookTitle = charList[chid].name;
    } else if (speakerName && speakerName !== '你') {
        bookTitle = speakerName;
    }

    const novelText = cleanNovelText(message.mes || '', settings);
    if (!novelText) return;

    const mesSnippet = novelText.slice(0, 80);
    if (
        lastSavedSignature.messageId === messageIndex &&
        lastSavedSignature.characterName === bookTitle &&
        lastSavedSignature.mesSnippet === mesSnippet
    ) {
        return;
    }

    const chapterNumber = chatLog.filter((m, idx) => idx <= messageIndex && (!m.is_user || settings.include_user_dialogue)).length;

    const payload = {
        name: speakerName,
        mes: novelText,
        is_user: !!message.is_user,
        characterName: bookTitle,
        chapterNumber: chapterNumber || 1,
        chapterStyle: settings.chapter_style || 'numbered'
    };

    const ok = await postChapterToServer(payload);
    if (ok) {
        lastSavedSignature = {
            messageId: messageIndex,
            characterName: bookTitle,
            mesSnippet: mesSnippet
        };
    }
}

async function renderSettingsUI() {
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
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>小说连载阅读 (Novel Stream)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content" style="display: none;">
            <div class="novel-drawer-inner">
                <!-- 连通性提示 -->
                <div id="novel_save_status_badge" class="novel-alert checking">
                    <i class="fa-solid fa-circle-notch fa-spin"></i>
                    <div class="novel-alert-text">正在检查连载服务状态...</div>
                </div>

                <!-- 主开关 -->
                <label class="checkbox_label" title="开启后，每轮 AI 回复将像小说章节一样自动写入 txt，随时用手机或阅读器翻阅">
                    <input type="checkbox" id="novel_save_enabled" ${settings.enabled ? 'checked' : ''} />
                    <span>开启小说自动连载</span>
                </label>

                <!-- 章节排版模式 -->
                <div class="novel-form-group">
                    <span class="novel-label">章节目录风格：</span>
                    <select id="novel_chapter_style" class="text_pole" style="padding: 5px 8px; border-radius: 4px; font-size: 13px;">
                        <option value="numbered" ${settings.chapter_style === 'numbered' ? 'selected' : ''}>第 X 节 · 角色名（手机阅读器可自动识别目录）</option>
                        <option value="separator" ${settings.chapter_style === 'separator' ? 'selected' : ''}>优雅分割线（* * * 散文小说连续阅读）</option>
                        <option value="dialogue" ${settings.chapter_style === 'dialogue' ? 'selected' : ''}>纯净戏剧体（角色名: 正文）</option>
                    </select>
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

                <!-- 存储位置说明 -->
                <div class="novel-book-info">
                    <i class="fa-solid fa-book-bookmark"></i>
                    <span>实时连载保存于：<code>SillyTavern/plugins/auto-save/logs/&lt;角色名&gt;.txt</code><br>
                    <small style="opacity: 0.8;">若未配置服务端插件，也可随时点击下方<b>“导出整本小说”</b>直接下载。</small></span>
                </div>

                <!-- 操作按钮组 -->
                <div style="display: flex; gap: 8px; margin-top: 4px;">
                    <button id="novel_export_all_btn" class="menu_button" style="flex: 1; background: var(--SmartThemeQuoteColor, #2980b9); color: #fff;" title="即使没有安装服务端插件，也可以一键将当前所有聊天按小说章节排版并下载为 txt！">
                        <i class="fa-solid fa-download"></i> 导出整本小说 TXT
                    </button>
                    <button id="novel_test_btn" class="menu_button" style="flex: 1;" title="测试服务端插件连通性">
                        <i class="fa-solid fa-feather-pointed"></i> 试写一章
                    </button>
                </div>
            </div>
        </div>
    `;

    container.appendChild(panel);

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

    bindCheck('novel_save_enabled', 'enabled');
    bindCheck('novel_include_user', 'include_user_dialogue');
    bindCheck('novel_indent_paragraphs', 'indent_paragraphs');

    const selectStyle = panel.querySelector('#novel_chapter_style');
    if (selectStyle) {
        selectStyle.addEventListener('change', (e) => {
            settings.chapter_style = e.target.value;
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

    // 纯前端一键导出整本小说
    const exportBtn = panel.querySelector('#novel_export_all_btn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const chatLog = (Array.isArray(ctx.chat)) ? ctx.chat : (chat_raw || window.chat || []);
            if (!chatLog || chatLog.length === 0) {
                if (window.toastr) window.toastr.info('当前没有任何聊天内容可供导出。', '小说连载');
                return;
            }

            let bookTitle = '我的小说连载';
            const charList = ctx.characters || characters_raw || window.characters || [];
            const chid = (typeof ctx.this_chid !== 'undefined') ? ctx.this_chid : (typeof this_chid_raw !== 'undefined' ? this_chid_raw : window.this_chid);
            if (Array.isArray(charList) && typeof chid !== 'undefined' && charList[chid]?.name) {
                bookTitle = charList[chid].name;
            }

            let novelText = `《${bookTitle}》\n\n`;
            let chapterCount = 0;

            for (const msg of chatLog) {
                if (msg.is_user && !settings.include_user_dialogue) continue;
                const cleanMes = cleanNovelText(msg.mes || '', settings);
                if (!cleanMes) continue;

                chapterCount++;
                const speaker = msg.name || (msg.is_user ? '你' : '旁白');
                if (settings.chapter_style === 'separator') {
                    novelText += `* * *\n\n${cleanMes}\n\n\n`;
                } else if (settings.chapter_style === 'dialogue') {
                    novelText += `【${speaker}】\n\n${cleanMes}\n\n\n`;
                } else {
                    novelText += `第 ${chapterCount} 节 · ${speaker}\n\n${cleanMes}\n\n\n`;
                }
            }

            if (chapterCount === 0) {
                if (window.toastr) window.toastr.warning('没有可导出的有效剧情章节。', '小说连载');
                return;
            }

            const blob = new Blob([novelText], { type: 'text/plain;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${bookTitle}.txt`;
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
                chapterStyle: settings.chapter_style
            };

            const success = await postChapterToServer(testPayload);
            testBtn.disabled = false;
            testBtn.innerHTML = '<i class="fa-solid fa-feather-pointed"></i> 试写一章';

            if (success) {
                if (window.toastr) {
                    window.toastr.success('试读章节已生成！请查看 plugins/auto-save/logs/ 目录下的 txt 文件', '小说连载');
                } else {
                    alert('试读章节已生成！');
                }
            }
        });
    }

    const badge = panel.querySelector('#novel_save_status_badge');
    const status = await checkServerPluginStatus();
    if (status.ready) {
        badge.className = 'novel-alert success';
        badge.innerHTML = `
            <i class="fa-solid fa-circle-check"></i>
            <div class="novel-alert-text"><b>连载服务已就绪：</b>每次 AI 回复将自动像小说一样顺畅续写。</div>
        `;
    } else {
        badge.className = 'novel-alert warning';
        badge.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation"></i>
            <div class="novel-alert-text"><b>服务插件未运行：</b>实时追加需配置服务端；或可直接点击下方<b>“导出整本小说”</b>一键下载。</div>
        `;
    }
}

jQuery(async () => {
    console.log('[AutoSaveTxt] 小说连载阅读扩展正在初始化...');

    getSettings();

    setTimeout(() => {
        renderSettingsUI();
    }, 500);

    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
            handleMessageSave(data, false);
        });

        eventSource.on(event_types.MESSAGE_SENT, (data) => {
            handleMessageSave(data, true);
        });
    }
});
