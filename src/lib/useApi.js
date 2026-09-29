import { useCallback, useEffect, useState } from 'react'
import { api } from './api.js'

/** Carrega uma rota autenticada: { data, error, loading, reload }. `path` null não carrega. */
export function useApi(path) {
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) })
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])

  useEffect(() => {
    if (!path) return
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    api(path)
      .then((res) => alive && setState({ data: res, error: null, loading: false }))
      .catch((err) => alive && setState({ data: null, error: err.message, loading: false }))
    return () => { alive = false }
  }, [path, tick])

  return { ...state, reload }
}
