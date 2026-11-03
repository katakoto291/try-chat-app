#!/usr/bin/env bash
# サンプルを Amazon Bedrock AgentCore Runtime にデプロイする。
#
#   ./scripts/agentcore-deploy.sh strands
#   ./scripts/agentcore-deploy.sh vercel-ai-sdk
#   ./scripts/agentcore-deploy.sh claude-agent-sdk
#
# 必要なもの: AWS CLI v2（最新版）、Docker（buildx）、jq、AWS の認証情報（aws configure / aws sso login など）
#
# やっていること（AgentCore にデプロイする最小の手順そのもの）:
#   1. ECR（コンテナの置き場所）にリポジトリを作る
#   2. ARM64 のイメージをビルドして ECR に push する
#   3. ランタイムが使う IAM ロール（実行ロール）を作る … ECR から取得・ログ出力・Bedrock の Claude 呼び出しを許可
#   4. AgentCore Runtime を作成（2 回目以降は更新）する
set -euo pipefail

SAMPLE="${1:?使い方: $0 <strands|vercel-ai-sdk|claude-agent-sdk>}"
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
  --policy-document "$(jq -nc '{
    Version: "2012-10-17",
    Statement: [
      { Sid: "PullImage", Effect: "Allow", Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], Resource: "arn:aws:ecr:*:*:repository/agent-samples/*" },
      { Sid: "EcrAuth", Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
      { Sid: "Logs", Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents", "logs:DescribeLogGroups", "logs:DescribeLogStreams"], Resource: "*" },
      { Sid: "Observability", Effect: "Allow", Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "cloudwatch:PutMetricData"], Resource: "*" },
      { Sid: "InvokeClaude", Effect: "Allow",
        Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:ListInferenceProfiles", "bedrock:GetInferenceProfile"],
        Resource: ["arn:aws:bedrock:*:*:foundation-model/*", "arn:aws:bedrock:*:*:inference-profile/*", "arn:aws:bedrock:*:*:application-inference-profile/*"] }
    ]
  }')"

echo "== 4. AgentCore Runtime: ${NAME}"
# コンテナに渡す環境変数。AgentCore 上では Bedrock の Claude を「実行ロール」の権限で呼ぶ
ENV_VARS="$(jq -nc --arg region "$REGION" --arg model "${MODEL_ID:-}" \
  '{MODEL_PROVIDER: "bedrock", AWS_REGION: $region, PORT: "8080"} + (if $model != "" then {MODEL_ID: $model} else {} end)')"
ARTIFACT="$(jq -nc --arg uri "$IMAGE" '{containerConfiguration: {containerUri: $uri}}')"

RUNTIME_ID="$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='${NAME}'].agentRuntimeId | [0]" --output text)"
if [[ "$RUNTIME_ID" == "None" || -z "$RUNTIME_ID" ]]; then
  RUNTIME_ID="$(aws bedrock-agentcore-control create-agent-runtime --region "$REGION" \
    --agent-runtime-name "$NAME" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --environment-variables "$ENV_VARS" \
    --query agentRuntimeId --output text)"
  echo "   作成しました: ${RUNTIME_ID}"
else
  aws bedrock-agentcore-control update-agent-runtime --region "$REGION" \
    --agent-runtime-id "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --network-configuration '{"networkMode":"PUBLIC"}' \
    --protocol-configuration '{"serverProtocol":"HTTP"}' \
    --environment-variables "$ENV_VARS" >/dev/null
  echo "   更新しました: ${RUNTIME_ID}"
fi

echo -n "   準備ができるのを待っています"
for _ in $(seq 1 60); do
  STATUS="$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RUNTIME_ID" --query status --output text)"
  [[ "$STATUS" == "READY" ]] && break
  [[ "$STATUS" == *FAILED* ]] && { echo; echo "失敗しました: $STATUS" >&2; exit 1; }
  echo -n "."; sleep 5
done
echo " ${STATUS}"

ARN="$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)"
echo
echo "デプロイ完了: ${ARN}"
echo "呼び出し例: ./scripts/agentcore-invoke.sh ${ARN} \"東京の天気は？\""
