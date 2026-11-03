"""Strands Agents でのエージェント定義。

Strands は AWS が公開しているオープンソースのエージェント SDK です。
Agent(model, tools, system_prompt) を作って呼ぶだけで、
「モデルを呼ぶ → ツールを実行 → 結果を渡してまた呼ぶ」のループを回してくれます。

どこの Claude を使うかは MODEL_PROVIDER で切り替えます（他の 2 サンプルと同じ）。
  anthropic … Anthropic の API を直接（ANTHROPIC_API_KEY）
  bedrock   … Amazon Bedrock の Claude（AWS の認証情報）
  foundry   … Microsoft Foundry の Claude（API キー or Entra ID）
"""

import os
from typing import Any, AsyncIterator
from urllib.parse import urlparse

from dotenv import load_dotenv

load_dotenv()  # ローカルでは .env を読む（コンテナでは環境変数がそのまま使われる）

from strands import Agent, tool  # noqa: E402
from strands.models import Model  # noqa: E402

import tools as travel  # noqa: E402

DEFAULT_MODEL = {
    "anthropic": "claude-opus-5-5",
    "bedrock": "us.anthropic.claude-opus-5-5",  # 推論プロファイル ID（リージョンに合わせて us./eu./apac./global.）
    "foundry": "claude-opus-5-5",  # Foundry の「デプロイ名」
}

PROVIDER = os.environ.get("MODEL_PROVIDER", "anthropic").lower()
if PROVIDER not in DEFAULT_MODEL:
    raise ValueError(f"MODEL_PROVIDER は anthropic / bedrock / foundry のどれかにしてください（今: {PROVIDER}）")
MODEL_ID = os.environ.get("MODEL_ID") or DEFAULT_MODEL[PROVIDER]
MAX_TOKENS = 16000


def create_model() -> Model:
    if PROVIDER == "bedrock":
        from strands.models import BedrockModel

        # boto3 が AWS の認証情報を自動で探します（環境変数 → ~/.aws → 実行ロール）。
        # AgentCore Runtime 上では、ランタイムに付けた「実行ロール」の権限で Bedrock を呼びます。
        return BedrockModel(
            model_id=MODEL_ID,
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            max_tokens=MAX_TOKENS,
        )

    from strands.models.anthropic import AnthropicModel

    if PROVIDER == "anthropic":
        return AnthropicModel(model_id=MODEL_ID, max_tokens=MAX_TOKENS)  # ANTHROPIC_API_KEY を自動で読む

    # foundry: Strands の AnthropicModel の「中身のクライアント」を Foundry 用に差し替える
    from anthropic import AsyncAnthropicFoundry

    model = AnthropicModel(model_id=MODEL_ID, max_tokens=MAX_TOKENS, client_args={"api_key": "unused"})
    model.client = _foundry_client(AsyncAnthropicFoundry)
    return model


def _foundry_client(client_cls: Any) -> Any:
    base_url = os.environ.get("ANTHROPIC_FOUNDRY_BASE_URL")
    resource = os.environ.get("ANTHROPIC_FOUNDRY_RESOURCE")
    if not resource and os.environ.get("FOUNDRY_PROJECT_ENDPOINT"):
        # Foundry hosted agents の中では FOUNDRY_PROJECT_ENDPOINT が自動で入るので、そこからリソース名を取り出せる
        resource = urlparse(os.environ["FOUNDRY_PROJECT_ENDPOINT"]).hostname.split(".")[0]
    if not base_url and not resource:
        raise ValueError("ANTHROPIC_FOUNDRY_RESOURCE（リソース名）を設定してください")
    target = {"base_url": base_url} if base_url else {"resource": resource}

    if os.environ.get("ANTHROPIC_FOUNDRY_API_KEY"):
        return client_cls(api_key=os.environ["ANTHROPIC_FOUNDRY_API_KEY"], **target)

    # API キーがなければ Entra ID（az login やマネージド ID）のトークンで認証する
    from azure.identity import DefaultAzureCredential, get_bearer_token_provider

    token_provider = get_bearer_token_provider(DefaultAzureCredential(), "https://ai.azure.com/.default")
    return client_cls(azure_ad_token_provider=token_provider, **target)


# --- ツール -----------------------------------------------------------------
# @tool を付けると、関数名・引数の型・docstring からツールの定義（JSON Schema）が自動で作られます
@tool
def get_weather(city: str) -> dict:
    """指定した都市の今日の天気を調べる。

    Args:
        city: 都市名（例: 東京、ロンドン）
    """
    return travel.get_weather(city)


@tool
def get_local_time(city: str) -> dict:
    """指定した都市の現在の現地時刻を調べる。

    Args:
        city: 都市名（例: 東京、ロンドン）
    """
    return travel.get_local_time(city)


_model = create_model()


def create_agent() -> Agent:
    """リクエストごとに新しい Agent を作る。

    Agent は会話履歴を自分の中に持つので、使い回すと別の人の会話が混ざります。
    会話を続けたいときは、セッション ID ごとに Agent（または履歴）を保存して使い分けます。
    """
    return Agent(
        model=_model,
        system_prompt=travel.INSTRUCTIONS,
        tools=[get_weather, get_local_time],
        callback_handler=None,  # 既定では標準出力に途中経過を書くので、オフにする
    )


async def run(prompt: str) -> dict:
    """最後まで実行して、答えとツール呼び出しの一覧を返す。"""
    agent = create_agent()
    tool_calls: list[dict] = []
    text = ""
    async for event in stream(prompt, agent):
        if event["type"] == "tool_call":
            tool_calls.append({"name": event["name"], "input": event["input"]})
        elif event["type"] == "result":
            text = event["result"]
    return {"result": text, "toolCalls": tool_calls}


async def stream(prompt: str, agent: Agent | None = None) -> AsyncIterator[dict]:
    """Strands のイベントを、3 サンプル共通のイベントの形に変換して流す。"""
    agent = agent or create_agent()
    async for event in agent.stream_async(prompt):
        if "data" in event:  # 文章の断片
            yield {"type": "text", "text": event["data"]}
        elif "message" in event and event["message"].get("role") == "assistant":
            for block in event["message"].get("content", []):
                if "toolUse" in block:
                    yield {"type": "tool_call", "name": block["toolUse"]["name"], "input": block["toolUse"]["input"]}
        elif "result" in event:  # 最後に AgentResult が届く
            yield {"type": "result", "result": str(event["result"]).strip()}
