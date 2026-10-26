import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('the marketplace copy contains a runnable voice CLI and native sources', () => {
  const repo = fileURLToPath(new URL('../', import.meta.url))
  const marketplace = JSON.parse(readFileSync(join(repo, '.claude-plugin/marketplace.json'), 'utf8'))
  const source = resolve(repo, marketplace.plugins.find((p) => p.name === 'earshot').source)
  const dir = mkdtempSync(join(tmpdir(), 'earshot-distribution-'))
  const installed = join(dir, 'plugin')
  try {
    // Hosted marketplaces copy only the directory named by source.
    cpSync(source, installed, { recursive: true, filter: (path) => !['.git', 'node_modules'].includes(basename(path)) })
    const manifest = JSON.parse(readFileSync(join(installed, '.claude-plugin/plugin.json'), 'utf8'))
    assert.ok(existsSync(join(installed, manifest.hooks)))
    assert.ok(existsSync(join(installed, manifest.types)))
    for (const name of ['ear', 'hear']) assert.ok(existsSync(join(installed, 'native', `${name}.swift`)))
    const help = execFileSync(process.execPath, [join(installed, 'src/cli.js'), '--help'], { encoding: 'utf8', cwd: dir })
    assert.match(help, /earshot doctor/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
