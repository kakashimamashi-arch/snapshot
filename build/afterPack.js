'use strict';

// electron-builder afterPack hook.
//
// Without a paid Apple "Developer ID Application" certificate, electron-builder
// skips code signing entirely, leaving only an invalid linker-signed stub.
// On Apple Silicon that makes the downloaded app show up as "damaged and can't
// be opened" — even after the quarantine flag is removed.
//
// This hook applies a proper ad-hoc signature (`codesign --sign -`) to the
// packed .app before the DMG is built, so recipients only need to clear the
// download quarantine (`xattr -dr com.apple.quarantine …` or "Open Anyway").
//
// This is NOT a substitute for real Developer ID signing + notarization; it
// only makes the free, unsigned build launchable after a manual quarantine
// removal.

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  console.log(`  • ad-hoc signing (free build) app=${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
