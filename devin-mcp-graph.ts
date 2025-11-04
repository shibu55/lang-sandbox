// DeepWiki MCP を利用したリポジトリドキュメント分析グラフ（HTTP/SSE版）
import "dotenv/config";
import { AzureChatOpenAI } from "@langchain/openai";
import { StateGraph, START, END, Annotation } from "@langchain/langgraph";
import {
  SystemMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
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
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    console.log(
      `${indent}    └─ ${dataStr.replace(/\n/g, `\n${indent}       `)}`
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
  repoName: Annotation<string>,
  userQuestion: Annotation<string>,
  wikiStructure: Annotation<any>,
  wikiContents: Annotation<string>,
  answer: Annotation<string>,
  insights: Annotation<{
    topicCount?: number;
    documentLength?: number;
    hasWiki?: boolean;
  }>,
  summary: Annotation<string>,
  error: Annotation<string>,
});

// ========================================
// モデルの定義
// ========================================
const model = new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

// ========================================
// MCP クライアント（HTTP/SSE版）
// ========================================
class MCPClient {
  private client: Client | null = null;
  private transport: SSEClientTransport | null = null;

  async connect(url: string) {
    trace("🔌 MCPサーバーに接続中...", { url });

    this.transport = new SSEClientTransport(new URL(url));

    this.client = new Client({
      name: "langgraph-client",
      version: "1.0.0",
    }, {
      capabilities: {}
    });

    await this.client.connect(this.transport);
    trace("✅ MCPサーバーに接続しました");
  }

  async listTools() {
    if (!this.client) {
      throw new Error("MCP client not connected");
    }

    const result = await this.client.listTools();
    trace("📋 利用可能なツール", { count: result.tools.length });
    return result.tools;
  }

  async callTool(name: string, args: Record<string, any>) {
    if (!this.client) {
      throw new Error("MCP client not connected");
    }

    trace(`🔧 MCPツール呼び出し: ${name}`, args);
    const result = await this.client.callTool({ name, arguments: args });
    return result;
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      trace("🔌 MCPサーバーから切断しました");
    }
  }
}

// グローバルなMCPクライアント
let mcpClient: MCPClient | null = null;

// ========================================
// DeepWiki MCP ツール呼び出し
// ========================================

async function initMCPClient() {
  if (mcpClient) {
    return mcpClient;
  }

  mcpClient = new MCPClient();

  // DeepWiki MCPサーバーに接続（HTTP/SSE）
  try {
    await mcpClient.connect("https://mcp.deepwiki.com/sse");

    // 利用可能なツールを表示
    const tools = await mcpClient.listTools();
    console.log("\n📋 利用可能なMCPツール:");
    tools.forEach(tool => {
      console.log(`  - ${tool.name}: ${tool.description || '(説明なし)'}`);
    });
    console.log("");
  } catch (error) {
    console.log("❌ DeepWiki MCPサーバーへの接続に失敗しました。");
    console.log("   エラー:", error);
    mcpClient = null;
    throw error;
  }

  return mcpClient;
}

// マークダウン形式のトピックリストをパースする
function parseTopicList(text: string): string[] {
  const lines = text.split('\n');
  const topics: string[] = [];

  for (const line of lines) {
    // "- 1 Topic Name" や "  - 1.1 Subtopic" の形式をパース
    const match = line.match(/^\s*-\s+[\d.]+\s+(.+)$/);
    if (match) {
      topics.push(match[1].trim());
    }
  }

  return topics;
}

async function readWikiStructure(repoName: string): Promise<any> {
  const client = await initMCPClient();

  if (!client) {
    throw new Error("MCP client not available");
  }

  const result = await client.callTool("read_wiki_structure", { repoName });

  // MCPレスポンスの型を考慮
  if (result.content && Array.isArray(result.content) && result.content.length > 0) {
    const content = result.content[0];

    if (typeof content === 'object' && content !== null && 'text' in content) {
      const textContent = (content as any).text;

      // マークダウン形式のトピックリストをパース
      const topics = parseTopicList(textContent);

      return {
        raw: textContent,
        topics: topics,
      };
    }
    return content;
  }
  return result.content;
}

async function readWikiContents(repoName: string): Promise<string> {
  const client = await initMCPClient();

  if (!client) {
    throw new Error("MCP client not available");
  }

  const result = await client.callTool("read_wiki_contents", { repoName });
  // MCPレスポンスの型を考慮
  if (result.content && Array.isArray(result.content) && result.content.length > 0) {
    const content = result.content[0];
    if (typeof content === 'object' && content !== null && 'text' in content) {
      return (content as any).text;
    }
    return String(content);
  }
  return String(result.content);
}

async function askQuestion(repoName: string, question: string): Promise<string> {
  const client = await initMCPClient();

  if (!client) {
    throw new Error("MCP client not available");
  }

  const result = await client.callTool("ask_question", { repoName, question });
  // MCPレスポンスの型を考慮
  if (result.content && Array.isArray(result.content) && result.content.length > 0) {
    const content = result.content[0];
    if (typeof content === 'object' && content !== null && 'text' in content) {
      return (content as any).text;
    }
    return String(content);
  }
  return String(result.content);
}

