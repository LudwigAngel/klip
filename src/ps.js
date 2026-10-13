'use strict';
// Runs one of Klip's bundled .ps1 helpers in a short-lived, hidden Windows
// PowerShell process and parses its JSON output.
const { execFile } = require('node:child_process');
const path = require('node:path');

function scriptPath(name) {
  // Scripts must be real files on disk for powershell.exe to read them.
  return path.join(__dirname, name).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function runPs(name, args = [], timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath(name), ...args],
      { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || err.message).trim().split(/\r?\n/).filter(Boolean).pop() || err.message;
          return reject(new Error(detail));
        }
        try {
          resolve(JSON.parse(stdout.trim().replace(/^\uFEFF/, '')));
        } catch {
          reject(new Error(`Respuesta no válida de ${name}: ${stdout.slice(0, 200)}`));
        }
      });
  });
}

module.exports = { runPs };
