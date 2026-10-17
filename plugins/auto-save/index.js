/**
 * SillyTavern 聊天小说连载阅读服务端插件 (v1.16.0)
 * 
 * 文件路径：plugins/auto-save/index.js
 * 
 * 核心功能：
 * - 接收前端章节内容，以高雅、规范的小说排版格式追加写入 TXT。
 * - 格式完美适配微信读书、掌阅、ReadEra、多看等主流阅读器，自动识别“第 X 节”为可点击的目录。
 * - 首次创建小说自动补充 UTF-8 BOM 编码标识与《书名》扉页，彻底杜绝乱码。
 * - 智能防重与“重新生成 (Regenerate)”分支自动替换末尾章节，避免剧情堆叠。
 * - 尾部一致性守卫：仅当目标章号确实是文件最后一章时才替换，否则 409 拒绝且绝不改动文件
 *   （修复“编辑早期楼层 → 从该章截断到文件末尾，静默删除其后所有章节”的数据损坏）。
 * - 写前备份（.bak，仅留最近一份）+ 临时文件 rename 原子写，杜绝半截文件。
 * - 图片电子书导出（EPUB3）：手写 ZIP（零第三方依赖）+ 按正文原位嵌入本地图片。
 * - 电子书双交付（v1.15.0）：默认落盘 + JSON（服务端模式）；delivery=download 直接返回
 *   二进制 EPUB 供浏览器下载（同一套校验/打包管线，绝不落盘、save_dir 完全忽略）。
 * - 电子书体积预估（v1.16.0）：POST /ebook/estimate 与 /ebook 同构请求体，只做路径解析 +
 *   stat + 文件头魔数嗅探，导出前即可提示图片总量/超限情况（绝不读整图、不打包、零落盘）。
 * - 严格防路径穿越、100KB 单章容量防护与异步并发文件写入锁机制。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const pluginName = 'auto-save';
const MAX_MESSAGE_BYTES = 100 * 1024; // 100KB
const LOGS_DIR = path.join(__dirname, 'logs');
const UTF8_BOM = '\uFEFF';
// 聊天 ID 锚定注册表：聊天改名后自动跟随重命名小说文件（本机状态，随部署生成，绝不上传 Git）
const REGISTRY_FILE = path.join(__dirname, '.novel-registry.json');

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

// 聊天 ID 锚定注册表（内存态，启动时加载）：{ [chat_anchor]: { file, title } }
let novelRegistry = {};

// 启动时容错读取注册表：文件不存在/JSON 损坏 → 视为空表；损坏时备份为 .bak 后重建
async function loadNovelRegistry() {
    try {
        const raw = await fs.promises.readFile(REGISTRY_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        novelRegistry = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (err) {
        novelRegistry = {};
        if (err.code !== 'ENOENT') {
            try {
                await fs.promises.copyFile(REGISTRY_FILE, `${REGISTRY_FILE}.bak`);
                console.warn(`[${pluginName}] 聊天锚定注册表损坏，已备份为 .novel-registry.json.bak 并重建空表:`, err.message);
            } catch (bakErr) {
                console.warn(`[${pluginName}] 注册表损坏且备份失败:`, bakErr.message);
            }
        }
    }
}

// 注册表变更后同步写回（写不回仅告警，绝不阻断连载）
async function saveNovelRegistry() {
    try {
        await fs.promises.writeFile(REGISTRY_FILE, JSON.stringify(novelRegistry, null, 2), { encoding: 'utf8' });
    } catch (err) {
        console.error(`[${pluginName}] 聊天锚定注册表写回失败:`, err);
    }
}

/**
 * 聊天 ID 锚定目标文件解析（聊天改名自动跟随重命名 + 多账号 file_name 优先）：
 * - 有 file_name 优先用之（前端算好的含账号前缀文件名，sanitize 兜底并确保 .txt 后缀），否则沿用 characterName 逻辑
 * - registry[anchor] 不存在 → 登记 desiredPath 并写（老用户首次写入与现有文件名一致，无缝接管）
 * - entry.file === desiredPath → 直接写
 * - entry.file !== desiredPath 且旧文件存在：
 *   · desiredPath 不存在 → 重命名迁移：内容整体搬迁，首行书仅当原首行以《 开头时同步为新书名（BOM 原样保留）；响应 renamed_from
 *   · desiredPath 已存在（与别的聊天撞名）→ 不 rename 绝不覆盖他人小说，继续写 entry.file（旧名），响应 kept_name
 * - entry.file !== desiredPath 且旧文件不存在 → 视为用户手动挪走：登记改为 desiredPath，写新文件
 */
async function resolveAnchoredTargetPath({ chat_anchor, file_name, characterName, name, targetDir, bookTitle }) {
    let targetFileName;
    if (typeof file_name === 'string' && file_name.trim()) {
        const sanitized = sanitizeFilename(file_name.trim());
        targetFileName = /\.txt$/i.test(sanitized) ? sanitized : `${sanitized}.txt`;
    } else {
        targetFileName = `${sanitizeFilename(characterName || name)}.txt`;
    }
    const desiredPath = path.join(targetDir, targetFileName);

    const anchor = (typeof chat_anchor === 'string') ? chat_anchor.trim() : '';
    if (!anchor) {
        return { targetFilePath: desiredPath, renamedFrom: '', keptName: false };
    }

    const entry = novelRegistry[anchor];
    if (!entry) {
        novelRegistry[anchor] = { file: desiredPath, title: characterName || '' };
        await saveNovelRegistry();
        return { targetFilePath: desiredPath, renamedFrom: '', keptName: false };
    }

    if (entry.file === desiredPath) {
        return { targetFilePath: desiredPath, renamedFrom: '', keptName: false };
    }

    const oldStat = await fs.promises.stat(entry.file).catch(() => null);
    if (!oldStat) {
        // 旧文件已被用户手动挪走：直接登记新路径并写新文件
        novelRegistry[anchor] = { file: desiredPath, title: characterName || '' };
        await saveNovelRegistry();
        return { targetFilePath: desiredPath, renamedFrom: '', keptName: false };
    }

    const newStat = await fs.promises.stat(desiredPath).catch(() => null);
    if (newStat) {
        // 与别的聊天撞名：保留旧文件名继续写，绝不覆盖他人小说
        console.warn(`[${pluginName}] 锚点期望文件名已被其它聊天占用，保留旧文件继续写入: ${entry.file}`);
        return { targetFilePath: entry.file, renamedFrom: '', keptName: true };
    }

    // 执行重命名：内容迁移 + 首行书名替换（仅当原首行以《 开头；BOM 原样保留）
    const oldContent = await fs.promises.readFile(entry.file, 'utf8');
    let newContent = oldContent;
    const firstLineEnd = oldContent.indexOf('\n');
    const firstLine = firstLineEnd >= 0 ? oldContent.slice(0, firstLineEnd) : oldContent;
    if (firstLine.replace(/^\uFEFF/, '').startsWith('《')) {
        const rest = firstLineEnd >= 0 ? oldContent.slice(firstLineEnd) : '';
        const hadBom = oldContent.startsWith(UTF8_BOM);
        newContent = (hadBom ? UTF8_BOM : '') + `《${bookTitle}》` + rest;
    }
    await fs.promises.writeFile(desiredPath, newContent, { encoding: 'utf8' });
    await fs.promises.unlink(entry.file);

    const renamedFrom = path.basename(entry.file);
    novelRegistry[anchor] = { file: desiredPath, title: characterName || '' };
    await saveNovelRegistry();
    console.log(`[${pluginName}] 聊天改名检测：小说文件已同步更名 ${renamedFrom} -> ${path.basename(desiredPath)}`);
    return { targetFilePath: desiredPath, renamedFrom, keptName: false };
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
 * 写前备份：复制为 `${filePath}.bak`（仅保留最近一份，直接覆盖旧 bak）
 * 备份失败绝不阻断写入，只告警；返回值仅供响应字段使用。
 * @returns {Promise<boolean>} 是否成功产生备份
 */
async function backupFile(filePath) {
    try {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || stat.size === 0) {
            // 首次创建 / 首次全量同步：没有可备份的旧内容，静默跳过
            return false;
        }
        await fs.promises.copyFile(filePath, `${filePath}.bak`);
        return true;
    } catch (err) {
        console.warn(`[${pluginName}] 写前备份失败（不阻断写入）: ${filePath} -> ${err.message}`);
        return false;
    }
}