// ========================================
// グラフのノード定義
// ========================================

// 1. Wiki構造取得ノード
async function fetchWikiStructureNode(state: typeof GraphState.State) {
  traceEnter("fetchWikiStructure", { repoName: state.repoName });

  try {
    const wikiStructure = await readWikiStructure(state.repoName);

    traceExit("fetchWikiStructure", {
      topicCount: wikiStructure.topics?.length || 0
    });

    return { wikiStructure };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    traceExit("fetchWikiStructure", { error: errorMsg });
    return { error: errorMsg, wikiStructure: null };
  }
}

// 2. Wikiコンテンツ取得ノード
async function fetchWikiContentsNode(state: typeof GraphState.State) {
  traceEnter("fetchWikiContents", { repoName: state.repoName });

  try {
    const wikiContents = await readWikiContents(state.repoName);

    traceExit("fetchWikiContents", {
      length: wikiContents.length,
      preview: wikiContents.substring(0, 100) + "..."
    });

    return { wikiContents };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    traceExit("fetchWikiContents", { error: errorMsg });
    return { error: errorMsg, wikiContents: "" };
  }
}

// 3. 質問回答ノード
async function answerQuestionNode(state: typeof GraphState.State) {
  traceEnter("answerQuestion", { question: state.userQuestion });

  try {
    const answer = await askQuestion(state.repoName, state.userQuestion);

    traceExit("answerQuestion", {
      answerLength: answer.length
    });

    return { answer };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    traceExit("answerQuestion", { error: errorMsg });
    return { error: errorMsg, answer: "" };
  }
}

// 4. インサイト分析ノード
async function analyzeInsightsNode(state: typeof GraphState.State) {
  traceEnter("analyzeInsights");

  const insights = {
    topicCount: state.wikiStructure?.topics?.length || 0,
    documentLength: state.wikiContents?.length || 0,
    hasWiki: state.wikiContents ? state.wikiContents.length > 0 : false,
  };

  traceExit("analyzeInsights", insights);
  return { insights };
}

// 5. AI総合要約生成ノード
async function generateSummaryNode(state: typeof GraphState.State) {
  traceEnter("generateSummary");

  const data = {
    repository: state.repoName,
    question: state.userQuestion,
    wikiTopics: state.wikiStructure?.topics || [],
    documentLength: state.wikiContents?.length || 0,
    answer: state.answer,
    insights: state.insights,
  };

  const messages = [
    new SystemMessage(
      "あなたはGitHubリポジトリのドキュメント分析レポートを作成するアシスタントです。" +
      "提供されたデータを元に、簡潔で分かりやすいサマリーを日本語で作成してください。" +
      "ユーザーの質問に対する回答も含めてください。"
    ),
    new HumanMessage(
      `以下のリポジトリドキュメント情報を要約してください:\n\n${JSON.stringify(data, null, 2)}`
    ),
  ];

  try {
    const response = await model.invoke(messages);
    const summary = String(response.content);

    traceExit("generateSummary", { length: summary.length });
    return { summary };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    traceExit("generateSummary", { error: errorMsg });
    return { summary: `要約生成中にエラーが発生しました: ${errorMsg}` };
  }
}

// ========================================
// ルーティング関数
// ========================================
function checkError(state: typeof GraphState.State) {
  if (state.error) {
    trace(`❌ エラー検出: ${state.error}`);
    return "end";
  }
  return "continue";
}

function shouldAnswerQuestion(state: typeof GraphState.State) {
  if (state.error) {
    return "skip";
  }
  if (state.userQuestion && state.userQuestion.trim().length > 0) {
    trace(`❓ ユーザー質問あり: "${state.userQuestion}"`);
    return "answer";
  }
  trace(`ℹ️  ユーザー質問なし - スキップ`);
  return "skip";
}

// ========================================
// グラフの構築
// ========================================
const graph = new StateGraph(GraphState)
  .addNode("fetchWikiStructure", fetchWikiStructureNode)
  .addNode("fetchWikiContents", fetchWikiContentsNode)
  .addNode("answerQuestion", answerQuestionNode)
  .addNode("analyzeInsights", analyzeInsightsNode)
  .addNode("generateSummary", generateSummaryNode)
  // フロー定義
  .addEdge(START, "fetchWikiStructure")
  .addConditionalEdges("fetchWikiStructure", checkError, {
    continue: "fetchWikiContents",
    end: END,
  })
  .addEdge("fetchWikiContents", "analyzeInsights")
  // 質問がある場合のみ回答ノードを実行
  .addConditionalEdges("analyzeInsights", shouldAnswerQuestion, {
    answer: "answerQuestion",
    skip: "generateSummary",
  })
  .addEdge("answerQuestion", "generateSummary")
  .addEdge("generateSummary", END)
  .compile();

