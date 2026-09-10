/**
 * SillyTavern 聊天记录自动存档至 TXT 服务端插件
 * 
 * 文件路径：plugins/auto-save/index.js
 * 
 * 规范说明：
 * - 采用 CommonJS 规范，导出 { init, exit, pluginName }。
 * - SillyTavern 启动时检测 plugins/ 目录并自动挂载路由于 /api/plugins/<pluginName>。
 * - 因此在 init(router) 中注册 router.post('/append') 对应的完整接口即为：
 *   POST /api/plugins/auto-save/append
 */

const fs = require('fs');
const path = require('path');

// 插件基础配置
const pluginName = 'auto-save';
const MAX_MESSAGE_BYTES = 100 * 1024; // 单条消息体 100KB 硬限制
const LOGS_DIR = path.join(__dirname, 'logs');

/**
 * 递归确保日志目录存在
 */
async function ensureLogsDir() {
    try {
        await fs.promises.mkdir(LOGS_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') {
            console.error(`[${pluginName}] 创建日志目录失败:`, err);
        }
    }
}

/**
 * 文件名安全清洗：抵御路径穿越与非法特殊字符（Windows/Linux 兼容）
 * @param {string} rawName - 原始角色名或归档目标标识
 * @returns {string} 安全的文件名（不含后缀）
 */
function sanitizeFilename(rawName) {
    if (!rawName || typeof rawName !== 'string') {
        return 'all';
    }
    // 剔除 Windows 和 Linux 文件名保留字符：\ / : * ? " < > |
    // 并替换连续的点为单个点，防止 .. 路径穿越攻击
    let safeName = rawName
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/\.{2,}/g, '_')
        .trim();

    // 长度截断，避免超出系统文件名长度限制（限制为最长 80 字符）
    safeName = safeName.slice(0, 80);

    // 如果清洗后为空字符串，兜底为 all
    return safeName || 'all';
}

/**
 * 幂等防重检查：检查目标文件末尾是否已包含相同的时间戳与正文
 * 用于防御 Swipe、连续重试或快速重生成导致的重复写入
 * @param {string} filePath - 目标日志文件绝对路径
 * @param {string} timestamp - 消息时间戳字符串
 * @param {string} mes - 消息正文
 * @returns {Promise<boolean>} true 代表已存在重复记录，应跳过
 */
async function isDuplicateTail(filePath, timestamp, mes) {
    try {
        // 如果文件不存在，肯定无重复
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || stat.size === 0) {
            return false;
        }

        // 读取末尾最多 8KB 内容比对即可
        const readSize = Math.min(stat.size, 8192);
        const buffer = Buffer.alloc(readSize);
        const fileHandle = await fs.promises.open(filePath, 'r');
        try {
            await fileHandle.read(buffer, 0, readSize, stat.size - readSize);
        } finally {
            await fileHandle.close();
        }

        const tailContent = buffer.toString('utf8');

        // 比对特征：时间戳必须完全吻合，且正文前 60 个字符吻合
        const mesPrefix = mes.slice(0, 60).trim();
        if (tailContent.includes(timestamp) && tailContent.includes(mesPrefix)) {
            return true;
        }
        return false;
    } catch (err) {
        console.warn(`[${pluginName}] 读取文件尾部检测重复失败，跳过防重比对:`, err.message);
        return false;
    }
}

/**
 * 插件初始化函数（SillyTavern 核心加载入口）
 * @param {import('express').Router} router - Express 路由实例
 */
async function init(router) {
    console.log(`[${pluginName}] 自动归档服务端插件正在初始化...`);

    // 初始化时创建日志存储文件夹
    await ensureLogsDir();

    /**
     * 接收追加写入聊天记录的请求
     * POST /api/plugins/auto-save/append
     */
    router.post('/append', async (req, res) => {
        try {
            const body = req.body;

            // 1. 请求体验证
            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: '无效的 JSON 请求体' });
            }

            const { name, mes, is_user, characterName, timestamp } = body;

            // 必填字段校验
            if (!name || typeof name !== 'string') {
                return res.status(400).json({ error: '缺少发言者名称 (name)' });
            }
            if (!mes || typeof mes !== 'string') {
                return res.status(400).json({ error: '正文内容 (mes) 不能为空' });
            }

            // 2. 单条内容大小上限校验 (100KB)
            const byteLength = Buffer.byteLength(mes, 'utf8');
            if (byteLength > MAX_MESSAGE_BYTES) {
                return res.status(413).json({
                    error: `消息体积过大 (${Math.round(byteLength / 1024)}KB)，超过单条上限 100KB`
                });
            }

            // 3. 安全计算归档文件名与绝对路径
            const targetCharName = sanitizeFilename(characterName || name);
            const targetFileName = `${targetCharName}.txt`;
            const targetFilePath = path.join(LOGS_DIR, targetFileName);

            // 格式化时间戳兜底
            const recordTimestamp = timestamp || new Date().toLocaleString();

            // 4. Swipe / 重复提交防重检查
            const duplicate = await isDuplicateTail(targetFilePath, recordTimestamp, mes);
            if (duplicate) {
                console.log(`[${pluginName}] 检测到末尾记录与当前提交相同，跳过写入: [${recordTimestamp}] ${name}`);
                return res.json({
                    success: true,
                    skipped: true,
                    reason: '检测到末尾已有相同时间与正文记录，已自动去重',
                    file: path.relative(process.cwd(), targetFilePath)
                });
            }

            // 5. 组装格式化归档文本（标准 UTF-8 追加格式）
            // 分割线长度 50
            const divider = '─'.repeat(50);
            const formattedRecord = 
`${divider}
[${recordTimestamp}] ${name}:

${mes.trim()}

`;

            // 6. 追加写入文件（强制 UTF-8 编码）
            await fs.promises.appendFile(targetFilePath, formattedRecord, { encoding: 'utf8' });

            const relPath = path.relative(process.cwd(), targetFilePath);
            console.log(`[${pluginName}] 成功归档 [${name}] 的发言 -> ${relPath}`);

            return res.json({
                success: true,
                skipped: false,
                file: relPath,
                timestamp: recordTimestamp
            });
        } catch (error) {
            console.error(`[${pluginName}] 写入聊天记录异常:`, error);
            return res.status(500).json({
                error: '写入文件失败',
                detail: error.message
            });
        }
    });

    console.log(`[${pluginName}] 插件初始化完成，归档目录：${LOGS_DIR}`);
}

/**
 * 插件退出函数（SillyTavern 关闭时触发）
 */
async function exit() {
    console.log(`[${pluginName}] 服务端插件已安全退出。`);
}

module.exports = {
    init,
    exit,
    pluginName
};
