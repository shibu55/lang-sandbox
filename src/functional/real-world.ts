import "dotenv/config";
import { createAgent, tool } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { AzureChatOpenAI } from "@langchain/openai";
import * as z from "zod";

// Step 1: Define system prompt
const systemPrompt = `You are an expert weather forecaster, who speaks in puns.

You have access to two tools:

- get_weather_for_location: use this to get the weather for a specific location
- get_user_location: use this to get the user's location

If a user asks you for the weather, make sure you know the location. If you can tell from the question that they mean wherever they are, use the get_user_location tool to find their location.`;

// Step 2: Create tools
const getWeather = tool(
  ({ city }) => `It's always sunny in ${city}!`,
  {
    name: "get_weather_for_location",
    description: "Get the weather for a given city",
    schema: z.object({
      city: z.string().describe("The city to get the weather for"),
    }),
  }
);

const getUserLocation = tool(
  (_, config: any) => {
    const user_id = config?.context?.user_id;
    return user_id === "1" ? "Florida" : "SF";
  },
  {
    name: "get_user_location",
    description: "Retrieve user information based on user ID",
    schema: z.object({}),
  }
);

// Step 3: Configure model (Azure OpenAI)
const model = new AzureChatOpenAI({
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
  azureOpenAIEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_DEPLOYMENT_NAME,
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

// Step 4: Add memory
const checkpointer = new MemorySaver();

// Step 5: Create and run the agent
const agent = createAgent({
  model: model,
  systemPrompt: systemPrompt,
  tools: [getUserLocation, getWeather],
  checkpointer,
});

// Run agent
async function main() {
  // `thread_id` is a unique identifier for a given conversation.
  const config = {
    configurable: { thread_id: "1" },
    context: { user_id: "1" },
  };

  console.log("First question: what is the weather outside?\n");
  const response = await agent.invoke(
    { messages: [{ role: "user", content: "what is the weather outside?" }] },
    config
  );
  console.log("Response:");
  const lastMessage = response.messages[response.messages.length - 1];
  console.log(lastMessage.content);
  console.log("\n---\n");

  // Note that we can continue the conversation using the same `thread_id`.
  console.log("Second question: thank you!\n");
  const thankYouResponse = await agent.invoke(
    { messages: [{ role: "user", content: "thank you!" }] },
    config
  );
  console.log("Response:");
  const lastThankYouMessage = thankYouResponse.messages[thankYouResponse.messages.length - 1];
  console.log(lastThankYouMessage.content);
}

main().catch(console.error);
