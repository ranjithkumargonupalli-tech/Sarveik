const fs = require('fs');
const file = 'D:\\RADHAKRIHNA\\nova-platform\\auth-service\\public\\friends.html';
let content = fs.readFileSync(file, 'utf8');

const target = 'playTone(); buzz();';
if (!content.includes('window.SarveikNative.showNotification') && content.includes(target)) {
  const replacement = `playTone(); buzz();
  try {
    if (window.SarveikNative && typeof window.SarveikNative.showNotification === 'function') {
      window.SarveikNative.showNotification(title, body, href || 'friends.html');
    }
  } catch(e) {}`;
  content = content.replace(target, replacement);
  fs.writeFileSync(file, content, 'utf8');
  console.log('✅ Successfully added SarveikNative hook into notify() in friends.html!');
} else {
  console.log('Already patched or target not found');
}
