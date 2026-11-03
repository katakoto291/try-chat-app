# agent-samples：同じエージェントを 3 つの SDK で作り、AgentCore と Foundry で動かす

「エージェントってどう作るの？」「Bedrock AgentCore や Microsoft Foundry で動かすってどういうこと？」を、
**同じ題材を作り比べながら**理解するためのサンプル集です。

> 全体の関係を図で見たいときは **[全体構成ガイド（docs/ARCHITECTURE.md）](../docs/ARCHITECTURE.md)** をどうぞ。

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

さらに、**ツールを MCP サーバーに切り出して、別のエージェントから使う** 例もあります（[11 章](#11-mcp-サーバーと-2-つ目のエージェント)）。

| フォルダ | 中身 |
|---|---|
| [`mcp-server/`](./mcp-server) | 観光スポットを検索できる MCP サーバー（ツール・リソース・プロンプト） |
| [`trip-planner/`](./trip-planner) | MCP サーバーのツールを使って日帰りプランを作る 2 つ目のエージェント（Strands） |
| [`agent-hub/`](./agent-hub) | エージェントの登録所。一覧・死活確認・呼び出しの中継・MCP 公開（[12 章](#12-チャットアプリから使う外部エージェントと-agent-hub)） |

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

- すべてのフォルダで TypeScript の型チェックは通っています。
- Claude API の形を真似た偽のサーバーを使い、ツール呼び出し → 最終回答のループ、`/ping`・`/readiness`・`/invocations`（JSON と SSE）が動くことを確認しています。
  Foundry の Entra ID 方式（API キーの代わりに `Authorization: Bearer` を付ける）も、トークン取得だけ差し替えて確認しています。
- チャットアプリ（モックモード）から、設定（`EXTERNAL_AGENTS`）経由と agent-hub 経由の両方で外部エージェントを呼べること、
  トレース画面に外部エージェントとその中のツール呼び出しが表示されることを確認しています。
  agent-hub の一覧・登録・中継（SSE）・MCP 公開・死活確認（止めたエージェントが unhealthy になる）も確認しています。
  ハブから AgentCore のエージェントを呼ぶ部分（SigV4）は、実際の AWS では試していません。
- A2A: 4 つのエージェントを A2A の SDK クライアントから呼べること（Agent Card の取得、タスクの状態の変化、ツール呼び出しの通知、成果物）、
  agent-hub に `/invocations` 方式と A2A 方式を混ぜて登録し、どちらも同じ形で呼べること、
  チャットアプリ → ハブ → 観光プランナー（A2A）の流れを確認しています。AgentCore の A2A 方式・GetAgentCard は実際の AWS では試していません。
- MCP サーバーは、新しい形式（v2）と従来の形式（v1）の両方の MCP クライアントから使えることを確認しています。
  観光プランナーからの呼び出しは、認証なし・Bearer トークン・SigV4（署名が付くところまで）を確認しています。
  11 章の 3 つの SDK からつなぐコードも、型チェックと偽サーバーでの呼び出しを確認しています。
- **本物の Claude、AWS、Azure へのデプロイは試していません。** コンテナのビルドもこの環境では未確認です。
  AWS CLI の引数は AWS の API 定義、Foundry の設定は Microsoft の公式サンプルに合わせていますが、初回は手順どおりに動くか確認しながら進めてください。

## 10. 次の一歩

- **AgentCore の他の機能**: Memory（会話の記憶）、Gateway（API を MCP のツールにする）、Identity（外部サービスの認証）など
- **Foundry の他の機能**: Toolbox（Web 検索や MCP サーバーをまとめて使う）、responses プロトコル、A2A
- **プロトコル**: AgentCore Runtime は HTTP のほかに MCP / A2A / AG-UI のサーバーも載せられます。
  このリポジトリ本体（`../server`）の MCP・A2A・AG-UI の実装と組み合わせると、「エージェント同士の呼び出し」をクラウド上で試せます。

## 11. MCP サーバーと 2 つ目のエージェント

ここまでの 3 サンプルは、ツールをエージェントのコードの中に書いていました。
ツールが増えてきたり、**同じツールを複数のエージェントで使いたく** なったりしたら、ツールを MCP サーバーに切り出します。

```
 観光プランナー（trip-planner/）               MCP サーバー（mcp-server/）
 ┌────────────────────────────┐   tools/list   ┌──────────────────────────┐
 │ Claude                     │ ─────────────▶ │ search_spots             │
 │  ├ get_weather（自分で持つ）│   tools/call   │ get_spot_details         │
 │  └ MCP のツール（借りる）   │ ─────────────▶ │（本物なら DB や社内 API）│
 └────────────────────────────┘                └──────────────────────────┘
          ▲ 同じ MCP サーバーを、Vercel AI SDK・Claude Agent SDK・Claude Code などからも使える
```

- **[`mcp-server/`](./mcp-server)**: 観光スポットの検索ツールを公開する MCP サーバー。MCP の 3 種類（ツール・リソース・プロンプト）を 1 つずつ持たせています
- **[`trip-planner/`](./trip-planner)**: 2 つ目のエージェント。天気は自分のツール、観光スポットは MCP サーバーのツールで調べて、日帰りプランを作ります

### 動かす

```bash
cd agent-samples/mcp-server && npm install && npm run dev        # ターミナル 1（:8000）
cd agent-samples/trip-planner && npm install && cp .env.example .env
npm run ask -- "雨でも楽しめる大阪の日帰りプランを作って"          # ターミナル 2
```

### 3 つの SDK それぞれでの MCP のつなぎ方

どの SDK も「MCP サーバーの URL を渡すと、ツールの一覧を取ってきて Claude に渡す」部分をやってくれます。

```ts
// Strands（trip-planner/src/agent.ts）
const mcp = new McpClient({ url: "http://localhost:8000/mcp" });
const agent = new Agent({ model, tools: [getWeatherTool, mcp] });

// Vercel AI SDK（npm install @ai-sdk/mcp）
const mcp = await createMCPClient({ transport: { type: "http", url: "http://localhost:8000/mcp" } });
const agent = new ToolLoopAgent({ model, tools: { ...(await mcp.tools()) }, stopWhen: stepCountIs(8) });
// 使い終わったら await mcp.close()

// Claude Agent SDK
query({
  prompt,
  options: {
    mcpServers: { spots: { type: "http", url: "http://localhost:8000/mcp" } },
    allowedTools: ["mcp__spots__search_spots", "mcp__spots__get_spot_details"],
  },
});
```

### クラウドに置くとき

| | Bedrock AgentCore | Azure / Foundry |
|---|---|---|
| MCP サーバーの置き場所 | AgentCore Runtime に **MCP サーバーとして** 置ける（プロトコル `MCP`、ポート 8000 の `/mcp`） | hosted agents には置けないので、Azure Container Apps などに置く |
| エージェント → MCP サーバーの認証 | IAM（SigV4）。エージェントの実行ロールに `bedrock-agentcore:InvokeAgentRuntime` を付ける | Bearer トークン（学習用の合言葉。本番は OAuth / Entra ID） |
| 手順 | `./scripts/agentcore-deploy.sh mcp-server` → 表示された URL を `MCP_SERVER_URL` にして `trip-planner` をデプロイ | Container Apps に置く → `azd env set MCP_SERVER_URL ...` → `azd deploy trip-planner-agent` |

AgentCore には、既存の API や Lambda を MCP のツールに変換して一か所にまとめる **AgentCore Gateway** もあります。
Foundry には、Web 検索や MCP サーバーなどのツールをまとめて 1 つの MCP の口にする **Toolbox** があります。
ツールが増えてきたら、こうした「ツールの集約」の仕組みも検討してください。

## 12. チャットアプリから使う（外部エージェントと agent-hub）

このリポジトリ本体のチャットアプリ（`../server`）から、ここのエージェントを「外部エージェント」として呼べます。
「呼び出し」パターンのとき、司令塔に `call_ext_<id>` というツールが増え、依頼内容に合えば司令塔が自分で選んで呼びます。

```
チャット画面 ─▶ 司令塔（チャットアプリの中）
                 ├─ call_researcher など … アプリの中のエージェント
                 └─ call_ext_trip-planner … 別のサーバーの観光プランナー ─▶ MCP サーバー
```

トレース画面には、外部エージェントが「via 外部（HTTP）」として表示されます。相手の中で何が起きたかは、
相手が SSE で教えてくれた範囲（ツール呼び出し・文章）だけが見えます。

### 各エージェントの自己紹介（Agent Card）

呼ぶ側が「誰が・何をできるか」を知るため、各エージェントは自己紹介を返します（各フォルダの `src/card.ts`）。

```bash
curl localhost:8080/.well-known/agent-card.json                     # ローカルなど、パスがそのまま届く場所
curl -X POST localhost:8080/invocations -d '{"action":"describe"}'  # AgentCore / Foundry など、/invocations しか届かない場所
```

A2A の Agent Card を参考にした形ですが、呼び出しは A2A ではなく `POST /invocations` です。

### つなぎ方 1: 設定から（`EXTERNAL_AGENTS`）

```bash
# 外部エージェントを起動（それぞれ別のターミナルで）
cd agent-samples/mcp-server   && npm run dev                   # :8000
cd agent-samples/strands      && npm run dev                   # :8080 旅行アシスタント
cd agent-samples/trip-planner && PORT=8081 npm run dev         # :8081 観光プランナー

# チャットアプリ（リポジトリのルート）
EXTERNAL_AGENTS=http://localhost:8080,http://localhost:8081 npm run dev
```

チャットアプリが起動後、各 URL の自己紹介を読み、サイドバーの「外部エージェント」に表示します。
「東京で雨でも楽しめる日帰りプランを作って」と送ると、司令塔が観光プランナーを呼びます。

### つなぎ方 2: agent-hub から（`AGENT_HUB_URL`）

```bash
cd agent-samples/agent-hub && HUB_AGENTS=http://localhost:8080,http://localhost:8081 npm run dev   # :8090

# チャットアプリ
AGENT_HUB_URL=http://localhost:8090 npm run dev
```

チャットアプリはハブの URL しか知りません。一覧はハブの `GET /agents`、呼び出しはハブの `POST /agents/:id/invocations` です。
エージェントの追加・場所の変更・認証方式の違い（AgentCore の IAM など）・止まっているかどうかは、ハブが引き受けます。
2 つのつなぎ方の違いは [agent-hub の README](./agent-hub/README.md) にまとめてあります。

### 注意点

- **Vercel に置いたチャットアプリからは、手元の PC（localhost）のエージェントやハブには届きません。** クラウドに置いたものの URL を設定してください。
- 外部エージェントは、それぞれ自分の設定（`MODEL_PROVIDER` など）で Claude を呼びます。チャットアプリがモックモードでも、**外部エージェントは本物の Claude を呼ぶ**ので料金がかかります。
- 外部エージェントを呼べるのは司令塔だけで、「呼び出し」パターンのときだけです（ハンドオフや Pub/Sub では出てきません）。
- 外部エージェントは会話の履歴を知りません。司令塔が依頼文（task）に前提を書いて渡します。

## 13. A2A 版: エージェント同士の標準のつなぎ方

`/invocations` は AgentCore / Foundry がそれぞれ決めた「実行基盤への入り口」で、自己紹介の方法も決まっていません。
そこで、各エージェントは **A2A（Agent2Agent Protocol）** でも呼べるようにしてあります。A2A は標準なので、
A2A に対応したどのクライアントからも同じ方法で自己紹介を読み、仕事を頼めます。

| | `/invocations` | A2A |
|---|---|---|
| 入り口 | `POST /invocations` | `POST /`（JSON-RPC） |
| 自己紹介 | 決まりなし（このリポジトリでは `{"action":"describe"}`） | `GET /.well-known/agent-card.json`（標準の Agent Card） |
| 途中経過 | 中身は自由（このリポジトリでは独自の SSE） | タスクの状態の変化（作業中・完了・失敗）と成果物（Artifact） |
| AgentCore に置くと | HTTP 方式（ポート 8080） | A2A 方式（ポート 9000）。Agent Card は AWS の `GetAgentCard` API でも取れる |

同じサーバーが両方に答えるので、コードはそのままで、どちらの方式でも置けます（共通部品は各サンプルの `src/a2a.ts`）。

### A2A のタスクの進み方

```
task（受け付けた） → statusUpdate（作業中）
  → statusUpdate（作業中 + ツール呼び出しの情報）… ツールを呼ぶたびに
  → artifactUpdate（回答の文章を少しずつ）
  → statusUpdate（完了）
```

ツール呼び出しは、A2A の「data パート」（構造化データ）として `{"type":"tool_call","name":...,"input":...}` を載せています。
A2A の仕様で決まっている形ではなく、このサンプル集での約束です。

### 試す

```bash
# エージェントの自己紹介（標準の Agent Card）
curl localhost:8080/.well-known/agent-card.json

# agent-hub に A2A 方式で登録する（a2a: を付ける）
HUB_AGENTS=http://localhost:8080,a2a:http://localhost:8081/ npm run dev   # agent-hub で
```

ハブは、A2A 方式で登録したエージェントを A2A で呼び、結果を `/invocations` と同じ形の SSE に直して返します。
そのため、チャットアプリは相手が A2A かどうかを気にせずに使えます。

### クラウドで A2A を使う

- **AgentCore**: `AGENT_PROTOCOL=A2A ./scripts/agentcore-deploy.sh strands`。A2A 方式のランタイムになり、
  `aws bedrock-agentcore get-agent-card --agent-runtime-arn <ARN>` で Agent Card を取れます。
  ハブには `HUB_AGENTS=a2a:<ARN>` で登録します（ハブが IAM の署名を付けて A2A で呼びます）。
  Agent Card に載せる「外から見た URL」は、デプロイスクリプトが環境変数 `AGENT_URL` で渡します。
- **Foundry**: Foundry の A2A は、Foundry が用意する窓口（ゲートウェイ）です。エージェントのコードは responses プロトコルで書き、
  `azure.yaml` に `agentCard` を書くと、Foundry が A2A の窓口と Agent Card を用意します。
  このサンプルのエージェントは invocations プロトコルなので、Foundry の A2A は使っていません（`azure.yaml` の先頭に説明があります）。

## 参考リンク

- Vercel AI SDK: https://ai-sdk.dev/docs/agents/overview
- Strands Agents: https://strandsagents.com/
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview
  （Bedrock: https://code.claude.com/docs/en/amazon-bedrock 、Foundry: https://code.claude.com/docs/en/microsoft-foundry ）
- Bedrock AgentCore Runtime のサービス契約: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-service-contract.html
- Foundry hosted agents: https://learn.microsoft.com/azure/foundry/agents/concepts/hosted-agents
- Foundry hosted agents の公式サンプル: https://github.com/microsoft-foundry/foundry-samples/tree/main/samples/python/hosted-agents
- MCP（Model Context Protocol）: https://modelcontextprotocol.io/
- A2A（Agent2Agent Protocol）: https://a2a-protocol.org/
