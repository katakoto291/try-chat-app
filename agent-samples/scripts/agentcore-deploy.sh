#!/usr/bin/env bash
# サンプルを Amazon Bedrock AgentCore Runtime にデプロイする。
#
#   ./scripts/agentcore-deploy.sh strands
#   ./scripts/agentcore-deploy.sh vercel-ai-sdk
#   ./scripts/agentcore-deploy.sh claude-agent-sdk
#   ./scripts/agentcore-deploy.sh mcp-server        # MCP サーバーとして載せる（ポート 8000 の /mcp）
#   MCP_SERVER_URL=<上で表示された URL> ./scripts/agentcore-deploy.sh trip-planner
#   AGENT_PROTOCOL=A2A ./scripts/agentcore-deploy.sh strands    # A2A 方式で載せる（ポート 9000。Agent Card を GetAgentCard で取れる）
#
# 必要なもの: AWS CLI v2（最新版）、Docker（buildx）、jq、AWS の認証情報（aws configure / aws sso login など）
#
# やっていること（AgentCore にデプロイする最小の手順そのもの）:
#   1. ECR（コンテナの置き場所）にリポジトリを作る
#   2. ARM64 のイメージをビルドして ECR に push する
#   3. ランタイムが使う IAM ロール（実行ロール）を作る … ECR から取得・ログ出力・Bedrock の Claude 呼び出しを許可
#   4. AgentCore Runtime を作成（2 回目以降は更新）する
set -euo pipefail

SAMPLE="${1:?使い方: $0 <strands|vercel-ai-sdk|claude-agent-sdk|mcp-server|trip-planner>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[[ -f "$ROOT/$SAMPLE/Dockerfile" ]] || { echo "サンプルが見つかりません: $SAMPLE" >&2; exit 1; }

REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
NAME="agent_sample_${SAMPLE//-/_}"           # ランタイム名は英数字と _ のみ
REPO="agent-samples/${SAMPLE}"
IMAGE="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:latest"
ROLE_NAME="AgentSampleRuntimeRole"

echo "== 1. ECR リポジトリ: ${REPO}"
aws ecr describe-repositories --region "$REGION" --repository-names "$REPO" >/dev/null 2>&1 ||
  aws ecr create-repository --region "$REGION" --repository-name "$REPO" >/dev/null

echo "== 2. ARM64 イメージをビルドして push: ${IMAGE}"
aws ecr get-login-password --region "$REGION" |
  docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
docker buildx build --platform linux/arm64 -t "$IMAGE" --push "$ROOT/$SAMPLE"

echo "== 3. 実行ロール: ${ROLE_NAME}"
if ! ROLE_ARN="$(aws iam get-role --role-name "$ROLE_NAME" --query Role.Arn --output text 2>/dev/null)"; then
  ROLE_ARN="$(aws iam create-role --role-name "$ROLE_NAME" --query Role.Arn --output text \
    --assume-role-policy-document "$(jq -nc --arg acct "$ACCOUNT" '{
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": $acct } }
      }]
    }')")"
  echo "   作成しました（反映を待つため 10 秒待機）"; sleep 10
fi
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name AgentSampleRuntimePolicy \
  --policy-document "$(jq -nc --arg acct "$ACCOUNT" '{
    Version: "2012-10-17",
    Statement: [
      { Sid: "PullImage", Effect: "Allow", Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: "arn:aws:ecr:*:*:repository/agent-samples/*" },
      { Sid: "EcrAuth", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
      { Sid: "Logs", Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"], Resource: "*" },
      { Sid: "Observability", Effect: "Allow", Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "cloudwatch:PutMetricData"], Resource: "*" },
      { Sid: "InvokeOtherRuntimes", Effect: "Allow", Action: ["bedrock-agentcore:InvokeAgentRuntime"],
        Resource: ("arn:aws:bedrock-agentcore:*:" + $acct + ":runtime/agent_sample_*") },
      { Sid: "InvokeClaude", Effect: "Allow",
        Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ListInferenceProfiles", "bedrock:GetInferenceProfile"],
        Resource: ["arn:aws:bedrock:*:*:foundation-model/*", "arn:aws:bedrock:*:*:inference-profile/*", "arn:aws:bedrock:*:*:application-inference-profile/*"] }
    ]
  }')"

echo "== 4. AgentCore Runtime: ${NAME}"
# 一覧（list-agent-runtimes）で何のエージェントか分かるように、説明文を付けておく
case "$SAMPLE" in
  mcp-server)   DESCRIPTION="観光スポット検索の MCP サーバー" ;;
  trip-planner) DESCRIPTION="観光プランナー: 天気と観光スポットを調べて日帰りプランを作る" ;;
  *)            DESCRIPTION="旅行アシスタント（${SAMPLE}）: 都市の天気と現地時刻を調べて答える" ;;
esac

# コンテナに渡す環境変数とプロトコル
#   HTTP … POST /invocations をポート 8080 で受ける（既定）
#   A2A  … A2A の JSON-RPC をポート 9000 の / で受ける。Agent Card は GetAgentCard API で取れる
#   MCP  … MCP サーバー。ポート 8000 の /mcp（mcp-server のとき）
if [[ "$SAMPLE" == "mcp-server" ]]; then
  SERVER_PROTOCOL="MCP"; PORT=8000
