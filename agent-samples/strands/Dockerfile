# Bedrock AgentCore Runtime と Microsoft Foundry hosted agents のどちらでも動くコンテナ。
# AgentCore は ARM64 のイメージが必要なので、ビルド時に --platform linux/arm64 を付けます（scripts/agentcore-deploy.sh 参照）。
FROM python:3.13-slim

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY *.py ./

# HOSTING=agentcore（既定, ポート 8080）か HOSTING=foundry（ポート 8088）。Foundry 側は azure.yaml で指定します
ENV HOSTING=agentcore PYTHONUNBUFFERED=1
EXPOSE 8080 8088

CMD ["python", "main.py"]
