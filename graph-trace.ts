// Step 1: Define tools and model

import "dotenv/config";
import { AzureChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import * as z from "zod";
import { CallbackHandler } from "langfuse-langchain";

// Langfuse callback handler for tracing
const langfuseHandler = new CallbackHandler({
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  baseUrl: process.env.LANGFUSE_HOST,
});

const model = new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
  callbacks: [langfuseHandler], // Add Langfuse tracing
});

// Define tools
const add = tool(({ a, b }) => a + b, {
  name: "add",
  description: "Add two numbers",
  schema: z.object({
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  }),
});

const multiply = tool(({ a, b }) => a * b, {
  name: "multiply",
  description: "Multiply two numbers",
  schema: z.object({
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  }),
});

const divide = tool(({ a, b }) => a / b, {
  name: "divide",
  description: "Divide two numbers",
  schema: z.object({
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  }),
});

// Augment the LLM with tools
const toolsByName = {
  [add.name]: add,
  [multiply.name]: multiply,
  [divide.name]: divide,
};
const tools = Object.values(toolsByName);
const modelWithTools = model.bindTools(tools);

// Step 2: Define state

import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";

// Step 3: Define model node

import { SystemMessage } from "@langchain/core/messages";
async function llmCall(state: typeof MessagesAnnotation.State) {
  const messagesToSend = [
    new SystemMessage(
      "You are a helpful assistant tasked with performing arithmetic on a set of inputs."
    ),
    ...state.messages,
  ];

  // プロンプトを出力
  console.log("\n━━━ LLMに送信するメッセージ ━━━");
  messagesToSend.forEach((msg, i) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    console.log(`[${i + 1}] ${msg._getType()}: ${content}`);
  });
  console.log("━━━━━━━━━━━━━━━━━━━━━━━\n");

  return {
    messages: [await modelWithTools.invoke(messagesToSend, { callbacks: [langfuseHandler] })],
  };
}

// Step 4: Define tool node

import { AIMessage, ToolMessage } from "@langchain/core/messages";
async function toolNode(state: typeof MessagesAnnotation.State) {
  const lastMessage = state.messages.at(-1);

  if (lastMessage == null || lastMessage._getType() !== "ai") {
    return { messages: [] };
  }

  const aiMessage = lastMessage as AIMessage;

  console.log(`\n📍 ${aiMessage.tool_calls?.length || 0}個のツールを実行中...\n`);

  const result: ToolMessage[] = [];
  for (const toolCall of aiMessage.tool_calls ?? []) {
    console.log(`🔧 ツール呼び出し: ${toolCall.name}(${JSON.stringify(toolCall.args)})`);
    const tool = toolsByName[toolCall.name];
    const observation = await tool.invoke(toolCall);
    console.log(`✓ ツール結果: ${observation.content}\n`);
    result.push(observation);
  }

  return { messages: result };
}

// Step 5: Define logic to determine whether to end

async function shouldContinue(state: typeof MessagesAnnotation.State) {
  const lastMessage = state.messages.at(-1);
  if (lastMessage == null || lastMessage._getType() !== "ai") return END;

  const aiMessage = lastMessage as AIMessage;
  // If the LLM makes a tool call, then perform an action
  if (aiMessage.tool_calls?.length) {
    console.log(`➡️  次のノード: toolNode`);
    return "toolNode";
  }

  // Otherwise, we stop (reply to the user)
  console.log("✅ ツール呼び出しなし - エージェント終了\n");
  return END;
}

// Step 6: Build and compile the agent

const agent = new StateGraph(MessagesAnnotation)
  .addNode("llmCall", llmCall)
  .addNode("toolNode", toolNode)
  .addEdge(START, "llmCall")
  .addConditionalEdges("llmCall", shouldContinue, ["toolNode", END])
  .addEdge("toolNode", "llmCall")
  .compile();

// Invoke
import { HumanMessage } from "@langchain/core/messages";

console.log("\n🤖 グラフエージェント開始 (Langfuseでトレース中)\n");

const result = await agent.invoke({
  messages: [new HumanMessage("Add 3 and 4.")],
});

console.log("\n━━━ 最終結果 ━━━");
for (const message of result.messages) {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  console.log(`[${message._getType()}]: ${content}`);

  // AIメッセージの場合、tool_callsがあれば表示
  if (message._getType() === "ai") {
    const aiMsg = message as AIMessage;
    if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
      console.log(`  └─ tool_calls: ${aiMsg.tool_calls.map(tc => `${tc.name}(${JSON.stringify(tc.args)})`).join(', ')}`);
    }
  }
}
console.log("━━━━━━━━━━━━━━━━\n");

console.log("🔍 トレースをLangfuseで確認: http://localhost:3000\n");

// Ensure Langfuse data is flushed before exit
await langfuseHandler.shutdownAsync();
