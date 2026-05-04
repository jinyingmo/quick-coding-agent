import { useState, useEffect } from 'react'
import { Text } from 'ink'

export function StreamingText({ text }: { text: string }) {
  const [showCursor, setShowCursor] = useState(true)

  useEffect(() => {
    const timer = setInterval(() => setShowCursor(v => !v), 530)
    return () => clearInterval(timer)
  }, [])

  return <Text wrap="wrap">{text}{showCursor ? ' ▍' : ''}</Text>
}
