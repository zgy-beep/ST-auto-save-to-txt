/**
 * 图片电子书（EPUB）服务端单元测试
 * 运行方式: node test/test-ebook.js
 *
 * 覆盖：
 *  1) buildZip：ZIP 字节结构（mimetype 首条目 + STORED）、UTF-8 标志、CRC32、deflate 内容
 *  2) buildEpubBuffer：EPUB 必要条目、XML 全部可解析、转义、册/章/图片一一对应
 *  3) resolveImagePath：四级解析顺序（账号 / default-user / data/* 通配 / missing）、越界拒绝
 *  4) sniffImageType / readImageAsset：四种魔数、未知格式、大小限制、缺失文件
 *  5) POST /ebook：400 / 413 / 成功落盘 / 跳过清单 / .bak 备份 / 纯文字也允许
 *
 * 所有临时落盘都在 os.tmpdir() 下，try/finally 清理，不在仓库内留文件。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const plugin = require('../plugins/auto-save/index.js');

// ---------------- 测试用 MockRouter（与 test-server.js 同风格） ----------------
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
        const req = { body };
        const res = {
            status: function (code) {
                statusCode = code;
                return this;
            },
            json: function (data) {
                responseData = data;
                return this;
            }
        };
        await handler(req, res);
        return { status: statusCode, data: responseData };
    }
}

// ---------------- 独立实现的 CRC32 / ZIP 读取器（用于交叉校验手写 ZIP） ----------------
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 解析 ZIP（本地头 + 中央目录 + EOCD）并解压全部条目 */
function readZip(buf) {
    if (buf.readUInt32LE(buf.length - 22) !== 0x06054B50) {
        throw new Error('EOCD 签名不存在');
    }
    const total = buf.readUInt16LE(buf.length - 22 + 10);
    const cdOffset = buf.readUInt32LE(buf.length - 22 + 16);
    const entries = [];
    let p = cdOffset;

    for (let i = 0; i < total; i++) {
        if (buf.readUInt32LE(p) !== 0x02014B50) throw new Error(`中央目录条目 ${i} 签名错误`);
        const flags = buf.readUInt16LE(p + 8);
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const csize = buf.readUInt32LE(p + 20);
        const usize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

        if (buf.readUInt32LE(localOffset) !== 0x04034B50) throw new Error(`条目 ${name} 本地头签名错误`);
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const localMethod = buf.readUInt16LE(localOffset + 8);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const compressed = buf.subarray(dataStart, dataStart + csize);
        const data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed);

        entries.push({
            name,
            method,
            localMethod,
            flags,
            crc,
            crcOk: crc32(data) === crc,
            csize,
            usize,
            localOffset,
            dataStart,
            data
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries, byName: Object.fromEntries(entries.map((e) => [e.name, e])) };
}

/** 极简 XML 合法性检查（本项目零依赖，够校验自己生成的 XHTML/OPF/NCX） */
function checkXmlWellFormed(xml) {
    if (typeof xml !== 'string' || !xml.trim()) return { ok: false, why: '空文档' };
    if (!/^<\?xml\s/.test(xml)) return { ok: false, why: '缺少 XML 声明' };
    const badAmp = /&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
    const cleaned = xml
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!DOCTYPE[^>]*>/gi, '');
    const tagRe = /<\/?([A-Za-z_][\w:.-]*)((?:\s+[^<>]*?)?)(\/?)>/g;
    const stack = [];
    let cursor = 0;
    let match;
    while ((match = tagRe.exec(cleaned)) !== null) {
        if (badAmp.test(cleaned.slice(cursor, match.index))) {
            return { ok: false, why: `文本中出现未转义的 &（${match[1]} 前）` };
        }
        cursor = tagRe.lastIndex;
        const raw = match[0];
        const tagName = match[1];
        const attrs = match[2] || '';
        const selfClosing = match[3] === '/';
        if (badAmp.test(attrs)) return { ok: false, why: `<${tagName}> 属性中出现未转义的 &` };
        if (/(^|\s)[\w:.-]+=\s*[^"'\s>]/.test(attrs)) {
            return { ok: false, why: `<${tagName}> 属性值未加引号` };
        }
        if (raw.startsWith('</')) {
            if (stack.pop() !== tagName) return { ok: false, why: `闭合标签不匹配 </${tagName}>` };
        } else if (!selfClosing) {
            stack.push(tagName);
        }
    }
    if (badAmp.test(cleaned.slice(cursor))) return { ok: false, why: '尾部出现未转义的 &' };
    if (stack.length > 0) return { ok: false, why: `标签未闭合: ${stack.join(',')}` };
    return { ok: true };
}

/** 抽取 XHTML 中所有 <img src="..."> 的 src 值（用于逐章校验图片引用都能落到 ZIP 条目） */
function extractImgSrcs(xhtml) {
    return [...String(xhtml || '').matchAll(/<img\s[^>]*?src="([^"]*)"/g)].map((m) => m[1]);
}

// ---------------- 测试图片字节（魔数有效即可；单测不做解码） ----------------
const PNG_1PX = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
);
const JPEG_1PX = Buffer.from(
    'ffd8ffe000104a46494600010100000100010000ffdb004300ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc00011080001000103012200021101031101ffc4001f0000010501010101010100000000000000000102030405060708090a0bffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9faffda0008010100003f00fbf8a28a2803ffd9',
    'hex'
);
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const WEBP_1PX = Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x1A, 0x00, 0x00, 0x00]),
    Buffer.from('WEBPVP8L', 'latin1'),
    Buffer.from([0x0D, 0x00, 0x00, 0x00, 0x2F, 0x00, 0x00, 0x00, 0x00, 0x07, 0x10, 0x00, 0x00])
]);

