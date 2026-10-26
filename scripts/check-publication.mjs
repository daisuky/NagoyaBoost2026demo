import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Reports rule names and paths only; never echo matched credential contents.
export function inspectFile(path, bytes) {
  const name = path.replaceAll('\\', '/');
  const issues = [];
  if (/(^|\/)\.env(?:\..*)?$/.test(name) && !name.endsWith('/.env.example') && name !== '.env.example') issues.push('private environment file');
  if (/(^|\/)(?:\.vercel|\.wrangler|node_modules|dist|test-results|private|recordings)(\/|$)/.test(name)) issues.push('local state or private data');
  if (/\.(?:pem|key|p12|pfx|p8|cer|crt|mobileprovision|provisionprofile|keystore|jks|m4a|webm|wav)$/i.test(name)) issues.push('certificate, key, or recording file');
  if (/(^|\/)(?:credentials[^/]*|client_secret[^/]*|service-account[^/]*)\.json$/i.test(name)) issues.push('credential JSON');
  if (/(^|\/)\.dev\.vars/.test(name) || /(^|\/)docs\/screenshots\//.test(name)) issues.push('private configuration or operational screenshot');
  const text = bytes.toString('utf8');
  const signatures = [
    /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/,
    /\bAIza[A-Za-z0-9_-]{35}\b/,
    /\b1\/\/[A-Za-z0-9_-]{40,}/,
    /\bAKIA[A-Z0-9]{16}\b/
  ];
  if (signatures.some(pattern => pattern.test(text))) issues.push('credential signature');
  if (name === '.env.example' || name.endsWith('/.env.example')) {
    for (const line of text.split(/\r?\n/)) {
      const entry = line.match(/^([A-Z_]+)=(.*)$/);
      if (entry && /SECRET|TOKEN|KEY|ACCESS_CODE|CLIENT_ID|FOLDER_ID|QA_API_ORIGIN|CF_SIGNALING_URL/.test(entry[1]) && entry[2].trim()) issues.push(`example must leave ${entry[1]} empty`);
    }
  }
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!files.length) throw new Error('No tracked files: stage the publication snapshot before checking.');
  const failures = files.flatMap(file => inspectFile(file, readFileSync(file)).map(rule => `${file}: ${rule}`));
  if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
  else console.log(`Public snapshot check passed: ${files.length} tracked files. This check does not audit Git history or replace a review of new content.`);
}
