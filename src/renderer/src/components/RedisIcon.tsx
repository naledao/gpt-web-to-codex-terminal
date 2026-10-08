import type { ReactElement } from 'react'
import redisIconUrl from '../assets/redis-favicon.svg'

export default function RedisIcon({ size = 16 }: { size?: number }): ReactElement {
  return (
    <img
      src={redisIconUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
      style={{ flexShrink: 0 }}
    />
  )
}