async function runTests() {
    console.log('=== 开始执行图片电子书（EPUB）服务端单元测试 ===\n');
    let passCount = 0;
    let failCount = 0;

    const router = new MockRouter();
    await plugin.init(router);

    const TMP = path.join(os.tmpdir(), `auto-save-ebook-${process.pid}-${Date.now()}`);
    const ST_ROOT = path.join(TMP, 'st');
    const DATA = path.join(ST_ROOT, 'data');
    const OUT_DIR = path.join(TMP, 'out');

    function assert(condition, testName) {
        if (condition) {
            console.log(`[PASS] ${testName}`);
            passCount++;
        } else {
            console.error(`[FAIL] ${testName}`);
            failCount++;
        }
    }

    function writeFixture(relativePath, data) {
        const absPath = path.join(DATA, relativePath);
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, data);
        return absPath;
    }

    try {
        // ================= 1. buildZip：ZIP 字节结构 =================
        console.log('--- 1. buildZip 手写 ZIP ---');
        const zipBuf = plugin.buildZip([
            { name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii'), store: true },
            { name: 'a.txt', data: Buffer.from('hello 中文', 'utf8') },
            { name: 'bin/data.bin', data: Buffer.from([0, 1, 2, 3, 4, 5, 254, 255]) }
        ]);
        const zip = readZip(zipBuf);
        assert(zipBuf.readUInt32LE(0) === 0x04034B50, 'buildZip: 文件以本地头签名 PK\\x03\\x04 开始');
        assert((zipBuf.readUInt16LE(6) & 0x0800) !== 0, 'buildZip: 通用标志位 bit11=0x0800（文件名 UTF-8）');
        assert(zip.entries.length === 3, 'buildZip: EOCD 记录 3 个条目');
        assert(zip.entries[0].name === 'mimetype', 'buildZip: mimetype 是第一个条目');
        assert(zip.entries[0].method === 0 && zip.entries[0].localMethod === 0, 'buildZip: mimetype 使用 STORED 不压缩');
        assert(zip.entries[0].dataStart === 38, 'buildZip: mimetype 本地头无扩展字段（数据起点 38）');
        assert(zip.entries[0].data.toString() === 'application/epub+zip', 'buildZip: mimetype 内容为 application/epub+zip');
        assert(zip.entries[1].method === 8, 'buildZip: 非 mimetype 条目使用 deflate（method=8）');
        assert(zip.entries[1].data.toString('utf8') === 'hello 中文', 'buildZip: deflate 条目解压后内容正确（UTF-8 中文）');
        assert(zip.entries.every((e) => e.crcOk), 'buildZip: 全部条目 CRC32 校验通过（独立实现交叉校验）');
        assert(zipBuf.readUInt32LE(zipBuf.length - 22) === 0x06054B50, 'buildZip: 文件以 EOCD 签名结束');
        assert(zipBuf.readUInt16LE(zipBuf.length - 22 + 20) === 0, 'buildZip: EOCD 注释长度为 0');
        // mimetype 未显式传 store 时也必须强制 STORED（EPUB 硬性要求）
        const zipAutoStore = readZip(plugin.buildZip([
            { name: 'mimetype', data: Buffer.from('application/epub+zip', 'ascii') },
            { name: 'x.txt', data: Buffer.from('x') }
        ]));
        assert(zipAutoStore.entries[0].method === 0, 'buildZip: mimetype 未传 store 时自动强制 STORED');
        let emptyThrew = false;
        try {
            plugin.buildZip([]);
        } catch (err) {
            emptyThrew = true;
        }
        assert(emptyThrew, 'buildZip: 空条目数组抛出明确异常');

        // ================= 2. 魔数嗅探 =================
        console.log('\n--- 2. sniffImageType 魔数嗅探 ---');
        const typePng = plugin.sniffImageType(PNG_1PX);
        const typeJpeg = plugin.sniffImageType(JPEG_1PX);
        const typeGif = plugin.sniffImageType(GIF_1PX);
        const typeWebp = plugin.sniffImageType(WEBP_1PX);
        assert(typePng && typePng.mediaType === 'image/png' && typePng.ext === 'png', 'sniffImageType: PNG 识别正确');
        assert(typeJpeg && typeJpeg.mediaType === 'image/jpeg' && typeJpeg.ext === 'jpg', 'sniffImageType: JPEG 识别正确');
        assert(typeGif && typeGif.mediaType === 'image/gif' && typeGif.ext === 'gif', 'sniffImageType: GIF 识别正确');
        assert(typeWebp && typeWebp.mediaType === 'image/webp' && typeWebp.ext === 'webp', 'sniffImageType: WebP 识别正确');
        assert(plugin.sniffImageType(Buffer.from('NOT-AN-IMAGE')) === null, 'sniffImageType: 未知格式返回 null（不猜）');
        assert(plugin.sniffImageType(Buffer.from([0xFF])) === null, 'sniffImageType: 过短字节返回 null');
        assert(plugin.sniffImageType('not-buffer') === null, 'sniffImageType: 非 Buffer 返回 null');

        // ================= 3. resolveImagePath 四级解析 =================
        console.log('\n--- 3. resolveImagePath 四级解析顺序 ---');
        const CHAT = '柏宝绘_Seraphina'; // 中文聊天目录：磁盘侧不做 URL 编解码
        writeFixture(path.join('zgy9009', 'user', 'images', CHAT, 'in_account.png'), PNG_1PX);
        writeFixture(path.join('default-user', 'user', 'images', CHAT, 'in_default.gif'), GIF_1PX);
        writeFixture(path.join('acc2', 'user', 'images', CHAT, 'only_in_acc2.jpg'), JPEG_1PX);
        writeFixture(path.join('acc2', 'user', 'images', 'chatB', 'shared.webp'), WEBP_1PX);
        writeFixture(path.join('acc3', 'user', 'images', 'chatB', 'shared.webp'), WEBP_1PX);
        fs.mkdirSync(path.join(DATA, 'acc4', 'user', 'images', 'chatB', 'a-directory.png'), { recursive: true });

        const r1 = await plugin.resolveImagePath(`/user/images/${CHAT}/in_account.png`, { account: 'zgy9009', stRoot: ST_ROOT });
        assert(r1.ok && r1.via === 'account' && r1.absPath === path.join(DATA, 'zgy9009', 'user', 'images', CHAT, 'in_account.png'),
            'resolveImagePath: ① 优先命中指定账号（中文路径原样，不做 URL 解码）');
        assert(r1.ok && r1.rel === `${CHAT}/in_account.png`, 'resolveImagePath: rel 等于 /user/images/ 之后的部分');

        const r2 = await plugin.resolveImagePath(`/user/images/${CHAT}/in_default.gif`, { account: 'zgy9009', stRoot: ST_ROOT });
        assert(r2.ok && r2.via === 'default-user', 'resolveImagePath: ② 指定账号未命中时回落到 default-user');

        const r3 = await plugin.resolveImagePath(`/user/images/${CHAT}/only_in_acc2.jpg`, { account: 'zgy9009', stRoot: ST_ROOT });
        assert(r3.ok && r3.via === 'glob' && r3.account === 'acc2', 'resolveImagePath: ③ 通配 data/* 兜底命中其它账号');

        const originalWarn = console.warn;
        const warnLogs = [];
        console.warn = (...args) => warnLogs.push(args.join(' '));
        let r4;
        try {
            r4 = await plugin.resolveImagePath('/user/images/chatB/shared.webp', { account: '', stRoot: ST_ROOT });
        } finally {
            console.warn = originalWarn;
        }
        assert(r4.ok && r4.via === 'glob' && r4.account === 'acc2', 'resolveImagePath: ③ 多账号命中取第一个（排序后 acc2）');
        assert(warnLogs.length > 0 && warnLogs[0].includes('多账号'), 'resolveImagePath: 多账号命中必须 console.warn（不静默）');

        const r5 = await plugin.resolveImagePath('/user/images/chatB/nope.png', { account: 'zgy9009', stRoot: ST_ROOT });
        assert(!r5.ok && r5.reason === 'missing', 'resolveImagePath: ④ 全部未命中返回 reason=missing');
        const r6 = await plugin.resolveImagePath('/user/images/chatB/a-directory.png', { account: 'acc4', stRoot: ST_ROOT });
        assert(!r6.ok && r6.reason === 'missing', 'resolveImagePath: 目录不算图片文件（按 missing 处理）');

        const r7 = await plugin.resolveImagePath('/images/chatB/x.png', { stRoot: ST_ROOT });
        assert(!r7.ok && r7.reason === 'unsupported_path', 'resolveImagePath: 非 /user/images/ 前缀 → unsupported_path');
        const r8 = await plugin.resolveImagePath(null, { stRoot: ST_ROOT });
        assert(!r8.ok && r8.reason === 'unsupported_path', 'resolveImagePath: 非字符串入参 → unsupported_path');
        const r9 = await plugin.resolveImagePath('/user/images/../../secret.jpg', { stRoot: ST_ROOT });
        assert(!r9.ok && r9.reason === 'path_traversal', 'resolveImagePath: rel 中的 .. 段被拒绝（path_traversal）');
        const r10 = await plugin.resolveImagePath('/user/images/chatB/../../../boot.ini', { stRoot: ST_ROOT });
        assert(!r10.ok && r10.reason === 'path_traversal', 'resolveImagePath: 嵌套 .. 越界被拒绝');
        const r11 = await plugin.resolveImagePath('/user/images/chatB/x.png', { account: '../evil', stRoot: ST_ROOT });
        assert(!r11.ok, 'resolveImagePath: 非法账号名（../evil）被忽略且不越界命中');
        assert(typeof plugin.resolveStRoot(ST_ROOT) === 'string' && plugin.resolveStRoot(ST_ROOT) === path.resolve(ST_ROOT),
            'resolveStRoot: stRoot 显式覆盖优先');
        assert(path.isAbsolute(plugin.resolveStRoot('')) && plugin.resolveStRoot('').length > 1,
            'resolveStRoot: 未注入时推导出绝对路径（插件目录向上两级 / cwd 兜底）');

        // ================= 4. readImageAsset =================
        console.log('\n--- 4. readImageAsset 读取/嗅探/大小限制 ---');
        const pngAbs = writeFixture(path.join('acc-read', 'user', 'images', 'r', 'a.png'), PNG_1PX);
        const assetOk = await plugin.readImageAsset(pngAbs);
        assert(assetOk.ok && assetOk.mediaType === 'image/png' && assetOk.ext === 'png' && assetOk.bytes === PNG_1PX.length,
            'readImageAsset: 正常读取 PNG 并嗅探媒体类型');
        assert(assetOk.ok && Buffer.compare(assetOk.data, PNG_1PX) === 0, 'readImageAsset: 返回字节与磁盘完全一致');
        const assetTooLarge = await plugin.readImageAsset(pngAbs, { maxImageBytes: 10 });
        assert(!assetTooLarge.ok && assetTooLarge.reason === 'too_large' && assetTooLarge.bytes === PNG_1PX.length,
            'readImageAsset: 超过 maxImageBytes → too_large（带实际字节数）');
        const junkAbs = writeFixture(path.join('acc-read', 'user', 'images', 'r', 'junk.jpg'), Buffer.from('这不是图片'));
        const assetJunk = await plugin.readImageAsset(junkAbs);
        assert(!assetJunk.ok && assetJunk.reason === 'unsupported_format', 'readImageAsset: 未知格式 → unsupported_format');
        const assetMissing = await plugin.readImageAsset(path.join(TMP, 'no-such-file.png'));
        assert(!assetMissing.ok && assetMissing.reason === 'missing', 'readImageAsset: 文件不存在 → missing（不抛异常）');

        // ================= 5. buildEpubBuffer 结构 =================
        console.log('\n--- 5. buildEpubBuffer EPUB3 结构 ---');
        const epubAssets = [
            { href: 'images/img-0001.png', data: PNG_1PX, mediaType: 'image/png' },
            { href: 'images/img-0002.jpg', data: JPEG_1PX, mediaType: 'image/jpeg' }
        ];
        const epubBuf = plugin.buildEpubBuffer({
            bookTitle: '测试《书》 & <名>',
            author: '作者 A',
            chapters: [
                {
                    title: '第 1 章 · 甲',
                    floor: 1,
                    blocks: [
                        { type: 'p', text: '　　她推开门。' },
                        { type: 'img', href: 'images/img-0001.png', alt: '插图 & "1"' },
                        { type: 'p', text: '用 <script>alert(1)</script> & "引号" 测试' }
                    ]
                },
                {
                    // 前端 buildStructuredNovel 的块命名：text / image + path
                    title: '第 2 章 · 乙',
                    floor: 2,
                    blocks: [
                        { type: 'text', text: '前端命名 text 也要认' },
                        { type: 'image', path: 'images/img-0002.jpg', alt: '前端命名 image' }
                    ]
                }
            ],
            assets: epubAssets
        });
        assert(Buffer.isBuffer(epubBuf) && epubBuf.length > 500, 'buildEpubBuffer: 返回非空 Buffer');
        const epub = readZip(epubBuf);
        const names = epub.entries.map((e) => e.name);
        assert(names[0] === 'mimetype' && epub.entries[0].method === 0, 'buildEpubBuffer: mimetype 仍是首条目且 STORED');
        const requiredNames = [
            'META-INF/container.xml',
            'OEBPS/content.opf',
            'OEBPS/nav.xhtml',
            'OEBPS/toc.ncx',
            'OEBPS/style.css',
            'OEBPS/chapter-0001.xhtml',
            'OEBPS/chapter-0002.xhtml',
            'OEBPS/images/img-0001.png',
            'OEBPS/images/img-0002.jpg'
        ];
        assert(requiredNames.every((n) => !!epub.byName[n]), `buildEpubBuffer: 必要条目齐全（缺 ${requiredNames.filter((n) => !epub.byName[n]).join(',') || '无'}）`);

        const xmlNames = names.filter((n) => /\.(xhtml|opf|ncx|xml)$/.test(n));
        const badXml = xmlNames.map((n) => ({ n, r: checkXmlWellFormed(epub.byName[n].data.toString('utf8')) })).filter((x) => !x.r.ok);
        assert(badXml.length === 0, `buildEpubBuffer: 全部 ${xmlNames.length} 个 XML 文档可解析（${badXml.map((b) => `${b.n}:${b.r.why}`).join('; ') || 'all ok'}）`);

        const container = epub.byName['META-INF/container.xml'].data.toString('utf8');
        assert(container.includes('full-path="OEBPS/content.opf"'), 'buildEpubBuffer: container.xml 指向 OEBPS/content.opf');
        const opf = epub.byName['OEBPS/content.opf'].data.toString('utf8');
        assert(opf.includes('version="3.0"') && opf.includes('<dc:language>zh</dc:language>'), 'buildEpubBuffer: OPF 为 EPUB3 且 dc:language=zh');
        assert(opf.includes('测试《书》 &amp; &lt;名&gt;'), 'buildEpubBuffer: OPF 中 dc:title 做了 XML 转义');
        assert(opf.includes('properties="nav"') && opf.includes('<spine toc="ncx">'), 'buildEpubBuffer: OPF 声明 nav 属性与 toc=ncx');
        assert((opf.match(/<itemref /g) || []).length === 2, 'buildEpubBuffer: spine 有 2 个 itemref');
        const manifestHrefs = [...opf.matchAll(/<item [^>]*href="([^"]+)"/g)].map((m) => m[1]);
        const missingManifest = manifestHrefs.filter((href) => !epub.byName[`OEBPS/${href}`]);
        assert(manifestHrefs.length >= 5 && missingManifest.length === 0, `buildEpubBuffer: manifest 的 href 均存在（缺 ${missingManifest.join(',') || '无'}）`);

        const nav = epub.byName['OEBPS/nav.xhtml'].data.toString('utf8');
        assert(nav.includes('epub:type="toc"'), 'buildEpubBuffer: nav.xhtml 含 epub:type="toc"');
        assert(nav.includes('href="chapter-0001.xhtml"') && nav.includes('href="chapter-0002.xhtml"'), 'buildEpubBuffer: nav 列出两章链接');
        const ncx = epub.byName['OEBPS/toc.ncx'].data.toString('utf8');
        assert((ncx.match(/<navPoint /g) || []).length === 2, 'buildEpubBuffer: toc.ncx 有 2 个 navPoint');
        assert(ncx.includes('playOrder="1"') && ncx.includes('playOrder="2"'), 'buildEpubBuffer: toc.ncx playOrder 递增');
        const opfId = (opf.match(/<dc:identifier id="bookid">([^<]+)<\/dc:identifier>/) || [])[1];
        assert(!!opfId && ncx.includes(`content="${opfId}"`), 'buildEpubBuffer: ncx 的 dtb:uid 与 OPF identifier 一致');

        const ch1 = epub.byName['OEBPS/chapter-0001.xhtml'].data.toString('utf8');
        assert(ch1.startsWith('<?xml version="1.0" encoding="utf-8"?>'), 'buildEpubBuffer: 章节 XHTML 以 XML 声明开头');
        assert(ch1.includes('xmlns="http://www.w3.org/1999/xhtml"'), 'buildEpubBuffer: 章节 XHTML 声明 XHTML 命名空间');
        assert(ch1.includes('<p>她推开门。</p>'), 'buildEpubBuffer: 段首「　　」被 CSS 缩进取代（不出现双缩进）');
        assert(ch1.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !ch1.includes('<script>'), 'buildEpubBuffer: 正文 < > & 已 XML 转义（无裸标签）');
        assert(ch1.includes('<figure><img src="images/img-0001.png" alt="插图 &amp; &quot;1&quot;"/></figure>'),
            'buildEpubBuffer: 图片生成 <figure><img/> 且 alt 属性转义');
        const ch2 = epub.byName['OEBPS/chapter-0002.xhtml'].data.toString('utf8');
        assert(ch2.includes('前端命名 text 也要认') && ch2.includes('<img src="images/img-0002.jpg"'),
            'buildEpubBuffer: 兼容前端 text / image + path 块命名');
        assert(Buffer.compare(epub.byName['OEBPS/images/img-0001.png'].data, PNG_1PX) === 0, 'buildEpubBuffer: 图片字节原样嵌入（PNG）');
        assert(Buffer.compare(epub.byName['OEBPS/images/img-0002.jpg'].data, JPEG_1PX) === 0, 'buildEpubBuffer: 图片字节原样嵌入（JPEG）');
        const css = epub.byName['OEBPS/style.css'].data.toString('utf8');
        assert(css.includes('text-indent: 2em') && css.includes('max-width: 100%'), 'buildEpubBuffer: style.css 含段首缩进与图片自适应');
        const emptyEpub = readZip(plugin.buildEpubBuffer({ bookTitle: '空书' }));
        assert(!!emptyEpub.byName['OEBPS/chapter-0001.xhtml'], 'buildEpubBuffer: chapters 为空时仍生成合法单章 EPUB');

        // ================= 6. POST /ebook 端到端 =================
        console.log('\n--- 6. POST /ebook 端到端 ---');
        writeFixture(path.join('acc1', 'user', 'images', 'chatE', 'ok.png'), PNG_1PX);
        writeFixture(path.join('acc1', 'user', 'images', 'chatE', 'ok2.jpg'), JPEG_1PX);
        writeFixture(path.join('acc1', 'user', 'images', 'chatE', 'junk.png'), Buffer.from('这不是图片'));
        const bigPng = Buffer.concat([PNG_1PX, Buffer.alloc(2 * 1024 * 1024, 0)]);
        writeFixture(path.join('acc1', 'user', 'images', 'chatE', 'big.png'), bigPng);

        const ebookBody = {
            bookTitle: '端到端测试《书》',
            author: '测试作者',
            account: 'acc1',
            save_dir: OUT_DIR,
            chat_anchor: '',
            file_name: 'end-to-end.txt',
            options: { stRoot: ST_ROOT },
            chapters: [
                {
                    title: '第 1 章 · 甲',
                    floor: 1,
                    blocks: [
                        { type: 'p', text: '第一段正文。' },
                        { type: 'img', path: '/user/images/chatE/ok.png', alt: '可嵌入的图' },
                        { type: 'img', path: '/user/images/chatE/missing.jpg', alt: '磁盘上不存在' },
                        { type: 'img', path: '/user/images/chatE/junk.png', alt: '格式不支持' },
                        { type: 'p', text: '第二段正文。' }
                    ]
                },
                {
                    title: '第 2 章 · 乙',
                    floor: 2,
                    blocks: [
                        { type: 'image', path: '/user/images/chatE/ok2.jpg', alt: '前端命名 image' }
                    ]
                }
            ]
        };

        const res1 = await router.dispatch('POST', '/ebook', ebookBody);
        assert(res1.status === 200 && res1.data.success === true, 'POST /ebook: 成功返回 200 success:true');
        assert(typeof res1.data.file === 'string' && res1.data.file.endsWith('.epub'), 'POST /ebook: 响应 file 是 .epub 相对路径');
        assert(res1.data.epubBytes > 0, 'POST /ebook: 响应含 epubBytes');
        assert(res1.data.images.embedded === 2, 'POST /ebook: 2 张图片成功嵌入');
        assert(res1.data.images.skipped === 2, 'POST /ebook: 2 张图片被跳过（缺失 + 格式不支持）');
        const missingPaths = (res1.data.images.missing || []).map((m) => m.path);
        assert(missingPaths.includes('/user/images/chatE/missing.jpg') && missingPaths.includes('/user/images/chatE/junk.png'),
            'POST /ebook: 跳过清单逐条报告路径（不静默）');
        const missingReasons = (res1.data.images.missing || []).map((m) => m.reason);
        assert(missingReasons.includes('missing') && missingReasons.includes('unsupported_format'),
            'POST /ebook: 跳过清单带 reason（missing / unsupported_format）');
        assert((res1.data.images.missing || []).every((m) => m.chapter === 1), 'POST /ebook: 跳过清单标注所属章节');

        const epubOnDisk = fs.readFileSync(path.resolve(res1.data.file));
        assert(epubOnDisk.length === res1.data.epubBytes, 'POST /ebook: 落盘字节数与 epubBytes 一致');
        assert(path.resolve(res1.data.file) === path.join(OUT_DIR, '端到端测试《书》.epub'), 'POST /ebook: 落盘位置 = save_dir + 安全书名.epub');
        const servedEpub = readZip(epubOnDisk);
        const imgEntries = servedEpub.entries.filter((e) => e.name.startsWith('OEBPS/images/'));
        assert(imgEntries.length === 2, 'POST /ebook: EPUB 内只嵌入成功解析的 2 张图');
        assert(servedEpub.byName['OEBPS/images/img-0001.png'] && servedEpub.byName['OEBPS/images/img-0002.jpg'],
            'POST /ebook: 图片按顺序编号 img-0001/img-0002 且扩展名来自魔数');
        const servedCh1 = servedEpub.byName['OEBPS/chapter-0001.xhtml'].data.toString('utf8');
        assert(servedCh1.includes('<img src="images/img-0001.png"') && !servedCh1.includes('missing.jpg'),
            'POST /ebook: 章节 XHTML 原位引用成功嵌入的图，缺失图不产生空引用');
        assert(servedEpub.byName['mimetype'].method === 0, 'POST /ebook: 产出的 EPUB mimetype 仍是 STORED 首条目');

        // 再次导出 → 覆盖前应留下 .bak（内容 == 上一次的 epub）
        const res2 = await router.dispatch('POST', '/ebook', ebookBody);
        assert(res2.status === 200, 'POST /ebook: 二次导出成功');
        const bakPath = `${path.resolve(res2.data.file)}.bak`;
        assert(fs.existsSync(bakPath), 'POST /ebook: 覆盖旧 EPUB 前生成 .bak 备份');
        assert(Buffer.compare(fs.readFileSync(bakPath), epubOnDisk) === 0, 'POST /ebook: .bak 内容等于覆盖前的 EPUB');

        // 纯文字（零图片）也允许导出
        const textOnly = await router.dispatch('POST', '/ebook', {
            bookTitle: '纯文字书', save_dir: OUT_DIR, options: { stRoot: ST_ROOT },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'p', text: '没有图片的正文。' }] }]
        });
        assert(textOnly.status === 200 && textOnly.data.images.embedded === 0 && textOnly.data.images.skipped === 0,
            'POST /ebook: 无图也能导出纯文字 EPUB');
        assert(!readZip(fs.readFileSync(path.resolve(textOnly.data.file))).entries.some((e) => e.name.startsWith('OEBPS/images/')),
            'POST /ebook: 纯文字 EPUB 内没有图片条目');

        // 单图上限（请求级 options.maxImageBytes 生效）
        const smallLimit = await router.dispatch('POST', '/ebook', {
            bookTitle: '单图上限书', save_dir: OUT_DIR, options: { stRoot: ST_ROOT, maxImageBytes: 10 },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'img', path: '/user/images/chatE/ok.png', alt: 'x' }] }]
        });
        assert(smallLimit.status === 200 && smallLimit.data.images.skipped === 1
            && smallLimit.data.images.missing[0].reason === 'too_large',
            'POST /ebook: options.maxImageBytes 生效（超限图片被跳过并报告 too_large）');

        // 总大小上限 → 413
        const totalLimit = await router.dispatch('POST', '/ebook', {
            bookTitle: '总量上限书', save_dir: OUT_DIR,
            options: { stRoot: ST_ROOT, maxTotalBytes: 1024 * 1024 },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'img', path: '/user/images/chatE/big.png', alt: 'big' }] }]
        });
        assert(totalLimit.status === 413, 'POST /ebook: 图片总量超限返回 413');
        assert(typeof totalLimit.data.error === 'string' && totalLimit.data.error.includes('图片总量超出'), 'POST /ebook: 413 文案为「图片总量超出 …MB 限制」');
        assert(!fs.existsSync(path.join(OUT_DIR, '总量上限书.epub')), 'POST /ebook: 413 时不落盘任何 EPUB');

        // 入参校验
        const badBody = await router.dispatch('POST', '/ebook', { bookTitle: 'x', chapters: 'not-array' });
        assert(badBody.status === 400 && badBody.data.error === '无效请求', 'POST /ebook: chapters 非数组 → 400 无效请求');
        const badTitle = await router.dispatch('POST', '/ebook', { bookTitle: '', chapters: [{ title: 'a', blocks: [] }] });
        assert(badTitle.status === 400, 'POST /ebook: bookTitle 非字符串/空 → 400');
        const noChapters = await router.dispatch('POST', '/ebook', { bookTitle: 'x', chapters: [] });
        assert(noChapters.status === 400, 'POST /ebook: chapters 空数组 → 400');
        const emptyBody = await router.dispatch('POST', '/ebook', {});
        assert(emptyBody.status === 400, 'POST /ebook: 空请求体 → 400');

        // ================= 7. 审计补强：锁住"实现正确但测试没锁"的边界 =================
        // 本节由 tests-auditor 只读复核后补强：不改变实现，只把边界行为钉死，防后人静默改坏。
        console.log('\n--- 7. 审计补强回归锁定（路径穿越 / 413 残留 / 优先级 / off-by-one / 多章引用）---');
        const OUT2 = path.join(TMP, 'out2');
        const out2Snapshot = () => (fs.existsSync(OUT2) ? fs.readdirSync(OUT2).sort() : []);
        const escapeTargets = [
            path.join(TMP, 'evil.epub'),
            path.join(os.tmpdir(), 'evil.epub'),
            path.join(path.dirname(TMP), 'evil.epub')
        ];

        // 7.1 bookTitle 路径穿越：必须被 sanitize 成纯文件名，绝不越界写盘（实现已正确，这里锁死）
        const trav1 = await router.dispatch('POST', '/ebook', {
            bookTitle: '../../evil', save_dir: OUT2, options: { stRoot: ST_ROOT },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'p', text: '穿越测试一。' }] }]
        });
        const trav1Path = path.resolve(trav1.data.file);
        assert(trav1.status === 200, 'bookTitle 穿越: "../../evil" 仍正常导出（清洗而非报错）');
        assert(path.dirname(trav1Path) === path.resolve(OUT2), 'bookTitle 穿越: 落盘目录仍是 save_dir（未逃出）');
        assert(!path.basename(trav1Path).includes('..') && !/[\\/]/.test(path.basename(trav1Path)),
            'bookTitle 穿越: 产出文件名不含 .. 与路径分隔符');
        assert(escapeTargets.every((p) => !fs.existsSync(p)), 'bookTitle 穿越: 上级目录/os.tmpdir 均未生成 evil.epub');

        const trav2 = await router.dispatch('POST', '/ebook', {
            bookTitle: '..\\..\\evil', save_dir: OUT2, options: { stRoot: ST_ROOT },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'p', text: '穿越测试二。' }] }]
        });
        const trav2Path = path.resolve(trav2.data.file);
        assert(trav2.status === 200, 'bookTitle 穿越: Windows 分隔符 "..\\\\..\\\\evil" 仍正常导出');
        assert(path.dirname(trav2Path) === path.resolve(OUT2), 'bookTitle 穿越: Windows 变体同样未逃出 save_dir');
        assert(escapeTargets.every((p) => !fs.existsSync(p)), 'bookTitle 穿越: Windows 变体未越界生成 evil.epub');

        // 7.2 413 必须"零残留"，且绝不能先写后校验破坏同名旧 EPUB
        const keepTitle = '413 保护书';
        const okExport = await router.dispatch('POST', '/ebook', {
            bookTitle: keepTitle, save_dir: OUT2, options: { stRoot: ST_ROOT },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'p', text: '先成功导出一次，作为"旧文件"。' }] }]
        });
        assert(okExport.status === 200, '413 保护: 先成功导出同名 EPUB 作为旧文件');
        const keepPath = path.resolve(okExport.data.file);
        const keepBytesBefore = fs.readFileSync(keepPath);
        const filesBefore413 = out2Snapshot();

        const res413 = await router.dispatch('POST', '/ebook', {
            bookTitle: keepTitle, save_dir: OUT2,
            options: { stRoot: ST_ROOT, maxTotalBytes: 1024 * 1024 },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'img', path: '/user/images/chatE/big.png', alt: 'big' }] }]
        });
        assert(res413.status === 413, '413 保护: 超总量返回 413');
        const filesAfter413 = out2Snapshot();
        assert(filesAfter413.filter((f) => f.includes('.tmp-')).length === 0, '413 保护: 目标目录无 .tmp-* 临时文件残留');
        assert(JSON.stringify(filesAfter413) === JSON.stringify(filesBefore413),
            `413 保护: 目标目录文件清单未变（新增: ${filesAfter413.filter((f) => !filesBefore413.includes(f)).join(',') || '无'}）`);
        assert(Buffer.compare(fs.readFileSync(keepPath), keepBytesBefore) === 0, '413 保护: 同名旧 EPUB 字节完全未被改动（防"先写后校验"回归）');
        assert(!fs.existsSync(`${keepPath}.bak`), '413 保护: 413 请求未进入写盘阶段（未产生 .bak）');

        // 7.3 解析优先级必须是 ①account → ②default-user → ③glob（同一 rel 同时存在才证得了顺序）
        writeFixture(path.join('prio-acc', 'user', 'images', 'prio', 'same.png'), PNG_1PX);
        writeFixture(path.join('default-user', 'user', 'images', 'prio', 'same.png'), GIF_1PX);
        writeFixture(path.join('acc2', 'user', 'images', 'prio', 'same.png'), JPEG_1PX);
        const prio1 = await plugin.resolveImagePath('/user/images/prio/same.png', { account: 'prio-acc', stRoot: ST_ROOT });
        assert(prio1.ok && prio1.via === 'account'
            && prio1.absPath === path.join(DATA, 'prio-acc', 'user', 'images', 'prio', 'same.png'),
            'resolveImagePath 优先级: 同 rel 同时在 account 与 default-user → 必须命中 account');
        const prio2 = await plugin.resolveImagePath('/user/images/prio/same.png', { account: 'no-such-account', stRoot: ST_ROOT });
        assert(prio2.ok && prio2.via === 'default-user'
            && prio2.absPath === path.join(DATA, 'default-user', 'user', 'images', 'prio', 'same.png'),
            'resolveImagePath 优先级: account 不存在时必须命中 default-user（且优先于 glob）');

        // 7.4 maxImageBytes 边界 off-by-one：恰好等于上限应放行，只有"大于"才拒绝
        const exactLimit = await plugin.readImageAsset(pngAbs, { maxImageBytes: PNG_1PX.length });
        assert(exactLimit.ok && exactLimit.bytes === PNG_1PX.length,
            'readImageAsset 边界: 大小恰好等于 maxImageBytes 时放行（防 > 被改成 >= 误杀）');
        const overLimit = await plugin.readImageAsset(pngAbs, { maxImageBytes: PNG_1PX.length - 1 });
        assert(!overLimit.ok && overLimit.reason === 'too_large' && overLimit.bytes === PNG_1PX.length,
            'readImageAsset 边界: 大小 = maxImageBytes + 1 时拒绝（拒绝条件应是"大于上限"）');
        const exactRoute = await router.dispatch('POST', '/ebook', {
            bookTitle: '边界书', save_dir: OUT2,
            options: { stRoot: ST_ROOT, maxImageBytes: PNG_1PX.length },
            chapters: [{ title: '第 1 章', blocks: [{ type: 'img', path: '/user/images/chatE/ok.png', alt: '恰好等于上限' }] }]
        });
        assert(exactRoute.status === 200 && exactRoute.data.images.embedded === 1 && exactRoute.data.images.skipped === 0,
            '/ebook 边界: options.maxImageBytes 恰好等于图片大小时正常嵌入（off-by-one 锁定）');

        // 7.5 同一 path 被重复引用：当前实现不去重，引用几次就嵌入几份 —— 锁定现状
        const dupReq = await router.dispatch('POST', '/ebook', {
            bookTitle: '重复引用书', save_dir: OUT2, options: { stRoot: ST_ROOT },
            chapters: [{
                title: '第 1 章',
                blocks: [
                    { type: 'img', path: '/user/images/chatE/ok.png', alt: '第一次' },
                    { type: 'img', path: '/user/images/chatE/ok.png', alt: '第二次' },
                    { type: 'img', path: '/user/images/chatE/ok.png', alt: '第三次' }
                ]
            }]
        });
        assert(dupReq.status === 200 && dupReq.data.images.embedded === 3 && dupReq.data.images.skipped === 0,
            '重复引用: 同一 path 引用 3 次 → embedded=3（当前实现不去重，锁定现状）');
        const dupZip = readZip(fs.readFileSync(path.resolve(dupReq.data.file)));
        const dupImgs = dupZip.entries.filter((e) => e.name.startsWith('OEBPS/images/'));
        // 若未来改为按 path 去重，必须同步修改下面两条断言与实现
        assert(dupImgs.length === 3 && dupImgs.every((e) => Buffer.compare(e.data, PNG_1PX) === 0),
            '重复引用: ZIP 内确有 3 份独立图片条目（若未来去重需同步改此处）');
        const dupCh = dupZip.byName['OEBPS/chapter-0001.xhtml'].data.toString('utf8');
        assert((dupCh.match(/<figure><img /g) || []).length === 3, '重复引用: 章节 XHTML 中 3 个 <figure><img/> 原位引用');

        // 7.6 遍历全部章节 XHTML 的 <img src>，逐条断言都能在 ZIP 中找到条目（防后续章编号错位）
        const multi = await router.dispatch('POST', '/ebook', {
            bookTitle: '多章图片书', save_dir: OUT2, options: { stRoot: ST_ROOT },
            chapters: [
                { title: '第 1 章 · 无图', blocks: [{ type: 'p', text: '纯文字章节。' }] },
                {
                    title: '第 2 章 · 一张', blocks: [
                        { type: 'p', text: '图在前。' },
                        { type: 'img', path: '/user/images/chatE/ok.png', alt: '第 2 章图' },
                        { type: 'p', text: '图在后。' }
                    ]
                },
                {
                    title: '第 3 章 · 两张', blocks: [
                        { type: 'img', path: '/user/images/chatE/ok2.jpg', alt: '第 3 章图 A' },
                        { type: 'p', text: '中间正文。' },
                        { type: 'img', path: '/user/images/chatE/ok.png', alt: '第 3 章图 B' }
                    ]
                }
            ]
        });
        assert(multi.status === 200 && multi.data.images.embedded === 3 && multi.data.images.skipped === 0,
            '多章图片: 3 张图片全部跨章嵌入');
        const multiZip = readZip(fs.readFileSync(path.resolve(multi.data.file)));
        const chapterEntries = multiZip.entries
            .filter((e) => /^OEBPS\/chapter-\d{4}\.xhtml$/.test(e.name))
            .sort((a, b) => a.name.localeCompare(b.name));
        assert(chapterEntries.length === 3, '多章图片: EPUB 内生成 3 个章节 XHTML');
        const unresolved = [];
        let imgRefCount = 0;
        for (const entry of chapterEntries) {
            for (const src of extractImgSrcs(entry.data.toString('utf8'))) {
                imgRefCount++;
                if (!multiZip.byName[`OEBPS/${src}`]) unresolved.push(`${entry.name} → ${src}`);
            }
        }
        assert(unresolved.length === 0,
            `多章图片: 全部章节的 <img src> 都能在 ZIP 中找到对应条目（未解析: ${unresolved.join(',') || '无'}）`);
        assert(imgRefCount === 3, '多章图片: <img> 引用总数 == embedded 数（无漏引用）');
        const ch2Srcs = extractImgSrcs(multiZip.byName['OEBPS/chapter-0002.xhtml'].data.toString('utf8'));
        const ch3Srcs = extractImgSrcs(multiZip.byName['OEBPS/chapter-0003.xhtml'].data.toString('utf8'));
        assert(ch2Srcs.length === 1 && ch2Srcs[0] === 'images/img-0001.png', '多章图片: 第 2 章的图编号为 img-0001（跨章顺序编号）');
        assert(ch3Srcs.length === 2 && ch3Srcs[0] === 'images/img-0002.jpg' && ch3Srcs[1] === 'images/img-0003.png',
            '多章图片: 第 3 章两张图按 blocks 顺序编号为 img-0002/img-0003');
        const referenced = new Set(chapterEntries.flatMap((e) => extractImgSrcs(e.data.toString('utf8'))));
        const orphanImgs = multiZip.entries
            .filter((e) => e.name.startsWith('OEBPS/images/') && !referenced.has(e.name.slice('OEBPS/'.length)));
        assert(orphanImgs.length === 0,
            `多章图片: 无未被任何章节引用的孤儿图片条目（孤儿: ${orphanImgs.map((e) => e.name).join(',') || '无'}）`);
    } catch (err) {
        console.error('测试异常:', err);
        failCount++;
    } finally {
        await plugin.exit();
        fs.rmSync(TMP, { recursive: true, force: true });
    }

    console.log(`\n=== 测试结果: 通过: ${passCount}, 失败: ${failCount} ===`);
    if (failCount > 0) process.exit(1);
}

runTests();
