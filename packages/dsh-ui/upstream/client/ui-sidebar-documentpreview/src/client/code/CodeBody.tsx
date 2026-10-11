/** Incrementally highlighted source; the document owner supplies the accumulated text and wrap preference. */
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { CodeBlock, languageForPath } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentPreviewProps } from '../document/contract.ts'
import type {} from './locales.ts'
import css from './CodeBody.module.css'

/** Document owner props and this renderer's localized controls. */
export type CodeBodyProps = DocumentPreviewProps & PropsLocale<'sidebarCodePreview'>

/** @param props - accumulated document contents and framework props. @returns one stable CodeBlock, or no body for byte contents. */
export function CodeBody({ resourceAddress, content, wrap, scrollportRef, t }: CodeBodyProps): ReactNode {
  if (content.kind !== 'text') return null
  const language = languageForPath(resourceAddress)
  return (
    <div className={css.renderer} data-code-preview data-wrap={wrap}>
      <CodeBlock
        className={css.code}
        contentRef={scrollportRef}
        code={content.text}
        lang={language}
        streaming={!content.eof}
        wrap={wrap}
        lineNumbers
        copyLabel={t('copy')}
        copiedLabel={t('copied')}
        toolbarLabels={{ codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') }}
      />
    </div>
  )
}
