// 并行启动 API 服务与 Vite 开发服务器（零额外依赖）。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(name, cmd, args, color) {
  const child = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  const paint = (buf) =>
    buf
      .toString()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => console.log(`\x1b[${color}m[${name}]\x1b[0m ${line}`))
  child.stdout.on('data', paint)
  child.stderr.on('data', paint)
  child.on('exit', (code) => process.exit(code || 0))
  return child
}

run('api', process.execPath, ['server/http.js'], '36')
run('web', 'pnpm', ['exec', 'vite', '--host', '0.0.0.0', '--port', '3000'], '35')
