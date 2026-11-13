// scripts/parse-tools.js
const fs = require('fs');
const path = require('path');

const CARD_FILES = [
  'student.html', 'teacher.html', 'shopping.html', 'researcher.html',
  'music-mega.html', 'gamer1.html', 'entertainment1.html', 'editing.html',
  'developer.html', 'custom1.html', 'cartoons1.html', 'essentials.html', 'examkit.html',
  'career.html', 'businessdirectory.html', 'newtools.html'
];

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const OUTPUT_FILE = path.join(__dirname, '..', 'tools.json');

function extractToolsFromHtml(html) {
  const tools = [];
  // This regex looks for any block that resembles a JS object
  const objRegex = /\{([^{}]+)\}/g;
  let match;
  
  while ((match = objRegex.exec(html)) !== null) {
    const objStr = match[1];
    // Check if this object has both a name and a url
    if (objStr.includes('name:') && objStr.includes('url:')) {
      const nameMatch = objStr.match(/name:\s*["']([^"']+)["']/);
      const urlMatch = objStr.match(/url:\s*["']([^"']+)["']/);
      const descMatch = objStr.match(/(?:desc|description):\s*["']([^"']+)["']/);
      const catMatch = objStr.match(/category:\s*["']([^"']+)["']/);
      
      if (nameMatch && urlMatch) {
        tools.push({
          id: nameMatch[1].replace(/\s+/g, '_').toLowerCase(),
          name: nameMatch[1],
          url: urlMatch[1],
          description: descMatch ? descMatch[1].slice(0, 400) : '',
          category: catMatch ? catMatch[1] : 'general',
          isPremium: false,
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
    if (!fs.existsSync(p)) { continue; }
    
    const found = extractToolsFromHtml(fs.readFileSync(p, 'utf8'));
    console.log(`   ${file}: ${found.length} tools`);
    
    // Attach the source page to each tool
    found.forEach(t => t.sourcePage = file);
    all.push(...found);
  }
  
  // Deduplicate
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