import type { BetaMessage, BetaMessageParam, ModelCall, ModelClient } from "./types.js";

/**
 * API キーがなくても「エージェント間の呼び出し」の流れを体験できるモック。
 * 本物の Claude と同じ形（tool_use / tool_result）のメッセージを返すので、
 * エージェントのループ（runAgent.ts）は本物と全く同じコードで動く。
 */
export class MockModelClient implements ModelClient {
  readonly mode = "mock";

  async call({ model, system, messages, tools, onText, signal }: ModelCall): Promise<BetaMessage> {
    const toolNames = new Set(tools.map((t) => t.name));
    const last = messages[messages.length - 1];
    const toolResults = collectToolResults(last);
    const reply = async (text: string, toolUses: { name: string; input: Record<string, string> }[] = []) => {
      await streamText(text, onText, signal);
      return message(
        model,
        [
          { type: "text", text },
          ...toolUses.map((t, i) => ({ type: "tool_use" as const, id: `toolu_mock_${Date.now()}_${i}`, ...t })),
        ],
        toolUses.length > 0 ? "tool_use" : "end_turn",
      );
    };

    // 1) 直前がツール結果 → 結果をまとめて回答する
    if (toolResults.length > 0) {
      if (toolNames.has("publish_event")) return reply("（モック）イベントを発行しました。購読しているエージェントの結果を待ちます。");
      return reply(summarize(system, toolResults));
    }

    const userText = textOf(last);
    const isCode = /コード|code|プログラム|関数|実装|スクリプト|python|javascript|typescript/i.test(userText);
    const isLong = userText.length > 12;

    // Pub/Sub の 2 回目: 購読していたイベントの結果が届いた
    if (userText.startsWith("[購読していたイベントが届きました]")) {
      return reply(`（モック）届いたイベントの結果をまとめました。\n\n${userText.replace(/^\[購読していたイベントが届きました\]\s*/, "").replace(/\n\nこれらを統合して[\s\S]*$/, "")}`);
    }

    // 2) ハンドオフ: transfer_to_* を持っていれば、条件に応じて引き継ぐ
    if (toolNames.has("transfer_to_coder") && isCode) {
      return reply("コードの依頼なので、コーダーに引き継ぎます。", [{ name: "transfer_to_coder", input: { reason: "コードの作成依頼" } }]);
    }
    if (toolNames.has("transfer_to_researcher") && isLong) {
      return reply("調べものなので、リサーチャーに引き継ぎます。", [{ name: "transfer_to_researcher", input: { reason: "調査して説明してほしい依頼" } }]);
    }
    if (toolNames.has("transfer_to_reviewer")) {
      return reply(`（モック）コードを書きました。\n\n${SAMPLE_CODE}\n\nレビュアーに確認してもらいます。`, [
        { name: "transfer_to_reviewer", input: { reason: "書いたコードのレビュー" } },
      ]);
    }
    if (toolNames.has("transfer_to_writer") && system.includes("リサーチ担当")) {
      return reply(`${directAnswer(system, userText)}\n\n文章に仕上げるため、ライターに引き継ぎます。`, [
        { name: "transfer_to_writer", input: { reason: "調査結果を読みやすい文章にする" } },
      ]);
    }

    // 3) Pub/Sub: publish_event を持っていれば、依頼内容に応じたトピックに発行する
    if (toolNames.has("publish_event") && (isCode || isLong)) {
      const topic = isCode ? "code.requested" : "research.requested";
      return reply(`${topic} を発行します。`, [{ name: "publish_event", input: { topic, content: userText } }]);
    }

    // 4) 呼び出し: call_* を持っていれば、他のエージェントを呼ぶ
    const calls: { name: string; task: string }[] = [];
    if (toolNames.has("call_coder") && isCode) {
      calls.push({ name: "call_coder", task: `次の要望に合うコードを書いてください: ${userText}` });
    } else if (toolNames.has("call_reviewer")) {
      calls.push({ name: "call_reviewer", task: `次のコードをレビューしてください:\n${SAMPLE_CODE}` });
    } else if (toolNames.has("call_researcher") && toolNames.has("call_writer") && isLong) {
      // 独立した 2 つの依頼を同じターンで並列に呼ぶ例
      calls.push({ name: "call_researcher", task: `「${userText}」について要点を調べてください。` });
      calls.push({ name: "call_writer", task: `「${userText}」について、初心者向けの短い説明文を書いてください。` });
    }
    if (calls.length > 0) {
      return reply(
        `専門エージェントに依頼します: ${calls.map((c) => c.name.replace("call_", "")).join("、")}`,
        calls.map((c) => ({ name: c.name, input: { task: c.task } })),
      );
    }

    // 5) 自分で直接答える
    return reply(directAnswer(system, userText));
  }
}

