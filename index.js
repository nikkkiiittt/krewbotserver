import { config } from "dotenv";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { GoogleGenAI } from "@google/genai";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { TwitterApi } from "twitter-api-v2";
import { z } from "zod";

config();

// Chat history storage (in production, use a database with user sessions)
const chatHistory = new Map(); // Map userId -> chat history
let tools = [];

// MCP Server setup
const mcpServer = new McpServer({
  name: "merged-server",
  version: "1.0.0",
});

// 🧠 Dictionary Lookup
async function defineWord(word) {
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
    if (!response.ok) {
      return {
        content: [{ type: "text", text: `Could not find definition for "${word}"` }]
      };
    }
    const data = await response.json();
    const definition = data[0]?.meanings[0]?.definitions[0]?.definition;
    return {
      content: [{ type: "text", text: definition ? `${word}: ${definition}` : `No definition found for "${word}"` }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error looking up "${word}": ${error.message}` }]
    };
  }
}

// 🐦 Updated Twitter Post (with user-supplied credentials)
async function createPost({ status, credentials }) {
  try {
    if (!credentials || !credentials.apiKey || !credentials.apiSecret || 
        !credentials.accessToken || !credentials.accessSecret) {
      return {
        content: [{ type: "text", text: "Twitter credentials are missing. Please configure your Twitter API keys." }]
      };
    }

    const client = new TwitterApi({
      appKey: credentials.apiKey,
      appSecret: credentials.apiSecret,
      accessToken: credentials.accessToken,
      accessSecret: credentials.accessSecret,
    });

    await client.v2.tweet(status);

    return {
      content: [{ type: "text", text: `Successfully tweeted: "${status}"` }]
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Failed to tweet: ${error.message}` }]
    };
  }
}

// Tool Handlers
const toolHandlers = {
  addTwoNumbers: async ({ a, b }) => ({
    content: [{ type: "text", text: `The sum of ${a} and ${b} is ${a + b}` }]
  }),
  createPost: async ({ status, credentials }) => createPost({ status, credentials }),
  defineWord: async ({ word }) => defineWord(word)
};

// MCP Tool Registrations
mcpServer.tool("addTwoNumbers", "Add two numbers", {
  a: z.number(), b: z.number()
}, toolHandlers.addTwoNumbers);

mcpServer.tool("createPost", "Create a post on X (formerly Twitter)", {
  status: z.string(), 
  credentials: z.object({
    apiKey: z.string(),
    apiSecret: z.string(),
    accessToken: z.string(),
    accessSecret: z.string(),
  }).optional()
}, toolHandlers.createPost);

mcpServer.tool("defineWord", "Look up a definition", {
  word: z.string()
}, toolHandlers.defineWord);

// Gemini-compatible tool schema
tools = [
  {
    name: "addTwoNumbers",
    description: "Add two numbers",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" }
      },
      required: ["a", "b"]
    }
  },
  {
    name: "createPost",
    description: "Create a post on X (Twitter)",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        credentials: {
          type: "object",
          properties: {
            apiKey: { type: "string" },
            apiSecret: { type: "string" },
            accessToken: { type: "string" },
            accessSecret: { type: "string" }
          },
          required: ["apiKey", "apiSecret", "accessToken", "accessSecret"]
        }
      },
      required: ["status"]
    }
  },
  {
    name: "defineWord",
    description: "Look up a word",
    parameters: {
      type: "object",
      properties: {
        word: { type: "string" }
      },
      required: ["word"]
    }
  }
];

// Express app setup
const app = express();
app.use(cors());
app.use(bodyParser.json());

const transports = {};

// MCP SSE endpoint
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => delete transports[transport.sessionId]);
  await mcpServer.connect(transport);
});

// MCP POST message endpoint
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

// Save/Load user credentials endpoint
app.post("/credentials", (req, res) => {
  const { userId, credentials } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }
  
  // In production, save to database
  // For now, just acknowledge receipt
  res.json({ 
    message: "Credentials received (not stored server-side for security)",
    userId 
  });
});

