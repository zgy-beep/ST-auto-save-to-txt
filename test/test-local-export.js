/**
 * 跨层集成测试：EPUB「导出时嵌入图片」开关门控 + 「下载到本机」交付
 * 运行方式: node test/test-local-export.js
 *
 * 为什么需要本文件（它和 test-ebook.js / test-fix-contract.js 有什么不同）：
 *   本次用户报告的 bug 是「前端开关点了没效果」与「只能写服务器不能下载」——这类缺陷
 *   前后端各自单测都能是绿的（前端单测断言 buildStructuredNovel 的块结构、服务端单测直接
 *   构造 payload），但真实用户路径是：前端真实 index.js 产出 payload → 服务端真实 /ebook
 *   打包 → 浏览器拿到 EPUB / JSON。本文件把这条链路真正连起来跑，断言落到最终产物：
 *     A. 前端 gating 矩阵：settings.ebook_embed_images=false/true 时 buildEbookPayload 的
 *        chapters 是否真的不带/带 image 块，文本块与章节标题是否与 TXT 路径同口径；
 *        delivery 参数是否只由调用方式决定（server/download）。
 *     B. 跨层服务端模式：false payload → 真实 /ebook 落盘的 EPUB 内没有图片条目、XHTML 无 <img；
 *        true payload → EPUB 内恰有 N 张图且章节 XHTML 原位引用。
 *     C. download 交付：与 server 模式同源（ZIP 条目/图片/章节一致、响应头契约）、
 *        filename* 中文可解码且无路径穿越、Content-Length、X-Novel-Epub-Stats、彻底零落盘、
 *        非法 save_dir 仍 200、413/400 仍是 JSON、零图纯文字下载。
 *     D. 静态接线：下载按钮存在且 click 接 exportEbook(..., 'download')、ebookDownload 能力门控、
 *        refreshNovelAccSummaries 不再引用越界 ebookEmbedEl、EPUB 开关用 checkbox_label、
 *        style.css 有 .novel-row 规则、版本号同步。
 *     E. 回归：/status 1.16.0 + ebook/ebookDownload/ebookEstimate 能力、缺省 delivery 仍走「落盘 + JSON」。
 *     G. 跨层体积预估（v1.19.0 / 插件 1.16.0）：真实前端 buildEbookPayload → 真实插件 /ebook/estimate，
 *        断言各计数与 estimatedBytes 精确等于 fixture 字节和、overTotalLimit 阈值语义、同一 path 重复引用
 *        按两次计、缺失/超单图上限/坏格式归类、零图全 0、400 仍 JSON、estimate 零落盘、/ebook 交付不退化；
 *        以及前端预检接线（estimate 在 confirm 之前、自动提限、能力门控、预览弹窗占位、静默降级）。
 *        判别性验证 M5-M7 对应 mutation 见 discriminative.js（去 overTotalLimit / missing 计入 bytes /
 *        前端删预检调用，目标断言必须变红）。
 *
 * 零第三方依赖（只用 Node 内置模块 + 仓库自带 test/_helpers/load-index.js）；
 * 所有临时文件在 os.tmpdir() 下，try/finally 清理，不在仓库内留任何文件。
 *
 * 判别性验证（证明本测试不是空转）：review/_scratch/verify-v118/discriminative.js 会把最终
 * index.js / 插件复制到 temp 做定点突变，再用本文件同源断言跑突变副本，目标断言必须变红。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { loadIndexModule } = require('./_helpers/load-index.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.join(REPO_ROOT, 'index.js');
const STYLE_PATH = path.join(REPO_ROOT, 'style.css');
const MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');
const PLUGIN_PATH = path.join(REPO_ROOT, 'plugins', 'auto-save', 'index.js');
const PLUGIN_PACKAGE_PATH = path.join(REPO_ROOT, 'plugins', 'auto-save', 'package.json');

const plugin = require(PLUGIN_PATH);

// ==================== 测试用 MockRouter（收集 JSON 体 / Buffer 体 / 响应头） ====================
class MockRouter {
    constructor() {
        this.routes = {};
    }
    post(routePath, handler) {
        this.routes[`POST ${routePath}`] = handler;
    }
    get(routePath, handler) {
        this.routes[`GET ${routePath}`] = handler;
    }
    async dispatch(method, url, body) {
        const handler = this.routes[`${method} ${url}`];
        if (!handler) {
            throw new Error(`404 Not Found: ${method} ${url}`);
        }
        let statusCode = 200;
        let responseData = null;
        let responseBuffer = null;
        const headers = {};
        const req = { body };
        const res = {
            status: function (code) {
                statusCode = code;
                return this;
            },
            setHeader: function (name, value) {
                headers[String(name).toLowerCase()] = String(value);
                return this;
            },
            getHeader: function (name) {
                return headers[String(name).toLowerCase()];
            },
            json: function (data) {
                responseData = data;
                return this;
            },
            send: function (data) {
                if (Buffer.isBuffer(data)) responseBuffer = data;
                else if (typeof data === 'string') responseBuffer = Buffer.from(data, 'utf8');
                else responseData = data;
                return this;
            },
            end: function (data) {
                if (data !== undefined && data !== null) {
                    responseBuffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
                }
                return this;
            }
        };
        await handler(req, res);
        return { status: statusCode, data: responseData, buffer: responseBuffer, headers };
    }
}

// ==================== 极简 ZIP 读取器（解压 EPUB 断言条目；零依赖） ====================
/** 解析 ZIP（EOCD → 中央目录 → 本地头 → inflate）并返回全部条目 */
function readZip(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('ZIP 数据过短');
    if (buf.readUInt32LE(buf.length - 22) !== 0x06054B50) throw new Error('EOCD 签名不存在');
    const total = buf.readUInt16LE(buf.length - 22 + 10);
    const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
    const entries = [];
    let p = cdOffset;
    for (let i = 0; i < total; i++) {
        if (buf.readUInt32LE(p) !== 0x02014B50) throw new Error(`中央目录条目 ${i} 签名错误`);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const csize = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
        if (buf.readUInt32LE(localOffset) !== 0x04034B50) throw new Error(`条目 ${name} 本地头签名错误`);
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const compressed = buf.subarray(dataStart, dataStart + csize);
        const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed);
        entries.push({ name, method, flags, data });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, byName: Object.fromEntries(entries.map((e) => [e.name, e])) };
}

/** 抽取 XHTML 中全部 <img src="..."> */
function extractImgSrcs(xhtml) {
    return [...String(xhtml || '').matchAll(/<img\s[^>]*?src="([^"]*)"/g)].map((m) => m[1]);
}

/** 找出 index.js 中模块级函数的源码范围（1-based 闭区间；模块级函数以列 0 的 } 收尾） */
function findFunctionRange(lines, name) {
    const declRe = new RegExp('^[ \\t]*(?:async\\s+)?function\\s+' + name + '\\s*\\(');
    let start = -1;
    for (let i = 0; i < lines.length; i++) {
        if (declRe.test(lines[i])) { start = i; break; }
    }
    if (start < 0) return null;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^\}\s*$/.test(lines[i])) return { start: start + 1, end: i + 1 };
    }
    return null;
}

function fileSha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 深拷贝「线上传输形态」的 payload（JSON 序列化后再解析，顺带验证可序列化） */
function wireClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

/** 归一化 content.opf 里的 dcterms:modified 时间戳（两次打包唯一可能不同的字节来源） */
function normalizeEpubForCompare(buf) {
    const zip = readZip(buf);
    return {
        entries: zip.entries,
        names: zip.entries.map((e) => e.name),
        byName: zip.byName
    };
}

/** 比较两条 EPUB 字节：条目集合/非 opf 内容/opf 去时间戳后是否一致 */
function diffEpub(buffers) {
    const [a, b] = buffers.map(normalizeEpubForCompare);
    const namesEqual = a.names.length === b.names.length
        && a.names.every((n, i) => n === b.names[i]);
    const differing = [];
    let opfEqualAfterNormalize = false;
    if (namesEqual) {
        for (const name of a.names) {
            const da = a.byName[name].data;
            const db = b.byName[name].data;
            if (name === 'OEBPS/content.opf') {
                const norm = (d) => d.toString('utf8').replace(
                    /<meta property="dcterms:modified">[^<]*<\/meta>/,
                    '<meta property="dcterms:modified">NORMALIZED</meta>'
                );
                opfEqualAfterNormalize = norm(da) === norm(db);
                if (!opfEqualAfterNormalize) differing.push(name);
            } else if (!da.equals(db)) {
                differing.push(name);
            }
        }
    } else {
        differing.push('(条目集合不同)');
    }
    return { namesEqual, differing, opfEqualAfterNormalize };
}