// 临时文件名去重序号：同一毫秒内的多次原子写不会撞名
let atomicWriteSeq = 0;

/**
 * 原子写：先写同目录临时文件，再 rename 覆盖目标；rename 失败则回滚（unlink 临时文件）并抛出。
 * 注意：BOM 与《书名》扉页由调用方自行拼接，本函数不添加任何编码标识。
 */
async function atomicWriteFile(filePath, data) {
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${++atomicWriteSeq}`;
    try {
        await fs.promises.writeFile(tmpPath, data, { encoding: 'utf8' });
        await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        throw err;
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
 * 正则元字符转义（客户端可控的 chapterNumber 拼进 new RegExp 前必须转义）
 */
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 章节标题解析用的编号模式：兼容「第 N 章」与「第 N 节」，并要求标题分隔符「·」。
 * 章节标题由 formatNovelChapter() 生成，形如：`第 3 章 · 角色名 (原楼层: 4)`
 */
const CHAPTER_HEADING_SOURCE = '(?:^|\\r?\\n\\r?\\n)第\\s*(\\d+)\\s*[章节]\\s*·\\s*([^\\r\\n]+)';

/**
 * 解析真实文件内容里的全部章节标题。
 * 容错点：文件首部 BOM 会先跳过再判断行首，因此「BOM 紧邻首章标题」也能解析；
 * 返回的 index 已换算回原始 content 坐标，便于调用方直接切片。
 * @returns {Array<{number:number, title:string, index:number, raw:string}>}
 */
function extractChapterHeadings(content) {
    const headings = [];
    if (typeof content !== 'string' || content.length === 0) {
        return headings;
    }
    const bomOffset = content.startsWith(UTF8_BOM) ? UTF8_BOM.length : 0;
    const source = bomOffset ? content.slice(bomOffset) : content;
    // 每次新建正则实例：避免共享 lastIndex 造成跨调用状态污染
    const regex = new RegExp(CHAPTER_HEADING_SOURCE, 'g');
    let match;
    while ((match = regex.exec(source)) !== null) {
        headings.push({
            number: parseInt(match[1], 10),
            title: match[2].trim(),
            index: match.index + bomOffset,
            raw: match[0]
        });
    }
    return headings;
}

/**
 * 取文件中的最后一个章节标题（无章节标题时返回 null）
 */
function getTailChapter(content) {
    const headings = extractChapterHeadings(content);
    return headings.length > 0 ? headings[headings.length - 1] : null;
}

/**
 * 该章节排版风格是否使用「第 N 章 / 第 N 节」编号（旧实现中 !chapterStyle 也走编号匹配）
 */
function isNumberedChapterStyle(chapterStyle) {
    return chapterStyle === 'numbered_floor' || chapterStyle === 'numbered' || !chapterStyle;
}

/**
 * 精准末尾防重复写入检查：
 * 仅对比文件最末尾的实际章节内容，绝不在整个 4KB 范围内做前文误伤匹配
 * 结合章节序号判断，彻底杜绝短回复误杀
 *
 * D12 修复：本章标题位于本章开头，长章节（>4KB）的标题根本不在末尾 4KB 窗口里，
 * 导致「本章已写入」的序号判定失败而重复写入。读取窗口按本章字节数放大（上限 256KB，
 * 足以覆盖 100KB 单章上限 + 标题），短文件行为与旧实现完全一致（仍读整个文件）。
 */
async function isDuplicateTail(filePath, mes, chapterNumber, chapterStyle) {
    try {
        const stat = await fs.promises.stat(filePath).catch(() => null);
        if (!stat || stat.size === 0) {
            return false;
        }

        const mesBytes = Buffer.byteLength(typeof mes === 'string' ? mes : '', 'utf8');
        const readSize = Math.min(stat.size, Math.max(4096, Math.min(mesBytes + 4096, 256 * 1024)));
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
 *
 * 安全契约（修复 D1 / D13）：
 * - 只有当 chapterNumber 指向的章节**确实是文件中的最后一个章节**时才允许替换；
 *   目标之后还存在任何章节标题 → 直接拒绝，绝不改动文件。
 * - 找不到目标章节 / 序号非法 / 正则构造失败 / 替换异常 → 一律返回 replaced:false 且**不改文件**；
 *   旧实现在这些路径上静默降级为 append 并回报成功，是“数据被删/重复章”的根源，已彻底移除。
 * - 替换前 backupFile() 备份原文件（仅留最近一份 .bak），写入走 atomicWriteFile() 原子替换。
 * - 保留文件首部 BOM 与《书名》扉页（按目标标题起始位置切片）。
 *
 * @param {string} filePath
 * @param {string} newFormattedChapter
 * @param {string} chapterStyle 'numbered_floor' | 'numbered' | 'separator' | 'dialogue'
 * @param {number|string} chapterNumber
 * @param {{requireTail?: boolean}} [options] requireTail 默认 true（fail-closed）
 * @returns {Promise<{replaced: boolean, reason?: string, backup?: boolean}>}
 */
async function replaceLastChapter(filePath, newFormattedChapter, chapterStyle, chapterNumber, options = {}) {
    const requireTail = options.requireTail !== false;
    try {
        const rawContent = await fs.promises.readFile(filePath, 'utf8');
        const bomOffset = rawContent.startsWith(UTF8_BOM) ? UTF8_BOM.length : 0;
        const source = bomOffset ? rawContent.slice(bomOffset) : rawContent;

        // 0. 编号校验：chapterNumber 是客户端可控值，拼进 RegExp 前必须校验 + 转义
        const numberText = (chapterNumber === undefined || chapterNumber === null) ? '' : String(chapterNumber).trim();
        let numberedTargetRequired = false;
        if (isNumberedChapterStyle(chapterStyle) && numberText) {
            if (!/^\d+$/.test(numberText)) {
                return { replaced: false, reason: 'invalid_chapter_number' };
            }
            numberedTargetRequired = true;
        }

        // 1. 解析真实文件内容里的章节标题（兼容第 N 章 / 第 N 节 + BOM）
        const headings = extractChapterHeadings(rawContent);
        const tailChapter = headings.length > 0 ? headings[headings.length - 1] : null;

        // 2. 定位目标块的起始位置
        let candidateIndex = -1;
        if (numberedTargetRequired) {
            // 优先策略：精准匹配该章节标题头（最安全，绝不误伤正文内容）
            let exactRegex;
            try {
                exactRegex = new RegExp(
                    `(?:^|\\r?\\n\\r?\\n)第\\s*${escapeRegExp(numberText)}\\s*[章节]\\s*·\\s*[^\\r\\n]+`,
                    'g'
                );
            } catch (err) {
                return { replaced: false, reason: 'invalid_chapter_number' };
            }
            let lastMatch = null;
            let m;
            while ((m = exactRegex.exec(source)) !== null) {
                lastMatch = m;
            }
            if (!lastMatch) {
                // 找不到目标章节：绝不降级追加（旧实现会 append 并回报 success）
                return { replaced: false, reason: 'chapter_not_found' };
            }
            candidateIndex = lastMatch.index + bomOffset;
        } else if (chapterStyle === 'numbered_floor' || chapterStyle === 'numbered') {
            // 未提供有效编号的编号风格：只能替换文件最后一章
            if (!tailChapter) {
                return { replaced: false, reason: 'chapter_not_found' };
            }
            candidateIndex = tailChapter.index;
        } else {
            // 次级策略：按章节风格标记定位最后一块（separator / dialogue / 未知风格兜底）
            let regex;
            switch (chapterStyle) {
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

            let lastMatch = null;
            let m;
            while ((m = regex.exec(source)) !== null) {
                lastMatch = m;
            }
            if (!lastMatch) {
                return { replaced: false, reason: 'chapter_not_found' };
            }
            candidateIndex = lastMatch.index + bomOffset;
        }

        // 3. 尾部一致性守卫：目标之后不得再出现任何章节标题
        if (requireTail && tailChapter && candidateIndex < tailChapter.index) {
            return { replaced: false, reason: 'not_tail_chapter' };
        }

        // 4. 备份 + 原子替换
        const backup = await backupFile(filePath);
        const baseContent = rawContent.slice(0, candidateIndex).trimEnd();
        const separator = baseContent ? '\n\n\n' : '';
        let nextContent = baseContent + separator + newFormattedChapter;
        // 兜底：原文件带 BOM 时替换结果必须继续带 BOM（极端情况下标题紧邻 BOM、trim 会吃掉它）
        if (bomOffset && !nextContent.startsWith(UTF8_BOM)) {
            nextContent = UTF8_BOM + nextContent;
        }
        await atomicWriteFile(filePath, nextContent);
        return { replaced: true, backup };
    } catch (err) {
        // 任何异常都不得降级为追加：只报错、不改文件
        console.error(`[${pluginName}] 替换末尾章节失败（未改动文件）: ${filePath} ->`, err);
        return { replaced: false, reason: 'replace_failed' };
    }
}

// 替换失败时给前端展示的文案（失败响应保持 { error, detail } 形态）
const REPLACE_FAILURE_MESSAGES = {
    not_tail_chapter: '目标章节不是文件末尾章，已放弃替换以避免误删后续章节',
    chapter_not_found: '文件中未找到目标章节，已放弃替换以避免内容错位',
    invalid_chapter_number: '章节序号非法，已放弃替换',
    replace_failed: '替换末尾章节失败，文件未被改动'
};

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

// ============================================================================
// 图片电子书（EPUB）导出：手写 ZIP + EPUB3 组装 + 图片路径解析/读取
// 设计依据：review/图片电子书-设计方案.md §3（数据契约）/ §4（技术方案）
// 硬性约束：零第三方依赖（只用 Node 内置 fs / path / zlib）；单图失败不中断导出
// ============================================================================

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // 单图上限 5MB
const DEFAULT_MAX_TOTAL_BYTES = 80 * 1024 * 1024;  // 全书图片总量上限 80MB
// 图片魔数嗅探只需文件头 16 字节（PNG 8 / JPEG 3 / GIF 6 / WebP 12），体积预估时绝不读整图
const IMAGE_MAGIC_HEAD_BYTES = 16;
const EPUB_XHTML_NS = 'http://www.w3.org/1999/xhtml';
const EPUB_ID_SEED = 'auto-save-novel-stream';

// ---------- CRC32（多项式 0xEDB88320，ZIP 必需） ----------
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
        c = CRC32_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 手写 ZIP（够 EPUB 用：不做 ZIP64 / 加密 / 数据描述符）
 * entries: [{ name, data: Buffer|string, store?: boolean }]
 * - 本地文件头 + 中央目录 + EOCD
 * - 文件名 UTF-8（通用标志位 bit 11 = 0x0800）
 * - `mimetype` 是 EPUB 硬性要求：必须第一个条目且 STORED 不压缩（这里强制兜底）
 */
function buildZip(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('buildZip: entries 不能为空');
    }
    if (entries.length > 0xFFFF) {
        throw new Error('buildZip: 条目数超过 65535（本实现不支持 ZIP64）');
    }

    const localChunks = [];
    const centralRecords = [];
    let offset = 0;

    for (const entry of entries) {
        const name = (entry && typeof entry.name === 'string') ? entry.name : '';
        if (!name) {
            throw new Error('buildZip: 条目缺少 name');
        }
        const raw = Buffer.isBuffer(entry.data)
            ? entry.data
            : Buffer.from(entry.data === undefined || entry.data === null ? '' : String(entry.data), 'utf8');
        // EPUB 规范：mimetype 必须 STORED（不压缩），无论调用方是否传 store
        const useStore = !!entry.store || name === 'mimetype';
        const body = useStore ? raw : zlib.deflateRawSync(raw, { level: 9 });
        if (raw.length > 0xFFFFFFFE || body.length > 0xFFFFFFFE) {
            throw new Error('buildZip: 单条目超过 4GB（本实现不支持 ZIP64）');
        }
        const crc = crc32(raw);
        const nameBuf = Buffer.from(name, 'utf8');
        const flags = 0x0800; // bit 11：文件名使用 UTF-8

        // 本地文件头（30 字节）
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);        // 签名 PK\x03\x04
        local.writeUInt16LE(20, 4);                // 解压所需版本 2.0
        local.writeUInt16LE(flags, 6);             // 通用标志
        local.writeUInt16LE(useStore ? 0 : 8, 8);  // 压缩方法：0=STORED / 8=deflate
        local.writeUInt16LE(0, 10);                // 修改时间（固定 0，输出可复现）
        local.writeUInt16LE(0x21, 12);             // 修改日期：1980-01-01
        local.writeUInt32LE(crc, 14);              // CRC32
        local.writeUInt32LE(body.length, 18);      // 压缩后大小
        local.writeUInt32LE(raw.length, 22);       // 原始大小
        local.writeUInt16LE(nameBuf.length, 26);   // 文件名长度
        local.writeUInt16LE(0, 28);                // 扩展字段长度

        localChunks.push(local, nameBuf, body);
        centralRecords.push({ nameBuf, crc, csize: body.length, usize: raw.length, method: useStore ? 0 : 8, offset });
        offset += local.length + nameBuf.length + body.length;
    }

    // 中央目录
    const centralStart = offset;
    const centralChunks = [];
    let centralSize = 0;
    for (const record of centralRecords) {
        const header = Buffer.alloc(46);
        header.writeUInt32LE(0x02014B50, 0);        // 签名 PK\x01\x02
        header.writeUInt16LE(20, 4);                // 创建版本
        header.writeUInt16LE(20, 6);                // 解压所需版本
        header.writeUInt16LE(0x0800, 8);            // 通用标志（UTF-8）
        header.writeUInt16LE(record.method, 10);    // 压缩方法
        header.writeUInt16LE(0, 12);                // 修改时间
        header.writeUInt16LE(0x21, 14);             // 修改日期
        header.writeUInt32LE(record.crc, 16);
        header.writeUInt32LE(record.csize, 20);
        header.writeUInt32LE(record.usize, 24);
        header.writeUInt16LE(record.nameBuf.length, 28);
        // 扩展/注释/磁盘号/内部外部属性全部为 0（Buffer.alloc 已置零）
        header.writeUInt32LE(record.offset, 42);    // 对应本地文件头偏移
        centralChunks.push(header, record.nameBuf);
        centralSize += header.length + record.nameBuf.length;
    }

    // 中央目录结束记录（EOCD）
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);              // 签名 PK\x05\x06
    eocd.writeUInt16LE(0, 4);                       // 当前磁盘号
    eocd.writeUInt16LE(0, 6);                       // 中央目录起始磁盘号
    eocd.writeUInt16LE(centralRecords.length, 8);   // 本磁盘条目数
    eocd.writeUInt16LE(centralRecords.length, 10);  // 总条目数
    eocd.writeUInt32LE(centralSize, 12);            // 中央目录大小
    eocd.writeUInt32LE(centralStart, 16);           // 中央目录偏移
    eocd.writeUInt16LE(0, 20);                      // 注释长度

    return Buffer.concat([...localChunks, ...centralChunks, eocd]);
}

// ---------- XML 转义（XHTML 必须 XML 合法，否则阅读器整章打不开） ----------
function escapeXmlText(text) {
    return String(text === undefined || text === null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeXmlAttr(text) {
    return escapeXmlText(text).replace(/"/g, '&quot;');
}

// 现有 TXT 正文段首会带「　　」（两个全角空格）；EPUB 由 CSS text-indent:2em 统一缩进，
// 这里去掉规范缩进前缀，避免渲染成 4em 的“双缩进”。
function stripCanonicalIndent(text) {
    return String(text === undefined || text === null ? '' : text).replace(/^\u3000{2}/, '');
}

// ---------- 稳定书籍标识（不引 crypto：FNV 风格散列生成 uuid 形态，同书同 id） ----------
function buildBookUuid(seed) {
    let h1 = 0x811C9DC5;
    let h2 = 0x01000193;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
        h2 = (Math.imul(h2 ^ code, 0x85EBCA6B) + i) >>> 0;
    }
    const hex = [h1, h2, (h1 ^ h2) >>> 0, (h1 + h2) >>> 0]
        .map((v) => v.toString(16).padStart(8, '0'))
        .join(''); // 32 个十六进制字符
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * 组装 EPUB3 电子书（另生成 toc.ncx 兼容只认 EPUB2 的老阅读器）
 * @param {{ bookTitle?: string, author?: string,
 *           chapters?: Array<{ title?: string, floor?: number, blocks?: Array<object> }>,
 *           assets?: Array<{ href: string, data: Buffer, mediaType: string }> }} [book]
 * @returns {Buffer} 完整 .epub 字节
 *
 * blocks 同时兼容两种写法（前端 buildStructuredNovel 用 text/image，本任务契约写 p/img）：
 *   { type:'p'|'text', text }               → <p>…</p>
 *   { type:'img'|'image', href|path, alt }  → <figure><img/></figure>
 */
function buildEpubBuffer(book = {}) {
    const bookTitle = (typeof book.bookTitle === 'string' && book.bookTitle.trim()) ? book.bookTitle.trim() : '我的小说连载';
    const author = (typeof book.author === 'string' && book.author.trim()) ? book.author.trim() : '佚名';
    const sourceChapters = Array.isArray(book.chapters) ? book.chapters.filter((c) => c && typeof c === 'object') : [];
    const chapters = sourceChapters.length > 0 ? sourceChapters : [{ title: bookTitle, blocks: [] }];
    const assets = (Array.isArray(book.assets) ? book.assets : [])
        .filter((asset) => asset && typeof asset.href === 'string' && asset.href
            && Buffer.isBuffer(asset.data) && !asset.href.includes('..') && !asset.href.startsWith('/'))
        .map((asset) => ({
            href: asset.href,
            data: asset.data,
            mediaType: (typeof asset.mediaType === 'string' && asset.mediaType) ? asset.mediaType : 'application/octet-stream'
        }));

    const identifier = `urn:uuid:${buildBookUuid(`${EPUB_ID_SEED}:${bookTitle}`)}`;
    const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const entries = [];

    // 1) mimetype（必须第一 + STORED）
    entries.push({ name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii'), store: true });

    // 2) META-INF/container.xml → 指向 OEBPS/content.opf
    entries.push({
        name: 'META-INF/container.xml',
        data: '<?xml version="1.0" encoding="UTF-8"?>\n'
            + '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
            + '  <rootfiles>\n'
            + '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
            + '  </rootfiles>\n'
            + '</container>\n'
    });

    // 3) 逐章 XHTML（chapter-0001.xhtml …，序号从 1 开始补零 4 位）
    const chapterFiles = [];
    chapters.forEach((chapter, index) => {
        const number = index + 1;
        const fileName = `chapter-${String(number).padStart(4, '0')}.xhtml`;
        const chapterTitle = (typeof chapter.title === 'string' && chapter.title.trim()) ? chapter.title.trim() : `第 ${number} 章`;
        const bodyLines = [];
        const blocks = Array.isArray(chapter.blocks) ? chapter.blocks : [];
        for (const block of blocks) {
            if (!block || typeof block !== 'object') continue;
            if (block.type === 'img' || block.type === 'image') {
                const src = (typeof block.href === 'string' && block.href) ? block.href
                    : ((typeof block.path === 'string') ? block.path : '');
                if (!src) continue;
                const alt = (typeof block.alt === 'string' && block.alt) ? block.alt : '插图';
                bodyLines.push(`      <figure><img src="${escapeXmlAttr(src)}" alt="${escapeXmlAttr(alt)}"/></figure>`);
                continue;
            }
            const text = stripCanonicalIndent(typeof block.text === 'string' ? block.text : '');
            if (!text) continue;
            // 文本先整体 XML 转义，再把段内换行还原为 <br/>（尽量不丢排版）
            bodyLines.push(`      <p>${escapeXmlText(text).replace(/\r?\n/g, '<br/>')}</p>`);
        }
        const xhtml = [
            '<?xml version="1.0" encoding="utf-8"?>',
            '<!DOCTYPE html>',
            `<html xmlns="${EPUB_XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">`,
            '  <head>',
            '    <meta charset="utf-8"/>',
            `    <title>${escapeXmlText(chapterTitle)}</title>`,
            '    <link rel="stylesheet" type="text/css" href="style.css"/>',
            '  </head>',
            '  <body>',
            '    <section epub:type="chapter">',
            `      <h1>${escapeXmlText(chapterTitle)}</h1>`,
            ...bodyLines,
            '    </section>',
            '  </body>',
            '</html>',
            ''
        ].join('\n');
        entries.push({ name: `OEBPS/${fileName}`, data: xhtml });
        chapterFiles.push({ fileName, chapterTitle });
    });

    // 4) 样式（正文缩进 + 图片居中且不溢出）
    const css = [
        'body { font-family: serif; line-height: 1.7; margin: 1em; }',
        'h1 { font-size: 1.2em; text-align: center; margin: 1.2em 0 0.8em; }',
        'p { text-indent: 2em; margin: 0 0 0.6em; }',
        'figure { margin: 1em 0; text-align: center; }',
        'figure img { max-width: 100%; height: auto; }'
    ].join('\n') + '\n';
    entries.push({ name: 'OEBPS/style.css', data: css });

    // 5) 图片资源（href 形如 images/img-0001.jpg，相对 OEBPS/）
    for (const asset of assets) {
        entries.push({ name: `OEBPS/${asset.href}`, data: asset.data });
    }

    // 6) nav.xhtml（EPUB3 目录）
    const navItems = chapterFiles
        .map((c) => `        <li><a href="${escapeXmlAttr(c.fileName)}">${escapeXmlText(c.chapterTitle)}</a></li>`)
        .join('\n');
    const navXhtml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<!DOCTYPE html>',
        `<html xmlns="${EPUB_XHTML_NS}" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh">`,
        '  <head><meta charset="utf-8"/><title>目录</title></head>',
        '  <body>',
        '    <nav epub:type="toc" id="toc">',
        '      <h1>目录</h1>',
        '      <ol>',
        navItems,
        '      </ol>',
        '    </nav>',
        '  </body>',
        '</html>',
        ''
    ].join('\n');
    entries.push({ name: 'OEBPS/nav.xhtml', data: navXhtml });

    // 7) toc.ncx（EPUB2 兼容目录，与 nav 同目录）
    const navPoints = chapterFiles.map((c, i) => [
        `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">`,
        `      <navLabel><text>${escapeXmlText(c.chapterTitle)}</text></navLabel>`,
        `      <content src="${escapeXmlAttr(c.fileName)}"/>`,
        '    </navPoint>'
    ].join('\n')).join('\n');
    const ncx = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">',
        '  <head>',
        `    <meta name="dtb:uid" content="${escapeXmlAttr(identifier)}"/>`,
        '    <meta name="dtb:depth" content="1"/>',
        '    <meta name="dtb:totalPageCount" content="0"/>',
        '    <meta name="dtb:maxPageNumber" content="0"/>',
        '  </head>',
        `  <docTitle><text>${escapeXmlText(bookTitle)}</text></docTitle>`,
        '  <navMap>',
        navPoints,
        '  </navMap>',
        '</ncx>',
        ''
    ].join('\n');
    entries.push({ name: 'OEBPS/toc.ncx', data: ncx });

    // 8) content.opf（EPUB3 包文档：manifest / spine 与实际条目一一对应）
    const manifestItems = [
        '    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
        '    <item id="css" href="style.css" media-type="text/css"/>'
    ];
    const spineItems = [];
    chapterFiles.forEach((c, i) => {
        const id = `ch-${String(i + 1).padStart(4, '0')}`;
        manifestItems.push(`    <item id="${id}" href="${escapeXmlAttr(c.fileName)}" media-type="application/xhtml+xml"/>`);
        spineItems.push(`    <itemref idref="${id}"/>`);
    });
    assets.forEach((asset, i) => {
        const id = `img-${String(i + 1).padStart(4, '0')}`;
        manifestItems.push(`    <item id="${id}" href="${escapeXmlAttr(asset.href)}" media-type="${escapeXmlAttr(asset.mediaType)}"/>`);
    });
    const opf = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">',
        '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
        `    <dc:identifier id="bookid">${escapeXmlText(identifier)}</dc:identifier>`,
        `    <dc:title>${escapeXmlText(bookTitle)}</dc:title>`,
        '    <dc:language>zh</dc:language>',
        `    <dc:creator>${escapeXmlText(author)}</dc:creator>`,
        `    <meta property="dcterms:modified">${modified}</meta>`,
        '  </metadata>',
        '  <manifest>',
        ...manifestItems,
        '  </manifest>',
        '  <spine toc="ncx">',
        ...spineItems,
        '  </spine>',
        '</package>',
        ''
    ].join('\n');
    entries.push({ name: 'OEBPS/content.opf', data: opf });

    return buildZip(entries);
}

