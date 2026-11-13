// embeddingIndex.js
const { pipeline, env } = require('@huggingface/transformers');
const fs = require('fs');
const path = require('path');

env.backends.onnx.wasm.numThreads = 1;
env.allowLocalModels = false;

let embedder = null;
let toolVectors = [];
let allTools = [];

const MODEL_CACHE_DIR = process.env.MODEL_CACHE_DIR || path.join(__dirname, '.model-cache');
const TOOLS_JSON = path.join(__dirname, 'tools.json');

async function buildIndex() {
  console.log('🔍 Building local embedding index...');
  if (!fs.existsSync(TOOLS_JSON)) throw new Error('tools.json missing. Run npm run parse-tools first.');
  if (!fs.existsSync(MODEL_CACHE_DIR)) fs.mkdirSync(MODEL_CACHE_DIR, { recursive: true });
  env.cacheDir = MODEL_CACHE_DIR;

  embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
    device: 'cpu',
  });
  env.useBrowserCache = false;

  allTools = JSON.parse(fs.readFileSync(TOOLS_JSON, 'utf8'));
  toolVectors = [];
  for (const tool of allTools) {
    const text = `${tool.name} — ${tool.category}. ${tool.description}`;
    const out = await embedder(text, { pooling: 'mean', normalize: true });
    toolVectors.push({ tool, vector: Array.from(out.data) });
  }
  console.log(`✅ Embedding index ready: ${toolVectors.length} tools`);
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