# SillyTavern 聊天记录自动存档到 TXT 扩展与服务端插件

> 专为 **SillyTavern (v1.18.x 及兼容版本)** 开发的双端协作归档系统。  
> 每次 AI 回复完成后（及可选的用户发言），自动将正文格式化追加写入服务器本地的 `.txt` 文本文件。

---

## 🌟 功能特性

- **双端无缝协作**：
  - **前端 UI 扩展**：负责监听聊天事件、用户设置管理、正文标签清洗、防重签名对比。
  - **服务端插件**：Express Router 挂载，负责 100KB 大小安全校验、文件名路径清洗防御、末尾条目幂等去重并以 UTF-8 格式高速追加写入。
- **标签过滤与正文提纯**：
  - 支持一键剔除 DeepSeek R1 等现代推理模型的 `<think>...</think>` 深度思考标签。
  - 支持剥离 HTML 标签（如 `<div>`, `<span>`, `<br>`），保留排版换行。
  - 支持自定义排除标签列表（如 `details,script,style`）。
  - 支持仅提取指定标签（可选提取模式）。
- **Swipe / 重新生成双重防重**：
  - 前端缓存上一次成功保存的消息指纹，避免由于前端状态抖动重复请求。
  - 后端智能读取文件末尾片段，比对时间戳与正文内容，彻底防止同一条回复被重复写入。
- **群聊完美兼容**：
  - 自动读取消息实际发言者名称（`chat[messageId].name`），群聊模式下各角色发言清晰分明。
- **安全与稳定性**：
  - 过滤文件名中的非法字符与 `..` 路径穿越隐患。
  - 前后端全流程异常捕获与友好 Toast 告警，**绝不中断或阻塞主聊天流**。

---

## 📁 目录结构与安装映射

SillyTavern 的架构分为前端静态页面和后端 Node.js 服务。本系统由两部分组成，请分别复制到对应目录：

```text
SillyTavern 根目录/
├── config.yaml                                <-- 需要开启 enableServerPlugins
├── public/
│   └── scripts/
│       └── extensions/
│           └── third-party/
│               └── auto-save-to-txt/          <-- 对应本项目 auto-save-to-txt/
│                   ├── manifest.json
│                   ├── index.js
│                   └── style.css
└── plugins/
    └── auto-save/                             <-- 对应本项目 plugins/auto-save/
        ├── index.js
        ├── package.json
        └── logs/                              <-- 自动生成的存档文件目录
            ├── 角色名.txt
            └── all.txt
```

---

## 🚀 安装与使用步骤

### 方式 A：SillyTavern 官方 UI 一键安装（最便捷）

1. **安装前端扩展**：
   - 打开 SillyTavern 网页，点击顶部导航栏的 **扩展图标（积木/三个小方块图标 <i class="fa-solid fa-puzzle-piece"></i>）**。
   - 点击 **“Install Extension”（安装扩展）**。
   - 在输入框中粘贴本仓库地址：
     ```text
     https://github.com/zgy-beep/ST-auto-save-to-txt
     ```
   - 点击确认，SillyTavern 会自动克隆并识别本扩展。

2. **放置服务端插件**（因为官方扩展安装器仅会克隆到前端目录，需要将插件文件夹复制到根目录）：
   - 打开您的电脑文件管理器，进入刚才克隆下来的前端目录：
     `SillyTavern/public/scripts/extensions/third-party/ST-auto-save-to-txt/plugins/auto-save`
   - 将整个 `auto-save` 文件夹复制并粘贴到 SillyTavern 根目录下的 `plugins/` 目录中：
     即目标路径为：`SillyTavern/plugins/auto-save/`

3. **启用服务端插件配置**：
   - 打开 SillyTavern 根目录下的 `config.yaml`。
   - 将 `enableServerPlugins` 设为 `true`：
     ```yaml
     enableServerPlugins: true
     ```

4. **彻底重启 SillyTavern 服务**：
   - 关闭并重新启动终端里的 `node server.js`（或双击启动脚本）。
   - 刷新浏览器页面即可。

---

## 📍 扩展入口在哪里？

刷新页面后，请按如下步骤打开设置面板：
1. 点击 SillyTavern 顶部导航栏的 **扩展菜单（三块积木/方块图标）** 打开扩展侧边栏。
2. 向下滚动找到 **“自动存档到 TXT (Auto Save to TXT)”** 折叠菜单。
3. 点击展开，您会看到：
   - 🟢 **绿色指示徽章**：提示 `服务端插件已就绪 (可正常存档)`。
   - 🔴 **红色提示徽章**：若未放置服务端插件或未重启，会清晰提醒您复制目录与修改 `config.yaml`。
   - 各项开关（保存用户消息、按角色分文件、剔除 HTML、剔除 `<think>` 思考标签）及 **【立即测试保存】** 按钮。


---

## 🔍 导入路径在不同版本的差异与备选写法

前端扩展文件的头部导入了核心模块：
```javascript
import {
    eventSource,
    event_types,
    getRequestHeaders,
    extension_settings,
    saveSettingsDebounced,
    chat,
    characters,
    this_chid
} from '../../../script.js';
```