// ==================== 测试图片（魔数有效即可，不参与解码） ====================
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);
// 1x1 JPEG（与 test-ebook.js 同一 fixture；G 组用 JPEG 验证魔数嗅探不只认 PNG）
const JPEG_1PX = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbf8a28a2803ffd9',
    'hex'
);
// G 组超单图上限 fixture：PNG 魔数合法 + 1.2MB 填充（G 前端 settings.ebook_max_image_mb=1 → 1MB 上限）
const OVERSIZE_PNG = Buffer.concat([PNG_1PX, Buffer.alloc(1200 * 1024, 0)]);
// G 组坏格式 fixture：非图片字节，且 < 50B（调小 maxImageBytes=50 的场景里仍应归 unsupported）
const JUNK_BYTES = Buffer.from('not an image, just junk bytes');

async function runTests() {
    console.log('=== 开始执行跨层集成测试：EPUB 嵌入开关门控 + 本机下载 ===\n');
    let passCount = 0;
    let failCount = 0;
    const failures = [];

    function assert(condition, testName) {
        if (condition) {
            console.log(`[PASS] ${testName}`);
            passCount++;
        } else {
            console.error(`[FAIL] ${testName}`);
            failCount++;
            failures.push(testName);
        }
    }

    // 运行前记录实现指纹：本测试锁的是「真实实现」，哈希变化时结论需重新确认
    const fingerprints = {
        index: fileSha256(INDEX_PATH),
        style: fileSha256(STYLE_PATH),
        plugin: fileSha256(PLUGIN_PATH),
        manifest: fileSha256(MANIFEST_PATH)
    };
    console.log('实现指纹（sha256）：');
    console.log('  index.js   :', fingerprints.index);
    console.log('  style.css  :', fingerprints.style);
    console.log('  plugin     :', fingerprints.plugin);
    console.log('  manifest   :', fingerprints.manifest);
    console.log('');

    // ==================== 0. 加载真实前端 / 服务端 ====================
    console.log('--- 0. 加载真实实现（前端 index.js + 服务端插件） ---');
    const TMP = path.join(os.tmpdir(), `novel-crosslayer-${process.pid}-${Date.now()}`);
    const ST_ROOT = path.join(TMP, 'st');
    const DATA_ROOT = path.join(ST_ROOT, 'data');
    const ACCOUNT = 'tester';
    const CHAT_DIR = '跨层测试';
    const IMG_A = '/user/images/跨层测试/a.png';
    const IMG_B = '/user/images/跨层测试/b.png';
    const OUT_SERVER_OFF = path.join(TMP, 'out-server-off');
    const OUT_SERVER_ON = path.join(TMP, 'out-server-on');
    const DL_OUT = path.join(TMP, 'download-out-never-created');
    const REG_OUT = path.join(TMP, 'regression-out');

    const bbi = (slots) => {
        const bucket = {};
        for (const s of slots) {
            bucket['h' + s.slotSeq] = [{
                generationId: 'g' + s.slotSeq,
                path: s.path,
                prompt: s.prompt || ('prompt' + s.slotSeq),
                seed: 1,
                status: s.status || 'ready',
                createdAt: 1,
                slotSeq: s.slotSeq
            }];
        }
        return { '0': bucket };
    };

    const CHAT = [
        {
            mes: '　　她推开门。\n\n　　夜色如墨。',
            is_user: false, name: '艾莉丝', extra: {}
        },
        {
            mes: '　　风起。\n<bbi_image>first prompt\n　　云涌。\n<bbi_image>second prompt\n　　雨落。',
            is_user: false, name: '艾莉丝',
            extra: {
                bbiImage: bbi([
                    { path: IMG_A, prompt: 'first prompt', slotSeq: 0 },
                    { path: IMG_B, prompt: 'second prompt', slotSeq: 1 }
                ])
            }
        }
    ];

    /** 前端 harness：伪造最小 ST context，加载真实 index.js。
     *  chatOverride 用于 G 组自定义图片聊天（缺省沿用 A-F 的 CHAT，不影响既有断言）。 */
    function makeFrontend(settingsOverride, chatOverride) {
        const chat = Array.isArray(chatOverride) ? chatOverride : CHAT;
        const settings = Object.assign({}, frontendBase.DEFAULT_SETTINGS, {
            enabled: true,
            include_user_dialogue: false,
            chapter_style: 'numbered_floor',
            naming_rule: 'char_chat',
            indent_paragraphs: true,
            ebook_max_image_mb: 5,
            ebook_max_total_mb: 80,
            ebook_st_root: ST_ROOT,
            save_dir: OUT_SERVER_ON,
            ebook_embed_images: false
        }, settingsOverride || {});
        const ctxObj = {
            chat,
            chatId: '跨层测试.jsonl',
            chatMetadata: {},
            characters: [{ name: '艾莉丝', chat: '艾莉丝 - 跨层测试' }],
            this_chid: 0,
            currentUser: { name: ACCOUNT },
            extension_settings: { autoSaveTxt: settings },
            getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
            saveSettingsDebounced: () => {}
        };
        const api = loadIndexModule({ deps: { getContext: () => ctxObj } });
        return { api, settings };
    }

    let frontendBase;
    let router;
    let pluginInited = false;
    let evilPath = path.resolve(REPO_ROOT, '..', 'evil');
    const evilExistedBefore = fs.existsSync(evilPath);

    try {
        const IMG_DIR = path.join(DATA_ROOT, ACCOUNT, 'user', 'images', CHAT_DIR);
        fs.mkdirSync(IMG_DIR, { recursive: true });
        fs.writeFileSync(path.join(IMG_DIR, 'a.png'), PNG_1PX);
        fs.writeFileSync(path.join(IMG_DIR, 'b.png'), PNG_1PX);
        // G 组体积预估 fixture：JPEG 可嵌、超大 PNG（> 单图上限）、坏格式字节（不创建 missing.jpg）
        fs.writeFileSync(path.join(IMG_DIR, 'b.jpg'), JPEG_1PX);
        fs.writeFileSync(path.join(IMG_DIR, 'big.png'), OVERSIZE_PNG);
        fs.writeFileSync(path.join(IMG_DIR, 'junk.png'), JUNK_BYTES);

        let api;
        try {
            api = loadIndexModule();
            frontendBase = { DEFAULT_SETTINGS: api.DEFAULT_SETTINGS };
        } catch (e) {
            assert(false, '0.1 前端 index.js 可被 load-index 加载：' + (e && e.message));
            throw new Error('前端加载失败，后续断言无法执行');
        }
        assert(typeof api.buildEbookPayload === 'function', '0.1 真实 index.js 已导出 buildEbookPayload（跨层测试入口）');
        assert(typeof api.buildStructuredNovel === 'function' && typeof api.buildNovelText === 'function',
            '0.2 真实 index.js 已导出 buildStructuredNovel / buildNovelText（口径对比对象）');

        router = new MockRouter();
        try {
            await plugin.init(router);
            pluginInited = true;
            assert(true, '0.3 真实服务端插件 init(router) 成功（注册 /ebook 与 /status）');
        } catch (e) {
            assert(false, '0.3 真实服务端插件 init(router) 成功：' + (e && e.message));
            throw new Error('服务端插件初始化失败，后续断言无法执行');
        }

        // ==================== A. 前端 gating 矩阵 ====================
        console.log('\n--- A. 前端 gating 矩阵（buildEbookPayload / buildStructuredNovel） ---');
        const { api: fe } = makeFrontend({ ebook_embed_images: false });
        const settingsOff = fe.getSettings();
        settingsOff.ebook_st_root = ST_ROOT;
        settingsOff.save_dir = OUT_SERVER_ON;
        settingsOff.include_user_dialogue = false;
        settingsOff.chapter_style = 'numbered_floor';
        settingsOff.naming_rule = 'char_chat';
        settingsOff.indent_paragraphs = true;

        const settingsOn = Object.assign({}, settingsOff, { ebook_embed_images: true });

        const offBuild = fe.buildEbookPayload(settingsOff, CHAT);
        const onBuild = fe.buildEbookPayload(settingsOn, CHAT);
        const offPayload = offBuild.payload;
        const onPayload = onBuild.payload;

        // A1：false 时 payload.chapters 所有 blocks 无 image
        const offImageBlocks = offPayload.chapters.flatMap((c) => (c.blocks || []).filter((b) => b.type === 'image'));
        assert(offBuild.structured.embedImages === false, 'A1.1 关闭时 structured.embedImages === false');
        assert(offImageBlocks.length === 0, `A1.2 关闭时 payload.chapters 无任何 image 块（实际 ${offImageBlocks.length} 个）`);
        assert(offBuild.structured.imagesFound === 0 && offBuild.structured.imagesDeembedded === 0,
            'A1.3 关闭时 imagesFound=0 且 imagesDeembedded=0');

        // A2：文本块 / 章节标题与 buildNovelText 口径一致
        const novel = fe.buildNovelText(settingsOff, CHAT).novelText;
        const expectedTitles = [];
        for (let i = 0; i < CHAT.length; i++) {
            expectedTitles.push(`第 ${i + 1} 章 · 艾莉丝 (原楼层: ${i + 1})`);
        }
        assert(JSON.stringify(offPayload.chapters.map((c) => c.title)) === JSON.stringify(expectedTitles),
            'A2.1 关闭时章节标题与 TXT 口径逐条一致');

        const plainPerChapter = [];
        CHAT.forEach((msg, idx) => {
            const plain = fe.getCleanedMessage(msg, idx, settingsOff);
            plainPerChapter.push(String(plain).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean));
        });
        const offBlockTexts = offPayload.chapters.map((c) => (c.blocks || []).map((b) => b.text));
        assert(JSON.stringify(offBlockTexts) === JSON.stringify(plainPerChapter),
            'A2.2 关闭时文本块 = getCleanedMessage 纯文本切段（与 buildNovelText 同源）');
        const offTextsFlat = offBlockTexts.flat();
        assert(offTextsFlat.every((t) => novel.includes(t)), 'A2.3 关闭时每个文本块都出现在 buildNovelText 正文里');
        assert(expectedTitles.every((t) => novel.includes(t)), 'A2.4 每个章节标题都出现在 buildNovelText 里');
        assert(!novel.includes('bbi_image') && !offTextsFlat.some((t) => /first prompt|second prompt/.test(t)),
            'A2.5 关闭时正文与 TXT 都不含 bbi_image 标记/图片 prompt');

        // A3：true 时原位 image 块
        const onCh2Blocks = onPayload.chapters[1].blocks;
        const onCh2Types = onCh2Blocks.map((b) => b.type);
        const onImageBlocks = onPayload.chapters.flatMap((c) => (c.blocks || []).filter((b) => b.type === 'image'));
        assert(onBuild.structured.embedImages === true, 'A3.1 开启时 structured.embedImages === true');
        assert(JSON.stringify(onCh2Types) === JSON.stringify(['text', 'image', 'text', 'image', 'text']),
            'A3.2 开启时第 2 章块序列为 text/image/text/image/text（正文原位）');
        assert(onImageBlocks.length === 2 && onBuild.structured.imagesFound === 2,
            'A3.3 开启时共 2 个 image 块、imagesFound=2');
        assert(JSON.stringify(onImageBlocks.map((b) => b.path)) === JSON.stringify([IMG_A, IMG_B]),
            'A3.4 图片 path 按 slotSeq 顺序与原位对应');
        assert(onImageBlocks.every((b) => typeof b.alt === 'string' && b.alt.includes('prompt')),
            'A3.5 图片 alt 取 prompt 摘要（阅读器可见）');

        // A4：delivery 由调用方式决定
        assert(offPayload.delivery === 'server', 'A4.1 buildEbookPayload 缺省 delivery === server');
        assert(fe.buildEbookPayload(settingsOn, CHAT, 'download').payload.delivery === 'download',
            'A4.2 第三参 download 时 payload.delivery === download');
        assert(fe.buildEbookPayload(settingsOn, CHAT, 'whatever').payload.delivery === 'server',
            'A4.3 第三参为其它值时归一化为 server（不会误触发下载交付）');
        // A4.4：两个模式的 gating 结果不受 delivery 影响
        assert(fe.buildEbookPayload(settingsOff, CHAT, 'download').payload.chapters
            .every((c) => !(c.blocks || []).some((b) => b.type === 'image')),
            'A4.4 关闭嵌入 + download 交付时 chapters 仍无 image 块');

        // A5：payload 契约字段
        assert(onPayload.bookTitle === onBuild.structured.bookTitle && typeof onPayload.bookTitle === 'string' && onPayload.bookTitle.length > 0,
            'A5.1 payload.bookTitle 与 structured.bookTitle 同源且非空');
        assert(onPayload.author === fe.getBookTitle(settingsOn), 'A5.2 payload.author = getBookTitle(settings)');
        assert(onPayload.account === ACCOUNT, 'A5.3 payload.account = 当前登录账号名（图片解析按账号优先）');
        assert(onPayload.save_dir === settingsOn.save_dir, 'A5.4 payload.save_dir = settings.save_dir');
        assert(typeof onPayload.file_name === 'string' && /\.txt$/i.test(onPayload.file_name) && onPayload.file_name.includes('艾莉丝'),
            'A5.5 payload.file_name 与 TXT 落盘文件名同源（含角色名 + .txt）');
        assert(onPayload.chat_anchor === '跨层测试', 'A5.6 payload.chat_anchor = chatId 去 .jsonl');
        assert(Array.isArray(onPayload.chapters) && onPayload.chapters.length === 2, 'A5.7 payload.chapters 含 2 章');
        assert(onPayload.options && onPayload.options.maxImageBytes === 5 * 1024 * 1024
            && onPayload.options.maxTotalBytes === 80 * 1024 * 1024 && onPayload.options.stRoot === ST_ROOT,
            'A5.8 payload.options 带上图片大小上限与酒馆根目录');
        const serializable = (() => { try { wireClone(onPayload); return true; } catch (e) { return false; } })();
        assert(serializable, 'A5.9 payload 可 JSON 序列化（线上传输形态）');

        // ==================== B. 跨层服务端模式：gating 落到 EPUB 文件 ====================
        console.log('\n--- B. 跨层服务端模式（真实 /ebook 落盘 + 解 ZIP 断言） ---');
        // B1：关闭嵌入 → EPUB 无图片条目、无 <img>
        const offWire = wireClone(offPayload);
        offWire.save_dir = OUT_SERVER_OFF;
        const offResp = await router.dispatch('POST', '/ebook', offWire);
        assert(offResp.status === 200 && offResp.data && offResp.data.success === true,
            'B1.1 关闭嵌入 payload → /ebook 200 success:true');
        assert(offResp.data && offResp.data.images && offResp.data.images.embedded === 0
            && offResp.data.images.skipped === 0,
            'B1.2 关闭嵌入时服务端 embedded=0 / skipped=0');
        assert(offResp.data && typeof offResp.data.file === 'string' && fs.existsSync(path.resolve(offResp.data.file)),
            'B1.3 服务端模式仍落盘，file 指向真实文件');
        const offEpub = readZip(fs.readFileSync(path.resolve(offResp.data.file)));
        assert(!offEpub.entries.some((e) => e.name.startsWith('OEBPS/images/')),
            'B1.4 关闭嵌入时 EPUB 内没有 OEBPS/images/ 条目');
        const offChapterXhtml = offEpub.entries
            .filter((e) => /^OEBPS\/chapter-\d+\.xhtml$/.test(e.name))
            .map((e) => e.data.toString('utf8'));
        assert(offChapterXhtml.length === 2, 'B1.5 EPUB 内生成 2 个章节 XHTML');
        assert(offChapterXhtml.every((x) => extractImgSrcs(x).length === 0),
            'B1.6 关闭嵌入时章节 XHTML 无任何 <img> 引用');
        assert(offChapterXhtml.every((x) => !/first prompt|second prompt/.test(x)),
            'B1.7 关闭嵌入时图片 prompt 不泄漏进 EPUB');

        // B2：开启嵌入 → EPUB 恰有 2 张图且原位引用
        const onWire = wireClone(onPayload);
        onWire.save_dir = OUT_SERVER_ON;
        const onResp = await router.dispatch('POST', '/ebook', onWire);
        assert(onResp.status === 200 && onResp.data && onResp.data.success === true,
            'B2.1 开启嵌入 payload → /ebook 200 success:true');
        assert(onResp.data.images.embedded === 2 && onResp.data.images.skipped === 0,
            'B2.2 开启嵌入时服务端 embedded=2 / skipped=0');
        const onEpubPath = path.resolve(onResp.data.file);
        const serverEpubBuf = fs.readFileSync(onEpubPath);
        assert(serverEpubBuf.length === onResp.data.epubBytes, 'B2.3 落盘字节数 === 响应 epubBytes');
        const onEpub = readZip(serverEpubBuf);
        const imgEntries = onEpub.entries.filter((e) => e.name.startsWith('OEBPS/images/'));
        assert(imgEntries.length === 2, 'B2.4 EPUB 内恰有 2 个图片条目');
        assert(JSON.stringify(imgEntries.map((e) => e.name)) === JSON.stringify(['OEBPS/images/img-0001.png', 'OEBPS/images/img-0002.png']),
            'B2.5 图片按顺序编号 img-0001/img-0002，扩展名来自魔数');
        assert(imgEntries.every((e) => e.data.equals(PNG_1PX)), 'B2.6 图片字节原样嵌入（与磁盘素材逐字节一致）');
        const onCh2Xhtml = onEpub.byName['OEBPS/chapter-0002.xhtml'].data.toString('utf8');
        assert(JSON.stringify(extractImgSrcs(onCh2Xhtml)) === JSON.stringify(['images/img-0001.png', 'images/img-0002.png']),
            'B2.7 第 2 章 XHTML 原位引用两张图，src 指向 ZIP 内条目');
        assert(onCh2Xhtml.includes('风起') && onCh2Xhtml.includes('雨落') && /<h1>第 2 章/.test(onCh2Xhtml),
            'B2.8 章节正文与标题完整（图片不吞掉相邻正文）');
        const onCh1Xhtml = onEpub.byName['OEBPS/chapter-0001.xhtml'].data.toString('utf8');
        assert(extractImgSrcs(onCh1Xhtml).length === 0, 'B2.9 无图章节不产生 <img> 引用');

        // ==================== C. download 交付 ====================
        console.log('\n--- C. download 交付（二进制下载 / 响应头契约 / 零落盘） ---');
        const tmpSnapshotBeforeDownload = JSON.stringify(fs.readdirSync(TMP).sort());
        const dlWire = wireClone(onPayload);
        dlWire.delivery = 'download';
        dlWire.save_dir = DL_OUT;
        const dlResp = await router.dispatch('POST', '/ebook', dlWire);

        assert(dlResp.status === 200 && Buffer.isBuffer(dlResp.buffer),
            'C1.1 download 返回 200 + Buffer 二进制体');
        assert(dlResp.headers['content-type'] === 'application/epub+zip',
            'C1.2 Content-Type = application/epub+zip');
        const dlZip = readZip(dlResp.buffer);
        assert(!!dlZip.byName['mimetype'] && dlZip.byName['mimetype'].data.toString() === 'application/epub+zip',
            'C1.3 下载体是合法 EPUB（mimetype 首条目内容正确）');
        assert(dlZip.entries[0].method === 0, 'C1.4 mimetype 条目 STORED（EPUB 规范）');

        // C2：Content-Disposition filename* 中文可解码
        const disposition = dlResp.headers['content-disposition'] || '';
        assert(/^attachment;/.test(disposition) && /filename="novel\.epub"/.test(disposition),
            'C2.1 Content-Disposition 含 attachment 与 ASCII 兜底 filename="novel.epub"');
        const fnStarMatch = disposition.match(/filename\*=UTF-8''([^;]+)$/);
        assert(!!fnStarMatch, 'C2.2 Content-Disposition 含 RFC 5987 filename*=UTF-8\'\'…');
        let decodedName = '';
        try { decodedName = fnStarMatch ? decodeURIComponent(fnStarMatch[1]) : ''; } catch (e) { decodedName = ''; }
        const expectedFileName = `${fe.sanitizeFilename(onPayload.bookTitle)}.epub`;
        assert(decodedName === expectedFileName,
            `C2.3 filename* 解码后 = 安全书名.epub（实际 "${decodedName}"，期望 "${expectedFileName}"）`);
        assert(decodedName.endsWith('.epub') && !decodedName.includes('/') && !decodedName.includes('\\'),
            'C2.4 下载文件名无路径分隔符');

        // C3：Content-Length 与统计头
        assert(dlResp.headers['content-length'] === String(dlResp.buffer.length),
            'C3.1 Content-Length === 二进制体长度');
        const rawStats = dlResp.headers['x-novel-epub-stats'] || '';
        assert(/^[\x20-\x7E]+$/.test(rawStats), 'C3.2 X-Novel-Epub-Stats 为纯 ASCII（无裸中文头）');
        let stats = null;
        try { stats = JSON.parse(decodeURIComponent(rawStats)); } catch (e) { stats = null; }
        assert(!!stats && stats.success === true, 'C3.3 X-Novel-Epub-Stats 解码后 success:true');
        assert(!!stats && stats.epubBytes === dlResp.buffer.length, 'C3.4 stats.epubBytes === 实际字节数');
        assert(!!stats && stats.images && stats.images.embedded === 2 && stats.images.skipped === 0,
            'C3.5 stats.images 与嵌入结果一致（embedded=2 / skipped=0）');

        // C4：download 与 server 同源（同一 payload 打包结果一致）
        const diff = diffEpub([serverEpubBuf, dlResp.buffer]);
        const byteEqual = Buffer.compare(serverEpubBuf, dlResp.buffer) === 0;
        assert(diff.namesEqual, 'C4.1 download 与 server 模式的 EPUB 条目集合完全一致');
        assert(diff.differing.length === 0,
            'C4.2 非 content.opf 条目逐字节一致，content.opf 去时间戳后一致（差异项：' + JSON.stringify(diff.differing) + '）');
        assert(!!onResp.data && onResp.data.epubBytes === dlResp.buffer.length,
            'C4.3 两种交付的 EPUB 字节数相同');
        console.log(`        （附注：本次两次打包是否逐字节相同 = ${byteEqual}；content.opf 含秒级 dcterms:modified，跨秒时允许仅该字段不同）`);

        // C5：download 绝不落盘
        assert(!fs.existsSync(DL_OUT), 'C5.1 download 的 save_dir 指向全新路径 → 目录未被创建');
        const tmpSnapshotAfterDownload = JSON.stringify(fs.readdirSync(TMP).sort());
        assert(tmpSnapshotBeforeDownload === tmpSnapshotAfterDownload,
            'C5.2 download 前后临时根目录无任何新增文件/目录（彻底零落盘）');

        // C6：非法 save_dir 仍 200 且不产生越界文件
        const badDirWire = wireClone(onPayload);
        badDirWire.delivery = 'download';
        badDirWire.save_dir = '\0invalid-dir';
        const badDirResp = await router.dispatch('POST', '/ebook', badDirWire);
        assert(badDirResp.status === 200 && Buffer.isBuffer(badDirResp.buffer)
            && !!readZip(badDirResp.buffer).byName['mimetype'],
            'C6.1 download 的 save_dir 为非法值（含 NUL）仍 200 返回 EPUB');
        const travDirWire = wireClone(onPayload);
        travDirWire.delivery = 'download';
        travDirWire.save_dir = '../evil';
        const travDirResp = await router.dispatch('POST', '/ebook', travDirWire);
        assert(travDirResp.status === 200 && Buffer.isBuffer(travDirResp.buffer),
            'C6.2 download 的 save_dir 为 "../evil" 仍 200（下载模式完全忽略路径）');
        assert(!fs.existsSync(evilPath), 'C6.3 download 未在仓库外产生 ../evil 越界目录');

        // C7：书名穿越 → filename* 解码后干净
        const travTitleWire = wireClone(onPayload);
        travTitleWire.delivery = 'download';
        travTitleWire.bookTitle = '../../evil';
        const travTitleResp = await router.dispatch('POST', '/ebook', travTitleWire);
        const travDisposition = travTitleResp.headers['content-disposition'] || '';
        const travMatch = travDisposition.match(/filename\*=UTF-8''([^;]+)$/);
        let travDecoded = '';
        try { travDecoded = travMatch ? decodeURIComponent(travMatch[1]) : ''; } catch (e) { travDecoded = ''; }
        assert(travTitleResp.status === 200 && travDecoded.length > 0,
            'C7.1 穿越书名 download 仍 200 且 filename* 可解码');
        assert(!travDecoded.includes('/') && !travDecoded.includes('\\') && !travDecoded.includes('..')
            && travDecoded.endsWith('.epub'),
            `C7.2 穿越书名的 filename* 解码后无路径分隔符/..（实际 "${travDecoded}"）`);

        // C8：零图纯文字 download
        const textDlWire = wireClone(offPayload);
        textDlWire.delivery = 'download';
        textDlWire.save_dir = DL_OUT;
        const textDlResp = await router.dispatch('POST', '/ebook', textDlWire);
        assert(textDlResp.status === 200 && Buffer.isBuffer(textDlResp.buffer), 'C8.1 零图纯文字 download 返回 EPUB');
        let textStats = null;
        try { textStats = JSON.parse(decodeURIComponent(textDlResp.headers['x-novel-epub-stats'] || '')); } catch (e) { textStats = null; }
        assert(!!textStats && textStats.images.embedded === 0 && textStats.images.skipped === 0,
            'C8.2 零图下载 stats：embedded=0 / skipped=0');
        assert(!readZip(textDlResp.buffer).entries.some((e) => e.name.startsWith('OEBPS/images/')),
            'C8.3 零图下载 EPUB 内没有图片条目');

        // C9：413 / 400 仍是 JSON（无二进制头、无落盘）
        const limitWire = wireClone(onPayload);
        limitWire.delivery = 'download';
        limitWire.save_dir = DL_OUT;
        limitWire.options.maxTotalBytes = 100; // 两张 1x1 PNG 累计约 136 字节必然超限（触发 413）
        const limitResp = await router.dispatch('POST', '/ebook', limitWire);
        assert(limitResp.status === 413 && limitResp.buffer === null && limitResp.data
            && typeof limitResp.data.error === 'string' && limitResp.data.error.includes('图片总量超出'),
            'C9.1 图片总量超限 download 返回 JSON 413（文案「图片总量超出 …MB 限制」）');
        assert(!limitResp.headers['content-type'] && !limitResp.headers['content-disposition']
            && !limitResp.headers['x-novel-epub-stats'],
            'C9.2 413 不带任何 EPUB 二进制响应头');
        assert(!fs.existsSync(DL_OUT), 'C9.3 413 时依然零落盘');
        const bad400 = await router.dispatch('POST', '/ebook', { bookTitle: 'x', chapters: 'not-array', delivery: 'download' });
        assert(bad400.status === 400 && bad400.buffer === null && bad400.data && bad400.data.error === '无效请求',
            'C9.4 chapters 非法 download 返回 JSON 400 无效请求');
        const noTitle400 = await router.dispatch('POST', '/ebook', { bookTitle: '  ', chapters: [], delivery: 'download' });
        assert(noTitle400.status === 400 && noTitle400.buffer === null, 'C9.5 bookTitle/chapters 非法同样 JSON 400');

        // ==================== D. 静态/接线检查（独立于 T1 的 test-ui-wiring） ====================
        console.log('\n--- D. 静态/接线检查 ---');
        const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');
        const styleSrc = fs.readFileSync(STYLE_PATH, 'utf8');
        const indexLines = indexSrc.split(/\r?\n/);

        assert(indexSrc.includes('id="novel_ebook_download_btn"'), 'D1.1 index.js 含「下载到本机」按钮 id');
        const downloadBindingRe = new RegExp(
            'const ebookDownloadBtn = panel\\.querySelector\\(\'#novel_ebook_download_btn\'\\);'
            + '[\\s\\S]{0,400}?exportEbook\\(ebookDownloadBtn, \'download\'\\)'
        );
        assert(downloadBindingRe.test(indexSrc),
            'D1.2 下载按钮 click 接线 = exportEbook(ebookDownloadBtn, \'download\')');
        const gateMatches = indexSrc.match(/serverCapabilities\.ebookDownload !== true/g) || [];
        assert(gateMatches.length >= 2, 'D1.3 ebookDownload 能力门控同时存在于 exportEbook 与按钮禁用逻辑');
        assert(indexSrc.includes('id="novel_ebook_export_btn"'), 'D1.4 「导出到服务器」按钮仍在（server 模式不退化）');

        const summaryRange = findFunctionRange(indexLines, 'refreshNovelAccSummaries');
        assert(!!summaryRange, 'D2.1 能定位 refreshNovelAccSummaries 函数范围');
        if (summaryRange) {
            const summarySrc = indexLines.slice(summaryRange.start - 1, summaryRange.end).join('\n');
            assert(!summarySrc.includes('ebookEmbedEl'),
                'D2.2 refreshNovelAccSummaries 不再引用越界变量 ebookEmbedEl（原 ReferenceError 根因）');
            assert(summarySrc.includes("panel.querySelector('#novel_ebook_embed_images')"),
                'D2.3 refreshNovelAccSummaries 改为 panel 内查询 EPUB 开关现态');
        }

        const checkboxIdx = indexSrc.indexOf('id="novel_ebook_embed_images"');
        assert(checkboxIdx > 0, 'D3.1 找到 EPUB 嵌入开关复选框');
        const checkboxBefore = indexSrc.slice(Math.max(0, checkboxIdx - 400), checkboxIdx);
        assert(checkboxBefore.includes('class="checkbox_label"'),
            'D3.2 开关所在 label 使用 checkbox_label（命中胶囊开关样式）');
        assert(!indexSrc.includes('novel-switch-row'), 'D3.3 不再使用无样式类 novel-switch-row');
        assert(indexSrc.includes('id="novel_ebook_embed_hint"'), 'D3.4 存在开关即时说明 #novel_ebook_embed_hint');

        const rowRuleRe = /#auto-save-to-txt-settings \.novel-acc-body > \.novel-row\s*\{/;
        assert(rowRuleRe.test(styleSrc), 'D4.1 style.css 已为 .novel-acc-body > .novel-row 落地样式规则');
        const rowRuleCount = (styleSrc.match(/\.novel-acc-body > \.novel-row/g) || []).length;
        assert(rowRuleCount >= 3, `D4.2 .novel-row 规则覆盖数字/文本输入行（命中 ${rowRuleCount} 条）`);
        // v1.19.1 防御：旧版/缓存 index.js 仍用 .novel-switch-row —— style.css 必须按固定 ID 兜底胶囊开关样式，
        // 否则「旧 JS + 新 CSS」会出现“点了看不出勾选”的假故障（真实浏览器已复现，见 review/_scratch/verify-v118/）。
        assert(/id="novel_ebook_embed_images"/.test(indexSrc), 'D4.3 index.js 中开关固定 ID 存在（新旧前端一致，兜底样式的锚点）');
        assert(/#auto-save-to-txt-settings #novel_ebook_embed_images\s*\{/.test(styleSrc)
            && /\.novel-switch-row\s*\{/.test(styleSrc),
            'D4.4 style.css 保留按 ID 的兜底胶囊开关 + 旧类 .novel-switch-row 布局规则（缓存旧 index.js 时仍可勾选且可见）');

        assert(api.DEFAULT_SETTINGS.version === '1.20.0', `D5.1 DEFAULT_SETTINGS.version === 1.20.0（实际 ${api.DEFAULT_SETTINGS.version}）`);
        let manifest = null;
        try { manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch (e) { manifest = null; }
        assert(!!manifest && manifest.version === '1.20.0', 'D5.2 manifest.json version === 1.20.0');
        const payloadSrcRange = findFunctionRange(indexLines, 'buildEbookPayload');
        assert(!!payloadSrcRange && indexLines.slice(payloadSrcRange.start - 1, payloadSrcRange.end)
            .join('\n').includes("delivery === 'download' ? 'download' : 'server'"),
            'D5.3 buildEbookPayload 内 delivery 字段由调用方式决定（纯函数契约）');

        // ==================== E. 回归 ====================
        console.log('\n--- E. 回归（/status 能力 + 服务端模式不退化） ---');
        const statusResp = await router.dispatch('GET', '/status', undefined);
        assert(statusResp.status === 200 && statusResp.data && statusResp.data.ready === true,
            'E1.1 GET /status 200 ready:true');
        assert(statusResp.data.version === '1.16.0', `E1.2 /status version === 1.16.0（实际 ${statusResp.data && statusResp.data.version}）`);
        const caps = (statusResp.data && statusResp.data.capabilities) || {};
        assert(caps.ebookDownload === true && caps.ebook === true && caps.ebookEstimate === true,
            'E1.3 /status capabilities 同时声明 ebook / ebookDownload / ebookEstimate');
        assert(caps.append === true && caps.syncAll === true && caps.tailGuard === true,
            'E1.4 既有能力（append/syncAll/tailGuard）未被破坏');

        const legacyWire = {
            bookTitle: '缺省交付回归书',
            author: '测试作者',
            save_dir: REG_OUT,
            options: { stRoot: ST_ROOT },
            chapters: [{ title: '第 1 章 · 回归', blocks: [{ type: 'p', text: '缺省 delivery 仍应落盘。' }] }]
        };
        const legacyResp = await router.dispatch('POST', '/ebook', legacyWire);
        assert(legacyResp.status === 200 && legacyResp.data && legacyResp.data.success === true
            && legacyResp.buffer === null,
            'E2.1 缺省 delivery 仍走服务端模式：200 + JSON success（无二进制体）');
        assert(typeof legacyResp.data.file === 'string' && fs.existsSync(path.resolve(legacyResp.data.file))
            && fs.statSync(path.resolve(legacyResp.data.file)).size === legacyResp.data.epubBytes,
            'E2.2 缺省 delivery 仍真实落盘，文件大小 = epubBytes');

        // ==================== G. 跨层体积预估（前端 v1.19.0 / 插件 1.16.0） ====================
        console.log('\n--- G. 体积预估跨层（真实前端 buildEbookPayload → 真实插件 /ebook/estimate） ---');
        const G_IMG_JPG = '/user/images/跨层测试/b.jpg';
        const G_IMG_MISSING = '/user/images/跨层测试/never-created.jpg';
        const G_IMG_BIG = '/user/images/跨层测试/big.png';
        const G_IMG_JUNK = '/user/images/跨层测试/junk.png';
        const gStatSize = (name) => fs.statSync(path.join(IMG_DIR, name)).size;
        const SZ_A = gStatSize('a.png');
        const SZ_JPG = gStatSize('b.jpg');
        const SZ_BIG = gStatSize('big.png');
        const SZ_JUNK = gStatSize('junk.png');

        // 5 个图片引用：2 可嵌（PNG/JPEG）+ 1 缺失 + 1 超单图上限 + 1 坏格式
        const G_CHAT = [
            { mes: '　　她推开门。\n\n　　夜色如墨。', is_user: false, name: '艾莉丝', extra: {} },
            {
                mes: '　　一。\n<bbi_image>g0\n　　二。\n<bbi_image>g1\n　　三。\n<bbi_image>g2\n　　四。\n<bbi_image>g3\n　　五。\n<bbi_image>g4',
                is_user: false, name: '艾莉丝',
                extra: {
                    bbiImage: bbi([
                        { path: IMG_A, prompt: 'g0', slotSeq: 0 },
                        { path: G_IMG_JPG, prompt: 'g1', slotSeq: 1 },
                        { path: G_IMG_MISSING, prompt: 'g2', slotSeq: 2 },
                        { path: G_IMG_BIG, prompt: 'g3', slotSeq: 3 },
                        { path: G_IMG_JUNK, prompt: 'g4', slotSeq: 4 }
                    ])
                }
            }
        ];
        // 同一 path 出现两次（两个槽位都指向 a.png）
        const G_DUP_CHAT = [{
            mes: '　　甲。\n<bbi_image>dup0\n　　乙。\n<bbi_image>dup1',
            is_user: false, name: '艾莉丝',
            extra: {
                bbiImage: bbi([
                    { path: IMG_A, prompt: 'dup0', slotSeq: 0 },
                    { path: IMG_A, prompt: 'dup1', slotSeq: 1 }
                ])
            }
        }];

        const { api: gApi } = makeFrontend({ ebook_embed_images: true, ebook_max_image_mb: 1 }, G_CHAT);
        const gSettings = gApi.getSettings();
        gSettings.ebook_embed_images = true;
        gSettings.ebook_max_image_mb = 1;
        gSettings.ebook_max_total_mb = 80;
        gSettings.ebook_st_root = ST_ROOT;
        gSettings.save_dir = OUT_SERVER_ON;
        gSettings.include_user_dialogue = false;
        const gBuilt = gApi.buildEbookPayload(gSettings, G_CHAT);
        const gPayload = gBuilt.payload;

        // ---- G0 前置构造 ----
        const gImageBlocks = gPayload.chapters.flatMap((c) => (c.blocks || []).filter((b) => b.type === 'image'));
        assert(gImageBlocks.length === 5 && gBuilt.structured.imagesFound === 5,
            'G0.1 真实前端产出 5 个 image 块（2 可嵌 / 1 缺失 / 1 超限 / 1 坏格式）');
        assert(gPayload.options.maxImageBytes === 1 * 1024 * 1024
            && gPayload.options.maxTotalBytes === 80 * 1024 * 1024 && gPayload.options.stRoot === ST_ROOT,
            'G0.2 payload.options 上限与酒馆根目录正确（单图 1MB / 总量 80MB）');
        const gZeroWire = wireClone(offPayload);
        assert(gZeroWire.chapters.every((c) => !(c.blocks || []).some((b) => b.type === 'image')),
            'G0.3 零图输入（嵌入关闭 payload）无 image 块');

        // ---- G1 混合场景：各计数与体积精确值 ----
        const gEst = await router.dispatch('POST', '/ebook/estimate', wireClone(gPayload));
        const gEstImages = (gEst.data && gEst.data.images) || {};
        assert(gEst.status === 200 && gEst.data && gEst.data.success === true,
            'G1.1 POST /ebook/estimate → 200 success:true');
        assert(gEstImages.totalReferences === 5, `G1.2 totalReferences=5（实际 ${gEstImages.totalReferences}）`);
        assert(gEstImages.resolvable === 4, `G1.3 resolvable=4（实际 ${gEstImages.resolvable}）`);
        assert(gEstImages.embeddable === 2, `G1.4 embeddable=2（实际 ${gEstImages.embeddable}）`);
        assert(gEstImages.missing === 1, `G1.5 missing=1（实际 ${gEstImages.missing}）`);
        assert(gEstImages.oversize === 1, `G1.6 oversize=1（实际 ${gEstImages.oversize}）`);
        assert(gEstImages.unsupported === 1, `G1.7 unsupported=1（实际 ${gEstImages.unsupported}）`);
        assert(gEstImages.estimatedBytes === SZ_A + SZ_JPG,
            `G1.8 estimatedBytes 精确等于 fixture 字节和（实际 ${gEstImages.estimatedBytes}，期望 ${SZ_A + SZ_JPG}）`);
        assert(gEst.data.limits && gEst.data.limits.maxImageBytes === 1 * 1024 * 1024
            && gEst.data.limits.maxTotalBytes === 80 * 1024 * 1024,
            'G1.9 limits 回显规范化后的生效上限');
        assert(gEst.data.overTotalLimit === false, 'G1.10 默认上限下 overTotalLimit=false');
        const gEstFields = ['totalReferences', 'resolvable', 'embeddable', 'missing', 'oversize', 'unsupported', 'estimatedBytes'];
        assert(gEstFields.every((f) => typeof gEstImages[f] === 'number') && typeof gEst.data.overTotalLimit === 'boolean',
            'G1.11 images 七个字段齐全且为 number、overTotalLimit 为 boolean');

        // ---- G2 超总量上限 ----
        const gOverWire = wireClone(gPayload);
        gOverWire.options.maxTotalBytes = 100; // 小于 estimatedBytes(a+b)
        const gOver = await router.dispatch('POST', '/ebook/estimate', gOverWire);
        assert(gOver.status === 200 && gOver.data.overTotalLimit === true,
            'G2.1 maxTotalBytes 调小于 estimatedBytes → overTotalLimit=true');
        assert(gOver.data.images.estimatedBytes === SZ_A + SZ_JPG
            && gOver.data.images.embeddable === 2 && gOver.data.images.oversize === 1,
            'G2.2 阈值只影响判定，不影响计数与 estimatedBytes');

        // ---- G3 调小单图上限：原可嵌图归位 oversize、体积下降 ----
        const gSmallWire = wireClone(gPayload);
        gSmallWire.options.maxImageBytes = 50;
        const gSmall = await router.dispatch('POST', '/ebook/estimate', gSmallWire);
        assert(gSmall.data.images.embeddable === 0 && gSmall.data.images.estimatedBytes === 0,
            'G3.1 maxImageBytes=50 → embeddable=0 / estimatedBytes=0');
        assert(gSmall.data.images.oversize === 3,
            `G3.2 a.png/b.jpg/big.png 均归入 oversize（oversize=3，实际 ${gSmall.data.images.oversize}）`);
        assert(gSmall.data.images.unsupported === 1 && gSmall.data.overTotalLimit === false,
            'G3.3 junk.png(<50B) 仍归 unsupported；estimatedBytes=0 未超上限');

        // ---- G4 同一 path 重复引用按两次计 ----
        const { api: gDupApi } = makeFrontend({ ebook_embed_images: true }, G_DUP_CHAT);
        const gDupSettings = gDupApi.getSettings();
        gDupSettings.ebook_embed_images = true;
        gDupSettings.ebook_st_root = ST_ROOT;
        const gDupPayload = gDupApi.buildEbookPayload(gDupSettings, G_DUP_CHAT).payload;
        const gDup = await router.dispatch('POST', '/ebook/estimate', wireClone(gDupPayload));
        assert(gDup.status === 200 && gDup.data.images.totalReferences === 2,
            'G4.1 同一 path 在 blocks 中出现两次 → totalReferences=2');
        assert(gDup.data.images.embeddable === 2 && gDup.data.images.estimatedBytes === SZ_A * 2,
            `G4.2 embeddable=2 且 estimatedBytes 按两次计（实际 ${gDup.data.images.estimatedBytes}，期望 ${SZ_A * 2}）`);
        assert(gDup.data.images.missing === 0 && gDup.data.images.oversize === 0
            && gDup.data.images.unsupported === 0 && gDup.data.overTotalLimit === false,
            'G4.3 其余计数为 0、未超上限');

        // ---- G5 零图 ----
        const gZero = await router.dispatch('POST', '/ebook/estimate', gZeroWire);
        assert(gZero.status === 200
            && gEstFields.every((f) => gZero.data.images[f] === 0),
            'G5.1 零图 payload → 所有计数与 estimatedBytes 全 0');
        assert(gZero.data.overTotalLimit === false, 'G5.2 零图 overTotalLimit=false');

        // ---- G6 无效请求仍 JSON 400 ----
        const gBad = await router.dispatch('POST', '/ebook/estimate', { bookTitle: 'x', chapters: 'not-array' });
        assert(gBad.status === 400 && gBad.data && gBad.data.error === '无效请求' && gBad.buffer === null,
            'G6.1 chapters 非数组 → 400 JSON 无效请求（无二进制体）');
        const gBad2 = await router.dispatch('POST', '/ebook/estimate', { bookTitle: '   ', chapters: [] });
        assert(gBad2.status === 400 && gBad2.data && typeof gBad2.data.error === 'string',
            'G6.2 bookTitle 空白 / chapters 空 → 400 JSON');

        // ---- G7 零落盘与无副作用 ----
        const EST_SAVE_DIR = path.join(TMP, 'estimate-save-dir-never-created');
        const gTmpBefore = JSON.stringify(fs.readdirSync(TMP).sort());
        const gStatSnapshot = () => ['a.png', 'b.jpg', 'big.png', 'junk.png']
            .map((n) => { const s = fs.statSync(path.join(IMG_DIR, n)); return `${n}:${s.size}:${s.mtimeMs}`; }).join('|');
        const gStatBefore = gStatSnapshot();
        const gDiskWire = wireClone(gPayload);
        gDiskWire.save_dir = EST_SAVE_DIR;
        const gDisk = await router.dispatch('POST', '/ebook/estimate', gDiskWire);
        assert(gDisk.status === 200, 'G7.1 estimate 带全新 save_dir 仍 200');
        assert(!fs.existsSync(EST_SAVE_DIR), 'G7.2 estimate 绝不创建 save_dir 目录（零落盘）');
        assert(gTmpBefore === JSON.stringify(fs.readdirSync(TMP).sort()),
            'G7.3 estimate 前后临时根目录无任何新增文件/目录');
        assert(gStatBefore === gStatSnapshot(), 'G7.4 fixture 文件 size/mtime 未变（只 stat + 读头，不读整图不改文件）');

        // ---- G8 回归：/ebook 交付不被 estimate 改动影响 ----
        const gDlWire = wireClone(onPayload);
        gDlWire.delivery = 'download';
        gDlWire.save_dir = DL_OUT;
        const gDl = await router.dispatch('POST', '/ebook', gDlWire);
        assert(gDl.status === 200 && Buffer.isBuffer(gDl.buffer)
            && gDl.headers['content-type'] === 'application/epub+zip',
            'G8.1 estimate 之后 /ebook download 仍返回 200 二进制 EPUB');
        const gDlDisp = gDl.headers['content-disposition'] || '';
        const gDlMatch = gDlDisp.match(/filename\*=UTF-8''([^;]+)$/);
        let gDlName = '';
        try { gDlName = gDlMatch ? decodeURIComponent(gDlMatch[1]) : ''; } catch (e) { gDlName = ''; }
        assert(/^attachment;/.test(gDlDisp) && gDlName.endsWith('.epub'),
            'G8.2 download 响应头契约未被 estimate 改动影响');
        let gDlStats = null;
        try { gDlStats = JSON.parse(decodeURIComponent(gDl.headers['x-novel-epub-stats'] || '')); } catch (e) { gDlStats = null; }
        assert(!!gDlStats && gDlStats.images && gDlStats.images.embedded === 2,
            'G8.3 X-Novel-Epub-Stats 仍报告 embedded=2');

        // ---- G9 前端源码静态断言（独立于 T5 的 test-ui-wiring） ----
        assert(typeof gApi.estimateEbookPayload === 'function',
            'G9.1 测试导出块含 estimateEbookPayload（前端预检入口）');
        assert(typeof gApi.formatBytesMb === 'function', 'G9.2 测试导出块含 formatBytesMb');
        assert(/EBOOK_LARGE_WARN_BYTES\s*=\s*100\s*\*\s*1024\s*\*\s*1024/.test(indexSrc),
            'G9.3 EBOOK_LARGE_WARN_BYTES = 100MB');
        assert(/EBOOK_MAX_TOTAL_LIMIT_MB\s*=\s*500/.test(indexSrc), 'G9.4 EBOOK_MAX_TOTAL_LIMIT_MB = 500');
        const exportFnRange = findFunctionRange(indexLines, 'exportEbook');
        const exportFnSrc = exportFnRange
            ? indexLines.slice(exportFnRange.start - 1, exportFnRange.end).join('\n') : '';
        assert(!!exportFnRange, 'G9.5 能定位 exportEbook 函数范围');
        const gEstCallIdx = exportFnSrc.indexOf('estimateEbookPayload(');
        const gFirstConfirmIdx = exportFnSrc.indexOf('confirm(');
        assert(gEstCallIdx >= 0 && gFirstConfirmIdx > gEstCallIdx,
            'G9.6 exportEbook 内体积预估调用早于首个 confirm（预检在确认框之前）');
        assert(exportFnSrc.includes('overTotalLimit')
            && exportFnSrc.includes('ebook_max_total_mb')
            && exportFnSrc.includes('payload.options.maxTotalBytes'),
            'G9.7 exportEbook 超限分支：引用 overTotalLimit、自动提限并同步抬高 payload.options.maxTotalBytes');
        assert(indexSrc.includes('serverCapabilities.ebookEstimate !== true')
            && indexSrc.includes('serverCapabilities.ebookEstimate === true'),
            'G9.8 能力门控存在（estimate 内部与 exportEbook 预检分支）');
        const previewFnRange = findFunctionRange(indexLines, 'openEbookPreviewModal');
        const previewFnSrc = previewFnRange
            ? indexLines.slice(previewFnRange.start - 1, previewFnRange.end).join('\n') : '';
        assert(previewFnSrc.includes('novel_ebook_modal_estimate') && previewFnSrc.includes('fillEbookEstimateHint('),
            'G9.9 预览弹窗含预估占位 #novel_ebook_modal_estimate 且触发异步填充');
        const fillFnRange = findFunctionRange(indexLines, 'fillEbookEstimateHint');
        const fillFnSrc = fillFnRange
            ? indexLines.slice(fillFnRange.start - 1, fillFnRange.end).join('\n') : '';
        assert(fillFnSrc.includes('estimateEbookPayload(') && fillFnSrc.includes('overTotalLimit')
            && fillFnSrc.includes('EBOOK_LARGE_WARN_BYTES'),
            'G9.10 预览预估：调用 estimate、展示 overTotalLimit 与 ≥100MB 提示');
        assert(api.DEFAULT_SETTINGS.version === '1.20.0' && !!manifest && manifest.version === '1.20.0',
            'G9.11 前端版本双向一致（DEFAULT_SETTINGS 与 manifest 均 1.20.0）');
        let pluginPkg = null;
        try { pluginPkg = JSON.parse(fs.readFileSync(PLUGIN_PACKAGE_PATH, 'utf8')); } catch (e) { pluginPkg = null; }
        assert(!!pluginPkg && pluginPkg.version === '1.16.0' && statusResp.data.version === '1.16.0',
            'G9.12 服务端版本双向一致（/status 与插件 package.json 均 1.16.0）');

        // ---- G10 前端行为：能力门控 / 正路径请求契约 / 静默降级 / 格式化 ----
        let g10FetchCalls = 0;
        const g10FetchLog = [];
        let g10Responder = () => Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
                success: true,
                images: { totalReferences: 2, resolvable: 2, embeddable: 2, missing: 0, oversize: 0, unsupported: 0, estimatedBytes: 2048 },
                limits: { maxImageBytes: 1048576, maxTotalBytes: 83886080 },
                overTotalLimit: false
            })
        });
        const g10Api = loadIndexModule({
            deps: {
                getContext: () => ({ chat: [], chatId: '跨层测试.jsonl' }),
                fetch: (url, opts) => { g10FetchCalls++; g10FetchLog.push({ url, opts }); return g10Responder(); }
            }
        });
        const g10Payload = {
            bookTitle: 'g10 探测书',
            chapters: [{ title: '第 1 章', blocks: [{ type: 'image', path: IMG_A }] }],
            options: { maxImageBytes: 1048576, maxTotalBytes: 83886080, stRoot: ST_ROOT }
        };
        const g10Null = await g10Api.estimateEbookPayload(g10Payload);
        assert(g10Null === null, 'G10.1 能力缺失时 estimateEbookPayload 返回 null（静默降级）');
        assert(g10FetchCalls === 0, 'G10.2 能力缺失时完全不发 fetch（不打扰旧服务端）');
        g10Api.__testState.setServerCapabilities({ ebookEstimate: true });
        const g10Data = await g10Api.estimateEbookPayload(g10Payload);
        assert(!!g10Data && g10Data.success === true && g10Data.images && g10Data.images.embeddable === 2,
            'G10.3 能力可用时返回服务端估算 JSON');
        assert(g10FetchCalls === 1 && g10FetchLog.length === 1
            && g10FetchLog[0].url === '/api/plugins/auto-save/ebook/estimate'
            && g10FetchLog[0].opts && g10FetchLog[0].opts.method === 'POST',
            'G10.4 fetch 恰好调用 1 次且 URL/method 正确');
        const g10Sent = JSON.parse(g10FetchLog[0].opts.body);
        assert(JSON.stringify(g10Sent) === JSON.stringify(g10Payload),
            'G10.5 请求体 JSON 序列化后与传入 payload 深等');
        assert(g10FetchLog[0].opts.headers && /application\/json/i.test(g10FetchLog[0].opts.headers['Content-Type'] || ''),
            'G10.6 请求头 Content-Type: application/json');
        g10Responder = () => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
        assert(await g10Api.estimateEbookPayload(g10Payload) === null,
            'G10.7 服务端 500 → 返回 null（不阻塞导出）');
        g10Responder = () => Promise.reject(new Error('network down'));
        assert(await g10Api.estimateEbookPayload(g10Payload) === null,
            'G10.8 fetch 抛异常 → 返回 null（catch 兜底）');
        g10Responder = () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
        assert(await g10Api.estimateEbookPayload(g10Payload) === null,
            'G10.9 响应非法 JSON → 返回 null');
        g10Api.__testState.setServerCapabilities({}); // 能力复位，避免影响后续断言
        assert(gApi.formatBytesMb(0) === '0.0 MB' && gApi.formatBytesMb(-5) === '0.0 MB'
            && gApi.formatBytesMb('abc') === '0.0 MB',
            'G10.10 formatBytesMb 非法值（0/负数/非数）按 0 处理');
        assert(gApi.formatBytesMb(130.4 * 1024 * 1024) === '130.4 MB',
            'G10.11 formatBytesMb 130.4MB → "130.4 MB"（对应 130MB+ 用户场景）');
        assert(gApi.formatBytesMb(80 * 1024 * 1024) === '80.0 MB',
            'G10.12 formatBytesMb 整数 80MB → "80.0 MB"');
        assert(exportFnSrc.includes('estimate = null') && /estimate && estimate\.images/.test(exportFnSrc),
            'G10.13 exportEbook 对 null 预估静默降级（预估失败按旧流程继续）');

        // ==================== F. 收尾核对 ====================
        console.log('\n--- F. 收尾核对 ---');
        const fingerprintsAfter = {
            index: fileSha256(INDEX_PATH),
            style: fileSha256(STYLE_PATH),
            plugin: fileSha256(PLUGIN_PATH),
            manifest: fileSha256(MANIFEST_PATH)
        };
        assert(JSON.stringify(fingerprintsAfter) === JSON.stringify(fingerprints),
            'F1 运行期间 index.js/style.css/插件/manifest 未被并发修改（本测试结论有效）');
        const logsDir = path.join(REPO_ROOT, 'plugins', 'auto-save', 'logs');
        const logsEntries = fs.existsSync(logsDir) ? fs.readdirSync(logsDir).filter((n) => n !== '.gitkeep') : null;
        assert(logsEntries !== null && logsEntries.length === 0,
            'F2 仓库 plugins/auto-save/logs 没有测试残留（只允许 .gitkeep）');
        const tmpEntries = fs.readdirSync(TMP).filter((n) => !['st', 'out-server-off', 'out-server-on', 'regression-out'].includes(n));
        assert(tmpEntries.length === 0, `F3 测试临时根目录无计划外产物（实际 ${JSON.stringify(tmpEntries)}）`);
    } catch (err) {
        console.error('测试异常:', err && err.stack ? err.stack : err);
        failCount++;
        failures.push('测试执行异常：' + (err && err.message));
    } finally {
        try { if (pluginInited) await plugin.exit(); } catch (e) { /* 退出钩子失败不影响结论 */ }
        // 防御式清理：若 download 缺陷导致 save_dir 被误写，清掉本测试可能创建的越界目录（仅当运行前不存在）
        try {
            if (!evilExistedBefore && fs.existsSync(evilPath)) {
                fs.rmSync(evilPath, { recursive: true, force: true });
            }
        } catch (e) { /* 清理失败在 F 组已暴露 */ }
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 同上 */ }
    }

    console.log(`\n=== 测试结果: 通过: ${passCount}, 失败: ${failCount} ===`);
    if (failures.length) {
        console.log('失败清单：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    }
    if (failCount > 0) process.exit(1);
}

runTests().catch((err) => {
    console.error('未捕获异常:', err && err.stack ? err.stack : err);
    process.exit(1);
});
