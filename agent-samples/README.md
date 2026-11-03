# agent-samples：同じエージェントを 3 つの SDK で作り、AgentCore と Foundry で動かす

「エージェントってどう作るの？」「Bedrock AgentCore や Microsoft Foundry で動かすってどういうこと？」を、
**同じ題材を作り比べながら**理解するためのサンプル集です。

題材は「天気と現地時刻を調べて答える旅行アシスタント」です。ツールは 2 つ（`get_weather` / `get_local_time`）だけにしています。
これを次の 3 つの SDK で作り、どれも **ローカル・AgentCore Runtime・Foundry hosted agents** の 3 か所で動くようにしています。
3 つとも **TypeScript（Node.js 22 以上）** で、ファイル構成もそろえてあるので、同じ名前のファイルを並べて見比べられます。

| フォルダ | SDK | npm パッケージ |
|---|---|---|
| [`vercel-ai-sdk/`](./vercel-ai-sdk) | Vercel AI SDK（`ToolLoopAgent`） | `ai` |
| [`strands/`](./strands) | Strands Agents（AWS 製のオープンソース） | `@strands-agents/sdk` |
| [`claude-agent-sdk/`](./claude-agent-sdk) | Claude Agent SDK（Anthropic 製。中身は Claude Code） | `@anthropic-ai/claude-agent-sdk` |

各フォルダの中身は同じ構成です。

```
src/tools.ts   ツールの中身（3 つとも同じ普通の関数）
src/model.ts   どこの Claude を使うか（Claude Agent SDK は agent.ts の中）
src/agent.ts   エージェント本体 ← ここが SDK ごとに違う
src/server.ts  AgentCore / Foundry 用の HTTP サーバー（3 つともほぼ同じ）
src/cli.ts     ターミナルから 1 回だけ動かす
```

> このリポジトリ本体（`../server`）は、SDK を使わずに Anthropic SDK でループを手書きしています。
> 「フレームワークなしだとこう書く」という比較対象として、`../server/agents/runAgent.ts` も一緒に読むと理解が深まります。

---

## 1. まず押さえたい「3 つの層」

エージェントの話がややこしく見えるのは、次の 3 つの話がごちゃまぜになりやすいからです。**この 3 つはそれぞれ別に選べます。**

```
┌────────────────────────────────────────────────────────────────────┐
│ ③ 実行基盤（どこでエージェントのプログラムを動かすか）               │
│    ローカル PC / Bedrock AgentCore Runtime / Microsoft Foundry hosted agents │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ ① フレームワーク（エージェントをどう書くか）                    │  │
│  │    Vercel AI SDK / Strands Agents / Claude Agent SDK / 手書き     │  │
│  │        │                                                       │  │
│  │        │ モデルを呼ぶ                                            │  │
│  └────────┼──────────────────────────────────────────────────────┘  │
└───────────┼──────────────────────────────────────────────────────────┘
            ▼
   ② モデルの提供元（どこの Claude を呼ぶか）
      Anthropic API / Amazon Bedrock / Microsoft Foundry
```

| 層 | 決めること | このサンプルでの切り替え方 |
|---|---|---|
| ① フレームワーク | ループの回し方、ツールの書き方 | フォルダを選ぶ |
| ② モデルの提供元 | 請求先、認証方法、使えるリージョン | 環境変数 `MODEL_PROVIDER=anthropic \| bedrock \| foundry` |
| ③ 実行基盤 | サーバー管理、スケール、セッションの分離、権限 | 同じコンテナを AgentCore / Foundry に置く |

よくある組み合わせは「**AgentCore で動かして Bedrock の Claude を呼ぶ**」「**Foundry で動かして Foundry の Claude を呼ぶ**」ですが、
仕組み上は「AgentCore で動かして Anthropic API を呼ぶ」のような組み合わせもできます。

## 2. エージェントの正体は「ループ」

