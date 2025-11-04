// 複雑なグラフ構造のデモ - Langfuse自動トレース版
import "dotenv/config";
import { AzureChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import {
  SystemMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { CallbackHandler } from "langfuse-langchain";

// ========================================
// トレースユーティリティ
// ========================================
let traceDepth = 0;
const trace = (message: string, data?: any) => {
  const indent = "  ".repeat(traceDepth);
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`${indent}[${timestamp}] ${message}`);
  if (data) {
    console.log(
      `${indent}    └─ ${JSON.stringify(data, null, 2).replace(/\n/g, `\n${indent}       `)}`
    );
  }
};

const traceEnter = (name: string, input?: any) => {
  trace(`▶ ${name} 開始`, input);
  traceDepth++;
};

const traceExit = (name: string, output?: any) => {
  traceDepth--;
  trace(`◀ ${name} 終了`, output);
};

// ========================================
// グラフのState定義
// ========================================
const GraphState = Annotation.Root({
  input: Annotation<string>,
  category: Annotation<"math" | "text" | "data" | "unknown">,
  confidence: Annotation<number>,
  processed: Annotation<boolean>,
  path: Annotation<string>,
  response: Annotation<string>,
  enrichments: Annotation<{
    sentiment?: string;
    complexity?: string;
    tags?: string[];
  }>,
  summary: Annotation<string>,
  timestamp: Annotation<string>,
});

// ========================================
// モデルとツールの定義
// ========================================
const model = new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

// データ分析ツール
const analyzeData = tool(
  ({ data }) => {
    const sum = data.reduce((a: number, b: number) => a + b, 0);
    const avg = sum / data.length;
    const max = Math.max(...data);
    const min = Math.min(...data);
    return JSON.stringify({ sum, avg, max, min, count: data.length });
  },
  {
    name: "analyzeData",
    description: "Analyze an array of numbers and return statistics",
    schema: z.object({
      data: z.array(z.number()).describe("Array of numbers to analyze"),
    }),
  }
);

// テキスト処理ツール
const processText = tool(
  ({ text, operation }) => {
    switch (operation) {
      case "uppercase":
        return text.toUpperCase();
      case "lowercase":
        return text.toLowerCase();
      case "reverse":
        return text.split("").reverse().join("");
      case "length":
        return `Length: ${text.length}`;
      default:
        return text;
    }
  },
  {
    name: "processText",
    description: "Process text with various operations",
    schema: z.object({
      text: z.string().describe("Text to process"),
      operation: z
        .enum(["uppercase", "lowercase", "reverse", "length"])
        .describe("Operation to perform"),
    }),
  }
);

// 計算ツール
const calculate = tool(
  ({ expression }) => {
    try {
      const result = Function(`"use strict"; return (${expression})`)();
      return `Result: ${result}`;
    } catch (e) {
      return `Error: ${e}`;
    }
  },
  {
    name: "calculate",
    description: "Calculate a mathematical expression",
    schema: z.object({
      expression: z.string().describe("Mathematical expression to evaluate"),
    }),
  }
);

const toolsByName = {
  [analyzeData.name]: analyzeData,
  [processText.name]: processText,
  [calculate.name]: calculate,
};
const tools = Object.values(toolsByName);
const modelWithTools = model.bindTools(tools);

// ========================================
// グラフのノード定義（シンプル版 - Langfuseが自動トレース）
// ========================================

// 1. 入力分類ノード
async function classifyInputNode(state: typeof GraphState.State) {
  traceEnter("classifyInput", { input: state.input });

  const messages = [
    new SystemMessage(
      'ユーザーの入力を次のカテゴリのいずれかに分類してください: "math"（数学）, "text"（テキスト処理）, "data"（データ分析）, "unknown"（不明）。' +
        'JSONオブジェクトのみで回答してください: {"category": "...", "confidence": 0.0-1.0}'
    ),
    new HumanMessage(state.input),
  ];

  const response = await model.invoke(messages);
  const content =
    typeof response.content === "string" ? response.content : "";

  let category: "math" | "text" | "data" | "unknown" = "unknown";
  let confidence = 0.5;

  try {
    const parsed = JSON.parse(content);
    category = parsed.category || "unknown";
    confidence = parsed.confidence || 0.5;
  } catch {
    // Keep defaults
  }

  traceExit("classifyInput", { category, confidence });

  return {
    category,
    confidence,
  };
}

// 2. 数学処理ノード
async function processMathNode(state: typeof GraphState.State) {
  traceEnter("processMath", { input: state.input });

  const messages = [
    new SystemMessage(
      "あなたは数学の専門家です。calculateツールを使って問題を解いてください。"
    ),
    new HumanMessage(state.input),
  ];

  const response = await modelWithTools.invoke(messages);

  // ツール呼び出しを実行
  let responseText = "";
  if (response.tool_calls && response.tool_calls.length > 0) {
    trace(`🔧 ${response.tool_calls.length} 個のツール呼び出し`);
    for (const toolCall of response.tool_calls) {
      trace(`  → ${toolCall.name}`, toolCall.args);
      const tool = toolsByName[toolCall.name];
      const result = await tool.invoke(toolCall);
      trace(`  ← Result`, result.content);
      responseText = String(result.content);
    }
  }

  traceExit("processMath", { processed: true });

  return {
    processed: true,
    path: "math",
    response: responseText,
  };
}

// 3. テキスト処理ノード
async function processTextNode(state: typeof GraphState.State) {
  traceEnter("processTextPath", { input: state.input });

  const messages = [
    new SystemMessage(
      "あなたはテキスト処理の専門家です。processTextツールを使ってテキストを操作してください。"
    ),
    new HumanMessage(state.input),
  ];

  const response = await modelWithTools.invoke(messages);

  // ツール呼び出しを実行
  let responseText = "";
  if (response.tool_calls && response.tool_calls.length > 0) {
    trace(`🔧 ${response.tool_calls.length} 個のツール呼び出し`);
    for (const toolCall of response.tool_calls) {
      trace(`  → ${toolCall.name}`, toolCall.args);
      const tool = toolsByName[toolCall.name];
      const result = await tool.invoke(toolCall);
      trace(`  ← Result`, result.content);
      responseText = String(result.content);
    }
  }

  traceExit("processTextPath", { processed: true });

  return {
    processed: true,
    path: "text",
    response: responseText,
  };
}

// 4. データ分析ノード
async function processDataNode(state: typeof GraphState.State) {
  traceEnter("processDataPath", { input: state.input });

  const messages = [
    new SystemMessage(
      "あなたはデータアナリストです。入力から数値を抽出してanalyzeDataツールを使って分析してください。"
    ),
    new HumanMessage(state.input),
  ];

  const response = await modelWithTools.invoke(messages);

  // ツール呼び出しを実行
  let responseText = "";
  if (response.tool_calls && response.tool_calls.length > 0) {
    trace(`🔧 ${response.tool_calls.length} 個のツール呼び出し`);
    for (const toolCall of response.tool_calls) {
      trace(`  → ${toolCall.name}`, toolCall.args);
      const tool = toolsByName[toolCall.name];
      const result = await tool.invoke(toolCall);
      trace(`  ← Result`, result.content);
      responseText = String(result.content);
    }
  }

  traceExit("processDataPath", { processed: true });

  return {
    processed: true,
    path: "data",
    response: responseText,
  };
}

// 5. 並列拡張処理ノード
async function enrichDataNode(state: typeof GraphState.State) {
  traceEnter("enrichData", { category: state.category });

  // 並列で複数の拡張処理を実行
  const enrichments = await Promise.all([
    // 追加分析1: センチメント
    (async () => {
      trace("並列タスク1: センチメント分析");
      return { sentiment: Math.random() > 0.5 ? "positive" : "neutral" };
    })(),
    // 追加分析2: 複雑度
    (async () => {
      trace("並列タスク2: 複雑度評価");
      return { complexity: state.input.length > 20 ? "high" : "low" };
    })(),
    // 追加分析3: タグ付け
    (async () => {
      trace("並列タスク3: タグ生成");
      return { tags: ["processed", state.category, "v1"] };
    })(),
  ]);

  const enrichmentData = Object.assign({}, ...enrichments);

  traceExit("enrichData", enrichmentData);

  return {
    enrichments: enrichmentData,
  };
}

// 6. 結果要約ノード
async function summarizeResultsNode(state: typeof GraphState.State) {
  traceEnter("summarizeResults", { path: state.path });

  const stateForSummary = {
    input: state.input,
    category: state.category,
    confidence: state.confidence,
    processed: state.processed,
    path: state.path,
    response: state.response,
    enrichments: state.enrichments,
  };

  const messages = [
    new SystemMessage(
      "以下の処理結果を簡潔に要約してください。日本語で回答してください。"
    ),
    new HumanMessage(JSON.stringify(stateForSummary, null, 2)),
  ];

  const response = await model.invoke(messages);

  traceExit("summarizeResults", { hasSummary: true });

  return {
    summary: String(response.content),
    timestamp: new Date().toISOString(),
  };
}

// ========================================
// ルーティング関数（条件分岐）
// ========================================
function routeByCategory(state: typeof GraphState.State) {
  trace(`🔀 ルーティング → ${state.category} パス`);

  switch (state.category) {
    case "math":
      return "processMath";
    case "text":
      return "processText";
    case "data":
      return "processData";
    default:
      return "enrichData";
  }
}

// ========================================
// グラフの構築
// ========================================
const graph = new StateGraph(GraphState)
  .addNode("classifyInput", classifyInputNode)
  .addNode("processMath", processMathNode)
  .addNode("processText", processTextNode)
  .addNode("processData", processDataNode)
  .addNode("enrichData", enrichDataNode)
  .addNode("summarizeResults", summarizeResultsNode)
  .addEdge(START, "classifyInput")
  .addConditionalEdges("classifyInput", routeByCategory, [
    "processMath",
    "processText",
    "processData",
    "enrichData",
  ])
  .addEdge("processMath", "enrichData")
  .addEdge("processText", "enrichData")
  .addEdge("processData", "enrichData")
  .addEdge("enrichData", "summarizeResults")
  .addEdge("summarizeResults", END)
  .compile();

// ========================================
// 実行関数
// ========================================
async function runComplexGraph(input: string, sessionId?: string) {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║      複雑なグラフ実行 - Langfuse自動トレース              ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  traceEnter("complexAgent", { input });

  // Langfuseのコールバックハンドラーを作成
  // セッションIDを指定すると、複数実行を1つのセッションにグループ化できる
  const langfuseHandler = new CallbackHandler({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST,
    sessionId: sessionId,
    metadata: {
      environment: "demo",
      version: "auto-trace-v1",
    },
  });

  // グラフ実行時にコールバックを渡すだけ！
  // LangGraphが自動的にノード・エッジ・ツール呼び出しをトレース
  const result = await graph.invoke(
    { input },
    {
      callbacks: [langfuseHandler],
      runName: "complex_graph_execution", // トレース名をカスタマイズ
    }
  );

  // トレースIDを取得
  const traceId = langfuseHandler.trace?.id;

  traceExit("complexAgent", { path: result.path, traceId });
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║        グラフ実行完了                                      ║");
  if (traceId) {
    console.log(`║        トレースID: ${traceId.substring(0, 32)}...║`);
  }
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // コールバックをシャットダウン
  await langfuseHandler.shutdownAsync();

  return result;
}

// ========================================
// 実行例
// ========================================
console.log("\n🚀 複雑なグラフのデモ実行開始 (Langfuse自動トレース版)\n");
console.log("💡 各ノード、エッジ、ツール呼び出しが自動的にトレースされます\n");

// セッションIDを生成（全3つの実行を1つのセッションにまとめる）
const sessionId = `demo-session-${Date.now()}`;

// 例1: 数学
console.log("\n" + "=".repeat(60));
console.log("例1: 数学処理");
console.log("=".repeat(60));
const result1 = await runComplexGraph("123 × 456 + 789 を計算してください", sessionId);

console.log("\n【最終結果】");
console.log(
  JSON.stringify(
    {
      category: result1.category,
      path: result1.path,
      response: result1.response,
      summary: result1.summary,
    },
    null,
    2
  )
);

// 例2: テキスト
console.log("\n" + "=".repeat(60));
console.log("例2: テキスト処理");
console.log("=".repeat(60));
const result2 = await runComplexGraph("「hello world」を大文字に変換してください", sessionId);

console.log("\n【最終結果】");
console.log(
  JSON.stringify(
    {
      category: result2.category,
      path: result2.path,
      response: result2.response,
      summary: result2.summary,
    },
    null,
    2
  )
);

// 例3: データ分析
console.log("\n" + "=".repeat(60));
console.log("例3: データ分析");
console.log("=".repeat(60));
const result3 = await runComplexGraph("次の数値を分析してください: 10, 20, 30, 40, 50", sessionId);

console.log("\n【最終結果】");
console.log(
  JSON.stringify(
    {
      category: result3.category,
      path: result3.path,
      response: result3.response,
      summary: result3.summary,
    },
    null,
    2
  )
);

console.log("\n✅ 全ての例の実行が完了しました！\n");

console.log("🔍 Langfuseで確認: http://localhost:3000\n");
console.log("   📊 各実行が1つの通貫したトレースとして自動記録");
console.log("   🔗 3つの実行がセッションでグループ化: " + sessionId);
console.log("   📈 ノード、エッジ、ツール呼び出しが階層構造で表示\n");
