/**
 * SillyTavern 聊天小说连载阅读服务端插件 (v1.6.0)
 * 
 * 文件路径：plugins/auto-save/index.js
 * 
 * 核心功能：
 * - 接收前端章节内容，以高雅、规范的小说排版格式追加写入 TXT。
 * - 格式完美适配微信读书、掌阅、ReadEra、多看等主流阅读器，自动识别“第 X 节”为可点击的目录。
 * - 首次创建小说自动补充 UTF-8 BOM 编码标识与《书名》扉页，彻底杜绝乱码。
 * - 智能防重与“重新生成 (Regenerate)”分支自动替换末尾章节，避免剧情堆叠。
 * - 严格防路径穿越、100KB 单章容量防护与异步并发文件写入锁机制。
 */

const fs = require('fs');
const path = require('path');

const pluginName = 'auto-save';
const MAX_MESSAGE_BYTES = 100 * 1024; // 100KB
const LOGS_DIR = path.join(__dirname, 'logs');
const UTF8_BOM = '\uFEFF';

// 异步文件写入队列，确保同一小说的并发写入严格按序执行
const fileQueues = new Map();

function runInFileQueue(filePath, task) {
    const currentQueue = fileQueues.get(filePath) || Promise.resolve();
    const nextQueue = currentQueue
        .then(task, task)
        .finally(() => {
            if (fileQueues.get(filePath) === nextQueue) {
                fileQueues.delete(filePath);
            }
        });
    fileQueues.set(filePath, nextQueue);
    return nextQueue;
}

async function ensureLogsDir() {
    try {
        await fs.promises.mkdir(LOGS_DIR, { recursive: true });
    } catch (err) {
        if (err.code !== 'EEXIST') {
            console.error(`[${pluginName}] 创建小说存储目录失败:`, err);
        }
    }
}

/**
 * 健壮的文件名清洗
 * 防路径穿越、清理非法字符、剔除末尾空格与句点、防 Windows 保留设备名
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

    // 截断长度并去除 Windows 不允许的末尾空格和句点
    safeName = safeName.slice(0, 150).replace(/[. ]+$/, '');

    // 防御 Windows 经典保留设备名 (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(safeName)) {
        safeName = `${safeName}_novel`;
    }

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
 * 精准末尾防重复写入检查：
 * 仅对比文件最末尾的实际章节内容，绝不在整个 4KB 范围内做前文误伤匹配
 * 结合章节序号判断，彻底杜绝短回复误杀
 */
async function isDuplicateTail(filePath, mes, chapterNumber, chapterStyle) {
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
        const cleanMes = mes.trim();
        const tailTrimmed = tailContent.trim();

        // 0. 若为带序号章节，且当前序号大于 1：若文件尾部尚未包含本章序号标记，说明本章绝对未写入过，绝不可误判为重复
        if (chapterNumber && chapterNumber > 1 && (!chapterStyle || chapterStyle === 'numbered_floor' || chapterStyle === 'numbered')) {
            if (!tailContent.includes(`第 ${chapterNumber} `)) {
                return false;
            }
        }

        // 1. 如果文件末尾完全以此段正文结尾
        if (tailTrimmed.endsWith(cleanMes)) {
            return true;
        }

        // 2. 检查文件最末尾 200 个字符内是否包含该正文的尾部特征片段（仅针对长正文进行模糊比对，短回复不做模糊比对防误判）
        if (cleanMes.length >= 30) {
            const tailSnippet = cleanMes.slice(-60);
            if (tailSnippet.length >= 20 && tailTrimmed.slice(-200).includes(tailSnippet)) {
                return true;
            }
        }

        return false;
    } catch (err) {
        return false;
    }
}

/**
 * 替换文件末尾的最后一章节（用于支持 Regenerate / Swipe 重新生成替换）
 * 严格按照当前的章节排版样式与章节序号进行精准边界匹配，避免误伤正文内部的散文分隔符或系统括号
 */
async function replaceLastChapter(filePath, newFormattedChapter, chapterStyle, chapterNumber) {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');

        let lastMatch = null;

        // 优先策略：如果已知章节序号，精准匹配该章节标题头（最安全，绝不误伤正文内容）
        if (chapterNumber && (chapterStyle === 'numbered_floor' || chapterStyle === 'numbered' || !chapterStyle)) {
            const exactRegex = new RegExp(`(?:^|\\r?\\n\\r?\\n)(第 ${chapterNumber} [章节] · [^\\r\\n]+)\\r?\\n\\r?\\n`, 'g');
            let m;
            while ((m = exactRegex.exec(content)) !== null) {
                lastMatch = m;
            }
        }

        // 次级策略：若未匹配到精准序号，则根据当前章节风格专一定位末尾章节头
        if (!lastMatch) {
            let regex;
            switch (chapterStyle) {
                case 'numbered_floor':
                    regex = /(?:^|\r?\n\r?\n)(第 \d+ 章 · [^\r\n]+)\r?\n\r?\n/g;
                    break;
                case 'numbered':
                    regex = /(?:^|\r?\n\r?\n)(第 \d+ 节 · [^\r\n]+)\r?\n\r?\n/g;
                    break;
                case 'separator':
                    regex = /(?:^|\r?\n\r?\n)(\* \* \*)\r?\n\r?\n/g;
                    break;
                case 'dialogue':
                    regex = /(?:^|\r?\n\r?\n)(【[^\r\n]+】)\r?\n\r?\n/g;
                    break;
                default:
                    regex = /(?:^|\r?\n\r?\n)(第 \d+ [章节] · [^\r\n]+|\* \* \*|【[^\r\n]+】)\r?\n\r?\n/g;
                    break;
            }

            let m;
            while ((m = regex.exec(content)) !== null) {
                lastMatch = m;
            }
        }

        if (lastMatch && lastMatch.index >= 0) {
            const baseContent = content.slice(0, lastMatch.index).trimEnd();
            const separator = baseContent ? '\n\n\n' : '';
            await fs.promises.writeFile(filePath, baseContent + separator + newFormattedChapter, { encoding: 'utf8' });
            return true;
        } else {
            // 未匹配到章节头，则安全追加
            await fs.promises.appendFile(filePath, newFormattedChapter, { encoding: 'utf8' });
            return false;
        }
    } catch (err) {
        // 出错降级为追加
        await fs.promises.appendFile(filePath, newFormattedChapter, { encoding: 'utf8' });
        return false;
    }
}

