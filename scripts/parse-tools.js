// scripts/parse-tools.js
const fs = require('fs');
const path = require('path');

const CARD_FILES = [
  'student.html', 'teacher.html', 'shopping.html', 'researcher.html',
  'music-mega.html', 'gamer1.html', 'entertainment1.html', 'editing.html',
  'developer.html', 'custom1.html', 'cartoons1.html', 'essentials.html', 'examkit.html'
];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const OUTPUT_FILE = path.join(__dirname, '..', 'tools.json');

function extractToolsFromHtml(html) {
  const tools = [];
  const regex = /(?:const|let|var)\s+\w+\s*=\s*(\[[\s\S]*?\n\s{0,4}\]);/g;
  let m;
  while ((m = regex.exec(html)) !== null) {
    let arr;
    try { arr = new Function(`return ${m[1]}`)(); } catch (_) { continue; }
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (item && typeof item === 'object' && item.name && item.url) {
        tools.push({
          id: String(item.name).replace(/\s+/g, '_').toLowerCase(),
          name: String(item.name),
          url: String(item.url),
          description: String(item.desc || item.description || '').slice(0, 400),
          category: String(item.category || 'general'),
          isPremium: item.isPremiumRequired === true,
        });
      }
    }
  }
  return tools;
}

function main() {
  const all = [];
  for (const file of CARD_FILES) {
    const p = path.join(PUBLIC_DIR, file);
    if (!fs.existsSync(p)) { console.warn(`⚠️ Missing: ${file} — skipping`); continue; }
    const found = extractToolsFromHtml(fs.readFileSync(p, 'utf8'));
    console.log(`   ${file}: ${found.length} tools`);
    all.push(...found);
  }
  const seen = new Set();
  const unique = all.filter(t => {
    const k = t.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2));
  console.log(`✅ tools.json generated: ${unique.length} unique tools`);
}

main();