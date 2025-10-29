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

// Step 2: Define state

import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { type BaseMessage } from "@langchain/core/messages";

// Step 3: Define model node

import { SystemMessage } from "@langchain/core/messages";
async function llmCall(state: typeof MessagesAnnotation.State) {
  return {
    messages: [await modelWithTools.invoke([
      new SystemMessage(
        "You are a helpful assistant tasked with performing arithmetic on a set of inputs."
      ),
      ...state.messages,
    ])],
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
  const result: ToolMessage[] = [];
  for (const toolCall of aiMessage.tool_calls ?? []) {
    const tool = toolsByName[toolCall.name];
    const observation = await tool.invoke(toolCall);
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
    return "toolNode";
  }

  // Otherwise, we stop (reply to the user)
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
const result = await agent.invoke({
  messages: [new HumanMessage("Add 3 and 4.")],
});

console.log("\nResults:");
for (const message of result.messages) {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  console.log(`[${message._getType()}]: ${content}`);
}