const keys = ['DEMO_NAME', 'DEMO_GREETING', 'DEMO_SECRET', 'DEMO_COUNT']

console.log('[demo-node] running JavaScript demo via node')

for (const key of keys) {
  console.log(`${key}=${process.env[key] ?? '<missing>'}`)
}
