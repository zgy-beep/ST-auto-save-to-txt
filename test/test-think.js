const fs = require('fs');
const path = require('path');

const INLINE_TAGS = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'span', 'sub', 'sup', 'small', 'del', 'mark']);

function cleanNovelText(rawText, settings = {}) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText;

    // 前置清洗：彻底过滤 HTML 注释 (如 <!-- Lorebook: ... -->) 与 Markdown 多媒体图片
    text = text.replace(/<!--[\s\S]*?-->/g, '');
    text = text.replace(/!\[.*?\]\(.*?\)/g, '');
    text = text.replace(/<img[^>]*>/gi, '');

    // 阶段零【通用前置无头标签与思维链智能清洗】：
    // 应对任何反代、Prefill、插件导致的"开篇无起始标签、仅有闭标签"问题（无论标签名叫什么，均可自动识别并切除）
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

    // 剔除末尾未闭合的思考链（针对 max_tokens 截断未输出闭合标签的情况）
    const unclosedAuxPattern = /<\s*([a-zA-Z0-9_\-~.:#]*(?:think|thought|reasoning|cot|scratchpad|reflection|inner_thought|analysis|plan)[a-zA-Z0-9_\-~.:#]*)[^>]*>[\s\S]*$/i;
    text = text.replace(unclosedAuxPattern, '');

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
        : 'status,memory,details,variables,analysis,ooc,note,draft,system,log';

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

// 测试各种情况
const testCases = [
    {
        name: '测试1: 只有 </think_fox~> 结束标签，无开始标签的思考过程',
        input: '这是前置思考分析过程...\n角色心境应该是有些犹豫的。\n</think_fox~>\n第一章 启程\n清晨的微风穿过树林。',
        expected: '　　第一章 启程\n\n　　清晨的微风穿过树林。'
    },
    {
        name: '测试2: 只有 </think> 结束标签，无开始标签',
        input: '思考中...\n</think>\n第二章 离别\n少年踏上了远方的路。',
        expected: '　　第二章 离别\n\n　　少年踏上了远方的路。'
    },
    {
        name: '测试3: 完整成对的 <think_fox~>...</think_fox~>',
        input: '<think_fox~>\n成对思考内容\n</think_fox~>\n第三章 归途\n他终于回来了。',
        expected: '　　第三章 归途\n\n　　他终于回来了。'
    },
    {
        name: '测试4: 多段思考流，带有孤立闭标签',
        input: '思考一...\n</think_fox~>\n补充思考二...\n</think_fox~>\n正文内容第一段。',
        expected: '　　正文内容第一段。'
    },
    {
        name: '测试5: 思考流 + 黑名单标签 <status> + <memory>',
        input: '无头思考...\n</think_fox~>\n第一章\n正文在此。\n<status>血量: 100</status>',
        expected: '　　第一章\n\n　　正文在此。'
    },
    {
        name: '测试6: 思考流 + 白名单模式 <story>',
        input: '无头思考...\n</think_fox~>\n<story>这是被白名单包裹的真正小说正文。</story>',
        settings: { include_tags: '<story>' },
        expected: '　　这是被白名单包裹的真正小说正文。'
    },
    {
        name: '测试7: 自定义黑名单标签缺失开标签、仅有结束标签（如 </fox_draft>）',
        input: '这是草稿分析过程...\n</fox_draft>\n真正的章节正文内容。',
        settings: { exclude_tags: '<fox_draft>, <status>' },
        expected: '　　真正的章节正文内容。'
    }
];

let allPassed = true;
for (const tc of testCases) {
    const result = cleanNovelText(tc.input, tc.settings || {});
    if (result === tc.expected) {
        console.log(`[PASS] ${tc.name}`);
    } else {
        console.error(`[FAIL] ${tc.name}`);
        console.error('Expected:\n' + JSON.stringify(tc.expected));
        console.error('Got:\n' + JSON.stringify(result));
        allPassed = false;
    }
}

if (!allPassed) {
    process.exit(1);
} else {
    console.log('\n所有思考标签排除测试全部通过！');
}
