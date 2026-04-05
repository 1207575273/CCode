const tty = require('tty')
const result = {
  runtime: typeof globalThis.Bun !== 'undefined' ? 'bun-' + Bun.version : 'node-' + process.version,
  isatty_stdin: tty.isatty(0),
  isatty_stdout: tty.isatty(1),
  stdin_isTTY: process.stdin.isTTY,
  stdin_constructor: process.stdin.constructor.name,
  stdin_setRawMode: typeof process.stdin.setRawMode,
  stdout_isTTY: process.stdout.isTTY,
}
console.log(JSON.stringify(result))
