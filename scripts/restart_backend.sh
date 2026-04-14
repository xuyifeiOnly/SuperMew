#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/4] 停止旧服务..."
pkill -f "python backend/app.py" >/dev/null 2>&1 || true

echo "[2/4] 启动新服务..."
nohup .venv/bin/python backend/app.py > /tmp/supermew_backend.log 2>&1 &

echo "[3/4] 健康检查..."
for _ in $(seq 1 40); do
  code="$(curl -s -o /tmp/supermew_backend_health.txt -w "%{http_code}" http://127.0.0.1:8000/docs || true)"
  if [ "$code" = "200" ]; then
    echo "服务重启成功：http://127.0.0.1:8000"
    echo "日志文件：/tmp/supermew_backend.log"
    break
  fi
  sleep 1
done

if [ "${code:-000}" != "200" ]; then
  echo "服务重启失败，请查看日志：/tmp/supermew_backend.log"
  tail -n 40 /tmp/supermew_backend.log || true
  exit 1
fi

echo "[4/4] 当前监听端口："
lsof -nP -iTCP:8000 -sTCP:LISTEN || true
