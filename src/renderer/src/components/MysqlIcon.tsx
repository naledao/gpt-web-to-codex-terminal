import { useId } from 'react'
import type { ReactElement } from 'react'

interface MysqlIconProps {
  /** Rendered width/height in px. The artwork is a square, so one number is enough. */
  size?: number
  className?: string
}

/**
 * The MySQL dolphin mark, drawn from the official favicon.
 *
 * The artwork carries three defs (a tile clip, a corner highlight and a white gradient for
 * the outline). Those ids are document-global, so two icons on one page would fight over
 * them; useId keeps every instance self-contained.
 */
export default function MysqlIcon({ size = 16, className }: MysqlIconProps): ReactElement {
  const uid = useId().replace(/:/g, '')
  const tile = uid + '-tile'
  const light = uid + '-light'
  const white = uid + '-white'
  const shadow = uid + '-shadow'
  const dolphin = uid + '-dolphin'

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={tile}>
          <rect width="48" height="48" rx="2.6" />
        </clipPath>
        <radialGradient id={light}>
          <stop stopColor="#82b2c4" stopOpacity=".9" />
          <stop offset="1" stopColor="#82b2c4" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={white} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#e3eef3" />
          <stop offset=".48" stopColor="#c4dbe5" />
          <stop offset="1" stopColor="#fff" />
        </linearGradient>
        <filter id={shadow} x="-25%" y="-25%" width="150%" height="150%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation=".75" />
        </filter>
        <path
          id={dolphin}
          d="M 50.3,27.7 C 48.5,28.3 47.0,28.2 46.2,26.1 C 45.7,24.7 44.1,24.1 43.3,22.5 C 42.5,20.9 41.7,19.6 40.3,18.6 C 39.0,17.6 38.9,16.5 37.4,15.6 C 35.9,14.6 35.1,13.8 33.6,12.8 C 32.3,11.9 31.9,10.9 30.3,10.6 C 28.4,10.4 27.6,9.7 26.0,8.7 C 24.3,7.6 22.7,7.6 20.6,7.5 C 18.3,7.4 16.5,7.5 14.3,7.7 C 12.6,7.9 11.5,6.9 10.2,5.9 C 8.7,4.7 6.9,4.1 5.4,5.1 C 3.8,6.1 3.5,7.8 4.2,9.4 C 4.9,11.0 6.4,12.4 7.8,13.8 C 9.2,15.2 9.5,16.8 10.2,18.6 C 10.9,20.4 12.0,22.0 13.2,23.4 C 14.3,24.6 16.4,25.6 16.5,27.0 C 16.5,29.4 15.5,32.6 15.3,35.0 C 15.1,37.3 15.4,38.9 17.1,40.6 C 18.6,42.1 20.1,44.1 21.8,43.8 C 23.5,43.5 24.8,42.0 25.5,40.7 C 25.1,39.1 24.8,37.7 24.7,36.7 C 24.2,37.6 24.4,39.1 25.1,40.1 C 26.0,41.4 27.7,41.8 29.1,42.7 C 31.4,44.1 32.8,46.2 34.3,49.0"
        />
      </defs>
      <g clipPath={'url(#' + tile + ')'}>
        <rect width="48" height="48" fill="#015b85" />
        <ellipse cx="0" cy="0" rx="5.9" ry="5.6" fill={'url(#' + light + ')'} />
        <ellipse cx="48" cy="0" rx="5.5" ry="6.6" fill={'url(#' + light + ')'} />
        <ellipse cx="0" cy="48" rx="4.8" ry="7.4" fill={'url(#' + light + ')'} opacity=".5" />
        <ellipse cx="48" cy="48" rx="5.4" ry="7.4" fill={'url(#' + light + ')'} opacity=".5" />
        <use href={'#' + dolphin} fill="none" stroke="#003d69" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" filter={'url(#' + shadow + ')'} transform="translate(.25 1)" opacity=".65" />
        <use href={'#' + dolphin} fill="none" stroke={'url(#' + white + ')'} strokeWidth="2.05" strokeLinecap="round" strokeLinejoin="round" />
        <ellipse cx="18.1" cy="14.0" rx="1.1" ry=".65" fill="#a6cbd9" />
      </g>
    </svg>
  )
}