/**
 * 格式化为小说章节
 */
function formatNovelChapter({ name, mes, is_user, chapterNumber, chapterStyle, floor }) {
    const cleanMes = mes.trim();
    const num = chapterNumber || 1;
    const floorNum = (typeof floor !== 'undefined' && floor !== null) ? floor : num;

    switch (chapterStyle) {
        case 'numbered':
            // 标准小说章节体（无楼层）
            return `第 ${num} 节 · ${name}\n\n${cleanMes}\n\n\n`;

        case 'separator':
            // 散文流分割体
            return `* * *\n\n${cleanMes}\n\n`;

        case 'dialogue':
            // 戏剧对话体
            return `【${name}】\n\n${cleanMes}\n\n`;

        case 'numbered_floor':
        default:
            // 默认推荐：第 X 章 · 角色名 (原楼层: Y)
            return `第 ${num} 章 · ${name} (原楼层: ${floorNum})\n\n${cleanMes}\n\n\n`;
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
            version: '1.6.0',
            logsDir: LOGS_DIR
        });
    });

    router.post('/append', async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: '无效请求' });
            }

            const { name, mes, is_user, characterName, chapterNumber, chapterStyle, save_dir, is_regenerate, floor } = body;

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

            // 排队进入写入队列，确保并发写操作安全有序
            const result = await runInFileQueue(targetFilePath, async () => {
                const stat = await fs.promises.stat(targetFilePath).catch(() => null);
                const isNewFile = !stat || stat.size === 0;

                // 非新建且非重新生成模式下，检查末尾防重（结合章节序号精确防误杀）
                if (!isNewFile && !is_regenerate) {
                    const duplicate = await isDuplicateTail(targetFilePath, mes, chapterNumber, chapterStyle);
                    if (duplicate) {
                        console.log(`[${pluginName}] 检测到末尾已有相同段落，跳过重复写入`);
                        return {
                            skipped: true,
                            reason: '重复段落已自动跳过',
                            file: path.relative(process.cwd(), targetFilePath)
                        };
                    }
                }

                // 编排成小说章节
                const formattedNovel = formatNovelChapter({
                    name: name || '故事',
                    mes,
                    is_user,
                    chapterNumber,
                    chapterStyle,
                    floor
                });

                if (isNewFile) {
                    // 首次创建文件：写入 UTF-8 BOM 标识与《书名》扉页，完美适配阅读器目录与中文编码
                    const fileHeader = `${UTF8_BOM}《${bookTitle}》\n\n\n`;
                    await fs.promises.writeFile(targetFilePath, fileHeader + formattedNovel, { encoding: 'utf8' });
                } else if (is_regenerate) {
                    // 用户重新生成或滑动分支：智能替换末尾章节（精确定位该章节起始边界，避免残留旧草稿或误伤正文）
                    await replaceLastChapter(targetFilePath, formattedNovel, chapterStyle, chapterNumber);
                } else {
                    // 正常追加新章节
                    await fs.promises.appendFile(targetFilePath, formattedNovel, { encoding: 'utf8' });
                }

                const relPath = path.relative(process.cwd(), targetFilePath);
                console.log(`[${pluginName}] 📖 成功连载新章节 -> ${relPath}${is_regenerate ? ' (重写替换)' : ''}`);

                return {
                    skipped: false,
                    file: relPath,
                    is_regenerate: !!is_regenerate
                };
            });

            return res.json({
                success: true,
                skipped: result.skipped,
                reason: result.reason,
                file: result.file,
                is_regenerate: result.is_regenerate
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

            await runInFileQueue(targetFilePath, async () => {
                // 确保包含 UTF-8 BOM 标识
                const contentWithBom = fullText.startsWith(UTF8_BOM) ? fullText : (UTF8_BOM + fullText);
                await fs.promises.writeFile(targetFilePath, contentWithBom, { encoding: 'utf8' });
            });

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
    name: '小说连载阅读 (Novel Stream)',
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
