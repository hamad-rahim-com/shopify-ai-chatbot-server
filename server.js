import express from "express";
import cors from "cors";
import axios from "axios";
import fs from "fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ✅ Local session storage
const SESSIONS_FILE = "./sessions.json";
let sessions = {};

if (fs.existsSync(SESSIONS_FILE)) {
  try {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE));
  } catch (e) {
    sessions = {};
  }
}

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// ✅ Filter helper (budget + category)
function parseFilters(text) {
  const filters = {};
  const lower = text.toLowerCase();

  // ✅ Budget: "under 5000", "below 10k", "less than 3000"
  const budgetRegex = /(under|below|less than)\s*(\d{1,3}k|\d{2,7})/;
  const match = lower.match(budgetRegex);

  if (match) {
    let num = match[2];
    if (num.endsWith("k")) num = parseFloat(num) * 1000;
    filters.maxPrice = Number(num);
  }

  // ✅ Basic category words
  const categories = [
    "shoe", "shoes", "shirt", "hoodie", "bag", "backpack", "dress",
    "jacket", "watch", "sneaker", "pants", "jeans"
  ];

  for (const c of categories) {
    if (lower.includes(c)) {
      filters.category = c;
      break;
    }
  }

  return filters;
}

// ✅ Fetch Shopify products
async function fetchProducts() {
  const response = await axios.get(
    `https://${process.env.SHOPIFY_STORE_URL}/admin/api/2024-10/products.json`,
    {
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.products;
}

// ✅ Public products endpoint (unchanged)
app.get("/products", async (req, res) => {
  try {
    const products = await fetchProducts();
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

// ✅ MAIN CHAT ENDPOINT
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message || "";
    const sessionId = req.body.sessionId || "anonymous";

    // ✅ Create session if not exists
    if (!sessions[sessionId]) {
      sessions[sessionId] = { messages: [] };
    }

    // ✅ Save user message to session history
    sessions[sessionId].messages.push({ role: "user", text: userMessage });
    sessions[sessionId].messages = sessions[sessionId].messages.slice(-10);
    saveSessions();

    // ✅ Get products
    const products = await fetchProducts();

    // ✅ Build structured product data WITH IMAGES
    const productSummary = products.map((p) => {
      const variant = p.variants?.[0] || {};
      const image = p.images?.[0]?.src || p.image?.src || "";
      
      return {
        id: p.id,
        title: p.title,
        description: p.body_html?.replace(/<[^>]+>/g, "") || "",
        tags: p.tags,
        price: Number(variant.price) || 0,
        compareAtPrice: Number(variant.compare_at_price) || null,
        currency: "PKR", // Change based on your store currency
        image: image,
        url: `https://${process.env.SHOPIFY_STORE_URL}/products/${p.handle}`,
        handle: p.handle
      };
    });

    // ✅ Apply filters
    const filters = parseFilters(userMessage);
    let filtered = productSummary;

    if (filters.maxPrice) {
      filtered = filtered.filter((p) => p.price && p.price <= filters.maxPrice);
    }

    if (filters.category) {
      filtered = filtered.filter((p) =>
        (p.title + " " + p.description + " " + p.tags)
          .toLowerCase()
          .includes(filters.category)
      );
    }

    // ✅ If no match, fallback to all products
    if (filtered.length === 0) {
      filtered = productSummary;
    }

    // ✅ Build prompt with chat history
    const historyText = sessions[sessionId].messages
      .slice(-6) // Last 6 messages for context
      .map((m) => `${m.role}: ${m.text}`)
      .join("\n");

    // ✅ Create simplified product list for AI (without images)
    const productsForAI = filtered.slice(0, 15).map(p => ({
      id: p.id,
      title: p.title,
      description: p.description.substring(0, 150),
      price: p.price,
      tags: p.tags
    }));

    const prompt = `
You are a helpful shopping assistant. Based on the conversation and user's query, recommend the most relevant products.

Conversation history:
${historyText}

Current user query: "${userMessage}"

Available products:
${JSON.stringify(productsForAI, null, 2)}

Instructions:
1. Recommend up to 3 most relevant products
2. Return ONLY a JSON array of product IDs in this exact format:
   {"productIds": [123456, 789012, 345678], "message": "Your friendly recommendation message here"}
3. The "message" should be a brief, friendly explanation of why you're recommending these products
4. If the query is unclear or you need more info, return: {"productIds": [], "message": "Your clarifying question here"}

Return only valid JSON, no other text.
`;

    // ✅ AI Call
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await model.generateContent(prompt);
    let aiResponse = result.response.text().trim();

    // ✅ Clean up AI response (remove markdown code blocks if present)
    aiResponse = aiResponse.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();

    // ✅ Parse AI response
    let aiData;
    try {
      aiData = JSON.parse(aiResponse);
    } catch (parseErr) {
      console.error("Failed to parse AI response:", aiResponse);
      aiData = { productIds: [], message: aiResponse };
    }

    // ✅ Get full product data for recommended IDs
    const recommendedProducts = aiData.productIds
      .map(id => filtered.find(p => p.id === id))
      .filter(Boolean)
      .slice(0, 3); // Max 3 products

    // ✅ Save bot reply to history
    sessions[sessionId].messages.push({ 
      role: "assistant", 
      text: aiData.message 
    });
    sessions[sessionId].messages = sessions[sessionId].messages.slice(-10);
    saveSessions();

    // ✅ Return structured response
    res.json({
      message: aiData.message,
      products: recommendedProducts,
      type: recommendedProducts.length > 0 ? "product_recommendation" : "text"
    });

  } catch (err) {
    console.error("Chat Error:", err);
    res.status(500).json({ error: "Chat failed" });
  }
});

// ✅ Start server
const PORT = 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});