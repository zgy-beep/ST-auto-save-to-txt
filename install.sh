#!/usr/bin/env bash
# ==============================================================================
# SillyTavern 小说连载阅读 (ST-auto-save-to-txt) 官方安装部署脚本 (高性能优化版)
# 特性：纯本地精准定位、0 外部依赖、杜绝全盘慢速遍历、秒级响应
# ==============================================================================

echo "=========================================================="
echo " 📖 小说连载阅读 (Novel Stream) 服务端插件自动安装程序"
echo "=========================================================="

SUCCESS=0

# ------------------------------------------------------------------------------
# 模式 1：检测是否在 Docker 宿主机，且有 SillyTavern 容器运行（优先处理）
# ------------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
    CID=$(docker ps --filter "name=sillytavern" -q | head -n 1)
    if [ -z "$CID" ]; then
        CID=$(docker ps --format '{{.ID}} {{.Image}} {{.Names}}' | grep -i 'sillytavern' | awk '{print $1}' | head -n 1)
    fi

    if [ -n "$CID" ]; then
        CNAME=$(docker inspect --format '{{.Name}}' "$CID" | sed 's/^\///')
        echo "🐳 检测到运行中的酒馆容器: $CNAME ($CID)"
        echo "⏳ 正在容器内部秒级部署..."

        OUT=$(docker exec "$CID" sh -c '
            for s in /home/node/app/data/*/extensions/*auto-save*/plugins/auto-save \
                     /home/node/app/public/scripts/extensions/*/*auto-save*/plugins/auto-save \
                     /app/data/*/extensions/*auto-save*/plugins/auto-save; do
                if [ -d "$s" ]; then
                    mkdir -p /home/node/app/plugins
                    cp -r "$s" /home/node/app/plugins/
                    echo "INSTALLED_OK"
                    exit 0
                fi
            done
            # 容错降级：在应用目录内限制 4 层快速搜索
            src=$(find /home/node/app /app -maxdepth 5 -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
            if [ -n "$src" ]; then
                mkdir -p /home/node/app/plugins
                cp -r "$src" /home/node/app/plugins/
                echo "INSTALLED_OK"
                exit 0
            fi
            echo "NOT_FOUND"
        ' 2>/dev/null)

        if echo "$OUT" | grep -q "INSTALLED_OK"; then
            echo "🎉 [成功] 已通过 Docker 成功将插件部署到容器 plugins/ 目录！"
            SUCCESS=1
        fi
    fi
fi

# ------------------------------------------------------------------------------
# 模式 2：检测是否在 Docker 容器内部执行
# ------------------------------------------------------------------------------
if [ "$SUCCESS" -eq 0 ] && ([ -f /.dockerenv ] || grep -q 'docker\|containerd' /proc/1/cgroup 2>/dev/null); then
    echo "🔍 检测到当前运行在 Docker 容器终端内部..."
    for s in /home/node/app/data/*/extensions/*auto-save*/plugins/auto-save \
             /home/node/app/public/scripts/extensions/*/*auto-save*/plugins/auto-save \
             ./data/*/extensions/*auto-save*/plugins/auto-save \
             ./public/scripts/extensions/*/*auto-save*/plugins/auto-save; do
        if [ -d "$s" ]; then
            dest="/home/node/app/plugins"
            [ ! -d "$dest" ] && dest="plugins"
            mkdir -p "$dest"
            cp -r "$s" "$dest/"
            echo "🎉 [成功] 容器内部署完成: $dest/auto-save"
            SUCCESS=1
            break
        fi
    done
fi

# ------------------------------------------------------------------------------
# 模式 3：常规 Linux 原生 Node.js 运行环境 (非 Docker)
# ------------------------------------------------------------------------------
if [ "$SUCCESS" -eq 0 ]; then
    echo "🔍 正在检查本地 SillyTavern 目录..."
    # 优先使用精准路径通配，耗时 0.001 秒，绝不扫描 NAS/大存储盘
    for s in data/*/extensions/*auto-save*/plugins/auto-save \
             public/scripts/extensions/*/*auto-save*/plugins/auto-save \
             */data/*/extensions/*auto-save*/plugins/auto-save \
             ../data/*/extensions/*auto-save*/plugins/auto-save; do
        if [ -d "$s" ]; then
            p_dir="plugins"
            if [ ! -d "$p_dir" ]; then
                p_dir="$(echo "$s" | sed -E 's/(data|public).*/plugins/') "
            fi
            mkdir -p "$p_dir"
            cp -r "$s" "$p_dir/"
            echo "🎉 [成功] 已部署至本地: $p_dir/auto-save"
            SUCCESS=1
            break
        fi
    done

    # 仅在当前目录树（最大深度 5 层）快速扫描，拒绝全盘遍历
    if [ "$SUCCESS" -eq 0 ]; then
        src=$(find . -maxdepth 5 -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
        if [ -n "$src" ]; then
            mkdir -p plugins
            cp -r "$src" plugins/
            echo "🎉 [成功] 已部署至本地: plugins/auto-save"
            SUCCESS=1
        fi
    fi
fi

echo "----------------------------------------------------------"
if [ "$SUCCESS" -eq 1 ]; then
    echo "✅ 插件安装完成！"
    echo "👉 下一步：请确认酒馆 config.yaml 中 enableServerPlugins: true，然后重启酒馆即可生效！"
else
    echo "❌ 未能自动找到 ST-auto-save 扩展文件。"
    echo "💡 提示："
    echo "   1. 确认已在酒馆网页扩展菜单中下载并安装了本扩展；"
    echo "   2. 如果使用 Docker，请确认容器正在运行中 (docker ps 可见)；"
    echo "   3. 亦可手动复制：将扩展目录内的 plugins/auto-save 文件夹复制到 SillyTavern 根目录的 plugins/ 即可。"
    exit 1
fi
echo "=========================================================="
