# ==============================================================================
# SillyTavern 小说连载阅读 (ST-auto-save-to-txt) Windows 服务端插件安装脚本
# ==============================================================================

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 📖 小说连载阅读 (Novel Stream) 服务端插件安装程序 (Windows)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$success = $false

# 1. 尝试寻找正在运行的酒馆 Node 进程目录
$nodeProc = Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine -like "*server.js*" } catch { $false }
} | Select-Object -First 1

$targetPlugins = ""
if ($nodeProc) {
    try {
        if (Test-Path "plugins") { $targetPlugins = "plugins" }
    } catch {}
}

# 2. 检查常见酒馆目录结构
if (-not $targetPlugins) {
    if (Test-Path "plugins") {
        $targetPlugins = "plugins"
    } elseif (Test-Path "config.yaml") {
        $targetPlugins = "plugins"
    }
}

# 3. 搜索扩展源文件
$srcItem = Get-ChildItem -Path @("data", "public", ".") -Recurse -Filter "auto-save" -Directory -Depth 5 -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*ST-auto-save*" } | Select-Object -First 1

if (-not $srcItem) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if ($scriptDir) {
        $srcItem = Get-ChildItem -Path $scriptDir -Recurse -Filter "auto-save" -Directory -Depth 5 -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*ST-auto-save*" } | Select-Object -First 1
    }
}

if ($srcItem) {
    if (-not $targetPlugins) {
        $parent = $srcItem.FullName
        while ($parent -and -not (Test-Path (Join-Path $parent "config.yaml")) -and (Split-Path $parent)) {
            $parent = Split-Path $parent
        }
        if ($parent -and (Test-Path (Join-Path $parent "config.yaml"))) {
            $targetPlugins = Join-Path $parent "plugins"
        } else {
            $targetPlugins = "plugins"
        }
    }

    if (-not (Test-Path $targetPlugins)) {
        New-Item -ItemType Directory -Path $targetPlugins -Force | Out-Null
    }

    Copy-Item -Recurse -Force $srcItem.FullName $targetPlugins
    Write-Host "🎉 [成功] 已部署至: $targetPlugins\auto-save" -ForegroundColor Green
    $success = $true
} else {
    # CDN 保底
    if ($targetPlugins -or (Test-Path "config.yaml") -or (Test-Path "plugins")) {
        if (-not $targetPlugins) { $targetPlugins = "plugins" }
        $dest = Join-Path $targetPlugins "auto-save"
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Write-Host "🌐 [CDN保底] 尝试从国内加速源直接下载插件核心文件..." -ForegroundColor Yellow
        try {
            Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/gh/zgy-beep/ST-auto-save-to-txt@main/plugins/auto-save/index.js" -OutFile (Join-Path $dest "index.js") -UseBasicParsing
            Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/gh/zgy-beep/ST-auto-save-to-txt@main/plugins/auto-save/package.json" -OutFile (Join-Path $dest "package.json") -UseBasicParsing
            if ((Test-Path (Join-Path $dest "index.js")) -and (Test-Path (Join-Path $dest "package.json"))) {
                Write-Host "🎉 [成功] 已通过 CDN 镜像安装至: $dest" -ForegroundColor Green
                $success = $true
            }
        } catch {}
    }
}

Write-Host "----------------------------------------------------------"
if ($success) {
    Write-Host "✅ 插件安装完成！" -ForegroundColor Green
    Write-Host "👉 下一步：请确认酒馆根目录 config.yaml 中 enableServerPlugins: true，然后重启酒馆即可生效！" -ForegroundColor Yellow
} else {
    Write-Host "❌ 未能自动找到 ST-auto-save 扩展源目录。" -ForegroundColor Red
    Write-Host "💡 请在 SillyTavern 根目录下打开 PowerShell 后重新执行此脚本。" -ForegroundColor Gray
}
Write-Host "=========================================================="
