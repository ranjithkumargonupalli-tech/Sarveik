// embeddingIndex.js
const { pipeline, env } = require('@huggingface/transformers');
const fs = require('fs');
const path = require('path');
const { pool } = require('./database'); // 👈 Import your database pool

env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;

let embedder = null;
let toolVectors = [];
let allTools = [];

const MODEL_CACHE_DIR = process.env.MODEL_CACHE_DIR || path.join(__dirname, '.model-cache');
const TOOLS_JSON = path.join(__dirname, 'tools.json');

async function buildIndex() {
  console.log('🔍 Building local embedding index...');
  if (!fs.existsSync(MODEL_CACHE_DIR)) fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
  env.cacheDir = MODEL_CACHE_DIR;

  // 1. Load the local embedding model
  embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
    device: 'cpu',
  });

  // 2. Load static tools from HTML files
  let staticTools = [];
  if (fs.existsSync(TOOLS_JSON)) {
    staticTools = JSON.parse(fs.readFileSync(TOOLS_JSON, 'utf8'));
  }

  // 3. Load newly approved tools from the Database
  let dbTools = [];
  try {
    const result = await pool.query(
      `SELECT id, name, url, description, category FROM tools WHERE approved = true`
    );
    // Format DB tools to match the structure of your HTML tools
    dbTools = result.rows.map(t => ({
      id: `db_${t.id}`,
      name: t.name,
      url: t.url,
      description: t.description || '',
      category: t.category || 'general',
      sourcePage: 'newtools.html' // Link DB tools to the New Tools page
    }));
    console.log(`✅ Loaded ${dbTools.length} newly approved tools from database.`);
  } catch (err) {
    console.error('⚠️ Failed to load tools from database:', err.message);
  }

  // 4. Merge and deduplicate (prevent duplicates if a tool is in both places)
  const seen = new Set();
  allTools = [];
  const combined = [...staticTools, ...dbTools];
  
  for (const tool of combined) {
    const key = tool.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      allTools.push(tool);
    }
  }

  // 5. Generate vectors
  toolVectors = [];
  for (const tool of allTools) {
    const text = `${tool.name} — ${tool.category}. ${tool.description}`;
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    toolVectors.push({ tool, vector: Array.from(out.data) });
  }
  
  console.log(`✅ Embedding index ready: ${toolVectors.length} total tools (${staticTools.length} static + ${dbTools.length} database)`);
}

function cosine(a, b) {
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s;
}

async function prefilterTools(query, limit = 20) {
  if (!embedder || toolVectors.length === 0) return [];
  const out = await embedder(query, { pooling: 'mean', normalize: true });
  const q = Array.from(out.data);
  return toolVectors
    .map(({ tool, vector }) => ({ tool, score: cosine(q, vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.tool);
}

module.exports = { buildIndex, prefilterTools };