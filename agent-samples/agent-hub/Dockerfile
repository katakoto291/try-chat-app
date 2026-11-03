# agent-hub のコンテナ。ふつうの Web サービスなので、App Runner・ECS・Azure Container Apps など
# どこに置いても動きます。ポート 8090。公開するときは HUB_TOKEN を必ず設定してください。
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src

ENV PORT=8090
EXPOSE 8090

CMD ["node_modules/.bin/tsx", "src/server.ts"]