else
  SERVER_PROTOCOL="${AGENT_PROTOCOL:-HTTP}"
  [[ "$SERVER_PROTOCOL" == "A2A" ]] && PORT=9000 || PORT=8080
fi
PROTOCOL="$(jq -nc --arg p "$SERVER_PROTOCOL" '{serverProtocol: $p}')"

# 環境変数。エージェントは AgentCore 上では Bedrock の Claude を「実行ロール」の権限で呼ぶ。
# MCP_SERVER_URL を渡すと、その MCP サーバーを IAM（SigV4）で呼ぶ設定も入れる（trip-planner 用）。
# AGENT_URL は A2A のときに Agent Card に載せる「外から見た URL」（ARN が決まってから入れる）
env_vars() {
  if [[ "$SAMPLE" == "mcp-server" ]]; then echo '{"PORT":"8000"}'; return; fi
  jq -nc --arg region "$REGION" --arg port "$PORT" --arg model "${MODEL_ID:-}" --arg mcp "${MCP_SERVER_URL:-}" --arg url "${1:-}" \
    '{MODEL_PROVIDER: "bedrock", AWS_REGION: $region, PORT: $port}
     + (if $model != "" then {MODEL_ID: $model} else {} end)
     + (if $mcp != "" then {MCP_SERVER_URL: $mcp, MCP_AUTH: "sigv4"} else {} end)
     + (if $url != "" then {AGENT_URL: $url} else {} end)'
}
ARTIFACT="$(jq -nc --arg uri "$IMAGE" '{containerConfiguration: {containerUri: $uri}}')"
runtime_base() { echo "https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/$(jq -rn --arg a "$1" '$a|@uri')"; }
arn_of() { aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$1" --query agentRuntimeArn --output text; }

update_runtime() {
  aws bedrock-agentcore-control update-agent-runtime --region "$REGION" \
    --agent-runtime-id "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --description "$DESCRIPTION" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration "$PROTOCOL" \
    --environment-variables "$1" >/dev/null
}

wait_ready() {
  echo -n "   準備ができるのを待っています"
  for _ in $(seq 1 60); do
    STATUS="$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RUNTIME_ID" --query status --output text)"
    [[ "$STATUS" == "READY" ]] && break
    [[ "$STATUS" == *FAILED* ]] && { echo; echo "失敗しました: $STATUS" >&2; exit 1; }
    echo -n "."; sleep 5
  done
  echo " ${STATUS}"
}

RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${NAME}'].agentRuntimeId | [0]" --output text)"
if [[ "$RUNTIME_ID" == "None" || -z "$RUNTIME_ID" ]]; then
  RUNTIME_ID="$(aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
    --agent-runtime-name "$NAME" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --description "$DESCRIPTION" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration "$PROTOCOL" \
    --environment-variables "$(env_vars)" \
    --query agentRuntimeId --output text)"
  echo "   作成しました: ${RUNTIME_ID}"
  wait_ready
  # A2A のときは、ARN が決まったので「外から見た URL」を Agent Card に載せるため、もう一度更新する
  if [[ "$SERVER_PROTOCOL" == "A2A" ]]; then
    update_runtime "$(env_vars "$(runtime_base "$(arn_of "$RUNTIME_ID")")/invocations/")"
    echo "   Agent Card に載せる URL を設定しました"; wait_ready
  fi
else
  AGENT_URL=""
  [[ "$SERVER_PROTOCOL" == "A2A" ]] && AGENT_URL="$(runtime_base "$(arn_of "$RUNTIME_ID")")/invocations/"
  update_runtime "$(env_vars "$AGENT_URL")"
  echo "   更新しました: ${RUNTIME_ID}"
  wait_ready
fi

ARN="$(arn_of "$RUNTIME_ID")"
echo
echo "デプロイ完了: ${ARN}"
case "$SERVER_PROTOCOL" in
  MCP)
    # AgentCore 上の MCP サーバーの URL は「ARN を URL エンコードして埋め込んだ invocations の URL」
    MCP_URL="$(runtime_base "$ARN")/invocations?qualifier=DEFAULT"
    echo "MCP サーバーの URL: ${MCP_URL}"
    echo "観光プランナーをこの MCP サーバーにつないでデプロイする例:"
    echo "  MCP_SERVER_URL='${MCP_URL}' ./scripts/agentcore-deploy.sh trip-planner"
    ;;
  A2A)
    echo "Agent Card を取る:  aws bedrock-agentcore get-agent-card --region ${REGION} --agent-runtime-arn ${ARN}"
    echo "agent-hub に登録:   HUB_AGENTS=a2a:${ARN}  （ハブが IAM の署名を付けて A2A で呼ぶ）"
    ;;
  *)
    echo "呼び出し例: ./scripts/agentcore-invoke.sh ${ARN} \"東京の天気は？\""
    echo "自己紹介:   ./scripts/agentcore-invoke.sh ${ARN} --describe"
    ;;
esac
