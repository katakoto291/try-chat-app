#!/usr/bin/env bash
# ローカルで起動したサーバー（またはコンテナ）が、AgentCore / Foundry の約束どおりに答えるかを確かめる。
#
#   ./scripts/smoke-test.sh                       # http://localhost:8080
#   ./scripts/smoke-test.sh http://localhost:8088
#
# どのサンプルも /ping（AgentCore 用）と /readiness（Foundry 用）の両方に答えます。
set -euo pipefail

BASE="${1:-http://localhost:8080}"
PROMPT="${2:-東京とロンドンの、今の天気と現地時刻を教えて}"
BODY="$(jq -nc --arg p "$PROMPT" '{prompt: $p}')"

echo "== GET /ping（AgentCore のヘルスチェック）"
curl -sf "$BASE/ping" || echo "(なし)"
echo; echo
echo "== GET /readiness（Foundry のヘルスチェック）"
curl -s -o /dev/null -w "HTTP %{http_code}\n" "$BASE/readiness"
echo
echo "== POST /invocations（まとめて返す）"
curl -s -X POST "$BASE/invocations" -H 'content-type: application/json' -d "$BODY" | jq .
echo
echo "== POST /invocations（\"stream\": true で途中経過を SSE で受け取る）"
curl -sN -X POST "$BASE/invocations" -H 'content-type: application/json' \
  -d "$(jq -c '. + {stream: true}' <<<"$BODY")"
