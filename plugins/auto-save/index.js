/**
 * SillyTavern 聊天小说连载阅读服务端插件
 * 
 * 文件路径：plugins/auto-save/index.js
 * 
 * 核心功能：
 * - 接收前端章节内容，以高雅、规范的小说排版格式追加写入 TXT。
 * - 格式完美适配微信读书、掌阅、ReadEra、多看等主流阅读器，自动识别“第 X 节”为可点击的目录。
 * - 严格防路径穿越、100KB 容量防护与末尾条目防重复机制。
 */

const fs = require('fs');
const path = require('path');

const pluginName = 'auto-save';
const MAX_MESSAGE_BYTES = 100 * 1024; // 100KB
const LOGS_DIR = path.join(__dirname, 'logs');

async function ensureLogsDir() {
    try {
        await fs.promises.mkdir(LOGS_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') {
            console.error(`[${pluginName}] 创建小说存储目录失败:`, err);
        }
    }
}

function sanitizeFilename(rawName) {
    if (!rawName || typeof rawName !== 'string') {
        return '我的小说连载';
    }
    let safeName = rawName
        .replace(/[/\\?%*:|"<>]/g, '_')
        .replace(/\.{2,}/g, '_')
        .trim();
    safeName = safeName.slice(0, 80);
    return safeName || '我的小说连载';
}

/**
 * 解析并校验目标存储文件夹
 * 针对云服务器(Linux)场景提供友好拦截与提示
 */
function resolveTargetDirectory(customDir) {
    if (!customDir || typeof customDir !== 'string' || !customDir.trim()) {
        return { success: true, dir: LOGS_DIR };
    }
    const trimmed = customDir.trim();

    // 如果服务端运行在 Linux/Unix 环境，而前端传递了 Windows 盘符路径（如 D:\... 或 C:\...）
    if (process.platform !== 'win32' && /^[a-zA-Z]:/i.test(trimmed)) {
        return {
            success: false,
            error: `当前酒馆运行在云服务器(Linux/Docker)中，无法直接访问您本地电脑的盘符路径（"${trimmed}"）。请留空使用默认目录，或填写服务器内部有效路径（如 /mnt/...），或使用前端【导出整本小说 TXT】。`
        };
    }

    const resolved = path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
    return { success: true, dir: resolved };
}

/**
 * 防重复写入检查：防止 Swipe 或重新生成在小说末尾连续堆叠相同段落
 */
async function isDuplicateTail(filePath, mes) {
    try {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || stat.size === 0) {
            return false;
        }

        const readSize = Math.min(stat.size, 4096);
        const buffer = Buffer.alloc(readSize);
        const fileHandle = await fs.promises.open(filePath, 'r');
        try {
            await fileHandle.read(buffer, 0, readSize, stat.size - readSize);
        } finally {
            await fileHandle.close();
        }

        const tailContent = buffer.toString('utf8');
        const mesSnippet = mes.slice(0, 60).trim();
        return tailContent.includes(mesSnippet);
    } catch (err) {
        return false;
    }
}

/**
 * 格式化为小说章节
 */
function formatNovelChapter({ name, mes, is_user, chapterNumber, chapterStyle }) {
    const cleanMes = mes.trim();
    const num = chapterNumber || 1;

    switch (chapterStyle) {
        case 'separator':
            // 散文流分割体
            return `* * *\n\n${cleanMes}\n\n`;

        case 'dialogue':
            // 戏剧对话体
            return `【${name}】\n\n${cleanMes}\n\n`;

        case 'numbered':
        default:
            // 标准小说章节体（微信读书/阅读器可直接识别为目录索引）
            return `第 ${num} 节 · ${name}\n\n${cleanMes}\n\n\n`;
    }
}

async function init(router) {
    console.log(`[${pluginName}] 小说连载服务插件正在初始化...`);
    await ensureLogsDir();

    // 状态探针接口：用于前端检测服务端插件是否正常运行
    router.get('/status', async (req, res) => {
        res.json({
            ready: true,
            plugin: pluginName,
            version: '1.3.2',
            logsDir: LOGS_DIR
        });
    });

    router.post('/append', async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: '无效请求' });
            }

            const { name, mes, is_user, characterName, chapterNumber, chapterStyle, save_dir } = body;

            if (!mes || typeof mes !== 'string') {
                return res.status(400).json({ error: '正文内容不能为空' });
            }

            // 单条长度防护 (100KB)
            const byteLength = Buffer.byteLength(mes, 'utf8');
            if (byteLength > MAX_MESSAGE_BYTES) {
                return res.status(413).json({ error: '单章节篇幅过大，超出 100KB 限制' });
            }

            // 安全书名与目标存储路径
            const bookTitle = sanitizeFilename(characterName || name);
            const targetFileName = `${bookTitle}.txt`;

            // 支持自定义存储目录（绝对路径或相对酒馆运行目录），留空则使用默认 logs 目录
            const dirResult = resolveTargetDirectory(save_dir);
            if (!dirResult.success) {
                return res.status(400).json({ error: dirResult.error });
            }
            const targetDir = dirResult.dir;
            await fs.promises.mkdir(targetDir, { recursive: true });

            const targetFilePath = path.join(targetDir, targetFileName);

            // 检查末尾防重
            const duplicate = await isDuplicateTail(targetFilePath, mes);
            if (duplicate) {
                console.log(`[${pluginName}] 检测到末尾已有相同段落，跳过重复写入`);
                return res.json({
                    success: true,
                    skipped: true,
                    reason: '重复段落已自动跳过',
                    file: path.relative(process.cwd(), targetFilePath)
                });
            }

            // 编排成小说章节
            const formattedNovel = formatNovelChapter({
                name: name || '故事',
                mes,
                is_user,
                chapterNumber,
                chapterStyle
            });

            // 以 UTF-8 格式追加写入小说文件
            await fs.promises.appendFile(targetFilePath, formattedNovel, { encoding: 'utf8' });

            const relPath = path.relative(process.cwd(), targetFilePath);
            console.log(`[${pluginName}] 📖 成功连载新章节 -> ${relPath}`);

            return res.json({
                success: true,
                skipped: false,
                file: relPath
            });
        } catch (error) {
            console.error(`[${pluginName}] 连载写入异常:`, error);
            return res.status(500).json({
                error: '写入文件失败',
                detail: error.message
            });
        }
    });

    // 全量历史同步接口：半路启用插件时，一键将过去的全部章节完整写入小说文件
    router.post('/sync-all', async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: '无效请求' });
            }

            const { characterName, fullText, save_dir } = body;
            if (!fullText || typeof fullText !== 'string') {
                return res.status(400).json({ error: '小说正文不能为空' });
            }

            // 大小限制防护 (20MB)
            const byteLength = Buffer.byteLength(fullText, 'utf8');
            if (byteLength > 20 * 1024 * 1024) {
                return res.status(413).json({ error: '小说篇幅过大，超出 20MB 限制' });
            }

            const bookTitle = sanitizeFilename(characterName || '我的小说连载');
            const targetFileName = `${bookTitle}.txt`;

            const dirResult = resolveTargetDirectory(save_dir);
            if (!dirResult.success) {
                return res.status(400).json({ error: dirResult.error });
            }
            const targetDir = dirResult.dir;
            await fs.promises.mkdir(targetDir, { recursive: true });

            const targetFilePath = path.join(targetDir, targetFileName);

            // 完整写入小说文件（覆盖初始化）
            await fs.promises.writeFile(targetFilePath, fullText, { encoding: 'utf8' });

            const relPath = path.relative(process.cwd(), targetFilePath);
            console.log(`[${pluginName}] 📚 成功全量同步历史小说 -> ${relPath}`);

            return res.json({
                success: true,
                file: relPath
            });
        } catch (error) {
            console.error(`[${pluginName}] 全量同步异常:`, error);
            return res.status(500).json({
                error: '全量同步写入失败',
                detail: error.message
            });
        }
    });

    console.log(`[${pluginName}] 小说连载服务初始化就绪，书籍目录：${LOGS_DIR}`);
}

async function exit() {
    console.log(`[${pluginName}] 小说连载服务已退出。`);
}

const info = {
    id: 'auto-save',
    name: 'Auto Save to TXT',
    description: 'SillyTavern 聊天小说连载阅读服务端追加插件'
};

module.exports = {
    init,
    exit,
    info,
    default: {
        init,
        exit,
        info
    }
};
