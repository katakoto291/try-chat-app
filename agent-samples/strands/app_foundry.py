"""Microsoft Foundry hosted agents 用の入り口（公式 SDK: azure-ai-agentserver-invocations）。

InvocationAgentServerHost が Foundry の「invocations プロトコル」どおりの HTTP サーバーを作ってくれます。
  POST /invocations … @app.invoke_handler の関数が呼ばれる
  GET  /readiness   … ヘルスチェック（自動）
  ポート 8088（環境変数 PORT で変更可）

AgentCore 版（app_agentcore.py）と見比べると、エージェント本体（agent.py）は
まったく同じで、入り口の書き方だけが違うことが分かります。
"""

import json

from azure.ai.agentserver.invocations import InvocationAgentServerHost
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse

import agent

app = InvocationAgentServerHost()
META = {"framework": "strands", "provider": agent.PROVIDER, "model": agent.MODEL_ID}


@app.invoke_handler
async def handle(request: Request) -> Response:
    try:
        payload = await request.json()
        prompt = (payload.get("prompt") or "").strip()
    except Exception:
        prompt = ""
    if not prompt:
        return JSONResponse({"error": 'リクエストは {"prompt": "..."} の形で送ってください'}, status_code=400)

    # request.state.session_id は Foundry が付けるセッション ID
    print(f"[invoke] session={request.state.session_id} prompt={prompt!r}", flush=True)

    if payload.get("stream"):

        async def events():
            async for event in agent.stream(prompt):
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done', **META}, ensure_ascii=False)}\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    return JSONResponse({**META, **(await agent.run(prompt))})


if __name__ == "__main__":
    app.run()  # 0.0.0.0:${PORT:-8088}
