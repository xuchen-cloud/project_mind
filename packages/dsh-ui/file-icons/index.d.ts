import type { ReactNode } from 'react';

/** Filename classification from the existing DSH file icon mappings. */
export function classifyFileType(name: string): string;
export function fileExtension(name: string): string;
/** The subset of upstream props needed by shared File presentation. */
export function FileTypeIcon(props: ({ path: string } | { kind: 'other' }) & {
  size?: number;
  className?: string;
}): ReactNode;
