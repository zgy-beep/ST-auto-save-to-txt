/**
 * SillyTavern 聊天记录自动存档至 TXT 前端扩展
 * 
 * 文件路径：public/scripts/extensions/third-party/ST-auto-save-to-txt/index.js
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

// 获取 SillyTavern 运行期上下文
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

// 扩展唯一标识与默认设置
const EXTENSION_NAME = 'autoSaveTxt';
const DEFAULT_SETTINGS = {
    enabled: true,                  // 扩展总开关
    save_user_messages: false,      // 是否同时保存用户消息
    split_by_character: true,       // 是否按角色名分文件（true: 角色名.txt, false: all.txt）
    strip_html: true,               // 是否剔除 HTML 标签
    filter_think_tags: true,        // 是否剔除 <think> 深度思考标签（DeepSeek 等推理模型）
    exclude_tags: 'think,details,script,style', // 需过滤排除的自定义标签列表
    include_only_tags: '',          // 仅提取指定标签内的正文
};

// 内存中维护上一条成功保存的记录特征，用于前端即时防重
let lastSavedSignature = {
    messageId: null,
    characterName: '',
    timestamp: '',
    mesSnippet: ''
};

/**
 * 获取当前扩展的配置对象
 */
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

/**
 * 格式化时间戳：YYYY-MM-DD HH:mm:ss
 */
function formatTimestamp(date = new Date()) {
    const d = (date instanceof Date && !isNaN(date)) ? date : new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 对正文文本进行标签过滤与 HTML 清洗
 */
function filterMessageContent(text, settings) {
    if (!text || typeof text !== 'string') return '';
    let result = text;

    // 1. 仅提取指定标签
    if (settings.include_only_tags && settings.include_only_tags.trim()) {
        const allowedTags = settings.include_only_tags
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);

        if (allowedTags.length > 0) {
            const extractedParts = [];
            for (const tag of allowedTags) {
                const tagRegex = new RegExp(`<(${tag})[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
                let match;
                while ((match = tagRegex.exec(result)) !== null) {
                    if (match[2]) extractedParts.push(match[2].trim());
                }
            }
            if (extractedParts.length > 0) {
                result = extractedParts.join('\n\n');
            }
        }
    }

    // 2. 过滤深度思考标签 <think>...</think>
    if (settings.filter_think_tags) {
        result = result.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');
    }

    // 3. 过滤自定义排除标签
    if (settings.exclude_tags && settings.exclude_tags.trim()) {
        const excludeList = settings.exclude_tags
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);

        for (const tag of excludeList) {
            if (tag.toLowerCase() === 'think' && settings.filter_think_tags) continue;
            const reg = new RegExp(`<(${tag})[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');
            result = result.replace(reg, '');
        }
    }

    // 4. 剔除普通 HTML 标签（保留纯文本）
    if (settings.strip_html) {
        result = result.replace(/<br\s*[\/]?>/gi, '\n');
        result = result.replace(/<\/p>/gi, '\n');
        result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '');
        result = result
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }

    return result.trim();
}

/**
 * 检查服务端插件运行状态
 */
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

        // 400 代表路由通畅且进入了插件逻辑
        if (response.status === 400) {
            return { ready: true };
        }
        if (response.status === 404) {
            return { ready: false, reason: '404' };
        }
        return { ready: response.ok, reason: String(response.status) };
    } catch (err) {
        return { ready: false, reason: err.message };
    }
}

/**
 * 发送保存请求至后端 Node.js 插件
 */
async function postAppendToServer(payload) {
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
            const errText = await response.text().catch(() => '');
            console.warn(`[AutoSaveTxt] 服务器返回状态码 ${response.status}: ${errText}`);
            if (window.toastr) {
                window.toastr.warning(`自动存档失败 (${response.status})：请确认 config.yaml 中 enableServerPlugins: true`, 'Auto Save to TXT');
            }
            return false;
        }

        const data = await response.json().catch(() => ({}));
        if (data.skipped) {
            console.log(`[AutoSaveTxt] 检测到重复记录，已跳过存档：${data.reason || ''}`);
        } else {
            console.log(`[AutoSaveTxt] 成功归档消息至：${data.file || 'txt 文件'}`);
        }
        return true;
    } catch (error) {
        console.warn('[AutoSaveTxt] 请求后端插件发生网络异常，请确认服务器插件已启用:', error);
        if (window.toastr) {
            window.toastr.warning('自动存档失败：无法连接服务端插件，请确认已将 plugins/auto-save 放入 SillyTavern 并启用', 'Auto Save to TXT');
        }
        return false;
    }
}

/**
 * 处理消息并执行保存逻辑
 */
