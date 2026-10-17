# SillyTavern 插件 UI Kit · 设计规范

> 版本：**v1.1.0**（语义化版本；破坏性改名/删 token 升大版本，新增组件/新增 token 升小版本）
> 来源：从 novel-stream 扩展（另一个 SillyTavern 插件）的浮动 UI（设置弹窗 / 悬浮入口 / 图片预览 / 提示层）中提炼，已在实际酒馆宿主（深/浅主题、桌面/手机）上验证。
> 定位：**独立项目 + SillyTavern 插件自有的 body 级浮动 UI**。本目录自带 `package.json` / `LICENSE` / `CHANGELOG` / `test/`，**不依赖任何外部仓库或父目录，可整目录复制/移动到任意文件夹或仓库**。不接管聊天区、原生抽屉等宿主区域（那些区域必须沿用酒馆主题变量）。

| 文件 | 作用 |
| :--- | :--- |
| [`tokens.css`](tokens.css) | 设计令牌：配色、字号、间距、圆角、阴影、动效、层级、组件尺寸；含深色默认值与 `.nvui-theme-light` 浅色覆盖 |
| [`components.css`](components.css) | 通用组件样式；全部 `nvui-` 前缀，颜色只引用 token |
| [`preview.html`](preview.html) | 离线组件预览页（双击即可打开，可切换深/浅主题；桌面与手机两种宽度都要过一眼） |
| [`test/test-ui-kit.js`](test/test-ui-kit.js) | 规范守护测试（token 完整性 / 三方覆盖 / 无硬编码颜色 / WCAG AA 对比度 / 宿主兼容红线 / 金标准取值）；`npm test` 或 `node test/test-ui-kit.js` |
| [`package.json`](package.json) | 独立项目元信息与 `npm test` 入口（零依赖，无需 `npm install`） |
| [`LICENSE`](LICENSE) | MIT 许可 |
| [`CHANGELOG.md`](CHANGELOG.md) | 变更记录（遵循语义化版本） |
| `README.md` | 本规范（配色语义、组件用法、宿主兼容红线、命名约定、迁移对照） |