// ---------- 图片魔数嗅探（不猜格式：只认 PNG / JPEG / GIF / WebP） ----------
function sniffImageType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf.length >= 8
        && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47
        && buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) {
        return { mediaType: 'image/png', ext: 'png' };
    }
    // JPEG: FF D8 FF
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
        return { mediaType: 'image/jpeg', ext: 'jpg' };
    }
    // GIF: 47 49 46 38（GIF8）
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return { mediaType: 'image/gif', ext: 'gif' };
    }
    // WebP: RIFF????WEBP
    if (buf.length >= 12
        && buf.toString('latin1', 0, 4) === 'RIFF'
        && buf.toString('latin1', 8, 12) === 'WEBP') {
        return { mediaType: 'image/webp', ext: 'webp' };
    }
    return null;
}

/**
 * 推导酒馆根目录 <ST>（其下应有 data/ 目录）
 * 优先级：opts.stRoot 显式覆盖 → 插件目录向上两级（<ST>/plugins/auto-save）→ process.cwd() 兜底
 */
function resolveStRoot(stRoot) {
    if (typeof stRoot === 'string' && stRoot.trim()) {
        return path.resolve(stRoot.trim());
    }
    const derived = path.resolve(__dirname, '..', '..');
    try {
        if (fs.statSync(path.join(derived, 'data')).isDirectory()) {
            return derived;
        }
    } catch (err) {
        // 忽略：推导目录不存在时走进程工作目录兜底
    }
    return path.resolve(process.cwd());
}

