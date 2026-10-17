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
    # $MyInvocation.MyCommand.Path 在 `irm | iex` 场景下为空，优先使用 $PSCommandPath 并做空值防护
    $scriptDir = if ($PSCommandPath) {
        Split-Path -Parent $PSCommandPath
    } elseif ($MyInvocation.MyCommand.Path) {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    } else {
        $null
    }
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
    $deployedIndex = Join-Path (Join-Path $targetPlugins "auto-save") "index.js"
    $deployedFile = Get-Item $deployedIndex -ErrorAction SilentlyContinue
    if ((Test-Path $deployedIndex) -and $deployedFile -and ($deployedFile.Length -gt 0)) {
        Write-Host "🎉 [成功] 已部署至: $targetPlugins\auto-save" -ForegroundColor Green
        $success = $true
    } else {
        Write-Host "⚠️ [校验失败] 目标目录中未找到非空的 auto-save\index.js，本次部署视为未完成。" -ForegroundColor Red
    }
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
            $cdnIndex = Join-Path $dest "index.js"
            $cdnPkg = Join-Path $dest "package.json"
            $cdnIndexFile = Get-Item $cdnIndex -ErrorAction SilentlyContinue
            $cdnPkgFile = Get-Item $cdnPkg -ErrorAction SilentlyContinue
            if ((Test-Path $cdnIndex) -and (Test-Path $cdnPkg) -and $cdnIndexFile -and $cdnPkgFile -and ($cdnIndexFile.Length -gt 0) -and ($cdnPkgFile.Length -gt 0)) {
                Write-Host "🎉 [成功] 已通过 CDN 镜像安装至: $dest" -ForegroundColor Green
                $success = $true
            }
        } catch {}
    }
}

Write-Host "----------------------------------------------------------"
if ($success) {
    Write-Host "==========================================================" -ForegroundColor Green
    Write-Host "✅ 插件安装完成！" -ForegroundColor Green
    Write-Host "👉 下一步：请确认酒馆根目录 config.yaml 中 enableServerPlugins: true，然后重启酒馆即可生效！" -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Green
    exit 0
} else {
    Write-Host "==========================================================" -ForegroundColor Red
    Write-Host "❌ [自动部署未完成] 未能在当前环境自动定位到酒馆根目录或插件文件" -ForegroundColor Red
    Write-Host "==========================================================" -ForegroundColor Red
    # 打印本次将要写入的绝对路径，便于用户判断是否装到了错误目录
    $relPlugins = if ($targetPlugins) { $targetPlugins } else { "plugins" }
    if ([System.IO.Path]::IsPathRooted($relPlugins)) {
        $attemptedDir = Join-Path $relPlugins "auto-save"
    } else {
        $attemptedDir = Join-Path (Get-Location).Path (Join-Path $relPlugins "auto-save")
    }
    Write-Host "📌 [诊断] 本次尝试写入的绝对路径: $attemptedDir" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "📌 请使用【100% 成功保底方案：手动复制】" -ForegroundColor Yellow
    Write-Host "   【源文件夹】：SillyTavern\data\default-user\extensions\ST-auto-save-to-txt\plugins\auto-save" -ForegroundColor White
    Write-Host "   【目标目录】：SillyTavern\plugins\auto-save" -ForegroundColor Green
    Write-Host ""
    Write-Host "👉 操作步骤：" -ForegroundColor Cyan
    Write-Host "   1. 打开文件资源管理器，进入扩展所在文件夹；"
    Write-Host "   2. 将 plugins\auto-save 整个文件夹复制到 SillyTavern 根目录的 plugins\ 下；"
    Write-Host "   3. 确认 config.yaml 中 enableServerPlugins: true 并重启酒馆。" -ForegroundColor Yellow
    Write-Host "==========================================================" -ForegroundColor Red
    exit 1
}
