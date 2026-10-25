'use strict';

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function check(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['node_modules', '.homeybuild', '.git'].includes(entry.name)) {
            continue;
        }
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            check(file);
        } else if (/\.(js|cjs)$/.test(entry.name)) {
            const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
            if (result.status !== 0) {
                process.exit(result.status || 1);
            }
        } else if (entry.name.endsWith('.json')) {
            JSON.parse(fs.readFileSync(file, 'utf8'));
        } else if (entry.name.endsWith('.html')) {
            const html = fs.readFileSync(file, 'utf8');
            for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
                if (!/\bsrc\s*=/.test(match[1])) {
                    new vm.Script(match[2], { filename: file });
                }
            }
        }
    }
}

check(root);
globalThis.console.log('JavaScript, pairing view syntax, and JSON checks passed');
