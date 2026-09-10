const fs = require('fs');
const path = require('path');

function cleanNovelText(rawText, settings = {}) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText;

    // 阶段零【思考流与思维链智能清洗】：
    // 应对如 DeepSeek R1、Fox~ 或各路 API 代理中常见的成对思考、缺失起始标签的孤立思考流
    // 1. 彻底清除成对的各类思考/思维链标签块（例如 <think>...</think>, <thought>...</thought>, <think_fox~>...</think_fox~> 等）
    text = text.replace(/<([a-zA-Z0-9_\-~]*(?:think|thought|reasoning)[a-zA-Z0-9_\-~]*)[^>]*>[\s\S]*?<\/\1>\s*/gi, '');

    // 2. 彻底清除开篇无起始标签、仅有结束标签的头部思考流（如开篇直接输出思考文本，最终以 </think_fox~> 或 </think> 结束）
    let prevText = '';
    while (prevText !== text) {
        prevText = text;
        text = text.replace(/^[\s\S]*?<\/[a-zA-Z0-9_\-~]*(?:think|thought|reasoning)[a-zA-Z0-9_\-~]*>\s*/i, '');
    }

    // 3. 清理任何残留孤立的思考标签标记
    text = text.replace(/<\/?(?:[a-zA-Z0-9_\-~]*(?:think|thought|reasoning)[a-zA-Z0-9_\-~]*)[^>]*>/gi, '');

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
                const tagRegex = new RegExp(`<(${safeTag})[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
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

    // 阶段二【黑名单模式】：深度剔除不要的标签块
    const excludeInput = (typeof settings.exclude_tags === 'string') 
        ? settings.exclude_tags 
        : '<status>, <memory>';

    if (excludeInput && excludeInput.trim()) {
        const excludeTags = excludeInput
            .split(/[,，\s]+/)
            .map(t => t.trim().replace(/^<|>$/g, ''))
            .filter(Boolean);

        for (const tag of excludeTags) {
            const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // 1. 成对标签块深度剔除
            const reg = new RegExp(`<(${safeTag})[^>]*>[\\s\\S]*?<\\/\\1>\\s*`, 'gi');
            text = text.replace(reg, '');

            // 2. 如果该黑名单标签在开头缺失起始标签、仅有结束标签（如 </custom_tag>），也将开头思考/草稿剔除
            if (!new RegExp(`<${safeTag}[^>]*>`, 'i').test(text)) {
                const orphanReg = new RegExp(`^[\\s\\S]*?<\\/${safeTag}[^>]*>\\s*`, 'i');
                text = text.replace(orphanReg, '');
            }
        }
    }

    // 阶段三【网页与排版杂质清洗】
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
