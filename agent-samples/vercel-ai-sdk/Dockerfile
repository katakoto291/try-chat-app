# Bedrock AgentCore Runtime と Microsoft Foundry hosted agents のどちらでも動くコンテナ。
# AgentCore は ARM64 のイメージが必要なので、ビルド時に --platform linux/arm64 を付けます（scripts/agentcore-deploy.sh 参照）。
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

# AgentCore は 8080（A2A 方式なら 9000）、Foundry は 8088 で待ち受ける約束。PORT で切り替えます（Foundry 側は azure.yaml で PORT=8088 を渡す）
ENV PORT=8080
EXPOSE 8080 8088 9000

CMD ["node_modules/.bin/tsx", "src/server.ts"]
