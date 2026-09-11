#!/usr/bin/env bash
# ==============================================================================
# SillyTavern 小说连载 (ST-auto-save-to-txt) 终极智能部署脚本
# 特性：内核级进程感知、Docker容器直连、0全盘遍历、0网络依赖、瞬间定位
# ==============================================================================

echo "=========================================================="
echo " 📖 小说连载阅读 (Novel Stream) 终极智能部署程序"
echo "=========================================================="

# 1. 智能感知：检测 Docker 运行中的酒馆容器 (耗时 0.01 秒)
if command -v docker >/dev/null 2>&1; then
    CID=$(docker ps --filter "name=sillytavern" -q 2>/dev/null | head -n 1)
    [ -z "$CID" ] && CID=$(docker ps --format '{{.ID}} {{.Image}} {{.Names}}' 2>/dev/null | grep -i 'sillytavern' | awk '{print $1}' | head -n 1)

    if [ -n "$CID" ]; then
        CNAME=$(docker inspect --format '{{.Name}}' "$CID" 2>/dev/null | sed 's/^\///')
        echo "🐳 [智能感知] 发现运行中的 Docker 酒馆: $CNAME"
        
        docker exec "$CID" sh -c '
            for s in /home/node/app/data/*/extensions/*auto-save*/plugins/auto-save \
                     /home/node/app/public/scripts/extensions/*/*auto-save*/plugins/auto-save \
                     /app/data/*/extensions/*auto-save*/plugins/auto-save; do
                if [ -d "$s" ]; then
                    mkdir -p /home/node/app/plugins
                    cp -r "$s" /home/node/app/plugins/
                    echo "SUCCESS"
                    exit 0
                fi
            done
            echo "NOT_FOUND"
        ' 2>/dev/null | grep -q "SUCCESS" && {
            echo "🎉 [部署成功] 已通过 Docker 极速完成容器内插件部署！"
            echo "👉 下一步：在酒馆 config.yaml 确认 enableServerPlugins: true 并重启容器即可！"
            echo "=========================================================="
            exit 0
        }
    fi
fi

# 2. 智能感知：通过 Linux 内核进程树读取原生 Node.js 酒馆工作目录 (耗时 0.001 秒)
ST_PID=$(pgrep -f "server.js" 2>/dev/null | head -n 1)
if [ -n "$ST_PID" ]; then
    ST_DIR=$(readlink -f /proc/"$ST_PID"/cwd 2>/dev/null)
    if [ -n "$ST_DIR" ] && [ -d "$ST_DIR" ]; then
        echo "⚡ [智能感知] 发现运行中的本地酒馆进程 (PID $ST_PID): $ST_DIR"
        for s in "$ST_DIR"/data/*/extensions/*auto-save*/plugins/auto-save \
                 "$ST_DIR"/public/scripts/extensions/*/*auto-save*/plugins/auto-save; do
            if [ -d "$s" ]; then
                mkdir -p "$ST_DIR/plugins"
                cp -r "$s" "$ST_DIR/plugins/"
                echo "🎉 [部署成功] 已极速部署至: $ST_DIR/plugins/auto-save"
                echo "👉 下一步：在 config.yaml 确认 enableServerPlugins: true 并重启酒馆即可！"
                echo "=========================================================="
                exit 0
            fi
        done
    fi
fi

# 3. 浅层探测：在当前目录及家目录下快速推断 (最大深度 3 层，耗时 0.05 秒，绝不扫大盘)
for base in . "$HOME" "$HOME/SillyTavern" /opt/SillyTavern; do
    if [ -d "$base" ]; then
        for s in "$base"/data/*/extensions/*auto-save*/plugins/auto-save \
                 "$base"/public/scripts/extensions/*/*auto-save*/plugins/auto-save \
                 "$base"/*/data/*/extensions/*auto-save*/plugins/auto-save; do
            if [ -d "$s" ]; then
                p_dir="$(echo "$s" | sed -E 's/(data|public).*/plugins\//')"
                mkdir -p "$p_dir"
                cp -r "$s" "$p_dir"
                echo "🎉 [部署成功] 已部署至: $p_dir/auto-save"
                echo "👉 下一步：在 config.yaml 确认 enableServerPlugins: true 并重启酒馆！"
                echo "=========================================================="
                exit 0
            fi
        done
    fi
done

echo "❌ 未能自动感知到 SillyTavern 运行环境。"
echo "💡 建议："
echo "   1. 确认 SillyTavern 处于启动状态；"
echo "   2. 确认网页扩展中已成功下载 ST-auto-save 扩展；"
echo "   3. 亦可手动将 扩展包内的 plugins/auto-save 复制到酒馆根目录的 plugins/ 目录。"
echo "=========================================================="
exit 1
