// Step 1: Define tools and model

import "dotenv/config";
import { AzureChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import * as z from "zod";

const model = new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
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

// Step 2: Define model node

import { task, entrypoint } from "@langchain/langgraph";
import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
const callLlm = task({ name: "callLlm" }, async (messages: BaseMessage[]) => {
  const messagesToSend = [
    new SystemMessage(
      "You are a helpful assistant tasked with performing arithmetic on a set of inputs."
    ),
    ...messages,
  ];

  // プロンプトを出力
  console.log("\n━━━ LLMに送信するメッセージ ━━━");
  messagesToSend.forEach((msg, i) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    console.log(`[${i + 1}] ${msg._getType()}: ${content}`);
  });
  console.log("━━━━━━━━━━━━━━━━━━━━━━━\n");

  return modelWithTools.invoke(messagesToSend);
});

// Step 3: Define tool node

import type { ToolCall } from "@langchain/core/messages/tool";
const callTool = task({ name: "callTool" }, async (toolCall: ToolCall) => {
  console.log(`🔧 ツール呼び出し: ${toolCall.name}(${JSON.stringify(toolCall.args)})`);
  const tool = toolsByName[toolCall.name];
  const result = await tool.invoke(toolCall);
  console.log(`✓ ツール結果: ${result.content}\n`);
  return result;
});

// Step 4: Define agent
import { addMessages } from "@langchain/langgraph";
const agent = entrypoint({ name: "agent" }, async (messages: BaseMessage[]) => {
  console.log("\n🤖 エージェント開始\n");
  let modelResponse = await callLlm(messages);

  let iteration = 1;
  while (true) {
    if (!modelResponse.tool_calls?.length) {
      console.log("✅ ツール呼び出しなし - エージェント終了\n");
      break;
    }

    console.log(`\n📍 反復 ${iteration++}: ${modelResponse.tool_calls.length}個のツールを実行中...\n`);

    // Execute tools
    const toolResults = await Promise.all(
      modelResponse.tool_calls.map((toolCall) => callTool(toolCall))
    );
    messages = addMessages(messages, [modelResponse, ...toolResults]);
    modelResponse = await callLlm(messages);
  }

  return messages;
});

// Invoke
import { HumanMessage, AIMessage as AIMsg } from "@langchain/core/messages";
const result = await agent.invoke([new HumanMessage("Add 3 and 4.")]);

console.log("\n━━━ 最終結果 ━━━");
for (const message of result) {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  console.log(`[${message._getType()}]: ${content}`);

  // AIメッセージの場合、tool_callsがあれば表示
  if (message._getType() === "ai") {
    const aiMsg = message as AIMsg;
    if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
      console.log(`  └─ tool_calls: ${aiMsg.tool_calls.map(tc => `${tc.name}(${JSON.stringify(tc.args)})`).join(', ')}`);
    }
  }
}
console.log("━━━━━━━━━━━━━━━━\n");