どの SDK を使っても、エージェントの中でやっていることは同じです。

```
ユーザーの質問
   ▼
① モデル（Claude）を呼ぶ ◀──────────────┐
   ▼                                   │
② 返事に「ツールを使いたい」がある？      │
   ├─ ある → ③ ツールを実行して結果を会話に足す ─┘
   └─ ない → ④ その文章が最終回答
```

たとえば「東京とロンドンの天気は？」と聞くと、Claude は `get_weather("東京")` と `get_weather("ロンドン")` を呼びたいと返し、
プログラムがそれを実行して結果を渡すと、Claude がまとめた答えを返します。
**SDK はこのループと、ツールの定義（JSON Schema）作りを肩代わりしてくれる道具**です。

## 3. 3 つの SDK の違い

| | Vercel AI SDK | Strands Agents | Claude Agent SDK |
|---|---|---|---|
| 作っているところ | Vercel | AWS（オープンソース） | Anthropic |
| 言語 | TypeScript | TypeScript / Python | TypeScript / Python |
| エージェントの書き方 | `new ToolLoopAgent({ model, tools, stopWhen })` | `new Agent({ model, tools, systemPrompt })` | `query({ prompt, options })` |
| ツールの書き方 | `tool({ inputSchema: z.object(...), execute })` | `tool({ name, inputSchema: z.object(...), callback })` | `tool()` を「プロセス内 MCP サーバー」にまとめる |
| モデルの切り替え | プロバイダ（`@ai-sdk/anthropic` など）を差し替え | `AnthropicModel` / `BedrockModel` を差し替え | 環境変数（`CLAUDE_CODE_USE_BEDROCK` など） |
| 得意なこと | Web アプリ（Next.js など）との一体化、多数のモデル | AWS との連携、マルチエージェント、すぐ使えるツール集 | **ファイル操作・Bash・Web 検索などの組み込みツール**、長い作業 |
| 中身 | ライブラリ | ライブラリ | Claude Code を子プロセスとして起動 |

ポイント:

- **Vercel AI SDK と Strands** は「ループを回してくれる薄めのライブラリ」です。ツールは基本的に自分で書きます。
- **Claude Agent SDK** は「Claude Code そのもの」をライブラリにしたものです。ファイルを読む・書く・コマンドを実行するといった
  組み込みツールが最初から入っていて、コーディングや調べ物のような長い作業が得意です。
  このサンプルでは安全のため組み込みツールを全部外し（`tools: []`）、自作ツールだけを渡しています。

## 4. 実行基盤の「約束」はほぼ同じ

AgentCore Runtime も Foundry hosted agents も、やることは **「コンテナを預かって、HTTP でリクエストを転送してくれる」** です。
コンテナの中で「約束どおりの HTTP サーバー」を動かせば、中身がどの SDK でも構いません。

| | Bedrock AgentCore Runtime | Microsoft Foundry hosted agents |
|---|---|---|
| 呼び出し | `POST /invocations` | `POST /invocations`（invocations プロトコル） |
| ヘルスチェック | `GET /ping` → `{"status": "Healthy", ...}` | `GET /readiness` → 200 |
| ポート | 8080 | 8088（`PORT` で変更可） |
| CPU | **ARM64**（イメージを arm64 でビルドする） | 指定なし |
| セッション | ヘッダー `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`。セッションごとに分離された環境（microVM）で動く | クエリ `agent_session_id`（ヘッダー `x-agent-session-id` で返る） |
| 公式の補助ライブラリ（Python 用） | `bedrock-agentcore`（`BedrockAgentCoreApp`） | `azure-ai-agentserver-invocations`（`InvocationAgentServerHost`） |
| デプロイ | ECR に push → `create-agent-runtime`（`scripts/agentcore-deploy.sh`） | Azure Developer CLI（`azd deploy`、`azure.yaml`） |
| Claude を呼ぶ権限 | ランタイムの **実行ロール（IAM）** | エージェントの **マネージド ID（Entra ID）** |

