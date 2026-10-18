import { useEffect, useState } from 'react'

export default function HelloView() {
  const [greeting, setGreeting] = useState('…')

  useEffect(() => {
    window.api.invoke<string>('sample-builtin:hello').then(setGreeting)
  }, [])

  return (
    <div id="hello-tsx">
      <h2>Hello from TSX</h2>
      <p>Backend says: {greeting}</p>
    </div>
  )
}