/** childPath 解析后是否仍位于 parentDir 之内（防 ../ 越界） */
function isPathInside(parentDir, childPath) {
    const parent = path.resolve(parentDir);
    const child = path.resolve(childPath);
    return child === parent || child.startsWith(parent + path.sep);
}

async function statFileMaybe(targetPath) {
    try {
        const stat = await fs.promises.stat(targetPath);
        return stat.isFile() ? stat : null;
    } catch (err) {
        return null;
    }
}

/**
 * 把消息里的 `/user/images/…` URL 前缀解析为磁盘绝对路径。
 *
 * 解析顺序（设计文档 §3.5，严格按序，命中即返回）：
 *   1) <ST>/data/<account>/user/images/<rel>      ← 该聊天所属账号（首选）
 *   2) <ST>/data/default-user/user/images/<rel>
 *   3) <ST>/data/<其它账号>/user/images/<rel>      ← 通配兜底，多个命中取第一个并 console.warn
 *   4) 都不命中 → { ok:false, reason:'missing' }
 *
 * 关键：磁盘侧【不做 URL 编解码】（中文原样 UTF-8）；拒绝 ../ 越界与逃出 <ST>/data。
 *
 * @param {string} imagePath 形如 `/user/images/<聊天目录>/<文件>.jpg`
 * @param {{ account?: string, stRoot?: string }} [opts]
 * @returns {Promise<{ok:true, absPath:string, rel:string, via:string, account?:string, bytes:number}
 *                  | {ok:false, reason:string}>}
 */