async function handleMessageSave(messageIdOrData, isFromUser = false) {
    const settings = getSettings();
    if (!settings.enabled) return;

    if (isFromUser && !settings.save_user_messages) {
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

    if (message.is_user && !settings.save_user_messages) {
        return;
    }

    let speakerName = message.name || (message.is_user ? 'User' : 'Assistant');

    let characterName = 'all';
    if (settings.split_by_character) {
        let currentCardName = '';
        const charList = ctx.characters || characters_raw || window.characters || [];
        const chid = (typeof ctx.this_chid !== 'undefined') ? ctx.this_chid : (typeof this_chid_raw !== 'undefined' ? this_chid_raw : window.this_chid);
        if (Array.isArray(charList) && typeof chid !== 'undefined' && charList[chid]) {
            currentCardName = charList[chid].name;
        }
        characterName = speakerName || currentCardName || 'default';
    }

    const rawMes = message.mes || '';
    const cleanMes = filterMessageContent(rawMes, settings);
    if (!cleanMes) {
        return;
    }

    let timestamp = message.send_date ? formatTimestamp(new Date(message.send_date)) : formatTimestamp();

    const mesSnippet = cleanMes.slice(0, 100);
    if (
        lastSavedSignature.messageId === messageIndex &&
        lastSavedSignature.characterName === characterName &&
        lastSavedSignature.mesSnippet === mesSnippet
    ) {
        console.log('[AutoSaveTxt] 本地特征比对与上次保存一致，忽略重复事件');
        return;
    }

    const payload = {
        name: speakerName,
        mes: cleanMes,
        is_user: !!message.is_user,
        characterName: characterName,
        timestamp: timestamp,
        messageId: messageIndex
    };

    const ok = await postAppendToServer(payload);
    if (ok) {
        lastSavedSignature = {
            messageId: messageIndex,
            characterName: characterName,
            timestamp: timestamp,
            mesSnippet: mesSnippet
        };
    }
}

/**
 * 渲染扩展的设置面板 UI
 */
async function renderSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (!container) {
        console.warn('[AutoSaveTxt] 未找到扩展设置容器 #extensions_settings，稍后重试');
        return;
    }

    let panel = document.getElementById('auto-save-to-txt-settings');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'auto-save-to-txt-settings';
    panel.className = 'inline-drawer';

    panel.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>自动存档到 TXT (Auto Save to TXT)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <!-- 服务端状态指示徽章 -->
            <div id="auto_save_status_badge" class="auto-save-alert" style="background: rgba(128,128,128,0.15); color: var(--SmartThemeEmColor, #eee);">
                <i class="fa-solid fa-circle-notch fa-spin"></i>
                <div class="auto-save-alert-body">正在检测服务端插件连通性...</div>
            </div>

            <!-- 扩展总开关 -->
            <label class="checkbox_label" title="开启后，每次 AI 回复完成后自动保存至服务端">
                <input type="checkbox" id="auto_save_enabled" ${settings.enabled ? 'checked' : ''} />
                <span>启用自动存档</span>
            </label>

            <!-- 保存用户消息开关 -->
            <label class="checkbox_label" title="是否在用户每次发送消息后也记录到 txt 文件">
                <input type="checkbox" id="auto_save_user_messages" ${settings.save_user_messages ? 'checked' : ''} />
                <span>同时保存用户消息</span>
            </label>

            <!-- 按角色名分文件 -->
            <label class="checkbox_label" title="开启后按角色名分别创建 txt 文件；关闭则全部追加至 all.txt">
                <input type="checkbox" id="auto_save_split_by_character" ${settings.split_by_character ? 'checked' : ''} />
                <span>按角色名分文件（开启: [角色名].txt，关闭: all.txt）</span>
            </label>

            <!-- 剔除 HTML 标签 -->
            <label class="checkbox_label" title="保存时自动移除 HTML 标签，仅保留纯文本">
                <input type="checkbox" id="auto_save_strip_html" ${settings.strip_html ? 'checked' : ''} />
                <span>剔除 HTML 标签</span>
            </label>

            <!-- 剔除推理思考标签 -->
            <label class="checkbox_label" title="过滤 DeepSeek R1 等推理模型的 <think>...</think> 内部思考正文">
                <input type="checkbox" id="auto_save_filter_think" ${settings.filter_think_tags ? 'checked' : ''} />
                <span>剔除模型思考标签 (&lt;think&gt;...&lt;/think&gt;)</span>
            </label>

            <!-- 自定义排除标签 -->
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <span class="auto-save-input-desc">排除的标签（逗号分隔，同时排除标签及内部内容）：</span>
                <input type="text" id="auto_save_exclude_tags" class="text_pole" value="${settings.exclude_tags || ''}" placeholder="例如: think,details,script" />
            </div>

            <!-- 仅保留指定标签内容（可选） -->
            <div style="display: flex; flex-direction: column; gap: 4px;">
                <span class="auto-save-input-desc">仅提取指定标签（可选，留空则提取整篇正文）：</span>
                <input type="text" id="auto_save_include_tags" class="text_pole" value="${settings.include_only_tags || ''}" placeholder="例如: response（留空代表不限制）" />
            </div>

            <!-- 存储位置提示 -->
            <div class="auto-save-path-hint">
                <i class="fa-solid fa-folder-open"></i> 文件保存路径：<code>SillyTavern/plugins/auto-save/logs/</code>
            </div>

            <!-- 立即测试保存按钮 -->
            <div style="margin-top: 4px;">
                <button id="auto_save_test_btn" class="menu_button">
                    <i class="fa-solid fa-floppy-disk"></i> 立即测试保存（写入一条测试记录）
                </button>
            </div>
        </div>
    `;

    container.appendChild(panel);

    // 折叠展开交互（ST 若未自带委托则做容错支持）
    const toggleHeader = panel.querySelector('.inline-drawer-toggle');
    const drawerContent = panel.querySelector('.inline-drawer-content');
    const drawerIcon = panel.querySelector('.inline-drawer-icon');
    toggleHeader.addEventListener('click', (e) => {
        // 如果 ST 原生已绑定，则原生会触发 slideToggle；做防重复兼容
        setTimeout(() => {
            const isVisible = $(drawerContent).is(':visible');
            drawerIcon.classList.toggle('down', isVisible);
        }, 50);
    });

    // 绑定设置项事件
    const bindCheckbox = (id, key) => {
        const el = panel.querySelector(`#${id}`);
        if (el) {
            el.addEventListener('change', (e) => {
                settings[key] = e.target.checked;
                if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            });
        }
    };

    const bindInput = (id, key) => {
        const el = panel.querySelector(`#${id}`);
        if (el) {
            el.addEventListener('input', (e) => {
                settings[key] = e.target.value.trim();
                if (typeof saveSettingsDebounced === 'function') saveSettingsDebounced();
            });
        }
    };

    bindCheckbox('auto_save_enabled', 'enabled');
    bindCheckbox('auto_save_user_messages', 'save_user_messages');
    bindCheckbox('auto_save_split_by_character', 'split_by_character');
    bindCheckbox('auto_save_strip_html', 'strip_html');
    bindCheckbox('auto_save_filter_think', 'filter_think_tags');
    bindInput('auto_save_exclude_tags', 'exclude_tags');
    bindInput('auto_save_include_tags', 'include_only_tags');

    // 绑定测试按钮
    const testBtn = panel.querySelector('#auto_save_test_btn');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            testBtn.disabled = true;
            testBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中...';
            
            const testPayload = {
                name: 'AutoSaveTester',
                mes: '这是一条由 SillyTavern 前端扩展发起的连通性测试消息。\n如果您在 txt 文件中看到本内容，说明自动归档插件工作一切正常！',
                is_user: false,
                characterName: settings.split_by_character ? 'TestCharacter' : 'all',
                timestamp: formatTimestamp(),
                messageId: 999999
            };

            const success = await postAppendToServer(testPayload);
            testBtn.disabled = false;
            testBtn.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> 立即测试保存（写入一条测试记录）';

            if (success) {
                if (window.toastr) {
                    window.toastr.success('测试消息写入成功！请查看 plugins/auto-save/logs/ 目录。', 'Auto Save to TXT');
                } else {
                    alert('测试消息写入成功！');
                }
            }
        });
    }

    // 异步检测服务端插件连通性
    const badge = panel.querySelector('#auto_save_status_badge');
    const status = await checkServerPluginStatus();
    if (status.ready) {
        badge.className = 'auto-save-alert success';
        badge.removeAttribute('style');
        badge.innerHTML = `
            <i class="fa-solid fa-circle-check"></i>
            <div class="auto-save-alert-body">
                <b>服务端插件已就绪：</b>每次 AI 回复完成后将自动追加归档至 TXT。
            </div>
        `;
    } else {
        badge.className = 'auto-save-alert warning';
        badge.removeAttribute('style');
        badge.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation"></i>
            <div class="auto-save-alert-body">
                <b>服务端插件未运行：</b>请将本扩展目录中的 <code>plugins/auto-save</code> 复制到 SillyTavern 根目录下的 <code>plugins/</code>，并在 <code>config.yaml</code> 中设置 <code>enableServerPlugins: true</code> 后重启终端服务。
            </div>
        `;
    }
}

/**
 * 扩展入口初始化
 */
jQuery(async () => {
    console.log('[AutoSaveTxt] 自动存档扩展正在加载...');

    getSettings();

    setTimeout(() => {
        renderSettingsUI();
    }, 500);

    // 注册事件监听器
    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
            handleMessageSave(data, false);
        });

        eventSource.on(event_types.MESSAGE_SENT, (data) => {
            handleMessageSave(data, true);
        });
        console.log('[AutoSaveTxt] 事件监听器已就绪 (MESSAGE_RECEIVED & MESSAGE_SENT)');
    } else {
        setTimeout(() => {
            const retryCtx = getStContext();
            if (retryCtx.eventSource && retryCtx.event_types) {
                retryCtx.eventSource.on(retryCtx.event_types.MESSAGE_RECEIVED, (d) => handleMessageSave(d, false));
                retryCtx.eventSource.on(retryCtx.event_types.MESSAGE_SENT, (d) => handleMessageSave(d, true));
                console.log('[AutoSaveTxt] 延迟绑定成功！');
            }
        }, 2000);
    }
});
