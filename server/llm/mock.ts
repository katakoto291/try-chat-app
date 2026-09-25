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

    // 1) 直前がツール結果 → 結果をまとめて最終回答を返す
    if (toolResults.length > 0) {
      const text = summarize(system, toolResults);
      await streamText(text, onText, signal);
      return message(model, [{ type: "text", text }], "end_turn");
    }

    const userText = textOf(last);

    // 2) 他のエージェントを呼べるなら、ツール呼び出し（= エージェント呼び出し）を返す
    const calls: { name: string; task: string }[] = [];
    if (toolNames.has("call_coder") && /コード|code|プログラム|関数|実装|スクリプト|python|javascript|typescript/i.test(userText)) {
      calls.push({ name: "call_coder", task: `次の要望に合うコードを書いてください: ${userText}` });
    } else if (toolNames.has("call_reviewer")) {
      calls.push({ name: "call_reviewer", task: `次のコードをレビューしてください:\n${SAMPLE_CODE}` });
    } else if (toolNames.has("call_researcher") && toolNames.has("call_writer") && userText.length > 12) {
      // 独立した 2 つの依頼を同じターンで並列に呼ぶ例
      calls.push({ name: "call_researcher", task: `「${userText}」について要点を調べてください。` });
      calls.push({ name: "call_writer", task: `「${userText}」について、初心者向けの短い説明文を書いてください。` });
    }

    if (calls.length > 0) {
      const preface = `専門エージェントに依頼します: ${calls.map((c) => c.name.replace("call_", "")).join("、")}`;
      await streamText(preface, onText, signal);
      return message(
        model,
        [
          { type: "text", text: preface },
          ...calls.map((c, i) => ({
            type: "tool_use" as const,
            id: `toolu_mock_${Date.now()}_${i}`,
            name: c.name,
            input: { task: c.task },
          })),
        ],
        "tool_use",
      );
    }

    // 3) 自分で直接答える
    const text = directAnswer(system, userText);
    await streamText(text, onText, signal);
    return message(model, [{ type: "text", text }], "end_turn");
  }
}

const SAMPLE_CODE = "```python\ndef fizzbuzz(n):\n    for i in range(1, n + 1):\n        print('FizzBuzz' if i % 15 == 0 else 'Fizz' if i % 3 == 0 else 'Buzz' if i % 5 == 0 else i)\n```";

function directAnswer(system: string, userText: string): string {
  if (system.includes("リサーチ")) {
    return `（モック）リサーチ結果:\n- 依頼内容: ${userText.slice(0, 60)}\n- 要点1: モックモードなので実際の調査はしていません\n- 要点2: ANTHROPIC_API_KEY を設定すると本物の Claude が回答します`;
  }
  if (system.includes("ライター")) {
    return `（モック）ライターの文章:\nこれはライターエージェントが書いた説明文の見本です。実際には依頼内容「${userText.slice(0, 40)}…」に沿った文章が入ります。`;
  }
  if (system.includes("レビュー")) {
    return "（モック）レビュー結果:\n- 1 行が長いので if/elif に分けると読みやすい\n- n が 0 以下のときの扱いを決めておくとよい";
  }
  return `（モック）こんにちは！「${userText}」を受け取りました。\n長めの質問を送ると リサーチャー と ライター に、「コード」を含む依頼を送ると コーダー → レビュアー に仕事が振り分けられる様子を右側のトレースで確認できます。`;
}

function summarize(system: string, results: string[]): string {
  if (system.includes("プログラミング")) {
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
