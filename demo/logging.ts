// Structured logging module\nexport function log(level: string, msg: string) {\n  console.log(JSON.stringify({ level, msg, ts: Date.now() }));\n}
