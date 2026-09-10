/**
 * SillyTavern 聊天记录自动存档至 TXT 前端扩展
 * 
 * 文件路径：public/scripts/extensions/third-party/auto-save-to-txt/index.js
 * 
 * 模块导入路径说明：
 * 1. 标准导入（由用户指令指定）：
 *    import { eventSource, event_types, getRequestHeaders, extension_settings, saveSettingsDebounced } from '../../../script.js';
 * 2. 备选写法（若扩展安装在 public/scripts/extensions/third-party/<name>/，根据标准目录层级可能需向上 4 层）：
 *    import { eventSource, event_types, getRequestHeaders, extension_settings, saveSettingsDebounced } from '../../../../script.js';
 * 3. 动态兼容：代码内同时做了全局挂载对象与 window.SillyTavern.getContext() 的兜底适配。
 */

import {
    eventSource,
    event_types,
    getRequestHeaders,
    extension_settings,
    saveSettingsDebounced,
    chat,
    characters,
    this_chid
} from '../../../script.js';

// 扩展唯一标识与默认设置
const EXTENSION_NAME = 'autoSaveTxt';
const DEFAULT_SETTINGS = {
    enabled: true,                  // 扩展总开关
    save_user_messages: false,      // 是否同时保存用户消息
    split_by_character: true,       // 是否按角色名分文件（true: 角色名.txt, false: all.txt）
    strip_html: true,               // 是否剔除 HTML 标签
    filter_think_tags: true,        // 是否剔除 <think> 深度思考标签（常用在 DeepSeek 等推理模型）
    exclude_tags: 'think,details,script,style', // 需过滤排除的自定义标签列表（逗号分隔）
    include_only_tags: '',          // 仅提取指定标签内的正文（为空则保留全部有效正文）
};

// 内存中维护上一条成功保存的记录特征，用于前端即时防重（防 Swipe/重新生成连续触发）
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
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...DEFAULT_SETTINGS };
    } else {
        // 补齐可能新增的配置项
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
            if (extension_settings[EXTENSION_NAME][key] === undefined) {
                extension_settings[EXTENSION_NAME][key] = DEFAULT_SETTINGS[key];
            }
        }
    }
    return extension_settings[EXTENSION_NAME];
}

/**
 * 格式化时间戳为本地标准可读字符串：YYYY-MM-DD HH:mm:ss
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
 * @param {string} text - 原始正文
 * @param {object} settings - 当前配置
 * @returns {string} 清洗后的正文
 */
