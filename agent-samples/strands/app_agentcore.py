"""Bedrock AgentCore Runtime 用の入り口（公式 SDK: bedrock-agentcore）。

BedrockAgentCoreApp が AgentCore の約束どおりの HTTP サーバーを作ってくれます。
  POST /invocations … @app.entrypoint の関数が呼ばれる
  GET  /ping        … ヘルスチェック（自動）
  ポート 8080
"""

from bedrock_agentcore.runtime import BedrockAgentCoreApp

import agent

app = BedrockAgentCoreApp()
META = {"framework": "strands", "provider": agent.PROVIDER, "model": agent.MODEL_ID}


@app.entrypoint
async def invoke(payload: dict, context):
    """payload はリクエストの JSON。例: {"prompt": "東京の天気は？", "stream": true}"""
    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"error": 'リクエストは {"prompt": "..."} の形で送ってください'}

    # context.session_id は AgentCore が付けるセッション ID（会話のまとまり）
    print(f"[invoke] session={context.session_id} prompt={prompt!r}", flush=True)

    if payload.get("stream"):
        # 非同期ジェネレーターを返すと、SDK が自動で SSE（text/event-stream）にしてくれる
        async def events():
            async for event in agent.stream(prompt):
                yield event
            yield {"type": "done", **META}

        return events()

    return {**META, **(await agent.run(prompt))}


if __name__ == "__main__":
    app.run()  # 0.0.0.0:8080
