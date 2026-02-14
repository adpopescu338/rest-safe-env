import { useMemo } from 'react'
import ApproveApp from '../approve/App'
import ManageApp from '../manage/App'

function App() {
  const mode = useMemo(() => new URLSearchParams(window.location.search).get('mode'), [])

  if (mode === 'view') {
    return <ApproveApp />
  }

  if (mode === 'import') {
    return <ApproveApp />
  }

  if (mode === 'run') {
    return <ManageApp />
  }

  return (
    <main style={{ padding: '1rem', fontFamily: 'Avenir Next, Segoe UI, sans-serif' }}>
      <h1>rest-safe-env</h1>
      <p>Invalid session mode. Expected <code>view</code>, <code>import</code>, or <code>run</code>.</p>
    </main>
  )
}

export default App
