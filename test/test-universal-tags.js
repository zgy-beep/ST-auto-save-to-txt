const fs = require('fs');

// 通用行内排版标签（这些标签不作为思考/元数据孤立块处理）
const INLINE_TAGS = new Set(['b', 'i', 'u', 's', 'em', 'strong', 'span', 'sub', 'sup', 'small', 'del', 'mark']);

/**
 * 通用小说文本清洗与标签剥离引擎
 */
function cleanNovelTextUniversal(rawText, settings = {}) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText;

    // =========================================================================
    // 阶段零【通用前置/思考/Prefill 孤立闭标签与通用思维链自动剔除】
    // 无论是 think, cot, scratchpad, analysis, plan, 还是类似 think_fox~, my_tag~ 等任意自定义标签
    // =========================================================================

    // 1. 通用开篇孤立闭标签检测：
    // 当消息以思考、分析、Prompt 元数据开篇，但开标签被反代或预设 prefill 省略，仅以 </tag_name> 闭合时
    // 自动切除从第 0 个字符到该闭合标签的全部内容
    let prevText = '';
    while (prevText !== text) {
        prevText = text;
        // 匹配任意非行内标签的开篇孤立闭合标签：^ (前置内容) </tagName>
        // 支持特殊符号如 ~、_、-、:、. 等（例如 </think_fox~>, </system:cot>）
        const match = text.match(/^([\s\S]*?)<\/\s*([a-zA-Z0-9_\-~.:#]+)\s*>\s*/i);
        if (match) {
            const beforeClosing = match[1];
            const tagName = match[2].toLowerCase();
            // 如果不是普通行内样式标签
            if (!INLINE_TAGS.has(tagName)) {
                // 检查这部分前置内容里是否包含同名开标签 <tagName...
                const safeTag = match[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const openTagRegex = new RegExp(`<${safeTag}[^>]*>`, 'i');
                if (!openTagRegex.test(beforeClosing)) {
                    // 没有开标签，证实这是被省略了开标签的无头前置块（无论 tag 名叫什么），彻底切除！
                    text = text.slice(match[0].length);
                    continue;
                }
            }
        }
        break;
    }

    // 2. 泛化思维链/思考/草稿/规划标签成对剔除（覆盖常见所有辅助型标签）
    // 匹配 think, thought, reasoning, cot, scratchpad, reflection, inner_thought, analysis, plan 等
    const genericAuxiliaryPattern = /<\s*([a-zA-Z0-9_\-~.:#]*(?:think|thought|reasoning|cot|scratchpad|reflection|inner_thought|analysis|plan)[a-zA-Z0-9_\-~.:#]*)[^>]*>[\s\S]*?<\/\s*\1\s*>\s*/gi;
    text = text.replace(genericAuxiliaryPattern, '');

    // =========================================================================
    // 阶段一【白名单模式】：优先提取指定标签内的正文
    // =========================================================================
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

    // =========================================================================
    // 阶段二【黑名单模式】：深度剔除不要的标签块（成对标签 + 未闭合尾部标签）
    // =========================================================================
    const excludeInput = (typeof settings.exclude_tags === 'string') 
        ? settings.exclude_tags 
        : 'status,memory,details,variables,analysis,ooc,note,draft,system,state,log';

    if (excludeInput && excludeInput.trim()) {
        const excludeTags = excludeInput
            .split(/[,，\s]+/)
            .map(t => t.trim().replace(/^<|>$/g, ''))
            .filter(Boolean);

        for (const tag of excludeTags) {
            const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // 1. 成对闭合标签块完整排除（支持标签内空格，如 <status >...</status >）
            const pairReg = new RegExp(`<\\s*(${safeTag})[^>]*>[\\s\\S]*?<\\/\\s*\\1\\s*>\\s*`, 'gi');
            text = text.replace(pairReg, '');

            // 2. 开篇缺失开标签、仅有闭合标签的孤立块排除
            if (!new RegExp(`<\\s*${safeTag}[^>]*>`, 'i').test(text)) {
                const orphanCloseReg = new RegExp(`^[\\s\\S]*?<\\/\\s*${safeTag}\\s*>\\s*`, 'i');
                text = text.replace(orphanCloseReg, '');
            }

            // 3. 末尾只有开标签、但因达到 token 限制未闭合的残留块排除
            // 例如正文末尾附带了 <status> 血量: 100 但没有输出 </status>
            if (!new RegExp(`<\\/\\s*${safeTag}\\s*>`, 'i').test(text)) {
                const unclosedTailReg = new RegExp(`<\\s*${safeTag}[^>]*>[\\s\\S]*$`, 'i');
                text = text.replace(unclosedTailReg, '');
            }
        }
    }

    // =========================================================================
    // 阶段三【网页与排版杂质清洗】
    // =========================================================================
    text = text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    text = text.replace(/<br\s*[\/]?>/gi, '\n');
    text = text.replace(/<\/p>/gi, '\n\n');
    // 剥离剩余的所有 HTML/XML 格式化标签（如 <div class="...">, </span> 等）
    text = text.replace(/<\/?[a-zA-Z0-9_\-~.:#]+[^>]*>/g, '');

    text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    // =========================================================================
    // 阶段四【中文出版小说段落规范化】
    // =========================================================================
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

// 自动化测试集
const cases = [
    {
        name: '测试1: 任意自定义标签孤立闭合（如 </custom_logic~>），无需手动配置',
        input: '这是前置逻辑推导过程...\n角色心境分析...\n</custom_logic~>\n第一章 启程\n少年走在青石街道上。',
        expected: '　　第一章 启程\n\n　　少年走在青石街道上。'
    },
    {
        name: '测试2: 冒号命名的特殊标签（如 </agent:cot>）',
        input: '思考当前任务...\n</agent:cot>\n微风吹拂。',
        expected: '　　微风吹拂。'
    },
    {
        name: '测试3: 带有空格的闭合标签（如 </ think_fox~ >）',
        input: '思考中...\n</ think_fox~ >\n窗外下着小雨。',
        expected: '　　窗外下着小雨。'
    },
    {
        name: '测试4: 多层嵌套或连续无头标签（如 </scratchpad> 后跟 </plan>）',
        input: '草稿分析1...\n</scratchpad>\n剧情步骤2...\n</plan>\n他握紧了手中的剑。',
        expected: '　　他握紧了手中的剑。'
    },
    {
        name: '测试5: 黑名单标签末尾未闭合（如最后附带 <status>HP:100 但没有 </status>）',
        input: '正文内容第一段。\n正文内容第二段。\n<status>\nHP: 100\nMP: 50',
        settings: { exclude_tags: '<status>' },
        expected: '　　正文内容第一段。\n\n　　正文内容第二段。'
    },
    {
        name: '测试6: 带有属性的成对排除标签（如 <details type="memory" version="1.0">...</details>）',
        input: '<details type="memory" version="1.0">记忆碎片内容</details>\n这是真正的小说正文。',
        settings: { exclude_tags: '<details>' },
        expected: '　　这是真正的小说正文。'
    },
    {
        name: '测试7: 普通正文内含合法标签不被误伤（如 <b>加粗</b> 与 <i>斜体</i>）',
        input: '他大喊一声：<b>快走！</b>随后冲入<i>暴风雨</i>中。',
        expected: '　　他大喊一声：快走！随后冲入暴风雨中。'
    }
];

let allPassed = true;
for (const tc of cases) {
    const result = cleanNovelTextUniversal(tc.input, tc.settings || {});
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
    console.log('\n=== 通用全标签清洗引擎自动化测试全部通过！ ===');
}
