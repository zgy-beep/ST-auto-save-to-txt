# ==============================================================================
# SillyTavern 小说连载阅读 (ST-auto-save-to-txt) Windows 服务端插件安装脚本
# ==============================================================================

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " 📖 小说连载阅读 (Novel Stream) 服务端插件安装程序 (Windows)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$success = $false

# 1. 尝试在当前目录及子目录搜索
$srcItem = Get-ChildItem -Path . -Recurse -Filter "auto-save" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*ST-auto-save*" } | Select-Object -First 1

# 2. 如果当前目录没找到，向上探测或在常见酒馆路径搜索
if (-not $srcItem) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    if ($scriptDir) {
        $srcItem = Get-ChildItem -Path $scriptDir -Recurse -Filter "auto-save" -Directory -ErrorAction SilentlyContinue | Where-Object { $_.FullName -like "*ST-auto-save*" } | Select-Object -First 1
    }
}

if ($srcItem) {
    # 推断 plugins 目录
    $targetPlugins = "plugins"
    if (-not (Test-Path $targetPlugins)) {
        # 尝试根据扩展所在路径推断上级酒馆目录
        $parent = $srcItem.FullName
        while ($parent -and -not (Test-Path (Join-Path $parent "config.yaml")) -and (Split-Path $parent)) {
            $parent = Split-Path $parent
        }
        if ($parent -and (Test-Path (Join-Path $parent "config.yaml"))) {
            $targetPlugins = Join-Path $parent "plugins"
        }
    }

    if (-not (Test-Path $targetPlugins)) {
        New-Item -ItemType Directory -Path $targetPlugins -Force | Out-Null
    }

    Copy-Item -Recurse -Force $srcItem.FullName $targetPlugins
    Write-Host "🎉 [成功] 已部署至: $targetPlugins\auto-save" -ForegroundColor Green
    $success = $true
}

Write-Host "----------------------------------------------------------"
if ($success) {
    Write-Host "✅ 插件安装完成！" -ForegroundColor Green
    Write-Host "👉 下一步：请确认酒馆根目录 config.yaml 中 enableServerPlugins: true，然后重启酒馆即可生效！" -ForegroundColor Yellow
} else {
    Write-Host "❌ 未能在当前目录下找到 ST-auto-save 扩展源目录。" -ForegroundColor Red
    Write-Host "💡 请在 SillyTavern 根目录下打开 PowerShell 后重新执行此脚本。" -ForegroundColor Gray
}
Write-Host "=========================================================="
