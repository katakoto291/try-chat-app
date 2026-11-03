# agent-hub（エージェントの登録所）

エージェントを「どこにいて、何ができて、今動いているか」と一緒に登録しておき、
使う側には **ハブの URL 1 つだけ** を教えれば済むようにするサンプルです。
全体の説明は [../README.md](../README.md) を見てください。

```
チャットアプリ ──┐                         ┌─ 旅行アシスタント（ローカル / Foundry など）
Claude Code   ──┼──▶  agent-hub  ─────────┼─ 観光プランナー
別のエージェント ─┘   ・一覧と自己紹介         └─ AgentCore 上のエージェント（ハブが IAM の署名を付けて呼ぶ）
                     ・生きているかの確認
                     ・呼び出しの中継（認証の肩代わり）
                     ・MCP サーバーとしても公開
```

## ハブがあると何が変わるか

チャットアプリは、外部エージェントを 2 通りの方法で知ることができます（`server/external/registry.ts`）。

| | 設定から（`EXTERNAL_AGENTS`） | ハブから（`AGENT_HUB_URL`） |
|---|---|---|
| 使う側が知っていること | 全エージェントの URL | ハブの URL だけ |
| エージェントを増やすとき | 使う側の設定を全部書き換える | ハブに 1 回登録するだけ |
| 生きているかの確認 | 呼んでから失敗に気づく | ハブが 30 秒ごとに確認し、止まっているものは一覧で分かる |
| 相手ごとの認証（AgentCore の IAM など） | 使う側がそれぞれ実装する | ハブが代わりに付ける |
| 使う側が増えたとき（Slack ボットなど） | それぞれに同じ設定が要る | ハブの URL を教えるだけ |
| 動かすもの | 増えない | ハブが 1 つ増える（ハブが止まると全部呼べない） |

エージェントも使う側も少ないうちは「設定から」で十分です。増えてきたらハブを考えます。

## API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/agents` | 一覧（名前・説明・できること・状態・呼び出し用のパス） |
| GET | `/agents/:id` | 1 つのエージェントの自己紹介（Agent Card） |
| POST | `/agents` | 登録（下の表）。相手が合言葉を求めるなら `"bearerToken"` も |
| DELETE | `/agents/:id` | 登録を外す |
| POST | `/agents/:id/invocations` | 呼び出しの中継。本文も、途中経過の SSE も、そのまま流す |
| POST | `/mcp` | ハブ自身の MCP サーバー（`list_agents` / `call_agent`） |
| GET | `/ping` | ハブ自身の死活確認（合言葉なしで呼べる） |

## 登録のしかた（呼び方 2 つ × 置き場所 2 つ）

| | `/invocations` 方式 | A2A 方式 |
|---|---|---|
| ふつうの HTTP | `{"url": "http://localhost:8080"}` | `{"a2aUrl": "http://localhost:8080/"}` |
| AgentCore Runtime | `{"agentCoreArn": "arn:..."}` | `{"agentCoreArn": "arn:...", "protocol": "a2a"}` |
| `HUB_AGENTS` での書き方 | `http://...` / `arn:...` | `a2a:http://...` / `a2a:arn:...` |

- A2A 方式のエージェントは、標準の Agent Card（AgentCore なら AWS の `GetAgentCard` API）で自己紹介を読みます。
- 呼ぶ側には、どちらの方式でも同じ形（`POST /agents/:id/invocations` の SSE）で見せます。A2A の相手には、ハブが A2A で頼んで結果を変換します（`src/a2a.ts`）。

## 動かす

```bash
npm install
cp .env.example .env      # HUB_AGENTS に登録したいエージェントの URL を並べる
npm run dev               # http://localhost:8090

curl localhost:8090/agents                                   # 一覧
curl -X POST localhost:8090/agents -H 'content-type: application/json' \
  -d '{"url": "http://localhost:8082"}'                      # あとから登録
```

チャットアプリ側は `.env` に `AGENT_HUB_URL=http://localhost:8090` を書くだけで、外部エージェントの一覧と呼び出しがハブ経由になります
（`HUB_TOKEN` を設定したら、チャットアプリには同じ値を `AGENT_HUB_TOKEN` で渡します）。

## 読む順番

1. `src/registry.ts` — 台帳。登録（自己紹介を読む）、呼び出し（相手に応じて認証を付ける）、死活確認
2. `src/server.ts` — HTTP の API。中継は「受けた本文を相手に送って、返ってきたものをそのまま流す」だけ
3. `src/a2a.ts` — A2A の相手を呼んで、結果を `/invocations` と同じ形に直す部分
4. `src/mcp.ts` — ハブを MCP サーバーとして見せる部分
5. `src/sigv4.ts` — AgentCore のエージェントを呼ぶための AWS の署名

## 作りのポイント

- **自己紹介は `POST /invocations {"action":"describe"}` で読みます。** AgentCore や Foundry に置いたエージェントは、
  `/invocations` 以外のパスに外から届かないためです（各サンプルの `src/card.ts`）。
- **生きているかの確認**: ふつうのエージェントは `GET /ping`（だめなら `/readiness`）。AgentCore のエージェントは `/ping` を外から叩けないので、自己紹介を聞けるかで代わりに確かめます。
  起動時に登録できなかったエージェントも、30 秒ごとに登録をやり直します。
- **ハブ自身を MCP サーバーにする**と、Claude Code などの MCP クライアントからも全エージェントを呼べます。
  ```bash
  claude mcp add --transport http agent-hub http://localhost:8090/mcp
  ```
  MCP のツールは 1 往復なので、`call_agent` は途中経過を流さず、最終回答だけを返します。
- 登録は**メモリにだけ**持っています。ハブを再起動すると、`HUB_AGENTS` 以外の登録は消えます。本番では DB に保存します。

## 本番で考えること（このサンプルではやっていないこと）

- 登録の保存（DB）と、ハブ自身を複数台にする（どれか 1 台が止まっても使えるように）
- 「このアプリはこのエージェントだけ呼べる」といった、使う側ごとの権限
- 合言葉ではなく OAuth（Entra ID や Cognito のトークン）での認証
- 呼び出しの記録と、エージェントごとの利用量・料金の集計
- エージェントの版の管理（v1 から v2 へ少しずつ切り替えるなど）
