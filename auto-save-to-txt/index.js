/**
 * SillyTavern 聊天小说连载阅读扩展 (Novel Reader Stream)
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
    enabled: true,
    include_user_dialogue: false,
    chapter_style: 'numbered',
    indent_paragraphs: true,
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

function cleanNovelText(rawText, indent = true) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText;

    text = text.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<details[^>]*>[\s\S]*?<\/details>/gi, '');
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

    text = text.replace(/<br\s*[\/]?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');

    text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    const paragraphs = text
        .split(/\r?\n+/)
        .map(p => p.trim())
        .filter(p => p.length > 0);

    if (indent) {
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

    const novelText = cleanNovelText(message.mes || '', settings.indent_paragraphs);
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

    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>📖 小说连载阅读 (Novel Stream)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="novel_save_status_badge" class="novel-alert checking">
                <i class="fa-solid fa-circle-notch fa-spin"></i>
                <div class="novel-alert-text">正在检查连载服务状态...</div>
            </div>

            <label class="checkbox_label" title="开启后，每轮 AI 回复将像小说章节一样自动写入 txt，随时用手机或阅读器翻阅">
                <input type="checkbox" id="novel_save_enabled" ${settings.enabled ? 'checked' : ''} />
                <span>开启小说自动连载</span>
            </label>

            <div class="novel-form-group">
                <span class="novel-label">章节目录风格：</span>
                <select id="novel_chapter_style" class="text_pole" style="padding: 5px 8px; border-radius: 4px; font-size: 13px;">
                    <option value="numbered" ${settings.chapter_style === 'numbered' ? 'selected' : ''}>第 X 节 · 角色名（手机阅读器可自动识别目录）</option>
                    <option value="separator" ${settings.chapter_style === 'separator' ? 'selected' : ''}>优雅分割线（* * * 散文小说连续阅读）</option>
                    <option value="dialogue" ${settings.chapter_style === 'dialogue' ? 'selected' : ''}>纯净戏剧体（角色名: 正文）</option>
                </select>
            </div>

            <label class="checkbox_label" title="开启后，你的提问与互动也会作为主角对白融入小说中；关闭则只收录纯故事正文">
                <input type="checkbox" id="novel_include_user" ${settings.include_user_dialogue ? 'checked' : ''} />
                <span>将你的发言作为主角对白融入小说</span>
            </label>

            <label class="checkbox_label" title="每段开头空两格（全角空格），符合中文出版小说排版规范">
                <input type="checkbox" id="novel_indent_paragraphs" ${settings.indent_paragraphs ? 'checked' : ''} />
                <span>段落首行空两格（中文小说规范缩进）</span>
            </label>

            <div class="novel-book-info">
                <i class="fa-solid fa-book-bookmark"></i>
                <span>小说存储于：<code>SillyTavern/plugins/auto-save/logs/&lt;角色名&gt;.txt</code><br>
                <small style="opacity: 0.8;">生成的文件可直接导入微信读书、掌阅、ReadEra 等 APP 沉浸阅读。</small></span>
            </div>

            <button id="novel_test_btn" class="menu_button">
                <i class="fa-solid fa-feather-pointed"></i> 试写一章（测试连通并生成小说小节）
            </button>
        </div>
    `;

    container.appendChild(panel);

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

    const testBtn = panel.querySelector('#novel_test_btn');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            testBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在生成小说章节...';

            const testPayload = {
                name: '故事序幕',
                mes: '夜幕低垂，微风拂过静谧的街角。\n书页翻动的沙沙声在耳边回荡，这是一部由你与 AI 共同谱写的故事。\n如果您在 txt 小说文件中看到这一段文字，说明小说连载服务已经完美就绪！',
                is_user: false,
                characterName: '我的小说试读本',
                chapterNumber: 1,
                chapterStyle: settings.chapter_style
            };

            const success = await postChapterToServer(testPayload);
            testBtn.disabled = false;
            testBtn.innerHTML = '<i class="fa-solid fa-feather-pointed"></i> 试写一章（测试连通并生成小说小节）';

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
            <div class="novel-alert-text"><b>服务插件未运行：</b>请确认已将 <code>plugins/auto-save</code> 放置于 SillyTavern 根目录并在 <code>config.yaml</code> 开启 <code>enableServerPlugins: true</code>。</div>
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