async function resolveImagePath(imagePath, opts = {}) {
    const URL_PREFIX = '/user/images/';
    if (typeof imagePath !== 'string' || !imagePath) {
        return { ok: false, reason: 'unsupported_path' };
    }
    if (!imagePath.startsWith(URL_PREFIX)) {
        return { ok: false, reason: 'unsupported_path' };
    }
    const rel = imagePath.slice(URL_PREFIX.length);
    if (!rel || rel.includes('\0')) {
        return { ok: false, reason: 'unsupported_path' };
    }
    // 拒绝路径穿越：rel 中出现 .. 或 . 段一律拒绝（磁盘侧不做 URL 解码，编码过的 .. 也不会被解码出来）
    if (rel.split('/').some((segment) => segment === '..' || segment === '.')) {
        return { ok: false, reason: 'path_traversal' };
    }

    const stRoot = resolveStRoot(opts.stRoot);
    const dataRoot = path.join(stRoot, 'data');

    const tryCandidate = async (absPath, via, account) => {
        if (!isPathInside(dataRoot, absPath)) return null;
        const stat = await statFileMaybe(absPath);
        if (!stat) return null;
        return { ok: true, absPath, rel, via, ...(account ? { account } : {}), bytes: stat.size };
    };

    // 1) 指定账号（账号名本身也做穿越校验，非法则跳过该步）
    if (typeof opts.account === 'string') {
        const account = opts.account.trim();
        const accountSafe = account && !account.includes('/') && !account.includes('\\')
            && !account.includes('..') && account !== '.';
        if (accountSafe) {
            const hit = await tryCandidate(path.join(dataRoot, account, 'user', 'images', rel), 'account', account);
            if (hit) return hit;
        }
    }

    // 2) default-user
    {
        const hit = await tryCandidate(path.join(dataRoot, 'default-user', 'user', 'images', rel), 'default-user', 'default-user');
        if (hit) return hit;
    }

    // 3) data/* 通配兜底（账号目录排序保证结果确定；命中多个必须告警，不能静默选）
    let accountDirs = [];
    try {
        const dirents = await fs.promises.readdir(dataRoot, { withFileTypes: true });
        accountDirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name).sort();
    } catch (err) {
        accountDirs = [];
    }
    const globHits = [];
    for (const account of accountDirs) {
        if (account === 'default-user') continue;
        const hit = await tryCandidate(path.join(dataRoot, account, 'user', 'images', rel), 'glob', account);
        if (hit) globHits.push(hit);
    }
    if (globHits.length > 0) {
        if (globHits.length > 1) {
            console.warn(`[${pluginName}] 图片在多账号下同时命中（${globHits.map((h) => h.account).join(', ')}），取第一个: ${rel}`);
        }
        return globHits[0];
    }

    // 4) 未命中：调用方必须把 missing 报给前端，不得静默跳过
    return { ok: false, reason: 'missing' };
}

/**
 * 读取并校验一张图片（单图失败不抛异常，交给调用方汇总为跳过清单）
 * @param {string} absPath
 * @param {{ maxImageBytes?: number }} [options]
 * @returns {Promise<{ok:true, data:Buffer, mediaType:string, ext:string, bytes:number}
 *                  | {ok:false, reason:string, bytes?:number, detail?:string}>}
 */
async function readImageAsset(absPath, options = {}) {
    const maxImageBytes = (Number.isFinite(options.maxImageBytes) && options.maxImageBytes > 0)
        ? Math.floor(options.maxImageBytes)
        : DEFAULT_MAX_IMAGE_BYTES;
    try {
        const stat = await fs.promises.stat(absPath).catch(() => null);
        if (!stat || !stat.isFile()) {
            return { ok: false, reason: 'missing' };
        }
        if (stat.size > maxImageBytes) {
            return { ok: false, reason: 'too_large', bytes: stat.size };
        }
        const data = await fs.promises.readFile(absPath);
        if (data.length > maxImageBytes) {
            return { ok: false, reason: 'too_large', bytes: data.length };
        }
        const type = sniffImageType(data);
        if (!type) {
            return { ok: false, reason: 'unsupported_format', bytes: data.length };
        }
        return { ok: true, data, mediaType: type.mediaType, ext: type.ext, bytes: data.length };
    } catch (err) {
        return { ok: false, reason: 'unreadable', detail: err.message };
    }
}

/** 请求体里的字节上限参数规范化（非法值回落到默认值） */
function normalizeByteLimit(value, fallback) {
    const num = Number(value);
    return (Number.isFinite(num) && num > 0) ? Math.floor(num) : fallback;
}

/**
 * 块是否为图片块：兼容契约 p/img（type:'img'）与前端实际命名 text/image（type:'image'），
 * 以及无 type 但带 path 的旧数据。
 */
function isImageBlock(block) {
    if (!block || typeof block !== 'object') return false;
    return (block.type === 'img' || block.type === 'image')
        || (!block.type && typeof block.path === 'string');
}

