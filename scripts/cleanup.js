import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// whatsapp-web.js keeps a Chrome process with the LocalAuth profile dir locked.
// If the previous run was killed (Ctrl+C, crash, reboot), that orphaned Chrome
// keeps holding .wwebjs_auth/session and puppeteer refuses to start ("the
// browser is already running"). Kill any such process so the bot always starts.
export function cleanupStaleSessions() {
  const ps = `
$ProgressPreference = 'SilentlyContinue'
$stale = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*wwebjs*' }
foreach ($p in $stale) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Output "Cleaned $($stale.Count) stale browser process(es)."
`;

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.trim();
  } catch {
    return 'Cleanup: nothing to clean.';
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  console.log(cleanupStaleSessions());
}