import { useId } from 'react'
import type { ReactElement } from 'react'

interface NacosIconProps {
  /** Rendered width/height in px. The artwork is a square, so one number is enough. */
  size?: number
  className?: string
}

/**
 * The Nacos infinity mark, drawn from the official favicon.
 *
 * The artwork carries a linear gradient whose id is document-global, so two icons on one
 * page would fight over it; useId keeps every instance self-contained.
 */
export default function NacosIcon({ size = 16, className }: NacosIconProps): ReactElement {
  const uid = useId().replace(/:/g, '')
  const gradient = uid + '-gradient'

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="5" y1="32" x2="58" y2="32">
          <stop offset="0" stopColor="#4090ff" />
          <stop offset="1" stopColor="#1be1f7" />
        </linearGradient>
      </defs>
      <g fill={'url(#' + gradient + ')'}>
        <path d="M 17.5 46.64 C 14.27 47.21 11.42 46.57 8.5 45.26 C -5.7 38.88 -0.84 17.56 14.5 17.13 C 19.25 16.99 23.35 19.23 26.63 22.5 C 27.27 23.14 29.18 24.47 29.18 25.5 C 29.18 26.13 26.11 29.24 25.5 29.35 C 24.45 29.54 20.82 24.94 19.5 24.28 C 13.13 21.09 5.78 25.21 6.04 32.5 C 6.28 39.27 13.84 42.56 19.5 39.72 C 20.97 38.98 24.28 34.48 25.5 34.48 C 26.16 34.48 29.47 37.82 29.35 38.5 C 29.27 38.9 28.87 39.17 28.62 39.5 C 28.27 39.97 26.94 41.01 26.5 41.45 C 23.82 44.12 21.24 45.8 17.5 46.64 Z" />
        <path fillRule="evenodd" d="M 51.5 46.59 C 42.7 48.2 38.03 42.31 32.5 36.78 C 31.52 35.8 27.83 32.77 28.12 31.5 C 28.2 31.11 31.68 28.04 32.22 27.5 C 36.35 23.36 39.83 19.02 45.7 17.5 C 55.42 14.98 65.72 24.6 63.65 34.5 C 62.66 39.22 59.19 44.07 54.5 45.78 C 53.52 46.13 52.48 46.23 51.5 46.59 Z M 51.2 40.5 C 63.11 36.01 56.88 20.37 46.5 23.46 C 43.11 24.47 40.92 27.27 38.5 29.69 C 37.87 30.33 36.23 31.41 36.7 32.5 C 36.93 33.02 38.99 34.71 39.5 35.22 C 42.73 38.45 46.1 42.19 51.2 40.5 Z" />
      </g>
    </svg>
  )
}