目录
- [1. 它是什么 / 不是什么](#1-它是什么--不是什么)
- [2. 快速开始](#2-快速开始)
- [3. 设计原则](#3-设计原则)
- [4. 配色规范](#4-配色规范)
- [5. 文字与排版](#5-文字与排版)
- [6. 尺寸、间距、圆角、阴影、动效、层级](#6-尺寸间距圆角阴影动效层级)
- [7. 组件规范](#7-组件规范)
- [8. SillyTavern 宿主兼容红线](#8-sillytavern-宿主兼容红线)
- [9. 命名与工程约定](#9-命名与工程约定)
- [10. 从 novel-stream 迁移对照表](#10-从-novel-stream-迁移对照表)
- [11. 版本管理](#11-版本管理)
- [12. 许可](#12-许可)

---

## 1. 它是什么 / 不是什么

**是什么**

- 一套**自包含深色主题**的浮动 UI：弹窗、标签页、折叠分组、胶囊开关、按钮、输入行、提示/告警、状态行、徽标、空态、悬浮面板等。
- 一套**可复制的实现**：下一个插件把本目录整个拷过去，`@import` 两个 CSS 即可用；无需构建工具、无第三方依赖。
- 一个**独立项目**：目录内自带元信息、许可、变更记录、预览页与测试，可整体移动到任意文件夹/仓库；`cd` 进目录后 `npm test` 即可独立验证。
- 一套**有守护的规范**：`test/test-ui-kit.js` 自动检查 token 是否齐全、组件是否被预览/文档覆盖、是否泄漏裸选择器、是否硬编码颜色、对比度是否达标、核心取值是否与金标准一致。

**不是什么**

- 不是通用组件框架：没有 JS 运行时，交互（标签切换、折叠、拖拽、Esc 关闭、拖拽定位）由各插件用少量原生 JS 实现，规范只约定 DOM 结构与类名。
- 不是酒馆主题的替代品：**不要**把 `.nvui-*` 组件塞进聊天消息流里；聊天区必须使用宿主主题变量。
- 不提供图标字体：图标沿用宿主的 Font Awesome（`<i class="fa-solid fa-...">`），kit 内只有纯 CSS 的箭头/滑钮/加载环。

---

## 2. 快速开始

### 2.0 本目录是独立项目

本目录可以直接作为独立项目/仓库使用，不依赖任何外部文件：

```text
ui-kit/                  <- 可整目录移动到任意位置或仓库
  tokens.css
  components.css
  preview.html
  README.md              <- 本规范
  package.json           <- 元信息 + npm test
  LICENSE
  CHANGELOG.md
  .gitignore
  test/
    test-ui-kit.js       <- 规范守护测试（零依赖）
```

- **独立验证**：`cd ui-kit` 后运行 `npm test`（等价于 `node test/test-ui-kit.js`），无需 `npm install`；
- **独立预览**：双击 `preview.html` 即可（离线可用）；
- **移动/复用**：整个目录复制到新插件里，或作为独立仓库单独维护；
- Node.js 要求：>= 16（仅测试需要；`tokens.css` / `components.css` 在浏览器/酒馆中使用，无 Node 依赖）。

### 2.1 引入

新插件的 `style.css` 顶部（`@import` 必须在所有规则之前）：

```css
@import url('./ui-kit/tokens.css');
@import url('./ui-kit/components.css');
```

集成到插件时的目录结构建议：

```text
your-plugin/
  manifest.json
  style.css          <- @import ./ui-kit/...
  index.js
  ui-kit/            <- 本目录（可整目录拷入）
    tokens.css
    components.css
    preview.html
    README.md
    package.json
    LICENSE
    CHANGELOG.md
    test/
```

### 2.2 作用域

给浮层根节点加 `nvui-scope`；需要浅色主题时叠加 `nvui-theme-light`：

```html
<div class="nvui-scope"> ... 深色（默认） ... </div>
<div class="nvui-scope nvui-theme-light"> ... 浅色覆盖 ... </div>
```

### 2.3 弹窗骨架（含 top-layer 载体）

```html
<dialog class="nvui-tl" id="your_modal_layer">
    <div class="nvui-overlay" id="your_overlay" hidden>
        <div class="nvui-modal" role="dialog" aria-modal="true" aria-labelledby="your_modal_title">
            <div class="nvui-modal-header">
                <b class="nvui-modal-title" id="your_modal_title">
                    标题<span class="nvui-modal-ver">v1.0.0</span>
                </b>
                <span class="nvui-modal-actions">
                    <button type="button" class="nvui-icon-btn" data-close aria-label="关闭">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </span>
            </div>
            <div class="nvui-modal-body"> ... </div>
            <div class="nvui-modal-footer">
                <button type="button" class="nvui-btn is-ghost" data-close>取消</button>
                <button type="button" class="nvui-btn is-primary">确定</button>
            </div>
        </div>
    </div>
</dialog>
```

```js
// 非模态 show()：不产生 inert，悬浮入口/其它弹窗仍可点击
const layer = document.getElementById('your_modal_layer');
const overlay = document.getElementById('your_overlay');
function openModal() {
    try { layer.show(); } catch (e) { layer.setAttribute('open', ''); } // 旧内核兜底
    overlay.hidden = false;
}
function closeModal() {
    overlay.hidden = true;
    try { layer.close(); } catch (e) { layer.removeAttribute('open'); }
}
overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) closeModal(); });
```

> 为什么必须用 `<dialog>` 载体：见 [第 8 节](#8-sillytavern-宿主兼容红线) 第 1 条。

---

## 3. 设计原则

1. **浮层自包含、主题可切换**：自有浮层用 kit 的深色令牌（或浅色覆盖），不依赖宿主主题变量；这样浅色/深色酒馆下观感一致、可预期。
2. **组件样式里出现 `#hex` / `rgb()` 视为缺陷（禁止硬编码颜色）**：颜色一律走 token；换色只改 token，不改组件。
3. **唯一强调色 + 语义色各司其职**：紫罗兰是"可交互/当前选中"的唯一强调色；成功/注意/错误/进行中只用语义色，不用主色表达状态。
4. **层级靠表面与阴影，不靠描边堆盒子**：`bg` → `block-bg` → `block-bg-2` 三层表面；需要强调边界才用 `line-2`。
5. **可点区域要大方**：开关整行 label 可点；按钮最小高度 `--nvui-control-h`；图标按钮 28×28；触屏留足间距。
6. **收起态必须给摘要**：折叠分组右侧 `nvui-acc-summary` 是用户唯一线索，必须显示当前值。
7. **可访问性内建**：对比度达标、`focus-visible` 焦点环、`aria-*` 语义、尊重 `prefers-reduced-motion`、读屏隐藏文本用 `.nvui-sr-only`。
8. **不污染宿主**：全部 `nvui-` 前缀、无裸元素选择器、无全局重置；`!important` 只用于对抗酒馆全局 checkbox 样式。

---

## 4. 配色规范

### 4.1 深色主题令牌（默认，`:root` / `.nvui-scope`）

**表面 / 背景**

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-bg` | `#161a24` | 弹窗 / 浮层本体表面 |
| `--nvui-bg-2` | `#1c2130` | 次级面板、工具提示、悬浮面板 |
| `--nvui-bg-3` | `#232939` | 再深一档的分组底（少用） |
| `--nvui-block-bg` | `rgba(255,255,255,0.05)` | 可点区块底（折叠分组、次级按钮） |
| `--nvui-block-bg-2` | `rgba(255,255,255,0.078)` | 区块悬停 / 展开态 |
| `--nvui-input-bg` | `rgba(0,0,0,0.22)` | 输入框底 |
| `--nvui-code-bg` | `rgba(0,0,0,0.3)` | 行内代码底 |
| `--nvui-overlay-bg` | `rgba(6,8,14,0.72)` | 弹窗遮罩 |
| `--nvui-switch-off-bg` | `rgba(255,255,255,0.12)` | 开关关闭态轨道 |
| `--nvui-knob` | `#ffffff` | 开关开启态滑钮 |
| `--nvui-knob-off` | `var(--nvui-text-2)` | 开关关闭态滑钮 |

**分隔线**

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-line` | `rgba(255,255,255,0.07)` | 常规分隔 / 头部底边 |
| `--nvui-line-2` | `rgba(255,255,255,0.12)` | 强调边界 / 弹窗外框 |
| `--nvui-dash` | `rgba(255,255,255,0.17)` | 虚线空态 / 检查中 |
| `--nvui-block-line` | `rgba(255,255,255,0.06)` | 区块内发丝线 |
| `--nvui-block-line-2` | `rgba(255,255,255,0.1)` | 控件描边（按钮/输入框/开关轨道） |

**文字**

| Token | 值 | 对比度（on `--nvui-bg`） | 用途 |
| :--- | :--- | :--- | :--- |
| `--nvui-text` | `#e9ecf3` | 14.71:1 | 正文、标题 |
| `--nvui-text-2` | `#98a1b3` | 6.70:1 | 次要说明、开关行标题、状态行 |
| `--nvui-text-3` | `#7d879b` | 4.81:1 | 提示性小字、摘要、占位符（仅非关键信息） |

> `--nvui-text-3` 相对 novel-stream v1.17.x 的实现值 `#6c7487`（3.72:1）提亮一档以满足 WCAG AA；旧插件若要完全还原可覆盖该 token，但**规范推荐用新值**。

**主色（唯一强调色）**

| Token | 值 | 对比度 | 用途 |
| :--- | :--- | :--- | :--- |
| `--nvui-accent` | `#8b6dff` | 4.75:1（on bg） | 开关轨道、选中描边、焦点环 |
| `--nvui-accent-2` | `#a997ff` | 7.09:1（on bg） | 图标、强调文字 |
| `--nvui-accent-strong` | `#6d4df2` | 白字 5.26:1 | **填充按钮底**（满足 AA） |
| `--nvui-accent-strong-hover` | `#5b3fd6` | 白字 6.72:1 | 填充按钮悬停 |
| `--nvui-accent-bg` | `rgba(139,109,255,0.14)` | - | 主色淡底（选中的标签页、次级按钮） |
| `--nvui-accent-bg-hover` | `rgba(139,109,255,0.24)` | - | 主色淡底悬停 |
| `--nvui-accent-line` | `rgba(139,109,255,0.4)` | - | 主色描边 |

> 注意：旧实现主按钮用 `--nvui-accent` + 白字（3.67:1）不达 AA；规范改为 `--nvui-accent-strong`。视觉仍是同一紫罗兰色系。

**语义色（每个都配 bg/line 派生，组件不得自行调透明度）**

| Token | 值 | 对比度（on bg） | 语义 |
| :--- | :--- | :--- | :--- |
| `--nvui-ok` | `#4ade80` | 9.98:1 | 成功 / 已就绪 |
| `--nvui-ok-bg` | `rgba(74,222,128,0.12)` | - | 成功淡底 |
| `--nvui-ok-line` | `rgba(74,222,128,0.35)` | - | 成功描边 |
| `--nvui-warn` | `#fbbf24` | 10.42:1 | 需要注意 / 超限提示 |
| `--nvui-warn-bg` | `rgba(251,191,36,0.12)` | - | 注意淡底 |
| `--nvui-warn-line` | `rgba(251,191,36,0.35)` | - | 注意描边 |
| `--nvui-danger` | `#f87171` | 6.29:1 | 错误 / 危险操作 |
| `--nvui-danger-bg` | `rgba(248,113,113,0.12)` | - | 错误淡底 |
| `--nvui-danger-line` | `rgba(248,113,113,0.35)` | - | 错误描边 |
| `--nvui-info` | `#3498db` | 5.52:1 | 进行中 / 信息 |
| `--nvui-info-bg` | `rgba(52,152,219,0.12)` | - | 信息淡底 |
| `--nvui-info-line` | `rgba(52,152,219,0.35)` | - | 信息描边 |

### 4.2 浅色主题（`.nvui-theme-light` 覆盖）

在容器上叠加 `.nvui-theme-light` 即可整体切换。所有组件只消费 token，因此**不需要为浅色写第二套组件样式**。

| Token | 浅色值 | 对比度（on `#f7f8fc`） |
| :--- | :--- | :--- |
| `--nvui-text` | `#1f2430` | 14.62:1 |
| `--nvui-text-2` | `#4a5365` | 7.28:1 |
| `--nvui-text-3` | `#5f6879` | 5.29:1 |
| `--nvui-accent` | `#6d4df2` | 4.95:1 |
| `--nvui-accent-2` | `#5b3fd6` | 6.33:1 |
| `--nvui-accent-strong` | `#6d4df2` | 白字 5.26:1 |
| `--nvui-ok` | `#15803d` | 4.73:1 |
| `--nvui-warn` | `#b45309` | 4.73:1 |
| `--nvui-danger` | `#dc2626` | 4.55:1 |
| `--nvui-info` | `#1d4ed8` | 6.31:1 |

（表面、分隔线、语义淡底/描边、阴影也在 `tokens.css` 的 `.nvui-theme-light` 块中整体覆盖，此处不重复列出。）

### 4.3 配色使用规则

- **Do**：正文/标题用 `--nvui-text`；解释性文字用 `--nvui-text-2`；提示小字用 `--nvui-text-3`（不要用它承载关键信息）。
- **Do**：未选中控件用 `text-2` / `block-line-2`，选中/激活统一用主色系（accent / accent-bg / accent-line）；主色即"可交互、当前"。
- **Do**：语义色只做语义：ok=成功、warn=注意/超限、danger=错误/破坏性操作、info=进行中。语义色的淡底/描边用配套 `-bg` / `-line` token，不要自己写透明度。
- **Don't**：用主色表示错误或警告（用户会误以为可点）；用 danger 做装饰。
- **Don't**：在一个视图里同时出现两种强调色；需要更多区分时用表面层级 / 字号 / 图标，而不是加色。
- **Don't**：在组件样式里硬编码颜色；也不要直接引用酒馆的 `--SmartTheme*` 变量（kit 浮层要跨主题一致）。

---

## 5. 文字与排版

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-fs-2xs` | `10px` | 计数角标（chip count） |
| `--nvui-fs-xs` | `11px` | 版本号、状态时间、次要元信息 |
| `--nvui-fs-sm` | `12px` | 说明、提示、状态行、默认按钮 |
| `--nvui-fs-md` | `13px` | 设置面板默认正文、折叠标题、标签页 |
| `--nvui-fs-lg` | `14px` | 弹窗正文（桌面） |
| `--nvui-fs-xl` | `15px` | 弹窗正文（窄屏） |
| `--nvui-fs-2xl` | `16px` | 大标题（弹窗标题变体、结果页） |
| `--nvui-fw-regular` | `400` | 摘要、普通说明 |
| `--nvui-fw-medium` | `500` | 按钮 |
| `--nvui-fw-semibold` | `600` | 折叠标题、选中标签页 |
| `--nvui-fw-bold` | `700` | 区块标题、弹窗标题 |
| `--nvui-lh-tight` | `1.4` | 按钮、标签、输入框 |
| `--nvui-lh-normal` | `1.5` | 正文、状态行 |
| `--nvui-lh-relaxed` | `1.6` | 说明小字、告警 |
| `--nvui-lh-loose` | `1.8` | 弹窗正文（长文阅读） |

规则：

- 字体一律 `font-family: inherit`，沿用酒馆主题字体，kit 不自带字体。
- 中文正文不做字间距（`letter-spacing`），仅区块标题可用 `0.5px` 拉开层级。
- 一屏内字号层级不超过 3 档；数字（计数、上限）右对齐。
- 长文本用 `word-break: break-word`；文件名/路径用 `.nvui-code` 或等宽栈。

---

## 6. 尺寸、间距、圆角、阴影、动效、层级

### 6.1 间距（4px 基准）

| Token | 值 | Token | 值 |
| :--- | :--- | :--- | :--- |
| `--nvui-space-05` | `2px` | `--nvui-space-25` | `10px` |
| `--nvui-space-1` | `4px` | `--nvui-space-3` | `12px` |
| `--nvui-space-15` | `6px` | `--nvui-space-4` | `16px` |
| `--nvui-space-2` | `8px` | `--nvui-space-5` | `20px` |
| | | `--nvui-space-6` | `24px` |

### 6.2 圆角

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-radius-xs` | `6px` | 行内代码、小提示 |
| `--nvui-radius-sm` | `8px` | 输入框、按钮 |
| `--nvui-radius` | `12px` | 折叠分组、空态 |
| `--nvui-radius-lg` | `16px` | 弹窗 |
| `--nvui-radius-pill` | `999px` | 胶囊：开关、徽标、标签页、悬浮药丸 |

### 6.3 阴影（层级越高越深）

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-shadow-modal` | `0 24px 64px rgba(0,0,0,0.55)` | 弹窗 |
| `--nvui-shadow-pop` | `0 8px 24px rgba(0,0,0,0.45)` | 悬浮面板、工具提示 |
| `--nvui-shadow-accent` | `0 6px 18px rgba(139,109,255,0.32)` | 主按钮悬停光晕 |

### 6.4 动效

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-transition` | `0.16s ease` | 颜色/背景/边框过渡（默认） |
| `--nvui-transition-slow` | `0.25s ease` | 折叠分组背景、箭头旋转 |
| `--nvui-spin-duration` | `0.8s` | 加载环旋转周期 |

规则：只过渡颜色/背景/边框/位移，不做尺寸动画（避免抖动）；必须尊重 `prefers-reduced-motion`（kit 已内置）。

### 6.5 组件尺寸

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-control-h` | `32px` | 按钮 / 输入框统一最小高度 |
| `--nvui-switch-w` | `36px` | 胶囊开关轨道宽 |
| `--nvui-switch-h` | `21px` | 胶囊开关轨道高 |
| `--nvui-switch-knob` | `15px` | 滑钮直径 |
| `--nvui-switch-knob-offset` | `2px` | 滑钮距轨道内边 |
| `--nvui-switch-knob-on` | `15px` | 勾选态滑钮右移距离 |
| `--nvui-modal-width` | `680px` | 弹窗最大宽度 |
| `--nvui-modal-max-h` | `80vh` | 弹窗最大高度（窄屏为 92dvh） |

### 6.6 层级

| Token | 值 | 用途 |
| :--- | :--- | :--- |
| `--nvui-z-floating` | `1000010` | 悬浮入口/悬浮面板 |
| `--nvui-z-overlay` | `1000020` | 弹窗遮罩 |
| `--nvui-z-tooltip` | `1000030` | 工具提示（最上层） |

> top-layer 载体内的实际层级由浏览器 top layer 决定；这些 z-index 是给"未走 dialog 载体"或旧内核的兜底。

---

## 7. 组件规范

> 每个组件都可在 [`preview.html`](preview.html) 中看到实际效果（含深/浅主题）。以下只列结构与规则，样式细节以 `components.css` 为准。

### 7.1 作用域与工具类

- `.nvui-scope`：浮层根节点必加。设置 `box-sizing`、`color`、基础字号/行高；其所有后代统一 `border-box`。
- `.nvui-sr-only`：读屏专用隐藏文本（不要用 `display:none`）。
- 布局工具：`.nvui-stack`（竖向堆叠，gap=space-3；`.is-loose` 加大）、`.nvui-row`（横向排列；`.is-between` 两端对齐）、`.nvui-grow`（占满剩余宽度）、`.nvui-divider`（发丝分割线）。
- 文字色工具类：`.nvui-muted`、`.nvui-muted-2`、`.nvui-accent-text`、`.nvui-ok-text`、`.nvui-warn-text`、`.nvui-danger-text`、`.nvui-info-text`；行内代码 `.nvui-code`。

### 7.2 遮罩与弹窗

结构：`.nvui-overlay > .nvui-modal > (.nvui-modal-header + .nvui-modal-body + .nvui-modal-footer)`

| 类名 | 说明 |
| :--- | :--- |
| `.nvui-overlay` | 全屏遮罩（flex 居中、padding=space-4）；`hidden` 属性即可隐藏 |
| `.nvui-modal` | 弹窗本体：`--nvui-bg` 表面、大圆角、深阴影、max-height 限制 |
| `.nvui-modal-header` | 头部：标题 + 右侧操作区，底部发丝线，不可被压缩 |
| `.nvui-modal-title` | 标题（内联 flex）；`.is-lg` 为大标题变体；内嵌图标用主色 2 |
| `.nvui-modal-ver` | 版本号胶囊（`fs-xs`、淡底） |
| `.nvui-modal-actions` | 头部右侧操作区（图标按钮组） |
| `.nvui-modal-body` | 正文区：可滚动、`overscroll-behavior: contain`、长文行高 1.8 |
| `.nvui-modal-footer` | 底部操作区：右对齐按钮组，顶部发丝线 |
| `.nvui-icon-btn` | 28×28 方形图标按钮（关闭、更多）；带 focus-visible 焦点环 |

无障碍：`role="dialog"` + `aria-modal="true"` + `aria-labelledby` 指向标题；关闭按钮必须有 `aria-label`；Esc 与点遮罩关闭由业务 JS 实现。

### 7.3 按钮

| 类名 | 说明 |
| :--- | :--- |
| `.nvui-btn` | 默认中性按钮：半透明底 + 发丝线，悬停加深 |
| `.nvui-btn.is-primary` | 主操作（紫罗兰实心 + 白字） |
| `.nvui-btn.is-secondary` | 次级操作（主色淡底 + 主色描边） |
| `.nvui-btn.is-ghost` | 弱操作（透明 + 细描边） |
| `.nvui-btn.is-danger` | 破坏性操作（语义红淡底） |
| `.nvui-btn.is-sm` | 小尺寸 |
| `.nvui-btn.is-block` | 通栏 |
| `.nvui-btn-row` | 按钮组：等宽（`flex:1 1 140px`）并自动换行；窄屏单列 |
| `.nvui-btn:disabled` | 禁用态：降透明度 + not-allowed |

规则：同一区块主按钮最多 1 个；破坏性操作必须用 `is-danger` 且二次确认；按钮文字 2~6 个汉字，图标在前、文字在后。

### 7.4 胶囊开关行

```html
<label class="nvui-switch-row">
    <input type="checkbox" checked>
    <span>导出时嵌入图片</span>
</label>
```

| 部分 | 规则 |
| :--- | :--- |
| `.nvui-switch-row` | 整行 label 可点；`row-reverse` 实现左标题右开关；底部发丝线（`:last-child` 去掉） |
| `input[type="checkbox"]` | 36×21 胶囊；`appearance:none`；清掉宿主 `::before` 对勾；`::after` 为 15px 滑钮 |
| `:checked` | 轨道变 `--nvui-accent`，滑钮右移 `--nvui-switch-knob-on` 并变白 |
| `:focus-visible` | 2px 主色焦点环；`:disabled` 降透明度 |

无障碍：label 包裹 input，点击文字即可切换；业务侧用 `change` 事件同步设置并刷新摘要/说明。

### 7.5 输入行

```html
<label class="nvui-input-row">
    <input class="nvui-input is-number" type="number" value="5">
    <span>单图上限 (MB)</span>
</label>
```

| 类名 | 说明 |
| :--- | :--- |
| `.nvui-input-row` | 左标题 + 右控件（`row-reverse`），底部发丝线 |
| `.nvui-input` | 输入框：`--nvui-input-bg` 底、发丝描边、`--nvui-control-h` 高 |
| `.nvui-input.is-number` | 数值框：定宽 96px、右对齐 |
| `.nvui-input.is-path` | 路径框：200px、最大 60% 行宽 |

规则：所有可编辑控件必须有可见 label（`label` 包裹即可）；失焦/回车触发保存；数值用 `min/max/step` 限制。

### 7.6 标签页

```html
<nav class="nvui-tabs" role="tablist" aria-label="设置分区">
    <button type="button" class="nvui-tab is-active" role="tab"
            id="tab_a" aria-selected="true" aria-controls="pane_a">连载</button>
    <button type="button" class="nvui-tab" role="tab"
            id="tab_b" aria-selected="false" aria-controls="pane_b">过滤</button>
</nav>
<div class="nvui-tabpane is-active" id="pane_a" role="tabpanel" aria-labelledby="tab_a">...</div>
<div class="nvui-tabpane" id="pane_b" role="tabpanel" aria-labelledby="tab_b">...</div>
```

规则：**只切 `display`，绝不重建面板 DOM**（否则丢输入焦点与异步结果）；每次切换把滚动位置复位；只有当前标签可 Tab 聚焦（`tabIndex=0/-1`），左右方向键切换由 JS 实现。

### 7.7 折叠面板

```html
<div class="nvui-acc is-open">
    <button type="button" class="nvui-acc-head" aria-expanded="true">
        <span class="nvui-acc-title"><i class="fa-solid fa-folder"></i>保存位置</span>
        <span class="nvui-acc-summary">默认目录 plugins/auto-save/logs</span>
        <i class="nvui-acc-chev"></i>
    </button>
    <div class="nvui-acc-body"> ... 展开内容 ... </div>
</div>
```

| 类名 | 说明 |
| :--- | :--- |
| `.nvui-acc` | 分组容器：`block-bg` 底 + 发丝描边 + 12px 圆角；`.is-open` 表示展开 |
| `.nvui-acc-head` | 整行标题按钮；维护 `aria-expanded`；hover 加深 |
| `.nvui-acc-title` | 左侧标题（可带图标） |
| `.nvui-acc-summary` | 右侧当前值摘要：单行省略；**收起态唯一线索，必须维护** |
| `.nvui-acc-chev` | 纯 CSS 箭头，展开时旋转 225° |
| `.nvui-acc-body` | 展开体：默认 `display:none`，`.is-open` 时显示 |

规则：开合只切 class、不重建 DOM；开合偏好可持久化；默认建议全部收起。

### 7.8 区块标题 / 提示 / 告警 / 状态行

| 类名 | 说明 |
| :--- | :--- |
| `.nvui-section-title` | 区块标题（图标 + 13px 粗体 + 0.5px 字距） |
| `.nvui-hint` | 说明小字（12px，`text-3`）；`.is-warn` 变注意色 |
| `.nvui-alert` | 告警条：左侧 2px 竖线 + 淡底；语义变体 `.is-checking` / `.is-success` / `.is-warning` / `.is-error` / `.is-info` |
| `.nvui-status-line` | 状态行：`is-updating` / `is-success` / `is-skipped` / `is-error` 颜色即状态 |
| `.nvui-status-time` | 右侧时间戳（`ml:auto`、降透明度） |
| `.nvui-status-file` | 状态行内的文件路径（独占一行） |

规则：告警不要铺满深底色（用竖线 + 淡底即可，保持"扁平"）；状态行时间戳贴右，路径另起一行；同一屏告警不超过 2 条。

### 7.9 徽标 / 标签块 / 空态 / 加载

| 类名 | 说明 |
| :--- | :--- |
| `.nvui-badge` | 胶囊徽标；变体 `.is-accent` / `.is-success` / `.is-warn` / `.is-danger` / `.is-info` |
| `.nvui-chip` | 内容标签块（方角小圆角） |
| `.nvui-chip-count` | 标签后的计数角标（10px 降透明度） |
| `.nvui-empty` | 空态：虚线框 + 居中提示 |
| `.nvui-spinner` | 纯 CSS 加载环（也可用 Font Awesome `fa-spin`） |

### 7.10 悬浮面板 / 工具提示

| 类名 | 说明 |
| :--- | :--- |
| `.nvui-floating` | 悬浮面板外观（胶囊默认形态；`.is-panel` 为竖向面板） |
| `.nvui-floating-handle` | 拖拽把手（`cursor: grab`、`touch-action: none`） |
| `.nvui-floating.is-dragging` | 拖拽中（`cursor: grabbing`、禁选中） |
| `.nvui-tooltip` | 轻量工具提示（固定定位、最大 340px，由 JS 定位；`pointer-events: none`） |

规则：**没有 JS 运行时的定位逻辑**——拖拽/位置记忆/点击判定由各插件实现（建议 pointer 事件 + 阈值区分点击与拖动；悬浮入口必须可键盘操作）。

### 7.11 无障碍速查

- 弹窗：`role="dialog"`、`aria-modal="true"`、`aria-labelledby`；关闭按钮 `aria-label`。
- 标签页：`role="tablist"/"tab"/"tabpanel"` + `aria-selected` + `aria-controls`。
- 折叠：`aria-expanded` 随开合更新；标题就是 `<button>`。
- 开关：`label` 包裹 `input`；说明文字用 `<span>` 而不是 `title`（移动端 title 不可见）。
- 所有交互元素都要有 `:focus-visible` 焦点环（kit 已内建）。
- 只用颜色表达状态的地方，必须同时有文字或图标（例如状态行已有文案）。

---

## 8. SillyTavern 宿主兼容红线

以下每条都来自 novel-stream 在真实酒馆（桌面 / 手机 / Docker / 浅色主题）上踩过的坑，**下个插件请直接照做**：

1. **body 级浮层必须进 `<dialog class="nvui-tl">` top-layer 载体，并用非模态 `show()`。**
   - 酒馆 `html` 上有 `transform`，`position:fixed` 的包含块会变成文档盒子，手机端浮层被顶出屏幕；
   - `showModal()` 会给文档加 `inert`，悬浮入口/其它弹窗全部点不到；
   - 载体 `pointer-events:none`，子浮层（`.nvui-overlay` / `.nvui-floating`）恢复 `auto`；
   - 未 `show()` 的 dialog 是 `display:none`，关闭时用 `close()` 或切 `hidden`。
2. **所有 checkbox 必须隔离宿主样式。** 酒馆给每个 `input[type=checkbox]` 挂了 `appearance:none; display:grid` + `::before` 对勾（clip-path + inset box-shadow）。自定义开关必须 `appearance:none` + 显式宽高 + 压掉 `::before`（`content:none !important; display:none !important`），否则会出现"蓝色尖角/勾选态不可见"。kit 的 `.nvui-switch-row` 已内置。
3. **不要用裸元素选择器写样式。** 一律 `.nvui-*` / `dialog.nvui-tl` 前缀；ID 级作用域仅用于对抗宿主既有全局样式（例如 `#your_panel input[type=checkbox]`）。
4. **颜色只用 token。** 浮层自带深色主题（或 `.nvui-theme-light`），不要引用酒馆 `--SmartTheme*` 变量——否则浅色主题下观感不可控；聊天区内联组件除外。
5. **移动端三件事**：`100dvh`/`safe-area-inset-bottom`；弹窗正文 `-webkit-overflow-scrolling: touch`；打开弹窗时若键盘弹起，位置/滚动要复算（监听 `visualViewport`）。
6. **不要用 emoji 当图标。** 用 Font Awesome（`<i class="fa-solid fa-...">`）或纯 CSS 图形；仓库历史上统一清理过 emoji。
7. **动效可降级。** 必须尊重 `prefers-reduced-motion`（kit 已内置全局降级）。
8. **一次只提升一个 top-layer 载体。** 多个 dialog 载体可共存，但同一时刻只显示必要的；浮层之间用 `hidden` 切换而不是重复创建 DOM。

---

## 9. 命名与工程约定

- **前缀**：全部组件 `nvui-`；HTML 类名 kebab-case；状态类统一 `is-` 前缀（`is-active` / `is-open` / `is-primary` / `is-warn` ...）。
- **Token 命名**：`--nvui-<类别>-<档位>`；类别固定为 `bg` / `line` / `text` / `accent` / `ok|warn|danger|info` / `radius` / `space` / `fs` / `fw` / `lh` / `shadow` / `transition` / `z` 等；**新增 token 必须同步更新本 README 的 token 表与 `test/test-ui-kit.js` 的必填清单**。
- **颜色**：`components.css` 内禁止 `#hex` / `rgb()` / `hsl()` 字面量；只能用 `var(--nvui-*)`（`transparent` / `inherit` / `currentColor` 除外）。测试会扫描。
- **`!important`**：只允许两类：① 对抗宿主 checkbox `::before` 的隔离规则；② `prefers-reduced-motion` 降级块。其它地方不得使用。
- **选择器**：不得出现裸元素选择器（如 `input { ... }`、`button { ... }`）与全局重置；所有规则必须在 `.nvui-` / `dialog.nvui-tl` 作用域下。
- **图标**：Font Awesome `<i>`；纯 CSS 图形只用于箭头/滑钮/加载环。
- **无 emoji**：README、CSS、HTML、JS 文案中不使用 emoji。
- **文件结构**：本目录是自包含独立项目（`package.json` / `LICENSE` / `CHANGELOG.md` / `test/` 齐全），可直接整目录复制或移动；`preview.html` 必须保持离线可打开（无 CDN、无网络请求）。
- **版本**：kit 版本同时写在 `package.json`、`tokens.css` / `components.css` 文件头、本 README 标题、`CHANGELOG.md` 最新条目与 `preview.html`；对外暴露的插件版本由各插件自己的 manifest 独立管理（不要求与 kit 版本一致）。
- **测试**：新增/修改组件后，在本目录运行 `npm test`（或 `node test/test-ui-kit.js`）；该测试同时守护「token 完整」「组件被预览与文档覆盖」「无硬编码颜色」「WCAG 对比度」「核心 token 金标准取值」「独立项目结构与版本自洽」。

---

## 10. 从 novel-stream 迁移对照表

> novel-stream 当前 `style.css` 是 kit 的"参考实现"（历史演进，含个别未收敛的取值）。新插件直接用 kit；旧插件按需逐步迁移，不要一次性重写。

### 10.1 Token 映射

| novel-stream 旧 token | UI Kit token | 说明 |
| :--- | :--- | :--- |
| `--nv-bg` | `--nvui-bg` | 同名同值 |
| `--nv-bg-2` / `--nv-bg-3` | `--nvui-bg-2` / `--nvui-bg-3` | 同名同值 |
| `--nv-line` / `--nv-line-2` / `--nv-dash` | `--nvui-line` / `--nvui-line-2` / `--nvui-dash` | 同名同值 |
| `--nv-block-bg` / `--nv-block-bg-2` | `--nvui-block-bg` / `--nvui-block-bg-2` | 同名同值 |
| `--nv-block-line` / `--nv-block-line-2` | `--nvui-block-line` / `--nvui-block-line-2` | 同名同值 |
| `--nv-text` / `--nv-text-2` | `--nvui-text` / `--nvui-text-2` | 同名同值 |
| `--nv-text-3` | `--nvui-text-3` | **值提亮一档**（AA 对比度） |
| `--nv-accent` / `--nv-accent-2` | `--nvui-accent` / `--nvui-accent-2` | 同名同值 |
| `--nv-accent-bg` / `--nv-accent-line` | `--nvui-accent-bg` / `--nvui-accent-line` | 同名同值 |
| `--nv-ok` / `--nv-warn` / `--nv-danger` | `--nvui-ok` / `--nvui-warn` / `--nvui-danger` | 同名同值；新增配套 `-bg` / `-line` |
| `--nv-radius` | `--nvui-radius` | 同名同值；kit 扩展 xs/sm/lg/pill |
| （无） | `--nvui-accent-strong` / `--nvui-accent-strong-hover` | 新增：填充按钮底（白字 AA） |
| （无） | `--nvui-info` / `--nvui-info-bg` / `--nvui-info-line` | 新增：进行中/信息（旧实现借用了宿主主题色） |
| （无） | 字号/间距/阴影/动效/尺寸/z-index 令牌 | 新增：把散落的具体数值收敛成 token |

### 10.2 组件类名映射

| novel-stream 旧类名 | UI Kit 类名 | 说明 |
| :--- | :--- | :--- |
| `.novel-modal-overlay` | `.nvui-overlay` | 遮罩 |
| `.novel-modal` / `.novel-modal-header` / `.novel-modal-title` / `.novel-modal-body` | `.nvui-modal` / `.nvui-modal-header` / `.nvui-modal-title` / `.nvui-modal-body` | 弹窗骨架；kit 新增 `.nvui-modal-ver` / `.nvui-modal-actions` / `.nvui-modal-footer` |
| `.novel-icon-btn` | `.nvui-icon-btn` | 图标按钮 |
| `.novel-btn` + `.btn-export` / `.btn-sync` / `.btn-test` / `.btn-download` | `.nvui-btn` + `.is-primary` / `.is-secondary` / `.is-ghost` | 按语义选变体，不再按业务命名 |
| `.novel-btn-row` | `.nvui-btn-row` | 按钮组 |
| `.checkbox_label`（借用宿主类）+ `.novel-switch-row` | `.nvui-switch-row` | kit 自己实现胶囊开关与宿主样式隔离 |
| `.novel-row` | `.nvui-input-row` + `.nvui-input` | 输入行 |
| `.novel-tabs` / `.novel-tab` / `.novel-tabpane` | `.nvui-tabs` / `.nvui-tab` / `.nvui-tabpane` | 标签页 |
| `.novel-acc` / `.novel-acc-head` / `.novel-acc-title` / `.novel-acc-summary` / `.novel-acc-chev` / `.novel-acc-body` | `.nvui-acc` / `.nvui-acc-head` / `.nvui-acc-title` / `.nvui-acc-summary` / `.nvui-acc-chev` / `.nvui-acc-body` | 折叠面板 |
| `.novel-section-title` | `.nvui-section-title` | 区块标题 |
| `.novel-mv-hint` | `.nvui-hint` | 说明小字 |
| `.novel-alert` | `.nvui-alert` | 告警条 |
| `.novel-status-line` / `.novel-status-time` / `.novel-status-file` | `.nvui-status-line` / `.nvui-status-time` / `.nvui-status-file` | 状态行 |
| `.novel-mv-badge` / `.novel-chip-count` | `.nvui-badge` / `.nvui-chip-count` | 徽标与计数 |
| `.novel-tag-chip` | `.nvui-chip` | 标签块 |
| `.novel-floating-window` | `.nvui-floating` | 悬浮面板（拖拽逻辑各插件自实现） |
| `.novel-chip-tooltip` | `.nvui-tooltip` | 工具提示 |
| `.novel-modal-overlay` 外层 `<dialog class="novel-tl">` | `<dialog class="nvui-tl">` | top-layer 载体 |

---

## 11. 版本管理

- 当前 **v1.1.0**（2026-10-17）：独立项目化（自带 `package.json` / `LICENSE` / `CHANGELOG.md` / `test/`，可整目录移动）；含深/浅双主题、13 个组件族、宿主兼容红线与自动守护测试。
- 变更记录（倒序）：
  - **v1.1.0**：独立项目化封装；README 去除对来源仓库的相对链接；守护测试改为项目内自洽（内置核心 token 金标准 + 多处版本一致性），不再读取外部仓库文件。
  - **v1.0.0**：首个版本。token 体系、组件样式、预览页、规范文档、`test/test-ui-kit.js`。
- 兼容性约定：
  - 修 bug / 调整单个 token 值：补丁版本（1.1.x）；
  - 新增组件 / 新增 token：小版本（1.x.0）；
  - 重命名类/token、删除 token、修改 DOM 契约：大版本（x.0.0），并同步更新本文件的迁移对照表与 `test/test-ui-kit.js` 的金标准/必填清单。
- 升级步骤：用新版本目录覆盖 `tokens.css` / `components.css` → 打开 `preview.html` 确认视觉无回归 → 在本目录运行 `npm test` →（若集成在插件中）再跑该插件的测试。

> 备注：`ui-kit/` 作为独立项目时，版本号只看本目录内的 `package.json` / `CHANGELOG.md`；它不代表任何宿主插件的版本。

---

## 12. 许可

MIT，见同目录 [LICENSE](LICENSE)。本目录是独立项目，可整体移动/复制到任意位置；复制到其它插件时请保留本目录与版本号，便于后续同步上游修复。
