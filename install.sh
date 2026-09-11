#!/usr/bin/env bash
# ==============================================================================
# SillyTavern 小说连载阅读 (ST-auto-save-to-txt) 服务端插件全自动部署脚本
# 适用环境：
# 1. Linux 宿主机 (自动识别并穿透部署至 Docker 容器及宿主机挂载卷)
# 2. Docker 容器内部终端
# 3. 本地 Linux/VPS 直接运行的 SillyTavern
# ==============================================================================

echo "=========================================================="
echo " 📖 小说连载阅读 (Novel Stream) 服务端插件全自动部署程序"
echo "=========================================================="

SUCCESS=0

# ------------------------------------------------------------------------------
# 1. 尝试模式 A：如果在 Docker 容器内部执行
# ------------------------------------------------------------------------------
if [ -f /.dockerenv ] || grep -q 'docker\|containerd' /proc/1/cgroup 2>/dev/null; then
    echo "🔍 检测到当前运行在 Docker 容器内部..."
    SRC=$(find / -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
    if [ -n "$SRC" ]; then
        DEST="/home/node/app/plugins"
        [ ! -d "$DEST" ] && [ -d "plugins" ] && DEST="plugins"
        mkdir -p "$DEST"
        cp -r "$SRC" "$DEST/"
        echo "🎉 [成功] 容器内部署完成！已安装至: $DEST/auto-save"
        SUCCESS=1
    fi
fi

# ------------------------------------------------------------------------------
# 2. 尝试模式 B：如果在宿主机执行，且宿主机运行着 SillyTavern Docker 容器
# ------------------------------------------------------------------------------
if [ "$SUCCESS" -eq 0 ] && command -v docker >/dev/null 2>&1; then
    echo "🔍 正在检测 Docker 容器中的 SillyTavern 实例..."
    CID=$(docker ps --filter "name=sillytavern" -q | head -n 1)
    if [ -z "$CID" ]; then
        CID=$(docker ps --format '{{.ID}} {{.Image}} {{.Names}}' | grep -i 'sillytavern' | awk '{print $1}' | head -n 1)
    fi

    if [ -n "$CID" ]; then
        CNAME=$(docker inspect --format '{{.Name}}' "$CID" | sed 's/^\///')
        echo "🐳 找到正在运行的酒馆容器: $CNAME ($CID)"

        # 在容器内部执行搜寻并安装
        docker exec "$CID" sh -c '
            SRC=$(find / -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
            if [ -n "$SRC" ]; then
                DEST="/home/node/app/plugins"
                [ ! -d "$DEST" ] && [ -d "plugins" ] && DEST="plugins"
                mkdir -p "$DEST"
                cp -r "$SRC" "$DEST/"
                echo "CONTAINER_COPY_OK"
            fi
        ' 2>/dev/null | grep -q "CONTAINER_COPY_OK" && SUCCESS=1

        # 同时探测宿主机上的映射挂载卷，确保两端一致
        MOUNTS=$(docker inspect "$CID" --format '{{range .Mounts}}{{.Source}}:{{.Destination}}{{"\n"}}{{end}}' 2>/dev/null)
        while IFS=':' read -r host_path container_path; do
            [ -z "$host_path" ] && continue
            if echo "$container_path" | grep -qE "plugins$"; then
                SRC_HOST=$(find / -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
                [ -n "$SRC_HOST" ] && cp -r "$SRC_HOST" "$host_path/" && echo "📁 [同步] 已同步至宿主机挂载目录: $host_path/auto-save"
            elif echo "$container_path" | grep -qE "app$|data$"; then
                if [ -d "$host_path/plugins" ] || [ -d "$(dirname "$host_path")/plugins" ]; then
                    p_dir="$host_path/plugins"
                    [ ! -d "$p_dir" ] && p_dir="$(dirname "$host_path")/plugins"
                    SRC_HOST=$(find / -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
                    [ -n "$SRC_HOST" ] && mkdir -p "$p_dir" && cp -r "$SRC_HOST" "$p_dir/" && echo "📁 [同步] 已同步至宿主机挂载目录: $p_dir/auto-save"
                fi
            fi
        done <<< "$MOUNTS"

        if [ "$SUCCESS" -eq 1 ]; then
            echo "🎉 [成功] 已成功向 Docker 容器及挂载卷部署服务端插件！"
        fi
    fi
fi

# ------------------------------------------------------------------------------
# 3. 尝试模式 C：本地直接运行的 Linux / 原生 Node.js SillyTavern
# ------------------------------------------------------------------------------
if [ "$SUCCESS" -eq 0 ]; then
    echo "🔍 正在全盘搜索本地 SillyTavern 安装路径..."
    SRC=$(find ~ . /opt /var /volume1 -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
    if [ -n "$SRC" ]; then
        P_DIR=$(echo "$SRC" | sed -E 's/(data|public).*/plugins\//')
        if [ -n "$P_DIR" ] && [ "$P_DIR" != "$SRC" ]; then
            mkdir -p "$P_DIR"
            cp -r "$SRC" "$P_DIR"
            echo "🎉 [成功] 已部署至本地目录: $P_DIR/auto-save"
            SUCCESS=1
        fi
    fi
fi

echo "----------------------------------------------------------"
if [ "$SUCCESS" -eq 1 ]; then
    echo "✅ 插件安装完成！"
    echo "👉 下一步：请确认酒馆根目录 config.yaml 中 enableServerPlugins: true，然后重启酒馆即可生效！"
else
    echo "❌ 未能自动检测到 ST-auto-save-to-txt 插件源文件。"
    echo "💡 请排查："
    echo "   1. 确认已在 SillyTavern 网页端的扩展菜单中安装了该扩展；"
    echo "   2. 如果酒馆运行在 Docker 中，请确保容器正在运行 (docker ps 可见)；"
    echo "   3. 手动安装：将扩展内的 plugins/auto-save 目录复制到酒馆根目录的 plugins/ 即可。"
    exit 1
fi
echo "=========================================================="