/** 取图片块里的图片路径：优先 path，其次 href（前端两种命名都有） */
function getBlockImagePath(block) {
    if (typeof block.path === 'string' && block.path) return block.path;
    return (typeof block.href === 'string') ? block.href : '';
}

/**
 * 规范化并校验 EPUB 相关接口（/ebook 与 /ebook/estimate）共用的请求体。
 * 两条路径共用同一份校验逻辑，避免「预估能过、导出却 400」之类的规则分叉；
 * 无效请求的 400 JSON 文案与历史保持一致。
 *
 * @param {object} body 原始请求体
 * @returns {{ok:true, bookTitle:string, author:*, account:*, chapters:Array<object>,
 *            maxImageBytes:number, maxTotalBytes:number, stRoot:string}
 *          | {ok:false, status:number, payload:object}}
 */
function normalizeEbookRequest(body) {
    if (!body || typeof body !== 'object') {
        return { ok: false, status: 400, payload: { error: '无效请求' } };
    }

    const { bookTitle, author, account, chapters } = body;
    const rawOptions = (body.options && typeof body.options === 'object') ? body.options : {};

    if (typeof bookTitle !== 'string' || !bookTitle.trim()) {
        return { ok: false, status: 400, payload: { error: '无效请求', detail: 'bookTitle 必须是非空字符串' } };
    }
    if (!Array.isArray(chapters) || chapters.length === 0) {
        return { ok: false, status: 400, payload: { error: '无效请求', detail: 'chapters 必须是非空数组' } };
    }

    return {
        ok: true,
        bookTitle,
        author,
        account,
        chapters,
        // 生效上限：与 /ebook 完全一致地规范化（非法值回落默认 5MB 单图 / 80MB 总量）
        maxImageBytes: normalizeByteLimit(rawOptions.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES),
        maxTotalBytes: normalizeByteLimit(rawOptions.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
        stRoot: (typeof rawOptions.stRoot === 'string') ? rawOptions.stRoot : ''
    };
}

/**
 * 组装图片电子书（/ebook 共用管线）：请求校验 → 逐图解析/读盘 → 打包 EPUB Buffer。
 * 服务端落盘模式与下载模式（delivery=download）共用本函数，保证两条交付路径的
 * 校验顺序、图片解析规则、413 语义与产出的 EPUB 字节完全一致；本函数绝不落盘。
 *
 * @param {object} body POST /ebook 原始请求体
 * @returns {Promise<{ok:true, epubBuffer:Buffer, chapters:Array<object>, assets:Array<object>, missing:Array<object>}
 *                  | {ok:false, status:number, payload:object}>}
 */
async function buildEbookArtifacts(body) {
    const request = normalizeEbookRequest(body);
    if (!request.ok) {
        return { ok: false, status: request.status, payload: request.payload };
    }
    const { bookTitle, author, account, chapters, maxImageBytes, maxTotalBytes, stRoot } = request;

    // 逐图解析 + 读取：成功则编号进 assets 并回填 href；失败只记入 missing（绝不静默跳过）
    const assets = [];
    const missing = [];
    const normalizedChapters = [];
    let totalImageBytes = 0;

    for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
        const chapter = (chapters[chapterIndex] && typeof chapters[chapterIndex] === 'object') ? chapters[chapterIndex] : {};
        const sourceBlocks = Array.isArray(chapter.blocks) ? chapter.blocks : [];
        const nextBlocks = [];

        for (const block of sourceBlocks) {
            if (!block || typeof block !== 'object') continue;
            // 兼容两种块命名：契约 p/img，前端 buildStructuredNovel 实际用 text/image
            if (!isImageBlock(block)) {
                nextBlocks.push({ type: 'p', text: (typeof block.text === 'string') ? block.text : '' });
                continue;
            }

            const imagePath = getBlockImagePath(block);
            const resolved = await resolveImagePath(imagePath, { account, stRoot });
            if (!resolved.ok) {
                missing.push({ path: imagePath, reason: resolved.reason, chapter: chapterIndex + 1 });
                continue;
            }
            const asset = await readImageAsset(resolved.absPath, { maxImageBytes });
            if (!asset.ok) {
                missing.push({
                    path: imagePath,
                    reason: asset.reason,
                    chapter: chapterIndex + 1,
                    ...(asset.bytes !== undefined ? { bytes: asset.bytes } : {})
                });
                continue;
            }
            totalImageBytes += asset.bytes;
            if (totalImageBytes > maxTotalBytes) {
                return {
                    ok: false,
                    status: 413,
                    payload: {
                        error: `图片总量超出 ${Math.round(maxTotalBytes / 1024 / 1024)}MB 限制`,
                        detail: `累计 ${totalImageBytes} 字节 > ${maxTotalBytes} 字节`
                    }
                };
            }
            const href = `images/img-${String(assets.length + 1).padStart(4, '0')}.${asset.ext}`;
            assets.push({ href, data: asset.data, mediaType: asset.mediaType });
            nextBlocks.push({
                type: 'img',
                href,
                alt: (typeof block.alt === 'string' && block.alt) ? block.alt : ''
            });
        }

        normalizedChapters.push({
            title: (typeof chapter.title === 'string') ? chapter.title : '',
            floor: chapter.floor,
            blocks: nextBlocks
        });
    }

    // 组装 EPUB（即使一张图都没嵌入也允许导出纯文字电子书）
    const epubBuffer = buildEpubBuffer({
        bookTitle,
        author,
        chapters: normalizedChapters,
        assets
    });

    return { ok: true, epubBuffer, chapters: normalizedChapters, assets, missing };
}

/**
 * 只读取文件头部若干字节（体积预估只看魔数，绝不把整张图片读进内存）。
 * 用 open + read 精确读取，而非 readFile：即使目标是大文件也不会有整图内存开销。
 * 读取失败（权限 / IO / 文件消失）返回 null，由调用方归类处理。
 * @param {string} absPath
 * @param {number} [byteLength]
 * @returns {Promise<Buffer|null>}
 */
async function readFileHead(absPath, byteLength = IMAGE_MAGIC_HEAD_BYTES) {
    let handle = null;
    try {
        handle = await fs.promises.open(absPath, 'r');
        const buffer = Buffer.alloc(byteLength);
        const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
        return buffer.subarray(0, bytesRead);
    } catch (err) {
        return null;
    } finally {
        if (handle) {
            await handle.close().catch(() => {});
        }
    }
}

/**
 * 轻量预估图片体积（POST /ebook/estimate 核心，导出的内部函数仅测试/复用）。
 * 只做「路径解析 + stat + 文件头魔数嗅探」三件事：绝不读取整张图片、绝不打包 EPUB、
 * 绝不做任何磁盘写入/目录创建，因此对 130MB+ 的大量图片也能近乎零成本地先给出结论。
 *
 * 计数口径（与服务端实际嵌入行为保持一致）：
 * - 每个图片块引用各计一次（同一 path 重复引用按多次计，与 /ebook 实际嵌入份数一致）
 * - resolveImagePath 失败或 stat 失败 → missing（打包时同样跳过）
 * - stat.size > maxImageBytes → oversize（打包时 readImageAsset 会以 too_large 跳过）
 * - 文件头魔数非 PNG/JPEG/GIF/WebP（含头部读取失败）→ unsupported（打包时同样跳过）
 * - 其余计入 embeddable，并累加其实际字节数到 estimatedBytes
 * - resolvable = embeddable + oversize + unsupported（即"路径可解析到文件"的引用数）
 *
 * @param {{account?:string, chapters:Array<object>, maxImageBytes:number, maxTotalBytes:number, stRoot?:string}} request
 *        normalizeEbookRequest() 返回的 ok 结果
 * @returns {Promise<{success:true, images:{totalReferences:number, resolvable:number, embeddable:number,
 *           missing:number, oversize:number, unsupported:number, estimatedBytes:number},
 *           limits:{maxImageBytes:number, maxTotalBytes:number}, overTotalLimit:boolean}>}
 */