違いはヘルスチェックのパスとポート番号くらいです。そこで、このサンプルでは `/ping` と `/readiness` の両方に答える
小さなサーバー（Hono）を `src/server.ts` に書き、ポートは環境変数 `PORT` で切り替えています。
これで **1 つのコンテナイメージをそのまま両方の基盤に載せられます**。
（公式の補助ライブラリは Python 用なので、TypeScript では約束を自分で満たします。といっても数十行です。）

### リクエストとレスポンス（3 サンプル共通）

```jsonc
// リクエスト（POST /invocations）
{ "prompt": "東京とロンドンの天気と時刻を教えて", "stream": false }

// レスポンス（stream: false）
{ "framework": "strands", "provider": "bedrock", "model": "...",
  "result": "東京は晴れで…", "toolCalls": [{ "name": "get_weather", "input": { "city": "東京" } }, ...] }
```

`"stream": true` にすると、途中経過が SSE（`text/event-stream`）で 1 つずつ届きます。

```
data: {"type":"tool_call","name":"get_weather","input":{"city":"東京"}}
data: {"type":"text","text":"東京は"}
data: {"type":"text","text":"晴れで…"}
data: {"type":"done","framework":"vercel-ai-sdk",...}
```

---

## 5. ローカルで動かす

### 準備

- Node.js 22 以上
- 使う Claude の認証情報（どれか 1 つ）
  - **Anthropic API**: `ANTHROPIC_API_KEY`
  - **Bedrock**: AWS の認証情報（`aws configure` や `aws sso login`）と、Bedrock コンソールで Anthropic のモデルを有効化しておくこと
  - **Foundry**: Foundry のリソース名（`ANTHROPIC_FOUNDRY_RESOURCE`）と、Claude のデプロイ。API キー（`ANTHROPIC_FOUNDRY_API_KEY`）か `az login`

### 実行（3 サンプルとも同じ手順）

```bash
cd agent-samples/strands              # または vercel-ai-sdk / claude-agent-sdk
npm install
cp .env.example .env                  # MODEL_PROVIDER と認証情報を記入
npm run ask -- "東京とロンドンの天気と時刻を教えて"   # 1 回だけ実行
npm run dev                           # http://localhost:8080 で HTTP サーバーを起動
PORT=8088 npm run dev                 # Foundry と同じポートで起動したいとき
```

### サーバーを試す

```bash
./scripts/smoke-test.sh http://localhost:8080   # /ping, /readiness, /invocations を順に呼ぶ
```

### コンテナで試す

```bash
docker build -t agent-strands ./strands
docker run --rm -p 8080:8080 --env-file strands/.env agent-strands
```

---

## 6. Bedrock AgentCore Runtime にデプロイする

### 必要なもの

- AWS CLI v2（AgentCore のコマンドが入っている新しいもの）、Docker（buildx）、jq
- AgentCore が使えるリージョン（例: `us-east-1`）と、そのリージョンで Bedrock の Claude が有効になっていること

### デプロイ

```bash
cd agent-samples
export AWS_REGION=us-east-1
./scripts/agentcore-deploy.sh strands          # vercel-ai-sdk / claude-agent-sdk も同じ
```

スクリプトがやっていることは、AgentCore にデプロイする最小の手順そのものです（中身にコメントを書いてあります）。

1. ECR にリポジトリを作る
2. **ARM64** のイメージをビルドして push する（`docker buildx build --platform linux/arm64`）
3. 実行ロール（IAM）を作る。ECR からの取得、ログ出力、Bedrock の Claude の呼び出しを許可
4. `aws bedrock-agentcore-control create-agent-runtime` でランタイムを作る（2 回目以降は `update-agent-runtime`）。
   環境変数で `MODEL_PROVIDER=bedrock` を渡すので、エージェントは実行ロールの権限で Bedrock の Claude を呼びます

