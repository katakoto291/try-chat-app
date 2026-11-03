#!/usr/bin/env bash
# AgentCore Runtime にデプロイしたエージェントを呼び出す。
#
#   ./scripts/agentcore-invoke.sh <ランタイムの ARN> "東京の天気は？"
#
# AWS が受けたリクエストは、コンテナの POST /invocations にそのまま届きます。
# 同じ SESSION_ID を使い続けると、同じコンテナ（セッション）に振り分けられます。
set -euo pipefail

ARN="${1:?使い方: $0 <agentRuntimeArn> \"質問\"}"
PROMPT="${2:-東京とロンドンの、今の天気と現地時刻を教えて}"
REGION="${AWS_REGION:-$(cut -d: -f4 <<<"$ARN")}"
# セッション ID は 33 文字以上が必要
SESSION_ID="${SESSION_ID:-session-$(date +%s)-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
OUT="$(mktemp)"

aws bedrock-agentcore invoke-agent-runtime --region "$REGION" \
  --agent-runtime-arn "$ARN" \
  --runtime-session-id "$SESSION_ID" \
  --content-type application/json \
  --payload "$(jq -nc --arg p "$PROMPT" '{prompt: $p}')" \
  --cli-binary-format raw-in-base64-out \
  "$OUT" >/dev/null

jq . "$OUT" 2>/dev/null || cat "$OUT"
rm -f "$OUT"
echo "(session: ${SESSION_ID})" >&2
