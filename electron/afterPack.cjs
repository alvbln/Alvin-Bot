// afterPack hook: Remove personal/runtime data from the build
const fs = require('fs');
const path = require('path');

exports.default = async function(context) {
  const appDir = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app');
  
  // Fallback for non-macOS
  const appDirAlt = path.join(context.appOutDir, 'resources', 'app');
  const baseDir = fs.existsSync(appDir) ? appDir : appDirAlt;
  
  if (!fs.existsSync(baseDir)) {
    console.warn('⚠️ afterPack: Could not find app directory');
    return;
  }

  // Files and directories to remove (personal/runtime data)
  const toRemove = [
    'docs/memory',
    'docs/MEMORY.md', 
    'docs/users',
    'docs/whatsapp-groups.json',
    'docs/cron-jobs.json',
    'data',
    'backups',
    '.env',
    '.wwebjs_cache',
    'CLAUDE.md',
    'telegram-agent-setup-prompt.md',
    '.npmignore',
    '.gitignore',
    '.electronignore',
    'src',
    'scripts',
    '.git',
    '.github',
  ];

  let removed = 0;
  for (const item of toRemove) {
    const fullPath = path.join(baseDir, item);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`  🧹 Removed: ${item}`);
      removed++;
    }
  }

  // Create empty docs/memory directory (bot creates files at runtime)
  const memoryDir = path.join(baseDir, 'docs', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, '.gitkeep'), '');

  // Create template MEMORY.md
  const memoryMd = path.join(baseDir, 'docs', 'MEMORY.md');
  fs.writeFileSync(memoryMd, '# MEMORY.md — Long-term Memory\n\n> This file is auto-populated by the bot during usage.\n');

  console.log(`  ✅ afterPack: Cleaned ${removed} personal/runtime items`);
};