モデルを変えたいときは `MODEL_ID=us.anthropic.claude-sonnet-5-5 ./scripts/agentcore-deploy.sh strands` のように指定します
（Bedrock のモデル ID は `anthropic.` が付き、多くの場合 `us.` / `eu.` / `apac.` / `global.` などの推論プロファイルの接頭辞も付けます）。

### 呼び出し

```bash
./scripts/agentcore-invoke.sh <デプロイ時に表示された ARN> "東京の天気は？"
```

AWS が受けたリクエストは、コンテナの `POST /invocations` にそのまま届きます。
`SESSION_ID=...` を付けて同じ値で呼び続けると、同じセッション（同じコンテナ）に振り分けられます。

### 補足

- AWS には、Python 用の `bedrock-agentcore-starter-toolkit`（`agentcore` コマンド）という、ここまでの手順をまとめて行うツールもあります。
  このサンプルでは「何が起きているか」を見せるため、あえて AWS CLI で 1 つずつ書いています。
- AgentCore にはコンテナの代わりに zip でコードを渡す方法（Python / Node.js 22）もあります。
- 片付けは `aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id <ID>` と、ECR リポジトリ・IAM ロールの削除です。

---

## 7. Microsoft Foundry（hosted agents）にデプロイする

### 必要なもの

