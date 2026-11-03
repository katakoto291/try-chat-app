// サーバーを立てずに、ターミナルからエージェントを 1 回だけ動かす。
//   npm run ask -- "東京とロンドンの天気と時刻を教えて"

import { agent, modelId, provider } from "./agent.js";

const prompt = process.argv.slice(2).join(" ") || "東京とロンドンの、今の天気と現地時刻を教えて";
console.log(`> ${prompt}  (provider=${provider}, model=${modelId})\n`);

const result = await agent.stream({ prompt });
for await (const part of result.fullStream) {
  if (part.type === "text-delta") process.stdout.write(part.text);
  else if (part.type === "tool-call") console.log(`\n[ツール呼び出し] ${part.toolName} ${JSON.stringify(part.input)}`);
  else if (part.type === "tool-result") console.log(`[ツール結果] ${JSON.stringify(part.output)}`);
  else if (part.type === "error") console.error(`\n[エラー] ${String(part.error)}`);
}
console.log();