// ========================================
// 実行関数
// ========================================
async function runDocumentAnalysis(
  repoName: string,
  userQuestion?: string,
  sessionId?: string
) {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║      DeepWiki MCP リポジトリドキュメント分析グラフ        ║");
  console.log("║      (HTTP/SSE版 + Langfuse)                              ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  traceEnter("documentAnalysisAgent", { repoName, userQuestion });

  // Langfuseのコールバックハンドラーを作成
  const langfuseHandler = new CallbackHandler({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl: process.env.LANGFUSE_HOST,
    sessionId: sessionId,
    metadata: {
      environment: "demo",
      version: "deepwiki-mcp-v1",
      repoName: repoName,
    },
  });

  const result = await graph.invoke(
    {
      repoName,
      userQuestion: userQuestion || ""
    },
    {
      callbacks: [langfuseHandler],
      runName: "deepwiki_mcp_analysis",
    }
  );

  // トレースIDを取得
  const traceId = langfuseHandler.traceId;

  traceExit("documentAnalysisAgent", {
    success: !result.error,
    hasAnswer: !!result.answer,
    traceId,
  });

  // コールバックをシャットダウン
  await langfuseHandler.shutdownAsync();

  return { ...result, traceId };
}

// ========================================
// 実行例
// ========================================
async function main() {
  console.log("\n🚀 DeepWiki MCP グラフのデモ実行開始\n");
  console.log("💡 このグラフは標準MCPプロトコル（HTTP/SSE）でDeepWiki MCPサーバーと通信します\n");
  console.log("🌐 接続先: https://mcp.deepwiki.com/sse\n");

  // セッションIDを生成（全実行を1つのセッションにまとめる）
  const sessionId = `deepwiki-mcp-session-${Date.now()}`;
  console.log(`📊 Langfuseセッション: ${sessionId}\n`);

  try {
    // 例1: ドキュメント取得のみ
    console.log("\n" + "=".repeat(60));
    console.log("例1: React リポジトリのドキュメント取得");
    console.log("=".repeat(60));

    const result1 = await runDocumentAnalysis("facebook/react", undefined, sessionId);

    console.log("\n【分析結果】");
    console.log("=".repeat(60));

    if (result1.error) {
      console.log("❌ エラー:", result1.error);
    } else {
      console.log("\n📚 Wiki構造:");
      console.log(JSON.stringify(result1.wikiStructure, null, 2));

      console.log("\n📊 インサイト:");
      console.log(JSON.stringify(result1.insights, null, 2));

      console.log("\n📄 ドキュメントプレビュー:");
      console.log(result1.wikiContents?.substring(0, 300) + "...");

      console.log("\n🤖 AI要約:");
      console.log(result1.summary);

      if (result1.traceId) {
        console.log(`\n🔍 トレースID: ${result1.traceId}`);
      }
    }

    // 例2: 質問付きで実行
    console.log("\n" + "=".repeat(60));
    console.log("例2: Next.js についての質問");
    console.log("=".repeat(60));

    const result2 = await runDocumentAnalysis(
      "vercel/next.js",
      "このプロジェクトの主な特徴は何ですか？",
      sessionId
    );

    console.log("\n【分析結果】");
    console.log("=".repeat(60));

    if (result2.error) {
      console.log("❌ エラー:", result2.error);
    } else {
      console.log("\n❓ 質問:", result2.userQuestion);
      console.log("\n💬 回答:");
      console.log(result2.answer);

      console.log("\n📊 インサイト:");
      console.log(JSON.stringify(result2.insights, null, 2));

      console.log("\n🤖 AI総合要約:");
      console.log(result2.summary);

      if (result2.traceId) {
        console.log(`\n🔍 トレースID: ${result2.traceId}`);
      }
    }

    console.log("\n✅ 全ての分析が完了しました！\n");
  } finally {
    // MCPクライアントを切断
    if (mcpClient) {
      await mcpClient.disconnect();
    }
  }

  console.log("\n💡 このグラフの特徴:");
  console.log("   🔧 標準MCPプロトコルを使用（HTTP/SSE通信）");
  console.log("   🌐 DeepWiki MCPサーバーに接続 (https://mcp.deepwiki.com)");
  console.log("   📚 リポジトリのWiki/ドキュメント構造を取得");
  console.log("   📄 ドキュメント本文を取得");
  console.log("   ❓ リポジトリに関する質問に回答");
  console.log("   🤖 AIによる総合要約生成");
  console.log("   🔀 条件分岐（質問がある場合のみ回答ノード実行）");
  console.log("   📊 Langfuseで全実行を自動トレース");
  console.log(`\n🔍 Langfuseで確認: ${process.env.LANGFUSE_HOST || 'http://localhost:3000'}`);
  console.log(`   📊 2つの実行がセッションでグループ化: ${sessionId}`);
  console.log(`   📈 各ノード・エッジ・LLM呼び出しが階層構造で表示\n`);
}

main().catch(console.error);
