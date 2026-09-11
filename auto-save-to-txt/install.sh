#!/usr/bin/env bash
# ==============================================================================
# SillyTavern 小说连载 (ST-auto-save-to-txt) 全环境通用型自适应部署程序
# 兼容：
# 1. 任意名称的 Docker 容器 (智能模糊匹配镜像名与容器名，绝不硬编码)
# 2. Docker 容器内部 Web 终端 (群晖/1Panel/Portainer)
# 3. Linux 宿主机 SSH 终端 (无论当前在哪个目录)
# 4. Linux 原生 Node.js 运行环境 (内核级 PID 进程目录自感知)
# ==============================================================================

echo "=========================================================="
echo " 📖 小说连载阅读 (Novel Stream) 全环境通用自适应部署程序"
echo "=========================================================="

SUCCESS=0

# ------------------------------------------------------------------------------
# 1. 智能探测：宿主机 Docker 环境 (模糊匹配容器名或镜像名，提取容器 ID)
# ------------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
    CID=$(docker ps --format '{{.ID}} {{.Names}} {{.Image}}' 2>/dev/null | grep -iE 'sillytavern|tavern' | awk '{print $1}' | head -n 1)
    if [ -n "$CID" ]; then
        CNAME=$(docker inspect --format '{{.Name}}' "$CID" 2>/dev/null | sed 's/^\///')
        echo "🐳 [智能感知] 发现运行中的 Docker 酒馆容器: $CNAME ($CID)"
        
        OUT=$(docker exec "$CID" sh -c '
            for s in /home/node/app/data/*/extensions/*auto-save*/plugins/auto-save \
                     /home/node/app/public/scripts/extensions/*/*auto-save*/plugins/auto-save \
                     /app/data/*/extensions/*auto-save*/plugins/auto-save \
                     data/*/extensions/*auto-save*/plugins/auto-save; do
                if [ -d "$s" ]; then
                    dest="/home/node/app/plugins"
                    [ ! -d "$dest" ] && dest="plugins"
                    mkdir -p "$dest"
                    cp -r "$s" "$dest/"
                    echo "INSTALLED_OK"
                    exit 0
                fi
            done
            # 浅层快速定位 (深度4层，限制在app内，拒绝慢速遍历)
            src=$(find /home/node/app /app -maxdepth 5 -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
            if [ -n "$src" ]; then
                dest="/home/node/app/plugins"
                [ ! -d "$dest" ] && dest="plugins"
                mkdir -p "$dest"
                cp -r "$src" "$dest/"
                echo "INSTALLED_OK"
                exit 0
            fi
            echo "NOT_FOUND"
        ' 2>/dev/null)

        if echo "$OUT" | grep -q "INSTALLED_OK"; then
            echo "🎉 [部署成功] 已通过 Docker 极速完成容器内插件部署！"
            SUCCESS=1
        fi
    fi
fi

# ------------------------------------------------------------------------------
# 2. 智能探测：Linux 原生 Node.js 进程 (通过 /proc/PID/cwd 瞬间定位真实目录)
# ------------------------------------------------------------------------------
if [ "$SUCCESS" -eq 0 ]; then
    PID_DIR=$(readlink -f /proc/$(pgrep -f "server.js" 2>/dev/null | head -n 1)/cwd 2>/dev/null)
    if [ -n "$PID_DIR" ] && [ -d "$PID_DIR" ]; then
        echo "⚡ [智能感知] 发现正在运行的本地酒馆进程: $PID_DIR"
        for s in "$PID_DIR"/data/*/extensions/*auto-save*/plugins/auto-save \
                 "$PID_DIR"/public/scripts/extensions/*/*auto-save*/plugins/auto-save; do
            if [ -d "$s" ]; then
                mkdir -p "$PID_DIR/plugins"
                cp -r "$s" "$PID_DIR/plugins/"
                echo "🎉 [部署成功] 已自动部署至: $PID_DIR/plugins/auto-save"
                SUCCESS=1
                break
            fi
        done
    fi
fi

# ------------------------------------------------------------------------------
# 3. 智能探测：容器内部终端 (群晖/1Panel/Portainer) 或当前目录推断
# ------------------------------------------------------------------------------
if [ "$SUCCESS" -eq 0 ]; then
    for s in data/*/extensions/*auto-save*/plugins/auto-save \
             public/scripts/extensions/*/*auto-save*/plugins/auto-save \
             /home/node/app/data/*/extensions/*auto-save*/plugins/auto-save \
             /home/node/app/public/scripts/extensions/*/*auto-save*/plugins/auto-save \
             "$HOME"/SillyTavern/data/*/extensions/*auto-save*/plugins/auto-save; do
        if [ -d "$s" ]; then
            dest="plugins"
            [ -d "/home/node/app" ] && dest="/home/node/app/plugins"
            [ -d "$HOME/SillyTavern/plugins" ] && dest="$HOME/SillyTavern/plugins"
            mkdir -p "$dest"
            cp -r "$s" "$dest/"
            echo "🎉 [部署成功] 已部署至: $dest/auto-save"
            SUCCESS=1
            break
        fi
    done
fi

echo "----------------------------------------------------------"
if [ "$SUCCESS" -eq 1 ]; then
    echo "✅ 服务端插件部署完成！"
    echo "👉 最终步骤："
    echo "   1. 确认酒馆根目录 config.yaml 中 enableServerPlugins: true；"
    echo "   2. 重启酒馆（若为 Docker 运行请执行 docker restart <容器名>）；"
    echo "   3. 刷新浏览器，连载状态即可点亮！"
else
    echo "❌ 未能自动检测到 SillyTavern 环境或插件源文件。"
    echo "💡 通用排查方案："
    echo "   1. 确认酒馆正在运行中；"
    echo "   2. 确认网页扩展菜单中已成功下载本扩展；"
    echo "   3. 极简手动方式：将扩展包内部的 plugins/auto-save 文件夹直接复制到 SillyTavern/plugins/ 下即可。"
    exit 1
fi
echo "=========================================================="
