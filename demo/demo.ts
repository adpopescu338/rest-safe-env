const keys = ['DEMO_NAME', 'DEMO_GREETING', 'DEMO_SECRET', 'DEMO_COUNT'] as const

console.log('[demo-tsx] running TypeScript demo via npx tsx')

for (const key of keys) {
  console.log(`${key}=${process.env[key] ?? '<missing>'}`)
}
