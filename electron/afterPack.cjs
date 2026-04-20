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

  // Files and directories to remove from the build
  // Personal/runtime data now lives in ~/.alvin-bot/ (outside the repo),
  // but we still clean up anything that shouldn't be in the app bundle.
  const toRemove = [
    // Personal config that might have been copied in
    'SOUL.md',
    'TOOLS.md',
    'CLAUDE.md',
    '.env',
    // Legacy data locations (in case they still exist)
    'docs/memory',
    'docs/MEMORY.md',
    'docs/users',
    'docs/whatsapp-groups.json',
    'docs/cron-jobs.json',
    'docs/tools.json',
    'docs/custom-models.json',
    'data',
    'backups',
    '.wwebjs_cache',
    // Dev/build files
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

  // Data directory is now created at runtime in ~/.alvin-bot/
  // No need to create docs/memory in the build.

  console.log(`  ✅ afterPack: Cleaned ${removed} personal/runtime items`);
};
