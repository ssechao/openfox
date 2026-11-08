import { t } from '@shared/i18n/index.js'

export function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sendFailedMessage(detail: string): string {
  return t(
    {
      en: 'The message could not be sent ({{detail}}). Your draft and attachments were kept.',
      fr: 'Le message n\u2019a pas pu \u00eatre envoy\u00e9 ({{detail}}). Votre brouillon et vos pi\u00e8ces jointes ont \u00e9t\u00e9 conserv\u00e9s.',
    },
    { detail },
  )
}
