#!/usr/bin/env bash
# ==============================================================================
# SillyTavern 小说连载 (ST-auto-save-to-txt) 全环境通用自适应部署程序
# 兼容：
# 1. 任意名称的 Docker 容器 (智能模糊匹配镜像名与容器名，绝不硬编码)
# 2. 宿主机挂载卷同步 (自动解析 docker inspect 挂载路径，宿主机挂载卷也能找到)
# 3. Docker 容器内部 Web 终端 (群晖/1Panel/Portainer)
# 4. Linux 宿主机 SSH 终端 (无论当前在哪个目录)
# 5. Linux 原生 Node.js 运行环境 (内核级 PID 进程目录自感知)
# 6. 国内高速 CDN / 镜像直连保底 (jsDelivr / Fastly / 加速镜像)
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
        
        # 容器内执行定向查找与部署
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
                    chmod -R 755 "$dest/auto-save" 2>/dev/null || true
                    echo "INSTALLED_OK:$dest/auto-save"
                    exit 0
                fi
            done
            # 限制在应用目录浅层查找 (最大5层，拒绝慢速遍历)
            src=$(find /home/node/app /app -maxdepth 5 -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
            if [ -n "$src" ]; then
                dest="/home/node/app/plugins"
                [ ! -d "$dest" ] && dest="plugins"
                mkdir -p "$dest"
                cp -r "$src" "$dest/"
                chmod -R 755 "$dest/auto-save" 2>/dev/null || true
                echo "INSTALLED_OK:$dest/auto-save"
                exit 0
            fi
            echo "NOT_FOUND"
        ' 2>/dev/null)

        if echo "$OUT" | grep -q "INSTALLED_OK"; then
            echo "🎉 [部署成功] 已通过 Docker 极速完成容器内插件部署！"
            SUCCESS=1

            # 宿主机挂载卷同步检查：让在宿主机排查挂载卷的用户也能看到文件
            HOST_MOUNTS=$(docker inspect --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$CID" 2>/dev/null)
            for hm in $HOST_MOUNTS; do
                if [ -d "$hm" ]; then
                    target_plugin_dir=""
                    if [ -d "$hm/plugins" ]; then
                        target_plugin_dir="$hm/plugins"
                    elif echo "$hm" | grep -qE '/plugins/?$'; then
                        target_plugin_dir="$hm"
                    fi

                    if [ -n "$target_plugin_dir" ]; then
                        host_src=$(find "$hm" -maxdepth 5 -type d -name "auto-save" -path "*ST-auto-save*" 2>/dev/null | head -n 1)
                        if [ -n "$host_src" ]; then
                            mkdir -p "$target_plugin_dir"
                            cp -r "$host_src" "$target_plugin_dir/"
                            chmod -R 755 "$target_plugin_dir/auto-save" 2>/dev/null || true
                            echo "📁 [宿主机挂载同步] 同步至宿主机挂载卷: $target_plugin_dir/auto-save"
                        fi
                    fi
                fi
            done
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
                chmod -R 755 "$PID_DIR/plugins/auto-save" 2>/dev/null || true
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
            chmod -R 755 "$dest/auto-save" 2>/dev/null || true
            echo "🎉 [部署成功] 已部署至: $dest/auto-save"
            SUCCESS=1
            break
        fi
    done
fi

# ------------------------------------------------------------------------------
# 4. 保底降级方案：若本地未找到源文件，通过国内 CDN 高速源直下插件核心文件
# ------------------------------------------------------------------------------
if [ "$SUCCESS" -eq 0 ]; then
    fallback_dest=""
    if [ -d "plugins" ] || [ -f "server.js" ] || [ -f "config.yaml" ]; then
        fallback_dest="plugins"
    elif [ -d "/home/node/app/plugins" ] || [ -d "/home/node/app" ]; then
        fallback_dest="/home/node/app/plugins"
    elif [ -d "$HOME/SillyTavern/plugins" ]; then
        fallback_dest="$HOME/SillyTavern/plugins"
    fi

    if [ -n "$fallback_dest" ]; then
        echo "🌐 [CDN保底] 尝试从国内高速加速源直接下载插件核心文件..."
        target_dir="$fallback_dest/auto-save"
        mkdir -p "$target_dir"
        cdn_urls=(
            "https://cdn.jsdelivr.net/gh/zgy-beep/ST-auto-save-to-txt@main/plugins/auto-save"
            "https://fastly.jsdelivr.net/gh/zgy-beep/ST-auto-save-to-txt@main/plugins/auto-save"
            "https://ghproxy.net/https://raw.githubusercontent.com/zgy-beep/ST-auto-save-to-txt/main/plugins/auto-save"
        )
        for base in "${cdn_urls[@]}"; do
            curl -fsSL "$base/index.js" -o "$target_dir/index.js" 2>/dev/null
            curl -fsSL "$base/package.json" -o "$target_dir/package.json" 2>/dev/null
            if [ -s "$target_dir/index.js" ] && [ -s "$target_dir/package.json" ]; then
                chmod -R 755 "$target_dir" 2>/dev/null || true
                echo "🎉 [部署成功] 已通过 CDN 镜像源安装至: $target_dir"
                SUCCESS=1
                break
            fi
        done
    fi
fi

echo "----------------------------------------------------------"
if [ "$SUCCESS" -eq 1 ]; then
    echo "=========================================================="
    echo "✅ 服务端插件部署完成！"
    echo "👉 最终步骤："
    echo "   1. 确认酒馆根目录 config.yaml 中 enableServerPlugins: true；"
    echo "   2. 重启酒馆（若为 Docker 运行请执行: docker restart <容器名>）；"
    echo "   3. 刷新酒馆页面，连载状态即可点亮！"
    echo "=========================================================="
else
    echo "=========================================================="
    echo "❌ [自动部署未完成] 未能在当前环境自动定位到酒馆或插件源目录"
    echo "=========================================================="
    echo ""
    echo "📌 请使用【100% 成功保底方案：手动复制】"
    echo ""
    echo "👉 核心复制规则："
    echo "   【源文件夹】：.../data/default-user/extensions/ST-auto-save-to-txt/plugins/auto-save"
    echo "   【目标目录】：.../SillyTavern/plugins/auto-save"
    echo ""
    echo "💻 场景一：Docker 用户（在服务器终端直接执行以下命令）："
    echo "   docker exec -it <容器名> cp -r /home/node/app/data/default-user/extensions/ST-auto-save-to-txt/plugins/auto-save /home/node/app/plugins/"
    echo "   （若有宿主机挂载卷，直接将扩展内的 plugins/auto-save 复制进挂载的 plugins/ 目录亦可）"
    echo ""
    echo "🖥️ 场景二：Linux / Windows 原生运行用户："
    echo "   直接将 ST-auto-save-to-txt/plugins/auto-save 整个文件夹，"
    echo "   复制到 SillyTavern 根目录的 plugins/ 目录下即可。"
    echo ""
    echo "✨ 复制完成后："
    echo "   1. 确认酒馆 config.yaml 中 enableServerPlugins: true；"
    echo "   2. 重启酒馆服务（Docker 执行: docker restart <容器名>）；"
    echo "   3. 刷新浏览器网页，连载功能即可点亮正常使用！"
    echo "=========================================================="
    exit 1
fi
echo "=========================================================="