async function estimateEbookImages(request) {
    const { account, chapters, maxImageBytes, maxTotalBytes, stRoot } = request;
    let totalReferences = 0;
    let embeddable = 0;
    let missing = 0;
    let oversize = 0;
    let unsupported = 0;
    let estimatedBytes = 0;

    for (const chapter of chapters) {
        if (!chapter || typeof chapter !== 'object') continue;
        const sourceBlocks = Array.isArray(chapter.blocks) ? chapter.blocks : [];
        for (const block of sourceBlocks) {
            if (!isImageBlock(block)) continue;
            totalReferences++;

            const imagePath = getBlockImagePath(block);
            const resolved = await resolveImagePath(imagePath, { account, stRoot });
            if (!resolved.ok) {
                missing++;
                continue;
            }
            const stat = await statFileMaybe(resolved.absPath);
            if (!stat) {
                // resolve 成功但文件随后消失/不可 stat：按缺失计（与打包路径的跳过口径一致）
                missing++;
                continue;
            }
            if (stat.size > maxImageBytes) {
                oversize++;
                continue;
            }
            // 只读文件头 16 字节：魔数合法才可能真正被嵌入
            const head = await readFileHead(resolved.absPath, IMAGE_MAGIC_HEAD_BYTES);
            const type = head ? sniffImageType(head) : null;
            if (!type) {
                unsupported++;
                continue;
            }
            embeddable++;
            estimatedBytes += stat.size;
        }
    }

    const resolvable = embeddable + oversize + unsupported;
    return {
        success: true,
        images: {
            totalReferences,
            resolvable,
            embeddable,
            missing,
            oversize,
            unsupported,
            estimatedBytes
        },
        limits: { maxImageBytes, maxTotalBytes },
        overTotalLimit: estimatedBytes > maxTotalBytes
    };
}