### 为什么各版本可能有差异？
1. **安装在 `public/scripts/extensions/third-party/<name>/`**：
   - 物理路径距离 `public/script.js` 跨越了 4 级目录（`../../../../script.js`）。
   - 但若 SillyTavern 打包或历史版本结构中 `script.js` 位于 `public/scripts/`，则相对路径为 3 级（`../../../script.js`）。
2. **备选写法 1（如果控制台报 404 Cannot find script.js）**：
   将 `index.js` 顶部的引用改为向上 4 层：
   ```javascript
   import {
       eventSource,
       event_types,
       getRequestHeaders,
       extension_settings,
       saveSettingsDebounced,
       chat,
       characters,
       this_chid
   } from '../../../../script.js';
   ```
3. **备选写法 2（绝对根路径导入）**：
   在大多数基于现代浏览器的 ES Module 环境下，可直接通过相对于 Web 根目录导入：
   ```javascript
   import {
       eventSource,
       event_types,
       getRequestHeaders,
       extension_settings,
       saveSettingsDebounced,
       chat,
       characters,
       this_chid
   } from '/script.js';
   ```
4. **备选写法 3（通过 SillyTavern 全局上下文获取）**：
   若不使用 import 解构，ST v1.11+ 在前端挂载了全局对象：
   ```javascript
   const context = window.SillyTavern?.getContext?.();
   const { eventSource, event_types, chat, characters } = context;
   ```

---

## 📝 归档文本格式说明

每次追加写入均采用 UTF-8 编码，标准追加格式如下：

```text
──────────────────────────────────────────────────
[2026-09-10 14:00:00] 角色名:

这是角色回复的正文内容。
换行与段落格式均被完好保留。
```

- 若开启 **按角色名分文件**（默认）：
  - 角色名将自动清理为安全文件名（如 `Seraphina.txt`）。
  - 群聊时根据实际发言者自动归入对应文件。
- 若关闭 **按角色名分文件**：
  - 所有聊天记录按发言时间流水追加至 `plugins/auto-save/logs/all.txt`。

---

## 🧪 验证方法

### 验证方法一：扩展面板一键测试
1. 进入 SillyTavern 网页，点击右上角 **扩展设置（魔棒图标或积木图标）**。
2. 展开 **“自动存档到 TXT (Auto Save to TXT)”** 设置面板。
3. 点击 **【立即测试保存（写入一条测试记录）】** 按钮。
4. 页面将弹出绿色 Toast 提示：`测试消息写入成功！请查看 plugins/auto-save/logs/ 目录。`
5. 检查本地 `plugins/auto-save/logs/TestCharacter.txt`，确认测试记录已写入。

### 验证方法二：实际对话验证
1. 选择任意角色或群聊开始对话。
2. 输入一条消息并等待 AI 回复完毕。
3. 打开 `SillyTavern/plugins/auto-save/logs/` 文件夹。
4. 打开对应的 `<角色名>.txt`，即可查看到刚刚生成的回复正文及格式化分割线。
5. 尝试对该回复点击 **Swipe（滑动切换）** 或 **重新生成**，观察日志文件：防重机制将拦截相同正文的重复写入。

---

## ❓ 常见问题排查 (Troubleshooting)

### 1. 为什么点击测试提示 404 或“无法连接服务端插件”？
- **原因**：SillyTavern 尚未启用服务端插件加载机制。
- **解决办法**：
  1. 打开 `config.yaml`，确认 `enableServerPlugins: true`。
  2. 确认文件夹名字必须完全对应：`plugins/auto-save/index.js`（注意是小写与连字符）。
  3. 必须**彻底重启**终端中的 `node server.js`。

### 2. 为什么提示 CSRF Token 校验失败 (403 Forbidden)？
- **原因**：SillyTavern 启用了安全防护机制（CSRF 保护或 API 密钥）。
- **解决办法**：
  - 本扩展在 `index.js` 中严格调用了 `getRequestHeaders()`，会自动附带当前会话的 `X-CSRF-Token` 及鉴权 Header。
  - 请确保前端没有使用被拦截的第三方代理，或者通过浏览器控制台（F12 -> Network）查看 `append` 请求的 Request Headers 是否携带正确的 Token。

### 3. 打开 txt 文件显示为乱码（尤其是中文）？
- **原因**：Windows 自带记事本（旧版 Notepad）默认尝试使用 ANSI/GBK 打开无 BOM 的 UTF-8 文件。
- **解决办法**：
  1. 本插件统一使用标准 UTF-8 编码写入（符合现代 Linux/Node 标准）。
  2. 使用 VSCode、Notepad++、Sublime Text 或 Windows 11 新版记事本打开，均会自动识别为 UTF-8。
  3. 如必须在老版记事本双击查看，请在编辑器右下角切换编码为 UTF-8。

### 4. 前端设置面板没有出现？
- 打开浏览器开发者工具（F12 -> Console 控制台）。
- 检查是否有类似 `Failed to resolve module specifier '../../../script.js'` 的红字。
- 如有，请参考上文【导入路径在不同版本的差异与备选写法】调整 `index.js` 前两行的相对路径层级。