// Updated Gemini Chat API with user credentials
// Function to detect if message needs tools
function shouldUseTools(message) {
  const lowerMessage = message.toLowerCase();
  
  // Keywords that suggest tool usage
  const toolKeywords = [
    // Math/calculation
    'calculate', 'add', 'sum', 'plus', 'minus', 'multiply', 'divide', 'math',
    // Dictionary
    'define', 'definition', 'meaning',
    // Twitter/posting
    'tweet', 'post', 'twitter', 'share', 'publish'
  ];
  
  // Check for numbers (might need math)
  const hasNumbers = /\d+\s*[\+\-\*\/]\s*\d+/.test(message);
  
  // Check for tool keywords
  const hasToolKeywords = toolKeywords.some(keyword => 
    lowerMessage.includes(keyword)
  );
  
  return hasNumbers || hasToolKeywords;
}

// Updated Gemini Chat API with smart tool detection
app.post("/chat", async (req, res) => {
  const { message, userId = "default", geminiApiKey, twitterCreds } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message is required" });
  }

  if (!geminiApiKey) {
    return res.status(400).json({ error: "Gemini API key is required" });
  }

  // Get or create user chat history
  const userChatHistory = chatHistory.get(userId) || [];
  userChatHistory.push({ role: "user", parts: [{ text: message, type: "text" }] });

  try {
    // Initialize Google AI with user's API key
    const ai = new GoogleGenAI({ apiKey: geminiApiKey });

    // Decide whether to include tools
    const useTools = shouldUseTools(message);
    
    const requestConfig = {
      model: "gemini-2.0-flash",
      contents: userChatHistory,
    };

    // Only add tools if message suggests they're needed
    if (useTools) {
      requestConfig.config = { tools: [{ functionDeclarations: tools }] };
      console.log(`🔧 Using tools for message: "${message}"`);
    } else {
      console.log(`💬 Regular chat for message: "${message}"`);
    }

    const response = await ai.models.generateContent(requestConfig);
    const part = response.candidates[0].content.parts[0];

    // Handle tool calls (only possible if tools were provided)
    if (part.functionCall && useTools) {
      const toolName = part.functionCall.name;
      const args = part.functionCall.args;

      console.log(`📡 User ${userId} calling tool: ${toolName}`);

      // Only add Twitter credentials if the tool needs them AND they exist
      if (toolName === 'createPost') {
        if (!twitterCreds || !twitterCreds.apiKey) {
          const errorMessage = "Twitter credentials are required to create posts. Please configure your Twitter API keys in settings.";
          userChatHistory.push({ role: "model", parts: [{ text: errorMessage, type: "text" }] });
          chatHistory.set(userId, userChatHistory);
          return res.json({ reply: errorMessage });
        }
        args.credentials = twitterCreds;
      }

      const toolHandler = toolHandlers[toolName];
      if (!toolHandler) {
        return res.status(400).json({ error: `Unknown tool: ${toolName}` });
      }

      try {
        const toolResult = await toolHandler(args);
        const toolReply = toolResult.content[0].text;

        userChatHistory.push({ role: "model", parts: [{ functionCall: part.functionCall }] });
        userChatHistory.push({ role: "user", parts: [{ text: "Tool result: " + toolReply, type: "text" }] });

        // Get final response after tool execution (without tools this time)
        const finalResponse = await ai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: userChatHistory,
        });

        const finalReply = finalResponse.candidates[0].content.parts[0].text;
        userChatHistory.push({ role: "model", parts: [{ text: finalReply, type: "text" }] });

        chatHistory.set(userId, userChatHistory);

        return res.json({
          reply: finalReply,
          toolUsed: toolName,
          toolResult: toolReply
        });

      } catch (toolError) {
        console.error("❌ Tool error:", toolError);
        return res.status(500).json({ error: "Tool execution failed", details: toolError.message });
      }
    }

    // Regular chat response (no tools used)
    const reply = part.text;
    userChatHistory.push({ role: "model", parts: [{ text: reply, type: "text" }] });
    
    chatHistory.set(userId, userChatHistory);
    
    return res.json({ reply });

  } catch (error) {
    console.error("❌ Chat error:", error);
    return res.status(500).json({ 
      error: "Chat failed", 
      details: error.message.includes('API key') ? 
        "Invalid Gemini API key. Please check your credentials." : 
        error.message 
    });
  }
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    toolsCount: tools.length,
    mcpServer: "active",
    activeUsers: chatHistory.size
  });
});

// Get tool metadata
app.get("/tools", (req, res) => {
  res.json({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  });
});

// Start server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
