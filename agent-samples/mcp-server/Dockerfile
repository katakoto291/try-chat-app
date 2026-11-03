# MCP サーバーのコンテナ。Bedrock AgentCore Runtime に「MCP サーバー」として載せるときは
# ARM64 でビルドし、ポート 8000 の /mcp で待ち受けます（scripts/agentcore-deploy.sh mcp-server）。
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV PORT=8000
EXPOSE 8000

CMD ["node_modules/.bin/tsx", "src/server.ts"]