const SAMPLE_CODE = "```python\ndef fizzbuzz(n):\n    for i in range(1, n + 1):\n        print('FizzBuzz' if i % 15 == 0 else 'Fizz' if i % 3 == 0 else 'Buzz' if i % 5 == 0 else i)\n```";

function directAnswer(system: string, userText: string): string {
  if (system.includes("リサーチ担当")) {
    return `（モック）リサーチ結果:\n- 依頼内容: ${userText.slice(0, 60)}\n- 要点1: モックモードなので実際の調査はしていません\n- 要点2: ANTHROPIC_API_KEY を設定すると本物の Claude が回答します`;
  }
  if (system.includes("ライター担当")) {
    return `（モック）ライターの文章:\nこれはライターエージェントが書いた説明文の見本です。実際には依頼内容「${userText.slice(0, 40)}…」に沿った文章が入ります。`;
  }
  if (system.includes("コードレビュー担当")) {
    return "（モック）レビュー結果:\n- 1 行が長いので if/elif に分けると読みやすい\n- n が 0 以下のときの扱いを決めておくとよい";
  }
  if (system.includes("プログラミング担当")) {
    return `（モック）コードを書きました。\n\n${SAMPLE_CODE}`;
  }
  return `（モック）こんにちは！「${userText}」を受け取りました。\n長めの質問を送ると リサーチャー と ライター に、「コード」を含む依頼を送ると コーダー → レビュアー に仕事が振り分けられる様子を右側のトレースで確認できます。`;
}

function summarize(system: string, results: string[]): string {
  if (system.includes("プログラミング担当")) {
    return `（モック）レビューの指摘を反映した最終版です。\n\n\`\`\`python\ndef fizzbuzz(n):\n    for i in range(1, n + 1):\n        if i % 15 == 0:\n            print("FizzBuzz")\n        elif i % 3 == 0:\n            print("Fizz")\n        elif i % 5 == 0:\n            print("Buzz")\n        else:\n            print(i)\n\`\`\`\n\nレビュー内容:\n${results.join("\n")}`;
  }
  return `（モック）専門エージェントの結果をまとめました。\n\n${results.map((r, i) => `### 結果 ${i + 1}\n${r}`).join("\n\n")}`;
}

function collectToolResults(msg: BetaMessageParam | undefined): string[] {
  if (!msg || typeof msg.content === "string") return [];
  return msg.content.flatMap((b) =>
    b.type === "tool_result" ? [typeof b.content === "string" ? b.content : JSON.stringify(b.content)] : [],
  );
}

function textOf(msg: BetaMessageParam | undefined): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}

async function streamText(text: string, onText: (d: string) => void, signal: AbortSignal) {
  for (let i = 0; i < text.length; i += 3) {
    if (signal.aborted) throw new Error("aborted");
    onText(text.slice(i, i + 3));
    await new Promise((r) => setTimeout(r, 12));
  }
}

function message(model: string, content: unknown[], stop_reason: "end_turn" | "tool_use"): BetaMessage {
  // 学習用のモックなので、UI とループが使うフィールドだけを埋める
  return {
    id: `msg_mock_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as BetaMessage;
}
