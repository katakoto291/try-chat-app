# Strands Agents 版（Python）

[Strands Agents](https://strandsagents.com/) で作った旅行アシスタントです。全体の説明は [../README.md](../README.md) を見てください。

## 読む順番

1. `tools.py` — ツールの中身（天気・現地時刻）。他のサンプルと同じ普通の関数
2. `agent.py` — エージェント本体とモデルの切り替え（`MODEL_PROVIDER`）
3. `app_agentcore.py` — **AgentCore 用**の入り口（公式 SDK `bedrock-agentcore`）
4. `app_foundry.py` — **Foundry 用**の入り口（公式 SDK `azure-ai-agentserver-invocations`）
5. `main.py` — `HOSTING` を見て、3 か 4 のどちらかを起動する（コンテナの入り口）
6. `cli.py` — ターミナルから 1 回だけ動かす

3 と 4 を見比べると、**エージェント本体（`agent.py`）はまったく同じで、入り口だけが違う** ことが分かります。

## 動かす

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                  # MODEL_PROVIDER と認証情報を記入
python cli.py "東京とロンドンの天気と時刻を教えて"
python main.py                        # AgentCore 用（:8080）
HOSTING=foundry python main.py        # Foundry 用（:8088）
```

## この SDK のポイント

- `@tool` を付けた関数が、そのままツールになります。関数名・引数の型ヒント・docstring から、ツールの定義（JSON Schema）が自動で作られます。
- `Agent(model=..., tools=[...], system_prompt=...)` を作って呼ぶだけでループが回ります。
  `agent.stream_async()` で途中経過（文章の断片・ツール呼び出し）を受け取れます。
- `Agent` は会話履歴を自分の中に持つので、**リクエストごとに作り直しています**。使い回すと別の人の会話が混ざります。
- モデルは `BedrockModel`（Bedrock）と `AnthropicModel`（Anthropic API）を差し替えます。
  Foundry は `AnthropicModel` の中のクライアントを Anthropic SDK の `AsyncAnthropicFoundry` に差し替えて使っています。
- AgentCore 用の `BedrockAgentCoreApp` は、エントリーポイントの関数が **ジェネレーターを返すと自動で SSE にしてくれる** など、
  AgentCore で動かすための細かい部分（`/ping`、セッション ID、実行中の `HealthyBusy` など）を引き受けてくれます。