function filterMessageContent(text, settings) {
    if (!text || typeof text !== 'string') return '';
    let result = text;

    // 1. 若配置了仅包含指定标签（例如只提取某特定标记内的输出）
    if (settings.include_only_tags && settings.include_only_tags.trim()) {
        const allowedTags = settings.include_only_tags
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);

        if (allowedTags.length > 0) {
            const extractedParts = [];
            for (const tag of allowedTags) {
                // 匹配形如 <tag ...>内容</tag>
                const tagRegex = new RegExp(`<(${tag})[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
                let match;
                while ((match = tagRegex.exec(result)) !== null) {
                    if (match[2]) extractedParts.push(match[2].trim());
                }
            }
            // 若匹配到了内容，则仅使用提取到的内容；若未匹配到则按原样兜底
            if (extractedParts.length > 0) {
                result = extractedParts.join('\n\n');
            }
        }
    }

    // 2. 过滤深度思考标签 <think>...</think>（DeepSeek R1 / 推理模型特有）
    if (settings.filter_think_tags) {
        result = result.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');
    }

    // 3. 过滤自定义排除标签（包含标签及其包裹内容）
    if (settings.exclude_tags && settings.exclude_tags.trim()) {
        const excludeList = settings.exclude_tags
            .split(',')
            .map(t => t.trim())
            .filter(Boolean);

        for (const tag of excludeList) {
            if (tag.toLowerCase() === 'think' && settings.filter_think_tags) continue; // 已处理
            const reg = new RegExp(`<(${tag})[^>]*>[\\s\\S]*?<\\/\\1>`, 'gi');
            result = result.replace(reg, '');
        }
    }

    // 4. 剔除普通 HTML 标签（保留纯文本），如 <div>, <span>, <br> 等
    if (settings.strip_html) {
        // 先将常见的换行标签替换为真换行
        result = result.replace(/<br\s*[\/]?>/gi, '\n');
        result = result.replace(/<\/p>/gi, '\n');
        // 剔除所有剩余的 HTML 尖括号标签
        result = result.replace(/<\/?[a-zA-Z][^>]*>/g, '');
        // 反转义常见的 HTML 实体
        result = result
            .replace(/&nbsp;/g, ' ')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'");
    }

    // 清理多余空行与首尾空白
    return result.trim();
}

/**
 * 发送保存请求至后端 Node.js 插件
 * 捕获所有异常并弹出友好提示，绝不影响 SillyTavern 聊天主流程
 */
async function postAppendToServer(payload) {
    try {
        const headers = (typeof getRequestHeaders === 'function') 
            ? getRequestHeaders() 
            : { 'Content-Type': 'application/json' };

        // 确保请求头包含 JSON 类型
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
                window.toastr.warning(`自动存档失败 (${response.status})：请检查服务端插件是否开启`, 'Auto Save to TXT');
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
        // 网络错误或插件接口不可用（例如 config.yaml 中 enableServerPlugins: false）
        console.warn('[AutoSaveTxt] 请求后端插件发生网络异常，请确认服务器插件已启用:', error);
        if (window.toastr) {
            window.toastr.warning('自动存档失败：无法连接服务端插件，请确认 config.yaml 已启用插件功能', 'Auto Save to TXT');
        }
        return false;
    }
}

/**
 * 处理消息并执行保存逻辑
 * @param {number|object} messageIdOrData - 事件派发带入的 messageId 或消息对象
 * @param {boolean} isFromUser - 是否来自用户发送事件
 */
async function handleMessageSave(messageIdOrData, isFromUser = false) {
    const settings = getSettings();
    if (!settings.enabled) return; // 总开关未开启直接返回

    // 若当前为用户消息，但配置中未勾选保存用户消息，则忽略
    if (isFromUser && !settings.save_user_messages) {
        return;
    }

    // 获取当前聊天记录数组
    const chatLog = (Array.isArray(chat)) ? chat : (window.SillyTavern?.getContext?.()?.chat || []);
    if (!chatLog || chatLog.length === 0) return;

    // 解析 messageId
    let messageIndex = -1;
    if (typeof messageIdOrData === 'number') {
        messageIndex = messageIdOrData;
    } else if (messageIdOrData && typeof messageIdOrData.messageId === 'number') {
        messageIndex = messageIdOrData.messageId;
    } else {
        messageIndex = chatLog.length - 1; // 兜底为最后一条
    }

    const message = chatLog[messageIndex];
    if (!message) return;

    // 检查是否仅保存 AI 消息（如果是用户消息且没有开启保存用户，再次拦截保障）
    if (message.is_user && !settings.save_user_messages) {
        return;
    }

    // 发言者名称处理：兼容群聊实际发言者名字
    let speakerName = message.name || (message.is_user ? 'User' : 'Assistant');

    // 归档目标角色名确定（单聊 vs 群聊）
    let characterName = 'all';
    if (settings.split_by_character) {
        // 优先取消息本身关联的角色名称，其次取当前选中的角色卡片名称
        let currentCardName = '';
        if (Array.isArray(characters) && typeof this_chid !== 'undefined' && characters[this_chid]) {
            currentCardName = characters[this_chid].name;
        }
        characterName = speakerName || currentCardName || 'default';
    }

    // 提取正文并执行标签过滤清洗
    const rawMes = message.mes || '';
    const cleanMes = filterMessageContent(rawMes, settings);
    if (!cleanMes) {
        console.log('[AutoSaveTxt] 正文清洗后为空，跳过存档');
        return;
    }

    // 时间戳获取（优先使用消息记录的时间，其次使用本地当前时间）
    let timestamp = message.send_date ? formatTimestamp(new Date(message.send_date)) : formatTimestamp();

    // 防重比对：针对 swipe 和重新生成导致的多重触发
    // 如果同一 messageId、同一发言者且正文前 100 字符相同，说明是无变更的重复触发，直接跳过
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
        // 记录特征
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
function renderSettingsUI() {
    const settings = getSettings();
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    // 防止重复注入 UI
    let panel = document.getElementById('auto-save-to-txt-settings');
    if (panel) panel.remove();

    panel = document.createElement('div');
    panel.id = 'auto-save-to-txt-settings';
    panel.className = 'auto-save-settings-box';

    panel.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>自动存档到 TXT (Auto Save to TXT)</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content" style="display: flex; flex-direction: column; gap: 10px; padding: 10px 5px;">
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
                    <span style="font-size: 12px; opacity: 0.85;">排除的标签（逗号分隔，同时排除标签及内部内容）：</span>
                    <input type="text" id="auto_save_exclude_tags" class="text_pole" value="${settings.exclude_tags || ''}" placeholder="例如: think,details,script" />
                </div>

                <!-- 仅保留指定标签内容（可选） -->
                <div style="display: flex; flex-direction: column; gap: 4px;">
                    <span style="font-size: 12px; opacity: 0.85;">仅提取指定标签（可选，留空则提取整篇正文）：</span>
                    <input type="text" id="auto_save_include_tags" class="text_pole" value="${settings.include_only_tags || ''}" placeholder="例如: response（留空代表不限制）" />
                </div>

                <!-- 存储位置提示 -->
                <div class="auto-save-path-hint" style="font-size: 12px; opacity: 0.75; padding: 6px; border-left: 3px solid var(--SmartThemeQuoteColor, #4a90e2); background: rgba(0,0,0,0.15);">
                    <i class="fa-solid fa-folder-open"></i> 文件保存路径：<code>SillyTavern/plugins/auto-save/logs/</code>
                </div>

                <!-- 立即测试保存按钮 -->
                <div style="margin-top: 5px;">
                    <button id="auto_save_test_btn" class="menu_button">
                        <i class="fa-solid fa-floppy-disk"></i> 立即测试保存（写入一条测试记录）
                    </button>
                </div>
            </div>
        </div>
    `;

    container.appendChild(panel);

    // 折叠菜单展开/收起点击事件
    const toggleHeader = panel.querySelector('.inline-drawer-toggle');
    const drawerContent = panel.querySelector('.inline-drawer-content');
    const drawerIcon = panel.querySelector('.inline-drawer-icon');
    toggleHeader.addEventListener('click', () => {
        const isHidden = drawerContent.style.display === 'none';
        drawerContent.style.display = isHidden ? 'flex' : 'none';
        drawerIcon.classList.toggle('down', isHidden);
    });

    // 绑定设置项事件
    const bindCheckbox = (id, key) => {
        const el = panel.querySelector(`#${id}`);
        if (el) {
            el.addEventListener('change', (e) => {
                settings[key] = e.target.checked;
                saveSettingsDebounced();
            });
        }
    };

    const bindInput = (id, key) => {
        const el = panel.querySelector(`#${id}`);
        if (el) {
            el.addEventListener('input', (e) => {
                settings[key] = e.target.value.trim();
                saveSettingsDebounced();
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
}

/**
 * 扩展初始化入口
 */
jQuery(async () => {
    console.log('[AutoSaveTxt] 自动存档扩展正在加载...');

    // 确保设置已注入
    getSettings();

    // 渲染 UI 设置面板
    renderSettingsUI();

    // 监听 AI 回复完成事件
    if (eventSource && event_types) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (data) => {
            handleMessageSave(data, false);
        });

        // 监听用户发送消息事件
        eventSource.on(event_types.MESSAGE_SENT, (data) => {
            handleMessageSave(data, true);
        });
        console.log('[AutoSaveTxt] 事件监听器注册完毕 (MESSAGE_RECEIVED & MESSAGE_SENT)');
    } else {
        console.warn('[AutoSaveTxt] 无法获取 eventSource 或 event_types，事件监听未启动');
    }
});
