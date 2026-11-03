// サーバーを立てずに、ターミナルからエージェントを 1 回だけ動かす。
//   npm run ask -- "東京とロンドンの天気と時刻を教えて"

import { modelId, provider, runAgent, toEvents } from "./agent.js";

const prompt = process.argv.slice(2).join(" ") || "東京とロンドンの、今の天気と現地時刻を教えて";
console.log(`> ${prompt}  (provider=${provider}, model=${modelId})\n`);

for await (const message of runAgent(prompt)) {
  for (const ev of toEvents(message)) {
    if (ev.type === "text") process.stdout.write(ev.text);
    else if (ev.type === "tool_call") console.log(`\n[ツール呼び出し] ${ev.name} ${JSON.stringify(ev.input)}`);
    else if (ev.type === "result") console.log(`\n\n(ターン数: ${ev.turns}, 概算コスト: $${ev.costUsd.toFixed(4)})`);
    else if (ev.type === "error") console.error(`\n[エラー] ${ev.error}`);
  }
}