- [Azure Developer CLI（azd）](https://aka.ms/azd) と、その AI エージェント拡張（`azd extension install azure.ai.agents`）
- Foundry のリソースとプロジェクト
- そのリソースにある **Claude のデプロイ**（Foundry ポータルのモデルカタログから作る。デプロイ名を控えておく）

### デプロイ

`agent-samples/azure.yaml` に 3 つのサンプルを hosted agent として登録してあります。

```bash
cd agent-samples
azd auth login
azd env new claude-agent-samples
azd env set CLAUDE_DEPLOYMENT_NAME claude-opus-5-5   # Foundry で作った Claude のデプロイ名
azd provision                                         # Foundry のプロジェクトなどを用意
azd deploy strands-agent                              # 1 つだけ。全部なら azd deploy
```

`azd deploy` は、Dockerfile からイメージをビルドして（`remoteBuild: true` なので Azure 側でビルド）、Foundry に hosted agent として登録します。
環境変数で `MODEL_PROVIDER=foundry` と `PORT=8088` を渡しています。Claude のリソース名は、Foundry がコンテナに自動で入れる
`FOUNDRY_PROJECT_ENDPOINT` から取り出すので、設定は不要です。

### 権限の設定（大事）

エージェントは API キーを使わず、**エージェント自身のマネージド ID（Entra ID）** で Claude を呼びます。
そのため、デプロイ後に「そのマネージド ID が Claude を呼んでよい」という権限を付ける必要があります。
付けないと、エージェントは起動しても Claude の呼び出しで `401` になります。

```bash
# <PRINCIPAL_ID> は Foundry ポータルのエージェントの詳細などで確認できる、エージェントの実行 ID
az role assignment create \
  --assignee-object-id <PRINCIPAL_ID> --assignee-principal-type ServicePrincipal \
  --role "Foundry User" \
  --scope "/subscriptions/<SUB_ID>/resourceGroups/<RG>/providers/Microsoft.CognitiveServices/accounts/<リソース名>"
```

（Microsoft の公式サンプル [claude-agent-sdk hosted agent](https://github.com/microsoft-foundry/foundry-samples/tree/main/samples/python/hosted-agents/bring-your-own/invocations/claude-agent-sdk) と同じ手順です。反映まで数分かかることがあります。）

### 呼び出し

```bash
azd ai agent invoke '{"prompt": "東京の天気は？"}'
```

Foundry ポータルの Agent Playground からも試せます。ローカルで Foundry と同じ形で動かすなら `azd ai agent run` も使えます。
細かいオプションは azd のバージョンで変わるので、`azd ai agent --help` で確認してください。

### 補足

- Microsoft の公式サンプルは Python と C# だけです。このサンプルは「Dockerfile を指定してコンテナとして載せる」形にしていますが、
  TypeScript は公式に例のない構成なので、azd のバージョンによっては `azure.yaml` の調整が必要になるかもしれません。
- Foundry の Claude は、デプロイ時に「Azure 上で動かす」か「Anthropic の基盤で動かす」かを選べます（hosting option）。

---

## 8. 知っておきたい注意点

- **会話は覚えていません。** どのサンプルも 1 回のリクエストで完結します（リクエストごとに新しいエージェントを作ります）。
  会話を続けるには、セッション ID ごとに履歴を保存して次の呼び出しに渡す必要があります（AgentCore Memory や Foundry の会話機能などを使う）。
- **料金**: 既定のモデルは `claude-opus-5-5` です。試すだけなら `MODEL_ID` で `claude-sonnet-5-5` や `claude-haiku-5-5`（Bedrock なら `us.anthropic.claude-haiku-5-5` など）にすると安くなります。
- **ループの上限**: ツールを呼び続けて止まらない事故を防ぐため、Vercel AI SDK は `stopWhen`、Claude Agent SDK は `maxTurns` で上限を付けています。
  Strands の TypeScript 版には同じ形の設定が見当たらなかったので付けていません（必要ならフックやプラグインで止める形になります）。
- **Claude Agent SDK の組み込みツール**: サーバーに置くエージェントで Bash やファイル書き込みを許すと、プロンプト次第で何でもできてしまいます。
  使うときは `tools` / `allowedTools` で必要なものだけに絞り、隔離された環境（AgentCore のセッションごとの microVM など）で動かしてください。
- **公開範囲**: AgentCore / Foundry にデプロイしたエージェントは、既定ではそれぞれのクラウドの認証（IAM / Entra ID）がないと呼べません。

## 9. このリポジトリで確認したこと・していないこと

- 3 サンプルとも、TypeScript の型チェックは通っています。
- Claude API の形を真似た偽のサーバーを使い、ツール呼び出し → 最終回答のループ、`/ping`・`/readiness`・`/invocations`（JSON と SSE）が動くことを確認しています。
  Foundry の Entra ID 方式（API キーの代わりに `Authorization: Bearer` を付ける）も、トークン取得だけ差し替えて確認しています。
- **本物の Claude、AWS、Azure へのデプロイは試していません。** コンテナのビルドもこの環境では未確認です。
  AWS CLI の引数は AWS の API 定義、Foundry の設定は Microsoft の公式サンプルに合わせていますが、初回は手順どおりに動くか確認しながら進めてください。

## 10. 次の一歩

- **AgentCore の他の機能**: Memory（会話の記憶）、Gateway（API を MCP のツールにする）、Identity（外部サービスの認証）など
- **Foundry の他の機能**: Toolbox（Web 検索や MCP サーバーをまとめて使う）、responses プロトコル、A2A
- **プロトコル**: AgentCore Runtime は HTTP のほかに MCP / A2A / AG-UI のサーバーも載せられます。
  このリポジトリ本体（`../server`）の MCP・A2A・AG-UI の実装と組み合わせると、「エージェント同士の呼び出し」をクラウド上で試せます。

## 参考リンク

- Vercel AI SDK: https://ai-sdk.dev/docs/agents/overview
- Strands Agents: https://strandsagents.com/
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview
  （Bedrock: https://code.claude.com/docs/en/amazon-bedrock 、Foundry: https://code.claude.com/docs/en/microsoft-foundry ）
- Bedrock AgentCore Runtime のサービス契約: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
- Foundry hosted agents: https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents
- Foundry hosted agents の公式サンプル: https://github.com/microsoft-foundry/foundry-samples/tree/main/samples/python/hosted-agents
