export const theme = {
  primaryText: '#e4e4e4',
  dimText:     '#8e8e8e',
  success:     '#4ade80',
  error:       '#f87171',
  warning:     '#fbbf24',
  info:        '#67e8f9',
  accent:      '#60a5fa',
  border:      '#404040',
  inputBg:     '#0f3460',
  statusBg:    '#0a0a23',
  headerBg:    '#0a0a23',
} as const

export type ThemeKey = keyof typeof theme