async function init(router) {
    console.log(`[${pluginName}] 小说连载服务插件正在初始化...`);
    await ensureLogsDir();
    await loadNovelRegistry();

    // 状态探针接口：用于前端检测服务端插件是否正常运行
    router.get('/status', async (req, res) => {
        res.json({
            ready: true,
            plugin: pluginName,
            version: '1.16.0',
            // 能力声明：前端据此 feature-detect（比比较版本号更可靠，老服务端没有该字段）
            capabilities: {
                append: true,
                syncAll: true,
                tailGuard: true,      // v1.13.0：末尾章守卫 / 备份 / 原子写
                ebook: true,          // v1.14.0：POST /ebook 图片电子书
                ebookDownload: true,  // v1.15.0：POST /ebook delivery=download 直接返回二进制 EPUB
                ebookEstimate: true   // v1.16.0：POST /ebook/estimate 导出前体积预估（不读整图/不落盘）
            },
            logsDir: LOGS_DIR
        });
    });

    router.post('/append', async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== 'object') {
                return res.status(400).json({ error: '无效请求' });
            }

            const { name, mes, is_user, characterName, chapterNumber, chapterStyle, save_dir, is_regenerate, floor, is_greeting, chat_anchor, file_name } = body;

            if (!mes || typeof mes !== 'string') {
                return res.status(400).json({ error: '正文内容不能为空' });
            }

            // 单条长度防护 (100KB)
            const byteLength = Buffer.byteLength(mes, 'utf8');
            if (byteLength > MAX_MESSAGE_BYTES) {
                return res.status(413).json({ error: '单章节篇幅过大，超出 100KB 限制' });
            }

            // 安全书名（扉页/首行《书名》用，保持纯净标题，不含账号前缀）
            const bookTitle = sanitizeFilename(characterName || name);

            // 支持自定义存储目录（绝对路径或相对酒馆运行目录），留空则使用默认 logs 目录
            const dirResult = resolveTargetDirectory(save_dir);
            if (!dirResult.success) {
                return res.status(400).json({ error: dirResult.error });
            }
            const targetDir = dirResult.dir;
            await fs.promises.mkdir(targetDir, { recursive: true });

            // 聊天 ID 锚定：聊天改名自动跟随重命名（file_name 含多账号前缀时优先）
            const anchorResult = await resolveAnchoredTargetPath({ chat_anchor, file_name, characterName, name, targetDir, bookTitle });
            const targetFilePath = anchorResult.targetFilePath;

            // 排队进入写入队列，确保并发写操作安全有序
            const result = await runInFileQueue(targetFilePath, async () => {
                const stat = await fs.promises.stat(targetFilePath).catch(() => null);
                const isNewFile = !stat || stat.size === 0;

                // 问候语补写模式：小说已有内容（含旧版已写入问候语的书）直接跳过绝不重复；全新文件则作为第 1 章写入
                if (is_greeting && !isNewFile) {
                    return {
                        skipped: true,
                        reason: '小说已有内容，问候语无需补写',
                        file: path.relative(process.cwd(), targetFilePath)
                    };
                }

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

                // 章号已存在守卫（D1/D4）：非 regenerate 的追加请求若文件里已有同号章节：
                //   · 同号章节正好是末尾章 → 自动纠正为“替换末尾章”（滑动早期楼层不再产生重复章）；
                //   · 同号章节不是末尾章 → HTTP 409 拒绝重复追加，且绝不改动文件。
                // 问候语补写有自己的 isNewFile/跳过语义，不套用本守卫。
                let autoReplaceExisting = false;
                if (!isNewFile && !is_regenerate && !is_greeting) {
                    const numberText = (chapterNumber === undefined || chapterNumber === null) ? '' : String(chapterNumber).trim();
                    if (isNumberedChapterStyle(chapterStyle) && /^\d+$/.test(numberText)) {
                        const existingContent = await fs.promises.readFile(targetFilePath, 'utf8').catch(() => '');
                        const existingHeadings = extractChapterHeadings(existingContent);
                        const sameNumber = existingHeadings.filter((h) => h.number === parseInt(numberText, 10));
                        if (sameNumber.length > 0) {
                            const tailChapter = existingHeadings[existingHeadings.length - 1];
                            const targetIsTail = tailChapter && tailChapter.index === sameNumber[sameNumber.length - 1].index;
                            if (targetIsTail) {
                                autoReplaceExisting = true;
                            } else {
                                console.warn(`[${pluginName}] 第 ${numberText} 章已存在于文件中且不是末尾章，拒绝重复追加`);
                                return {
                                    conflict: true,
                                    httpStatus: 409,
                                    reason: 'chapter_exists',
                                    chapterNumber,
                                    error: `第 ${numberText} 章已存在于文件中，已拒绝重复追加`,
                                    detail: 'chapter_exists'
                                };
                            }
                        }
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

                // 是否走了“替换已有章节”通道（regenerate 或同号末尾章自动纠正）
                const isReplacePath = !!is_regenerate || autoReplaceExisting;
                let replacedExisting = false;
                let backupDone = false;

                if (isNewFile) {
                    // 首次创建文件：写入 UTF-8 BOM 标识与《书名》扉页，完美适配阅读器目录与中文编码
                    const fileHeader = `${UTF8_BOM}《${bookTitle}》\n\n\n`;
                    await atomicWriteFile(targetFilePath, fileHeader + formattedNovel);
                } else if (isReplacePath) {
                    // 用户重新生成或滑动分支：智能替换末尾章节（精确定位该章节起始边界，避免残留旧草稿或误伤正文）
                    // 守卫失败（不是末尾章/找不到/序号非法/写失败）时绝不追加，直接以 409/500 回应
                    const replaceResult = await replaceLastChapter(targetFilePath, formattedNovel, chapterStyle, chapterNumber, { requireTail: true });
                    if (!replaceResult.replaced) {
                        const reason = replaceResult.reason || 'replace_failed';
                        return {
                            conflict: true,
                            httpStatus: reason === 'replace_failed' ? 500 : 409,
                            reason,
                            chapterNumber,
                            error: REPLACE_FAILURE_MESSAGES[reason] || REPLACE_FAILURE_MESSAGES.replace_failed,
                            detail: reason
                        };
                    }
                    replacedExisting = true;
                    backupDone = !!replaceResult.backup;
                } else {
                    // 正常追加新章节
                    await fs.promises.appendFile(targetFilePath, formattedNovel, { encoding: 'utf8' });
                }

                const relPath = path.relative(process.cwd(), targetFilePath);
                console.log(`[${pluginName}] 成功连载新章节 -> ${relPath}${isReplacePath ? ' (重写替换)' : ''}`);

                return {
                    skipped: false,
                    file: relPath,
                    is_regenerate: isReplacePath,
                    ...(replacedExisting ? { replaced_existing: true } : {}),
                    ...(backupDone ? { backup: true } : {})
                };
            });

            // 冲突/守卫拒绝：保持 { error, detail } 形态，并附 conflict/reason/chapterNumber 供前端分支
            if (result && result.conflict) {
                return res.status(result.httpStatus || 409).json({
                    success: false,
                    conflict: true,
                    reason: result.reason,
                    ...(result.chapterNumber !== undefined ? { chapterNumber: result.chapterNumber } : {}),
                    error: result.error,
                    detail: result.detail
                });
            }

            return res.json({
                success: true,
                skipped: result.skipped,
                reason: result.reason,
                file: result.file,
                is_regenerate: result.is_regenerate,
                ...(result.replaced_existing ? { replaced_existing: true } : {}),
                ...(result.backup ? { backup: true } : {}),
                ...(anchorResult.renamedFrom ? { renamed_from: anchorResult.renamedFrom } : {}),
                ...(anchorResult.keptName ? { kept_name: true } : {})
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

            const { characterName, fullText, save_dir, chat_anchor, file_name } = body;
            if (!fullText || typeof fullText !== 'string') {
                return res.status(400).json({ error: '小说正文不能为空' });
            }

            // 大小限制防护 (20MB)
            const byteLength = Buffer.byteLength(fullText, 'utf8');
            if (byteLength > 20 * 1024 * 1024) {
                return res.status(413).json({ error: '小说篇幅过大，超出 20MB 限制' });
            }

            const bookTitle = sanitizeFilename(characterName || '我的小说连载');

            const dirResult = resolveTargetDirectory(save_dir);
            if (!dirResult.success) {
                return res.status(400).json({ error: dirResult.error });
            }
            const targetDir = dirResult.dir;
            await fs.promises.mkdir(targetDir, { recursive: true });

            // 聊天 ID 锚定：全书重写同样走改名跟随（sync-all 内容本身就是新书名的全文，无需首行替换，但仍需迁移旧文件）
            const anchorResult = await resolveAnchoredTargetPath({ chat_anchor, file_name, characterName, targetDir, bookTitle });
            const targetFilePath = anchorResult.targetFilePath;

            await runInFileQueue(targetFilePath, async () => {
                // 确保包含 UTF-8 BOM 标识
                const contentWithBom = fullText.startsWith(UTF8_BOM) ? fullText : (UTF8_BOM + fullText);
                // D18：全量覆盖会立即丢弃旧内容，写前先备份（仅留最近一份 .bak；失败不阻断）
                await backupFile(targetFilePath);
                // 原子写：避免进程中断留下半截小说
                await atomicWriteFile(targetFilePath, contentWithBom);
            });

            const relPath = path.relative(process.cwd(), targetFilePath);
            console.log(`[${pluginName}] 成功全量同步历史小说 -> ${relPath}`);

            return res.json({
                success: true,
                file: relPath,
                ...(anchorResult.renamedFrom ? { renamed_from: anchorResult.renamedFrom } : {}),
                ...(anchorResult.keptName ? { kept_name: true } : {})
            });
        } catch (error) {
            console.error(`[${pluginName}] 全量同步异常:`, error);
            return res.status(500).json({
                error: '全量同步写入失败',
                detail: error.message
            });
        }
    });

    // 图片电子书导出接口：把前端组装好的「章节 blocks + 本地图片」按原位嵌入 EPUB3
    // 请求体见 review/图片电子书-设计方案.md §4.3；图片按 §3.5 四级顺序解析，单图失败只跳过不中断
    // v1.15.0：顶层 delivery='download' → 同一管线打包后直接返回二进制 EPUB（绝不落盘，save_dir 完全忽略）；
    //          缺省或其它值 → 原「落盘 + JSON」服务端模式，响应字段与行为保持向后兼容
    router.post('/ebook', async (req, res) => {
        try {
            const body = req.body;
            // 校验 / 图片解析 / EPUB 打包三条路径共用同一管线；失败仍返回 JSON（400/413/500），不设二进制头
            const artifacts = await buildEbookArtifacts(body);
            if (!artifacts.ok) {
                return res.status(artifacts.status).json(artifacts.payload);
            }
            const { epubBuffer, chapters: normalizedChapters, assets, missing } = artifacts;

            // ---------- 下载交付：只回二进制，全程零磁盘写入 ----------
            // 本分支绝不调用 resolveTargetDirectory / mkdir / backupFile / atomicWriteFile；
            // save_dir 即使非法也必须被完全忽略（下载模式不落盘，该路径没有意义）。
            if (body.delivery === 'download') {
                const downloadName = `${sanitizeFilename(body.bookTitle)}.epub`;
                res.status(200);
                res.setHeader('Content-Type', 'application/epub+zip');
                // filename 为 ASCII 兜底；filename* 按 RFC 5987 用 UTF-8'' 百分号编码承载中文书名
                res.setHeader('Content-Disposition',
                    `attachment; filename="novel.epub"; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
                res.setHeader('Content-Length', String(epubBuffer.length));
                // 仅回 ASCII 编码后的 JSON（encodeURIComponent 输出纯 ASCII），避免响应头出现裸非 ASCII
                res.setHeader('X-Novel-Epub-Stats', encodeURIComponent(JSON.stringify({
                    success: true,
                    epubBytes: epubBuffer.length,
                    images: { embedded: assets.length, skipped: missing.length }
                })));
                console.log(`[${pluginName}] 已生成 EPUB 下载响应（${normalizedChapters.length} 章 / 嵌入图片 ${assets.length} 张 / 跳过 ${missing.length} 张）`);
                return res.end(epubBuffer);
            }

            // ---------- 服务端交付（默认）：落盘 + JSON，行为与 v1.14.0 完全一致 ----------
            // 落盘：与 TXT 同目录策略（save_dir 解析规则一致），写前备份 + 原子写
            const dirResult = resolveTargetDirectory(body.save_dir);
            if (!dirResult.success) {
                return res.status(400).json({ error: dirResult.error });
            }
            const targetDir = dirResult.dir;
            await fs.promises.mkdir(targetDir, { recursive: true });
            const epubPath = path.join(targetDir, `${sanitizeFilename(body.bookTitle)}.epub`);

            await runInFileQueue(epubPath, async () => {
                await backupFile(epubPath); // 覆盖旧电子书前备份（.bak 仅留最近一份，失败不阻断）
                await atomicWriteFile(epubPath, epubBuffer);
            });

            const relPath = path.relative(process.cwd(), epubPath);
            console.log(`[${pluginName}] 成功导出 EPUB 电子书 -> ${relPath}（${normalizedChapters.length} 章 / 嵌入图片 ${assets.length} 张 / 跳过 ${missing.length} 张）`);

            return res.json({
                success: true,
                file: relPath,
                epubBytes: epubBuffer.length,
                images: {
                    embedded: assets.length,
                    skipped: missing.length,
                    missing
                }
            });
        } catch (error) {
            console.error(`[${pluginName}] EPUB 导出异常:`, error);
            return res.status(500).json({
                error: 'EPUB 导出失败',
                detail: error.message
            });
        }
    });

    // 体积预估接口（v1.16.0）：请求体与 /ebook 同构，但只做「路径解析 + stat + 文件头魔数嗅探」，
    // 供前端在导出前提示图片总量/超限情况；绝不读取整图、绝不打包、绝不落盘（save_dir 完全不解析）。
    router.post('/ebook/estimate', async (req, res) => {
        try {
            const request = normalizeEbookRequest(req.body);
            if (!request.ok) {
                return res.status(request.status).json(request.payload);
            }
            const result = await estimateEbookImages(request);
            return res.json(result);
        } catch (error) {
            console.error(`[${pluginName}] EPUB 体积预估异常:`, error);
            return res.status(500).json({
                error: 'EPUB 体积预估失败',
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
    // 以下为内部工具的测试导出（SillyTavern 只消费 init/exit/info，额外导出无副作用）
    replaceLastChapter,
    extractChapterHeadings,
    getTailChapter,
    escapeRegExp,
    backupFile,
    atomicWriteFile,
    // 图片电子书（EPUB）服务端能力（前端只走 /ebook HTTP 接口，这里导出便于单测/复用）
    buildZip,
    buildEpubBuffer,
    estimateEbookImages,
    resolveImagePath,
    resolveStRoot,
    sniffImageType,
    readImageAsset,
    escapeXmlText,
    escapeXmlAttr,
    default: {
        init,
        exit,
        info
    }
};
